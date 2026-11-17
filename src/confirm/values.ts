/**
 * 确认列取值解析：把表格里读到的原始值规整成白名单 ConfirmValue。
 * 别名不生效（如「采用」「确认」一律报未知取值），空值按「待确认」处理。
 */
import type { ConfirmValue } from '../contract/index.js';

/** 确认列取值白名单（与契约 CONFIRM_VALUES 一致）。 */
export const CONFIRM_VALUES: ConfirmValue[] = ['待确认', '采纳', '不采纳', '无需确认'];

/** 解析结果：成功携带规整后的值，失败携带错误码与原始串。 */
export type ParsedConfirmValue =
  | { ok: true; value: ConfirmValue }
  | { ok: false; code: 'UNKNOWN_CONFIRM_VALUE'; raw: string; allowed: ConfirmValue[] };

/** 规整原始串：去首尾空白、全角空格(U+3000)→普通空格、折叠内部连续空白。 */
function normalize(raw: string): string {
  return raw
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 解析任意原始确认值。 */
export function parseConfirmValue(raw: unknown): ParsedConfirmValue {
  if (raw === null || raw === undefined) {
    return { ok: true, value: '待确认' };
  }
  const rawStr = typeof raw === 'string' ? raw : String(raw);
  const normalized = normalize(rawStr);

  if (normalized.length === 0) {
    return { ok: true, value: '待确认' };
  }
  if ((CONFIRM_VALUES as string[]).includes(normalized)) {
    return { ok: true, value: normalized as ConfirmValue };
  }
  return {
    ok: false,
    code: 'UNKNOWN_CONFIRM_VALUE',
    raw: rawStr,
    allowed: CONFIRM_VALUES,
  };
}

/** 类型谓词：判定字符串是否为已知 ConfirmValue。 */
export function isKnownConfirmValue(v: string): v is ConfirmValue {
  return (CONFIRM_VALUES as string[]).includes(v);
}
