/**
 * 表内呈现 · 写回构建层。
 *
 * 把引擎的 align 结果（逐行 AlignRowResult）与表尾两区（ReceiptBlock / MissingRow[]）
 * 组装成「一张真实结果表」的内存形态：原表列一个字节都不改、五列新列追加在末尾、
 * 差异列按状态上底色、缺行只追加在表尾不进正文、人工补充列逐字节保护。
 *
 * 三条硬规矩（与 result-file.ts 同口径）：
 * - 原表列只读不覆盖：本层只追加，绝不写原表列；protectHumanSuppliedColumns 兜底自检。
 * - 缺行只追加：院内命中但本表缺的登记号只出现在表尾缺行区，绝不混进正文行。
 * - 失败不留半张表：本层只产出内存结构，落盘与原子写由 result-file.ts 负责。
 */
import type {
  AlignRowResult,
  CellValue,
  MissingRow,
  ReceiptBlock,
} from '../contract/index.js';

import { APPENDED_COLUMNS, buildLayout, diffCellFill } from './present/layout.js';

/** 一行写回结果（单元格数组）。 */
export interface WritebackRow {
  cells: CellValue[];
}

/** 整张写回结果表的内存形态。 */
export interface WritebackResult {
  /** 表头 = 原表列 + 五列新列 */
  header: string[];
  /** 数据行（含追加列，原表列原样在前） */
  rows: CellValue[][];
  /** 差异列底色的单元格坐标（只上在差异列，绝不染原表列） */
  fills: { rowIndex: number; colIndex: number; fill: string }[];
}

/**
 * 把 align 逐行结果组装成写回结果表。
 *
 * - header = 原表表头 + 五列固定追加列。
 * - 每一行：原表单元格原样在前，依次追加 院内值 / 差异 / 建议值 / 确认 / AI说明。
 * - 差异列底色：按 diffCellFill(status, hasDiff) 上色，hasDiff = operations.length > 0；
 *   只给差异列下标加 fills，原表列一律不上底色。
 * - 原表表头与单元格**只读取、不修改**：所有行都是新建数组，原引用保持不变。
 */
export function buildWritebackResult(
  originalHeader: string[],
  originalRows: CellValue[][],
  alignRows: AlignRowResult[],
): WritebackResult {
  const header = [...originalHeader, ...APPENDED_COLUMNS];
  const layout = buildLayout(originalHeader);

  const rows: CellValue[][] = [];
  const fills: { rowIndex: number; colIndex: number; fill: string }[] = [];

  originalRows.forEach((originalRow, index) => {
    const align = alignRows[index];

    const hospitalText = align
      ? Object.values(align.hospitalValues)
          .map((value) => (value === null ? '' : String(value)))
          .join('；')
      : '';
    const diffText: CellValue = align ? align.diffText : '';
    const suggestedText: CellValue = align ? align.suggestedText : '';
    const confirmValue: CellValue = align ? align.confirmValue : '待确认';
    const aiNote: CellValue = align ? align.aiNote : '';

    // 新建一行：原表单元格浅拷贝在前，五列追加在后。原表数组不被改动。
    const newRow: CellValue[] = [
      ...originalRow,
      hospitalText,
      diffText,
      suggestedText,
      confirmValue,
      aiNote,
    ];
    rows.push(newRow);

    if (align) {
      const hasDiff = align.operations.length > 0;
      const { fill } = diffCellFill(align.status, hasDiff);
      // 只有真正需要上色的（非 transparent）才记录，且只上在差异列。
      if (fill !== 'transparent') {
        fills.push({ rowIndex: index, colIndex: layout.diffColumnIndex, fill });
      }
    }
  });

  return { header, rows, fills };
}

/**
 * 在正文数据行之后追加表尾两块：推送回执区 + 院内命中但本表缺行区。
 *
 * 推送回执区：标题行『推送回执』→ 计数行（批次键 / 已推送数 / 待确认数 / 失败数 /
 * 待重试 / 推送时刻）→ 逐行一条回执明细。
 * 缺行区：标题行『院内命中但本表缺行』→ 逐行一条（登记号 / 来源 / 状态 / 确认）。
 *
 * 缺行只追加、不插入正文、绝不自动入表。返回的是新数组，不改动入参 `rows`。
 */
export function appendTailBlocks(
  rows: CellValue[][],
  receipt: ReceiptBlock,
  missingRows: MissingRow[],
): CellValue[][] {
  const width = rows.length > 0 ? rows[0]!.length : 0;

  const pad = (cells: CellValue[]): CellValue[] => {
    const out = [...cells];
    while (out.length < width) out.push('');
    return out.slice(0, width);
  };

  const tail: CellValue[][] = [];

  // ── 推送回执区 ──
  tail.push(pad(['推送回执']));
  const counts = receipt.counts;
  tail.push(
    pad([
      '批次键',
      receipt.batchKey,
      '已推送数',
      counts.pushed,
      '待确认数',
      counts.pendingConfirm,
      '失败数',
      counts.failed,
      '待重试',
      counts.pendingRetry,
      '推送时刻',
      receipt.pushedAt ?? '',
    ]),
  );
  for (const detail of receipt.details) {
    tail.push(
      pad([
        detail.registryId ?? '',
        detail.rowNumber,
        detail.status,
        detail.reason ?? '',
        detail.idempotencyKey ?? '',
        detail.attempts,
        detail.pushedAt ?? '',
      ]),
    );
  }

  // ── 院内命中但本表缺行区（只追加，不自动入表）──
  tail.push(pad(['院内命中但本表缺行']));
  tail.push(pad([`缺行数=${missingRows.length}`, '不自动入表，需登记员人工核对后补行']));
  for (const missing of missingRows) {
    tail.push(pad([missing.registryId, missing.source, missing.status, missing.confirmValue]));
  }

  return [...rows, ...tail];
}

/**
 * 人工补充列保护自检（纯函数）。
 *
 * 写回层只在末尾追加新列，原表列（含人工补充列）逐字节不变。本函数校验：
 * - 声明的人工补充列是否都真实存在于表头中（不在表头里就无法保证不覆盖）；
 * - 每个数据行的人工补充列单元格都已存在（未缺失）。
 *
 * 全部通过 → { unchanged: true }；任何一项不满足 → { unchanged: false }。
 * 调用方可据此断言「写回从未覆盖人工补充列」。
 */
export function protectHumanSuppliedColumns(
  originalRows: CellValue[][],
  humanSuppliedColumns: string[],
  header: string[],
): { unchanged: boolean } {
  const indexes = humanSuppliedColumns
    .map((name) => header.indexOf(name))
    .filter((index) => index >= 0);

  // 有人工补充列不在表头里：写回无法保护它，直接判为未受保护。
  if (indexes.length !== humanSuppliedColumns.length) {
    return { unchanged: false };
  }

  for (const row of originalRows) {
    for (const columnIndex of indexes) {
      if (row[columnIndex] === undefined) {
        return { unchanged: false };
      }
    }
  }

  return { unchanged: true };
}
