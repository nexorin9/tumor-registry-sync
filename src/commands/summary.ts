/**
 * summary 子命令：读对齐结果（AlignResult）+ 运行日志，产出本周期摘要。
 *
 * 它不做任何网络请求，只做三件事：
 * 1. 校验对齐结果契约（parseAlignResult），拿权威计数 summary、批次键、检索参数串；
 * 2. 读回运行日志（对齐阶段 + 推送阶段的事件），用 crossCheckSummary 把摘要计数
 *    与日志里可反推的计数（pushed / failed / pendingRetry / issueRows）核对，
 *    对不上就明说，绝不假装一致；
 * 3. 由运行日志里最近一条「已推送」事件的时间戳推出「上次同步时间」。
 *
 * 输出：SummaryResult JSON 写到 `--out`（或标准输出）。
 *
 * 不修改任何既有模块；只组合公共 API。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import {
  type AlignResult,
  type SummaryResult,
  errorResponse,
  okResponse,
  parseAlignResult,
} from '../contract/index.js';
import { readRunLog } from '../observability/logger.js';
import { buildSummary, crossCheckSummary, formatLastSynced } from '../audit/summary.js';

import { resolveRunLogPath } from './shared.js';

/** 挑选运行日志路径：对齐结果自带 > --run-log / --log 旗标 > 默认落盘位置。 */
function pickRunLogPath(
  fromResult: string | null,
  flags: Record<string, string | boolean>,
  source: NodeJS.ProcessEnv,
): string | null {
  if (typeof fromResult === 'string' && fromResult.length > 0) return fromResult;
  const flag =
    (typeof flags['run-log'] === 'string' && flags['run-log'].length > 0
      ? (flags['run-log'] as string)
      : typeof flags['log'] === 'string' && flags['log'].length > 0
        ? (flags['log'] as string)
        : null) as string | null;
  if (flag !== null) return flag;
  const fallback = resolveRunLogPath(source, undefined);
  return existsSync(fallback) ? fallback : null;
}

/**
 * summary 子命令入口：读对齐结果 → 交叉校验 → 组装摘要 → 落盘。
 */
export async function runSummary(
  flags: Record<string, string | boolean>,
  source: NodeJS.ProcessEnv,
): Promise<number> {
  const input =
    (typeof flags['in'] === 'string' && flags['in'].length > 0
      ? (flags['in'] as string)
      : typeof flags['align-result'] === 'string' && flags['align-result'].length > 0
        ? (flags['align-result'] as string)
        : null) as string | null;

  if (input === null || !existsSync(input)) {
    process.stderr.write(
      `${JSON.stringify(
        errorResponse('summary', {
          code: 'invalid_request',
          message: '缺少参数 --in（对齐结果 AlignResult JSON 路径）或该文件不存在',
          hint: '用法：node dist/cli.js summary --in <对齐结果.json> [--out <摘要.json>] [--run-log <run-log.jsonl>]',
        }),
        null,
        2,
      )}\n`,
    );
    return 2;
  }

  try {
    const raw = JSON.parse(readFileSync(input, 'utf8')) as unknown;
    const alignResult = parseAlignResult(raw) as AlignResult;

    const runLogPath = pickRunLogPath(alignResult.runLogPath, flags, source);
    let events: ReturnType<typeof readRunLog> = [];
    if (runLogPath !== null && existsSync(runLogPath)) {
      try {
        events = readRunLog(runLogPath);
      } catch {
        events = [];
      }
    }

    const cross = crossCheckSummary(alignResult.summary, events);

    // 上次同步时间：运行日志里最近一条「已推送」事件的时间戳（无推送则为 null）
    let lastPushIso: string | null = null;
    for (const event of events) {
      if (event.stage === 'push' && event.outcome === 'ok' && event.ts.length > 0) {
        if (lastPushIso === null || event.ts > lastPushIso) lastPushIso = event.ts;
      }
    }
    const synced = formatLastSynced(lastPushIso);

    const result: SummaryResult = {
      batchKey: alignResult.batchKey,
      generatedAt: new Date().toISOString(),
      summary: alignResult.summary,
      lastSyncedAt: synced.text,
      lastSyncedAtRaw: synced.raw,
      searchParams: alignResult.receipt.searchParams,
      crossCheckOk: cross.ok,
      crossCheckNote: cross.note,
    };

    const payload = okResponse('summary', result, result.batchKey);
    const text = `${JSON.stringify(payload, null, 2)}\n`;

    const outFlag = typeof flags['out'] === 'string' ? (flags['out'] as string) : null;
    if (outFlag !== null) {
      writeFileSync(outFlag, text, 'utf8');
      process.stdout.write(
        `${JSON.stringify(
          okResponse(
            'summary',
            {
              outputPath: outFlag,
              crossCheckOk: cross.ok,
              lastSyncedAt: synced.text,
            },
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
    process.stderr.write(
      `${JSON.stringify(
        errorResponse('summary', {
          code: 'invalid_request',
          message,
          hint: '请确认 --in 指向的对齐结果合法（可被 parseAlignResult 校验通过）',
        }),
        null,
        2,
      )}\n`,
    );
    return 1;
  }
}

/** 仅用于单测/复用：由对齐结果计数派生完整 SummaryCounts（透传 buildSummary）。 */
export function summarizeAlignResult(alignResult: AlignResult) {
  return buildSummary({
    total: alignResult.summary.total,
    matched: alignResult.summary.matched,
    ambiguous: alignResult.summary.ambiguous,
    noMatch: alignResult.summary.noMatch,
    diffRows: alignResult.summary.diffRows,
    pendingConfirm: alignResult.summary.pendingConfirm,
    adopted: alignResult.summary.adopted,
    pushed: alignResult.summary.pushed,
    failed: alignResult.summary.failed,
    pendingRetry: alignResult.summary.pendingRetry,
    missingRows: alignResult.summary.missingRows,
    issueRows: alignResult.summary.issueRows,
    missingCheckIncomplete: alignResult.summary.missingCheckIncomplete,
  });
}
