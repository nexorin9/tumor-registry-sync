/**
 * 结构化可观测性：JSONL 运行日志 + 本批错误分布。
 *
 * 登记员看不懂堆栈，但看得懂「哪一行、因为什么、试了几次、花了多久」。
 * 所以每条日志都是**一行一个 JSON 对象**（JSONL），字段固定：
 *
 * | 字段 | 含义 |
 * |---|---|
 * | `stage` | 阶段：读表 / 检索 / 比对 / 确认 / 推送 / 缺行检查 |
 * | `rowNumber` / `rowId` | 行标识（表内行号 + 登记主索引占位标识） |
 * | `errorCode` | 错误码（与契约 ErrorCode 同一套名字） |
 * | `durationMs` | 本行耗时（毫秒） |
 * | `attempts` | 尝试次数（本行为取得院内值发出的检索段数） |
 *
 * 三条纪律：
 * - **只写脱敏标识**：行标识是登记主索引占位（如 REG-0001），不写姓名等明报
 * - **追加不覆盖**：同一批次重跑时追加写，历史记录留着对照
 * - **失败不静默**：写不出去就报错点名文件路径，不假装记下了
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ErrorCode, ErrorDistribution, ErrorDistributionEntry } from '../contract/index.js';

/** 阶段名（与主干的处理段一一对应）。 */
export const LOG_STAGES = [
  'sheet',
  'lookup',
  'diff',
  'confirm',
  'push',
  'missing',
  'model',
  'system',
] as const;
export type LogStage = (typeof LOG_STAGES)[number];

/** 事件结果：成功 / 出错 / 可重试的失败。 */
export type LogOutcome = 'ok' | 'error' | 'retry';

/** 一条结构化日志。 */
export interface LogEvent {
  /** 时刻（ISO 8601） */
  ts: string;
  /** 阶段 */
  stage: LogStage;
  /** 结果 */
  outcome: LogOutcome;
  /** 表内行号（批次级事件为 null） */
  rowNumber: number | null;
  /** 行标识：登记主索引占位标识（批次级事件为 null） */
  rowId: string | null;
  /** 错误码（成功事件为 null） */
  errorCode: ErrorCode | null;
  /** 是否可重试（成功事件为 null） */
  retryable: boolean | null;
  /** 本行耗时（毫秒；未知为 null） */
  durationMs: number | null;
  /** 尝试次数 */
  attempts: number;
  /** 一句话说明 */
  message: string;
  /** 面向人的处置提示 */
  hint: string | null;
  /**
   * 生效的规则表版本（批次级事件才有；逐行事件不带这个键）。
   *
   * 写进 run-log 是为了下次核对「当时用的是哪版规则」时能查到 ——
   * 规则表改了、结果对不上，先看这一条。
   */
  rulesVersion?: string;
}

/** 记一条日志时的可选项。 */
export interface LogInput {
  /** 表内行号 */
  rowNumber?: number | null;
  /** 行标识（登记主索引占位） */
  rowId?: string | null;
  /** 错误码 */
  errorCode?: ErrorCode | null;
  /** 是否可重试；不给则按错误码表推断 */
  retryable?: boolean | null;
  /** 本行耗时（毫秒） */
  durationMs?: number | null;
  /** 尝试次数 */
  attempts?: number | null;
  /** 一句话说明 */
  message?: string | null;
  /** 面向人的处置提示 */
  hint?: string | null;
}

/** 日志器构造选项。 */
export interface RunLoggerOptions {
  /** run-log 文件路径 */
  path: string;
  /** 默认阶段 */
  stage?: LogStage;
  /** 时钟（测试可注入固定时钟） */
  clock?: () => Date;
}

/** 单条消息的最大长度：超长截断，避免把整页响应写进日志。 */
export const MAX_MESSAGE_LENGTH = 500;

/** 截断并去掉控制字符：日志一行一件事，不塞整页报文。 */
function sanitizeText(text: string | null | undefined): string {
  if (text === null || text === undefined) return '';
  const cleaned = text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (cleaned.length <= MAX_MESSAGE_LENGTH) return cleaned;
  return `${cleaned.slice(0, MAX_MESSAGE_LENGTH)}…`;
}

/**
 * 本机运行日志器：往一个 JSONL 文件里追加写。
 *
 * 事件先在内存里攒着（便于测试与失败时回看），`flush()` 落盘。
 * 落盘失败会抛错并点名文件路径 —— 记不上就当没记成，不假装成功。
 */
export class RunLogger {
  /** run-log 文件路径 */
  readonly path: string;
  /** 默认阶段 */
  readonly stage: LogStage;

  private readonly clock: () => Date;
  private readonly buffer: LogEvent[] = [];

  constructor(options: RunLoggerOptions) {
    this.path = options.path;
    this.stage = options.stage ?? 'system';
    this.clock = options.clock ?? (() => new Date());
  }

  /** 已记录的事件（内存副本）。 */
  get events(): LogEvent[] {
    return [...this.buffer];
  }

  /** 记一条成功事件。 */
  ok(input: LogInput = {}): LogEvent {
    return this.record('ok', input);
  }

  /** 记一条错误事件。 */
  error(input: LogInput = {}): LogEvent {
    return this.record('error', input);
  }

  /** 记一条可重试的失败事件。 */
  retry(input: LogInput = {}): LogEvent {
    return this.record('retry', input);
  }

  /** 记一条事件（结果由调用方给）。 */
  record(outcome: LogOutcome, input: LogInput = {}): LogEvent {
    const event: LogEvent = {
      ts: this.clock().toISOString(),
      stage: this.stage,
      outcome,
      rowNumber: input.rowNumber ?? null,
      rowId: input.rowId ?? null,
      errorCode: input.errorCode ?? null,
      retryable: input.retryable ?? null,
      durationMs: input.durationMs ?? null,
      attempts: input.attempts ?? 1,
      message: sanitizeText(input.message),
      hint: input.hint === undefined ? null : sanitizeText(input.hint) || null,
    };
    this.buffer.push(event);
    return event;
  }

  /**
   * 塞一条已经拼好的事件（不重新生成时间戳）。
   *
   * 供「先把一批结果转成事件、再统一落盘」的场景用（例如检索结果 → 日志事件）。
   */
  push(event: LogEvent): LogEvent {
    this.buffer.push(event);
    return event;
  }

  /**
   * 把攒着的事件落盘（追加写）。
   *
   * 目录不存在会先建；写失败抛错并点名路径与已写条数。
   */
  flush(): number {
    if (this.buffer.length === 0) return 0;
    const lines = this.buffer.map((event) => JSON.stringify(event)).join('\n');
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${lines}\n`, 'utf8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`写入运行日志失败（${this.path}，本次 ${this.buffer.length} 条）：${message}`);
    }
    const written = this.buffer.length;
    this.buffer.length = 0;
    return written;
  }
}

/** 读回运行日志（JSONL → 事件数组）。 */
export function readRunLog(path: string, options: { limit?: number } = {}): LogEvent[] {
  const content = readFileSync(path, 'utf8');
  const events: LogEvent[] = [];
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? '').trim();
    if (line.length === 0) continue;
    try {
      events.push(JSON.parse(line) as LogEvent);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`运行日志第 ${index + 1} 行不是合法 JSON（${path}）：${message}`);
    }
  }
  if (options.limit !== undefined && options.limit >= 0) {
    return events.slice(-options.limit);
  }
  return events;
}

/**
 * 错误计数表：按错误码累加，随时取快照。
 *
 * 计数表只认「带错误码的事件」：成功事件不计入，批次级汇总因此天然只反映失败。
 */
export class ErrorCounter {
  private readonly counts = new Map<ErrorCode, { count: number; retryable: boolean }>();

  /** 累加一次。 */
  increment(code: ErrorCode, retryable = false): void {
    const current = this.counts.get(code);
    if (current === undefined) {
      this.counts.set(code, { count: 1, retryable });
      return;
    }
    current.count += 1;
    current.retryable = current.retryable || retryable;
  }

  /** 取当前分布快照。 */
  snapshot(): ErrorDistribution {
    const entries = [...this.counts.entries()]
      .map(([code, value]) => ({ code, count: value.count, retryable: value.retryable }))
      .sort((a, b) => {
        if (a.count !== b.count) return b.count - a.count;
        return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
      });
    return {
      total: entries.reduce((sum, entry) => sum + entry.count, 0),
      retryable: entries.reduce((sum, entry) => sum + (entry.retryable ? entry.count : 0), 0),
      entries,
    };
  }

  /** 清零。 */
  reset(): void {
    this.counts.clear();
  }
}

/**
 * 汇总一批日志里的错误分布。
 *
 * 只统计带错误码的事件（outcome 为 error / retry）；成功事件不计入。
 */
export function summarizeErrors(events: LogEvent[]): ErrorDistribution {
  const counter = new ErrorCounter();
  for (const event of events) {
    if (event.errorCode === null) continue;
    counter.increment(event.errorCode, event.retryable ?? false);
  }
  return counter.snapshot();
}

/** 错误分布的一句话中文摘要（写进运行摘要与表尾回执区）。 */
export function formatErrorDistribution(distribution: ErrorDistribution): string {
  if (distribution.total === 0) {
    return '本批没有检索错误。';
  }
  const items = distribution.entries.map(
    (entry) => `${entry.code} ×${entry.count}${entry.retryable ? '（可重试）' : ''}`,
  );
  return `本批错误分布：${items.join('、')}，共 ${distribution.total} 条，其中可重试 ${distribution.retryable} 条。`;
}

/** 检索结果行的最小形状（结构化类型定义，避免可观测层反向依赖检索层）。 */
export interface LookupOutcomeLike {
  rowNumber: number;
  registryId: string;
  binding: string;
  errorCode?: ErrorCode | null;
  durationMs?: number | null;
  attempts?: number | null;
}

/**
 * 把一批检索结果转成日志事件。
 *
 * 命中 → 成功事件；未完成 → 错误事件（带错误码）；歧义与零命中是**判定结果**
 * 而不是检索失败，记成成功事件并在 message 里说明，不混进错误分布。
 */
export function buildLookupEvents(rows: LookupOutcomeLike[]): LogEvent[] {
  const now = new Date().toISOString();
  return rows.map((row) => {
    const failed = row.binding === '未完成';
    const outcome: LogOutcome = failed ? 'error' : 'ok';
    const errorCode = failed ? (row.errorCode ?? 'unknown') : null;
    const message = failed
      ? `登记号 ${row.registryId} 本轮未取到院内记录`
      : row.binding === '歧义'
        ? `登记号 ${row.registryId} 院内命中多条，需人工判定`
        : row.binding === '零命中'
          ? `登记号 ${row.registryId} 院内无此记录`
          : `登记号 ${row.registryId} 已取到院内记录`;
    return {
      ts: now,
      stage: 'lookup' as const,
      outcome,
      rowNumber: row.rowNumber,
      rowId: row.registryId,
      errorCode,
      retryable: failed ? (row.errorCode === 'timeout' || row.errorCode === 'server_error' || row.errorCode === 'rate_limited') : null,
      durationMs: row.durationMs ?? null,
      attempts: row.attempts ?? 1,
      message,
      hint: failed ? '本轮该行未取得院内值，请按错误码处置后重跑' : null,
    };
  });
}
