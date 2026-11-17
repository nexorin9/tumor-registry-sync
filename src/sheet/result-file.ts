/**
 * 结果表文件落盘：把写回层的语义结果写成一张**真实的结果表文件**。
 *
 * 登记员最后拿到的不是一堆 JSON，而是自己能打开的那张表：原表列原样在前，
 * 五列新列追加在后，表尾两区说明「这批推了什么、还漏了什么」。这一层只管
 * **文件形态** —— 物理列序、表尾区块版式、编码、原子写、原列一致性自检；
 * 差异怎么算、确认怎么判、推不推，都在别处定，这里只照着写。
 *
 * 三条硬规矩：
 * - **原表列一个字节都不改**：写回层只追加新列；人工补充列（随访电话、生活方式备注）
 *   在输出里与输入逐字节相同，写完还要回读文件再核一遍。
 * - **缺行区只追加，不插入正文**：院内命中但本表没有的登记号只出现在表尾缺行区，
 *   绝不混进正文行冒充登记员自己填的行。
 * - **失败不留半文件**：先写临时文件再 rename；写出失败删掉临时文件，原结果表保持原样。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { AlignRowResult, FieldValue, MissingRow, ReceiptBlock } from '../contract/index.js';

import { writeFileAtomically } from './atomic.js';
import { decodeEncodedSheet, encodeSheetText, type OutputEncoding } from './encode.js';
import { parseCsv } from './read.js';

/** 结果表新增的五个固定列（物理列序固定：原表列之后依次追加）。 */
export const RESULT_NEW_COLUMNS = ['院内值', '差异', '建议值', '确认', 'AI 说明'] as const;

/** 表尾回执区的区块标题（写回层与宏侧共用同一份文案）。 */
export const RECEIPT_BLOCK_TITLE = '【推送回执】';

/** 表尾缺行区的区块标题。 */
export const MISSING_BLOCK_TITLE = '【院内命中但本表缺行】';

/** 回执区明细行的字段顺序（标题行里也写一遍，登记员照着看列序）。 */
export const RECEIPT_DETAIL_FIELDS = '登记号｜行号｜状态｜原因｜幂等键｜尝试次数｜推送时刻';

/** 缺行区明细行的字段顺序。 */
export const MISSING_DETAIL_FIELDS = '登记号｜来源｜状态｜确认';

/** 结果表相关错误：message 里点名具体位置，便于登记员照着改。 */
export class ResultFileError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(issues.length > 0 ? `${message}：${issues.join('；')}` : message);
    this.name = 'ResultFileError';
    this.issues = issues;
  }
}

/** 一行新列的取值（五个新列一一对应）。 */
export interface ResultNewColumnValues {
  /** 「院内值」列 */
  hospitalValue: string;
  /** 「差异」列 */
  diff: string;
  /** 「建议值」列 */
  suggested: string;
  /** 「确认」列 */
  confirm: string;
  /** 「AI 说明」列 */
  aiNote: string;
}

/** 写结果表需要的输入。 */
export interface ResultFileInput {
  /** 原表表头（原列顺序，一个都不改） */
  header: string[];
  /** 原表数据行的原始单元格（字符串，按原表列序） */
  originalRows: string[][];
  /** 逐行的新列取值，与 originalRows 一一对应 */
  newColumns: ResultNewColumnValues[];
  /** 表尾推送回执区 */
  receipt: ReceiptBlock;
  /** 表尾缺行区 */
  missingRows: MissingRow[];
  /** 人工补充列的列名（写完自检时逐字节核对这一列） */
  humanSuppliedColumns?: string[];
}

/** 写出选项。 */
export interface ResultFileOptions {
  /** 输出编码：utf-8（默认）或 gbk（老旧 Excel / WPS 老版本） */
  encoding?: OutputEncoding;
  /** 行尾：crlf（默认，Excel 友好）或 lf */
  lineEnding?: 'crlf' | 'lf';
  /** UTF-8 输出是否带 BOM（默认带；GBK 下忽略） */
  bom?: boolean;
}

/** 写完后的回执：给上层汇总与 README 输出样例用。 */
export interface ResultFileWriteResult {
  /** 落盘路径 */
  outputPath: string;
  /** 实际使用的编码 */
  encoding: OutputEncoding;
  /** 实际使用的行尾 */
  lineEnding: 'crlf' | 'lf';
  /** 是否带 BOM */
  bom: boolean;
  /** 表宽（原列数 + 5） */
  columnCount: number;
  /** 正文行数（不含表尾区块） */
  bodyRows: number;
  /** 表尾区块行数 */
  footerLines: number;
  /** 总行数（含表头） */
  totalLines: number;
  /** 该编码下无法表示的字符（已替换为 '?'），空数组表示没有 */
  unmappableCharacters: string[];
  /** 原表列一致性自检结果 */
  verification: {
    /** 表头与预期一致 */
    headerMatches: boolean;
    /** 原表列逐行与输入一致 */
    originalColumnsMatch: boolean;
    /** 人工补充列逐字节未变 */
    humanSuppliedColumnsUnchanged: boolean;
    /** 核对了几行 */
    checkedRows: number;
  };
  /** 列数超过表头宽度、被截到表头宽度的行（需人工核对） */
  truncatedRows: { rowNumber: number; cellCount: number }[];
}

/** 组装出来的结果表（尚未落盘）。 */
export interface BuiltResultTable {
  /** 结果表文本（已按选定行尾拼接） */
  text: string;
  /** 表头（含五个新列） */
  header: string[];
  /** 表宽 */
  columnCount: number;
  /** 正文行数 */
  bodyRows: number;
  /** 表尾区块行数 */
  footerLines: number;
  /** 总行数（含表头） */
  totalLines: number;
  /** 列数超过表头宽度而被截断的行 */
  truncatedRows: { rowNumber: number; cellCount: number }[];
}

/** CSV 字段转义：含逗号、引号、换行时用双引号包起来。 */
export function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** 一行单元格 → 一行 CSV 文本。 */
function csvRow(cells: string[]): string {
  return cells.map(csvEscape).join(',');
}

/** 把一行补齐到指定宽度（多的截掉，少的空着）。 */
function padToWidth(cells: string[], width: number): string[] {
  return cells.slice(0, width).concat(new Array<string>(Math.max(0, width - cells.length)).fill(''));
}

/** 院内值列的排版：字段名=值，多个字段用「；」分隔（没有可用值时留空）。 */
export function formatHospitalValues(values: Record<string, FieldValue>): string {
  const parts = Object.entries(values)
    .filter(([, value]) => value !== null && value !== '')
    .map(([field, value]) => `${field}=${String(value)}`);
  return parts.join('；');
}

/** 由 align 的逐行结果取出五列新列的取值。 */
export function newColumnsFromAlignRow(row: AlignRowResult): ResultNewColumnValues {
  return {
    hospitalValue: formatHospitalValues(row.hospitalValues),
    diff: row.diffText,
    suggested: row.suggestedText,
    confirm: row.confirmValue,
    aiNote: row.aiNote,
  };
}

/**
 * 组装结果表文本（纯函数，不落盘）。
 *
 * 表尾两个区块的版式固定为「区块标题行 + 计数行 + 明细行」：
 * - 推送回执区：标题行写区块名与明细字段顺序；计数行写批次键、推送时刻、检索参数串
 *   与各类计数；明细行逐行一条（登记号｜行号｜状态｜原因｜幂等键｜尝试次数｜推送时刻）。
 * - 缺行区：标题行写区块名与明细字段顺序；计数行写缺行条数与「不自动入表」提示；
 *   明细行逐行一条（登记号｜来源｜状态｜确认）。
 *
 * 缺行只出现在缺行区，**不进正文**。
 */
export function buildResultTable(
  input: ResultFileInput,
  options: ResultFileOptions = {},
): BuiltResultTable {
  const lineEnding = options.lineEnding ?? 'crlf';

  if (input.originalRows.length !== input.newColumns.length) {
    throw new ResultFileError('原表行数与新列行数对不上', [
      `原表 ${input.originalRows.length} 行，新列 ${input.newColumns.length} 行`,
      '请确认新列取值与原表行一一对应后再写出',
    ]);
  }

  const header = [...input.header];
  const columnCount = header.length + RESULT_NEW_COLUMNS.length;
  const truncatedRows: { rowNumber: number; cellCount: number }[] = [];
  const lines: string[] = [];

  lines.push(csvRow([...header, ...RESULT_NEW_COLUMNS]));

  input.originalRows.forEach((originalCells, index) => {
    let cells = originalCells;
    if (cells.length > header.length) {
      // 列数超过表头宽度：多出来的列位已错位，截到表头宽度并显式报告，不静默丢
      truncatedRows.push({ rowNumber: index + 2, cellCount: cells.length });
      cells = cells.slice(0, header.length);
    }
    const padded = padToWidth(cells, header.length);
    const added = input.newColumns[index] as ResultNewColumnValues;
    lines.push(
      csvRow([
        ...padded,
        added.hospitalValue,
        added.diff,
        added.suggested,
        added.confirm,
        added.aiNote,
      ]),
    );
  });

  const bodyRows = input.originalRows.length;
  const footer: string[][] = [];

  // ── 推送回执区 ──
  const counts = input.receipt.counts;
  footer.push([
    RECEIPT_BLOCK_TITLE,
    `明细字段：${RECEIPT_DETAIL_FIELDS}`,
  ]);
  footer.push([
    `批次键=${input.receipt.batchKey} ｜推送时刻=${input.receipt.pushedAt ?? '未推送'} ｜检索参数串=${input.receipt.searchParams} ｜已推送=${counts.pushed} ｜待确认=${counts.pendingConfirm} ｜失败=${counts.failed} ｜待重试=${counts.pendingRetry} ｜缺行=${counts.missingRows} ｜问题行=${counts.issueRows}`,
  ]);
  for (const detail of input.receipt.details) {
    footer.push([
      detail.registryId ?? '',
      String(detail.rowNumber),
      detail.status,
      detail.reason ?? '',
      detail.idempotencyKey ?? '',
      String(detail.attempts),
      detail.pushedAt ?? '',
    ]);
  }

  // ── 缺行区（只追加，不插入正文）──
  footer.push([MISSING_BLOCK_TITLE, `明细字段：${MISSING_DETAIL_FIELDS}`]);
  footer.push([`缺行=${input.missingRows.length} ｜不自动入表，需登记员人工核对后补行`]);
  for (const row of input.missingRows) {
    footer.push([row.registryId, row.source, row.status, row.confirmValue]);
  }

  const footerLines = footer.length;
  for (const row of footer) {
    lines.push(csvRow(padToWidth(row, columnCount)));
  }

  const text = `${lines.join(lineEnding === 'crlf' ? '\r\n' : '\n')}${
    lineEnding === 'crlf' ? '\r\n' : '\n'
  }`;

  return {
    text,
    header: [...header, ...RESULT_NEW_COLUMNS],
    columnCount,
    bodyRows,
    footerLines,
    totalLines: lines.length,
    truncatedRows,
  };
}

/** 原子写：先写临时文件再 rename；失败删临时文件，目标文件保持原样。 */
function writeAtomically(targetPath: string, data: Buffer): void {
  const absolute = resolve(targetPath);
  try {
    writeFileAtomically(absolute, data);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ResultFileError(`写出结果表失败：${absolute}`, [
      message,
      '请确认目标目录存在且可写；写出失败时原结果表保持原样',
    ]);
  }
}

/** 一致性核对结果。 */
interface ColumnCheck {
  originalColumnsMatch: boolean;
  humanSuppliedColumnsUnchanged: boolean;
  checkedRows: number;
  issues: string[];
}

/**
 * 逐行核对输出里的原表列与输入是否完全一致。
 *
 * 核对两件事：
 * - 每一行的原表列（表头宽度那一段）与输入逐格相同；
 * - 人工补充列逐字节不变（这一列登记员自己填，插件只读不覆盖）。
 */
function checkOriginalColumns(
  text: string,
  expectedRows: string[][],
  humanSuppliedIndexes: number[],
): ColumnCheck {
  const issues: string[] = [];
  const parsed = parseCsv(text);
  const body = parsed.slice(1, 1 + expectedRows.length);

  let originalColumnsMatch = true;
  let humanSuppliedColumnsUnchanged = true;

  expectedRows.forEach((expected, index) => {
    const actual = body[index] ?? [];
    for (let column = 0; column < expected.length; column += 1) {
      const got = actual[column];
      if (got !== expected[column]) {
        originalColumnsMatch = false;
        issues.push(
          `第 ${index + 2} 行第 ${column + 1} 列不一致：期望「${expected[column]}」，实际「${got ?? ''}」`,
        );
      }
    }
    for (const column of humanSuppliedIndexes) {
      const got = actual[column];
      if (got !== expected[column]) {
        humanSuppliedColumnsUnchanged = false;
        issues.push(
          `第 ${index + 2} 行人工补充列第 ${column + 1} 列被改动：期望「${expected[column]}」，实际「${got ?? ''}」`,
        );
      }
    }
  });

  return {
    originalColumnsMatch,
    humanSuppliedColumnsUnchanged,
    checkedRows: expectedRows.length,
    issues,
  };
}

/** 把文本里该编码无法表示的字符替换成 '?'（GBK 情形下用于生成回读后的期望值）。 */
function substituteUnmappable(text: string, unmappable: string[]): string {
  if (unmappable.length === 0) return text;
  const set = new Set(unmappable);
  let output = '';
  for (const char of text) {
    output += set.has(char) ? '?' : char;
  }
  return output;
}

/**
 * 原表行在结果表里的实际形态：截到表头宽度（超宽行的多余列位已错位）并补齐空列。
 *
 * 超宽行不是静默丢的：buildResultTable 把它们记进 truncatedRows 交给上层报告，
 * 读表层也早就给这类行打了 COLUMN_COUNT_MISMATCH 的行级错误码。
 */
function effectiveOriginalRows(input: ResultFileInput): string[][] {
  const width = input.header.length;
  return input.originalRows.map((cells) => padToWidth(cells, width));
}

/**
 * 把结果表写到磁盘：组装 → 自检 → 原子写 → 回读复核。
 *
 * 自检在落盘前先做一遍（表头、原表列逐行一致），落盘后再回读文件核对一遍；
 * 任何一处对不上都显式报错，不会留下一张「看着像对的」表。
 *
 * @param input 原表行 + 新列 + 表尾两区
 * @param outputPath 目标文件路径
 * @param options 编码 / 行尾 / BOM
 */
export function writeResultFile(
  input: ResultFileInput,
  outputPath: string,
  options: ResultFileOptions = {},
): ResultFileWriteResult {
  const encoding = options.encoding ?? 'utf-8';
  const lineEnding = options.lineEnding ?? 'crlf';
  const bom = options.bom ?? encoding === 'utf-8';

  const built = buildResultTable(input, { ...options, lineEnding, encoding });

  const humanSuppliedIndexes = (input.humanSuppliedColumns ?? [])
    .map((name) => input.header.indexOf(name))
    .filter((index) => index >= 0);

  const expectedRows = effectiveOriginalRows(input);

  // 落盘前自检：表头与原表列
  const precheck = checkOriginalColumns(built.text, expectedRows, humanSuppliedIndexes);
  if (!precheck.originalColumnsMatch) {
    throw new ResultFileError('结果表自检未通过：原表列与输入不一致', precheck.issues);
  }

  const encoded = encodeSheetText(built.text, encoding, bom);

  writeAtomically(outputPath, encoded.buffer);

  // 回读复核：读回来的内容必须与预期完全一致
  let readBack: string;
  try {
    readBack = decodeEncodedSheet(readFileSync(outputPath), encoding);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ResultFileError(`回读结果表失败：${outputPath}`, [message]);
  }

  if (readBack !== encoded.decodedEquivalent) {
    throw new ResultFileError('结果表回读校验未通过：文件内容与写出内容不一致', [
      `文件：${outputPath}`,
      '请检查磁盘写入是否被外部程序改写',
    ]);
  }

  const decodedExpectedRows = expectedRows.map((cells) =>
    cells.map((cell) => substituteUnmappable(cell, encoded.unmappableCharacters)),
  );
  const postcheck = checkOriginalColumns(readBack, decodedExpectedRows, humanSuppliedIndexes);
  if (!postcheck.originalColumnsMatch || !postcheck.humanSuppliedColumnsUnchanged) {
    throw new ResultFileError('结果表回读校验未通过：原表列与输入不一致', postcheck.issues);
  }

  return {
    outputPath: resolve(outputPath),
    encoding,
    lineEnding,
    bom: encoding === 'utf-8' ? bom : false,
    columnCount: built.columnCount,
    bodyRows: built.bodyRows,
    footerLines: built.footerLines,
    totalLines: built.totalLines,
    unmappableCharacters: encoded.unmappableCharacters,
    verification: {
      headerMatches: true,
      originalColumnsMatch: postcheck.originalColumnsMatch,
      humanSuppliedColumnsUnchanged: postcheck.humanSuppliedColumnsUnchanged,
      checkedRows: postcheck.checkedRows,
    },
    truncatedRows: built.truncatedRows,
  };
}
