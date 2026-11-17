import { describe, expect, it } from 'vitest';

import { ROW_ISSUE_LABELS, ROW_STATUSES } from '../../src/contract/index.js';
import {
  DESTRUCTIVE_REASONS,
  PRECONDITION_REJECTED_STATUS,
  PRECONDITION_VIOLATION_KINDS,
  checkRowPreconditions,
  collectDestructiveOperations,
  createIfMatchPreconditions,
  destructiveReason,
  evaluateBatchPreconditions,
  isDestructive,
  isNonEmptyValue,
  toPreconditionRowIssues,
  type PreconditionRowInput,
} from '../../src/diff/index.js';
import { diffValues, type DiffOperation } from '../../src/diff/patch.js';
import { diffNested } from '../../src/diff/nested.js';

/** 用真实差异引擎造一条操作，避免测试里手搓引擎产物。 */
function op(input: {
  field?: string;
  column?: string | null;
  oldValue: unknown;
  newValue: unknown;
  rawOldValue?: unknown;
  controlledCode?: boolean;
}): DiffOperation[] {
  return diffValues({
    path: input.field ?? '分期',
    field: input.field ?? '分期',
    column: input.column ?? input.field ?? '分期',
    oldValue: input.oldValue,
    newValue: input.newValue,
    rawOldValue: input.rawOldValue,
    controlledCode: input.controlledCode ?? false,
  });
}

describe('破坏性判定', () => {
  it('删除院内已有字段判为破坏性', () => {
    const [operation] = op({ oldValue: 'IIIB', newValue: undefined });
    expect(operation).toBeDefined();
    expect(operation?.op).toBe('remove');
    expect(isDestructive(operation!)).toBe(true);
    expect(destructiveReason(operation!)).toBe(DESTRUCTIVE_REASONS.REMOVE);
  });

  it('覆盖院内非空旧值判为破坏性', () => {
    const [operation] = op({ oldValue: 'IIIB', newValue: 'IVA' });
    expect(operation?.op).toBe('replace');
    expect(isDestructive(operation!)).toBe(true);
    expect(destructiveReason(operation!)).toBe(DESTRUCTIVE_REASONS.REPLACE_NON_EMPTY);
  });

  it('往空格里补填不判为破坏性', () => {
    const [operation] = op({ oldValue: null, newValue: 'IIIB' });
    expect(operation?.op).toBe('add');
    expect(isDestructive(operation!)).toBe(false);
    expect(destructiveReason(operation!)).toBeNull();
  });

  it('空串 / 空数组 / 空对象不算非空，覆盖它们不判破坏性', () => {
    expect(isNonEmptyValue('')).toBe(false);
    expect(isNonEmptyValue('   ')).toBe(false);
    expect(isNonEmptyValue([])).toBe(false);
    expect(isNonEmptyValue({})).toBe(false);
    expect(isNonEmptyValue(null)).toBe(false);
    expect(isNonEmptyValue(undefined)).toBe(false);
  });

  it('0 与 false 是真填进去的值，覆盖它们算破坏性', () => {
    expect(isNonEmptyValue(0)).toBe(true);
    expect(isNonEmptyValue(false)).toBe(true);
    const [operation] = op({ field: '随访次数', oldValue: 0, newValue: 3 });
    expect(isDestructive(operation!)).toBe(true);
  });

  it('覆盖空串旧值不算破坏性（往空位写值不构成覆盖）', () => {
    const [operation] = op({ oldValue: '', newValue: 'IIIB' });
    expect(operation?.op).toBe('replace');
    expect(isDestructive(operation!)).toBe(false);
  });

  it('破坏性操作清单只留破坏性的，且保持原顺序', () => {
    const operations = [
      ...op({ field: '分期', oldValue: 'IIIB', newValue: 'IVA' }),
      ...op({ field: '治疗方案', oldValue: null, newValue: '化疗' }),
      ...op({ field: '首次入院日', oldValue: '2024-01-01', newValue: undefined }),
    ];
    const destructive = collectDestructiveOperations(operations);
    expect(destructive.map((operation) => operation.field)).toEqual([
      '分期',
      '首次入院日',
    ]);
    expect(destructive.map((operation) => operation.op)).toEqual(['replace', 'remove']);
  });
});

describe('ifMatch 前置条件生成', () => {
  it('非破坏性操作不生成任何条件', () => {
    const operations = [
      ...op({ field: '治疗方案', oldValue: null, newValue: '化疗' }),
      ...op({ field: '分期', oldValue: '', newValue: 'IIIB' }),
    ];
    expect(createIfMatchPreconditions(operations)).toEqual([]);
  });

  it('破坏性操作生成 {path, value} 条件，value 取表里的原值', () => {
    const operations = op({
      field: '分期',
      oldValue: 'IIIB',
      newValue: 'IVA',
      rawOldValue: ' ⅢB ',
    });
    const conditions = createIfMatchPreconditions(operations);
    expect(conditions).toHaveLength(1);
    expect(conditions[0]?.path).toBe('分期');
    expect(conditions[0]?.value).toBe(' ⅢB ');
    expect(conditions[0]?.field).toBe('分期');
    expect(conditions[0]?.op).toBe('replace');
    expect(conditions[0]?.reason).toBe(DESTRUCTIVE_REASONS.REPLACE_NON_EMPTY);
  });

  it('删除操作的条件值是登记侧原值', () => {
    const operations = op({ field: '首次入院日', oldValue: '2024-01-01', newValue: undefined });
    const conditions = createIfMatchPreconditions(operations);
    expect(conditions).toHaveLength(1);
    expect(conditions[0]?.op).toBe('remove');
    expect(conditions[0]?.value).toBe('2024-01-01');
  });

  it('嵌套展开后的操作沿用带下标的路径', () => {
    const operations = diffNested({
      path: '分期',
      field: '分期',
      column: '分期',
      oldValue: { coding: [{ code: 'IIIB' }] },
      newValue: { coding: [{ code: 'IVA' }] },
    });
    expect(operations.length).toBeGreaterThan(0);
    const conditions = createIfMatchPreconditions(operations);
    expect(conditions.length).toBeGreaterThan(0);
    for (const condition of conditions) {
      expect(condition.path).toContain('分期');
      expect(condition.field).toBe('分期');
    }
  });
});

describe('发出前本地比对', () => {
  it('院内当前值与检索快照一致 → 通过，可进推送体', () => {
    const operations = op({ field: '分期', oldValue: 'IIIB', newValue: 'IVA' });
    const result = checkRowPreconditions({
      operations,
      snapshot: { 分期: 'IVA' },
      current: { 分期: 'IVA' },
    });
    expect(result.status).toBe('通过');
    expect(result.canPush).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.checkedFields).toEqual(['分期']);
    expect(result.conditions).toHaveLength(1);
  });

  it('检索后院内被改 → 该行拒写，标「院内已变更，需重查」', () => {
    const operations = op({ field: '分期', oldValue: 'IIIB', newValue: 'IVA' });
    const result = checkRowPreconditions({
      operations,
      snapshot: { 分期: 'IVA' },
      current: { 分期: 'IIB' },
    });
    expect(result.status).toBe(PRECONDITION_REJECTED_STATUS);
    expect(result.status).toBe('院内已变更，需重查');
    expect(result.canPush).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.kind).toBe('院内记录已变更');
    expect(result.violations[0]?.field).toBe('分期');
    expect(result.violations[0]?.expected).toBe('IVA');
    expect(result.violations[0]?.actual).toBe('IIB');
    expect(result.violations[0]?.reason).toContain('在检索之后被院内改过');
    expect(result.violations[0]?.hint).toContain('重新对齐');
  });

  it('非破坏性操作的字段被改过同样拒写（建议本身已过时）', () => {
    const operations = op({ field: '治疗方案', oldValue: null, newValue: '化疗' });
    const result = checkRowPreconditions({
      operations,
      snapshot: { 治疗方案: '化疗' },
      current: { 治疗方案: '放疗' },
    });
    expect(result.canPush).toBe(false);
    expect(result.status).toBe('院内已变更，需重查');
  });

  it('院内把字段删掉（快照有、当前没有）也算被改过', () => {
    const operations = op({ field: '分期', oldValue: 'IIIB', newValue: 'IVA' });
    const result = checkRowPreconditions({
      operations,
      snapshot: { 分期: 'IVA' },
      current: {},
    });
    expect(result.canPush).toBe(false);
    expect(result.violations[0]?.kind).toBe('院内记录已变更');
  });

  it('两侧都没有这个字段不算被改过（缺失 vs 缺失）', () => {
    const operations = op({ field: '分期', oldValue: 'IIIB', newValue: 'IVA' });
    const result = checkRowPreconditions({
      operations,
      snapshot: {},
      current: {},
    });
    expect(result.canPush).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('登记条目当前值与 ifMatch 期望值不一致 → 拒写', () => {
    const operations = op({
      field: '分期',
      oldValue: 'IIIB',
      newValue: 'IVA',
      rawOldValue: 'IIIB',
    });
    const result = checkRowPreconditions({
      operations,
      snapshot: { 分期: 'IVA' },
      current: { 分期: 'IVA' },
      targetCurrent: { 分期: 'IIIA' },
    });
    expect(result.canPush).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.kind).toBe('登记条目已被改动');
    expect(result.violations[0]?.expected).toBe('IIIB');
    expect(result.violations[0]?.actual).toBe('IIIA');
  });

  it('没有给出登记条目当前值时不做目标侧核对', () => {
    const operations = op({ field: '分期', oldValue: 'IIIB', newValue: 'IVA' });
    const result = checkRowPreconditions({
      operations,
      snapshot: { 分期: 'IVA' },
      current: { 分期: 'IVA' },
    });
    expect(result.violations.every((violation) => violation.kind === '院内记录已变更')).toBe(
      true,
    );
  });

  it('没有差异的行不需要核对，直接通过', () => {
    const result = checkRowPreconditions({
      operations: [],
      snapshot: {},
      current: {},
    });
    expect(result.status).toBe('通过');
    expect(result.canPush).toBe(true);
    expect(result.checkedFields).toEqual([]);
  });

  it('核对是纯函数：不改入参，也不推进任何状态', () => {
    const operations = op({ field: '分期', oldValue: 'IIIB', newValue: 'IVA' });
    const snapshot = Object.freeze({ 分期: 'IVA' });
    const current = Object.freeze({ 分期: 'IIB' });
    const result = checkRowPreconditions({ operations, snapshot, current });
    expect(result.canPush).toBe(false);
    expect(snapshot.分期).toBe('IVA');
    expect(current.分期).toBe('IIB');
    expect(operations[0]?.oldValue).toBe('IIIB');
  });
});

describe('一批的拒写隔离', () => {
  function row(input: Partial<PreconditionRowInput> & { rowNumber: number }): PreconditionRowInput {
    const field = input.field ?? '分期';
    return {
      rowNumber: input.rowNumber,
      registryId: input.registryId ?? `REG-${String(input.rowNumber).padStart(4, '0')}`,
      operations: input.operations ?? op({ field, oldValue: 'IIIB', newValue: 'IVA' }),
      snapshot: input.snapshot ?? { [field]: 'IVA' },
      current: input.current ?? { [field]: 'IVA' },
    };
  }

  it('一行被拒写，同批其余行照常通过', () => {
    const rows: PreconditionRowInput[] = [
      row({ rowNumber: 2 }),
      row({ rowNumber: 3, current: { 分期: 'IIB' } }),
      row({ rowNumber: 4 }),
    ];
    const batch = evaluateBatchPreconditions(rows);
    expect(batch.rows).toHaveLength(3);
    expect(batch.passed).toBe(2);
    expect(batch.rejected).toBe(1);
    expect(batch.rejectedRows).toEqual([3]);
    expect(batch.rows[0]?.canPush).toBe(true);
    expect(batch.rows[1]?.canPush).toBe(false);
    expect(batch.rows[1]?.status).toBe('院内已变更，需重查');
    expect(batch.rows[2]?.canPush).toBe(true);
  });

  it('被拒的行不进推送体：canPush 为 false 的行不产出请求体资格', () => {
    const rows = [row({ rowNumber: 2 }), row({ rowNumber: 3, current: { 分期: 'IIB' } })];
    const batch = evaluateBatchPreconditions(rows);
    const pushable = batch.rows.filter((entry) => entry.canPush);
    expect(pushable.map((entry) => entry.rowNumber)).toEqual([2]);
    expect(pushable[0]?.conditions).toHaveLength(1);
  });

  it('逐行结果顺序与入参一致，行号不串', () => {
    const rows = [row({ rowNumber: 7 }), row({ rowNumber: 8, current: { 分期: 'IIB' } })];
    const batch = evaluateBatchPreconditions(rows);
    expect(batch.rows.map((entry) => entry.rowNumber)).toEqual([7, 8]);
    expect(batch.rows[1]?.registryId).toBe('REG-0008');
  });

  it('拒写行转成行级问题：阻断推送、错误码 PRECONDITION_MISMATCH', () => {
    const rows = [row({ rowNumber: 5, current: { 分期: 'IIB' } })];
    const batch = evaluateBatchPreconditions(rows);
    const issues = toPreconditionRowIssues({
      rowNumber: batch.rows[0]!.rowNumber,
      registryId: batch.rows[0]!.registryId,
      result: batch.rows[0]!,
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe('PRECONDITION_MISMATCH');
    expect(issues[0]?.blocking).toBe(true);
    expect(issues[0]?.rowNumber).toBe(5);
    expect(issues[0]?.registryId).toBe('REG-0005');
    expect(issues[0]?.reason.length).toBeGreaterThan(0);
    expect(issues[0]?.hint.length).toBeGreaterThan(0);
  });
});

describe('与契约的一致性', () => {
  it('拒写状态是契约登记的行状态之一', () => {
    expect(ROW_STATUSES).toContain(PRECONDITION_REJECTED_STATUS);
    expect(PRECONDITION_REJECTED_STATUS).toBe('院内已变更，需重查');
  });

  it('错误码标签与拒写状态同名', () => {
    expect(ROW_ISSUE_LABELS.PRECONDITION_MISMATCH).toBe('院内已变更，需重查');
  });

  it('不一致形态只有两种', () => {
    expect(PRECONDITION_VIOLATION_KINDS).toEqual(['院内记录已变更', '登记条目已被改动']);
  });
});
