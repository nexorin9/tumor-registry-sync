/**
 * 推送体契约（spec.md 输出 D · RegistryEntry）。
 *
 * 这是引擎写往专病库登记接口的唯一请求形状。schema 是权威来源，SPEC_FIELD_MAP
 * 把 spec.md 的每个字段逐条映射到 schema，assertSpecConsistency 反过来校验两边
 * 没有偏离 —— 任一侧加了字段或改了必填性，另一侧立刻在校验时报错。
 */
import { z } from 'zod';

import { FieldValueSchema } from '../contract/index.js';

/** spec.md 输出 D 的推送体。两种 payload form 都用这同一个结构。 */
export const RegistryEntrySchema = z.object({
  resourceType: z.literal('RegistryEntry'),
  identifier: z.object({
    system: z.string(),
    value: z.string(),
  }),
  subject: z.object({
    reference: z.string(),
  }),
  changedFields: z.array(
    z.object({
      path: z.string(),
      oldValue: FieldValueSchema.nullable(),
      newValue: FieldValueSchema.nullable(),
    }),
  ),
  ifMatch: z.array(
    z.object({
      path: z.string(),
      value: FieldValueSchema.nullable(),
    }),
  ),
  extensions: z.record(z.string(), z.unknown()),
});
export type RegistryEntry = z.infer<typeof RegistryEntrySchema>;

/** 推送体校验失败：带字段路径与原因，登记员/信息科照着改。 */
export class PayloadValidationError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(issues.length > 0 ? `${message}：${issues.join('；')}` : message);
    this.name = 'PayloadValidationError';
    this.issues = issues;
  }
}

export type ValidatedRegistryEntry = z.infer<typeof RegistryEntrySchema>;

/** 校验推送体；失败时抛 PayloadValidationError 并附带每个字段的路径与原因。 */
export function validateRegistryEntry(data: unknown): ValidatedRegistryEntry {
  const result = RegistryEntrySchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return path.length > 0 ? `${path} ${issue.message}` : issue.message;
    });
    throw new PayloadValidationError('推送体不符合契约', issues);
  }
  return result.data;
}

/**
 * spec.md ↔ schema 字段映射表。逐条对应、不漏字段。
 * `required` 指「键必须存在」，null 仍算「存在」（故 changedFields[].oldValue 等必填）。
 */
export const SPEC_FIELD_MAP: {
  field: string;
  required: boolean;
  meaning: string;
  source: string;
}[] = [
  {
    field: 'resourceType',
    required: true,
    meaning: '资源类型常量，固定为 RegistryEntry',
    source: 'spec.md 输出 D',
  },
  {
    field: 'identifier.system',
    required: true,
    meaning: '登记主索引的 system（对应 CDR_IDENTIFIER_SYSTEM）',
    source: 'spec.md 输出 D · identifier.system',
  },
  {
    field: 'identifier.value',
    required: true,
    meaning: '登记主索引的 token 值（登记号）',
    source: 'spec.md 输出 D · identifier.value',
  },
  {
    field: 'subject.reference',
    required: true,
    meaning: '院内主体引用（Patient 引用）',
    source: 'spec.md 输出 D · subject.reference',
  },
  {
    field: 'changedFields[].path',
    required: true,
    meaning: '发生变化的字段路径',
    source: 'spec.md 输出 D · changedFields[].path',
  },
  {
    field: 'changedFields[].oldValue',
    required: true,
    meaning: '字段原值（缺失/空为 null）',
    source: 'spec.md 输出 D · changedFields[].oldValue',
  },
  {
    field: 'changedFields[].newValue',
    required: true,
    meaning: '字段新值（缺失/空为 null）',
    source: 'spec.md 输出 D · changedFields[].newValue',
  },
  {
    field: 'ifMatch[].path',
    required: true,
    meaning: '写前比对路径',
    source: 'spec.md 输出 D · ifMatch[].path',
  },
  {
    field: 'ifMatch[].value',
    required: true,
    meaning: '写前比对期望值',
    source: 'spec.md 输出 D · ifMatch[].value',
  },
  {
    field: 'extensions',
    required: true,
    meaning: '开放扩展字段（来源/派生标记等）',
    source: 'spec.md 输出 D · extensions',
  },
];

/** 拆掉 ZodOptional / ZodNullable 外层，便于递归探查内部结构。 */
function unwrap(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) {
    return unwrap(schema.unwrap());
  }
  return schema;
}

interface FieldInfo {
  path: string;
  required: boolean;
}

/**
 * 递归收集 schema 的全部叶子字段路径与必填性。
 * 对象属性：必填 = 不是 ZodOptional；数组元素用 `[]` 后缀；record 用自身路径。
 */
function collectPaths(schema: z.ZodTypeAny, prefix: string, required: boolean): FieldInfo[] {
  const inner = unwrap(schema);
  if (inner instanceof z.ZodObject) {
    const out: FieldInfo[] = [];
    const shape = inner.shape as Record<string, z.ZodTypeAny>;
    for (const [key, def] of Object.entries(shape)) {
      const propRequired = !(def instanceof z.ZodOptional);
      const childPrefix = prefix.length > 0 ? `${prefix}.${key}` : key;
      out.push(...collectPaths(def, childPrefix, propRequired));
    }
    return out;
  }
  if (inner instanceof z.ZodArray) {
    return collectPaths(inner.element, `${prefix}[]`, required);
  }
  if (inner instanceof z.ZodRecord) {
    return [{ path: prefix, required }];
  }
  return [{ path: prefix, required }];
}

/** 校验 SPEC_FIELD_MAP 与 RegistryEntrySchema 完全一致（不漏、不多、必填性一致）。 */
export function assertSpecConsistency(): void {
  const actual = new Map<string, boolean>();
  for (const info of collectPaths(RegistryEntrySchema, '', true)) {
    actual.set(info.path, info.required);
  }

  // 映射表里的每个字段都必须能在 schema 中找到，且必填性一致
  for (const entry of SPEC_FIELD_MAP) {
    if (!actual.has(entry.field)) {
      throw new Error(`SPEC_FIELD_MAP 字段在 schema 中缺失：${entry.field}`);
    }
    const schemaRequired = actual.get(entry.field);
    if (schemaRequired !== entry.required) {
      throw new Error(
        `SPEC_FIELD_MAP 字段 ${entry.field} 的必填性与 schema 不一致（map=${entry.required}, schema=${schemaRequired}）`,
      );
    }
  }

  // schema 里有但映射表没声明的字段 = 多余的字段，也要报错
  for (const path of actual.keys()) {
    if (!SPEC_FIELD_MAP.some((entry) => entry.field === path)) {
      throw new Error(`schema 存在未在 SPEC_FIELD_MAP 中声明的字段：${path}`);
    }
  }
}
