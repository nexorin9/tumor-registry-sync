import { describe, expect, it } from 'vitest';

import {
  DIFF_CHANGE_STATUS,
  DIFF_TEXT_CONSISTENT,
  DEFAULT_MAX_RENDERED_FIELDS,
  SUGGESTION_CALIBER_UNSPECIFIED,
  SUGGESTION_MANUAL_JUDGEMENT,
  controlledCodeSuggestionText,
  diffRowStatus,
  formatDiffValue,
  renderDiff,
  renderFieldValue,
  type DiffEntry,
  type ManualField,
  type RenderDiffInput,
} from '../../src/diff/index.js';
import { diffValues, diffValuesEqual, type DiffOperation } from '../../src/diff/patch.js';
import { diffNested } from '../../src/diff/nested.js';
import { getStatusToken } from '../../src/sheet/present/tokens.js';

/** 用真实差异引擎造一条操作，避免测试里手搓引擎产物。 */
function op(input: {
  field: string;
  column?: string | null;
  oldValue: unknown;
  newValue: unknown;
  controlledCode?: boolean;
}): DiffOperation[] {
  return diffValues({
    path: input.field,
    field: input.field,
    column: input.column ?? input.field,
    oldValue: input.oldValue,
    newValue: input.newValue,
    controlledCode: input.controlledCode ?? false,
  });
}

function render(input: Partial<RenderDiffInput> & { operations?: DiffOperation[] } = {}) {
  return renderDiff({
    operations: input.operations ?? [],
    mergeSuggestions: input.mergeSuggestions,
    manualFields: input.manualFields,
    unspecifiedColumns: input.unspecifiedColumns,
    maxFields: input.maxFields,
  });
}

describe('diff/render · 差异文案', () => {
  it('一条 replace 操作渲染成「字段名：登记值 → 院内值（修改）」', () => {
    const result = render({
      operations: op({ field: '分期', oldValue: 'ⅡA', newValue: 'ⅢB' }),
    });

    expect(result.diffText).toBe('分期：ⅡA → ⅢB（修改）');
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.changeType).toBe('修改');
    expect(result.entries[0]?.oldText).toBe('ⅡA');
    expect(result.entries[0]?.newText).toBe('ⅢB');
  });

  it('add 操作渲染成「新增」，登记侧空着如实写成「（空）」', () => {
    const result = render({
      operations: op({ field: '分期', oldValue: null, newValue: 'ⅢB' }),
    });

    expect(result.diffText).toBe('分期：（空） → ⅢB（新增）');
    expect(result.entries[0]?.changeType).toBe('新增');
  });

  it('remove 操作渲染成「删除」，院内侧写明「院内无此字段」', () => {
    const result = render({
      operations: op({ field: '分期', oldValue: 'ⅡA', newValue: undefined }),
    });

    expect(result.diffText).toBe('分期：ⅡA → 院内无此字段（删除）');
    expect(result.entries[0]?.changeType).toBe('删除');
  });

  it('类型变更在文案里额外标注「类型不同，请人工核对」', () => {
    const result = render({
      operations: op({ field: '首次入院日', oldValue: '2024-01-02', newValue: 20240102 }),
    });

    expect(result.diffText).toContain('（修改 · 类型不同，请人工核对）');
    expect(result.entries[0]?.changeKind).toBe('类型变更');
  });

  it('多字段差异在同一行内串联，用「；」分隔', () => {
    const result = render({
      operations: [
        ...op({ field: '分期', oldValue: 'ⅡA', newValue: 'ⅢB' }),
        ...op({ field: '首次入院日', oldValue: '2024-01-02', newValue: '2024-03-05' }),
      ],
      maxFields: 5,
    });

    expect(result.diffText).toBe(
      '分期：ⅡA → ⅢB（修改）；首次入院日：2024-01-02 → 2024-03-05（修改）',
    );
  });

  it('字段数超过阈值时折叠，并给出总数', () => {
    const result = render({
      operations: [
        ...op({ field: '分期', oldValue: 'ⅡA', newValue: 'ⅢB' }),
        ...op({ field: '首次入院日', oldValue: '2024-01-02', newValue: '2024-03-05' }),
        ...op({ field: '本次就诊开始', oldValue: '2024-01-02', newValue: '2024-02-02' }),
        ...op({ field: '治疗方案', oldValue: '方案A', newValue: '方案B' }),
      ],
      maxFields: 2,
    });

    expect(result.diffText).toBe(
      '分期：ⅡA → ⅢB（修改）；首次入院日：2024-01-02 → 2024-03-05（修改）；另有 2 个字段有差异（共 4 个字段）',
    );
    expect(result.foldedFields).toBe(2);
    expect(result.totalFields).toBe(4);
  });

  it('同一字段的多条差异折叠时只算没露过面的字段，不把已展示的字段重复计数', () => {
    const result = render({
      operations: [
        ...op({ field: '分期', oldValue: 'ⅡA', newValue: 'ⅢB' }),
        ...op({ field: '分期', oldValue: 'ⅢB', newValue: 'ⅢC' }),
        ...op({ field: '治疗方案', oldValue: '方案A', newValue: '方案B' }),
      ],
      maxFields: 1,
    });

    // 治疗方案是唯一没露过面的字段：只算它，不把已展示的分期再数一遍
    expect(result.diffText).toContain('另有 1 个字段有差异（共 2 个字段）');
    expect(result.foldedFields).toBe(1);
    expect(result.totalFields).toBe(2);
  });

  it('折掉的全是同一个已展示字段时按「处」计数', () => {
    const result = render({
      operations: [
        ...op({ field: '分期', oldValue: 'ⅡA', newValue: 'ⅢB' }),
        ...op({ field: '分期', oldValue: 'ⅢB', newValue: 'ⅢC' }),
        ...op({ field: '分期', oldValue: 'ⅢC', newValue: 'ⅢD' }),
      ],
      maxFields: 1,
    });

    expect(result.diffText).toContain('另有 2 处差异（共 1 个字段）');
    expect(result.foldedFields).toBe(0);
    expect(result.totalFields).toBe(1);
  });

  it('没有差异时给「与院内一致」，不留空白格', () => {
    const result = render({ operations: [] });

    expect(result.diffText).toBe(DIFF_TEXT_CONSISTENT);
    expect(result.suggestedText).toBe('');
    expect(result.status).toBe('一致');
  });

  it('嵌套路径作为后缀补在字段标签后，登记员看得到是哪一条变了', () => {
    const nested = diffNested({
      path: '分期',
      field: '分期',
      column: '分期',
      oldValue: { code: 'A' },
      newValue: { code: 'B' },
    });

    const result = render({ operations: nested });

    expect(result.entries[0]?.label).toBe('分期 · 分期.code');
    expect(result.diffText).toContain('分期 · 分期.code：');
  });

  it('折叠阈值非法时显式报错，不静默改成默认值', () => {
    expect(() => render({ maxFields: 0 })).toThrow(/折叠阈值必须是正整数/);
  });
});

describe('diff/render · 建议值文案', () => {
  it('普通差异给出可直接采纳的建议值（按院内值填）', () => {
    const result = render({
      operations: op({ field: '首次入院日', oldValue: '2024-01-02', newValue: '2024-03-05' }),
    });

    expect(result.suggestedText).toBe('首次入院日：建议改为「2024-03-05」');
    expect(result.suggestions[0]?.kind).toBe('采纳院内值');
    expect(result.suggestions[0]?.value).toBe('2024-03-05');
  });

  it('add 差异的建议是「建议补填」', () => {
    const result = render({
      operations: op({ field: '分期', oldValue: null, newValue: 'ⅢB' }),
    });

    expect(result.suggestedText).toBe('分期：建议补填「ⅢB」');
    expect(result.suggestions[0]?.value).toBe('ⅢB');
  });

  it('remove 差异的建议是「建议清空（院内无此字段）」，建议值为空串', () => {
    const result = render({
      operations: op({ field: '分期', oldValue: 'ⅡA', newValue: undefined }),
    });

    expect(result.suggestedText).toBe('分期：建议清空（院内无此字段）');
    expect(result.suggestions[0]?.value).toBe('');
  });

  it('院内显式为空时建议清空，与 remove 的说法不同', () => {
    const result = render({
      operations: op({ field: '分期', oldValue: 'ⅡA', newValue: null }),
    });

    expect(result.suggestedText).toBe('分期：建议清空（院内显式为空）');
  });

  it('受控编码字段给出「写法归并后等价，建议统一为受控编码 XXX」措辞', () => {
    const result = render({
      operations: [],
      mergeSuggestions: [
        {
          field: '分期',
          column: '分期',
          rawValue: 'ⅢB',
          hospitalValue: 'IIIB',
          mergedCode: 'IIIB',
          reason: '写法归并后等价，建议统一为受控编码 IIIB',
        },
      ],
    });

    expect(result.suggestedText).toBe('分期：写法归并后等价，建议统一为受控编码 IIIB');
    expect(result.suggestions[0]?.kind).toBe('受控编码建议');
    expect(result.suggestions[0]?.value).toBe('IIIB');
    expect(controlledCodeSuggestionText('IIIB')).toBe(
      '写法归并后等价，建议统一为受控编码 IIIB',
    );
  });

  it('归并失败 / 置信不足 → 需人工判定，建议值留空', () => {
    const manual: ManualField[] = [{ field: '分期', column: '分期' }];
    const result = render({ operations: [], manualFields: manual });

    expect(result.suggestedText).toBe(`分期：${SUGGESTION_MANUAL_JUDGEMENT}`);
    expect(result.suggestions[0]?.kind).toBe('需人工判定');
    expect(result.suggestions[0]?.value).toBeNull();
  });

  it('需人工判定时给出自定义原因，并保留「建议值留空」的交代', () => {
    const manual: ManualField[] = [
      { field: '治疗方案', column: '治疗方案', reason: '写法未能归并到受控编码' },
    ];
    const result = render({ operations: [], manualFields: manual });

    expect(result.suggestedText).toBe(
      '治疗方案：写法未能归并到受控编码，建议值留空，请人工填写',
    );
    expect(result.suggestions[0]?.value).toBeNull();
  });

  it('口径未声明的字段给「口径未声明，不参与比对」而不是空白', () => {
    const result = render({ operations: [], unspecifiedColumns: ['备注'] });

    expect(result.suggestedText).toBe(`备注：${SUGGESTION_CALIBER_UNSPECIFIED}`);
    expect(result.diffText).toBe(`备注：${SUGGESTION_CALIBER_UNSPECIFIED}`);
    expect(result.suggestions[0]?.kind).toBe('口径未声明');
    expect(result.suggestions[0]?.value).toBeNull();
  });

  it('三类建议值都在同一格里时按顺序串联', () => {
    const result = render({
      operations: op({ field: '首次入院日', oldValue: '2024-01-02', newValue: '2024-03-05' }),
      mergeSuggestions: [
        {
          field: '分期',
          column: '分期',
          rawValue: 'ⅢB',
          hospitalValue: 'IIIB',
          mergedCode: 'IIIB',
          reason: '写法归并后等价',
        },
      ],
      manualFields: [{ field: '治疗方案', column: '治疗方案' }],
      unspecifiedColumns: ['备注'],
    });

    expect(result.suggestedText).toBe(
      '首次入院日：建议改为「2024-03-05」；分期：写法归并后等价，建议统一为受控编码 IIIB；治疗方案：写法无法归并到受控编码，建议值留空，请人工填写；备注：口径未声明，不参与比对',
    );
  });
});

describe('diff/render · 脱敏约束', () => {
  it('手机号形态的值被脱敏，文案里不出现完整号码', () => {
    const result = render({
      operations: op({ field: '随访电话', oldValue: '13800138000', newValue: '13900139000' }),
    });

    expect(result.diffText).not.toContain('13800138000');
    expect(result.diffText).not.toContain('13900139000');
    expect(result.diffText).toContain('138****8000');
  });

  it('身份证号形态的值被脱敏', () => {
    const result = render({
      operations: op({
        field: '证件号',
        oldValue: '11010119900307123X',
        newValue: '11010119900307124X',
      }),
    });

    expect(result.diffText).not.toContain('11010119900307123X');
    expect(result.diffText).toContain('110101********123X');
  });

  it('邮箱形态的值被脱敏', () => {
    const result = render({
      operations: op({ field: '联系邮箱', oldValue: 'aaa@example.com', newValue: 'bbb@example.com' }),
    });

    expect(result.diffText).not.toContain('aaa@example.com');
    expect(result.diffText).not.toContain('bbb@example.com');
  });

  it('姓名类字段的值整段脱敏', () => {
    const result = render({
      operations: op({ field: '姓名', oldValue: '张三', newValue: '李四' }),
    });

    expect(result.diffText).not.toContain('张三');
    expect(result.diffText).not.toContain('李四');
    expect(result.diffText).toBe('姓名：（已脱敏） → （已脱敏）（修改）');
  });

  it('renderFieldValue 对姓名类字段返回脱敏标记', () => {
    expect(renderFieldValue('姓名', '张三')).toEqual({ text: '（已脱敏）', redacted: true });
    expect(renderFieldValue('分期', 'ⅢB')).toEqual({ text: 'ⅢB', redacted: false });
  });

  it('登记主索引这类占位标识不受脱敏影响', () => {
    const result = render({
      operations: op({ field: '登记号', oldValue: 'REG-0001', newValue: 'REG-0002' }),
    });

    expect(result.diffText).toBe('登记号：REG-0001 → REG-0002（修改）');
  });
});

describe('diff/render · 状态色板联动', () => {
  it('有差异的行映射到「差异」状态，token 底色与强调色取自色板', () => {
    const result = render({
      operations: op({ field: '分期', oldValue: 'ⅡA', newValue: 'ⅢB' }),
    });

    expect(result.status).toBe('差异');
    expect(result.token).toEqual(getStatusToken('差异'));
    expect(result.token.background).toBe('#FBEAEA');
    expect(result.token.accent).toBe('#D93F3F');
  });

  it('每个变化类型都有一档映射，且全部落在色板已定义的八个状态里', () => {
    const allowed = new Set([
      '一致',
      '无需确认',
      '待确认',
      '差异',
      '需人工判定',
      '零命中',
      '命中歧义',
      '院内已变更，需重查',
    ]);

    for (const [changeKind, status] of Object.entries(DIFF_CHANGE_STATUS)) {
      expect(allowed.has(status), `${changeKind} → ${status}`).toBe(true);
      // 取得到 token 才算映射真的落到色板上
      expect(() => getStatusToken(status)).not.toThrow();
    }
  });

  it('条目级状态可直接供写回层上底色', () => {
    const result = render({
      operations: op({ field: '分期', oldValue: 'ⅡA', newValue: 'ⅢB' }),
      mergeSuggestions: [
        {
          field: '治疗方案',
          column: '治疗方案',
          rawValue: '方案A',
          hospitalValue: '方案B',
          mergedCode: '方案B',
          reason: '写法归并后等价',
        },
      ],
      manualFields: [{ field: '分期', column: '分期' }],
      unspecifiedColumns: ['备注'],
    });

    const byKind = new Map(result.entries.map((entry) => [entry.kind, entry.status]));
    expect(byKind.get('差异')).toBe('差异');
    expect(byKind.get('受控编码建议')).toBe('待确认');
    expect(byKind.get('需人工判定')).toBe('需人工判定');
    expect(byKind.get('口径未声明')).toBe('无需确认');
  });

  it('行级状态按最重的一档取：有差异时不被其它说明盖掉', () => {
    const entries: DiffEntry[] = [
      {
        kind: '口径未声明',
        field: '备注',
        column: '备注',
        label: '备注',
        changeType: null,
        changeKind: null,
        oldText: null,
        newText: null,
        detail: '口径未声明，不参与比对',
        status: '无需确认',
      },
      {
        kind: '差异',
        field: '分期',
        column: '分期',
        label: '分期',
        changeType: '修改',
        changeKind: '值不同',
        oldText: 'ⅡA',
        newText: 'ⅢB',
        detail: 'ⅡA → ⅢB（修改）',
        status: '差异',
      },
    ];

    expect(diffRowStatus(entries)).toBe('差异');
  });

  it('只受控编码归并建议时行状态是「待确认」，不冒充有差异', () => {
    const result = render({
      operations: [],
      mergeSuggestions: [
        {
          field: '分期',
          column: '分期',
          rawValue: 'ⅢB',
          hospitalValue: 'IIIB',
          mergedCode: 'IIIB',
          reason: '写法归并后等价',
        },
      ],
    });

    expect(result.status).toBe('待确认');
    expect(result.token).toEqual(getStatusToken('待确认'));
  });

  it('只有口径未声明的列时行状态是「无需确认」', () => {
    const result = render({ operations: [], unspecifiedColumns: ['备注'] });

    expect(result.status).toBe('无需确认');
  });
});

describe('diff/render · 取值格式化', () => {
  it('缺失与显式空分开说', () => {
    expect(formatDiffValue(undefined)).toBe('（未填）');
    expect(formatDiffValue(null)).toBe('（空）');
  });

  it('数组与对象有可读的短写法', () => {
    expect(formatDiffValue(['A', 'B'])).toBe('A、B');
    expect(formatDiffValue({ code: 'A' })).toBe('{code=A}');
    expect(formatDiffValue([])).toBe('（空列表）');
  });

  it('过长的值被截断并留省略号', () => {
    const text = formatDiffValue('x'.repeat(80));

    expect(text.length).toBeLessThanOrEqual(41);
    expect(text.endsWith('…')).toBe(true);
  });

  it('默认折叠阈值是 3 条', () => {
    expect(DEFAULT_MAX_RENDERED_FIELDS).toBe(3);
  });

  it('渲染不改动引擎产出的操作（纯函数）', () => {
    const operations = op({ field: '分期', oldValue: 'ⅡA', newValue: 'ⅢB' });
    const before = JSON.stringify(operations);

    render({ operations });

    expect(JSON.stringify(operations)).toBe(before);
    expect(diffValuesEqual(operations[0]?.oldValue, 'ⅡA')).toBe(true);
  });
});
