import { describe, expect, it } from 'vitest';

import { FhirClient } from '../../src/fhir/client.js';
import {
  DEFAULT_LOOKUP_CONCURRENCY,
  LookupConcurrencyError,
  lookupRows,
  type LookupRowInput,
} from '../../src/fhir/orchestrator.js';
import { createFakeCdr, type FakeCdrRequest } from '../fakes/fake-cdr.js';

const SYSTEM = 'urn:oid:2.16.156.10011.0.1';

function clientWith(fetchImpl: (input: string, init?: RequestInit) => Promise<Response>) {
  return new FhirClient({
    baseUrl: 'http://cdr.test',
    apiToken: 'test-token',
    identifierSystem: SYSTEM,
    fetchImpl,
  });
}

/** 记录在途请求数与峰值的 fetch 包装：让并发真的能被观测到。 */
function trackedFetch(
  fake: { fetch: (input: string, init?: RequestInit) => Promise<Response>; requests: FakeCdrRequest[] },
  delayMs = 5,
): {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  peak: () => number;
} {
  let inFlight = 0;
  let peak = 0;
  return {
    fetch: async (input, init) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        return await fake.fetch(input, init);
      } finally {
        inFlight -= 1;
      }
    },
    peak: () => peak,
  };
}

/** 一批登记号（每行一个唯一登记号）。 */
function rowsOf(count: number, prefix = 'REG'): LookupRowInput[] {
  return Array.from({ length: count }, (_unused, index) => ({
    rowNumber: index + 2,
    registryId: `${prefix}-${String(index + 1).padStart(4, '0')}`,
  }));
}

function patientsFor(rows: LookupRowInput[]) {
  return rows.map((row) => ({
    id: `pat-${row.registryId}`,
    identifiers: [{ system: SYSTEM, value: row.registryId }],
  }));
}

describe('检索编排：并发限流 / 去重 / 单行失败隔离 / 检索参数串', () => {
  it('并发上限：同时在途的检索不超过上限，且确实并行跑', async () => {
    const rows = rowsOf(8);
    const fake = createFakeCdr({ patients: patientsFor(rows) });
    const tracker = trackedFetch(fake);
    const client = clientWith(tracker.fetch);

    const result = await lookupRows(rows, client, { maxConcurrency: 3 });

    expect(result.concurrency.limit).toBe(3);
    expect(result.concurrency.peakInFlight).toBeLessThanOrEqual(3);
    // 并行是真的发生了：峰值达到上限，而不是退化成串行
    expect(result.concurrency.peakInFlight).toBe(3);
    expect(result.stats.matched).toBe(8);
  });

  it('并发上限缺省取 4', async () => {
    const rows = rowsOf(6);
    const fake = createFakeCdr({ patients: patientsFor(rows) });
    const tracker = trackedFetch(fake);

    const result = await lookupRows(rows, clientWith(tracker.fetch));

    expect(DEFAULT_LOOKUP_CONCURRENCY).toBe(4);
    expect(result.concurrency.limit).toBe(4);
    expect(result.concurrency.peakInFlight).toBeLessThanOrEqual(4);
  });

  it('并发上限非法时点名 FHIR_MAX_CONCURRENCY，不静默改成 1', async () => {
    const fake = createFakeCdr({ patients: [] });
    const client = clientWith(fake.fetch);

    const error = await lookupRows(rowsOf(2), client, { maxConcurrency: 0 }).catch((e) => e);

    expect(error).toBeInstanceOf(LookupConcurrencyError);
    expect((error as Error).message).toContain('FHIR_MAX_CONCURRENCY');
  });

  it('同一登记主索引只查一次：结果复用并计数', async () => {
    const fake = createFakeCdr({
      patients: [{ id: 'pat-1', identifiers: [{ system: SYSTEM, value: 'REG-0001' }] }],
      conditions: [{ patientId: 'pat-1', code: 'M8500/3', stage: 'IIIB' }],
      encounters: [{ patientId: 'pat-1', periodStart: '2024-03-05T08:00:00+08:00' }],
    });
    const client = clientWith(fake.fetch);

    const result = await lookupRows(
      [
        { rowNumber: 2, registryId: 'REG-0001' },
        { rowNumber: 3, registryId: 'REG-0001' },
        { rowNumber: 4, registryId: 'REG-0002' },
      ],
      client,
    );

    // REG-0001 只发了一次患者检索（REG-0002 零命中也只发一次患者检索）
    const patientRequests = fake.requests.filter(
      (request) => new URL(request.url).pathname === '/fhir/R4/Patient',
    );
    expect(patientRequests).toHaveLength(2);
    expect(result.dedup.uniqueRegistryIds).toBe(2);
    expect(result.dedup.reusedRows).toBe(1);

    const first = result.rows[0];
    const second = result.rows[1];
    expect(first?.binding).toBe('命中');
    expect(second?.binding).toBe('命中');
    expect(first?.reused).toBe(false);
    expect(second?.reused).toBe(true);
    // 复用的行拿到同一份院内值
    expect(second?.patientId).toBe(first?.patientId);
    expect(second?.conditions[0]?.code).toBe('M8500/3');
    expect(second?.encounters[0]?.periodStart).toBe('2024-03-05T08:00:00+08:00');
    // 行级问题上的行号按行补正（复用行不带别人的行号）
    expect(second?.issues.every((issue) => issue.rowNumber === 3)).toBe(true);
  });

  it('单行失败隔离：该行标错误码，其余行照常命中', async () => {
    const fake = createFakeCdr({
      patients: [
        { id: 'pat-1', identifiers: [{ system: SYSTEM, value: 'REG-0001' }] },
        { id: 'pat-3', identifiers: [{ system: SYSTEM, value: 'REG-0003' }] },
      ],
      faults: [{ kind: '500', identifier: 'REG-0002' }],
    });
    const client = clientWith(fake.fetch);

    const result = await lookupRows(
      [
        { rowNumber: 2, registryId: 'REG-0001' },
        { rowNumber: 3, registryId: 'REG-0002' },
        { rowNumber: 4, registryId: 'REG-0003' },
      ],
      client,
      { maxConcurrency: 2 },
    );

    expect(result.stats).toMatchObject({ total: 3, matched: 2, incomplete: 1, noMatch: 0 });
    expect(result.rows[1]?.binding).toBe('未完成');
    expect(result.rows[1]?.issues[0]?.code).toBe('SEARCH_FAILED');
    expect(result.rows[0]?.binding).toBe('命中');
    expect(result.rows[2]?.binding).toBe('命中');
  });

  it('未命中短路：患者没绑定上就不再取诊断与就诊', async () => {
    const fake = createFakeCdr({
      patients: [{ id: 'pat-1', identifiers: [{ system: SYSTEM, value: 'REG-0001' }] }],
      conditions: [{ patientId: 'pat-1' }],
      encounters: [{ patientId: 'pat-1' }],
    });
    const client = clientWith(fake.fetch);

    const result = await lookupRows(
      [
        { rowNumber: 2, registryId: 'REG-0001' },
        { rowNumber: 3, registryId: 'REG-404' },
      ],
      client,
    );

    // 并发下各行的请求会交错，按资源类型分组看每段发了几次才对
    const paths = fake.requests.map((request) => new URL(request.url).pathname);
    const patientRequests = paths.filter((path) => path === '/fhir/R4/Patient');
    const conditionRequests = fake.requests.filter(
      (request) => new URL(request.url).pathname === '/fhir/R4/Condition',
    );
    const encounterRequests = fake.requests.filter(
      (request) => new URL(request.url).pathname === '/fhir/R4/Encounter',
    );

    // 两行各发了一次患者检索；诊断与就诊只按命中行取回的那位患者检索
    expect(patientRequests).toHaveLength(2);
    expect(conditionRequests).toHaveLength(1);
    expect(encounterRequests).toHaveLength(1);
    expect(new URL(conditionRequests[0]?.url ?? '').searchParams.get('subject')).toBe('Patient/pat-1');
    expect(new URL(encounterRequests[0]?.url ?? '').searchParams.get('patient')).toBe('Patient/pat-1');
    expect(result.rows[1]?.binding).toBe('零命中');
    expect(result.rows[1]?.conditions).toHaveLength(0);
  });

  it('三段取数顺序固定：患者 → 诊断 → 就诊', async () => {
    const fake = createFakeCdr({
      patients: [{ id: 'pat-1', identifiers: [{ system: SYSTEM, value: 'REG-0001' }] }],
      conditions: [{ patientId: 'pat-1', code: 'M8500/3' }],
      encounters: [{ patientId: 'pat-1', periodStart: '2024-03-05T08:00:00+08:00' }],
    });
    const client = clientWith(fake.fetch);

    await lookupRows([{ rowNumber: 2, registryId: 'REG-0001' }], client);

    expect(fake.requests.map((request) => new URL(request.url).pathname)).toEqual([
      '/fhir/R4/Patient',
      '/fhir/R4/Condition',
      '/fhir/R4/Encounter',
    ]);
  });

  it('本批检索参数串：唯一登记号 + 实际检索参数 + 分页页数，且两次运行完全一致', async () => {
    const fake = createFakeCdr({
      patients: [
        { id: 'pat-1', identifiers: [{ system: SYSTEM, value: 'REG-0002' }] },
        { id: 'pat-2', identifiers: [{ system: SYSTEM, value: 'REG-0001' }] },
      ],
      conditions: [{ patientId: 'pat-1', code: 'M8500/3' }],
      encounters: [{ patientId: 'pat-1', periodStart: '2024-03-05T08:00:00+08:00' }],
    });
    const client = clientWith(fake.fetch);
    const rows = [
      { rowNumber: 2, registryId: 'REG-0002' },
      { rowNumber: 3, registryId: 'REG-0001' },
    ];

    const first = await lookupRows(rows, client);
    const second = await lookupRows(rows, client);

    expect(first.searchParams).toBe(second.searchParams);
    // 按登记号排序，与行的先后顺序无关
    const lines = first.searchParams.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]?.startsWith('REG-0001 :: ')).toBe(true);
    expect(lines[1]?.startsWith('REG-0002 :: ')).toBe(true);
    // 参数串里带得出实际检索参数与页数
    expect(lines[0]).toContain('Patient?identifier=');
    expect(lines[0]).toContain('#1');
    expect(first.searchParamEntries.map((entry) => entry.registryId)).toEqual(['REG-0001', 'REG-0002']);
    expect(first.searchParamEntries[0]?.steps.map((step) => step.resourceType)).toEqual([
      'Patient',
      'Condition',
      'Encounter',
    ]);
    // 页地址保留路径 + 查询串，不带主机名
    expect(first.searchParamEntries[0]?.pagePaths[0]).toBe(
      `/fhir/R4/Patient?identifier=${encodeURIComponent(`${SYSTEM}|REG-0001`)}`,
    );
  });

  it('参数串不因同号多行而变长（去重后只有一行一个登记号）', async () => {
    const fake = createFakeCdr({
      patients: [{ id: 'pat-1', identifiers: [{ system: SYSTEM, value: 'REG-0001' }] }],
    });
    const client = clientWith(fake.fetch);

    const result = await lookupRows(
      [
        { rowNumber: 2, registryId: 'REG-0001' },
        { rowNumber: 3, registryId: 'REG-0001' },
        { rowNumber: 4, registryId: 'REG-0001' },
      ],
      client,
    );

    expect(result.searchParams.split('\n')).toHaveLength(1);
    expect(result.dedup.uniqueRegistryIds).toBe(1);
    expect(result.dedup.reusedRows).toBe(2);
  });
});
