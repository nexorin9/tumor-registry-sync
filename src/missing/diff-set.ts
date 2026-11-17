/**
 * 缺行检查（反向 diff，任务 45/46）。
 *
 * 口径：先取院内满足「诊断编码 + 时间窗」的患者登记号集合（院内检索命中集），
 * 再与本表登记号集合求差，找出「院内命中、本表却无此登记号」的行，追加到表尾
 * 缺行区。确认列初始「待确认」，引擎绝不自动入表、绝不自动采纳。
 *
 * 两条硬规矩（与绑定层一致）：
 * - 「未完成」≠「零缺行」：检索失败（超时/5xx/非 JSON）判「本轮缺行检查未完成」，
 *   绝不谎报成「院内没有缺行」。合法的零命中（检索成功、返回空集）才是真零结果，
 *   两者在结果里严格分开计数。
 * - 院内同患者多条件命中（multi-hit）时，绝不悄悄取第一条：若该患者登记号确属缺行，
 *   标记 `命中歧义`，交由登记员人工判定。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { CdrEnv } from '../config/env.js';
import type { MissingRow } from '../contract/index.js';
import { FhirClient } from '../fhir/client.js';

/** 缺行检查配置。 */
export interface MissingCheckConfig {
  /** 是否启用本轮缺行检查 */
  enabled: boolean;
  /** 诊断编码（取值形如 `{system}|{code}`） */
  conditionCode: string;
  /** 时间窗；null 表示不限定时间 */
  dateWindow: { from: string; to: string } | null;
}

/** 缺行检查入参。 */
export interface MissingCheckInput {
  /** 院内 FHIR 只读侧配置 */
  cdr: CdrEnv;
  /** 本表登记号集合（允许含重复，去重参与比对） */
  registryIds: string[];
  /** 缺行检查配置 */
  config: MissingCheckConfig;
  /** 本次覆盖的时间窗；缺省沿用 config.dateWindow */
  dateWindow?: { from: string; to: string };
}

/** 缺行检查结果。 */
export interface MissingCheckResult {
  /** 表尾缺行区的待追加行 */
  rows: MissingRow[];
  /** 本轮是否未完成（检索失败/口径未声明/时间窗非法）；与「零缺行」严格区分 */
  incomplete: boolean;
  /** 未完成/未声明原因；合法零命中时为 null */
  reason: string | null;
  /** 本轮检索到的院内 Condition 条目数（零命中时自然为 0） */
  searchedCount: number;
}

/**
 * 可注入的检索客户端：测试层用假实现顶替，签名与 FhirClient.searchConditionsByCode 一致。
 */
export interface ConditionSearchClient {
  searchConditionsByCode(params: {
    code: string;
    from?: string;
    to?: string;
  }): Promise<{ registryIds: string[]; raw: unknown[] }>;
}

const SOURCE_LITERAL = '院内检索命中，本表无此登记号' as const;

/**
 * 读数窗配置。文件缺位 / 不可解析时退化为「未声明」（enabled:false），
 * 绝不拿占位值冒充一个可用的缺行口径。
 */
export function loadMissingCheckConfig(path?: string): MissingCheckConfig {
  const configPath = path ?? resolve(process.cwd(), 'config', 'missing-check.json');

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return { enabled: false, conditionCode: '', dateWindow: null };
  }

  const obj = (parsed ?? null) as Record<string, unknown> | null;
  if (obj === null || typeof obj !== 'object') {
    return { enabled: false, conditionCode: '', dateWindow: null };
  }

  const enabled = obj.enabled === true;
  const conditionCode =
    typeof obj.conditionCode === 'string' ? obj.conditionCode.trim() : '';
  const dateWindow = parseDateWindow(obj.dateWindow);

  if (!enabled || conditionCode.length === 0) {
    return { enabled: false, conditionCode: '', dateWindow: null };
  }
  return { enabled, conditionCode, dateWindow };
}

/** 从任意 JSON 值里尽量解析出 {from,to} 时间窗；形态不符返回 null。 */
function parseDateWindow(value: unknown): { from: string; to: string } | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.from !== 'string' || typeof obj.to !== 'string') return null;
  return { from: obj.from, to: obj.to };
}

/**
 * 缺行检查口径是否声明：仅当 config.enabled 且 conditionCode 非空。
 * spec 留作未来扩展（如按批次口径覆盖），当前判定只看 config。
 */
export function isMissingCheckDeclared(
  _spec: unknown,
  config: MissingCheckConfig,
): boolean {
  return config.enabled && config.conditionCode.trim().length > 0;
}

/** 登记号规范化：去空格 + 大小写不敏感，供集合比对。 */
export function normalizeRegistryId(id: string): string {
  return id.trim().toLowerCase();
}

/** 时间窗是否非法：起止任一不可解析，或 from 晚于 to。 */
function isIllegalWindow(window: { from: string; to: string }): boolean {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return true;
  return from > to;
}

/**
 * 执行缺行检查。
 *
 * @param input  缺行检查入参
 * @param client 可选注入的检索客户端；缺省按 input.cdr 构造 FhirClient
 */
export async function findMissingRows(
  input: MissingCheckInput,
  client?: ConditionSearchClient,
): Promise<MissingCheckResult> {
  const config = input.config;

  if (!isMissingCheckDeclared(null, config)) {
    return {
      rows: [],
      incomplete: true,
      reason: '缺行检查口径未声明',
      searchedCount: 0,
    };
  }

  const window = input.dateWindow ?? config.dateWindow ?? null;
  if (window !== null && isIllegalWindow(window)) {
    return { rows: [], incomplete: true, reason: '时间窗非法', searchedCount: 0 };
  }

  const searchClient: ConditionSearchClient =
    client ?? new FhirClient(input.cdr);

  let search: { registryIds: string[]; raw: unknown[] };
  try {
    search = await searchClient.searchConditionsByCode({
      code: config.conditionCode,
      from: window?.from,
      to: window?.to,
    });
  } catch {
    // 检索失败 ≠ 零缺行：宁可报「未完成」，也不谎报成「院内没有缺行」。
    return {
      rows: [],
      incomplete: true,
      reason: '本轮缺行检查未完成',
      searchedCount: 0,
    };
  }

  const tableSet = new Set(input.registryIds.map(normalizeRegistryId));

  // 统计每个院内登记号的命中次数（multi-hit → 歧义）。
  const hitCounts = new Map<string, number>();
  for (const entry of search.raw) {
    const resource = entry as { subject?: { reference?: string } } | null;
    const ref = resource?.subject?.reference;
    if (typeof ref !== 'string') continue;
    const token = ref.split('/').pop();
    if (!token || token.length === 0) continue;
    const key = normalizeRegistryId(token);
    hitCounts.set(key, (hitCounts.get(key) ?? 0) + 1);
  }

  const rows: MissingRow[] = [];
  for (const id of search.registryIds) {
    const key = normalizeRegistryId(id);
    if (tableSet.has(key)) continue;
    const ambiguous = (hitCounts.get(key) ?? 0) > 1;
    rows.push({
      registryId: id,
      source: SOURCE_LITERAL,
      status: ambiguous ? '命中歧义' : '待确认',
      confirmValue: '待确认',
    });
  }

  // 合法零命中（检索成功、返回空集）与「未完成」严格区分：此处 incomplete 必为 false。
  return {
    rows,
    incomplete: false,
    reason: null,
    searchedCount: search.raw.length,
  };
}
