/**
 * 性能与稳定性：约 100 行在高并发检索下跑 align，断言全程完成、无行被丢弃；
 * 同输入两次运行产出完全一致的差异（确定性）；同一对齐结果两次推送的幂等键稳定一致。
 */
import { describe, expect, it } from 'vitest';

import type { FakeCdrRecord } from '../fakes/fake-cdr.js';
import { envForHarness, startHarness, stopHarness } from '../fakes/harness.js';
import { generateSample } from '../../src/samples/generate.js';

import { runCommand, withTempDir, writeTemp } from './helpers.js';

function toFakeRecords(
  hospitalExpected: { records: Array<{ registryId: string; fields: Record<string, string> }> },
): FakeCdrRecord[] {
  return hospitalExpected.records.map((rec) => ({
    patient: { id: rec.registryId, identifier: rec.registryId, birthDate: null, sex: null },
    conditions: [
      {
        code: rec.fields['分期'] ?? null,
        onsetDateTime: null,
        stage: rec.fields['分期'] ?? null,
      },
    ],
    encounters: [],
  }));
}

interface AlignResultShape {
  batchKey: string;
  rows: Array<{
    rowNumber: number;
    registryId: string | null;
    status: string;
    operations: unknown[];
  }>;
  runLogPath: string | null;
}

describe('性能与稳定性（perf-stability）', () => {
  it('~100 行并发 align 完成、无行丢弃、结果确定、推送幂等键稳定', async () => {
    const sample = generateSample({ rows: 100, seed: 42 });
    const records = toFakeRecords(sample.hospitalExpected);
    const expectedRows = sample.sheetCsv
      .split(/\r\n|\n/)
      .filter((line) => line.trim().length > 0).length - 1;

    await withTempDir(async (dir) => {
      const harness = await startHarness(records);
      const env = envForHarness(harness);
      try {
        const csvPath = writeTemp(dir, 'sheet-100.csv', sample.sheetCsv);

        // 第一次跑
        const run1 = await runCommand(['align', '--in', csvPath], env);
        expect(run1.code).toBe(0);
        const res1 = run1.envelope?.result as AlignResultShape;
        expect(res1.rows.length).toBe(expectedRows);
        expect(res1.rows.length).toBeGreaterThan(0);

        // 第二次跑（同输入）→ 确定性
        const run2 = await runCommand(['align', '--in', csvPath], env);
        const res2 = run2.envelope?.result as AlignResultShape;
        expect(res2.rows.length).toBe(expectedRows);
        expect(JSON.stringify(res1.rows.map((r) => [r.status, r.operations]))).toBe(
          JSON.stringify(res2.rows.map((r) => [r.status, r.operations])),
        );

        // 取一行有差异的行确认采纳，验证推送幂等键稳定
        const adoptedRow = res1.rows.find((r) => r.operations.length > 0 && r.registryId !== null);
        expect(adoptedRow).toBeDefined();
        const adopted = {
          ...res1,
          rows: res1.rows.map((row) =>
            row.rowNumber === adoptedRow?.rowNumber ? { ...row, status: '采纳' } : row,
          ),
        };
        const alignedPath = writeTemp(dir, 'aligned.json', JSON.stringify(adopted));

        const push1 = await runCommand(['push', '--in', alignedPath], env);
        const push2 = await runCommand(['push', '--in', alignedPath], env);
        const p1 = push1.envelope?.result as {
          receipts: Array<{ idempotencyKey: string | null }>;
        };
        const p2 = push2.envelope?.result as {
          receipts: Array<{ idempotencyKey: string | null }>;
        };
        expect(p1.receipts.length).toBe(p2.receipts.length);
        const keys1 = p1.receipts.map((r) => r.idempotencyKey).sort();
        const keys2 = p2.receipts.map((r) => r.idempotencyKey).sort();
        expect(keys1).toEqual(keys2);
      } finally {
        await stopHarness(harness);
      }
    });
  });
});
