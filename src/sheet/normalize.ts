/**
 * 单元格规范化：把表格里读到的原始字符串变成可参与比对的值。
 *
 * 三条规矩：
 * - **原始值必须留着**：写前比对（ifMatch）要拿表里的原值跟院内当前值比，
 *   所以规范化只改「参与比对的副本」，不改原值本身。
 * - **空串归 null，显式 null 与「缺失」是两回事**：两者在差异语义里走不同操作
 *   （缺失 → remove，显式 null → replace），不能提前混成一个。
 * - **全角转半角**：WPS 里手打的「　」（表意空格）、「Ａ」这类全角字符经常混进
 *   登记号与分期，不归一就会凭空多出「差异」。
 */
import type { CellValue, FieldValue } from '../contract/index.js';

/** 规范化后的单元格：原值 + 参与比对的归一值。 */
export interface NormalizedCell {
  /** 表格里的原始字符串（未做任何加工） */
  raw: string;
  /** 归一后的值：空串归 null */
  value: FieldValue;
}

/** 全角 ASCII 区间 → 半角；表意空格 → 普通空格。 */
export function toHalfWidth(input: string): string {
  let output = '';
  for (const char of input) {
    const code = char.codePointAt(0) as number;
    if (code === 0x3000) {
      output += ' ';
    } else if (code >= 0xff01 && code <= 0xff5e) {
      output += String.fromCharCode(code - 0xfee0);
    } else {
      output += char;
    }
  }
  return output;
}

/**
 * 单元格值规范化：去首尾空白 → 全角转半角 → 再去首尾空白 → 空串归 null。
 */
export function normalizeCellValue(raw: string): FieldValue {
  const normalized = toHalfWidth(raw).trim();
  return normalized.length === 0 ? null : normalized;
}

/** 规范化一个单元格，保留原值。 */
export function normalizeCell(raw: string): NormalizedCell {
  return { raw, value: normalizeCellValue(raw) };
}

/**
 * 规范化任意来源的单元格值（宏导出的 JSON 里可能是字符串、数字、布尔或 null）。
 * 非字符串原样保留，只对字符串做规范化。
 */
export function normalizeAnyCell(raw: CellValue): NormalizedCell {
  if (typeof raw !== 'string') {
    return { raw: raw === null ? '' : String(raw), value: raw === null ? null : raw };
  }
  return normalizeCell(raw);
}
