/**
 * 模型调用审计（脱敏 + 结构化落盘）。
 *
 * 归并/差异解释只走 ai_role=assist，模型输出**永远不会**推进某一行的确认状态、
 * 也**永远不会**进入推送体。审计层同样严格隔离：本文件不得 import 任何
 * confirm / transition / push 相关模块，确保审计逻辑无法反推或改动业务状态。
 */
import { createHash } from 'node:crypto';

import type { RunLogger } from '../observability/index.js';

/** 本次调用的 token 用量；取不到时为 null（绝不猜测）。 */
export interface ModelCallUsage {
  promptTokens: number | null;
  completionTokens: number | null;
}

/** 一次模型调用的审计元数据。 */
export interface ModelCallMeta {
  /** 实际调用的模型名 */
  model: string;
  /** 请求载荷的脱敏摘要哈希（sha256 hex） */
  promptHash: string;
  /** 人读的输入摘要（不含明文） */
  inputSummary: string;
  /** 人读的输出摘要（不含明文） */
  outputSummary: string;
  /** 本调用总耗时（毫秒） */
  durationMs: number;
  /** token 用量；服务器未返回时为 null */
  usage: ModelCallUsage | null;
  /** 是否降级（不可达 / 解析失败 / 限流耗尽等） */
  degraded: boolean;
  /** 实际尝试次数（含重试） */
  attempts: number;
}

/** 审计记录器接口：调用方（网关）把元数据交给它落盘。 */
export interface ModelAuditRecorder {
  record(meta: ModelCallMeta): void;
}

/**
 * 把任意输入转成「脱敏副本」：
 * - 递归深拷贝，不改动原对象；
 * - 任何看起来像姓名/身份明文的字段（name / patient / 姓名 等）一律替换为占位；
 * - 长度超过 64 字符的自由文本替换为「长度摘要」，避免把整段报文写进审计。
 *
 * 这里本就没有姓名等患者明文，但按口径统一兜底：宁可多挡、不能漏。
 */
export function desensitize(input: unknown): unknown {
  const NAME_LIKE = /name|patient|subject|person|身份证|姓名|患者|登记员|doctor/i;

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        if (NAME_LIKE.test(key)) {
          out[key] = '[redacted]';
          continue;
        }
        out[key] = walk(raw);
      }
      return out;
    }
    if (typeof value === 'string') {
      // 只保留短字段；长自由文本降级为长度摘要，防止泄露整段口径说明。
      return value.length > 64 ? `[文本 ${value.length} 字]` : value;
    }
    return value;
  };

  return walk(input);
}

/**
 * 请求载荷的不可还原摘要。
 *
 * 算法：先对输入做脱敏副本，再 `JSON.stringify` 后用 sha256 求 hex。
 * 因为 sha256 是单向散列（抗第二原像 / 抗碰撞），仅凭哈希值无法反推出原始
 * 明文载荷；审计里只留这个哈希，用于「同一请求是否重复」「请求指纹」等判定，
 * 不留存任何可还原的请求内容。
 */
export function promptHash(input: unknown): string {
  const normalized = JSON.stringify(desensitize(input));
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * 把一次模型调用审计落进 RunLogger 的 'model' 阶段事件。
 *
 * 隔离纪律：本函数绝不引入 confirm / transition / push 的任何函数 ——
 * 审计不推进、也不回写任何业务状态（isolation）。这里直接构造一条带
 * `stage:'model'` 的事件并用 `push` 落盘，确保阶段标识不依赖调用方的
 * logger 默认阶段。
 */
export function writeModelAudit(logger: RunLogger, meta: ModelCallMeta): void {
  logger.push({
    ts: new Date().toISOString(),
    stage: 'model',
    outcome: meta.degraded ? 'error' : 'ok',
    rowNumber: null,
    rowId: null,
    errorCode: meta.degraded ? 'model_unavailable' : null,
    retryable: null,
    durationMs: meta.durationMs,
    attempts: meta.attempts,
    message: meta.degraded ? '模型调用降级' : '模型调用完成',
    hint: null,
  });
}

/** RunLogger 适配器：把审计元数据写成 'model' 阶段运行日志事件。 */
export class RunLoggerAuditRecorder implements ModelAuditRecorder {
  constructor(private readonly logger: RunLogger) {}

  record(meta: ModelCallMeta): void {
    writeModelAudit(this.logger, meta);
  }
}
