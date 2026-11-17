/**
 * 推送体构造：把一行差异（DiffOperation[]）与写前比对（ifMatch）组装成 RegistryEntry。
 *
 * 两种 payload form 都「只带变化字段」——
 * - field-level：字段级增量，只发 changedFields
 * - whole-entry：整条但只带变化的字段，未变化的字段由服务端保留
 * 二者在本引擎里差异仅停留在语义层；请求体形状完全一致，绝不整行覆盖未变化字段。
 * form 非法时**点名配置项并列出允许值**报错，绝不静默降级。
 */
import type { FieldValue } from '../contract/index.js';
import { InvalidEnvError, PAYLOAD_FORMS } from '../config/env.js';
import type { DiffOperation } from '../diff/patch.js';
import type { RegistryEntry } from './payload-schema.js';

export interface PushRowInput {
  registryId: string;
  identifierSystem: string;
  subjectReference: string;
  operations: DiffOperation[];
  ifMatch: { path: string; value: unknown }[];
  extensions: Record<string, unknown>;
}

function toFieldValue(value: unknown): FieldValue | null {
  if (value === undefined) return null;
  return value as FieldValue | null;
}

/**
 * 构造推送体。form 不是 'field-level' | 'whole-entry' 时抛 InvalidEnvError 并点名
 * REGISTRY_PAYLOAD_FORM 与允许取值，绝不静默回退到默认形态。
 */
export function buildPushBody(row: PushRowInput, form: (typeof PAYLOAD_FORMS)[number]): RegistryEntry {
  if (!(PAYLOAD_FORMS as readonly string[]).includes(form)) {
    throw new InvalidEnvError(
      'REGISTRY_PAYLOAD_FORM',
      `允许取值为 ${PAYLOAD_FORMS.join(' / ')}，当前为「${form}」`,
    );
  }

  const changedFields = row.operations.map((op) => ({
    path: op.path,
    // 优先用未归一化的原值（raw*）做写前/回写，缺失时回退到归一值
    oldValue: toFieldValue(op.rawOldValue ?? op.oldValue),
    newValue: toFieldValue(op.rawNewValue ?? op.newValue),
  }));

  return {
    resourceType: 'RegistryEntry',
    identifier: { system: row.identifierSystem, value: row.registryId },
    subject: { reference: row.subjectReference },
    changedFields,
    ifMatch: row.ifMatch.map((entry) => ({
      path: entry.path,
      value: toFieldValue(entry.value),
    })),
    extensions: row.extensions,
  };
}
