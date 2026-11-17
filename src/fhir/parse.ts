/**
 * Bundle → 逐行权威记录视图。
 *
 * 这一层只做**取值**，不做比对、不做归并。两条原则：
 * - 关键字段缺失时**显式记一条缺字段问题**，并把该字段列入
 *   `unavailableFields`：下游不得把它当成「院内为空」，更不能据此判「删除」
 * - 取值不做任何猜测：分期取不到就是取不到，不拿别的字段顶替
 *
 * 字段口径（经验推断）：诊断取 code / onsetDateTime / stage，
 * 就诊取 period.start / period.end / class / type。
 */
import type { FhirCodeableConcept, FhirCoding, FhirResource } from './types.js';

/** 缺关键字段的问题。 */
export interface FieldIssue {
  /** 资源类型 */
  resourceType: string;
  /** 资源 id（取不到时为 null） */
  resourceId: string | null;
  /** 缺哪个字段 */
  field: string;
  /** 面向人的原因 */
  reason: string;
}

/** 患者视图。 */
export interface PatientView {
  id: string;
  birthDate: string | null;
  sex: string | null;
  identifiers: { system: string | null; value: string | null }[];
}

/** 诊断（含分期）视图。 */
export interface ConditionView {
  id: string | null;
  code: string | null;
  codeSystem: string | null;
  onsetDateTime: string | null;
  stage: string | null;
}

/** 就诊视图。 */
export interface EncounterView {
  id: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  class: string | null;
  type: string | null;
  status: string | null;
}

/** 一行权威记录视图。 */
export interface ParsedRecord {
  patient: PatientView | null;
  conditions: ConditionView[];
  encounters: EncounterView[];
  /** 缺关键字段的问题 */
  issues: FieldIssue[];
  /** 取不到、不参与比对的字段（如 Condition.code、Encounter.period.start） */
  unavailableFields: string[];
}

function textOf(value: string | undefined): string | null {
  if (value === undefined) return null;
  const text = value.trim();
  return text.length === 0 ? null : text;
}

/** 取 CodeableConcept 的编码与体系。 */
function codingOf(concept: FhirCodeableConcept | undefined): {
  code: string | null;
  system: string | null;
} {
  const coding = concept?.coding?.[0];
  return {
    code: textOf(coding?.code) ?? textOf(concept?.text),
    system: textOf(coding?.system),
  };
}

/** 取 Coding 的 code。 */
function codingCode(coding: FhirCoding | undefined): string | null {
  return textOf(coding?.code) ?? textOf(coding?.display);
}

/**
 * 解析患者：id 是关键字段（后续诊断/就诊都要按它引用），缺失即记问题。
 */
export function parsePatient(resource: FhirResource): {
  patient: PatientView | null;
  issues: FieldIssue[];
} {
  const issues: FieldIssue[] = [];
  const id = textOf(resource.id);
  if (id === null) {
    issues.push({
      resourceType: 'Patient',
      resourceId: null,
      field: 'id',
      reason: '院内 Patient 资源缺 id，无法作为后续诊断与就诊的引用主体',
    });
    return { patient: null, issues };
  }

  const identifiers = (resource.identifier ?? []).map((identifier) => ({
    system: textOf(identifier.system),
    value: textOf(identifier.value),
  }));

  return {
    patient: {
      id,
      birthDate: textOf(resource.birthDate),
      sex: textOf(resource.gender),
      identifiers,
    },
    issues,
  };
}

/**
 * 解析诊断：code 是关键字段（分期口径挂在这里），缺失即记问题。
 */
export function parseCondition(resource: FhirResource): {
  condition: ConditionView;
  issues: FieldIssue[];
} {
  const issues: FieldIssue[] = [];
  const id = textOf(resource.id);
  const { code, system } = codingOf(resource.code);

  if (code === null) {
    issues.push({
      resourceType: 'Condition',
      resourceId: id,
      field: 'Condition.code',
      reason: '院内诊断资源缺 code，该字段不参与比对',
    });
  }

  return {
    condition: {
      id,
      code,
      codeSystem: system,
      onsetDateTime: textOf(resource.onsetDateTime),
      stage: textOf(resource.stage?.text) ?? codingCode(resource.stage?.coding?.[0]),
    },
    issues,
  };
}

/**
 * 解析就诊：period.start 是关键字段（派生首次入院日靠它），缺失即记问题。
 */
export function parseEncounter(resource: FhirResource): {
  encounter: EncounterView;
  issues: FieldIssue[];
} {
  const issues: FieldIssue[] = [];
  const id = textOf(resource.id);
  const periodStart = textOf(resource.period?.start);
  const periodEnd = textOf(resource.period?.end);

  if (periodStart === null) {
    issues.push({
      resourceType: 'Encounter',
      resourceId: id,
      field: 'Encounter.period.start',
      reason: '院内就诊资源缺 period.start，本次就诊开始与首次入院日不参与比对',
    });
  }

  return {
    encounter: {
      id,
      periodStart,
      periodEnd,
      class: codingCode(resource.class),
      type: textOf(resource.type?.text) ?? codingCode(resource.type?.coding?.[0]),
      status: textOf(resource.status),
    },
    issues,
  };
}

/** 合并患者、诊断、就诊三类资源为一行权威记录视图。 */
export function parseRecord(input: {
  patientResources: FhirResource[];
  conditionResources: FhirResource[];
  encounterResources: FhirResource[];
}): ParsedRecord {
  const issues: FieldIssue[] = [];
  const unavailableFields: string[] = [];

  let patient: PatientView | null = null;
  for (const resource of input.patientResources) {
    const parsed = parsePatient(resource);
    issues.push(...parsed.issues);
    if (parsed.patient && patient === null) {
      patient = parsed.patient;
    }
  }
  if (patient === null && input.patientResources.length > 0) {
    unavailableFields.push('Patient.id');
  }

  const conditions: ConditionView[] = [];
  for (const resource of input.conditionResources) {
    const parsed = parseCondition(resource);
    issues.push(...parsed.issues);
    for (const issue of parsed.issues) {
      if (!unavailableFields.includes(issue.field)) unavailableFields.push(issue.field);
    }
    conditions.push(parsed.condition);
  }

  const encounters: EncounterView[] = [];
  for (const resource of input.encounterResources) {
    const parsed = parseEncounter(resource);
    issues.push(...parsed.issues);
    for (const issue of parsed.issues) {
      if (!unavailableFields.includes(issue.field)) unavailableFields.push(issue.field);
    }
    encounters.push(parsed.encounter);
  }

  return { patient, conditions, encounters, issues, unavailableFields };
}
