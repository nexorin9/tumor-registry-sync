/**
 * 重试队列与批量推送（带退避与幂等重放）。
 *
 * 设计要点：
 * - 退避是确定性（不抖动的）：base * factor^(attempt-1) 封顶 maxMs，便于复现
 * - 单行失败绝不拖垮其他行：每行独立尝试，互不阻塞
 * - 可重试错误（429/5xx/timeout）按退避重试；不可重试（4xx）立即判推送失败
 * - 重试耗尽 → 落「待重试」回执并进队列，供断点续跑
 * - 幂等重放安全：同一 idempotencyKey 重复提交，由客户端/服务端去重，本层可重复调用
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { PushReceipt } from '../contract/index.js';
import type { RegistryEntry } from './payload-schema.js';
import { PushError } from './registry-client.js';
import type { RegistryClient } from './registry-client.js';

/** 退避毫秒数：base * factor^(attempt-1)，封顶 maxMs（确定性、无抖动）。 */
export function backoffDelayMs(
  attempt: number,
  baseMs = 1000,
  factor = 2,
  maxMs = 8000,
): number {
  const raw = baseMs * Math.pow(factor, attempt - 1);
  return Math.min(raw, maxMs);
}

export type RetryClassification = 'retryable' | 'fatal';

/** 按 PushError.retryable 判定本错误是否可重试。 */
export function classifyError(err: PushError): RetryClassification {
  return err.retryable ? 'retryable' : 'fatal';
}

export interface RetryItem {
  rowNumber: number;
  registryId: string | null;
  body: RegistryEntry;
  idempotencyKey: string;
  attempts: number;
  nextRetryAt?: string;
}

export interface PushBatchInput {
  rowNumber: number;
  registryId: string | null;
  body: RegistryEntry;
  idempotencyKey: string;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('已取消', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('已取消', 'AbortError'));
      },
      { once: true },
    );
  });
}

/**
 * 批量推送（带重试）。
 *
 * 每行最多尝试 maxAttempts 次；可重试错误之间按退避等待；不可重试立即出推送失败回执；
 * 重试耗尽出待重试回执并加入 queue。单行失败不影响其他行。
 * 幂等重放安全：同一 idempotencyKey 本函数可重复调用，由服务端去重。
 */
export async function pushBatchWithRetry(
  rows: PushBatchInput[],
  client: RegistryClient,
  opts?: { maxAttempts?: number; signal?: AbortSignal },
): Promise<{ receipts: PushReceipt[]; queue: RetryItem[] }> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const receipts: PushReceipt[] = [];
  const queue: RetryItem[] = [];

  for (const row of rows) {
    let outcome: 'success' | 'fatal' | 'exhausted' = 'exhausted';
    let finalReceipt: PushReceipt | null = null;
    let lastErr: PushError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await client.pushRow(row.body, row.idempotencyKey);
        result.rowNumber = row.rowNumber;
        result.registryId = row.registryId;
        result.attempts = attempt;
        finalReceipt = result;
        outcome = 'success';
        break;
      } catch (error) {
        const err = error as PushError;
        lastErr = err;
        if (!err.retryable) {
          finalReceipt = {
            rowNumber: row.rowNumber,
            registryId: row.registryId,
            status: '推送失败',
            code: err.code,
            reason: err.message,
            idempotencyKey: row.idempotencyKey,
            attempts: attempt,
            pushedAt: null,
          };
          outcome = 'fatal';
          break;
        }
        if (attempt < maxAttempts) {
          await sleep(backoffDelayMs(attempt), opts?.signal);
        }
      }
    }

    if (outcome === 'success' && finalReceipt) {
      receipts.push(finalReceipt);
    } else if (outcome === 'fatal' && finalReceipt) {
      receipts.push(finalReceipt);
    } else {
      // 重试耗尽
      const item: RetryItem = {
        rowNumber: row.rowNumber,
        registryId: row.registryId,
        body: row.body,
        idempotencyKey: row.idempotencyKey,
        attempts: maxAttempts,
        nextRetryAt: new Date(Date.now() + backoffDelayMs(maxAttempts)).toISOString(),
      };
      queue.push(item);
      receipts.push({
        rowNumber: row.rowNumber,
        registryId: row.registryId,
        status: '待重试',
        code: lastErr ? lastErr.code : null,
        reason: lastErr ? lastErr.message : '重试次数耗尽',
        idempotencyKey: row.idempotencyKey,
        attempts: maxAttempts,
        pushedAt: null,
      });
    }
  }

  return { receipts, queue };
}

/** 重试队列：落盘 JSON，断点续跑。简单实现，仅持久化待重试项。 */
export class RetryQueue {
  private items: RetryItem[] = [];

  /** 从磁盘加载（文件不存在则视为空队列）；同一批次键只重跑 pending 项。 */
  load(path: string): void {
    try {
      const raw = readFileSync(path, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      this.items = Array.isArray(parsed) ? (parsed as RetryItem[]) : [];
    } catch {
      this.items = [];
    }
  }

  add(item: RetryItem): void {
    this.items.push(item);
  }

  pending(): RetryItem[] {
    return [...this.items];
  }

  save(path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(this.items, null, 2), 'utf8');
  }
}
