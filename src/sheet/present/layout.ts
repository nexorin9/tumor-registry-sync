/**
 * 表内呈现 · 布局层。
 *
 * 这一层只决定「列摆在哪、差异格染什么底色、表尾两块叫什么、确认列下拉有哪些」，
 * **不碰任何业务语义**：差异怎么算、确认怎么判、推不推，全在引擎里。这里取色也
 * 一律来自 tokens.ts 的 token —— 八个状态各有唯一色值，宏与写回层照同一份上色。
 *
 * 固定的五列（物理列序固定，永远追加在原表列之后）：
 *   院内值 / 差异 / 建议值 / 确认 / AI 说明
 */
import type { ConfirmValue, RowStatus } from '../../contract/index.js';

import { CONFIRM_VALUE_BADGES, STATUS_TOKENS } from './tokens.js';

/** 结果表新增的五列（列序固定，原表列一个都不动）。 */
export const APPENDED_COLUMNS = ['院内值', '差异', '建议值', '确认', 'AI说明'] as const;

/** 一张表的列布局。 */
export interface ColumnLayout {
  /** 原表列（顺序不变，原样透传） */
  originalColumns: string[];
  /** 追加列（固定顺序） */
  appendedColumns: readonly string[];
  /** 确认列下拉白名单 */
  confirmDropdown: ConfirmValue[];
  /** 「差异」列的列下标（0 基，含原表列） */
  diffColumnIndex: number;
  /** 「确认」列的列下标（0 基，含原表列） */
  confirmColumnIndex: number;
}

/**
 * 根据原表表头算整张表的列布局。
 *
 * 原表列顺序完全不动；追加列按 APPENDED_COLUMNS 固定顺序排在末尾；
 * 确认下拉固定四值；差异列 / 确认列的下标由「原表列数 + 追加列内下标」推出。
 */
export function buildLayout(originalHeader: string[]): ColumnLayout {
  const originalColumns = [...originalHeader];
  const appendedColumns = APPENDED_COLUMNS;
  const confirmDropdown: ConfirmValue[] = ['待确认', '采纳', '不采纳', '无需确认'];

  const appendedOffset = originalHeader.length;
  const diffColumnIndex = appendedOffset + appendedColumns.indexOf('差异');
  const confirmColumnIndex = appendedOffset + appendedColumns.indexOf('确认');

  return {
    originalColumns,
    appendedColumns,
    confirmDropdown,
    diffColumnIndex,
    confirmColumnIndex,
  };
}

const TRANSPARENT = 'transparent';

/**
 * 差异列单元格的底色。
 *
 * 规则（色值一律取自 tokens.ts，本层不写裸色）：
 * - 无差异（hasDiff=false）→ 不填充（transparent）。
 * - 一致 / 无需确认 → 不填充（与院内一致，登记员无需处理）。
 * - 其余状态（差异 / 待确认 / 采纳 / 需人工判定 / 命中歧义 / 院内已变更 / 零命中）→
 *   取对应状态 token 的底色（warning 族偏黄、danger 族偏红、manual 族偏紫、info 族偏灰）。
 *   具体的「黄 / 橙红 / 灰」由 token 的 background 决定，本函数不另起一份色板。
 *
 * @param status 行状态（contract 的 RowStatus，含呈现层八态与生命周期态）
 * @param hasDiff 本行是否真有差异操作（operations.length > 0）
 */
export function diffCellFill(
  status: RowStatus,
  hasDiff: boolean,
): { fill: string; note: string } {
  if (!hasDiff) {
    return { fill: TRANSPARENT, note: '本行无差异操作，差异列不填充底色' };
  }
  if (status === '一致' || status === '无需确认') {
    return { fill: TRANSPARENT, note: '本行与院内一致，无需填充' };
  }

  // 呈现层八态：直接取 token 底色（note 含状态名 + 中文 description）。
  const token = (STATUS_TOKENS as Record<string, { background: string; description: string }>)[status];
  if (token && token.background) {
    return { fill: token.background, note: `${status}：${token.description}` };
  }

  // RowStatus 中仅出现在确认列的取值（采纳 等）：用确认徽标底色。
  const confirmBadge = (CONFIRM_VALUE_BADGES as Record<string, { background: string }>)[status];
  if (confirmBadge) {
    return { fill: confirmBadge.background, note: `确认取值「${status}」，按确认徽标上色` };
  }

  return { fill: TRANSPARENT, note: '未识别状态，差异列不填充' };
}

/**
 * 表尾两块区块的标题行文案（写回层与宏侧共用同一份）。
 *
 * - 推送回执：本批推了什么、成功失败各多少。
 * - 院内命中但本表缺行：院内有、本表没有的登记号只追加在这里，不混进正文。
 */
export function tailBlockLayout(): { receiptTitleRow: string; missingTitleRow: string } {
  return {
    receiptTitleRow: '推送回执',
    missingTitleRow: '院内命中但本表缺行',
  };
}

const CONFIRM_WHITELIST: readonly ConfirmValue[] = ['待确认', '采纳', '不采纳', '无需确认'];

/** 确认列取值白名单校验：仅四值放行，其余一律 false（类型收窄为 ConfirmValue）。 */
export function confirmColumnValidation(value: string): value is ConfirmValue {
  return (CONFIRM_WHITELIST as readonly string[]).includes(value);
}
