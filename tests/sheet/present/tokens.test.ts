import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CONFIRM_VALUE_BADGES,
  DEFAULT_ORIGINAL_COLUMN_WIDTH,
  FOOTER_ZONES,
  FONT_FAMILY,
  HUMAN_SUPPLIED_COLUMN_STYLE,
  MISSING_BLOCK_TITLE,
  NEUTRAL,
  NEW_COLUMN_WIDTHS,
  NUMERIC_STYLE,
  NORMAL_COLUMN_STYLE,
  PRESENTATION_STATUSES,
  PresentationTokenError,
  READ_ONLY_COLUMN_STYLE,
  RECEIPT_BLOCK_TITLE,
  RADIUS,
  SEMANTIC,
  SHEET_PRESENTATION,
  SPACING,
  SPACING_GRID_PX,
  STATUS_TOKENS,
  TYPE_SCALE,
  assertHexColor,
  excelFillArgb,
  getColumnRoleStyle,
  getStatusToken,
  validatePresentationTokens,
} from '../../../src/sheet/index.js';

describe('表内呈现 token · 状态 → 色/文案映射', () => {
  it('恰好八个呈现状态，且每个都在映射表里', () => {
    expect(PRESENTATION_STATUSES).toHaveLength(8);
    expect([...PRESENTATION_STATUSES].sort()).toEqual(
      [
        '一致',
        '无需确认',
        '待确认',
        '差异',
        '需人工判定',
        '零命中',
        '命中歧义',
        '院内已变更，需重查',
      ].sort(),
    );
    for (const status of PRESENTATION_STATUSES) {
      expect(STATUS_TOKENS[status]).toBeDefined();
      expect(STATUS_TOKENS[status].status).toBe(status);
    }
  });

  it('八个状态各有唯一色值（强调色与底色都不撞车）', () => {
    const accents = PRESENTATION_STATUSES.map((status) => STATUS_TOKENS[status].accent);
    const backgrounds = PRESENTATION_STATUSES.map((status) => STATUS_TOKENS[status].background);

    expect(new Set(accents).size).toBe(PRESENTATION_STATUSES.length);
    expect(new Set(backgrounds).size).toBe(PRESENTATION_STATUSES.length);

    // 撞色的状态必须被点出来，而不是悄悄放过
    const seenAccent = new Map<string, string>();
    const seenBackground = new Map<string, string>();
    for (const status of PRESENTATION_STATUSES) {
      const token = STATUS_TOKENS[status];
      const prevAccent = seenAccent.get(token.accent);
      expect(prevAccent, `强调色撞车：${status} 与 ${prevAccent}`).toBeUndefined();
      seenAccent.set(token.accent, status);

      const prevBackground = seenBackground.get(token.background);
      expect(prevBackground, `底色撞车：${status} 与 ${prevBackground}`).toBeUndefined();
      seenBackground.set(token.background, status);
    }
  });

  it('八个状态各有面向登记员的中文徽标文案', () => {
    const expectedBadges: Record<string, string> = {
      一致: '与院内一致',
      无需确认: '无需确认',
      待确认: '待确认',
      差异: '有差异',
      需人工判定: '需人工判定',
      零命中: '院内无此记录',
      命中歧义: '院内多条命中',
      '院内已变更，需重查': '院内已变更，需重查',
    };

    for (const status of PRESENTATION_STATUSES) {
      const token = STATUS_TOKENS[status];
      expect(token.badge.trim().length).toBeGreaterThan(0);
      expect(token.description.trim().length).toBeGreaterThan(0);
      expect(token.badge, `状态 ${status} 的徽标文案不对`).toBe(expectedBadges[status]);
    }

    // 内部术语（零命中 / 命中歧义）不得直接出现在徽标上：登记员看的是人话
    expect(STATUS_TOKENS['零命中'].badge).not.toContain('零命中');
    expect(STATUS_TOKENS['命中歧义'].badge).not.toContain('歧义');
  });

  it('色值都是合法 #RRGGBB', () => {
    for (const status of PRESENTATION_STATUSES) {
      const token = STATUS_TOKENS[status];
      expect(() => assertHexColor(token.accent, '强调色')).not.toThrow();
      expect(() => assertHexColor(token.background, '底色')).not.toThrow();
      expect(() => assertHexColor(token.textColor, '文字色')).not.toThrow();
    }
  });

  it('未定义状态显式报错，并列出全部允许取值', () => {
    expect(() => getStatusToken('未定义状态')).toThrow(PresentationTokenError);
    try {
      getStatusToken('已推送');
      throw new Error('应当抛出');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationTokenError);
      const message = (error as PresentationTokenError).message;
      expect(message).toContain('未定义的呈现状态：已推送');
      for (const status of PRESENTATION_STATUSES) {
        expect(message).toContain(status);
      }
    }
  });

  it('已知状态能查到完整外观', () => {
    const token = getStatusToken('待确认');
    expect(token.badge).toBe('待确认');
    expect(token.family).toBe('warning');
    expect(token.severity).toBe(1);
  });

  it('token 自洽性校验通过', () => {
    expect(() => validatePresentationTokens()).not.toThrow();
  });
});

describe('表内呈现 token · 确认列与生命周期徽标', () => {
  it('确认列四个取值都有徽标外观', () => {
    for (const value of ['待确认', '采纳', '不采纳', '无需确认'] as const) {
      const badge = CONFIRM_VALUE_BADGES[value];
      expect(badge.badge).toBe(value);
      expect(() => assertHexColor(badge.background)).not.toThrow();
    }
  });
});

describe('表内呈现 token · 人工补充列与只读列的视觉区分', () => {
  it('人工补充列与只读列都不参与差异比对，且外观互不相同', () => {
    expect(HUMAN_SUPPLIED_COLUMN_STYLE.participatesInDiff).toBe(false);
    expect(READ_ONLY_COLUMN_STYLE.participatesInDiff).toBe(false);
    expect(NORMAL_COLUMN_STYLE.participatesInDiff).toBe(true);

    expect(HUMAN_SUPPLIED_COLUMN_STYLE.background).not.toBe(READ_ONLY_COLUMN_STYLE.background);
    expect(HUMAN_SUPPLIED_COLUMN_STYLE.borderLeft).not.toBe(READ_ONLY_COLUMN_STYLE.borderLeft);
    expect(HUMAN_SUPPLIED_COLUMN_STYLE.textColor).not.toBe(READ_ONLY_COLUMN_STYLE.textColor);
  });

  it('两类列各带一句「不参与差异比对」的提示文案', () => {
    expect(HUMAN_SUPPLIED_COLUMN_STYLE.hint).toContain('不参与差异比对');
    expect(HUMAN_SUPPLIED_COLUMN_STYLE.hint).toContain('人工补充列');
    expect(READ_ONLY_COLUMN_STYLE.hint).toContain('不参与差异比对');
    expect(READ_ONLY_COLUMN_STYLE.hint).toContain('只读列');
  });

  it('两类列都是浅底（比正文画布更浅的灰）', () => {
    expect(HUMAN_SUPPLIED_COLUMN_STYLE.background).not.toBe(NEUTRAL.canvas);
    expect(READ_ONLY_COLUMN_STYLE.background).not.toBe(NEUTRAL.canvas);
  });

  it('按列角色取外观；未知角色显式报错', () => {
    expect(getColumnRoleStyle('normal')).toBe(NORMAL_COLUMN_STYLE);
    expect(getColumnRoleStyle('human_supplied')).toBe(HUMAN_SUPPLIED_COLUMN_STYLE);
    expect(getColumnRoleStyle('read_only')).toBe(READ_ONLY_COLUMN_STYLE);
    expect(() => getColumnRoleStyle('whatever' as 'normal')).toThrow(PresentationTokenError);
  });
});

describe('表内呈现 token · 字体层级与间距栅格', () => {
  it('字号层级至少四级，且逐级有字号与字重', () => {
    const levels = Object.values(TYPE_SCALE);
    expect(levels.length).toBeGreaterThanOrEqual(4);
    for (const level of levels) {
      expect(level.fontSizePx).toBeGreaterThan(0);
      expect(level.lineHeightPx).toBeGreaterThanOrEqual(level.fontSizePx);
      expect([400, 500, 600]).toContain(level.fontWeight);
    }
    const sizes = levels.map((level) => level.fontSizePx);
    expect(new Set(sizes).size).toBeGreaterThanOrEqual(4);
  });

  it('中文字体走系统中文栈，数字走等宽', () => {
    expect(FONT_FAMILY.sans).toContain('PingFang SC');
    expect(FONT_FAMILY.sans).toContain('Microsoft YaHei');
    expect(NUMERIC_STYLE.fontVariantNumeric).toBe('tabular-nums');
    expect(NUMERIC_STYLE.fontFamily).toBe(FONT_FAMILY.mono);
  });

  it('间距全部守 8px 栅格（4 的倍数）', () => {
    expect(SPACING_GRID_PX).toBe(8);
    for (const [key, value] of Object.entries(SPACING)) {
      expect(value % 4, `间距 ${key}=${value} 不守栅格`).toBe(0);
    }
  });

  it('圆角分三级', () => {
    expect(Object.keys(RADIUS)).toHaveLength(3);
  });
});

describe('表内呈现 token · 列宽', () => {
  it('新增五列都有固定列宽，且「差异」列最宽、「确认」列最窄', () => {
    expect(Object.keys(NEW_COLUMN_WIDTHS)).toEqual([
      '院内值',
      '差异',
      '建议值',
      '确认',
      'AI 说明',
    ]);
    for (const [name, width] of Object.entries(NEW_COLUMN_WIDTHS)) {
      expect(width.widthPx, `${name} 缺像素宽`).toBeGreaterThan(0);
      expect(width.excelCharWidth, `${name} 缺 Excel 列宽`).toBeGreaterThan(0);
    }
    const widest = Math.max(...Object.values(NEW_COLUMN_WIDTHS).map((w) => w.widthPx));
    const narrowest = Math.min(...Object.values(NEW_COLUMN_WIDTHS).map((w) => w.widthPx));
    expect(NEW_COLUMN_WIDTHS['差异'].widthPx).toBe(widest);
    expect(NEW_COLUMN_WIDTHS['确认'].widthPx).toBe(narrowest);
  });

  it('原表列有默认列宽兜底', () => {
    expect(DEFAULT_ORIGINAL_COLUMN_WIDTH.widthPx).toBeGreaterThan(0);
    expect(DEFAULT_ORIGINAL_COLUMN_WIDTH.excelCharWidth).toBeGreaterThan(0);
  });
});

describe('表内呈现 token · 表尾回执区与缺行区版式', () => {
  it('两个区块都是「标题行 + 计数行 + 明细行」的行序，且只追加', () => {
    for (const zone of ['receipt', 'missing'] as const) {
      const layout = FOOTER_ZONES[zone];
      expect(layout.rowOrder).toBe('title-count-detail');
      expect(layout.appendOnly).toBe(true);
      expect(layout.title.length).toBeGreaterThan(0);
      expect(layout.detailFields.length).toBeGreaterThan(0);
      expect(layout.titleRow.fontSizePx).toBeGreaterThan(layout.countRow.fontSizePx);
      expect(layout.detailRow.background).not.toBe(layout.titleRow.background);
      expect(layout.detailAlternateBackground).not.toBe(layout.detailRow.background);
    }
  });

  it('区块标题与结果表写出层是同一份文案', () => {
    expect(FOOTER_ZONES.receipt.title).toBe(RECEIPT_BLOCK_TITLE);
    expect(FOOTER_ZONES.missing.title).toBe(MISSING_BLOCK_TITLE);
    expect(RECEIPT_BLOCK_TITLE).toBe('【推送回执】');
    expect(MISSING_BLOCK_TITLE).toBe('【院内命中但本表缺行】');
  });

  it('两个区块标题用不同底色，避免登记员看错区块', () => {
    expect(FOOTER_ZONES.receipt.titleRow.background).not.toBe(FOOTER_ZONES.missing.titleRow.background);
    expect(FOOTER_ZONES.receipt.titleRow.background).toBe(SEMANTIC.primarySubtle);
    expect(FOOTER_ZONES.missing.titleRow.background).toBe(SEMANTIC.warningSubtle);
  });
});

describe('表内呈现 token · 颜色工具', () => {
  it('#RRGGBB 转 Excel 填充色（BGR 顺序）', () => {
    // 纯红 #D93F3F → B=0x3F, G=0x3F, R=0xD9
    expect(excelFillArgb('#D93F3F')).toBe(0x3f * 65536 + 0x3f * 256 + 0xd9);
    expect(excelFillArgb('#000000')).toBe(0);
    expect(excelFillArgb('#FFFFFF')).toBe(0xffffff);
  });

  it('非法色值显式报错并点名', () => {
    expect(() => excelFillArgb('red')).toThrow(PresentationTokenError);
    expect(() => excelFillArgb('#FFF')).toThrow(PresentationTokenError);
    try {
      excelFillArgb('#GGGGGG');
      throw new Error('应当抛出');
    } catch (error) {
      expect((error as PresentationTokenError).message).toContain('#RRGGBB');
    }
  });
});

describe('表内呈现 token · 表内呈现参数', () => {
  it('冻结首行、开启筛选，且差异底纹只上在变化的格子上', () => {
    expect(SHEET_PRESENTATION.freezeHeaderRow).toBe(true);
    expect(SHEET_PRESENTATION.enableFilter).toBe(true);
    expect(SHEET_PRESENTATION.shadeOnlyChangedCells).toBe(true);
  });
});

describe('视觉目标卡 · docs/concepts/visual-target.md', () => {
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');
  const cardPath = join(projectRoot, 'docs/concepts/visual-target.md');
  const card = readFileSync(cardPath, 'utf8');

  it('列出了起始态 / 首个可用瞬间 / 成形态三态画面', () => {
    expect(card).toContain('起始态');
    expect(card).toContain('首个可用瞬间');
    expect(card).toContain('成形态');
  });

  it('列出了配色与字体层级', () => {
    expect(card).toContain('## 二、配色');
    expect(card).toContain('## 三、字体层级');
    expect(card).toContain('## 四、信息层级');
    expect(card).toContain('## 五、必须可达的约束');
  });

  it('卡上出现的色值全部来自 token（不许写裸色值）', () => {
    const declared = new Set<string>([
      ...Object.values(NEUTRAL),
      ...Object.values(SEMANTIC),
      ...Object.values(STATUS_TOKENS).flatMap((token) => [
        token.accent,
        token.background,
        token.textColor,
      ]),
      ...Object.values(CONFIRM_VALUE_BADGES).flatMap((badge) => [
        badge.accent,
        badge.background,
        badge.textColor,
      ]),
      ...Object.values(HUMAN_SUPPLIED_COLUMN_STYLE).filter(
        (value): value is string => typeof value === 'string' && value.startsWith('#'),
      ),
      ...Object.values(READ_ONLY_COLUMN_STYLE).filter(
        (value): value is string => typeof value === 'string' && value.startsWith('#'),
      ),
      ...Object.values(NORMAL_COLUMN_STYLE).filter(
        (value): value is string => typeof value === 'string' && value.startsWith('#'),
      ),
    ].map((color) => color.toUpperCase()));

    const mentioned = new Set(
      [...card.matchAll(/#[0-9a-fA-F]{6}/g)].map((match) => match[0].toUpperCase()),
    );
    expect(mentioned.size).toBeGreaterThan(10);

    const unknown = [...mentioned].filter((color) => !declared.has(color));
    expect(unknown, `视觉目标卡里出现了 token 中没有的色值：${unknown.join('、')}`).toEqual([]);
  });

  it('卡上不许出现伪造图片链接（本环境无图像生成能力）', () => {
    expect(card).not.toMatch(/!\[.*\]\(.*\.png\)/);
    expect(card).not.toMatch(/!\[.*\]\(.*\.jpg\)/);
  });
});
