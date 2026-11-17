/**
 * push 子命令：把确认闸门放行的行（确认列 = 「采纳」）外发到专病库登记接口。
 *
 * 数据来源是对齐结果（AlignResult）：只推送 `status === '采纳'` 的行；其余行进
 * skipped 列表并写明未确认原因。模型输出永不进推送体 —— 推送体只由对齐结果里的
 * 字段级最小操作集合（`operations`）组装，AI 说明等一律不碰。
 *
 * 幂等：每行一个由「登记号 + 操作集合」派生的幂等键（不混时间戳/重试次数），
 * 同内容重发由服务端去重。可重试错误（429/5xx/超时）按退避重试，耗尽进「待重试」。
 *
 * 输出：PushResult JSON 写到 `--out`（或标准输出）；`--dry-run` 只构造请求体不发送。
 *
 * 不修改任何既有模块；只组合公共 API。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  type AlignResult,
  type PushResult,
  type PushReceipt,
  type RowStatus,
  errorResponse,
  okResponse,
  parseAlignResult,
} from '../contract/index.js';
import { InvalidEnvError, loadEnv } from '../config/env.js';
import { RegistryClient, pushBatchWithRetry, buildPushBody, summarizeReceipts } from '../push/index.js';
import type { DiffOperation } from '../diff/patch.js';
import { splitPushable, isPushable } from '../confirm/gate.js';
import { buildSummary } from '../audit/summary.js';
import { stableStringify } from '../push/idempotency.js';
import { RunLogger } from '../observability/index.js';

import { resolveRunLogPath } from './shared.js';

/**
 * 由一行对齐结果派生稳定的行级幂等键（只含业务内容，与时间/重试无关）。
 *
 * 注意：该键会被放到 HTTP 请求头 `Idempotency-Key`，而 undici 要求头值必须是合法
 * ASCII 字符串。业务里字段路径（如「分期」）含中文，直接 `stableStringify` 会得到
 * 非 ASCII 文本，导致 `fetch` 抛错。因此这里对归一化 JSON 做 base64（UTF-8），
 * 既保持内容与顺序确定、又确保头值纯 ASCII。
 */
function rowIdempotencyKey(
  registryId: string | null,
  operations: unknown[],
): string {
  return Buffer.from(stableStringify({ registryId, operations }), 'utf8').toString('base64');
}

/** 把一行确认结果组装成推送体（受控网关不参与，模型输出不进体）。 */
function buildRowBody(
  row: AlignResult['rows'][number],
  identifierSystem: string,
  form: 'field-level' | 'whole-entry',
): ReturnType<typeof buildPushBody> {
  // ifMatch：写前比对用的登记侧原值（缺省取归一值）
  const ifMatch = row.operations.map((op) => ({
    path: op.path,
    value: (op.oldValue ?? null) as unknown,
  }));

  return buildPushBody(
    {
      registryId: row.registryId ?? '',
      identifierSystem,
      subjectReference: `Patient/${row.registryId ?? ''}`,
      operations: row.operations as unknown as DiffOperation[],
      ifMatch,
      extensions: {},
    },
    form,
  );
}

/** 由回执推导本批推送时刻（取第一条「已推送」回执的时刻，否则 null）。 */
function firstPushedAt(receipts: PushReceipt[]): string | null {
  for (const receipt of receipts) {
    if (receipt.status === '已推送' && receipt.pushedAt !== null) return receipt.pushedAt;
  }
  return null;
}

/**
 * push 子命令入口：读对齐结果 → 过滤可推送行 → 组装推送体 → 外发 → 收口回执。
 */
export async function runPush(
  flags: Record<string, string | boolean>,
  source: NodeJS.ProcessEnv,
): Promise<number> {
  const input =
    (typeof flags['in'] === 'string' && flags['in'].length > 0
      ? (flags['in'] as string)
      : typeof flags['align-result'] === 'string' && flags['align-result'].length > 0
        ? (flags['align-result'] as string)
        : null);

  if (input === null || !existsSync(input)) {
    process.stderr.write(
      `${JSON.stringify(
        errorResponse('push', {
          code: 'invalid_request',
          message: '缺少参数 --in（对齐结果 AlignResult JSON 路径）或该文件不存在',
          hint: '用法：node dist/cli.js push --in <对齐结果.json> [--out <推送结果.json>] [--dry-run]',
        }),
        null,
        2,
      )}\n`,
    );
    return 2;
  }

  const dryRun = flags['dry-run'] === true;

  try {
    const raw = JSON.parse(readFileSync(input, 'utf8')) as unknown;
    const alignResult = parseAlignResult(raw);

    const env = loadEnv(source);
    const identifierSystem = env.cdr.identifierSystem;
    const form = env.registry.payloadForm;
    const client = new RegistryClient(
      {
        baseUrl: env.registry.baseUrl,
        apiToken: env.registry.apiToken,
        payloadForm: form,
      },
    );

    const { pushable, skipped } = splitPushable(alignResult.rows);

    const skippedResult = skipped.map((item) => ({
      rowNumber: item.row.rowNumber,
      registryId: item.row.registryId,
      status: item.row.status as RowStatus,
      reason: item.reason,
    }));

    let receipts: PushReceipt[] = [];
    if (!dryRun) {
      const batchInput = pushable.map((row) => ({
        rowNumber: row.rowNumber,
        registryId: row.registryId,
        body: buildRowBody(row, identifierSystem, form),
        idempotencyKey: rowIdempotencyKey(row.registryId, row.operations),
      }));
      const result = await pushBatchWithRetry(batchInput, client);
      receipts = result.receipts;
    }

    const { pushed, failed, pendingRetry } = summarizeReceipts(receipts);
    const pushedAt = firstPushedAt(receipts) ?? new Date().toISOString();

    const summary = buildSummary({
      total: alignResult.rows.length,
      matched: alignResult.summary.matched,
      ambiguous: alignResult.summary.ambiguous,
      noMatch: alignResult.summary.noMatch,
      diffRows: alignResult.summary.diffRows,
      pendingConfirm: alignResult.summary.pendingConfirm,
      adopted: pushable.length,
      pushed,
      failed,
      pendingRetry,
      missingRows: alignResult.summary.missingRows,
      issueRows: alignResult.summary.issueRows,
      missingCheckIncomplete: alignResult.summary.missingCheckIncomplete,
    });

    const result: PushResult = {
      batchKey: alignResult.batchKey,
      pushedAt,
      summary,
      receipts,
      skipped: skippedResult,
      runLogPath: null,
    };

    // 运行日志：逐回执写 push 阶段事件（成功 / 失败 / 待重试）
    const runLogPath = resolveRunLogPath(
      source,
      typeof flags['log'] === 'string' && flags['log'].length > 0
        ? (flags['log'] as string)
        : undefined,
    );
    const logger = new RunLogger({ path: runLogPath, stage: 'push' });
    for (const receipt of receipts) {
      const outcome =
        receipt.status === '已推送' ? 'ok' : receipt.status === '待重试' ? 'retry' : 'error';
      logger.record(outcome, {
        rowNumber: receipt.rowNumber,
        rowId: receipt.registryId,
        errorCode: receipt.code,
        retryable: receipt.status !== '推送失败' ? true : false,
        attempts: receipt.attempts,
        message:
          receipt.status === '已推送'
            ? `登记号 ${receipt.registryId ?? ''} 已推送`
            : receipt.status === '待重试'
              ? `登记号 ${receipt.registryId ?? ''} 推送待重试：${receipt.reason ?? ''}`
              : `登记号 ${receipt.registryId ?? ''} 推送失败：${receipt.reason ?? ''}`,
        hint: receipt.status === '推送失败' ? receipt.reason ?? null : null,
      });
    }
    if (dryRun) {
      logger.record('ok', {
        message: `dry-run：构造了 ${pushable.length} 个推送体，未实际发送`,
      });
    }
    try {
      logger.flush();
      result.runLogPath = runLogPath;
    } catch {
      result.runLogPath = null;
    }

    const payload = okResponse('push', result, result.batchKey);
    const text = `${JSON.stringify(payload, null, 2)}\n`;

    const outFlag = typeof flags['out'] === 'string' ? (flags['out'] as string) : null;
    if (outFlag !== null) {
      writeFileSync(outFlag, text, 'utf8');
      process.stdout.write(
        `${JSON.stringify(
          okResponse(
            'push',
            { outputPath: outFlag, pushed, failed, pendingRetry, dryRun },
            result.batchKey,
          ),
          null,
          2,
        )}\n`,
      );
    } else {
      process.stdout.write(text);
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      error instanceof InvalidEnvError ? 'missing_env' : 'unknown';
    const hint =
      error instanceof InvalidEnvError
        ? error.message
        : '请确认 --in 指向的对齐结果合法，且 REGISTRY_BASE_URL / REGISTRY_API_TOKEN 已配置';
    process.stderr.write(
      `${JSON.stringify(errorResponse('push', { code, message, hint }), null, 2)}\n`,
    );
    return 1;
  }
}

/** 仅用于单测/复用：判定一行是否可推送（重导出确认闸门）。 */
export function rowIsPushable(status: RowStatus): boolean {
  return isPushable(status);
}
