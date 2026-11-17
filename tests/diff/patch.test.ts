import { describe, expect, it } from 'vitest';

import {
  createPatch,
  diffFields,
  diffRowAgainstRecord,
  diffValues,
  diffValuesEqual,
  matchArrayElements,
  valueKind,
  type DiffOperation,
} from '../../src/diff/index.js';
import { parseFieldSpec } from '../../src/diff/field-spec.js';

/** 只声明参与比对字段的口径表（人工补充列也在，验证它被排除）。 */
const SPEC = parseFieldSpec({
  version: '0.1.0',
  basis: '经验推断',
  note: '测试用口径表。',
  fields: [
    {
      field: '分期',
      source: '院内资源路径',
      sourceColumn: '分期',
      resourcePath: 'Condition.stage',
      description: '分期自由写法，归并到受控编码后比对',
      participatesInDiff: true,
      derived: false,
      controlledCode: true,
      humanSupplied: false,
      basis: '经验推断',
    },
    {
      field: '治疗方案',
      source: '登记列',
      sourceColumn: '治疗方案',
      resourcePath: null,
      description: '治疗方案自由写法，本轮不参与比对',
      participatesInDiff: false,
      derived: false,
      controlledCode: true,
      humanSupplied: false,
      basis: '经验推断',
    },
    {
      field: '随访电话',
      source: '登记列',
      sourceColumn: '随访电话',
      resourcePath: null,
      description: '人工补充列，只读不覆盖',
      participatesInDiff: false,
      derived: false,
      controlledCode: false,
      humanSupplied: true,
      basis: '经验推断',
    },
  ],
});

function opsOf(operations: DiffOperation[], field: string): DiffOperation[] {
  return operations.filter((operation) => operation.field === field);
}

describe('最小差异引擎 · 操作类型分流', () => {
  it('add：登记侧这一格空着、院内有值 → 建议新增', () => {
    const operations = diffValues({
      path: '分期',
      oldValue: null,
      newValue: 'IIIB',
      rawOldValue: '',
    });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe('add');
    expect(operations[0]?.changeKind).toBe('新增');
    expect(operations[0]?.oldValue).toBeNull();
    expect(operations[0]?.newValue).toBe('IIIB');
  });

  it('add：登记侧缺这一列（值缺失）→ 不参与比对，不产出「新增」', () => {
    expect(diffValues({ path: '分期', oldValue: undefined, newValue: 'IIIB' })).toEqual([]);
  });

  it('add：数组多出元素 → 元素新增', () => {
    const operations = diffValues({
      path: '过敏史',
      oldValue: ['青霉素'],
      newValue: ['青霉素', '碘造影剂'],
    });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe('add');
    expect(operations[0]?.changeKind).toBe('元素新增');
    expect(operations[0]?.detail?.addedElements).toEqual(['碘造影剂']);
  });

  it('remove：院内没有这个字段、登记侧有值 → 建议删除', () => {
    const operations = diffValues({ path: '分期', oldValue: 'III', newValue: undefined });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe('remove');
    expect(operations[0]?.changeKind).toBe('删除');
    expect(operations[0]?.oldValue).toBe('III');
    expect(operations[0]?.newValue).toBeNull();
  });

  it('remove：数组少了元素 → 元素删除', () => {
    const operations = diffValues({
      path: '过敏史',
      oldValue: ['青霉素', '碘造影剂'],
      newValue: ['青霉素'],
    });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe('remove');
    expect(operations[0]?.changeKind).toBe('元素删除');
    expect(operations[0]?.detail?.removedElements).toEqual(['碘造影剂']);
  });

  it('replace：两侧都有值但不一致 → 建议修改', () => {
    const operations = diffValues({ path: '分期', oldValue: 'I', newValue: 'IVC' });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe('replace');
    expect(operations[0]?.changeKind).toBe('值不同');
    expect(operations[0]?.oldValue).toBe('I');
    expect(operations[0]?.newValue).toBe('IVC');
  });

  it('replace：嵌套对象属性变了 → 属性变化', () => {
    const operations = diffValues({
      path: '转移部位',
      oldValue: { 肝: false, 肺: true },
      newValue: { 肝: true, 肺: true },
    });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe('replace');
    expect(operations[0]?.changeKind).toBe('属性变化');
    expect(operations[0]?.detail?.changedProperties).toEqual(['肝']);
    expect(operations[0]?.detail?.addedProperties).toEqual([]);
    expect(operations[0]?.detail?.removedProperties).toEqual([]);
  });

  it('replace：类型不同 → 类型变更并打标', () => {
    const operations = diffValues({ path: '分期', oldValue: 'IVC', newValue: 4 });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe('replace');
    expect(operations[0]?.changeKind).toBe('类型变更');
    expect(operations[0]?.typeChanged).toBe(true);
    expect(operations[0]?.fromKind).toBe('string');
    expect(operations[0]?.toKind).toBe('number');
  });
});

describe('最小差异引擎 · 边界用例', () => {
  it('登记值 null 与院内缺失：两边都空着，不建议删除', () => {
    expect(diffValues({ path: '分期', oldValue: null, newValue: undefined })).toEqual([]);
  });

  it('院内显式为空（null）而登记侧有值 → 修改（清空这一格），不是删除', () => {
    const operations = diffValues({ path: '分期', oldValue: 'IIIB', newValue: null });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe('replace');
    expect(operations[0]?.changeKind).toBe('值不同');
    expect(operations[0]?.newValue).toBeNull();
  });

  it('写法近似但不是同一值：`ⅢB` 与 `IIIB` 不视为同一值（不做 Unicode 折叠）', () => {
    expect(diffValuesEqual('ⅢB', 'IIIB')).toBe(false);
    const operations = diffValues({ path: '分期', oldValue: 'ⅢB', newValue: 'IIIB' });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe('replace');
    expect(operations[0]?.oldValue).toBe('ⅢB');
    expect(operations[0]?.newValue).toBe('IIIB');
  });

  it('写法近似但不是同一值：`III B` 与 `IIIB` 同样判为有差异', () => {
    expect(diffValuesEqual('III B', 'IIIB')).toBe(false);
    expect(diffValues({ path: '分期', oldValue: 'III B', newValue: 'IIIB' })).toHaveLength(1);
  });

  it('数组元素同时增删 → 两条操作（新增 + 删除），各自只带自己那一侧', () => {
    const operations = diffValues({
      path: '过敏史',
      oldValue: ['青霉素', '碘造影剂'],
      newValue: ['青霉素', '头孢'],
    });
    expect(operations).toHaveLength(2);
    expect(operations.map((operation) => operation.op)).toEqual(['add', 'remove']);
    expect(operations[0]?.detail?.addedElements).toEqual(['头孢']);
    expect(operations[1]?.detail?.removedElements).toEqual(['碘造影剂']);
  });

  it('数组顺序不同但元素相同 → 不算差异', () => {
    expect(
      diffValues({ path: '过敏史', oldValue: ['青霉素', '碘造影剂'], newValue: ['碘造影剂', '青霉素'] }),
    ).toEqual([]);
    expect(matchArrayElements(['a', 'b'], ['b', 'a'])).toEqual({ added: [], removed: [] });
  });

  it('嵌套对象新增 / 缺失属性 → 属性变化，明细分开记', () => {
    const operations = diffValues({
      path: '转移部位',
      oldValue: { 肝: false },
      newValue: { 肝: false, 骨: true },
    });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.changeKind).toBe('属性变化');
    expect(operations[0]?.detail?.addedProperties).toEqual(['骨']);
  });

  it('空值形态区分得开：缺失 ≠ 空', () => {
    expect(valueKind(undefined)).toBe('missing');
    expect(valueKind(null)).toBe('null');
    expect(valueKind('')).toBe('string');
    expect(valueKind([])).toBe('array');
    expect(valueKind({})).toBe('object');
  });
});

describe('最小差异引擎 · 最小性', () => {
  it('值相等的字段不产生任何操作', () => {
    const operations = diffFields([
      { field: '分期', oldValue: 'IIIB', newValue: 'IIIB' },
      { field: '治疗方案', oldValue: '术后辅助化疗', newValue: '靶向治疗' },
    ]);
    expect(operations).toHaveLength(1);
    expect(operations[0]?.field).toBe('治疗方案');
  });

  it('只对真正变化的字段产出操作，不整行覆盖', () => {
    const operations = diffFields([
      { field: '分期', oldValue: 'IIIB', newValue: 'IIIB' },
      { field: '治疗方案', oldValue: '术后辅助化疗', newValue: '术后辅助化疗' },
      { field: '随访电话', oldValue: '138****0001', newValue: '139****0002' },
    ]);
    expect(operations).toHaveLength(1);
    expect(operations[0]?.field).toBe('随访电话');
  });

  it('每条操作都带未归一化原值，供写前 ifMatch 比对', () => {
    const operations = diffValues({
      path: '分期',
      oldValue: 'I',
      newValue: 'IVC',
      rawOldValue: ' Ⅰ期 ',
    });
    expect(operations[0]?.rawOldValue).toBe(' Ⅰ期 ');
    expect(operations[0]?.oldValue).toBe('I');
  });
});

describe('最小差异引擎 · 口径表约束', () => {
  it('人工补充列永不产生操作（哪怕调用方把值传进来）', () => {
    const operations = diffFields(
      [{ field: '随访电话', oldValue: '138****0001', newValue: '139****0002' }],
      { spec: SPEC },
    );
    expect(operations).toEqual([]);
  });

  it('口径表声明不参与比对的字段不产生操作', () => {
    const operations = diffFields(
      [{ field: '治疗方案', oldValue: '术后辅助化疗', newValue: '靶向治疗' }],
      { spec: SPEC },
    );
    expect(operations).toEqual([]);
  });

  it('受控编码字段在操作上带标记', () => {
    const operations = diffFields(
      [{ field: '分期', oldValue: 'I', newValue: 'IVC' }],
      { spec: SPEC },
    );
    expect(operations[0]?.controlledCode).toBe(true);
    expect(operations[0]?.column).toBe('分期');
  });

  it('归并等价判定接入后，同义写法不再算差异', () => {
    const normalize = (value: unknown): string =>
      String(value).replace('Ⅲ', 'III').replace(/\s+/g, '');
    const operations = diffFields(
      [{ field: '分期', oldValue: 'IIIB', newValue: 'ⅢB' }],
      {
        spec: SPEC,
        equivalent: (field, oldValue, newValue) =>
          field === '分期' && normalize(oldValue) === normalize(newValue),
      },
    );
    expect(operations).toEqual([]);
  });
});

describe('最小差异引擎 · 逐行比对（口径表驱动）', () => {
  it('产出最小操作集合，并逐条说明未参与比对的字段', () => {
    const result = diffRowAgainstRecord({
      spec: SPEC,
      registryValues: { 分期: 'I' },
      hospitalValues: { 分期: 'IVC' },
    });
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]?.op).toBe('replace');
    const skippedFields = result.skipped.map((item) => item.field);
    expect(skippedFields).toContain('治疗方案');
    expect(skippedFields).toContain('随访电话');
    expect(result.skipped.find((item) => item.field === '随访电话')?.reason).toContain(
      '人工补充列',
    );
  });

  it('登记侧没有这个字段 → 不参与比对，不产出「新增」', () => {
    const result = diffRowAgainstRecord({
      spec: SPEC,
      registryValues: {},
      hospitalValues: { 分期: 'IVC' },
    });
    expect(result.operations).toEqual([]);
    expect(result.skipped.find((item) => item.field === '分期')?.reason).toContain(
      '登记侧本轮没有这个字段的值',
    );
  });

  it('院内本轮未取到这个字段 → 不参与比对（未取到 ≠ 院内没有，不判删除）', () => {
    const result = diffRowAgainstRecord({
      spec: SPEC,
      registryValues: { 分期: 'I' },
      hospitalValues: {},
    });
    expect(result.operations).toEqual([]);
    expect(result.skipped.find((item) => item.field === '分期')?.reason).toContain(
      '未取到',
    );
  });

  it('院内确实没有这个字段（键在、值为 undefined）→ 建议删除', () => {
    const result = diffRowAgainstRecord({
      spec: SPEC,
      registryValues: { 分期: 'I' },
      hospitalValues: { 分期: undefined },
    });
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]?.op).toBe('remove');
  });

  it('登记侧这一格空着、院内有值 → 建议新增', () => {
    const result = diffRowAgainstRecord({
      spec: SPEC,
      registryValues: { 分期: null },
      hospitalValues: { 分期: 'IIIB' },
    });
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]?.op).toBe('add');
  });
});

describe('对象级最小差异 createPatch', () => {
  it('只产出变化字段的操作，值相等与缺失的字段各自按规则处理', () => {
    const operations = createPatch(
      { 登记号: 'REG-0001', 分期: 'I', 治疗方案: '术后辅助化疗' },
      { 登记号: 'REG-0001', 分期: 'IVC', 治疗方案: '术后辅助化疗', 随访电话: '138****0001' },
    );
    expect(operations).toHaveLength(2);
    expect(opsOf(operations, '分期')[0]?.op).toBe('replace');
    expect(opsOf(operations, '随访电话')[0]?.op).toBe('add');
    expect(opsOf(operations, '治疗方案')).toHaveLength(0);
  });

  it('目标里没有的字段 → 建议删除', () => {
    const operations = createPatch({ 登记号: 'REG-0001', 分期: 'I' }, { 登记号: 'REG-0001' });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe('remove');
    expect(operations[0]?.field).toBe('分期');
  });
});
