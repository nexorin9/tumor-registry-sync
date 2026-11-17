/**
 * 模型层统一出口：OpenAI 兼容网关 + 调用审计。
 */
export type {
  MergeTermInput,
  MergeTermOutput,
  ExplainDiffInput,
  ExplainDiffOutput,
  ModelGateway,
  OpenAIGatewayOptions,
} from './gateway.js';
export {
  OpenAIGateway,
  ModelUnavailableError,
  degradedMergeTerm,
  degradedExplainDiff,
  isDegradedMerge,
} from './gateway.js';

export type {
  ModelCallUsage,
  ModelCallMeta,
  ModelAuditRecorder,
} from './audit.js';
export {
  promptHash,
  desensitize,
  writeModelAudit,
  RunLoggerAuditRecorder,
} from './audit.js';
