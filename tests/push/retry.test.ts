import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RegistryEnv } from '../../src/config/env.js';
import type { RegistryEntry } from '../../src/push/payload-schema.js';
import {
  backoffDelayMs,
  classifyError,
  pushBatchWithRetry,
  RetryQueue,
} from '../../src/push/retry.js';
import { PushError, RegistryClient } from '../../src/push/registry-client.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createFakeRegistry,
  waitReady,
  type FakeRegistry,
} from './fake-registry.js';

let fake: FakeRegistry | null = null;

afterEach(async () => {
  if (fake) {
    await fake.close();
    fake = null;
  }
});

function bodyFor(value: string, registryId = 'R1'): RegistryEntry {
  return {
    resourceType: 'RegistryEntry',
    identifier: { system: 'urn:x', value: registryId },
    subject: { reference: `Patient/${registryId}` },
    changedFields: [{ path: 'stage', oldValue: 'IIIA', newValue: value }],
    ifMatch: [{ path: 'stage', value: 'IIIA' }],
    extensions: {},
  };
}

function input(rowNumber: number, key: string, value: string, registryId = `R${rowNumber}`) {
  return { rowNumber, registryId, body: bodyFor(value, registryId), idempotencyKey: key };
}

describe('backoffDelayMs', () => {
  it('base * factor^(attempt-1) 封顶', () => {
    expect(backoffDelayMs(1)).toBe(1000);
    expect(backoffDelayMs(2)).toBe(2000);
    expect(backoffDelayMs(3)).toBe(4000);
    expect(backoffDelayMs(10)).toBe(8000);
  });
});

describe('classifyError', () => {
  it('按 retryable 判定', () => {
    expect(classifyError(new PushError('server_error', true, 'x'))).toBe('retryable');
    expect(classifyError(new PushError('auth_failed', false, 'x'))).toBe('fatal');
  });
});

describe('pushBatchWithRetry', () => {
  it('第一次 500，重试后 200 → 已推送', async () => {
    const attempts = new Map<string, number>();
    fake = createFakeRegistry((_req, key) => {
      const n = (attempts.get(key ?? '') ?? 0) + 1;
      attempts.set(key ?? '', n);
      if (n === 1) return { status: 500, store: false };
      return { status: 200, store: true };
    });
    await waitReady(fake);
    const client = new RegistryClient({ baseUrl: fake.url, apiToken: 't', payloadForm: 'field-level' });
    const { receipts, queue } = await pushBatchWithRetry(
      [input(1, 'k1', 'IIIB')],
      client,
      { maxAttempts: 2 },
    );
    expect(receipts[0]!.status).toBe('已推送');
    expect(receipts[0]!.attempts).toBe(2);
    expect(queue).toHaveLength(0);
  });

  it('一行持续 500，其余全部 已推送（单行失败不阻塞他人）', async () => {
    const failingKey = 'fail-key';
    fake = createFakeRegistry((_req, key) =>
      key === failingKey ? { status: 500, store: false } : { status: 200, store: true },
    );
    await waitReady(fake);
    const client = new RegistryClient({ baseUrl: fake.url, apiToken: 't', payloadForm: 'field-level' });
    const { receipts, queue } = await pushBatchWithRetry(
      [
        input(1, 'k1', 'IIIB'),
        input(2, failingKey, 'IV'),
        input(3, 'k3', 'IIIC'),
      ],
      client,
      { maxAttempts: 2 },
    );
    const byRow = new Map(receipts.map((r) => [r.rowNumber, r.status]));
    expect(byRow.get(1)).toBe('已推送');
    expect(byRow.get(3)).toBe('已推送');
    expect(byRow.get(2)).toBe('待重试');
    expect(queue).toHaveLength(1);
    expect(queue[0]!.idempotencyKey).toBe(failingKey);
  });

  it('4xx → 推送失败且不再重试', async () => {
    fake = createFakeRegistry(() => ({ status: 404, store: false }));
    await waitReady(fake);
    const client = new RegistryClient({ baseUrl: fake.url, apiToken: 't', payloadForm: 'field-level' });
    const { receipts, queue } = await pushBatchWithRetry(
      [input(1, 'k1', 'IIIB')],
      client,
      { maxAttempts: 3 },
    );
    expect(receipts[0]!.status).toBe('推送失败');
    expect(receipts[0]!.attempts).toBe(1);
    expect(receipts[0]!.code).toBe('not_found');
    expect(queue).toHaveLength(0);
    // 只发起了一次请求（未重试）
    expect(fake.requests).toHaveLength(1);
  });

  it('重试耗尽 → 待重试 + 进入队列', async () => {
    fake = createFakeRegistry(() => ({ status: 500, store: false }));
    await waitReady(fake);
    const client = new RegistryClient({ baseUrl: fake.url, apiToken: 't', payloadForm: 'field-level' });
    const { receipts, queue } = await pushBatchWithRetry(
      [input(1, 'k1', 'IIIB')],
      client,
      { maxAttempts: 2 },
    );
    expect(receipts[0]!.status).toBe('待重试');
    expect(receipts[0]!.attempts).toBe(2);
    expect(receipts[0]!.code).toBe('server_error');
    expect(queue).toHaveLength(1);
    expect(queue[0]!.rowNumber).toBe(1);
  });

  it('同一 idempotencyKey 重放 → 替身只存一条（去重）', async () => {
    fake = createFakeRegistry(() => ({ status: 200, store: true }));
    await waitReady(fake);
    const client = new RegistryClient({ baseUrl: fake.url, apiToken: 't', payloadForm: 'field-level' });
    const inputs = [input(1, 'k1', 'IIIB'), input(2, 'k2', 'IV'), input(3, 'k3', 'IIIC')];
    await pushBatchWithRetry(inputs, client, { maxAttempts: 2 });
    // 重放同一批次（相同 idempotencyKey）
    await pushBatchWithRetry(inputs, client, { maxAttempts: 2 });
    expect(fake.stored.size).toBe(3);
    for (const count of fake.stored.values()) {
      expect(count).toBe(1);
    }
  });
});

describe('RetryQueue · 持久化', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'retry-queue-'));
    path = join(dir, 'queue.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('add / pending / save / load 往返一致', () => {
    const q = new RetryQueue();
    q.add({
      rowNumber: 2,
      registryId: 'R2',
      body: bodyFor('IV', 'R2'),
      idempotencyKey: 'fail-key',
      attempts: 2,
    });
    expect(q.pending()).toHaveLength(1);
    q.save(path);

    const q2 = new RetryQueue();
    q2.load(path);
    expect(q2.pending()).toHaveLength(1);
    expect(q2.pending()[0]!.idempotencyKey).toBe('fail-key');
  });

  it('load 文件不存在时为空队列', () => {
    const q = new RetryQueue();
    q.load(join(dir, 'missing.json'));
    expect(q.pending()).toHaveLength(0);
  });
});
