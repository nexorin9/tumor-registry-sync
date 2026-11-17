/**
 * 检索参数构造。
 *
 * 登记员的表里只有一个「登记号」，院内 FHIR 侧却要一串检索条件；这一层负责
 * 把登记号**稳定地**翻译成 FHIR R4 的 token 检索参数，并把实际发出去的参数
 * 原样留下来（供批次检索参数串复现，见任务 26）。
 *
 * 口径（经验推断）：
 * - 登记号落在 Patient.identifier 上，token 形如 `{system}|{value}`，
 *   system 取自环境变量 CDR_IDENTIFIER_SYSTEM
 * - 诊断与就诊按患者引用取：Condition 用 `subject=Patient/{id}`，
 *   Encounter 用 `patient=Patient/{id}`
 * - 日期区间用重复参数表达：`?date=ge2024-01-01&date=le2024-12-31`
 */
import { FHIR_RESOURCE_TYPES, type FhirResourceType } from './types.js';

/** 检索参数值：单值或重复值（日期区间用重复值）。 */
export type SearchParamValue = string | string[];

/** 一组检索参数。 */
export type SearchParams = Record<string, SearchParamValue>;

/**
 * token 检索值：`{system}|{value}`。
 * system 为空时抛错——没有 system 的 token 检索会命中同号不同源的患者，
 * 那正是「歧义」的来源，宁可报错也不发这种请求。
 */
export function identifierToken(system: string, value: string): string {
  if (system.trim().length === 0) {
    throw new Error('缺少登记主索引的 identifier system：请检查环境变量 CDR_IDENTIFIER_SYSTEM');
  }
  if (value.trim().length === 0) {
    throw new Error('登记号为空，无法构造 token 检索参数');
  }
  return `${system.trim()}|${value.trim()}`;
}

/** 按登记主索引检索患者。 */
export function patientByIdentifierParams(system: string, registryId: string): SearchParams {
  return { identifier: identifierToken(system, registryId) };
}

/** 按患者引用检索诊断与分期。 */
export function conditionByPatientParams(patientId: string): SearchParams {
  return { subject: patientReference(patientId) };
}

/** 按患者引用检索就诊。 */
export function encounterByPatientParams(patientId: string): SearchParams {
  return { patient: patientReference(patientId) };
}

/** 患者引用：`Patient/{id}`。 */
export function patientReference(patientId: string): string {
  if (patientId.trim().length === 0) {
    throw new Error('缺少患者 id，无法构造患者引用检索参数');
  }
  return `Patient/${patientId.trim()}`;
}

/**
 * 日期区间参数：`{name: ['ge<开始>', 'le<结束>']}`。
 * 起止只给一个也允许（FHIR 支持单边区间）。
 */
export function dateRangeParams(
  name: string,
  start: string | null,
  end: string | null,
): SearchParams {
  const values: string[] = [];
  if (start !== null && start.trim().length > 0) values.push(`ge${start.trim()}`);
  if (end !== null && end.trim().length > 0) values.push(`le${end.trim()}`);
  if (values.length === 0) {
    throw new Error(`日期区间参数 ${name} 的起止都为空`);
  }
  return { [name]: values };
}

/** 参数编码：同名多值按出现顺序追加（与 FHIR 的重复参数语义一致）。 */
export function encodeSearchParams(params: SearchParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      search.append(key, item);
    }
  }
  return search.toString();
}

/** 资源类型不在白名单时显式报错——不静默放过未知端点形态。 */
export function assertResourceType(resourceType: string): FhirResourceType {
  if (!(FHIR_RESOURCE_TYPES as readonly string[]).includes(resourceType)) {
    throw new Error(
      `不支持的资源类型「${resourceType}」，本轮只检索 ${FHIR_RESOURCE_TYPES.join(' / ')}`,
    );
  }
  return resourceType as FhirResourceType;
}

/** 拼出完整的检索地址（相对 CDR 基地址）。 */
export function buildSearchPath(resourceType: string, params: SearchParams): string {
  const type = assertResourceType(resourceType);
  const query = encodeSearchParams(params);
  return query.length > 0 ? `/fhir/R4/${type}?${query}` : `/fhir/R4/${type}`;
}
