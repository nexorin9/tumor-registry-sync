import { describe, it, expect } from 'vitest';
import {
  buildVocabIndex,
  normalizeTermKey,
  VocabIndexError,
  type ControlledTerm,
} from '../../src/merge/vocab-index.js';

function term(partial: Partial<ControlledTerm> & { code: string }): ControlledTerm {
  return {
    label: `${partial.code}期`,
    aliases: [],
    caliber: 'c',
    source: 's',
    ...partial,
  };
}

describe('normalizeTermKey 等价性', () => {
  it('全角罗马数字 / 半角 / 带空格 / 带期后缀 归一为同一键', () => {
    const keys = ['ⅢB', 'IIIB', 'III B', 'IIIB期', 'iiib', 'Ⅲ B期'].map(normalizeTermKey);
    for (const k of keys) {
      expect(k).toBe('iiib');
    }
  });

  it('去空白与大小写归一确定性', () => {
    expect(normalizeTermKey('  IIIb  ')).toBe('iiib');
    expect(normalizeTermKey('ⅠA')).toBe('ia');
  });
});

describe('buildVocabIndex 正常构建与命中', () => {
  const idx = buildVocabIndex({
    version: '1.0.0',
    terms: [
      term({ code: 'IIIB', aliases: ['ⅢB', 'III B', 'IIIB期'] }),
      term({ code: 'IA', aliases: ['ⅠA'] }),
    ],
  });

  it('多种写法命中同一编码', () => {
    for (const raw of ['ⅢB', 'IIIB', 'III B', 'IIIB期']) {
      const hit = idx.lookupRaw(raw);
      expect(hit).not.toBeNull();
      expect(hit?.code).toBe('IIIB');
    }
  });

  it('lookup 接受已归一键', () => {
    expect(idx.lookup(normalizeTermKey('IIIB'))?.code).toBe('IIIB');
  });
});

describe('buildVocabIndex 校验与冲突', () => {
  it('缺少 version 抛错', () => {
    expect(() => buildVocabIndex({ terms: [term({ code: 'X' })] })).toThrow(VocabIndexError);
    expect(() => buildVocabIndex({ version: '', terms: [term({ code: 'X' })] })).toThrow(
      VocabIndexError,
    );
  });

  it('缺少 code 抛错', () => {
    expect(() =>
      buildVocabIndex({
        version: '1',
        terms: [{ label: 'x', aliases: [], caliber: 'c', source: 's' } as unknown as ControlledTerm],
      }),
    ).toThrow(VocabIndexError);
  });

  it('缺少 caliber 抛错', () => {
    expect(() =>
      buildVocabIndex({
        version: '1',
        terms: [{ code: 'X', label: 'x', aliases: [], source: 's' } as unknown as ControlledTerm],
      }),
    ).toThrow(VocabIndexError);
  });

  it('缺少 source 抛错', () => {
    expect(() =>
      buildVocabIndex({
        version: '1',
        terms: [{ code: 'X', label: 'x', aliases: [], caliber: 'c' } as unknown as ControlledTerm],
      }),
    ).toThrow(VocabIndexError);
  });

  it('aliases 不是字符串数组抛错', () => {
    expect(() =>
      buildVocabIndex({
        version: '1',
        terms: [
          { code: 'X', label: 'x', aliases: 'notarray', caliber: 'c', source: 's' } as unknown as ControlledTerm,
        ],
      }),
    ).toThrow(VocabIndexError);
  });

  it('重复 code 抛错并点名冲突', () => {
    expect(() =>
      buildVocabIndex({
        version: '1',
        terms: [term({ code: 'DUP' }), term({ code: 'DUP' })],
      }),
    ).toThrow(/DUP/);
  });

  it('别名冲突（跨术语共享归一键）抛错', () => {
    expect(() =>
      buildVocabIndex({
        version: '1',
        terms: [term({ code: 'A', aliases: ['foo'] }), term({ code: 'B', aliases: ['foo'] })],
      }),
    ).toThrow(/foo/);
  });
});
