/**
 * 行规范化：把二维数组变成「可参与比对的行」。
 *
 * 这一层是脏行的守门人。原则只有一条：**任何一行都不静默丢弃，任何一处问题都
 * 显式落到行级错误码上**，登记员能一行一行看到哪里不对、该怎么改。
 *
 * 处理的几类脏行：
 * - 空行：整行全空（导出尾部常见）→ 跳过并计数，不算数据行
 * - 列数不符：表头 6 列、这行 5 列 → 列位可能已错位，本行**阻断比对**，
 *   但行本身保留在结果里，登记员看得见这一行被挡下了
 * - 缺登记号：无法与院内记录绑定 → 阻断比对
 * - 重复登记号：同一登记号多行，与院内记录绑定会歧义 → 阻断比对，全部相关行都标
 *
 * 人工补充列（随访电话、生活方式备注等）打 `humanSupplied` 标记传给下游，
 * 写回层据此强制跳过。
 */
import {
  type FieldValue,
  type RowIssue,
} from '../contract/index.js';

import type { ColumnMapping } from './column-mapping.js';
import { normalizeCell, type NormalizedCell } from './normalize.js';

/** 规范化后的一行。 */
export interface SheetRow {
  /** 表内行号（1 基，含表头行；表头是第 1 行，首个数据行是第 2 行） */
  rowNumber: number;
  /** 登记主索引（脱敏占位标识）；缺登记号时为 null */
  registryId: string | null;
  /** 口径字段名 → 归一化单元格 */
  cells: Record<string, NormalizedCell>;
  /** 源列名 → 原始字符串（原表内容，供写回层逐行一致性校验） */
  rawByColumn: Record<string, string>;
  /** 本行的人工补充列（源列名），写回层必须跳过 */
  humanSuppliedColumns: string[];
  /** 本行的行级问题 */
  issues: RowIssue[];
  /** 登记号是否在本表重复 */
  duplicate: boolean;
  /** 是否被阻断（有阻断性问题，本行不产出差异值、不进推送体） */
  blocked: boolean;
}

/** 一批行的统计。 */
export interface RowStats {
  /** 读到的数据行数（含被跳过的空行之前的计数口径见下） */
  total: number;
  /** 跳过的空行数 */
  skippedEmpty: number;
  /** 正常可参与比对的行数 */
  usable: number;
  /** 被阻断的行数 */
  blocked: number;
  /** 缺登记号的行数 */
  missingRegistryId: number;
  /** 重复登记号的行数 */
  duplicate: number;
}

/** 一批规范化的结果。 */
export interface NormalizedRows {
  rows: SheetRow[];
  issues: RowIssue[];
  stats: RowStats;
}

export interface BuildRowsInput {
  /** 表头（源列名） */
  header: string[];
  /** 数据行（原始字符串数组） */
  rows: string[][];
  /** 列映射配置 */
  mapping: ColumnMapping;
}

/** 整行是否全空（导出尾部常见的空行）。 */
function isBlankRow(row: string[]): boolean {
  return row.every((cell) => cell.trim().length === 0);
}

/** 登记号取值：归一后的值转字符串。 */
function registryIdOf(value: FieldValue): string | null {
  if (value === null) return null;
  const text = String(value).trim();
  return text.length === 0 ? null : text;
}

/**
 * 把二维数组变成规范化行。
 *
 * @param input 表头、数据行与列映射配置
 * @returns 规范化行、行级问题与统计
 */
export function buildRows(input: BuildRowsInput): NormalizedRows {
  const { header, rows, mapping } = input;
  const headerLength = header.length;

  const columnIndex = new Map<string, number>();
  header.forEach((name, index) => {
    if (!columnIndex.has(name)) {
      columnIndex.set(name, index);
    }
  });

  const registryIdIndex = columnIndex.get(mapping.registryIdColumn);
  const result: SheetRow[] = [];
  const issues: RowIssue[] = [];
  let skippedEmpty = 0;

  rows.forEach((rawRow, rowIndex) => {
    const rowNumber = rowIndex + 2; // 表头占第 1 行

    if (isBlankRow(rawRow)) {
      skippedEmpty += 1;
      return;
    }

    const rowIssues: RowIssue[] = [];

    // 列数不符：列位可能整体错位，本行阻断比对，但行本身保留
    const columnCountMismatch = rawRow.length !== headerLength;
    if (columnCountMismatch) {
      rowIssues.push({
        rowNumber,
        registryId: null,
        code: 'COLUMN_COUNT_MISMATCH',
        reason: `第 ${rowNumber} 行有 ${rawRow.length} 个单元格，表头是 ${headerLength} 列`,
        hint: '该行列位可能已错位，本行不参与比对，请核对分列后重跑',
        blocking: true,
      });
    }

    const cells: Record<string, NormalizedCell> = {};
    const rawByColumn: Record<string, string> = {};
    const humanSuppliedColumns: string[] = [];

    for (const entry of mapping.columns) {
      const index = columnIndex.get(entry.sourceColumn);
      if (index === undefined) continue; // 配置里声明了但本表没有 → 本轮不参与比对

      const raw = rawRow[index] ?? '';
      rawByColumn[entry.sourceColumn] = raw;
      cells[entry.field] = normalizeCell(raw);

      if (entry.humanSupplied) {
        humanSuppliedColumns.push(entry.sourceColumn);
      }
    }

    // 登记主索引
    let registryId: string | null = null;
    if (registryIdIndex !== undefined) {
      const raw = rawRow[registryIdIndex] ?? '';
      rawByColumn[mapping.registryIdColumn] = raw;
      registryId = registryIdOf(normalizeCell(raw).value);
    }
    if (registryId === null) {
      rowIssues.push({
        rowNumber,
        registryId: null,
        code: 'MISSING_REGISTRY_ID',
        reason: `第 ${rowNumber} 行缺少登记号`,
        hint: '补齐登记号后重跑；缺登记号的行无法与院内记录绑定',
        blocking: true,
      });
    }

    result.push({
      rowNumber,
      registryId,
      cells,
      rawByColumn,
      humanSuppliedColumns,
      issues: rowIssues,
      duplicate: false,
      blocked: rowIssues.some((issue) => issue.blocking),
    });
  });

  // 重复登记号：全部相关行都标出来，登记员才知道要合并哪几行
  const byRegistryId = new Map<string, SheetRow[]>();
  for (const row of result) {
    if (row.registryId === null) continue;
    const group = byRegistryId.get(row.registryId) ?? [];
    group.push(row);
    byRegistryId.set(row.registryId, group);
  }
  for (const [registryId, group] of byRegistryId) {
    if (group.length < 2) continue;
    for (const row of group) {
      row.duplicate = true;
      row.blocked = true;
      row.issues.push({
        rowNumber: row.rowNumber,
        registryId,
        code: 'DUPLICATE_REGISTRY_ID',
        reason: `登记号 ${registryId} 在本表出现 ${group.length} 次`,
        hint: '同一登记号多行会与院内记录产生歧义，请合并或删除重复行后重跑',
        blocking: true,
      });
    }
  }

  for (const row of result) {
    issues.push(...row.issues);
  }

  const stats: RowStats = {
    total: result.length + skippedEmpty,
    skippedEmpty,
    usable: result.filter((row) => !row.blocked).length,
    blocked: result.filter((row) => row.blocked).length,
    missingRegistryId: result.filter((row) => row.registryId === null).length,
    duplicate: result.filter((row) => row.duplicate).length,
  };

  return { rows: result, issues, stats };
}

/** 本层会用到的行级问题码（取自契约，保证下游按同一套错误码归集）。 */
export const SHEET_ROW_ISSUE_CODES = [
  'COLUMN_COUNT_MISMATCH',
  'MISSING_REGISTRY_ID',
  'DUPLICATE_REGISTRY_ID',
] as const;
