/**
 * 原子写：先写临时文件再 rename，失败不留半文件。
 *
 * 登记员拿到的是一张要直接打开的表，半截文件比报错更麻烦 —— 所以凡是往磁盘上
 * 落「给人看」的东西（结果表、待人工处理清单）都走这里：
 * 写出中途失败时，磁盘上要么是旧文件，要么什么都没有，不会出现半张表。
 *
 * 错误语义：失败抛 {@link AtomicWriteError}，message 里带底层原因（如 EISDIR），
 * 由调用方决定怎么翻译成登记员看得懂的话。
 */
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** 原子写失败：目标路径与底层原因都在，不静默吞。 */
export class AtomicWriteError extends Error {
  /** 目标文件路径 */
  readonly targetPath: string;
  /** 底层错误 */
  readonly reason: unknown;

  constructor(targetPath: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(detail);
    this.name = 'AtomicWriteError';
    this.targetPath = targetPath;
    this.reason = cause;
  }
}

/** 临时文件计数器：同一进程内多次写不撞名。 */
let tempCounter = 0;

/**
 * 原子写一个文件。
 *
 * 步骤：写临时文件 → fsync → rename 覆盖目标。rename 在同一文件系统上是原子的，
 * 所以读者永远看到完整的旧版本或完整的新版本。
 *
 * @param targetPath 目标文件路径
 * @param data 要写入的字节
 */
export function writeFileAtomically(targetPath: string, data: Buffer): void {
  const absolute = resolve(targetPath);
  const directory = dirname(absolute);
  const tempPath = join(directory, `.${basename(absolute)}.tmp-${process.pid}-${tempCounter++}`);

  try {
    const handle = openSync(tempPath, 'wx');
    try {
      writeFileSync(handle, data);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(tempPath, absolute);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      /* 临时文件可能压根没建成，忽略 */
    }
    throw new AtomicWriteError(absolute, error);
  }
}
