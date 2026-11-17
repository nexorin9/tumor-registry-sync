/**
 * 表内呈现的设计 token 与语义色板。
 *
 * 这个产品没有网页，登记员看到的一切都发生在**一张表**里：底色、字重、列宽、
 * 表尾版式，全靠这套 token 定死。所以这一层必须先把「色、字、宽、间距」定下来，
 * 后面的布局层（layout）、状态层（states）、两个宏宿主都只从这里取值，
 * **任何一处都不许再写裸色值** —— 否则 Excel 宏与 WPS 宏画出来两张不一样的表。
 *
 * 几条硬规矩：
 * - **八个状态各有唯一色值**：一致 / 无需确认 / 待确认 / 差异 / 需人工判定 /
 *   零命中 / 命中歧义 / 院内已变更，需重查。色值两两不同，徽标文案面向登记员，
 *   不是给程序员看的状态名。
 * - **人工补充列与只读列有专属外观**：浅底 + 左侧色条 + 一句「不参与差异比对」
 *   的提示，登记员一眼知道哪些格不能被插件改。
 * - **表尾两个区块的版式固定**：区块标题行 + 计数行 + 明细行。缺行区只追加，
 *   绝不插进正文冒充登记员自己填的行。
 * - **颜色必须可达**：本产品只在 Excel / WPS 里渲染（VBA / JSA 的单元格填充与
 *   字体），因此 token 里只放单元格填充色、字体色、字号、列宽这类**真能在表格里
 *   做出来的**属性，不放渐变、阴影动画、图标库之类表格做不出来的效果。
 */
import {
  MISSING_BLOCK_TITLE as RESULT_MISSING_BLOCK_TITLE,
  MISSING_DETAIL_FIELDS as RESULT_MISSING_DETAIL_FIELDS,
  RECEIPT_BLOCK_TITLE as RESULT_RECEIPT_BLOCK_TITLE,
  RECEIPT_DETAIL_FIELDS as RESULT_RECEIPT_DETAIL_FIELDS,
} from '../result-file.js';

/** 表内呈现相关错误：message 里点名具体状态或色值，便于定位。 */
export class PresentationTokenError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(issues.length > 0 ? `${message}：${issues.join('；')}` : message);
    this.name = 'PresentationTokenError';
    this.issues = issues;
  }
}

/* ────────────────────────────── 色板 ────────────────────────────── */

/** 中性灰阶：文字、分隔线、浅底。 */
export const NEUTRAL = {
  /** 标题字（区块标题） */
  ink: '#1F2329',
  /** 正文字 */
  body: '#39414D',
  /** 辅助文字（说明、计数行） */
  secondary: '#646A73',
  /** 占位/禁用字 */
  placeholder: '#9AA0A8',
  /** 分隔线 */
  divider: '#D5D8DD',
  /** 浅底（人工补充列、区块计数行） */
  surface: '#F7F8FA',
  /** 更浅的底（斑马纹隔行） */
  surfaceMuted: '#FAFBFC',
  /** 画布（正文单元格默认底色） */
  canvas: '#FFFFFF',
} as const;

/** 语义色：主操作与四类状态提示。 */
export const SEMANTIC = {
  /** 主色：按钮、链接、选中态 */
  primary: '#1668DC',
  primaryHover: '#3D89F5',
  primaryActive: '#0E4FB0',
  primarySubtle: '#E8F1FD',
  /** 成功：已推送、已采纳 */
  success: '#3FA65A',
  successSubtle: '#E8F5EC',
  /** 警告：待确认、可重试 */
  warning: '#D89614',
  warningSubtle: '#FDF3DC',
  /** 危险：差异、失败 */
  danger: '#D93F3F',
  dangerSubtle: '#FBEAEA',
  /** 信息：零命中 */
  info: '#4B7BEC',
  infoSubtle: '#EAF0FD',
} as const;

/* ──────────────────────────── 状态 → 色/文案 ──────────────────────────── */

/**
 * 表内呈现层的八个标注状态。
 *
 * 与引擎层的行状态机（contract 里的 ROW_STATUSES，11 个）**不是一回事**：
 * 引擎状态管「这一行走到哪一步了」，呈现状态管「这个格子给登记员看什么颜色、
 * 什么字」。两个集合刻意分开，避免把「已推送」这种生命周期状态画成一种差异色。
 */
export const PRESENTATION_STATUSES = [
  '一致',
  '无需确认',
  '待确认',
  '差异',
  '需人工判定',
  '零命中',
  '命中歧义',
  '院内已变更，需重查',
] as const;

export type PresentationStatus = (typeof PRESENTATION_STATUSES)[number];

/** 一个状态在表内的完整外观。 */
export interface StatusToken {
  /** 状态标识 */
  status: PresentationStatus;
  /** 徽标文案：面向登记员，不含程序内部术语 */
  badge: string;
  /** 徽标文字色 */
  textColor: string;
  /** 单元格浅底色 */
  background: string;
  /** 强调色（左侧色条 / 边框），也是该状态的「主色」 */
  accent: string;
  /** 语义族：同族的两个状态用色深浅区分 */
  family: 'neutral' | 'info' | 'warning' | 'danger' | 'manual';
  /** 严重度：0 最轻（无需处理），3 最重（必须人工处理） */
  severity: 0 | 1 | 2 | 3;
  /** 给登记员看的一句话：这一格是什么意思 */
  description: string;
}

/**
 * 八个状态的映射表。
 *
 * 同族两色靠**深浅**分开而不是靠色相硬撞：
 * - 灰族：一致（深灰 #5F6672）/ 无需确认（浅灰 #9AA0A8）
 * - 橙族：命中歧义（浅橙 #E2733B）/ 院内已变更，需重查（深橙 #C2410C）
 * 这样登记员扫一眼就知道「同色系 = 同一类问题」，需要细看时靠徽标文案再分。
 */
export const STATUS_TOKENS: Record<PresentationStatus, StatusToken> = {
  一致: {
    status: '一致',
    badge: '与院内一致',
    textColor: '#4A5059',
    background: '#F2F3F5',
    accent: '#5F6672',
    family: 'neutral',
    severity: 0,
    description: '登记表这一格与院内权威记录相同，不需要处理。',
  },
  无需确认: {
    status: '无需确认',
    badge: '无需确认',
    textColor: '#6E747C',
    background: '#FAFAFB',
    accent: '#9AA0A8',
    family: 'neutral',
    severity: 0,
    description: '本行没有需要确认的差异，插件不会把它推送出去。',
  },
  待确认: {
    status: '待确认',
    badge: '待确认',
    textColor: '#8A5B00',
    background: '#FDF3DC',
    accent: '#D89614',
    family: 'warning',
    severity: 1,
    description: '这一格与院内记录不一致，等登记员在「确认」列选择是否采纳。',
  },
  差异: {
    status: '差异',
    badge: '有差异',
    textColor: '#A92020',
    background: '#FBEAEA',
    accent: '#D93F3F',
    family: 'danger',
    severity: 2,
    description: '登记表这一格与院内权威记录不一致，请核对后决定是否采纳。',
  },
  需人工判定: {
    status: '需人工判定',
    badge: '需人工判定',
    textColor: '#5533C8',
    background: '#F0ECFE',
    accent: '#7A5AF8',
    family: 'manual',
    severity: 3,
    description: '写法无法归并到受控编码，建议值留空，请人工填写。',
  },
  零命中: {
    status: '零命中',
    badge: '院内无此记录',
    textColor: '#4F6A85',
    background: '#EDF2F7',
    accent: '#7C93AC',
    family: 'info',
    severity: 2,
    description: '院内按这个登记号没查到记录，本行不产生差异值。',
  },
  命中歧义: {
    status: '命中歧义',
    badge: '院内多条命中',
    textColor: '#B14A17',
    background: '#FCEEE5',
    accent: '#E2733B',
    family: 'warning',
    severity: 3,
    description: '院内有多条记录匹配这个登记号，插件不取第一条，请人工核对。',
  },
  '院内已变更，需重查': {
    status: '院内已变更，需重查',
    badge: '院内已变更，需重查',
    textColor: '#9A3412',
    background: '#FDEBDD',
    accent: '#C2410C',
    family: 'warning',
    severity: 3,
    description: '检索之后院内的值又被改过，本行已拒写，请重新跑一次对齐。',
  },
};

/** 确认列四个取值的徽标（与八个标注状态分开：这里管「确认」列本身）。 */
export const CONFIRM_VALUE_BADGES: Record<
  '待确认' | '采纳' | '不采纳' | '无需确认',
  { badge: string; textColor: string; background: string; accent: string }
> = {
  待确认: { badge: '待确认', textColor: '#8A5B00', background: '#FDF3DC', accent: '#D89614' },
  采纳: { badge: '采纳', textColor: '#246B39', background: '#E8F5EC', accent: '#3FA65A' },
  不采纳: { badge: '不采纳', textColor: '#5F6672', background: '#F2F3F5', accent: '#8A9099' },
  无需确认: { badge: '无需确认', textColor: '#6E747C', background: '#FAFAFB', accent: '#9AA0A8' },
};

/** 生命周期状态在表尾回执区里的徽标。 */
export const LIFECYCLE_BADGES: Record<
  '待对齐' | '已推送' | '推送失败',
  { badge: string; textColor: string; background: string; accent: string }
> = {
  待对齐: { badge: '待对齐', textColor: '#6E747C', background: '#FAFAFB', accent: '#9AA0A8' },
  已推送: { badge: '已推送', textColor: '#246B39', background: '#E8F5EC', accent: '#3FA65A' },
  推送失败: { badge: '推送失败', textColor: '#A92020', background: '#FBEAEA', accent: '#D93F3F' },
};

/**
 * 查一个状态的完整外观；状态不存在时**显式报错并列出全部允许取值**，
 * 绝不回退到「随便给个灰色」——回退会让登记员把未知状态当成一致。
 */
export function getStatusToken(status: string): StatusToken {
  const token = Object.prototype.hasOwnProperty.call(STATUS_TOKENS, status)
    ? STATUS_TOKENS[status as PresentationStatus]
    : undefined;
  if (!token) {
    throw new PresentationTokenError(`未定义的呈现状态：${status}`, [
      `允许的状态：${PRESENTATION_STATUSES.join('、')}`,
      '请在 STATUS_TOKENS 中补上该状态的色值与文案后再用',
    ]);
  }
  return token;
}

/* ────────────────────────────── 字体层级 ────────────────────────────── */

/** 字体族：中文系统栈，不依赖任何需要额外安装的字体。 */
export const FONT_FAMILY = {
  sans: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif',
  mono: '"SF Mono", "JetBrains Mono", Consolas, "Courier New", monospace',
} as const;

/** 数字一律等宽对齐（登记号、计数、幂等键、批次键都要能上下对齐看）。 */
export const NUMERIC_STYLE = {
  fontVariantNumeric: 'tabular-nums',
  fontFamily: FONT_FAMILY.mono,
} as const;

/** 字号层级：页面/区块标题、列名、正文、说明、徽标、指标，六级。 */
export const TYPE_SCALE = {
  /** 区块标题（表尾区块名） */
  sectionTitle: { fontSizePx: 16, fontWeight: 600, lineHeightPx: 24 },
  /** 列名 / 小节标题 */
  columnHeader: { fontSizePx: 14, fontWeight: 600, lineHeightPx: 20 },
  /** 正文单元格 */
  body: { fontSizePx: 14, fontWeight: 400, lineHeightPx: 20 },
  /** 辅助说明（计数行、提示语） */
  caption: { fontSizePx: 12, fontWeight: 400, lineHeightPx: 18 },
  /** 徽标 */
  badge: { fontSizePx: 12, fontWeight: 500, lineHeightPx: 18 },
  /** 指标数字（表尾计数） */
  metric: { fontSizePx: 20, fontWeight: 600, lineHeightPx: 28 },
} as const;

export type TypeScaleKey = keyof typeof TYPE_SCALE;

/* ────────────────────────────── 间距与圆角 ────────────────────────────── */

/** 间距栅格：4 的倍数，统一按 8px 栅格取。 */
export const SPACING = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 40,
} as const;

/** 栅格基准（px）。所有间距都应是它的整数倍或半数倍。 */
export const SPACING_GRID_PX = 8;

/** 圆角：只对容器类元素有意义，表格单元格本身不圆角。 */
export const RADIUS = {
  sm: 4,
  md: 8,
  lg: 12,
} as const;

/* ────────────────────────────── 列宽 ────────────────────────────── */

/** 一列的宽度规格：px 给排版参考，excelCharWidth 给 Excel/WPS 设置列宽用。 */
export interface ColumnWidthToken {
  /** 像素宽（视觉目标卡里的参照值） */
  widthPx: number;
  /** Excel 列宽（字符数），宏里 `ColumnWidth =` 直接用这个 */
  excelCharWidth: number;
  /** 是否自动换行 */
  wrap: boolean;
}

/**
 * 结果表新增五列的固定列宽（列序固定：院内值 / 差异 / 建议值 / 确认 / AI 说明）。
 *
 * 「差异」列最宽 —— 它是登记员真正要读的那一列；「确认」列最窄 —— 只需放下拉取值。
 */
export const NEW_COLUMN_WIDTHS: Record<
  '院内值' | '差异' | '建议值' | '确认' | 'AI 说明',
  ColumnWidthToken
> = {
  院内值: { widthPx: 220, excelCharWidth: 22, wrap: true },
  差异: { widthPx: 260, excelCharWidth: 26, wrap: true },
  建议值: { widthPx: 160, excelCharWidth: 16, wrap: true },
  确认: { widthPx: 100, excelCharWidth: 10, wrap: false },
  'AI 说明': { widthPx: 200, excelCharWidth: 20, wrap: true },
};

/** 原表列的默认列宽（登记表自己的列宽不改，只给没设过宽度的列兜底）。 */
export const DEFAULT_ORIGINAL_COLUMN_WIDTH: ColumnWidthToken = {
  widthPx: 140,
  excelCharWidth: 14,
  wrap: true,
};

/* ────────────────────── 列角色：人工补充列 / 只读列 ────────────────────── */

/** 一类列在表内的外观。 */
export interface ColumnRoleStyle {
  /** 单元格底色 */
  background: string;
  /** 文字色 */
  textColor: string;
  /** 左侧色条颜色 */
  borderLeft: string;
  /** 提示语：这一列为什么不参与比对 */
  hint: string;
  /** 是否参与差异比对 */
  participatesInDiff: boolean;
}

/** 普通登记表列：参与比对。 */
export const NORMAL_COLUMN_STYLE: ColumnRoleStyle = {
  background: NEUTRAL.canvas,
  textColor: NEUTRAL.ink,
  borderLeft: NEUTRAL.divider,
  hint: '参与差异比对的登记表列。',
  participatesInDiff: true,
};

/**
 * 人工补充列（随访电话、生活方式备注等）：登记员自己填的，**插件只读不覆盖**。
 * 浅底 + 左色条 + 一句提示，登记员一眼就知道这一列不会被动。
 */
export const HUMAN_SUPPLIED_COLUMN_STYLE: ColumnRoleStyle = {
  background: NEUTRAL.surface,
  textColor: NEUTRAL.secondary,
  borderLeft: '#BFC5CC',
  hint: '人工补充列 · 只读不覆盖 · 不参与差异比对',
  participatesInDiff: false,
};

/** 只读列：由院内记录带出的派生信息，登记员改不了。 */
export const READ_ONLY_COLUMN_STYLE: ColumnRoleStyle = {
  background: NEUTRAL.surfaceMuted,
  textColor: NEUTRAL.body,
  borderLeft: '#DCE0E6',
  hint: '只读列 · 由院内记录带出 · 不参与差异比对',
  participatesInDiff: false,
};

/** 按列角色取外观；未知角色显式报错。 */
export function getColumnRoleStyle(role: 'normal' | 'human_supplied' | 'read_only'): ColumnRoleStyle {
  switch (role) {
    case 'normal':
      return NORMAL_COLUMN_STYLE;
    case 'human_supplied':
      return HUMAN_SUPPLIED_COLUMN_STYLE;
    case 'read_only':
      return READ_ONLY_COLUMN_STYLE;
    default:
      throw new PresentationTokenError(`未定义的列角色：${String(role)}`, [
        '允许的角色：normal、human_supplied、read_only',
      ]);
  }
}

/* ─────────────────────── 表尾回执区 / 缺行区 版式 ─────────────────────── */

/** 表尾区块的行版式。 */
export interface FooterRowStyle {
  /** 底色 */
  background: string;
  /** 文字色 */
  textColor: string;
  /** 字号 */
  fontSizePx: number;
  /** 字重 */
  fontWeight: number;
}

/** 一个表尾区块的完整版式。 */
export interface FooterZoneLayout {
  /** 区块标识 */
  zone: 'receipt' | 'missing';
  /** 区块标题（写进标题行第一格） */
  title: string;
  /** 明细行的字段顺序 */
  detailFields: string;
  /** 行序：标题 → 计数 → 明细 */
  rowOrder: 'title-count-detail';
  /** 只追加到表尾，绝不插入正文 */
  appendOnly: boolean;
  /** 标题行样式 */
  titleRow: FooterRowStyle;
  /** 计数行样式 */
  countRow: FooterRowStyle;
  /** 明细行样式（含隔行斑马纹） */
  detailRow: FooterRowStyle;
  /** 隔行斑马纹底色 */
  detailAlternateBackground: string;
}

// 区块标题与明细字段顺序不在这里另起一份：直接用写出层那一份，
// 保证「表里长什么样」和「表里写了什么」永远是同一套文案。
export const FOOTER_BLOCK_TITLES = {
  receipt: RESULT_RECEIPT_BLOCK_TITLE,
  missing: RESULT_MISSING_BLOCK_TITLE,
} as const;

export const FOOTER_DETAIL_FIELDS = {
  receipt: RESULT_RECEIPT_DETAIL_FIELDS,
  missing: RESULT_MISSING_DETAIL_FIELDS,
} as const;

/**
 * 表尾两个区块的版式。
 *
 * 两个区块版式一致，登记员扫到表尾就知道该怎么读：**标题行**说这块是什么、
 * **计数行**给结论（推了多少、还剩多少）、**明细行**给逐行证据。
 */
export const FOOTER_ZONES: Record<'receipt' | 'missing', FooterZoneLayout> = {
  receipt: {
    zone: 'receipt',
    title: RESULT_RECEIPT_BLOCK_TITLE,
    detailFields: RESULT_RECEIPT_DETAIL_FIELDS,
    rowOrder: 'title-count-detail',
    appendOnly: true,
    titleRow: {
      background: SEMANTIC.primarySubtle,
      textColor: NEUTRAL.ink,
      fontSizePx: TYPE_SCALE.sectionTitle.fontSizePx,
      fontWeight: TYPE_SCALE.sectionTitle.fontWeight,
    },
    countRow: {
      background: NEUTRAL.surface,
      textColor: NEUTRAL.secondary,
      fontSizePx: TYPE_SCALE.caption.fontSizePx,
      fontWeight: TYPE_SCALE.caption.fontWeight,
    },
    detailRow: {
      background: NEUTRAL.canvas,
      textColor: NEUTRAL.body,
      fontSizePx: TYPE_SCALE.body.fontSizePx,
      fontWeight: TYPE_SCALE.body.fontWeight,
    },
    detailAlternateBackground: NEUTRAL.surfaceMuted,
  },
  missing: {
    zone: 'missing',
    title: RESULT_MISSING_BLOCK_TITLE,
    detailFields: RESULT_MISSING_DETAIL_FIELDS,
    rowOrder: 'title-count-detail',
    appendOnly: true,
    titleRow: {
      background: SEMANTIC.warningSubtle,
      textColor: NEUTRAL.ink,
      fontSizePx: TYPE_SCALE.sectionTitle.fontSizePx,
      fontWeight: TYPE_SCALE.sectionTitle.fontWeight,
    },
    countRow: {
      background: NEUTRAL.surface,
      textColor: NEUTRAL.secondary,
      fontSizePx: TYPE_SCALE.caption.fontSizePx,
      fontWeight: TYPE_SCALE.caption.fontWeight,
    },
    detailRow: {
      background: NEUTRAL.canvas,
      textColor: NEUTRAL.body,
      fontSizePx: TYPE_SCALE.body.fontSizePx,
      fontWeight: TYPE_SCALE.body.fontWeight,
    },
    detailAlternateBackground: NEUTRAL.surfaceMuted,
  },
};

/* ───────────────────────────── 表内呈现参数 ───────────────────────────── */

/** 表内呈现的通用参数：冻结首行、筛选、换行等由布局层按这里执行。 */
export const SHEET_PRESENTATION = {
  /** 冻结首行（表头） */
  freezeHeaderRow: true,
  /** 开启筛选 */
  enableFilter: true,
  /** 正文单元格默认自动换行 */
  wrapText: true,
  /** 差异列底纹只上在真正变化的格子上，一致的格子不加底纹 */
  shadeOnlyChangedCells: true,
  /** 徽标超出列宽时的最大显示字符数（超出折叠并给总数） */
  maxBadgeChars: 48,
} as const;

/* ────────────────────────────── 颜色工具 ────────────────────────────── */

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** 校验一个 #RRGGBB 色值；不合法时点名是哪个色值。 */
export function assertHexColor(color: string, label = '色值'): string {
  if (!HEX_PATTERN.test(color)) {
    throw new PresentationTokenError(`${label} 不是合法的 #RRGGBB 色值`, [
      `实际取值：${color}`,
      '请写成 # 加六位十六进制，例如 #D93F3F',
    ]);
  }
  return color.toUpperCase();
}

/**
 * 把 #RRGGBB 转成 Excel / WPS 单元格填充用的 OLE 色值（**BGR** 顺序）。
 *
 * 宏里 `Range.Interior.Color = <这个数>`，不转换的话红底会变蓝底。
 */
export function excelFillArgb(color: string): number {
  const hex = assertHexColor(color);
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return b * 65536 + g * 256 + r;
}

/* ─────────────────────────── 自洽性校验 ─────────────────────────── */

/**
 * 校验 token 自洽：八个状态色值两两不同、徽标文案非空、间距守栅格、字号层级齐全。
 *
 * 模块加载时自跑一遍 —— 设计 token 一旦漂移（比如有人复制粘贴出一个重色），
 * 必须在**第一次加载**就炸出来，而不是等到某张表画出来才发现两个状态长得一样。
 */
export function validatePresentationTokens(): void {
  const issues: string[] = [];

  const accentSeen = new Map<string, PresentationStatus>();
  const backgroundSeen = new Map<string, PresentationStatus>();
  for (const status of PRESENTATION_STATUSES) {
    const token = STATUS_TOKENS[status];
    if (!token) {
      issues.push(`状态 ${status} 在 STATUS_TOKENS 中缺失`);
      continue;
    }
    if (token.badge.trim().length === 0) {
      issues.push(`状态 ${status} 缺徽标文案`);
    }
    const previousAccent = accentSeen.get(token.accent);
    if (previousAccent !== undefined) {
      issues.push(`状态 ${status} 与 ${previousAccent} 的强调色重复：${token.accent}`);
    }
    accentSeen.set(token.accent, status);

    const previousBackground = backgroundSeen.get(token.background);
    if (previousBackground !== undefined) {
      issues.push(`状态 ${status} 与 ${previousBackground} 的底色重复：${token.background}`);
    }
    backgroundSeen.set(token.background, status);
  }

  for (const [key, value] of Object.entries(SPACING)) {
    if (value % 2 !== 0) {
      issues.push(`间距 ${key}=${value} 不是 4 的倍数`);
    }
  }

  if (Object.keys(TYPE_SCALE).length < 4) {
    issues.push(`字号层级只有 ${Object.keys(TYPE_SCALE).length} 级，至少要 4 级`);
  }

  const colorValues: [string, string][] = [
    ...Object.values(STATUS_TOKENS).map((token) => ['状态强调色', token.accent] as [string, string]),
    ...Object.values(STATUS_TOKENS).map((token) => ['状态底色', token.background] as [string, string]),
    ...Object.values(CONFIRM_VALUE_BADGES).map((badge) => ['确认徽标底色', badge.background] as [string, string]),
  ];
  for (const [label, color] of colorValues) {
    try {
      assertHexColor(color, label);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (issues.length > 0) {
    throw new PresentationTokenError('表内呈现 token 自洽性校验未通过', issues);
  }
}

validatePresentationTokens();
