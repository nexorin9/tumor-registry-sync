import { describe, expect, it } from 'vitest';
import type { RowStatus } from '../../src/contract/index.js';
import {
  ALLOWED_TRANSITIONS,
  InvalidTransitionError,
  canTransition,
  isTerminal,
  transition,
} from '../../src/confirm/state.js';

describe('state: 合法迁移', () => {
  const legal: Array<[RowStatus, RowStatus]> = [
    ['待对齐', '待确认'],
    ['待对齐', '零命中'],
    ['待对齐', '命中歧义'],
    ['待对齐', '需人工判定'],
    ['待对齐', '无需确认'],
    ['待确认', '采纳'],
    ['待确认', '不采纳'],
    ['采纳', '已推送'],
    ['采纳', '推送失败'],
    ['需人工判定', '待确认'],
    ['院内已变更，需重查', '待对齐'],
    ['推送失败', '待确认'],
  ];

  for (const [from, to] of legal) {
    it(`${from} → ${to} 合法`, () => {
      expect(canTransition(from, to)).toBe(true);
      expect(transition(from, to)).toBe(to);
    });
  }
});

describe('state: 同态', () => {
  it('current===next 不报错', () => {
    expect(transition('待确认', '待确认')).toBe('待确认');
    expect(canTransition('待确认', '待确认')).toBe(false);
  });
});

describe('state: 非法迁移', () => {
  const illegal: Array<[RowStatus, RowStatus]> = [
    ['不采纳', '已推送'],
    ['零命中', '采纳'],
    ['待确认', '已推送'],
    ['已推送', '待确认'],
    ['采纳', '待对齐'],
    ['无需确认', '采纳'],
    ['命中歧义', '待确认'],
  ];

  for (const [from, to] of illegal) {
    it(`${from} → ${to} 抛 InvalidTransitionError`, () => {
      expect(canTransition(from, to)).toBe(false);
      expect(() => transition(from, to)).toThrow(InvalidTransitionError);
      try {
        transition(from, to);
      } catch (e) {
        const err = e as InvalidTransitionError;
        expect(err.current).toBe(from);
        expect(err.next).toBe(to);
        expect(Array.isArray(err.allowed)).toBe(true);
        expect(err.allowed).toEqual(ALLOWED_TRANSITIONS[from]);
        expect(err.message).toContain(`${from} → ${to}`);
      }
    });
  }
});

describe('state: 终态', () => {
  it('终态正确', () => {
    expect(isTerminal('不采纳')).toBe(true);
    expect(isTerminal('无需确认')).toBe(true);
    expect(isTerminal('零命中')).toBe(true);
    expect(isTerminal('命中歧义')).toBe(true);
    expect(isTerminal('已推送')).toBe(true);
    expect(isTerminal('采纳')).toBe(false);
    expect(isTerminal('待确认')).toBe(false);
  });
});
