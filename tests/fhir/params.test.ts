import { describe, expect, it } from 'vitest';

import {
  buildSearchPath,
  conditionByPatientParams,
  dateRangeParams,
  encounterByPatientParams,
  encodeSearchParams,
  identifierToken,
  patientByIdentifierParams,
} from '../../src/fhir/params.js';

describe('检索参数构造', () => {
  it('token 检索值形如 {system}|{value}', () => {
    expect(identifierToken('urn:oid:2.16.156.10011.0.1', 'REG-0001')).toBe(
      'urn:oid:2.16.156.10011.0.1|REG-0001',
    );
  });

  it('system 为空时显式报错（无 system 的 token 会命中别家同号患者）', () => {
    expect(() => identifierToken('  ', 'REG-0001')).toThrow(/CDR_IDENTIFIER_SYSTEM/);
  });

  it('登记号为空时显式报错', () => {
    expect(() => identifierToken('sys', '  ')).toThrow(/登记号为空/);
  });

  it('按登记主索引检索患者', () => {
    expect(patientByIdentifierParams('sys', 'REG-0001')).toEqual({
      identifier: 'sys|REG-0001',
    });
  });

  it('诊断按 subject 引用检索、就诊按 patient 引用检索', () => {
    expect(conditionByPatientParams('pat-1')).toEqual({ subject: 'Patient/pat-1' });
    expect(encounterByPatientParams('pat-1')).toEqual({ patient: 'Patient/pat-1' });
  });

  it('日期区间用重复参数表达', () => {
    expect(dateRangeParams('date', '2024-01-01', '2024-12-31')).toEqual({
      date: ['ge2024-01-01', 'le2024-12-31'],
    });
    expect(dateRangeParams('date', '2024-01-01', null)).toEqual({
      date: ['ge2024-01-01'],
    });
    expect(() => dateRangeParams('date', null, null)).toThrow(/起止都为空/);
  });

  it('参数编码保留重复参数的顺序', () => {
    expect(encodeSearchParams({ date: ['ge2024-01-01', 'le2024-12-31'], _page: '2' })).toBe(
      'date=ge2024-01-01&date=le2024-12-31&_page=2',
    );
  });

  it('资源类型不在白名单时显式报错', () => {
    expect(() => buildSearchPath('Observation', {})).toThrow(/不支持的资源类型/);
    expect(buildSearchPath('Patient', { identifier: 'sys|REG-0001' })).toBe(
      '/fhir/R4/Patient?identifier=sys%7CREG-0001',
    );
  });
});
