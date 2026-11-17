import { describe, expect, it } from 'vitest';

import {
  decodeSheetBuffer,
  detectLineEnding,
  parseCsv,
  readSheetFile,
  readSheetText,
} from '../../src/sheet/index.js';

import {
  GBK_CSV_BASE64,
  REGISTRY_HEADER,
  SAMPLE_CSV,
  mixedUtf8GbkBuffer,
} from './fixtures.js';

describe('表格读取', () => {
  it('首行是表头，数据行不含表头', () => {
    const sheet = readSheetText(SAMPLE_CSV);

    expect(sheet.header).toEqual(REGISTRY_HEADER);
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0]?.[0]).toBe('REG-0001');
    expect(sheet.encoding).toBe('utf-8');
  });

  it('引号转义：字段里的逗号与转义引号都还原', () => {
    const rows = parseCsv('a,b\n"含,逗号","含""引号"""\n');

    expect(rows[1]?.[0]).toBe('含,逗号');
    expect(rows[1]?.[1]).toBe('含"引号"');
  });

  it('引号内的换行不拆行', () => {
    const rows = parseCsv('a,b\n"第一行\n第二行",c\n');

    expect(rows).toHaveLength(2);
    expect(rows[1]?.[0]).toBe('第一行\n第二行');
    expect(rows[1]?.[1]).toBe('c');
  });

  it('CRLF 与 LF 两种行尾都能读', () => {
    const crlf = readSheetText('登记号,分期\r\nREG-0001,ⅢB\r\n');
    const lf = readSheetText('登记号,分期\nREG-0001,ⅢB\n');

    expect(crlf.header).toEqual(['登记号', '分期']);
    expect(crlf.rows).toHaveLength(1);
    expect(crlf.lineEnding).toBe('crlf');
    expect(lf.rows).toHaveLength(1);
    expect(lf.lineEnding).toBe('lf');
  });

  it('UTF-8 BOM 被去掉，首列表头能认出来', () => {
    const withBom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(SAMPLE_CSV, 'utf8'),
    ]);

    const sheet = readSheetText(withBom);

    expect(sheet.hadBom).toBe(true);
    expect(sheet.header).toEqual(REGISTRY_HEADER);
    expect(sheet.header[0]).not.toContain('﻿');
  });

  it('GBK 登记表能正确解码，不出乱码', () => {
    const decoded = decodeSheetBuffer(Buffer.from(GBK_CSV_BASE64, 'base64'));

    expect(decoded.encoding).toBe('gbk');
    expect(decoded.text).toContain('登记号');
    expect(decoded.text).toContain('术后辅助化疗');
    expect(decoded.text).not.toContain('�');
  });

  it('UTF-8 与 GBK 混编时逐段解码，两段都对', () => {
    const sheet = readSheetText(mixedUtf8GbkBuffer());

    expect(sheet.encoding).toBe('mixed');
    expect(sheet.header).toEqual(REGISTRY_HEADER);
    expect(sheet.rows[0]?.[4]).toBe('吸烟史');
  });

  it('空行与空表头只报提示，不静默丢列', () => {
    const sheet = readSheetText('登记号,,分期\nREG-0001,x,ⅢB\n');

    expect(sheet.warnings.join('')).toContain('空列名');
    expect(sheet.header).toEqual(['登记号', '', '分期']);
  });

  it('重复表头报提示', () => {
    const sheet = readSheetText('登记号,分期,分期\nREG-0001,ⅢB,II\n');

    expect(sheet.warnings.join('')).toContain('重复列名');
  });

  it('空表给出提示而不是抛错', () => {
    const sheet = readSheetText('');

    expect(sheet.header).toEqual([]);
    expect(sheet.rows).toEqual([]);
    expect(sheet.warnings.join('')).toContain('表是空的');
  });

  it('行尾风格判定', () => {
    expect(detectLineEnding('a\r\nb\r\n')).toBe('crlf');
    expect(detectLineEnding('a\nb\n')).toBe('lf');
    expect(detectLineEnding('a\rb\r')).toBe('cr');
    expect(detectLineEnding('a\r\nb\n')).toBe('mixed');
    expect(detectLineEnding('abc')).toBe('none');
  });

  it('从文件读表：UTF-8 样例与 GBK 样例都能读出来', () => {
    const utf8 = readSheetFile('tests/fixtures/registry-utf8.csv');
    expect(utf8.header).toEqual(REGISTRY_HEADER);
    expect(utf8.encoding).toBe('utf-8');

    const gbk = readSheetFile('tests/fixtures/registry-gbk.csv');
    expect(gbk.encoding).toBe('gbk');
    expect(gbk.header).toEqual(REGISTRY_HEADER);
    expect(gbk.rows[0]?.[1]).toBe('ⅢB');
  });

  it('文件不存在时给出可读的错误', () => {
    expect(() => readSheetFile('tests/fixtures/不存在.csv')).toThrow(/读取登记表失败/);
  });
});
