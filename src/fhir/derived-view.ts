/**
 * 派生视图与日期口径边界。
 *
 * 前面几层（parse / binding / orchestrator）只做**取值**：把院内资源原样读出来。
 * 这一层做两件前面没做的事：
 *
 * 1. **日期归一**：院内各家的日期写法不一样（带时区偏移、ISO、纯数字、斜杠、
 *    中文年月日）。差异引擎比的是值，不先把日期折算到同一个基准上，
 *    `2024-03-05` 与 `2024-03-05T08:00:00+08:00` 就会被算成一条**假差异**，
 *    再被登记员采纳、推给专病库。归一后的日期是「院内本地日期」：
 *    带偏移的写法一律折算到院内时区（默认东八区）再取日期部分，
 *    因此 `2024-03-04T20:00:00Z` 与 `2024-03-05T04:00:00+08:00` 是同一天。
 * 2. **派生字段口径**：首次入院日 / 本次就诊开始不是院内资源上的字段，是**算出来**的。
 *    算它就得先说清楚口径（按哪条规则、取哪几次诊）。口径没声明就不算；
 *    算不出来就明说「口径未声明」，**绝不按空值参与比对** —— 那等于让插件建议「删除」。
 *
 * 三条硬规矩：
 * - **绝不猜日期**：解析不了就标「日期不可解析」，不猜、不就近取整、不拿别的字段顶
 * - **绝不按空值参与比对**：派生字段取不到 → 该字段本轮不参与比对
 * - **口径先于取值**：口径没声明的字段，值再好看也不参与比对
 *
 * 口径依据（经验推断）：肿瘤登记没有院内权威口径文件可依，本文件的取数规则按
 * 「登记员要对齐什么」倒推 —— 首次入院日取院内就诊开始时间最早的一次，
 * 本次就诊开始取最近一次；口径表（任务 4）落地后会用表里的声明替换本文件默认口径，
 * 并可按就诊分类（如住院）收窄筛选范围。
 */
import type { RowIssue } from '../contract/index.js';

import type { ConditionView, EncounterView, PatientView } from './parse.js';

/* ─────────────────────────── 院内本地时区 ─────────────────────────── */

/** 院内本地时区偏移（分钟）。默认东八区：中国大陆医院统一 UTC+08:00。 */
export const DEFAULT_HOSPITAL_UTC_OFFSET_MINUTES = 8 * 60;

/** 偏移量转 `+HH:MM` 文本（instant 字段用）。 */
export function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  return `${sign}${pad2(hours)}:${pad2(minutes)}`;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/* ───────────────────────────── 日期归一 ───────────────────────────── */

/** 归一前识别出的原始写法。 */
export type HospitalDateFormat =
  | 'iso-datetime'
  | 'iso-date'
  | 'compact-8'
  | 'slash'
  | 'chinese';

/** 归一后的院内本地日期。 */
export interface NormalizedHospitalDate {
  /** 院内本地日期 `YYYY-MM-DD` */
  date: string;
  /** 院内本地时刻 `YYYY-MM-DDTHH:mm:ss+08:00` */
  instant: string;
  /** 该值代表的时刻（epoch 毫秒），跨就诊取最早/最晚时用它比 */
  epochMs: number;
  /** 原始写法（去首尾空白） */
  source: string;
  /** 识别出的原始格式 */
  format: HospitalDateFormat;
  /** 原值是否带时刻（false = 只有日期，按院内本地零点计） */
  hasTime: boolean;
}

const RE_ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?$/;
const RE_ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const RE_COMPACT_8 = /^(\d{4})(\d{2})(\d{2})$/;
const RE_SLASH = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/;
const RE_CHINESE = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/;

/** 某年某月的天数（闰年按四年一闰、百年不闰、四百年再闰）。 */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

/** 年月日是否真实存在（`2024-02-31`、`20240230` 这类一律判为不可解析）。 */
function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;
  return day <= daysInMonth(year, month);
}

/** 解析时区偏移写法：`Z` / `+08:00` / `+0800` / `-05:30`。不可解析返回 null。 */
function parseOffsetToken(token: string): number | null {
  if (token === 'Z') return 0;
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(token);
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 14 || minutes > 59) return null;
  return sign * (hours * 60 + minutes);
}

/**
 * 把院内（或登记表）的一个日期写法归一成院内本地日期。
 *
 * 支持四种写法（另含中文年月日这一常见变体）：
 * - ISO 日期：`2024-03-05`
 * - 带时区偏移的 ISO 时刻：`2024-03-05T08:00:00+08:00` / `...Z`
 * - 纯数字 8 位：`20240305`
 * - 斜杠分隔：`2024/03/05`
 *
 * 归一失败的返回 **null**（不猜）：空值、非法日历日、非法时刻、认不出的写法。
 *
 * @param raw 原始写法
 * @param options.hospitalUtcOffsetMinutes 院内本地时区偏移（默认东八区）
 */
export function normalizeHospitalDate(
  raw: string | null | undefined,
  options: { hospitalUtcOffsetMinutes?: number } = {},
): NormalizedHospitalDate | null {
  if (raw === null || raw === undefined) return null;
  const source = String(raw).trim();
  if (source.length === 0) return null;
  const offset = options.hospitalUtcOffsetMinutes ?? DEFAULT_HOSPITAL_UTC_OFFSET_MINUTES;

  let year = 0;
  let month = 0;
  let day = 0;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let sourceOffset: number | null = null;
  let hasTime = false;
  let format: HospitalDateFormat;

  const dateTime = RE_ISO_DATETIME.exec(source);
  if (dateTime) {
    format = 'iso-datetime';
    year = Number(dateTime[1]);
    month = Number(dateTime[2]);
    day = Number(dateTime[3]);
    hour = Number(dateTime[4]);
    minute = Number(dateTime[5]);
    second = dateTime[6] === undefined ? 0 : Number(dateTime[6]);
    hasTime = true;
    if (dateTime[7] !== undefined) {
      sourceOffset = parseOffsetToken(dateTime[7]);
      if (sourceOffset === null) return null;
    }
  } else {
    const isoDate = RE_ISO_DATE.exec(source);
    const compact = RE_COMPACT_8.exec(source);
    const slash = RE_SLASH.exec(source);
    const chinese = RE_CHINESE.exec(source);
    if (isoDate) {
      format = 'iso-date';
      year = Number(isoDate[1]);
      month = Number(isoDate[2]);
      day = Number(isoDate[3]);
    } else if (compact) {
      format = 'compact-8';
      year = Number(compact[1]);
      month = Number(compact[2]);
      day = Number(compact[3]);
    } else if (slash) {
      format = 'slash';
      year = Number(slash[1]);
      month = Number(slash[2]);
      day = Number(slash[3]);
    } else if (chinese) {
      format = 'chinese';
      year = Number(chinese[1]);
      month = Number(chinese[2]);
      day = Number(chinese[3]);
    } else {
      return null;
    }
  }

  if (!isRealDate(year, month, day)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  // 无偏移的写法按「院内本地时间」理解；带偏移的先折算成绝对时刻
  const effectiveOffset = sourceOffset ?? offset;
  const epochMs = Date.UTC(year, month - 1, day, hour, minute, second) - effectiveOffset * 60_000;

  // 折算到院内本地时区后再取日期部分：同一绝对时刻永远落在同一个本地日期
  const local = new Date(epochMs + offset * 60_000);
  const date = `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())}`;
  const instant = `${date}T${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}:${pad2(local.getUTCSeconds())}${formatUtcOffset(offset)}`;

  return { date, instant, epochMs, source, format, hasTime };
}

/* ─────────────────────────── 派生字段与口径 ─────────────────────────── */

/** 派生字段全集（口径字段名，与口径表一一对应）。 */
export const DERIVED_FIELDS = ['首次入院日', '本次就诊开始'] as const;
export type DerivedFieldName = (typeof DERIVED_FIELDS)[number];

/** 派生口径规则：取就诊开始时间最早的一次 / 最近的一次。 */
export const DERIVED_CALIBER_RULES = [
  'earliest-encounter-start',
  'latest-encounter-start',
] as const;
export type DerivedCaliberRuleId = (typeof DERIVED_CALIBER_RULES)[number];

/** 口径里可声明的就诊筛选范围（如「只按住院就诊口径取」）。 */
export interface EncounterFilter {
  /** 就诊分类（Encounter.class.code），如 inpatient */
  classCode?: string | null;
  /** 就诊类型文本（Encounter.type.text），精确匹配 */
  typeText?: string | null;
}

/** 一个派生字段的口径声明。 */
export interface DerivedCaliberRule {
  /** 取数规则 */
  rule: DerivedCaliberRuleId;
  /** 可选的筛选范围；不声明则取全部就诊 */
  encounterFilter?: EncounterFilter | null;
}

/** 口径声明：派生字段 → 口径规则。未出现在声明里的字段即「口径未声明」。 */
export type DerivedCaliberDeclaration = Partial<Record<DerivedFieldName, DerivedCaliberRule>>;

/**
 * 本模块的兜底口径（**经验推断**）。
 *
 * 口径表（任务 4）落地后由表里的声明替换本默认值；未替换之前，
 * 这份默认口径就是「首次入院日取最早、本次就诊开始取最近」的书面依据。
 */
export const DEFAULT_DERIVED_CALIBERS: DerivedCaliberDeclaration = {
  首次入院日: { rule: 'earliest-encounter-start' },
  本次就诊开始: { rule: 'latest-encounter-start' },
};

/** 派生字段的三种状态。 */
export const DERIVED_FIELD_STATUSES = ['已取到', '口径未声明', '日期不可解析'] as const;
export type DerivedFieldStatus = (typeof DERIVED_FIELD_STATUSES)[number];

/** 一个派生字段的取值结果。 */
export interface DerivedFieldResult {
  /** 口径字段名 */
  field: DerivedFieldName;
  /** 状态：已取到 / 口径未声明 / 日期不可解析 */
  status: DerivedFieldStatus;
  /** 院内本地日期 `YYYY-MM-DD`；未取到为 null */
  date: string | null;
  /** 院内本地时刻；未取到为 null */
  instant: string | null;
  /** 取值来源的就诊 id */
  sourceEncounterIds: string[];
  /** 面向登记员的原因说明 */
  reason: string;
  /** 是否参与差异比对：只有「已取到」才参与 */
  participatesInDiff: boolean;
}

/** 一行的派生视图。 */
export interface DerivedRowView {
  /** 表内行号 */
  rowNumber: number;
  /** 登记主索引 */
  registryId: string;
  /** 院内患者视图 */
  patient: PatientView | null;
  /** 院内诊断列表 */
  conditions: ConditionView[];
  /** 院内就诊列表 */
  encounters: EncounterView[];
  /** 派生字段取值（按口径字段名索引） */
  derived: Record<DerivedFieldName, DerivedFieldResult>;
  /** 行级问题（日期不可解析等） */
  issues: RowIssue[];
  /** 本轮不参与比对的字段 */
  unavailableFields: string[];
}

/* ───────────────────────────── 取数实现 ───────────────────────────── */

/** 口径规则的中文说明（写进 reason，给登记员看）。 */
const RULE_LABELS: Record<DerivedCaliberRuleId, string> = {
  'earliest-encounter-start': '就诊开始最早的一次',
  'latest-encounter-start': '就诊开始最近的一次',
};

/** 筛选条件的文字说明。 */
function describeFilter(filter: EncounterFilter | null | undefined): string {
  if (!filter) return '全部就诊';
  const parts: string[] = [];
  if (filter.classCode) parts.push(`就诊分类=${filter.classCode}`);
  if (filter.typeText) parts.push(`就诊类型=${filter.typeText}`);
  return parts.length > 0 ? parts.join('、') : '全部就诊';
}

/** 就诊是否落在口径声明的筛选范围内。 */
function matchesFilter(encounter: EncounterView, filter: EncounterFilter | null | undefined): boolean {
  if (!filter) return true;
  if (filter.classCode && encounter.class !== filter.classCode) return false;
  if (filter.typeText && encounter.type !== filter.typeText) return false;
  return true;
}

/** 就诊排序用的稳定标识（缺 id 时退回空串，保证排序可复现）。 */
function encounterKey(encounter: EncounterView): string {
  return encounter.id ?? '';
}

/** 未取到时的统一结果。 */
function unavail(
  field: DerivedFieldName,
  status: '口径未声明' | '日期不可解析',
  reason: string,
): DerivedFieldResult {
  return {
    field,
    status,
    date: null,
    instant: null,
    sourceEncounterIds: [],
    reason,
    participatesInDiff: false,
  };
}

/**
 * 按口径取一个派生字段。
 *
 * 取不到只有三种可能，每种都明说：
 * - 口径没声明 → 「口径未声明」，不参与比对
 * - 口径声明了但院内没有可用就诊 → 「口径未声明」，不参与比对
 * - 口径声明了、就诊也有，但日期写法认不出 → 「日期不可解析」，不参与比对
 */
function deriveField(
  field: DerivedFieldName,
  rule: DerivedCaliberRule | undefined,
  encounters: EncounterView[],
  offsetMinutes: number,
  context: { rowNumber: number; registryId: string },
): { result: DerivedFieldResult; issue: RowIssue | null } {
  if (rule === undefined) {
    return {
      result: unavail(
        field,
        '口径未声明',
        `口径表未声明「${field}」的取数口径，本字段本轮不参与比对`,
      ),
      issue: null,
    };
  }

  const candidates = encounters.filter((encounter) => matchesFilter(encounter, rule.encounterFilter));
  if (candidates.length === 0) {
    const reason =
      encounters.length === 0
        ? `院内没有就诊记录，无法按口径取「${field}」`
        : `按口径筛选（${describeFilter(rule.encounterFilter)}）后本行没有可用就诊记录，无法取「${field}」`;
    return { result: unavail(field, '口径未声明', reason), issue: null };
  }

  const parsed: { encounter: EncounterView; date: NormalizedHospitalDate }[] = [];
  const missing: EncounterView[] = [];
  const unparseable: { encounter: EncounterView; raw: string }[] = [];

  for (const encounter of candidates) {
    const raw = encounter.periodStart;
    if (raw === null || raw.trim().length === 0) {
      missing.push(encounter);
      continue;
    }
    const normalized = normalizeHospitalDate(raw, { hospitalUtcOffsetMinutes: offsetMinutes });
    if (normalized === null) {
      unparseable.push({ encounter, raw });
      continue;
    }
    parsed.push({ encounter, date: normalized });
  }

  if (unparseable.length > 0) {
    const sample = unparseable[0];
    return {
      result: unavail(
        field,
        '日期不可解析',
        `日期不可解析：${unparseable.length}/${candidates.length} 条就诊记录的 period.start 无法解析为日期（如「${sample?.raw ?? ''}」），「${field}」本轮不参与比对`,
      ),
      issue: {
        rowNumber: context.rowNumber,
        registryId: context.registryId,
        code: 'DATE_UNPARSEABLE',
        reason: `日期不可解析：${unparseable.length}/${candidates.length} 条就诊记录的 period.start 无法解析为日期（如「${sample?.raw ?? ''}」）`,
        hint: '该字段本轮不参与比对，请核对院内就诊记录的日期写法后重跑；插件不会猜日期',
        blocking: false,
      },
    };
  }

  if (missing.length > 0) {
    return {
      result: unavail(
        field,
        '口径未声明',
        `按口径取「${field}」需要全部就诊记录的 period.start，本行 ${missing.length}/${candidates.length} 条就诊记录缺 period.start，本字段本轮不参与比对`,
      ),
      issue: null,
    };
  }

  const sorted = [...parsed].sort((a, b) => {
    if (a.date.epochMs !== b.date.epochMs) {
      return rule.rule === 'earliest-encounter-start'
        ? a.date.epochMs - b.date.epochMs
        : b.date.epochMs - a.date.epochMs;
    }
    // 同一时刻多条就诊：按 id 稳定排序，保证多次运行取到同一条
    const keyA = encounterKey(a.encounter);
    const keyB = encounterKey(b.encounter);
    return rule.rule === 'earliest-encounter-start'
      ? keyA < keyB
        ? -1
        : keyA > keyB
          ? 1
          : 0
      : keyA > keyB
        ? -1
        : keyA < keyB
          ? 1
          : 0;
  });

  const chosen = sorted[0];
  if (chosen === undefined) {
    return {
      result: unavail(field, '口径未声明', `院内没有可用就诊记录，无法按口径取「${field}」`),
      issue: null,
    };
  }

  const sourceIds = chosen.encounter.id === null ? [] : [chosen.encounter.id];
  return {
    result: {
      field,
      status: '已取到',
      date: chosen.date.date,
      instant: chosen.date.instant,
      sourceEncounterIds: sourceIds,
      reason: `按口径「${RULE_LABELS[rule.rule]}」取自就诊 ${chosen.encounter.id ?? '（无 id）'}（${chosen.date.instant}）`,
      participatesInDiff: true,
    },
    issue: null,
  };
}

/**
 * 把一行的院内记录整理成**派生视图**。
 *
 * 输入是 parse / orchestrator 给出的患者、诊断、就诊视图；输出是登记员能直接看懂的
 * 派生字段（首次入院日 / 本次就诊开始）与「哪些字段本轮不参与比对」的说明。
 *
 * @param input 行号、登记号、院内三类视图、口径声明等
 */
export function buildDerivedRow(input: {
  /** 表内行号 */
  rowNumber: number;
  /** 登记主索引 */
  registryId: string;
  /** 院内患者视图 */
  patient?: PatientView | null;
  /** 院内诊断列表 */
  conditions?: ConditionView[];
  /** 院内就诊列表 */
  encounters?: EncounterView[];
  /** 口径声明；不传则用默认口径（经验推断） */
  calibers?: DerivedCaliberDeclaration;
  /** 院内本地时区偏移（默认东八区） */
  hospitalUtcOffsetMinutes?: number;
  /** 上游行级问题（读表层 / 检索层已记的） */
  issues?: RowIssue[];
  /** 上游不参与比对的字段 */
  unavailableFields?: string[];
}): DerivedRowView {
  const offsetMinutes = input.hospitalUtcOffsetMinutes ?? DEFAULT_HOSPITAL_UTC_OFFSET_MINUTES;
  const calibers = input.calibers ?? DEFAULT_DERIVED_CALIBERS;
  const encounters = input.encounters ?? [];
  const issues = [...(input.issues ?? [])];
  const unavailableFields = [...(input.unavailableFields ?? [])];

  const derived = {} as Record<DerivedFieldName, DerivedFieldResult>;
  for (const field of DERIVED_FIELDS) {
    const outcome = deriveField(field, calibers[field], encounters, offsetMinutes, {
      rowNumber: input.rowNumber,
      registryId: input.registryId,
    });
    derived[field] = outcome.result;
    // 同一行只记一条「日期不可解析」：两个派生字段撞上的是同一个日期问题
    if (outcome.issue !== null && !issues.some((issue) => issue.code === outcome.issue?.code)) {
      issues.push(outcome.issue);
    }
    if (!outcome.result.participatesInDiff && !unavailableFields.includes(field)) {
      unavailableFields.push(field);
    }
  }

  return {
    rowNumber: input.rowNumber,
    registryId: input.registryId,
    patient: input.patient ?? null,
    conditions: input.conditions ?? [],
    encounters,
    derived,
    issues,
    unavailableFields,
  };
}

/** 取一行里参与差异比对的派生字段（只有「已取到」的才算）。 */
export function comparableDerivedFields(
  view: DerivedRowView,
): { field: DerivedFieldName; result: DerivedFieldResult }[] {
  return DERIVED_FIELDS.filter((field) => view.derived[field].participatesInDiff).map((field) => ({
    field,
    result: view.derived[field],
  }));
}
