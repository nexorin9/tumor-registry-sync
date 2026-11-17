import { describe, expect, it } from 'vitest';

import type { AlignRowResult, MissingRow, ReceiptBlock } from '../../src/contract/index.js';

import {
  appendTailBlocks,
  buildWritebackResult,
  protectHumanSuppliedColumns,
} from '../../src/sheet/writeback.js';

function alignRow(over: Partial<AlignRowResult>): AlignRowResult {
  return {
    rowNumber: 1,
    registryId: 'R1',
    status: '差异',
    binding: '命中',
    hospitalValues: { 分期: 'III' },
    operations: [{ op: 'replace', path: '分期', oldValue: 'II', newValue: 'III' }],
    diffText: '分期：II → III',
    suggestedText: 'III',
    confirmValue: '待确认',
    aiNote: '院内记录为 III',
    humanSuppliedColumns: ['随访电话'],
    ...over,
  };
}

const originalHeader = ['登记号', '姓名', '分期'];
const originalRows: (string | number | boolean | null)[][] = [
  ['R1', '张三', 'II'],
  ['R2', '李四', 'I'],
];

describe('buildWritebackResult · 表头与列序', () => {
  it('表头 = 原表列 + 五列追加列', () => {
    const result = buildWritebackResult(originalHeader, originalRows, [alignRow({}), alignRow({})]);
    expect(result.header).toEqual([
      '登记号',
      '姓名',
      '分期',
      '院内值',
      '差异',
      '建议值',
      '确认',
      'AI说明',
    ]);
  });
});

describe('buildWritebackResult · 原表不被改动', () => {
  it('原表表头与单元格逐格保持不变（新数组，未 mutate）', () => {
    const headerCopy = [...originalHeader];
    const rowsCopy = originalRows.map((r) => [...r]);
    buildWritebackResult(originalHeader, originalRows, [alignRow({}), alignRow({})]);
    expect(originalHeader).toEqual(headerCopy);
    expect(originalRows).toEqual(rowsCopy);
  });
});

describe('buildWritebackResult · 追加列内容', () => {
  it('每行追加五列被正确填充', () => {
    const alignRows = [
      alignRow({ hospitalValues: { 分期: 'III' }, diffText: '分期：II → III', suggestedText: 'III', confirmValue: '采纳', aiNote: '说明A' }),
      alignRow({ hospitalValues: {}, diffText: '', suggestedText: '', confirmValue: '无需确认', aiNote: '' }),
    ];
    const result = buildWritebackResult(originalHeader, originalRows, alignRows);
    expect(result.rows).toHaveLength(2);

    // 第 1 行（原表 3 列 + 追加 5 列）；院内值按值拼接（不含字段名）
    expect(result.rows[0]!.slice(0, 3)).toEqual(['R1', '张三', 'II']);
    expect(result.rows[0]!.slice(3)).toEqual(['III', '分期：II → III', 'III', '采纳', '说明A']);
    // 第 2 行：院内值拼接空值后为空串
    expect(result.rows[1]!.slice(0, 3)).toEqual(['R2', '李四', 'I']);
    expect(result.rows[1]!.slice(3)).toEqual(['', '', '', '无需确认', '']);
  });
});

describe('buildWritebackResult · 差异列底色', () => {
  it('仅差异列下标出现底色，且无差异行不上色', () => {
    const alignRows = [
      alignRow({ status: '差异', operations: [{ op: 'replace', path: '分期', oldValue: 'II', newValue: 'III' }] }),
      alignRow({ status: '一致', operations: [] }),
    ];
    const result = buildWritebackResult(originalHeader, originalRows, alignRows);
    // 只有第 1 行（有差异）有填充，且 colIndex 等于差异列下标（3）
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]!.rowIndex).toBe(0);
    expect(result.fills[0]!.colIndex).toBe(4);
  });

  it('原表列（colIndex < 3）永不上底色', () => {
    const result = buildWritebackResult(originalHeader, originalRows, [alignRow({}), alignRow({})]);
    for (const f of result.fills) {
      expect(f.colIndex).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('appendTailBlocks', () => {
  const receipt: ReceiptBlock = {
    batchKey: 'BK-001',
    searchParams: 'q',
    pushedAt: '2026-11-08T10:00:00Z',
    counts: {
      total: 2,
      matched: 2,
      ambiguous: 0,
      noMatch: 0,
      diffRows: 1,
      pendingConfirm: 1,
      adopted: 0,
      pushed: 1,
      failed: 0,
      pendingRetry: 0,
      missingRows: 1,
      issueRows: 0,
      missingCheckIncomplete: false,
    },
    details: [
      { rowNumber: 1, registryId: 'R1', status: '已推送', code: null, reason: null, idempotencyKey: 'k1', attempts: 1, pushedAt: '2026-11-08T10:00:00Z' },
    ],
  };
  const missingRows: MissingRow[] = [
    { registryId: 'R9', source: '院内检索命中，本表无此登记号', status: '零命中', confirmValue: '待确认' },
  ];

  it('表尾追加回执区与缺行区（不在正文里）', () => {
    const body = buildWritebackResult(originalHeader, originalRows, [alignRow({}), alignRow({})]);
    const withTail = appendTailBlocks(body.rows, receipt, missingRows);

    // 正文行数不变
    expect(withTail.slice(0, body.rows.length)).toEqual(body.rows);
    // 表尾确实追加了内容
    expect(withTail.length).toBeGreaterThan(body.rows.length);

    const flat = withTail.map((r) => r.join('|'));
    // 回执区标题在表尾
    expect(flat.some((line) => line.includes('推送回执'))).toBe(true);
    // 缺行区标题在表尾，且晚于回执区
    const receiptIdx = flat.findIndex((line) => line.includes('推送回执'));
    const missingIdx = flat.findIndex((line) => line.includes('院内命中但本表缺行'));
    expect(receiptIdx).toBeGreaterThanOrEqual(0);
    expect(missingIdx).toBeGreaterThan(receiptIdx);
    // 缺行明细含登记号 / 来源 / 确认
    expect(flat.some((line) => line.includes('R9') && line.includes('院内检索命中，本表无此登记号') && line.includes('待确认'))).toBe(true);
  });

  it('缺行只追加、不插入正文（正文首行仍是原表数据）', () => {
    const body = buildWritebackResult(originalHeader, originalRows, [alignRow({}), alignRow({})]);
    const withTail = appendTailBlocks(body.rows, receipt, missingRows);
    expect(withTail[0]).toEqual(body.rows[0]);
  });
});

describe('protectHumanSuppliedColumns', () => {
  it('人工补充列都在表头 → unchanged:true', () => {
    expect(
      protectHumanSuppliedColumns(originalRows, ['随访电话'], ['登记号', '姓名', '随访电话']),
    ).toEqual({ unchanged: true });
  });

  it('有人工补充列不在表头 → 检测为未保护（unchanged:false）', () => {
    // 故意让声明的人工补充列不在表头里（模拟会丢失/被覆盖的场景）
    expect(
      protectHumanSuppliedColumns(originalRows, ['随访电话'], ['登记号', '姓名', '分期']),
    ).toEqual({ unchanged: false });
  });

  it('数据行人工补充列缺失 → 检测为未保护', () => {
    const rowsWithGap: (string | number | boolean | null)[][] = [['R1', '张三']]; // 缺随访电话列
    expect(
      protectHumanSuppliedColumns(rowsWithGap, ['随访电话'], ['登记号', '姓名', '随访电话']),
    ).toEqual({ unchanged: false });
  });
});
