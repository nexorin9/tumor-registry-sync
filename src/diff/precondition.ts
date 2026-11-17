/**
 * 写前前置条件：破坏性操作加条件再写 + 发出前本地比对院内当前值。
 *
 * 这一层解决的是「差异算完之后、推送发出之前，院内这条记录可能已经被人改过」
 * 这件事，具体做两段：
 *
 * **① 生成 ifMatch 前置条件（随推送体携带）**
 * 只有**破坏性操作**才配前置条件 —— 删除院内已有字段、覆盖院内非空旧值。
 * 条件形如 `{path, value}`：path 是操作路径，value 是**写这条之前目标侧应持有的值**
 * （登记员在表里看到的原值）。对端据此判断「这一条现在还能不能写」。
 * 非破坏性操作（往空格补填、把空值改成有值）不配条件：写错顶多多一条，
 * 覆盖掉别人已经填好的内容才是事故。
 *
 * **② 发出前本地比对（推送前重读院内当前值）**
 * 检索那一刻拿到的院内值是**本地快照**；推送前再读一次院内**当前值**，
 * 两者不一致，说明院内在我们检索之后被改过 —— 这一行的建议是基于旧数据算的，
 * 直接推过去等于把过期数据盖回院内。该行**拒写**：标「院内已变更，需重查」，
 * **不构造任何请求体**，同批其余行照常推送、照常出回执。
 *
 * 三条硬规矩：
 * - **拒写不牵连别人**：一行被拒只影响这一行，本批其余行的推送与回执不受影响。
 * - **不静默改状态**：本层是纯函数，只给出「能不能推」的判定与原因，
 *   状态由确认状态机推进（任务 7），本层不写任何单元格、不推进任何状态。
 * - **缺失与空是两回事**：快照里没有这个字段（`undefined`）与「字段存在但值为空」
 *   （`null`）不是一回事，比对时按缺失 / 显式空分别判定，不把两者混作一谈。
 *
 * 与源产品主路径的关系：源实现的 `createTests(input, patch)` 只对 `isDestructive`
 * 操作生成 `test` 前置条件（`createTest()` 按路径取该路径的当前值），
 * 源产品的 `test` 是 JSON Patch 语义（由 `apply()` 在应用前就地求值），
 * HTTP 侧没有等价语义。因此本产品改写成「**发出前本地比对 + 随体携带 ifMatch**」
 * 两段：本地先拦一道，对端再核一道 —— 与源产品「先验条件、后落地」的次序一致。
 */
import type { RowIssue, RowStatus } from '../contract/index.js';

import type { DiffOperation, DiffOp, DiffValue } from './patch.js';
import { diffValuesEqual, valueKind } from './patch.js';
import { formatDiffValue } from './render.js';
import type { DestructiveRuleKind } from './destructive-rules.js';

/** 破坏性判定的两类理由（面向登记员与 run-log）。 */
export const DESTRUCTIVE_REASONS = {
  /** 删除院内已有字段 */
  REMOVE: '删除院内已有字段',
  /** 覆盖院内非空旧值 */
  REPLACE_NON_EMPTY: '覆盖院内非空旧值',
} as const;
export type DestructiveReason = (typeof DESTRUCTIVE_REASONS)[keyof typeof DESTRUCTIVE_REASONS];

/** 拒写时的行状态（与契约登记的行状态同源，改契约会编译报错）。 */
export const PRECONDITION_REJECTED_STATUS = '院内已变更，需重查' as const satisfies RowStatus;

/** 写前核对的结果状态：通过 / 拒写。 */
export type PreconditionStatus = '通过' | Extract<RowStatus, '院内已变更，需重查'>;

/**
 * 值是否「非空」。
 *
 * 空串 / 空数组 / 空对象 / null / 缺失都算空 —— 往这些位置写值不构成破坏。
 * `0` 与 `false` **不算空**：它们是登记员真填进去的值，覆盖掉同样是事故。
 */
export function isNonEmptyValue(value: unknown): boolean {
  switch (valueKind(value)) {
    case 'missing':
    case 'null':
      return false;
    case 'string':
      return (value as string).trim() !== '';
    case 'array':
      return (value as DiffValue[]).length > 0;
    case 'object':
      return Object.keys(value as Record<string, unknown>).length > 0;
    default:
      return true;
  }
}

/**
 * 破坏性判定：删除，或覆盖一个非空旧值。
 *
 * 返回判定理由；不破坏时返回 `null`（不猜、不含糊）。
 */
export function destructiveReason(operation: DiffOperation): DestructiveReason | null {
  if (operation.op === 'remove') return DESTRUCTIVE_REASONS.REMOVE;
  if (operation.op === 'replace' && isNonEmptyValue(operation.oldValue)) {
    return DESTRUCTIVE_REASONS.REPLACE_NON_EMPTY;
  }
  return null;
}

/** 这条操作是不是破坏性的。 */
export function isDestructive(operation: DiffOperation): boolean {
  return destructiveReason(operation) !== null;
}

/** 破坏性操作清单（保持原顺序，不静默丢弃任何一条）。 */
export function collectDestructiveOperations(
  operations: DiffOperation[],
): DiffOperation[] {
  return operations.filter(isDestructive);
}

/** 一条写前前置条件。 */
export interface IfMatchCondition {
  /** 写前要核对的路径：字段级为口径字段名；嵌套展开后为带下标的路径 */
  path: string;
  /** 期望值：写这条之前目标侧应持有的值（取表里登记员看到的原值） */
  value: unknown;
  /** 口径字段名 */
  field: string;
  /** 产生该条件的操作类型 */
  op: DiffOp;
  /** 为什么这条要写前核对（基线两类，或规则表给出的四类判定） */
  reason: DestructiveReason | DestructiveRuleKind;
  /** 命中的破坏性规则编号（规则表接入时给出） */
  ruleId?: string | null;
}

/**
 * 为破坏性操作生成 ifMatch 前置条件。
 *
 * 非破坏性操作一律不生成条件 —— 条件越多，越容易把一次正常的补填拖成一次拒写。
 */
export function createIfMatchPreconditions(
  operations: DiffOperation[],
): IfMatchCondition[] {
  const conditions: IfMatchCondition[] = [];
  for (const operation of operations) {
    const reason = destructiveReason(operation);
    if (reason === null) continue;
    conditions.push({
      path: operation.path,
      value:
        operation.rawOldValue === undefined ? operation.oldValue : operation.rawOldValue,
      field: operation.field,
      op: operation.op,
      reason,
    });
  }
  return conditions;
}

/** 不一致的两类形态。 */
export const PRECONDITION_VIOLATION_KINDS = ['院内记录已变更', '登记条目已被改动'] as const;
export type PreconditionViolationKind = (typeof PRECONDITION_VIOLATION_KINDS)[number];

/** 一处写前核对不通过。 */
export interface PreconditionViolation {
  /** 不一致的形态 */
  kind: PreconditionViolationKind;
  /** 口径字段名 */
  field: string;
  /** 涉及的操作路径 */
  path: string;
  /** 期望值（检索时的快照 / 表里的原值） */
  expected: unknown;
  /** 实际值（推送前重读到的当前值） */
  actual: unknown;
  /** 面向登记员的原因 */
  reason: string;
  /** 处置建议 */
  hint: string;
}

/** 一行的写前核对入参。 */
export interface RowPreconditionInput {
  /** 本行的最小操作集合 */
  operations: DiffOperation[];
  /** 检索时的院内本地快照（口径字段名 → 值） */
  snapshot: Record<string, unknown>;
  /** 推送前重新读到的院内当前值（口径字段名 → 值） */
  current: Record<string, unknown>;
  /**
   * 推送前重新读到的**登记条目当前值**（口径字段名 → 值）。
   *
   * 给了就一并核对 ifMatch 条件（目标侧是不是还保持表里看到的原值）；
   * 没给就只做院内新鲜度核对。
   */
  targetCurrent?: Record<string, unknown>;
  /**
   * 随体携带的 ifMatch 条件。
   *
   * 不给就按基线判定（删除 / 覆盖非空旧值）现场生成；
   * 给了就以这批为准（破坏性判定规则表接入后由规则表生成，条件更全）。
   */
  conditions?: IfMatchCondition[];
}

/** 一行的写前核对结果。 */
export interface RowPreconditionResult {
  /** 通过 / 拒写 */
  status: PreconditionStatus;
  /** 能不能进推送体：拒写为 false（调用方据此不构造请求体） */
  canPush: boolean;
  /** 随体携带的 ifMatch 前置条件 */
  conditions: IfMatchCondition[];
  /** 核对不通过的地方（逐条说清，不合并成一句「有变化」） */
  violations: PreconditionViolation[];
  /** 本行核对过的口径字段名 */
  checkedFields: string[];
}

/**
 * 一行的写前核对。
 *
 * 两道核对，任意一道不通过就拒写这一行：
 * 1. **院内新鲜度**：检索时的本地快照 vs 推送前重读的院内当前值 —— 院内被改过，
 *    这一行的建议就是基于旧数据算的，不能推。
 * 2. **目标侧原值**（给了 `targetCurrent` 才做）：ifMatch 期望值 vs 登记条目当前值 ——
 *    目标已经被别人改过，同样不能拿旧值去覆盖。
 *
 * 纯函数：不改入参、不写单元格、不推进任何状态。
 */
export function checkRowPreconditions(
  input: RowPreconditionInput,
): RowPreconditionResult {
  const conditions = input.conditions ?? createIfMatchPreconditions(input.operations);
  const violations: PreconditionViolation[] = [];

  // ① 院内当前值 vs 检索时的本地快照
  const checkedFields: string[] = [];
  for (const operation of input.operations) {
    if (!checkedFields.includes(operation.field)) checkedFields.push(operation.field);
  }
  for (const field of checkedFields) {
    const expected = input.snapshot[field];
    const actual = input.current[field];
    if (diffValuesEqual(expected, actual)) continue;
    violations.push({
      kind: '院内记录已变更',
      field,
      path: field,
      expected,
      actual,
      reason: `「${field}」在检索之后被院内改过：检索时是 ${formatDiffValue(expected)}，现在是 ${formatDiffValue(actual)}`,
      hint: '请重新对齐这一行后再推送，不要用旧数据覆盖院内现状',
    });
  }

  // ② 登记条目当前值 vs ifMatch 期望值
  if (input.targetCurrent !== undefined) {
    for (const condition of conditions) {
      const actual = input.targetCurrent[condition.field];
      if (diffValuesEqual(condition.value, actual)) continue;
      violations.push({
        kind: '登记条目已被改动',
        field: condition.field,
        path: condition.path,
        expected: condition.value,
        actual,
        reason: `「${condition.field}」在登记条目里已经不是表里的原值（${condition.reason}）`,
        hint: '请重新对齐这一行后再推送，避免覆盖登记员同事的改动',
      });
    }
  }

  return {
    status: violations.length > 0 ? PRECONDITION_REJECTED_STATUS : '通过',
    canPush: violations.length === 0,
    conditions,
    violations,
    checkedFields,
  };
}

/** 一行的写前核对入参（带行标识）。 */
export interface PreconditionRowInput extends RowPreconditionInput {
  /** 表内行号 */
  rowNumber: number;
  /** 登记主索引（脱敏占位标识） */
  registryId: string | null;
}

/** 一行的写前核对结果（带行标识）。 */
export interface PreconditionRowResult extends RowPreconditionResult {
  rowNumber: number;
  registryId: string | null;
}

/** 一批的写前核对结果。 */
export interface PreconditionBatchResult {
  /** 逐行结果（顺序与入参一致） */
  rows: PreconditionRowResult[];
  /** 通过的行数 */
  passed: number;
  /** 被拒写的行数 */
  rejected: number;
  /** 被拒写的行号 */
  rejectedRows: number[];
}

/**
 * 一批的写前核对。
 *
 * 逐行独立判定：**某一行被拒写不影响同批其余行** —— 其余行照常进推送体，
 * 照常出回执。被拒的行号单独列出，供回执区与待人工处理清单使用。
 */
export function evaluateBatchPreconditions(
  rows: PreconditionRowInput[],
): PreconditionBatchResult {
  const results: PreconditionRowResult[] = rows.map((row) => ({
    rowNumber: row.rowNumber,
    registryId: row.registryId,
    ...checkRowPreconditions(row),
  }));

  const rejectedRows = results
    .filter((row) => !row.canPush)
    .map((row) => row.rowNumber);

  return {
    rows: results,
    passed: results.length - rejectedRows.length,
    rejected: rejectedRows.length,
    rejectedRows,
  };
}

/**
 * 把拒写行转成行级问题（错误码 `PRECONDITION_MISMATCH`，阻断推送）。
 *
 * 一处不一致出一条问题，不合并 —— 待人工处理清单上要能看出到底哪几个字段对不上。
 */
export function toPreconditionRowIssues(input: {
  rowNumber: number;
  registryId: string | null;
  result: RowPreconditionResult;
}): RowIssue[] {
  return input.result.violations.map((violation) => ({
    rowNumber: input.rowNumber,
    registryId: input.registryId,
    code: 'PRECONDITION_MISMATCH',
    reason: violation.reason,
    hint: violation.hint,
    blocking: true,
  }));
}
