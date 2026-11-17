import { describe, expect, it } from 'vitest';

import { FhirClient } from '../../src/fhir/client.js';
import { FhirRequestError } from '../../src/fhir/errors.js';
import { createFakeCdr } from '../fakes/fake-cdr.js';

function clientWith(fetchImpl: (input: string, init?: RequestInit) => Promise<Response>, timeoutMs = 200) {
  return new FhirClient({
    baseUrl: 'http://cdr.test',
    apiToken: 'test-token',
    identifierSystem: 'urn:oid:2.16.156.10011.0.1',
    timeoutMs,
    fetchImpl,
  });
}

describe('院内 FHIR 客户端', () => {
  it('请求带 Bearer 令牌与 FHIR Accept 头', async () => {
    const fake = createFakeCdr({ patients: [{ id: 'pat-1' }] });
    const client = clientWith(fake.fetch);

    await client.searchPage('Patient', { identifier: 'urn:oid:2.16.156.10011.0.1|pat-1' });

    expect(fake.requests).toHaveLength(1);
    const request = fake.requests[0];
    expect(request?.method).toBe('GET');
    expect(request?.headers['authorization']).toBe('Bearer test-token');
    expect(request?.headers['accept']).toBe('application/fhir+json');
    expect(request?.url).toBe(
      'http://cdr.test/fhir/R4/Patient?identifier=urn%3Aoid%3A2.16.156.10011.0.1%7Cpat-1',
    );
  });

  it('401 终止并点名 CDR_API_TOKEN', async () => {
    const fake = createFakeCdr({ faults: [{ kind: '401' }] });
    const client = clientWith(fake.fetch);

    const error = await client.searchPage('Patient', { identifier: 'sys|pat-1' }).catch((e) => e);

    expect(error).toBeInstanceOf(FhirRequestError);
    expect((error as FhirRequestError).code).toBe('auth_failed');
    expect((error as FhirRequestError).retryable).toBe(false);
    expect((error as FhirRequestError).userHint).toContain('CDR_API_TOKEN');
    expect((error as FhirRequestError).httpStatus).toBe(401);
  });

  it('403 指名 CDR_API_TOKEN 与 CDR_BASE_URL', async () => {
    const fake = createFakeCdr({ faults: [{ kind: '403' }] });
    const client = clientWith(fake.fetch);

    const error = await client.searchPage('Patient', { identifier: 'sys|pat-1' }).catch((e) => e);

    expect((error as FhirRequestError).code).toBe('forbidden');
    expect((error as FhirRequestError).userHint).toContain('CDR_API_TOKEN');
    expect((error as FhirRequestError).userHint).toContain('CDR_BASE_URL');
  });

  it('404 归为 not_found（上层映射零命中）', async () => {
    const fake = createFakeCdr({ faults: [{ kind: '404' }] });
    const client = clientWith(fake.fetch);

    const error = await client.searchPage('Patient', { identifier: 'sys|pat-1' }).catch((e) => e);

    expect((error as FhirRequestError).code).toBe('not_found');
    expect((error as FhirRequestError).userHint).toContain('零命中');
  });

  it('5xx 归为可重试的服务端错误', async () => {
    const fake = createFakeCdr({ faults: [{ kind: '500' }] });
    const client = clientWith(fake.fetch);

    const error = await client.searchPage('Patient', { identifier: 'sys|pat-1' }).catch((e) => e);

    expect((error as FhirRequestError).code).toBe('server_error');
    expect((error as FhirRequestError).retryable).toBe(true);
  });

  it('429 归为可重试的限流', async () => {
    const fake = createFakeCdr({ faults: [{ kind: '429' }] });
    const client = clientWith(fake.fetch);

    const error = await client.searchPage('Patient', { identifier: 'sys|pat-1' }).catch((e) => e);

    expect((error as FhirRequestError).code).toBe('rate_limited');
    expect((error as FhirRequestError).retryable).toBe(true);
  });

  it('非 JSON 响应显式报坏响应', async () => {
    const fake = createFakeCdr({ faults: [{ kind: 'non-json' }] });
    const client = clientWith(fake.fetch);

    const error = await client.searchPage('Patient', { identifier: 'sys|pat-1' }).catch((e) => e);

    expect((error as FhirRequestError).code).toBe('bad_payload');
    expect((error as FhirRequestError).retryable).toBe(false);
    expect((error as FhirRequestError).userHint).toContain('FHIR R4');
  });

  it('超时归为可重试的 timeout', async () => {
    const fake = createFakeCdr({ faults: [{ kind: 'timeout' }] });
    const client = clientWith(fake.fetch, 50);

    const error = await client.searchPage('Patient', { identifier: 'sys|pat-1' }).catch((e) => e);

    expect((error as FhirRequestError).code).toBe('timeout');
    expect((error as FhirRequestError).retryable).toBe(true);
  });

  it('跨源的分页链接被拒绝（防令牌外泄）', async () => {
    const client = clientWith(async () =>
      new Response(
        JSON.stringify({
          resourceType: 'Bundle',
          link: [{ relation: 'next', url: 'http://other-host/fhir/R4/Patient?_page=2' }],
          entry: [],
        }),
        { status: 200, headers: { 'content-type': 'application/fhir+json' } },
      ),
    );

    const error = await client.fetchPage('http://other-host/fhir/R4/Patient?_page=2').catch((e) => e);

    expect(error).toBeInstanceOf(FhirRequestError);
    expect((error as FhirRequestError).code).toBe('invalid_request');
    expect((error as FhirRequestError).message).toContain('跨源');
  });

  it('searchUrl 可原样重建实际请求（供批次检索参数串复现）', () => {
    const client = clientWith(async () => new Response('{}'));
    expect(client.searchUrl('Patient', { identifier: 'sys|REG-0001' })).toBe(
      'http://cdr.test/fhir/R4/Patient?identifier=sys%7CREG-0001',
    );
  });
});
