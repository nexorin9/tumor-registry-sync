import { describe, expect, it } from 'vitest';

import {
  ColumnMappingError,
  loadColumnMapping,
  parseColumnMapping,
  resolveColumnMapping,
} from '../../src/sheet/index.js';

const VALID_MAPPING = {
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
  ],
};

describe('列映射配置', () => {
  it('项目自带的列映射配置能通过校验', () => {
    const mapping = loadColumnMapping('config/column-mapping.json');

    expect(mapping.registryIdColumn).toBe('登记号');
    expect(mapping.columns.map((entry) => entry.field)).toContain('分期');
    const phone = mapping.columns.find((entry) => entry.field === '随访电话');
    expect(phone?.humanSupplied).toBe(true);
  });

  it('缺口径说明的列不允许进配置', () => {
    const broken = {
      ...VALID_MAPPING,
      columns: [{ field: '分期', sourceColumn: '分期' }],
    };

    expect(() => parseColumnMapping(broken)).toThrow(ColumnMappingError);
    expect(() => parseColumnMapping(broken)).toThrow(/口径|description/);
  });

  it('同一源列声明两次时报错并点名冲突列', () => {
    const duplicated = {
      ...VALID_MAPPING,
      columns: [
        ...VALID_MAPPING.columns,
        {
          field: '分期备写',
          sourceColumn: '分期',
          description: '重复声明',
          humanSupplied: false,
          required: false,
          controlledCode: false,
        },
      ],
    };

    try {
      parseColumnMapping(duplicated);
      expect.unreachable('应当抛出 ColumnMappingError');
    } catch (error) {
      expect(error).toBeInstanceOf(ColumnMappingError);
      expect((error as ColumnMappingError).message).toContain('分期');
    }
  });

  it('配置里没有登记号列时报错', () => {
    const broken = { ...VALID_MAPPING, registryIdColumn: '' };

    expect(() => parseColumnMapping(broken)).toThrow(/registryIdColumn/);
  });

  it('登记表缺必填列时点名缺哪一列', () => {
    const mapping = parseColumnMapping({
      ...VALID_MAPPING,
      columns: [
        ...VALID_MAPPING.columns,
        {
          field: '治疗方案',
          sourceColumn: '治疗方案',
          description: '登记员填写的治疗方案',
          humanSupplied: false,
          required: true,
          controlledCode: true,
        },
      ],
    });

    try {
      resolveColumnMapping(mapping, ['登记号', '分期', '随访电话']);
      expect.unreachable('应当抛出 ColumnMappingError');
    } catch (error) {
      expect(error).toBeInstanceOf(ColumnMappingError);
      const message = (error as ColumnMappingError).message;
      expect(message).toContain('治疗方案');
      expect(message).not.toContain('分期');
    }
  });

  it('登记表缺登记号列时点名缺哪一列', () => {
    const mapping = parseColumnMapping(VALID_MAPPING);

    expect(() => resolveColumnMapping(mapping, ['分期', '随访电话'])).toThrow(/登记号/);
  });

  it('人工补充列被标出来，未声明的列进 unmapped', () => {
    const mapping = parseColumnMapping(VALID_MAPPING);
    const resolved = resolveColumnMapping(mapping, ['登记号', '分期', '随访电话', '科室']);

    expect(resolved.humanSuppliedColumns).toEqual(['随访电话']);
    expect(resolved.unmappedColumns).toEqual(['科室']);
    expect(resolved.fieldByColumn.get('分期')).toBe('分期');
  });

  it('配置里声明了但表里没有的列记入 absent，不阻断', () => {
    const mapping = parseColumnMapping({
      ...VALID_MAPPING,
      columns: [
        ...VALID_MAPPING.columns,
        {
          field: '治疗方案',
          sourceColumn: '治疗方案',
          description: '登记员填写的治疗方案',
          humanSupplied: false,
          required: false,
          controlledCode: true,
        },
      ],
    });

    const resolved = resolveColumnMapping(mapping, ['登记号', '分期', '随访电话']);

    expect(resolved.absentColumns).toEqual(['治疗方案']);
  });
});
