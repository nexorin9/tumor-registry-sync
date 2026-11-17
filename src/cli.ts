#!/usr/bin/env node
/**
 * 引擎入口（本机 CLI）。
 *
 * 三入口中的「CSV 直跑」入口即本 CLI；另外两个入口（Excel 加载宏 / WPS JSA 宏）
 * 由表内按钮把工作表导出成同一份 JSON 契约，再 Shell 调本 CLI 并回读结果。
 * 宏里不含任何业务逻辑，业务逻辑一律在这里。
 *
 * 当前已实现子命令：
 * - sheet   读表：读登记表 → 规范化行 → 打印行 JSON 与行级问题清单
 * - lookup  检索：读登记表 → 按登记主索引批量检索院内权威记录 → 逐行标注
 *                 「命中 / 歧义 / 零命中 / 未完成」（只读，不推送）
 * - caliber 口径：打印当前生效的字段口径清单与派生字段结果（离线，不依赖网络与凭据）
 * - doctor  体检：逐项检查九个环境变量与配置合法性，缺哪个点名哪个
 * - align   对齐：把登记表行与院内权威记录逐字段比对，产出可供宏回写的结果（含 CSV 落点）
 * - push    推送：把确认闸门放行的行（确认列=「采纳」）外发到专病库登记接口
 * - summary 摘要：读对齐结果 + 运行日志，产出本周期摘要并交叉校验计数
 * - replay  回放：把已导出的 AlignRequest JSON 重新跑一遍对齐管线（与 align 同引擎）
 */
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  inspectEnv,
  loadCdrEnv,
  loadEnv,
  loadFhirMaxConcurrency,
  loadRunLogDir,
  InvalidEnvError,
  ENV_NAMES,
} from './config/env.js';
import { errorResponse, okResponse, parseLookupResult } from './contract/index.js';
import {
  FieldSpecError,
  buildReplayDerivedRows,
  effectiveCalibers,
  loadFieldSpec,
  resolveFieldSpec,
} from './diff/index.js';
import { FhirClient, FhirRequestError, lookupRows, parseEncounter, parsePatient } from './fhir/index.js';
import {
  RunLogger,
  buildLookupEvents,
  formatErrorDistribution,
  summarizeErrors,
} from './observability/index.js';
import { patientIdOfReference, readReplaySet } from './scripts/fetch-synthea.js';
import {
  ColumnMappingError,
  buildRows,
  collectBatchIssues,
  formatIssueSummary,
  loadColumnMapping,
  readSheetFile,
  resolveColumnMapping,
  writeManualChecklist,
} from './sheet/index.js';
import { runAlign } from './commands/align.js';
import { runPush } from './commands/push.js';
import { runSummary } from './commands/summary.js';
import { runReplay } from './commands/replay.js';

const USAGE = `肿瘤登记增量同步 · 本机引擎

用法：
  node dist/cli.js sheet --in <登记表.csv>   读表：打印规范化行 JSON 与行级问题清单
  node dist/cli.js lookup --in <登记表.csv>  检索：按登记主索引查院内权威记录，逐行标注命中情况
  node dist/cli.js caliber                  口径：打印生效口径清单与派生字段结果（离线）
  node dist/cli.js doctor                   体检：检查环境变量与配置是否齐备
  node dist/cli.js align --in <登记表.csv|alignRequest.json> [--out <结果.json>] [--out-csv <结果.csv>]
  node dist/cli.js push --in <对齐结果.json> [--out <推送结果.json>] [--dry-run]
  node dist/cli.js summary --in <对齐结果.json> [--out <摘要.json>] [--run-log <run-log.jsonl>]
  node dist/cli.js replay --in <alignRequest.json> [--out <结果.json>] [--snapshot <快照.json>]

通用参数：
  --in <文件>              输入路径（sheet/lookup 为登记表 CSV；align 为 CSV 或 AlignRequest JSON；
                          push/summary 为对齐结果 JSON；replay 为 AlignRequest JSON）
  --mapping <列映射.json>  列映射配置路径（默认 config/column-mapping.json）
  --spec <口径表.json>     字段口径表路径（默认 config/field-spec.json）
  --replay <回放集目录>    离线回放集目录（默认 data/replay，不存在则跳过派生结果）
  --limit <n>              派生字段结果只算前 n 位患者（默认 5，0 表示全算）
  --out <结果.json>        结果落盘路径
  --out-csv <结果.csv>     align 的 CSV 结果表文件路径（仅 --in 为 CSV 时生效）
  --align-result <对齐结果.json>  push / summary 的别名入参，等价 --in
  --run-log <run-log.jsonl> summary 的运行日志路径
  --snapshot <快照.json>   replay 的离线快照路径（仅备注，不影响引擎）
  --dry-run               push 只构造推送体不外发
  --checklist <清单.csv>   把本批行级问题导出成待人工处理清单（CSV）
  --log <run-log.jsonl>    本机结构化运行日志路径

可用子命令：sheet、lookup、caliber、doctor、align、push、summary、replay
`;

function parseArgs(argv: string[]): { command: string; flags: Record<string, string | boolean> } {
  const [command = '', ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === undefined || !token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true;
    } else {
      flags[name] = next;
      i += 1;
    }
  }
  return { command, flags };
}

const ENV_REPORT_FIELDS: { key: string; label: string; required: boolean }[] = [
  { key: ENV_NAMES.cdrBaseUrl, label: '院内 FHIR 服务基地址', required: true },
  { key: ENV_NAMES.cdrApiToken, label: '院内 FHIR 服务令牌', required: true },
  { key: ENV_NAMES.cdrIdentifierSystem, label: '登记主索引 identifier system', required: true },
  { key: ENV_NAMES.registryBaseUrl, label: '专病库登记接口基地址', required: true },
  { key: ENV_NAMES.registryApiToken, label: '专病库登记接口令牌', required: true },
  { key: ENV_NAMES.modelBaseUrl, label: '模型网关 base_url', required: false },
  { key: ENV_NAMES.modelApiKey, label: '模型网关 api_key', required: false },
  { key: ENV_NAMES.modelName, label: '模型名', required: false },
  { key: ENV_NAMES.modelTimeoutMs, label: '模型调用超时（毫秒）', required: false },
];

function runDoctor(source: NodeJS.ProcessEnv): number {
  const { missing, invalid, modelConfigured } = inspectEnv(source);

  const variables = ENV_REPORT_FIELDS.map((field) => ({
    name: field.key,
    label: field.label,
    required: field.required,
    configured: (source[field.key] ?? '').trim().length > 0,
    isPlaceholder: (source[field.key] ?? '').includes('example-hospital.internal'),
  }));

  let loaded: { ok: true } | { ok: false; message: string } = { ok: true };
  try {
    loadEnv(source);
  } catch (error) {
    loaded = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  const report = {
    checkedAt: new Date().toISOString(),
    variables,
    missing,
    invalid,
    modelConfigured,
    loadable: loaded.ok,
  };

  const healthy = missing.length === 0 && invalid.length === 0 && loaded.ok;
  const payload = healthy
    ? okResponse('doctor', { ...report, message: '配置齐备，可以执行对齐与推送。' }, null)
    : errorResponse(
        'doctor',
        {
          code: missing.length > 0 ? 'missing_env' : 'invalid_request',
          message:
            missing.length > 0
              ? `配置不齐备：缺少环境变量：${missing.join('、')}`
              : `配置不齐备：${invalid.map((item) => item.message).join('；')}`,
          hint:
            missing.length > 0
              ? `请在 .env 中配置 ${missing.join('、')} 后重试`
              : invalid.map((item) => item.message).join('；'),
          details: report,
        },
        null,
      );

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);

  return healthy ? 0 : 1;
}

/** run-log 文件名（固定名，追加写，历史批次都留在同一个文件里）。 */
const RUN_LOG_FILE_NAME = 'run-log.jsonl';

/**
 * 解析本批运行日志的落盘路径。
 *
 * `--log <path>` 优先；否则落在 `RUN_LOG_DIR`（默认 logs）下的 run-log.jsonl。
 */
function resolveRunLogPath(
  flags: Record<string, string | boolean>,
  source: NodeJS.ProcessEnv,
): string {
  const flag = flags['log'];
  if (typeof flag === 'string' && flag.length > 0) return resolve(flag);
  return resolve(loadRunLogDir(source), RUN_LOG_FILE_NAME);
}

/** 默认列映射配置路径：项目根目录下的 config/column-mapping.json。 */
function defaultMappingPath(): string {
  return fileURLToPath(new URL('../config/column-mapping.json', import.meta.url));
}

/** 默认字段口径表路径：项目根目录下的 config/field-spec.json。 */
function defaultFieldSpecPath(): string {
  return fileURLToPath(new URL('../config/field-spec.json', import.meta.url));
}

/** 默认离线回放集目录：项目根目录下的 data/replay。 */
function defaultReplayDir(): string {
  return fileURLToPath(new URL('../data/replay', import.meta.url));
}

/**
 * sheet 子命令：读登记表 → 规范化行 → 打印行 JSON。
 *
 * 这是表格载体层的独立可验收入口：一条命令就能看到「这张表被读成了什么样、
 * 哪几行被挡下了」，不依赖网络也不依赖院内凭据。
 */
function runSheet(flags: Record<string, string | boolean>): number {
  const input = flags['in'];
  if (typeof input !== 'string' || input.length === 0) {
    process.stderr.write(
      `${JSON.stringify(
        errorResponse('sheet', {
          code: 'invalid_request',
          message: '缺少参数 --in（登记表 CSV 路径）',
          hint: '用法：node dist/cli.js sheet --in <登记表.csv> [--mapping <列映射.json>] [--out <结果.json>]',
        }),
        null,
        2,
      )}\n`,
    );
    return 2;
  }

  const mappingFlag = flags['mapping'];
  const mappingPath =
    typeof mappingFlag === 'string' && mappingFlag.length > 0 ? mappingFlag : defaultMappingPath();

  try {
    const mapping = loadColumnMapping(mappingPath);
    const sheet = readSheetFile(input);
    const resolved = resolveColumnMapping(mapping, sheet.header);
    const normalized = buildRows({ header: sheet.header, rows: sheet.rows, mapping });

    // 行级问题统一归集：读表侧与检索侧合到一套，按错误码给出分布
    const batchIssues = collectBatchIssues({ sheetRows: normalized.rows });

    const result = {
      source: input,
      mappingPath,
      encoding: sheet.encoding,
      lineEnding: sheet.lineEnding,
      hadBom: sheet.hadBom,
      header: sheet.header,
      warnings: sheet.warnings,
      unmappedColumns: resolved.unmappedColumns,
      absentColumns: resolved.absentColumns,
      humanSuppliedColumns: resolved.humanSuppliedColumns,
      stats: normalized.stats,
      issues: batchIssues.issues,
      issueSummary: batchIssues.summary,
      issueDistribution: formatIssueSummary(batchIssues.summary),
      rows: normalized.rows.map((row) => ({
        rowNumber: row.rowNumber,
        registryId: row.registryId,
        duplicate: row.duplicate,
        blocked: row.blocked,
        humanSuppliedColumns: row.humanSuppliedColumns,
        cells: row.cells,
        issues: row.issues.map((issue) => issue.code),
      })),
    };

    const payload = okResponse('sheet', result, null);
    const text = `${JSON.stringify(payload, null, 2)}\n`;

    const checklistFlag = flags['checklist'];
    let checklist: { path: string; rows: number } | null = null;
    if (typeof checklistFlag === 'string' && checklistFlag.length > 0) {
      const written = writeManualChecklist(batchIssues.issues, checklistFlag);
      checklist = { path: written.outputPath, rows: written.rows };
    }

    const out = flags['out'];
    if (typeof out === 'string' && out.length > 0) {
      writeFileSync(out, text, 'utf8');
      process.stdout.write(
        `${JSON.stringify(
          okResponse(
            'sheet',
            {
              outputPath: out,
              stats: normalized.stats,
              issueCount: batchIssues.issues.length,
              issueSummary: batchIssues.summary,
              checklist,
            },
            null,
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
    const code = error instanceof ColumnMappingError ? 'invalid_request' : 'unknown';
    process.stderr.write(
      `${JSON.stringify(
        errorResponse('sheet', {
          code,
          message,
          hint:
            error instanceof ColumnMappingError
              ? '请按提示核对列映射配置或表头后重跑'
              : '请确认 --in 指向的登记表存在且可读',
        }),
        null,
        2,
      )}\n`,
    );
    return 1;
  }
}

/**
 * lookup 子命令：读登记表 → 按登记主索引检索院内权威记录 → 逐行标注绑定判定。
 *
 * 这是主干的只读第一段：登记员先看「哪几行命中、哪几行歧义、哪几行院内没有」，
 * 确认无误后再进比对与推送。命中 >1 判歧义、=0 判零命中，两者都不产出差异值。
 */
async function runLookup(
  flags: Record<string, string | boolean>,
  source: NodeJS.ProcessEnv,
): Promise<number> {
  const input = flags['in'];
  if (typeof input !== 'string' || input.length === 0) {
    process.stderr.write(
      `${JSON.stringify(
        errorResponse('lookup', {
          code: 'invalid_request',
          message: '缺少参数 --in（登记表 CSV 路径）',
          hint: '用法：node dist/cli.js lookup --in <登记表.csv> [--mapping <列映射.json>] [--out <结果.json>]',
        }),
        null,
        2,
      )}\n`,
    );
    return 2;
  }

  const mappingFlag = flags['mapping'];
  const mappingPath =
    typeof mappingFlag === 'string' && mappingFlag.length > 0 ? mappingFlag : defaultMappingPath();

  try {
    const mapping = loadColumnMapping(mappingPath);
    const sheet = readSheetFile(input);
    resolveColumnMapping(mapping, sheet.header);
    const normalized = buildRows({ header: sheet.header, rows: sheet.rows, mapping });

    const cdr = loadCdrEnv(source);
    const maxConcurrency = loadFhirMaxConcurrency(source);
    const client = new FhirClient({
      baseUrl: cdr.baseUrl,
      apiToken: cdr.apiToken,
      identifierSystem: cdr.identifierSystem,
    });

    const searchable = normalized.rows
      .filter((row) => !row.blocked && row.registryId !== null)
      .map((row) => ({ rowNumber: row.rowNumber, registryId: row.registryId as string }));
    const skipped = normalized.rows
      .filter((row) => row.blocked)
      .map((row) => ({
        rowNumber: row.rowNumber,
        registryId: row.registryId,
        reason: row.issues.map((issue) => issue.reason).join('；') || '本行被读表层挡下',
      }));

    const result = await lookupRows(searchable, client, { maxConcurrency });

    // 本批运行日志：每行一条 JSONL（阶段 / 行标识 / 错误码 / 耗时 / 尝试次数）
    const runLogPath = resolveRunLogPath(flags, source);
    const events = buildLookupEvents(result.rows);
    const logger = new RunLogger({ path: runLogPath, stage: 'lookup' });
    for (const event of events) {
      logger.push(event);
    }
    let runLogWritten = 0;
    let runLogError: string | null = null;
    try {
      runLogWritten = logger.flush();
    } catch (error) {
      // 写日志失败不吞：本批检索结果照样给，但明确告诉用户日志没写成
      runLogError = error instanceof Error ? error.message : String(error);
    }
    const errorDistribution = summarizeErrors(events);

    // 行级问题统一归集：读表侧（脏行）+ 检索侧（缺关键字段 / 非 JSON / 歧义 / 零命中）
    const batchIssues = collectBatchIssues({
      sheetRows: normalized.rows,
      lookupRows: result.rows,
    });

    const checklistFlag = flags['checklist'];
    let checklist: { path: string; rows: number } | null = null;
    if (typeof checklistFlag === 'string' && checklistFlag.length > 0) {
      const written = writeManualChecklist(batchIssues.issues, checklistFlag);
      checklist = { path: written.outputPath, rows: written.rows };
    }

    const payload = parseLookupResult({
      source: input,
      generatedAt: new Date().toISOString(),
      stats: result.stats,
      rows: result.rows.map((row) => ({
        rowNumber: row.rowNumber,
        registryId: row.registryId,
        binding: row.binding,
        status: row.status,
        patientId: row.patientId,
        patient:
          row.patient === null
            ? null
            : { birthDate: row.patient.birthDate, sex: row.patient.sex },
        conditions: row.conditions.map((condition) => ({
          code: condition.code,
          onsetDateTime: condition.onsetDateTime,
          stage: condition.stage,
        })),
        encounters: row.encounters.map((encounter) => ({
          periodStart: encounter.periodStart,
          periodEnd: encounter.periodEnd,
          class: encounter.class,
          type: encounter.type,
        })),
        unavailableFields: row.unavailableFields,
        issues: row.issues,
        requestUrls: row.requestUrls,
        reused: row.reused,
        errorCode: row.errorCode,
        durationMs: row.durationMs,
        attempts: row.attempts,
      })),
      searchParams: result.searchParams,
      searchParamEntries: result.searchParamEntries,
      dedup: result.dedup,
      concurrency: result.concurrency,
      skipped,
      errorDistribution,
      issueSummary: batchIssues.summary,
      checklist,
      runLog: { path: runLogPath, written: runLogWritten, error: runLogError },
    });

    const text = `${JSON.stringify(okResponse('lookup', payload, null), null, 2)}\n`;

    const out = flags['out'];
    if (typeof out === 'string' && out.length > 0) {
      writeFileSync(out, text, 'utf8');
      process.stdout.write(
        `${JSON.stringify(
          okResponse(
            'lookup',
            {
              outputPath: out,
              stats: payload.stats,
              skipped: payload.skipped.length,
              issueSummary: payload.issueSummary,
              checklist,
            },
            null,
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
            : '请确认 --in 指向的登记表存在且可读，且 CDR_BASE_URL / CDR_API_TOKEN / CDR_IDENTIFIER_SYSTEM 已配置';
    process.stderr.write(
      `${JSON.stringify(errorResponse('lookup', { code, message, hint }), null, 2)}\n`,
    );
    return 1;
  }
}

/**
 * caliber 子命令：打印当前生效的字段口径清单与派生字段结果。
 *
 * 这是差异引擎的独立可验收入口：一条命令就能看到「哪些列参与比对、哪些列口径未声明、
 * 哪些列只读不覆盖、派生字段按哪条口径算出来的值是什么」。全程离线 —— 不依赖网络，
 * 也不依赖院内凭据，所以信息科配好口径表就能先自查一遍。
 */
async function runCaliber(flags: Record<string, string | boolean>): Promise<number> {
  const specFlag = flags['spec'];
  const specPath =
    typeof specFlag === 'string' && specFlag.length > 0 ? specFlag : defaultFieldSpecPath();

  try {
    const spec = loadFieldSpec(specPath);
    const calibers = effectiveCalibers(spec);

    // 一、与本张表对照：哪些列参与比对、哪些列口径未声明、哪些列只读不覆盖
    let table: {
      source: string;
      mappingPath: string;
      encoding: string;
      header: string[];
      columns: ReturnType<typeof resolveFieldSpec>['columns'];
      unspecifiedColumns: string[];
      humanSuppliedColumns: string[];
      absentFields: string[];
    } | null = null;

    const input = flags['in'];
    if (typeof input === 'string' && input.length > 0) {
      const mappingFlag = flags['mapping'];
      const mappingPath =
        typeof mappingFlag === 'string' && mappingFlag.length > 0
          ? mappingFlag
          : defaultMappingPath();
      const mapping = loadColumnMapping(mappingPath);
      const sheet = readSheetFile(input);
      const resolved = resolveFieldSpec(spec, sheet.header);
      table = {
        source: input,
        mappingPath,
        encoding: sheet.encoding,
        header: sheet.header,
        columns: resolved.columns,
        unspecifiedColumns: resolved.unspecifiedColumns,
        humanSuppliedColumns: resolved.humanSuppliedColumns,
        absentFields: resolved.absentFields,
      };
    }

    // 二、派生字段结果：按口径表声明的规则，从离线回放集里算一遍
    const replayFlag = flags['replay'];
    const replayExplicit = typeof replayFlag === 'string' && replayFlag.length > 0;
    const replayPath = replayExplicit
      ? (replayFlag as string)
      : existsSync(defaultReplayDir())
        ? defaultReplayDir()
        : null;

    let derived: {
      source: string;
      available: boolean;
      patients: number;
      sampled: number;
      limit: number | null;
      statusCounts: Record<string, number>;
      rows: ReturnType<typeof buildReplayDerivedRows>;
      note: string | null;
    } | null = null;

    if (replayPath !== null) {
      const dataset = await readReplaySet(replayPath);
      if (dataset === null) {
        if (replayExplicit) {
          throw new FieldSpecError(`回放集不可用：${replayPath}`, [
            '该目录下应有 Patient.json / Condition.json / Encounter.json（由 fetch-synthea 脚本产出）',
          ]);
        }
        derived = {
          source: replayPath,
          available: false,
          patients: 0,
          sampled: 0,
          limit: null,
          statusCounts: {},
          rows: [],
          note: '本机没有离线回放集，跳过派生字段结果（口径清单不受影响）',
        };
      } else {
        const patients = dataset.patients
          .map((resource) => parsePatient(resource).patient)
          .filter((patient): patient is NonNullable<typeof patient> => patient !== null)
          .map((patient) => {
            const encounters = dataset.encounters
              .map((resource) => {
                const patientId =
                  patientIdOfReference(resource.subject) ??
                  patientIdOfReference(resource.patient);
                if (patientId !== patient.id) return null;
                return parseEncounter(resource).encounter;
              })
              .filter((encounter): encounter is NonNullable<typeof encounter> => encounter !== null);
            const identifier =
              patient.identifiers.find((item) => item.value !== null)?.value ?? null;
            return { patientId: patient.id, identifier, encounters };
          });

        const limitFlag = flags['limit'];
        const parsedLimit =
          typeof limitFlag === 'string' && limitFlag.length > 0 ? Number(limitFlag) : 5;
        const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : patients.length;

        const rows = buildReplayDerivedRows({ spec, patients, limit });
        const statusCounts: Record<string, number> = {};
        for (const row of rows) {
          for (const outcome of Object.values(row.derived)) {
            statusCounts[outcome.status] = (statusCounts[outcome.status] ?? 0) + 1;
          }
        }

        derived = {
          source: replayPath,
          available: true,
          patients: patients.length,
          sampled: rows.length,
          limit,
          statusCounts,
          rows,
          note: null,
        };
      }
    }

    const payload = okResponse(
      'caliber',
      {
        specPath,
        version: spec.version,
        basis: spec.basis,
        note: spec.note,
        calibers,
        counts: {
          fields: calibers.length,
          participatesInDiff: calibers.filter((item) => item.participatesInDiff).length,
          derived: calibers.filter((item) => item.derived).length,
          controlledCode: calibers.filter((item) => item.controlledCode).length,
          humanSupplied: calibers.filter((item) => item.humanSupplied).length,
          unspecifiedColumns: table?.unspecifiedColumns.length ?? 0,
        },
        table,
        derived,
      },
      null,
    );

    const text = `${JSON.stringify(payload, null, 2)}\n`;
    const out = flags['out'];
    if (typeof out === 'string' && out.length > 0) {
      writeFileSync(out, text, 'utf8');
      process.stdout.write(
        `${JSON.stringify(
          okResponse('caliber', { outputPath: out, counts: payload.result as { counts: unknown } }, null),
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
      error instanceof FieldSpecError || error instanceof ColumnMappingError
        ? 'invalid_request'
        : 'unknown';
    const hint =
      error instanceof FieldSpecError
        ? '请按提示核对字段口径表 config/field-spec.json 后重跑'
        : error instanceof ColumnMappingError
          ? '请按提示核对列映射配置或表头后重跑'
          : '请确认 --spec 指向的口径表存在且可读';
    process.stderr.write(
      `${JSON.stringify(errorResponse('caliber', { code, message, hint }), null, 2)}\n`,
    );
    return 1;
  }
}

/**
 * CLI 入口。拆成可导出的函数，测试层可直接调用并捕获输出。
 */
export async function runCli(
  argv: string[],
  source: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const { command, flags } = parseArgs(argv);

  if (flags.help === true || flags.h === true || command === '') {
    process.stdout.write(USAGE);
    return command === '' ? 1 : 0;
  }

  switch (command) {
    case 'sheet':
      return runSheet(flags);
    case 'lookup':
      return runLookup(flags, source);
    case 'caliber':
      return await runCaliber(flags);
    case 'doctor':
      return runDoctor(source);
    case 'align':
      return await runAlign(flags, source);
    case 'push':
      return await runPush(flags, source);
    case 'summary':
      return await runSummary(flags, source);
    case 'replay':
      return await runReplay(flags, source);
    default:
      process.stderr.write(
        `${JSON.stringify(
          errorResponse('doctor', {
            code: 'invalid_request',
            message: `未知子命令「${command}」`,
            hint: '可用子命令：sheet、lookup、caliber、doctor、align、push、summary、replay',
          }),
          null,
          2,
        )}\n`,
      );
      return 2;
  }
}

/** 直接运行时才执行（被测试 import 时不自动跑）。 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runCli(process.argv.slice(2), process.env)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `${JSON.stringify(
          errorResponse('doctor', { code: 'unknown', message, hint: null }),
          null,
          2,
        )}\n`,
      );
      process.exitCode = 1;
    });
}
