/**
 * 数组与嵌套对象的差异展开层：把字段级的一条「属性变化 / 元素新增」拆成
 * **带索引、带层级**的最小操作集合。
 *
 * 与源产品主路径的关系：源实现的 `createPatch(input, output) → Operation[]`
 * 用一条 `Pointer` 路径贯穿整棵树（`createPatch` 以路径为操作单位，
 * `createTest()` 按同一条路径把目标当前值取出来做写前比对）。本层把同一套
 * 「以路径为最小操作单位」的语义落到本产品的登记表侧，但路径换成本产品能
 * 直接读的形状：**点号分层 + 数组下标**（`a.b[2].c`）——登记员在「差异」列
 * 看的就是这条路径，写前比对（ifMatch）也按这条路径回查院内当前值。
 *
 * 五条硬规矩：
 * - **索引级操作**：数组按元素配对，产出 `items[2]` 这种带下标的路径，
 *   不是一条笼统的「数组不一样」。
 * - **逐层展开**：嵌套对象按 `a.b.c` 一层层展开，只对真正变化的叶子/属性
 *   产出操作；值相等的属性**一条操作都不产生**。
 * - **缺失与显式空严格分开**：目标侧**没有这个键** → `remove`（删除）；
 *   目标侧**键在但值是 null** → `replace`（修改，等于把这一格清空）。
 *   两者绝不能混成同一条操作。
 * - **类型变更单独标注**：数字 ↔ 字符串 ↔ 布尔（以及数组 ↔ 对象）判为
 *   `replace` 且 `typeChanged=true`，写回层据此提示「类型不同，请人工核对」。
 * - **顺序不同但元素相同不算差异**：表里 `['A','B']`、院内 `['B','A']`，
 *   元素集合一致 → 零操作。登记员重排了顺序不该被当成「院内多了/少了一条」。
 *
 * 本层**不做归并**：`ⅢB` 与 `IIIB` 在这里就是两个值；归并等价由归并层通过
 * `equivalent` 接进来（同 patch 层一致）。
 */
import type { FieldSpec } from './field-spec.js';
import {
  diffValues,
  diffValuesEqual,
  valueKind,
  type DiffChangeKind,
  type DiffOp,
  type DiffOperation,
  type DiffValue,
  type DiffValueKind,
  type DestructiveTagger,
  type EquivalentPredicate,
  type FieldDiffInput,
} from './patch.js';

/** 默认最大展开深度（防畸形输入把比对拖进无意义的深递归）。 */
export const NESTED_MAX_DEPTH = 8;

/** 展开深度封顶时写进明细的说明。 */
export const NESTED_DEPTH_CAPPED_NOTE = '超过最大展开深度，整块按修改处理';

/** 嵌套层的一条最小操作：与字段级同结构，只是 path 更细。 */
export type NestedOperation = DiffOperation;

/** 嵌套层比对的入参。 */
export interface NestedDiffInput {
  /** 根路径（通常是口径字段名） */
  path: string;
  /** 口径字段名；缺省时取 path */
  field?: string;
  /** 登记侧列名 */
  column?: string | null;
  /** 登记侧值；`undefined` = 缺失（根层按 missingOldPolicy 处理） */
  oldValue: unknown;
  /** 院内值；`undefined` = 院内没有这个字段 */
  newValue: unknown;
  /** 登记侧未归一化原值（嵌套层无独立原值通道，沿用归一值） */
  rawOldValue?: unknown;
  /** 院内原值 */
  rawNewValue?: unknown;
  /** 是否受控编码字段 */
  controlledCode?: boolean;
  /** 等价判定（归并层接入点） */
  equivalent?: EquivalentPredicate;
  /**
   * 根层登记侧缺失时的处理：
   * - `skip`（默认，产品口径）：表里没有这个字段 → 本轮不参与比对
   * - `add`：目标里有、来源里没有 → 产出一条「新增」
   */
  missingOldPolicy?: 'skip' | 'add';
  /** 最大展开深度，默认 {@link NESTED_MAX_DEPTH} */
  maxDepth?: number;
  /** 破坏性打标器（由破坏性判定规则表接入时提供） */
  tagDestructive?: DestructiveTagger;
}

/** 内部上下文：贯穿整棵树的固定信息。 */
interface NestedContext {
  field: string;
  column: string | null;
  controlledCode: boolean;
  equivalent?: EquivalentPredicate;
  tagDestructive?: DestructiveTagger;
  maxDepth: number;
  depth: number;
}

/** 造一条操作。 */
function makeOperation(
  context: NestedContext,
  op: DiffOp,
  path: string,
  oldValue: DiffValue | undefined,
  newValue: DiffValue | undefined,
  changeKind: DiffChangeKind,
  options: {
    typeChanged?: boolean;
    fromKind?: DiffValueKind;
    toKind?: DiffValueKind;
    note?: string;
  } = {},
): NestedOperation {
  const operation: NestedOperation = {
    op,
    path,
    field: context.field,
    column: context.column,
    oldValue,
    newValue,
    // 嵌套层没有独立的「表内原文」通道：表内原文只在字段级保留（供 ifMatch 比对），
    // 嵌套层的原值即归一值本身。
    rawOldValue: oldValue ?? null,
    rawNewValue: newValue ?? null,
    changeKind,
    typeChanged: options.typeChanged ?? false,
    fromKind: options.fromKind ?? valueKind(oldValue),
    toKind: options.toKind ?? valueKind(newValue),
    controlledCode: context.controlledCode,
    detail: options.note ? { note: options.note } : null,
  };
  // 破坏性打标（规则表接入时）：标记结果直接进操作结构
  if (context.tagDestructive !== undefined) {
    const tag = context.tagDestructive(operation);
    operation.destructive = tag.destructive;
    operation.destructiveRuleId = tag.ruleId;
    operation.destructiveKind = tag.kind;
  }
  return operation;
}

/** 拼子路径：对象用点号，数组用下标。 */
export function joinPath(base: string, segment: string): string {
  return `${base}.${segment}`;
}

/** 拼数组下标路径。 */
export function indexPath(base: string, index: number): string {
  return `${base}[${index}]`;
}

/**
 * 数组元素配对：先按内容深比对配出「两边都对得上」的元素，剩下的再按出现顺序配对。
 *
 * 返回的 `unmatchedOld` / `unmatchedNew` 是**没有内容相同对应物**的元素下标。
 * 这一步保证了「顺序不同但元素相同」被判为无差异（两侧都配得上 → 没有剩余）。
 */
export function matchArrayIndices(
  oldArray: DiffValue[],
  newArray: DiffValue[],
): { unmatchedOld: number[]; unmatchedNew: number[] } {
  const usedNew = new Array<boolean>(newArray.length).fill(false);
  const unmatchedOld: number[] = [];

  for (let oldIndex = 0; oldIndex < oldArray.length; oldIndex += 1) {
    const element = oldArray[oldIndex];
    const matchIndex = newArray.findIndex(
      (candidate, index) => !usedNew[index] && diffValuesEqual(element, candidate),
    );
    if (matchIndex === -1) {
      unmatchedOld.push(oldIndex);
    } else {
      usedNew[matchIndex] = true;
    }
  }

  const unmatchedNew: number[] = [];
  for (let newIndex = 0; newIndex < newArray.length; newIndex += 1) {
    if (!usedNew[newIndex]) unmatchedNew.push(newIndex);
  }

  return { unmatchedOld, unmatchedNew };
}

/**
 * 比对两个值，产出最小操作集合（叶子级）。
 *
 * 规则（每一层都一样，根层只多一条「登记侧缺失按口径处理」）：
 *
 * | 登记侧 | 院内侧 | 操作 | 变化类型 |
 * |--------|--------|------|----------|
 * | 缺失 | 缺失 | — | — |
 * | 缺失 | 有值 | `add` | 新增 |
 * | 有值 | 缺失（键不存在） | `remove` | 删除 |
 * | 空（null） | 空（null） | — | — |
 * | 空（null） | 有值 | `add` | 新增 |
 * | 有值 | 空（null） | `replace` | 值不同 |
 * | 有值 | 有值（类型不同） | `replace` | 类型变更 |
 * | 有值 | 有值（数组） | 展开 | 元素级操作 |
 * | 有值 | 有值（对象） | 展开 | 属性级操作 |
 * | 有值 | 有值（相等） | — | — |
 */
function diffValueAt(
  oldValue: unknown,
  newValue: unknown,
  path: string,
  context: NestedContext,
): NestedOperation[] {
  const fromKind = valueKind(oldValue);
  const toKind = valueKind(newValue);

  // 深度封顶：不再往下钻，整块按「修改」处理，并在明细里写明原因（不猜）
  if (context.depth > context.maxDepth) {
    return [
      makeOperation(context, 'replace', path, oldValue as DiffValue, newValue as DiffValue, '值不同', {
        note: NESTED_DEPTH_CAPPED_NOTE,
      }),
    ];
  }

  // 目标侧没有这个键 → 删除（与「键在但值为 null」严格分开）
  if (toKind === 'missing') {
    if (fromKind === 'missing') return [];
    return [
      makeOperation(context, 'remove', path, oldValue as DiffValue, null, '删除', {
        fromKind,
        toKind,
      }),
    ];
  }

  // 登记侧没有这个键 → 新增
  if (fromKind === 'missing') {
    return [
      makeOperation(context, 'add', path, undefined, newValue as DiffValue, '新增', {
        fromKind,
        toKind,
      }),
    ];
  }

  // 两边都是显式空 → 无操作
  if (fromKind === 'null' && toKind === 'null') return [];

  // 登记侧这一格空着、院内有值 → 新增
  if (fromKind === 'null') {
    return [
      makeOperation(context, 'add', path, null, newValue as DiffValue, '新增', {
        fromKind,
        toKind,
      }),
    ];
  }

  // 院内显式为空、登记侧有值 → 修改（等于把这一格清空），不是删除
  if (toKind === 'null') {
    return [
      makeOperation(context, 'replace', path, oldValue as DiffValue, null, '值不同', {
        fromKind,
        toKind,
      }),
    ];
  }

  // 类型不同（文本 ↔ 数值 ↔ 布尔 ↔ 数组 ↔ 对象）→ 修改并标注类型变更
  if (fromKind !== toKind) {
    return [
      makeOperation(context, 'replace', path, oldValue as DiffValue, newValue as DiffValue, '类型变更', {
        typeChanged: true,
        fromKind,
        toKind,
      }),
    ];
  }

  if (fromKind === 'array') {
    return diffArray(
      oldValue as DiffValue[],
      newValue as DiffValue[],
      path,
      { ...context, depth: context.depth + 1 },
    );
  }

  if (fromKind === 'object') {
    return diffObject(
      oldValue as { [key: string]: DiffValue },
      newValue as { [key: string]: DiffValue },
      path,
      { ...context, depth: context.depth + 1 },
    );
  }

  // 标量：归并等价（归并层接入点）→ 视为同一值
  if (context.equivalent?.(context.field, oldValue as DiffValue, newValue as DiffValue)) {
    return [];
  }

  // 逐字相等 → 无操作（最小性）
  if (diffValuesEqual(oldValue, newValue)) return [];

  return [
    makeOperation(context, 'replace', path, oldValue as DiffValue, newValue as DiffValue, '值不同', {
      fromKind,
      toKind,
    }),
  ];
}

/**
 * 数组差异：逐元素比较，产出带下标的操作路径。
 *
 * 配对顺序：
 * 1. 先按内容深比对配出「两边对得上」的元素（这一对不产生任何操作）；
 * 2. 剩下配不上的，按出现顺序两两配对，在**目标侧下标**上展开比较
 *    （元素是对象/数组时继续往下钻，路径形如 `items[0].code`）；
 * 3. 旧侧多出来的元素 → `remove`（`items[2]`）；
 * 4. 新侧多出来的元素 → `add`（`items[3]`）。
 */
export function diffArray(
  oldArray: DiffValue[],
  newArray: DiffValue[],
  path: string,
  context: NestedContext,
): NestedOperation[] {
  const { unmatchedOld, unmatchedNew } = matchArrayIndices(oldArray, newArray);

  // 元素集合一致（可能只是顺序不同）→ 零操作
  if (unmatchedOld.length === 0 && unmatchedNew.length === 0) return [];

  const operations: NestedOperation[] = [];
  const pairCount = Math.min(unmatchedOld.length, unmatchedNew.length);

  // 配不上的元素按出现顺序两两配对，在目标侧下标上展开
  for (let pair = 0; pair < pairCount; pair += 1) {
    const oldIndex = unmatchedOld[pair] as number;
    const newIndex = unmatchedNew[pair] as number;
    const oldElement = oldArray[oldIndex] as DiffValue;
    const newElement = newArray[newIndex] as DiffValue;
    operations.push(
      ...diffValueAt(oldElement, newElement, indexPath(path, newIndex), context),
    );
  }

  // 旧侧多出来的元素 → 删除
  for (let index = pairCount; index < unmatchedOld.length; index += 1) {
    const oldIndex = unmatchedOld[index] as number;
    operations.push(
      makeOperation(
        context,
        'remove',
        indexPath(path, oldIndex),
        oldArray[oldIndex] as DiffValue,
        null,
        '元素删除',
        { fromKind: valueKind(oldArray[oldIndex]), toKind: 'missing' },
      ),
    );
  }

  // 新侧多出来的元素 → 新增
  for (let index = pairCount; index < unmatchedNew.length; index += 1) {
    const newIndex = unmatchedNew[index] as number;
    operations.push(
      makeOperation(
        context,
        'add',
        indexPath(path, newIndex),
        undefined,
        newArray[newIndex] as DiffValue,
        '元素新增',
        { fromKind: 'missing', toKind: valueKind(newArray[newIndex]) },
      ),
    );
  }

  return operations;
}

/**
 * 对象差异：逐层展开（`a.b.c`），只对真正变化的属性产出操作。
 *
 * - 目标侧多出来的属性 → `add`（`a.b`）
 * - 目标侧没有的属性 → `remove`（`a.c`）
 * - 两边都有的属性 → 继续往下比（值相等则零操作）
 */
export function diffObject(
  oldObject: { [key: string]: DiffValue },
  newObject: { [key: string]: DiffValue },
  path: string,
  context: NestedContext,
): NestedOperation[] {
  const operations: NestedOperation[] = [];

  for (const key of Object.keys(newObject)) {
    const childPath = joinPath(path, key);
    if (!Object.prototype.hasOwnProperty.call(oldObject, key)) {
      operations.push(
        makeOperation(context, 'add', childPath, undefined, newObject[key] as DiffValue, '新增', {
          fromKind: 'missing',
          toKind: valueKind(newObject[key]),
        }),
      );
      continue;
    }
    operations.push(
      ...diffValueAt(oldObject[key] as DiffValue, newObject[key] as DiffValue, childPath, context),
    );
  }

  for (const key of Object.keys(oldObject)) {
    if (Object.prototype.hasOwnProperty.call(newObject, key)) continue;
    operations.push(
      makeOperation(context, 'remove', joinPath(path, key), oldObject[key] as DiffValue, null, '删除', {
        fromKind: valueKind(oldObject[key]),
        toKind: 'missing',
      }),
    );
  }

  return operations;
}

/**
 * 嵌套差异入口：比一个字段的两侧值，产出带索引、带层级的最小操作集合。
 *
 * 根层的语义与字段级（patch 层）保持一致 —— 登记侧整个缺失时按
 * `missingOldPolicy` 处理（默认 skip：表里没这一列就不参与比对），
 * 其余情况直接进入嵌套展开。
 */
export function diffNested(input: NestedDiffInput): NestedOperation[] {
  const field = input.field ?? input.path;
  const context: NestedContext = {
    field,
    column: input.column ?? null,
    controlledCode: input.controlledCode ?? false,
    equivalent: input.equivalent,
    tagDestructive: input.tagDestructive,
    maxDepth: input.maxDepth ?? NESTED_MAX_DEPTH,
    depth: 0,
  };

  const fromKind = valueKind(input.oldValue);
  const toKind = valueKind(input.newValue);

  // 登记侧整个字段缺失 → 按口径处理（默认不参与比对）
  if (fromKind === 'missing') {
    if (input.missingOldPolicy !== 'add') return [];
    if (toKind === 'missing') return [];
    return [
      makeOperation(context, 'add', input.path, undefined, input.newValue as DiffValue, '新增', {
        fromKind,
        toKind,
      }),
    ];
  }

  return diffValueAt(input.oldValue, input.newValue, input.path, context);
}

/** 一组字段的嵌套比对选项。 */
export interface NestedFieldsOptions {
  /** 字段口径表：给了就以它为准（人工补充列与不参与比对的字段一律跳过） */
  spec?: FieldSpec;
  /** 等价判定（归并层接入点） */
  equivalent?: EquivalentPredicate;
  /** 登记侧缺失时的处理，默认 skip（产品口径） */
  missingOldPolicy?: 'skip' | 'add';
  /** 最大展开深度 */
  maxDepth?: number;
  /** 破坏性打标器（由破坏性判定规则表接入时提供） */
  tagDestructive?: DestructiveTagger;
}

/**
 * 逐字段比对一批字段：标量走字段级语义，数组与对象走嵌套展开。
 *
 * 这是嵌套层接进主路径的入口 —— 口径表在位时，人工补充列与「口径表声明
 * 不参与比对」的字段**一律不产生操作**，哪怕调用方把值传进来了也不比。
 */
export function diffFieldsNested(
  inputs: FieldDiffInput[],
  options: NestedFieldsOptions = {},
): NestedOperation[] {
  const specEntries = new Map<string, FieldSpec['fields'][number]>();
  for (const entry of options.spec?.fields ?? []) {
    specEntries.set(entry.field, entry);
  }

  const operations: NestedOperation[] = [];
  for (const input of inputs) {
    const entry = specEntries.get(input.field);
    if (entry !== undefined) {
      if (entry.humanSupplied) continue;
      if (!entry.participatesInDiff) continue;
    }

    const kind = valueKind(input.oldValue);
    const isStructured = kind === 'array' || kind === 'object';

    if (!isStructured) {
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
      continue;
    }

    operations.push(
      ...diffNested({
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
        maxDepth: options.maxDepth,
        tagDestructive: options.tagDestructive,
      }),
    );
  }
  return operations;
}

/** 一条操作的路径摘要（写进 run-log 与差异文案用）。 */
export function describeOperationPath(operation: NestedOperation): string {
  return `${operation.op} ${operation.path}`;
}
