/**
 * 表内呈现层统一出口。
 *
 * tokens：设计 token 与语义色板（色值、字号层级、列宽、间距栅格、状态映射）
 * 后续的 layout（列位与表尾版面）、states（加载/空/错误三态）都从这一层取 token，
 * 两个宏宿主（Excel VBA / WPS JSA）也照同一份 token 上色。
 */
export * from './tokens.js';

export {
  APPENDED_COLUMNS,
  buildLayout,
  diffCellFill,
  tailBlockLayout,
  confirmColumnValidation,
} from './layout.js';
export type { ColumnLayout } from './layout.js';

export {
  renderLoadingState,
  renderEmptyState,
  renderErrorState,
  repeatRunConfirmation,
  completionFeedback,
} from './states.js';
export type { PresentState } from './states.js';
