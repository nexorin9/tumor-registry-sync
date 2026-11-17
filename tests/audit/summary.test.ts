import { describe, expect, it } from 'vitest';

import type { LogEvent, RowIssue, SummaryCounts } from '../../src/contract/index.js';
import {
  buildSummary,
  crossCheckSummary,
  formatLastSynced,
  formatSummary,
  summarizeIssueRows,
} from '../../src/audit/summary.js';

function event(over: Partial<LogEvent>): LogEvent {
  return {
    ts: '2026-11-08T00:00:00.000Z',
    stage: 'push',
    outcome: 'ok',
    rowNumber: 1,
    rowId: 'REG-0001',
    errorCode: null,
    retryable: null,
    durationMs: null,
    attempts: 1,
    message: 'x',
    hint: null,
    ...over,
  };
}

describe('buildSummary', () => {
  it('缺省字段全部补 0 / false', () => {
    const summary = buildSummary({ total: 10 });
    const expected: SummaryCounts = {
      total: 10,
      matched: 0,
      ambiguous: 0,
      noMatch: 0,
      diffRows: 0,
      pendingConfirm: 0,
      adopted: 0,
      pushed: 0,
      failed: 0,
      pendingRetry: 0,
      missingRows: 0,
      issueRows: 0,
      missingCheckIncomplete: false,
    };
    expect(summary).toEqual(expected);
  });

  it('传入的字段被保留', () => {
    const summary = buildSummary({ total: 5, matched: 3, pushed: 2, missingCheckIncomplete: true });
    expect(summary.matched).toBe(3);
    expect(summary.pushed).toBe(2);
    expect(summary.missingCheckIncomplete).toBe(true);
  });
});

describe('crossCheckSummary', () => {
  it('一致时返回 ok:true', () => {
    const summary = buildSummary({
      total: 10,
      pushed: 3,
      failed: 1,
      pendingRetry: 0,
      issueRows: 2,
    });
    const events: LogEvent[] = [
      event({ rowNumber: 1, outcome: 'ok', stage: 'push' }),
      event({ rowNumber: 2, outcome: 'ok', stage: 'push' }),
      event({ rowNumber: 3, outcome: 'ok', stage: 'push' }),
      event({ rowNumber: 5, outcome: 'error', stage: 'push', errorCode: 'server_error' }),
      event({ rowNumber: 5, outcome: 'error', stage: 'lookup', errorCode: 'not_found' }),
      event({ rowNumber: 6, outcome: 'ok', stage: 'lookup', errorCode: 'timeout' }),
    ];
    const result = crossCheckSummary(summary, events);
    expect(result.ok).toBe(true);
  });

  it('pushed 与日志矛盾时返回 ok:false 且 note 点名', () => {
    const summary = buildSummary({ total: 10, pushed: 5, failed: 0, issueRows: 0 });
    const events: LogEvent[] = [
      event({ rowNumber: 1, outcome: 'ok', stage: 'push' }),
      event({ rowNumber: 2, outcome: 'ok', stage: 'push' }),
      event({ rowNumber: 3, outcome: 'ok', stage: 'push' }),
    ];
    const result = crossCheckSummary(summary, events);
    expect(result.ok).toBe(false);
    expect(result.note).toContain('摘要计数与 run-log 不一致');
    expect(result.note).toContain('pushed');
  });
});

describe('formatSummary', () => {
  it('包含关键中文标签', () => {
    const summary = buildSummary({
      total: 10,
      matched: 4,
      ambiguous: 1,
      noMatch: 2,
      diffRows: 3,
      pendingConfirm: 2,
      adopted: 3,
      pushed: 2,
      failed: 1,
      pendingRetry: 1,
      missingRows: 1,
      issueRows: 2,
      missingCheckIncomplete: true,
    });
    const text = formatSummary(summary);
    for (const label of [
      '本批处理',
      '院内命中',
      '歧义',
      '零命中',
      '差异',
      '待确认',
      '已采纳',
      '已推送',
      '推送失败',
      '待重试',
      '院内缺行',
      '问题行',
      '缺行检查未完成',
    ]) {
      expect(text).toContain(label);
    }
  });
});

describe('formatLastSynced', () => {
  it('null → 尚未同步，raw 为 null', () => {
    const result = formatLastSynced(null);
    expect(result.text).toBe('尚未同步');
    expect(result.raw).toBeNull();
  });

  it('真实 ISO：text 不等于 raw，raw 原样保留', () => {
    const iso = '2026-11-08T01:02:03.000Z';
    const result = formatLastSynced(iso);
    expect(result.raw).toBe(iso);
    expect(result.text).not.toBe(iso);
    expect(typeof result.text).toBe('string');
    expect(result.text.length).toBeGreaterThan(0);
  });
});

describe('summarizeIssueRows', () => {
  it('按行去重计数，统计总数与阻断数', () => {
    const issues: RowIssue[] = [
      { rowNumber: 1, registryId: 'R1', code: 'MISSING_REGISTRY_ID', reason: 'a', hint: 'b', blocking: true },
      { rowNumber: 1, registryId: 'R1', code: 'DUPLICATE_REGISTRY_ID', reason: 'a', hint: 'b', blocking: false },
      { rowNumber: 2, registryId: 'R2', code: 'DATE_UNPARSEABLE', reason: 'a', hint: 'b', blocking: true },
    ];
    const result = summarizeIssueRows(issues);
    expect(result.issueRows).toBe(2);
    expect(result.totalIssues).toBe(3);
    expect(result.blockingIssues).toBe(2);
  });
});
