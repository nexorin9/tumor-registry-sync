import { describe, expect, it } from 'vitest';

import type { LogEvent, RowIssue } from '../../src/contract/index.js';
import { crossCheckSummary, summarizeIssueRows } from '../../src/audit/summary.js';

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

describe('summary 写回辅助（最小）', () => {
  it('crossCheckSummary 能抓出 pushed 与日志不一致', () => {
    const summary = {
      total: 4,
      matched: 0,
      ambiguous: 0,
      noMatch: 0,
      diffRows: 0,
      pendingConfirm: 0,
      adopted: 0,
      pushed: 9,
      failed: 0,
      pendingRetry: 0,
      missingRows: 0,
      issueRows: 0,
      missingCheckIncomplete: false,
    };
    const events: LogEvent[] = [event({ rowNumber: 1, outcome: 'ok', stage: 'push' })];
    const result = crossCheckSummary(summary, events);
    expect(result.ok).toBe(false);
    expect(result.note).toContain('pushed');
  });

  it('summarizeIssueRows 按行去重而不是按条目', () => {
    const issues: RowIssue[] = [
      { rowNumber: 3, registryId: 'R3', code: 'COLUMN_COUNT_MISMATCH', reason: 'a', hint: 'b', blocking: false },
      { rowNumber: 3, registryId: 'R3', code: 'MISSING_FIELD', reason: 'a', hint: 'b', blocking: true },
      { rowNumber: 7, registryId: 'R7', code: 'BAD_PAYLOAD', reason: 'a', hint: 'b', blocking: true },
    ];
    const result = summarizeIssueRows(issues);
    expect(result.issueRows).toBe(2);
    expect(result.totalIssues).toBe(3);
    expect(result.blockingIssues).toBe(2);
  });
});
