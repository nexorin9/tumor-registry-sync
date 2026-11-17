/**
 * 表内呈现 · 状态层。
 *
 * 登记员在表里看到的不只是数据，还有「正在算 / 算完了但没差异 / 算挂了」这三态，
 * 以及跑完之后的完成反馈和重复运行确认。这些字符串面向人，因此写死中文，且
 * **错误态要做分级**：401/403（auth_failed/forbidden）点名缺失的环境变量、超时类
 * 给「可重试」、模型不可达给「已降级」、行级错误把原始 message 带上。
 *
 * 注意：本层不做任何比对 / 推送，只负责把引擎的错误码翻译成登记员能懂的一句话。
 */
import type { ErrorCode, SummaryCounts } from '../../contract/index.js';

/** 呈现态：加载中 / 空表 / 错误 / 就绪。 */
export type PresentState = 'loading' | 'empty' | 'error' | 'ready';

/** 加载态：表尾写一行「对齐中…」，并禁止重复触发本轮对齐。 */
export function renderLoadingState(): { state: 'loading'; receiptLine: string } {
  return { state: 'loading', receiptLine: '对齐中…' };
}

/**
 * 空表态：**不是**一张空白表，而是一句明确的「无需推送」结论。
 * 让登记员下次打开表就知道「这一批已经核过、没有要推的」。
 */
export function renderEmptyState(): { state: 'empty'; message: string } {
  return { state: 'empty', message: '本表与院内记录一致，无需推送' };
}

/** auth_failed / forbidden（对应 HTTP 401/403）→ 点名缺失的环境变量。 */
const ENV_VAR_MESSAGE = '缺少 CDR_API_TOKEN 或 CDR_BASE_URL';
/** 超时 / 服务端错误 / 限流 → 可重试。 */
const RETRYABLE_MESSAGE = '可重试，请稍后重跑';
/** 模型不可达 → 已降级（差异照算，AI 说明用模板句）。 */
const MODEL_DEGRADED_MESSAGE = '模型不可达，已降级';

/**
 * 错误态：按错误码分级给出登记员能执行的下一步。
 *
 * - auth_failed / forbidden → 环境变量缺失（401/403）。
 * - timeout / server_error / rate_limited → 可重试。
 * - model_unavailable → 模型不可达，已降级。
 * - bad_payload / missing_field → 行级错误，把原始 message 带上。
 * - 其余 → 原样透传 message。
 */
export function renderErrorState(err: {
  code: ErrorCode;
  message: string;
  hint: string | null;
}): { state: 'error'; message: string; hint: string | null } {
  if (err.code === 'auth_failed' || err.code === 'forbidden') {
    return { state: 'error', message: ENV_VAR_MESSAGE, hint: err.hint };
  }
  if (err.code === 'timeout' || err.code === 'server_error' || err.code === 'rate_limited') {
    return { state: 'error', message: RETRYABLE_MESSAGE, hint: err.hint };
  }
  if (err.code === 'model_unavailable') {
    return { state: 'error', message: MODEL_DEGRADED_MESSAGE, hint: err.hint };
  }
  if (err.code === 'bad_payload' || err.code === 'missing_field') {
    return { state: 'error', message: `行级错误：${err.message}`, hint: err.hint };
  }
  return { state: 'error', message: err.message, hint: err.hint };
}

/**
 * 重复运行确认：仅当本表已有本批对齐结果时才弹确认框；
 * 否则返回空 prompt（调用方据此决定不弹框）。
 */
export function repeatRunConfirmation(hasExistingResult: boolean): { prompt: string } {
  if (hasExistingResult) {
    return { prompt: '已有本批对齐结果，再次运行将覆盖，确认继续？' };
  }
  return { prompt: '' };
}

/**
 * 完成反馈：一行总结本批推了 / 待确认 / 失败各多少，并带上批次键，
 * 登记员照着批次键就能在 run-log 里对账。
 */
export function completionFeedback(summary: SummaryCounts, batchKey: string): string {
  return `已推送 ${summary.pushed} 行 / 待确认 ${summary.pendingConfirm} 行 / 失败 ${summary.failed} 行（批次键 ${batchKey}）`;
}
