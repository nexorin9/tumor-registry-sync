/**
 * 替身自测（task 13）。
 *
 * 验证：
 * 1. 假 CDR 按 identifier 返回患者 Bundle，未知 identifier 返回空 Bundle（零命中）
 * 2. 假 CDR 按患者引用返回 Condition / Encounter
 * 3. 假专病库接受 POST 入库，且相同 Idempotency-Key 重复 POST 只入库一次（幂等去重）
 * 4. 故障注入路径：cdr auth→401、cdr serverError→500、registry auth→401、registry serverError→500
 * 5. 边界断言：产品 src/ 不得引用 tests/fakes（替身只在测试层）
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { FhirClient } from '../../src/fhir/client.js';
import {
  conditionByPatientParams,
  encounterByPatientParams,
  patientByIdentifierParams,
} from '../../src/fhir/params.js';

import { type FakeCdrRecord } from './fake-cdr.js';
import { startHarness, stopHarness, envForHarness, type Harness } from './harness.js';

const RECORDS: FakeCdrRecord[] = [
  {
    patient: { id: 'PT-001', identifier: 'PT-001', birthDate: '1968-04-12', sex: 'female' },
    conditions: [
      { code: 'C50.9', onsetDateTime: '2024-03-01T00:00:00+08:00', stage: 'IIIB' },
      { code: 'C34.9', onsetDateTime: '2023-11-20T00:00:00+08:00', stage: 'II' },
    ],
    encounters: [
      { periodStart: '2024-03-02', periodEnd: '2024-03-10', class: 'inpatient', type: '化学治疗' },
    ],
  },
  {
    patient: { id: 'PT-002', identifier: 'PT-002', birthDate: null, sex: null },
    conditions: [],
    encounters: [],
  },
];

/** 跑完测试统一回收替身，避免端口/句柄泄漏。 */
const open: Harness[] = [];
afterEach(async () => {
  while (open.length > 0) {
    const h = open.pop();
    if (h) await stopHarness(h);
  }
});

async function freshHarness(opts?: Parameters<typeof startHarness>[1]): Promise<Harness> {
  const h = await startHarness(RECORDS, opts);
  open.push(h);
  return h;
}

describe('fake CDR: read path', () => {
  it('serves a Patient by identifier as a 200 Bundle with an entry', async () => {
    const h = await freshHarness();
    const client = new FhirClient({
      baseUrl: h.cdrBaseUrl,
      apiToken: 'test-token',
      identifierSystem: 'urn:oid:1.2.3',
    });

    const bundle = await client.searchPage('Patient', patientByIdentifierParams('urn:oid:1.2.3', 'PT-001'));

    expect(bundle.resourceType).toBe('Bundle');
    expect(bundle.entry ?? []).toHaveLength(1);
    expect(bundle.entry?.[0]?.resource?.resourceType).toBe('Patient');
    expect(bundle.entry?.[0]?.resource?.id).toBe('PT-001');
    expect(bundle.entry?.[0]?.resource?.identifier?.[0]?.value).toBe('PT-001');
    expect(h.cdr.requests.some((r) => r.url.includes('/fhir/R4/Patient'))).toBe(true);
  });

  it('returns an empty Bundle (zero match) for an unknown identifier', async () => {
    const h = await freshHarness();
    const client = new FhirClient({
      baseUrl: h.cdrBaseUrl,
      apiToken: 'test-token',
      identifierSystem: 'urn:oid:1.2.3',
    });

    const bundle = await client.searchPage('Patient', patientByIdentifierParams('urn:oid:1.2.3', 'NOBODY'));
    expect(bundle.entry ?? []).toHaveLength(0);
  });

  it('serves Condition and Encounter by patient reference', async () => {
    const h = await freshHarness();
    const client = new FhirClient({
      baseUrl: h.cdrBaseUrl,
      apiToken: 'test-token',
      identifierSystem: 'urn:oid:1.2.3',
    });

    const conditions = await client.searchPage('Condition', conditionByPatientParams('PT-001'));
    expect(conditions.entry ?? []).toHaveLength(2);
    expect(conditions.entry?.[0]?.resource?.subject?.reference).toBe('Patient/PT-001');

    const encounters = await client.searchPage('Encounter', encounterByPatientParams('PT-001'));
    expect(encounters.entry ?? []).toHaveLength(1);
    expect(encounters.entry?.[0]?.resource?.period?.start).toBe('2024-03-02');
  });

  it('records every incoming request', async () => {
    const h = await freshHarness();
    const client = new FhirClient({
      baseUrl: h.cdrBaseUrl,
      apiToken: 'test-token',
      identifierSystem: 'urn:oid:1.2.3',
    });
    await client.searchPage('Patient', patientByIdentifierParams('urn:oid:1.2.3', 'PT-001'));
    expect(h.cdr.requests.length).toBeGreaterThanOrEqual(1);
    expect(h.cdr.requests[0]?.method).toBe('GET');
  });
});

describe('fake CDR: fault injection', () => {
  it("'auth' fault → 401", async () => {
    const h = await freshHarness({ cdrFault: 'auth' });
    const res = await fetch(`${h.cdrBaseUrl}/fhir/R4/Patient?identifier=urn:oid:1.2.3|PT-001`);
    expect(res.status).toBe(401);
  });

  it("'serverError' fault → 500", async () => {
    const h = await freshHarness({ cdrFault: 'serverError' });
    const res = await fetch(`${h.cdrBaseUrl}/fhir/R4/Patient?identifier=urn:oid:1.2.3|PT-001`);
    expect(res.status).toBe(500);
  });

  it("'notFound' fault → empty Bundle (zero match, not an error)", async () => {
    const h = await freshHarness({ cdrFault: 'notFound' });
    const res = await fetch(`${h.cdrBaseUrl}/fhir/R4/Patient?identifier=urn:oid:1.2.3|PT-001`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entry?: unknown[] };
    expect(body.entry ?? []).toHaveLength(0);
  });
});

describe('fake registry: write path', () => {
  it('accepts a POST and stores it', async () => {
    const h = await freshHarness();
    const res = await fetch(`${h.registryBaseUrl}/api/v1/registry-entries`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer reg-token',
        'Idempotency-Key': 'idem-1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ identifier: { system: 'urn:oid:1.2.3', value: 'PT-001' } }),
    });

    expect(res.status).toBe(201);
    expect(h.registry.storedCount).toBe(1);
    expect(h.registry.dedupeKeys.has('idem-1')).toBe(true);
    expect(h.registry.received).toHaveLength(1);
    expect(h.registry.received[0]?.idempotencyKey).toBe('idem-1');
  });

  it('dedupes by Idempotency-Key: same key twice → storedCount increments once', async () => {
    const h = await freshHarness();
    const post = (key: string) =>
      fetch(`${h.registryBaseUrl}/api/v1/registry-entries`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer reg-token',
          'Idempotency-Key': key,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ identifier: { value: 'PT-001' } }),
      });

    const first = await post('idem-dup');
    const second = await post('idem-dup');

    expect(first.status).toBe(201);
    expect(second.status).toBe(200); // 幂等重放，返回同一份条目
    expect(h.registry.storedCount).toBe(1);
    expect(h.registry.received).toHaveLength(2);
  });
});

describe('fake registry: fault injection', () => {
  it("'auth' fault → 401", async () => {
    const h = await freshHarness({ registryFault: 'auth' });
    const res = await fetch(`${h.registryBaseUrl}/api/v1/registry-entries`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it("'serverError' fault → 500", async () => {
    const h = await freshHarness({ registryFault: 'serverError' });
    const res = await fetch(`${h.registryBaseUrl}/api/v1/registry-entries`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k', 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(500);
  });
});

describe('harness env injection', () => {
  it('envForHarness exposes CDR/REGISTRY vars and optional model vars', async () => {
    const h = await freshHarness();
    const env = envForHarness(h);
    expect(env['CDR_BASE_URL']).toBe(h.cdrBaseUrl);
    expect(env['CDR_API_TOKEN']).toBe('test-token');
    expect(env['CDR_IDENTIFIER_SYSTEM']).toBe('urn:oid:1.2.3');
    expect(env['REGISTRY_BASE_URL']).toBe(h.registryBaseUrl);
    expect(env['REGISTRY_API_TOKEN']).toBe('reg-token');

    const envWithModel = envForHarness(h, 'http://model.test');
    expect(envWithModel['MODEL_BASE_URL']).toBe('http://model.test');
    expect(envWithModel['MODEL_API_KEY']).toBe('model-test-key');
    expect(envWithModel['MODEL_NAME']).toBe('test-model');
  });
});

describe('boundary: product src must not import tests/fakes', () => {
  it('no src file references tests/fakes', () => {
    const srcRoot = path.resolve(__dirname, '../../src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.ts')) {
          const content = fs.readFileSync(full, 'utf8');
          if (content.includes('tests/fakes')) offenders.push(full);
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});
