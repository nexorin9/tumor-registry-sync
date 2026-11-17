/**
 * run-log 辅助：计数、按行过滤、批量落盘。
 *
 * 运行日志（JSONL）是「本批处理了多少行」的权威记录 —— 一行一条事件，
 * 「run-log 行数 = 本批处理行数」这条纪律让摘要计数能被独立核对出来，
 * 不靠哪一处代码自报家门。
 */
import { readFileSync } from 'node:fs';

import type { LogEvent } from '../observability/index.js';
import { RunLogger, readRunLog } from '../observability/index.js';

export { RunLogger, readRunLog };
export type { LogEvent };

/**
 * 统计 run-log 里的有效事件行数。
 *
 * 空行跳过；非法 JSON 行不计入（但保留在文件里，不静默删），只数「能解析成事件」的行。
 * 对一次完整批次而言，这个数必须等于本批处理的行数。
 */
export function countRunLogEvents(path: string): number {
  const content = readFileSync(path, 'utf8');
  let count = 0;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      JSON.parse(trimmed);
      count += 1;
    } catch {
      // 跳过非法行；不在此抛错，核对计数时只认有效事件。
    }
  }
  return count;
}

/**
 * 从一批事件里挑出属于指定行号的事件。
 *
 * 批次级事件（rowNumber 为 null）永远不会被选中；行号以集合过滤，O(n) 一次过。
 */
export function eventsForRows(events: LogEvent[], rowNumbers: number[]): LogEvent[] {
  const wanted = new Set(rowNumbers);
  return events.filter((event) => event.rowNumber !== null && wanted.has(event.rowNumber));
}

/**
 * 把一批现成事件塞进 logger 并落盘，返回实际写入条数。
 *
 * 事件已经被拼好（时间戳、阶段、错误码都齐全），这里只负责「入库」，
 * 不再重新生成时间戳 —— 供「先把一批结果转成事件、再统一落盘」的场景。
 */
export function appendBatchEvents(logger: RunLogger, events: LogEvent[]): number {
  for (const event of events) {
    logger.push(event);
  }
  return logger.flush();
}
