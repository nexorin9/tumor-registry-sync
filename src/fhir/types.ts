/**
 * FHIR R4 检索用到的最小资源类型。
 *
 * 这一层刻意只声明本产品真正读到的字段，不做完整的 FHIR 类型推导：
 * 院内 FHIR 服务各家的实现细节差异很大，**只按本轮需要的字段取值**，
 * 取不到的字段一律显式标「缺关键字段」，绝不拿别的字段顶替。
 *
 * 口径说明（经验推断）：肿瘤登记没有院内权威资产可依，本文件的字段取舍按
 * 「登记员要对齐什么」倒推，不虚构分期编码位数、目录结构或量限数字。
 */

/** 本轮允许检索的资源类型：患者、诊断与分期、就诊。 */
export const FHIR_RESOURCE_TYPES = ['Patient', 'Condition', 'Encounter'] as const;
export type FhirResourceType = (typeof FHIR_RESOURCE_TYPES)[number];

/** 资源类型白名单检查：不在白名单里的类型显式报错，不静默放过。 */
export function isFhirResourceType(value: string): value is FhirResourceType {
  return (FHIR_RESOURCE_TYPES as readonly string[]).includes(value);
}

/** FHIR 标识符（Patient.identifier 等）。 */
export interface FhirIdentifier {
  use?: string;
  system?: string;
  value?: string;
}

/** FHIR 编码（Coding）：system + code + display。 */
export interface FhirCoding {
  system?: string;
  code?: string;
  display?: string;
}

/** FHIR 可编码概念（CodeableConcept）。 */
export interface FhirCodeableConcept {
  coding?: FhirCoding[];
  text?: string;
}

/** FHIR 引用（Reference）。 */
export interface FhirReference {
  reference?: string;
  display?: string;
}

/** FHIR 时间段（Period）。 */
export interface FhirPeriod {
  start?: string;
  end?: string;
}

/** FHIR 资源（只声明本轮读到的字段，其余字段按需再取）。 */
export interface FhirResource {
  resourceType?: string;
  id?: string;
  identifier?: FhirIdentifier[];
  /** Patient */
  birthDate?: string;
  gender?: string;
  /** Condition / Encounter */
  subject?: FhirReference;
  patient?: FhirReference;
  code?: FhirCodeableConcept;
  onsetDateTime?: string;
  stage?: FhirCodeableConcept;
  period?: FhirPeriod;
  class?: FhirCoding;
  type?: FhirCodeableConcept;
  status?: string;
  [key: string]: unknown;
}

/** Bundle 链接：分页靠 link[relation=next]。 */
export interface FhirBundleLink {
  relation?: string;
  url?: string;
}

/** Bundle 条目。 */
export interface FhirBundleEntry {
  fullUrl?: string;
  resource?: FhirResource;
}

/** FHIR 检索返回的 Bundle。 */
export interface FhirBundle {
  resourceType?: string;
  total?: number;
  link?: FhirBundleLink[];
  entry?: FhirBundleEntry[];
}
