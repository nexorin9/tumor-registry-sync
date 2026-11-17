/**
 * 登记表读取：CSV 解析 + 编码兜底 + 表头识别。
 *
 * 表格侧的现实情况（WPS 与 Excel 导出各有脾气）：
 * - 引号转义：字段里带逗号要包在引号里，包里的引号要写成两个引号
 * - 行尾：CRLF / LF / CR 都见过
 * - 编码：UTF-8（含 BOM）、GBK，甚至两者混编（见 encoding.ts）
 * - 空行：导出尾部常多一个空行，不能当成数据行
 *
 * 本模块只负责「把表读成二维数组」，**不做任何比对、不丢任何一行**：
 * 列数不符的行原样保留，由 rows.ts 给行级错误码。
 */
import { readFileSync } from 'node:fs';

import { decodeSheetBuffer, type SheetEncoding } from './encoding.js';

/** 行尾风格。 */
export type LineEnding = 'crlf' | 'lf' | 'cr' | 'mixed' | 'none';

/** 读出来的一张表。 */
export interface ParsedSheet {
  /** 首行表头（已去首尾空白） */
  header: string[];
  /** 数据行（不含表头），保持原始字符串 */
  rows: string[][];
  /** 实际采用的解码方式 */
  encoding: SheetEncoding;
  /** 原文件是否带 UTF-8 BOM */
  hadBom: boolean;
  /** 行尾风格 */
  lineEnding: LineEnding;
  /** 表级提示（重复表头、空表头等），不阻断运行 */
  warnings: string[];
}

/**
 * 解析 CSV 文本为二维数组。
 *
 * 规则（RFC 4180 + 院内实际）：
 * - 逗号分隔；字段可用双引号包裹，包裹后可含逗号与换行
 * - 引号内的双引号写成两个双引号
 * - 引号外的空白是内容的一部分（留给规范化层处理）
 * - 支持 CRLF / LF / CR 三种行尾
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let index = 0;

  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };

  while (index < text.length) {
    const char = text[index] as string;

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      endField();
      index += 1;
      continue;
    }
    if (char === '\r') {
      index += text[index + 1] === '\n' ? 2 : 1;
      endRow();
      continue;
    }
    if (char === '\n') {
      index += 1;
      endRow();
      continue;
    }

    field += char;
    index += 1;
  }

  // 文件末尾没有换行符时补上最后一行；若最后正好是换行符则不产生空行
  if (field.length > 0 || row.length > 0) {
    endRow();
  }

  return rows;
}

/** 判断行尾风格。 */
export function detectLineEnding(text: string): LineEnding {
  let crlf = 0;
  let lf = 0;
  let cr = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\r') {
      if (text[index + 1] === '\n') {
        crlf += 1;
        index += 1;
      } else {
        cr += 1;
      }
    } else if (char === '\n') {
      lf += 1;
    }
  }

  const kinds = [crlf > 0 ? 'crlf' : null, lf > 0 ? 'lf' : null, cr > 0 ? 'cr' : null].filter(
    (kind): kind is Exclude<LineEnding, 'mixed' | 'none'> => kind !== null,
  );
  if (kinds.length === 0) return 'none';
  if (kinds.length > 1) return 'mixed';
  return kinds[0] as Exclude<LineEnding, 'mixed' | 'none'>;
}

/** 表头检查：空表头与重复表头只报提示，不阻断（该列本轮不参与比对）。 */
function checkHeader(header: string[]): string[] {
  const warnings: string[] = [];
  const empty = header.filter((name) => name.length === 0);
  if (empty.length > 0) {
    warnings.push(`表头有 ${empty.length} 个空列名，这些列不参与比对`);
  }

  const counts = new Map<string, number>();
  for (const name of header) {
    if (name.length === 0) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const duplicated = [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name);
  if (duplicated.length > 0) {
    warnings.push(`表头有重复列名：${duplicated.join('、')}，这些列不参与比对`);
  }

  return warnings;
}

/** 把解析出的二维数组组装成一张表（首行为表头）。 */
export function buildSheet(
  rows: string[][],
  encoding: SheetEncoding,
  hadBom: boolean,
  lineEnding: LineEnding,
): ParsedSheet {
  const warnings: string[] = [];
  if (rows.length === 0) {
    warnings.push('表是空的：没有读到表头行');
    return { header: [], rows: [], encoding, hadBom, lineEnding, warnings };
  }

  const header = (rows[0] as string[]).map((name) => name.trim());
  const dataRows = rows.slice(1);
  warnings.push(...checkHeader(header));

  return {
    header,
    rows: dataRows,
    encoding,
    hadBom,
    lineEnding,
    warnings,
  };
}

/** 从 CSV 文本读表（先解码，再解析）。 */
export function readSheetText(input: Buffer | Uint8Array | string): ParsedSheet {
  const decoded =
    typeof input === 'string'
      ? { text: input, encoding: 'utf-8' as SheetEncoding, hadBom: false }
      : decodeSheetBuffer(input);
  const rows = parseCsv(decoded.text);
  return buildSheet(rows, decoded.encoding, decoded.hadBom, detectLineEnding(decoded.text));
}

/** 从 CSV 文件读表（自动做 BOM / GBK / UTF-8 混编探测）。 */
export function readSheetFile(path: string): ParsedSheet {
  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`读取登记表失败：${path}（${message}）`);
  }
  return readSheetText(buffer);
}
