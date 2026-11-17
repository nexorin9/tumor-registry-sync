import { describe, expect, it } from 'vitest';

import { FhirClient } from '../../src/fhir/client.js';
import { FhirRequestError } from '../../src/fhir/errors.js';
import { fetchAllPages, nextLinkOf } from '../../src/fhir/pagination.js';
import { createFakeCdr } from '../fakes/fake-cdr.js';

function clientWith(fetchImpl: (input: string, init?: RequestInit) => Promise<Response>) {
  return new FhirClient({
    baseUrl: 'http://cdr.test',
    apiToken: 'test-token',
    identifierSystem: 'urn:oid:2.16.156.10011.0.1',
    fetchImpl,
  });
}

describe('Bundle 分页', () => {
  it('按 link[relation=next] 逐页取完', async () => {
    const fake = createFakeCdr({
      patients: [{ id: 'pat-1' }, { id: 'pat-2' }, { id: 'pat-3' }],
      pageSize: 1,
    });
    const client = clientWith(fake.fetch);

    const result = await fetchAllPages(client, 'Patient', {});

    expect(result.pageCount).toBe(3);
    expect(result.resources).toHaveLength(3);
    expect(result.pageUrls).toHaveLength(3);
    expect(result.pageUrls[1]).toContain('_page=2');
  });

  it('没有 next 链接时正常收尾', async () => {
    const fake = createFakeCdr({ patients: [{ id: 'pat-1' }], pageSize: 10 });
    const client = clientWith(fake.fetch);

    const result = await fetchAllPages(client, 'Patient', {});

    expect(result.pageCount).toBe(1);
    expect(result.resources).toHaveLength(1);
  });

  it('分页链接指回自己时报错（不打环）', async () => {
    const client = clientWith(async () =>
      new Response(
        JSON.stringify({
          resourceType: 'Bundle',
          link: [{ relation: 'next', url: 'http://cdr.test/fhir/R4/Patient?_page=1' }],
          entry: [],
        }),
        { status: 200, headers: { 'content-type': 'application/fhir+json' } },
      ),
    );

    const error = await fetchAllPages(client, 'Patient', { identifier: 'sys|pat-1' }).catch(
      (e) => e,
    );

    expect(error).toBeInstanceOf(FhirRequestError);
    expect((error as FhirRequestError).message).toContain('重复的分页链接');
  });

  it('超过页数上限时报错，不闷头刷', async () => {
    const fake = createFakeCdr({
      patients: [{ id: 'pat-1' }, { id: 'pat-2' }, { id: 'pat-3' }],
      pageSize: 1,
    });
    const client = clientWith(fake.fetch);

    const error = await fetchAllPages(client, 'Patient', {}, {
      maxPages: 2,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(FhirRequestError);
    expect((error as FhirRequestError).message).toContain('超过 2 页');
  });

  it('next 链接为空时报错', () => {
    expect(() => nextLinkOf({ link: [{ relation: 'next', url: '  ' }] })).toThrow(
      /空的 next 分页链接/,
    );
    expect(nextLinkOf({ link: [{ relation: 'self', url: 'http://cdr.test/x' }] })).toBeNull();
  });
});
