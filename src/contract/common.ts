/**
 * 三入口（Excel 加载宏 / WPS JSA 宏 / CSV 直跑）共用的 JSON 契约 · 公共原语。
 *
 * 契约是宏与引擎之间唯一的约定：宏只负责「取行 → 调 CLI → 回读结果写回」，
 * 所有业务语义（比对、确认闸门、推送、幂等）一律留在引擎内，宏不得自行推导。
 *
 * 术语对齐（表内中文口径，勿改）：
 * - 登记主索引 = 登记表首列「登记号」，对应院内 Patient.identifier 的 token 值
 * - 差异列     = Operation[] 渲染出的可读文案
 * - 确认列     = 表内人工确认点，白名单取值见 CONFIRM_VALUES
 */
import { z } from 'zod';

/** 单元格原始值：表格里读到的都是字符串，数值/布尔由规范化层负责转换。 */
export const CellValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type CellValue = z.infer<typeof CellValueSchema>;

/** 参与比对的字段值：显式 null 与「缺失」是两回事，故 null 单独成值。 */
export const FieldValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type FieldValue = z.infer<typeof FieldValueSchema>;

/** 最小差异操作：只描述真正变化的字段，不整行覆盖。 */
export const OPERATION_OPS = ['add', 'replace', 'remove'] as const;

/**
 * 差异操作里的值：标量，或数组 / 对象（元素级展开在 nested 层做）。
 *
 * 大多数被比对的字段是标量（分期、派生日期），但通用字段也可能是数组或对象，
 * 契约得容得下，否则 align 结果在宏侧校验时会整条报错。
 */
export const OperationValueSchema = z.union([
  FieldValueSchema,
  z.array(FieldValueSchema),
  z.record(z.string(), FieldValueSchema),
]);
export type OperationValue = z.infer<typeof OperationValueSchema>;

export const OperationSchema = z.object({
  /** 操作类型：新增 / 修改 / 删除 */
  op: z.enum(OPERATION_OPS),
  /** 字段路径，登记表列 → 口径字段 → 院内资源路径的三段映射结果 */
  path: z.string().min(1),
  /** 登记侧原值（未归一化的原始值，供写前比对使用） */
  oldValue: OperationValueSchema.optional(),
  /** 院内侧新值 */
  newValue: OperationValueSchema.optional(),
  /** 是否破坏性操作（remove / 覆盖非空旧值 / 清空关键字段 / 整体替换嵌套对象） */
  destructive: z.boolean().optional(),
});
export type Operation = z.infer<typeof OperationSchema>;

/** 行状态机全集：主干态 + 旁支态。模型输出永不推进这些状态。 */
export const ROW_STATUSES = [
  '待对齐',
  '待确认',
  '采纳',
  '不采纳',
  '已推送',
  '推送失败',
  '无需确认',
  '一致',
  '需人工判定',
  '院内已变更，需重查',
  '零命中',
  '命中歧义',
] as const;
export const RowStatusSchema = z.enum(ROW_STATUSES);
export type RowStatus = z.infer<typeof RowStatusSchema>;

/** 确认列取值白名单（表内下拉）。空值按「待确认」处理，未知取值报行级错误。 */
export const CONFIRM_VALUES = ['待确认', '采纳', '不采纳', '无需确认'] as const;
export const ConfirmValueSchema = z.enum(CONFIRM_VALUES);
export type ConfirmValue = z.infer<typeof ConfirmValueSchema>;

/**
 * 实体绑定判定结果：命中 >1 判歧义、=0 判零命中，两者都不产出差异值。
 * 「未完成」= 本轮没取得可绑定的院内值（检索失败、资源缺关键字段），
 * 与「零命中」严格分开 —— 检索失败不等于院内没有这条登记号。
 */
export const BINDING_OUTCOMES = ['命中', '歧义', '零命中', '未完成'] as const;
export const BindingOutcomeSchema = z.enum(BINDING_OUTCOMES);
export type BindingOutcome = z.infer<typeof BindingOutcomeSchema>;

/** 行级问题：脏行不丢、不静默改值，一律进待人工处理清单。 */
export const ROW_ISSUE_CODES = [
  'COLUMN_COUNT_MISMATCH',
  'MISSING_REGISTRY_ID',
  'DUPLICATE_REGISTRY_ID',
  'MISSING_FIELD',
  'DATE_UNPARSEABLE',
  'BAD_PAYLOAD',
  'AMBIGUOUS_MATCH',
  'NO_MATCH',
  'SEARCH_FAILED',
  'PRECONDITION_MISMATCH',
  'UNKNOWN_CONFIRM_VALUE',
  'PUSH_FAILED',
] as const;
export const RowIssueSchema = z.object({
  /** 表内行号（1 基，含表头行的表内实际行号） */
  rowNumber: z.number().int().positive(),
  /** 登记主索引（脱敏占位标识） */
  registryId: z.string().nullable(),
  /** 错误码 */
  code: z.enum(ROW_ISSUE_CODES),
  /** 面向登记员的原因说明 */
  reason: z.string(),
  /** 处置建议 */
  hint: z.string(),
  /** 是否阻断推送 */
  blocking: z.boolean(),
});
export type RowIssue = z.infer<typeof RowIssueSchema>;

/** 行级错误码（与 ROW_ISSUE_CODES 同源，供下游按码聚合时不必再抄一遍）。 */
export type RowIssueCode = (typeof ROW_ISSUE_CODES)[number];

/**
 * 每个行级错误码对应的中文标签。
 *
 * 登记员看的是中文（「登记号重复」「院内命中多条」），不是英文码；
 * 英文码只写进 run-log 与本机排查材料。
 */
export const ROW_ISSUE_LABELS: Record<RowIssueCode, string> = {
  COLUMN_COUNT_MISMATCH: '列数不符',
  MISSING_REGISTRY_ID: '缺登记号',
  DUPLICATE_REGISTRY_ID: '登记号重复',
  MISSING_FIELD: '院内缺关键字段',
  DATE_UNPARSEABLE: '日期不可解析',
  BAD_PAYLOAD: '院内响应不是 JSON',
  AMBIGUOUS_MATCH: '院内命中多条',
  NO_MATCH: '院内无此记录',
  SEARCH_FAILED: '检索未完成',
  PRECONDITION_MISMATCH: '院内已变更，需重查',
  UNKNOWN_CONFIRM_VALUE: '确认列取值不认识',
  PUSH_FAILED: '推送失败',
};

/** 行级问题按错误码的分布条目。 */
export const RowIssueDistributionEntrySchema = z.object({
  /** 错误码 */
  code: z.enum(ROW_ISSUE_CODES),
  /** 中文标签（面向登记员） */
  label: z.string(),
  /** 该码出现次数（同一行同一原因算一条） */
  count: z.number().int().nonnegative(),
  /** 该码涉及的行数 */
  rows: z.number().int().nonnegative(),
  /** 其中阻断推送的条数 */
  blocking: z.number().int().nonnegative(),
});
export type RowIssueDistributionEntry = z.infer<typeof RowIssueDistributionEntrySchema>;

/** 本批行级问题汇总：问题行数 + 按错误码分布（写进运行摘要与表尾回执区）。 */
export const RowIssueSummarySchema = z.object({
  /** 本批涉及问题的行数（按行去重） */
  issueRows: z.number().int().nonnegative(),
  /** 问题条目总数 */
  totalIssues: z.number().int().nonnegative(),
  /** 阻断推送的问题条目数 */
  blockingIssues: z.number().int().nonnegative(),
  /** 按错误码聚合（次数降序，同数按码字典序） */
  byCode: z.array(RowIssueDistributionEntrySchema).default([]),
});
export type RowIssueSummary = z.infer<typeof RowIssueSummarySchema>;

/** 错误码表：检索/推送/模型三层共用；userHint 指名可执行的处置动作。 */
export const ERROR_CODES = [
  'auth_failed',
  'forbidden',
  'not_found',
  'timeout',
  'server_error',
  'rate_limited',
  'bad_payload',
  'missing_field',
  'missing_env',
  'invalid_request',
  'precondition_failed',
  'model_unavailable',
  'unknown',
] as const;
export const ErrorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorPayloadSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  /** 处置提示；缺失环境变量时必须点名具体变量名 */
  hint: z.string().nullable(),
  /** HTTP 状态码（网络类错误才有） */
  httpStatus: z.number().int().nullable().optional(),
  /** 结构化补充信息（如体检报告的逐项结果） */
  details: z.unknown().optional(),
});
export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>;

/** 命令名：CLI 的子命令全集，响应体用同一组名字做判别。 */
export const COMMAND_NAMES = [
  'sheet',
  'lookup',
  'caliber',
  'align',
  'push',
  'summary',
  'replay',
  'doctor',
] as const;
export const CommandNameSchema = z.enum(COMMAND_NAMES);
export type CommandName = z.infer<typeof CommandNameSchema>;
