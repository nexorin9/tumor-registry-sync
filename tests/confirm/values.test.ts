import { describe, expect, it } from 'vitest';
import { isKnownConfirmValue, parseConfirmValue } from '../../src/confirm/values.js';

describe('values: 空值与空白', () => {
  it('null/undefined → 待确认', () => {
    expect(parseConfirmValue(null)).toEqual({ ok: true, value: '待确认' });
    expect(parseConfirmValue(undefined)).toEqual({ ok: true, value: '待确认' });
  });

  it('空串与纯空白 → 待确认', () => {
    expect(parseConfirmValue('')).toEqual({ ok: true, value: '待确认' });
    expect(parseConfirmValue('   ')).toEqual({ ok: true, value: '待确认' });
    expect(parseConfirmValue('\t\n')).toEqual({ ok: true, value: '待确认' });
  });
});

describe('values: 空白规整', () => {
  it('首尾去空白 + 全角空格(U+3000)折叠', () => {
    expect(parseConfirmValue('  采纳  ')).toEqual({ ok: true, value: '采纳' });
    expect(parseConfirmValue(' 采纳 ')).toEqual({ ok: true, value: '采纳' });
  });

  it('内部连续空白折叠', () => {
    // 全角空格重复 → 折叠为单空格 → 不等于任何值 → 报错
    expect(parseConfirmValue('采 纳')).toEqual({
      ok: false,
      code: 'UNKNOWN_CONFIRM_VALUE',
      raw: '采 纳',
      allowed: ['待确认', '采纳', '不采纳', '无需确认'],
    });
  });
});

describe('values: 已知取值', () => {
  it('四态精确命中', () => {
    expect(parseConfirmValue('待确认')).toEqual({ ok: true, value: '待确认' });
    expect(parseConfirmValue('采纳')).toEqual({ ok: true, value: '采纳' });
    expect(parseConfirmValue('不采纳')).toEqual({ ok: true, value: '不采纳' });
    expect(parseConfirmValue('无需确认')).toEqual({ ok: true, value: '无需确认' });
  });
});

describe('values: 未知取值（别名不生效）', () => {
  it('别名/乱码 → 报错并带 allowed', () => {
    const r = parseConfirmValue('采用');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('UNKNOWN_CONFIRM_VALUE');
      expect(r.allowed).toEqual(['待确认', '采纳', '不采纳', '无需确认']);
    }
    expect(parseConfirmValue('确认').ok).toBe(false);
    expect(parseConfirmValue('garbage').ok).toBe(false);
  });
});

describe('values: isKnownConfirmValue', () => {
  it('类型谓词', () => {
    expect(isKnownConfirmValue('采纳')).toBe(true);
    expect(isKnownConfirmValue('采用')).toBe(false);
  });
});
