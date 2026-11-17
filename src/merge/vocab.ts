import {
  normalizeTermKey,
  buildVocabIndex,
  type ControlledTerm,
  type VocabIndex,
} from './vocab-index.js';
import { TIER_SCORE } from './confidence.js';

/**
 * 默认肿瘤分期受控词表（经验推断）。
 *
 * 设计要点：ⅢB / IIIB / III B / IIIB期 全部归一为同一受控编码 'IIIB'。
 * 为避免别名与自身 code 产生索引冲突，别名里不再重复放与 code 归一后相同的写法，
 * 但 'ⅢB'（全角罗马数字）与 'III B'（带空格）等写法会与 code 共享归一键——这是
 * 「同一术语内部」的重合，buildVocabIndex 允许（不跨术语即可）。
 */
const STAGE_CODES = ['IA', 'IB', 'IIA', 'IIB', 'IIIA', 'IIIB', 'IVA', 'IVB'] as const;

function buildDefaultTerms(): ControlledTerm[] {
  return STAGE_CODES.map((code) => {
    const aliases: string[] = [];
    // 全角罗马数字写法（如 ⅢB）
    const romanFullwidth = code
      .replace(/I/g, 'Ⅰ')
      .replace(/V/g, 'Ⅴ')
      .replace(/X/g, 'Ⅹ');
    aliases.push(romanFullwidth);
    // 带空格写法（如 III B）
    const spaced = code.replace(/([A-Z])(\d)/g, '$1 $2').replace(/(\d)([A-Z])/g, '$1 $2');
    if (spaced !== code) aliases.push(spaced);
    // 带「期」后缀的写法
    aliases.push(`${code}期`);
    // 全小写
    aliases.push(code.toLowerCase());

    return {
      code,
      label: `${code}期`,
      aliases,
      caliber: '肿瘤分期受控编码（经验推断）',
      source: '经验推断',
    };
  });
}

export const DEFAULT_STAGING_VOCAB: ControlledTerm[] = buildDefaultTerms();

/** 构建默认分期词表索引。 */
export function buildDefaultVocabIndex(): VocabIndex {
  return buildVocabIndex({ version: 'default-staging-1.0.0', terms: DEFAULT_STAGING_VOCAB });
}

/** 命中方式。 */
export type MergeMatchBy = 'exact' | 'normalized' | 'alias' | 'none';

export interface VocabMergeResult {
  code: string | null;
  confidence: number;
  reason: string;
  matchedBy: MergeMatchBy;
}

/** 仅做大小写 + 空白归一（不做全角/罗马数字归一），用于区分 exact 与 normalized。 */
function simpleNormalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '');
}

/**
 * 用词表归并单条自由文本分期。
 * - exact：仅大小写/空白差异即可命中 code
 * - normalized：经全量归一（含全角/罗马数字/后缀）命中 code
 * - alias：命中别名
 * - none：未命中
 */
export function mergeByVocab(term: string, index: VocabIndex): VocabMergeResult {
  const found = index.lookupRaw(term);
  if (found === null) {
    return { code: null, confidence: 0, reason: '未命中受控词表', matchedBy: 'none' };
  }

  const norm = normalizeTermKey(term);
  const codeNorm = normalizeTermKey(found.code);
  if (norm === codeNorm) {
    if (simpleNormalize(term) === simpleNormalize(found.code)) {
      return {
        code: found.code,
        confidence: TIER_SCORE.exact,
        reason: '受控词表精确命中',
        matchedBy: 'exact',
      };
    }
    return {
      code: found.code,
      confidence: TIER_SCORE.normalized,
      reason: '受控词表归一命中',
      matchedBy: 'normalized',
    };
  }

  return {
    code: found.code,
    confidence: TIER_SCORE.alias,
    reason: '受控词表别名命中',
    matchedBy: 'alias',
  };
}
