/**
 * Bundle 分页取完。
 *
 * 院内 FHIR 服务按页返回，一个登记号可能对应多页（诊断多、就诊多）。
 * 这一层负责**把页取完**，并且守住两条线：
 * - **不打环**：同一页地址不取第二次；服务端把 next 指回自己时立即报错
 * - **不无限翻**：超过页数上限（默认 50 页）显式报错，不闷头刷
 *
 * 取完后的资源按页顺序合并，页地址原样保留，供批次检索参数串复现。
 */
import { FhirRequestError } from './errors.js';
import type { FhirClient } from './client.js';
import type { SearchParams } from './params.js';
import type { FhirBundle, FhirResource, FhirResourceType } from './types.js';

/** 默认页数上限。 */
export const DEFAULT_MAX_PAGES = 50;

/** 取完的结果。 */
export interface FetchedResources {
  /** 合并后的资源（按页顺序） */
  resources: FhirResource[];
  /** 实际取过的页数 */
  pageCount: number;
  /** 实际取过的页地址（原样保留，供复现） */
  pageUrls: string[];
}

/** 取下一页的链接。 */
export function nextLinkOf(bundle: FhirBundle): string | null {
  for (const link of bundle.link ?? []) {
    if (link.relation === 'next') {
      const url = (link.url ?? '').trim();
      if (url.length === 0) {
        throw new FhirRequestError({
          code: 'bad_payload',
          retryable: false,
          message: '院内 FHIR 服务返回了空的 next 分页链接',
          userHint: '该分页链接无法跟随，本批已中止，请联系信息科核对院内 FHIR 网关配置',
        });
      }
      return url;
    }
  }
  return null;
}

/**
 * 按分页取完某次检索的全部资源。
 *
 * @param client 院内 FHIR 客户端
 * @param resourceType 资源类型
 * @param params 检索参数
 * @param options 页数上限等选项
 */
export async function fetchAllPages(
  client: FhirClient,
  resourceType: FhirResourceType,
  params: SearchParams,
  options: { maxPages?: number } = {},
): Promise<FetchedResources> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const visited = new Set<string>();
  const resources: FhirResource[] = [];
  const pageUrls: string[] = [];
  let url: string = client.searchUrl(resourceType, params);
  let pageCount = 0;

  for (;;) {
    if (visited.has(url)) {
      throw new FhirRequestError({
        code: 'invalid_request',
        retryable: false,
        message: `院内 FHIR 服务返回了重复的分页链接（${url}），已中止`,
        userHint: '为避免无限打环已中止本批，请联系信息科核对院内 FHIR 分页配置',
      });
    }
    visited.add(url);

    pageCount += 1;
    if (pageCount > maxPages) {
      throw new FhirRequestError({
        code: 'invalid_request',
        retryable: false,
        message: `院内 FHIR 分页超过 ${maxPages} 页，已中止`,
        userHint: '请缩小检索范围（核对登记号与检索条件）后重跑',
      });
    }

    const bundle: FhirBundle = await client.fetchPage(url);
    pageUrls.push(url);
    for (const entry of bundle.entry ?? []) {
      if (entry.resource) resources.push(entry.resource);
    }

    const next = nextLinkOf(bundle);
    if (next === null) break;
    url = next;
  }

  return { resources, pageCount, pageUrls };
}
