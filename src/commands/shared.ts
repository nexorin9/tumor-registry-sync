/**
 * 命令层共享工具：运行日志路径解析（与其他子命令同源）。
 *
 * 本文件只放命令层四个新命令公用的小工具，不引入任何业务逻辑，
 * 也不触碰既有模块（src/config、src/sheet 等）之外的实现。
 */
import { resolve } from 'node:path';

import { loadRunLogDir } from '../config/env.js';

/** 解析本批运行日志的落盘路径（`--log` 优先，否则落在 RUN_LOG_DIR/run-log.jsonl）。 */
export function resolveRunLogPath(source: NodeJS.ProcessEnv, logFlag?: string): string {
  if (typeof logFlag === 'string' && logFlag.length > 0) return resolve(logFlag);
  return resolve(loadRunLogDir(source), 'run-log.jsonl');
}

/** 把单元格值（CellValue）转成写回 CSV 用的字符串（null → 空串）。 */
export function cellToString(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value);
}
