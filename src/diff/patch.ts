/**
 * 最小差异引擎：登记表行 vs 院内权威记录 → 最小操作集合（add / replace / remove）。
 *
 * 这一层只做一件事：**逐字段比对，只对真正变化的字段产出操作**。它不整行覆盖、
 * 不猜口径、不做归并、不判断破坏性（那些是后面的层）。
 *
 * 四条硬规矩：
 * - **只读得着的字段才比**：登记侧没有这个字段的值（表里没这一列 / 本轮没取到）
 *   → 本轮不参与比对。绝不因为「表里没这一格」就产出一条「新增」把登记表加满。
 * - **缺失与空是两回事**（这是最容易出错的地方）：
 *   登记侧「这一格空着」而院内有值 → 建议**新增**；
 *   院内「没有这个字段」而登记侧有值 → 建议**删除**；
 *   院内显式为空 → **修改**（等于建议清空这一格），不是删除。
 * - **本层不做归并**：`ⅢB` 与 `IIIB` 在这里就是两个值（差异 = 修改）。
 *   归并后等价即视为无差异，由归并层通过等价判定接进来（`equivalent` 参数），
 *   本层不替归并层做决定，也不做 Unicode 规范化（NFKC 之类的折叠会把
 *   罗马数字 `Ⅲ` 悄悄变成 `III`，凭空抹掉一条差异）。
 * - **原值必须留着**：写前比对（ifMatch）要拿表里的原值跟院内当前值比，
 *   所以每条操作同时带归一值（oldValue / newValue）与**未归一化原值**
 *   （rawOldValue / rawNewValue）。
 *
 * 与源产品主路径的关系：源实现的 `createPatch(input, output) → Operation[]`
 * 用「算出最小补丁」代替「整份覆盖」；本文件把同一套语义落到「登记表行 ↔
 * 院内权威记录」上，并把操作类型收敛成登记员看得懂的 add / replace / remove。
 */
import type { FieldSpec } from './field-spec.js';

/** 比对用的值：标量、数组或对象。 */
export type DiffValue =
  | string
  | number
  | boolean
  | null
  | DiffValue[]
  | { [key: string]: DiffValue };

/** 操作类型：新增 / 修改 / 删除。 */
export const DIFF_OPS = ['add', 'replace', 'remove'] as const;
export type DiffOp = (typeof DIFF_OPS)[number];

/** 变化类型（面向登记员的一句话，比英文操作码更贴表内文案）。 */
export const DIFF_CHANGE_KINDS = [
  '新增',
  '删除',
  '值不同',
  '类型变更',
  '元素新增',
  '元素删除',
  '属性变化',
] as const;
export type DiffChangeKind = (typeof DIFF_CHANGE_KINDS)[number];

/** 值的形态：缺失 / 空 / 文本 / 数值 / 布尔 / 数组 / 对象。 */
export const DIFF_VALUE_KINDS = [
  'missing',
  'null',
  'string',
  'number',
  'boolean',
  'array',
  'object',
] as const;
export type DiffValueKind = (typeof DIFF_VALUE_KINDS)[number];

/** 值的形态的中文标签（写进 run-log 与差异文案）。 */
export const DIFF_VALUE_KIND_LABELS: Record<DiffValueKind, string> = {
  missing: '缺失',
  null: '空',
  string: '文本',
  number: '数值',
  boolean: '布尔',
  array: '数组',
  object: '对象',
};

/** 数组 / 对象在字段级上的差异明细（元素级展开由 nested 层负责）。 */
export interface DiffDetail {
  /** 数组：院内多出来的元素 */
  addedElements?: DiffValue[];
  /** 数组：院内没有的登记侧元素 */
  removedElements?: DiffValue[];
  /** 对象：值发生变化的属性名 */
  changedProperties?: string[];
  /** 对象：院内多出来的属性名 */
  addedProperties?: string[];
  /** 对象：院内没有的属性名 */
  removedProperties?: string[];
  /** 补充说明（如展开深度封顶时说明为何整块按修改处理） */
  note?: string;
}

/** 一条最小操作。 */
export interface DiffOperation {
  /** 操作类型：新增 / 修改 / 删除 */
  op: DiffOp;
  /** 字段路径：本层为口径字段名（三段映射到院内资源路径由 path-map 层负责） */
  path: string;
  /** 口径字段名 */
  field: string;
  /** 登记侧列名；派生字段为 null */
  column: string | null;
  /** 登记侧归一值（参与比对的副本） */
  oldValue: DiffValue | undefined;
  /** 院内值 */
  newValue: DiffValue | undefined;
  /** 登记侧**未归一化**原值（表格里的原始内容，供写前 ifMatch 比对） */
  rawOldValue: unknown;
  /** 院内原值 */
  rawNewValue: unknown;
  /** 变化类型 */
  changeKind: DiffChangeKind;
  /** 是否类型变更（文本 ↔ 数值 ↔ 布尔 ↔ 数组 ↔ 对象） */
  typeChanged: boolean;
  /** 登记侧值的形态 */
  fromKind: DiffValueKind;
  /** 院内值的形态 */
  toKind: DiffValueKind;
  /** 是否受控编码字段（分期、治疗方案等） */
  controlledCode: boolean;
  /** 数组 / 对象的元素级差异明细 */
  detail: DiffDetail | null;
  /**
   * 破坏性打标：由破坏性判定规则表接入时写入（未接入规则表时为 undefined）。
   *
   * 打标进操作结构，是为了让后面的写前核对、run-log、差异文案都读同一个判定，
   * 免得各判一遍、判出两个结果。
   */
  destructive?: boolean;
  /** 命中的破坏性规则编号 */
  destructiveRuleId?: string | null;
  /** 命中的破坏性判定类别 */
  destructiveKind?: string | null;
}

/** 破坏性打标结果（由破坏性判定规则表给出；差异引擎不认识规则表，只认识这个形状）。 */
export interface DestructiveTag {
  /** 是否破坏性 */
  destructive: boolean;
  /** 命中的规则编号 */
  ruleId: string | null;
  /** 命中的判定类别 */
  kind: string | null;
}

/**
 * 破坏性打标器：差异引擎产出操作后调用它给每条操作打标。
 *
 * 规则表换版本时差异引擎一行不改 —— 规则表怎么改、打标器怎么改，是两件事。
 */
export type DestructiveTagger = (operation: DiffOperation) => DestructiveTag;

/** 等价判定：归并层的接入点。返回 true 表示「两者视为同一值，不产生差异」。 */
export type EquivalentPredicate = (
  field: string,
  oldValue: DiffValue,
  newValue: DiffValue,
) => boolean;

/** 求一个值的形态。`undefined` = 缺失，`null` = 显式空。 */
export function valueKind(value: unknown): DiffValueKind {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    default:
      return 'string';
  }
}

/**
 * 深度相等判定。
 *
 * 注意这里是**逐字比较**：不做 Unicode 规范化、不折叠罗马数字、不忽略大小写。
 * `ⅢB` 与 `IIIB` 因此判为不相等（差异 = 修改），归并等价与否交给归并层。
 */
export function diffValuesEqual(left: unknown, right: unknown): boolean {
  const leftKind = valueKind(left);
  const rightKind = valueKind(right);
  if (leftKind !== rightKind) return false;

  switch (leftKind) {
    case 'missing':
    case 'null':
      return true;
    case 'string':
    case 'number':
    case 'boolean':
      return left === right;
    case 'array': {
      const a = left as DiffValue[];
      const b = right as DiffValue[];
      if (a.length !== b.length) return false;
      return a.every((element, index) => diffValuesEqual(element, b[index]));
    }
    case 'object': {
      const a = left as { [key: string]: DiffValue };
      const b = right as { [key: string]: DiffValue };
      const keys = Object.keys(a);
      if (keys.length !== Object.keys(b).length) return false;
      return keys.every(
        (key) =>
          Object.prototype.hasOwnProperty.call(b, key) &&
          diffValuesEqual(a[key], b[key]),
      );
    }
    default:
      return false;
  }
}

/** 数组元素配对：按内容配对（顺序不同但元素相同不算差异）。 */
export function matchArrayElements(
  oldArray: DiffValue[],
  newArray: DiffValue[],
): { added: DiffValue[]; removed: DiffValue[] } {
  const usedNew = new Array<boolean>(newArray.length).fill(false);
  const removed: DiffValue[] = [];

  for (const element of oldArray) {
    const matchIndex = newArray.findIndex(
      (candidate, index) => !usedNew[index] && diffValuesEqual(element, candidate),
    );
    if (matchIndex === -1) {
      removed.push(element);
    } else {
      usedNew[matchIndex] = true;
    }
  }

  const added = newArray.filter((_, index) => !usedNew[index]);
  return { added, removed };
}

/** 单个字段比对的入参。 */
export interface DiffValuesInput {
  /** 字段路径（本层为口径字段名） */
  path: string;
  /** 口径字段名；缺省时取 path */
  field?: string;
  /** 登记侧列名 */
  column?: string | null;
  /** 登记侧归一值；`undefined` = 缺失（不参与比对） */
  oldValue: unknown;
  /** 院内值；`undefined` = 院内没有这个字段 */
  newValue: unknown;
  /** 登记侧未归一化原值 */
  rawOldValue?: unknown;
  /** 院内原值 */
  rawNewValue?: unknown;
  /** 是否受控编码字段 */
  controlledCode?: boolean;
  /** 等价判定（归并层接入点） */
  equivalent?: EquivalentPredicate;
  /**
   * 登记侧缺失时的处理：
   * - `skip`（默认，产品口径）：表里没有这个字段 → 本轮不参与比对，不产出操作
   * - `add`（对象级最小差异口径）：目标里有、来源里没有 → 产出一条「新增」
   */
  missingOldPolicy?: 'skip' | 'add';
  /** 破坏性打标器（由破坏性判定规则表接入时提供） */
  tagDestructive?: DestructiveTagger;
}

interface OperationParts {
  changeKind: DiffChangeKind;
  typeChanged?: boolean;
  detail?: DiffDetail;
}

/**
 * 比对单个字段，产出最小操作集合（0 条、1 条，或数组场景下的 2 条）。
 *
 * 操作类型路由（登记侧 → 院内侧）：
 * - 登记侧缺失 → 不参与比对，不产出操作
 * - 登记侧空着、院内有值 → `add`（新增）
 * - 登记侧有值、院内没有这个字段 → `remove`（删除）
 * - 院内显式为空、登记侧有值 → `replace`（修改：等于清空这一格）
 * - 两侧都有值但不一致 → `replace`（修改）；类型不同另标「类型变更」
 * - 数组：院内多出元素 → `add`；院内少了元素 → `remove`；元素相同只是顺序不同 → 无操作
 * - 对象：属性有变化 → `replace`（属性变化）
 */
export function diffValues(input: DiffValuesInput): DiffOperation[] {
  const field = input.field ?? input.path;
  const column = input.column ?? null;
  const controlledCode = input.controlledCode ?? false;
  const fromKind = valueKind(input.oldValue);
  const toKind = valueKind(input.newValue);

  const build = (
    op: DiffOp,
    oldValue: DiffValue | undefined,
    newValue: DiffValue | undefined,
    parts: OperationParts,
  ): DiffOperation => {
    const operation: DiffOperation = {
      op,
      path: input.path,
      field,
      column,
      oldValue,
      newValue,
      rawOldValue: input.rawOldValue ?? oldValue ?? null,
      rawNewValue: input.rawNewValue ?? newValue ?? null,
      changeKind: parts.changeKind,
      typeChanged: parts.typeChanged ?? false,
      fromKind,
      toKind,
      controlledCode,
      detail: parts.detail ?? null,
    };
    // 破坏性打标（规则表接入时）：标记结果直接进操作结构
    if (input.tagDestructive !== undefined) {
      const tag = input.tagDestructive(operation);
      operation.destructive = tag.destructive;
      operation.destructiveRuleId = tag.ruleId;
      operation.destructiveKind = tag.kind;
    }
    return operation;
  };

  // 登记侧没有这个字段 → 本轮不参与比对（不猜、不补一条「新增」）
  if (fromKind === 'missing') {
    if (input.missingOldPolicy !== 'add') return [];
    if (toKind === 'missing') return [];
    return [build('add', undefined, input.newValue as DiffValue, { changeKind: '新增' })];
  }

  // 院内没有这个字段
  if (toKind === 'missing') {
    // 登记侧本来就是空的，不该建议「删除」
    if (fromKind === 'null') return [];
    return [build('remove', input.oldValue as DiffValue, null, { changeKind: '删除' })];
  }

  // 登记侧这一格空着，院内有值 → 建议新增
  if (fromKind === 'null') {
    if (toKind === 'null') return [];
    return [build('add', null, input.newValue as DiffValue, { changeKind: '新增' })];
  }

  const oldValue = input.oldValue as DiffValue;
  const newValue = input.newValue as DiffValue;

  // 归并等价（由归并层判定）→ 视为同一值
  if (input.equivalent?.(field, oldValue, newValue)) return [];

  // 逐字相等 → 无操作（最小性的第一道闸）
  if (diffValuesEqual(oldValue, newValue)) return [];

  // 院内显式为空（null）而登记侧有值 → 修改（等于建议清空这一格），不是删除
  if (toKind === 'null') {
    return [build('replace', oldValue, null, { changeKind: '值不同' })];
  }

  // 类型不同（文本 ↔ 数值 ↔ 布尔 ↔ 数组 ↔ 对象）→ 修改并标注类型变更
  if (fromKind !== toKind) {
    return [
      build('replace', oldValue, newValue, {
        changeKind: '类型变更',
        typeChanged: true,
      }),
    ];
  }

  if (fromKind === 'array') {
    const { added, removed } = matchArrayElements(
      oldValue as DiffValue[],
      newValue as DiffValue[],
    );
    if (added.length === 0 && removed.length === 0) return [];
    const operations: DiffOperation[] = [];
    if (added.length > 0) {
      operations.push(
        build('add', oldValue, newValue, {
          changeKind: '元素新增',
          detail: { addedElements: added },
        }),
      );
    }
    if (removed.length > 0) {
      operations.push(
        build('remove', oldValue, newValue, {
          changeKind: '元素删除',
          detail: { removedElements: removed },
        }),
      );
    }
    return operations;
  }

  if (fromKind === 'object') {
    const oldObject = oldValue as { [key: string]: DiffValue };
    const newObject = newValue as { [key: string]: DiffValue };
    const changedProperties: string[] = [];
    const addedProperties: string[] = [];
    const removedProperties: string[] = [];

    for (const key of Object.keys(newObject)) {
      if (!Object.prototype.hasOwnProperty.call(oldObject, key)) {
        addedProperties.push(key);
      } else if (!diffValuesEqual(oldObject[key], newObject[key])) {
        changedProperties.push(key);
      }
    }
    for (const key of Object.keys(oldObject)) {
      if (!Object.prototype.hasOwnProperty.call(newObject, key)) {
        removedProperties.push(key);
      }
    }

    if (
      changedProperties.length === 0 &&
      addedProperties.length === 0 &&
      removedProperties.length === 0
    ) {
      return [];
    }

    return [
      build('replace', oldValue, newValue, {
        changeKind: '属性变化',
        detail: { changedProperties, addedProperties, removedProperties },
      }),
    ];
  }

  return [build('replace', oldValue, newValue, { changeKind: '值不同' })];
}

/** 一组字段的比对入参。 */
export interface FieldDiffInput {
  /** 口径字段名 */
  field: string;
  /** 登记侧列名 */
  column?: string | null;
  /** 登记侧归一值；`undefined` = 缺失（不参与比对） */
  oldValue: unknown;
  /** 院内值；`undefined` = 院内没有这个字段 */
  newValue: unknown;
  /** 登记侧未归一化原值 */
  rawOldValue?: unknown;
  /** 院内原值 */
  rawNewValue?: unknown;
  /** 是否受控编码字段 */
  controlledCode?: boolean;
}

export interface DiffFieldsOptions {
  /** 字段口径表：给了就以它为准（人工补充列与不参与比对的字段一律跳过） */
  spec?: FieldSpec;
  /** 等价判定（归并层接入点） */
  equivalent?: EquivalentPredicate;
  /** 登记侧缺失时的处理，默认 skip（产品口径） */
  missingOldPolicy?: 'skip' | 'add';
  /** 破坏性打标器（由破坏性判定规则表接入时提供） */
  tagDestructive?: DestructiveTagger;
}

/**
 * 逐字段比对一批字段，产出最小操作集合。
 *
 * 口径表在位时，人工补充列与「口径表声明不参与比对」的字段**一律不产生操作**，
 * 哪怕调用方把值传进来了也不比 —— 这是写回层敢「只追加新列」的前提。
 */
export function diffFields(
  inputs: FieldDiffInput[],
  options: DiffFieldsOptions = {},
): DiffOperation[] {
  const specEntries = new Map<string, FieldSpec['fields'][number]>();
  for (const entry of options.spec?.fields ?? []) {
    specEntries.set(entry.field, entry);
  }

  const operations: DiffOperation[] = [];
  for (const input of inputs) {
    const entry = specEntries.get(input.field);
    if (entry !== undefined) {
      if (entry.humanSupplied) continue;
      if (!entry.participatesInDiff) continue;
    }

    operations.push(
      ...diffValues({
        path: input.field,
        field: input.field,
        column: entry?.sourceColumn ?? input.column ?? null,
        oldValue: input.oldValue,
        newValue: input.newValue,
        rawOldValue: input.rawOldValue,
        rawNewValue: input.rawNewValue,
        controlledCode: entry?.controlledCode ?? input.controlledCode ?? false,
        equivalent: options.equivalent,
        missingOldPolicy: options.missingOldPolicy,
        tagDestructive: options.tagDestructive,
      }),
    );
  }
  return operations;
}

/** 一行比对的结果。 */
export interface DiffRowResult {
  /** 最小操作集合 */
  operations: DiffOperation[];
  /** 本轮未参与比对的字段及原因（逐条说清，不静默跳过） */
  skipped: SkippedField[];
}

/** 未参与比对的字段与原因。 */
export interface SkippedField {
  /** 口径字段名 */
  field: string;
  /** 面向登记员的原因 */
  reason: string;
}

/** 一行比对（登记表行 ↔ 院内权威记录）的入参。 */
export interface DiffRowInput {
  /** 字段口径表 */
  spec: FieldSpec;
  /** 口径字段名 → 登记侧归一值。键不存在 = 登记侧没有这个字段 */
  registryValues: Record<string, unknown>;
  /** 口径字段名 → 院内值。键不存在 = 院内本轮未取到；值为 `undefined` = 院内没有这个字段 */
  hospitalValues: Record<string, unknown>;
  /** 口径字段名 → 登记侧未归一化原值 */
  rawRegistryValues?: Record<string, unknown>;
  /** 口径字段名 → 院内原值 */
  rawHospitalValues?: Record<string, unknown>;
  /** 等价判定（归并层接入点） */
  equivalent?: EquivalentPredicate;
  /** 破坏性打标器（由破坏性判定规则表接入时提供） */
  tagDestructive?: DestructiveTagger;
}

/**
 * 按口径表把一行比对完。
 *
 * 跳过规则（每条都有原因，不静默丢字段）：
 * - 人工补充列 → 只读不覆盖，不参与比对
 * - 口径表声明不参与比对的字段 → 不参与比对
 * - 登记侧没有这个字段的值 → 不参与比对（不产出一条「新增」把表填满）
 * - 院内本轮未取到这个字段 → 不参与比对（**不等于院内没有**，更不能据此判「删除」）
 */
export function diffRowAgainstRecord(input: DiffRowInput): DiffRowResult {
  const operations: DiffOperation[] = [];
  const skipped: SkippedField[] = [];

  for (const entry of input.spec.fields) {
    if (entry.humanSupplied) {
      skipped.push({
        field: entry.field,
        reason: '人工补充列 · 只读不覆盖 · 不参与比对',
      });
      continue;
    }
    if (!entry.participatesInDiff) {
      skipped.push({ field: entry.field, reason: '口径表声明本轮不参与比对' });
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(input.registryValues, entry.field)) {
      skipped.push({
        field: entry.field,
        reason: '登记侧本轮没有这个字段的值，不参与比对',
      });
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(input.hospitalValues, entry.field)) {
      skipped.push({
        field: entry.field,
        reason: '院内本轮未取到这个字段的值，不参与比对（未取到 ≠ 院内没有）',
      });
      continue;
    }

    operations.push(
      ...diffValues({
        path: entry.field,
        field: entry.field,
        column: entry.sourceColumn,
        oldValue: input.registryValues[entry.field],
        newValue: input.hospitalValues[entry.field],
        rawOldValue: input.rawRegistryValues?.[entry.field],
        rawNewValue: input.rawHospitalValues?.[entry.field],
        controlledCode: entry.controlledCode,
        equivalent: input.equivalent,
        tagDestructive: input.tagDestructive,
      }),
    );
  }

  return { operations, skipped };
}

/**
 * 对象级最小差异：给两份对象，算出把前者改成后者所需的最小操作集合。
 *
 * 与源产品主路径同名同义（`createPatch(input, output) → Operation[]`）：
 * 「算最小补丁」而不是「整份覆盖」。本层按**顶层字段**比，不下钻到数组元素与
 * 嵌套属性（那由 nested 层展开成带索引、带层级的操作）。
 */
export function createPatch(
  input: Record<string, unknown>,
  output: Record<string, unknown>,
  options: DiffFieldsOptions = {},
): DiffOperation[] {
  const fields: FieldDiffInput[] = [];
  const seen = new Set<string>();

  for (const key of Object.keys(output)) {
    seen.add(key);
    const present = Object.prototype.hasOwnProperty.call(input, key);
    fields.push({
      field: key,
      column: null,
      oldValue: present ? input[key] : undefined,
      newValue: output[key],
      rawOldValue: present ? input[key] : undefined,
      rawNewValue: output[key],
    });
  }
  for (const key of Object.keys(input)) {
    if (seen.has(key)) continue;
    fields.push({
      field: key,
      column: null,
      oldValue: input[key],
      newValue: undefined,
      rawOldValue: input[key],
      rawNewValue: undefined,
    });
  }

  return diffFields(fields, { ...options, missingOldPolicy: 'add' });
}
