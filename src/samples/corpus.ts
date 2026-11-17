/**
 * 登记员自由写法语料与受控编码表 —— 验证用数据集。
 *
 * 这份语料把登记员在表里**真实会写的写法**摆出来：罗马数字、全半角、带空格、
 * 同义表述、以及根本归不过去的开放类目。它是归并层（受控词表 → 规范化 → 模型兜底）
 * 的对照基准：哪条写法该归到哪个受控编码、哪条该标「需人工判定」，都写死在语料里。
 *
 * 口径声明（**经验推断** —— 肿瘤登记字段在院内无权威资产可依）：
 * - 分期的受控编码沿用临床通用的期别写法（I / II / III / IIIA…）。**不涉及任何
 *   院内编码位数、目录结构或量限数字** —— 那些本轮一律没有资产可依，不许编。
 * - 治疗方案的受控编码取**治疗意图类目**（术后辅助化疗 / 新辅助化疗 / 姑息治疗…），
 *   同样是类目名而非院内编码。
 * - 不可归并的写法一律 expectedCode = null：它们要么是开放类目（「晚期」），
 *   要么带登记员自己的判断（「IIIB?」），归并层遇到只能标「需人工判定」，不许猜。
 *
 * 四类 kind 的含义：
 * - 受控编码：原样就是受控编码（精确命中）
 * - 书写变体：同一编码的不同写法（罗马数字 / 全半角 / 空格 / 带「期」字）
 * - 同义写法：不同表述、同一编码（需要语义判断，模型兜底主要吃这一类）
 * - 不可归并：归并层应标「需人工判定」并留空
 */
export type CorpusField = '分期' | '治疗方案';

export type CorpusKind = '受控编码' | '书写变体' | '同义写法' | '不可归并';

export interface CorpusEntry {
  /** 口径字段名（与列映射配置里的 field 一致） */
  field: CorpusField;
  /** 登记员在表里写的原文 */
  raw: string;
  /** 写法类别 */
  kind: CorpusKind;
  /** 期望归并到的受控编码；不可归并时为 null */
  expectedCode: string | null;
  /** 归并依据说明 */
  note: string;
}

/** 各字段的受控编码全集。 */
export const CONTROLLED_CODES: Record<CorpusField, readonly string[]> = {
  分期: ['I', 'II', 'III', 'IIIA', 'IIIB', 'IIIC', 'IV', 'IVA', 'IVB', 'IVC'],
  治疗方案: [
    '术后辅助化疗',
    '新辅助化疗',
    '姑息治疗',
    '根治术',
    '免疫治疗',
    '放疗',
    '靶向治疗',
    '化疗',
  ],
};

/** 语料全集（分期 41 条 + 治疗方案 25 条）。 */
export const CORPUS: readonly CorpusEntry[] = [
  /* ---------------- 分期 ---------------- */
  { field: '分期', raw: 'I', kind: '受控编码', expectedCode: 'I', note: '原样即受控编码' },
  { field: '分期', raw: 'Ⅰ', kind: '书写变体', expectedCode: 'I', note: '罗马数字写法' },
  { field: '分期', raw: 'I期', kind: '书写变体', expectedCode: 'I', note: '带「期」字' },
  { field: '分期', raw: 'Ⅰ期', kind: '书写变体', expectedCode: 'I', note: '罗马数字 + 「期」字' },
  { field: '分期', raw: 'II', kind: '受控编码', expectedCode: 'II', note: '原样即受控编码' },
  { field: '分期', raw: 'Ⅱ', kind: '书写变体', expectedCode: 'II', note: '罗马数字写法' },
  { field: '分期', raw: 'II期', kind: '书写变体', expectedCode: 'II', note: '带「期」字' },
  { field: '分期', raw: 'Ⅱ期', kind: '书写变体', expectedCode: 'II', note: '罗马数字 + 「期」字' },
  { field: '分期', raw: 'III', kind: '受控编码', expectedCode: 'III', note: '原样即受控编码' },
  { field: '分期', raw: 'Ⅲ', kind: '书写变体', expectedCode: 'III', note: '罗马数字写法' },
  { field: '分期', raw: 'III期', kind: '书写变体', expectedCode: 'III', note: '带「期」字' },
  { field: '分期', raw: 'Ⅲ期', kind: '书写变体', expectedCode: 'III', note: '罗马数字 + 「期」字' },
  { field: '分期', raw: 'IIIA', kind: '受控编码', expectedCode: 'IIIA', note: '原样即受控编码' },
  { field: '分期', raw: 'ⅢA', kind: '书写变体', expectedCode: 'IIIA', note: '罗马数字写法' },
  { field: '分期', raw: 'III A', kind: '书写变体', expectedCode: 'IIIA', note: '中间带空格' },
  { field: '分期', raw: 'IIIA期', kind: '书写变体', expectedCode: 'IIIA', note: '带「期」字' },
  { field: '分期', raw: 'ⅢＡ', kind: '书写变体', expectedCode: 'IIIA', note: '全角字母' },
  { field: '分期', raw: 'IIIB', kind: '受控编码', expectedCode: 'IIIB', note: '原样即受控编码' },
  { field: '分期', raw: 'ⅢB', kind: '书写变体', expectedCode: 'IIIB', note: '罗马数字写法' },
  { field: '分期', raw: 'III B', kind: '书写变体', expectedCode: 'IIIB', note: '中间带空格' },
  { field: '分期', raw: 'IIIB期', kind: '书写变体', expectedCode: 'IIIB', note: '带「期」字' },
  { field: '分期', raw: 'ⅢＢ', kind: '书写变体', expectedCode: 'IIIB', note: '全角字母' },
  { field: '分期', raw: 'III B 期', kind: '书写变体', expectedCode: 'IIIB', note: '前后带空格' },
  { field: '分期', raw: 'IIIC', kind: '受控编码', expectedCode: 'IIIC', note: '原样即受控编码' },
  { field: '分期', raw: 'ⅢC', kind: '书写变体', expectedCode: 'IIIC', note: '罗马数字写法' },
  { field: '分期', raw: 'III C', kind: '书写变体', expectedCode: 'IIIC', note: '中间带空格' },
  { field: '分期', raw: 'IV', kind: '受控编码', expectedCode: 'IV', note: '原样即受控编码' },
  { field: '分期', raw: 'Ⅳ', kind: '书写变体', expectedCode: 'IV', note: '罗马数字写法' },
  { field: '分期', raw: 'IV期', kind: '书写变体', expectedCode: 'IV', note: '带「期」字' },
  { field: '分期', raw: 'Ⅳ期', kind: '书写变体', expectedCode: 'IV', note: '罗马数字 + 「期」字' },
  { field: '分期', raw: 'IVA', kind: '受控编码', expectedCode: 'IVA', note: '原样即受控编码' },
  { field: '分期', raw: 'ⅣA', kind: '书写变体', expectedCode: 'IVA', note: '罗马数字写法' },
  { field: '分期', raw: 'IV B', kind: '书写变体', expectedCode: 'IVB', note: '中间带空格' },
  { field: '分期', raw: 'ⅣB', kind: '书写变体', expectedCode: 'IVB', note: '罗马数字写法' },
  { field: '分期', raw: 'IVC', kind: '受控编码', expectedCode: 'IVC', note: '原样即受控编码' },
  { field: '分期', raw: 'ⅣＣ', kind: '书写变体', expectedCode: 'IVC', note: '罗马数字 + 全角字母' },
  { field: '分期', raw: '晚期', kind: '不可归并', expectedCode: null, note: '开放类目，未落到期别' },
  { field: '分期', raw: '进展期', kind: '不可归并', expectedCode: null, note: '开放类目，未落到期别' },
  { field: '分期', raw: '不明确', kind: '不可归并', expectedCode: null, note: '登记员未确定，需人工判定' },
  { field: '分期', raw: '待定', kind: '不可归并', expectedCode: null, note: '登记员未确定，需人工判定' },
  { field: '分期', raw: '复发未分期', kind: '不可归并', expectedCode: null, note: '含复发信息但无期别' },
  { field: '分期', raw: 'IIIB?', kind: '不可归并', expectedCode: null, note: '带问号，登记员存疑' },

  /* ---------------- 治疗方案 ---------------- */
  { field: '治疗方案', raw: '术后辅助化疗', kind: '受控编码', expectedCode: '术后辅助化疗', note: '原样即受控编码' },
  { field: '治疗方案', raw: '术后化疗', kind: '同义写法', expectedCode: '术后辅助化疗', note: '省略「辅助」' },
  { field: '治疗方案', raw: '辅助化疗', kind: '同义写法', expectedCode: '术后辅助化疗', note: '省略「术后」' },
  { field: '治疗方案', raw: '术后辅助化学治疗', kind: '同义写法', expectedCode: '术后辅助化疗', note: '「化学治疗」=「化疗」' },
  { field: '治疗方案', raw: '术后 化疗', kind: '书写变体', expectedCode: '术后辅助化疗', note: '中间带空格' },
  { field: '治疗方案', raw: '新辅助化疗', kind: '受控编码', expectedCode: '新辅助化疗', note: '原样即受控编码' },
  { field: '治疗方案', raw: '术前化疗', kind: '同义写法', expectedCode: '新辅助化疗', note: '「术前」=「新辅助」' },
  { field: '治疗方案', raw: '新辅助化学治疗', kind: '同义写法', expectedCode: '新辅助化疗', note: '「化学治疗」=「化疗」' },
  { field: '治疗方案', raw: '姑息治疗', kind: '受控编码', expectedCode: '姑息治疗', note: '原样即受控编码' },
  { field: '治疗方案', raw: '姑息化疗', kind: '同义写法', expectedCode: '姑息治疗', note: '姑息意图下的化疗' },
  { field: '治疗方案', raw: '姑息性治疗', kind: '同义写法', expectedCode: '姑息治疗', note: '省略「性」' },
  { field: '治疗方案', raw: '根治术', kind: '受控编码', expectedCode: '根治术', note: '原样即受控编码' },
  { field: '治疗方案', raw: '根治性手术', kind: '同义写法', expectedCode: '根治术', note: '「根治性手术」=「根治术」' },
  { field: '治疗方案', raw: '根治性切除术', kind: '同义写法', expectedCode: '根治术', note: '「根治性切除术」=「根治术」' },
  { field: '治疗方案', raw: '免疫治疗', kind: '受控编码', expectedCode: '免疫治疗', note: '原样即受控编码' },
  { field: '治疗方案', raw: '免疫检查点抑制剂治疗', kind: '同义写法', expectedCode: '免疫治疗', note: '免疫检查点抑制剂属免疫治疗' },
  { field: '治疗方案', raw: '放疗', kind: '受控编码', expectedCode: '放疗', note: '原样即受控编码' },
  { field: '治疗方案', raw: '放射治疗', kind: '同义写法', expectedCode: '放疗', note: '「放射治疗」=「放疗」' },
  { field: '治疗方案', raw: '靶向治疗', kind: '受控编码', expectedCode: '靶向治疗', note: '原样即受控编码' },
  { field: '治疗方案', raw: '分子靶向治疗', kind: '同义写法', expectedCode: '靶向治疗', note: '「分子靶向治疗」=「靶向治疗」' },
  { field: '治疗方案', raw: '化疗', kind: '受控编码', expectedCode: '化疗', note: '原样即受控编码' },
  { field: '治疗方案', raw: '姑息对症', kind: '不可归并', expectedCode: null, note: '支持治疗意图，非治疗方案类目' },
  { field: '治疗方案', raw: 'MDT讨论后定', kind: '不可归并', expectedCode: null, note: '尚未确定方案' },
  { field: '治疗方案', raw: '个体化方案', kind: '不可归并', expectedCode: null, note: '开放表述，需人工判定' },
  { field: '治疗方案', raw: '待MDT', kind: '不可归并', expectedCode: null, note: '尚未确定方案' },
];

/** 取某个字段的语料条目。 */
export function corpusOf(field: CorpusField): CorpusEntry[] {
  return CORPUS.filter((entry) => entry.field === field);
}

/**
 * 按原文查期望归并结果。
 *
 * 查不到即视为「不可归并」：语料是**期望基准**，不在表内的写法一律没有期望编码，
 * 归并层遇到它们应标「需人工判定」，不许猜。
 */
export function lookupExpectedCode(field: CorpusField, raw: string): string | null {
  const trimmed = raw.trim();
  const hit = CORPUS.find((entry) => entry.field === field && entry.raw === trimmed);
  return hit === undefined ? null : hit.expectedCode;
}

/** 该原文在语料里是否属于「不可归并」类。 */
export function isUnmergeable(field: CorpusField, raw: string): boolean {
  const trimmed = raw.trim();
  const hit = CORPUS.find((entry) => entry.field === field && entry.raw === trimmed);
  return hit !== undefined && hit.expectedCode === null;
}
