import { describe, expect, it } from 'vitest';

import { parseCondition, parseEncounter, parsePatient, parseRecord } from '../../src/fhir/parse.js';

describe('Bundle 取值', () => {
  it('解析患者：id / birthDate / gender', () => {
    const { patient, issues } = parsePatient({
      resourceType: 'Patient',
      id: 'pat-1',
      birthDate: '1968-04-12',
      gender: 'female',
      identifier: [{ system: 'urn:oid:x', value: 'REG-0001' }],
    });

    expect(issues).toHaveLength(0);
    expect(patient?.id).toBe('pat-1');
    expect(patient?.birthDate).toBe('1968-04-12');
    expect(patient?.sex).toBe('female');
    expect(patient?.identifiers).toEqual([{ system: 'urn:oid:x', value: 'REG-0001' }]);
  });

  it('患者缺 id 时记问题（无法作为引用主体）', () => {
    const { patient, issues } = parsePatient({ resourceType: 'Patient' });

    expect(patient).toBeNull();
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe('id');
  });

  it('解析诊断：code / onsetDateTime / stage', () => {
    const { condition, issues } = parseCondition({
      resourceType: 'Condition',
      id: 'cond-1',
      code: { coding: [{ system: 'http://snomed.info/sct', code: 'M8500/3' }] },
      onsetDateTime: '2024-03-01T00:00:00+08:00',
      stage: { text: 'IIIB' },
    });

    expect(issues).toHaveLength(0);
    expect(condition.code).toBe('M8500/3');
    expect(condition.codeSystem).toBe('http://snomed.info/sct');
    expect(condition.onsetDateTime).toBe('2024-03-01T00:00:00+08:00');
    expect(condition.stage).toBe('IIIB');
  });

  it('诊断缺 code 时记问题（该字段不参与比对，不当成院内为空）', () => {
    const { condition, issues } = parseCondition({ resourceType: 'Condition', id: 'cond-1' });

    expect(condition.code).toBeNull();
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe('Condition.code');
  });

  it('解析就诊：period / class / type', () => {
    const { encounter, issues } = parseEncounter({
      resourceType: 'Encounter',
      id: 'enc-1',
      period: { start: '2024-03-05T08:00:00+08:00', end: '2024-03-12T08:00:00+08:00' },
      class: { code: 'inpatient' },
      type: { text: '化学治疗' },
    });

    expect(issues).toHaveLength(0);
    expect(encounter.periodStart).toBe('2024-03-05T08:00:00+08:00');
    expect(encounter.periodEnd).toBe('2024-03-12T08:00:00+08:00');
    expect(encounter.class).toBe('inpatient');
    expect(encounter.type).toBe('化学治疗');
  });

  it('就诊缺 period.start 时记问题', () => {
    const { encounter, issues } = parseEncounter({
      resourceType: 'Encounter',
      id: 'enc-1',
      period: { end: '2024-03-12T08:00:00+08:00' },
    });

    expect(encounter.periodStart).toBeNull();
    expect(issues[0]?.field).toBe('Encounter.period.start');
  });

  it('合并三类资源并汇总不可用字段', () => {
    const record = parseRecord({
      patientResources: [{ resourceType: 'Patient', id: 'pat-1' }],
      conditionResources: [{ resourceType: 'Condition', id: 'cond-1' }],
      encounterResources: [{ resourceType: 'Encounter', id: 'enc-1', period: {} }],
    });

    expect(record.patient?.id).toBe('pat-1');
    expect(record.conditions).toHaveLength(1);
    expect(record.encounters).toHaveLength(1);
    expect(record.unavailableFields).toContain('Condition.code');
    expect(record.unavailableFields).toContain('Encounter.period.start');
  });
});
