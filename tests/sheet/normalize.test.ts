import { describe, expect, it } from 'vitest';

import { normalizeAnyCell, normalizeCell, normalizeCellValue, toHalfWidth } from '../../src/sheet/index.js';

describe('单元格规范化', () => {
  it('去首尾空白', () => {
    expect(normalizeCellValue('  ⅢB  ')).toBe('ⅢB');
  });

  it('全角转半角：全角字母、数字与表意空格', () => {
    expect(toHalfWidth('ＡＢ１２')).toBe('AB12');
    expect(toHalfWidth('　')).toBe(' ');
    expect(normalizeCellValue('　ＲＥＧ－０００１　')).toBe('REG-0001');
  });

  it('空串与纯空白归 null', () => {
    expect(normalizeCellValue('')).toBeNull();
    expect(normalizeCellValue('   ')).toBeNull();
    expect(normalizeCellValue('　')).toBeNull();
  });

  it('原始值原样保留，供写前比对用', () => {
    const cell = normalizeCell('  ⅢB  ');

    expect(cell.raw).toBe('  ⅢB  ');
    expect(cell.value).toBe('ⅢB');
  });

  it('罗马数字写法不做归一：ⅢB 与 IIIB 是两个值', () => {
    expect(normalizeCellValue('ⅢB')).toBe('ⅢB');
    expect(normalizeCellValue('IIIB')).toBe('IIIB');
    expect(normalizeCellValue('ⅢB')).not.toBe(normalizeCellValue('IIIB'));
  });

  it('非字符串值原样保留类型', () => {
    expect(normalizeAnyCell(42).value).toBe(42);
    expect(normalizeAnyCell(true).value).toBe(true);
    expect(normalizeAnyCell(null).value).toBeNull();
    expect(normalizeAnyCell('  Ⅳ  ').value).toBe('Ⅳ');
  });
});
