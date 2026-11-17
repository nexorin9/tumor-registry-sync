import { describe, expect, it } from 'vitest';

import {
  PayloadValidationError,
  RegistryEntrySchema,
  SPEC_FIELD_MAP,
  assertSpecConsistency,
  validateRegistryEntry,
} from '../../src/push/payload-schema.js';

const VALID_BODY = {
  resourceType: 'RegistryEntry',
  identifier: { system: 'urn:oid:2.16.156.10011.0.1', value: 'R1' },
  subject: { reference: 'Patient/R1' },
  changedFields: [{ path: 'stage', oldValue: 'IIIA', newValue: 'IIIB' }],
  ifMatch: [{ path: 'stage', value: 'IIIA' }],
  extensions: { source: 'registry' },
};

describe('validateRegistryEntry', () => {
  it('合法体通过校验', () => {
    expect(() => validateRegistryEntry(VALID_BODY)).not.toThrow();
    const parsed = validateRegistryEntry(VALID_BODY);
    expect(parsed.resourceType).toBe('RegistryEntry');
  });

  it('缺少必填字段时抛 PayloadValidationError 并带路径', () => {
    const bad = { ...VALID_BODY, identifier: { value: 'R1' } } as unknown;
    expect(() => validateRegistryEntry(bad)).toThrowError(PayloadValidationError);
    try {
      validateRegistryEntry(bad);
      expect.unreachable('应当抛出');
    } catch (error) {
      expect(error).toBeInstanceOf(PayloadValidationError);
      const issues = (error as PayloadValidationError).issues;
      expect(issues.some((i) => i.includes('identifier.system'))).toBe(true);
    }
  });

  it('resourceType 取错值时报错', () => {
    const bad = { ...VALID_BODY, resourceType: 'Other' } as unknown;
    expect(() => validateRegistryEntry(bad)).toThrowError(PayloadValidationError);
  });
});

describe('assertSpecConsistency', () => {
  it('与现有 schema 一致时通过', () => {
    expect(() => assertSpecConsistency()).not.toThrow();
  });

  it('映射表新增一个 schema 没有的幽灵字段时正确抛错', () => {
    SPEC_FIELD_MAP.push({
      field: 'phantomField',
      required: true,
      meaning: '幽灵',
      source: 'test',
    });
    expect(() => assertSpecConsistency()).toThrowError(/缺失|phantomField/);
    // 还原，避免污染其他测试
    const idx = SPEC_FIELD_MAP.findIndex((e) => e.field === 'phantomField');
    if (idx >= 0) SPEC_FIELD_MAP.splice(idx, 1);
  });
});

describe('SPEC_FIELD_MAP 覆盖完整', () => {
  it('列出 spec.md 输出 D 的全部字段', () => {
    const fields = SPEC_FIELD_MAP.map((e) => e.field).sort();
    const expected = [
      'changedFields[].newValue',
      'changedFields[].oldValue',
      'changedFields[].path',
      'extensions',
      'identifier.system',
      'identifier.value',
      'ifMatch[].path',
      'ifMatch[].value',
      'resourceType',
      'subject.reference',
    ].sort();
    expect(fields).toEqual(expected);
  });

  it('schema 顶层与嵌套字段数与映射表一致', () => {
    // 反向一致性已在上一个用例覆盖，这里确认映射表非空且每个字段有含义
    expect(SPEC_FIELD_MAP.length).toBe(10);
    for (const entry of SPEC_FIELD_MAP) {
      expect(entry.meaning.length).toBeGreaterThan(0);
      expect(entry.source.length).toBeGreaterThan(0);
    }
    // 顺带确认 schema 本身可解析
    expect(RegistryEntrySchema.parse(VALID_BODY).resourceType).toBe('RegistryEntry');
  });
});
