/**
 * 三入口共用 JSON 契约 · 统一出口。
 *
 * 宏（Excel VBA / WPS JSA）与 CSV 直跑入口都只依赖本模块导出的 schema：
 * 引擎侧写出请求 JSON，宏侧读回响应 JSON，两侧共用同一份契约，任何一侧改了
 * 字段名，另一侧立刻在校验时报错，不会各写各的。
 */
import { z } from 'zod';

import {
  AlignRequestSchema,
  AlignResultSchema,
  CommandErrorSchema,
  CommandOkSchema,
  CommandResponseSchema,
  LookupResultSchema,
  PushRequestSchema,
  PushResultSchema,
  SummaryRequestSchema,
  SummaryResultSchema,
} from './commands.js';
import type { CommandName, ErrorCode, ErrorPayload } from './common.js';

export * from './common.js';
export * from './commands.js';

export {
  AlignRequestSchema,
  AlignResultSchema,
  CommandErrorSchema,
  CommandOkSchema,
  CommandResponseSchema,
  LookupResultSchema,
  PushRequestSchema,
  PushResultSchema,
  SummaryRequestSchema,
  SummaryResultSchema,
};

/** 契约校验失败：带字段路径与原因，宏侧据此给出可执行的提示。 */
export class ContractError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(issues.length > 0 ? `${message}：${issues.join('；')}` : message);
    this.name = 'ContractError';
    this.issues = issues;
  }
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path.length > 0 ? `${path} ${issue.message}` : issue.message;
  });
}

function parseOrThrow<S extends z.ZodTypeAny>(
  schema: S,
  data: unknown,
  label: string,
): z.output<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new ContractError(`${label}不符合契约`, formatIssues(parsed.error));
  }
  return parsed.data as z.output<S>;
}

/** 解析 align 请求（宏导出的工作表 JSON / CSV 直跑入口共用）。 */
export function parseAlignRequest(data: unknown): z.infer<typeof AlignRequestSchema> {
  return parseOrThrow(AlignRequestSchema, data, 'align 请求');
}

/** 解析 push 请求。 */
export function parsePushRequest(data: unknown): z.infer<typeof PushRequestSchema> {
  return parseOrThrow(PushRequestSchema, data, 'push 请求');
}

/** 解析 summary 请求。 */
export function parseSummaryRequest(data: unknown): z.infer<typeof SummaryRequestSchema> {
  return parseOrThrow(SummaryRequestSchema, data, 'summary 请求');
}

/** 解析 align 结果（宏回写前校验，防止引擎改了字段名而宏静默写错列）。 */
export function parseAlignResult(data: unknown): z.infer<typeof AlignResultSchema> {
  return parseOrThrow(AlignResultSchema, data, 'align 结果');
}

/** 解析 lookup 结果（检索阶段的逐行绑定判定）。 */
export function parseLookupResult(data: unknown): z.infer<typeof LookupResultSchema> {
  return parseOrThrow(LookupResultSchema, data, 'lookup 结果');
}

/** 解析 push 结果。 */
export function parsePushResult(data: unknown): z.infer<typeof PushResultSchema> {
  return parseOrThrow(PushResultSchema, data, 'push 结果');
}

/** 解析 summary 结果。 */
export function parseSummaryResult(data: unknown): z.infer<typeof SummaryResultSchema> {
  return parseOrThrow(SummaryResultSchema, data, 'summary 结果');
}

/** 解析统一响应包络。 */
export function parseCommandResponse(data: unknown): z.infer<typeof CommandResponseSchema> {
  return parseOrThrow(CommandResponseSchema, data, '命令响应');
}

/** 构造成功响应。 */
export function okResponse(
  command: CommandName,
  result: unknown,
  batchKey: string | null = null,
): z.infer<typeof CommandOkSchema> {
  return { ok: true, command, batchKey, result };
}

/** 构造失败响应：hint 指名可执行的下一步（例如「缺少 CDR_BASE_URL」）。 */
export function errorResponse(
  command: CommandName,
  error: {
    code: ErrorCode;
    message: string;
    hint?: string | null;
    httpStatus?: number | null;
    details?: unknown;
  },
  batchKey: string | null = null,
): z.infer<typeof CommandErrorSchema> {
  const payload: ErrorPayload = {
    code: error.code,
    message: error.message,
    hint: error.hint ?? null,
    ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    ...(error.details === undefined ? {} : { details: error.details }),
  };
  return { ok: false, command, batchKey, error: payload };
}
