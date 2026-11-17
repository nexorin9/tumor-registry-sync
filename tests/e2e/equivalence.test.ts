/**
 * 三入口等价性：同一份登记表数据，分别经 CSV 入口与 AlignRequest JSON 入口跑 align，
 * 必须产出逐行等价的对齐结果（同登记号、同状态、同操作集、同差异文案）。
 *
 * 这是「Excel 宏 / WPS 宏 / CSV 直跑收敛到同一份 AlignRequest 契约」的核心保证：
 * 入口不同，引擎同一条，结果不应分叉。
 */
import { describe, expect, it } from 'vitest';

import type { FakeCdrRecord } from '../fakes/fake-cdr.js';
import { envForHarness, startHarness, stopHarness } from '../fakes/harness.js';
import { readSheetFile } from '../../src/sheet/index.js';

import { runCommand, withTempDir, writeTemp, writeJsonTemp } from './helpers.js';

const SHEET_HEADER = ['登记号', '分期', '治疗方案', '随访电话', '生活方式备注'];

function records(): FakeCdrRecord[] {
  return [
    {
      patient: { id: 'R1', identifier: 'R1', birthDate: null, sex: 'female' },
      conditions: [{ code: 'IIIA', onsetDateTime: null, stage: 'IIIA' }],
      encounters: [],
    },
    {
      patient: { id: 'R2', identifier: 'R2', birthDate: null, sex: 'male' },
      conditions: [{ code: 'IIIA', onsetDateTime: null, stage: 'IIIA' }],
      encounters: [],
    },
  ];
}

function buildCsv(): string {
  const lines = [
    SHEET_HEADER.join(','),
    'R1,IIIB,,13800000000,无',
    'R2,IIIA,,13900000000,戒烟',
    'R3,IIIB,,,',
  ];
  return `${lines.join('\n')}\n`;
}

describe('align 三入口等价性（CSV vs AlignRequest JSON）', () => {
  it('同一数据经 CSV 与 JSON 两入口，逐行结果等价', async () => {
    await withTempDir(async (dir) => {
      const harness = await startHarness(records());
      const env = envForHarness(harness);
      try {
        const csvPath = writeTemp(dir, 'sheet.csv', buildCsv());

        // CSV 入口
        const csvRun = await runCommand(['align', '--in', csvPath], env);
        expect(csvRun.code).toBe(0);
        expect(csvRun.envelope?.ok).toBe(true);
        const csvResult = csvRun.envelope?.result as {
          rows: Array<{
            rowNumber: number;
            registryId: string | null;
            status: string;
            operations: unknown[];
            diffText: string;
          }>;
        };

        // 把同一份 CSV 读成 AlignRequest JSON（宏导出形态）
        const sheet = readSheetFile(csvPath);
        const requestPath = writeJsonTemp(dir, 'request.json', {
          header: sheet.header,
          rows: sheet.rows,
        });

        // JSON 入口
        const jsonRun = await runCommand(['align', '--in', requestPath], env);
        expect(jsonRun.code).toBe(0);
        expect(jsonRun.envelope?.ok).toBe(true);
        const jsonResult = jsonRun.envelope?.result as typeof csvResult;

        expect(csvResult.rows.length).toBe(jsonResult.rows.length);
        expect(csvResult.rows.length).toBe(3);

        // 逐行比对：登记号、状态、操作集、差异文案必须一致（批次键/时间戳除外）
        for (let i = 0; i < csvResult.rows.length; i += 1) {
          const a = csvResult.rows[i] as (typeof csvResult.rows)[number];
          const b = jsonResult.rows[i] as (typeof jsonResult.rows)[number];
          expect(a.registryId).toBe(b.registryId);
          expect(a.status).toBe(b.status);
          expect(a.operations.length).toBe(b.operations.length);
          expect(JSON.stringify(a.operations)).toBe(JSON.stringify(b.operations));
          expect(a.diffText).toBe(b.diffText);
        }
      } finally {
        await stopHarness(harness);
      }
    });
  });
});
