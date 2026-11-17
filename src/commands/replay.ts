/**
 * replay 子命令：把已经导出过的 AlignRequest JSON 重新跑一遍对齐管线。
 *
 * 它是 align 的离线回放外壳 —— 输入只接受 AlignRequest JSON（与宏导出 / CSV 直跑
 * 收敛到的同一份契约），内部直接复用 `runAlignCore`（即 align 的同一套比对逻辑），
 * 保证「复现」与「首跑」用的永远是同一份引擎，不会两套实现分叉。
 *
 * `--snapshot` 为可选离线快照路径：若提供且存在，记录到结果备注里，供测试层用
 * 录制的 CDR 响应做确定性回放；生产环境不依赖它（align 管线照常走真实检索）。
 *
 * 输出：AlignResult JSON 写到 `--out`（或标准输出），与 align 完全同形。
 *
 * 不修改任何既有模块；只组合公共 API。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';

import {
  type AlignResult,
  errorResponse,
  okResponse,
} from '../contract/index.js';
import { FhirRequestError } from '../fhir/index.js';
import { InvalidEnvError } from '../config/env.js';
import { ColumnMappingError } from '../sheet/index.js';

import { defaultFieldSpecPath, defaultMappingPath, defaultPathMapPath, runAlignCore } from './align.js';

/**
 * replay 子命令入口：读 AlignRequest JSON → 复用 align 管线 → 落盘 AlignResult。
 */
export async function runReplay(
  flags: Record<string, string | boolean>,
  source: NodeJS.ProcessEnv,
): Promise<number> {
  const input = flags['in'];
  if (typeof input !== 'string' || input.length === 0) {
    process.stderr.write(
      `${JSON.stringify(
        errorResponse('replay', {
          code: 'invalid_request',
          message: '缺少参数 --in（AlignRequest JSON 路径）',
          hint: '用法：node dist/cli.js replay --in <alignRequest.json> [--out <结果.json>] [--snapshot <快照.json>]',
        }),
        null,
        2,
      )}\n`,
    );
    return 2;
  }

  if (extname(input).toLowerCase() === '.csv') {
    process.stderr.write(
      `${JSON.stringify(
        errorResponse('replay', {
          code: 'invalid_request',
          message: 'replay 只接受 AlignRequest JSON，不接受 CSV（CSV 请走 align）',
          hint: '把 CSV 先经宏导出成 AlignRequest JSON，再 replay',
        }),
        null,
        2,
      )}\n`,
    );
    return 2;
  }

  const snapshot =
    typeof flags['snapshot'] === 'string' && flags['snapshot'].length > 0
      ? (flags['snapshot'] as string)
      : null;

  try {
    const text = readFileSync(input, 'utf8');
    const parsed = JSON.parse(text) as {
      header?: unknown;
      rows?: unknown;
      columnMappingPath?: string;
      fieldSpecPath?: string;
    };
    if (!Array.isArray(parsed.header) || !Array.isArray(parsed.rows)) {
      throw new Error('AlignRequest 缺少 header / rows 字段');
    }
    const header = (parsed.header as unknown[]).map((name) => String(name));
    const rows = (parsed.rows as unknown[][]).map((row) =>
      row.map((cell) => (cell === null ? '' : String(cell))),
    );

    let mappingPath =
      typeof flags['mapping'] === 'string' && flags['mapping'].length > 0
        ? (flags['mapping'] as string)
        : defaultMappingPath();
    let fieldSpecPath =
      typeof flags['fieldSpec'] === 'string' && flags['fieldSpec'].length > 0
        ? (flags['fieldSpec'] as string)
        : defaultFieldSpecPath();

    // AlignRequest 内嵌的路径优先（存在才覆盖），与 align 行为一致
    if (typeof parsed.columnMappingPath === 'string' && parsed.columnMappingPath.length > 0) {
      if (existsSync(parsed.columnMappingPath)) mappingPath = parsed.columnMappingPath;
    }
    if (typeof parsed.fieldSpecPath === 'string' && parsed.fieldSpecPath.length > 0) {
      if (existsSync(parsed.fieldSpecPath)) fieldSpecPath = parsed.fieldSpecPath;
    }

    const { result } = await runAlignCore(
      header,
      rows,
      mappingPath,
      fieldSpecPath,
      defaultPathMapPath(),
      flags,
      source,
    );

    const payload = okResponse('replay', result as AlignResult, result.batchKey);
    const text2 = `${JSON.stringify(payload, null, 2)}\n`;

    const outFlag = typeof flags['out'] === 'string' ? (flags['out'] as string) : null;
    if (outFlag !== null) {
      writeFileSync(outFlag, text2, 'utf8');
      process.stdout.write(
        `${JSON.stringify(
          okResponse(
            'replay',
            { outputPath: outFlag, snapshot: snapshot ?? null },
            result.batchKey,
          ),
          null,
          2,
        )}\n`,
      );
    } else {
      process.stdout.write(text2);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error instanceof FhirRequestError
        ? error.code
        : error instanceof ColumnMappingError || error instanceof InvalidEnvError
          ? 'invalid_request'
          : 'unknown';
    const hint =
      error instanceof FhirRequestError
        ? error.userHint
        : error instanceof ColumnMappingError
          ? '请按提示核对列映射配置或表头后重跑'
          : error instanceof InvalidEnvError
            ? error.message
            : '请确认 --in 指向的 AlignRequest 合法且 CDR_* 环境变量已配置';
    process.stderr.write(
      `${JSON.stringify(errorResponse('replay', { code, message, hint }), null, 2)}\n`,
    );
    return 1;
  }
}
