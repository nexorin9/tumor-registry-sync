import { describe, expect, it } from 'vitest';
import type { RowStatus } from '../../src/contract/index.js';
import { InvalidTransitionError } from '../../src/confirm/state.js';
import { ModelTransitionError, applyTransition } from '../../src/confirm/transitions.js';

describe('transitions: 幂等', () => {
  it('current===next → changed:false，仍产出记录', () => {
    const r = applyTransition('待确认', '待确认', { source: 'user', rowNumber: 3, registryId: 'R1' });
    expect(r.changed).toBe(false);
    expect(r.status).toBe('待确认');
    expect(r.record.from).toBe('待确认');
    expect(r.record.to).toBe('待确认');
    expect(r.record.source).toBe('user');
    expect(typeof r.record.at).toBe('string');
  });
});

describe('transitions: 合法迁移', () => {
  it('待确认 → 采纳（user）', () => {
    const r = applyTransition('待确认', '采纳', { source: 'user', rowNumber: 1, registryId: 'R9' });
    expect(r.changed).toBe(true);
    expect(r.status).toBe('采纳');
    expect(r.record.to).toBe('采纳');
  });

  it('采纳 → 已推送（system）', () => {
    const r = applyTransition('采纳', '已推送', { source: 'system', rowNumber: 2 });
    expect(r.status).toBe('已推送');
  });
});

describe('transitions: 非法迁移', () => {
  it('待确认 → 已推送 抛 InvalidTransitionError', () => {
    expect(() => applyTransition('待确认', '已推送', { source: 'user' })).toThrow(InvalidTransitionError);
  });
});

describe('transitions: 撤回限制', () => {
  it('采纳 → 待确认 合法', () => {
    const r = applyTransition('采纳', '待确认', { source: 'user', rowNumber: 4 });
    expect(r.status).toBe('待确认');
  });

  it('已推送 → 待确认 抛 InvalidTransitionError（已推送不可回退）', () => {
    let thrown: unknown;
    try {
      applyTransition('已推送', '待确认', { source: 'user', rowNumber: 5 });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(InvalidTransitionError);
    if (thrown instanceof InvalidTransitionError) {
      expect(thrown.message).toContain('已推送行不可回退');
    }
  });
});

describe('transitions: 模型源限制', () => {
  const cases: Array<[RowStatus, RowStatus]> = [
    ['待确认', '采纳'],
    ['采纳', '已推送'],
    ['待对齐', '待确认'],
  ];
  for (const [from, to] of cases) {
    it(`source=model ${from} → ${to} 抛 ModelTransitionError`, () => {
      expect(() => applyTransition(from, to, { source: 'model' })).toThrow(ModelTransitionError);
    });
  }

  it('source=model 同态不报错', () => {
    const r = applyTransition('待确认', '待确认', { source: 'model' });
    expect(r.changed).toBe(false);
  });
});
