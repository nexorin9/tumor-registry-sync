/**
 * 受控列映射配置：登记表列 ↔ 口径字段 ↔ 院内资源路径 的第一段（列 ↔ 字段）。
 *
 * 为什么要有这张表：登记员手里的表列名五花八门（「分期」「临床分期」「TNM 分期」），
 * 而比对必须知道「这一列到底对应哪个口径字段、参不参与比对、是不是人工补充列」。
 * **未声明的列一律不参与比对** —— 不猜、不静默跳过，而是显式标「口径未声明」。
 *
 * 三条硬规矩：
 * - 人工补充列（如随访电话、生活方式备注）只读不覆盖：标记 human_supplied=true，
 *   写回层必须跳过，本模块只负责把标记传下去。
 * - 必填列缺失时显式报错并**点名缺哪一列**，不静默开跑。
 * - 口径说明（description）必填：没有说明的列不允许进这张表。
 */
import { readFileSync } from 'node:fs';

import { z } from 'zod';

/** 列映射条目：目标字段名 + 源列名 + 口径说明 + 是否人工补充列。 */
export const ColumnMappingEntrySchema = z.object({
  /** 目标字段名（口径字段），后续按它与院内资源路径对齐 */
  field: z.string().min(1),
  /** 源列名：登记表首行表头里的写法 */
  sourceColumn: z.string().min(1),
  /** 口径说明：这列到底是什么、拿来做什么 */
  description: z.string().min(1),
  /** 是否人工补充列（登记员自己填，插件只读不覆盖） */
  humanSupplied: z.boolean().default(false),
  /** 是否必填列：登记表缺这一列时报错 */
  required: z.boolean().default(false),
  /** 是否受控编码字段（分期、治疗方案等需归并到院内受控编码的字段） */
  controlledCode: z.boolean().default(false),
});
export type ColumnMappingEntry = z.infer<typeof ColumnMappingEntrySchema>;

/** 列映射配置整体。 */
export const ColumnMappingSchema = z.object({
  /** 配置版本号，写进 run-log 供核对当时用的是哪版口径 */
  version: z.string().min(1),
  /** 登记主索引所在列（登记表首列，通常叫「登记号」） */
  registryIdColumn: z.string().min(1),
  /** 逐列声明 */
  columns: z.array(ColumnMappingEntrySchema).min(1),
});
export type ColumnMapping = z.infer<typeof ColumnMappingSchema>;

/** 列映射相关错误：message 里点名具体列，便于登记员照着改表。 */
export class ColumnMappingError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(issues.length > 0 ? `${message}：${issues.join('；')}` : message);
    this.name = 'ColumnMappingError';
    this.issues = issues;
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path.length > 0 ? `${path} ${issue.message}` : issue.message;
  });
}

/** 校验列映射配置；不合法时点名具体字段路径。 */
export function parseColumnMapping(data: unknown): ColumnMapping {
  const parsed = ColumnMappingSchema.safeParse(data);
  if (!parsed.success) {
    throw new ColumnMappingError('列映射配置不符合约定', formatIssues(parsed.error));
  }

  const mapping = parsed.data;

  const seen = new Map<string, string>();
  const duplicates: string[] = [];
  for (const entry of mapping.columns) {
    const previous = seen.get(entry.sourceColumn);
    if (previous !== undefined) {
      duplicates.push(`源列「${entry.sourceColumn}」被声明了两次（${previous} / ${entry.field}）`);
    } else {
      seen.set(entry.sourceColumn, entry.field);
    }
  }
  if (duplicates.length > 0) {
    throw new ColumnMappingError('列映射配置存在重复声明', duplicates);
  }

  return mapping;
}

/** 从 JSON 文件加载列映射配置。 */
export function loadColumnMapping(path: string): ColumnMapping {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ColumnMappingError(`读取列映射配置失败：${path}`, [message]);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ColumnMappingError(`列映射配置不是合法 JSON：${path}`, [message]);
  }

  return parseColumnMapping(data);
}

/** 解析结果：把配置与本张表的表头对起来的结果。 */
export interface ResolvedColumnMapping {
  mapping: ColumnMapping;
  /** 本表表头（已规范化） */
  header: string[];
  /** 源列名 → 口径字段名 */
  fieldByColumn: Map<string, string>;
  /** 口径字段名 → 源列名 */
  columnByField: Map<string, string>;
  /** 人工补充列的源列名（写回层必须跳过） */
  humanSuppliedColumns: string[];
  /** 配置里声明了、但本张表没有的列（该字段本轮不参与比对） */
  absentColumns: string[];
  /** 配置里没声明的表列（本轮不参与比对，标「口径未声明」） */
  unmappedColumns: string[];
}

/**
 * 把列映射配置与本张表的表头对起来。
 *
 * 必填列（登记表登记号列 + 声明了 required 的列）缺失时抛错并点名缺哪一列；
 * 其余列缺失只记入 absentColumns，不阻断本轮运行。
 */
export function resolveColumnMapping(
  mapping: ColumnMapping,
  header: string[],
): ResolvedColumnMapping {
  const normalizedHeader = header.map((name) => name.trim());
  const headerSet = new Set(normalizedHeader);

  const missing: string[] = [];
  if (!headerSet.has(mapping.registryIdColumn)) {
    missing.push(mapping.registryIdColumn);
  }
  for (const entry of mapping.columns) {
    if (entry.required && !headerSet.has(entry.sourceColumn)) {
      missing.push(entry.sourceColumn);
    }
  }
  if (missing.length > 0) {
    throw new ColumnMappingError(
      `登记表缺少必填列：${missing.join('、')}`,
      missing.map((column) => `缺少「${column}」列，请核对表头后重跑`),
    );
  }

  const fieldByColumn = new Map<string, string>();
  const columnByField = new Map<string, string>();
  const humanSuppliedColumns: string[] = [];
  const absentColumns: string[] = [];

  for (const entry of mapping.columns) {
    if (!headerSet.has(entry.sourceColumn)) {
      absentColumns.push(entry.sourceColumn);
      continue;
    }
    fieldByColumn.set(entry.sourceColumn, entry.field);
    columnByField.set(entry.field, entry.sourceColumn);
    if (entry.humanSupplied) {
      humanSuppliedColumns.push(entry.sourceColumn);
    }
  }

  const mapped = new Set<string>([
    mapping.registryIdColumn,
    ...mapping.columns.map((entry) => entry.sourceColumn),
  ]);
  const unmappedColumns = normalizedHeader.filter((name) => !mapped.has(name));

  return {
    mapping,
    header: normalizedHeader,
    fieldByColumn,
    columnByField,
    humanSuppliedColumns,
    absentColumns,
    unmappedColumns,
  };
}
