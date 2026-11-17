/**
 * 运行摘要：构造、与 run-log 交叉校验、中文排版、上次同步时间、问题行计数。
 *
 * 两条纪律贯穿本文件：
 * - 缺省值统一填 0/false，摘要永远「完整可比较」，不留 undefined 让调用方踩空。
 * - 摘要计数与 run-log 统计对不上时，**报告而不是静默选一边**；要么两边一致，
 *   要么明确点出哪几项不一致。
 */
import type { RowIssue, SummaryCounts } from '../contract/index.js';
import type { LogEvent } from '../observability/logger.js';

/** buildSummary 的输入：所有字段可选，缺省按 0/false 补齐。 */
export interface RunSummaryInput {
  total: number;
  matched?: number;
  ambiguous?: number;
  noMatch?: number;
  diffRows?: number;
  pendingConfirm?: number;
  adopted?: number;
  pushed?: number;
  failed?: number;
  pendingRetry?: number;
  missingRows?: number;
  issueRows?: number;
  missingCheckIncomplete?: boolean;
}

/**
 * 把输入补齐成完整 SummaryCounts：没给的字段一律填 0 或 false，
 * 保证下游比较时不会出现 undefined。
 */
export function buildSummary(input: RunSummaryInput): SummaryCounts {
  return {
    total: input.total,
    matched: input.matched ?? 0,
    ambiguous: input.ambiguous ?? 0,
    noMatch: input.noMatch ?? 0,
    diffRows: input.diffRows ?? 0,
    pendingConfirm: input.pendingConfirm ?? 0,
    adopted: input.adopted ?? 0,
    pushed: input.pushed ?? 0,
    failed: input.failed ?? 0,
    pendingRetry: input.pendingRetry ?? 0,
    missingRows: input.missingRows ?? 0,
    issueRows: input.issueRows ?? 0,
    missingCheckIncomplete: input.missingCheckIncomplete ?? false,
  };
}

/**
 * 把一批 run-log 事件里能反推的计数算出来，供交叉校验用。
 *
 * 只在「日志里确实包含对应阶段事件」时才反推某一项 —— 没有推送阶段事件的批次，
 * 自然无从核对 pushed/failed/pendingRetry，强行比只会误报，这种情况就跳过该项。
 */
function deriveFromEvents(events: LogEvent[]): {
  pushed: number;
  failed: number;
  pendingRetry: number;
  issueRows: number;
  hasPush: boolean;
  hasIssue: boolean;
} {
  let pushed = 0;
  let failed = 0;
  let pendingRetry = 0;
  let hasPush = false;
  const issueRowNumbers = new Set<number>();

  for (const event of events) {
    if (event.stage === 'push') {
      hasPush = true;
      if (event.outcome === 'ok') pushed += 1;
      else if (event.outcome === 'error') failed += 1;
      else if (event.outcome === 'retry') pendingRetry += 1;
    }
    if (event.errorCode !== null && event.rowNumber !== null) {
      issueRowNumbers.add(event.rowNumber);
    }
  }

  return {
    pushed,
    failed,
    pendingRetry,
    issueRows: issueRowNumbers.size,
    hasPush,
    hasIssue: issueRowNumbers.size > 0,
  };
}

/**
 * 把摘要计数与 run-log 事件统计做交叉校验。
 *
 * 可反推就核：pushed / failed / pendingRetry（来自 push 阶段事件）、
 * issueRows（来自带错误码事件的去重行号）。任一项对不上 → ok:false 且 note 点名
 * 「摘要计数与 run-log 不一致：……」。推不出来（日志里没有对应事件）则仍返回
 * ok:true，并在 note 里说明跳过了哪些项，绝不假装核对过。
 */
export function crossCheckSummary(
  summary: SummaryCounts,
  events: LogEvent[],
): { ok: boolean; note: string } {
  const derived = deriveFromEvents(events);
  const mismatches: string[] = [];
  const skipped: string[] = [];

  if (derived.hasPush) {
    if (summary.pushed !== derived.pushed) {
      mismatches.push(`pushed 摘要=${summary.pushed} 日志=${derived.pushed}`);
    }
    if (summary.failed !== derived.failed) {
      mismatches.push(`failed 摘要=${summary.failed} 日志=${derived.failed}`);
    }
    if (summary.pendingRetry !== derived.pendingRetry) {
      mismatches.push(`pendingRetry 摘要=${summary.pendingRetry} 日志=${derived.pendingRetry}`);
    }
  } else {
    skipped.push('pushed/failed/pendingRetry（run-log 无推送阶段事件）');
  }

  if (derived.hasIssue) {
    if (summary.issueRows !== derived.issueRows) {
      mismatches.push(`issueRows 摘要=${summary.issueRows} 日志=${derived.issueRows}`);
    }
  } else {
    skipped.push('issueRows（run-log 无带错误码事件）');
  }

  if (mismatches.length > 0) {
    return {
      ok: false,
      note: `摘要计数与 run-log 不一致：${mismatches.join('；')}。`,
    };
  }

  if (skipped.length > 0) {
    return {
      ok: true,
      note: `摘要计数与 run-log 一致；以下项日志中不可反推，已跳过核对：${skipped.join('，')}。`,
    };
  }

  return { ok: true, note: '摘要计数与 run-log 一致。' };
}

/**
 * 把摘要排成一行可读中文，覆盖命中 / 歧义 / 零命中 / 差异 / 已采纳 / 已推送 /
 * 推送失败 / 待重试 / 院内缺行 / 问题行 / 待确认，并在缺行检查未完成时追加提示。
 */
export function formatSummary(summary: SummaryCounts): string {
  const parts = [
    `本批处理 ${summary.total} 行`,
    `院内命中 ${summary.matched}`,
    `歧义 ${summary.ambiguous}`,
    `零命中 ${summary.noMatch}`,
    `差异 ${summary.diffRows} 行`,
    `待确认 ${summary.pendingConfirm}`,
    `已采纳 ${summary.adopted}`,
    `已推送 ${summary.pushed}`,
    `推送失败 ${summary.failed}`,
    `待重试 ${summary.pendingRetry}`,
    `院内缺行 ${summary.missingRows}`,
    `问题行 ${summary.issueRows}`,
  ];
  let text = `${parts.join('，')}。`;
  if (summary.missingCheckIncomplete) {
    text += '（缺行检查未完成）';
  }
  return text;
}

/**
 * 上次同步时间：null → 「尚未同步」，并保留 raw 为 null；
 * 否则给出本地时区可读字符串，同时把原始 ISO 留在 raw 里供溯源/复现。
 */
export function formatLastSynced(rawIso: string | null): { text: string; raw: string | null } {
  if (rawIso === null) {
    return { text: '尚未同步', raw: null };
  }
  return { text: new Date(rawIso).toLocaleString('zh-CN'), raw: rawIso };
}

/**
 * 问题行计数：issueRows = 去重后的行数；totalIssues = 问题条目总数；
 * blockingIssues = 其中阻断推送的条目数。
 */
export function summarizeIssueRows(issues: RowIssue[]): {
  issueRows: number;
  totalIssues: number;
  blockingIssues: number;
} {
  const rowNumbers = new Set<number>();
  let blockingIssues = 0;
  for (const issue of issues) {
    rowNumbers.add(issue.rowNumber);
    if (issue.blocking) blockingIssues += 1;
  }
  return {
    issueRows: rowNumbers.size,
    totalIssues: issues.length,
    blockingIssues,
  };
}
