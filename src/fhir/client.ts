/**
 * 院内 FHIR R4 只读客户端。
 *
 * 这是本产品与院内权威记录之间**唯一的出站读取口**：所有取数都从这里走，
 * 凭据只从环境变量来（`CDR_API_TOKEN`），代码里不出现任何真实地址或令牌。
 *
 * 三条硬规矩：
 * - **同源**：拼出来的地址必须与 CDR_BASE_URL 同源。分页链接是服务端给的，
 *   万一指向别的机器（代理改写、错误配置），宁可报错也不把 Bearer 令牌发过去。
 * - **错误不吞**：401/403 终止并点名环境变量，404 交由上层映射零命中，
 *   超时与 5xx 标成可重试，非 JSON 显式报「坏响应」。
 * - **可复现**：每次实际发出的地址都能从 `searchUrl()` 原样重建，
 *   本批检索参数串据此拼装，登记员下次能照着同一串参数复现。
 */
import { buildSearchPath, dateRangeParams, type SearchParams } from './params.js';
import { classifyHttpStatus, FhirRequestError } from './errors.js';
import type { FhirBundle, FhirResourceType } from './types.js';

/** fetch 替身：测试层用假 CDR 顶替，签名与全局 fetch 一致。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** 检索超时默认值（毫秒）。 */
export const DEFAULT_FHIR_TIMEOUT_MS = 15_000;

/** 客户端配置。 */
export interface FhirClientOptions {
  /** 院内 FHIR 服务基地址（不带结尾斜杠） */
  baseUrl: string;
  /** Bearer 令牌（来自 CDR_API_TOKEN） */
  apiToken: string;
  /** 登记主索引的 identifier system（来自 CDR_IDENTIFIER_SYSTEM） */
  identifierSystem: string;
  /** 单次请求超时（毫秒） */
  timeoutMs?: number;
  /** fetch 实现；缺省用全局 fetch */
  fetchImpl?: FetchLike;
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

/** 院内 FHIR R4 只读客户端。 */
export class FhirClient {
  /** 院内 FHIR 服务基地址 */
  readonly baseUrl: string;
  /** 登记主索引的 identifier system */
  readonly identifierSystem: string;
  /** 单次请求超时（毫秒） */
  readonly timeoutMs: number;

  private readonly apiToken: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: FhirClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiToken = options.apiToken;
    this.identifierSystem = options.identifierSystem;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_FHIR_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  /** 拼出实际会发出的检索地址（可原样复现，批次检索参数串据此拼装）。 */
  searchUrl(resourceType: FhirResourceType, params: SearchParams): string {
    return `${this.baseUrl}${buildSearchPath(resourceType, params)}`;
  }

  /** 检索一页（分页由 pagination.ts 负责）。 */
  async searchPage(
    resourceType: FhirResourceType,
    params: SearchParams,
  ): Promise<FhirBundle> {
    return this.fetchPage(this.searchUrl(resourceType, params));
  }

  /**
   * 取一页 Bundle。
   *
   * 地址必须与基地址同源；服务端返回的分页链接若跨源，这里直接报错，
   * 避免把 Bearer 令牌发到别处。
   */
  async fetchPage(url: string): Promise<FhirBundle> {
    this.assertSameOrigin(url);

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${this.apiToken}`,
          accept: 'application/fhir+json',
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new FhirRequestError({
          code: 'timeout',
          retryable: true,
          message: `检索院内 FHIR 资源超时（${this.timeoutMs} ms）`,
          userHint: '院内 FHIR 服务未在超时时间内响应，可稍后重跑本批',
          cause: error,
        });
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new FhirRequestError({
        code: 'unknown',
        retryable: true,
        message: `连接院内 FHIR 服务失败：${message}`,
        userHint:
          '请检查 CDR_BASE_URL 是否指向正确的院内 FHIR R4 服务，以及本机到院内网络的连通性',
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const classified = classifyHttpStatus(response.status);
      throw new FhirRequestError({
        code: classified.code,
        retryable: classified.retryable,
        message: `院内 FHIR 服务返回状态码 ${response.status}`,
        userHint: classified.userHint,
        httpStatus: response.status,
      });
    }

    const text = await response.text();
    try {
      return JSON.parse(text) as FhirBundle;
    } catch (error) {
      throw new FhirRequestError({
        code: 'bad_payload',
        retryable: false,
        message: '院内 FHIR 服务返回的不是合法 JSON',
        userHint:
          '请确认 CDR_BASE_URL 指向的是 FHIR R4 服务（返回 application/fhir+json），而不是门户页或代理错误页',
        httpStatus: response.status,
        cause: error,
      });
    }
  }

  /**
   * 按诊断编码 + 时间窗检索院内 Condition，返回命中的患者登记号集合。
   *
   * 用于「缺行检查」反向 diff：先取院内满足口径的患者集合，再与本表登记号集合
   * 求差，找出院内命中但本表缺登记的行。只取 `subject.reference` 里 `Patient/`
   * 之后的登记号 token（按 `/` 切分取末段），去重后作为命中集合返回。
   *
   * 分页沿服务端给的 `link[relation=next]` 一路翻页；下一页地址同样受同源约束，
   * 跨源链接由 `assertSameOrigin` 拦下。检索失败（超时/5xx/非 JSON）原样抛出，
   * 由上层判为「本轮缺行检查未完成」，绝不谎报成零缺行。
   */
  async searchConditionsByCode(params: {
    code: string;
    from?: string;
    to?: string;
  }): Promise<{ registryIds: string[]; raw: unknown[] }> {
    const searchParams: SearchParams = { code: params.code };
    if (params.from !== undefined || params.to !== undefined) {
      const range = dateRangeParams('date', params.from ?? null, params.to ?? null);
      Object.assign(searchParams, range);
    }

    let url: string | null = this.searchUrl('Condition', searchParams);
    const matched = new Set<string>();
    const raw: unknown[] = [];

    while (url !== null) {
      const bundle = await this.fetchPage(url);
      const entries = bundle.entry ?? [];
      for (const entry of entries) {
        const resource = entry?.resource;
        if (resource && resource.resourceType === 'Condition') {
          raw.push(resource);
          const ref = resource.subject?.reference;
          if (typeof ref === 'string') {
            const token = ref.split('/').pop();
            if (token && token.length > 0) matched.add(token);
          }
        }
      }
      const next = bundle.link?.find(
        (link) => link.relation === 'next' && typeof link.url === 'string',
      );
      url = next?.url ?? null;
    }

    return { registryIds: [...matched], raw };
  }

  /** 地址必须与基地址同源：跨源地址一律拒绝，防令牌外泄。 */
  private assertSameOrigin(url: string): void {
    let target: URL;
    let base: URL;
    try {
      target = new URL(url);
      base = new URL(this.baseUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new FhirRequestError({
        code: 'invalid_request',
        retryable: false,
        message: `检索地址不是合法 URL：${message}`,
        userHint: '请检查 CDR_BASE_URL 配置是否为完整地址',
        cause: error,
      });
    }
    if (target.origin !== base.origin) {
      throw new FhirRequestError({
        code: 'invalid_request',
        retryable: false,
        message: `检索地址跨源（${target.origin} ≠ ${base.origin}），已中止`,
        userHint:
          '服务端返回的分页链接指向了另一个站点：已中止以免把访问令牌发到别处，请检查 CDR_BASE_URL 与院内网关配置',
      });
    }
  }
}
