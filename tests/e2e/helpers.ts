/**
 * e2e 测试公共工具（仅测试层）。
 *
 * 直接驱动 `runCli`（与生产入口同一条代码路径），通过临时覆盖
 * `process.stdout/stderr` 截获输出，再从 stdout/stderr 里解析出统一响应包络
 * （{ok, command, batchKey, result}）。不额外起子进程，断言稳定且快。
 */
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { runCli } from '../../src/cli.js';
import type { CommandName, ErrorCode } from '../../src/contract/index.js';

export interface RunResult {
  /** 进程退出码（runCli 返回值） */
  code: number;
  stdout: string;
  stderr: string;
  /** 从 stdout/stderr 解析出的响应包络（失败时为 null） */
  envelope: CommandEnvelope | null;
}

export interface CommandEnvelope {
  ok: boolean;
  command: CommandName;
  batchKey: string | null;
  error?: { code: ErrorCode; message: string; hint?: string | null };
  result?: unknown;
}

function parseEnvelope(text: string): CommandEnvelope | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed) as CommandEnvelope;
    if (parsed && typeof parsed === 'object' && 'ok' in parsed) return parsed;
  } catch {
    // 多行输出里可能夹着非 JSON 行，逐行再试一次
    for (const line of trimmed.split('\n')) {
      const t = line.trim();
      if (t.length === 0) continue;
      try {
        const p = JSON.parse(t) as CommandEnvelope;
        if (p && typeof p === 'object' && 'ok' in p) return p;
      } catch {
        // ignore
      }
    }
  }
  return null;
}

/** 运行一条 CLI 命令（argv 不含 `node dist/cli.js` 前缀），截获输出并解析包络。 */
export async function runCommand(
  argv: string[],
  env: NodeJS.ProcessEnv,
): Promise<RunResult> {
  let stdout = '';
  let stderr = '';
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);

  const sink = (chunk: string | Uint8Array): boolean => {
    const s = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  };
  // 用闭包累积，避免丢掉多段写入
  (process.stdout as unknown as { write: (c: string | Uint8Array) => boolean }).write = (
    chunk: string | Uint8Array,
  ) => {
    stdout += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  };
  (process.stderr as unknown as { write: (c: string | Uint8Array) => boolean }).write = (
    chunk: string | Uint8Array,
  ) => {
    stderr += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
    return true;
  };

  let code = 0;
  try {
    code = await runCli(argv, env);
  } finally {
    (process.stdout as unknown as { write: typeof origOut }).write = origOut;
    (process.stderr as unknown as { write: typeof origErr }).write = origErr;
  }

  void sink;
  const envelope = parseEnvelope(stdout) ?? parseEnvelope(stderr);
  return { code, stdout, stderr, envelope };
}

/**
 * 在已存在的 tests/e2e 目录里跑 fn（不新建子目录——部分运行环境对新建目录的写权限
 * 不稳定）。临时文件名全局唯一，fn 结束后统一清理。
 */
const createdFiles: string[] = [];

export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = join(process.cwd(), 'tests', 'e2e');
  try {
    // fn 是异步回调：必须 await，否则 finally 会在 async 体真正执行、登记文件之前就同步触发，
    // 导致 createdFiles 在清理时永远为空、所有 e2e-tmp-* 临时文件泄漏。
    return await fn(dir);
  } finally {
    for (const file of createdFiles.splice(0)) {
      try {
        rmSync(file, { force: true });
      } catch {
        // 忽略清理失败
      }
    }
  }
}

let counter = 0;
function uniqueName(ext: string): string {
  counter += 1;
  return `e2e-tmp-${Date.now()}-${counter}-${Math.random().toString(36).slice(2, 8)}${ext}`;
}

/** 写文本文件到临时位置，返回路径（自动登记以便清理）。 */
export function writeTemp(dir: string, name: string, content: string): string {
  const path = join(dir, uniqueName(name.startsWith('.') ? name : `-${name}`));
  writeFileSync(path, content, 'utf8');
  createdFiles.push(path);
  return path;
}

/** 写 JSON 文件到临时位置，返回路径（自动登记以便清理）。 */
export function writeJsonTemp(dir: string, name: string, value: unknown): string {
  return writeTemp(dir, name, JSON.stringify(value));
}
