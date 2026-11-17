import { describe, expect, it } from 'vitest';

import {
  completionFeedback,
  renderEmptyState,
  renderErrorState,
  renderLoadingState,
  repeatRunConfirmation,
} from '../../../src/sheet/present/index.js';

describe('三态渲染', () => {
  it('加载态：state=loading 且 receiptLine=对齐中…', () => {
    expect(renderLoadingState()).toEqual({ state: 'loading', receiptLine: '对齐中…' });
  });

  it('空表态：state=empty 且 message 为非空白表的明确结论', () => {
    expect(renderEmptyState()).toEqual({
      state: 'empty',
      message: '本表与院内记录一致，无需推送',
    });
  });

  it('错误态：state=error 且带回 hint', () => {
    const r = renderErrorState({ code: 'timeout', message: 'x', hint: '稍后' });
    expect(r.state).toBe('error');
    expect(r.hint).toBe('稍后');
  });
});

describe('错误分级', () => {
  it('auth_failed / forbidden（401/403）→ 点名环境变量', () => {
    expect(renderErrorState({ code: 'auth_failed', message: 'm', hint: null }).message).toBe(
      '缺少 CDR_API_TOKEN 或 CDR_BASE_URL',
    );
    expect(renderErrorState({ code: 'forbidden', message: 'm', hint: null }).message).toBe(
      '缺少 CDR_API_TOKEN 或 CDR_BASE_URL',
    );
  });

  it('timeout / server_error / rate_limited → 可重试', () => {
    for (const code of ['timeout', 'server_error', 'rate_limited'] as const) {
      expect(renderErrorState({ code, message: 'm', hint: null }).message).toBe('可重试，请稍后重跑');
    }
  });

  it('model_unavailable → 已降级', () => {
    expect(renderErrorState({ code: 'model_unavailable', message: 'm', hint: null }).message).toBe(
      '模型不可达，已降级',
    );
  });

  it('bad_payload / missing_field → 行级错误 + 原始 message', () => {
    expect(renderErrorState({ code: 'bad_payload', message: '字段缺失', hint: null }).message).toBe(
      '行级错误：字段缺失',
    );
    expect(
      renderErrorState({ code: 'missing_field', message: '登记号空', hint: null }).message,
    ).toBe('行级错误：登记号空');
  });
});

describe('重复运行确认', () => {
  it('已有结果 → 弹出覆盖确认 prompt', () => {
    expect(repeatRunConfirmation(true)).toEqual({
      prompt: '已有本批对齐结果，再次运行将覆盖，确认继续？',
    });
  });

  it('无已有结果 → 空 prompt（不弹框）', () => {
    expect(repeatRunConfirmation(false)).toEqual({ prompt: '' });
  });
});

describe('完成反馈', () => {
  it('格式包含三类计数与批次键', () => {
    const summary = {
      total: 10,
      matched: 8,
      ambiguous: 0,
      noMatch: 1,
      diffRows: 2,
      pendingConfirm: 3,
      adopted: 1,
      pushed: 4,
      failed: 1,
      pendingRetry: 0,
      missingRows: 0,
      issueRows: 0,
      missingCheckIncomplete: false,
    };
    expect(completionFeedback(summary, 'BK-001')).toBe(
      '已推送 4 行 / 待确认 3 行 / 失败 1 行（批次键 BK-001）',
    );
  });
});
