import { describe, expect, it } from 'vitest';

import {
  buildComparableInputs,
  collectHospitalValues,
  collectMergeSuggestions,
  createControlledCodeEquivalence,
  crossCheckPathMap,
  PathMapError,
  parsePathMap,
  readHospitalValue,
  resolvePathMap,
  splitResourcePath,
  type ControlledCodeResolver,
  type HospitalRecordView,
  type PathMap,
} from '../../src/diff/index.js';
import { parseFieldSpec } from '../../src/diff/field-spec.js';
import { diffFields } from '../../src/diff/patch.js';

/* ───────────────────────── 测试用口径表 ───────────────────────── */

/**
 * 测试用口径表：四个字段各代表一类。
 * - 登记号：绑定键，不参与比对
 * - 分期：受控编码字段，参与比对，院内侧走 Condition.stage
 * - 首次入院日：派生字段，参与比对，院内侧走 Encounter.period.start
 * - 随访电话：人工补充列，只读不覆盖
 */
const SPEC = parseFieldSpec({
  version: '0.1.0',
  basis: '经验推断',
  note: '测试用口径表。',
  fields: [
    {
      field: '登记号',
      source: '登记列',
      sourceColumn: '登记号',
      resourcePath: 'Patient.identifier',
      description: '登记主索引（脱敏占位标识）',
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
      field: '首次入院日',
      source: '派生',
      sourceColumn: null,
      resourcePath: 'Encounter.period.start',
      description: '派生字段：就诊开始最早的一次',
      participatesInDiff: true,
      derived: true,
      controlledCode: false,
      humanSupplied: false,
      basis: '经验推断',
      derivedCaliber: { rule: 'earliest-encounter-start', encounterFilter: null },
    },
    {
      field: '随访电话',
      source: '登记列',
      sourceColumn: '随访电话',
      resourcePath: null,
      description: '人工补充的随访联系方式',
      participatesInDiff: false,
      derived: false,
      controlledCode: false,
      humanSupplied: true,
      basis: '经验推断',
    },
  ],
});

/** 测试用映射表：三段齐全，与 SPEC 一致。 */
const MAP = parsePathMap({
  version: '0.1.0',
  basis: '经验推断',
  note: '测试用映射表。',
  entries: [
    {
      field: '登记号',
      column: '登记号',
      resourceType: 'Patient',
      resourcePath: 'identifier',
      derived: false,
      multiplicity: 'many',
      controlledCode: false,
      humanSupplied: false,
      basis: '经验推断',
    },
    {
      field: '分期',
      column: '分期',
      resourceType: 'Condition',
      resourcePath: 'stage',
      derived: false,
      multiplicity: 'many',
      controlledCode: true,
      humanSupplied: false,
      basis: '经验推断',
    },
    {
      field: '首次入院日',
      column: null,
      resourceType: 'Encounter',
      resourcePath: 'period.start',
      derived: true,
      multiplicity: 'many',
      controlledCode: false,
      humanSupplied: false,
      basis: '经验推断',
    },
    {
      field: '随访电话',
      column: '随访电话',
      resourceType: null,
      resourcePath: null,
      derived: false,
      multiplicity: 'many',
      controlledCode: false,
      humanSupplied: true,
      basis: '经验推断',
    },
  ],
});

const HEADER = ['登记号', '分期', '首次入院日', '随访电话'];

/** 受控编码词表替身：`ⅢB` / `IIIB` / `III B` 归到同一编码；其它归不出。 */
const VOCAB: Record<string, string> = {
  'ⅢB': 'IIIB',
  'IIIB': 'IIIB',
  'III B': 'IIIB',
  'IIIB期': 'IIIB',
};

const RESOLVER: ControlledCodeResolver = {
  resolve(field, rawValue) {
    if (field !== '分期') return { code: null, reason: `「${field}」不是受控编码字段` };
    const code = VOCAB[rawValue.trim()];
    if (code === undefined) {
      return { code: null, reason: `词表里没有「${rawValue}」的受控编码` };
    }
    return { code, reason: `命中受控编码 ${code}` };
  },
};

/** 一行院内记录：一条诊断 + 一次就诊。 */
function recordWith(stage: string | null, periodStart = '2024-03-05T08:00:00+08:00'): HospitalRecordView {
  return {
    patient: {
      id: 'pat-1',
      birthDate: '1960-01-01',
      sex: 'female',
      identifiers: [{ system: 'urn:oid:2.16.156.10011.0.1', value: 'REG-0001' }],
    },
    conditions: [{ id: 'cond-1', code: 'M8500/3', codeSystem: 'ICD-O', onsetDateTime: null, stage }],
    encounters: [
      {
        id: 'enc-1',
        periodStart,
        periodEnd: null,
        class: 'inpatient',
        type: null,
        status: 'finished',
      },
    ],
  };
}

/* ───────────────────────────── 加载与校验 ───────────────────────────── */

describe('字段路径映射表 · 加载校验', () => {
  it('结构不合法时报错并点名具体字段路径', () => {
    expect(() =>
      parsePathMap({ version: '0.1.0', note: '缺 basis 与 entries', entries: [] }),
    ).toThrow(PathMapError);
  });

  it('同一个口径字段不得声明两次', () => {
    expect(() =>
      parsePathMap({
        version: '0.1.0',
        note: '重复声明',
        entries: [
          {
            field: '分期',
            column: '分期',
            resourceType: 'Condition',
            resourcePath: 'stage',
            multiplicity: 'many',
            basis: '经验推断',
          },
          {
            field: '分期',
            column: '分期2',
            resourceType: 'Condition',
            resourcePath: 'stage',
            multiplicity: 'many',
            basis: '经验推断',
          },
        ],
      }),
    ).toThrow(/口径字段「分期」在映射表里被声明了两次/);
  });

  it('人工补充列不得声明院内资源路径', () => {
    expect(() =>
      parsePathMap({
        version: '0.1.0',
        note: '人工补充列带院内路径',
        entries: [
          {
            field: '随访电话',
            column: '随访电话',
            resourceType: 'Patient',
            resourcePath: 'birthDate',
            multiplicity: 'single',
            humanSupplied: true,
            basis: '经验推断',
          },
        ],
      }),
    ).toThrow(/人工补充列「随访电话」不应声明院内资源路径/);
  });

  it('资源路径没有登记读法时报错并点名字段与路径', () => {
    expect(() =>
      parsePathMap({
        version: '0.1.0',
        note: '路径没读法',
        entries: [
          {
            field: '分期',
            column: '分期',
            resourceType: 'Condition',
            resourcePath: 'noSuchField',
            multiplicity: 'many',
            basis: '经验推断',
          },
        ],
      }),
    ).toThrow(/「分期」声明的院内资源路径「Condition.noSuchField」没有登记读取方式/);
  });

  it('派生字段的命中条数口径必须是 many', () => {
    expect(() =>
      parsePathMap({
        version: '0.1.0',
        note: '派生字段口径错',
        entries: [
          {
            field: '首次入院日',
            column: null,
            resourceType: 'Encounter',
            resourcePath: 'period.start',
            derived: true,
            multiplicity: 'single',
            basis: '经验推断',
          },
        ],
      }),
    ).toThrow(/派生字段「首次入院日」的命中条数口径必须是 many/);
  });
});

/* ───────────────────── 映射表 ↔ 口径表 交叉校验 ───────────────────── */

describe('字段路径映射表 · 与口径表交叉校验', () => {
  it('口径表声明参与比对、映射表却缺条目时报错并点名缺哪个口径字段', () => {
    const mapWithoutStage = parsePathMap({
      version: '0.1.0',
      note: '缺分期映射',
      entries: MAP.entries.filter((entry) => entry.field !== '分期'),
    });

    expect(() => crossCheckPathMap(SPEC, mapWithoutStage)).toThrow(
      /口径字段「分期」声明参与比对，但字段路径映射表里没有它的映射/,
    );
  });

  it('两侧登记列不一致时报错并点名字段', () => {
    const drifted = parsePathMap({
      version: '0.1.0',
      note: '列名漂移',
      entries: MAP.entries.map((entry) =>
        entry.field === '分期' ? { ...entry, column: '临床分期' } : entry,
      ),
    });

    expect(() => crossCheckPathMap(SPEC, drifted)).toThrow(
      /口径字段「分期」的登记列不一致：口径表「分期」vs 映射表「临床分期」/,
    );
  });

  it('两侧院内资源路径不一致时报错并点名字段', () => {
    const drifted = parsePathMap({
      version: '0.1.0',
      note: '资源路径漂移',
      entries: MAP.entries.map((entry) =>
        entry.field === '分期'
          ? { ...entry, resourceType: 'Encounter', resourcePath: 'period.start' }
          : entry,
      ),
    });

    expect(() => crossCheckPathMap(SPEC, drifted)).toThrow(
      /口径字段「分期」的院内资源路径不一致：口径表「Condition.stage」vs 映射表「Encounter.period.start」/,
    );
  });

  it('映射表声明了口径表没有的字段时报错并点名字段', () => {
    const extra = parsePathMap({
      version: '0.1.0',
      note: '多出来的字段',
      entries: [
        ...MAP.entries,
        {
          field: '淋巴结受累',
          column: '淋巴结受累',
          resourceType: 'Condition',
          resourcePath: 'code',
          multiplicity: 'many',
          basis: '经验推断',
        },
      ],
    });

    expect(() => crossCheckPathMap(SPEC, extra)).toThrow(
      /映射表声明了口径字段「淋巴结受累」，但字段口径表里没有这个字段/,
    );
  });

  it('口径表里的资源路径可拆成资源类型与资源内路径', () => {
    expect(splitResourcePath('Condition.stage')).toEqual({
      resourceType: 'Condition',
      path: 'stage',
    });
    expect(() => splitResourcePath('Observation.value')).toThrow(/无法识别的院内资源类型/);
  });
});

/* ───────────────────────────── 逐列判定 ───────────────────────────── */

describe('字段路径映射表 · 逐列判定', () => {
  it('三段映射解析得出登记列 ↔ 口径字段 ↔ 院内资源路径', () => {
    const resolution = resolvePathMap(SPEC, MAP, HEADER);
    const stage = resolution.columns.find((column) => column.column === '分期');

    expect(stage?.field).toBe('分期');
    expect(stage?.status).toBe('参与比对');
    expect(stage?.resourceType).toBe('Condition');
    expect(stage?.resourcePath).toBe('stage');
    expect(stage?.controlledCode).toBe(true);
  });

  it('未声明映射的列显式标「口径未声明」，不参与比对、不猜值', () => {
    const resolution = resolvePathMap(SPEC, MAP, [...HEADER, '备注']);
    const note = resolution.columns.find((column) => column.column === '备注');

    expect(note?.status).toBe('口径未声明');
    expect(note?.field).toBeNull();
    expect(resolution.unspecifiedColumns).toContain('备注');

    const inputs = buildComparableInputs({
      resolution,
      registryValues: { 分期: 'IIIB', 备注: '随手写' },
      hospitalValues: { 分期: 'IIIB' },
    });
    expect(inputs.map((input) => input.field)).not.toContain('备注');
  });

  it('人工补充列标为人工补充列，且比对输入里被排除', () => {
    const resolution = resolvePathMap(SPEC, MAP, HEADER);
    const phone = resolution.columns.find((column) => column.column === '随访电话');

    expect(phone?.status).toBe('人工补充列');
    expect(phone?.humanSupplied).toBe(true);
    expect(resolution.humanSuppliedColumns).toContain('随访电话');

    const inputs = buildComparableInputs({
      resolution,
      registryValues: { 分期: 'IIIB', 随访电话: '1XX****0001' },
      hospitalValues: { 分期: 'IIIB' },
    });
    expect(inputs.map((input) => input.field)).not.toContain('随访电话');
  });

  it('派生字段的院内侧由派生层供给，映射表声明资源类型与路径', () => {
    const resolution = resolvePathMap(SPEC, MAP, HEADER);
    const derived = resolution.entries.find((entry) => entry.field === '首次入院日');

    expect(derived?.derived).toBe(true);
    expect(derived?.resourceType).toBe('Encounter');
    expect(derived?.resourcePath).toBe('period.start');
  });
});

/* ───────────────────────────── 院内取值 ───────────────────────────── */

describe('字段路径映射表 · 院内取值', () => {
  it('按资源路径取到院内值', () => {
    const resolution = resolvePathMap(SPEC, MAP, HEADER);
    const { values, results } = collectHospitalValues(resolution, recordWith('IIIB'));

    expect(values['分期']).toBe('IIIB');
    const stage = results.find((result) => result.field === '分期');
    expect(stage?.status).toBe('已取到');
    expect(stage?.sourceIds).toEqual(['cond-1']);
  });

  it('资源上没有该路径 → 未取到（不参与比对，不等于院内没有）', () => {
    const resolution = resolvePathMap(SPEC, MAP, HEADER);
    const { values, results } = collectHospitalValues(resolution, recordWith(null));

    expect(values['分期']).toBeUndefined();
    const stage = results.find((result) => result.field === '分期');
    expect(stage?.status).toBe('未取到');
    expect(stage?.reason).toContain('院内本轮未取到');
  });

  it('同一路径命中多条资源且取值不一致 → 歧义，不产出院内值（不取第一条）', () => {
    const resolution = resolvePathMap(SPEC, MAP, HEADER);
    const record = recordWith('IIIB');
    record.conditions.push({
      id: 'cond-2',
      code: 'M8500/3',
      codeSystem: 'ICD-O',
      onsetDateTime: null,
      stage: 'IIIA',
    });

    const { values, results } = collectHospitalValues(resolution, record);
    expect(values['分期']).toBeUndefined();

    const stage = results.find((result) => result.field === '分期');
    expect(stage?.status).toBe('歧义');
    expect(stage?.reason).toContain('取值不一致');
    expect(stage?.reason).toContain('不取第一条');
  });

  it('同一路径命中多条资源但取值一致 → 可比对', () => {
    const resolution = resolvePathMap(SPEC, MAP, HEADER);
    const record = recordWith('IIIB');
    record.conditions.push({
      id: 'cond-2',
      code: 'M8500/3',
      codeSystem: 'ICD-O',
      onsetDateTime: null,
      stage: 'IIIB',
    });

    const { values } = collectHospitalValues(resolution, record);
    expect(values['分期']).toBe('IIIB');
  });

  it('单值口径的路径命中多条资源 → 歧义', () => {
    const singleMap = parsePathMap({
      version: '0.1.0',
      note: '单值口径',
      entries: [
        {
          field: '登记号',
          column: '登记号',
          resourceType: 'Patient',
          resourcePath: 'identifier',
          multiplicity: 'single',
          basis: '经验推断',
        },
      ],
    });
    const spec = parseFieldSpec({
      version: '0.1.0',
      basis: '经验推断',
      note: '测试用口径表。',
      fields: [
        {
          field: '登记号',
          source: '登记列',
          sourceColumn: '登记号',
          resourcePath: 'Patient.identifier',
          description: '登记主索引',
          participatesInDiff: true,
          derived: false,
          controlledCode: false,
          humanSupplied: false,
          basis: '经验推断',
        },
      ],
    });

    const resolution = resolvePathMap(spec, singleMap, ['登记号']);
    const record = recordWith('IIIB');
    record.patient = {
      ...(record.patient as NonNullable<HospitalRecordView['patient']>),
      identifiers: [
        { system: 'urn:oid:2.16.156.10011.0.1', value: 'REG-0001' },
        { system: 'urn:oid:other', value: 'REG-0002' },
      ],
    };

    const result = readHospitalValue(resolution.entries[0]!, record);
    expect(result.status).toBe('歧义');
    expect(result.reason).toContain('按单值声明');
  });

  it('派生字段取不到 → 未取到，不参与比对', () => {
    const resolution = resolvePathMap(SPEC, MAP, HEADER);
    const { values, results } = collectHospitalValues(resolution, recordWith('IIIB'));

    expect(values['首次入院日']).toBeUndefined();
    const derived = results.find((result) => result.field === '首次入院日');
    expect(derived?.status).toBe('未取到');
    expect(derived?.reason).toContain('派生字段');
  });

  it('派生字段取到 → 已取到', () => {
    const resolution = resolvePathMap(SPEC, MAP, HEADER);
    const { values } = collectHospitalValues(resolution, recordWith('IIIB'), {
      首次入院日: '2024-03-05',
    });

    expect(values['首次入院日']).toBe('2024-03-05');
  });
});

/* ───────────────────────── 受控编码等价判定 ───────────────────────── */

describe('字段路径映射表 · 受控编码等价', () => {
  it('归并后受控编码相等 → 不产生任何操作', () => {
    const resolution = resolvePathMap(SPEC, MAP, HEADER);
    const equivalent = createControlledCodeEquivalence(MAP, RESOLVER);

    const operations = diffFields(
      [
        {
          field: '分期',
          column: '分期',
          oldValue: 'ⅢB',
          newValue: 'IIIB',
          controlledCode: true,
        },
      ],
      { spec: SPEC, equivalent },
    );

    expect(operations).toHaveLength(0);
  });

  it('归并后受控编码不同 → 差异照常产出，不被抹掉', () => {
    const resolution = resolvePathMap(SPEC, MAP, HEADER);
    const equivalent = createControlledCodeEquivalence(MAP, RESOLVER);

    const operations = diffFields(
      [
        {
          field: '分期',
          column: '分期',
          oldValue: 'ⅢB',
          newValue: 'ⅡA',
          controlledCode: true,
        },
      ],
      { spec: SPEC, equivalent },
    );

    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe('replace');
  });

  it('一侧归不出来 → 不算等价，差异保留', () => {
    const resolution = resolvePathMap(SPEC, MAP, HEADER);
    const equivalent = createControlledCodeEquivalence(MAP, RESOLVER);

    const operations = diffFields(
      [
        {
          field: '分期',
          column: '分期',
          oldValue: '写法不明',
          newValue: 'IIIB',
          controlledCode: true,
        },
      ],
      { spec: SPEC, equivalent },
    );

    expect(operations).toHaveLength(1);
    expect(operations[0]?.op).toBe('replace');
  });

  it('写法不同但归并等价 → 给出归并建议（只进建议值列，不产生差异）', () => {
    const resolution = resolvePathMap(SPEC, MAP, HEADER);
    const suggestions = collectMergeSuggestions({
      resolution,
      registryValues: { 分期: 'III B' },
      hospitalValues: { 分期: 'IIIB' },
      resolver: RESOLVER,
    });

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.field).toBe('分期');
    expect(suggestions[0]?.mergedCode).toBe('IIIB');
    expect(suggestions[0]?.reason).toContain('归并后等价');
  });

  it('归并不出受控编码 → 不给建议', () => {
    const resolution = resolvePathMap(SPEC, MAP, HEADER);
    const suggestions = collectMergeSuggestions({
      resolution,
      registryValues: { 分期: '写法不明' },
      hospitalValues: { 分期: 'IIIB' },
      resolver: RESOLVER,
    });

    expect(suggestions).toHaveLength(0);
  });
});

/* ───────────────────────── 比对输入装配 ───────────────────────── */

describe('字段路径映射表 · 比对输入装配', () => {
  it('只装配参与比对、两侧都有值的字段', () => {
    const resolution = resolvePathMap(SPEC, MAP, HEADER);
    const inputs = buildComparableInputs({
      resolution,
      registryValues: { 分期: 'ⅢB', 首次入院日: '2024-03-05', 随访电话: '1XX****0001' },
      hospitalValues: { 分期: 'IIIB', 首次入院日: '2024-03-04' },
    });

    expect(inputs.map((input) => input.field).sort()).toEqual(['分期', '首次入院日']);
    expect(inputs.every((input) => input.column !== '随访电话')).toBe(true);
  });

  it('院内侧没取到的字段不进比对输入（不按空值判删除）', () => {
    const resolution = resolvePathMap(SPEC, MAP, HEADER);
    const inputs = buildComparableInputs({
      resolution,
      registryValues: { 分期: 'ⅢB', 首次入院日: '2024-03-05' },
      hospitalValues: { 首次入院日: '2024-03-04' },
    });

    expect(inputs.map((input) => input.field)).toEqual(['首次入院日']);
  });

  it('受控编码标记随映射表传递到比对输入', () => {
    const resolution = resolvePathMap(SPEC, MAP, HEADER);
    const inputs = buildComparableInputs({
      resolution,
      registryValues: { 分期: 'ⅢB' },
      hospitalValues: { 分期: 'IIIB' },
    });

    expect(inputs[0]?.controlledCode).toBe(true);
  });
});

/* ───────────────────── 与仓库里的真实配置对得上 ───────────────────── */

describe('字段路径映射表 · 仓库配置自洽', () => {
  it('config/path-map.json 与 config/field-spec.json 对得上', async () => {
    const { loadFieldSpec } = await import('../../src/diff/field-spec.js');
    const { loadPathMap } = await import('../../src/diff/path-map.js');
    const { fileURLToPath } = await import('node:url');
    const path = await import('node:path');

    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const spec = loadFieldSpec(path.join(root, 'config/field-spec.json'));
    const map = loadPathMap(path.join(root, 'config/path-map.json'));

    expect(() => crossCheckPathMap(spec, map)).not.toThrow();

    const resolution = resolvePathMap(spec, map, ['登记号', '分期', '治疗方案', '随访电话']);
    expect(resolution.unspecifiedColumns).toEqual([]);
    expect(resolution.humanSuppliedColumns).toEqual(['随访电话']);
  });
});
