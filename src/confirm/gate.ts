/**
 * 确认闸门：判定哪些行可以外发推送，过滤 / 切分可推送与需跳过的行。
 */
import type { RowStatus } from '../contract/index.js';
import { PUSHABLE_STATUSES } from './state.js';

/** 可推送状态（重导出，便于闸门单独引用）。 */
export { PUSHABLE_STATUSES };

/** 判定单个状态是否可推送。 */
export function isPushable(status: RowStatus): boolean {
  return PUSHABLE_STATUSES.includes(status);
}

/** 过滤出可推送的行。 */
export function filterPushable<T extends { status: RowStatus }>(rows: T[]): T[] {
  return rows.filter((row) => isPushable(row.status));
}

/**
 * 切分行：可推送的进 pushable，其余进 skipped（附跳过原因）。
 * 跳过原因须说明当前状态阻断推送。
 */
export function splitPushable<T extends { rowNumber: number; registryId: string | null; status: RowStatus }>(
  rows: T[],
): { pushable: T[]; skipped: { row: T; reason: string }[] } {
  const pushable: T[] = [];
  const skipped: { row: T; reason: string }[] = [];
  for (const row of rows) {
    if (isPushable(row.status)) {
      pushable.push(row);
    } else {
      skipped.push({
        row,
        reason: `状态「${row.status}」未确认，不外发`,
      });
    }
  }
  return { pushable, skipped };
}
