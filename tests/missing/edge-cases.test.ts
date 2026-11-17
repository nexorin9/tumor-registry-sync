import { describe, expect, it } from 'vitest';

import type { CdrEnv } from '../../src/config/env.js';
import type { ConditionSearchClient, MissingCheckConfig } from '../../src/missing/diff-set.js';
import {
  findMissingRows,
  isMissingCheckDeclared,
  loadMissingCheckConfig,
} from '../../src/missing/diff-set.js';

const CDR: CdrEnv = {
  baseUrl: 'https://cdr.example.com',
  apiToken: 'test-token',
  identifierSystem: 'urn:oid:2.16.156.10011.0.1',
};

const ENABLED: MissingCheckConfig = {
  enabled: true,
  conditionCode: 'http://loinc.org|tumor-registry-screening',
  dateWindow: null,
};

function fakeClient(hits: string[]): ConditionSearchClient {
  const raw = hits.map((id) => ({
    resourceType: 'Condition',
    subject: { reference: `Patient/${id}` },
  }));
  return { searchConditionsByCode: async () => ({ registryIds: [...new Set(hits)], raw }) };
}

describe('缺行检查 · 口径未声明', () => {
  it('config.enabled=false → 缺口径未声明、incomplete:true', async () => {
    const config: MissingCheckConfig = { ...ENABLED, enabled: false };
    const result = await findMissingRows(
      { cdr: CDR, registryIds: ['A'], config },
      fakeClient(['A', 'B']),
    );

    expect(result.incomplete).toBe(true);
    expect(result.reason).toBe('缺行检查口径未声明');
    expect(result.rows).toHaveLength(0);
    expect(result.searchedCount).toBe(0);
  });

  it('config.conditionCode 为空 → 缺口径未声明、incomplete:true', async () => {
    const config: MissingCheckConfig = { ...ENABLED, conditionCode: '' };
    const result = await findMissingRows(
      { cdr: CDR, registryIds: ['A'], config },
      fakeClient(['A', 'B']),
    );

    expect(result.incomplete).toBe(true);
    expect(result.reason).toBe('缺行检查口径未声明');
  });

  it('loadMissingCheckConfig：文件不存在 → 退化为未声明', () => {
    const config = loadMissingCheckConfig('/no/such/missing-check.json');
    expect(config.enabled).toBe(false);
    expect(isMissingCheckDeclared(null, config)).toBe(false);
  });
});

describe('缺行检查 · 时间窗非法', () => {
  it('from 晚于 to → reason 时间窗非法、incomplete:true', async () => {
    const result = await findMissingRows(
      {
        cdr: CDR,
        registryIds: ['A'],
        config: ENABLED,
        dateWindow: { from: '2024-12-31', to: '2024-01-01' },
      },
      fakeClient(['B']),
    );

    expect(result.incomplete).toBe(true);
    expect(result.reason).toBe('时间窗非法');
    expect(result.rows).toHaveLength(0);
    expect(result.searchedCount).toBe(0);
  });

  it('时间窗不可解析 → reason 时间窗非法、incomplete:true', async () => {
    const result = await findMissingRows(
      {
        cdr: CDR,
        registryIds: ['A'],
        config: ENABLED,
        dateWindow: { from: '不是日期', to: '2024-01-01' },
      },
      fakeClient(['B']),
    );

    expect(result.incomplete).toBe(true);
    expect(result.reason).toBe('时间窗非法');
  });
});

describe('缺行检查 · 检索失败 ≠ 零缺行', () => {
  it('检索抛错 → 本轮缺行检查未完成、incomplete:true，绝不谎报零缺行', async () => {
    const failingClient: ConditionSearchClient = {
      searchConditionsByCode: async () => {
        throw new Error('FHIR 5xx');
      },
    };
    const result = await findMissingRows(
      { cdr: CDR, registryIds: ['A'], config: ENABLED },
      failingClient,
    );

    expect(result.incomplete).toBe(true);
    expect(result.reason).toBe('本轮缺行检查未完成');
    expect(result.rows).toHaveLength(0);
    expect(result.searchedCount).toBe(0);
  });

  it('incomplete 与合法零命中严格区分：两者 reason / incomplete 取值相反', async () => {
    const failingClient: ConditionSearchClient = {
      searchConditionsByCode: async () => {
        throw new Error('timeout');
      },
    };
    const failed = await findMissingRows(
      { cdr: CDR, registryIds: ['A'], config: ENABLED },
      failingClient,
    );
    const zero = await findMissingRows(
      { cdr: CDR, registryIds: ['A'], config: ENABLED },
      fakeClient([]),
    );

    // 失败：未完成
    expect(failed.incomplete).toBe(true);
    expect(failed.reason).toBe('本轮缺行检查未完成');
    // 合法零命中：完成、无原因
    expect(zero.incomplete).toBe(false);
    expect(zero.reason).toBeNull();
    // 二者不可混淆：失败态不能当作「零缺行」
    expect(zero.incomplete).not.toBe(failed.incomplete);
    expect(zero.reason).not.toBe(failed.reason);
  });
});
