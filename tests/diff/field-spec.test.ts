import { describe, expect, it } from 'vitest';

import {
  CALIBER_UNSPECIFIED,
  FieldSpecError,
  effectiveCalibers,
  loadFieldSpec,
  parseFieldSpec,
  resolveFieldSpec,
} from '../../src/diff/index.js';

/** 一份最小可用的口径表：两个参与比对的列 + 一个人工补充列 + 一个派生字段。 */
const VALID_SPEC = {
  version: '0.1.0',
  basis: '经验推断',
  note: '口径表级说明：未声明口径的列一律不参与比对。',
  fields: [
    {
      field: '登记号',
      source: '登记列',
      sourceColumn: '登记号',
      resourcePath: 'Patient.identifier',
      description: '登记主索引，行的绑定键',
      participatesInDiff: false,
      derived: false,
      controlledCode: false,
      humanSupplied: false,
      basis: '经验推断',
    },
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
      field: '随访电话',
      source: '登记列',
      sourceColumn: '随访电话',
      resourcePath: null,
      description: '登记员人工补充的随访联系方式',
      participatesInDiff: false,
      derived: false,
      controlledCode: false,
      humanSupplied: true,
      basis: '经验推断',
    },
    {
      field: '首次入院日',
      source: '派生',
      sourceColumn: null,
      resourcePath: 'Encounter.period.start',
      description: '就诊开始最早的一条',
      participatesInDiff: true,
      derived: true,
      controlledCode: false,
      humanSupplied: false,
      basis: '经验推断',
      derivedCaliber: { rule: 'earliest-encounter-start', encounterFilter: null },
    },
  ],
};

describe('受控字段口径表', () => {
  it('项目自带的口径表能通过校验，且每条都标注 (经验推断)', () => {
    const spec = loadFieldSpec('config/field-spec.json');

    expect(spec.version).toBe('0.1.0');
    expect(spec.basis).toBe('经验推断');
    expect(spec.fields.length).toBeGreaterThan(0);
    for (const entry of spec.fields) {
      expect(entry.basis).toBe('经验推断');
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('口径表覆盖任务要求的七个字段，派生字段各自声明了取数口径', () => {
    const spec = loadFieldSpec('config/field-spec.json');
    const fields = spec.fields.map((entry) => entry.field);

    expect(fields).toEqual(
      expect.arrayContaining([
        '登记号',
        '分期',
        '治疗方案',
        '首次入院日',
        '本次就诊开始',
        '随访电话',
        '生活方式备注',
      ]),
    );

    const firstAdmission = spec.fields.find((entry) => entry.field === '首次入院日');
    expect(firstAdmission?.derived).toBe(true);
    expect(firstAdmission?.derivedCaliber?.rule).toBe('earliest-encounter-start');

    const currentEncounter = spec.fields.find((entry) => entry.field === '本次就诊开始');
    expect(currentEncounter?.derived).toBe(true);
    expect(currentEncounter?.derivedCaliber?.rule).toBe('latest-encounter-start');
  });

  it('人工补充列在口径表里标 human_supplied 且不参与比对', () => {
    const spec = loadFieldSpec('config/field-spec.json');
    for (const field of ['随访电话', '生活方式备注']) {
      const entry = spec.fields.find((item) => item.field === field);
      expect(entry?.humanSupplied).toBe(true);
      expect(entry?.participatesInDiff).toBe(false);
    }
  });

  it('结构不合法的口径表报错并点名字段路径', () => {
    const broken = { ...VALID_SPEC, fields: [{ field: '分期' }] };

    expect(() => parseFieldSpec(broken)).toThrow(FieldSpecError);
    expect(() => parseFieldSpec(broken)).toThrow(/口径/);
  });

  it('口径依据留空不允许进表', () => {
    const broken = {
      ...VALID_SPEC,
      fields: [{ ...VALID_SPEC.fields[0], basis: '' }],
    };

    expect(() => parseFieldSpec(broken)).toThrow(FieldSpecError);
    expect(() => parseFieldSpec(broken)).toThrow(/basis/);
  });

  it('同一个口径字段名声明两次时报错并点名该字段', () => {
    const duplicated = {
      ...VALID_SPEC,
      fields: [...VALID_SPEC.fields, { ...VALID_SPEC.fields[1] }],
    };

    expect(() => parseFieldSpec(duplicated)).toThrow(FieldSpecError);
    expect(() => parseFieldSpec(duplicated)).toThrow(/分期.*声明了两次/);
  });

  it('同一登记列挂到两个口径字段上报错并点名该列', () => {
    const conflicted = {
      ...VALID_SPEC,
      fields: [
        ...VALID_SPEC.fields,
        {
          ...VALID_SPEC.fields[1],
          field: '分期备写',
          resourcePath: 'Condition.code',
          description: '另一个字段',
        },
      ],
    };

    expect(() => parseFieldSpec(conflicted)).toThrow(FieldSpecError);
    expect(() => parseFieldSpec(conflicted)).toThrow(/登记列「分期」/);
  });

  it('派生字段未声明取数口径时报错并点名该字段', () => {
    const broken = {
      ...VALID_SPEC,
      fields: [{ ...VALID_SPEC.fields[3], derivedCaliber: null }],
    };

    expect(() => parseFieldSpec(broken)).toThrow(FieldSpecError);
    expect(() => parseFieldSpec(broken)).toThrow(/首次入院日.*derivedCaliber/);
  });

  it('派生字段名不在支持集合内时报错并点名该字段', () => {
    const broken = {
      ...VALID_SPEC,
      fields: [{ ...VALID_SPEC.fields[3], field: '末次就诊日' }],
    };

    expect(() => parseFieldSpec(broken)).toThrow(FieldSpecError);
    expect(() => parseFieldSpec(broken)).toThrow(/末次就诊日.*派生字段集合/);
  });

  it('非派生字段声明取数口径时报错', () => {
    const broken = {
      ...VALID_SPEC,
      fields: [
        {
          ...VALID_SPEC.fields[1],
          derivedCaliber: { rule: 'earliest-encounter-start', encounterFilter: null },
        },
      ],
    };

    expect(() => parseFieldSpec(broken)).toThrow(FieldSpecError);
    expect(() => parseFieldSpec(broken)).toThrow(/非派生字段「分期」/);
  });

  it('来源为登记列却没声明登记侧列名时报错', () => {
    const broken = {
      ...VALID_SPEC,
      fields: [{ ...VALID_SPEC.fields[0], sourceColumn: null }],
    };

    expect(() => parseFieldSpec(broken)).toThrow(FieldSpecError);
    expect(() => parseFieldSpec(broken)).toThrow(/登记号.*sourceColumn/);
  });

  it('来源为院内资源路径却没声明资源路径时报错', () => {
    const broken = {
      ...VALID_SPEC,
      fields: [{ ...VALID_SPEC.fields[1], resourcePath: null }],
    };

    expect(() => parseFieldSpec(broken)).toThrow(FieldSpecError);
    expect(() => parseFieldSpec(broken)).toThrow(/分期.*resourcePath/);
  });

  it('声明参与比对却没有可比的一侧时报错（要比却没有可比对象）', () => {
    const broken = {
      ...VALID_SPEC,
      fields: [{ ...VALID_SPEC.fields[1], resourcePath: null }],
    };

    expect(() => parseFieldSpec(broken)).toThrow(FieldSpecError);
    expect(() => parseFieldSpec(broken)).toThrow(/参与比对的字段「分期」/);
  });

  it('人工补充列不得参与比对，也不得标成受控编码字段', () => {
    const compares = {
      ...VALID_SPEC,
      fields: [{ ...VALID_SPEC.fields[2], participatesInDiff: true }],
    };
    expect(() => parseFieldSpec(compares)).toThrow(/随访电话.*不能参与比对/);

    const controlled = {
      ...VALID_SPEC,
      fields: [{ ...VALID_SPEC.fields[2], controlledCode: true }],
    };
    expect(() => parseFieldSpec(controlled)).toThrow(/随访电话.*受控编码字段/);
  });

  it('口径表文件不存在时报错并点名路径', () => {
    expect(() => loadFieldSpec('config/不存在的口径表.json')).toThrow(FieldSpecError);
    expect(() => loadFieldSpec('config/不存在的口径表.json')).toThrow(/config\/不存在的口径表.json/);
  });

  it('口径表不是合法 JSON 时报错并点名路径', () => {
    expect(() => parseFieldSpec('{ 不是 JSON')).toThrow(FieldSpecError);
  });
});

describe('生效口径清单', () => {
  it('逐字段给出来源、口径说明与本轮怎么处理', () => {
    const calibers = effectiveCalibers(parseFieldSpec(VALID_SPEC));

    expect(calibers.map((item) => item.field)).toEqual(['登记号', '分期', '随访电话', '首次入院日']);
    expect(calibers.find((item) => item.field === '随访电话')?.treatment).toBe(
      '人工补充列 · 只读不覆盖 · 不参与比对',
    );
    expect(calibers.find((item) => item.field === '首次入院日')?.treatment).toBe(
      '派生字段 · 按口径算出后参与比对',
    );
    expect(calibers.find((item) => item.field === '分期')?.treatment).toBe('参与比对');
  });

  it('只归并不参与比对的字段，处理口径写明只作建议值', () => {
    const spec = parseFieldSpec({
      ...VALID_SPEC,
      fields: [
        {
          ...VALID_SPEC.fields[1],
          field: '治疗方案',
          source: '登记列',
          resourcePath: null,
          participatesInDiff: false,
        },
      ],
    });

    const caliber = effectiveCalibers(spec)[0];
    expect(caliber?.treatment).toBe('不参与比对 · 归并后只作建议值');
  });
});

describe('口径表与本张表对照', () => {
  it('口径表没声明的列显式标「口径未声明」且不参与比对', () => {
    const resolved = resolveFieldSpec(parseFieldSpec(VALID_SPEC), [
      '登记号',
      '分期',
      '随访电话',
      '备注',
    ]);

    const unspecified = resolved.columns.find((column) => column.column === '备注');
    expect(unspecified?.status).toBe(CALIBER_UNSPECIFIED);
    expect(unspecified?.field).toBeNull();
    expect(unspecified?.participatesInDiff).toBe(false);
    expect(unspecified?.reason).toContain('未在字段口径表中声明');
    expect(resolved.unspecifiedColumns).toEqual(['备注']);
  });

  it('人工补充列单列一档，不参与比对', () => {
    const resolved = resolveFieldSpec(parseFieldSpec(VALID_SPEC), ['登记号', '随访电话']);

    const phone = resolved.columns.find((column) => column.column === '随访电话');
    expect(phone?.status).toBe('人工补充列');
    expect(phone?.humanSupplied).toBe(true);
    expect(phone?.participatesInDiff).toBe(false);
    expect(resolved.humanSuppliedColumns).toEqual(['随访电话']);
  });

  it('口径表声明了但表里没有的字段记为本轮不出现', () => {
    const resolved = resolveFieldSpec(parseFieldSpec(VALID_SPEC), ['登记号']);

    expect(resolved.absentFields).toEqual(['分期', '随访电话']);
  });

  it('参与比对的列带上口径字段名与受控编码标记', () => {
    const resolved = resolveFieldSpec(parseFieldSpec(VALID_SPEC), ['分期']);

    const stage = resolved.columns[0];
    expect(stage?.field).toBe('分期');
    expect(stage?.status).toBe('参与比对');
    expect(stage?.participatesInDiff).toBe(true);
    expect(stage?.controlledCode).toBe(true);
  });

  it('表头首尾空白按去空白后的列名对照', () => {
    const resolved = resolveFieldSpec(parseFieldSpec(VALID_SPEC), [' 登记号 ', '分期']);

    expect(resolved.columns.map((column) => column.column)).toEqual(['登记号', '分期']);
    expect(resolved.unspecifiedColumns).toEqual([]);
  });
});
