import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ErrorCounter,
  MAX_MESSAGE_LENGTH,
  RunLogger,
  buildLookupEvents,
  formatErrorDistribution,
  readRunLog,
  summarizeErrors,
} from '../../src/observability/logger.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'tumor-registry-runlog-'));
}

describe('结构化运行日志（JSONL）', () => {
  it('一行一个 JSON 对象，字段齐全（阶段 / 行标识 / 错误码 / 耗时 / 尝试次数）', () => {
    const dir = tempDir();
    const path = join(dir, 'run-log.jsonl');
    const logger = new RunLogger({ path, stage: 'lookup' });

    logger.ok({ rowNumber: 2, rowId: 'REG-0001', durationMs: 42, attempts: 3 });
    logger.error({
      rowNumber: 3,
      rowId: 'REG-0002',
      errorCode: 'server_error',
      retryable: true,
      durationMs: 15000,
      attempts: 1,
      message: '院内 FHIR 服务返回服务端错误',
      hint: '可重试，退避 1 秒后重跑',
    });

    expect(logger.flush()).toBe(2);

    const raw = readFileSync(path, 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0] ?? '{}');
    expect(Object.keys(first).sort()).toEqual(
      [
        'attempts',
        'durationMs',
        'errorCode',
        'hint',
        'message',
        'outcome',
        'retryable',
        'rowId',
        'rowNumber',
        'stage',
        'ts',
      ].sort(),
    );
    expect(first.stage).toBe('lookup');
    expect(first.outcome).toBe('ok');
    expect(first.rowNumber).toBe(2);
    expect(first.rowId).toBe('REG-0001');
    expect(first.durationMs).toBe(42);
    expect(first.attempts).toBe(3);

    const second = JSON.parse(lines[1] ?? '{}');
    expect(second.outcome).toBe('error');
    expect(second.errorCode).toBe('server_error');
    expect(second.retryable).toBe(true);
    expect(second.durationMs).toBe(15000);
  });

  it('追加写：同批次重跑不覆盖历史（两次 flush 共两行）', () => {
    const dir = tempDir();
    const path = join(dir, 'run-log.jsonl');
    const first = new RunLogger({ path, stage: 'lookup' });
    first.ok({ rowNumber: 2, rowId: 'REG-0001' });
    first.flush();

    const second = new RunLogger({ path, stage: 'lookup' });
    second.ok({ rowNumber: 2, rowId: 'REG-0001' });
    second.flush();

    expect(readRunLog(path)).toHaveLength(2);
  });

  it('读回日志：坏行显式报错并点名行号，不静默跳过', () => {
    const dir = tempDir();
    const path = join(dir, 'run-log.jsonl');
    writeFileSync(path, '{"ts":"2026-01-01T00:00:00.000Z","stage":"lookup"}\nnot-json\n', 'utf8');

    expect(() => readRunLog(path)).toThrow(/第 2 行/);
  });

  it('读回日志时可只取末尾若干条', () => {
    const dir = tempDir();
    const path = join(dir, 'run-log.jsonl');
    const logger = new RunLogger({ path, stage: 'lookup' });
    logger.ok({ rowNumber: 2, rowId: 'REG-0001' });
    logger.ok({ rowNumber: 3, rowId: 'REG-0002' });
    logger.ok({ rowNumber: 4, rowId: 'REG-0003' });
    logger.flush();

    const tail = readRunLog(path, { limit: 2 });
    expect(tail).toHaveLength(2);
    expect(tail[1]?.rowId).toBe('REG-0003');
  });

  it('写不出去时点名文件路径，不假装记下了', () => {
    const dir = tempDir();
    // 目标是已存在的目录：追加写必然失败
    const logger = new RunLogger({ path: dir, stage: 'lookup' });
    logger.ok({ rowNumber: 2, rowId: 'REG-0001' });

    expect(() => logger.flush()).toThrow(/写入运行日志失败/);
    expect(() => logger.flush()).toThrow(new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('超长消息被截断、控制字符被清掉（一行一件事，不塞整页报文）', () => {
    const dir = tempDir();
    const path = join(dir, 'run-log.jsonl');
    const logger = new RunLogger({ path, stage: 'lookup' });
    logger.error({ message: `x\u0007`.repeat(400) });
    logger.flush();

    const event = readRunLog(path)[0];
    expect(event?.message.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH + 1);
    expect(event?.message).not.toContain('\u0007');
  });
});

describe('本批错误分布（按错误码聚合）', () => {
  it('只统计带错误码的事件，成功事件不计入', () => {
    const events = buildLookupEvents([
      { rowNumber: 2, registryId: 'REG-0001', binding: '命中', durationMs: 10, attempts: 3 },
      { rowNumber: 3, registryId: 'REG-0002', binding: '歧义', durationMs: 12, attempts: 1 },
      { rowNumber: 4, registryId: 'REG-0003', binding: '零命中', durationMs: 8, attempts: 1 },
      {
        rowNumber: 5,
        registryId: 'REG-0004',
        binding: '未完成',
        errorCode: 'server_error',
        durationMs: 15000,
        attempts: 1,
      },
    ]);

    const distribution = summarizeErrors(events);
    expect(distribution.total).toBe(1);
    expect(distribution.entries).toEqual([
      { code: 'server_error', count: 1, retryable: true },
    ]);
  });

  it('计数按错误码聚合，次数降序；可重试条数单独统计', () => {
    const counter = new ErrorCounter();
    counter.increment('timeout', true);
    counter.increment('timeout', true);
    counter.increment('server_error', true);
    counter.increment('not_found', false);

    const snapshot = counter.snapshot();
    expect(snapshot.total).toBe(4);
    expect(snapshot.retryable).toBe(3);
    // 次数降序；次数相同时按错误码字典序，两次运行输出一致
    expect(snapshot.entries.map((entry) => entry.code)).toEqual([
      'timeout',
      'not_found',
      'server_error',
    ]);
    expect(snapshot.entries[0]).toEqual({ code: 'timeout', count: 2, retryable: true });

    counter.reset();
    expect(counter.snapshot().total).toBe(0);
  });

  it('摘要是一句中文：空批说「没有检索错误」，有错时逐码列出', () => {
    expect(formatErrorDistribution(summarizeErrors([]))).toBe('本批没有检索错误。');

    const counter = new ErrorCounter();
    counter.increment('timeout', true);
    counter.increment('auth_failed', false);
    const summary = formatErrorDistribution(counter.snapshot());
    expect(summary).toContain('timeout ×1');
    expect(summary).toContain('auth_failed ×1');
    expect(summary).toContain('可重试');
    expect(summary).toContain('共 2 条');
  });

  it('检索结果转日志事件：命中/歧义/零命中是判定结果，不混进错误分布', () => {
    const events = buildLookupEvents([
      { rowNumber: 2, registryId: 'REG-0001', binding: '命中', durationMs: 11, attempts: 3 },
      { rowNumber: 3, registryId: 'REG-0002', binding: '歧义', durationMs: 12, attempts: 1 },
      { rowNumber: 4, registryId: 'REG-0003', binding: '零命中', durationMs: 9, attempts: 1 },
    ]);

    expect(events.map((event) => event.outcome)).toEqual(['ok', 'ok', 'ok']);
    expect(events.every((event) => event.errorCode === null)).toBe(true);
    expect(events[0]?.durationMs).toBe(11);
    expect(events[0]?.attempts).toBe(3);
    expect(summarizeErrors(events).total).toBe(0);
  });

  it('未完成的行带底层错误码，并标明能不能重试', () => {
    const events = buildLookupEvents([
      {
        rowNumber: 2,
        registryId: 'REG-0001',
        binding: '未完成',
        errorCode: 'timeout',
        durationMs: 15000,
        attempts: 1,
      },
      {
        rowNumber: 3,
        registryId: 'REG-0002',
        binding: '未完成',
        errorCode: 'auth_failed',
        durationMs: 30,
        attempts: 1,
      },
    ]);

    expect(events[0]?.outcome).toBe('error');
    expect(events[0]?.errorCode).toBe('timeout');
    expect(events[0]?.retryable).toBe(true);
    expect(events[1]?.errorCode).toBe('auth_failed');
    expect(events[1]?.retryable).toBe(false);
    expect(summarizeErrors(events).total).toBe(2);
  });
});
