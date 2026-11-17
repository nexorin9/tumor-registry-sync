/**
 * 检索编排：把规范化的登记表行批量驱动起来。
 *
 * 一行的检索顺序是固定的：**先患者，再诊断，再就诊**。
 * 患者没绑定上（歧义 / 零命中 / 未完成）就**不再取后两段**——
 * 没有唯一患者 id 时按它取诊断与就诊，取回来的也是别的东西。
 *
 * 失败语义（登记员看得懂的那种）：
 * - 401/403 是终止级错误：凭据不对就停下来点名环境变量，不刷一屏错行
 * - 404 映射「零命中」
 * - 其余失败（超时 / 5xx / 坏响应）映射「未完成」，与零命中分开计数
 *
 * 本层的三条批量纪律（登记表一次 100–300 行，院内接口不能被本机打爆）：
 * - **有限并发**：同时在途的检索不超过 `FHIR_MAX_CONCURRENCY`（默认 4），
 *   由固定数量的 worker 从队列里拉登记号，不是一行一行串行等
 * - **同号只查一次**：同一登记主索引只发一次检索，命中结果复用给同号的其他行
 * - **单行失败隔离**：一行检索失败只标那一行，同批其余行照常跑完
 *
 * 另产出**本批检索参数串**：去重后的唯一登记号 + 实际检索参数 + 分页页数，
 * 原样写进表尾回执区与批次键，登记员下次能照着同一串参数复现本批。
 */
import type { BindingOutcome, ErrorCode, RowIssue, RowStatus } from '../contract/index.js';
import { DEFAULT_FHIR_MAX_CONCURRENCY } from '../config/env.js';

import {
  assertBound,
  bindPatientHits,
  incompleteBindingIssue,
  type BindingContext,
} from './binding.js';
import type { FhirClient } from './client.js';
import { FhirRequestError, isFatalFhirError } from './errors.js';
import { fetchAllPages } from './pagination.js';
import {
  conditionByPatientParams,
  encounterByPatientParams,
  patientByIdentifierParams,
  type SearchParams,
} from './params.js';
import { parseCondition, parseEncounter, type ConditionView, type EncounterView } from './parse.js';
import type { PatientView } from './parse.js';
import type { FhirResourceType } from './types.js';

/** 检索并发上限默认值（与 FHIR_MAX_CONCURRENCY 的默认值同源，不各写一份）。 */
export const DEFAULT_LOOKUP_CONCURRENCY = DEFAULT_FHIR_MAX_CONCURRENCY;

/** 并发上限非法时的错误：点名配置项，信息科照着就能改。 */
export class LookupConcurrencyError extends Error {
  constructor(value: unknown) {
    super(
      `检索并发上限非法（当前为「${String(value)}」）：请检查环境变量 FHIR_MAX_CONCURRENCY，应为正整数`,
    );
    this.name = 'LookupConcurrencyError';
  }
}

/** 参与检索的一行。 */
export interface LookupRowInput {
  /** 表内行号 */
  rowNumber: number;
  /** 登记主索引 */
  registryId: string;
}

/** 一次检索步骤：资源类型 + 实际参数 + 取了几页。 */
export interface LookupSearchStep {
  /** 资源类型：Patient / Condition / Encounter */
  resourceType: FhirResourceType;
  /** 实际发出的检索参数（原样，未经 URL 编码） */
  params: SearchParams;
  /** 该步骤实际取过的页数 */
  pageCount: number;
}

/** 本批检索参数串的一个条目：一个唯一登记号的全部检索步骤。 */
export interface BatchSearchParamEntry {
  /** 登记主索引 */
  registryId: string;
  /** 该登记号实际走过的检索步骤（患者 → 诊断 → 就诊，未命中的步骤不出现） */
  steps: LookupSearchStep[];
  /** 实际取过的页地址（相对基地址的路径 + 查询串），原样保留供复现 */
  pagePaths: string[];
}

/** 去重统计：同号只查一次，其余行复用结果。 */
export interface LookupDedupStats {
  /** 去重后的唯一登记号数（实际发出的检索次数） */
  uniqueRegistryIds: number;
  /** 复用了同号检索结果的行数 */
  reusedRows: number;
}

/** 并发统计：上限与本批实际达到的峰值。 */
export interface LookupConcurrencyStats {
  /** 本批生效的并发上限 */
  limit: number;
  /** 本批同时在途的检索峰值 */
  peakInFlight: number;
}

/** 一行的检索结果。 */
export interface LookupRowOutcome {
  /** 表内行号 */
  rowNumber: number;
  /** 登记主索引 */
  registryId: string;
  /** 绑定判定：命中 / 歧义 / 零命中 / 未完成 */
  binding: BindingOutcome;
  /** 行状态 */
  status: RowStatus;
  /** 院内患者 id */
  patientId: string | null;
  /** 院内患者视图 */
  patient: PatientView | null;
  /** 院内诊断（含分期） */
  conditions: ConditionView[];
  /** 院内就诊 */
  encounters: EncounterView[];
  /** 取不到、不参与比对的字段 */
  unavailableFields: string[];
  /** 行级问题 */
  issues: RowIssue[];
  /** 本行涉及的检索地址（原样保留，供复现） */
  requestUrls: string[];
  /** 本行是否复用了同登记号另一行的检索结果 */
  reused: boolean;
  /** 本行检索失败时的底层错误码（成功 / 歧义 / 零命中为 null） */
  errorCode: ErrorCode | null;
  /** 本行检索耗时（毫秒） */
  durationMs: number;
  /** 本行为取得院内值发出的检索段数（患者 → 诊断 → 就诊） */
  attempts: number;
}

/** 一批的统计。 */
export interface LookupStats {
  /** 本批送检索的行数 */
  total: number;
  /** 命中 */
  matched: number;
  /** 歧义 */
  ambiguous: number;
  /** 零命中 */
  noMatch: number;
  /** 未完成（检索失败或资源不可用） */
  incomplete: number;
}

/** 检索选项。 */
export interface LookupOptions {
  /** 分页上限 */
  maxPages?: number;
  /** 是否取诊断（默认取） */
  fetchConditions?: boolean;
  /** 是否取就诊（默认取） */
  fetchEncounters?: boolean;
  /** 同时在途的检索上限（默认 4，来自环境变量 FHIR_MAX_CONCURRENCY） */
  maxConcurrency?: number;
}

/** 一批检索的结果。 */
export interface LookupResult {
  rows: LookupRowOutcome[];
  stats: LookupStats;
  /** 本批检索参数串（原样可复现；表尾回执区与批次键都用它） */
  searchParams: string;
  /** 结构化的检索参数串条目（按登记号排序） */
  searchParamEntries: BatchSearchParamEntry[];
  /** 去重统计 */
  dedup: LookupDedupStats;
  /** 并发统计 */
  concurrency: LookupConcurrencyStats;
}

/** 一个登记号的检索结果（尚未贴上行号，行号在铺回各行时补上）。 */
interface RegistryLookup {
  binding: BindingOutcome;
  status: RowStatus;
  patientId: string | null;
  patient: PatientView | null;
  conditions: ConditionView[];
  encounters: EncounterView[];
  unavailableFields: string[];
  issues: RowIssue[];
  requestUrls: string[];
  steps: LookupSearchStep[];
  pagePaths: string[];
  /** 检索失败时的底层错误码 */
  errorCode: ErrorCode | null;
  /** 本次检索耗时（毫秒） */
  durationMs: number;
  /** 发出的检索段数（患者 → 诊断 → 就诊） */
  attempts: number;
}

/** 绑定判定 → 行状态。 */
function statusOfBinding(binding: BindingOutcome): RowStatus {
  if (binding === '歧义') return '命中歧义';
  if (binding === '零命中') return '零命中';
  return '待对齐';
}

/** 去掉地址的源与凭据，只留路径 + 查询串：换一台机器也照样能复现。 */
function toRequestPath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/** 检索参数原样拼串：同名多值用逗号隔开。 */
function formatParams(params: SearchParams): string {
  return Object.entries(params)
    .map(([key, value]) => {
      const values = Array.isArray(value) ? value : [value];
      return `${key}=${values.join(',')}`;
    })
    .join(',');
}

/** 一个检索步骤的串：`Patient?identifier=xxx#1`（# 后是页数）。 */
function formatStep(step: LookupSearchStep): string {
  const query = formatParams(step.params);
  return `${step.resourceType}${query.length > 0 ? `?${query}` : ''}#${step.pageCount}`;
}

/**
 * 把结构化的检索参数条目拼成**本批检索参数串**。
 *
 * 格式：每个唯一登记号一行，行内按 患者 → 诊断 → 就诊 排列，
 * 行与行之间按登记号排序 —— 与行的先后顺序无关，重排表也不会让参数串变形。
 */
export function buildSearchParamsString(entries: BatchSearchParamEntry[]): string {
  return entries
    .map((entry) => `${entry.registryId} :: ${entry.steps.map(formatStep).join(' ; ')}`)
    .join('\n');
}

/** 并发上限：缺省用默认，非法值点名报错，不静默改成 1。 */
function resolveConcurrency(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LOOKUP_CONCURRENCY;
  if (!Number.isInteger(value) || value <= 0) throw new LookupConcurrencyError(value);
  return value;
}

/**
 * 检索一个登记主索引：患者 → 诊断 → 就诊。
 *
 * 未绑定上（歧义 / 零命中 / 未完成）就不再取后两段。
 */
async function lookupRegistryId(
  registryId: string,
  client: FhirClient,
  options: {
    maxPages?: number;
    fetchConditions: boolean;
    fetchEncounters: boolean;
    rowNumber: number;
  },
): Promise<RegistryLookup> {
  const context: BindingContext = {
    rowNumber: options.rowNumber,
    registryId,
    identifierSystem: client.identifierSystem,
  };
  const requestUrls: string[] = [];
  const steps: LookupSearchStep[] = [];
  const pagePaths: string[] = [];
  // 本行的耗时与检索段数：写进运行日志，供「哪一行慢、慢在哪一段」核对
  const startedAt = Date.now();
  let attempts = 0;

  const empty = {
    patientId: null,
    patient: null,
    conditions: [] as ConditionView[],
    encounters: [] as EncounterView[],
    unavailableFields: [] as string[],
  };

  try {
    const patientParams = patientByIdentifierParams(client.identifierSystem, registryId);
    attempts += 1;
    const patientPage = await fetchAllPages(client, 'Patient', patientParams, {
      maxPages: options.maxPages,
    });
    requestUrls.push(...patientPage.pageUrls);
    pagePaths.push(...patientPage.pageUrls.map(toRequestPath));
    steps.push({
      resourceType: 'Patient',
      params: patientParams,
      pageCount: patientPage.pageCount,
    });

    const decision = bindPatientHits(patientPage.resources, context);
    if (decision.outcome !== '命中') {
      return {
        ...empty,
        binding: decision.outcome,
        status: statusOfBinding(decision.outcome),
        issues: decision.issue ? [decision.issue] : [],
        requestUrls,
        steps,
        pagePaths,
        errorCode: null,
        durationMs: Date.now() - startedAt,
        attempts,
      };
    }

    const patient = assertBound(decision, context);
    const conditions: ConditionView[] = [];
    const encounters: EncounterView[] = [];
    const issues: RowIssue[] = [];
    const unavailableFields: string[] = [];

    if (options.fetchConditions) {
      const conditionParams = conditionByPatientParams(patient.id);
      attempts += 1;
      const conditionPage = await fetchAllPages(client, 'Condition', conditionParams, {
        maxPages: options.maxPages,
      });
      requestUrls.push(...conditionPage.pageUrls);
      pagePaths.push(...conditionPage.pageUrls.map(toRequestPath));
      steps.push({
        resourceType: 'Condition',
        params: conditionParams,
        pageCount: conditionPage.pageCount,
      });
      for (const resource of conditionPage.resources) {
        const parsed = parseCondition(resource);
        conditions.push(parsed.condition);
        for (const issue of parsed.issues) {
          unavailableFields.push(issue.field);
          issues.push({
            rowNumber: options.rowNumber,
            registryId,
            code: 'MISSING_FIELD',
            reason: issue.reason,
            hint: '该字段本轮不参与比对，请联系信息科核对院内资源后重跑',
            blocking: false,
          });
        }
      }
    }

    if (options.fetchEncounters) {
      const encounterParams = encounterByPatientParams(patient.id);
      attempts += 1;
      const encounterPage = await fetchAllPages(client, 'Encounter', encounterParams, {
        maxPages: options.maxPages,
      });
      requestUrls.push(...encounterPage.pageUrls);
      pagePaths.push(...encounterPage.pageUrls.map(toRequestPath));
      steps.push({
        resourceType: 'Encounter',
        params: encounterParams,
        pageCount: encounterPage.pageCount,
      });
      for (const resource of encounterPage.resources) {
        const parsed = parseEncounter(resource);
        encounters.push(parsed.encounter);
        for (const issue of parsed.issues) {
          unavailableFields.push(issue.field);
          issues.push({
            rowNumber: options.rowNumber,
            registryId,
            code: 'MISSING_FIELD',
            reason: issue.reason,
            hint: '该字段本轮不参与比对，请联系信息科核对院内资源后重跑',
            blocking: false,
          });
        }
      }
    }

    return {
      binding: '命中',
      status: '待对齐',
      patientId: patient.id,
      patient,
      conditions,
      encounters,
      unavailableFields,
      issues,
      requestUrls,
      steps,
      pagePaths,
      errorCode: null,
      durationMs: Date.now() - startedAt,
      attempts,
    };
  } catch (error) {
    // 凭据 / 权限问题终止整批：继续跑只会刷一屏错行
    if (isFatalFhirError(error)) {
      throw error;
    }

    const issue = thisRowIssue(error, context);
    // 404 = 院内确实没有这条登记号（零命中）；其余失败 = 本轮未取到院内值（未完成）
    const notFound = issue.code === 'NO_MATCH';
    return {
      ...empty,
      binding: notFound ? '零命中' : '未完成',
      status: notFound ? '零命中' : '待对齐',
      issues: [issue],
      requestUrls,
      steps,
      pagePaths,
      // 底层错误码：可观测层据此按错误码聚合本批失败（零命中不是失败，不带错误码）
      errorCode: notFound ? null : errorCodeOf(error),
      durationMs: Date.now() - startedAt,
      attempts,
    };
  }
}

/** 取底层错误码：非 FhirRequestError 一律记 unknown，不静默丢掉原因。 */
function errorCodeOf(error: unknown): ErrorCode {
  return error instanceof FhirRequestError ? error.code : 'unknown';
}

/** 检索失败 → 行级问题。404 单独映射零命中，坏响应单独映射 BAD_PAYLOAD。 */
function thisRowIssue(error: unknown, context: BindingContext): RowIssue {
  if (error instanceof FhirRequestError && error.code === 'not_found') {
    return {
      rowNumber: context.rowNumber,
      registryId: context.registryId,
      code: 'NO_MATCH',
      reason: `登记号 ${context.registryId} 在院内未检索到患者记录`,
      hint: `请核对登记号与 CDR_IDENTIFIER_SYSTEM（${context.identifierSystem}）是否一致；本行不产出差异值、不进推送体`,
      blocking: false,
    };
  }
  if (error instanceof FhirRequestError && error.code === 'bad_payload') {
    return {
      rowNumber: context.rowNumber,
      registryId: context.registryId,
      code: 'BAD_PAYLOAD',
      reason: `登记号 ${context.registryId} 的院内响应不是 FHIR JSON`,
      hint: '本轮该行未取得院内值，不产出差异值、不进推送体；请联系信息科核对 CDR_BASE_URL 指向的服务与代理配置后重跑',
      blocking: false,
    };
  }
  if (error instanceof FhirRequestError) {
    return incompleteBindingIssue(context, error.message, error.userHint);
  }
  const message = error instanceof Error ? error.message : String(error);
  return incompleteBindingIssue(
    context,
    `检索院内记录失败：${message}`,
    '请检查 CDR_BASE_URL 与本机网络；本轮该行未取得院内值，重跑后再看差异',
  );
}

/** 把一个登记号的检索结果铺回某一行（行号与行级问题上的行号一并补正）。 */
function materializeRow(
  row: LookupRowInput,
  found: RegistryLookup,
  reused: boolean,
): LookupRowOutcome {
  return {
    rowNumber: row.rowNumber,
    registryId: row.registryId,
    binding: found.binding,
    status: found.status,
    patientId: found.patientId,
    patient: found.patient,
    conditions: found.conditions,
    encounters: found.encounters,
    unavailableFields: found.unavailableFields,
    issues: found.issues.map((issue) => ({ ...issue, rowNumber: row.rowNumber })),
    requestUrls: found.requestUrls,
    reused,
    errorCode: found.errorCode,
    durationMs: found.durationMs,
    attempts: found.attempts,
  };
}

/**
 * 逐行检索院内权威记录（批量版）。
 *
 * 同一登记主索引只发一次检索（命中结果复用给同号的其他行）；
 * 同时在途的检索不超过并发上限；一行失败只标那一行，同批其余行照常跑完；
 * 401/403 仍终止整批并点名环境变量。
 *
 * @param rows 参与检索的行
 * @param client 院内 FHIR 客户端
 * @param options 检索选项（并发上限等）
 */
export async function lookupRows(
  rows: LookupRowInput[],
  client: FhirClient,
  options: LookupOptions = {},
): Promise<LookupResult> {
  const fetchConditions = options.fetchConditions ?? true;
  const fetchEncounters = options.fetchEncounters ?? true;
  const limit = resolveConcurrency(options.maxConcurrency);

  // 去重：同一登记主索引只查一次
  const uniqueIds: string[] = [];
  const firstRowNumber = new Map<string, number>();
  for (const row of rows) {
    const id = row.registryId.trim();
    if (id.length === 0) continue;
    if (firstRowNumber.has(id)) continue;
    firstRowNumber.set(id, row.rowNumber);
    uniqueIds.push(id);
  }

  const results = new Map<string, RegistryLookup>();
  let cursor = 0;
  let inFlight = 0;
  let peakInFlight = 0;
  let fatal: unknown = null;

  // 固定数量的 worker 从待查登记号队列里拉活：在途数天然不超过 worker 数
  const worker = async (): Promise<void> => {
    for (;;) {
      if (fatal !== null) return;
      const index = cursor;
      cursor += 1;
      if (index >= uniqueIds.length) return;
      const registryId = uniqueIds[index];
      if (registryId === undefined) return;

      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        results.set(
          registryId,
          await lookupRegistryId(registryId, client, {
            maxPages: options.maxPages,
            fetchConditions,
            fetchEncounters,
            rowNumber: firstRowNumber.get(registryId) ?? 1,
          }),
        );
      } catch (error) {
        // 终止级错误（401/403）：整批停下并把错误抛给调用方
        if (isFatalFhirError(error) && fatal === null) fatal = error;
      } finally {
        inFlight -= 1;
      }
    }
  };

  const workerCount = Math.max(1, Math.min(limit, uniqueIds.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  if (fatal !== null) throw fatal;

  const materialized: LookupRowOutcome[] = rows.map((row) => {
    const id = row.registryId.trim();
    const found = results.get(id);
    if (found === undefined) {
      // 不可达（每个唯一登记号都查过）；仍给显式行级问题，不静默丢行
      return {
        rowNumber: row.rowNumber,
        registryId: row.registryId,
        binding: '未完成' as BindingOutcome,
        status: '待对齐' as RowStatus,
        patientId: null,
        patient: null,
        conditions: [],
        encounters: [],
        unavailableFields: [],
        issues: [
          {
            rowNumber: row.rowNumber,
            registryId: row.registryId,
            code: 'SEARCH_FAILED' as const,
            reason: `登记号 ${id} 本轮未取得检索结果`,
            hint: '请重跑本批；若反复出现请联系信息科核对 CDR_BASE_URL 与本机网络',
            blocking: false,
          },
        ],
        requestUrls: [],
        reused: false,
        errorCode: 'unknown' as ErrorCode,
        durationMs: 0,
        attempts: 0,
      };
    }
    const reused = firstRowNumber.get(id) !== row.rowNumber;
    return materializeRow(row, found, reused);
  });

  const entries: BatchSearchParamEntry[] = [];
  for (const registryId of uniqueIds) {
    const found = results.get(registryId);
    if (found === undefined) continue;
    entries.push({ registryId, steps: found.steps, pagePaths: found.pagePaths });
  }
  entries.sort((a, b) => (a.registryId < b.registryId ? -1 : a.registryId > b.registryId ? 1 : 0));

  return {
    rows: materialized,
    stats: statsOf(materialized),
    searchParams: buildSearchParamsString(entries),
    searchParamEntries: entries,
    dedup: {
      uniqueRegistryIds: uniqueIds.length,
      reusedRows: materialized.filter((row) => row.reused).length,
    },
    concurrency: { limit, peakInFlight },
  };
}

/** 一批的计数：命中 / 歧义 / 零命中 / 未完成，各计各的。 */
export function statsOf(rows: LookupRowOutcome[]): LookupStats {
  return {
    total: rows.length,
    matched: rows.filter((row) => row.binding === '命中').length,
    ambiguous: rows.filter((row) => row.binding === '歧义').length,
    noMatch: rows.filter((row) => row.binding === '零命中').length,
    incomplete: rows.filter((row) => row.binding === '未完成').length,
  };
}
