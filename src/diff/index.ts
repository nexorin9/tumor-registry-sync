/**
 * 差异引擎统一出口。
 *
 * 口径层：field-spec（受控字段口径表：来源 / 是否参与比对 / 是否派生 / 是否受控编码）
 * 派生层：derived（首次入院日 / 本次就诊开始，按口径表声明的规则算）
 * 映射层：path-map（登记列 ↔ 口径字段 ↔ 院内资源路径的三段映射 + 受控编码等价判定）
 * 比对层：patch（逐字段最小差异 → add / replace / remove 最小操作集合）
 * 展开层：nested（数组与嵌套对象 → 带索引、带层级的最小操作集合）
 * 文案层：render（最小操作集合 → 表内「差异」列与「建议值」列文案）
 * 规则层：destructive-rules（破坏性判定规则表：哪些操作算破坏性 + ifMatch 要求 + 版本留存）
 * 写前层：precondition（破坏性操作生成 ifMatch + 发出前本地比对院内当前值）
 */
export * from './derived.js';
export * from './destructive-rules.js';
export * from './field-spec.js';
export * from './nested.js';
export * from './patch.js';
export * from './path-map.js';
export * from './precondition.js';
export * from './render.js';
