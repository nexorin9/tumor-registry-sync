/**
 * 假 CDR（仅测试层）。
 *
 * 这是本产品与院内权威记录之间**唯一的出站读取口** `src/fhir/client.ts` 的替身：
 * 它起一个真的本地 HTTP 服务（`node:http`），所以生产代码用 `globalThis.fetch`
 * 就能无改动地打到它。替身只在 `tests/` 内使用，`src/` 不得引用本文件。
 *
 * 复现的检索链路：
 * - `GET {baseUrl}/fhir/R4/Patient?identifier={system}|{value}`
 * - `GET {baseUrl}/fhir/R4/Condition?subject=Patient/{id}`
 * - `GET {baseUrl}/fhir/R4/Encounter?patient={id}`
 * 每条都返回 FHIR R4 searchset Bundle，分页靠 `Bundle.link[relation=next]`。
 *
 * 可注入的故障（通过 `FakeCdrOptions.fault`）：
 * 'auth'(401) / 'forbidden'(403) / 'notFound'(空 Bundle，零命中，非错误) /
 * 'serverError'(500) / 'timeout'(挂起不响应) / 'badJson'(200 但非 JSON 体)。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeCdrFault =
  | 'none'
  | 'auth'
  | 'forbidden'
  | 'notFound'
  | 'serverError'
  | 'timeout'
  | 'badJson';

export interface FakeCdrOptions {
  /** 监听端口（harness 用 node:net 找出的空闲端口） */
  port: number;
  /** 故障注入类型，默认 'none' */
  fault?: FakeCdrFault;
}

export interface FakeCdrRecord {
  patient: {
    id: string;
    identifier: string;
    birthDate: string | null;
    sex: string | null;
  };
  conditions: {
    code: string | null;
    onsetDateTime: string | null;
    stage: string | null;
  }[];
  encounters: {
    periodStart: string | null;
    periodEnd: string | null;
    class: string | null;
    type: string | null;
  }[];
}

export interface FakeCdrRequest {
  method: string;
  url: string;
  /** 仅部分场景填充（真实 HTTP 服务会带；内存 mock 也会带调用方头）。 */
  headers?: Record<string, string>;
}

/** FHIR R4 假 CDR。 */
export class FakeCdr {
  /** 已收到的请求（按到达顺序） */
  readonly requests: FakeCdrRequest[] = [];
  /** 服务基地址（不含 /fhir/R4），`start()` 后可用 */
  url = '';

  private readonly records: FakeCdrRecord[];
  private readonly options: FakeCdrOptions;
  private server: Server | null = null;

  constructor(records: FakeCdrRecord[], options: FakeCdrOptions) {
    this.records = records;
    this.options = options;
  }

  /** 启动本地 HTTP 服务。 */
  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      const server = this.server as Server;
      server.once('error', reject);
      server.listen(this.options.port, '127.0.0.1', () => resolve());
    });
    this.url = `http://127.0.0.1:${this.options.port}`;
  }

  /** 停止本地 HTTP 服务。 */
  async stop(): Promise<void> {
    if (this.server === null) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const rawUrl = `http://127.0.0.1:${this.options.port}${req.url ?? '/'}`;
    this.requests.push({ method: req.method ?? 'GET', url: rawUrl });

    const fault: FakeCdrFault = this.options.fault ?? 'none';
    if (fault !== 'none') {
      switch (fault) {
        case 'auth':
          this.respond(res, 401, 'text/plain', 'unauthorized');
          return;
        case 'forbidden':
          this.respond(res, 403, 'text/plain', 'forbidden');
          return;
        case 'serverError':
          this.respond(res, 500, 'text/plain', 'server error');
          return;
        case 'badJson':
          // 200 但返回非 JSON 体，触发客户端 bad_payload
          this.respond(res, 200, 'text/html', '<html>not a fhir bundle</html>');
          return;
        case 'timeout':
          // 故意挂起不响应：依赖客户端超时（AbortController）来中断
          return;
        case 'notFound':
          // 零命中：返回空 Bundle，这不是错误
          this.sendBundle(res, []);
          return;
      }
    }

    const parsed = new URL(rawUrl);
    const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
    const resourceType = segments[segments.length - 1] ?? '';
    const entries = this.matchResources(resourceType, parsed);
    this.sendBundle(res, entries);
  }

  /** 按资源类型与查询参数取数，返回 FHIR 资源数组。 */
  private matchResources(resourceType: string, parsed: URL): unknown[] {
    if (resourceType === 'Patient') {
      const token = parsed.searchParams.get('identifier');
      const value = token === null ? null : token.split('|')[1] ?? null;
      if (value === null) return [];
      const record = this.records.find((r) => r.patient.identifier === value);
      return record === undefined ? [] : [this.patientResource(record)];
    }

    if (resourceType === 'Condition') {
      const subject = parsed.searchParams.get('subject') ?? '';
      const patientId = subject.startsWith('Patient/') ? subject.slice('Patient/'.length) : '';
      const record = this.records.find((r) => r.patient.id === patientId);
      if (record === undefined) return [];
      return record.conditions.map((cond, index) => this.conditionResource(record.patient.id, cond, index));
    }

    if (resourceType === 'Encounter') {
      const patient = parsed.searchParams.get('patient') ?? '';
      const patientId = patient.startsWith('Patient/') ? patient.slice('Patient/'.length) : '';
      const record = this.records.find((r) => r.patient.id === patientId);
      if (record === undefined) return [];
      return record.encounters.map((enc, index) => this.encounterResource(record.patient.id, enc, index));
    }

    return [];
  }

  private patientResource(record: FakeCdrRecord): Record<string, unknown> {
    const resource: Record<string, unknown> = {
      resourceType: 'Patient',
      id: record.patient.id,
      identifier: [{ system: 'urn:oid:1.2.3', value: record.patient.identifier }],
    };
    if (record.patient.birthDate !== null) resource['birthDate'] = record.patient.birthDate;
    if (record.patient.sex !== null) resource['gender'] = record.patient.sex;
    return resource;
  }

  private conditionResource(
    patientId: string,
    cond: FakeCdrRecord['conditions'][number],
    index: number,
  ): Record<string, unknown> {
    const resource: Record<string, unknown> = {
      resourceType: 'Condition',
      id: `cond-${patientId}-${index}`,
      subject: { reference: `Patient/${patientId}` },
    };
    if (cond.code !== null) resource['code'] = { text: cond.code };
    if (cond.onsetDateTime !== null) resource['onsetDateTime'] = cond.onsetDateTime;
    if (cond.stage !== null) resource['stage'] = { text: cond.stage };
    return resource;
  }

  private encounterResource(
    patientId: string,
    enc: FakeCdrRecord['encounters'][number],
    index: number,
  ): Record<string, unknown> {
    const resource: Record<string, unknown> = {
      resourceType: 'Encounter',
      id: `enc-${patientId}-${index}`,
      subject: { reference: `Patient/${patientId}` },
    };
    const period: Record<string, string> = {};
    if (enc.periodStart !== null) period['start'] = enc.periodStart;
    if (enc.periodEnd !== null) period['end'] = enc.periodEnd;
    if (Object.keys(period).length > 0) resource['period'] = period;
    if (enc.class !== null) resource['class'] = { code: enc.class };
    if (enc.type !== null) resource['type'] = { text: enc.type };
    return resource;
  }

  private sendBundle(res: ServerResponse, entries: unknown[]): void {
    const bundle = {
      resourceType: 'Bundle',
      type: 'searchset',
      total: entries.length,
      link: [],
      entry: entries.map((resource) => ({ resource })),
    };
    this.respond(res, 200, 'application/fhir+json', JSON.stringify(bundle));
  }

  private respond(res: ServerResponse, status: number, contentType: string, body: string): void {
    res.writeHead(status, { 'content-type': contentType });
    res.end(body);
  }
}

/**
 * 旧版兼容 API（createFakeCdr / startFakeCdrServer）。
 *
 * 这是 7 个历史测试文件（`tests/fhir/*`、`tests/observability/*`、`tests/sheet/row-issues*`）
 * 依赖的替身契约：一个**内存 fetch mock**（createFakeCdr）与一个**真实 HTTP 服务**
 * （startFakeCdrServer），二者共享同一套请求处理逻辑。与上面的 `FakeCdr` 类（供 harness /
 * fakes.test 使用）互不依赖，互不耦合。
 *
 * 与旧契约完全一致的行为：
 * - Patient 按 identifier 值返回**全部**匹配患者（支持「歧义」= 同一登记号命中多条）
 * - Condition / Encounter 按 `subject=Patient/{id}` / `patient=Patient/{id}` 取数
 * - 分页：支持 `_page` + `pageSize`，超出页数由上层 fetchAllPages 判错
 * - 故障注入：401/403/404/500/429 返回对应状态码；non-json 返回 200 非 JSON；
 *   timeout 挂起不响应（由客户端 AbortController 判超时）
 * - 故障可按登记号定位（`{kind, identifier}`）：仅当请求上下文登记号命中时才触发
 * - 字段缺失：`omitCode` 让 Condition 不输出 code；`omitPeriodStart` 让 Encounter 不输出 period
 */
export interface OldFakePatient {
  id: string;
  identifiers?: Array<{ system: string; value: string }>;
  birthDate?: string | null;
  gender?: string | null;
}

export interface OldFakeCondition {
  patientId: string;
  code?: string | null;
  stage?: string | null;
  onsetDateTime?: string | null;
  omitCode?: boolean;
}

export interface OldFakeEncounter {
  patientId: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  class?: string | null;
  type?: string | null;
  omitPeriodStart?: boolean;
}

export type OldFakeFaultKind = '401' | '403' | '404' | '500' | '429' | 'non-json' | 'timeout';

export interface OldFakeFault {
  kind: OldFakeFaultKind;
  /** 仅当请求上下文登记号等于该值时才触发；缺省则对该资源所有请求生效。 */
  identifier?: string;
}

export interface CreateFakeCdrOptions {
  patients?: OldFakePatient[];
  conditions?: OldFakeCondition[];
  encounters?: OldFakeEncounter[];
  faults?: OldFakeFault[];
  pageSize?: number;
}

export interface FakeCdrHandle {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  requests: FakeCdrRequest[];
  baseUrl: string;
}

export interface FakeCdrServer {
  baseUrl: string;
  requests: FakeCdrRequest[];
  close(): Promise<void>;
}

interface CoreResult {
  status: number;
  contentType: string;
  body: string;
}

function withPageParam(rawUrl: string, page: number): string {
  const url = new URL(rawUrl);
  url.searchParams.set('_page', String(page));
  return url.toString();
}

function buildPatientResource(p: OldFakePatient): Record<string, unknown> {
  const resource: Record<string, unknown> = {
    resourceType: 'Patient',
    id: p.id,
    identifier: (p.identifiers ?? []).map((i) => ({ system: i.system, value: i.value })),
  };
  if (p.birthDate !== undefined && p.birthDate !== null) resource['birthDate'] = p.birthDate;
  if (p.gender !== undefined && p.gender !== null) resource['gender'] = p.gender;
  return resource;
}

function buildConditionResource(patientId: string, c: OldFakeCondition, index: number): Record<string, unknown> {
  const resource: Record<string, unknown> = {
    resourceType: 'Condition',
    id: `cond-${patientId}-${index}`,
    subject: { reference: `Patient/${patientId}` },
  };
  if (!c.omitCode && c.code !== undefined && c.code !== null) resource['code'] = { text: c.code };
  if (c.onsetDateTime !== undefined && c.onsetDateTime !== null) resource['onsetDateTime'] = c.onsetDateTime;
  if (c.stage !== undefined && c.stage !== null) resource['stage'] = { text: c.stage };
  return resource;
}

function buildEncounterResource(patientId: string, e: OldFakeEncounter, index: number): Record<string, unknown> {
  const resource: Record<string, unknown> = {
    resourceType: 'Encounter',
    id: `enc-${patientId}-${index}`,
    subject: { reference: `Patient/${patientId}` },
  };
  if (!e.omitPeriodStart) {
    const period: Record<string, string> = {};
    if (e.periodStart !== undefined && e.periodStart !== null) period['start'] = e.periodStart;
    if (e.periodEnd !== undefined && e.periodEnd !== null) period['end'] = e.periodEnd;
    if (Object.keys(period).length > 0) resource['period'] = period;
  }
  if (e.class !== undefined && e.class !== null) resource['class'] = { code: e.class };
  if (e.type !== undefined && e.type !== null) resource['type'] = { text: e.type };
  return resource;
}

const FAULT_STATUS: Record<Exclude<OldFakeFaultKind, 'non-json' | 'timeout'>, number> = {
  '401': 401,
  '403': 403,
  '404': 404,
  '500': 500,
  '429': 429,
};

function createCore(options: CreateFakeCdrOptions): {
  requests: FakeCdrRequest[];
  handle: (rawUrl: string, method: string, headers: Record<string, string>) => CoreResult | 'hang';
} {
  const requests: FakeCdrRequest[] = [];
  const patients = options.patients ?? [];
  const conditions = options.conditions ?? [];
  const encounters = options.encounters ?? [];
  const faults = options.faults ?? [];
  const pageSize = options.pageSize;

  const registryIdByPatientId = new Map<string, string>();
  for (const p of patients) {
    registryIdByPatientId.set(p.id, p.identifiers?.[0]?.value ?? p.id);
  }

  const conditionsByPatient = new Map<string, OldFakeCondition[]>();
  for (const c of conditions) {
    const arr = conditionsByPatient.get(c.patientId) ?? [];
    arr.push(c);
    conditionsByPatient.set(c.patientId, arr);
  }

  const encountersByPatient = new Map<string, OldFakeEncounter[]>();
  for (const e of encounters) {
    const arr = encountersByPatient.get(e.patientId) ?? [];
    arr.push(e);
    encountersByPatient.set(e.patientId, arr);
  }

  const findFault = (context: string | null): OldFakeFault | undefined =>
    faults.find((f) => f.identifier === undefined || f.identifier === context);

  const handle = (
    rawUrl: string,
    method: string,
    headers: Record<string, string>,
  ): CoreResult | 'hang' => {
    requests.push({ method, url: rawUrl, headers });

    const parsed = new URL(rawUrl);
    const segments = parsed.pathname.split('/').filter((segment) => segment.length > 0);
    const resourceType = segments[segments.length - 1] ?? '';
    const params = parsed.searchParams;

    let context: string | null = null;
    if (resourceType === 'Patient') {
      const idParam = params.get('identifier');
      context = idParam === null ? null : (idParam.split('|')[1] ?? idParam);
    } else if (resourceType === 'Condition') {
      const subject = params.get('subject') ?? '';
      const pid = subject.startsWith('Patient/') ? subject.slice('Patient/'.length) : '';
      context = registryIdByPatientId.get(pid) ?? null;
    } else if (resourceType === 'Encounter') {
      const patient = params.get('patient') ?? '';
      const pid = patient.startsWith('Patient/') ? patient.slice('Patient/'.length) : '';
      context = registryIdByPatientId.get(pid) ?? null;
    }

    const fault = findFault(context);
    if (fault !== undefined) {
      if (fault.kind === 'timeout') return 'hang';
      if (fault.kind === 'non-json') {
        return { status: 200, contentType: 'text/html', body: '<html>not a fhir bundle</html>' };
      }
      const status = FAULT_STATUS[fault.kind];
      return { status, contentType: 'text/plain', body: `fault ${fault.kind}` };
    }

    let entries: unknown[] = [];
    if (resourceType === 'Patient') {
      const idParam = params.get('identifier');
      if (idParam === null) {
        // 不带 identifier 的检索（如分页压力测试）：返回全部患者，再交给分页切片
        entries = patients.map(buildPatientResource);
      } else {
        const token = idParam.split('|')[1] ?? idParam;
        entries = patients
          .filter((p) => (p.identifiers?.[0]?.value ?? p.id) === token)
          .map(buildPatientResource);
      }
    } else if (resourceType === 'Condition') {
      const subject = params.get('subject') ?? '';
      const pid = subject.startsWith('Patient/') ? subject.slice('Patient/'.length) : '';
      entries = (conditionsByPatient.get(pid) ?? []).map((c, i) => buildConditionResource(pid, c, i));
    } else if (resourceType === 'Encounter') {
      const patient = params.get('patient') ?? '';
      const pid = patient.startsWith('Patient/') ? patient.slice('Patient/'.length) : '';
      entries = (encountersByPatient.get(pid) ?? []).map((e, i) => buildEncounterResource(pid, e, i));
    }

    const size = pageSize ?? entries.length;
    const pageRaw = Number(params.get('_page') ?? '1');
    const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
    const start = (page - 1) * size;
    const slice = size === 0 ? [] : entries.slice(start, start + size);
    const totalPages = size === 0 ? 0 : Math.ceil(entries.length / size);
    const link: Array<{ relation: string; url: string }> = [];
    if (page < totalPages) {
      link.push({ relation: 'next', url: withPageParam(rawUrl, page + 1) });
    }

    const bundle = {
      resourceType: 'Bundle',
      type: 'searchset',
      total: entries.length,
      link,
      entry: slice.map((resource) => ({ resource })),
    };
    return { status: 200, contentType: 'application/fhir+json', body: JSON.stringify(bundle) };
  };

  return { requests, handle };
}

/**
 * 内存 fetch mock 版假 CDR：返回一个可直接喂给 FhirClient.fetchImpl 的 `fetch`，
 * 不真正起服务。请求记录里的 `url` 就是调用方传进来的原始地址（供断言同源头/路径用）。
 */
export function createFakeCdr(options: CreateFakeCdrOptions): FakeCdrHandle {
  const core = createCore(options);
  return {
    requests: core.requests,
    baseUrl: 'http://fake-cdr.local',
    fetch: async (input: string, init?: RequestInit): Promise<Response> => {
      const headers =
        (init?.headers as Record<string, string> | undefined) ?? {};
      const result = core.handle(input, 'GET', headers);
      if (result === 'hang') {
        // 模拟超时：不响应，但尊重调用方传入的 AbortSignal —— 客户端据此判超时
        return new Promise<Response>((_resolve, reject) => {
          const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
          if (signal === undefined) return;
          if (signal.aborted) {
            const error = new Error('The operation was aborted');
            error.name = 'AbortError';
            reject(error);
            return;
          }
          signal.addEventListener(
            'abort',
            () => {
              const error = new Error('The operation was aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true },
          );
        });
      }
      return new Response(result.body, {
        status: result.status,
        headers: { 'content-type': result.contentType },
      });
    },
  };
}

/**
 * 真实 HTTP 服务版假 CDR：起一个 node:http 服务，让生产代码用全局 fetch 无改动打到它。
 */
export async function startFakeCdrServer(options: CreateFakeCdrOptions): Promise<FakeCdrServer> {
  const core = createCore(options);
  let port = 0;
  const server = createServer((req, res) => {
    const rawUrl = `http://127.0.0.1:${port}${req.url ?? '/'}`;
    const headers = (req.headers as Record<string, string>);
    const result = core.handle(rawUrl, req.method ?? 'GET', headers);
    if (result === 'hang') {
      // 超时故障：故意不响应
      return;
    }
    res.writeHead(result.status, { 'content-type': result.contentType });
    res.end(result.body);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  port = address.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    requests: core.requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
