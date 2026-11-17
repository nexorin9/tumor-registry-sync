import { z } from 'zod';

/**
 * 受控术语条目：登记员自由文本经由词表归一后指向的院内权威编码。
 */
export interface ControlledTerm {
  /** 受控编码，如 'IIIB'。 */
  code: string;
  /** 可读名，如 'IIIB期'。 */
  label: string;
  /** 别名列表，含全角/半角/带后缀等多种写法。 */
  aliases: string[];
  /** 口径说明。 */
  caliber: string;
  /** 来源标注，如 '经验推断'。 */
  source: string;
}

/** 受控词表构建/校验失败时的错误，message 会点名具体 offending 项。 */
export class VocabIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VocabIndexError';
  }
}

/**
 * 归一化术语键：
 * - NFKC 统一全角/半角（罗马数字 Ⅲ→III、带圈数字 ③→3 等）
 * - trim
 * - ASCII 字母转小写
 * - 去除所有空白
 * - 去除常见中文分期后缀（期/级/階）
 * 保持确定性，便于同一编码的多写法命中。
 */
export function normalizeTermKey(s: string): string {
  let t = s.normalize('NFKC');
  t = t.trim();
  t = t.replace(/[A-Za-z]/g, (c) => c.toLowerCase());
  t = t.replace(/\s+/g, '');
  t = t.replace(/[期级階]/g, '');
  return t;
}

const termSchema = z.object({
  code: z.string().min(1, 'code 不能为空字符串'),
  label: z.string().optional().default(''),
  aliases: z.array(z.string()),
  caliber: z.string().min(1, 'caliber 不能为空字符串'),
  source: z.string().min(1, 'source 不能为空字符串'),
});

export interface VocabIndex {
  version: string;
  terms: ControlledTerm[];
  /** 用已归一的键直接查表。 */
  lookup(normalized: string): ControlledTerm | null;
  /** 用原始字符串查表（内部先归一）。 */
  lookupRaw(raw: string): ControlledTerm | null;
}

/**
 * 构建受控词表索引。
 *
 * 校验：
 * - version 必填（非空字符串），否则抛 VocabIndexError
 * - 每条术语必须有 code（非空）、aliases（字符串数组）、caliber（非空）、source（非空），否则点名抛错
 * - 构建归一键索引；重复 code 或别名冲突（两个不同术语共享同一归一键）→ 点名冲突抛错，不静默取第一个
 */
export function buildVocabIndex(raw: unknown): VocabIndex {
  if (raw === null || typeof raw !== 'object') {
    throw new VocabIndexError('受控词表根节点必须是对象');
  }
  const root = raw as Record<string, unknown>;

  if (typeof root.version !== 'string' || root.version.length === 0) {
    throw new VocabIndexError('受控词表缺少 version（非空字符串）');
  }
  const version = root.version;

  if (!Array.isArray(root.terms)) {
    throw new VocabIndexError('受控词表缺少 terms 数组');
  }

  const terms: ControlledTerm[] = [];
  for (let i = 0; i < root.terms.length; i++) {
    const parsed = termSchema.safeParse(root.terms[i]);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((issue) => `[${(issue.path.join('.') || String(i))}] ${issue.message}`)
        .join('; ');
      throw new VocabIndexError(`第 ${i} 条术语校验失败：${detail}`);
    }
    terms.push(parsed.data as ControlledTerm);
  }

  const keyMap = new Map<string, ControlledTerm>();
  for (const term of terms) {
    const keys = [normalizeTermKey(term.code), ...term.aliases.map(normalizeTermKey)];
    for (const key of keys) {
      const existing = keyMap.get(key);
      if (existing !== undefined && existing !== term) {
        throw new VocabIndexError(
          `受控词冲突：归一键「${key}」同时指向 ${existing.code} 与 ${term.code}`,
        );
      }
      keyMap.set(key, term);
    }
  }

  const lookup = (normalized: string): ControlledTerm | null => keyMap.get(normalized) ?? null;
  const lookupRaw = (rawStr: string): ControlledTerm | null => lookup(normalizeTermKey(rawStr));

  return { version, terms, lookup, lookupRaw };
}
