/**
 * 确认模块统一出口：状态机、取值解析、闸门、迁移执行。
 */
export * from './state.js';
export * from './values.js';
export * from './gate.js';
export * from './transitions.js';

// PUSHABLE_STATUSES 同时由 state 与 gate 导出，显式声明以消除 star 歧义。
export { PUSHABLE_STATUSES } from './state.js';
