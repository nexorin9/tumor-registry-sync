import { describe, expect, it } from 'vitest';

import {
  APPENDED_COLUMNS,
  buildLayout,
  confirmColumnValidation,
  diffCellFill,
  tailBlockLayout,
} from '../../../src/sheet/present/index.js';
import { STATUS_TOKENS } from '../../../src/sheet/present/tokens.js';

describe('APPENDED_COLUMNS 顺序', () => {
  it('固定五列且顺序为 院内值 / 差异 / 建议值 / 确认 / AI说明', () => {
    expect(APPENDED_COLUMNS).toEqual(['院内值', '差异', '建议值', '确认', 'AI说明']);
    expect(APPENDED_COLUMNS).toHaveLength(5);
  });
});

describe('buildLayout', () => {
  it('原表列顺序不变，追加列按固定顺序排在末尾', () => {
    const layout = buildLayout(['登记号', '姓名', '分期']);
    expect(layout.originalColumns).toEqual(['登记号', '姓名', '分期']);
    expect(layout.appendedColumns).toEqual(APPENDED_COLUMNS);
  });

  it('确认下拉固定四值', () => {
    expect(buildLayout(['登记号']).confirmDropdown).toEqual([
      '待确认',
      '采纳',
      '不采纳',
      '无需确认',
    ]);
  });

  it('差异列与确认列下标正确（原表列数 + 追加内下标）', () => {
    const layout = buildLayout(['登记号', '姓名']); // 原表 2 列
    // 院内值(0) 差异(1) 建议值(2) 确认(3) AI说明(4) → 差异下标=3, 确认下标=5
    expect(layout.diffColumnIndex).toBe(3);
    expect(layout.confirmColumnIndex).toBe(5);
  });
});

describe('diffCellFill', () => {
  it('一致 → 不填充', () => {
    const r = diffCellFill('一致', true);
    expect(r.fill).toBe('transparent');
    expect(r.note).toContain('一致');
  });

  it('无需确认 → 不填充', () => {
    expect(diffCellFill('无需确认', true).fill).toBe('transparent');
  });

  it('差异 → 取 token 底色（非 transparent，色值来自 tokens）', () => {
    const r = diffCellFill('差异', true);
    expect(r.fill).toBe(STATUS_TOKENS['差异'].background);
    expect(r.fill).not.toBe('transparent');
    expect(r.note).toContain('差异');
  });

  it('需人工判定 → 取 token 底色（非 transparent）', () => {
    const r = diffCellFill('需人工判定', true);
    expect(r.fill).toBe(STATUS_TOKENS['需人工判定'].background);
    expect(r.fill).not.toBe('transparent');
  });

  it('零命中 → 取 token 底色（非 transparent）', () => {
    const r = diffCellFill('零命中', true);
    expect(r.fill).toBe(STATUS_TOKENS['零命中'].background);
    expect(r.fill).not.toBe('transparent');
  });

  it('hasDiff=false 时任何状态都不填充', () => {
    expect(diffCellFill('差异', false).fill).toBe('transparent');
    expect(diffCellFill('需人工判定', false).fill).toBe('transparent');
    expect(diffCellFill('零命中', false).fill).toBe('transparent');
  });
});

describe('tailBlockLayout', () => {
  it('两块区块标题正确', () => {
    expect(tailBlockLayout()).toEqual({
      receiptTitleRow: '推送回执',
      missingTitleRow: '院内命中但本表缺行',
    });
  });
});

describe('confirmColumnValidation', () => {
  it('白名单四值放行', () => {
    expect(confirmColumnValidation('待确认')).toBe(true);
    expect(confirmColumnValidation('采纳')).toBe(true);
    expect(confirmColumnValidation('不采纳')).toBe(true);
    expect(confirmColumnValidation('无需确认')).toBe(true);
  });

  it('非白名单取值一律 false', () => {
    expect(confirmColumnValidation('随便填')).toBe(false);
    expect(confirmColumnValidation('')).toBe(false);
    expect(confirmColumnValidation('已推送')).toBe(false);
  });
});
