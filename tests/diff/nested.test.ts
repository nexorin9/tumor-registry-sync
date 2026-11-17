import { describe, expect, it } from 'vitest';

import {
  NESTED_DEPTH_CAPPED_NOTE,
  diffArray,
  diffFieldsNested,
  diffNested,
  diffObject,
  indexPath,
  joinPath,
  matchArrayIndices,
  type NestedOperation,
} from '../../src/diff/index.js';
import { parseFieldSpec } from '../../src/diff/field-spec.js';

/** 口径表：受控编码字段 + 人工补充列 + 不参与比对的字段。 */
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
    {
      field: '转移部位',
      source: '院内资源路径',
      sourceColumn: '转移部位',
      resourcePath: 'Condition.evidence',
      description: '数组字段，逐元素比对',
      participatesInDiff: true,
      derived: false,
      controlledCode: false,
      humanSupplied: false,
      basis: '经验推断',
    },
  ],
});

function paths(operations: NestedOperation[]): string[] {
  return operations.map((operation) => operation.path);
}

describe('嵌套差异 · 数组元素级操作', () => {
  it('元素值不同 → 产出带下标的 replace（items[1]）', () => {
    const operations = diffNested({
      path: '转移部位',
      oldValue: ['肝', '肺', '骨'],
      newValue: ['肝', '脑', '骨'],
    });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe('replace');
    expect(operations[0]?.path).toBe('转移部位[1]');
    expect(operations[0]?.oldValue).toBe('肺');
    expect(operations[0]?.newValue).toBe('脑');
    expect(operations[0]?.changeKind).toBe('值不同');
  });

  it('院内多一个元素 → 产出 add（items[3]）', () => {
    const operations = diffNested({
      path: '转移部位',
      oldValue: ['肝', '肺'],
      newValue: ['肝', '肺', '骨'],
    });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe('add');
    expect(operations[0]?.path).toBe('转移部位[2]');
    expect(operations[0]?.changeKind).toBe('元素新增');
    expect(operations[0]?.newValue).toBe('骨');
  });

  it('院内少一个元素 → 产出 remove（items[1]）', () => {
    const operations = diffNested({
      path: '转移部位',
      oldValue: ['肝', '肺', '骨'],
      newValue: ['肝', '骨'],
    });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe('remove');
    expect(operations[0]?.path).toBe('转移部位[1]');
    expect(operations[0]?.changeKind).toBe('元素删除');
    expect(operations[0]?.oldValue).toBe('肺');
  });

  it('中间插入一个元素 → 只产出一条 add，不把所有元素都标成变化', () => {
    const operations = diffNested({
      path: '转移部位',
      oldValue: ['肝', '骨'],
      newValue: ['肝', '肺', '骨'],
    });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe('add');
    expect(operations[0]?.path).toBe('转移部位[1]');
    expect(operations[0]?.newValue).toBe('肺');
  });

  it('顺序不同但元素相同 → 零操作（重排不算差异）', () => {
    const operations = diffNested({
      path: '转移部位',
      oldValue: ['肝', '肺', '骨'],
      newValue: ['骨', '肝', '肺'],
    });
    expect(operations).toEqual([]);
  });

  it('两数组完全相等 → 零操作', () => {
    expect(
      diffNested({ path: '转移部位', oldValue: ['肝', '肺'], newValue: ['肝', '肺'] }),
    ).toEqual([]);
  });

  it('数组里的对象元素属性变了 → 下钻到元素内层路径（items[0].code）', () => {
    const operations = diffNested({
      path: '证据',
      oldValue: [{ code: 'M8500/3', detail: '原发' }],
      newValue: [{ code: 'M8501/3', detail: '原发' }],
    });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe('replace');
    expect(operations[0]?.path).toBe('证据[0].code');
    expect(operations[0]?.oldValue).toBe('M8500/3');
    expect(operations[0]?.newValue).toBe('M8501/3');
  });

  it('数组里对象的属性数量变了 → 一增一删各一条', () => {
    const operations = diffNested({
      path: '证据',
      oldValue: [{ code: 'M8500/3' }],
      newValue: [{ code: 'M8500/3', note: '补充' }],
    });
    expect(paths(operations)).toEqual(['证据[0].note']);
    expect(operations[0]?.op).toBe('add');
    expect(operations[0]?.changeKind).toBe('新增');
  });

  it('空数组 → 非空数组：每条都是 add', () => {
    const operations = diffNested({ path: '转移部位', oldValue: [], newValue: ['肝', '肺'] });
    expect(paths(operations)).toEqual(['转移部位[0]', '转移部位[1]']);
    expect(operations.every((operation) => operation.op === 'add')).toBe(true);
  });

  it('非空数组 → 空数组：每条都是 remove', () => {
    const operations = diffNested({ path: '转移部位', oldValue: ['肝', '肺'], newValue: [] });
    expect(paths(operations)).toEqual(['转移部位[0]', '转移部位[1]']);
    expect(operations.every((operation) => operation.op === 'remove')).toBe(true);
  });
});

describe('嵌套差异 · 嵌套对象逐层展开', () => {
  it('两层嵌套值不同 → 路径 a.b.c', () => {
    const operations = diffNested({
      path: '病历',
      oldValue: { 诊断: { 编码: 'M8500/3' } },
      newValue: { 诊断: { 编码: 'M8501/3' } },
    });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.path).toBe('病历.诊断.编码');
    expect(operations[0]?.op).toBe('replace');
    expect(operations[0]?.oldValue).toBe('M8500/3');
    expect(operations[0]?.newValue).toBe('M8501/3');
  });

  it('三层以上嵌套 → 逐层拼接到底', () => {
    const operations = diffNested({
      path: '病历',
      oldValue: { a: { b: { c: { d: 1 } } } },
      newValue: { a: { b: { c: { d: 2 } } } },
    });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.path).toBe('病历.a.b.c.d');
    expect(operations[0]?.oldValue).toBe(1);
    expect(operations[0]?.newValue).toBe(2);
  });

  it('目标侧多出来的属性 → add（a.b）', () => {
    const operations = diffNested({
      path: '病历',
      oldValue: { 诊断: '肺癌' },
      newValue: { 诊断: '肺癌', 病理: '腺癌' },
    });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe('add');
    expect(operations[0]?.path).toBe('病历.病理');
    expect(operations[0]?.changeKind).toBe('新增');
  });

  it('目标侧没有的属性 → remove（a.c）', () => {
    const operations = diffNested({
      path: '病历',
      oldValue: { 诊断: '肺癌', 病理: '腺癌' },
      newValue: { 诊断: '肺癌' },
    });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe('remove');
    expect(operations[0]?.path).toBe('病历.病理');
    expect(operations[0]?.changeKind).toBe('删除');
  });

  it('值相等的属性一条操作都不产生（最小性）', () => {
    const operations = diffNested({
      path: '病历',
      oldValue: { 诊断: '肺癌', 病理: '腺癌', 分期: 'IIIB' },
      newValue: { 诊断: '肺癌', 病理: '腺癌', 分期: 'IIIB' },
    });
    expect(operations).toEqual([]);
  });

  it('嵌套对象里嵌着数组 → 路径混合下标与点号（a.list[1].code）', () => {
    const operations = diffNested({
      path: '证据',
      oldValue: { list: [{ code: 'A' }, { code: 'B' }] },
      newValue: { list: [{ code: 'A' }, { code: 'C' }] },
    });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.path).toBe('证据.list[1].code');
  });

  it('对象整体不同类型（对象 ↔ 数组）→ replace 并标类型变更', () => {
    const operations = diffNested({
      path: '病历',
      oldValue: { 诊断: '肺癌' },
      newValue: ['肺癌'],
    });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe('replace');
    expect(operations[0]?.typeChanged).toBe(true);
    expect(operations[0]?.changeKind).toBe('类型变更');
  });
});

describe('嵌套差异 · null 与缺失严格分开', () => {
  it('目标侧键不存在 → remove', () => {
    const operations = diffNested({
      path: '病历',
      oldValue: { 病理: '腺癌' },
      newValue: {},
    });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe('remove');
    expect(operations[0]?.path).toBe('病历.病理');
    expect(operations[0]?.changeKind).toBe('删除');
  });

  it('目标侧键存在但值为 null → replace（清空这一格，不是删除）', () => {
    const operations = diffNested({
      path: '病历',
      oldValue: { 病理: '腺癌' },
      newValue: { 病理: null },
    });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe('replace');
    expect(operations[0]?.path).toBe('病历.病理');
    expect(operations[0]?.newValue).toBeNull();
    expect(operations[0]?.changeKind).toBe('值不同');
  });

  it('键缺失 与 显式 null 产出的是两种操作（remove vs replace）', () => {
    const removed = diffNested({
      path: '病历',
      oldValue: { 病理: '腺癌' },
      newValue: {},
    });
    const cleared = diffNested({
      path: '病历',
      oldValue: { 病理: '腺癌' },
      newValue: { 病理: null },
    });
    expect(removed[0]?.op).toBe('remove');
    expect(cleared[0]?.op).toBe('replace');
  });

  it('登记侧键不存在 → add', () => {
    const operations = diffNested({
      path: '病历',
      oldValue: {},
      newValue: { 病理: '腺癌' },
    });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe('add');
    expect(operations[0]?.path).toBe('病历.病理');
  });

  it('两侧都是显式 null → 零操作', () => {
    expect(
      diffNested({ path: '病历', oldValue: { 病理: null }, newValue: { 病理: null } }),
    ).toEqual([]);
  });

  it('登记侧显式 null、院内有值 → add（新增这一格）', () => {
    const operations = diffNested({
      path: '病历',
      oldValue: { 病理: null },
      newValue: { 病理: '腺癌' },
    });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe('add');
    expect(operations[0]?.changeKind).toBe('新增');
  });

  it('根层登记侧缺失 → 默认不参与比对（skip）', () => {
    expect(diffNested({ path: '病历', oldValue: undefined, newValue: { 病理: '腺癌' } })).toEqual(
      [],
    );
  });

  it('根层登记侧缺失 + missingOldPolicy=add → 产出一条新增', () => {
    const operations = diffNested({
      path: '病历',
      oldValue: undefined,
      newValue: { 病理: '腺癌' },
      missingOldPolicy: 'add',
    });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe('add');
    expect(operations[0]?.path).toBe('病历');
  });
});

describe('嵌套差异 · 类型变更单独标注', () => {
  it('数值 → 文本：replace + typeChanged', () => {
    const operations = diffNested({
      path: '病历',
      oldValue: { 年龄: 62 },
      newValue: { 年龄: '62' },
    });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe('replace');
    expect(operations[0]?.typeChanged).toBe(true);
    expect(operations[0]?.changeKind).toBe('类型变更');
    expect(operations[0]?.fromKind).toBe('number');
    expect(operations[0]?.toKind).toBe('string');
  });

  it('文本 → 数值：replace + typeChanged', () => {
    const operations = diffNested({
      path: '病历',
      oldValue: { 年龄: '62' },
      newValue: { 年龄: 62 },
    });
    expect(operations[0]?.typeChanged).toBe(true);
    expect(operations[0]?.fromKind).toBe('string');
    expect(operations[0]?.toKind).toBe('number');
  });

  it('布尔 → 文本：replace + typeChanged', () => {
    const operations = diffNested({
      path: '病历',
      oldValue: { 吸烟: true },
      newValue: { 吸烟: '是' },
    });
    expect(operations[0]?.typeChanged).toBe(true);
    expect(operations[0]?.fromKind).toBe('boolean');
    expect(operations[0]?.toKind).toBe('string');
  });

  it('数组 → 对象：replace + typeChanged', () => {
    const operations = diffNested({
      path: '病历',
      oldValue: { 部位: ['肝'] },
      newValue: { 部位: { 主部位: '肝' } },
    });
    expect(operations[0]?.typeChanged).toBe(true);
    expect(operations[0]?.changeKind).toBe('类型变更');
  });

  it('类型相同时不标 typeChanged', () => {
    const operations = diffNested({
      path: '病历',
      oldValue: { 年龄: 62 },
      newValue: { 年龄: 63 },
    });
    expect(operations[0]?.typeChanged).toBe(false);
    expect(operations[0]?.changeKind).toBe('值不同');
  });
});

describe('嵌套差异 · 最小性与口径纪律', () => {
  it('相等的数组元素与对象属性一条操作都不产生', () => {
    const operations = diffNested({
      path: '证据',
      oldValue: { list: [{ code: 'A', note: '甲' }] },
      newValue: { list: [{ code: 'A', note: '甲' }] },
    });
    expect(operations).toEqual([]);
  });

  it('人工补充列在批量比对里一律不产生操作', () => {
    const operations = diffFieldsNested(
      [{ field: '随访电话', oldValue: '1XX****1234', newValue: '1XX****5678' }],
      { spec: SPEC },
    );
    expect(operations).toEqual([]);
  });

  it('口径表声明不参与比对的字段不产生操作', () => {
    const operations = diffFieldsNested(
      [{ field: '治疗方案', oldValue: '化疗', newValue: '靶向' }],
      { spec: SPEC },
    );
    expect(operations).toEqual([]);
  });

  it('标量字段走字段级语义，数组字段走嵌套展开', () => {
    const operations = diffFieldsNested(
      [
        { field: '分期', oldValue: 'IIIB', newValue: 'IIIA' },
        { field: '转移部位', oldValue: ['肝'], newValue: ['肝', '肺'] },
      ],
      { spec: SPEC },
    );
    expect(paths(operations)).toEqual(['分期', '转移部位[1]']);
  });

  it('归并等价接入点生效：等价即零操作（ⅢB 与 IIIB 归并后）', () => {
    const operations = diffNested({
      path: '分期',
      oldValue: 'ⅢB',
      newValue: 'IIIB',
      equivalent: (field, oldValue, newValue) =>
        field === '分期' &&
        typeof oldValue === 'string' &&
        typeof newValue === 'string' &&
        oldValue.replace(/Ⅲ/g, 'III') === newValue,
    });
    expect(operations).toEqual([]);
  });

  it('不归并时写法不同仍判为差异（本层不做 Unicode 折叠）', () => {
    const operations = diffNested({ path: '分期', oldValue: 'ⅢB', newValue: 'IIIB' });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe('replace');
    expect(operations[0]?.oldValue).toBe('ⅢB');
    expect(operations[0]?.newValue).toBe('IIIB');
  });
});

describe('嵌套差异 · 深度封顶与辅助件', () => {
  it('超过最大展开深度 → 整块按修改处理并写明原因（不猜）', () => {
    const operations = diffNested({
      path: '病历',
      oldValue: { a: { b: { c: { d: 1 } } } },
      newValue: { a: { b: { c: { d: 2 } } } },
      maxDepth: 1,
    });
    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe('replace');
    expect(operations[0]?.detail?.note).toBe(NESTED_DEPTH_CAPPED_NOTE);
  });

  it('路径拼接：对象用点号、数组用下标', () => {
    expect(joinPath('病历', '诊断')).toBe('病历.诊断');
    expect(indexPath('转移部位', 2)).toBe('转移部位[2]');
  });

  it('元素配对：内容相同的元素配得上，重排不算剩余', () => {
    const matched = matchArrayIndices(['肝', '肺'], ['肺', '肝']);
    expect(matched.unmatchedOld).toEqual([]);
    expect(matched.unmatchedNew).toEqual([]);
  });

  it('底层 diffArray / diffObject 可单独调用', () => {
    const arrayOps = diffArray(['a', 'b'], ['a', 'c'], '部位', {
      field: '部位',
      column: null,
      controlledCode: false,
      maxDepth: 8,
      depth: 1,
    });
    expect(arrayOps[0]?.path).toBe('部位[1]');

    const objectOps = diffObject({ a: 1 }, { a: 2 }, '根', {
      field: '根',
      column: null,
      controlledCode: false,
      maxDepth: 8,
      depth: 1,
    });
    expect(objectOps[0]?.path).toBe('根.a');
  });
});
