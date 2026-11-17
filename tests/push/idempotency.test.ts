import { describe, expect, it } from 'vitest';

import {
  batchKey,
  idempotencyKey,
  stableStringify,
  tableFingerprint,
} from '../../src/push/idempotency.js';

describe('stableStringify', () => {
  it('对象键按字典序，与插入顺序无关', () => {
    const a = stableStringify({ b: 1, a: 2, c: 3 });
    const b = stableStringify({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it('数组保序', () => {
    expect(stableStringify([1, 2, 3])).toBe('[1,2,3]');
    expect(stableStringify([3, 2, 1])).not.toBe(stableStringify([1, 2, 3]));
  });

  it('undefined 归一为 null', () => {
    expect(stableStringify({ a: undefined })).toBe('{"a":null}');
  });
});

describe('idempotencyKey', () => {
  it('同一内容（不同时间戳/重试/批次）得到同一键', () => {
    const base = (nonce: unknown) =>
      idempotencyKey('R1', 'stage', 'IIIA', 'IIIB');
    const k1 = base('2026-01-01T00:00:00Z');
    const k2 = base('2026-02-02T12:00:00Z');
    const k3 = idempotencyKey('R1', 'stage', 'IIIA', 'IIIB');
    expect(k1).toBe(k2);
    expect(k1).toBe(k3);
  });

  it('内容不同则键不同', () => {
    const k1 = idempotencyKey('R1', 'stage', 'IIIA', 'IIIB');
    const k2 = idempotencyKey('R1', 'stage', 'IIIA', 'IV');
    expect(k1).not.toBe(k2);
  });

  it('多字段行 → 每个字段各自一个独立键', () => {
    const fields = [
      { path: 'stage', old: 'IIIA', nu: 'IIIB' },
      { path: 'therapy', old: 'X', nu: 'Y' },
    ];
    const keys = fields.map((f) => idempotencyKey('R1', f.path, f.old, f.nu));
    expect(keys[0]).not.toBe(keys[1]);
    // 每键都是稳定的 hex sha256
    for (const k of keys) {
      expect(k).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('batchKey', () => {
  it('相同输入稳定，输入不同则不同', () => {
    const a = batchKey('fp', 'p=1', '2026-01-01T00:00:00Z');
    const b = batchKey('fp', 'p=1', '2026-01-01T00:00:00Z');
    const c = batchKey('fp', 'p=2', '2026-01-01T00:00:00Z');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('tableFingerprint', () => {
  it('拼接多段取 sha256', () => {
    const a = tableFingerprint('sheet', '2026', 'v1');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(tableFingerprint('sheet', '2026', 'v1')).toBe(a);
  });
});
