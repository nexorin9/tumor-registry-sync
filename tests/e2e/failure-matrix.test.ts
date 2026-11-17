/**
 * 失败矩阵：CDR 侧 auth / 500 / timeout，以及专病库侧 500，断言「错误码可复现、行状态明确、
 * 绝不静默」。这是「检索失败 ≠ 零命中」「失败必须上报不谎报」两条硬规矩的端到端保证。
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { FakeCdrRecord } from '../fakes/fake-cdr.js';
import { envForHarness, startHarness, stopHarness, type Harness } from '../fakes/harness.js';
import type { FakeCdrFault, FakeRegistryFault } from '../fakes/fake-cdr.js';
import { readRunLog } from '../../src/observability/logger.js';

import { runCommand, withTempDir, writeTemp } from './helpers.js';

const SHEET_HEADER = ['登记号', '分期', '治疗方案', '随访电话', '生活方式备注'];

function records(): FakeCdrRecord[] {
  return [
    {
      patient: { id: 'R1', identifier: 'R1', birthDate: null, sex: null },
      conditions: [{ code: 'IIIA', onsetDateTime: null, stage: 'IIIA' }],
      encounters: [],
    },
  ];
}

function buildCsv(): string {
  const lines = [SHEET_HEADER.join(','), 'R1,IIIB,,13800000000,无'];
  return `${lines.join('\n')}\n`;
}

async function alignWithFault(
  cdrFault: FakeCdrFault,
  registryFault: FakeRegistryFault,
  dir: string,
): Promise<{ harness: Harness; run: Awaited<ReturnType<typeof runCommand>> }> {
  const harness = await startHarness(records(), { cdrFault, registryFault });
  const env = envForHarness(harness);
  const csvPath = writeTemp(dir, `sheet-${cdrFault}-${registryFault}.csv`, buildCsv());
  const run = await runCommand(['align', '--in', csvPath], env);
  return { harness, run };
}

describe('失败矩阵（CDR auth / 500 / timeout，registry 500）', () => {
  it('CDR auth：命令失败、错误码 auth_failed 且可复现', async () => {
    await withTempDir(async (dir) => {
      const r1 = await alignWithFault('auth', 'none', dir);
      try {
        expect(r1.run.code).not.toBe(0);
        expect(r1.run.envelope?.ok).toBe(false);
        expect(r1.run.envelope?.error?.code).toBe('auth_failed');

        // 复现：再跑一次，错误码一致
        const r2 = await alignWithFault('auth', 'none', dir);
        expect(r2.run.envelope?.error?.code).toBe('auth_failed');
      } finally {
        await stopHarness(r1.harness);
      }
    });
  });

  it('CDR 500：align 完成、行状态明确、运行日志记录 server_error（不静默）', async () => {
    await withTempDir(async (dir) => {
      const r = await alignWithFault('serverError', 'none', dir);
      try {
        expect(r.run.code).toBe(0);
        const result = r.run.envelope?.result as {
          rows: Array<{ registryId: string | null; status: string }>;
          runLogPath: string | null;
        };
        expect(result.rows.length).toBe(1);
        // 行状态明确（不是空、不是谎报零命中）
        expect(result.rows[0]?.status).toBe('待对齐');

        // 运行日志必须记录到该失败，绝不静默
        expect(result.runLogPath && existsSync(result.runLogPath)).toBe(true);
        if (result.runLogPath) {
          const events = readRunLog(result.runLogPath);
          const errEvents = events.filter((e) => e.errorCode === 'server_error');
          expect(errEvents.length).toBeGreaterThan(0);
        }
      } finally {
        await stopHarness(r.harness);
      }
    });
  });

  it('CDR timeout：行状态明确、运行日志记录 timeout（不静默）', async () => {
    await withTempDir(async (dir) => {
      const r = await alignWithFault('timeout', 'none', dir);
      try {
        expect(r.run.code).toBe(0);
        const result = r.run.envelope?.result as {
          rows: Array<{ registryId: string | null; status: string }>;
          runLogPath: string | null;
        };
        expect(result.rows.length).toBe(1);
        expect(result.rows[0]?.status).toBe('待对齐');

        expect(result.runLogPath && existsSync(result.runLogPath)).toBe(true);
        if (result.runLogPath) {
          const events = readRunLog(result.runLogPath);
          const errEvents = events.filter((e) => e.errorCode === 'timeout');
          expect(errEvents.length).toBeGreaterThan(0);
        }
      } finally {
        await stopHarness(r.harness);
      }
    });
  }, 60_000);

  it('registry 500：push 失败被如实上报（回执非「已推送」、带错误码、绝不静默）', async () => {
    await withTempDir(async (dir) => {
      // 同一 harness：CDR 正常、专病库 500
      const harness = await startHarness(records(), {
        cdrFault: 'none',
        registryFault: 'serverError',
      });
      const env = envForHarness(harness);
      try {
        const csvPath = writeTemp(dir, 'sheet.csv', buildCsv());
        const alignRun = await runCommand(['align', '--in', csvPath], env);
        const alignResult = alignRun.envelope?.result as {
          batchKey: string;
          rows: Array<{ rowNumber: number; registryId: string | null; status: string }>;
        };
        // 把该行确认采纳
        const adopted = {
          ...alignResult,
          rows: alignResult.rows.map((row) => ({ ...row, status: '采纳' })),
        };
        const alignedPath = writeTemp(dir, 'aligned.json', JSON.stringify(adopted));

        const pushRun = await runCommand(['push', '--in', alignedPath], env);
        expect(pushRun.code).toBe(0);
        const pushResult = pushRun.envelope?.result as {
          receipts: Array<{ status: string; code: string | null }>;
        };
        expect(pushResult.receipts.length).toBeGreaterThan(0);
        for (const receipt of pushResult.receipts) {
          // 失败必须如实呈现：要么推送失败、要么待重试，且带错误码，绝不谎报已推送
          expect(receipt.status === '推送失败' || receipt.status === '待重试').toBe(true);
          expect(receipt.code).not.toBeNull();
        }
      } finally {
        await stopHarness(harness);
      }
    });
  });
});
