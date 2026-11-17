import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  appendBatchEvents,
  countRunLogEvents,
  eventsForRows,
  readRunLog,
  RunLogger,
} from '../../src/audit/run-log.js';
import type { LogEvent } from '../../src/audit/run-log.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'tumor-registry-audit-log-'));
}

function makeEvent(rowNumber: number, stage: LogEvent['stage'], outcome: LogEvent['outcome']): LogEvent {
  return {
    ts: '2026-11-08T00:00:00.000Z',
    stage,
    outcome,
    rowNumber,
    rowId: `REG-${String(rowNumber).padStart(4, '0')}`,
    errorCode: null,
    retryable: null,
    durationMs: null,
    attempts: 1,
    message: 'unit-test',
    hint: null,
  };
}

describe('countRunLogEvents', () => {
  it('flush N 条事件 → 计数 = N', () => {
    const path = join(tempDir(), 'run-log.jsonl');
    const logger = new RunLogger({ path, stage: 'lookup' });
    for (let i = 1; i <= 5; i += 1) logger.ok({ rowNumber: i, rowId: `REG-${i}` });
    expect(logger.flush()).toBe(5);
    expect(countRunLogEvents(path)).toBe(5);
  });

  it('读回的行数与 countRunLogEvents 一致', () => {
    const path = join(tempDir(), 'run-log.jsonl');
    const logger = new RunLogger({ path, stage: 'push' });
    for (let i = 1; i <= 3; i += 1) logger.ok({ rowNumber: i, rowId: `REG-${i}` });
    logger.flush();
    expect(readRunLog(path)).toHaveLength(3);
    expect(countRunLogEvents(path)).toBe(3);
  });

  it('非法行不计入有效事件数', () => {
    const path = join(tempDir(), 'run-log.jsonl');
    const logger = new RunLogger({ path, stage: 'lookup' });
    logger.ok({ rowNumber: 1, rowId: 'REG-1' });
    logger.flush();
    // 追加一行非法 JSON（不破坏既有有效行）
    appendFileSync(path, 'not-json\n', 'utf8');
    expect(countRunLogEvents(path)).toBe(1);
  });
});

describe('eventsForRows', () => {
  it('只挑出指定行号的逐行事件，批次级事件（null）不选', () => {
    const events: LogEvent[] = [
      makeEvent(1, 'lookup', 'ok'),
      makeEvent(2, 'lookup', 'ok'),
      makeEvent(3, 'lookup', 'ok'),
      { ...makeEvent(1, 'system', 'ok'), rowNumber: null },
    ];
    const picked = eventsForRows(events, [2, 3]);
    expect(picked.map((e) => e.rowNumber)).toEqual([2, 3]);
  });

  it('不存在的行号不返回任何事件', () => {
    const events: LogEvent[] = [makeEvent(1, 'lookup', 'ok'), makeEvent(2, 'lookup', 'ok')];
    expect(eventsForRows(events, [99])).toHaveLength(0);
  });
});

describe('appendBatchEvents', () => {
  it('塞入一批事件后落盘，返回写入条数', () => {
    const path = join(tempDir(), 'run-log.jsonl');
    const logger = new RunLogger({ path, stage: 'push' });
    const batch: LogEvent[] = [
      makeEvent(1, 'push', 'ok'),
      makeEvent(2, 'push', 'ok'),
      makeEvent(3, 'push', 'error'),
    ];
    expect(appendBatchEvents(logger, batch)).toBe(3);
    expect(countRunLogEvents(path)).toBe(3);
  });
});
