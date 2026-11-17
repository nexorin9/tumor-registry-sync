#!/usr/bin/env node
/**
 * Synthea FHIR R4 导出获取脚本 —— 院内权威记录的离线回放数据源。
 *
 * 为什么需要它：真实院内数据拿不到，但「批量检索 → 逐字段差异 → 幂等推送」这条
 * 主干必须有**真实规模、真实字段形状**的权威记录才能验。本脚本按 Synthea 的官方
 * 分发方式拿到 FHIR R4 导出，规范化成回放集，供离线回放、对照基线与规模验收使用。
 *
 * 三条纪律：
 * 1. **可重跑**：已有完整回放集时跳过下载与生成，只刷新 manifest，不重复写数据文件。
 * 2. **断网降级**：断网且本地缓存可用时直接复用并在 manifest 标注 source=cache；
 *    断网且无缓存时非零退出，并打印可执行的降级说明（不空转、不伪造数据）。
 * 3. **不冒充最终对接**：本脚本产出的是**验证用回放集**。产品的真实对接面仍是
 *    院内 CDR 的 FHIR R4 只读接口与专病库登记接口（见 spec.md「数据来源」一节）。
 *
 * 官方分发方式：Synthea 由 MITRE 以 Apache-2.0 许可发布到 Maven Central
 * （groupId=org.mitre.synthea）与 GitHub Release，两者同为一个官方制品。
 * 默认走 Maven Central（体积相同、链路更短），可用 --source-url 换成 GitHub Release。
 *
 * 用法：
 *   node dist/scripts/fetch-synthea.js --out data/replay --patients 300
 *   node dist/scripts/fetch-synthea.js --out data/replay --patients 300 --offline true
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';

import { errorResponse, okResponse } from '../contract/index.js';
import type { ErrorCode } from '../contract/index.js';
import type { FhirCoding, FhirResource } from '../fhir/types.js';

/** 默认 Synthea 版本（与 spec.md「数据来源」一节一致）。 */
export const DEFAULT_SYNTHEA_VERSION = '4.0.0';

/** 官方制品地址：Maven Central（默认）与 GitHub Release（备选，同一个官方制品）。 */
export function mavenCentralUrl(version: string): string {
  return `https://repo1.maven.org/maven2/org/mitre/synthea/synthea/${version}/synthea-${version}-with-dependencies.jar`;
}

export function githubReleaseUrl(version: string): string {
  return `https://github.com/synthetichealth/synthea/releases/download/v${version}/synthea-with-dependencies.jar`;
}

/** 规模下限（写进验收）：三类资源各 ≥ 300，且每个 Patient 至少一条 Encounter。 */
export const DEFAULT_THRESHOLDS: ValidationThresholds = {
  minPatients: 300,
  minConditions: 300,
  minEncounters: 300,
  requireEncounterPerPatient: true,
};

export interface ValidationThresholds {
  minPatients: number;
  minConditions: number;
  minEncounters: number;
  requireEncounterPerPatient: boolean;
}

/** 回放集：只保留本产品真正读到的三类资源。 */
export interface ReplayDataset {
  patients: FhirResource[];
  conditions: FhirResource[];
  encounters: FhirResource[];
  /**
   * 规范化过程中被剔除的身份证件类 identifier 体系。
   *
   * 只有「从官方导出目录读进来」这一路会填；从已落盘的回放集再读时拿不到
   * （证件标识那时已经被剔掉了），此时由 manifest 里的记录接力。
   */
  droppedIdentifierSystems?: string[];
}

/** 单条校验结果。 */
export interface ValidationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ValidationResult {
  ok: boolean;
  checks: ValidationCheck[];
  counts: { patients: number; conditions: number; encounters: number };
  identifierSystems: string[];
}

export type ReplaySource = 'download' | 'cache';

export interface ReplayManifest {
  schemaVersion: '1';
  dataset: 'synthea-fhir-r4';
  source: ReplaySource;
  sourceDetail: {
    distribution: string;
    url: string;
    version: string;
    requestedPatients: number;
    seed: number | null;
    javaBin: string | null;
    /** 本次复用的是哪一层缓存：原始导出目录，还是已规范化的回放集 */
    reusedFrom: 'generated-export' | 'replay-set' | null;
  };
  license: { name: string; url: string; attribution: string };
  /** 本次 manifest 刷新时间 */
  generatedAt: string;
  /** 数据集首次产出时间（复用时不改） */
  datasetGeneratedAt: string;
  counts: { patients: number; conditions: number; encounters: number };
  identifierSystems: string[];
  deidentification: {
    applied: boolean;
    note: string;
    droppedFields: string[];
    droppedIdentifierSystems: string[];
  };
  validation: { ok: boolean; checks: ValidationCheck[] };
  files: { patients: string; conditions: string; encounters: string };
}

export interface FetchError {
  code: ErrorCode;
  message: string;
  hint: string;
}

export interface FetchOutcome {
  ok: boolean;
  exitCode: number;
  manifest: ReplayManifest | null;
  error: FetchError | null;
}

/** 注入点：测试用本地替身，不联网也不跑 Java。 */
export interface GenerateInput {
  javaBin: string;
  jarPath: string;
  exportDir: string;
  patients: number;
  seed: number | null;
}

export interface DownloadInput {
  url: string;
  destPath: string;
}

export interface FetchSyntheaOptions {
  outDir: string;
  cacheDir: string;
  patients: number;
  offline: boolean;
  version: string;
  sourceUrl?: string;
  javaBin?: string;
  seed?: number | null;
  thresholds?: ValidationThresholds;
  now?: () => Date;
  generate?: (input: GenerateInput) => Promise<void>;
  download?: (input: DownloadInput) => Promise<void>;
}

/* ------------------------------------------------------------------ *
 * 一、规范化：Synthea 导出 → 只留本产品读得到的字段
 * ------------------------------------------------------------------ */

/**
 * 身份凭证类 identifier（SSN / 驾照 / 护照）在回放集里一律剔除。
 *
 * 回放集只用来验检索与差异链路，用不到身份证件；而把这类标识留在本机回放文件里
 * 没有收益。system 字样与 type 类型码两处证据都认（见 isIdentityDocumentIdentifier），
 * 命中即剔除并在 manifest 里记录剔了哪些。
 */
const IDENTITY_DOCUMENT_SYSTEM_PATTERNS: RegExp[] = [
  /us-ssn/i,
  /driver/i,
  /licen/i,
  /passport/i,
  /taxid/i,
];

/**
 * 身份证件类的标识符类型码（v2-0203 标识符类型码表）。
 * SS=社会保障号、DL=驾照、PP=护照、PPID=个人身份号。
 */
const IDENTITY_DOCUMENT_TYPE_CODES = new Set(['SS', 'DL', 'PP', 'PPID']);

/** 身份证件类的类型显示名（type.coding.display / type.text）。 */
const IDENTITY_DOCUMENT_TYPE_PATTERNS: RegExp[] = [
  /social security/i,
  /driver'?s? licen/i,
  /passport/i,
];

/** identifier 的最小形状：判定身份凭证只需要 system 与 type 两处。 */
export interface IdentifierShape {
  system?: string | null;
  type?: { coding?: { code?: string | null; display?: string | null }[]; text?: string | null } | null;
}

/**
 * 判断一个 identifier 是否属于身份证件类。
 *
 * 证据有两个来源：identifier.system 的字样，以及 identifier.type 的
 * v2-0203 标识符类型码（SS / DL / PP）。**只看 system 会漏**——驾照号在不少
 * 导出里用 OID 表达（system 里既没有 driver 也没有 licen 字样），而 type 编码
 * 是数据自带的事实，比硬编码某个 OID 可靠。
 */
export function isIdentityDocumentIdentifier(identifier: IdentifierShape): boolean {
  const system = typeof identifier.system === 'string' ? identifier.system : '';
  if (IDENTITY_DOCUMENT_SYSTEM_PATTERNS.some((pattern) => pattern.test(system))) return true;

  const codings = Array.isArray(identifier.type?.coding) ? identifier.type.coding : [];
  for (const coding of codings) {
    const code = (coding.code ?? '').trim().toUpperCase();
    if (IDENTITY_DOCUMENT_TYPE_CODES.has(code)) return true;
    const display = (coding.display ?? '').trim();
    if (IDENTITY_DOCUMENT_TYPE_PATTERNS.some((pattern) => pattern.test(display))) return true;
  }
  const typeText = (identifier.type?.text ?? '').trim();
  return IDENTITY_DOCUMENT_TYPE_PATTERNS.some((pattern) => pattern.test(typeText));
}

/** 只看 system 的判定（保留给 manifest 汇总与既有调用方）。 */
export function isIdentityDocumentSystem(system: string): boolean {
  return IDENTITY_DOCUMENT_SYSTEM_PATTERNS.some((pattern) => pattern.test(system));
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function firstCode(concept: unknown): { code: string | null; system: string | null } {
  if (typeof concept !== 'object' || concept === null) return { code: null, system: null };
  const coding = (concept as { coding?: unknown[] }).coding;
  const first = Array.isArray(coding) ? coding[0] : undefined;
  if (typeof first === 'object' && first !== null) {
    const record = first as { code?: unknown; system?: unknown };
    return { code: text(record.code), system: text(record.system) };
  }
  const fallback = (concept as { text?: unknown }).text;
  return { code: text(fallback), system: null };
}

function firstCoding(coding: unknown): string | null {
  if (typeof coding !== 'object' || coding === null) return null;
  const record = coding as { code?: unknown; display?: unknown };
  return text(record.code) ?? text(record.display);
}

/** 归一化 Patient：只留 id / identifier / birthDate / gender，姓名地址电话全部剔除。 */
export function normalizePatient(resource: FhirResource): FhirResource {
  const identifiers = Array.isArray(resource.identifier)
    ? resource.identifier
        // 顺序要紧：先按**原始** identifier 判证件（要用到 type 里的类型码），
        // 再裁剪成只留 system / value。反过来先 map 会把 type 丢掉，
        // 靠 OID 表达的驾照号就漏过去了。
        .filter((identifier) => !isIdentityDocumentIdentifier(identifier))
        .map((identifier) => ({
          system: text(identifier.system),
          value: text(identifier.value),
        }))
        .filter(
          (identifier): identifier is { system: string; value: string } =>
            identifier.system !== null && identifier.value !== null,
        )
    : [];

  const normalized: FhirResource = {
    resourceType: 'Patient',
    identifier: identifiers,
  };
  const id = text(resource.id);
  if (id !== null) normalized.id = id;
  const birthDate = text(resource.birthDate);
  if (birthDate !== null) normalized.birthDate = birthDate;
  const gender = text(resource.gender);
  if (gender !== null) normalized.gender = gender;
  return normalized;
}

/** 归一化 Condition：只留诊断编码 / 起病时间 / 分期与主体引用。 */
export function normalizeCondition(resource: FhirResource): FhirResource {
  const code = firstCode(resource.code);
  const stage = firstCode(resource.stage);
  const normalized: FhirResource = { resourceType: 'Condition' };

  const id = text(resource.id);
  if (id !== null) normalized.id = id;
  if (resource.subject !== undefined) normalized.subject = resource.subject;
  if (code.code !== null) {
    const coding: FhirCoding = { code: code.code };
    if (code.system !== null) coding.system = code.system;
    normalized.code = { coding: [coding], text: code.code };
  }
  const onset = text(resource.onsetDateTime);
  if (onset !== null) normalized.onsetDateTime = onset;
  if (stage.code !== null) {
    const coding: FhirCoding = { code: stage.code };
    if (stage.system !== null) coding.system = stage.system;
    normalized.stage = { coding: [coding] };
  }
  return normalized;
}

/** 归一化 Encounter：只留就诊时段 / 类别 / 类型 / 状态与主体引用。 */
export function normalizeEncounter(resource: FhirResource): FhirResource {
  const type = firstCode(resource.type);
  const normalized: FhirResource = { resourceType: 'Encounter' };

  const id = text(resource.id);
  if (id !== null) normalized.id = id;
  if (resource.subject !== undefined) normalized.subject = resource.subject;
  if (resource.period !== undefined) normalized.period = resource.period;
  if (resource.class !== undefined) normalized.class = resource.class;
  if (type.code !== null) {
    const coding: FhirCoding = { code: type.code };
    if (type.system !== null) coding.system = type.system;
    normalized.type = { coding: [coding] };
  }
  const status = text(resource.status);
  if (status !== null) normalized.status = status;
  return normalized;
}

/** 主体引用里的患者 id：兼容 `Patient/xxx` 与 `urn:uuid:xxx` 两种写法。 */
export function patientIdOfReference(reference: unknown): string | null {
  if (typeof reference !== 'object' || reference === null) return null;
  const value = text((reference as { reference?: unknown }).reference);
  if (value === null) return null;
  const withoutPrefix = value.replace(/^urn:uuid:/, '').replace(/^Patient\//, '');
  return withoutPrefix.length > 0 ? withoutPrefix : null;
}

/* ------------------------------------------------------------------ *
 * 二、读取导出目录
 * ------------------------------------------------------------------ */

async function listJsonFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
        out.push(full);
      }
    }
  };
  await walk(dir);
  return out.sort();
}

/**
 * 读取 Synthea 的 FHIR 导出目录 → 回放集。
 *
 * 官方导出有两种形态：每位患者一个 transaction Bundle，或逐资源单文件。
 * 这里两种都吃：Bundle 展开 entry，单文件直接当资源用，只留三类目标资源。
 */
export async function readExportDir(exportDir: string): Promise<ReplayDataset> {
  const fhirDir = existsSync(join(exportDir, 'fhir')) ? join(exportDir, 'fhir') : exportDir;
  const files = await listJsonFiles(fhirDir);

  const patients: FhirResource[] = [];
  const conditions: FhirResource[] = [];
  const encounters: FhirResource[] = [];
  const dropped = new Set<string>();

  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      continue; // 非 JSON 文件（目录索引等）直接跳过，不静默当作有效数据
    }
    if (typeof parsed !== 'object' || parsed === null) continue;

    const record = parsed as { resourceType?: unknown; entry?: unknown };
    const resources: FhirResource[] = [];
    if (record.resourceType === 'Bundle' && Array.isArray(record.entry)) {
      for (const item of record.entry) {
        const resource = (item as { resource?: FhirResource }).resource;
        if (resource && typeof resource === 'object') resources.push(resource);
      }
    } else if (typeof record.resourceType === 'string') {
      resources.push(record as FhirResource);
    }

    for (const resource of resources) {
      switch (resource.resourceType) {
        case 'Patient': {
          // 证件类 identifier 在剔除前先记下体系名，manifest 要据此复核脱敏口径。
          const identifiers = Array.isArray(resource.identifier) ? resource.identifier : [];
          for (const identifier of identifiers) {
            if (isIdentityDocumentIdentifier(identifier)) {
              const system = text(identifier.system);
              if (system !== null) dropped.add(system);
            }
          }
          patients.push(normalizePatient(resource));
          break;
        }
        case 'Condition':
          conditions.push(normalizeCondition(resource));
          break;
        case 'Encounter':
          encounters.push(normalizeEncounter(resource));
          break;
        default:
          break; // 其余资源类型（Observation / Claim 等）本产品不读，直接丢弃
      }
    }
  }

  return { patients, conditions, encounters, droppedIdentifierSystems: [...dropped].sort() };
}

/* ------------------------------------------------------------------ *
 * 三、完整性校验
 * ------------------------------------------------------------------ */

/** identifier 是否能按 token（system|value）解析：system 与 value 都非空且不含分隔符。 */
export function isTokenParseable(identifier: { system: string | null; value: string | null }): boolean {
  if (identifier.system === null || identifier.value === null) return false;
  if (identifier.system.length === 0 || identifier.value.length === 0) return false;
  return !identifier.system.includes('|') && !identifier.value.includes('|');
}

/**
 * 完整性校验：规模下限、每个 Patient 至少一条 Encounter、identifier 可按 token 解析、
 * 诊断与就诊的主体引用能落到已知 Patient 上。
 *
 * 任何一条不满足即 ok=false —— 回放集不完整就不能拿来验主干。
 */
export function validateReplaySet(
  dataset: ReplayDataset,
  thresholds: ValidationThresholds = DEFAULT_THRESHOLDS,
): ValidationResult {
  const checks: ValidationCheck[] = [];

  const patientCount = dataset.patients.length;
  const conditionCount = dataset.conditions.length;
  const encounterCount = dataset.encounters.length;

  checks.push({
    name: 'patients_min',
    ok: patientCount >= thresholds.minPatients,
    detail: `Patient ${patientCount} 条，下限 ${thresholds.minPatients} 条`,
  });
  checks.push({
    name: 'conditions_min',
    ok: conditionCount >= thresholds.minConditions,
    detail: `Condition ${conditionCount} 条，下限 ${thresholds.minConditions} 条`,
  });
  checks.push({
    name: 'encounters_min',
    ok: encounterCount >= thresholds.minEncounters,
    detail: `Encounter ${encounterCount} 条，下限 ${thresholds.minEncounters} 条`,
  });

  const encountersByPatient = new Map<string, number>();
  for (const encounter of dataset.encounters) {
    const patientId = patientIdOfReference(encounter.subject);
    if (patientId === null) continue;
    encountersByPatient.set(patientId, (encountersByPatient.get(patientId) ?? 0) + 1);
  }

  if (thresholds.requireEncounterPerPatient) {
    const withoutEncounter = dataset.patients.filter(
      (patient) => (encountersByPatient.get(patient.id ?? '') ?? 0) === 0,
    );
    checks.push({
      name: 'encounter_per_patient',
      ok: withoutEncounter.length === 0,
      detail:
        withoutEncounter.length === 0
          ? `每位 Patient 至少一条 Encounter（共 ${patientCount} 位）`
          : `${withoutEncounter.length} 位 Patient 没有关联的 Encounter`,
    });
  }

  const identifierSystems = new Set<string>();
  let patientsWithoutToken = 0;
  for (const patient of dataset.patients) {
    const identifiers = Array.isArray(patient.identifier) ? patient.identifier : [];
    const usable = identifiers.filter((identifier) => {
      const system = text(identifier.system);
      const value = text(identifier.value);
      const parseable = isTokenParseable({ system, value });
      // identifierSystems 回答的是「能拿哪个体系做 token 检索」，
      // 只登记真正可解析的体系 —— 不可解析的列出来会误导操作员。
      if (parseable && system !== null) identifierSystems.add(system);
      return parseable;
    });
    if (usable.length === 0) patientsWithoutToken += 1;
  }
  checks.push({
    name: 'identifier_token_parseable',
    ok: patientsWithoutToken === 0,
    detail:
      patientsWithoutToken === 0
        ? `每位 Patient 至少有一个可按 system|value 解析的 identifier`
        : `${patientsWithoutToken} 位 Patient 没有可按 system|value 解析的 identifier`,
  });

  const knownPatients = new Set(dataset.patients.map((patient) => patient.id ?? ''));
  let danglingSubjects = 0;
  for (const resource of [...dataset.conditions, ...dataset.encounters]) {
    const patientId = patientIdOfReference(resource.subject);
    if (patientId !== null && !knownPatients.has(patientId)) danglingSubjects += 1;
  }
  checks.push({
    name: 'subject_reference_resolvable',
    ok: danglingSubjects === 0,
    detail:
      danglingSubjects === 0
        ? '诊断与就诊的主体引用都能落到已知 Patient 上'
        : `${danglingSubjects} 条诊断/就诊的主体引用找不到对应 Patient`,
  });

  return {
    ok: checks.every((check) => check.ok),
    checks,
    counts: { patients: patientCount, conditions: conditionCount, encounters: encounterCount },
    identifierSystems: [...identifierSystems].sort(),
  };
}

/* ------------------------------------------------------------------ *
 * 四、落盘：回放集文件与 manifest
 * ------------------------------------------------------------------ */

export const REPLAY_FILES = {
  patients: 'Patient.json',
  conditions: 'Condition.json',
  encounters: 'Encounter.json',
} as const;

export const MANIFEST_FILE = 'manifest.json';

/** 原子写：先写临时文件再 rename，写失败不留半文件。二进制内容按原字节落盘。 */
async function atomicWrite(path: string, content: string | Buffer): Promise<void> {
  const temp = `${path}.tmp`;
  await writeFile(temp, content, typeof content === 'string' ? 'utf8' : undefined);
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export async function writeReplaySet(outDir: string, dataset: ReplayDataset): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await atomicWrite(
    join(outDir, REPLAY_FILES.patients),
    `${JSON.stringify(dataset.patients, null, 2)}\n`,
  );
  await atomicWrite(
    join(outDir, REPLAY_FILES.conditions),
    `${JSON.stringify(dataset.conditions, null, 2)}\n`,
  );
  await atomicWrite(
    join(outDir, REPLAY_FILES.encounters),
    `${JSON.stringify(dataset.encounters, null, 2)}\n`,
  );
}

export async function writeManifest(outDir: string, manifest: ReplayManifest): Promise<void> {
  await mkdir(outDir, { recursive: true });
  await atomicWrite(join(outDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** 读取已落盘的回放集；文件缺失或读不出时返回 null（交给上层走重新获取的路径）。 */
export async function readReplaySet(outDir: string): Promise<ReplayDataset | null> {
  const paths = [
    join(outDir, REPLAY_FILES.patients),
    join(outDir, REPLAY_FILES.conditions),
    join(outDir, REPLAY_FILES.encounters),
  ];
  if (!paths.every((path) => existsSync(path))) return null;
  try {
    const parsed = await Promise.all(
      paths.map(async (path) => JSON.parse(await readFile(path, 'utf8')) as FhirResource[]),
    );
    const [patients, conditions, encounters] = parsed;
    if (patients === undefined || conditions === undefined || encounters === undefined) {
      return null;
    }
    return { patients, conditions, encounters };
  } catch {
    return null;
  }
}

/** 读回已落盘的 manifest（用于幂等重跑时沿用「数据集首次产出时间」）。 */
export async function readManifest(outDir: string): Promise<ReplayManifest | null> {
  const path = join(outDir, MANIFEST_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8')) as ReplayManifest;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 五、工具链：Java 运行时与官方制品下载
 * ------------------------------------------------------------------ */

/** Synthea 官方制品要求 Java 17 及以上。 */
export const MIN_JAVA_MAJOR = 17;

/** 探测到的 Java 运行时。 */
export interface JavaRuntime {
  /** 可执行文件路径 */
  path: string;
  /** 主版本号；探测到的不是 Java 时为 null */
  majorVersion: number | null;
}

/**
 * 探测一个候选 java 的**真实可运行性**。
 *
 * 只做 stat() 是不够的：macOS 自带的 /usr/bin/java 是「尚未安装 Java」的占位桩，
 * 文件确实存在、stat 得到 isFile()=true，但 `-version` 退出码非 0。这里统一以
 * 「`-version` 能否成功退出」为准，坏掉的软链与占位桩都会被挡掉。
 */
export async function probeJava(path: string): Promise<JavaRuntime | null> {
  return await new Promise<JavaRuntime | null>((resolvePromise) => {
    let output = '';
    // `--version` 是 java 与 node 都认的写法（java 只认 `-version` 的旧写法不通用）。
    let child: ChildProcess;
    try {
      child = spawn(path, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      // spawn 只把 ENOENT 等少数 errno 走 'error' 事件；ENOTDIR 这类会**同步抛出**。
      // macOS 上没装 JDK 时 /usr/libexec/java_home 就是指向不存在目录的坏软链，
      // 不接住的话一个坏候选会直接打断整轮探测。
      resolvePromise(null);
      return;
    }
    const collect = (chunk: Buffer): void => {
      output += chunk.toString('utf8');
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', () => resolvePromise(null));
    child.on('close', (code) => {
      if (code !== 0) {
        resolvePromise(null);
        return;
      }
      // 三种版本串写法都要认：
      //   java -version  → openjdk version "17.0.20.1" 2026-08-18
      //   java --version → openjdk 17.0.20.1 2026-08-18
      //   node --version → v26.4.0
      const match = /(?:version "|^\s*v|^openjdk\s+)(\d+)/m.exec(output);
      const major = match?.[1] === undefined ? null : Number(match[1]);
      resolvePromise({ path, majorVersion: major });
    });
  });
}

/**
 * 找 Java 运行时：显式指定 → JAVA_HOME → 常见安装位置 → PATH。
 *
 * 版本上优先取 17（Synthea 4.x 的官方基线），再退到 21 与其他 17+ 的版本。
 * 找不到就返回 null，由上层给出可执行的降级说明（不静默跳过）。
 */
export async function resolveJavaRuntime(hint?: string): Promise<JavaRuntime | null> {
  // 显式指定优先：不替用户改选，但仍然确认它真的能跑起来（坏路径当场暴露）。
  if (hint !== undefined && hint.length > 0) {
    return await probeJava(hint);
  }

  const candidates: string[] = [];
  const javaHome = process.env['JAVA_HOME'];
  if (javaHome !== undefined && javaHome.length > 0) {
    candidates.push(join(javaHome, 'bin', 'java'));
  }
  candidates.push(
    '/opt/homebrew/opt/openjdk@17/bin/java',
    '/opt/homebrew/opt/openjdk@21/bin/java',
    '/opt/homebrew/opt/openjdk/bin/java',
    '/usr/libexec/java_home/Contents/Home/bin/java',
  );

  const found: JavaRuntime[] = [];
  for (const candidate of candidates) {
    const probed = await probeJava(candidate);
    if (probed !== null) found.push(probed);
  }
  if (found.length === 0) {
    const onPath = await probeJava('java');
    if (onPath !== null) found.push(onPath);
  }
  if (found.length === 0) return null;

  const usable = found.filter(
    (runtime) => runtime.majorVersion !== null && runtime.majorVersion >= MIN_JAVA_MAJOR,
  );
  if (usable.length === 0) {
    // 探测到 java 但版本不满足要求：交出它，由上层在错误里点名版本要求。
    return found[0]!;
  }
  const preferred = usable.find((runtime) => runtime.majorVersion === 17) ?? usable[0]!;
  return preferred;
}

/** 只要路径的便捷包装（供 CLI 与测试使用）。 */
export async function resolveJavaBinary(hint?: string): Promise<string | null> {
  const runtime = await resolveJavaRuntime(hint);
  return runtime === null ? null : runtime.path;
}

/**
 * 下载官方制品到缓存目录（下载失败抛错，由上层转成可读的错误）。
 *
 * 官方 jar 是 200MB 上下，整包读进内存既没必要也危险 —— 院内工作站内存有限，
 * 这里流式落盘：先写临时文件，成功后 rename，失败不留半文件。
 */
export async function downloadToFile(input: DownloadInput): Promise<void> {
  await mkdir(resolve(input.destPath, '..'), { recursive: true });
  const response = await fetch(input.url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(30 * 60 * 1000),
  });
  if (!response.ok) {
    throw new Error(`下载失败：HTTP ${response.status} ${response.statusText}（${input.url}）`);
  }
  if (response.body === null) {
    throw new Error(`下载失败：响应没有内容体（${input.url}）`);
  }

  const temp = `${input.destPath}.tmp`;
  try {
    await pipeline(
      Readable.fromWeb(response.body as unknown as NodeWebReadableStream<Uint8Array>),
      createWriteStream(temp),
    );
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  await rename(temp, input.destPath);
}

/**
 * 用 Synthea 官方制品生成 FHIR R4 导出。
 *
 * 只导出本产品读得到的三类资源，并关掉 pretty print 与带姓名的文件名，
 * 避免把无关资源与姓名写进本机缓存。命名与规模参数固定，便于复现。
 */
export async function runSynthea(input: GenerateInput): Promise<void> {
  const args = [
    '-jar',
    input.jarPath,
    '-p',
    String(input.patients),
    '--exporter.fhir.export=true',
    '--exporter.fhir.included_resources=Patient,Condition,Encounter',
    '--exporter.pretty_print=false',
    '--exporter.use_uuid_filenames=true',
    '--exporter.useSyntaxHighlighting=false',
    `--exporter.baseDirectory=${input.exportDir}`,
  ];
  if (input.seed !== null && input.seed !== undefined) args.push('-s', String(input.seed));

  await new Promise<void>((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try {
      child = spawn(input.javaBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rejectPromise(new Error(`无法启动 Java 运行时「${input.javaBin}」：${message}`));
      return;
    }
    let stderr = '';
    child.stdout?.on('data', () => undefined);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error: Error) => rejectPromise(error));
    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      const tail = stderr.trim().split('\n').slice(-5).join(' / ');
      rejectPromise(new Error(`Synthea 退出码 ${code ?? 'null'}${tail.length > 0 ? `：${tail}` : ''}`));
    });
  });
}

/* ------------------------------------------------------------------ *
 * 六、编排
 * ------------------------------------------------------------------ */

function buildManifest(input: {
  source: ReplaySource;
  sourceDetail: ReplayManifest['sourceDetail'];
  validation: ValidationResult;
  datasetGeneratedAt: string;
  generatedAt: string;
  droppedIdentifierSystems: string[];
}): ReplayManifest {
  return {
    schemaVersion: '1',
    dataset: 'synthea-fhir-r4',
    source: input.source,
    sourceDetail: input.sourceDetail,
    license: {
      name: 'Apache-2.0',
      url: 'http://www.apache.org/licenses/LICENSE-2.0.txt',
      attribution: 'Synthea（MITRE Corporation）生成的合成患者数据，非真实患者数据',
    },
    generatedAt: input.generatedAt,
    datasetGeneratedAt: input.datasetGeneratedAt,
    counts: input.validation.counts,
    identifierSystems: input.validation.identifierSystems,
    deidentification: {
      applied: true,
      note: '回放集只保留本产品读得到的字段；姓名、地址、电话与身份证件类 identifier 已剔除',
      droppedFields: [
        'Patient.name',
        'Patient.address',
        'Patient.telecom',
        'Patient.contact',
        'Patient.photo',
        'Patient.text',
        'Patient.meta',
        'Patient.extension',
      ],
      droppedIdentifierSystems: input.droppedIdentifierSystems,
    },
    validation: { ok: input.validation.ok, checks: input.validation.checks },
    files: { ...REPLAY_FILES },
  };
}

/**
 * 找出被剔除的 identifier 体系（写进 manifest，便于复核脱敏口径）。
 *
 * 优先用规范化时记下的清单；从已落盘的回放集再读时证件标识已被剔除、记不到，
 * 由上一轮 manifest 的记录接力（见调用方）。
 */
function collectDroppedIdentifierSystems(dataset: ReplayDataset): string[] {
  if (dataset.droppedIdentifierSystems !== undefined) return dataset.droppedIdentifierSystems;
  const dropped = new Set<string>();
  for (const patient of dataset.patients) {
    const identifiers = Array.isArray(patient.identifier) ? patient.identifier : [];
    for (const identifier of identifiers) {
      const system = text(identifier.system);
      if (system !== null && isIdentityDocumentIdentifier(identifier)) dropped.add(system);
    }
  }
  return [...dropped].sort();
}

/**
 * 主流程：拿回放集 → 校验 → 落盘 → 写 manifest。
 *
 * 幂等：--out 已有完整且通过校验的回放集时，跳过下载与生成，只刷新 manifest。
 * 断网：--offline true（或网络不可用）且本地缓存可用时复用缓存，标 source=cache；
 *       无缓存时非零退出并给出可执行的降级说明。
 */
export async function runFetchSynthea(options: FetchSyntheaOptions): Promise<FetchOutcome> {
  const now = options.now ?? (() => new Date());
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const outDir = resolve(options.outDir);
  const cacheDir = resolve(options.cacheDir);
  const exportDir = join(cacheDir, 'export');
  const jarPath = join(cacheDir, `synthea-${options.version}-with-dependencies.jar`);
  const sourceUrl = options.sourceUrl ?? mavenCentralUrl(options.version);
  const timestamp = now().toISOString();

  const sourceDetailBase = {
    distribution: 'Synthea 官方制品（Apache-2.0，Maven Central / GitHub Release 同源）',
    url: sourceUrl,
    version: options.version,
    requestedPatients: options.patients,
    seed: options.seed ?? null,
    javaBin: null as string | null,
    reusedFrom: null as 'generated-export' | 'replay-set' | null,
  };

  // 路径一：--out 已有完整回放集 → 只刷新 manifest，不重复写数据文件。
  const existing = await readReplaySet(outDir);
  if (existing !== null) {
    const previous = await readManifest(outDir);
    const validation = validateReplaySet(existing, thresholds);
    if (validation.ok || previous === null) {
      const manifest = buildManifest({
        source: 'cache',
        sourceDetail: { ...sourceDetailBase, reusedFrom: 'replay-set' },
        validation,
        datasetGeneratedAt: previous?.datasetGeneratedAt ?? timestamp,
        generatedAt: timestamp,
        // 回放集里的证件标识在生成那轮就剔掉了，这里接力上一轮 manifest 的记录。
        droppedIdentifierSystems:
          previous?.deidentification.droppedIdentifierSystems ?? collectDroppedIdentifierSystems(existing),
      });
      if (validation.ok) await writeManifest(outDir, manifest);
      return {
        ok: validation.ok,
        exitCode: validation.ok ? 0 : 1,
        manifest,
        error: validation.ok
          ? null
          : {
              code: 'bad_payload',
              message: '已落盘的回放集未通过完整性校验',
              hint: '删除 --out 目录后重跑，重新获取完整回放集',
            },
      };
    }
  }

  // 路径二：缓存里已有官方导出 → 直接复用（断网时的降级路径）。
  const cachedExport = existsSync(join(exportDir, 'fhir'));
  if (cachedExport) {
    const dataset = await readExportDir(exportDir);
    const validation = validateReplaySet(dataset, thresholds);
    if (validation.ok) {
      await writeReplaySet(outDir, dataset);
      const manifest = buildManifest({
        source: 'cache',
        sourceDetail: { ...sourceDetailBase, reusedFrom: 'generated-export' },
        validation,
        datasetGeneratedAt: timestamp,
        generatedAt: timestamp,
        droppedIdentifierSystems: collectDroppedIdentifierSystems(dataset),
      });
      await writeManifest(outDir, manifest);
      return { ok: true, exitCode: 0, manifest, error: null };
    }
  }

  // 路径三：需要真正去取数据 —— 断网且无缓存则明确失败，不空转。
  if (options.offline) {
    return {
      ok: false,
      exitCode: 3,
      manifest: null,
      error: {
        code: 'not_found',
        message: `离线模式且本地没有可用的 Synthea 缓存（缓存目录：${cacheDir}）`,
        hint:
          '请在有网机器上先跑一次 `node dist/scripts/fetch-synthea.js --out data/replay --patients 300`，' +
          `再把 ${cacheDir} 整个目录拷到本机；或去掉 --offline true 联网重跑`,
      },
    };
  }

  const javaBin = await resolveJavaBinary(options.javaBin);
  if (javaBin === null) {
    return {
      ok: false,
      exitCode: 1,
      manifest: null,
      error: {
        code: 'invalid_request',
        message: '未找到 Java 运行时：Synthea 官方分发方式是下载官方 jar 后用 Java 运行（需 Java 17+）',
        hint:
          '请安装 Java 17 或更高版本后重跑（可用 --java <路径> 指定 java 可执行文件，' +
          '或设置 JAVA_HOME）；若本机无法安装 Java，请改用 --offline true 复用已缓存的回放集',
      },
    };
  }

  const download = options.download ?? downloadToFile;
  const generate = options.generate ?? runSynthea;

  try {
    if (!existsSync(jarPath)) {
      await mkdir(cacheDir, { recursive: true });
      await download({ url: sourceUrl, destPath: jarPath });
    }
    await rm(exportDir, { recursive: true, force: true });
    await mkdir(exportDir, { recursive: true });
    await generate({ javaBin, jarPath, exportDir, patients: options.patients, seed: options.seed ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      exitCode: 1,
      manifest: null,
      error: {
        code: 'server_error',
        message: `获取 Synthea 官方导出失败：${message}`,
        hint: '请检查网络与官方制品地址是否可达；已下载的 jar 会留在缓存目录，重跑时不会重复下载',
      },
    };
  }

  const dataset = await readExportDir(exportDir);
  const validation = validateReplaySet(dataset, thresholds);
  if (!validation.ok) {
    const failed = validation.checks.filter((check) => !check.ok).map((check) => check.detail);
    const manifest = buildManifest({
      source: 'download',
      sourceDetail: { ...sourceDetailBase, javaBin },
      validation,
      datasetGeneratedAt: timestamp,
      generatedAt: timestamp,
      droppedIdentifierSystems: collectDroppedIdentifierSystems(dataset),
    });
    await writeManifest(outDir, manifest);
    return {
      ok: false,
      exitCode: 1,
      manifest,
      error: {
        code: 'bad_payload',
        message: `回放集未通过完整性校验：${failed.join('；')}`,
        hint: '请调高 --patients 后重跑，或检查官方导出的资源类型配置',
      },
    };
  }

  await writeReplaySet(outDir, dataset);
  const manifest = buildManifest({
    source: 'download',
    sourceDetail: { ...sourceDetailBase, javaBin },
    validation,
    datasetGeneratedAt: timestamp,
    generatedAt: timestamp,
    droppedIdentifierSystems: collectDroppedIdentifierSystems(dataset),
  });
  await writeManifest(outDir, manifest);
  return { ok: true, exitCode: 0, manifest, error: null };
}

/* ------------------------------------------------------------------ *
 * 七、命令行入口
 * ------------------------------------------------------------------ */

const USAGE = `Synthea FHIR R4 导出获取（离线回放数据源）

用法：
  node dist/scripts/fetch-synthea.js --out data/replay --patients 300 [选项]

选项：
  --out <dir>          回放集落盘目录（默认 data/replay）
  --cache-dir <dir>    本机缓存目录（默认 <out>/../cache），存放官方 jar 与原始导出
  --patients <n>       生成患者数（默认 300）
  --offline <bool>     true 时不联网，只用本地缓存（默认 false）
  --version <ver>      Synthea 版本（默认 ${DEFAULT_SYNTHEA_VERSION}）
  --source-url <url>   官方制品地址（默认 Maven Central）
  --java <path>        java 可执行文件路径（默认自动查找）
  --seed <n>           Synthea 随机种子（固定后可复现同一批数据）
`;

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true;
    } else {
      flags[name] = next;
      i += 1;
    }
  }
  return flags;
}

function readString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(flags: Record<string, string | boolean>, name: string): number | undefined {
  const raw = readString(flags, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} 应为正整数，当前为「${raw}」`);
  }
  return parsed;
}

function readBoolean(flags: Record<string, string | boolean>, name: string): boolean {
  const raw = readString(flags, name);
  if (raw === undefined) return false;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`--${name} 只接受 true / false，当前为「${raw}」`);
}

export async function main(argv: string[]): Promise<number> {
  const flags = parseArgs(argv);
  if (flags['help'] === true || flags['h'] === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  const outDir = readString(flags, 'out') ?? join('data', 'replay');
  const cacheDir = readString(flags, 'cache-dir') ?? join(resolve(outDir, '..'), 'cache');
  const patients = readNumber(flags, 'patients') ?? DEFAULT_THRESHOLDS.minPatients;
  const offline = readBoolean(flags, 'offline');
  const version = readString(flags, 'version') ?? DEFAULT_SYNTHEA_VERSION;
  const sourceUrl = readString(flags, 'source-url');
  const javaBin = readString(flags, 'java');
  const seed = readNumber(flags, 'seed');

  let outcome: FetchOutcome;
  try {
    outcome = await runFetchSynthea({
      outDir,
      cacheDir,
      patients,
      offline,
      version,
      ...(sourceUrl === undefined ? {} : { sourceUrl }),
      ...(javaBin === undefined ? {} : { javaBin }),
      ...(seed === undefined ? {} : { seed }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `${JSON.stringify(
        errorResponse('replay', { code: 'invalid_request', message, hint: '请按 --help 核对参数取值' }),
        null,
        2,
      )}\n`,
    );
    return 2;
  }

  if (!outcome.ok) {
    const error = outcome.error;
    process.stderr.write(
      `${JSON.stringify(
        errorResponse('replay', {
          code: error?.code ?? 'unknown',
          message: error?.message ?? '获取回放集失败',
          hint: error?.hint ?? null,
          details: outcome.manifest
            ? { validation: outcome.manifest.validation, counts: outcome.manifest.counts }
            : undefined,
        }),
        null,
        2,
      )}\n`,
    );
    return outcome.exitCode;
  }

  process.stdout.write(
    `${JSON.stringify(
      okResponse('replay', {
        outDir: resolve(outDir),
        source: outcome.manifest?.source ?? 'cache',
        counts: outcome.manifest?.counts ?? null,
        identifierSystems: outcome.manifest?.identifierSystems ?? [],
        validation: outcome.manifest?.validation ?? null,
        manifestPath: join(resolve(outDir), MANIFEST_FILE),
      }),
      null,
      2,
    )}\n`,
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `${JSON.stringify(
          errorResponse('replay', { code: 'unknown', message, hint: null }),
          null,
          2,
        )}\n`,
      );
      process.exitCode = 1;
    });
}

/** 供测试用：生成一个临时目录（测试夹具落在临时目录，不进仓库）。 */
export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** 供测试与调试用：回放集指纹（表头 + 行数 + 内容哈希），与批次键口径一致。 */
export function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** 本文件在 dist 下的位置（供脚本自述与调试）。 */
export const SCRIPT_PATH = fileURLToPath(import.meta.url);
