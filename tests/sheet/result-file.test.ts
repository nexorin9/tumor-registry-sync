import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MissingRow, ReceiptBlock, SummaryCounts } from '../../src/contract/index.js';
import {
  MISSING_BLOCK_TITLE,
  RECEIPT_BLOCK_TITLE,
  RESULT_NEW_COLUMNS,
  ResultFileError,
  buildResultTable,
  csvEscape,
  formatHospitalValues,
  newColumnsFromAlignRow,
  parseCsv,
  readSheetFile,
  writeResultFile,
  type ResultFileInput,
} from '../../src/sheet/index.js';

const HEADER = ['登记号', '分期', '治疗方案', '随访电话', '生活方式备注'];

const ORIGINAL_ROWS = [
  ['REG-0001', 'ⅢB', '术后辅助化疗', '138****0001', '吸烟史'],
  ['REG-0002', 'IIIB', '新辅助化疗', '138****0002', '吸烟, 每日10支'],
];

const NEW_COLUMNS = [
  {
    hospitalValue: '分期=M8500/3；治疗方案=术后辅助化疗',
    diff: '分期：ⅢB → M8500/3（修改）',
    suggested: 'M8500/3',
    confirm: '待确认',
    aiNote: '',
  },
  {
    hospitalValue: '分期=M8500/3',
    diff: '分期：IIIB → M8500/3（修改）',
    suggested: 'M8500/3',
    confirm: '待确认',
    aiNote: '写法归并后等价，建议统一为受控编码 M8500/3',
  },
];

function counts(overrides: Partial<SummaryCounts> = {}): SummaryCounts {
  return {
    total: 2,
    matched: 2,
    ambiguous: 0,
    noMatch: 0,
    diffRows: 2,
    pendingConfirm: 2,
    adopted: 0,
    pushed: 0,
    failed: 0,
    pendingRetry: 0,
    missingRows: 1,
    issueRows: 0,
    missingCheckIncomplete: false,
    ...overrides,
  };
}

function receipt(overrides: Partial<ReceiptBlock> = {}): ReceiptBlock {
  return {
    batchKey: 'batch-2026-11-08-abc123',
    searchParams: 'identifier=REG-0001|REG-0002',
    pushedAt: '2026-11-08T10:12:00+08:00',
    counts: counts(),
    details: [
      {
        rowNumber: 2,
        registryId: 'REG-0001',
        status: '已推送',
        code: null,
        reason: null,
        idempotencyKey: 'idem-0001',
        attempts: 1,
        pushedAt: '2026-11-08T10:12:00+08:00',
      },
      {
        rowNumber: 3,
        registryId: 'REG-0002',
        status: '推送失败',
        code: 'server_error',
        reason: '专病库返回 500，稍后重试',
        idempotencyKey: 'idem-0002',
        attempts: 3,
        pushedAt: null,
      },
    ],
    ...overrides,
  };
}

const MISSING_ROWS: MissingRow[] = [
  {
    registryId: 'REG-0009',
    source: '院内检索命中，本表无此登记号',
    status: '待确认',
    confirmValue: '待确认',
  },
];

function makeInput(overrides: Partial<ResultFileInput> = {}): ResultFileInput {
  return {
    header: [...HEADER],
    originalRows: ORIGINAL_ROWS.map((row) => [...row]),
    newColumns: NEW_COLUMNS.map((column) => ({ ...column })),
    receipt: receipt(),
    missingRows: [...MISSING_ROWS],
    humanSuppliedColumns: ['随访电话', '生活方式备注'],
    ...overrides,
  };
}

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), 'tumor-result-file-'));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('结果表文件落盘', () => {
  it('列序固定：原表列原样在前，五列新列追加在后', () => {
    const built = buildResultTable(makeInput());

    const header = built.header;
    expect(header.slice(0, HEADER.length)).toEqual(HEADER);
    expect(header.slice(HEADER.length)).toEqual([...RESULT_NEW_COLUMNS]);
    expect(header).toEqual([
      '登记号',
      '分期',
      '治疗方案',
      '随访电话',
      '生活方式备注',
      '院内值',
      '差异',
      '建议值',
      '确认',
      'AI 说明',
    ]);
    expect(built.columnCount).toBe(HEADER.length + 5);
  });

  it('正文每行都是表宽那么长，新列取值落在正确列位', () => {
    const built = buildResultTable(makeInput());
    const rows = parseCsv(built.text);

    expect(rows[0]).toEqual([...HEADER, ...RESULT_NEW_COLUMNS]);
    for (const row of rows) {
      expect(row).toHaveLength(built.columnCount);
    }

    const first = rows[1] as string[];
    expect(first[0]).toBe('REG-0001');
    expect(first[5]).toBe('分期=M8500/3；治疗方案=术后辅助化疗');
    expect(first[6]).toBe('分期：ⅢB → M8500/3（修改）');
    expect(first[7]).toBe('M8500/3');
    expect(first[8]).toBe('待确认');
    expect(first[9]).toBe('');
  });

  it('原表列逐行与输入完全一致，人工补充列字节不变', () => {
    const input = makeInput();
    const built = buildResultTable(input);
    const rows = parseCsv(built.text);

    input.originalRows.forEach((original, index) => {
      const actual = rows[index + 1] as string[];
      original.forEach((cell, column) => {
        expect(actual[column]).toBe(cell);
      });
    });

    // 人工补充列（随访电话、生活方式备注）必须逐字节不变
    const phoneIndex = HEADER.indexOf('随访电话');
    const noteIndex = HEADER.indexOf('生活方式备注');
    expect((rows[1] as string[])[phoneIndex]).toBe('138****0001');
    expect((rows[1] as string[])[noteIndex]).toBe('吸烟史');
    expect((rows[2] as string[])[noteIndex]).toBe('吸烟, 每日10支');
  });

  it('含逗号的单元格被正确转义，不串列', () => {
    const built = buildResultTable(makeInput());
    const rows = parseCsv(built.text);

    expect((rows[2] as string[])[4]).toBe('吸烟, 每日10支');
    expect((rows[2] as string[])[0]).toBe('REG-0002');
    expect(csvEscape('含"引号"')).toBe('"含""引号"""');
    expect(csvEscape('普通')).toBe('普通');
  });

  it('表尾两个区块版式固定：标题行 + 计数行 + 明细行', () => {
    const built = buildResultTable(makeInput());
    const rows = parseCsv(built.text);

    const receiptTitle = rows[3] as string[];
    expect(receiptTitle[0]).toBe(RECEIPT_BLOCK_TITLE);
    expect(receiptTitle[1]).toContain('明细字段');

    const receiptCount = rows[4] as string[];
    expect(receiptCount[0]).toContain('批次键=batch-2026-11-08-abc123');
    expect(receiptCount[0]).toContain('推送时刻=2026-11-08T10:12:00+08:00');
    expect(receiptCount[0]).toContain('已推送=0');
    expect(receiptCount[0]).toContain('缺行=1');

    const detail1 = rows[5] as string[];
    expect(detail1[0]).toBe('REG-0001');
    expect(detail1[1]).toBe('2');
    expect(detail1[2]).toBe('已推送');
    expect(detail1[4]).toBe('idem-0001');
    expect(detail1[6]).toBe('2026-11-08T10:12:00+08:00');

    const detail2 = rows[6] as string[];
    expect(detail2[0]).toBe('REG-0002');
    expect(detail2[2]).toBe('推送失败');
    expect(detail2[3]).toBe('专病库返回 500，稍后重试');

    const missingTitle = rows[7] as string[];
    expect(missingTitle[0]).toBe(MISSING_BLOCK_TITLE);

    const missingCount = rows[8] as string[];
    expect(missingCount[0]).toContain('缺行=1');
    expect(missingCount[0]).toContain('不自动入表');

    const missingDetail = rows[9] as string[];
    expect(missingDetail[0]).toBe('REG-0009');
    expect(missingDetail[1]).toBe('院内检索命中，本表无此登记号');
    expect(missingDetail[2]).toBe('待确认');
    expect(missingDetail[3]).toBe('待确认');
  });

  it('缺行只追加到表尾，不插入正文', () => {
    const input = makeInput();
    const built = buildResultTable(input);
    const rows = parseCsv(built.text);

    expect(built.bodyRows).toBe(input.originalRows.length);
    // 正文行只有原表那两行，缺行的登记号不在正文里
    expect(rows).toHaveLength(1 + input.originalRows.length + built.footerLines);
    const bodyText = rows.slice(1, 1 + input.originalRows.length).map((row) => row.join(','));
    expect(bodyText.join('\n')).not.toContain('REG-0009');
    expect(bodyText.join('\n')).not.toContain(MISSING_BLOCK_TITLE);
  });

  it('写盘后原表列逐行核对通过（自检），人工补充列不变', () => {
    const input = makeInput();
    const outputPath = join(workdir, '结果表.csv');

    const result = writeResultFile(input, outputPath);

    expect(result.verification.originalColumnsMatch).toBe(true);
    expect(result.verification.humanSuppliedColumnsUnchanged).toBe(true);
    expect(result.verification.headerMatches).toBe(true);
    expect(result.verification.checkedRows).toBe(2);
    expect(result.bodyRows).toBe(2);
    expect(result.footerLines).toBe(7);
    expect(result.totalLines).toBe(10);

    const written = parseCsv(readFileSync(outputPath, 'utf8'));
    expect((written[2] as string[])[4]).toBe('吸烟, 每日10支');
  });

  it('默认 UTF-8 带 BOM、行尾 CRLF，老 Excel 双击不乱码', () => {
    const outputPath = join(workdir, '结果表.csv');
    const result = writeResultFile(makeInput(), outputPath);

    const bytes = readFileSync(outputPath);
    expect(bytes[0]).toBe(0xef);
    expect(bytes[1]).toBe(0xbb);
    expect(bytes[2]).toBe(0xbf);
    expect(result.bom).toBe(true);
    expect(result.lineEnding).toBe('crlf');

    const text = bytes.subarray(3).toString('utf8');
    expect(text).toContain('\r\n');
    expect(text.endsWith('\r\n')).toBe(true);
  });

  it('GBK 编码可选：写出的字节按 GBK 解回来与原文一致，且不带 BOM', () => {
    const outputPath = join(workdir, '结果表-gbk.csv');
    const result = writeResultFile(makeInput(), outputPath, { encoding: 'gbk' });

    expect(result.encoding).toBe('gbk');
    expect(result.bom).toBe(false);
    expect(result.unmappableCharacters).toEqual([]);

    const bytes = readFileSync(outputPath);
    expect(bytes[0]).not.toBe(0xef);
    const decoded = new TextDecoder('gbk').decode(bytes);
    expect(decoded).toContain('登记号');
    expect(decoded).toContain('【推送回执】');
    expect(decoded).toContain('ⅢB');
    expect(decoded).not.toContain('�');

    const rows = parseCsv(decoded);
    expect((rows[1] as string[])[0]).toBe('REG-0001');
    expect((rows[2] as string[])[4]).toBe('吸烟, 每日10支');
  });

  it('GBK 里无法表示的字符被替换并显式报告，不静默丢字', () => {
    const input = makeInput();
    input.originalRows[0] = ['REG-0001', 'ⅢB', '术后辅助化疗🙂', '138****0001', '吸烟史'];
    const outputPath = join(workdir, '结果表-gbk-emoji.csv');

    const result = writeResultFile(input, outputPath, { encoding: 'gbk' });

    expect(result.unmappableCharacters).toEqual(['🙂']);
    const decoded = new TextDecoder('gbk').decode(readFileSync(outputPath));
    expect(decoded).toContain('术后辅助化疗?');
  });

  it('原子写：写失败时删掉临时文件，原结果表保持原样', () => {
    const outputPath = join(workdir, '结果表.csv');
    writeResultFile(makeInput(), outputPath);
    const original = readFileSync(outputPath);

    // 让 rename 失败：把目标换成一个非空目录
    const blocked = join(workdir, 'blocked');
    rmSync(blocked, { recursive: true, force: true });
    mkdirSync(blocked);
    writeFileSync(join(blocked, '占位'), 'x');

    expect(() => writeResultFile(makeInput(), blocked)).toThrow(ResultFileError);

    // 临时文件不留在盘上
    const leftovers = readdirSync(workdir).filter((name) => name.includes('.tmp-'));
    expect(leftovers).toEqual([]);

    // 之前写好的结果表没有被这次失败影响
    expect(readFileSync(outputPath).equals(original)).toBe(true);
  });

  it('原子写：覆盖已有结果表时内容整体替换，不留半截', () => {
    const outputPath = join(workdir, '结果表.csv');
    writeResultFile(makeInput(), outputPath);

    const second = makeInput();
    second.receipt = receipt({ batchKey: 'batch-second' });
    writeResultFile(second, outputPath);

    const text = readFileSync(outputPath, 'utf8');
    expect(text).toContain('batch-second');
    expect(text).not.toContain('batch-2026-11-08-abc123');
  });

  it('目标目录不存在时给出可读的错误，且不留临时文件', () => {
    const outputPath = join(workdir, '不存在', '结果表.csv');

    expect(() => writeResultFile(makeInput(), outputPath)).toThrow(/写出结果表失败/);
    expect(readdirSync(workdir)).toEqual([]);
  });

  it('原表行数与新列行数对不上时显式报错，不写出半张表', () => {
    const input = makeInput();
    input.newColumns = input.newColumns.slice(0, 1);
    const outputPath = join(workdir, '结果表.csv');

    expect(() => writeResultFile(input, outputPath)).toThrow(/原表行数与新列行数对不上/);
    expect(readdirSync(workdir)).toEqual([]);
  });

  it('列数超过表头宽度的行被截到表头宽度并显式报告', () => {
    const input = makeInput();
    input.originalRows[1] = ['REG-0002', 'IIIB', '新辅助化疗', '138****0002', '吸烟史', '多出来的一列'];
    const outputPath = join(workdir, '结果表.csv');

    const result = writeResultFile(input, outputPath);

    expect(result.truncatedRows).toEqual([{ rowNumber: 3, cellCount: 6 }]);
    const rows = parseCsv(readFileSync(outputPath, 'utf8'));
    expect(rows[2]).toHaveLength(result.columnCount);
    expect((rows[2] as string[])[5]).toBe('分期=M8500/3');
  });

  it('用真实登记表读进来再写出：原表内容与读表结果一致', () => {
    const sheet = readSheetFile('tests/fixtures/registry-utf8.csv');
    const input = makeInput({
      header: sheet.header,
      originalRows: sheet.rows,
      newColumns: sheet.rows.map((_, index) => ({
        hospitalValue: index === 0 ? '分期=M8500/3' : '',
        diff: index === 0 ? '分期：ⅢB → M8500/3（修改）' : '',
        suggested: index === 0 ? 'M8500/3' : '',
        confirm: '待确认',
        aiNote: '',
      })),
    });
    const outputPath = join(workdir, '结果表-真实样例.csv');

    const result = writeResultFile(input, outputPath);

    expect(result.verification.originalColumnsMatch).toBe(true);
    const rows = parseCsv(readFileSync(outputPath, 'utf8'));
    expect((rows[1] as string[])[0]).toBe(sheet.rows[0]?.[0]);
    expect((rows[1] as string[])[1]).toBe(sheet.rows[0]?.[1]);
  });

  it('院内值排版与 align 行结果取列：字段名=值，空值不占位', () => {
    expect(formatHospitalValues({ 分期: 'M8500/3', 治疗方案: null, 备注: '' })).toBe('分期=M8500/3');

    const columns = newColumnsFromAlignRow({
      rowNumber: 2,
      registryId: 'REG-0001',
      status: '待确认',
      binding: '命中',
      hospitalValues: { 分期: 'M8500/3' },
      operations: [],
      diffText: '分期：ⅢB → M8500/3（修改）',
      suggestedText: 'M8500/3',
      confirmValue: '待确认',
      aiNote: '',
      humanSuppliedColumns: ['随访电话'],
    });

    expect(columns).toEqual({
      hospitalValue: '分期=M8500/3',
      diff: '分期：ⅢB → M8500/3（修改）',
      suggested: 'M8500/3',
      confirm: '待确认',
      aiNote: '',
    });
  });
});
