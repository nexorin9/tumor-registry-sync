/**
 * 破坏性判定规则表：把「哪些操作算破坏性」从代码里搬进一张受控规则表。
 *
 * 为什么要一张表：破坏性判定决定「这条改动要不要写前核对、核对不过要不要拒写」。
 * 这件事一旦写死在代码里，就既改不动、也说不清「当时用的是哪版口径」——
 * 登记表里分期这一列被清空了，到底算不算破坏性？信息科需要能自己查、自己改、
 * 改完能留下版本号。所以本层把判定拆成四件事：
 *
 * - **判定条件**（`match`）：操作类型 + 路径模式 + 值形态 + 是否关键字段 + 是否整块替换
 * - **ifMatch 要求**（`ifMatch`）：要不要写前核对、按哪条路径核对、拿哪个值核对
 * - **拒写后果**（`rejectConsequence`）：核对不过时这一行会怎样
 * - **规则表版本**（`version`）：随 run-log 留存，下次核对「当时用的是哪版规则」
 *
 * 四类破坏性（`kind`）：
 * | 类别 | 含义 | 典型场景 |
 * |------|------|----------|
 * | 删除院内已有字段 | 把登记条目里已有的项删掉 | 表里有、院内查不到对应项 |
 * | 覆盖院内非空旧值 | 把别人填好的非空值盖掉 | 同期值不同 |
 * | 清空关键字段 | 关键字段被置空 | 首次入院日被清空 |
 * | 整体替换嵌套对象 | 整块对象被换掉 | 展开深度封顶、属性整块变化 |
 *
 * 四条硬规矩：
 * - **关键字段清单来自口径表**：规则表声明的关键字段必须在字段口径表里查得到，
 *   加载时逐个对账，查不到直接报错点名 —— 不虚构业务数值，也不让规则表自说自话。
 * - **规则按表内顺序评估，第一条命中的为准**：更具体的规则排在前面
 *   （清空关键字段 → 整体替换 → 删除 → 覆盖）。这样「关键字段被清空」不会被
 *   笼统的「覆盖非空旧值」抢走判定，判定结果与登记员看到的口径一致。
 * - **非破坏性操作一律不生成写前核对条件**：往空格里补填不配条件 ——
 *   条件越多，越容易把一次正常补填拖成一次拒写。
 * - **匹配不上的操作不静默丢弃**：命中的规则、生不成的条件、生成不了的原因，
 *   都逐条给出，交给 run-log 与待人工处理清单。
 *
 * 与源产品主路径的关系：源实现的 `createTests(input, patch)` 先用 `isDestructive`
 * 把破坏性操作筛出来，再对每条破坏性操作用 `createTest(input, operation.path)`
 * 按**同一条路径**把目标当前值取出来，生成 `{op:'test', path, value}` 形式的
 * 写前核对条件；路径取不到值时 `createTest` 返回 `undefined`（不生成条件）。
 * 本层把同一套语义落成受控规则表：判定条件可配置、可版本化，
 * 条件形状仍是 `{path, value}`（HTTP 侧没有 JSON Patch 的 test 语义，
 * 改由「发出前本地比对 + 随体携带 ifMatch」两段承担，见 precondition 层）。
 */
import { readFileSync } from 'node:fs';

import { z } from 'zod';

import type { LogEvent, RunLogger } from '../observability/logger.js';

import type { FieldSpec } from './field-spec.js';
import { NESTED_DEPTH_CAPPED_NOTE } from './nested.js';
import type { DiffOp, DiffOperation, DestructiveTagger } from './patch.js';
import { valueKind } from './patch.js';
import { isNonEmptyValue } from './precondition.js';

/** 破坏性判定的四类（规则表里的 kind）。 */
export const DESTRUCTIVE_RULE_KINDS = [
  '删除院内已有字段',
  '覆盖院内非空旧值',
  '清空关键字段',
  '整体替换嵌套对象',
] as const;
export type DestructiveRuleKind = (typeof DESTRUCTIVE_RULE_KINDS)[number];

/** 值形态条件。 */
export const DESTRUCTIVE_VALUE_CONDITIONS = [
  'any',
  'non-empty',
  'empty',
  'missing',
  'null',
  'object',
  'array',
  'scalar',
] as const;
export type DestructiveValueCondition = (typeof DESTRUCTIVE_VALUE_CONDITIONS)[number];

/** 操作类型条件。 */
export const DESTRUCTIVE_OP_CONDITIONS = ['any', 'add', 'replace', 'remove'] as const;
export type DestructiveOpCondition = (typeof DESTRUCTIVE_OP_CONDITIONS)[number];

/** ifMatch 条件取路径的方式：`operation` = 用操作路径（可带下标），`field` = 用口径字段名。 */
export const IFMATCH_PATH_SOURCES = ['operation', 'field'] as const;
export type IfMatchPathSource = (typeof IFMATCH_PATH_SOURCES)[number];

/** ifMatch 条件取期望值的方式：`raw-old-value` = 表里未归一化原值，`old-value` = 归一值。 */
export const IFMATCH_VALUE_SOURCES = ['raw-old-value', 'old-value'] as const;
export type IfMatchValueSource = (typeof IFMATCH_VALUE_SOURCES)[number];

/** 规则的判定条件。 */
export const DestructiveRuleMatchSchema = z.object({
  /** 操作类型：`any` = 不限 */
  op: z.enum(DESTRUCTIVE_OP_CONDITIONS).default('any'),
  /** 路径模式：`**` = 任意路径（含嵌套）；`字段名` = 该字段；`字段名.*` = 该字段下一层 */
  pathPattern: z.string().min(1),
  /** 登记侧旧值的形态条件 */
  oldValue: z.enum(DESTRUCTIVE_VALUE_CONDITIONS).default('any'),
  /** 院内新值的形态条件 */
  newValue: z.enum(DESTRUCTIVE_VALUE_CONDITIONS).default('any'),
  /** 是否只对「关键字段」生效 */
  fieldIsKey: z.boolean().default(false),
  /** 是否只对「整块替换」生效 */
  wholeObject: z.boolean().default(false),
});
export type DestructiveRuleMatch = z.infer<typeof DestructiveRuleMatchSchema>;

/** 规则的写前核对要求。 */
export const DestructiveRuleIfMatchSchema = z.object({
  /** 是否要求写前核对 */
  required: z.boolean(),
  /** 条件路径取法 */
  pathSource: z.enum(IFMATCH_PATH_SOURCES).default('operation'),
  /** 条件期望值取法 */
  valueSource: z.enum(IFMATCH_VALUE_SOURCES).default('raw-old-value'),
});
export type DestructiveRuleIfMatch = z.infer<typeof DestructiveRuleIfMatchSchema>;

/** 规则表里的一条规则。 */
export const DestructiveRuleSchema = z.object({
  /** 规则编号（表内唯一，写进操作打标与 run-log） */
  id: z.string().min(1),
  /** 判定类别 */
  kind: z.enum(DESTRUCTIVE_RULE_KINDS),
  /** 判定条件 */
  match: DestructiveRuleMatchSchema,
  /** 写前核对要求 */
  ifMatch: DestructiveRuleIfMatchSchema,
  /** 核对不过时的后果（面向登记员的一句话） */
  rejectConsequence: z.string().min(1),
  /** 补充说明（为什么这么判） */
  note: z.string().min(1).optional(),
});
export type DestructiveRule = z.infer<typeof DestructiveRuleSchema>;

/** 破坏性判定规则表整体。 */
export const DestructiveRulesSchema = z.object({
  /** 规则表版本号，写进 run-log 供核对当时用的是哪版规则 */
  version: z.string().min(1),
  /** 表级说明 */
  note: z.string().min(1),
  /** 关键字段清单（必须都在字段口径表里声明过） */
  keyFields: z.array(z.string().min(1)).min(1),
  /** 逐条规则（按数组顺序评估，第一条命中的为准） */
  rules: z.array(DestructiveRuleSchema).min(1),
});
export type DestructiveRules = z.infer<typeof DestructiveRulesSchema>;

/** 规则表相关错误：message 里点名具体规则 / 字段，便于信息科照着改表。 */
export class DestructiveRulesError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(issues.length > 0 ? `${message}：${issues.join('；')}` : message);
    this.name = 'DestructiveRulesError';
    this.issues = issues;
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path.length > 0 ? `${path} ${issue.message}` : issue.message;
  });
}

/**
 * 校验破坏性判定规则表。
 *
 * 除了结构校验，还做一组**跨项一致性**检查 —— 这些是规则表最容易写错、
 * 一写错就会让写前核对悄悄失效的地方：
 * - 规则编号不得重复（打标与 run-log 靠编号认规则）
 * - 关键字段清单不得重复，且必须在字段口径表里声明过（给了 `fieldSpec` 才查）
 * - 判「清空关键字段」的规则必须带 `fieldIsKey`；判「整体替换嵌套对象」的规则
 *   必须带 `wholeObject` —— 类别与条件对不上，判定就会名不副实
 * - 判「整体替换嵌套对象」的规则必须要求写前核对（整块替换不核对等于裸写）
 */
export function parseDestructiveRules(
  data: unknown,
  options: { fieldSpec?: FieldSpec } = {},
): DestructiveRules {
  const parsed = DestructiveRulesSchema.safeParse(data);
  if (!parsed.success) {
    throw new DestructiveRulesError('破坏性判定规则表不符合约定', formatIssues(parsed.error));
  }

  const rules = parsed.data;
  const issues: string[] = [];

  const seenRuleIds = new Set<string>();
  for (const rule of rules.rules) {
    if (seenRuleIds.has(rule.id)) {
      issues.push(`规则编号「${rule.id}」重复`);
    }
    seenRuleIds.add(rule.id);

    if (rule.kind === '清空关键字段' && !rule.match.fieldIsKey) {
      issues.push(`规则「${rule.id}」的类别是「清空关键字段」，但判定条件没有限定关键字段`);
    }
    if (rule.kind === '整体替换嵌套对象') {
      if (!rule.match.wholeObject) {
        issues.push(`规则「${rule.id}」的类别是「整体替换嵌套对象」，但判定条件没有限定整块替换`);
      }
      if (!rule.ifMatch.required) {
        issues.push(`规则「${rule.id}」判定为整块替换，必须要求写前核对（整块替换不核对等于裸写）`);
      }
    }
  }

  const seenKeyFields = new Set<string>();
  for (const keyField of rules.keyFields) {
    if (seenKeyFields.has(keyField)) {
      issues.push(`关键字段「${keyField}」重复声明`);
    }
    seenKeyFields.add(keyField);
  }

  const fieldSpec = options.fieldSpec;
  if (fieldSpec !== undefined) {
    const declared = new Set(fieldSpec.fields.map((entry) => entry.field));
    for (const keyField of rules.keyFields) {
      if (!declared.has(keyField)) {
        issues.push(
          `关键字段「${keyField}」在字段口径表里没有声明（口径表已声明：${[...declared].join('、')}）`,
        );
      }
    }
  }

  if (issues.length > 0) {
    throw new DestructiveRulesError('破坏性判定规则表存在规则冲突', issues);
  }

  return rules;
}

/** 从 JSON 文件加载破坏性判定规则表。 */
export function loadDestructiveRules(
  path: string,
  options: { fieldSpec?: FieldSpec } = {},
): DestructiveRules {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DestructiveRulesError(`读取破坏性判定规则表失败：${path}`, [message]);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DestructiveRulesError(`破坏性判定规则表不是合法 JSON：${path}`, [message]);
  }

  return parseDestructiveRules(data, options);
}

/** 把路径拆成段（点号分层，数组下标算一段）。 */
function splitPathSegments(path: string): string[] {
  return path.split('.').filter((segment) => segment.length > 0);
}

/** 一段路径模式是否匹配一段实际路径。 */
function matchSegment(pattern: string, segment: string): boolean {
  return pattern === '*' || pattern === segment;
}

/** 段列表是否匹配（`**` 匹配任意多段，含零段）。 */
function matchSegments(patterns: string[], segments: string[]): boolean {
  if (patterns.length === 0) return segments.length === 0;
  const [head, ...rest] = patterns;
  if (head === undefined) return segments.length === 0;
  if (head === '**') {
    for (let index = 0; index <= segments.length; index += 1) {
      if (matchSegments(rest, segments.slice(index))) return true;
    }
    return false;
  }
  const [first, ...tail] = segments;
  if (first === undefined) return false;
  if (!matchSegment(head, first)) return false;
  return matchSegments(rest, tail);
}

/**
 * 路径模式匹配。
 *
 * - `**` 匹配任意路径（含嵌套路径 `分期.code`、数组下标路径 `证据.list[1].code`）
 * - `*` 匹配**一层**（`分期.*` 匹配 `分期.code`，不匹配 `分期.code.coding`）
 * - 其余按字面匹配
 */
export function matchPathPattern(pattern: string, path: string): boolean {
  if (pattern === '**') return true;
  return matchSegments(splitPathSegments(pattern), splitPathSegments(path));
}

/** 值形态条件是否命中。 */
export function matchesValueCondition(
  condition: DestructiveValueCondition,
  value: unknown,
): boolean {
  switch (condition) {
    case 'any':
      return true;
    case 'non-empty':
      return isNonEmptyValue(value);
    case 'empty':
      return !isNonEmptyValue(value);
    case 'missing':
      return valueKind(value) === 'missing';
    case 'null':
      return valueKind(value) === 'null';
    case 'object':
      return valueKind(value) === 'object';
    case 'array':
      return valueKind(value) === 'array';
    case 'scalar': {
      const kind = valueKind(value);
      return kind === 'string' || kind === 'number' || kind === 'boolean';
    }
    default:
      return false;
  }
}

/**
 * 这条操作是不是「整块替换对象」。
 *
 * 两种形态都算：字段级比对出的「属性变化」（对象整体被换掉），
 * 与嵌套展开深度封顶时的「整块按修改处理」。
 */
export function isWholeObjectReplace(operation: DiffOperation): boolean {
  if (operation.changeKind === '属性变化') return true;
  return operation.detail?.note === NESTED_DEPTH_CAPPED_NOTE;
}

/** 一条规则是否命中这条操作。 */
export function matchesDestructiveRule(
  rule: DestructiveRule,
  operation: DiffOperation,
  rules: DestructiveRules,
): boolean {
  const match = rule.match;
  if (match.op !== 'any' && match.op !== operation.op) return false;
  if (!matchPathPattern(match.pathPattern, operation.path)) return false;
  if (!matchesValueCondition(match.oldValue, operation.oldValue)) return false;
  if (!matchesValueCondition(match.newValue, operation.newValue)) return false;
  if (match.fieldIsKey && !rules.keyFields.includes(operation.field)) return false;
  if (match.wholeObject && !isWholeObjectReplace(operation)) return false;
  return true;
}

/** 一条操作的破坏性判定结果。 */
export interface DestructiveVerdict {
  /** 是否破坏性 */
  destructive: boolean;
  /** 命中的规则编号（未命中为 null） */
  ruleId: string | null;
  /** 命中的判定类别（未命中为 null） */
  kind: DestructiveRuleKind | null;
  /** 命中的规则（未命中为 null） */
  rule: DestructiveRule | null;
  /** 命中的全部规则（按表内顺序，第一条为准） */
  matchedRules: DestructiveRule[];
  /** 面向人的原因 */
  reason: string;
}

/**
 * 按规则表判定一条操作是否破坏性。
 *
 * 规则按表内顺序评估，**第一条命中的规则为准** —— 更具体的规则排在前面，
 * 「关键字段被清空」不会被笼统的「覆盖非空旧值」抢走判定。
 */
export function evaluateDestructiveRules(
  operation: DiffOperation,
  rules: DestructiveRules,
): DestructiveVerdict {
  const matchedRules = rules.rules.filter((rule) =>
    matchesDestructiveRule(rule, operation, rules),
  );
  const primary = matchedRules[0];
  if (primary === undefined) {
    return {
      destructive: false,
      ruleId: null,
      kind: null,
      rule: null,
      matchedRules: [],
      reason: '非破坏性操作：写前不核对',
    };
  }
  return {
    destructive: true,
    ruleId: primary.id,
    kind: primary.kind,
    rule: primary,
    matchedRules,
    reason: `${primary.kind}（规则 ${primary.id}）`,
  };
}

/**
 * 给差异引擎用的破坏性打标器。
 *
 * 差异引擎本身不认识规则表，只认识这个形状 —— 规则表换版本时，差异引擎一行不改。
 */
export function createDestructiveTagger(rules: DestructiveRules): DestructiveTagger {
  return (operation: DiffOperation) => {
    const verdict = evaluateDestructiveRules(operation, rules);
    return {
      destructive: verdict.destructive,
      ruleId: verdict.ruleId,
      kind: verdict.kind,
    };
  };
}

/**
 * 给一批操作打上破坏性标记（返回新对象，不改入参）。
 *
 * 标记进操作结构（`destructive` / `destructiveRuleId` / `destructiveKind`），
 * 后续的写前核对、run-log、差异文案都读这个标记，不必再各自判一遍。
 */
export function annotateDestructiveOperations(
  operations: DiffOperation[],
  rules: DestructiveRules,
): DiffOperation[] {
  const tagger = createDestructiveTagger(rules);
  return operations.map((operation) => {
    const tag = tagger(operation);
    return {
      ...operation,
      destructive: tag.destructive,
      destructiveRuleId: tag.ruleId,
      destructiveKind: tag.kind,
    };
  });
}

/** 一条写前核对条件（形状与源产品的 test 条件一致：路径 + 期望值）。 */
export interface RuleIfMatchCondition {
  /** 写前要核对的路径 */
  path: string;
  /** 期望值：写这条之前目标侧应持有的值 */
  value: unknown;
  /** 口径字段名 */
  field: string;
  /** 产生该条件的操作类型 */
  op: DiffOp;
  /** 命中的规则编号 */
  ruleId: string;
  /** 命中的判定类别 */
  kind: DestructiveRuleKind;
  /** 面向人的原因 */
  reason: string;
}

/** 生不成条件的破坏性操作（逐条说清原因，不静默丢弃）。 */
export interface SkippedIfMatchCondition {
  /** 口径字段名 */
  field: string;
  /** 操作路径 */
  path: string;
  /** 命中的规则编号 */
  ruleId: string;
  /** 生不成的原因 */
  reason: string;
}

/** 一批的写前核对条件生成结果。 */
export interface RuleIfMatchResult {
  /** 随体携带的 ifMatch 条件（逐条对应一条破坏性操作） */
  conditions: RuleIfMatchCondition[];
  /** 生不成条件的破坏性操作 */
  skipped: SkippedIfMatchCondition[];
  /** 本次用的规则表版本 */
  rulesVersion: string;
  /** 规则命中计数（按规则编号，次数降序） */
  ruleHits: Array<{ ruleId: string; kind: DestructiveRuleKind; count: number }>;
}

/**
 * 按规则表生成写前核对条件。
 *
 * **只有破坏性操作才生成条件**；非破坏性操作一条都不配 —— 条件越多，
 * 越容易把一次正常的补填拖成一次拒写。条件形状为 `{path, value}`，
 * 与源产品 `createTest()` 产出的写前核对条件同形。
 */
export function createRuleIfMatchConditions(
  operations: DiffOperation[],
  rules: DestructiveRules,
): RuleIfMatchResult {
  const conditions: RuleIfMatchCondition[] = [];
  const skipped: SkippedIfMatchCondition[] = [];
  const hits = new Map<string, { ruleId: string; kind: DestructiveRuleKind; count: number }>();

  for (const operation of operations) {
    const verdict = evaluateDestructiveRules(operation, rules);
    if (!verdict.destructive || verdict.rule === null) continue;

    const rule = verdict.rule;
    const current = hits.get(rule.id);
    if (current === undefined) {
      hits.set(rule.id, { ruleId: rule.id, kind: rule.kind, count: 1 });
    } else {
      current.count += 1;
    }

    if (!rule.ifMatch.required) {
      skipped.push({
        field: operation.field,
        path: operation.path,
        ruleId: rule.id,
        reason: `规则「${rule.id}」判定为破坏性，但不要求写前核对`,
      });
      continue;
    }

    const path = rule.ifMatch.pathSource === 'field' ? operation.field : operation.path;
    const value =
      rule.ifMatch.valueSource === 'raw-old-value'
        ? operation.rawOldValue === undefined
          ? operation.oldValue
          : operation.rawOldValue
        : operation.oldValue;

    if (value === undefined) {
      skipped.push({
        field: operation.field,
        path,
        ruleId: rule.id,
        reason: `取不到写前应有的原值，无法为「${path}」生成写前核对条件`,
      });
      continue;
    }

    conditions.push({
      path,
      value,
      field: operation.field,
      op: operation.op,
      ruleId: rule.id,
      kind: rule.kind,
      reason: verdict.reason,
    });
  }

  const ruleHits = [...hits.values()].sort((left, right) => {
    if (left.count !== right.count) return right.count - left.count;
    return left.ruleId < right.ruleId ? -1 : left.ruleId > right.ruleId ? 1 : 0;
  });

  return { conditions, skipped, rulesVersion: rules.version, ruleHits };
}

/** 规则表版本的一句话描述（写进 run-log 与摘要）。 */
export function describeRulesVersion(rules: DestructiveRules): string {
  return `破坏性判定规则表版本 ${rules.version} 生效：${rules.rules.length} 条规则，关键字段 ${rules.keyFields.length} 个（${rules.keyFields.join('、')}）`;
}

/**
 * 造一条「规则表版本已生效」的日志事件。
 *
 * 写进 run-log 是为了下次核对「当时用的是哪版规则」时能查到 ——
 * 规则表改了、结果对不上时，先看这一条。
 */
export function buildRulesVersionEvent(rules: DestructiveRules, now: Date = new Date()): LogEvent {
  return {
    ts: now.toISOString(),
    stage: 'system',
    outcome: 'ok',
    rowNumber: null,
    rowId: null,
    errorCode: null,
    retryable: null,
    durationMs: null,
    attempts: 1,
    message: describeRulesVersion(rules),
    hint: '规则表版本随 run-log 留存；结果对不上时先核对这一条',
    rulesVersion: rules.version,
  };
}

/** 把规则表版本记进 run-log（不落盘，由调用方 flush）。 */
export function recordRulesVersion(logger: RunLogger, rules: DestructiveRules): LogEvent {
  const event = buildRulesVersionEvent(rules);
  logger.push(event);
  return event;
}
