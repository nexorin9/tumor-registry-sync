/**
 * 迁移执行：把一次「当前态 → 目标态」的请求落地为结果 + 审计记录。
 * 模型源永不推进状态；已推送的行不可回退到待确认（撤回限制）。
 */
import type { RowStatus } from '../contract/index.js';
import { InvalidTransitionError, canTransition, transition } from './state.js';

/** 迁移来源：user / model / system。 */
export type TransitionSource = 'user' | 'model' | 'system';

/** 迁移审计记录。 */
export interface TransitionRecord {
  rowNumber: number;
  registryId: string | null;
  from: RowStatus;
  to: RowStatus;
  at: string;
  source: TransitionSource;
}

/** 模型源尝试推进状态时抛出：模型永远不能改变行状态。 */
export class ModelTransitionError extends Error {
  readonly current: RowStatus;
  readonly next: RowStatus;

  constructor(current: RowStatus, next: RowStatus) {
    super(`模型源不可推进状态：${current} → ${next}（模型永不改变行状态）`);
    this.name = 'ModelTransitionError';
    this.current = current;
    this.next = next;
  }
}

/**
 * 执行一次状态迁移。
 * - current===next → changed:false，仍产出记录。
 * - source==='model' 且 current!==next → 抛 ModelTransitionError。
 * - 非法迁移 → 抛 InvalidTransitionError。
 * - 已推送→待确认 撤回 → 抛 InvalidTransitionError（reason 已推送行不可回退）。
 */
export function applyTransition(
  current: RowStatus,
  next: RowStatus,
  opts: { source: TransitionSource; rowNumber?: number; registryId?: string | null },
): { status: RowStatus; changed: boolean; record: TransitionRecord } {
  const { source, rowNumber = 0, registryId = null } = opts;

  if (current === next) {
    return {
      status: current,
      changed: false,
      record: {
        rowNumber,
        registryId,
        from: current,
        to: current,
        at: new Date().toISOString(),
        source,
      },
    };
  }

  if (source === 'model') {
    throw new ModelTransitionError(current, next);
  }

  // 撤回限制：已推送的行不可回退到待确认。
  if (current === '已推送' && next === '待确认') {
    const err = new InvalidTransitionError(current, next, ['已推送']);
    err.message = '已推送行不可回退';
    throw err;
  }

  // 撤回（采纳 → 待确认）：尚未推送，允许撤回；该迁移不在 ALLOWED_TRANSITIONS 表中。
  if (current === '采纳' && next === '待确认') {
    return {
      status: '待确认',
      changed: true,
      record: {
        rowNumber,
        registryId,
        from: current,
        to: '待确认',
        at: new Date().toISOString(),
        source,
      },
    };
  }

  const status = transition(current, next);

  return {
    status,
    changed: true,
    record: {
      rowNumber,
      registryId,
      from: current,
      to: status,
      at: new Date().toISOString(),
      source,
    },
  };
}
