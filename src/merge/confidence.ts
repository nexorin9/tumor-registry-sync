import { DEFAULT_MERGE_CONFIDENCE_THRESHOLD } from '../config/env.js';
import type { MergeMatchBy } from './vocab.js';

/** 置信度层级。 */
export type ConfidenceTier = 'exact' | 'normalized' | 'alias' | 'fuzzy' | 'model';

/** 默认阈值（来自 env：0.8）。 */
export const DEFAULT_THRESHOLD = DEFAULT_MERGE_CONFIDENCE_THRESHOLD;

/** 各层级对应分数。 */
export const TIER_SCORE: Record<ConfidenceTier, number> = {
  exact: 1.0,
  normalized: 0.95,
  alias: 0.9,
  fuzzy: 0.6,
  model: 0.7,
};

/** 将命中方式映射到置信层级；'none' 归为 fuzzy（不会进入任何受信路径）。 */
export function tierOf(matchedBy: MergeMatchBy | 'model'): ConfidenceTier {
  switch (matchedBy) {
    case 'exact':
      return 'exact';
    case 'normalized':
      return 'normalized';
    case 'alias':
      return 'alias';
    case 'model':
      return 'model';
    default:
      return 'fuzzy';
  }
}

/** score >= threshold 即视为可信。低于阈值 → 需人工判定（code 置空）。 */
export function isConfident(score: number, threshold: number): boolean {
  return score >= threshold;
}

/** 由阈值派生的稳定版本串，便于审计/缓存失效。 */
export function confidenceVersion(threshold: number): string {
  return `merge-threshold-${threshold}`;
}

export interface EvaluateInput {
  code: string | null;
  confidence: number;
}

export interface EvaluateOutput {
  accepted: boolean;
  needsHuman: boolean;
}

/**
 * 评估一次归并结果是否可被自动接受。
 * code 为 null 或 confidence 低于阈值 → 需人工判定（accepted:false, needsHuman:true）。
 */
export function evaluateMerge(
  result: EvaluateInput,
  threshold: number,
): EvaluateOutput {
  const accepted = result.code !== null && result.confidence >= threshold;
  return { accepted, needsHuman: !accepted };
}
