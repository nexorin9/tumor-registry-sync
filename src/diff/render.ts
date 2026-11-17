/**
 * 差异文案渲染层：把最小操作集合（`Operation[]`）翻译成表内两列能直接读的中文。
 *
 * 差异引擎（patch / nested）只说「哪条路径变了、怎么变的」；登记员要看的是
 * 「分期这一格，院里写的是 ⅢB，我表里写的是 ⅡA，改还是不改」。这一层负责
 * 把前者翻译成后者，并且守住三条硬规矩：
 *
 * - **差异与建议分开**：差异列说「变了什么」，建议值列说「建议怎么填」。
 *   两件事不混在一格里 —— 登记员扫一眼就知道哪句是事实、哪句要他点头。
 * - **不猜**：归不出受控编码 → 建议值留空并标「需人工判定」；口径没声明 →
 *   明写「口径未声明，不参与比对」。**绝不填一个看起来合理的值。**
 * - **不含患者可识别明报**：文案只出现字段名与值；值里的手机号 / 身份证号 /
 *   邮箱形态一律脱敏，姓名类字段的值整段脱敏。
 *
 * 与状态色板的联动：每条差异都映射到 token 里的呈现状态，写回层据此上底色；
 * 两个宏宿主（Excel / WPS）从同一份 token 取色，画出来的表必然一样。
 */
import {
  getStatusToken,
  type PresentationStatus,
  type StatusToken,
} from '../sheet/present/tokens.js';
import { redactIdentifiable } from '../sheet/row-issues.js';

import type { MergeSuggestion } from './path-map.js';
import type { DiffChangeKind, DiffOperation } from './patch.js';

/* ───────────────────────────── 文案常量 ───────────────────────────── */

/** 差异列里表示「与院内一致」的文案（不是空白格）。 */
export const DIFF_TEXT_CONSISTENT = '与院内一致';

/** 建议值列里「口径未声明」的固定措辞。 */
export const SUGGESTION_CALIBER_UNSPECIFIED = '口径未声明，不参与比对';

/** 建议值列里「需人工判定」的固定措辞。 */
export const SUGGESTION_MANUAL_JUDGEMENT = '写法无法归并到受控编码，建议值留空，请人工填写';

/** 差异列里「需人工判定」的默认说明。 */
export const DIFF_TEXT_MANUAL_JUDGEMENT = '写法无法归并到受控编码';

/** 值的最大展示长度；超出的部分用「…」截断。 */
export const MAX_VALUE_CHARS = 40;

/** 一行最多展示几条差异（超出折叠并给出总数）。 */
export const DEFAULT_MAX_RENDERED_FIELDS = 3;

/**
 * 字段名里出现这些词，值一律按个人身份明报整段脱敏。
 *
 * 分期、治疗方案、派生日期这些比对字段不会命中；命中的是「姓名」「联系人」
 * 这类万一被登记员塞进表里的列 —— 文案里一个明报都不该出现。
 */
export const PERSONAL_IDENTITY_FIELD_PATTERN = /姓名|名字|联系人|监护人|身份证|护照/;

/** 受控编码建议的措辞。 */
export function controlledCodeSuggestionText(code: string): string {
  return `写法归并后等价，建议统一为受控编码 ${code}`;
}

/* ───────────────────────────── 取值格式化 ───────────────────────────── */

/** 截断过长的文本。 */
function truncate(text: string, max: number = MAX_VALUE_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/**
 * 把一个值格式化成表内可读的短文本。
 *
 * 缺失（undefined）与显式空（null）分开说：前者是「表里没这一项」，
 * 后者是「表里这一项是空的」。两者在差异语义上不是一回事，文案也不能混。
 */
export function formatDiffValue(value: unknown): string {
  if (value === undefined) return '（未填）';
  if (value === null) return '（空）';
  if (Array.isArray(value)) {
    if (value.length === 0) return '（空列表）';
    return truncate(value.map((item) => formatDiffValue(item)).join('、'));
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '（空）';
    return truncate(
      `{${entries.map(([key, item]) => `${key}=${formatDiffValue(item)}`).join('，')}}`,
    );
  }
  return truncate(String(value));
}

/** 渲染后的取值（带是否脱敏的标记，便于复核）。 */
export interface RenderedValue {
  /** 表内展示文本 */
  text: string;
  /** 是否做过脱敏 */
  redacted: boolean;
}

/**
 * 按字段名渲染取值：姓名类字段整段脱敏，其余值做形态脱敏。
 *
 * 形态脱敏复用待人工处理清单那一份规则（手机号留前 3 后 4、身份证留前 6 后 4、
 * 邮箱只留域名），保证「表里看到的」与「清单里写下的」脱敏口径完全一致。
 */
export function renderFieldValue(field: string, value: unknown): RenderedValue {
  if (PERSONAL_IDENTITY_FIELD_PATTERN.test(field)) {
    return { text: '（已脱敏）', redacted: true };
  }
  const raw = formatDiffValue(value);
  const text = redactIdentifiable(raw);
  return { text, redacted: text !== raw };
}

/* ───────────────────────────── 状态色板联动 ───────────────────────────── */

/**
 * 引擎的细分变化类型 → 表内呈现状态。
 *
 * 除了「类型变更」外都归到「差异」（红色底 = 这格和院里不一样）。
 * 「类型变更」也归到「差异」—— 它**确实是**一处差异，只是多带一句
 * 「类型不同，请人工核对」；不另开一个状态，免得登记员多记一种颜色。
 */
export const DIFF_CHANGE_STATUS: Record<DiffChangeKind, PresentationStatus> = {
  新增: '差异',
  删除: '差异',
  值不同: '差异',
  类型变更: '差异',
  元素新增: '差异',
  元素删除: '差异',
  属性变化: '差异',
};

/** 差异条目的四类（前三类与差异有关，第四类说明本轮不参与比对）。 */
export type DiffEntryKind = '差异' | '受控编码建议' | '需人工判定' | '口径未声明';

/** 变化类型：新增 / 修改 / 删除（面向登记员，不暴露英文操作码）。 */
export type ChangeType = '新增' | '修改' | '删除';

/** 操作类型 → 变化类型。 */
const OP_CHANGE_TYPE: Record<'add' | 'replace' | 'remove', ChangeType> = {
  add: '新增',
  replace: '修改',
  remove: '删除',
};

/* ───────────────────────────── 条目模型 ───────────────────────────── */

/** 差异列里的一条：要么是一条真实差异，要么是一条与差异相关的说明。 */
export interface DiffEntry {
  /** 条目类型 */
  kind: DiffEntryKind;
  /** 口径字段名 */
  field: string;
  /** 登记侧列名（表里那一列的名字） */
  column: string | null;
  /** 表内展示用的字段标签（列名 + 嵌套路径后缀） */
  label: string;
  /** 变化类型：新增 / 修改 / 删除（仅「差异」类有） */
  changeType: ChangeType | null;
  /** 引擎给出的细分变化类型 */
  changeKind: DiffChangeKind | null;
  /** 登记侧取值文案 */
  oldText: string | null;
  /** 院内取值文案 */
  newText: string | null;
  /** 条目正文（不含字段标签前缀） */
  detail: string;
  /** 这一条对应的呈现状态（决定底色） */
  status: PresentationStatus;
}

/** 建议值的一类。 */
export type SuggestionKind =
  /** 可直接采纳：按院内值填 */
  | '采纳院内值'
  /** 受控编码建议：写法归并后等价，建议统一写法 */
  | '受控编码建议'
  /** 需人工判定：归不出或置信不足，建议值留空 */
  | '需人工判定'
  /** 口径未声明：本轮不参与比对 */
  | '口径未声明';

/** 一条建议值。 */
export interface FieldSuggestion {
  /** 建议类型 */
  kind: SuggestionKind;
  /** 口径字段名 */
  field: string;
  /** 登记侧列名 */
  column: string | null;
  /** 表内展示用的字段标签 */
  label: string;
  /**
   * 可直接采纳的建议值。
   * - 采纳院内值：`add` / `replace` 为院内取值文案，`remove` 为空串（表示清空）
   * - 受控编码建议：归并后的受控编码
   * - 需人工判定 / 口径未声明：`null`（没有建议值，留空由人工填）
   */
  value: string | null;
  /** 条目正文（不含字段标签前缀） */
  detail: string;
}

/* ───────────────────────────── 输入 ───────────────────────────── */

/** 需人工判定的字段（归并失败或置信度低于阈值）。 */
export interface ManualField {
  /** 口径字段名 */
  field: string;
  /** 登记侧列名 */
  column?: string | null;
  /** 面向登记员的原因（不填则用默认措辞） */
  reason?: string;
}

/** 渲染入参。 */
export interface RenderDiffInput {
  /** 最小操作集合（字段级或嵌套展开级） */
  operations: DiffOperation[];
  /** 归并建议：写法不同但归并后等价（这类字段不产生任何操作） */
  mergeSuggestions?: MergeSuggestion[];
  /** 需人工判定的字段（归并失败或置信度低于阈值） */
  manualFields?: ManualField[];
  /** 口径未声明的列（本轮不参与比对） */
  unspecifiedColumns?: string[];
  /** 一行最多展示几条差异（超出折叠并给出总数） */
  maxFields?: number;
}

/** 渲染结果：表内两列的文案 + 逐条明细（写回层据此上底色）。 */
export interface RenderedDiff {
  /** 「差异」列文案 */
  diffText: string;
  /** 「建议值」列文案（无建议时为空串） */
  suggestedText: string;
  /** 逐条差异 / 说明 */
  entries: DiffEntry[];
  /** 逐字段建议 */
  suggestions: FieldSuggestion[];
  /** 行级呈现状态 */
  status: PresentationStatus;
  /** 行级呈现 token（底色 / 文字色 / 徽标） */
  token: StatusToken;
  /** 折叠掉的字段数（0 表示没折叠） */
  foldedFields: number;
  /** 涉及的总字段数 */
  totalFields: number;
}

/* ───────────────────────────── 组装 ───────────────────────────── */

/** 表内展示用的字段标签：登记列名优先，嵌套路径作为后缀补上。 */
function entryLabel(operation: DiffOperation): string {
  const base = operation.column ?? operation.field;
  if (operation.path && operation.path !== operation.field) {
    return `${base} · ${operation.path}`;
  }
  return base;
}

/** 把一条操作变成差异条目。 */
function operationToEntry(operation: DiffOperation): DiffEntry {
  const label = entryLabel(operation);
  const changeType = OP_CHANGE_TYPE[operation.op];
  const oldText = renderFieldValue(operation.field, operation.oldValue).text;
  const newText =
    operation.op === 'remove'
      ? '院内无此字段'
      : renderFieldValue(operation.field, operation.newValue).text;

  const typeNote = operation.typeChanged ? ' · 类型不同，请人工核对' : '';
  const detail = `${oldText} → ${newText}（${changeType}${typeNote}）`;

  return {
    kind: '差异',
    field: operation.field,
    column: operation.column,
    label,
    changeType,
    changeKind: operation.changeKind,
    oldText,
    newText,
    detail,
    status: DIFF_CHANGE_STATUS[operation.changeKind],
  };
}

/** 把一条归并建议变成差异条目 + 建议条目。 */
function mergeSuggestionToEntries(
  suggestion: MergeSuggestion,
): { entry: DiffEntry; suggestion: FieldSuggestion } {
  const label = suggestion.column ?? suggestion.field;
  const registryText = renderFieldValue(suggestion.field, suggestion.rawValue).text;
  const hospitalText = renderFieldValue(suggestion.field, suggestion.hospitalValue).text;

  return {
    entry: {
      kind: '受控编码建议',
      field: suggestion.field,
      column: suggestion.column,
      label,
      changeType: null,
      changeKind: null,
      oldText: registryText,
      newText: hospitalText,
      detail: `写法归并后等价（登记写「${registryText}」，院内写「${hospitalText}」）`,
      status: '待确认',
    },
    suggestion: {
      kind: '受控编码建议',
      field: suggestion.field,
      column: suggestion.column,
      label,
      value: suggestion.mergedCode,
      detail: controlledCodeSuggestionText(suggestion.mergedCode),
    },
  };
}

/** 把一个需人工判定的字段变成差异条目 + 建议条目。 */
function manualFieldToEntries(
  manual: ManualField,
): { entry: DiffEntry; suggestion: FieldSuggestion } {
  const label = manual.column ?? manual.field;
  const reason = manual.reason ?? DIFF_TEXT_MANUAL_JUDGEMENT;

  return {
    entry: {
      kind: '需人工判定',
      field: manual.field,
      column: manual.column ?? null,
      label,
      changeType: null,
      changeKind: null,
      oldText: null,
      newText: null,
      detail: reason,
      status: '需人工判定',
    },
    suggestion: {
      kind: '需人工判定',
      field: manual.field,
      column: manual.column ?? null,
      label,
      value: null,
      detail: manual.reason
        ? `${manual.reason}，建议值留空，请人工填写`
        : SUGGESTION_MANUAL_JUDGEMENT,
    },
  };
}

/** 把一个口径未声明的列变成差异条目 + 建议条目。 */
function unspecifiedColumnToEntries(
  column: string,
): { entry: DiffEntry; suggestion: FieldSuggestion } {
  return {
    entry: {
      kind: '口径未声明',
      field: column,
      column,
      label: column,
      changeType: null,
      changeKind: null,
      oldText: null,
      newText: null,
      detail: SUGGESTION_CALIBER_UNSPECIFIED,
      status: '无需确认',
    },
    suggestion: {
      kind: '口径未声明',
      field: column,
      column,
      label: column,
      value: null,
      detail: SUGGESTION_CALIBER_UNSPECIFIED,
    },
  };
}

/** 把一条差异操作变成建议条目。 */
function operationToSuggestion(operation: DiffOperation): FieldSuggestion {
  const label = entryLabel(operation);
  const newText =
    operation.op === 'remove'
      ? '院内无此字段'
      : renderFieldValue(operation.field, operation.newValue).text;

  let detail: string;
  let value: string | null;
  if (operation.op === 'remove') {
    detail = '建议清空（院内无此字段）';
    value = '';
  } else if (operation.newValue === null) {
    detail = '建议清空（院内显式为空）';
    value = '';
  } else if (operation.op === 'add') {
    detail = `建议补填「${newText}」`;
    value = newText;
  } else {
    detail = `建议改为「${newText}」`;
    value = newText;
  }

  return {
    kind: '采纳院内值',
    field: operation.field,
    column: operation.column,
    label,
    value,
    detail,
  };
}

/* ───────────────────────────── 折叠 ───────────────────────────── */

/** 折叠结果：展示哪几条 + 一句说明。 */
interface FoldedEntries {
  shown: DiffEntry[];
  note: string | null;
  foldedFields: number;
  totalFields: number;
}

/**
 * 差异条目超过阈值时折叠：只展示前 N 条，后面补一句总数。
 *
 * 折叠的是**差异列** —— 那一格最长，登记员先看前几条；
 * 建议值列**不折叠**（可执行的建议一条都不能被折掉）。
 *
 * 总数只算「一个字段都没露过」的字段：同一个字段的第二条差异已经在前面露过，
 * 不该再被算成「另一个字段」，否则登记员会以为漏了一整列。
 */
function foldEntries(entries: DiffEntry[], maxFields: number): FoldedEntries {
  const totalFields = new Set(entries.map((entry) => entry.field)).size;
  if (entries.length <= maxFields) {
    return { shown: entries, note: null, foldedFields: 0, totalFields };
  }

  const shown = entries.slice(0, maxFields);
  const rest = entries.slice(maxFields);
  const shownFields = new Set(shown.map((entry) => entry.field));
  const hiddenFields = new Set(
    rest.filter((entry) => !shownFields.has(entry.field)).map((entry) => entry.field),
  ).size;
  const note =
    hiddenFields > 0
      ? `另有 ${hiddenFields} 个字段有差异（共 ${totalFields} 个字段）`
      : `另有 ${rest.length} 处差异（共 ${totalFields} 个字段）`;

  return { shown, note, foldedFields: hiddenFields, totalFields };
}

/* ───────────────────────────── 行级状态 ───────────────────────────── */

/** 行级呈现状态：按条目类型取最重的一档。 */
export function diffRowStatus(entries: DiffEntry[]): PresentationStatus {
  if (entries.some((entry) => entry.kind === '差异')) return '差异';
  if (entries.some((entry) => entry.kind === '需人工判定')) return '需人工判定';
  if (entries.some((entry) => entry.kind === '受控编码建议')) return '待确认';
  if (entries.some((entry) => entry.kind === '口径未声明')) return '无需确认';
  return '一致';
}

/* ───────────────────────────── 主入口 ───────────────────────────── */

/**
 * 把最小操作集合渲染成表内两列的文案。
 *
 * @param input 操作集合 + 归并建议 + 需人工判定字段 + 口径未声明列
 * @returns 差异列文案、建议值列文案、逐条明细与行级呈现状态
 */
export function renderDiff(input: RenderDiffInput): RenderedDiff {
  const maxFields = input.maxFields ?? DEFAULT_MAX_RENDERED_FIELDS;
  if (!Number.isInteger(maxFields) || maxFields < 1) {
    throw new RangeError(`差异文案的折叠阈值必须是正整数，实际为 ${String(maxFields)}`);
  }

  const entries: DiffEntry[] = [];
  const suggestions: FieldSuggestion[] = [];

  for (const operation of input.operations) {
    entries.push(operationToEntry(operation));
    suggestions.push(operationToSuggestion(operation));
  }

  for (const merge of input.mergeSuggestions ?? []) {
    const { entry, suggestion } = mergeSuggestionToEntries(merge);
    entries.push(entry);
    suggestions.push(suggestion);
  }

  for (const manual of input.manualFields ?? []) {
    const { entry, suggestion } = manualFieldToEntries(manual);
    entries.push(entry);
    suggestions.push(suggestion);
  }

  for (const column of input.unspecifiedColumns ?? []) {
    const { entry, suggestion } = unspecifiedColumnToEntries(column);
    entries.push(entry);
    suggestions.push(suggestion);
  }

  const folded = foldEntries(entries, maxFields);

  const diffParts = folded.shown.map((entry) => `${entry.label}：${entry.detail}`);
  if (folded.note !== null) diffParts.push(folded.note);
  const diffText =
    diffParts.length === 0 ? DIFF_TEXT_CONSISTENT : diffParts.join('；');

  const suggestedText = suggestions
    .map((suggestion) => `${suggestion.label}：${suggestion.detail}`)
    .join('；');

  const status = diffRowStatus(entries);

  return {
    diffText,
    suggestedText,
    entries,
    suggestions,
    status,
    token: getStatusToken(status),
    foldedFields: folded.foldedFields,
    totalFields: folded.totalFields,
  };
}
