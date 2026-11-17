import { describe, it, expect } from 'vitest';
import {
  TIER_SCORE,
  DEFAULT_THRESHOLD,
  tierOf,
  isConfident,
  confidenceVersion,
  evaluateMerge,
} from '../../src/merge/confidence.js';

describe('TIER_SCORE', () => {
  it('各层级分数符合约定', () => {
    expect(TIER_SCORE).toMatchObject({
      exact: 1.0,
      normalized: 0.95,
      alias: 0.9,
      fuzzy: 0.6,
      model: 0.7,
    });
  });
});

describe('阈值与 isConfident', () => {
  it('默认阈值为 0.8', () => {
    expect(DEFAULT_THRESHOLD).toBe(0.8);
  });

  it('大于等于阈值即可信', () => {
    expect(isConfident(0.95, 0.8)).toBe(true);
    expect(isConfident(0.8, 0.8)).toBe(true);
    expect(isConfident(0.79, 0.8)).toBe(false);
    expect(isConfident(0.6, 0.8)).toBe(false);
  });
});

describe('tierOf', () => {
  it('命中方式映射到层级', () => {
    expect(tierOf('exact')).toBe('exact');
    expect(tierOf('normalized')).toBe('normalized');
    expect(tierOf('alias')).toBe('alias');
    expect(tierOf('model')).toBe('model');
  });
});

describe('evaluateMerge', () => {
  it('低于阈值 → 需人工判定', () => {
    const r = evaluateMerge({ code: 'IIIB', confidence: 0.7 }, 0.8);
    expect(r.accepted).toBe(false);
    expect(r.needsHuman).toBe(true);
  });

  it('code 为 null → 需人工判定', () => {
    const r = evaluateMerge({ code: null, confidence: 0 }, 0.8);
    expect(r.accepted).toBe(false);
    expect(r.needsHuman).toBe(true);
  });

  it('达阈值且 code 非空 → 接受', () => {
    const r = evaluateMerge({ code: 'IIIB', confidence: 0.95 }, 0.8);
    expect(r.accepted).toBe(true);
    expect(r.needsHuman).toBe(false);
  });
});

describe('confidenceVersion', () => {
  it('由阈值派生且稳定', () => {
    expect(confidenceVersion(0.8)).toBe('merge-threshold-0.8');
    expect(confidenceVersion(0.8)).toBe(confidenceVersion(0.8));
    expect(confidenceVersion(0.7)).toBe('merge-threshold-0.7');
  });
});
