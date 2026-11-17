import { describe, expect, it } from 'vitest';

import {
  buildDerivedFields,
  buildReplayDerivedRows,
  derivedCalibersFromSpec,
} from '../../src/diff/index.js';
import { parseFieldSpec } from '../../src/diff/field-spec.js';
import type { EncounterView } from '../../src/fhir/index.js';

function encounter(
  id: string,
  periodStart: string | null,
  extra: Partial<EncounterView> = {},
): EncounterView {
  return {
    id,
    periodStart,
    periodEnd: null,
    class: null,
    type: null,
    status: null,
    ...extra,
  };
}

/** 只声明了两个派生字段的口径表。 */
const SPEC = parseFieldSpec({
  version: '0.1.0',
  basis: '经验推断',
  note: '口径表级说明。',
  fields: [
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
    {
      field: '本次就诊开始',
      source: '派生',
      sourceColumn: null,
      resourcePath: 'Encounter.period.start',
      description: '就诊开始最近的一条',
      participatesInDiff: true,
      derived: true,
      controlledCode: false,
      humanSupplied: false,
      basis: '经验推断',
      derivedCaliber: { rule: 'latest-encounter-start', encounterFilter: null },
    },
  ],
});

/** 只声明了首次入院日的口径表（本次就诊开始未声明 → 口径未声明）。 */
const SPEC_ONLY_FIRST = parseFieldSpec({
  version: '0.1.0',
  basis: '经验推断',
  note: '口径表级说明。',
  fields: [
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
});

const ENCOUNTERS: EncounterView[] = [
  encounter('enc-1', '2024-03-05T08:00:00+08:00'),
  encounter('enc-2', '2024-05-20T09:30:00+08:00'),
  encounter('enc-3', '2023-11-02T14:00:00+08:00'),
];

describe('派生口径声明', () => {
  it('只取口径表里声明了取数口径的派生字段', () => {
    const calibers = derivedCalibersFromSpec(SPEC);

    expect(Object.keys(calibers).sort()).toEqual(['本次就诊开始', '首次入院日']);
    expect(calibers['首次入院日']?.rule).toBe('earliest-encounter-start');
    expect(calibers['本次就诊开始']?.rule).toBe('latest-encounter-start');
  });

  it('口径表没声明的派生字段不进声明（口径未声明就不算）', () => {
    const calibers = derivedCalibersFromSpec(SPEC_ONLY_FIRST);

    expect(Object.keys(calibers)).toEqual(['首次入院日']);
  });
});

describe('派生字段计算', () => {
  it('首次入院日取就诊开始最早的一次，本次就诊开始取最近的一次', () => {
    const result = buildDerivedFields({
      spec: SPEC,
      rowNumber: 2,
      registryId: 'REG-0001',
      encounters: ENCOUNTERS,
    });

    expect(result.derived['首次入院日']?.status).toBe('已取到');
    expect(result.derived['首次入院日']?.date).toBe('2023-11-02');
    expect(result.derived['首次入院日']?.sourceEncounterIds).toEqual(['enc-3']);
    expect(result.derived['首次入院日']?.participatesInDiff).toBe(true);

    expect(result.derived['本次就诊开始']?.status).toBe('已取到');
    expect(result.derived['本次就诊开始']?.instant).toBe('2024-05-20T09:30:00+08:00');
    expect(result.derived['本次就诊开始']?.sourceEncounterIds).toEqual(['enc-2']);
  });

  it('口径表没声明的派生字段标「口径未声明」且不参与比对', () => {
    const result = buildDerivedFields({
      spec: SPEC_ONLY_FIRST,
      rowNumber: 2,
      registryId: 'REG-0001',
      encounters: ENCOUNTERS,
    });

    const unspecified = result.derived['本次就诊开始'];
    expect(unspecified?.declaredInSpec).toBe(false);
    expect(unspecified?.status).toBe('口径未声明');
    expect(unspecified?.participatesInDiff).toBe(false);
    expect(unspecified?.date).toBeNull();
    expect(result.unavailableFields).toContain('本次就诊开始');
  });

  it('院内没有就诊记录时标「口径未声明」，绝不按空值参与比对', () => {
    const result = buildDerivedFields({
      spec: SPEC,
      rowNumber: 2,
      registryId: 'REG-0001',
      encounters: [],
    });

    for (const field of ['首次入院日', '本次就诊开始']) {
      expect(result.derived[field]?.status).toBe('口径未声明');
      expect(result.derived[field]?.participatesInDiff).toBe(false);
      expect(result.derived[field]?.date).toBeNull();
    }
    expect(result.unavailableFields.sort()).toEqual(['本次就诊开始', '首次入院日']);
  });

  it('就诊缺 period.start 时该字段不参与比对，并说明原因', () => {
    const result = buildDerivedFields({
      spec: SPEC,
      rowNumber: 2,
      registryId: 'REG-0001',
      encounters: [encounter('enc-1', null)],
    });

    expect(result.derived['首次入院日']?.status).toBe('口径未声明');
    expect(result.derived['首次入院日']?.reason).toContain('period.start');
    expect(result.derived['首次入院日']?.participatesInDiff).toBe(false);
  });

  it('日期写法认不出时标「日期不可解析」并记一条行级问题（不猜日期）', () => {
    const result = buildDerivedFields({
      spec: SPEC,
      rowNumber: 7,
      registryId: 'REG-0001',
      encounters: [encounter('enc-1', '三月五号')],
    });

    expect(result.derived['首次入院日']?.status).toBe('日期不可解析');
    expect(result.derived['首次入院日']?.participatesInDiff).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('DATE_UNPARSEABLE');
    expect(result.issues[0]?.rowNumber).toBe(7);
  });

  it('口径表声明的就诊筛选范围生效', () => {
    const spec = parseFieldSpec({
      version: '0.1.0',
      basis: '经验推断',
      note: '口径表级说明。',
      fields: [
        {
          field: '首次入院日',
          source: '派生',
          sourceColumn: null,
          resourcePath: 'Encounter.period.start',
          description: '只按住院就诊取最早的一次',
          participatesInDiff: true,
          derived: true,
          controlledCode: false,
          humanSupplied: false,
          basis: '经验推断',
          derivedCaliber: {
            rule: 'earliest-encounter-start',
            encounterFilter: { classCode: 'inpatient', typeText: null },
          },
        },
      ],
    });

    const result = buildDerivedFields({
      spec,
      rowNumber: 2,
      registryId: 'REG-0001',
      encounters: [
        encounter('enc-out', '2020-01-01T08:00:00+08:00', { class: 'outpatient' }),
        encounter('enc-in', '2024-03-05T08:00:00+08:00', { class: 'inpatient' }),
      ],
    });

    expect(result.derived['首次入院日']?.sourceEncounterIds).toEqual(['enc-in']);
    expect(result.derived['首次入院日']?.date).toBe('2024-03-05');
  });

  it('口径表里的取数规则改了，算出来的值跟着改（口径先于取值）', () => {
    const flipped = parseFieldSpec({
      version: '0.1.1',
      basis: '经验推断',
      note: '口径表级说明。',
      fields: [
        {
          field: '首次入院日',
          source: '派生',
          sourceColumn: null,
          resourcePath: 'Encounter.period.start',
          description: '改成取最近的一次',
          participatesInDiff: true,
          derived: true,
          controlledCode: false,
          humanSupplied: false,
          basis: '经验推断',
          derivedCaliber: { rule: 'latest-encounter-start', encounterFilter: null },
        },
      ],
    });

    const result = buildDerivedFields({
      spec: flipped,
      rowNumber: 2,
      registryId: 'REG-0001',
      encounters: ENCOUNTERS,
    });

    expect(result.derived['首次入院日']?.date).toBe('2024-05-20');
  });
});

describe('离线回放的派生结果', () => {
  it('按 limit 只算前几位患者，identifier 原样透传', () => {
    const rows = buildReplayDerivedRows({
      spec: SPEC,
      patients: [
        { patientId: 'pat-1', identifier: 'REG-0001', encounters: ENCOUNTERS },
        { patientId: 'pat-2', identifier: 'REG-0002', encounters: [encounter('e', '2024-06-01T08:00:00+08:00')] },
        { patientId: 'pat-3', identifier: null, encounters: [] },
      ],
      limit: 2,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.identifier).toBe('REG-0001');
    expect(rows[0]?.derived['首次入院日']?.date).toBe('2023-11-02');
    expect(rows[1]?.derived['本次就诊开始']?.date).toBe('2024-06-01');
  });

  it('没有 identifier 时不猜值，派生字段照常按口径算', () => {
    const rows = buildReplayDerivedRows({
      spec: SPEC,
      patients: [{ patientId: 'pat-3', identifier: null, encounters: ENCOUNTERS }],
    });

    expect(rows[0]?.identifier).toBeNull();
    expect(rows[0]?.derived['首次入院日']?.status).toBe('已取到');
  });
});
