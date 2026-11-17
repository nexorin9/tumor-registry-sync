/**
 * 字段路径映射：登记表列 ↔ 口径字段 ↔ 院内资源路径（三段映射）。
 *
 * 为什么要有这一层：比对引擎（patch）只认「口径字段名」，可推送体只认
 * 「院内资源路径」，而登记员手里是一张列名五花八门的表。三段各说各话的时候，
 * 比对层就会自己猜 —— 把没声明的列拿去比、把多份诊断里的第一条当权威值、
 * 把 `ⅢB` 与 `IIIB` 判成两个值。这一层把三段**落成一张可执行的映射表**，
 * 并把「哪一段缺了」变成显式报错。
 *
 * 三段分别是：
 * - 第一段：登记列名（「分期」）↔ 口径字段名（「分期」）
 * - 第二段：口径字段名 ↔ 院内资源类型 + 资源内路径（Condition.stage）
 * - 第三段：读法登记（哪个资源类型、哪个路径、怎么读、可能命中几条）
 *
 * 四条硬规矩：
 * - **缺映射显式报错**：口径表声明参与比对、映射表却没有条目的字段 → 报错并
 *   点名缺哪个口径字段。绝不「这一列先不比」。
 * - **绝不取第一条**：同一资源路径命中多条资源时，取值不一致 → 判歧义、
 *   不产出院内值；取值一致才可比。取第一条是这套产品最不该犯的错。
 * - **未声明映射的列不参与比对**：表里出现口径表没声明的列 → 显式标
 *   「口径未声明」，不猜值、不静默跳过。
 * - **人工补充列全程排除**：映射表里标了 humanSupplied 的列，比对侧与写回侧
 *   都跳过（写回层由 result-file / writeback 兜底，本层只负责标出来并排除）。
 *
 * 与源产品主路径的关系：源实现的最小差异（`createPatch(input, output)`）
 * 把差异挂在一组**路径**上，写前前置条件（`createTests`）用同一条路径把目标
 * 对象当前值取出来做比对。本层是同一件事的医院版：**一条口径字段 → 一条院内
 * 资源路径 → 一个能取到当前值的读法**，取不到就明说取不到，而不是猜一个。
 */
import { readFileSync } from 'node:fs';

import { z } from 'zod';

import type { ConditionView, EncounterView, PatientView } from '../fhir/parse.js';

import type { FieldSpec } from './field-spec.js';
import { diffValuesEqual, type EquivalentPredicate, type FieldDiffInput } from './patch.js';

/* ───────────────────────────── 三段映射结构 ───────────────────────────── */

/** 本轮 CDR 只读的三类院内资源。 */
export const HOSPITAL_RESOURCE_TYPES = ['Patient', 'Condition', 'Encounter'] as const;
export type HospitalResourceType = (typeof HOSPITAL_RESOURCE_TYPES)[number];

/**
 * 路径命中条数口径：
 * - `single`：该路径按单值声明（同一行只应命中一次）；命中多条 → 歧义
 * - `many`：该路径允许命中多条（如每个诊断各带一条分期）；取值不一致 → 歧义
 */
export const PATH_MAP_MULTIPLICITIES = ['single', 'many'] as const;
export type PathMapMultiplicity = (typeof PATH_MAP_MULTIPLICITIES)[number];

/** 映射表的一条：口径字段 → 登记列 + 院内资源路径 + 读法。 */
export const PathMapEntrySchema = z.object({
  /** 口径字段名（与字段口径表同名） */
  field: z.string().min(1),
  /** 登记列名（派生字段为 null） */
  column: z.string().min(1).nullable().default(null),
  /** 院内资源类型；无院内侧（登记专用列）为 null */
  resourceType: z.enum(HOSPITAL_RESOURCE_TYPES).nullable().default(null),
  /** 资源内路径（如 stage / period.start）；无院内侧为 null */
  resourcePath: z.string().min(1).nullable().default(null),
  /** 是否派生字段（值由派生层按口径算出，不直接读资源） */
  derived: z.boolean().default(false),
  /** 该路径可能命中几条 */
  multiplicity: z.enum(PATH_MAP_MULTIPLICITIES).default('single'),
  /** 是否受控编码字段（需归并到院内受控编码） */
  controlledCode: z.boolean().default(false),
  /** 是否人工补充列（登记员自己填，插件只读不覆盖） */
  humanSupplied: z.boolean().default(false),
  /** 口径依据标注（逐项必填） */
  basis: z.string().min(1),
});
export type PathMapEntry = z.infer<typeof PathMapEntrySchema>;

/** 字段路径映射表整体。 */
export const PathMapSchema = z.object({
  /** 映射表版本号，写进 run-log 供核对当时用的是哪版映射 */
  version: z.string().min(1),
  /** 口径依据 */
  basis: z.string().min(1).default('经验推断'),
  /** 表级说明 */
  note: z.string().min(1),
  /** 逐字段声明 */
  entries: z.array(PathMapEntrySchema).min(1),
});
export type PathMap = z.infer<typeof PathMapSchema>;

/** 路径映射相关错误：message 里点名具体字段，便于信息科照着改配置。 */
export class PathMapError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(issues.length > 0 ? `${message}：${issues.join('；')}` : message);
    this.name = 'PathMapError';
    this.issues = issues;
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path.length > 0 ? `${path} ${issue.message}` : issue.message;
  });
}

/* ───────────────────────────── 读法登记表 ───────────────────────────── */

/** 某一类资源的路径读法：从资源视图里取出该路径上的值。 */
export type HospitalPathReader<T> = (view: T) => unknown;

/**
 * 读法登记表：资源类型 → 资源内路径 → 读法。
 *
 * 这张表是「映射能不能执行」的唯一依据：路径没登记读法就是**配置错了**，
 * 加载期就要报错点名，不许等到比对时才发现取不到值。
 */
export const HOSPITAL_PATH_READERS: {
  Patient: Record<string, HospitalPathReader<PatientView>>;
  Condition: Record<string, HospitalPathReader<ConditionView>>;
  Encounter: Record<string, HospitalPathReader<EncounterView>>;
} = {
  Patient: {
    id: (view) => view.id,
    birthDate: (view) => view.birthDate,
    gender: (view) => view.sex,
    // identifier 是可重复元素：一次读出该患者全部 identifier 的值
    identifier: (view) =>
      view.identifiers.map((item) => item.value).filter((value): value is string => value !== null),
  },
  Condition: {
    id: (view) => view.id,
    code: (view) => view.code,
    stage: (view) => view.stage,
    onsetDateTime: (view) => view.onsetDateTime,
  },
  Encounter: {
    id: (view) => view.id,
    'period.start': (view) => view.periodStart,
    'period.end': (view) => view.periodEnd,
    class: (view) => view.class,
    type: (view) => view.type,
    status: (view) => view.status,
  },
};

/* ───────────────────────────── 加载与校验 ───────────────────────────── */

/**
 * 校验字段路径映射表。
 *
 * 除了结构校验，还做一组**表内一致性**检查 —— 这些错一处，映射就会在比对时
 * 悄悄走偏：
 * - 同一个口径字段不得声明两次；同一登记列也不得挂到两个字段上
 * - 人工补充列不得声明院内资源路径，也不得标成受控编码字段
 * - 资源类型与资源内路径必须同时有或同时没有
 * - 资源内路径必须在读法登记表里登记了读法（否则点名 字段 + 路径）
 * - 派生字段必须有院内资源路径，且命中条数口径为 many（派生要从多次就诊里挑）
 */
export function parsePathMap(data: unknown): PathMap {
  const parsed = PathMapSchema.safeParse(data);
  if (!parsed.success) {
    throw new PathMapError('字段路径映射表不符合约定', formatIssues(parsed.error));
  }

  const map = parsed.data;
  const issues: string[] = [];

  const seenFields = new Map<string, number>();
  const seenColumns = new Map<string, string>();
  map.entries.forEach((entry, index) => {
    const previousIndex = seenFields.get(entry.field);
    if (previousIndex !== undefined) {
      issues.push(
        `口径字段「${entry.field}」在映射表里被声明了两次（第 ${previousIndex + 1} 条与第 ${index + 1} 条）`,
      );
    } else {
      seenFields.set(entry.field, index);
    }

    if (entry.column !== null) {
      const owner = seenColumns.get(entry.column);
      if (owner !== undefined) {
        issues.push(
          `登记列「${entry.column}」同时挂到了「${owner}」与「${entry.field}」两个口径字段上`,
        );
      } else {
        seenColumns.set(entry.column, entry.field);
      }
    }

    if (entry.humanSupplied) {
      if (entry.resourceType !== null || entry.resourcePath !== null) {
        issues.push(
          `人工补充列「${entry.field}」不应声明院内资源路径（登记员自己填的，插件只读不覆盖）`,
        );
      }
      if (entry.controlledCode) {
        issues.push(`人工补充列「${entry.field}」不应标为受控编码字段（人工填写的内容不归并）`);
      }
    }

    if ((entry.resourceType === null) !== (entry.resourcePath === null)) {
      issues.push(
        `口径字段「${entry.field}」的院内资源类型与资源内路径必须同时有或同时没有（当前 ${String(entry.resourceType)} / ${String(entry.resourcePath)}）`,
      );
    }

    if (entry.derived) {
      if (entry.resourceType === null) {
        issues.push(`派生字段「${entry.field}」必须声明院内资源类型（派生值来自哪类资源）`);
      }
      if (entry.multiplicity !== 'many') {
        issues.push(
          `派生字段「${entry.field}」的命中条数口径必须是 many（派生值要从多条就诊里按口径挑一条）`,
        );
      }
    }

    if (entry.resourceType !== null && entry.resourcePath !== null) {
      const readers = HOSPITAL_PATH_READERS[entry.resourceType];
      if (!(entry.resourcePath in readers)) {
        issues.push(
          `口径字段「${entry.field}」声明的院内资源路径「${entry.resourceType}.${entry.resourcePath}」没有登记读取方式`,
        );
      }
    }
  });

  if (issues.length > 0) {
    throw new PathMapError('字段路径映射表存在冲突', issues);
  }

  return map;
}

/** 从 JSON 文件加载字段路径映射表。 */
export function loadPathMap(path: string): PathMap {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PathMapError(`读取字段路径映射表失败：${path}`, [message]);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PathMapError(`字段路径映射表不是合法 JSON：${path}`, [message]);
  }

  return parsePathMap(data);
}

/* ─────────────────────── 映射表 ↔ 口径表 交叉校验 ─────────────────────── */

/** 把口径表里的 `ResourceType.path` 拆成资源类型与资源内路径。 */
export function splitResourcePath(resourcePath: string): {
  resourceType: HospitalResourceType;
  path: string;
} {
  const index = resourcePath.indexOf('.');
  const resourceType = index === -1 ? resourcePath : resourcePath.slice(0, index);
  const path = index === -1 ? '' : resourcePath.slice(index + 1);
  if (!(HOSPITAL_RESOURCE_TYPES as readonly string[]).includes(resourceType)) {
    throw new PathMapError(`无法识别的院内资源类型：${resourcePath}`, [
      `已登记的资源类型只有 ${HOSPITAL_RESOURCE_TYPES.join(' / ')}`,
    ]);
  }
  return { resourceType: resourceType as HospitalResourceType, path };
}

/**
 * 把映射表与字段口径表对起来，冲突一律显式报错并点名具体字段。
 *
 * 两条表必须说同一件事：
 * - 口径表声明参与比对的字段，映射表里必须有条目（缺了就点名缺哪个口径字段）
 * - 两侧对同一字段的登记列 / 院内资源路径 / 受控编码 / 人工补充 / 派生标记
 *   必须一致（不一致就点名字段与两侧取值）
 */
export function crossCheckPathMap(spec: FieldSpec, map: PathMap): void {
  const issues: string[] = [];
  const entryByField = new Map(map.entries.map((entry) => [entry.field, entry]));

  for (const specEntry of spec.fields) {
    const entry = entryByField.get(specEntry.field);
    if (entry === undefined) {
      if (specEntry.participatesInDiff) {
        issues.push(
          `口径字段「${specEntry.field}」声明参与比对，但字段路径映射表里没有它的映射`,
        );
      }
      continue;
    }

    if ((entry.column ?? null) !== specEntry.sourceColumn) {
      issues.push(
        `口径字段「${specEntry.field}」的登记列不一致：口径表「${String(specEntry.sourceColumn)}」vs 映射表「${String(entry.column)}」`,
      );
    }
    if (entry.controlledCode !== specEntry.controlledCode) {
      issues.push(
        `口径字段「${specEntry.field}」的受控编码标记不一致：口径表 ${String(specEntry.controlledCode)} vs 映射表 ${String(entry.controlledCode)}`,
      );
    }
    if (entry.humanSupplied !== specEntry.humanSupplied) {
      issues.push(
        `口径字段「${specEntry.field}」的人工补充列标记不一致：口径表 ${String(specEntry.humanSupplied)} vs 映射表 ${String(entry.humanSupplied)}`,
      );
    }
    if (entry.derived !== specEntry.derived) {
      issues.push(
        `口径字段「${specEntry.field}」的派生标记不一致：口径表 ${String(specEntry.derived)} vs 映射表 ${String(entry.derived)}`,
      );
    }

    const specResource = specEntry.resourcePath;
    const mapResource =
      entry.resourceType !== null && entry.resourcePath !== null
        ? `${entry.resourceType}.${entry.resourcePath}`
        : null;
    if ((specResource ?? null) !== mapResource) {
      issues.push(
        `口径字段「${specEntry.field}」的院内资源路径不一致：口径表「${String(specResource)}」vs 映射表「${String(mapResource)}」`,
      );
    }
  }

  for (const entry of map.entries) {
    if (!spec.fields.some((specEntry) => specEntry.field === entry.field)) {
      issues.push(`映射表声明了口径字段「${entry.field}」，但字段口径表里没有这个字段`);
    }
  }

  if (issues.length > 0) {
    throw new PathMapError('字段路径映射表与字段口径表对不上', issues);
  }
}

/* ───────────────────────────── 逐列判定 ───────────────────────────── */

/** 一列在本轮的口径状态。 */
export type PathMapColumnStatus =
  /** 已声明口径，参与比对 */
  | '参与比对'
  /** 已声明口径，但登记员自己填的（只读不覆盖） */
  | '人工补充列'
  /** 已声明口径，但本轮不参与比对（只作建议值或不比对） */
  | '不参与比对'
  /** 口径表没声明这一列 */
  | '口径未声明';

/** 一列的判定结果。 */
export interface PathMapColumn {
  /** 表头列名 */
  column: string;
  /** 口径字段名；未声明时为 null */
  field: string | null;
  /** 本轮口径状态 */
  status: PathMapColumnStatus;
  /** 院内资源类型；无院内侧为 null */
  resourceType: HospitalResourceType | null;
  /** 院内资源内路径；无院内侧为 null */
  resourcePath: string | null;
  /** 是否受控编码字段 */
  controlledCode: boolean;
  /** 是否人工补充列 */
  humanSupplied: boolean;
  /** 面向登记员的说明 */
  reason: string;
}

/**
 * 一个口径字段解析后的完整映射：映射表条目 + 口径表声明。
 *
 * 「是否参与比对」只以口径表为准（那是口径的权威），映射表负责院内侧怎么取。
 */
export interface ResolvedPathEntry {
  /** 口径字段名 */
  field: string;
  /** 登记列名（派生字段为 null） */
  column: string | null;
  /** 院内资源类型；无院内侧为 null */
  resourceType: HospitalResourceType | null;
  /** 资源内路径；无院内侧为 null */
  resourcePath: string | null;
  /** 是否派生字段 */
  derived: boolean;
  /** 该路径可能命中几条 */
  multiplicity: PathMapMultiplicity;
  /** 是否受控编码字段 */
  controlledCode: boolean;
  /** 是否人工补充列 */
  humanSupplied: boolean;
  /** 是否参与本轮比对（以口径表为准） */
  participatesInDiff: boolean;
  /** 口径依据 */
  basis: string;
  /** 映射表原件条目 */
  entry: PathMapEntry;
}

/** 映射表解析结果。 */
export interface PathMapResolution {
  /** 映射表原件 */
  map: PathMap;
  /** 字段口径表原件 */
  spec: FieldSpec;
  /** 解析后的逐字段映射（映射表 + 口径表合并） */
  entries: ResolvedPathEntry[];
  /** 按口径字段名索引的映射条目 */
  entryByField: Map<string, PathMapEntry>;
  /** 按表头顺序的逐列判定 */
  columns: PathMapColumn[];
  /** 口径表没声明的列：本轮不参与比对，显式标「口径未声明」 */
  unspecifiedColumns: string[];
  /** 人工补充列（比对侧与写回侧都必须跳过） */
  humanSuppliedColumns: string[];
}

/**
 * 把映射表、口径表与本张表的表头对起来。
 *
 * 未声明的列不猜、不静默跳过 —— 显式落到 `unspecifiedColumns` 与逐列判定里。
 */
export function resolvePathMap(
  spec: FieldSpec,
  map: PathMap,
  header: string[],
): PathMapResolution {
  crossCheckPathMap(spec, map);

  const entryByField = new Map(map.entries.map((entry) => [entry.field, entry]));
  const specByColumn = new Map<string, FieldSpec['fields'][number]>();
  for (const specEntry of spec.fields) {
    if (specEntry.sourceColumn !== null) {
      specByColumn.set(specEntry.sourceColumn, specEntry);
    }
  }

  const columns: PathMapColumn[] = [];
  const unspecifiedColumns: string[] = [];
  const humanSuppliedColumns: string[] = [];

  const entries: ResolvedPathEntry[] = map.entries.map((entry) => {
    const specEntry = spec.fields.find((item) => item.field === entry.field);
    return {
      field: entry.field,
      column: entry.column,
      resourceType: entry.resourceType,
      resourcePath: entry.resourcePath,
      derived: entry.derived,
      multiplicity: entry.multiplicity,
      controlledCode: entry.controlledCode,
      humanSupplied: entry.humanSupplied,
      participatesInDiff: specEntry?.participatesInDiff ?? false,
      basis: entry.basis,
      entry,
    };
  });

  for (const rawColumn of header.map((name) => name.trim())) {
    const specEntry = specByColumn.get(rawColumn);
    if (specEntry === undefined) {
      unspecifiedColumns.push(rawColumn);
      columns.push({
        column: rawColumn,
        field: null,
        status: '口径未声明',
        resourceType: null,
        resourcePath: null,
        controlledCode: false,
        humanSupplied: false,
        reason: `「${rawColumn}」未在字段口径表中声明，本轮不参与比对、不产生任何差异值`,
      });
      continue;
    }

    const entry = entryByField.get(specEntry.field);
    if (specEntry.humanSupplied) {
      humanSuppliedColumns.push(rawColumn);
      columns.push({
        column: rawColumn,
        field: specEntry.field,
        status: '人工补充列',
        resourceType: null,
        resourcePath: null,
        controlledCode: false,
        humanSupplied: true,
        reason: `「${rawColumn}」是人工补充列，只读不覆盖、不参与比对`,
      });
      continue;
    }

    const participates = specEntry.participatesInDiff;
    columns.push({
      column: rawColumn,
      field: specEntry.field,
      status: participates ? '参与比对' : '不参与比对',
      resourceType: entry?.resourceType ?? null,
      resourcePath: entry?.resourcePath ?? null,
      controlledCode: specEntry.controlledCode,
      humanSupplied: false,
      reason: participates
        ? `「${rawColumn}」按口径「${specEntry.description}」参与比对`
        : `「${rawColumn}」本轮不参与比对（${specEntry.description}）`,
    });
  }

  return {
    map,
    spec,
    entries,
    entryByField,
    columns,
    unspecifiedColumns,
    humanSuppliedColumns,
  };
}

/* ───────────────────────────── 院内取值 ───────────────────────────── */

/** 院内取值的结果状态。 */
export const HOSPITAL_VALUE_STATUSES = ['已取到', '未取到', '歧义'] as const;
export type HospitalValueStatus = (typeof HOSPITAL_VALUE_STATUSES)[number];

/** 一个口径字段的院内取值结果。 */
export interface HospitalValueResult {
  /** 口径字段名 */
  field: string;
  /** 取值状态 */
  status: HospitalValueStatus;
  /** 取到的值；未取到时为 undefined */
  value: unknown;
  /** 面向登记员的原因 */
  reason: string;
  /** 取值来自哪些资源 id */
  sourceIds: string[];
}

/** 一行院内权威记录（与检索层给出的 ParsedRecord 结构一致）。 */
export interface HospitalRecordView {
  patient: PatientView | null;
  conditions: ConditionView[];
  encounters: EncounterView[];
}

/** 一次命中：值 + 来源资源 id。 */
interface Candidate {
  value: unknown;
  resourceId: string | null;
}

/**
 * 展开一个资源上的路径取值。
 *
 * 可重复元素（Patient.identifier）读出来是数组 → 展开成多个候选值；
 * 资源上根本没有这个路径（读出来是 null / undefined）→ 该资源不贡献候选值。
 */
function expandCandidates(value: unknown, resourceId: string | null): Candidate[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== null && item !== undefined)
      .map((item) => ({ value: item, resourceId }));
  }
  return [{ value, resourceId }];
}

/** 按映射条目到院内记录里取该路径上的全部候选值。 */
function collectCandidates(entry: ResolvedPathEntry, record: HospitalRecordView): Candidate[] {
  const resourceType = entry.resourceType;
  const resourcePath = entry.resourcePath;
  if (resourceType === null || resourcePath === null) return [];

  switch (resourceType) {
    case 'Patient': {
      const patient = record.patient;
      if (!patient) return [];
      const reader = HOSPITAL_PATH_READERS.Patient[resourcePath];
      if (!reader) {
        throw new PathMapError(
          `院内资源路径未登记读取方式：${resourceType}.${resourcePath}`,
          [`口径字段「${entry.field}」声明的路径没有读取方式`],
        );
      }
      return expandCandidates(reader(patient), patient.id);
    }
    case 'Condition': {
      const reader = HOSPITAL_PATH_READERS.Condition[resourcePath];
      if (!reader) {
        throw new PathMapError(
          `院内资源路径未登记读取方式：${resourceType}.${resourcePath}`,
          [`口径字段「${entry.field}」声明的路径没有读取方式`],
        );
      }
      return record.conditions.flatMap((condition) =>
        expandCandidates(reader(condition), condition.id),
      );
    }
    case 'Encounter': {
      const reader = HOSPITAL_PATH_READERS.Encounter[resourcePath];
      if (!reader) {
        throw new PathMapError(
          `院内资源路径未登记读取方式：${resourceType}.${resourcePath}`,
          [`口径字段「${entry.field}」声明的路径没有读取方式`],
        );
      }
      return record.encounters.flatMap((encounter) =>
        expandCandidates(reader(encounter), encounter.id),
      );
    }
    default:
      return [];
  }
}

/** 去重后的取值（按差异引擎的深度相等判定）。 */
function distinctValues(values: unknown[]): unknown[] {
  const result: unknown[] = [];
  for (const value of values) {
    if (!result.some((existing) => diffValuesEqual(existing, value))) {
      result.push(value);
    }
  }
  return result;
}

/**
 * 按映射条目取一个口径字段的院内值。
 *
 * 三种结果，各有各的说法：
 * - **已取到**：只有一条取值（或多条资源取值一致）→ 可参与比对
 * - **未取到**：院内本轮没有这个字段 → 不参与比对（**不等于院内没有**，
 *   更不能据此判「删除」）
 * - **歧义**：同一路径命中多条资源且取值不一致 → 不产出院内值，
 *   **绝不取第一条**
 */
export function readHospitalValue(
  entry: ResolvedPathEntry,
  record: HospitalRecordView,
  derivedValues?: Record<string, unknown>,
): HospitalValueResult {
  if (entry.humanSupplied) {
    return {
      field: entry.field,
      status: '未取到',
      value: undefined,
      reason: '人工补充列只读不覆盖，不参与比对',
      sourceIds: [],
    };
  }

  if (entry.derived) {
    const derived = derivedValues?.[entry.field];
    if (derived === undefined || derived === null || derived === '') {
      return {
        field: entry.field,
        status: '未取到',
        value: undefined,
        reason: `派生字段「${entry.field}」本轮未取到（口径未声明或日期不可解析），本轮不参与比对`,
        sourceIds: [],
      };
    }
    return {
      field: entry.field,
      status: '已取到',
      value: derived,
      reason: `派生字段「${entry.field}」按口径算出`,
      sourceIds: [],
    };
  }

  if (entry.resourceType === null || entry.resourcePath === null) {
    return {
      field: entry.field,
      status: '未取到',
      value: undefined,
      reason: `口径字段「${entry.field}」没有院内资源路径，本轮不参与比对`,
      sourceIds: [],
    };
  }

  const candidates = collectCandidates(entry, record);
  if (candidates.length === 0) {
    return {
      field: entry.field,
      status: '未取到',
      value: undefined,
      reason: `院内本轮未取到「${entry.field}」（${entry.resourceType}.${entry.resourcePath}），本轮不参与比对`,
      sourceIds: [],
    };
  }

  const sourceIds = [
    ...new Set(candidates.map((candidate) => candidate.resourceId).filter((id): id is string => id !== null)),
  ];

  const resourceCount = new Set(
    candidates.map((candidate) => candidate.resourceId ?? '（无 id）'),
  ).size;
  if (entry.multiplicity === 'single' && candidates.length > 1) {
    return {
      field: entry.field,
      status: '歧义',
      value: undefined,
      reason: `「${entry.field}」按单值声明，却命中 ${candidates.length} 处取值，本轮不产出院内值`,
      sourceIds,
    };
  }

  const values = distinctValues(candidates.map((candidate) => candidate.value));
  if (values.length > 1) {
    return {
      field: entry.field,
      status: '歧义',
      value: undefined,
      reason: `「${entry.field}」在 ${resourceCount} 条院内资源上取值不一致，本轮不产出院内值（不取第一条）`,
      sourceIds,
    };
  }

  return {
    field: entry.field,
    status: '已取到',
    value: values[0],
    reason: `「${entry.field}」取自 ${entry.resourceType}.${entry.resourcePath}`,
    sourceIds,
  };
}

/** 一行院内值：可参与比对的取值 + 逐字段取数说明。 */
export interface HospitalValues {
  /** 口径字段名 → 院内值；只含「已取到」的字段 */
  values: Record<string, unknown>;
  /** 逐字段取数结果（含未取到与歧义的原因） */
  results: HospitalValueResult[];
}

/** 按映射表取一行院内值。 */
export function collectHospitalValues(
  resolution: PathMapResolution,
  record: HospitalRecordView,
  derivedValues?: Record<string, unknown>,
): HospitalValues {
  const values: Record<string, unknown> = {};
  const results: HospitalValueResult[] = [];

  for (const entry of resolution.entries) {
    const result = readHospitalValue(entry, record, derivedValues);
    results.push(result);
    if (result.status === '已取到') {
      values[entry.field] = result.value;
    }
  }

  return { values, results };
}

/* ───────────────────────── 受控编码等价判定 ───────────────────────── */

/** 一次归并的结果。 */
export interface ControlledCodeResolution {
  /** 归并到的受控编码；归不出为 null */
  code: string | null;
  /** 归并依据（写进建议值列的说明） */
  reason: string;
  /** 置信度（0–1）；缺省视为 1 */
  confidence?: number;
}

/**
 * 归并层接入点。
 *
 * 受控词表与模型兜底由归并层实现（受控编码词表 + 置信度分级）；
 * 本层只负责「哪些字段是受控编码字段」「归并后相等即视为无差异」。
 */
export interface ControlledCodeResolver {
  /** 把一个自由写法归并到受控编码；归不出返回 code=null */
  resolve(field: string, rawValue: string): ControlledCodeResolution;
}

/**
 * 生成受控编码等价判定（给差异引擎当 `equivalent` 用）。
 *
 * 规则：**归并后受控编码相等 → 视为同一值，不产生任何操作**。
 * 只要有一侧归不出来，就不算等价 —— 宁可留一条差异让登记员看，
 * 也不把一条真差异悄悄抹掉。
 */
export function createControlledCodeEquivalence(
  map: PathMap,
  resolver: ControlledCodeResolver,
): EquivalentPredicate {
  const controlled = new Set(
    map.entries.filter((entry) => entry.controlledCode).map((entry) => entry.field),
  );

  return (field, oldValue, newValue) => {
    if (!controlled.has(field)) return false;
    if (typeof oldValue !== 'string' || typeof newValue !== 'string') return false;

    const registry = resolver.resolve(field, oldValue);
    const hospital = resolver.resolve(field, newValue);
    if (registry.code === null || hospital.code === null) return false;
    return registry.code === hospital.code;
  };
}

/** 一条归并建议：写法不同但归并后等价时给出。 */
export interface MergeSuggestion {
  /** 口径字段名 */
  field: string;
  /** 登记列名 */
  column: string | null;
  /** 登记侧写法 */
  rawValue: unknown;
  /** 院内取值 */
  hospitalValue: unknown;
  /** 建议统一成的受控编码（取院内侧归并结果） */
  mergedCode: string;
  /** 建议依据 */
  reason: string;
}

/**
 * 收集受控编码字段的归并建议。
 *
 * 只有「两侧写法不同、但归并后受控编码相同」才给建议 —— 这类行不产生差异操作，
 * 只在建议值列提示统一写法。归不出、或归并后编码不同，都不给建议。
 */
export function collectMergeSuggestions(input: {
  resolution: PathMapResolution;
  registryValues: Record<string, unknown>;
  hospitalValues: Record<string, unknown>;
  resolver: ControlledCodeResolver;
}): MergeSuggestion[] {
  const suggestions: MergeSuggestion[] = [];

  for (const entry of input.resolution.entries) {
    if (!entry.controlledCode || entry.humanSupplied) continue;
    if (!entry.participatesInDiff) continue;

    const oldValue = input.registryValues[entry.field];
    const newValue = input.hospitalValues[entry.field];
    if (typeof oldValue !== 'string' || typeof newValue !== 'string') continue;
    if (oldValue === newValue) continue;

    const registry = input.resolver.resolve(entry.field, oldValue);
    const hospital = input.resolver.resolve(entry.field, newValue);
    if (registry.code === null || hospital.code === null) continue;
    if (registry.code !== hospital.code) continue;

    suggestions.push({
      field: entry.field,
      column: entry.column,
      rawValue: oldValue,
      hospitalValue: newValue,
      mergedCode: hospital.code,
      reason: `写法归并后等价，建议统一为受控编码 ${hospital.code}`,
    });
  }

  return suggestions;
}

/* ─────────────────────── 比对输入装配 ─────────────────────── */

/**
 * 按映射表装配比对输入（给差异引擎逐字段比对）。
 *
 * 排除两类字段：人工补充列（只读不覆盖）与本轮不参与比对的字段。
 * 「口径未声明」的列根本不在映射表里，天然不会进这里 —— 不猜值。
 */
export function buildComparableInputs(input: {
  resolution: PathMapResolution;
  /** 口径字段名 → 登记侧归一值 */
  registryValues: Record<string, unknown>;
  /** 口径字段名 → 院内值 */
  hospitalValues: Record<string, unknown>;
  /** 口径字段名 → 登记侧未归一化原值（可选，供写前比对用） */
  rawRegistryValues?: Record<string, unknown>;
  /** 口径字段名 → 院内原值（可选） */
  rawHospitalValues?: Record<string, unknown>;
}): FieldDiffInput[] {
  const { resolution, registryValues, hospitalValues } = input;
  const inputs: FieldDiffInput[] = [];

  for (const entry of resolution.entries) {
    if (entry.humanSupplied) continue;
    if (!entry.participatesInDiff) continue;
    if (!Object.prototype.hasOwnProperty.call(registryValues, entry.field)) continue;
    if (!Object.prototype.hasOwnProperty.call(hospitalValues, entry.field)) continue;

    inputs.push({
      field: entry.field,
      column: entry.column,
      oldValue: registryValues[entry.field],
      newValue: hospitalValues[entry.field],
      rawOldValue: input.rawRegistryValues?.[entry.field],
      rawNewValue: input.rawHospitalValues?.[entry.field],
      controlledCode: entry.controlledCode,
    });
  }

  return inputs;
}
