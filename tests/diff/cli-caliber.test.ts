import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/cli.js';

const FIXTURE = fileURLToPath(new URL('../fixtures/registry-utf8.csv', import.meta.url));

afterEach(() => {
  vi.restoreAllMocks();
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

/** 临时回放集：一位患者两条就诊（离线派生结果的稳定夹具）。 */
function tempReplaySet(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tumor-registry-caliber-'));
  writeFileSync(
    join(dir, 'Patient.json'),
    JSON.stringify([
      {
        resourceType: 'Patient',
        id: 'pat-1',
        identifier: [{ system: 'urn:oid:test', value: 'REG-0001' }],
      },
    ]),
    'utf8',
  );
  writeFileSync(join(dir, 'Condition.json'), JSON.stringify([]), 'utf8');
  writeFileSync(
    join(dir, 'Encounter.json'),
    JSON.stringify([
      {
        resourceType: 'Encounter',
        id: 'enc-1',
        subject: { reference: 'Patient/pat-1' },
        period: { start: '2024-03-05T08:00:00+08:00' },
      },
      {
        resourceType: 'Encounter',
        id: 'enc-2',
        subject: { reference: 'Patient/pat-1' },
        period: { start: '2023-11-02T14:00:00+08:00' },
      },
    ]),
    'utf8',
  );
  return dir;
}

/** 带一列口径表没声明过的列的登记表。 */
function tableWithUndeclaredColumn(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tumor-registry-caliber-table-'));
  const path = join(dir, 'table.csv');
  writeFileSync(
    path,
    '登记号,分期,治疗方案,随访电话,生活方式备注,备注\nREG-0001,ⅢB,术后辅助化疗,138****0001,吸烟史,手工加的\n',
    'utf8',
  );
  return path;
}

/** 口径表里人工补充列却声明参与比对（冲突配置）。 */
function brokenSpecPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tumor-registry-caliber-spec-'));
  const path = join(dir, 'field-spec.json');
  writeFileSync(
    path,
    JSON.stringify({
      version: '0.1.0',
      basis: '经验推断',
      note: '冲突口径表。',
      fields: [
        {
          field: '随访电话',
          source: '登记列',
          sourceColumn: '随访电话',
          resourcePath: null,
          description: '人工补充的随访电话',
          participatesInDiff: true,
          derived: false,
          controlledCode: false,
          humanSupplied: true,
          basis: '经验推断',
        },
      ],
    }),
    'utf8',
  );
  return path;
}

describe('caliber 子命令（生效口径清单与派生字段结果）', () => {
  it('打印当前生效的口径清单与逐列判定', async () => {
    const stdout = captureStdout();
    const code = await runCli(['caliber', '--in', FIXTURE], {} as NodeJS.ProcessEnv);

    expect(code).toBe(0);
    const payload = JSON.parse(stdout.text());
    expect(payload.ok).toBe(true);
    expect(payload.command).toBe('caliber');

    const result = payload.result;
    expect(result.version).toBe('0.1.0');
    expect(result.basis).toBe('经验推断');
    expect(result.counts.fields).toBe(7);
    expect(result.counts.derived).toBe(2);
    expect(result.counts.humanSupplied).toBe(2);

    // 口径清单逐条带来源与处理口径
    const stage = result.calibers.find((item: { field: string }) => item.field === '分期');
    expect(stage.resourcePath).toBe('Condition.stage');
    expect(stage.treatment).toBe('参与比对');

    // 逐列判定：人工补充列单列一档
    expect(result.table.humanSuppliedColumns).toEqual(['随访电话', '生活方式备注']);
    expect(result.table.unspecifiedColumns).toEqual([]);
    const phone = result.table.columns.find(
      (column: { column: string }) => column.column === '随访电话',
    );
    expect(phone.status).toBe('人工补充列');
    expect(phone.participatesInDiff).toBe(false);
  });

  it('口径表没声明的列显式标「口径未声明」且不参与比对', async () => {
    const stdout = captureStdout();
    const code = await runCli(['caliber', '--in', tableWithUndeclaredColumn()], {} as NodeJS.ProcessEnv);

    expect(code).toBe(0);
    const result = JSON.parse(stdout.text()).result;
    expect(result.table.unspecifiedColumns).toEqual(['备注']);
    const note = result.table.columns.find((column: { column: string }) => column.column === '备注');
    expect(note.status).toBe('口径未声明');
    expect(note.participatesInDiff).toBe(false);
  });

  it('按口径表算派生字段结果（首次入院日取最早、本次就诊开始取最近）', async () => {
    const stdout = captureStdout();
    const code = await runCli(['caliber', '--replay', tempReplaySet()], {} as NodeJS.ProcessEnv);

    expect(code).toBe(0);
    const derived = JSON.parse(stdout.text()).result.derived;
    expect(derived.available).toBe(true);
    expect(derived.patients).toBe(1);
    expect(derived.sampled).toBe(1);
    expect(derived.statusCounts['已取到']).toBe(2);

    const row = derived.rows[0];
    expect(row.derived['首次入院日'].date).toBe('2023-11-02');
    expect(row.derived['首次入院日'].participatesInDiff).toBe(true);
    expect(row.derived['本次就诊开始'].date).toBe('2024-03-05');
  });

  it('回放集不可用时显式报错并点名目录（显式指定时不静默跳过）', async () => {
    const stdout = captureStdout();
    const code = await runCli(['caliber', '--replay', '/tmp/不存在的回放集'], {} as NodeJS.ProcessEnv);

    expect(code).toBe(1);
    expect(stdout.stderrText()).toContain('/tmp/不存在的回放集');
  });

  it('口径表有冲突时报错并点名冲突字段', async () => {
    const stdout = captureStdout();
    const code = await runCli(['caliber', '--spec', brokenSpecPath()], {} as NodeJS.ProcessEnv);

    expect(code).toBe(1);
    expect(stdout.stderrText()).toContain('随访电话');
  });

  it('--out 把结果落盘', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tumor-registry-caliber-out-'));
    const out = join(dir, 'caliber.json');
    const stdout = captureStdout();
    const code = await runCli(['caliber', '--out', out], {} as NodeJS.ProcessEnv);

    expect(code).toBe(0);
    expect(stdout.text()).toContain(out);
    const written = JSON.parse(readFileSync(out, 'utf8') as string);
    expect(written.result.calibers.length).toBe(7);
  });
});
