/**
 * 规模与性能：批量生成 300 行登记表，跑 align，断言行数正确、全程完成且耗时可控。
 *
 * 数据用 `generateSample` 生成（与产品自带样例同一条生成链路），院内侧用其
 * hospitalExpected 转换成的假 CDR 记录，尽量贴近真实比对角色。
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

describe('规模与性能（scale-300）', () => {
  it('300 行 align 完成且行数完整、耗时可控', async () => {
    const sample = generateSample({ rows: 300, seed: 20261101 });
    const records = toFakeRecords(sample.hospitalExpected);

    // 期望数据行数 = CSV 数据行（去掉表头，且不计末尾空行）
    const expectedRows = sample.sheetCsv
      .split(/\r\n|\n/)
      .filter((line) => line.trim().length > 0).length - 1;

    await withTempDir(async (dir) => {
      const harness = await startHarness(records);
      const env = envForHarness(harness);
      try {
        const csvPath = writeTemp(dir, 'sheet-300.csv', sample.sheetCsv);
        const started = Date.now();
        const run = await runCommand(['align', '--in', csvPath], env);
        const elapsed = Date.now() - started;

        expect(run.code).toBe(0);
        expect(run.envelope?.ok).toBe(true);
        const result = run.envelope?.result as { rows: unknown[]; summary: { total: number } };
        expect(result.rows.length).toBe(expectedRows);
        expect(result.summary.total).toBe(expectedRows);
        // 任何一行都不应被静默丢弃（全部进入结果）
        expect(elapsed).toBeLessThan(30_000);
      } finally {
        await stopHarness(harness);
      }
    });
  });
});
