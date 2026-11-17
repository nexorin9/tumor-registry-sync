/**
 * 受控字段口径表：比对之前先把「每个字段按什么口径算」写死。
 *
 * 为什么要有这张表：登记表里一列到底对应哪个口径字段、参不参与比对、是不是派生、
 * 是不是受控编码、是不是人工补充列 —— 这些不写死，比对层就会自己猜：把没声明口径的
 * 列也拿去比、把派生字段当成普通字段比、把人工补充列覆盖掉。所以口径先于取值。
 *
 * 三条硬规矩：
 * - **未声明口径的字段不参与比对**，并显式标「口径未声明」——不猜、不静默跳过。
 * - **人工补充列只读不覆盖**，不参与比对，也不产生任何操作。
 * - **派生字段必须声明取数口径**（按哪条规则、取哪几次就诊）；口径没声明就不算，
 *   算不出来就明说，绝不按空值参与比对（按空值参与比对等于建议「删除」）。
 *
 * 口径依据（经验推断）：肿瘤登记的分期与随访字段口径在院内无权威资产可依
 * （domain/ 资产层不收录肿瘤登记条目），本表逐项标注 (经验推断)；
 * **严禁**虚构分期编码位数、目录结构或量限数字。
 */
import { readFileSync } from 'node:fs';

import { z } from 'zod';

import { DERIVED_CALIBER_RULES, DERIVED_FIELDS } from '../fhir/derived-view.js';

/** 口径依据标注：本轮所有肿瘤登记字段口径均标 (经验推断)。 */
export const FIELD_SPEC_BASIS = '经验推断';

/** 未声明口径时的统一标注（写进表内「差异 / 建议值」列，给登记员看）。 */
export const CALIBER_UNSPECIFIED = '口径未声明';

/** 字段来源：登记列 / 院内资源路径 / 派生。 */
export const FIELD_SOURCE_KINDS = ['登记列', '院内资源路径', '派生'] as const;
export const FieldSourceKindSchema = z.enum(FIELD_SOURCE_KINDS);
export type FieldSourceKind = z.infer<typeof FieldSourceKindSchema>;

/** 派生字段的取数口径声明（按哪条规则、取哪几次就诊）。 */
export const FieldSpecDerivedCaliberSchema = z.object({
  /** 取数规则：就诊开始最早的一次 / 最近的一次 */
  rule: z.enum(DERIVED_CALIBER_RULES),
  /** 可选的就诊筛选范围；不声明即取全部就诊 */
  encounterFilter: z
    .object({
      /** 就诊分类（Encounter.class.code） */
      classCode: z.string().min(1).nullable().default(null),
      /** 就诊类型文本（Encounter.type.text），精确匹配 */
      typeText: z.string().min(1).nullable().default(null),
    })
    .nullable()
    .default(null),
});
export type FieldSpecDerivedCaliber = z.infer<typeof FieldSpecDerivedCaliberSchema>;

/** 口径表的一条字段声明。 */
export const FieldSpecEntrySchema = z.object({
  /** 口径字段名 */
  field: z.string().min(1),
  /** 权威值来源 */
  source: FieldSourceKindSchema,
  /** 登记侧列名（派生字段为 null） */
  sourceColumn: z.string().min(1).nullable().default(null),
  /** 院内资源路径（如 Condition.stage）；无对应资源时为 null */
  resourcePath: z.string().min(1).nullable().default(null),
  /** 口径说明：这列到底是什么、拿来做什么 */
  description: z.string().min(1),
  /** 是否参与差异比对 */
  participatesInDiff: z.boolean(),
  /** 是否派生字段 */
  derived: z.boolean(),
  /** 是否受控编码字段（需归并到院内受控编码） */
  controlledCode: z.boolean().default(false),
  /** 是否人工补充列（登记员自己填，插件只读不覆盖） */
  humanSupplied: z.boolean().default(false),
  /** 口径依据标注（逐项必填，不许留空） */
  basis: z.string().min(1),
  /** 派生取数口径（非派生字段为 null） */
  derivedCaliber: FieldSpecDerivedCaliberSchema.nullable().default(null),
});
export type FieldSpecEntry = z.infer<typeof FieldSpecEntrySchema>;

/** 受控字段口径表整体。 */
export const FieldSpecSchema = z.object({
  /** 口径表版本号，写进 run-log 供核对当时用的是哪版口径 */
  version: z.string().min(1),
  /** 口径依据（逐项另标 basis） */
  basis: z.string().min(1).default(FIELD_SPEC_BASIS),
  /** 表级说明：三条硬规矩写在表里，跟着表一起走 */
  note: z.string().min(1),
  /** 逐字段声明 */
  fields: z.array(FieldSpecEntrySchema).min(1),
});
export type FieldSpec = z.infer<typeof FieldSpecSchema>;

/** 口径表相关错误：message 里点名具体字段，便于信息科照着改表。 */
export class FieldSpecError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(issues.length > 0 ? `${message}：${issues.join('；')}` : message);
    this.name = 'FieldSpecError';
    this.issues = issues;
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path.length > 0 ? `${path} ${issue.message}` : issue.message;
  });
}

/**
 * 校验字段口径表。
 *
 * 除了结构校验，还做一组**跨字段一致性**检查 —— 这些是口径表最容易出错、
 * 一出错就会让比对层默默猜值的地方：
 * - 同一个口径字段名不得声明两次；同一登记列也不得挂到两个字段上
 * - 派生字段必须在已支持的派生字段集合内（首次入院日 / 本次就诊开始），
 *   且必须声明取数口径；非派生字段不得声明取数口径
 * - 来源为「登记列」必须声明登记侧列名；来源为「院内资源路径」必须声明资源路径
 * - 声明参与比对，就必须有可比的一侧（院内资源路径或派生），否则是「要比却没有可比对象」
 * - 人工补充列不得参与比对、不得标成受控编码字段
 */
export function parseFieldSpec(data: unknown): FieldSpec {
  const parsed = FieldSpecSchema.safeParse(data);
  if (!parsed.success) {
    throw new FieldSpecError('字段口径表不符合约定', formatIssues(parsed.error));
  }

  const spec = parsed.data;
  const issues: string[] = [];

  const seenFields = new Map<string, number>();
  const seenColumns = new Map<string, string>();
  spec.fields.forEach((entry, index) => {
    const previousIndex = seenFields.get(entry.field);
    if (previousIndex !== undefined) {
      issues.push(`口径字段「${entry.field}」被声明了两次（第 ${previousIndex + 1} 条与第 ${index + 1} 条）`);
    } else {
      seenFields.set(entry.field, index);
    }

    if (entry.sourceColumn !== null) {
      const owner = seenColumns.get(entry.sourceColumn);
      if (owner !== undefined) {
        issues.push(`登记列「${entry.sourceColumn}」同时挂到了「${owner}」与「${entry.field}」两个口径字段上`);
      } else {
        seenColumns.set(entry.sourceColumn, entry.field);
      }
    }

    if (entry.derived) {
      if (!(DERIVED_FIELDS as readonly string[]).includes(entry.field)) {
        issues.push(
          `派生字段「${entry.field}」不在已支持的派生字段集合内（${DERIVED_FIELDS.join(' / ')}）`,
        );
      }
      if (entry.derivedCaliber === null) {
        issues.push(`派生字段「${entry.field}」必须声明取数口径 derivedCaliber（按哪条规则、取哪几次就诊）`);
      }
      if (entry.sourceColumn !== null) {
        issues.push(`派生字段「${entry.field}」不应声明 sourceColumn（派生值不来自表里的列）`);
      }
    } else if (entry.derivedCaliber !== null) {
      issues.push(`非派生字段「${entry.field}」不应声明 derivedCaliber`);
    }

    if (entry.source === '登记列' && entry.sourceColumn === null) {
      issues.push(`来源为登记列的字段「${entry.field}」必须声明 sourceColumn`);
    }
    if (entry.source === '院内资源路径' && entry.resourcePath === null) {
      issues.push(`来源为院内资源路径的字段「${entry.field}」必须声明 resourcePath`);
    }
    if (entry.source === '派生' && entry.derivedCaliber === null) {
      issues.push(`来源为派生的字段「${entry.field}」必须声明 derivedCaliber`);
    }

    if (
      entry.participatesInDiff &&
      entry.resourcePath === null &&
      !entry.derived
    ) {
      issues.push(
        `参与比对的字段「${entry.field}」必须有可比的一侧：声明院内资源路径 resourcePath 或标为派生字段`,
      );
    }

    if (entry.humanSupplied) {
      if (entry.participatesInDiff) {
        issues.push(`人工补充列「${entry.field}」不能参与比对（登记员自己填的，只读不覆盖）`);
      }
      if (entry.controlledCode) {
        issues.push(`人工补充列「${entry.field}」不应标为受控编码字段（人工填写的内容不归并）`);
      }
    }
  });

  if (issues.length > 0) {
    throw new FieldSpecError('字段口径表存在口径冲突', issues);
  }

  return spec;
}

/** 从 JSON 文件加载字段口径表。 */
export function loadFieldSpec(path: string): FieldSpec {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FieldSpecError(`读取字段口径表失败：${path}`, [message]);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FieldSpecError(`字段口径表不是合法 JSON：${path}`, [message]);
  }

  return parseFieldSpec(data);
}

/** 一条生效口径（表里声明了就是生效，没声明的一律不生效）。 */
export interface EffectiveCaliber {
  /** 口径字段名 */
  field: string;
  /** 权威值来源 */
  source: FieldSourceKind;
  /** 登记侧列名 */
  sourceColumn: string | null;
  /** 院内资源路径 */
  resourcePath: string | null;
  /** 口径说明 */
  description: string;
  /** 是否参与差异比对 */
  participatesInDiff: boolean;
  /** 是否派生字段 */
  derived: boolean;
  /** 是否受控编码字段 */
  controlledCode: boolean;
  /** 是否人工补充列 */
  humanSupplied: boolean;
  /** 口径依据 */
  basis: string;
  /** 派生取数口径 */
  derivedCaliber: FieldSpecDerivedCaliber | null;
  /** 这一列本轮怎么处理（面向登记员的一句话） */
  treatment: string;
}

/** 按来源声明给出「这一列本轮怎么处理」。 */
export function caliberTreatment(entry: FieldSpecEntry): string {
  if (entry.humanSupplied) {
    return '人工补充列 · 只读不覆盖 · 不参与比对';
  }
  if (entry.derived) {
    return entry.participatesInDiff
      ? '派生字段 · 按口径算出后参与比对'
      : '派生字段 · 算出来但不参与比对';
  }
  if (entry.participatesInDiff) {
    return '参与比对';
  }
  if (entry.controlledCode) {
    return '不参与比对 · 归并后只作建议值';
  }
  return '不参与比对';
}

/** 当前生效的口径清单（表里声明了就是生效）。 */
export function effectiveCalibers(spec: FieldSpec): EffectiveCaliber[] {
  return spec.fields.map((entry) => ({
    field: entry.field,
    source: entry.source,
    sourceColumn: entry.sourceColumn,
    resourcePath: entry.resourcePath,
    description: entry.description,
    participatesInDiff: entry.participatesInDiff,
    derived: entry.derived,
    controlledCode: entry.controlledCode,
    humanSupplied: entry.humanSupplied,
    basis: entry.basis,
    derivedCaliber: entry.derivedCaliber,
    treatment: caliberTreatment(entry),
  }));
}

/** 表里一列的口径状态。 */
export type ColumnCaliberStatus =
  /** 已声明口径，参与比对 */
  | '参与比对'
  /** 已声明口径，但登记员自己填的（只读不覆盖） */
  | '人工补充列'
  /** 口径表没声明这一列 */
  | '口径未声明';

/** 表里一列的口径判定结果。 */
export interface ColumnCaliber {
  /** 表头列名 */
  column: string;
  /** 口径字段名；未声明时为 null */
  field: string | null;
  /** 本轮口径状态 */
  status: ColumnCaliberStatus;
  /** 是否参与差异比对 */
  participatesInDiff: boolean;
  /** 是否派生字段 */
  derived: boolean;
  /** 是否受控编码字段 */
  controlledCode: boolean;
  /** 是否人工补充列 */
  humanSupplied: boolean;
  /** 面向登记员的说明 */
  reason: string;
}

/** 口径表与本张表的对照结果。 */
export interface ResolvedFieldSpec {
  /** 口径表原件 */
  spec: FieldSpec;
  /** 按表头顺序的逐列判定 */
  columns: ColumnCaliber[];
  /** 口径表没声明的列：本轮不参与比对，显式标「口径未声明」 */
  unspecifiedColumns: string[];
  /** 人工补充列（写回层必须跳过） */
  humanSuppliedColumns: string[];
  /** 口径表声明了、但本张表没有的字段（本轮不参与比对） */
  absentFields: string[];
}

/**
 * 把口径表与本张表的表头对起来。
 *
 * 三档结果：**参与比对** / **人工补充列** / **口径未声明**。
 * 未声明的列不猜、不静默跳过 —— 显式落到 `unspecifiedColumns` 与逐列判定里。
 */
export function resolveFieldSpec(spec: FieldSpec, header: string[]): ResolvedFieldSpec {
  const normalizedHeader = header.map((name) => name.trim());
  const byColumn = new Map<string, FieldSpecEntry>();
  for (const entry of spec.fields) {
    if (entry.sourceColumn !== null) {
      byColumn.set(entry.sourceColumn, entry);
    }
  }

  const columns: ColumnCaliber[] = [];
  const unspecifiedColumns: string[] = [];
  const humanSuppliedColumns: string[] = [];

  for (const column of normalizedHeader) {
    const entry = byColumn.get(column);
    if (entry === undefined) {
      unspecifiedColumns.push(column);
      columns.push({
        column,
        field: null,
        status: '口径未声明',
        participatesInDiff: false,
        derived: false,
        controlledCode: false,
        humanSupplied: false,
        reason: `「${column}」未在字段口径表中声明，本轮不参与比对、不产生任何差异值`,
      });
      continue;
    }

    if (entry.humanSupplied) {
      humanSuppliedColumns.push(column);
      columns.push({
        column,
        field: entry.field,
        status: '人工补充列',
        participatesInDiff: false,
        derived: false,
        controlledCode: false,
        humanSupplied: true,
        reason: `「${column}」是人工补充列，只读不覆盖、不参与比对`,
      });
      continue;
    }

    columns.push({
      column,
      field: entry.field,
      status: '参与比对',
      participatesInDiff: entry.participatesInDiff,
      derived: entry.derived,
      controlledCode: entry.controlledCode,
      humanSupplied: false,
      reason: entry.description,
    });
  }

  const headerSet = new Set(normalizedHeader);
  const absentFields = spec.fields
    .filter((entry) => entry.sourceColumn !== null && !headerSet.has(entry.sourceColumn))
    .map((entry) => entry.field);

  return {
    spec,
    columns,
    unspecifiedColumns,
    humanSuppliedColumns,
    absentFields,
  };
}
