import type { ModelGateway } from '../model/gateway.js';
import { mergeByVocab } from './vocab.js';
import { isConfident } from './confidence.js';
import type { VocabIndex } from './vocab-index.js';

/** 归并来源。 */
export type MergeSource = 'exact' | 'normalized' | 'alias' | 'model' | 'none';

export interface MergeWithFallbackInput {
  term: string;
  field: string;
  /** 是否为受控编码字段；只有受控字段才允许走模型兜底。 */
  controlledCodeField: boolean;
  candidates?: { code: string; label: string }[];
}

export interface MergeWithFallbackResult {
  code: string | null;
  confidence: number;
  reason: string;
  source: MergeSource;
}

export interface MergeWithFallbackOptions {
  vocab: VocabIndex;
  model: ModelGateway | null;
  threshold: number;
  modelCandidates?: { code: string; label: string }[];
}

/**
 * 带模型兜底的归并。
 *
 * 流程：
 * 1. 先走词表；命中且超过阈值 → 直接返回（exact/normalized/alias）。
 * 2. 仅当「词表未命中」且「是受控编码字段」且「模型可用」时，才调用模型兜底；
 *    模型输出需校验（code 为 string|null，confidence 在 0..1），且必须通过阈值门禁，
 *    否则一律判为需人工判定。
 * 3. 其余任何情况 → code 置空、reason『需人工判定』、source『none』。
 *
 * 重要：本函数只返回「建议」，绝不直接写入推送体；低于阈值时模型猜测值一律被丢弃（code=null）。
 */
export async function mergeWithModelFallback(
  input: MergeWithFallbackInput,
  opts: MergeWithFallbackOptions,
): Promise<MergeWithFallbackResult> {
  const vocabResult = mergeByVocab(input.term, opts.vocab);

  if (vocabResult.matchedBy !== 'none' && isConfident(vocabResult.confidence, opts.threshold)) {
    return {
      code: vocabResult.code,
      confidence: vocabResult.confidence,
      reason: vocabResult.reason,
      source: vocabResult.matchedBy,
    };
  }

  const noVocabHit = vocabResult.matchedBy === 'none';

  if (noVocabHit && input.controlledCodeField && opts.model !== null) {
    const out = await opts.model.mergeTerm({
      term: input.term,
      candidates: opts.modelCandidates ?? input.candidates ?? [],
      field: input.field,
    });

    if (
      out !== null &&
      typeof out === 'object' &&
      (out.code === null || typeof out.code === 'string') &&
      typeof out.confidence === 'number' &&
      out.confidence >= 0 &&
      out.confidence <= 1
    ) {
      if (
        out.code !== null &&
        out.code.length > 0 &&
        isConfident(out.confidence, opts.threshold)
      ) {
        return {
          code: out.code,
          confidence: out.confidence,
          reason: '模型归并建议',
          source: 'model',
        };
      }
    }
  }

  return { code: null, confidence: 0, reason: '需人工判定', source: 'none' };
}
