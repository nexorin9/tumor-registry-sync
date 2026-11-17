/**
 * 三入口共用的 JSON 契约 · 命令请求与响应。
 *
 * 契约形状：
 * - 请求：Excel 宏 / WPS 宏把工作表导出成 `align` 请求 JSON；CLI 从 `--in` 读它
 * - 响应：引擎回写 `result.json`，宏按它把新列、状态底色与表尾两个区块写回原表
 *
 * 统一响应包络：所有子命令共用 `{ok, command, batchKey, result, error}`，
 * 出错时 `ok=false` 且 `error` 指名可执行的处置动作（缺哪个环境变量就说哪个）。
 */
import { z } from 'zod';

import {
  BindingOutcomeSchema,
  CellValueSchema,
  CommandNameSchema,
  ConfirmValueSchema,
  ErrorCodeSchema,
  ErrorPayloadSchema,
  FieldValueSchema,
  OperationSchema,
  RowIssueSchema,
  RowIssueSummarySchema,
  RowStatusSchema,
} from './common.js';

/** 本批计数：命中 / 差异 / 缺行 / 问题 / 已推送 / 待确认 / 失败 / 待重试，各计各的。 */
export const SummaryCountsSchema = z.object({
  /** 本批处理行数 */
  total: z.number().int().nonnegative(),
  /** 院内唯一命中行数 */
  matched: z.number().int().nonnegative(),
  /** 命中歧义行数（不产出差异值） */
  ambiguous: z.number().int().nonnegative(),
  /** 零命中行数（不产出差异值） */
  noMatch: z.number().int().nonnegative(),
  /** 存在差异的行数 */
  diffRows: z.number().int().nonnegative(),
  /** 待确认行数 */
  pendingConfirm: z.number().int().nonnegative(),
  /** 登记员已采纳行数 */
  adopted: z.number().int().nonnegative(),
  /** 已推送行数 */
  pushed: z.number().int().nonnegative(),
  /** 推送失败行数 */
  failed: z.number().int().nonnegative(),
  /** 进入重试队列待重试的行数 */
  pendingRetry: z.number().int().nonnegative(),
  /** 院内命中但本表缺行的行数 */
  missingRows: z.number().int().nonnegative(),
  /** 行级问题行数 */
  issueRows: z.number().int().nonnegative(),
  /** 缺行检查是否未完成（检索失败 ≠ 零缺行，两者分开计数） */
  missingCheckIncomplete: z.boolean(),
});
export type SummaryCounts = z.infer<typeof SummaryCountsSchema>;

/** 逐行推送回执：状态 + 原因 + 幂等键 + 推送时刻 + 尝试次数。 */
export const PushReceiptSchema = z.object({
  rowNumber: z.number().int().positive(),
  registryId: z.string().nullable(),
  status: z.enum(['已推送', '推送失败', '待重试']),
  code: ErrorCodeSchema.nullable(),
  reason: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  pushedAt: z.string().nullable(),
});
export type PushReceipt = z.infer<typeof PushReceiptSchema>;

/** 表尾推送回执区：批次键 + 检索参数串 + 推送时刻 + 计数 + 逐行明细。 */
export const ReceiptBlockSchema = z.object({
  batchKey: z.string(),
  searchParams: z.string(),
  pushedAt: z.string().nullable(),
  counts: SummaryCountsSchema,
  details: z.array(PushReceiptSchema),
});
export type ReceiptBlock = z.infer<typeof ReceiptBlockSchema>;

/** 表尾缺行区：院内命中但本表无此登记号；确认列初始「待确认」，不自动入表。 */
export const MissingRowSchema = z.object({
  registryId: z.string(),
  source: z.literal('院内检索命中，本表无此登记号'),
  status: RowStatusSchema,
  confirmValue: ConfirmValueSchema,
});
export type MissingRow = z.infer<typeof MissingRowSchema>;

/* ────────────────────────── lookup ───────────────────────── */

/**
 * 本批错误分布：按错误码聚合。
 *
 * 由可观测层产出（运行日志里带错误码的事件），契约只负责校验与回传给三入口 ——
 * 宏侧据此在表尾回执区显示「这批错在哪」。
 */
export const ErrorDistributionEntrySchema = z.object({
  /** 错误码 */
  code: ErrorCodeSchema,
  /** 出现次数 */
  count: z.number().int().nonnegative(),
  /** 是否可重试 */
  retryable: z.boolean(),
});
export type ErrorDistributionEntry = z.infer<typeof ErrorDistributionEntrySchema>;

export const ErrorDistributionSchema = z.object({
  /** 本批错误事件总数 */
  total: z.number().int().nonnegative(),
  /** 其中可重试的条数 */
  retryable: z.number().int().nonnegative(),
  /** 按错误码聚合（次数降序） */
  entries: z.array(ErrorDistributionEntrySchema).default([]),
});
export type ErrorDistribution = z.infer<typeof ErrorDistributionSchema>;

/** lookup 的逐行结果：检索到没有、绑上没有、拿回哪些院内值。 */
export const LookupRowSchema = z.object({
  /** 表内行号（1 基） */
  rowNumber: z.number().int().positive(),
  /** 登记主索引（脱敏占位标识） */
  registryId: z.string(),
  /** 实体绑定判定：命中 / 歧义 / 零命中 / 未完成 */
  binding: BindingOutcomeSchema,
  /** 当前行状态 */
  status: RowStatusSchema,
  /** 院内患者 id */
  patientId: z.string().nullable(),
  /** 院内患者视图 */
  patient: z
    .object({
      birthDate: z.string().nullable(),
      sex: z.string().nullable(),
    })
    .nullable(),
  /** 院内诊断（含分期） */
  conditions: z.array(
    z.object({
      code: z.string().nullable(),
      onsetDateTime: z.string().nullable(),
      stage: z.string().nullable(),
    }),
  ),
  /** 院内就诊 */
  encounters: z.array(
    z.object({
      periodStart: z.string().nullable(),
      periodEnd: z.string().nullable(),
      class: z.string().nullable(),
      type: z.string().nullable(),
    }),
  ),
  /** 取不到、不参与比对的字段 */
  unavailableFields: z.array(z.string()),
  /** 行级问题 */
  issues: z.array(RowIssueSchema),
  /** 本行实际发出的检索地址（原样保留，供复现） */
  requestUrls: z.array(z.string()),
  /** 本行是否复用了同登记号另一行的检索结果（同号只查一次） */
  reused: z.boolean().default(false),
  /** 本行检索失败时的底层错误码（成功/歧义/零命中为 null） */
  errorCode: ErrorCodeSchema.nullable().default(null),
  /** 本行检索耗时（毫秒） */
  durationMs: z.number().int().nonnegative().default(0),
  /** 本行为取得院内值发出的检索段数（患者 → 诊断 → 就诊） */
  attempts: z.number().int().nonnegative().default(0),
});
export type LookupRow = z.infer<typeof LookupRowSchema>;

/** lookup 的本批计数：命中 / 歧义 / 零命中 / 未完成，各计各的。 */
export const LookupStatsSchema = z.object({
  total: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  ambiguous: z.number().int().nonnegative(),
  noMatch: z.number().int().nonnegative(),
  incomplete: z.number().int().nonnegative(),
});
export type LookupStats = z.infer<typeof LookupStatsSchema>;

/** 一次检索步骤：资源类型 + 实际参数 + 页数（原样，供复现）。 */
export const LookupSearchStepSchema = z.object({
  resourceType: z.enum(['Patient', 'Condition', 'Encounter']),
  params: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  pageCount: z.number().int().nonnegative(),
});
export type LookupSearchStep = z.infer<typeof LookupSearchStepSchema>;

/** 本批检索参数串的一个条目：一个唯一登记号的全部检索步骤。 */
export const BatchSearchParamEntrySchema = z.object({
  registryId: z.string(),
  steps: z.array(LookupSearchStepSchema),
  pagePaths: z.array(z.string()),
});
export type BatchSearchParamEntry = z.infer<typeof BatchSearchParamEntrySchema>;

/** lookup 结果：逐行绑定判定与院内值。 */
export const LookupResultSchema = z.object({
  /** 输入登记表路径 */
  source: z.string(),
  /** 生成时刻 */
  generatedAt: z.string(),
  /** 本批计数 */
  stats: LookupStatsSchema,
  /** 逐行结果 */
  rows: z.array(LookupRowSchema),
  /** 本批检索参数串（原样可复现；表尾回执区与批次键都用它） */
  searchParams: z.string(),
  /** 结构化的检索参数串条目（按登记号排序） */
  searchParamEntries: z.array(BatchSearchParamEntrySchema),
  /** 去重统计：同号只查一次，其余行复用结果 */
  dedup: z.object({
    uniqueRegistryIds: z.number().int().nonnegative(),
    reusedRows: z.number().int().nonnegative(),
  }),
  /** 并发统计：上限与本批实际达到的峰值 */
  concurrency: z.object({
    limit: z.number().int().positive(),
    peakInFlight: z.number().int().nonnegative(),
  }),
  /** 未送检索的行（被读表层挡下：缺登记号 / 重复登记号 / 列数不符） */
  skipped: z
    .array(
      z.object({
        rowNumber: z.number().int().positive(),
        registryId: z.string().nullable(),
        reason: z.string(),
      }),
    )
    .default([]),
  /** 本批错误分布（按错误码聚合；由运行日志汇总而来） */
  errorDistribution: ErrorDistributionSchema.default({
    total: 0,
    retryable: 0,
    entries: [],
  }),
  /** 本批行级问题汇总（读表侧 + 检索侧归集）：问题行数与按错误码分布 */
  issueSummary: RowIssueSummarySchema.default({
    issueRows: 0,
    totalIssues: 0,
    blockingIssues: 0,
    byCode: [],
  }),
  /** 待人工处理清单的落盘位置（登记员直接打开处理；未导出时为 null） */
  checklist: z
    .object({
      /** 清单文件路径 */
      path: z.string(),
      /** 清单明细行数 */
      rows: z.number().int().nonnegative(),
    })
    .nullable()
    .default(null),
  /** 本批结构化运行日志（JSONL）的落盘位置与写入条数 */
  runLog: z
    .object({
      /** 日志文件路径 */
      path: z.string(),
      /** 本批写入条数 */
      written: z.number().int().nonnegative(),
      /** 写日志失败时的说明（不静默吞掉，但不影响本批检索结果） */
      error: z.string().nullable().default(null),
    })
    .default({ path: '', written: 0, error: null }),
});
export type LookupResult = z.infer<typeof LookupResultSchema>;

/* ────────────────────────── align ────────────────────────── */

/** align 请求：宏导出的工作表内容或 CSV 直跑入口的等价物。 */
export const AlignRequestSchema = z.object({
  /** 表头行，列顺序即原表列顺序（原列不动，新列追加在末尾） */
  header: z.array(z.string()).min(1),
  /** 数据行，按表头列序对齐；脏行（列数不符）保留并由读取层给行级错误码 */
  rows: z.array(z.array(CellValueSchema)),
  /** 入口来源：三入口共用同一契约，仅用于回执溯源 */
  source: z.enum(['excel-macro', 'wps-macro', 'csv']).default('csv'),
  /** 列映射配置路径（未声明口径的列不参与比对） */
  columnMappingPath: z.string().optional(),
  /** 字段口径表路径 */
  fieldSpecPath: z.string().optional(),
  /** 确认列列名 */
  confirmColumn: z.string().default('确认'),
  /** 只检索与比对、不推送 */
  dryRun: z.boolean().default(false),
});
export type AlignRequest = z.infer<typeof AlignRequestSchema>;

/** align 的逐行结果：表内五列（院内值 / 差异 / 建议值 / 确认 / AI 说明）的数据来源。 */
export const AlignRowResultSchema = z.object({
  /** 表内行号（1 基） */
  rowNumber: z.number().int().positive(),
  /** 登记主索引（脱敏占位标识） */
  registryId: z.string().nullable(),
  /** 当前行状态 */
  status: RowStatusSchema,
  /** 实体绑定判定结果 */
  binding: BindingOutcomeSchema,
  /** 院内权威值（按口径字段名索引） */
  hospitalValues: z.record(z.string(), FieldValueSchema),
  /** 最小差异操作集合 */
  operations: z.array(OperationSchema),
  /** 「差异」列文案 */
  diffText: z.string(),
  /** 「建议值」列文案 */
  suggestedText: z.string(),
  /** 「确认」列当前取值 */
  confirmValue: ConfirmValueSchema,
  /** 「AI 说明」列文案（模型不可达时填降级模板句） */
  aiNote: z.string(),
  /** 人工补充列名（只读不覆盖） */
  humanSuppliedColumns: z.array(z.string()),
});
export type AlignRowResult = z.infer<typeof AlignRowResultSchema>;

/** align 结果：写回原表新列 + 表尾两个区块 + 摘要 + run-log 落点。 */
export const AlignResultSchema = z.object({
  batchKey: z.string(),
  generatedAt: z.string(),
  summary: SummaryCountsSchema,
  rows: z.array(AlignRowResultSchema),
  issues: z.array(RowIssueSchema),
  receipt: ReceiptBlockSchema,
  missingRows: z.array(MissingRowSchema),
  runLogPath: z.string().nullable(),
});
export type AlignResult = z.infer<typeof AlignResultSchema>;

/* ────────────────────────── push ─────────────────────────── */

/** push 请求：按确认闸门过滤后逐行推送专病库登记接口。 */
export const PushRequestSchema = z.object({
  /** align 结果文件路径（result.json） */
  alignResultPath: z.string(),
  /** 推送体形态：字段级增量 / 整条但只带变化字段 */
  payloadForm: z.enum(['field-level', 'whole-entry']).optional(),
  /** 只构造请求体不外发（不产生任何业务状态变更） */
  dryRun: z.boolean().default(false),
  /** 重试队列落盘路径（断点续跑用） */
  retryQueuePath: z.string().optional(),
});
export type PushRequest = z.infer<typeof PushRequestSchema>;

/** push 结果：逐行回执 + 批次计数。 */
export const PushResultSchema = z.object({
  batchKey: z.string(),
  pushedAt: z.string(),
  summary: SummaryCountsSchema,
  receipts: z.array(PushReceiptSchema),
  /** 未进推送体的行（未确认 / 需人工判定 / 歧义 / 零命中），写明原因 */
  skipped: z.array(
    z.object({
      rowNumber: z.number().int().positive(),
      registryId: z.string().nullable(),
      status: RowStatusSchema,
      reason: z.string(),
    }),
  ),
  runLogPath: z.string().nullable(),
});
export type PushResult = z.infer<typeof PushResultSchema>;

/* ───────────────────────── summary ──────────────────────── */

/** summary 请求：读对齐结果与 run-log，产出本周期摘要。 */
export const SummaryRequestSchema = z.object({
  alignResultPath: z.string().optional(),
  runLogPath: z.string().optional(),
});
export type SummaryRequest = z.infer<typeof SummaryRequestSchema>;

/** summary 结果：登记员下次打开表即知「同步过没有、哪些行还悬着」。 */
export const SummaryResultSchema = z.object({
  batchKey: z.string().nullable(),
  generatedAt: z.string(),
  summary: SummaryCountsSchema,
  /** 上次同步时间（本地时区可读化），同时保留原始时间戳 */
  lastSyncedAt: z.string().nullable(),
  lastSyncedAtRaw: z.string().nullable(),
  searchParams: z.string().nullable(),
  /** 摘要计数与 run-log 统计的交叉校验结果，不一致时报错不静默取其一 */
  crossCheckOk: z.boolean(),
  crossCheckNote: z.string().nullable(),
});
export type SummaryResult = z.infer<typeof SummaryResultSchema>;

/* ───────────────────── 统一响应包络 ──────────────────────── */

/** 成功响应：结果体随命令不同，由各命令的结果 schema 单独校验。 */
export const CommandOkSchema = z.object({
  ok: z.literal(true),
  command: CommandNameSchema,
  batchKey: z.string().nullable(),
  result: z.unknown(),
});

/** 失败响应：error.hint 必须指名可执行的下一步（缺哪个环境变量就说哪个）。 */
export const CommandErrorSchema = z.object({
  ok: z.literal(false),
  command: CommandNameSchema,
  batchKey: z.string().nullable(),
  error: ErrorPayloadSchema,
});

export const CommandResponseSchema = z.union([CommandOkSchema, CommandErrorSchema]);
export type CommandResponse = z.infer<typeof CommandResponseSchema>;
