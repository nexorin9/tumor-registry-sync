/**
 * 实体绑定判定：登记表的一行 ↔ 院内的一条权威记录。
 *
 * 这是整条主路径上**最不能出错的一步**——绑错了，后面算出来的每一条差异都是错的，
 * 而且会被推给专病库。所以这一层的规矩写得很死：
 *
 * - 命中 **>1** 条 → 判**歧义**：不产出任何差异值，绝不取第一条
 * - 命中 **=0** 条 → 判**零命中**：不产出任何差异值
 * - 检索没跑完 / 资源不可用 → 判**未完成**：与「零命中」分开，不谎报
 *
 * 四种判定里只有「命中」能往下走（取诊断与就诊）。其余三种一律停在门口。
 */
import type { BindingOutcome, RowIssue } from '../contract/index.js';

import { parsePatient, type PatientView } from './parse.js';
import type { FhirResource } from './types.js';

/** 绑定判定结果。 */
export interface BindingDecision {
  /** 判定结果：命中 / 歧义 / 零命中 / 未完成 */
  outcome: BindingOutcome;
  /** 绑定的患者（只有命中时非空） */
  patient: PatientView | null;
  /** 院内命中的患者资源条数 */
  hitCount: number;
  /** 行级问题（歧义 / 零命中 / 缺关键字段各出一条） */
  issue: RowIssue | null;
}

/** 绑定上下文。 */
export interface BindingContext {
  /** 表内行号 */
  rowNumber: number;
  /** 登记主索引（脱敏占位标识） */
  registryId: string;
  /** 登记主索引的 identifier system，用于提示核对 */
  identifierSystem: string;
}

/**
 * 判定一行登记记录与院内患者记录的绑定关系。
 *
 * @param hits 院内按登记主索引检索到的患者资源
 * @param context 行号、登记号与 identifier system
 */
export function bindPatientHits(
  hits: FhirResource[],
  context: BindingContext,
): BindingDecision {
  const { rowNumber, registryId, identifierSystem } = context;

  if (hits.length === 0) {
    return {
      outcome: '零命中',
      patient: null,
      hitCount: 0,
      issue: {
        rowNumber,
        registryId,
        code: 'NO_MATCH',
        reason: `登记号 ${registryId} 在院内未检索到患者记录`,
        hint: `请核对登记号与 CDR_IDENTIFIER_SYSTEM（${identifierSystem}）是否一致；本行不产出差异值、不进推送体`,
        blocking: false,
      },
    };
  }

  if (hits.length > 1) {
    return {
      outcome: '歧义',
      patient: null,
      hitCount: hits.length,
      issue: {
        rowNumber,
        registryId,
        code: 'AMBIGUOUS_MATCH',
        reason: `登记号 ${registryId} 在院内检索到 ${hits.length} 条患者记录`,
        hint:
          '院内同一登记号对应多条记录，本行不产出差异值、不进推送体；请先在院内确认唯一记录后重跑',
        blocking: false,
      },
    };
  }

  const parsed = parsePatient(hits[0] as FhirResource);
  if (parsed.patient === null) {
    return {
      outcome: '未完成',
      patient: null,
      hitCount: 1,
      issue: {
        rowNumber,
        registryId,
        code: 'MISSING_FIELD',
        reason: `登记号 ${registryId} 命中 1 条院内记录，但该记录缺 Patient.id，无法作为唯一绑定`,
        hint: '本轮未取得可绑定的院内值，请联系信息科核对院内 Patient 资源后重跑',
        blocking: false,
      },
    };
  }

  return { outcome: '命中', patient: parsed.patient, hitCount: 1, issue: null };
}

/**
 * 绑定未完成时的行级问题（检索失败、坏响应等）。
 * 与「零命中」分开：检索失败不代表院内没有这条登记号。
 */
export function incompleteBindingIssue(
  context: BindingContext,
  reason: string,
  hint: string,
): RowIssue {
  return {
    rowNumber: context.rowNumber,
    registryId: context.registryId,
    code: 'SEARCH_FAILED',
    reason,
    hint,
    blocking: false,
  };
}

/**
 * 断言绑定已命中：只有命中才允许往下取诊断与就诊。
 *
 * 这是「绝不取第一条」的守卫点——歧义与零命中走到这里会直接报错，
 * 而不是悄悄拿某一条继续算差异。
 */
export function assertBound(decision: BindingDecision, context: BindingContext): PatientView {
  if (decision.outcome !== '命中' || decision.patient === null) {
    throw new Error(
      `绑定未命中（${decision.outcome}），不得继续取数：登记号 ${context.registryId}`,
    );
  }
  return decision.patient;
}
