/**
 * 确认状态机：状态全集、合法迁移表与判定工具。
 * 模型输出永不推进这些状态，所有迁移都由 user / system 显式驱动。
 */
import type { RowStatus } from '../contract/index.js';

/** 合法迁移表：每个状态允许到达的下一状态全集。 */
export const ALLOWED_TRANSITIONS: Record<RowStatus, RowStatus[]> = {
  待对齐: ['待确认', '零命中', '命中歧义', '需人工判定', '无需确认'],
  待确认: ['采纳', '不采纳'],
  采纳: ['已推送', '推送失败'],
  不采纳: [],
  无需确认: [],
  一致: [],
  需人工判定: ['待确认'],
  '院内已变更，需重查': ['待对齐'],
  零命中: [],
  命中歧义: [],
  已推送: [],
  推送失败: ['待确认'],
};

/** 非法迁移：携带当前态、目标态与允许的迁移目标。 */
export class InvalidTransitionError extends Error {
  readonly current: RowStatus;
  readonly next: RowStatus;
  readonly allowed: RowStatus[];

  constructor(current: RowStatus, next: RowStatus, allowed: RowStatus[]) {
    const allowedText = allowed.length > 0 ? allowed.join(' / ') : '（无）';
    super(`非法状态迁移：${current} → ${next}；允许目标：${allowedText}`);
    this.name = 'InvalidTransitionError';
    this.current = current;
    this.next = next;
    this.allowed = allowed;
  }
}

/** 判定某迁移是否合法。 */
export function canTransition(current: RowStatus, next: RowStatus): boolean {
  return ALLOWED_TRANSITIONS[current].includes(next);
}

/** 执行迁移；非法则抛 InvalidTransitionError。 */
export function transition(current: RowStatus, next: RowStatus): RowStatus {
  if (current === next) return current;
  if (!canTransition(current, next)) {
    throw new InvalidTransitionError(current, next, ALLOWED_TRANSITIONS[current]);
  }
  return next;
}

/** 终态：不再有任何合法外迁的状态。 */
export function isTerminal(status: RowStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}

/** 可推送状态（采纳后才会进入外发流水线）。 */
export const PUSHABLE_STATUSES: RowStatus[] = ['采纳'];
