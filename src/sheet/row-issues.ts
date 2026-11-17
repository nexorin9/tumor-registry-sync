/**
 * 行级问题统一归集与本批问题清单。
 *
 * 一批表里会同时冒出来好几类问题：读表阶段发现的脏行（列数不符、缺登记号、
 * 登记号重复），检索阶段发现的问题（院内缺关键字段、响应不是 JSON、命中多条、
 * 院内无此记录）。它们此前散在链路两侧，登记员要自己拼成一张清单才能动手改。
 *
 * 本模块把它们**归成一套**：同一个行级问题结构、同一个按错误码的分布、
 * 同一张待人工处理清单。
 *
 * 三条纪律：
 * - **不静默丢弃**：每一行的问题都要进清单。被读表层挡下的行也要写明「为什么
 *   被挡下」，不能悄悄从结果里消失；归集后另有覆盖守卫（gaps）兜底。
 * - **不静默改值**：本模块只读行与问题，不碰任何单元格取值。归集全程不改原表。
 * - **不含可识别明报**：清单只写登记主索引占位标识（如 REG-0001）；文本里出现
 *   手机号 / 身份证号 / 邮箱形态时，落盘前一律脱敏。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  ROW_ISSUE_LABELS,
  type RowIssue,
  type RowIssueCode,
  type RowIssueDistributionEntry,
  type RowIssueSummary,
} from '../contract/index.js';

import { writeFileAtomically } from './atomic.js';
import { decodeEncodedSheet, encodeSheetText, type OutputEncoding } from './encode.js';
import { csvEscape } from './result-file.js';

/** 待人工处理清单的表头（固定顺序，登记员照着列看）。 */
export const MANUAL_CHECKLIST_HEADER = [
  '行号',
  '登记号',
  '错误码',
  '问题',
  '原因',
  '处置建议',
  '是否阻断推送',
] as const;

/** 清单相关错误：message 点名具体位置与下一步。 */
export class RowIssueError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(issues.length > 0 ? `${message}：${issues.join('；')}` : message);
    this.name = 'RowIssueError';
    this.issues = issues;
  }
}

/** 一行及其身上的行级问题（读表链与检索链的最小公共形状）。 */
export interface IssueBearingRow {
  /** 表内行号（1 基，含表头行） */
  rowNumber: number;
  /** 登记主索引（脱敏占位标识）；缺登记号时为 null */
  registryId: string | null;
  /** 该行身上的行级问题 */
  issues: readonly RowIssue[];
}

/** 归集输入：读表链与检索链各给一份行即可。 */
export interface BatchIssueInput {
  /** 读表链产出的行（脏行问题挂在行上） */
  sheetRows?: readonly IssueBearingRow[];
  /** 检索链产出的行 */
  lookupRows?: readonly IssueBearingRow[];
}

/** 覆盖缺口：某行的问题没有出现在归集结果里（正常情况下不应出现）。 */
export interface IssueCoverageGap {
  /** 表内行号 */
  rowNumber: number;
  /** 登记主索引 */
  registryId: string | null;
  /** 漏掉的错误码 */
  missingCodes: RowIssueCode[];
}

/** 归集结果。 */
export interface BatchIssues {
  /** 归集后的全部行级问题（已去重、已按行号排序） */
  issues: RowIssue[];
  /** 本批问题汇总（问题行数 + 按错误码分布） */
  summary: RowIssueSummary;
  /** 覆盖守卫发现的遗漏；正常为空数组 */
  gaps: IssueCoverageGap[];
}

/** 清单的一行（面向登记员，字段值已脱敏）。 */
export interface ManualChecklistRow {
  /** 表内行号 */
  rowNumber: number;
  /** 登记主索引（脱敏占位标识） */
  registryId: string | null;
  /** 错误码 */
  code: RowIssueCode;
  /** 中文标签 */
  label: string;
  /** 原因（已脱敏） */
  reason: string;
  /** 处置建议（已脱敏） */
  hint: string;
  /** 是否阻断推送 */
  blocking: boolean;
}

/** 清单落盘选项。 */
export interface ManualChecklistOptions {
  /** 输出编码：utf-8（默认）或 gbk */
  encoding?: OutputEncoding;
  /** 行尾：crlf（默认，Excel 友好）或 lf */
  lineEnding?: 'crlf' | 'lf';
  /** UTF-8 输出是否带 BOM（默认带） */
  bom?: boolean;
}

/** 清单落盘结果。 */
export interface ManualChecklistWriteResult {
  /** 落盘路径 */
  outputPath: string;
  /** 实际使用的编码 */
  encoding: OutputEncoding;
  /** 实际使用的行尾 */
  lineEnding: 'crlf' | 'lf';
  /** 是否带 BOM */
  bom: boolean;
  /** 明细行数（不含表头） */
  rows: number;
  /** 总行数（含表头） */
  totalLines: number;
  /** 该编码下无法表示的字符（已替换为 '?'） */
  unmappableCharacters: string[];
  /** 回读自检结果 */
  verification: {
    /** 表头与预期一致 */
    headerMatches: boolean;
    /** 明细逐行与写出内容一致 */
    bodyMatches: boolean;
    /** 核对了多少行 */
    checkedRows: number;
  };
}

/* ─────────────────────── 脱敏 ─────────────────────── */

/** 身份证号形态：18 位（末位可 X）或 15 位，前后不接数字/字母。 */
const ID_CARD_PATTERN = /(?<![0-9A-Za-z])(?:\d{17}[\dXx]|\d{15})(?![0-9A-Za-z])/g;

/** 手机号形态：11 位、以 1 开头，前后不接数字。 */
const PHONE_PATTERN = /(?<!\d)1\d{10}(?!\d)/g;

/** 邮箱形态。 */
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * 把文本里可能含可识别明报的片段脱敏。
 *
 * 只做形态匹配，不猜语义：手机号留前 3 后 4，身份证留前 6 后 4，邮箱只留域名。
 * 登记主索引这类占位标识（REG-0001）不受影响，原样保留 —— 它是本产品对人的唯一指认方式。
 */
export function redactIdentifiable(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(ID_CARD_PATTERN, (matched) =>
      matched.length === 18
        ? `${matched.slice(0, 6)}********${matched.slice(14)}`
        : `${matched.slice(0, 6)}*******${matched.slice(13)}`,
    )
    .replace(PHONE_PATTERN, (matched) => `${matched.slice(0, 3)}****${matched.slice(7)}`)
    .replace(EMAIL_PATTERN, (matched) => {
      const at = matched.indexOf('@');
      return `${matched.slice(0, 2)}***${matched.slice(at)}`;
    })
    .trim();
}

/* ─────────────────────── 归集 ─────────────────────── */

/** 问题去重键：同一行 + 同一错误码 + 同一原因算同一条。 */
function issueKey(issue: RowIssue): string {
  return `${issue.rowNumber}|${issue.code}|${issue.reason}`;
}

/** 把一行身上的问题归一：行号与登记号以行为准（行上的才是权威）。 */
function normalizeIssue(issue: RowIssue, row: IssueBearingRow): RowIssue {
  return {
    rowNumber: row.rowNumber,
    registryId: row.registryId ?? issue.registryId,
    code: issue.code,
    reason: issue.reason,
    hint: issue.hint,
    blocking: issue.blocking,
  };
}

/**
 * 归集一批的行级问题。
 *
 * 读表链与检索链的问题合到一处，按行号排序；同一行同一原因只留一条。
 * 归集过程只读不写：不碰任何单元格取值。
 *
 * @param input 读表链与检索链的行
 */
export function collectBatchIssues(input: BatchIssueInput): BatchIssues {
  const issues: RowIssue[] = [];
  const seen = new Set<string>();
  const rows: IssueBearingRow[] = [...(input.sheetRows ?? []), ...(input.lookupRows ?? [])];

  for (const row of rows) {
    for (const raw of row.issues) {
      const issue = normalizeIssue(raw, row);
      const key = issueKey(issue);
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push(issue);
    }
  }

  issues.sort((a, b) => {
    if (a.rowNumber !== b.rowNumber) return a.rowNumber - b.rowNumber;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0;
  });

  return {
    issues,
    summary: summarizeRowIssues(issues),
    gaps: findCoverageGaps(rows, issues),
  };
}

/**
 * 覆盖守卫：每一行身上的每个错误码都应当出现在归集结果里。
 *
 * 返回遗漏清单（正常为空）。它的作用是让「不静默丢弃」可核对 —— 哪一行的哪个
 * 问题没进清单，一眼就能指出来，而不是等登记员发现少了一行。
 */
export function findCoverageGaps(
  rows: readonly IssueBearingRow[],
  issues: readonly RowIssue[],
): IssueCoverageGap[] {
  const collected = new Map<number, Set<RowIssueCode>>();
  for (const issue of issues) {
    const set = collected.get(issue.rowNumber) ?? new Set<RowIssueCode>();
    set.add(issue.code);
    collected.set(issue.rowNumber, set);
  }

  const gaps: IssueCoverageGap[] = [];
  for (const row of rows) {
    const present = collected.get(row.rowNumber) ?? new Set<RowIssueCode>();
    const missing = [...new Set(row.issues.map((issue) => issue.code))].filter(
      (code) => !present.has(code),
    );
    if (missing.length === 0) continue;
    gaps.push({ rowNumber: row.rowNumber, registryId: row.registryId, missingCodes: missing });
  }
  return gaps;
}

/**
 * 汇总一批行级问题：问题行数 + 按错误码分布。
 *
 * 「行数」按行去重，「次数」按条目计 —— 一行缺两个院内字段就是 1 行、2 条。
 */
export function summarizeRowIssues(issues: readonly RowIssue[]): RowIssueSummary {
  const rows = new Set<number>();
  const byCode = new Map<
    RowIssueCode,
    { count: number; rows: Set<number>; blocking: number }
  >();
  let blockingIssues = 0;

  for (const issue of issues) {
    rows.add(issue.rowNumber);
    const entry = byCode.get(issue.code) ?? { count: 0, rows: new Set<number>(), blocking: 0 };
    entry.count += 1;
    entry.rows.add(issue.rowNumber);
    if (issue.blocking) {
      entry.blocking += 1;
      blockingIssues += 1;
    }
    byCode.set(issue.code, entry);
  }

  const entries: RowIssueDistributionEntry[] = [...byCode.entries()]
    .map(([code, value]) => ({
      code,
      label: ROW_ISSUE_LABELS[code],
      count: value.count,
      rows: value.rows.size,
      blocking: value.blocking,
    }))
    .sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
    });

  return {
    issueRows: rows.size,
    totalIssues: issues.length,
    blockingIssues,
    byCode: entries,
  };
}

/** 本批问题的一句话摘要（写进运行摘要与表尾回执区）。 */
export function formatIssueSummary(summary: RowIssueSummary): string {
  if (summary.totalIssues === 0) {
    return '本批没有行级问题。';
  }
  const items = summary.byCode.map((entry) => `${entry.label}（${entry.code}）×${entry.count}`);
  return `本批 ${summary.issueRows} 行有问题、共 ${summary.totalIssues} 条：${items.join('、')}；其中阻断推送 ${summary.blockingIssues} 条。`;
}

/* ─────────────────────── 清单 ─────────────────────── */

/**
 * 生成待人工处理清单（逐行一条，字段值已脱敏）。
 *
 * 清单是登记员动手改表的依据：哪一行、什么问题、为什么、该怎么改，一行一条。
 */
export function buildManualChecklist(issues: readonly RowIssue[]): ManualChecklistRow[] {
  return issues.map((issue) => ({
    rowNumber: issue.rowNumber,
    registryId: issue.registryId,
    code: issue.code,
    label: ROW_ISSUE_LABELS[issue.code],
    reason: redactIdentifiable(issue.reason),
    hint: redactIdentifiable(issue.hint),
    blocking: issue.blocking,
  }));
}

/** 一行清单 → 一行 CSV 文本。 */
function checklistCsvRow(row: ManualChecklistRow): string {
  return [
    String(row.rowNumber),
    row.registryId ?? '',
    row.code,
    row.label,
    row.reason,
    row.hint,
    row.blocking ? '是' : '否',
  ]
    .map(csvEscape)
    .join(',');
}

/** 清单组装结果（尚未落盘）。 */
export interface BuiltManualChecklist {
  /** 清单文本 */
  text: string;
  /** 表头 */
  header: string[];
  /** 明细行数（不含表头） */
  rows: number;
  /** 总行数（含表头） */
  totalLines: number;
}

/**
 * 组装待人工处理清单文本（纯函数，不落盘）。
 *
 * 表头固定七列：行号 / 登记号 / 错误码 / 问题 / 原因 / 处置建议 / 是否阻断推送。
 */
export function buildManualChecklistCsv(
  issues: readonly RowIssue[],
  options: ManualChecklistOptions = {},
): BuiltManualChecklist {
  const lineEnding = options.lineEnding ?? 'crlf';
  const rows = buildManualChecklist(issues);
  const header = [...MANUAL_CHECKLIST_HEADER];
  const lines = [header.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(checklistCsvRow(row));
  }
  const separator = lineEnding === 'crlf' ? '\r\n' : '\n';
  return {
    text: `${lines.join(separator)}${separator}`,
    header,
    rows: rows.length,
    totalLines: lines.length,
  };
}

/**
 * 把待人工处理清单写到磁盘（原子写 + 回读自检）。
 *
 * 写出失败不留半文件；写完读回来核对表头与明细，对不上就报错。
 *
 * @param issues 归集后的行级问题
 * @param outputPath 目标文件路径
 * @param options 编码 / 行尾 / BOM
 */
export function writeManualChecklist(
  issues: readonly RowIssue[],
  outputPath: string,
  options: ManualChecklistOptions = {},
): ManualChecklistWriteResult {
  const encoding = options.encoding ?? 'utf-8';
  const lineEnding = options.lineEnding ?? 'crlf';
  const bom = options.bom ?? encoding === 'utf-8';

  const built = buildManualChecklistCsv(issues, { ...options, lineEnding, encoding });
  const encoded = encodeSheetText(built.text, encoding, bom);

  try {
    writeFileAtomically(outputPath, encoded.buffer);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RowIssueError(`写出待人工处理清单失败：${resolve(outputPath)}`, [
      message,
      '请确认目标目录存在且可写；写出失败时不会留下半截清单',
    ]);
  }

  let readBack: string;
  try {
    readBack = decodeEncodedSheet(readFileSync(outputPath), encoding);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RowIssueError(`回读待人工处理清单失败：${outputPath}`, [message]);
  }

  if (readBack !== encoded.decodedEquivalent) {
    throw new RowIssueError('待人工处理清单回读校验未通过：文件内容与写出内容不一致', [
      `文件：${outputPath}`,
      '请检查磁盘写入是否被外部程序改写',
    ]);
  }

  const backLines = readBack.split(lineEnding === 'crlf' ? '\r\n' : '\n');
  const headerMatches = (backLines[0] ?? '') === built.header.map(csvEscape).join(',');
  const expectedRows = buildManualChecklist(issues);
  const bodyMatches =
    backLines.length >= built.totalLines &&
    backLines
      .slice(1, 1 + built.rows)
      .every((line, index) => line === checklistCsvRow(expectedRows[index] as ManualChecklistRow));

  if (!headerMatches || !bodyMatches) {
    throw new RowIssueError('待人工处理清单回读校验未通过：内容与预期不一致', [
      `文件：${outputPath}`,
      '请检查磁盘写入是否被外部程序改写',
    ]);
  }

  return {
    outputPath: resolve(outputPath),
    encoding,
    lineEnding,
    bom: encoding === 'utf-8' ? bom : false,
    rows: built.rows,
    totalLines: built.totalLines,
    unmappableCharacters: encoded.unmappableCharacters,
    verification: {
      headerMatches,
      bodyMatches,
      checkedRows: built.rows,
    },
  };
}
