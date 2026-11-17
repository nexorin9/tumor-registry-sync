/**
 * 单一 OpenAI 兼容的 ModelGateway，只承担两类 assist 任务：
 *   1) 同义词归并（mergeTerm）
 *   2) 字段差异解释（explainDiff）
 *
 * 关键纪律（ai_role=assist）：模型输出**永远不会**推进某一行的确认状态，
 * 也**永远不会**进入推送体。本网关只产出「建议 / 解释」，调用方据此呈现给
 * 人工，最终是否确认、如何推送由确认层决定。
 *
 * 容错：结构化输出、超时（AbortController）、重试退避、不可达降级。
 * 任何不可达 / 降级路径一律返回降级产物，绝不抛错中断主链路。
 */
import type { ModelEnv } from '../config/env.js';
import { promptHash, type ModelAuditRecorder, type ModelCallMeta, type ModelCallUsage } from './audit.js';

/** 归并输入：一个待归并术语 + 一组标准候选编码 + 字段名。 */
export interface MergeTermInput {
  term: string;
  candidates: { code: string; label: string }[];
  field: string;
}

/** 归并输出：命中的标准编码（或 null）+ 置信度 + 中文理由。 */
export interface MergeTermOutput {
  code: string | null;
  confidence: number;
  reason: string;
}

/** 差异解释输入：字段名 + 登记库值 + 院内值 + 字段口径说明。 */
export interface ExplainDiffInput {
  field: string;
  registryValue: string;
  hospitalValue: string;
  fieldNote: string;
}

/** 差异解释输出：面向人工的一句话说明。 */
export interface ExplainDiffOutput {
  note: string;
}

/** 模型网关契约。 */
export interface ModelGateway {
  mergeTerm(input: MergeTermInput): Promise<MergeTermOutput>;
  explainDiff(input: ExplainDiffInput): Promise<ExplainDiffOutput>;
}

/** 网关构造选项。 */
export interface OpenAIGatewayOptions {
  /** 审计记录器；不给则本次调用不写审计 */
  audit?: ModelAuditRecorder;
  /** 时钟（测试可注入固定时钟测耗时） */
  clock?: () => Date;
}

/** 不可达 / 未配置端点时抛出，由方法捕获后降级。 */
export class ModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelUnavailableError';
  }
}

/** 4xx（含鉴权失败）：不重试，立即降级。 */
class NoRetryHttpError extends Error {
  constructor(public readonly status: number) {
    super(`模型接口返回不可重试错误：${status}`);
    this.name = 'NoRetryHttpError';
  }
}

/** 429 / 5xx：可重试，退避后重试（封顶 3 次）。 */
class RetryableHttpError extends Error {
  constructor(public readonly status: number) {
    super(`模型接口返回可重试错误：${status}`);
    this.name = 'RetryableHttpError';
  }
}

/** 解析失败（含非 JSON 响应体 / 字段缺失）：重试一次后降级。 */
class ParseError extends Error {
  constructor() {
    super('模型返回内容无法解析为结构化输出');
    this.name = 'ParseError';
  }
}

/** 超时 / 网络不可达：按不可达处理，退避后重试（封顶 3 次），耗尽则降级。 */
class TimeoutError extends Error {
  constructor() {
    super('模型接口超时或不可达');
    this.name = 'TimeoutError';
  }
}

/** 重试退避基数（毫秒），指数增长。 */
const BACKOFF_BASE_MS = 10;
/** 可重试错误（429/5xx/超时）的最大尝试次数。 */
const MAX_RETRYABLE_ATTEMPTS = 3;
/** 解析失败的最大尝试次数（重试一次）。 */
const MAX_PARSE_ATTEMPTS = 2;

/** 占位符判定：命中任一即视为未配置，直接降级。 */
const PLACEHOLDER_PATTERN = /example|placeholder|\{\{|\<|your-|xxxx|\.\.\.|待填/i;

/** 降级产物：归并任务。 */
export function degradedMergeTerm(): MergeTermOutput {
  return { code: null, confidence: 0, reason: '模型未启用或不可达' };
}

/** 降级产物：差异解释任务。 */
export function degradedExplainDiff(): ExplainDiffOutput {
  return { note: '字段口径不一致，请人工核对（模型未启用）' };
}

/** 是否归并降级（未命中任何编码）。 */
export function isDegradedMerge(out: MergeTermOutput): boolean {
  return out.code === null;
}

/**
 * OpenAI 兼容网关实现。
 *
 * 调用 `${env.baseUrl}/chat/completions`，携带 `Authorization: Bearer ${env.apiKey}`，
 * 通过 `response_format.json_schema` 请求结构化输出。
 */
export class OpenAIGateway implements ModelGateway {
  private readonly env: ModelEnv;
  private readonly audit?: ModelAuditRecorder;
  private readonly clock: () => Date;

  constructor(env: ModelEnv, opts: OpenAIGatewayOptions = {}) {
    this.env = env;
    this.audit = opts.audit;
    this.clock = opts.clock ?? (() => new Date());
  }

  async mergeTerm(input: MergeTermInput): Promise<MergeTermOutput> {
    return this.invoke<MergeTermOutput>({
      input,
      inputSummary: `term=${input.term};candidates=${input.candidates.length};field=${input.field}`,
      buildBody: () => this.buildMergeBody(input),
      parse: parseMergeTerm,
      summarizeOutput: (out) => `code=${out.code ?? 'null'};confidence=${out.confidence}`,
      degraded: degradedMergeTerm,
    });
  }

  async explainDiff(input: ExplainDiffInput): Promise<ExplainDiffOutput> {
    return this.invoke<ExplainDiffOutput>({
      input,
      inputSummary: `field=${input.field}`,
      buildBody: () => this.buildExplainBody(input),
      parse: parseExplainDiff,
      summarizeOutput: (out) => `noteLen=${out.note.length}`,
      degraded: degradedExplainDiff,
    });
  }

  /** 统一的「尝试 → 重试/降级 → 审计」编排。 */
  private async invoke<T>(params: {
    input: unknown;
    inputSummary: string;
    buildBody: () => unknown;
    parse: (raw: unknown) => T;
    summarizeOutput: (out: T) => string;
    degraded: () => T;
  }): Promise<T> {
    const start = this.clock().getTime();
    let attempts = 0;

    const finishDegraded = (): T => {
      const durationMs = this.clock().getTime() - start;
      this.audit?.record(
        this.buildMeta(true, attempts, durationMs, params.input, params.inputSummary, '', null),
      );
      return params.degraded();
    };

    try {
      this.assertReachable();

      let lastErr: unknown;
      const maxAttempts = MAX_RETRYABLE_ATTEMPTS;
      while (true) {
        attempts += 1;
        try {
          const { out, usage } = await this.doHttpRequest(params.buildBody(), params.parse);
          const durationMs = this.clock().getTime() - start;
          this.audit?.record(
            this.buildMeta(
              false,
              attempts,
              durationMs,
              params.input,
              params.inputSummary,
              params.summarizeOutput(out),
              usage,
            ),
          );
          return out;
        } catch (err) {
          lastErr = err;
          const kind = classify(err);
          if (kind === 'no-retry') break; // 4xx：绝不重试
          if (kind === 'parse' && attempts >= MAX_PARSE_ATTEMPTS) break; // 解析失败：重试一次
          if (attempts >= maxAttempts) break; // 可重试错误：封顶 3 次
          await this.sleep(BACKOFF_BASE_MS * 2 ** (attempts - 1));
        }
      }
      // 走到这里说明已耗尽重试但仍失败 → 降级。
      void lastErr;
      return finishDegraded();
    } catch (err) {
      // assertReachable 抛出的 ModelUnavailableError，或任何意外错误：一律降级。
      void err;
      return finishDegraded();
    }
  }

  /** 端点未配置 / 占位符 → 抛错，由 invoke 捕获降级（不崩溃）。 */
  private assertReachable(): void {
    if (!this.env || !this.env.baseUrl || PLACEHOLDER_PATTERN.test(this.env.baseUrl)) {
      throw new ModelUnavailableError('模型端点未配置或为占位符');
    }
  }

  private async doHttpRequest<T>(
    body: unknown,
    parse: (raw: unknown) => T,
  ): Promise<{ out: T; usage: ModelCallUsage | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.env.timeoutMs);
    try {
      const res = await fetch(`${this.env.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.env.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (res.status === 429 || res.status >= 500) {
        throw new RetryableHttpError(res.status);
      }
      if (res.status >= 400) {
        throw new NoRetryHttpError(res.status);
      }

      const json = (await res.json().catch(() => {
        throw new ParseError();
      })) as unknown;
      const out = extractContent(json, parse);
      const usage = extractUsage(json);
      return { out, usage };
    } catch (err) {
      if (
        err instanceof NoRetryHttpError ||
        err instanceof RetryableHttpError ||
        err instanceof ParseError
      ) {
        throw err;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new TimeoutError();
      }
      // fetch 网络层错误（连接被拒等）按不可达处理。
      throw new TimeoutError();
    } finally {
      clearTimeout(timer);
    }
  }

  private buildMergeBody(input: MergeTermInput): unknown {
    return {
      model: this.env.name,
      messages: [
        {
          role: 'system',
          content:
            '你是肿瘤登记字段归并助手（assist 角色）：只把待归并术语映射到标准候选编码并给置信度与理由，不推进任何确认状态，也不生成推送内容。',
        },
        {
          role: 'user',
          content: `请将下列待归并术语映射到标准候选编码，仅可返回候选中的 code 或 null。\n输入：${JSON.stringify(input)}`,
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'merge_term',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              code: { type: ['string', 'null'] },
              confidence: { type: 'number' },
              reason: { type: 'string' },
            },
            required: ['code', 'confidence', 'reason'],
            additionalProperties: false,
          },
        },
      },
    };
  }

  private buildExplainBody(input: ExplainDiffInput): unknown {
    return {
      model: this.env.name,
      messages: [
        {
          role: 'system',
          content:
            '你是肿瘤登记差异解释助手（assist 角色）：只用一句话说明登记库值与院内值口径为何不一致，不推进任何确认状态，也不生成推送内容。',
        },
        {
          role: 'user',
          content: `请解释下列字段的差异。\n输入：${JSON.stringify(input)}`,
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'explain_diff',
          strict: true,
          schema: {
            type: 'object',
            properties: { note: { type: 'string' } },
            required: ['note'],
            additionalProperties: false,
          },
        },
      },
    };
  }

  private buildMeta(
    degraded: boolean,
    attempts: number,
    durationMs: number,
    input: unknown,
    inputSummary: string,
    outputSummary: string,
    usage: ModelCallUsage | null,
  ): ModelCallMeta {
    return {
      model: this.env.name,
      promptHash: promptHash(input),
      inputSummary,
      outputSummary,
      durationMs,
      usage,
      degraded,
      attempts,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** 把一次 HTTP 响应体解析为结构化输出；任何一步不合规都抛 ParseError。 */
function extractContent<T>(json: unknown, parse: (raw: unknown) => T): T {
  if (json === null || typeof json !== 'object') throw new ParseError();
  const choices = (json as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new ParseError();
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  const content = first?.message?.content;
  if (typeof content !== 'string') throw new ParseError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ParseError();
  }
  return parse(parsed);
}

/** 从 OpenAI 响应提取 token 用量；缺失/非数字时返回 null（绝不猜测）。 */
function extractUsage(json: unknown): ModelCallUsage | null {
  if (json === null || typeof json !== 'object') return null;
  const usage = (json as { usage?: unknown }).usage;
  if (usage === null || typeof usage !== 'object') return null;
  const u = usage as { prompt_tokens?: unknown; completion_tokens?: unknown };
  const promptTokens = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : null;
  const completionTokens =
    typeof u.completion_tokens === 'number' ? u.completion_tokens : null;
  if (promptTokens === null && completionTokens === null) return null;
  return { promptTokens, completionTokens };
}

/** 将异常分类为错误处理策略。 */
function classify(err: unknown): 'no-retry' | 'retry' | 'parse' {
  if (err instanceof NoRetryHttpError) return 'no-retry';
  if (err instanceof RetryableHttpError) return 'retry';
  if (err instanceof TimeoutError) return 'retry';
  if (err instanceof ParseError) return 'parse';
  // 兜底：未知异常按可重试（最终会耗尽退化为降级）。
  return 'retry';
}

function parseMergeTerm(raw: unknown): MergeTermOutput {
  if (raw === null || typeof raw !== 'object') throw new ParseError();
  const r = raw as Record<string, unknown>;
  if (!('code' in r) || !('confidence' in r) || !('reason' in r)) throw new ParseError();
  const codeVal = r.code;
  const code = codeVal === null || codeVal === undefined ? null : String(codeVal);
  const confidence =
    typeof r.confidence === 'number' ? r.confidence : Number(r.confidence);
  if (!Number.isFinite(confidence)) throw new ParseError();
  const reason = typeof r.reason === 'string' ? r.reason : String(r.reason);
  return { code, confidence, reason };
}

function parseExplainDiff(raw: unknown): ExplainDiffOutput {
  if (raw === null || typeof raw !== 'object') throw new ParseError();
  const r = raw as Record<string, unknown>;
  if (!('note' in r)) throw new ParseError();
  const note = typeof r.note === 'string' ? r.note : String(r.note);
  return { note };
}
