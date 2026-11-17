import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/cli.js';
import { readRunLog } from '../../src/observability/logger.js';
import { startFakeCdrServer, type FakeCdrServer } from '../fakes/fake-cdr.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/lookup-sample.csv', import.meta.url));
const SYSTEM = 'urn:oid:2.16.156.10011.0.1';

const servers: FakeCdrServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) await server.close();
  }
});

function captureStdout(): { text: () => string; stderrText: () => string } {
  const chunks: string[] = [];
  const errors: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    errors.push(String(chunk));
    return true;
  });
  return { text: () => chunks.join(''), stderrText: () => errors.join('') };
}

describe('lookup 的运行日志与错误分布（真实 HTTP 假 CDR）', () => {
  it('每行一条 JSONL；失败行带底层错误码与可重试标记', async () => {
    const server = await startFakeCdrServer({
      patients: [
        { id: 'pat-1', identifiers: [{ system: SYSTEM, value: 'REG-0001' }] },
        { id: 'pat-2', identifiers: [{ system: SYSTEM, value: 'REG-0002' }] },
        { id: 'pat-3', identifiers: [{ system: SYSTEM, value: 'REG-0002' }] },
      ],
      // REG-0001 检索时院内服务报 500
      faults: [{ kind: '500', identifier: 'REG-0001' }],
    });
    servers.push(server);

    const dir = mkdtempSync(join(tmpdir(), 'tumor-registry-cli-log-'));
    const logPath = join(dir, 'run-log.jsonl');

    const stdout = captureStdout();
    const code = await runCli(['lookup', '--in', FIXTURE, '--log', logPath], {
      CDR_BASE_URL: server.baseUrl,
      CDR_API_TOKEN: 'test-token',
      CDR_IDENTIFIER_SYSTEM: SYSTEM,
    } as NodeJS.ProcessEnv);

    expect(code).toBe(0);
    const payload = JSON.parse(stdout.text());

    // 本批错误分布：REG-0001 是 500 → server_error，可重试
    expect(payload.result.errorDistribution.total).toBe(1);
    expect(payload.result.errorDistribution.entries).toEqual([
      { code: 'server_error', count: 1, retryable: true },
    ]);
    expect(payload.result.runLog.path).toBe(logPath);
    expect(payload.result.runLog.written).toBe(3);
    expect(payload.result.runLog.error).toBeNull();

    // 该行本身状态是「未完成」（不是零命中），错误码落在行上
    const failed = payload.result.rows.find(
      (row: { registryId: string }) => row.registryId === 'REG-0001',
    );
    expect(failed.binding).toBe('未完成');
    expect(failed.errorCode).toBe('server_error');

    // 日志：三行一行一个 JSON 对象；失败行带错误码、耗时与尝试次数
    const events = readRunLog(logPath);
    expect(events).toHaveLength(3);
    const failedEvent = events.find((event) => event.rowId === 'REG-0001');
    expect(failedEvent?.outcome).toBe('error');
    expect(failedEvent?.errorCode).toBe('server_error');
    expect(failedEvent?.retryable).toBe(true);
    expect(failedEvent?.stage).toBe('lookup');
    expect(failedEvent?.attempts).toBeGreaterThanOrEqual(1);
    expect(failedEvent?.durationMs).not.toBeNull();

    // 歧义与零命中是判定结果，不是检索失败：不进错误分布
    const ambiguousEvent = events.find((event) => event.rowId === 'REG-0002');
    expect(ambiguousEvent?.outcome).toBe('ok');
    expect(ambiguousEvent?.errorCode).toBeNull();
  });

  it('日志只写脱敏标识：不落姓名等可识别明报', async () => {
    const server = await startFakeCdrServer({
      patients: [{ id: 'pat-1', identifiers: [{ system: SYSTEM, value: 'REG-0001' }] }],
    });
    servers.push(server);

    const dir = mkdtempSync(join(tmpdir(), 'tumor-registry-cli-log-'));
    const logPath = join(dir, 'run-log.jsonl');

    const stdout = captureStdout();
    await runCli(['lookup', '--in', FIXTURE, '--log', logPath], {
      CDR_BASE_URL: server.baseUrl,
      CDR_API_TOKEN: 'test-token',
      CDR_IDENTIFIER_SYSTEM: SYSTEM,
    } as NodeJS.ProcessEnv);

    const raw = JSON.parse(stdout.text());
    expect(raw.ok).toBe(true);

    // 登记表的随访电话只以脱敏形态出现（1XX****NNNN），日志里不得出现原值
    const events = readRunLog(logPath);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('138****0001');
    expect(serialized).not.toContain('吸烟史');
    // 日志里出现的标识只有登记号占位
    expect(events.every((event) => event.rowId === null || event.rowId.startsWith('REG-'))).toBe(true);
  });
});
