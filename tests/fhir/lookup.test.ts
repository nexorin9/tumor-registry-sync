import { describe, expect, it } from 'vitest';

import { FhirClient } from '../../src/fhir/client.js';
import { FhirRequestError } from '../../src/fhir/errors.js';
import { lookupRows } from '../../src/fhir/orchestrator.js';
import { createFakeCdr } from '../fakes/fake-cdr.js';

function clientWith(fetchImpl: (input: string, init?: RequestInit) => Promise<Response>) {
  return new FhirClient({
    baseUrl: 'http://cdr.test',
    apiToken: 'test-token',
    identifierSystem: 'urn:oid:2.16.156.10011.0.1',
    fetchImpl,
  });
}

describe('逐行检索编排', () => {
  it('命中时依次取回患者、诊断与就诊', async () => {
    const fake = createFakeCdr({
      patients: [{ id: 'pat-1', identifiers: [{ system: 'urn:oid:2.16.156.10011.0.1', value: 'REG-0001' }] }],
      conditions: [{ patientId: 'pat-1', code: 'M8500/3', stage: 'IIIB' }],
      encounters: [{ patientId: 'pat-1', periodStart: '2024-03-05T08:00:00+08:00' }],
    });
    const client = clientWith(fake.fetch);

    const result = await lookupRows([{ rowNumber: 2, registryId: 'REG-0001' }], client);

    const row = result.rows[0];
    expect(row?.binding).toBe('命中');
    expect(row?.status).toBe('待对齐');
    expect(row?.patientId).toBe('pat-1');
    expect(row?.conditions[0]?.code).toBe('M8500/3');
    expect(row?.encounters[0]?.periodStart).toBe('2024-03-05T08:00:00+08:00');
    expect(result.stats).toMatchObject({ total: 1, matched: 1, ambiguous: 0, noMatch: 0, incomplete: 0 });

    // 三段取数顺序：患者 → 诊断 → 就诊
    const paths = fake.requests.map((request) => new URL(request.url).pathname);
    expect(paths).toEqual(['/fhir/R4/Patient', '/fhir/R4/Condition', '/fhir/R4/Encounter']);
  });

  it('零命中：不产出差异值，且不再取诊断与就诊', async () => {
    const fake = createFakeCdr({ patients: [] });
    const client = clientWith(fake.fetch);

    const result = await lookupRows([{ rowNumber: 3, registryId: 'REG-404' }], client);

    const row = result.rows[0];
    expect(row?.binding).toBe('零命中');
    expect(row?.status).toBe('零命中');
    expect(row?.issues[0]?.code).toBe('NO_MATCH');
    expect(row?.conditions).toHaveLength(0);
    expect(fake.requests).toHaveLength(1);
    expect(result.stats.noMatch).toBe(1);
  });

  it('歧义：判歧义、不取第一条、不再取诊断与就诊', async () => {
    const fake = createFakeCdr({
      patients: [
        { id: 'pat-1', identifiers: [{ system: 'urn:oid:2.16.156.10011.0.1', value: 'REG-0001' }] },
        { id: 'pat-2', identifiers: [{ system: 'urn:oid:2.16.156.10011.0.1', value: 'REG-0001' }] },
      ],
    });
    const client = clientWith(fake.fetch);

    const result = await lookupRows([{ rowNumber: 4, registryId: 'REG-0001' }], client);

    const row = result.rows[0];
    expect(row?.binding).toBe('歧义');
    expect(row?.status).toBe('命中歧义');
    expect(row?.patientId).toBeNull();
    expect(row?.issues[0]?.code).toBe('AMBIGUOUS_MATCH');
    expect(fake.requests).toHaveLength(1);
    expect(result.stats.ambiguous).toBe(1);
  });

  it('401 终止整批并点名环境变量', async () => {
    const fake = createFakeCdr({ faults: [{ kind: '401' }] });
    const client = clientWith(fake.fetch);

    const error = await lookupRows([{ rowNumber: 2, registryId: 'REG-0001' }], client).catch((e) => e);

    expect(error).toBeInstanceOf(FhirRequestError);
    expect((error as FhirRequestError).code).toBe('auth_failed');
    expect((error as FhirRequestError).userHint).toContain('CDR_API_TOKEN');
  });

  it('404 映射零命中（不是未完成）', async () => {
    const fake = createFakeCdr({ faults: [{ kind: '404' }] });
    const client = clientWith(fake.fetch);

    const result = await lookupRows([{ rowNumber: 2, registryId: 'REG-0001' }], client);

    expect(result.rows[0]?.binding).toBe('零命中');
    expect(result.rows[0]?.issues[0]?.code).toBe('NO_MATCH');
    expect(result.stats.noMatch).toBe(1);
    expect(result.stats.incomplete).toBe(0);
  });

  it('5xx 映射未完成（检索失败 ≠ 零命中）', async () => {
    const fake = createFakeCdr({ faults: [{ kind: '500' }] });
    const client = clientWith(fake.fetch);

    const result = await lookupRows([{ rowNumber: 2, registryId: 'REG-0001' }], client);

    const row = result.rows[0];
    expect(row?.binding).toBe('未完成');
    expect(row?.issues[0]?.code).toBe('SEARCH_FAILED');
    expect(result.stats.incomplete).toBe(1);
    expect(result.stats.noMatch).toBe(0);
  });

  it('单行失败不影响同批其余行', async () => {
    const fake = createFakeCdr({
      patients: [{ id: 'pat-1', identifiers: [{ system: 'urn:oid:2.16.156.10011.0.1', value: 'REG-0001' }] }],
      faults: [{ kind: '500', identifier: 'REG-0002' }],
    });
    const client = clientWith(fake.fetch);

    const result = await lookupRows(
      [
        { rowNumber: 2, registryId: 'REG-0002' },
        { rowNumber: 3, registryId: 'REG-0001' },
      ],
      client,
    );

    expect(result.rows[0]?.binding).toBe('未完成');
    expect(result.rows[1]?.binding).toBe('命中');
    expect(result.stats).toMatchObject({ total: 2, matched: 1, incomplete: 1 });
  });

  it('缺关键字段：记行级问题且该字段不参与比对', async () => {
    const fake = createFakeCdr({
      patients: [{ id: 'pat-1', identifiers: [{ system: 'urn:oid:2.16.156.10011.0.1', value: 'REG-0001' }] }],
      conditions: [{ patientId: 'pat-1', omitCode: true }],
      encounters: [{ patientId: 'pat-1', omitPeriodStart: true }],
    });
    const client = clientWith(fake.fetch);

    const result = await lookupRows([{ rowNumber: 2, registryId: 'REG-0001' }], client);

    const row = result.rows[0];
    expect(row?.binding).toBe('命中');
    expect(row?.unavailableFields).toContain('Condition.code');
    expect(row?.unavailableFields).toContain('Encounter.period.start');
    expect(row?.issues.map((issue) => issue.code)).toContain('MISSING_FIELD');
  });
});
