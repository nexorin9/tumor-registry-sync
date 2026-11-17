import { afterEach, describe, expect, it } from 'vitest';

import type { RegistryEnv } from '../../src/config/env.js';
import type { PushReceipt } from '../../src/contract/index.js';
import {
  PushError,
  RegistryClient,
} from '../../src/push/registry-client.js';
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

function envFor(url: string, token = 'registry-token', timeoutMs = 10_000): RegistryEnv {
  return { baseUrl: url, apiToken: token, payloadForm: 'field-level' };
}

function validBody() {
  return {
    resourceType: 'RegistryEntry' as const,
    identifier: { system: 'urn:x', value: 'R1' },
    subject: { reference: 'Patient/R1' },
    changedFields: [{ path: 'stage', oldValue: 'IIIA', newValue: 'IIIB' }],
    ifMatch: [{ path: 'stage', value: 'IIIA' }],
    extensions: {},
  };
}

describe('RegistryClient.pushRow · 请求形状', () => {
  it('请求带 Authorization、Idempotency-Key、Content-Type 与正确体', async () => {
    fake = createFakeRegistry(() => ({ status: 200, store: true }));
    await waitReady(fake);
    const client = new RegistryClient(envFor(fake.url));
    const key = 'key-123';
    const receipt = await client.pushRow(validBody(), key);
    expect(receipt.status).toBe('已推送');

    const req = fake.requests[0]!;
    expect(req.auth).toBe('Bearer registry-token');
    expect(req.key).toBe(key);
    expect(req.contentType).toContain('application/json');
    expect(req.body).toMatchObject({ resourceType: 'RegistryEntry' });
  });
});

describe('RegistryClient.pushRow · 状态码映射', () => {
  it('200 → 已推送', async () => {
    fake = createFakeRegistry(() => ({ status: 200, store: true }));
    await waitReady(fake);
    const client = new RegistryClient(envFor(fake.url));
    const r: PushReceipt = await client.pushRow(validBody(), 'k');
    expect(r.status).toBe('已推送');
    expect(r.code).toBeNull();
    expect(r.attempts).toBe(1);
    expect(typeof r.pushedAt).toBe('string');
  });

  it('401 → auth_failed（不可重试）', async () => {
    fake = createFakeRegistry(() => ({ status: 401 }));
    await waitReady(fake);
    const client = new RegistryClient(envFor(fake.url));
    await expect(client.pushRow(validBody(), 'k')).rejects.toMatchObject({
      code: 'auth_failed',
      retryable: false,
    });
  });

  it('403 → forbidden（不可重试）', async () => {
    fake = createFakeRegistry(() => ({ status: 403 }));
    await waitReady(fake);
    const client = new RegistryClient(envFor(fake.url));
    await expect(client.pushRow(validBody(), 'k')).rejects.toMatchObject({
      code: 'forbidden',
      retryable: false,
    });
  });

  it('429 → rate_limited（可重试）', async () => {
    fake = createFakeRegistry(() => ({ status: 429 }));
    await waitReady(fake);
    const client = new RegistryClient(envFor(fake.url));
    await expect(client.pushRow(validBody(), 'k')).rejects.toMatchObject({
      code: 'rate_limited',
      retryable: true,
    });
  });

  it('500 → server_error（可重试）', async () => {
    fake = createFakeRegistry(() => ({ status: 500 }));
    await waitReady(fake);
    const client = new RegistryClient(envFor(fake.url));
    await expect(client.pushRow(validBody(), 'k')).rejects.toMatchObject({
      code: 'server_error',
      retryable: true,
    });
  });

  it('404 → not_found（不可重试）', async () => {
    fake = createFakeRegistry(() => ({ status: 404 }));
    await waitReady(fake);
    const client = new RegistryClient(envFor(fake.url));
    await expect(client.pushRow(validBody(), 'k')).rejects.toMatchObject({
      code: 'not_found',
      retryable: false,
    });
  });

  it('超时 → timeout（可重试）', async () => {
    fake = createFakeRegistry(() => ({ status: 200, delayMs: 300 }));
    await waitReady(fake);
    const client = new RegistryClient(envFor(fake.url, 'registry-token'), 50);
    await expect(client.pushRow(validBody(), 'k')).rejects.toMatchObject({
      code: 'timeout',
      retryable: true,
    });
  });

  it('坏请求体 → bad_payload（不可重试）', async () => {
    fake = createFakeRegistry(() => ({ status: 200 }));
    await waitReady(fake);
    const client = new RegistryClient(envFor(fake.url));
    const bad = { ...validBody(), identifier: { value: 'R1' } } as object;
    await expect(client.pushRow(bad as never, 'k')).rejects.toMatchObject({
      code: 'bad_payload',
      retryable: false,
    });
  });
});

describe('RegistryClient · 缺环境变量', () => {
  it('缺少 baseUrl / apiToken 时抛 InvalidEnvError 并点名', async () => {
    const client = new RegistryClient({
      baseUrl: '',
      apiToken: '',
      payloadForm: 'field-level',
    });
    await expect(client.pushRow(validBody(), 'k')).rejects.toThrowError(/REGISTRY_/);
  });
});
