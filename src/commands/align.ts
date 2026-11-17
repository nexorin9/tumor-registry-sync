/**
 * align 子命令：把登记表行与院内权威记录逐字段比对，产出可供宏回写的结果。
 *
 * 三入口（Excel 宏 / WPS 宏 / CSV 直跑）都收敛到同一份 AlignRequest 契约：
 * - `--in <file.json>`：宏已把工作表导出成 AlignRequest，直接用 header + rows
 * - `--in <file.csv>`：读表 → 规范行 → 走列映射 → 转成 header + rows 的等价形态
 *
 * 比对管线（纯引擎、网络只在检索侧）：
 * 1. 读表 / 规范行（blocked 行——缺登记号 / 重复 / 列数不符——原样保留，标「待对齐」）
 * 2. 按登记主索引批量检索院内权威记录（复用 fhir 检索编排，同号只查一次）
 * 3. 命中行：取院内值（含派生字段）→ 与登记侧逐字段最小差异 → 渲染「差异 / 建议值」文案
 * 4. AI 说明：受控网关 explain-diff，不可达时填降级模板句（模型输出永不进推送体）
 * 5. 收口：批次键、摘要计数、缺行检查（院内命中但本表缺行）、运行日志
 *
 * 输出：
 * - 默认：AlignResult JSON 写到 `--out`（或标准输出）
 * - CSV 入参且指定了 CSV 落点：另写一张「原表列 + 五列新列 + 表尾两块」的结果表文件
 *
 * 不修改任何既有模块；只组合公共 API。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type AlignRowResult,
  type AlignResult,
  type BindingOutcome,
  type FieldValue,
  type MissingRow,
  type Operation,
  type RowIssue,
  errorResponse,
  okResponse,
} from '../contract/index.js';
import {
  InvalidEnvError,
  loadCdrEnv,
  loadEnv,
  loadFhirMaxConcurrency,
} from '../config/env.js';
import {
  FhirClient,
  FhirRequestError,
  lookupRows,
} from '../fhir/index.js';
import {
  type ControlledCodeResolution,
  type ControlledCodeResolver,
  collectHospitalValues,
  createControlledCodeEquivalence,
  loadPathMap,
  resolvePathMap,
} from '../diff/path-map.js';
import { buildDefaultVocabIndex, mergeByVocab } from '../merge/index.js';
import { buildDerivedFields } from '../diff/derived.js';
import { loadFieldSpec } from '../diff/field-spec.js';
import { diffRowAgainstRecord, type DiffOperation } from '../diff/patch.js';
import { renderDiff } from '../diff/render.js';
import { OpenAIGateway, degradedExplainDiff } from '../model/index.js';
import type { ModelGateway } from '../model/gateway.js';
import type { ModelEnv } from '../config/env.js';
import {
  ColumnMappingError,
  buildRows,
  loadColumnMapping,
  readSheetFile,
  resolveColumnMapping,
} from '../sheet/index.js';
import {
  type ResultFileInput,
  newColumnsFromAlignRow,
  writeResultFile,
} from '../sheet/result-file.js';
import { buildReceiptBlock } from '../push/index.js';
import { buildSummary } from '../audit/summary.js';
import { makeBatchKey, tableFingerprint } from '../audit/batch-key.js';
import {
  findMissingRows,
  isMissingCheckDeclared,
  loadMissingCheckConfig,
} from '../missing/diff-set.js';
import { RunLogger, buildLookupEvents } from '../observability/index.js';

import { resolveRunLogPath } from './shared.js';

/** 列映射配置默认路径（位于项目根 config/）。 */
export function defaultMappingPath(): string {
  return fileURLToPath(new URL('../../config/column-mapping.json', import.meta.url));
}

/** 字段口径表默认路径（位于项目根 config/）。 */
export function defaultFieldSpecPath(): string {
  return fileURLToPath(new URL('../../config/field-spec.json', import.meta.url));
}

/** 字段路径映射表默认路径（位于项目根 config/）。 */
export function defaultPathMapPath(): string {
  return fileURLToPath(new URL('../../config/path-map.json', import.meta.url));
}

/** 绑定判定 → align 行状态。 */
function statusOfBinding(binding: BindingOutcome): AlignRowResult['status'] {
  switch (binding) {
    case '命中':
      return '待确认';
    case '歧义':
      return '命中歧义';
    case '零命中':
      return '零命中';
    default:
      return '待对齐';
  }
}

/** 受控编码等价解析器：词表归并（模型兜底不进差异判定，只走建议）。 */
function buildControlledCodeResolver(): ControlledCodeResolver {
  const vocab = buildDefaultVocabIndex();
  return {
    resolve(_field: string, rawValue: string): ControlledCodeResolution {
      const merged = mergeByVocab(rawValue, vocab);
      return { code: merged.code, reason: merged.reason, confidence: merged.confidence };
    },
  };
}

/** 模型不可用时用的网关桩：所有调用返回降级产物。 */
function degradedGateway(): ModelGateway {
  return {
    async mergeTerm() {
      return { code: null, confidence: 0, reason: '模型未启用或不可达' };
    },
    async explainDiff() {
      return degradedExplainDiff();
    },
  };
}

/** 按环境构造模型网关；未配置则返回一个只返回降级产物的桩。 */
function makeGateway(model: ModelEnv | null): ModelGateway {
  if (model === null) return degradedGateway();
  try {
    return new OpenAIGateway(model);
  } catch {
    return degradedGateway();
  }
}

/**
 * 一行差异的 AI 说明：只调 explain-diff，失败/无差异一律降级模板句。
 * 模型输出永不进入推送体，只进「AI 说明」列。
 */
async function buildAiNote(
  gateway: ModelGateway,
  operations: DiffOperation[],
): Promise<string> {
  if (operations.length === 0) return '';
  const op = operations[0] as DiffOperation;
  try {
    const out = await gateway.explainDiff({
      field: op.field,
      registryValue: op.oldValue === undefined ? '' : String(op.oldValue),
      hospitalValue: op.newValue === undefined ? '' : String(op.newValue),
      fieldNote: '',
    });
    return out.note;
  } catch {
    return degradedExplainDiff().note;
  }
}

/** 把 diff 引擎操作收敛成契约 Operation（只保留契约字段）。 */
function toOperation(op: DiffOperation): Operation {
  const out: Operation = {
    op: op.op,
    path: op.path,
  };
  if (op.oldValue !== undefined) out.oldValue = op.oldValue as Operation['oldValue'];
  if (op.newValue !== undefined) out.newValue = op.newValue as Operation['newValue'];
  if (op.destructive !== undefined) out.destructive = op.destructive;
  return out;
}

/** align 管线输入。 */
export interface AlignPipelineInput {
  /** 表头（原列顺序） */
  header: string[];
  /** 数据行（字符串，已跳过空行） */
  rows: string[][];
  /** 列映射配置路径 */
  columnMappingPath: string;
  /** 字段口径表路径 */
  fieldSpecPath: string;
  /** 字段路径映射表路径 */
  pathMapPath: string;
  /** 运行环境（环境变量） */
  source: NodeJS.ProcessEnv;
  /** 模型网关（已按配置构造好） */
  gateway: ModelGateway;
  /** 运行日志器（检索事件写入其中） */
  logger: RunLogger;
}

/** align 管线输出。 */
export interface AlignPipelineOutput {
  /** 对齐结果（契约形状） */
  result: AlignResult;
  /** 用于写回 CSV 的「原表数据行」（与 result.rows 同序、跳过空行） */
  csvOriginalRows: string[][];
}

/**
 * 跑一整条对齐管线，产出 AlignResult（纯逻辑，不含文件 IO）。
 *
 * blocked 行（缺登记号 / 重复 / 列数不符）原样保留：状态「待对齐」、绑定「未完成」、
 * 不产出差异操作；其余行的判定按绑定结果映射到状态机。
 */
export async function runAlignPipeline(
  input: AlignPipelineInput,
): Promise<AlignPipelineOutput> {
  const { header, rows, source, gateway, logger } = input;

  const mapping = loadColumnMapping(input.columnMappingPath);
  resolveColumnMapping(mapping, header);
  const normalized = buildRows({ header, rows, mapping });

  const spec = loadFieldSpec(input.fieldSpecPath);
  const pathMap = loadPathMap(input.pathMapPath);
  const resolution = resolvePathMap(spec, pathMap, header);
  const resolver = buildControlledCodeResolver();
  const equivalent = createControlledCodeEquivalence(pathMap, resolver);

  const cdr = loadCdrEnv(source);
  const client = new FhirClient({
    baseUrl: cdr.baseUrl,
    apiToken: cdr.apiToken,
    identifierSystem: cdr.identifierSystem,
  });

  const searchable = normalized.rows
    .filter((row) => !row.blocked && row.registryId !== null)
    .map((row) => ({ rowNumber: row.rowNumber, registryId: row.registryId as string }));

  const lookup = await lookupRows(searchable, client, {
    maxConcurrency: loadFhirMaxConcurrency(source),
  });

  for (const event of buildLookupEvents(lookup.rows)) logger.push(event);

  const lookupByRow = new Map(lookup.rows.map((row) => [row.rowNumber, row]));
  const generatedAt = new Date().toISOString();

  const alignRows: AlignRowResult[] = [];
  const issues: RowIssue[] = [...normalized.issues];

  for (const row of normalized.rows) {
    const humanSuppliedColumns = row.humanSuppliedColumns;

    if (row.blocked) {
      alignRows.push({
        rowNumber: row.rowNumber,
        registryId: row.registryId,
        status: '待对齐',
        binding: '未完成',
        hospitalValues: {},
        operations: [],
        diffText: '',
        suggestedText: '',
        confirmValue: '待确认',
        aiNote: '本行被读表层挡下，未参与比对',
        humanSuppliedColumns,
      });
      continue;
    }

    const outcome = lookupByRow.get(row.rowNumber);
    const binding: BindingOutcome = outcome?.binding ?? '未完成';
    const status = statusOfBinding(binding);

    if (binding !== '命中' || outcome === undefined) {
      alignRows.push({
        rowNumber: row.rowNumber,
        registryId: row.registryId,
        status,
        binding,
        hospitalValues: {},
        operations: [],
        diffText: binding === '零命中' ? '院内无此登记号' : binding === '歧义' ? '院内命中多条，需人工判定' : '',
        suggestedText: '',
        confirmValue: '待确认',
        aiNote: '',
        humanSuppliedColumns,
      });
      continue;
    }

    const record = {
      patient: outcome.patient,
      conditions: outcome.conditions,
      encounters: outcome.encounters,
    };
    const derived = buildDerivedFields({
      spec,
      rowNumber: row.rowNumber,
      registryId: row.registryId as string,
      encounters: outcome.encounters,
    });
    for (const issue of derived.issues) issues.push(issue);

    const derivedValues: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(derived.derived)) {
      derivedValues[field] = value.date ?? null;
    }

    const hospitalResult = collectHospitalValues(resolution, record, derivedValues);
    const hospitalValues = hospitalResult.values;

    const registryValues: Record<string, unknown> = {};
    for (const [field, cell] of Object.entries(row.cells)) {
      registryValues[field] = cell.value;
    }
    const rawRegistryValues: Record<string, unknown> = {};
    const fieldByColumn = new Map(mapping.columns.map((c) => [c.sourceColumn, c.field]));
    for (const [column, raw] of Object.entries(row.rawByColumn)) {
      const field = fieldByColumn.get(column);
      if (field !== undefined) rawRegistryValues[field] = raw;
    }

    const diff = diffRowAgainstRecord({
      spec,
      registryValues,
      hospitalValues,
      rawRegistryValues,
      rawHospitalValues: hospitalValues,
      equivalent,
    });
    const rendered = renderDiff({ operations: diff.operations });

    const hospitalFieldValues: Record<string, FieldValue> = {};
    for (const [field, value] of Object.entries(hospitalValues)) {
      hospitalFieldValues[field] = value as FieldValue;
    }

    const aiNote = await buildAiNote(gateway, diff.operations);

    alignRows.push({
      rowNumber: row.rowNumber,
      registryId: row.registryId,
      status,
      binding,
      hospitalValues: hospitalFieldValues,
      operations: diff.operations.map(toOperation),
      diffText: rendered.diffText,
      suggestedText: rendered.suggestedText,
      confirmValue: '待确认',
      aiNote,
      humanSuppliedColumns,
    });
  }

  const diffRows = alignRows.filter((row) => row.operations.length > 0).length;
  const pendingConfirm = alignRows.filter((row) => row.status === '待确认').length;
  const adopted = alignRows.filter((row) => row.confirmValue === '采纳').length;
  const issueRows = new Set(issues.map((issue) => issue.rowNumber)).size;

  // 缺行检查：院内命中但本表缺行（仅当口径声明启用；失败也绝不谎报成零缺行）
  let missingRows: MissingRow[] = [];
  const missingConfig = loadMissingCheckConfig();
  if (isMissingCheckDeclared(null, missingConfig)) {
    try {
      const registryIds = normalized.rows
        .filter((row) => !row.blocked && row.registryId !== null)
        .map((row) => row.registryId as string);
      const mc = await findMissingRows({
        cdr: loadCdrEnv(source),
        registryIds,
        config: missingConfig,
      });
      missingRows = mc.rows;
    } catch {
      missingRows = [];
    }
  }

  const summary = buildSummary({
    total: alignRows.length,
    matched: lookup.stats.matched,
    ambiguous: lookup.stats.ambiguous,
    noMatch: lookup.stats.noMatch,
    diffRows,
    pendingConfirm,
    adopted,
    missingRows: missingRows.length,
    issueRows,
    missingCheckIncomplete: !isMissingCheckDeclared(null, missingConfig),
  });

  const fingerprint = tableFingerprint(header, rows);
  const batchKey = makeBatchKey(fingerprint, lookup.searchParams, generatedAt);

  const receipt = buildReceiptBlock({
    batchKey,
    searchParams: lookup.searchParams,
    pushedAt: null,
    receipts: [],
    summary,
  });

  const runLogPath = logger.path;

  const result: AlignResult = {
    batchKey,
    generatedAt,
    summary,
    rows: alignRows,
    issues,
    receipt,
    missingRows,
    runLogPath,
  };

  const csvOriginalRows = normalized.rows.map((row) =>
    header.map((column) => row.rawByColumn[column] ?? ''),
  );

  return { result, csvOriginalRows };
}

/**
 * align 管线核心：构造模型网关与运行日志器、跑管线、落盘运行日志。
 *
 * align（JSON / CSV 入口）与 replay（离线回放）共用同一份比对逻辑，
 * 避免两处各自实现导致分叉。文件 IO（JSON / CSV 落盘）留在命令层。
 */
export async function runAlignCore(
  header: string[],
  rows: string[][],
  columnMappingPath: string,
  fieldSpecPath: string,
  pathMapPath: string,
  flags: Record<string, string | boolean>,
  source: NodeJS.ProcessEnv,
): Promise<{
  result: AlignResult;
  csvOriginalRows: string[][];
  runLogPath: string;
  runLogWritten: number;
}> {
  const env = loadEnv(source);
  const gateway = makeGateway(env.model);

  const runLogPath = resolveRunLogPath(
    source,
    typeof flags['log'] === 'string' && flags['log'].length > 0
      ? (flags['log'] as string)
      : undefined,
  );
  const logger = new RunLogger({ path: runLogPath, stage: 'lookup' });

  const { result, csvOriginalRows } = await runAlignPipeline({
    header,
    rows,
    columnMappingPath,
    fieldSpecPath,
    pathMapPath,
    source,
    gateway,
    logger,
  });

  let runLogWritten = 0;
  try {
    runLogWritten = logger.flush();
  } catch {
    runLogWritten = 0;
  }

  return { result, csvOriginalRows, runLogPath, runLogWritten };
}

/**
 * align 子命令入口：解析 `--in`、构造管线输入、落盘结果（JSON 与可选 CSV）。
 */
export async function runAlign(
  flags: Record<string, string | boolean>,
  source: NodeJS.ProcessEnv,
): Promise<number> {
  const input = flags['in'];
  if (typeof input !== 'string' || input.length === 0) {
    process.stderr.write(
      `${JSON.stringify(
        errorResponse('align', {
          code: 'invalid_request',
          message: '缺少参数 --in（登记表 CSV 或 AlignRequest JSON 路径）',
          hint: '用法：node dist/cli.js align --in <登记表.csv|alignRequest.json> [--out <结果.json>] [--out-csv <结果.csv>]',
        }),
        null,
        2,
      )}\n`,
    );
    return 2;
  }

  const isCsv = extname(input).toLowerCase() === '.csv';

  const columnMappingPath =
    typeof flags['mapping'] === 'string' && flags['mapping'].length > 0
      ? (flags['mapping'] as string)
      : defaultMappingPath();
  const fieldSpecPath =
    typeof flags['fieldSpec'] === 'string' && flags['fieldSpec'].length > 0
      ? (flags['fieldSpec'] as string)
      : defaultFieldSpecPath();
  const pathMapPath = defaultPathMapPath();

  try {
    let header: string[];
    let rows: string[][];

    if (isCsv) {
      const mapping = loadColumnMapping(columnMappingPath);
      const sheet = readSheetFile(input);
      resolveColumnMapping(mapping, sheet.header);
      header = sheet.header;
      rows = sheet.rows;
    } else {
      const text = readFileSync(input, 'utf8');
      const parsed = JSON.parse(text) as {
        header?: unknown;
        rows?: unknown;
        columnMappingPath?: string;
        fieldSpecPath?: string;
      };
      if (!Array.isArray(parsed.header) || !Array.isArray(parsed.rows)) {
        throw new Error('AlignRequest 缺少 header / rows 字段');
      }
      header = parsed.header.map((name) => String(name));
      // 单元格可能是 number / boolean / null，统一转字符串供规范行层处理
      rows = (parsed.rows as unknown[][]).map((row) =>
        row.map((cell) => (cell === null ? '' : String(cell))),
      );
      if (typeof parsed.columnMappingPath === 'string' && parsed.columnMappingPath.length > 0) {
        if (existsSync(parsed.columnMappingPath)) {
          // 仅当显式声明且文件存在时覆盖；否则沿用命令行/默认
          (flags as Record<string, string>)['mapping'] = parsed.columnMappingPath;
        }
      }
      if (typeof parsed.fieldSpecPath === 'string' && parsed.fieldSpecPath.length > 0) {
        if (existsSync(parsed.fieldSpecPath)) {
          (flags as Record<string, string>)['fieldSpec'] = parsed.fieldSpecPath;
        }
      }
    }

    const effectiveMappingPath =
      typeof flags['mapping'] === 'string' && flags['mapping'].length > 0
        ? (flags['mapping'] as string)
        : columnMappingPath;
    const effectiveFieldSpecPath =
      typeof flags['fieldSpec'] === 'string' && flags['fieldSpec'].length > 0
        ? (flags['fieldSpec'] as string)
        : fieldSpecPath;

    const { result, csvOriginalRows, runLogPath, runLogWritten } = await runAlignCore(
      header,
      rows,
      effectiveMappingPath,
      effectiveFieldSpecPath,
      pathMapPath,
      flags,
      source,
    );

    const payload = okResponse('align', result, result.batchKey);
    const text = `${JSON.stringify(payload, null, 2)}\n`;

    const outFlag = typeof flags['out'] === 'string' ? (flags['out'] as string) : null;
    const outCsvFlag =
      typeof flags['out-csv'] === 'string' && flags['out-csv'].length > 0
        ? (flags['out-csv'] as string)
        : null;

    // CSV 入参 + 指定 CSV 落点（或 --out 本身以 .csv 结尾）时写结果表文件
    const csvOutPath =
      isCsv && outCsvFlag !== null
        ? outCsvFlag
        : isCsv && outFlag !== null && outFlag.toLowerCase().endsWith('.csv')
          ? outFlag
          : null;

    if (csvOutPath !== null) {
      const humanSuppliedColumns = Array.from(
        new Set(result.rows.flatMap((row) => row.humanSuppliedColumns)),
      );
      const csvInput: ResultFileInput = {
        header,
        originalRows: csvOriginalRows,
        newColumns: result.rows.map((row) => newColumnsFromAlignRow(row)),
        receipt: result.receipt,
        missingRows: result.missingRows,
        humanSuppliedColumns,
      };
      writeResultFile(csvInput, csvOutPath, {});
    }

    if (outFlag !== null && csvOutPath === null) {
      writeFileSync(outFlag, text, 'utf8');
      process.stdout.write(
        `${JSON.stringify(
          okResponse(
            'align',
            { outputPath: outFlag, runLogPath, runLogWritten, csvPath: csvOutPath },
            result.batchKey,
          ),
          null,
          2,
        )}\n`,
      );
    } else {
      process.stdout.write(text);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error instanceof FhirRequestError
        ? error.code
        : error instanceof ColumnMappingError || error instanceof InvalidEnvError
          ? 'invalid_request'
          : 'unknown';
    const hint =
      error instanceof FhirRequestError
        ? error.userHint
        : error instanceof ColumnMappingError
          ? '请按提示核对列映射配置或表头后重跑'
          : error instanceof InvalidEnvError
            ? error.message
            : '请确认 --in 指向的文件存在且可读，且 CDR_* 环境变量已配置';
    process.stderr.write(
      `${JSON.stringify(errorResponse('align', { code, message, hint }), null, 2)}\n`,
    );
    return 1;
  }
}
