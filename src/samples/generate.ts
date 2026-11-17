/**
 * 脱敏登记表样例 + 期望差异集生成 —— 验证用数据集的生成逻辑。
 *
 * 产出三样东西，缺一不可：
 * 1. **登记表样例**：登记员视角的输入表（占位登记号 + 自由写法 + 人工补充列 + 脏行）。
 * 2. **期望差异集**：逐行给出「这一行该出哪些差异、分别是什么操作」，供对照基线、
 *    规模验收与端到端回放当断言基准。
 * 3. **院内侧期望**：每条登记号对应的院内权威值（受控编码、派生日期、就诊时段），
 *    供假 CDR / 假专病库把「院内」那一半还原出来。
 *
 * 三条纪律：
 * - **幂等**：同参数两次生成逐字节一致（PRNG 用固定种子，不碰当前时间）。
 * - **不冒充真实数据**：只有占位标识（REG-0001 这类）与脱敏电话，不含任何可识别明报。
 * - **不猜口径**：派生字段的取法（首次入院日 = 最早一次就诊开始日；本次就诊开始 =
 *   最近一次就诊开始）在产物里写明，下游按同一口径实现，不各算各的。
 */
import { decodeSheetBuffer } from '../sheet/encoding.js';

import { CONTROLLED_CODES, CORPUS, corpusOf, lookupExpectedCode } from './corpus.js';
import { encodeGbk, findUtf8AmbiguousRuns } from './gbk.js';

/** 登记表表头（与 config/column-mapping.json 声明的列一一对应）。 */
export const SHEET_HEADER = ['登记号', '分期', '治疗方案', '随访电话', '生活方式备注'] as const;

/** 参与比对的受控编码字段（人工补充列不参与比对，故不在此列）。 */
export type ComparedField = '分期' | '治疗方案';

export const COMPARED_FIELDS: readonly ComparedField[] = ['分期', '治疗方案'];

/** 行状态取值（取自契约的 ROW_STATUSES 子集）。 */
export type ExpectedStatus = '待确认' | '无需确认' | '需人工判定';

/** 最小差异操作类型（与契约 OPERATION_OPS 一致）。 */
export type ExpectedOp = 'add' | 'replace' | 'remove';

/** 行场景：决定院内侧长什么样，因而决定这一行会出什么差异。 */
export type ScenarioName =
  | 'same'
  | 'replaceStage'
  | 'replacePlan'
  | 'replaceBoth'
  | 'addStage'
  | 'addPlan'
  | 'removeStage'
  | 'removePlan';

/** 场景槽位表：10 个槽位轮转，保证 add / replace / remove 三类操作都出现。 */
const SCENARIO_SLOTS: ScenarioName[] = [
  'same',
  'same',
  'same',
  'replaceStage',
  'replacePlan',
  'replaceBoth',
  'addStage',
  'addPlan',
  'removeStage',
  'removePlan',
];

/** 一行样例的规划结果（写表前的中间态）。 */
export interface RowPlan {
  /** 0 基序号 */
  index: number;
  /** 表内行号（1 基，含表头行） */
  rowNumber: number;
  /** 占位登记号 */
  registryId: string;
  /** 场景 */
  scenario: ScenarioName;
  /** 分期列原文 */
  stageRaw: string;
  /** 治疗方案列原文 */
  planRaw: string;
  /** 随访电话（人工补充列，脱敏） */
  phone: string;
  /** 生活方式备注（人工补充列） */
  lifestyle: string;
}

/** 期望差异操作。 */
export interface ExpectedOperation {
  /** 口径字段名（与列映射配置的 field 一致） */
  field: ComparedField;
  /** 操作类型 */
  op: ExpectedOp;
  /** 登记侧参与比对的旧值；缺失时为 null */
  oldValue: string | null;
  /** 院内侧新值；院内没有该字段时为 null */
  newValue: string | null;
  /** 表里的原始写法（受控编码字段给出归并前的原样，便于核对） */
  sheetRaw: string;
}

/** 一行的期望。 */
export interface ExpectedRow {
  registryId: string;
  rowNumber: number;
  scenario: ScenarioName;
  expectedStatus: ExpectedStatus;
  operations: ExpectedOperation[];
  /** 归并不成功的字段（该字段不产出任何操作，需人工判定） */
  unmergeableFields: ComparedField[];
}

/** 被阻断的脏行期望。 */
export interface BlockedRow {
  rowNumber: number;
  registryId: string | null;
  code: 'MISSING_REGISTRY_ID' | 'DUPLICATE_REGISTRY_ID' | 'COLUMN_COUNT_MISMATCH';
  reason: string;
}

/** 院内权威侧的期望记录。 */
export interface HospitalRecord {
  registryId: string;
  /** 院内有的口径字段（派生字段也在内） */
  fields: Record<string, string>;
  /** 院内**没有**的口径字段（与「值为 null」是两回事） */
  missingFields: string[];
  /** 就诊时段（供派生字段按口径取首次入院日 / 本次就诊开始） */
  encounters: Array<{ start: string; end: string; class: string }>;
}

/** 生成参数。 */
export interface GenerateOptions {
  /** 可参与比对的行数（脏行另计） */
  rows: number;
  /** PRNG 种子：固定后同参数生成结果逐字节一致 */
  seed: number;
}

/** 生成结果。 */
export interface GeneratedSample {
  /** 登记表样例（CSV 文本，UTF-8，CRLF 行尾） */
  sheetCsv: string;
  /** GBK 与 UTF-8 混编表（字节） */
  mixedCsv: Buffer;
  /** 混编表解出来的文本（供校验比对） */
  mixedText: string;
  /** 期望差异集 */
  expectedDiffs: ExpectedDiffsFile;
  /** 院内侧期望 */
  hospitalExpected: HospitalExpectedFile;
  /** 语料 */
  corpus: typeof CORPUS;
  /** 统计 */
  stats: GenerationStats;
  /** 校验结果 */
  checks: ValidationCheck[];
}

/** 期望差异集文件。 */
export interface ExpectedDiffsFile {
  schemaVersion: '1';
  generator: string;
  generatedWith: { rows: number; seed: number };
  /** 口径说明：下游按同一口径实现，别各算各的 */
  conventions: Record<string, string>;
  rows: ExpectedRow[];
  blockedRows: BlockedRow[];
  summary: {
    rows: number;
    blocked: number;
    operations: Record<ExpectedOp, number>;
    status: Record<ExpectedStatus, number>;
  };
}

/** 院内侧期望文件。 */
export interface HospitalExpectedFile {
  schemaVersion: '1';
  generator: string;
  /** 占位 identifier system —— 真实取值来自环境变量 CDR_IDENTIFIER_SYSTEM */
  identifierSystem: string;
  /** 口径说明 */
  conventions: Record<string, string>;
  records: HospitalRecord[];
}

/** 统计。 */
export interface GenerationStats {
  /** CSV 数据行数（含脏行与空行） */
  csvDataLines: number;
  /** 可参与比对的行数 */
  usableRows: number;
  /** 被阻断的脏行数 */
  blockedRows: number;
  /** 空行数 */
  blankLines: number;
  /** 语料条目数 */
  corpusEntries: number;
  operations: Record<ExpectedOp, number>;
  status: Record<ExpectedStatus, number>;
}

/** 校验结果。 */
export interface ValidationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** 派生字段的取法说明（写进产物，下游按同一口径实现）。 */
export const CONVENTIONS: Record<string, string> = {
  首次入院日: 'min(encounters[].start) 的本地日期；多条就诊取最早一次（经验推断）',
  本次就诊开始: '最近一次 encounter 的 start（经验推断）',
  分期: '归并到受控编码后与院内值比较；归并不成功则不产出操作，标「需人工判定」',
  治疗方案: '归并到受控编码后与院内值比较；归并不成功则不产出操作，标「需人工判定」',
  随访电话: '人工补充列，只读不覆盖，不参与比对',
  生活方式备注: '人工补充列，只读不覆盖，不参与比对',
  操作类型: '登记侧为空而院内有值 = add；两侧都有值但不同 = replace；登记侧有值而院内缺失 = remove',
  expectedStatus: '有归并不成功的字段 = 需人工判定；否则有差异 = 待确认；无差异 = 无需确认',
  field: 'field 用口径字段名（与列映射配置的 field 一致）；引擎输出的 path 由三段映射决定，比对时先映射回口径字段名',
};

/** 混编表的固定内容：4 行 GBK + 8 行 UTF-8（UTF-8 多数，混编探测才判得出 mixed）。 */
const MIXED_GBK_ROWS = [
  'REG-0001,ⅢB,术后辅助化疗,138****0001,吸烟史',
  'REG-0002,IIIB,新辅助化疗,138****0002,饮酒史',
  'REG-0003,Ⅱ,姑息治疗,138****0003,戒烟',
  'REG-0004,IV,根治术,138****0004,运动',
];

const MIXED_UTF8_ROWS = [
  'REG-0005,ⅢB,免疫治疗,138****0005,无',
  'REG-0006,II,姑息治疗,138****0006,规律作息',
  'REG-0007,III B,放疗,138****0007,规律作息',
  'REG-0008,ⅣA,靶向治疗,138****0008,',
  'REG-0009,ⅢC,化疗,138****0009,戒烟',
  'REG-0010,IVB,术后化疗,138****0010,运动',
  'REG-0011,ⅡA,新辅助化疗,138****0011,',
  'REG-0012,IVC,靶向治疗,138****0012,',
];

/** 人工补充列的取值池（生活方式备注）。 */
const LIFESTYLE_VALUES = ['吸烟史', '饮酒史', '戒烟', '规律作息', '运动', '无', ''];

/** 日期基数：2023-01-01（固定值，不取当前时间，保证生成幂等）。 */
const BASE_DAY_MS = Date.UTC(2023, 0, 1);

/** 一天毫秒数。 */
const DAY_MS = 86_400_000;

/** 默认种子。 */
export const DEFAULT_SEED = 20261101;

/** 默认行数。 */
export const DEFAULT_ROWS = 120;

/** mulberry32：轻量确定性 PRNG，同种子同序列。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** CSV 单元格转义：含逗号 / 引号 / 换行时包引号，包内引号写两遍。 */
export function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** 由「距 2023-01-01 的天数 + 时刻」拼出带 +08:00 偏移的本地时间戳。 */
function localDateTime(dayOffset: number, hour: number): string {
  const date = new Date(BASE_DAY_MS + dayOffset * DAY_MS);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}T${String(hour).padStart(2, '0')}:00:00+08:00`;
}

/** 由时间戳取本地日历日期（YYYY-MM-DD）。 */
function localDate(timestamp: string): string {
  return timestamp.slice(0, 10);
}

/** 从受控编码全集里取一个（可排除某个值）。 */
function pickCode(
  field: ComparedField,
  random: () => number,
  exclude?: string | null,
): string {
  const codes = CONTROLLED_CODES[field];
  const filtered = exclude === undefined || exclude === null ? codes : codes.filter((code) => code !== exclude);
  const pool = filtered.length > 0 ? filtered : codes;
  const index = Math.min(Math.floor(random() * pool.length), pool.length - 1);
  return pool[index] as string;
}

/** 规划全部可参与比对的行。 */
function planRows(options: GenerateOptions): RowPlan[] {
  const stageCorpus = corpusOf('分期');
  const planCorpus = corpusOf('治疗方案');
  const plans: RowPlan[] = [];

  for (let index = 0; index < options.rows; index += 1) {
    const scenario = SCENARIO_SLOTS[index % SCENARIO_SLOTS.length] as ScenarioName;
    const stageEntry = stageCorpus[index % stageCorpus.length];
    const planEntry = planCorpus[index % planCorpus.length];

    // add 场景要求表侧该列为空（登记侧为空、院内有值 → add 操作）
    const stageRaw = scenario === 'addStage' ? '' : (stageEntry?.raw ?? '');
    const planRaw = scenario === 'addPlan' ? '' : (planEntry?.raw ?? '');

    // 人工补充列：电话留空是真实场景（登记员还没补上），备注同理
    const phone = index % 11 === 3 ? '' : `138****${String(index + 1).padStart(4, '0')}`;
    const lifestyle = LIFESTYLE_VALUES[index % LIFESTYLE_VALUES.length] as string;

    plans.push({
      index,
      rowNumber: index + 2, // 表头占第 1 行
      registryId: `REG-${String(index + 1).padStart(4, '0')}`,
      scenario,
      stageRaw,
      planRaw,
      phone,
      lifestyle,
    });
  }

  return plans;
}

/**
 * 语料覆盖补齐：确保每个语料条目都在样例表里出现过。
 *
 * 补齐手法是「换一个不唯一的行」：只动那些当前写法在别处还出现过的行，换掉它不会
 * 让另一个条目失去覆盖。实在换不动（行数太少）时，牺牲被换掉那条的覆盖并记账，
 * 不做无限重试 —— 覆盖情况最终由校验项如实报出来。
 */
function repairCorpusCoverage(plans: RowPlan[]): string[] {
  const usage = new Map<string, number>();
  const bump = (key: string): void => {
    usage.set(key, (usage.get(key) ?? 0) + 1);
  };

  for (const plan of plans) {
    if (plan.stageRaw.length > 0) bump(`分期|${plan.stageRaw}`);
    if (plan.planRaw.length > 0) bump(`治疗方案|${plan.planRaw}`);
  }

  const sacrificed = new Set<string>();
  const unrepairable: string[] = [];

  for (const entry of CORPUS) {
    const key = `${entry.field}|${entry.raw}`;
    if ((usage.get(key) ?? 0) > 0) continue;

    const rawOf = (plan: RowPlan): string => (entry.field === '分期' ? plan.stageRaw : plan.planRaw);
    const candidates = plans.filter((plan) => {
      if (plan.scenario !== 'same') return false;
      const raw = rawOf(plan);
      if (raw.length === 0) return false;
      return (usage.get(`${entry.field}|${raw}`) ?? 0) >= 2;
    });
    const fallback = candidates.length > 0
      ? candidates[0]
      : plans.find((plan) => {
          if (plan.scenario !== 'same') return false;
          const raw = rawOf(plan);
          return raw.length > 0 && !sacrificed.has(`${entry.field}|${raw}`);
        });

    const target = fallback;
    if (target === undefined) {
      unrepairable.push(entry.raw);
      continue;
    }

    const previous = rawOf(target);
    if (entry.field === '分期') {
      target.stageRaw = entry.raw;
    } else {
      target.planRaw = entry.raw;
    }
    if ((usage.get(`${entry.field}|${previous}`) ?? 0) <= 1) {
      sacrificed.add(`${entry.field}|${previous}`);
    }
    usage.set(`${entry.field}|${previous}`, (usage.get(`${entry.field}|${previous}`) ?? 1) - 1);
    usage.set(key, 1);
  }

  return unrepairable;
}

/** 构造院内权威侧记录。 */
function buildHospitalRecord(plan: RowPlan, random: () => number): HospitalRecord {
  const mergedStage = lookupExpectedCode('分期', plan.stageRaw);
  const mergedPlan = lookupExpectedCode('治疗方案', plan.planRaw);
  const stageCode = mergedStage ?? pickCode('分期', random);
  const planCode = mergedPlan ?? pickCode('治疗方案', random);

  const fields: Record<string, string> = {};
  const missingFields: string[] = [];

  switch (plan.scenario) {
    case 'same':
      fields['分期'] = stageCode;
      fields['治疗方案'] = planCode;
      break;
    case 'replaceStage':
      fields['分期'] = pickCode('分期', random, stageCode);
      fields['治疗方案'] = planCode;
      break;
    case 'replacePlan':
      fields['分期'] = stageCode;
      fields['治疗方案'] = pickCode('治疗方案', random, planCode);
      break;
    case 'replaceBoth':
      fields['分期'] = pickCode('分期', random, stageCode);
      fields['治疗方案'] = pickCode('治疗方案', random, planCode);
      break;
    case 'addStage':
      fields['分期'] = pickCode('分期', random);
      fields['治疗方案'] = planCode;
      break;
    case 'addPlan':
      fields['分期'] = stageCode;
      fields['治疗方案'] = pickCode('治疗方案', random);
      break;
    case 'removeStage':
      fields['治疗方案'] = planCode;
      missingFields.push('分期');
      break;
    case 'removePlan':
      fields['分期'] = stageCode;
      missingFields.push('治疗方案');
      break;
    default:
      break;
  }

  // 派生字段与就诊时段：部分患者有多次就诊（首次入院日 ≠ 本次就诊开始）
  const admissionDay = plan.index % 365;
  const currentDay = 365 + ((plan.index * 13) % 400);
  // 每 11 行造一条 23 点开诊的就诊，用来压「时区偏移跨日」的边界
  const currentHour = plan.index % 11 === 0 ? 23 : 8;
  const encounters: HospitalRecord['encounters'] = [
    {
      start: localDateTime(currentDay, currentHour),
      end: localDateTime(currentDay + 5, 11),
      class: 'AMB',
    },
  ];
  if (plan.index % 3 !== 2) {
    encounters.push({
      start: localDateTime(admissionDay, 9),
      end: localDateTime(admissionDay + 6, 10),
      class: 'AMB',
    });
  }
  encounters.sort((left, right) => (left.start < right.start ? -1 : left.start > right.start ? 1 : 0));

  const starts = encounters.map((encounter) => encounter.start);
  const firstAdmission = starts.reduce((min, value) => (value < min ? value : min));
  fields['首次入院日'] = localDate(firstAdmission);
  fields['本次就诊开始'] = starts.reduce((max, value) => (value > max ? value : max));

  return { registryId: plan.registryId, fields, missingFields, encounters };
}

/** 逐字段算期望操作：受控编码字段按「归并后的编码」比，缺失与 null 严格区分。 */
function computeOperations(
  plan: RowPlan,
  hospital: HospitalRecord,
): { operations: ExpectedOperation[]; unmergeableFields: ComparedField[] } {
  const operations: ExpectedOperation[] = [];
  const unmergeableFields: ComparedField[] = [];

  const compare = (field: ComparedField, sheetRaw: string): void => {
    const merged = lookupExpectedCode(field, sheetRaw);
    const hospitalValue = hospital.fields[field] ?? null;

    if (merged === null) {
      if (sheetRaw.trim().length === 0) {
        // 登记侧为空：院内有值才需要新增；两侧都空则无操作
        if (hospitalValue !== null) {
          operations.push({ field, op: 'add', oldValue: null, newValue: hospitalValue, sheetRaw });
        }
        return;
      }
      // 归并不成功：不产出任何操作，标「需人工判定」，不许猜
      unmergeableFields.push(field);
      return;
    }

    if (hospitalValue === null) {
      operations.push({ field, op: 'remove', oldValue: merged, newValue: null, sheetRaw });
      return;
    }
    if (merged !== hospitalValue) {
      operations.push({ field, op: 'replace', oldValue: merged, newValue: hospitalValue, sheetRaw });
    }
  };

  compare('分期', plan.stageRaw);
  compare('治疗方案', plan.planRaw);

  return { operations, unmergeableFields };
}

/** 由操作与归并结果推出行的期望状态。 */
function statusOf(
  operations: ExpectedOperation[],
  unmergeableFields: ComparedField[],
): ExpectedStatus {
  if (unmergeableFields.length > 0) return '需人工判定';
  if (operations.length > 0) return '待确认';
  return '无需确认';
}

/** 脏行块：空行、缺登记号、重复登记号、列数不符，各至少一行。 */
interface DirtyBlock {
  lines: string[];
  blocked: BlockedRow[];
}

/**
 * 组装脏行块（接在可比对行之后）。
 *
 * @param baseRowNumber 脏行块第一行（空行）的表内行号
 */
function buildDirtyBlock(baseRowNumber: number): DirtyBlock {
  const lines: string[] = [];
  const blocked: BlockedRow[] = [];

  // 1) 空行：整行空白，读取层按「跳过空行」计数，不算数据行
  lines.push('');

  // 2) 缺登记号：无法与院内记录绑定
  lines.push(',Ⅱ,根治术,138****9002,');
  blocked.push({
    rowNumber: baseRowNumber + 1,
    registryId: null,
    code: 'MISSING_REGISTRY_ID',
    reason: '登记号为空，无法与院内记录绑定',
  });

  // 3) 重复登记号：两行同号，与院内记录绑定会歧义
  lines.push('REG-DUP-0001,ⅢB,姑息治疗,138****9003,吸烟史');
  lines.push('REG-DUP-0001,IIIB,姑息治疗,138****9004,戒烟');
  blocked.push({
    rowNumber: baseRowNumber + 2,
    registryId: 'REG-DUP-0001',
    code: 'DUPLICATE_REGISTRY_ID',
    reason: '登记号 REG-DUP-0001 在本表出现 2 次',
  });
  blocked.push({
    rowNumber: baseRowNumber + 3,
    registryId: 'REG-DUP-0001',
    code: 'DUPLICATE_REGISTRY_ID',
    reason: '登记号 REG-DUP-0001 在本表出现 2 次',
  });

  // 4) 列数不符：列位可能已错位，本行阻断比对
  //    登记号刻意取一个不与可比对行冲突的占位值（否则会连带触发重复登记号，
  //    脏行就变成两种错误混在一起，期望差异集与读取层的判定会对不上）
  lines.push('REG-9901,ⅢB,免疫治疗');
  blocked.push({
    rowNumber: baseRowNumber + 4,
    registryId: 'REG-9901',
    code: 'COLUMN_COUNT_MISMATCH',
    reason: '该行只有 3 个单元格，表头是 5 列',
  });

  return { lines, blocked };
}

/**
 * 三类操作必须都出现（回归基线与规模验收都要用到）。
 *
 * 缺了就改**院内侧**补齐（表侧是登记员写的，不该为了凑齐操作类型去改它）。
 */
function ensureOperationCoverage(
  expectedRows: ExpectedRow[],
  plans: RowPlan[],
  hospitals: HospitalRecord[],
  random: () => number,
): void {
  for (const op of ['add', 'replace', 'remove'] as ExpectedOp[]) {
    const present = expectedRows.some((row) => row.operations.some((item) => item.op === op));
    if (present) continue;

    const target = expectedRows.find((row) => {
      if (row.unmergeableFields.length > 0) return false;
      if (op === 'add') return row.scenario === 'addStage' || row.scenario === 'addPlan';
      if (op === 'remove') return row.scenario === 'removeStage' || row.scenario === 'removePlan';
      return (
        row.scenario === 'replaceStage' ||
        row.scenario === 'replacePlan' ||
        row.scenario === 'replaceBoth'
      );
    });
    if (target === undefined) continue;

    const plan = plans.find((item) => item.registryId === target.registryId);
    const hospital = hospitals.find((record) => record.registryId === target.registryId);
    if (plan === undefined || hospital === undefined) continue;

    if (op === 'replace') {
      const field: ComparedField = target.operations[0]?.field ?? '分期';
      hospital.fields[field] = pickCode(field, random, hospital.fields[field] ?? null);
    } else if (op === 'add') {
      const field: ComparedField = plan.scenario === 'addPlan' ? '治疗方案' : '分期';
      if (hospital.fields[field] === undefined) {
        hospital.fields[field] = pickCode(field, random);
      }
    } else {
      const field: ComparedField = plan.scenario === 'removePlan' ? '治疗方案' : '分期';
      delete hospital.fields[field];
      if (!hospital.missingFields.includes(field)) hospital.missingFields.push(field);
    }

    const recomputed = computeOperations(plan, hospital);
    target.operations = recomputed.operations;
    target.unmergeableFields = recomputed.unmergeableFields;
    target.expectedStatus = statusOf(recomputed.operations, recomputed.unmergeableFields);
  }
}

/** 统计各类操作的数量。 */
function countOperations(rows: ExpectedRow[]): Record<ExpectedOp, number> {
  const counts: Record<ExpectedOp, number> = { add: 0, replace: 0, remove: 0 };
  for (const row of rows) {
    for (const operation of row.operations) {
      counts[operation.op] += 1;
    }
  }
  return counts;
}

/** 统计各类行状态的数量。 */
function countStatus(rows: ExpectedRow[]): Record<ExpectedStatus, number> {
  const counts: Record<ExpectedStatus, number> = { 待确认: 0, 无需确认: 0, 需人工判定: 0 };
  for (const row of rows) {
    counts[row.expectedStatus] += 1;
  }
  return counts;
}

/** 生成全部产物。 */
export function generateSample(options: GenerateOptions): GeneratedSample {
  const random = mulberry32(options.seed ^ 0x9e3779b9);
  const plans = planRows(options);
  const unrepairable = repairCorpusCoverage(plans);

  const hospitals: HospitalRecord[] = [];
  const expectedRows: ExpectedRow[] = [];

  for (const plan of plans) {
    const hospital = buildHospitalRecord(plan, random);
    hospitals.push(hospital);
    const { operations, unmergeableFields } = computeOperations(plan, hospital);
    expectedRows.push({
      registryId: plan.registryId,
      rowNumber: plan.rowNumber,
      scenario: plan.scenario,
      expectedStatus: statusOf(operations, unmergeableFields),
      operations,
      unmergeableFields,
    });
  }

  ensureOperationCoverage(expectedRows, plans, hospitals, random);

  // 登记表正文
  const bodyLines: string[] = [];
  for (const plan of plans) {
    bodyLines.push(
      [plan.registryId, plan.stageRaw, plan.planRaw, plan.phone, plan.lifestyle]
        .map(csvEscape)
        .join(','),
    );
  }

  const dirty = buildDirtyBlock(plans.length + 2);
  const headerLine = SHEET_HEADER.join(',');
  const sheetCsv = [headerLine, ...bodyLines, ...dirty.lines].join('\r\n') + '\r\n';

  // 混编表：GBK 段 + UTF-8 段
  const gbkText = [SHEET_HEADER.join(','), ...MIXED_GBK_ROWS].join('\r\n') + '\r\n';
  const utf8Text = [...MIXED_UTF8_ROWS].join('\r\n') + '\r\n';
  const gbkBytes = encodeGbk(gbkText);
  const mixedCsv = Buffer.concat([gbkBytes, Buffer.from(utf8Text, 'utf8')]);
  const mixedDecoded = decodeSheetBuffer(mixedCsv);
  const mixedText = mixedDecoded.text;

  const operations = countOperations(expectedRows);
  const status = countStatus(expectedRows);

  const expectedDiffs: ExpectedDiffsFile = {
    schemaVersion: '1',
    generator: 'scripts/gen-samples',
    generatedWith: { rows: options.rows, seed: options.seed },
    conventions: CONVENTIONS,
    rows: expectedRows,
    blockedRows: dirty.blocked,
    summary: {
      rows: expectedRows.length,
      blocked: dirty.blocked.length,
      operations,
      status,
    },
  };

  const hospitalExpected: HospitalExpectedFile = {
    schemaVersion: '1',
    generator: 'scripts/gen-samples',
    identifierSystem: 'urn:example:tumor-registry:registry-id',
    conventions: CONVENTIONS,
    records: hospitals,
  };

  const stats: GenerationStats = {
    csvDataLines: bodyLines.length + dirty.lines.length,
    usableRows: plans.length,
    blockedRows: dirty.blocked.length,
    blankLines: dirty.lines.filter((line) => line.trim().length === 0).length,
    corpusEntries: CORPUS.length,
    operations,
    status,
  };

  const checks = runChecks({
    requestedRows: options.rows,
    stats,
    plans,
    expectedRows,
    dirty,
    unrepairable,
    mixedDecodedEncoding: mixedDecoded.encoding,
    mixedText,
    expectedMixedText: gbkText + utf8Text,
    gbkConflicts: findUtf8AmbiguousRuns(gbkBytes),
    sheetCsv,
  });

  return {
    sheetCsv,
    mixedCsv,
    mixedText,
    expectedDiffs,
    hospitalExpected,
    corpus: CORPUS,
    stats,
    checks,
  };
}

/** 校验：把「生成出来的东西对不对」逐条查清楚，不对就明说。 */
function runChecks(input: {
  requestedRows: number;
  stats: GenerationStats;
  plans: RowPlan[];
  expectedRows: ExpectedRow[];
  dirty: DirtyBlock;
  unrepairable: string[];
  mixedDecodedEncoding: string;
  mixedText: string;
  expectedMixedText: string;
  gbkConflicts: string[];
  sheetCsv: string;
}): ValidationCheck[] {
  const checks: ValidationCheck[] = [];

  checks.push({
    name: 'rows_min',
    ok: input.stats.usableRows === input.requestedRows,
    detail: `可参与比对的行 ${input.stats.usableRows} 行（请求 ${input.requestedRows} 行），脏行 ${input.stats.blockedRows} 行`,
  });

  // 语料覆盖
  const used = new Set<string>();
  for (const plan of input.plans) {
    if (plan.stageRaw.length > 0) used.add(`分期|${plan.stageRaw}`);
    if (plan.planRaw.length > 0) used.add(`治疗方案|${plan.planRaw}`);
  }
  const missing = CORPUS.filter((entry) => !used.has(`${entry.field}|${entry.raw}`));
  checks.push({
    name: 'corpus_coverage',
    ok: missing.length === 0,
    detail:
      missing.length === 0
        ? `语料 ${CORPUS.length} 条全部在样例表中出现`
        : `有 ${missing.length} 条语料没出现：${missing.map((entry) => entry.raw).join('、')}`,
  });

  checks.push({
    name: 'corpus_size',
    ok: CORPUS.length >= 40,
    detail: `语料 ${CORPUS.length} 条（下限 40 条）`,
  });

  // 三类操作齐全
  checks.push({
    name: 'operation_types',
    ok:
      input.stats.operations.add > 0 &&
      input.stats.operations.replace > 0 &&
      input.stats.operations.remove > 0,
    detail:
      `add ${input.stats.operations.add} / replace ${input.stats.operations.replace} ` +
      `/ remove ${input.stats.operations.remove}`,
  });

  // 脏行四类齐全
  const codes = new Set(input.dirty.blocked.map((row) => row.code));
  checks.push({
    name: 'dirty_rows',
    ok:
      codes.has('MISSING_REGISTRY_ID') &&
      codes.has('DUPLICATE_REGISTRY_ID') &&
      codes.has('COLUMN_COUNT_MISMATCH') &&
      input.stats.blankLines >= 1,
    detail: `空行 ${input.stats.blankLines} 行；脏行错误码：${[...codes].join('、')}`,
  });

  // 脏行的登记号不得与可比对行撞号（否则会连带触发重复登记号，期望就对不上了）
  const usableIds = new Set(input.plans.map((plan) => plan.registryId));
  const collided = input.dirty.blocked
    .filter((row) => row.registryId !== null && usableIds.has(row.registryId))
    .map((row) => row.registryId as string);
  checks.push({
    name: 'dirty_id_collision',
    ok: collided.length === 0,
    detail:
      collided.length === 0
        ? '脏行的登记号与可比对行不冲突'
        : `脏行登记号与可比对行撞号：${collided.join('、')}`,
  });

  // 期望条目数与行数一致
  checks.push({
    name: 'expected_count',
    ok:
      input.expectedRows.length + input.dirty.blocked.length ===
      input.stats.csvDataLines - input.stats.blankLines,
    detail:
      `期望可比对 ${input.expectedRows.length} 条 + 阻断 ${input.dirty.blocked.length} 条 ` +
      `= CSV 数据行 ${input.stats.csvDataLines} 行减空行 ${input.stats.blankLines} 行`,
  });

  // 无可识别明报：电话全脱敏、无身份证号、无姓名列
  const phonePattern = /1[3-9]\d{9}/;
  const idPattern = /\d{17}[\dXx]/;
  const rawPhones = input.plans.filter(
    (plan) => plan.phone.length > 0 && !/^1\d{2}\*{4}\d{4}$/.test(plan.phone),
  );
  const leaked = input.sheetCsv
    .split(/\r?\n/)
    .filter((line) => phonePattern.test(line) || idPattern.test(line));
  checks.push({
    name: 'no_identifiers',
    ok: rawPhones.length === 0 && leaked.length === 0 && !input.sheetCsv.includes('姓名'),
    detail:
      rawPhones.length === 0 && leaked.length === 0 && !input.sheetCsv.includes('姓名')
        ? '未发现未脱敏手机号、身份证号或姓名列'
        : `发现 ${rawPhones.length + leaked.length} 处疑似明报`,
  });

  // 混编表：GBK 段不会与 UTF-8 混淆，且整体能被正确解码
  checks.push({
    name: 'mixed_encoding_safe',
    ok: input.gbkConflicts.length === 0,
    detail:
      input.gbkConflicts.length === 0
        ? 'GBK 段各字节段都不会被误判成 UTF-8'
        : input.gbkConflicts.join('；'),
  });

  checks.push({
    name: 'mixed_encoding_decodes',
    ok: input.mixedDecodedEncoding === 'mixed' && input.mixedText === input.expectedMixedText,
    detail:
      input.mixedDecodedEncoding === 'mixed' && input.mixedText === input.expectedMixedText
        ? '混编表被识别为 mixed 且逐字解回原文'
        : `识别为 ${input.mixedDecodedEncoding}，逐字比对${
            input.mixedText === input.expectedMixedText ? '一致' : '不一致'
          }`,
  });

  if (input.unrepairable.length > 0) {
    checks.push({
      name: 'corpus_coverage_repair',
      ok: false,
      detail: `行数不足以覆盖这些语料条目，请调大 --rows：${input.unrepairable.join('、')}`,
    });
  }

  return checks;
}
