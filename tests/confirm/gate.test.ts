import { describe, expect, it } from 'vitest';
import type { RowStatus } from '../../src/contract/index.js';
import {
  PUSHABLE_STATUSES,
  filterPushable,
  isPushable,
  splitPushable,
} from '../../src/confirm/gate.js';

type Row = { rowNumber: number; registryId: string | null; status: RowStatus };

describe('gate: isPushable', () => {
  it('仅「采纳」可推送', () => {
    expect(isPushable('采纳')).toBe(true);
    for (const s of ['待确认', '不采纳', '待对齐', '需人工判定', '零命中', '命中歧义', '已推送', '推送失败', '无需确认', '院内已变更，需重查'] as RowStatus[]) {
      expect(isPushable(s)).toBe(false);
    }
  });

  it('PUSHABLE_STATUSES 仅含采纳', () => {
    expect(PUSHABLE_STATUSES).toEqual(['采纳']);
  });
});

describe('gate: filterPushable', () => {
  it('只保留采纳行', () => {
    const rows: Row[] = [
      { rowNumber: 1, registryId: 'R1', status: '采纳' },
      { rowNumber: 2, registryId: 'R2', status: '待确认' },
      { rowNumber: 3, registryId: null, status: '采纳' },
      { rowNumber: 4, registryId: 'R4', status: '零命中' },
    ];
    const out = filterPushable(rows);
    expect(out.map((r) => r.rowNumber)).toEqual([1, 3]);
  });
});

describe('gate: splitPushable', () => {
  it('切分可推送与跳过，跳过带原因', () => {
    const rows: Row[] = [
      { rowNumber: 1, registryId: 'R1', status: '采纳' },
      { rowNumber: 2, registryId: 'R2', status: '待确认' },
      { rowNumber: 3, registryId: 'R3', status: '不采纳' },
      { rowNumber: 4, registryId: 'R4', status: '需人工判定' },
      { rowNumber: 5, registryId: 'R5', status: '零命中' },
      { rowNumber: 6, registryId: 'R6', status: '命中歧义' },
    ];
    const { pushable, skipped } = splitPushable(rows);
    expect(pushable.map((r) => r.rowNumber)).toEqual([1]);
    expect(skipped).toHaveLength(5);
    const reasons = skipped.map((s) => s.reason);
    expect(reasons[0]).toContain('待确认');
    expect(reasons[0]).toContain('未确认，不外发');
    for (const s of skipped) {
      expect(s.reason).toMatch(/状态「.+」未确认，不外发/);
    }
  });
});
