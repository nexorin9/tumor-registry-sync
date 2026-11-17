/**
 * 表格载体层统一出口。
 *
 * 读表链路：read（读 + 解码 + 表头） → rows（行规范化 + 脏行归集）
 * 列口径：column-mapping（配置加载 + 与表头对账）
 * 值口径：normalize（单元格规范化，保留原值）
 * 写表链路：result-file（原表列 + 五列新列 + 表尾两区 → 结果表文件，原子写 + 回读自检）
 * 问题归集：row-issues（读表侧 + 检索侧行级问题统一归集 → 按错误码分布 + 待人工处理清单）
 * 表内呈现：present/tokens（设计 token 与语义色板：色值、字号层级、列宽、间距栅格、状态映射）
 * 编码：encoding（读进来时猜编码）/ encode（写出去时按 UTF-8 或 GBK 落盘）
 */
export * from './atomic.js';
export * from './column-mapping.js';
export * from './encode.js';
export * from './encoding.js';
export * from './normalize.js';
export * from './present/index.js';
export * from './read.js';
export * from './result-file.js';
export * from './row-issues.js';
export * from './rows.js';
