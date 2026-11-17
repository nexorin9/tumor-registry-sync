import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/cli.js';
import {
  MANUAL_CHECKLIST_HEADER,
  RowIssueError,
  buildManualChecklist,
  buildManualChecklistCsv,
  collectBatchIssues,
  findCoverageGaps,
  formatIssueSummary,
  redactIdentifiable,
  summarizeRowIssues,
  writeManualChecklist,
} from '../../src/sheet/row-issues.js';
import { parseColumnMapping } from '../../src/sheet/column-mapping.js';
import { buildRows } from '../../src/sheet/rows.js';
import type { RowIssue } from '../../src/contract/index.js';
import { startFakeCdrServer, type FakeCdrServer } from '../fakes/fake-cdr.js';

/** 含脏行的登记表（空行 / 缺登记号 / 重复登记号 / 列数不符）。 */
const DIRTY_SAMPLE = fileURLToPath(
  new URL('../../samples/generated/sample.csv', import.meta.url),
);

/** 检索用的小样例（三行，院内能造出命中 / 歧义 / 零命中）。 */
const LOOKUP_FIXTURE = fileURLToPath(new URL('../fixtures/lookup-sample.csv', import.meta.url));

const MAPPING = parseColumnMapping({
  version: '0.1.0',
  registryIdColumn: '登记号',
  columns: [
    {
      field: '分期',
      sourceColumn: '分期',
      description: '登记员填写的分期自由写法',
      humanSupplied: false,
      required: false,
      controlledCode: true,
    },
    {
      field: '随访电话',
      sourceColumn: '随访电话',
      description: '登记员人工补充的随访电话',
      humanSupplied: true,
      required: false,
      controlledCode: false,
    },
  ],
});

const HEADER = ['登记号', '分期', '随访电话'];

/** 造一条行级问题。 */
function issue(overrides: Partial<RowIssue> = {}): RowIssue {
  return {
    rowNumber: 2,
    registryId: 'REG-0001',
    code: 'NO_MATCH',
    reason: '登记号 REG-0001 在院内未检索到患者记录',
    hint: '请核对登记号与 CDR_IDENTIFIER_SYSTEM 是否一致',
    blocking: false,
    ...overrides,
  };
}

const workdirs: string[] = [];
const servers: FakeCdrServer[] = [];

function workdir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tumor-registry-row-issues-'));
  workdirs.push(dir);
  return dir;
}

/** 捕获 CLI 的标准输出与错误输出。 */
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

afterEach(async () => {
  vi.restoreAllMocks();
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) await server.close();
  }
  while (workdirs.length > 0) {
    const dir = workdirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('行级问题统一归集', () => {
  it('读取侧问题归集：列数不符 / 缺登记号 / 登记号重复各出一条', () => {
    const normalized = buildRows({
      header: HEADER,
      rows: [
        ['REG-0001', 'ⅢB', '138****0001'],
        ['', 'Ⅱ', '138****0002'],
        ['REG-0002', 'Ⅱ', '138****0003'],
        ['REG-0002', 'Ⅲ', '138****0004'],
        ['REG-0003', 'Ⅳ'],
      ],
      mapping: MAPPING,
    });

    const batch = collectBatchIssues({ sheetRows: normalized.rows });

    const codes = batch.issues.map((item) => item.code);
    expect(codes).toContain('MISSING_REGISTRY_ID');
    expect(codes).toContain('DUPLICATE_REGISTRY_ID');
    expect(codes).toContain('COLUMN_COUNT_MISMATCH');
    // 缺登记号（第 3 行）与重复登记号（第 4、5 行）都进了清单，没有被丢掉
    expect(batch.issues.filter((item) => item.code === 'DUPLICATE_REGISTRY_ID')).toHaveLength(2);
    expect(batch.issues.filter((item) => item.code === 'MISSING_REGISTRY_ID')).toHaveLength(1);
    // 列数不符那行（第 6 行）也在清单里，写明是几个单元格对几列
    expect(batch.issues.filter((item) => item.code === 'COLUMN_COUNT_MISMATCH')).toHaveLength(1);
    expect(batch.issues.find((item) => item.code === 'COLUMN_COUNT_MISMATCH')?.reason).toContain(
      '2 个单元格',
    );
    expect(batch.summary.issueRows).toBe(4);
    expect(batch.gaps).toEqual([]);
  });

  it('检索侧问题归集：缺关键字段 / 非 JSON / 命中歧义 / 零命中各出一例', () => {
    const lookupRows = [
      {
        rowNumber: 2,
        registryId: 'REG-0001',
        issues: [
          issue({
            rowNumber: 2,
            code: 'MISSING_FIELD',
            reason: '院内 Condition 缺 code 字段',
            hint: '该字段本轮不参与比对',
          }),
        ],
      },
      {
        rowNumber: 3,
        registryId: 'REG-0002',
        issues: [
          issue({
            rowNumber: 3,
            code: 'BAD_PAYLOAD',
            reason: '院内响应不是 FHIR JSON',
            hint: '请联系信息科核对 CDR_BASE_URL',
          }),
        ],
      },
      {
        rowNumber: 4,
        registryId: 'REG-0003',
        issues: [issue({ rowNumber: 4, code: 'AMBIGUOUS_MATCH', reason: '命中 2 条' })],
      },
      {
        rowNumber: 5,
        registryId: 'REG-0004',
        issues: [issue({ rowNumber: 5, code: 'NO_MATCH', reason: '院内无此记录' })],
      },
    ];

    const batch = collectBatchIssues({ lookupRows });

    expect(batch.issues.map((item) => item.code)).toEqual([
      'MISSING_FIELD',
      'BAD_PAYLOAD',
      'AMBIGUOUS_MATCH',
      'NO_MATCH',
    ]);
    expect(batch.summary.issueRows).toBe(4);
    expect(batch.summary.totalIssues).toBe(4);
  });

  it('读表侧与检索侧合到一套，按行号排序', () => {
    const batch = collectBatchIssues({
      sheetRows: [
        { rowNumber: 9, registryId: 'REG-0009', issues: [issue({ rowNumber: 9, code: 'MISSING_REGISTRY_ID' })] },
      ],
      lookupRows: [
        { rowNumber: 3, registryId: 'REG-0003', issues: [issue({ rowNumber: 3, code: 'NO_MATCH' })] },
      ],
    });

    expect(batch.issues.map((item) => item.rowNumber)).toEqual([3, 9]);
  });

  it('同一行同一原因只留一条；同一行不同原因各留一条', () => {
    const duplicated = issue({ code: 'MISSING_FIELD', reason: '院内 Condition 缺 code 字段' });
    const other = issue({ code: 'MISSING_FIELD', reason: '院内 Encounter 缺 period.start 字段' });

    const batch = collectBatchIssues({
      lookupRows: [
        { rowNumber: 2, registryId: 'REG-0001', issues: [duplicated, { ...duplicated }, other] },
      ],
    });

    expect(batch.issues).toHaveLength(2);
    expect(batch.summary.issueRows).toBe(1);
    expect(batch.summary.totalIssues).toBe(2);
  });

  it('归集只读不改值：行上的单元格取值一个字节都不动', () => {
    const normalized = buildRows({
      header: HEADER,
      rows: [['REG-0001', 'ⅢB', '138****0001']],
      mapping: MAPPING,
    });
    const before = JSON.stringify(normalized.rows.map((row) => row.cells));

    collectBatchIssues({ sheetRows: normalized.rows });

    expect(JSON.stringify(normalized.rows.map((row) => row.cells))).toBe(before);
  });

  it('覆盖守卫：行上的每个错误码都进了清单，缺口为空', () => {
    const rows = [
      { rowNumber: 2, registryId: 'REG-0001', issues: [issue({ code: 'NO_MATCH' })] },
      { rowNumber: 3, registryId: null, issues: [issue({ rowNumber: 3, code: 'MISSING_REGISTRY_ID' })] },
    ];
    const batch = collectBatchIssues({ lookupRows: rows });

    expect(batch.gaps).toEqual([]);
    expect(findCoverageGaps(rows, batch.issues)).toEqual([]);
  });

  it('覆盖守卫能指出被漏掉的问题（人为制造缺口时可见）', () => {
    const rows = [
      { rowNumber: 2, registryId: 'REG-0001', issues: [issue({ code: 'NO_MATCH' })] },
    ];
    const gaps = findCoverageGaps(rows, []);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.rowNumber).toBe(2);
    expect(gaps[0]?.missingCodes).toEqual(['NO_MATCH']);
  });
});

describe('本批问题汇总与按错误码分布', () => {
  it('问题行数按行去重、次数按条目计、阻断条数单独数', () => {
    const issues = [
      issue({ rowNumber: 2, code: 'MISSING_FIELD', reason: '缺 code' }),
      issue({ rowNumber: 2, code: 'MISSING_FIELD', reason: '缺 period.start' }),
      issue({ rowNumber: 5, code: 'NO_MATCH', reason: '院内无此记录' }),
      issue({ rowNumber: 6, code: 'DUPLICATE_REGISTRY_ID', reason: '出现 2 次', blocking: true }),
    ];

    const summary = summarizeRowIssues(issues);

    expect(summary.issueRows).toBe(3);
    expect(summary.totalIssues).toBe(4);
    expect(summary.blockingIssues).toBe(1);
    expect(summary.byCode[0]).toMatchObject({
      code: 'MISSING_FIELD',
      count: 2,
      rows: 1,
      blocking: 0,
      label: '院内缺关键字段',
    });
    expect(summary.byCode.find((entry) => entry.code === 'DUPLICATE_REGISTRY_ID')).toMatchObject({
      rows: 1,
      blocking: 1,
      label: '登记号重复',
    });
  });

  it('分布按次数降序；次数相同时按错误码字典序', () => {
    const summary = summarizeRowIssues([
      issue({ rowNumber: 2, code: 'NO_MATCH' }),
      issue({ rowNumber: 3, code: 'AMBIGUOUS_MATCH' }),
      issue({ rowNumber: 4, code: 'BAD_PAYLOAD' }),
      issue({ rowNumber: 5, code: 'NO_MATCH' }),
    ]);

    expect(summary.byCode.map((entry) => entry.code)).toEqual([
      'NO_MATCH',
      'AMBIGUOUS_MATCH',
      'BAD_PAYLOAD',
    ]);
    expect(summary.byCode[0]?.count).toBe(2);
  });

  it('没有问题时汇总与文案都给出「本批没有行级问题」', () => {
    const summary = summarizeRowIssues([]);
    expect(summary.issueRows).toBe(0);
    expect(summary.totalIssues).toBe(0);
    expect(formatIssueSummary(summary)).toBe('本批没有行级问题。');
  });

  it('摘要文案写明问题行数、条数与阻断条数', () => {
    const summary = summarizeRowIssues([
      issue({ rowNumber: 2, code: 'NO_MATCH' }),
      issue({ rowNumber: 3, code: 'MISSING_REGISTRY_ID', blocking: true }),
    ]);
    const text = formatIssueSummary(summary);

    expect(text).toContain('2 行有问题');
    expect(text).toContain('共 2 条');
    expect(text).toContain('阻断推送 1 条');
    expect(text).toContain('院内无此记录');
  });
});

describe('待人工处理清单导出', () => {
  it('清单逐行一条，含行号、登记号、错误码、原因与处置建议', () => {
    const checklist = buildManualChecklist([
      issue({ rowNumber: 4, registryId: 'REG-0004', code: 'AMBIGUOUS_MATCH', reason: '命中 2 条' }),
    ]);

    expect(checklist).toHaveLength(1);
    expect(checklist[0]).toMatchObject({
      rowNumber: 4,
      registryId: 'REG-0004',
      code: 'AMBIGUOUS_MATCH',
      label: '院内命中多条',
      reason: '命中 2 条',
      blocking: false,
    });
  });

  it('CSV 表头固定七列，行号与登记号在最前面', () => {
    const built = buildManualChecklistCsv([
      issue({ rowNumber: 4, registryId: 'REG-0004', code: 'AMBIGUOUS_MATCH', reason: '命中 2 条' }),
    ]);

    const lines = built.text.split('\r\n');
    expect(lines[0]).toBe(MANUAL_CHECKLIST_HEADER.join(','));
    expect(MANUAL_CHECKLIST_HEADER).toHaveLength(7);
    expect(lines[1]).toContain('4');
    expect(lines[1]).toContain('REG-0004');
    expect(lines[1]).toContain('AMBIGUOUS_MATCH');
    expect(lines[1]).toContain('院内命中多条');
    expect(lines[1]).toContain('命中 2 条');
    expect(built.rows).toBe(1);
    expect(built.totalLines).toBe(2);
  });

  it('CSV 里含逗号 / 引号的字段按 CSV 规则转义；换行不把一条清单拆成两行', () => {
    const built = buildManualChecklistCsv([
      issue({ reason: '有逗号,还有"引号"', hint: '换行\n也在里面' }),
    ]);
    const lines = built.text.split('\r\n');

    expect(lines[1]).toContain('"有逗号,还有""引号"""');
    // 换行在落盘前被折成空格：一条问题永远占一行，不会把清单拆成多行
    expect(lines[1]).toContain('换行 也在里面');
    expect(lines.filter((line) => line.length > 0)).toHaveLength(2);
  });

  it('清单不含可识别明报：手机号 / 身份证号 / 邮箱落盘前脱敏', () => {
    const built = buildManualChecklistCsv([
      issue({
        reason: '随访电话 13800001234 与身份证 110101199001011234 不一致',
        hint: '请联系 13800001234 或 zhangsan@example.com 核对',
      }),
    ]);
    const text = built.text;

    expect(text).not.toContain('13800001234');
    expect(text).not.toContain('110101199001011234');
    expect(text).not.toContain('zhangsan@example.com');
    expect(text).toContain('138****1234');
    expect(text).toContain('110101********1234');
    expect(text).toContain('zh***@example.com');
    // 登记主索引占位标识原样保留 —— 它是本产品对人的唯一指认方式
    expect(text).toContain('REG-0001');
  });

  it('脱敏函数不动普通文本与登记号', () => {
    expect(redactIdentifiable('登记号 REG-0001 在院内未检索到患者记录')).toBe(
      '登记号 REG-0001 在院内未检索到患者记录',
    );
    expect(redactIdentifiable('分期 ⅢB 与 治疗方案 Ⅱ')).toBe('分期 ⅢB 与 治疗方案 Ⅱ');
  });

  it('落盘：UTF-8 带 BOM、CRLF 行尾，写完回读核对表头与明细', () => {
    const dir = workdir();
    const outputPath = join(dir, '待人工处理清单.csv');

    const result = writeManualChecklist(
      [issue({ rowNumber: 4, registryId: 'REG-0004', code: 'AMBIGUOUS_MATCH', reason: '命中 2 条' })],
      outputPath,
    );

    expect(result.rows).toBe(1);
    expect(result.totalLines).toBe(2);
    expect(result.encoding).toBe('utf-8');
    expect(result.lineEnding).toBe('crlf');
    expect(result.bom).toBe(true);
    expect(result.verification).toEqual({ headerMatches: true, bodyMatches: true, checkedRows: 1 });

    const bytes = readFileSync(outputPath);
    expect(bytes[0]).toBe(0xef);
    expect(bytes[1]).toBe(0xbb);
    expect(bytes[2]).toBe(0xbf);
    const text = bytes.subarray(3).toString('utf8');
    expect(text).toContain('\r\n');
    expect(text.split('\r\n')[0]).toBe(MANUAL_CHECKLIST_HEADER.join(','));
    expect(text).toContain('REG-0004');
  });

  it('落盘失败不留半文件：目标是非空目录时报错且目录内容不变', () => {
    const dir = workdir();
    const blocked = join(dir, 'blocked');
    rmSync(blocked, { recursive: true, force: true });
    mkdirSync(blocked);
    writeFileSync(join(blocked, '占位'), 'x');

    expect(() => writeManualChecklist([issue()], blocked)).toThrow(RowIssueError);
    expect(() => writeManualChecklist([issue()], blocked)).toThrow(/写出待人工处理清单失败/);

    // 临时文件不留在盘上，原目录内容不变
    expect(readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([]);
    expect(readdirSync(blocked)).toEqual(['占位']);
  });
});

describe('CLI 接线：sheet / lookup 都能导出待人工处理清单', () => {
  it('sheet --checklist 落出清单文件，并在结果里给出按错误码的分布', async () => {
    const dir = workdir();
    const checklistPath = join(dir, '待人工处理清单.csv');

    const stdout = captureStdout();
    const code = await runCli(['sheet', '--in', DIRTY_SAMPLE, '--checklist', checklistPath]);

    expect(code).toBe(0);
    const payload = JSON.parse(stdout.text());
    expect(payload.ok).toBe(true);
    expect(payload.result.issueSummary.issueRows).toBeGreaterThan(0);
    expect(payload.result.issueSummary.totalIssues).toBeGreaterThan(0);
    expect(payload.result.issueSummary.byCode.map((entry: { code: string }) => entry.code)).toEqual(
      expect.arrayContaining(['MISSING_REGISTRY_ID', 'DUPLICATE_REGISTRY_ID']),
    );
    expect(payload.result.issueDistribution).toContain('行有问题');

    const text = readFileSync(checklistPath, 'utf8');
    expect(text).toContain(MANUAL_CHECKLIST_HEADER.join(','));
    expect(text).toContain('MISSING_REGISTRY_ID');
    expect(text).toContain('缺登记号');
  });

  it('lookup --checklist 把检索侧问题（歧义 / 零命中）也并进同一张清单', async () => {
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

    const dir = workdir();
    const checklistPath = join(dir, '待人工处理清单.csv');
    const stdout = captureStdout();
    const code = await runCli(['lookup', '--in', LOOKUP_FIXTURE, '--checklist', checklistPath], {
      CDR_BASE_URL: server.baseUrl,
      CDR_API_TOKEN: 'test-token',
      CDR_IDENTIFIER_SYSTEM: 'urn:oid:2.16.156.10011.0.1',
      RUN_LOG_DIR: workdir(),
    } as NodeJS.ProcessEnv);

    expect(code).toBe(0);
    const payload = JSON.parse(stdout.text());
    const codes = payload.result.issueSummary.byCode.map((entry: { code: string }) => entry.code);
    expect(codes).toContain('AMBIGUOUS_MATCH');
    expect(codes).toContain('NO_MATCH');
    expect(payload.result.issueSummary.issueRows).toBe(2);
    expect(payload.result.checklist).toMatchObject({ rows: 2 });

    const text = readFileSync(checklistPath, 'utf8');
    expect(text).toContain('AMBIGUOUS_MATCH');
    expect(text).toContain('NO_MATCH');
    expect(text).toContain('院内命中多条');
  });
});
