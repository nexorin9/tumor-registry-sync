/**
 * 幂等键与批次键。
 *
 * 推送必须幂等：同一「登记号 + 字段 + 原值 + 新值」无论被引擎重发多少次，
 * 专病库只能落一条。所以幂等键只由业务内容决定，绝不混入时间戳 / 重试次数 /
 * 批次号 —— 否则同一内容换一批重发就会变成不同的键，去重就失效了。
 */
import { createHash } from 'node:crypto';

/** 把任意值规整成「键有序、数组保序、undefined 归一为 null」的规范结构。 */
function canonical(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((element) => canonical(element));
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      result[key] = canonical(obj[key]);
    }
    return result;
  }
  return value;
}

/** 确定性 JSON：对象键按字典序、数组保序、undefined 归一为 null。 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonical(value));
}

/**
 * 单字段幂等键：对 `${registryId}|${fieldPath}|${old}|${new}` 取 sha256（hex）。
 * 只依赖业务内容，与时间戳 / 重试次数 / 批次无关。
 */
export function idempotencyKey(
  registryId: string,
  fieldPath: string,
  oldValue: unknown,
  newValue: unknown,
): string {
  const input = `${registryId}|${fieldPath}|${stableStringify(oldValue)}|${stableStringify(
    newValue,
  )}`;
  return createHash('sha256').update(input).digest('hex');
}

/**
 * 批次键：对 `${fingerprint}|${searchParams}|${timeIso}` 取 sha256（hex）。
 * 同一批「表指纹 + 检索参数 + 生成时刻」固定映射到同一个批次键，用于断点续跑定位。
 */
export function batchKey(fingerprint: string, searchParams: string, timeIso: string): string {
  const input = `${fingerprint}|${searchParams}|${timeIso}`;
  return createHash('sha256').update(input).digest('hex');
}

/** 表指纹：把若干段拼接后取 sha256（hex），作为整张表/这批源数据的固定指纹。 */
export function tableFingerprint(...parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex');
}
