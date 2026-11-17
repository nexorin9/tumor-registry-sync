/**
 * 派生字段计算：首次入院日 / 本次就诊开始。
 *
 * 这两个字段**不在院内资源的字段列表里** —— 它们是算出来的：
 * - 首次入院日 = 所选就诊集合中 period.start 最早的一条（折算到院内本地时区后的日期）
 * - 本次就诊开始 = 所选就诊集合中 period.start 最近的一条
 *
 * 算它就得先说清楚口径（按哪条规则、取哪几次就诊），所以**取数口径来自字段口径表**，
 * 不是代码里写死的默认值：口径表声明了哪个规则就用哪个，没声明就不算。
 * 算不出来只有三种可能，每种都明说：
 * - 口径没声明 → 「口径未声明」，该字段本轮不参与比对
 * - 口径声明了但院内没有可用就诊 → 「口径未声明」，该字段本轮不参与比对
 * - 口径声明了、就诊也有，但日期写法认不出 → 「日期不可解析」，该字段本轮不参与比对
 *
 * **绝不按空值参与比对**：空值参与比对会被算成一条「删除」操作，等于让插件建议
 * 登记员删掉一个本来就有值的字段。派生字段取不到就整条不参与。
 */
import type { RowIssue } from '../contract/index.js';

import {
  buildDerivedRow,
  DEFAULT_HOSPITAL_UTC_OFFSET_MINUTES,
  DERIVED_FIELDS,
  type DerivedCaliberDeclaration,
  type DerivedFieldName,
  type DerivedRowView,
} from '../fhir/derived-view.js';
import type { EncounterView } from '../fhir/parse.js';

import type { FieldSpec } from './field-spec.js';

/**
 * 从口径表取出派生字段的取数口径。
 *
 * 口径表里声明了 derivedCaliber 的派生字段才会进这份声明；
 * 没声明的字段不出现 → 下游按「口径未声明」处理。
 */
export function derivedCalibersFromSpec(spec: FieldSpec): DerivedCaliberDeclaration {
  const declaration: DerivedCaliberDeclaration = {};
  for (const entry of spec.fields) {
    if (!entry.derived || entry.derivedCaliber === null) continue;
    // 口径表校验已保证派生字段名在支持集合内；这里再挡一道，避免越界键进声明
    const field = entry.field as DerivedFieldName;
    if (!(DERIVED_FIELDS as readonly string[]).includes(field)) continue;
    const rule = entry.derivedCaliber.rule;
    const filter = entry.derivedCaliber.encounterFilter;
    declaration[field] = {
      rule,
      encounterFilter:
        filter === null || (filter.classCode === null && filter.typeText === null)
          ? null
          : {
              classCode: filter.classCode,
              typeText: filter.typeText,
            },
    };
  }
  return declaration;
}

/** 一个派生字段的取值结果（面向表内呈现）。 */
export interface DerivedFieldOutcome {
  /** 口径字段名 */
  field: string;
  /** 口径表里是否声明了这个派生字段 */
  declaredInSpec: boolean;
  /** 状态：已取到 / 口径未声明 / 日期不可解析 */
  status: string;
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

/** 一行的派生字段计算结果。 */
export interface DerivedFieldsResult {
  /** 派生字段取值（按口径字段名索引） */
  derived: Record<string, DerivedFieldOutcome>;
  /** 行级问题（日期不可解析等） */
  issues: RowIssue[];
  /** 本轮不参与比对的字段 */
  unavailableFields: string[];
  /** 派生视图原件（下游按需再取） */
  view: DerivedRowView;
}

export interface BuildDerivedFieldsInput {
  /** 字段口径表 */
  spec: FieldSpec;
  /** 表内行号 */
  rowNumber: number;
  /** 登记主索引 */
  registryId: string;
  /** 该行的院内就诊记录 */
  encounters?: EncounterView[];
  /** 院内本地时区偏移（分钟），默认东八区 */
  hospitalUtcOffsetMinutes?: number;
  /** 上游行级问题（读表层 / 检索层已记的） */
  issues?: RowIssue[];
}

/**
 * 按口径表算一行的派生字段。
 *
 * 口径表没声明的派生字段一律「口径未声明」，不参与比对 ——
 * 口径先于取值，没声明就不算。
 */
export function buildDerivedFields(input: BuildDerivedFieldsInput): DerivedFieldsResult {
  const calibers = derivedCalibersFromSpec(input.spec);
  const declared = new Set(Object.keys(calibers));

  const view = buildDerivedRow({
    rowNumber: input.rowNumber,
    registryId: input.registryId,
    encounters: input.encounters ?? [],
    calibers,
    hospitalUtcOffsetMinutes:
      input.hospitalUtcOffsetMinutes ?? DEFAULT_HOSPITAL_UTC_OFFSET_MINUTES,
    issues: input.issues ?? [],
  });

  const derived: Record<string, DerivedFieldOutcome> = {};
  for (const [field, result] of Object.entries(view.derived)) {
    derived[field] = {
      field: result.field,
      declaredInSpec: declared.has(field),
      status: result.status,
      date: result.date,
      instant: result.instant,
      sourceEncounterIds: result.sourceEncounterIds,
      reason: result.reason,
      participatesInDiff: result.participatesInDiff,
    };
  }

  return {
    derived,
    issues: view.issues,
    unavailableFields: view.unavailableFields,
    view,
  };
}

/** 离线回放里的一个患者（院内权威记录侧）。 */
export interface ReplayPatientInput {
  /** 院内 Patient.id */
  patientId: string;
  /**
   * 行标识：登记主索引（脱敏占位标识）。
   *
   * 离线回放集是**院内侧**数据，没有登记主索引，取院内 identifier 的 token 值顶上，
   * 只用于把派生结果与患者对上，不参与任何比对。
   */
  identifier: string | null;
  /** 该患者的就诊记录 */
  encounters: EncounterView[];
}

/** 离线回放的一行派生结果。 */
export interface ReplayDerivedRow {
  /** 院内 Patient.id */
  patientId: string;
  /** 行标识（登记主索引；离线回放集里取院内 identifier 的 token 值） */
  identifier: string | null;
  /** 派生字段取值 */
  derived: Record<string, DerivedFieldOutcome>;
  /** 本轮不参与比对的字段 */
  unavailableFields: string[];
}

/**
 * 离线回放：按口径表给一批院内权威记录算派生字段。
 *
 * 用途是**离线核对口径是否生效**（不依赖网络与院内凭据）：
 * 口径表改了规则，这里的结果跟着变；口径表没声明，这里就标「口径未声明」。
 */
export function buildReplayDerivedRows(input: {
  spec: FieldSpec;
  patients: ReplayPatientInput[];
  /** 只算前 N 位（默认全部） */
  limit?: number;
}): ReplayDerivedRow[] {
  const limit = input.limit ?? input.patients.length;
  const rows: ReplayDerivedRow[] = [];
  for (const patient of input.patients.slice(0, Math.max(0, limit))) {
    const result = buildDerivedFields({
      spec: input.spec,
      rowNumber: rows.length + 2,
      registryId: patient.identifier ?? patient.patientId,
      encounters: patient.encounters,
    });
    rows.push({
      patientId: patient.patientId,
      identifier: patient.identifier,
      derived: result.derived,
      unavailableFields: result.unavailableFields,
    });
  }
  return rows;
}
