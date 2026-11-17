/**
 * 环境变量集中读取与校验。
 *
 * 规矩：
 * - 凭据一律只从环境变量读，代码里不得出现任何真实地址或令牌
 * - 必填项缺失时抛错并**点名具体变量名**（如「缺少环境变量：CDR_BASE_URL」），
 *   不静默降级、不填假值、不把真实端点换成替身
 * - 模型三项（base_url / api_key / model）要么全部配置、要么全部不配；
 *   只配一部分时报错并指名缺哪一项，避免半配置状态在运行时才炸
 */

export const ENV_NAMES = {
  cdrBaseUrl: 'CDR_BASE_URL',
  cdrApiToken: 'CDR_API_TOKEN',
  cdrIdentifierSystem: 'CDR_IDENTIFIER_SYSTEM',
  registryBaseUrl: 'REGISTRY_BASE_URL',
  registryApiToken: 'REGISTRY_API_TOKEN',
  modelBaseUrl: 'MODEL_BASE_URL',
  modelApiKey: 'MODEL_API_KEY',
  modelName: 'MODEL_NAME',
  modelTimeoutMs: 'MODEL_TIMEOUT_MS',
} as const;

export const PAYLOAD_FORMS = ['field-level', 'whole-entry'] as const;
export type PayloadForm = (typeof PAYLOAD_FORMS)[number];

export const DEFAULT_MODEL_TIMEOUT_MS = 20_000;
/** 运行日志目录默认值（本机 run-log 落在这里）。 */
export const DEFAULT_RUN_LOG_DIR = 'logs';
export const DEFAULT_FHIR_MAX_CONCURRENCY = 4;
export const DEFAULT_MERGE_CONFIDENCE_THRESHOLD = 0.8;

/** 缺环境变量时的错误：message 里逐个点名，便于登记员/信息科照着改。 */
export class MissingEnvError extends Error {
  readonly missing: string[];

  constructor(missing: string[]) {
    super(`缺少环境变量：${missing.join('、')}`);
    this.name = 'MissingEnvError';
    this.missing = missing;
  }
}

/** 配置值非法（如推送体形态不在白名单内）时的错误，同样点名配置项。 */
export class InvalidEnvError extends Error {
  readonly variable: string;

  constructor(variable: string, message: string) {
    super(`${variable} 配置无效：${message}`);
    this.name = 'InvalidEnvError';
    this.variable = variable;
  }
}

export interface CdrEnv {
  /** 院内 FHIR 服务基地址（已去掉结尾斜杠） */
  baseUrl: string;
  /** Bearer 令牌 */
  apiToken: string;
  /** 登记主索引在 Patient.identifier 上使用的 system 值 */
  identifierSystem: string;
}

export interface RegistryEnv {
  /** 专病库登记接口基地址（已去掉结尾斜杠） */
  baseUrl: string;
  /** Bearer 令牌 */
  apiToken: string;
  /** 推送体形态 */
  payloadForm: PayloadForm;
}

export interface ModelEnv {
  baseUrl: string;
  apiKey: string;
  name: string;
  timeoutMs: number;
}

export interface AppEnv {
  cdr: CdrEnv;
  registry: RegistryEnv;
  /** 模型未配置时为 null；此时归并列留空并标「需人工判定」 */
  model: ModelEnv | null;
  /** 检索并发上限 */
  fhirMaxConcurrency: number;
  /** 归并置信度阈值 */
  mergeConfidenceThreshold: number;
}

type EnvSource = Record<string, string | undefined>;

function trimmed(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const t = value.trim();
  return t.length === 0 ? undefined : t;
}

/** 去掉结尾斜杠，避免拼出 `//fhir/R4/...` 这类双斜杠路径。 */
function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function requireVars(source: EnvSource, names: string[]): string[] {
  return names.filter((name) => trimmed(source[name]) === undefined);
}

function parsePositiveInt(
  source: EnvSource,
  name: string,
  fallback: number,
): number {
  const raw = trimmed(source[name]);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidEnvError(name, `应为正整数，当前为「${raw}」`);
  }
  return parsed;
}

function parseThreshold(source: EnvSource, name: string, fallback: number): number {
  const raw = trimmed(source[name]);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new InvalidEnvError(name, `应为 0 到 1 之间的小数，当前为「${raw}」`);
  }
  return parsed;
}

/** 组装院内只读侧配置（前提：三项都已校验存在）。 */
function buildCdrEnv(source: EnvSource): CdrEnv {
  return {
    baseUrl: normalizeBaseUrl(trimmed(source[ENV_NAMES.cdrBaseUrl]) as string),
    apiToken: trimmed(source[ENV_NAMES.cdrApiToken]) as string,
    identifierSystem: trimmed(source[ENV_NAMES.cdrIdentifierSystem]) as string,
  };
}

/**
 * 只加载院内只读侧的三项配置（CDR_BASE_URL / CDR_API_TOKEN / CDR_IDENTIFIER_SYSTEM）。
 *
 * 检索是主干的只读第一步：专病库写接口还没配好时，登记员也应该能先跑检索看
 * 命中情况，所以这里不连带要求 REGISTRY_*。缺哪项就点名哪项。
 */
export function loadCdrEnv(source: EnvSource = process.env): CdrEnv {
  const missing = requireVars(source, [
    ENV_NAMES.cdrBaseUrl,
    ENV_NAMES.cdrApiToken,
    ENV_NAMES.cdrIdentifierSystem,
  ]);
  if (missing.length > 0) {
    throw new MissingEnvError(missing);
  }
  return buildCdrEnv(source);
}

/**
 * 只读取运行日志目录（RUN_LOG_DIR），缺省 logs。
 *
 * run-log 是本机的结构化运行日志（JSONL）：检索成功、失败、耗时、尝试次数都写在这里，
 * 出问题时信息科可以直接看这个文件，不用来问「当时到底发生了什么」。
 */
export function loadRunLogDir(source: EnvSource = process.env): string {
  const raw = trimmed(source['RUN_LOG_DIR']);
  if (raw === undefined) return DEFAULT_RUN_LOG_DIR;
  return raw;
}

/**
 * 只读取检索并发上限（FHIR_MAX_CONCURRENCY），缺省 4。
 *
 * 检索是主干的只读第一段，专病库写接口还没配好时也应该能先跑检索，
 * 所以这里不连带要求 REGISTRY_*；非法值点名报错，不静默改成 1。
 */
export function loadFhirMaxConcurrency(source: EnvSource = process.env): number {
  return parsePositiveInt(source, 'FHIR_MAX_CONCURRENCY', DEFAULT_FHIR_MAX_CONCURRENCY);
}

function parsePayloadForm(source: EnvSource): PayloadForm {  const raw = trimmed(source['REGISTRY_PAYLOAD_FORM']);
  if (raw === undefined) return 'field-level';
  if ((PAYLOAD_FORMS as readonly string[]).includes(raw)) return raw as PayloadForm;
  throw new InvalidEnvError(
    'REGISTRY_PAYLOAD_FORM',
    `允许取值为 ${PAYLOAD_FORMS.join(' / ')}，当前为「${raw}」`,
  );
}

/**
 * 读取全部配置；缺必填项或模型半配置时抛 MissingEnvError 并点名变量。
 * 这是产品代码读取配置的**唯一入口**。
 */
export function loadEnv(source: EnvSource = process.env): AppEnv {
  const missing = requireVars(source, [
    ENV_NAMES.cdrBaseUrl,
    ENV_NAMES.cdrApiToken,
    ENV_NAMES.cdrIdentifierSystem,
    ENV_NAMES.registryBaseUrl,
    ENV_NAMES.registryApiToken,
  ]);

  const modelConfigured = [
    ENV_NAMES.modelBaseUrl,
    ENV_NAMES.modelApiKey,
    ENV_NAMES.modelName,
  ].filter((name) => trimmed(source[name]) !== undefined);

  if (modelConfigured.length > 0 && modelConfigured.length < 3) {
    const missingModel = [
      ENV_NAMES.modelBaseUrl,
      ENV_NAMES.modelApiKey,
      ENV_NAMES.modelName,
    ].filter((name) => trimmed(source[name]) === undefined);
    missing.push(...missingModel);
  }

  if (missing.length > 0) {
    throw new MissingEnvError(missing);
  }

  const model: ModelEnv | null =
    modelConfigured.length === 3
      ? {
          baseUrl: normalizeBaseUrl(trimmed(source[ENV_NAMES.modelBaseUrl]) as string),
          apiKey: trimmed(source[ENV_NAMES.modelApiKey]) as string,
          name: trimmed(source[ENV_NAMES.modelName]) as string,
          timeoutMs: parsePositiveInt(
            source,
            ENV_NAMES.modelTimeoutMs,
            DEFAULT_MODEL_TIMEOUT_MS,
          ),
        }
      : null;

  return {
    cdr: buildCdrEnv(source),
    registry: {
      baseUrl: normalizeBaseUrl(trimmed(source[ENV_NAMES.registryBaseUrl]) as string),
      apiToken: trimmed(source[ENV_NAMES.registryApiToken]) as string,
      payloadForm: parsePayloadForm(source),
    },
    model,
    fhirMaxConcurrency: parsePositiveInt(
      source,
      'FHIR_MAX_CONCURRENCY',
      DEFAULT_FHIR_MAX_CONCURRENCY,
    ),
    mergeConfidenceThreshold: parseThreshold(
      source,
      'MERGE_CONFIDENCE_THRESHOLD',
      DEFAULT_MERGE_CONFIDENCE_THRESHOLD,
    ),
  };
}

/**
 * 只体检不抛错：返回缺失 / 非法的变量清单，供 `doctor` 子命令逐项报给信息科。
 * 与 loadEnv 用同一套规则，避免「体检说齐了、跑起来却报错」。
 */
export function inspectEnv(source: EnvSource = process.env): {
  missing: string[];
  invalid: { variable: string; message: string }[];
  modelConfigured: boolean;
} {
  const missing = requireVars(source, [
    ENV_NAMES.cdrBaseUrl,
    ENV_NAMES.cdrApiToken,
    ENV_NAMES.cdrIdentifierSystem,
    ENV_NAMES.registryBaseUrl,
    ENV_NAMES.registryApiToken,
  ]);

  const invalid: { variable: string; message: string }[] = [];
  const modelConfigured = [
    ENV_NAMES.modelBaseUrl,
    ENV_NAMES.modelApiKey,
    ENV_NAMES.modelName,
  ].filter((name) => trimmed(source[name]) !== undefined);

  if (modelConfigured.length > 0 && modelConfigured.length < 3) {
    missing.push(
      ...[ENV_NAMES.modelBaseUrl, ENV_NAMES.modelApiKey, ENV_NAMES.modelName].filter(
        (name) => trimmed(source[name]) === undefined,
      ),
    );
  }

  const probe = (fn: () => void): void => {
    try {
      fn();
    } catch (error) {
      if (error instanceof InvalidEnvError) {
        invalid.push({ variable: error.variable, message: error.message });
      } else {
        throw error;
      }
    }
  };

  probe(() => parsePositiveInt(source, ENV_NAMES.modelTimeoutMs, DEFAULT_MODEL_TIMEOUT_MS));
  probe(() => parsePositiveInt(source, 'FHIR_MAX_CONCURRENCY', DEFAULT_FHIR_MAX_CONCURRENCY));
  probe(() =>
    parseThreshold(source, 'MERGE_CONFIDENCE_THRESHOLD', DEFAULT_MERGE_CONFIDENCE_THRESHOLD),
  );
  probe(() => parsePayloadForm(source));

  return { missing, invalid, modelConfigured: modelConfigured.length === 3 };
}
