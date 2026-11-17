import { describe, it, expect } from 'vitest';
import {
  buildDefaultVocabIndex,
  mergeByVocab,
  DEFAULT_STAGING_VOCAB,
} from '../../src/merge/vocab.js';

const idx = buildDefaultVocabIndex();

describe('默认分期词表归并', () => {
  it('多种写法归并到同一受控编码 IIIB', () => {
    for (const raw of ['ⅢB', 'IIIB', 'III B', 'IIIB期']) {
      const r = mergeByVocab(raw, idx);
      expect(r.code).toBe('IIIB');
      expect(r.matchedBy === 'exact' || r.matchedBy === 'normalized').toBe(true);
    }
  });

  it('默认词表内部一致（无重复 code）', () => {
    const codes = new Set(DEFAULT_STAGING_VOCAB.map((t) => t.code));
    expect(codes.size).toBe(DEFAULT_STAGING_VOCAB.length);
  });

  it('未知术语返回 none', () => {
    const r = mergeByVocab('ZZZUNKNOWN', idx);
    expect(r.matchedBy).toBe('none');
    expect(r.code).toBeNull();
    expect(r.confidence).toBe(0);
  });

  it('已知 IA 命中', () => {
    expect(mergeByVocab('IA期', idx).code).toBe('IA');
    expect(mergeByVocab('ⅠA', idx).code).toBe('IA');
  });
});
