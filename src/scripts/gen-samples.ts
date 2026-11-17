#!/usr/bin/env node
/**
 * 脱敏登记表样例 + 归并语料生成脚本。
 *
 * 干什么：按受控口径表生成一份登记员的登记表（占位登记号 + 自由写法 + 人工补充列 +
 * 脏行），同时给出**期望差异集**（逐行该出什么差异、什么操作）与**院内侧期望**，
 * 供对照基线、规模验收与端到端回放当断言基准。
 *
 * 三条纪律（与 fetch-synthea 同款）：
 * 1. **幂等**：同参数两次生成逐字节一致（固定种子，不取当前时间）。
 * 2. **不冒充真实数据**：只有占位标识与脱敏电话，不含任何可识别明报。
 * 3. **校验不过就非零退出**：样例表是后面所有验收的基准，基准错了后面全错。
 *
 * 用法：
 *   node dist/scripts/gen-samples.js --rows 120 --out samples/generated
 */
import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { errorResponse, okResponse } from '../contract/index.js';
import {
  DEFAULT_ROWS,
  DEFAULT_SEED,
  generateSample,
  type GeneratedSample,
} from '../samples/generate.js';

/** 产物文件名（对外契约，下游按这些名字取文件）。 */
export const OUTPUT_FILES = {
  sheet: 'sample.csv',
  mixed: 'sample-gbk-utf8.csv',
  expectedDiffs: 'expected-diffs.json',
  hospitalExpected: 'hospital-expected.json',
  corpus: 'corpus.json',
  manifest: 'manifest.json',
} as const;

/** 原子写：先写临时文件再 rename，写失败不留半文件。 */
async function atomicWrite(path: string, content: string | Buffer): Promise<void> {
  const temp = `${path}.tmp`;
  await writeFile(temp, content, typeof content === 'string' ? 'utf8' : undefined);
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** sha256 摘要（manifest 里记文件指纹，便于核对两次生成是否一致）。 */
function digest(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** 组装 manifest：计数、校验结果与文件指纹。 */
function buildManifest(sample: GeneratedSample, outDir: string): Record<string, unknown> {
  return {
    schemaVersion: '1',
    generator: 'scripts/gen-samples',
    generatedWith: sample.expectedDiffs.generatedWith,
    outDir,
    files: { ...OUTPUT_FILES },
    counts: {
      csvDataLines: sample.stats.csvDataLines,
      usableRows: sample.stats.usableRows,
      blockedRows: sample.stats.blockedRows,
      blankLines: sample.stats.blankLines,
      corpusEntries: sample.stats.corpusEntries,
      operations: sample.stats.operations,
      status: sample.stats.status,
    },
    conventions: sample.expectedDiffs.conventions,
    validation: {
      ok: sample.checks.every((check) => check.ok),
      checks: sample.checks,
    },
    checksums: {
      [OUTPUT_FILES.sheet]: digest(sample.sheetCsv),
      [OUTPUT_FILES.mixed]: digest(sample.mixedCsv),
      [OUTPUT_FILES.expectedDiffs]: digest(`${JSON.stringify(sample.expectedDiffs, null, 2)}\n`),
      [OUTPUT_FILES.hospitalExpected]: digest(
        `${JSON.stringify(sample.hospitalExpected, null, 2)}\n`,
      ),
      [OUTPUT_FILES.corpus]: digest(`${JSON.stringify(sample.corpus, null, 2)}\n`),
    },
    note:
      '本目录是验证用数据集（脱敏登记表样例 + 归并语料 + 期望差异集），' +
      '不是产品的最终对接方式；真实对接仍是院内 CDR 的 FHIR R4 只读接口与专病库登记接口。',
  };
}

/** 写出全部产物。 */
export async function writeSample(outDir: string, sample: GeneratedSample): Promise<void> {
  await mkdir(outDir, { recursive: true });

  await atomicWrite(join(outDir, OUTPUT_FILES.sheet), sample.sheetCsv);
  await atomicWrite(join(outDir, OUTPUT_FILES.mixed), sample.mixedCsv);
  await atomicWrite(
    join(outDir, OUTPUT_FILES.expectedDiffs),
    `${JSON.stringify(sample.expectedDiffs, null, 2)}\n`,
  );
  await atomicWrite(
    join(outDir, OUTPUT_FILES.hospitalExpected),
    `${JSON.stringify(sample.hospitalExpected, null, 2)}\n`,
  );
  await atomicWrite(join(outDir, OUTPUT_FILES.corpus), `${JSON.stringify(sample.corpus, null, 2)}\n`);
  await atomicWrite(
    join(outDir, OUTPUT_FILES.manifest),
    `${JSON.stringify(buildManifest(sample, outDir), null, 2)}\n`,
  );
}

const USAGE = `脱敏登记表样例与归并语料生成

用法：
  node dist/scripts/gen-samples.js --rows 120 --out samples/generated [选项]

选项：
  --rows <n>     可参与比对的行数（脏行另计，默认 ${DEFAULT_ROWS}）
  --out <dir>    产物目录（默认 samples/generated）
  --seed <n>     随机种子：影响院内侧取值与期望差异集；登记表本身固定不动，
                 保证同一份输入表可以反复比对（默认 ${DEFAULT_SEED}）
`;

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith('--')) continue;
    const name = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[name] = true;
    } else {
      flags[name] = next;
      index += 1;
    }
  }
  return flags;
}

function readString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(flags: Record<string, string | boolean>, name: string): number | undefined {
  const raw = readString(flags, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} 应为正整数，当前为「${raw}」`);
  }
  return parsed;
}

export async function main(argv: string[]): Promise<number> {
  const flags = parseArgs(argv);
  if (flags['help'] === true || flags['h'] === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  const rows = readNumber(flags, 'rows') ?? DEFAULT_ROWS;
  const seed = readNumber(flags, 'seed') ?? DEFAULT_SEED;
  const outDir = resolve(readString(flags, 'out') ?? join('samples', 'generated'));

  let sample: GeneratedSample;
  try {
    sample = generateSample({ rows, seed });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `${JSON.stringify(
        errorResponse('replay', {
          code: 'invalid_request',
          message: `生成样例失败：${message}`,
          hint: '请按 --help 核对参数取值；--rows 需为正整数',
        }),
        null,
        2,
      )}\n`,
    );
    return 2;
  }

  try {
    await writeSample(outDir, sample);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `${JSON.stringify(
        errorResponse('replay', {
          code: 'server_error',
          message: `写出样例文件失败：${message}`,
          hint: `请检查目录是否可写：${outDir}`,
        }),
        null,
        2,
      )}\n`,
    );
    return 1;
  }

  const failed = sample.checks.filter((check) => !check.ok);

  process.stdout.write(
    `${JSON.stringify(
      okResponse('replay', {
        outDir,
        files: { ...OUTPUT_FILES },
        counts: {
          csvDataLines: sample.stats.csvDataLines,
          usableRows: sample.stats.usableRows,
          blockedRows: sample.stats.blockedRows,
          blankLines: sample.stats.blankLines,
          corpusEntries: sample.stats.corpusEntries,
          operations: sample.stats.operations,
          status: sample.stats.status,
        },
        validation: {
          ok: failed.length === 0,
          checks: sample.checks,
        },
      }),
      null,
      2,
    )}\n`,
  );

  if (failed.length > 0) {
    process.stderr.write(
      `${JSON.stringify(
        errorResponse('replay', {
          code: 'bad_payload',
          message: `样例未通过校验：${failed.map((check) => `${check.name}（${check.detail}）`).join('；')}`,
          hint: '样例是后续验收的基准，请修好后重跑；必要时调大 --rows',
        }),
        null,
        2,
      )}\n`,
    );
    return 1;
  }

  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `${JSON.stringify(
          errorResponse('replay', { code: 'unknown', message, hint: null }),
          null,
          2,
        )}\n`,
      );
      process.exitCode = 1;
    });
}
