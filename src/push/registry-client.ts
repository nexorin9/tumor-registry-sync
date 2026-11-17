/**
 * 专病库登记接口的出站客户端。
 *
 * 规矩（与 config/env 同源）：
 * - 凭据只来自 RegistryEnv，代码里不出现真实地址/令牌
 * - 缺 baseUrl / apiToken 时抛 InvalidEnvError 并点名具体变量
 * - 发送前先校验请求体（validateRegistryEntry），非法体直接转 bad_payload
 * - 状态码映射到位：4xx 多数不可重试、429/5xx/超时可重试；绝不静默吞错
 */
import type { ErrorCode } from '../contract/index.js';
import { InvalidEnvError } from '../config/env.js';
import type { RegistryEnv } from '../config/env.js';
import type { PushReceipt } from '../contract/index.js';
import { PayloadValidationError, validateRegistryEntry } from './payload-schema.js';
import type { RegistryEntry } from './payload-schema.js';

/** 推送阶段错误：带 ErrorCode 与是否可重试，供重试层判定。 */
export class PushError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly httpStatus?: number;

  constructor(code: ErrorCode, retryable: boolean, message: string, httpStatus?: number) {
    super(message);
    this.name = 'PushError';
    this.code = code;
    this.retryable = retryable;
    this.httpStatus = httpStatus;
  }
}

const DEFAULT_TIMEOUT_MS = 10_000;
const PUSH_PATH = '/api/v1/registry-entries';

export class RegistryClient {
  private readonly env: RegistryEnv;
  readonly timeoutMs: number;

  constructor(env: RegistryEnv, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.env = env;
    this.timeoutMs = timeoutMs;
  }

  /**
   * 推送一行。返回成功回执；任何失败都抛 PushError（不会返回失败回执）。
   * rowNumber 由调用方（重试层）按批次回填，这里以 0 占位、registryId 取自 body。
   */
  async pushRow(body: RegistryEntry, idempotencyKey: string): Promise<PushReceipt> {
    if (!this.env.baseUrl || !this.env.apiToken) {
      const missing: string[] = [];
      if (!this.env.baseUrl) missing.push('REGISTRY_BASE_URL');
      if (!this.env.apiToken) missing.push('REGISTRY_API_TOKEN');
      throw new InvalidEnvError(missing.join(','), `缺少环境变量：${missing.join('、')}`);
    }

    // 发送前校验请求体；非法体 → bad_payload（不可重试）
    try {
      validateRegistryEntry(body);
    } catch (error) {
      if (error instanceof PayloadValidationError) {
        throw new PushError('bad_payload', false, `请求体非法：${error.issues.join('；')}`);
      }
      throw error;
    }

    const url = `${this.env.baseUrl}${PUSH_PATH}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.env.apiToken}`,
          'Idempotency-Key': idempotencyKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      // 连接失败 / 超时（AbortError）/ DNS 等网络类错误 → timeout（可重试）
      throw new PushError('timeout', true, '请求失败或超时（网络 / 超时）');
    } finally {
      clearTimeout(timer);
    }

    const status = response.status;

    if (status >= 200 && status < 300) {
      return {
        rowNumber: 0,
        registryId: body.identifier.value,
        status: '已推送',
        code: null,
        reason: null,
        idempotencyKey,
        attempts: 1,
        pushedAt: new Date().toISOString(),
      };
    }

    const reason = await this.extractReason(response, status);

    if (status === 401) {
      throw new PushError(
        'auth_failed',
        false,
        `认证失败：${reason}（缺失 / 无效 REGISTRY_API_TOKEN）`,
        status,
      );
    }
    if (status === 403) {
      throw new PushError(
        'forbidden',
        false,
        `无权限：${reason}（REGISTRY_API_TOKEN 无权推送该资源）`,
        status,
      );
    }
    if (status === 404) {
      throw new PushError('not_found', false, `资源不存在：${reason}`, status);
    }
    if (status === 429) {
      throw new PushError('rate_limited', true, `触发限流：${reason}`, status);
    }
    if (status >= 500) {
      throw new PushError('server_error', true, `服务端错误：${reason}`, status);
    }

    // 其余 4xx（含 400）：请求本身不被接受，不可重试
    throw new PushError('bad_payload', false, `请求被拒（${status}）：${reason}`, status);
  }

  /** 尽量从响应体读出可读原因；读不到就用状态文本。 */
  private async extractReason(response: Response, status: number): Promise<string> {
    const text = await response.text().catch(() => '');
    if (text.length === 0) return response.statusText || String(status);
    try {
      const data = JSON.parse(text) as { message?: unknown; error?: unknown };
      const candidate = data?.message ?? data?.error;
      if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    } catch {
      // 非 JSON：原样截断返回
      return text.slice(0, 200);
    }
    return response.statusText || String(status);
  }
}
