/**
 * 检索层统一出口。
 *
 * 读数链路：client（出站读取 + 错误分类） → pagination（分页取完）
 * → parse（取值 + 缺字段记问题） → binding（命中 / 歧义 / 零命中 / 未完成）
 * → orchestrator（逐行驱动，按患者 → 诊断 → 就诊取数）
 *
 * 参数构造在 params.ts，错误分类在 errors.ts，资源类型在 types.ts。
 */
export * from './binding.js';
export * from './client.js';
export * from './derived-view.js';
export * from './errors.js';
export * from './orchestrator.js';
export * from './pagination.js';
export * from './params.js';
export * from './parse.js';
export * from './types.js';
