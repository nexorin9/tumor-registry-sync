import { describe, it, expect, vi } from 'vitest';
import type { ModelGateway } from '../../src/model/gateway.js';
import { buildDefaultVocabIndex } from '../../src/merge/vocab.js';
import { mergeWithModelFallback } from '../../src/merge/model-fallback.js';

const idx = buildDefaultVocabIndex();
const THRESHOLD = 0.8;

interface ModelOut {
  code: string | null;
  confidence: number;
}

function makeModel(impl: (args: { term: string; candidates: { code: string; label: string }[]; field: string }) => ModelOut) {
  const mergeTerm = vi.fn(impl);
  return { gateway: { mergeTerm } as unknown as ModelGateway, mergeTerm };
}

describe('mergeWithModelFallback 词表命中优先', () => {
  it('词表命中时绝不调用模型', async () => {
    const { gateway, mergeTerm } = makeModel(() => ({ code: 'X', confidence: 0.9 }));
    const r = await mergeWithModelFallback(
      { term: 'IIIB', field: 'stage', controlledCodeField: true },
      { vocab: idx, model: gateway, threshold: THRESHOLD },
    );
    expect(r.source).toBe('exact');
    expect(r.code).toBe('IIIB');
    expect(mergeTerm).not.toHaveBeenCalled();
  });
});

describe('模型兜底门禁', () => {
  it('模型为 null → none，code 置空', async () => {
    const r = await mergeWithModelFallback(
      { term: '未知分期', field: 'stage', controlledCodeField: true },
      { vocab: idx, model: null, threshold: THRESHOLD },
    );
    expect(r.code).toBeNull();
    expect(r.source).toBe('none');
    expect(r.reason).toBe('需人工判定');
  });

  it('模型返回低置信度 → none，code 置空（模型猜测值不进入结果）', async () => {
    const { gateway, mergeTerm } = makeModel(() => ({ code: 'GUESS', confidence: 0.5 }));
    const r = await mergeWithModelFallback(
      { term: '未知分期', field: 'stage', controlledCodeField: true },
      { vocab: idx, model: gateway, threshold: THRESHOLD },
    );
    expect(mergeTerm).toHaveBeenCalledTimes(1);
    expect(r.code).toBeNull();
    expect(r.source).toBe('none');
    expect(r.reason).toBe('需人工判定');
  });

  it('模型返回高置信度且为受控字段 → source model，code 设置', async () => {
    const { gateway, mergeTerm } = makeModel(() => ({ code: 'IIIC', confidence: 0.9 }));
    const r = await mergeWithModelFallback(
      { term: 'IIIC', field: 'stage', controlledCodeField: true },
      { vocab: idx, model: gateway, threshold: THRESHOLD },
    );
    expect(mergeTerm).toHaveBeenCalledTimes(1);
    expect(r.source).toBe('model');
    expect(r.code).toBe('IIIC');
    expect(r.confidence).toBe(0.9);
  });

  it('非受控字段 → 即使模型可用也不调用', async () => {
    const { gateway, mergeTerm } = makeModel(() => ({ code: 'X', confidence: 0.95 }));
    const r = await mergeWithModelFallback(
      { term: '自由文本备注', field: 'note', controlledCodeField: false },
      { vocab: idx, model: gateway, threshold: THRESHOLD },
    );
    expect(mergeTerm).not.toHaveBeenCalled();
    expect(r.code).toBeNull();
    expect(r.source).toBe('none');
  });

  it('模型返回非法输出（code 非字符串/null）→ 判为需人工判定', async () => {
    const bad = {
      mergeTerm: vi.fn(async () => ({ code: 123, confidence: 0.9 })),
    } as unknown as ModelGateway;
    const r = await mergeWithModelFallback(
      { term: '未知', field: 'stage', controlledCodeField: true },
      { vocab: idx, model: bad, threshold: THRESHOLD },
    );
    expect(r.code).toBeNull();
    expect(r.source).toBe('none');
  });
});

describe('模型结果仅作建议', () => {
  it('低于阈值时 code 恒为 null（不会直达推送体）', async () => {
    const { gateway } = makeModel(() => ({ code: 'SHOULD_NOT_APPEAR', confidence: 0.4 }));
    const r = await mergeWithModelFallback(
      { term: '未知', field: 'stage', controlledCodeField: true },
      { vocab: idx, model: gateway, threshold: THRESHOLD },
    );
    expect(r.code).toBeNull();
    expect(r.confidence).toBe(0);
  });
});
