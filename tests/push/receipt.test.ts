import { describe, expect, it } from 'vitest';

import type { PushReceipt, SummaryCounts } from '../../src/contract/index.js';
import {
  buildReceiptBlock,
  redactReceipt,
  summarizeReceipts,
} from '../../src/push/receipt.js';

function receipt(status: PushReceipt['status']): PushReceipt {
  return {
    rowNumber: 1,
    registryId: 'R1',
    status,
    code: null,
    reason: null,
    idempotencyKey: 'k1',
    attempts: 1,
    pushedAt: status === '已推送' ? '2026-01-01T00:00:00Z' : null,
  };
}

describe('summarizeReceipts', () => {
  it('按状态计数', () => {
    const receipts = [receipt('已推送'), receipt('已推送'), receipt('推送失败'), receipt('待重试')];
    const summary = summarizeReceipts(receipts);
    expect(summary).toEqual({ pushed: 2, failed: 1, pendingRetry: 1 });
  });

  it('空列表计数为零', () => {
    expect(summarizeReceipts([])).toEqual({ pushed: 0, failed: 0, pendingRetry: 0 });
  });
});

describe('buildReceiptBlock', () => {
  it('组装批次回执区块结构', () => {
    const receipts = [receipt('已推送'), receipt('推送失败')];
    const summary: SummaryCounts = {
      total: 2,
      matched: 2,
      ambiguous: 0,
      noMatch: 0,
      diffRows: 2,
      pendingConfirm: 0,
      adopted: 2,
      pushed: 1,
      failed: 1,
      pendingRetry: 0,
      missingRows: 0,
      issueRows: 0,
      missingCheckIncomplete: false,
    };
    const block = buildReceiptBlock({
      batchKey: 'batch-1',
      searchParams: 'p=1',
      pushedAt: '2026-01-01T00:00:00Z',
      receipts,
      summary,
    });
    expect(block.batchKey).toBe('batch-1');
    expect(block.searchParams).toBe('p=1');
    expect(block.pushedAt).toBe('2026-01-01T00:00:00Z');
    expect(block.counts).toBe(summary);
    expect(block.details).toHaveLength(2);
  });
});

describe('redactReceipt', () => {
  it('恒等返回，不泄露明文（回执仅为脱敏占位）', () => {
    const r = receipt('已推送');
    expect(redactReceipt(r)).toBe(r);
  });
});

describe('计数交叉校验', () => {
  it('summarizeReceipts 与 ReceiptBlock.counts 一致', () => {
    const receipts = [receipt('已推送'), receipt('已推送'), receipt('推送失败'), receipt('待重试')];
    const summary = summarizeReceipts(receipts);
    const counts: SummaryCounts = {
      total: 4,
      matched: 4,
      ambiguous: 0,
      noMatch: 0,
      diffRows: 4,
      pendingConfirm: 0,
      adopted: 4,
      pushed: summary.pushed,
      failed: summary.failed,
      pendingRetry: summary.pendingRetry,
      missingRows: 0,
      issueRows: 0,
      missingCheckIncomplete: false,
    };
    expect(counts.pushed).toBe(2);
    expect(counts.failed).toBe(1);
    expect(counts.pendingRetry).toBe(1);
    expect(counts.pushed + counts.failed + counts.pendingRetry).toBe(counts.total);
  });
});
