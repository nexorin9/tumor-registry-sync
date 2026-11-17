import { afterEach, describe, expect, it } from 'vitest';

import { RunLogger } from '../../src/observability/index.js';
import {
  OpenAIGateway,
  RunLoggerAuditRecorder,
  desensitize,
  promptHash,
  writeModelAudit,
} from '../../src/model/index.js';
import type { ModelCallMeta } from '../../src/model/index.js';
import { startMockModelServer, type MockModelServer } from './mockModelServer.js';

function makeEnv(url: string): import('../../src/config/env.js').ModelEnv {
  return { baseUrl: url, apiKey: 'k', name: 'm', timeoutMs: 5_000 };
}

describe('promptHash 审计指纹', () => {
  it('相同输入哈希稳定', () => {
    const a = { term: '肺CA', candidates: [{ code: 'C34', label: 'x' }] };
    expect(promptHash(a)).toBe(promptHash(a));
  });

  it('不同输入哈希不同', () => {
    const a = { term: '肺CA' };
    const b = { term: '肝CA' };
    expect(promptHash(a)).not.toBe(promptHash(b));
  });

  it('哈希不含明文术语（单向、不可逆）', () => {
    const input = { term: '肺癌', candidates: [] as unknown[] };
    const hash = promptHash(input);
    // sha256 hex，长度固定 64，不会是明文字符串的子串
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const original = JSON.stringify(input);
    expect(original).toContain('肺癌');
    expect(hash).not.toContain('肺癌');
    expect(original.includes(hash)).toBe(false);
  });
});

describe('desensitize 脱敏', () => {
  it('超长自由文本替换为长度摘要', () => {
    const out = desensitize({ note: 'x'.repeat(120) }) as { note: string };
    expect(out.note).toBe('[文本 120 字]');
  });

  it('姓名类字段被抹除', () => {
    const out = desensitize({ patientName: '张三', code: 'C34' }) as Record<string, unknown>;
    expect(out.patientName).toBe('[redacted]');
    expect(out.code).toBe('C34');
  });
});

describe('审计落盘与隔离', () => {
  let server: MockModelServer;
  afterEach(async () => {
    if (server) {
      await server.close();
      server = undefined;
    }
  });

  it('服务器省略 usage → 记录为 null（不猜测）', async () => {
    server = await startMockModelServer({
      content: JSON.stringify({ code: 'C34', confidence: 0.9, reason: 'r' }),
      // 不返回 usage
    });
    const recorder = new CapturingRecorder();
    const gw = new OpenAIGateway(makeEnv(server.url), { audit: recorder });
    await gw.mergeTerm({ term: 't', candidates: [{ code: 'C34', label: 'l' }], field: 'f' });
    expect(recorder.metas[0]?.usage).toBeNull();
  });

  it('服务器返回 usage → 如实记录', async () => {
    server = await startMockModelServer({
      content: JSON.stringify({ note: 'n' }),
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    });
    const recorder = new CapturingRecorder();
    const gw = new OpenAIGateway(makeEnv(server.url), { audit: recorder });
    await gw.explainDiff({
      field: 'f',
      registryValue: 'a',
      hospitalValue: 'b',
      fieldNote: 'n',
    });
    expect(recorder.metas[0]?.usage).toEqual({ promptTokens: 3, completionTokens: 2 });
  });

  it('降级时 degraded 标记为 true', async () => {
    server = await startMockModelServer({ status: 403, content: '{}' });
    const recorder = new CapturingRecorder();
    const gw = new OpenAIGateway(makeEnv(server.url), { audit: recorder });
    const out = await gw.mergeTerm({ term: 't', candidates: [], field: 'f' });
    expect(out.code).toBeNull();
    expect(recorder.metas[0]?.degraded).toBe(true);
  });

  it('writeModelAudit 落到 RunLogger 的 model 阶段事件（且不推进业务状态）', () => {
    const logger = new RunLogger({ path: 'audit-test.log', stage: 'model' });
    const meta: ModelCallMeta = {
      model: 'm',
      promptHash: 'abc',
      inputSummary: 's',
      outputSummary: 'o',
      durationMs: 10,
      usage: null,
      degraded: false,
      attempts: 1,
    };
    writeModelAudit(logger, meta);
    const events = logger.events;
    expect(events).toHaveLength(1);
    expect(events[0]?.stage).toBe('model');
    expect(events[0]?.outcome).toBe('ok');
    expect(events[0]?.errorCode).toBeNull();

    // 降级事件：errorCode = model_unavailable
    writeModelAudit(logger, { ...meta, degraded: true });
    const last = logger.events[logger.events.length - 1];
    expect(last?.outcome).toBe('error');
    expect(last?.errorCode).toBe('model_unavailable');
  });

  it('RunLoggerAuditRecorder 适配器把元数据写成 model 事件', () => {
    const logger = new RunLogger({ path: 'audit-adapter.log', stage: 'model' });
    const recorder = new RunLoggerAuditRecorder(logger);
    recorder.record({
      model: 'm',
      promptHash: 'h',
      inputSummary: 'i',
      outputSummary: 'o',
      durationMs: 1,
      usage: null,
      degraded: false,
      attempts: 1,
    });
    expect(logger.events[0]?.stage).toBe('model');
  });
});

/** 捕获审计元数据（仅测试用）。 */
class CapturingRecorder {
  readonly metas: ModelCallMeta[] = [];
  record(meta: ModelCallMeta): void {
    this.metas.push(meta);
  }
}
