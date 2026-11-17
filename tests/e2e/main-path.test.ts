/**
 * 主链路：align → 人工确认（把某行 status 置为「采纳」）→ push → 断言该行进专病库、
 * 回执状态为「已推送」、批次键在 align 结果与 push 结果间保持一致、运行日志可查。
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type { FakeCdrRecord } from '../fakes/fake-cdr.js';
import { envForHarness, startHarness, stopHarness } from '../fakes/harness.js';
import { readRunLog } from '../../src/observability/logger.js';

import { runCommand, withTempDir, writeTemp, writeJsonTemp } from './helpers.js';

const SHEET_HEADER = ['登记号', '分期', '治疗方案', '随访电话', '生活方式备注'];

function records(): FakeCdrRecord[] {
  return [
    {
      patient: { id: 'R1', identifier: 'R1', birthDate: null, sex: 'female' },
      conditions: [{ code: 'IIIA', onsetDateTime: null, stage: 'IIIA' }],
      encounters: [],
    },
  ];
}

function buildCsv(): string {
  const lines = [SHEET_HEADER.join(','), 'R1,IIIB,,13800000000,无'];
  return `${lines.join('\n')}\n`;
}

describe('主链路：align → 采纳 → push', () => {
  it('确认采纳的行被推送，回执已推送，批次键一致，运行日志可查', async () => {
    await withTempDir(async (dir) => {
      const harness = await startHarness(records());
      const env = envForHarness(harness);
      try {
        const csvPath = writeTemp(dir, 'sheet.csv', buildCsv());

        // 1) align
        const alignRun = await runCommand(['align', '--in', csvPath], env);
        expect(alignRun.code).toBe(0);
        const alignResult = alignRun.envelope?.result as {
          batchKey: string;
          rows: Array<{ rowNumber: number; registryId: string | null; status: string }>;
        };
        expect(alignResult.rows.length).toBe(1);

        // 2) 人工确认：把该行 status 置为「采纳」
        const adoptedResult = {
          ...alignResult,
          rows: alignResult.rows.map((row) =>
            row.registryId === 'R1' ? { ...row, status: '采纳' } : row,
          ),
        };
        const alignedPath = writeJsonTemp(dir, 'aligned.json', adoptedResult);

        // 3) push
        const pushRun = await runCommand(['push', '--in', alignedPath], env);
        expect(pushRun.code).toBe(0);
        const pushResult = pushRun.envelope?.result as {
          batchKey: string;
          runLogPath: string | null;
          summary: { pushed: number };
          receipts: Array<{
            rowNumber: number;
            registryId: string | null;
            status: string;
            code: string | null;
          }>;
        };

        // 批次键在 align 与 push 间一致
        expect(pushResult.batchKey).toBe(alignResult.batchKey);

        // 该行进专病库，回执状态为「已推送」
        const receipt = pushResult.receipts.find((r) => r.registryId === 'R1');
        expect(receipt).toBeDefined();
        expect(receipt?.status).toBe('已推送');
        expect(pushResult.summary.pushed).toBeGreaterThanOrEqual(1);

        // 运行日志落盘且含一条 push ok 事件
        expect(pushResult.runLogPath).not.toBeNull();
        expect(pushResult.runLogPath && existsSync(pushResult.runLogPath)).toBe(true);
        if (pushResult.runLogPath) {
          const events = readRunLog(pushResult.runLogPath);
          const okPush = events.find((e) => e.stage === 'push' && e.outcome === 'ok');
          expect(okPush).toBeDefined();
        }
      } finally {
        await stopHarness(harness);
      }
    });
  });
});
