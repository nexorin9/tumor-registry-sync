import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/cli.js';
import { startFakeCdrServer, type FakeCdrServer } from '../fakes/fake-cdr.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/lookup-sample.csv', import.meta.url));

const servers: FakeCdrServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) await server.close();
  }
});

/** 运行日志目录：测试期间写进临时目录，不在项目里留运行产物。 */
function tempRunLogDir(): string {
  return mkdtempSync(join(tmpdir(), 'tumor-registry-cli-lookup-'));
}

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

describe('lookup 子命令（真实 HTTP 假 CDR）', () => {
  it('逐行打印「命中 / 歧义 / 零命中」状态标注', async () => {
    const server = await startFakeCdrServer({
      patients: [
        { id: 'pat-1', identifiers: [{ system: 'urn:oid:2.16.156.10011.0.1', value: 'REG-0001' }] },
        { id: 'pat-2', identifiers: [{ system: 'urn:oid:2.16.156.10011.0.1', value: 'REG-0002' }] },
        { id: 'pat-3', identifiers: [{ system: 'urn:oid:2.16.156.10011.0.1', value: 'REG-0002' }] },
      ],
      conditions: [{ patientId: 'pat-1', code: 'M8500/3', stage: 'IIIB' }],
      encounters: [{ patientId: 'pat-1', periodStart: '2024-03-05T08:00:00+08:00' }],
    });
    servers.push(server);

    const stdout = captureStdout();
    const code = await runCli(['lookup', '--in', FIXTURE], {
      CDR_BASE_URL: server.baseUrl,
      CDR_API_TOKEN: 'test-token',
      CDR_IDENTIFIER_SYSTEM: 'urn:oid:2.16.156.10011.0.1',
      RUN_LOG_DIR: tempRunLogDir(),
    } as NodeJS.ProcessEnv);

    expect(code).toBe(0);
    const payload = JSON.parse(stdout.text());
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe('lookup');
    expect(payload.result.stats).toEqual({
      total: 3,
      matched: 1,
      ambiguous: 1,
      noMatch: 1,
      incomplete: 0,
    });

    const byRegistry = new Map(
      payload.result.rows.map((row: { registryId: string; binding: string }) => [row.registryId, row.binding]),
    );
    expect(byRegistry.get('REG-0001')).toBe('命中');
    expect(byRegistry.get('REG-0002')).toBe('歧义');
    expect(byRegistry.get('REG-0003')).toBe('零命中');

    const hit = payload.result.rows.find((row: { registryId: string }) => row.registryId === 'REG-0001');
    expect(hit.patientId).toBe('pat-1');
    expect(hit.conditions[0].code).toBe('M8500/3');
    expect(hit.encounters[0].periodStart).toBe('2024-03-05T08:00:00+08:00');

    // 凭据确实从环境变量来：请求头带的是配置的令牌
    expect(server.requests[0]?.headers['authorization']).toBe('Bearer test-token');
  });

  it('输出本批检索参数串、去重与并发统计（并发上限取自 FHIR_MAX_CONCURRENCY）', async () => {
    const server = await startFakeCdrServer({
      patients: [
        { id: 'pat-1', identifiers: [{ system: 'urn:oid:2.16.156.10011.0.1', value: 'REG-0001' }] },
        { id: 'pat-2', identifiers: [{ system: 'urn:oid:2.16.156.10011.0.1', value: 'REG-0002' }] },
        { id: 'pat-3', identifiers: [{ system: 'urn:oid:2.16.156.10011.0.1', value: 'REG-0002' }] },
        { id: 'pat-4', identifiers: [{ system: 'urn:oid:2.16.156.10011.0.1', value: 'REG-0004' }] },
      ],
      conditions: [{ patientId: 'pat-1', code: 'M8500/3', stage: 'IIIB' }],
      encounters: [{ patientId: 'pat-1', periodStart: '2024-03-05T08:00:00+08:00' }],
    });
    servers.push(server);

    const stdout = captureStdout();
    const code = await runCli(['lookup', '--in', FIXTURE], {
      CDR_BASE_URL: server.baseUrl,
      CDR_API_TOKEN: 'test-token',
      CDR_IDENTIFIER_SYSTEM: 'urn:oid:2.16.156.10011.0.1',
      FHIR_MAX_CONCURRENCY: '2',
      RUN_LOG_DIR: tempRunLogDir(),
    } as NodeJS.ProcessEnv);

    expect(code).toBe(0);
    const payload = JSON.parse(stdout.text());
    expect(payload.result.concurrency.limit).toBe(2);
    expect(payload.result.concurrency.peakInFlight).toBeLessThanOrEqual(2);
    expect(payload.result.dedup.uniqueRegistryIds).toBe(3);
    expect(payload.result.dedup.reusedRows).toBe(0);
    // 检索参数串按登记号排序，带得出实际检索参数与页数
    expect(payload.result.searchParams.split('\n')[0]).toContain('REG-0001 :: Patient?identifier=');
    expect(payload.result.searchParams).toContain('Condition?subject=Patient/pat-1#1');
    expect(payload.result.searchParamEntries).toHaveLength(3);
  });

  it('缺 CDR 配置时指名环境变量并以非 0 退出', async () => {
    const stdout = captureStdout();
    const code = await runCli(['lookup', '--in', FIXTURE], {} as NodeJS.ProcessEnv);

    expect(code).toBe(1);
    expect(stdout.stderrText()).toContain('CDR_BASE_URL');
    expect(stdout.stderrText()).toContain('CDR_API_TOKEN');
    expect(stdout.stderrText()).toContain('CDR_IDENTIFIER_SYSTEM');
  });
});
