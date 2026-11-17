import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { RunLogger, readRunLog } from '../../src/observability/logger.js';
import {
  DESTRUCTIVE_RULE_KINDS,
  DestructiveRulesError,
  annotateDestructiveOperations,
  buildRulesVersionEvent,
  createDestructiveTagger,
  createRuleIfMatchConditions,
  describeRulesVersion,
  evaluateDestructiveRules,
  isWholeObjectReplace,
  loadDestructiveRules,
  matchPathPattern,
  parseDestructiveRules,
  recordRulesVersion,
} from '../../src/diff/index.js';
import { loadFieldSpec } from '../../src/diff/field-spec.js';
import { diffFields, diffRowAgainstRecord, diffValues } from '../../src/diff/patch.js';
import { diffFieldsNested, diffNested } from '../../src/diff/nested.js';
import { destructiveReason, isDestructive } from '../../src/diff/precondition.js';
import type { DestructiveRules } from '../../src/diff/destructive-rules.js';

const spec = loadFieldSpec('config/field-spec.json');
const rules = loadDestructiveRules('config/destructive-rules.json', { fieldSpec: spec });

const temporaryDirs: string[] = [];

afterAll(() => {
  for (const dir of temporaryDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 写一份临时规则表文件，返回路径。 */
function writeTempRules(content: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'destructive-rules-'));
  temporaryDirs.push(dir);
  const path = join(dir, 'rules.json');
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  writeFileSync(path, text, 'utf8');
  return path;
}

/** 用真实差异引擎造一条操作，避免测试里手搓引擎产物。 */
function operation(input: {
  field?: string;
  oldValue: unknown;
  newValue: unknown;
  rawOldValue?: unknown;
}): ReturnType<typeof diffValues> {
  return diffValues({
    path: input.field ?? '分期',
    field: input.field ?? '分期',
    column: input.field ?? '分期',
    oldValue: input.oldValue,
    newValue: input.newValue,
    rawOldValue: input.rawOldValue,
  });
}

describe('规则表加载与校验', () => {
  it('config/destructive-rules.json 加载通过，版本号与规则齐备', () => {
    expect(rules.version.length).toBeGreaterThan(0);
    expect(rules.rules.length).toBeGreaterThanOrEqual(4);
    expect(rules.note.length).toBeGreaterThan(0);
  });

  it('关键字段清单取自字段口径表已声明的字段', () => {
    const declared = new Set(spec.fields.map((entry) => entry.field));
    for (const keyField of rules.keyFields) {
      expect(declared.has(keyField)).toBe(true);
    }
    expect(rules.keyFields).toContain('首次入院日');
    expect(rules.keyFields).toContain('本次就诊开始');
    expect(rules.keyFields).toContain('登记号');
  });

  it('关键字段不在口径表里 → 加载报错并点名该字段', () => {
    const broken = {
      ...rules,
      keyFields: [...rules.keyFields, '不存在的关键字段'],
    };
    expect(() => parseDestructiveRules(broken, { fieldSpec: spec })).toThrow(
      DestructiveRulesError,
    );
    expect(() => parseDestructiveRules(broken, { fieldSpec: spec })).toThrow(
      /不存在的关键字段.*字段口径表里没有声明/,
    );
  });

  it('规则编号重复 → 加载报错并点名编号', () => {
    const duplicated = {
      ...rules,
      rules: [...rules.rules, { ...rules.rules[0]! }],
    };
    expect(() => parseDestructiveRules(duplicated)).toThrow(/规则编号「.*」重复/);
  });

  it('关键字段重复声明 → 加载报错并点名字段', () => {
    const duplicated = {
      ...rules,
      keyFields: [rules.keyFields[0]!, rules.keyFields[0]!],
    };
    expect(() => parseDestructiveRules(duplicated)).toThrow(/关键字段「.*」重复声明/);
  });

  it('类别与判定条件对不上 → 加载报错并点名规则', () => {
    const mismatched = {
      ...rules,
      rules: rules.rules.map((rule) =>
        rule.id === 'clear-key-field' ? { ...rule, match: { ...rule.match, fieldIsKey: false } } : rule,
      ),
    };
    expect(() => parseDestructiveRules(mismatched)).toThrow(
      /规则「clear-key-field」.*「清空关键字段」.*没有限定关键字段/,
    );
  });

  it('整块替换的规则不要求写前核对 → 加载报错并点名规则', () => {
    const mismatched = {
      ...rules,
      rules: rules.rules.map((rule) =>
        rule.id === 'whole-object-replace'
          ? { ...rule, ifMatch: { ...rule.ifMatch, required: false } }
          : rule,
      ),
    };
    expect(() => parseDestructiveRules(mismatched)).toThrow(
      /规则「whole-object-replace」.*必须要求写前核对/,
    );
  });

  it('规则表文件不存在 → 报错点名路径', () => {
    expect(() => loadDestructiveRules('config/不存在的规则表.json')).toThrow(DestructiveRulesError);
    expect(() => loadDestructiveRules('config/不存在的规则表.json')).toThrow(
      /config\/不存在的规则表\.json/,
    );
  });

  it('规则表不是合法 JSON → 报错点名路径', () => {
    const path = writeTempRules('{ 这不是 JSON');
    expect(() => loadDestructiveRules(path)).toThrow(/不是合法 JSON/);
  });
});

describe('路径模式匹配', () => {
  it('`**` 匹配任意路径（含嵌套与数组下标）', () => {
    expect(matchPathPattern('**', '分期')).toBe(true);
    expect(matchPathPattern('**', '分期.code')).toBe(true);
    expect(matchPathPattern('**', '证据.list[1].code')).toBe(true);
  });

  it('字段名只匹配该字段本身', () => {
    expect(matchPathPattern('分期', '分期')).toBe(true);
    expect(matchPathPattern('分期', '分期.code')).toBe(false);
    expect(matchPathPattern('分期', '治疗方案')).toBe(false);
  });

  it('`*` 只匹配一层', () => {
    expect(matchPathPattern('分期.*', '分期.code')).toBe(true);
    expect(matchPathPattern('分期.*', '分期.code.coding')).toBe(false);
    expect(matchPathPattern('分期.*', '分期')).toBe(false);
  });
});

describe('四类破坏性判定', () => {
  it('删除院内已有字段 → 命中删除规则', () => {
    const [op] = operation({ oldValue: 'IIIB', newValue: undefined });
    expect(op?.op).toBe('remove');
    const verdict = evaluateDestructiveRules(op!, rules);
    expect(verdict.destructive).toBe(true);
    expect(verdict.kind).toBe('删除院内已有字段');
    expect(verdict.ruleId).toBe('remove-existing-field');
  });

  it('覆盖院内非空旧值 → 命中覆盖规则', () => {
    const [op] = operation({ oldValue: 'IIIB', newValue: 'IVA' });
    const verdict = evaluateDestructiveRules(op!, rules);
    expect(verdict.destructive).toBe(true);
    expect(verdict.kind).toBe('覆盖院内非空旧值');
    expect(verdict.ruleId).toBe('overwrite-non-empty');
  });

  it('清空关键字段 → 命中清空规则（不被笼统的覆盖规则抢走）', () => {
    const [op] = operation({ field: '首次入院日', oldValue: '2024-03-05', newValue: null });
    expect(op?.op).toBe('replace');
    const verdict = evaluateDestructiveRules(op!, rules);
    expect(verdict.destructive).toBe(true);
    expect(verdict.kind).toBe('清空关键字段');
    expect(verdict.ruleId).toBe('clear-key-field');
  });

  it('非关键字段被清空 → 不命中清空规则，按覆盖非空旧值判', () => {
    const [op] = operation({ field: '分期', oldValue: 'IIIB', newValue: null });
    const verdict = evaluateDestructiveRules(op!, rules);
    expect(verdict.kind).toBe('覆盖院内非空旧值');
  });

  it('整体替换嵌套对象 → 命中整块替换规则', () => {
    const [op] = operation({
      field: '证据',
      oldValue: { 部位: '肺', 编码: 'C34.9' },
      newValue: { 部位: '纵隔', 编码: 'C38.0' },
    });
    expect(op?.changeKind).toBe('属性变化');
    expect(isWholeObjectReplace(op!)).toBe(true);
    const verdict = evaluateDestructiveRules(op!, rules);
    expect(verdict.kind).toBe('整体替换嵌套对象');
    expect(verdict.ruleId).toBe('whole-object-replace');
  });

  it('嵌套展开深度封顶 → 同样判为整块替换', () => {
    let oldValue: Record<string, unknown> = { leaf: '旧' };
    let newValue: Record<string, unknown> = { leaf: '新' };
    for (let depth = 0; depth < 10; depth += 1) {
      oldValue = { child: oldValue };
      newValue = { child: newValue };
    }
    const operations = diffNested({
      path: '证据',
      field: '证据',
      oldValue,
      newValue,
      maxDepth: 2,
    });
    expect(operations).toHaveLength(1);
    expect(isWholeObjectReplace(operations[0]!)).toBe(true);
    const verdict = evaluateDestructiveRules(operations[0]!, rules);
    expect(verdict.kind).toBe('整体替换嵌套对象');
  });

  it('往空格里补填 → 不判为破坏性', () => {
    const [op] = operation({ oldValue: null, newValue: 'IIIB' });
    expect(op?.op).toBe('add');
    const verdict = evaluateDestructiveRules(op!, rules);
    expect(verdict.destructive).toBe(false);
    expect(verdict.ruleId).toBeNull();
    expect(verdict.kind).toBeNull();
  });

  it('四类判定类别都在规则表里声明过', () => {
    const declared = new Set(rules.rules.map((rule) => rule.kind));
    for (const kind of DESTRUCTIVE_RULE_KINDS) {
      expect(declared.has(kind)).toBe(true);
    }
  });
});

describe('与基线破坏性判定的一致性', () => {
  const cases: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [
    { field: '分期', oldValue: 'IIIB', newValue: undefined },
    { field: '分期', oldValue: 'IIIB', newValue: 'IVA' },
    { field: '分期', oldValue: null, newValue: 'IIIB' },
    { field: '分期', oldValue: '', newValue: 'IIIB' },
    { field: '分期', oldValue: 'IIIB', newValue: null },
    { field: '首次入院日', oldValue: '2024-03-05', newValue: null },
    { field: '首次入院日', oldValue: '2024-03-05', newValue: '2024-03-06' },
    { field: '分期', oldValue: 0, newValue: 1 },
  ];

  it('基线判为破坏性的，规则表也判为破坏性；反之亦然', () => {
    for (const item of cases) {
      const [op] = operation(item);
      expect(op).toBeDefined();
      const baseline = isDestructive(op!);
      const table = evaluateDestructiveRules(op!, rules).destructive;
      expect(table).toBe(baseline);
    }
  });

  it('两侧同值 → 根本不产生操作，自然谈不上破坏性', () => {
    const operations = operation({ oldValue: 'IIIB', newValue: 'IIIB' });
    expect(operations).toHaveLength(0);
  });

  it('基线判定仍给出两条基础理由', () => {
    const [remove] = operation({ oldValue: 'IIIB', newValue: undefined });
    expect(destructiveReason(remove!)).toBe('删除院内已有字段');
    const [replace] = operation({ oldValue: 'IIIB', newValue: 'IVA' });
    expect(destructiveReason(replace!)).toBe('覆盖院内非空旧值');
  });
});

describe('ifMatch 写前核对条件生成', () => {
  it('只给破坏性操作生成条件，非破坏性一条都不生成', () => {
    const operations = [
      ...operation({ oldValue: 'IIIB', newValue: 'IVA' }),
      ...operation({ oldValue: null, newValue: 'IIIB' }),
    ];
    const result = createRuleIfMatchConditions(operations, rules);
    expect(result.conditions).toHaveLength(1);
    expect(result.conditions[0]?.path).toBe('分期');
    expect(result.conditions[0]?.field).toBe('分期');
    expect(result.conditions[0]?.op).toBe('replace');
    expect(result.conditions[0]?.ruleId).toBe('overwrite-non-empty');
  });

  it('条件形状是 {path, value}，期望值取表里未归一化原值', () => {
    const [op] = operation({
      oldValue: 'IIIB',
      newValue: 'IVA',
      rawOldValue: ' ⅢB ',
    });
    const result = createRuleIfMatchConditions([op!], rules);
    expect(result.conditions[0]?.path).toBe('分期');
    expect(result.conditions[0]?.value).toBe(' ⅢB ');
  });

  it('清空关键字段按字段名配条件（不是按操作路径）', () => {
    const [op] = operation({ field: '首次入院日', oldValue: '2024-03-05', newValue: null });
    const result = createRuleIfMatchConditions([op!], rules);
    expect(result.conditions[0]?.path).toBe('首次入院日');
    expect(result.conditions[0]?.kind).toBe('清空关键字段');
    expect(result.conditions[0]?.value).toBe('2024-03-05');
  });

  it('规则命中计数按规则编号汇总', () => {
    const operations = [
      ...operation({ oldValue: 'IIIB', newValue: 'IVA' }),
      ...operation({ oldValue: 'IIIA', newValue: 'IIIB' }),
      ...operation({ field: '首次入院日', oldValue: '2024-03-05', newValue: null }),
    ];
    const result = createRuleIfMatchConditions(operations, rules);
    const hits = new Map(result.ruleHits.map((hit) => [hit.ruleId, hit.count]));
    expect(hits.get('overwrite-non-empty')).toBe(2);
    expect(hits.get('clear-key-field')).toBe(1);
    expect(result.conditions).toHaveLength(3);
  });

  it('规则不要求写前核对 → 逐条记明原因，不静默丢弃', () => {
    const noCheck: DestructiveRules = {
      ...rules,
      rules: rules.rules.map((rule) =>
        rule.id === 'overwrite-non-empty'
          ? { ...rule, ifMatch: { ...rule.ifMatch, required: false } }
          : rule,
      ),
    };
    const [op] = operation({ oldValue: 'IIIB', newValue: 'IVA' });
    const result = createRuleIfMatchConditions([op!], noCheck);
    expect(result.conditions).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.ruleId).toBe('overwrite-non-empty');
    expect(result.skipped[0]?.reason).toContain('不要求写前核对');
  });

  it('结果里带本次用的规则表版本', () => {
    const result = createRuleIfMatchConditions([], rules);
    expect(result.rulesVersion).toBe(rules.version);
  });
});

describe('接入差异引擎（打标进操作结构）', () => {
  it('逐行比对产出的操作带上破坏性标记', () => {
    const result = diffRowAgainstRecord({
      spec,
      registryValues: { 分期: 'IIIB', 首次入院日: '2024-03-05' },
      hospitalValues: { 分期: 'IVA', 首次入院日: null },
      tagDestructive: createDestructiveTagger(rules),
    });
    const byField = new Map(result.operations.map((op) => [op.field, op]));
    expect(byField.get('分期')?.destructive).toBe(true);
    expect(byField.get('分期')?.destructiveRuleId).toBe('overwrite-non-empty');
    expect(byField.get('分期')?.destructiveKind).toBe('覆盖院内非空旧值');
    expect(byField.get('首次入院日')?.destructive).toBe(true);
    expect(byField.get('首次入院日')?.destructiveRuleId).toBe('clear-key-field');
  });

  it('不提供打标器时操作不带破坏性标记', () => {
    const result = diffRowAgainstRecord({
      spec,
      registryValues: { 分期: 'IIIB' },
      hospitalValues: { 分期: 'IVA' },
    });
    expect(result.operations[0]?.destructive).toBeUndefined();
    expect(result.operations[0]?.destructiveRuleId).toBeUndefined();
  });

  it('嵌套展开层同样打标', () => {
    const operations = diffFieldsNested(
      [{ field: '证据', oldValue: { 部位: '肺' }, newValue: { 部位: '纵隔' } }],
      { tagDestructive: createDestructiveTagger(rules) },
    );
    expect(operations.length).toBeGreaterThan(0);
    expect(operations[0]?.destructive).toBe(true);
    expect(operations[0]?.destructiveRuleId).toBe('overwrite-non-empty');
  });

  it('逐字段比对入口也支持打标', () => {
    const operations = diffFields(
      [{ field: '分期', oldValue: 'IIIB', newValue: 'IVA' }],
      { tagDestructive: createDestructiveTagger(rules) },
    );
    expect(operations[0]?.destructive).toBe(true);
  });

  it('打标不改入参（返回新对象）', () => {
    const operations = operation({ oldValue: 'IIIB', newValue: 'IVA' });
    const annotated = annotateDestructiveOperations(operations, rules);
    expect(annotated[0]?.destructive).toBe(true);
    expect(operations[0]?.destructive).toBeUndefined();
  });
});

describe('规则表版本留存（run-log）', () => {
  it('版本事件写进 run-log，可按批次检索', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rules-runlog-'));
    temporaryDirs.push(dir);
    const path = join(dir, 'run-log.jsonl');
    const logger = new RunLogger({ path });
    const event = recordRulesVersion(logger, rules);
    expect(event.rulesVersion).toBe(rules.version);
    expect(event.message).toContain(rules.version);
    expect(logger.flush()).toBe(1);
    const events = readRunLog(path);
    expect(events).toHaveLength(1);
    expect(events[0]?.rulesVersion).toBe(rules.version);
  });

  it('版本变更 → 留档的事件随之变化，可分辨用的是哪版规则', () => {
    const nextVersion: DestructiveRules = { ...rules, version: '0.2.0' };
    const first = buildRulesVersionEvent(rules, new Date('2026-01-01T00:00:00Z'));
    const second = buildRulesVersionEvent(nextVersion, new Date('2026-01-02T00:00:00Z'));
    expect(first.rulesVersion).toBe('0.1.0');
    expect(second.rulesVersion).toBe('0.2.0');
    expect(first.message).not.toBe(second.message);
    expect(describeRulesVersion(nextVersion)).toContain('0.2.0');
  });

  it('版本事件不落任何患者可识别明报', () => {
    const event = buildRulesVersionEvent(rules);
    const text = JSON.stringify(event);
    expect(text).not.toMatch(/1[3-9]\d{9}/);
    expect(text).not.toMatch(/\d{17}[\dXx]/);
  });

  it('规则表文件里的版本号与加载结果一致', () => {
    const raw = JSON.parse(readFileSync('config/destructive-rules.json', 'utf8')) as {
      version: string;
    };
    expect(raw.version).toBe(rules.version);
  });
});
