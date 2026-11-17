/**
 * 检索链的错误分类。
 *
 * 分类的用途只有一个：**让登记员一眼看懂这行为什么没结果、下一步该做什么**。
 * 因此每个错误都带三样东西：
 * - code：机器可判的归类（与契约 ErrorCode 同一套名字）
 * - retryable：这类失败重跑有没有意义（超时/5xx/429 有，其余没有）
 * - userHint：面向人的处置动作，缺凭据时**点名环境变量**
 *
 * 三条硬规矩：
 * - 401/403 是**终止级**错误：凭据不对时继续跑只会刷一屏错行，直接停下来点名变量
 * - 404 映射「零命中」：院内确实没有这条登记号，和「检索失败」是两回事
 * - 检索失败**不等于**零命中：超时/5xx 走「未完成」，不谎报成「没有」
 *
 * 退避建议沿用「最小延迟 × 增长因子 × 次数，封顶」的形状：
 * 第 n 次重试等 min × factor^(n-1)，封顶 max，最多 maxAttempts 次。
 * 登记员照着这个节奏重跑即可，不必自己猜该等多久。
 */
import type { ErrorCode } from '../contract/index.js';

/**
 * 检索链的固定错误码（八类）。
 *
 * 这张表是检索侧错误的**唯一真源**：客户端、编排层、可观测层都从这里取
 * 错误码、可重试标记与处置提示，不再各写一份文案。
 */
export const FHIR_ERROR_CODES = [
  'auth_failed',
  'forbidden',
  'not_found',
  'timeout',
  'server_error',
  'rate_limited',
  'bad_payload',
  'missing_field',
] as const;
export type FhirErrorCode = (typeof FHIR_ERROR_CODES)[number];

/** 退避策略：最小延迟、增长因子、封顶延迟、最多尝试次数。 */
export const BACKOFF_POLICY = {
  /** 第一次重试前的最小等待 */
  minDelayMs: 1_000,
  /** 每次重试的等待倍数 */
  growFactor: 2,
  /** 单次等待封顶 */
  maxDelayMs: 30_000,
  /** 一批内最多尝试次数（含首次） */
  maxAttempts: 3,
} as const;

/** 一个错误码的处置规则。 */
export interface ErrorRule {
  /** 错误码 */
  code: FhirErrorCode;
  /** 这类失败重跑有没有意义 */
  retryable: boolean;
  /** 面向登记员的处置提示 */
  userHint: string;
}

/**
 * 第 attempt 次重试前该等多久（毫秒）。
 *
 * 形状：min × factor^(attempt-1)，封顶 maxDelayMs。attempt 从 1 起，
 * 即第一次重试等 min，第二次等 min×factor。
 */
export function backoffDelayMs(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt < 1) return BACKOFF_POLICY.minDelayMs;
  const raw =
    BACKOFF_POLICY.minDelayMs * BACKOFF_POLICY.growFactor ** (Math.floor(attempt) - 1);
  return Math.min(raw, BACKOFF_POLICY.maxDelayMs);
}

/** 退避建议的一句话（写进 userHint，让登记员照着就能重跑）。 */
export function retryAdvice(attempt = 1): string {
  const delayMs = backoffDelayMs(attempt);
  const seconds = delayMs / 1000;
  const delayText = Number.isInteger(seconds) ? `${seconds}` : seconds.toFixed(1);
  return `建议退避 ${delayText} 秒后重跑（本批最多尝试 ${BACKOFF_POLICY.maxAttempts} 次）`;
}

/** 八类错误的处置规则表（唯一真源）。 */
export const ERROR_RULES: Readonly<Record<FhirErrorCode, ErrorRule>> = {
  auth_failed: {
    code: 'auth_failed',
    retryable: false,
    userHint:
      '院内 FHIR 服务拒绝了凭据：请检查环境变量 CDR_API_TOKEN 是否正确、是否已过期',
  },
  forbidden: {
    code: 'forbidden',
    retryable: false,
    userHint:
      '当前令牌无权访问院内 FHIR 资源：请检查 CDR_API_TOKEN 的授权范围，或 CDR_BASE_URL 是否指向正确的院内 FHIR 服务',
  },
  not_found: {
    code: 'not_found',
    retryable: false,
    userHint:
      '院内 FHIR 服务未返回该资源：本轮按「零命中」处理，请核对登记号与 CDR_IDENTIFIER_SYSTEM 是否一致',
  },
  timeout: {
    code: 'timeout',
    retryable: true,
    userHint: `院内 FHIR 服务未在超时时间内响应：可重试，${retryAdvice(1)}`,
  },
  server_error: {
    code: 'server_error',
    retryable: true,
    userHint: `院内 FHIR 服务返回服务端错误：可重试，${retryAdvice(1)}`,
  },
  rate_limited: {
    code: 'rate_limited',
    retryable: true,
    userHint: `院内 FHIR 服务限流：可重试，${retryAdvice(1)}`,
  },
  bad_payload: {
    code: 'bad_payload',
    retryable: false,
    userHint:
      '请确认 CDR_BASE_URL 指向的是 FHIR R4 服务（返回 application/fhir+json），而不是门户页或代理错误页',
  },
  missing_field: {
    code: 'missing_field',
    retryable: false,
    userHint:
      '院内资源缺少关键字段：该字段本轮不参与比对，请联系信息科核对院内资源后重跑',
  },
};

/** 检索链错误。 */
export class FhirRequestError extends Error {
  /** 错误码 */
  readonly code: ErrorCode;
  /** 是否值得重跑 */
  readonly retryable: boolean;
  /** 面向登记员的处置提示 */
  readonly userHint: string;
  /** HTTP 状态码（网络类错误才有） */
  readonly httpStatus: number | null;
  /** 原始异常 */
  override readonly cause: unknown;

  constructor(init: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
    userHint: string;
    httpStatus?: number | null;
    cause?: unknown;
  }) {
    super(init.message);
    this.name = 'FhirRequestError';
    this.code = init.code;
    this.retryable = init.retryable;
    this.userHint = init.userHint;
    this.httpStatus = init.httpStatus ?? null;
    this.cause = init.cause;
  }
}

/** 状态码分类结果。 */
export interface StatusClassification {
  code: ErrorCode;
  retryable: boolean;
  userHint: string;
}

/** 失败形态（非 HTTP 状态码的那几类）。 */
export type FailureKind = 'timeout' | 'network' | 'bad_payload' | 'missing_field' | 'invalid_request';

/**
 * 按 HTTP 状态码分类检索失败。
 *
 * 401/403 指名环境变量（CDR_API_TOKEN / CDR_BASE_URL），404 明说「按零命中处理」，
 * 超时与 5xx、429 标成可重试并给退避建议，其余 4xx 不重试（重跑也是一样的结果）。
 */
export function classifyHttpStatus(status: number): StatusClassification {
  if (status === 401) {
    return rule('auth_failed');
  }
  if (status === 403) {
    return rule('forbidden');
  }
  if (status === 404) {
    return rule('not_found');
  }
  if (status === 429) {
    return rule('rate_limited');
  }
  if (status >= 500) {
    return rule('server_error');
  }
  if (status >= 400) {
    return {
      code: 'invalid_request',
      retryable: false,
      userHint: '院内 FHIR 服务拒绝了本次检索参数：请核对登记号与检索条件',
    };
  }
  return {
    code: 'unknown',
    retryable: true,
    userHint:
      '院内 FHIR 服务返回了非预期状态码，请确认 CDR_BASE_URL 指向的是 FHIR R4 服务',
  };
}

/**
 * 按失败形态分类（非 HTTP 状态码的失败）。
 *
 * 网络不通与超时可重试；坏响应与缺关键字段重跑也是一样的结果，不重试。
 */
export function classifyFailureKind(kind: FailureKind): StatusClassification {
  switch (kind) {
    case 'timeout':
      return rule('timeout');
    case 'bad_payload':
      return rule('bad_payload');
    case 'missing_field':
      return rule('missing_field');
    case 'invalid_request':
      return {
        code: 'invalid_request',
        retryable: false,
        userHint: '本次检索条件不合法：请核对登记号与 CDR_IDENTIFIER_SYSTEM 配置',
      };
    case 'network':
    default:
      return {
        code: 'unknown',
        retryable: true,
        userHint:
          '请检查 CDR_BASE_URL 是否指向正确的院内 FHIR R4 服务，以及本机到院内网络的连通性',
      };
  }
}

/** 取规则表里的处置规则。 */
function rule(code: FhirErrorCode): StatusClassification {
  const entry = ERROR_RULES[code];
  return { code: entry.code, retryable: entry.retryable, userHint: entry.userHint };
}

/** 该错误码是否属于检索链的八类固定错误码。 */
export function isFhirErrorCode(code: string): code is FhirErrorCode {
  return (FHIR_ERROR_CODES as readonly string[]).includes(code);
}

/** 该错误码是否值得重跑（不在八类表内的按不可重试算）。 */
export function isRetryableCode(code: string): boolean {
  return isFhirErrorCode(code) ? ERROR_RULES[code].retryable : false;
}

/** 是否终止级错误：凭据 / 权限问题，继续跑只会刷一屏错行。 */
export function isFatalFhirError(error: unknown): boolean {
  if (!(error instanceof FhirRequestError)) return false;
  return error.code === 'auth_failed' || error.code === 'forbidden';
}

/**
 * 是否「零命中」类错误（404）：院内确实没有这条登记号。
 *
 * 零命中与「未完成」是两回事，摘要里分开计数，不许混。
 */
export function isZeroHitError(error: unknown): boolean {
  return error instanceof FhirRequestError && error.code === 'not_found';
}

/** 是否「检索未完成」类错误（与「零命中」区分开）。 */
export function isIncompleteFhirError(error: unknown): boolean {
  if (!(error instanceof FhirRequestError)) return false;
  return (
    error.code === 'timeout' ||
    error.code === 'server_error' ||
    error.code === 'rate_limited' ||
    error.code === 'bad_payload' ||
    error.code === 'unknown' ||
    error.code === 'invalid_request'
  );
}

/**
 * 把任意异常压成可观测层要的形状（错误码 / 可重试 / 处置提示 / 状态码）。
 *
 * 非 FhirRequestError 的异常一律记成 unknown + 可重试 —— 未知问题先当网络抖动处理，
 * 但绝不静默吞掉：日志里一定会留下一条 error 记录。
 */
export function describeError(error: unknown): {
  code: ErrorCode;
  retryable: boolean;
  userHint: string;
  httpStatus: number | null;
  message: string;
} {
  if (error instanceof FhirRequestError) {
    return {
      code: error.code,
      retryable: error.retryable,
      userHint: error.userHint,
      httpStatus: error.httpStatus,
      message: error.message,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const classified = classifyFailureKind('network');
  return {
    code: classified.code,
    retryable: classified.retryable,
    userHint: classified.userHint,
    httpStatus: null,
    message,
  };
}
