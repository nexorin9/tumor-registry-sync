/**
 * 审计层统一出口：批次键、run-log 辅助、运行摘要。
 *
 * 三个能力各管一段：批次如何唯一标识（batch-key）、运行日志如何计数与落盘
 * （run-log）、摘要如何构造与交叉校验（summary）。这里把它们聚到一处，方便
 * 主干与表尾写回逻辑统一引入。
 */
export * from './batch-key.js';
export * from './run-log.js';
export * from './summary.js';
