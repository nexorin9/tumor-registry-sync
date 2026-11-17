/**
 * 最小差异集：只改哪个字段，就只产出那个字段的操作。
 *
 * 构造两行：R1 的「分期」与院内不一致（应产出恰好一条 分期 的替换操作）；
 * R2 与院内逐字段一致（不应产出任何操作）。由此证明差异引擎是「字段级最小集」，
 * 不是整行覆盖。
 */
import { describe, expect, it } from 'vitest';

import type { FakeCdrRecord } from '../fakes/fake-cdr.js';
import { envForHarness, startHarness, stopHarness } from '../fakes/harness.js';

import { runCommand, withTempDir, writeTemp } from './helpers.js';

const SHEET_HEADER = ['登记号', '分期', '治疗方案', '随访电话', '生活方式备注'];

function records(): FakeCdrRecord[] {
  return [
    {
      patient: { id: 'R1', identifier: 'R1', birthDate: null, sex: null },
      conditions: [{ code: 'IIIA', onsetDateTime: null, stage: 'IIIA' }],
      encounters: [],
    },
    {
      patient: { id: 'R2', identifier: 'R2', birthDate: null, sex: null },
      conditions: [{ code: 'IIIA', onsetDateTime: null, stage: 'IIIA' }],
      encounters: [],
    },
  ];
}

function buildCsv(): string {
  const lines = [
    SHEET_HEADER.join(','),
    'R1,IIIB,,13800000000,', // 分期与院内 IIIA 不一致
    'R2,IIIA,,13900000000,', // 与院内完全一致
  ];
  return `${lines.join('\n')}\n`;
}

interface AlignRow {
  registryId: string | null;
  status: string;
  operations: Array<{ op: string; path: string; oldValue?: unknown; newValue?: unknown }>;
}

describe('最小差异集（baseline-diff）', () => {
  it('只变更 分期 时仅产出该字段的操作，未变更行零操作', async () => {
    await withTempDir(async (dir) => {
      const harness = await startHarness(records());
      const env = envForHarness(harness);
      try {
        const csvPath = writeTemp(dir, 'sheet.csv', buildCsv());
        const run = await runCommand(['align', '--in', csvPath], env);
        expect(run.code).toBe(0);
        const result = run.envelope?.result as { rows: AlignRow[] };

        const r1 = result.rows.find((r) => r.registryId === 'R1');
        const r2 = result.rows.find((r) => r.registryId === 'R2');
        expect(r1).toBeDefined();
        expect(r2).toBeDefined();

        // 未变更行：零操作
        expect(r2?.operations.length).toBe(0);

        // 变更行：恰好一条操作，且是 分期 的替换（旧值 IIIB → 新值 IIIA）
        expect(r1?.operations.length).toBe(1);
        const op = r1?.operations[0] as AlignRow['operations'][number];
        expect(op.oldValue).toBe('IIIB');
        expect(op.newValue).toBe('IIIA');
        // 操作应指向「分期」口径字段（路径中含 分期）
        expect(op.path).toContain('分期');
      } finally {
        await stopHarness(harness);
      }
    });
  });
});
