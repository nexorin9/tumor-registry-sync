import { afterEach, describe, expect, it } from 'vitest';

import type { ModelEnv } from '../../src/config/env.js';
import {
  OpenAIGateway,
  degradedExplainDiff,
  degradedMergeTerm,
  isDegradedMerge,
} from '../../src/model/index.js';
import type { ModelAuditRecorder, ModelCallMeta } from '../../src/model/index.js';
import { startMockModelServer, type MockModelServer } from './mockModelServer.js';

/** 捕获审计元数据的记录器（仅测试用）。 */
class CapturingRecorder implements ModelAuditRecorder {
  readonly metas: ModelCallMeta[] = [];
  record(meta: ModelCallMeta): void {
    this.metas.push(meta);
  }
}

function makeEnv(url: string, timeoutMs = 5_000): ModelEnv {
  return { baseUrl: url, apiKey: 'test-key', name: 'test-model', timeoutMs };
}

const MERGE_INPUT = {
  term: '肺CA',
  candidates: [{ code: 'C34', label: '肺恶性肿瘤' }],
  field: 'diagnosis',
};

const EXPLAIN_INPUT = {
  field: 'stage',
  registryValue: 'III',
  hospitalValue: '3期',
  fieldNote: '登记库用罗马数字，院内用中文',
};

describe('OpenAIGateway 正常路径', () => {
  let server: MockModelServer;
  afterEach(async () => {
    await server?.close();
  });

  it('mergeTerm 解析结构化输出', async () => {
    server = await startMockModelServer({
      content: JSON.stringify({ code: 'C34', confidence: 0.91, reason: '同义归并' }),
      usage: { prompt_tokens: 12, completion_tokens: 8 },
    });
    const recorder = new CapturingRecorder();
    const gw = new OpenAIGateway(makeEnv(server.url), { audit: recorder });
    const out = await gw.mergeTerm(MERGE_INPUT);

    expect(out.code).toBe('C34');
    expect(out.confidence).toBeCloseTo(0.91);
    expect(out.reason).toBe('同义归并');
    expect(isDegradedMerge(out)).toBe(false);
    expect(recorder.metas).toHaveLength(1);
    expect(recorder.metas[0]?.degraded).toBe(false);
    expect(recorder.metas[0]?.attempts).toBe(1);
    expect(recorder.metas[0]?.usage).toEqual({ promptTokens: 12, completionTokens: 8 });
  });

  it('explainDiff 返回 note', async () => {
    server = await startMockModelServer({
      content: JSON.stringify({ note: '口径差异：罗马数字与中文表述' }),
    });
    const gw = new OpenAIGateway(makeEnv(server.url));
    const out = await gw.explainDiff(EXPLAIN_INPUT);
    expect(out.note).toBe('口径差异：罗马数字与中文表述');
  });
});

describe('OpenAIGateway 故障与降级', () => {
  let server: MockModelServer;
  afterEach(async () => {
    await server?.close();
  });

  it('结构化输出校验失败 → 重试一次后降级', async () => {
    server = await startMockModelServer({ content: '{这不是合法json' });
    const recorder = new CapturingRecorder();
    const gw = new OpenAIGateway(makeEnv(server.url), { audit: recorder });
    const out = await gw.mergeTerm(MERGE_INPUT);

    expect(out.code).toBeNull();
    expect(isDegradedMerge(out)).toBe(true);
    expect(out).toEqual(degradedMergeTerm());
    expect(recorder.metas[0]?.degraded).toBe(true);
    expect(recorder.metas[0]?.attempts).toBe(2); // 重试一次
  });

  it('429 → 重试后成功', async () => {
    let calls = 0;
    server = await startMockModelServer(() => {
      calls += 1;
      if (calls === 1) return { status: 429, content: '{}' };
      return {
        status: 200,
        content: JSON.stringify({ code: 'C34', confidence: 0.8, reason: '重试成功' }),
      };
    });
    const recorder = new CapturingRecorder();
    const gw = new OpenAIGateway(makeEnv(server.url), { audit: recorder });
    const out = await gw.mergeTerm(MERGE_INPUT);

    expect(out.code).toBe('C34');
    expect(recorder.metas[0]?.degraded).toBe(false);
    expect(recorder.metas[0]?.attempts).toBe(2); // 一次失败 + 一次成功
  });

  it('500 → 重试耗尽后降级', async () => {
    server = await startMockModelServer({ status: 500, content: '{}' });
    const recorder = new CapturingRecorder();
    const gw = new OpenAIGateway(makeEnv(server.url), { audit: recorder });
    const out = await gw.mergeTerm(MERGE_INPUT);

    expect(out.code).toBeNull();
    expect(recorder.metas[0]?.degraded).toBe(true);
    expect(recorder.metas[0]?.attempts).toBe(3); // 封顶 3 次
  });

  it('401/403 → 不重试，立即降级', async () => {
    server = await startMockModelServer({ status: 401, content: '{}' });
    const recorder = new CapturingRecorder();
    const gw = new OpenAIGateway(makeEnv(server.url), { audit: recorder });
    const out = await gw.mergeTerm(MERGE_INPUT);

    expect(out.code).toBeNull();
    expect(recorder.metas[0]?.degraded).toBe(true);
    expect(recorder.metas[0]?.attempts).toBe(1); // 绝不重试
  });

  it('超时 → 降级（小 timeoutMs + 延迟服务器）', async () => {
    server = await startMockModelServer({ status: 200, content: '{}', delayMs: 500 });
    const recorder = new CapturingRecorder();
    const gw = new OpenAIGateway(makeEnv(server.url, 50), { audit: recorder });
    const out = await gw.mergeTerm(MERGE_INPUT);

    expect(out.code).toBeNull();
    expect(recorder.metas[0]?.degraded).toBe(true);
  });
});

describe('OpenAIGateway 占位符 / 降级产物', () => {
  it('baseUrl 为占位符 → 直接降级，不崩溃', async () => {
    const recorder = new CapturingRecorder();
    const gw = new OpenAIGateway(
      { baseUrl: 'https://api.example.com/v1', apiKey: 'x', name: 'm', timeoutMs: 1000 },
      { audit: recorder },
    );
    const out = await gw.mergeTerm(MERGE_INPUT);
    expect(out.code).toBeNull();
    expect(recorder.metas[0]?.degraded).toBe(true);
    expect(recorder.metas[0]?.attempts).toBe(0);
  });

  it('降级产物：mergeTerm 为 code=null', () => {
    const d = degradedMergeTerm();
    expect(d).toEqual({ code: null, confidence: 0, reason: '模型未启用或不可达' });
    expect(isDegradedMerge(d)).toBe(true);
  });

  it('降级产物：explainDiff 为固定中文说明', () => {
    expect(degradedExplainDiff()).toEqual({
      note: '字段口径不一致，请人工核对（模型未启用）',
    });
  });
});
