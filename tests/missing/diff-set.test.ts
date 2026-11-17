import { describe, expect, it } from 'vitest';

import type { CdrEnv } from '../../src/config/env.js';
import type { MissingRow } from '../../src/contract/index.js';
import type { ConditionSearchClient, MissingCheckConfig } from '../../src/missing/diff-set.js';
import { findMissingRows, normalizeRegistryId } from '../../src/missing/diff-set.js';

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

/** 假检索客户端：按给定的患者登记号列表（允许重复）返回命中。 */
function fakeClient(hits: string[]): ConditionSearchClient {
  const raw = hits.map((id) => ({
    resourceType: 'Condition',
    id: `cond-${id}`,
    subject: { reference: `Patient/${id}` },
  }));
  const registryIds = [...new Set(hits)];
  return {
    searchConditionsByCode: async () => ({ registryIds, raw }),
  };
}

describe('缺行检查 · 正向 diff', () => {
  it('院内命中 A,B,C，本表只有 A → 缺行 B、C', async () => {
    const result = await findMissingRows(
      { cdr: CDR, registryIds: ['A'], config: ENABLED },
      fakeClient(['A', 'B', 'C']),
    );

    expect(result.incomplete).toBe(false);
    expect(result.reason).toBeNull();
    expect(result.searchedCount).toBe(3);
    expect(result.rows).toHaveLength(2);

    const ids = result.rows.map((r: MissingRow) => r.registryId).sort();
    expect(ids).toEqual(['B', 'C']);
    for (const row of result.rows) {
      expect(row.source).toBe('院内检索命中，本表无此登记号');
      expect(row.status).toBe('待确认');
      expect(row.confirmValue).toBe('待确认');
    }
  });

  it('院内零命中（检索成功、返回空集）→ 合法零结果，incomplete:false', async () => {
    const result = await findMissingRows(
      { cdr: CDR, registryIds: ['A', 'B'], config: ENABLED },
      fakeClient([]),
    );

    expect(result.rows).toHaveLength(0);
    expect(result.incomplete).toBe(false);
    expect(result.reason).toBeNull();
    expect(result.searchedCount).toBe(0);
  });

  it('院内同患者多条件命中（multi-hit）且本表缺该号 → 标记「命中歧义」，不取第一条', async () => {
    // 表里有 A；院内对 C 命中两条 Condition（multi-hit），C 不在表中。
    const result = await findMissingRows(
      { cdr: CDR, registryIds: ['A'], config: ENABLED },
      fakeClient(['A', 'C', 'C']),
    );

    expect(result.incomplete).toBe(false);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.registryId).toBe('C');
    expect(result.rows[0]?.status).toBe('命中歧义');
    expect(result.rows[0]?.confirmValue).toBe('待确认');
  });

  it('表内登记号重复不影响比对（集合去重）', async () => {
    const result = await findMissingRows(
      { cdr: CDR, registryIds: ['A', 'A', 'B'], config: ENABLED },
      fakeClient(['A', 'B', 'C']),
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.registryId).toBe('C');
    expect(result.rows[0]?.status).toBe('待确认');
  });
});

describe('normalizeRegistryId', () => {
  it('去空格且大小写不敏感', () => {
    expect(normalizeRegistryId('  Reg-001 ')).toBe('reg-001');
    expect(normalizeRegistryId('REG-001')).toBe(normalizeRegistryId('reg-001'));
  });
});
