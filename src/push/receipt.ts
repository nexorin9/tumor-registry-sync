/**
 * 推送回执汇总与区块组装。
 *
 * 回执只持有脱敏占位 registryId（登记号 token），不含任何患者明文。
 * redactReceipt 目前为恒等（字段本身已是占位），保留接口以便后续增强脱敏。
 */
import type { PushReceipt, ReceiptBlock, SummaryCounts } from '../contract/index.js';

/** 按状态机聚合回执计数：已推送 / 推送失败 / 待重试。 */
export function summarizeReceipts(receipts: PushReceipt[]): {
  pushed: number;
  failed: number;
  pendingRetry: number;
} {
  let pushed = 0;
  let failed = 0;
  let pendingRetry = 0;
  for (const receipt of receipts) {
    if (receipt.status === '已推送') pushed += 1;
    else if (receipt.status === '推送失败') failed += 1;
    else if (receipt.status === '待重试') pendingRetry += 1;
  }
  return { pushed, failed, pendingRetry };
}

/** 组装表尾回执区块（批次键 + 检索参数串 + 推送时刻 + 计数 + 明细）。 */
export function buildReceiptBlock(input: {
  batchKey: string;
  searchParams: string;
  pushedAt: string | null;
  receipts: PushReceipt[];
  summary: SummaryCounts;
}): ReceiptBlock {
  return {
    batchKey: input.batchKey,
    searchParams: input.searchParams,
    pushedAt: input.pushedAt,
    counts: input.summary,
    details: input.receipts,
  };
}

/**
 * 脱敏回执：当前回执仅含脱敏占位 registryId，无患者明文，故为恒等返回。
 * 保留该接口以便后续若引入更丰富的上下文时统一在此脱敏。
 */
export function redactReceipt(receipt: PushReceipt): PushReceipt {
  return receipt;
}
