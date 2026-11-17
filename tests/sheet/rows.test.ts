import { describe, expect, it } from 'vitest';

import { parseColumnMapping } from '../../src/sheet/index.js';
import { buildRows } from '../../src/sheet/rows.js';

const MAPPING = parseColumnMapping({
  version: '0.1.0',
  registryIdColumn: '登记号',
  columns: [
    {
      field: '分期',
      sourceColumn: '分期',
      description: '登记员填写的分期自由写法',
      humanSupplied: false,
      required: false,
      controlledCode: true,
    },
    {
      field: '随访电话',
      sourceColumn: '随访电话',
      description: '登记员人工补充的随访电话',
      humanSupplied: true,
      required: false,
      controlledCode: false,
    },
    {
      field: '生活方式备注',
      sourceColumn: '生活方式备注',
      description: '登记员人工补充的生活方式备注',
      humanSupplied: true,
      required: false,
      controlledCode: false,
    },
  ],
});

const HEADER = ['登记号', '分期', '随访电话', '生活方式备注'];

describe('行规范化与脏行处理', () => {
  it('行号从 2 起（表头是第 1 行），登记号被提出来', () => {
    const { rows } = buildRows({
      header: HEADER,
      rows: [['REG-0001', 'ⅢB', '138****0001', '吸烟史']],
      mapping: MAPPING,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.rowNumber).toBe(2);
    expect(rows[0]?.registryId).toBe('REG-0001');
    expect(rows[0]?.cells['分期']?.value).toBe('ⅢB');
    expect(rows[0]?.blocked).toBe(false);
  });

  it('人工补充列打上标记，且原值保留', () => {
    const { rows } = buildRows({
      header: HEADER,
      rows: [['REG-0001', 'ⅢB', '138****0001', '吸烟史']],
      mapping: MAPPING,
    });

    expect(rows[0]?.humanSuppliedColumns).toEqual(['随访电话', '生活方式备注']);
    expect(rows[0]?.rawByColumn['随访电话']).toBe('138****0001');
    expect(rows[0]?.cells['随访电话']?.value).toBe('138****0001');
  });

  it('空行被跳过并计数，不进数据行', () => {
    const { rows, stats } = buildRows({
      header: HEADER,
      rows: [['', '', '', ''], ['REG-0001', 'ⅢB', '138****0001', '吸烟史']],
      mapping: MAPPING,
    });

    expect(rows).toHaveLength(1);
    expect(stats.skippedEmpty).toBe(1);
    expect(stats.total).toBe(2);
  });

  it('缺登记号：给行级错误码并阻断该行', () => {
    const { rows, issues } = buildRows({
      header: HEADER,
      rows: [['', 'ⅢB', '138****0001', '吸烟史']],
      mapping: MAPPING,
    });

    expect(rows[0]?.registryId).toBeNull();
    expect(rows[0]?.blocked).toBe(true);
    expect(issues[0]?.code).toBe('MISSING_REGISTRY_ID');
    expect(issues[0]?.hint).toContain('登记号');
  });

  it('重复登记号：所有相关行都标歧义并阻断', () => {
    const { rows, issues, stats } = buildRows({
      header: HEADER,
      rows: [
        ['REG-0001', 'ⅢB', '138****0001', ''],
        ['REG-0001', 'II', '138****0002', ''],
      ],
      mapping: MAPPING,
    });

    expect(rows.every((row) => row.duplicate)).toBe(true);
    expect(rows.every((row) => row.blocked)).toBe(true);
    expect(stats.duplicate).toBe(2);
    expect(issues.filter((issue) => issue.code === 'DUPLICATE_REGISTRY_ID')).toHaveLength(2);
    expect(issues[0]?.reason).toContain('出现 2 次');
  });

  it('列数不符：行保留但阻断，错误码指名列数', () => {
    const { rows, issues } = buildRows({
      header: HEADER,
      rows: [['REG-0001', 'ⅢB', '138****0001']],
      mapping: MAPPING,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.blocked).toBe(true);
    expect(issues[0]?.code).toBe('COLUMN_COUNT_MISMATCH');
    expect(issues[0]?.reason).toContain('3 个单元格');
    expect(issues[0]?.reason).toContain('4 列');
  });

  it('任何脏行都不被丢弃：行数与读入的非空行数一致', () => {
    const { rows, stats } = buildRows({
      header: HEADER,
      rows: [
        ['REG-0001', 'ⅢB', '138****0001', ''],
        ['', 'II', '138****0002', ''],
        ['REG-0003', 'II', '138****0003', ''],
        ['REG-0003', 'II', '138****0004', ''],
        ['REG-0005', 'IV', '138****0005'],
      ],
      mapping: MAPPING,
    });

    expect(rows).toHaveLength(5);
    expect(stats.total).toBe(5);
    expect(stats.blocked).toBe(4);
    expect(stats.usable).toBe(1);
  });

  it('配置里没有的列不参与比对，也不进 rawByColumn', () => {
    const { rows } = buildRows({
      header: [...HEADER, '科室'],
      rows: [['REG-0001', 'ⅢB', '138****0001', '吸烟史', '肿瘤科']],
      mapping: MAPPING,
    });

    expect(rows[0]?.rawByColumn['科室']).toBeUndefined();
    expect(Object.keys(rows[0]?.cells ?? {})).toEqual(['分期', '随访电话', '生活方式备注']);
  });
});
