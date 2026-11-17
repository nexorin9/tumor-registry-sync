/**
 * 批次键与登记表指纹。
 *
 * 批次键用于把「同一份登记表 + 同一组检索参数 + 同一时刻」绑成一次同步批次：
 * 幂等、可复现、缺行检查与表尾回执都靠它串起来。
 *
 * 登记表指纹只取「内容」：表头 + 行数 + 行内容，刻意不沾任何时间戳，
 * 所以同一份登记表无论何时跑，指纹都一致；批次键才是那个带时间戳的壳。
 */
import { createHash } from 'node:crypto';

/**
 * 规范化一个值：对象按 key 字典序、数组按序展开，得到与「输入等价、与顺序无关」
 * 的稳定字符串。数组/对象顺序本来就是语义顺序，这里只消掉对象 key 遍历顺序的
 * 不确定性（不同运行、不同 JSON 解析器可能把 key 排成不同顺序）。
 */
function canonicalize(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const fields = keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * 登记表指纹：表头 + 行数 + 各行的稳定序列化后取 sha256（hex）。
 *
 * 把行数放在最前面，避免「A 行内容正好是 B 的前缀」时两组不同输入算出同一指纹
 * （前缀碰撞）。相同输入永远得到相同指纹，与时间无关。
 */
export function tableFingerprint(header: string[], rows: unknown[][]): string {
  const parts: string[] = [String(rows.length), canonicalize(header)];
  for (const row of rows) {
    parts.push(canonicalize(row));
  }
  const serialized = parts.join('\n');
  return createHash('sha256').update(serialized).digest('hex');
}

/**
 * 批次键 = sha256(登记表指纹|检索参数串|时间)。
 *
 * 同一份表 + 同一组检索参数 + 同一时刻 → 同一批次键；任意一项变了都得到新键，
 * 因此它能直接当幂等键与缺行/回执的串联键用。
 */
export function makeBatchKey(fingerprint: string, searchParams: string, timeIso: string): string {
  const basis = `${fingerprint}|${searchParams}|${timeIso}`;
  return createHash('sha256').update(basis).digest('hex');
}

/** normalizeSearchParams 的输入形状（与契约检索步骤对应的子集）。 */
export interface BatchSearchParamEntryInput {
  registryId: string;
  steps: { resourceType: string; params: Record<string, string | string[]> }[];
}

/** 把单个检索参数值规范成稳定字符串：数组内按值排序，标量原样。 */
function serializeParamValue(value: string | string[]): string {
  if (Array.isArray(value)) {
    return `[${[...value].sort().map((item) => JSON.stringify(item)).join(',')}]`;
  }
  return JSON.stringify(value);
}

/**
 * 把一批检索参数归一化成稳定、可排序的字符串。
 *
 * 顺序不依赖传入顺序：先按登记号排、再按资源类型排、参数按 key 排序、
 * 数组型参数值内部排序。同一组检索参数无论以什么顺序喂进来都得到同一串，
 * 因此可直接作为批次键的 `searchParams` 分量与表尾回执区的检索参数串。
 */
export function normalizeSearchParams(entries: BatchSearchParamEntryInput[]): string {
  const sortedEntries = [...entries].sort((a, b) => {
    if (a.registryId < b.registryId) return -1;
    if (a.registryId > b.registryId) return 1;
    return 0;
  });

  const entryStrings = sortedEntries.map((entry) => {
    const sortedSteps = [...entry.steps].sort((a, b) => {
      if (a.resourceType < b.resourceType) return -1;
      if (a.resourceType > b.resourceType) return 1;
      return 0;
    });
    const stepStrings = sortedSteps.map((step) => {
      const keys = Object.keys(step.params).sort();
      const paramStrings = keys.map(
        (key) => `${JSON.stringify(key)}=${serializeParamValue(step.params[key] as string | string[])}`,
      );
      return `${step.resourceType}{${paramStrings.join(',')}}`;
    });
    return `${entry.registryId}:[${stepStrings.join('|')}]`;
  });

  return entryStrings.join(';');
}
