import { describe, expect, it } from 'vitest';

import type { DiffOperation } from '../../src/diff/patch.js';
import { InvalidEnvError } from '../../src/config/env.js';
import { buildPushBody } from '../../src/push/payload-form.js';
import type { PushRowInput } from '../../src/push/payload-form.js';

function makeOp(partial: Partial<DiffOperation>): DiffOperation {
  return {
    op: 'replace',
    path: 'stage',
    field: 'stage',
    column: '分期',
    oldValue: 'IIIA',
    newValue: 'IIIB',
    rawOldValue: 'IIIA',
    rawNewValue: 'IIIB',
    changeKind: '值不同',
    typeChanged: false,
    fromKind: 'string',
    toKind: 'string',
    controlledCode: true,
    detail: null,
    ...partial,
  } as DiffOperation;
}

function makeRow(operations: DiffOperation[]): PushRowInput {
  return {
    registryId: 'R1',
    identifierSystem: 'urn:oid:2.16.156.10011.0.1',
    subjectReference: 'Patient/R1',
    operations,
    ifMatch: [{ path: 'stage', value: 'IIIA' }],
    extensions: { source: 'registry' },
  };
}

describe('buildPushBody · 两种 form', () => {
  const ops = [makeOp({ path: 'stage', rawOldValue: 'IIIA', rawNewValue: 'IIIB' })];

  it('field-level 只带变化字段 + ifMatch + extensions', () => {
    const body = buildPushBody(makeRow(ops), 'field-level');
    expect(body.resourceType).toBe('RegistryEntry');
    expect(body.changedFields).toEqual([
      { path: 'stage', oldValue: 'IIIA', newValue: 'IIIB' },
    ]);
    expect(body.ifMatch).toEqual([{ path: 'stage', value: 'IIIA' }]);
    expect(body.extensions).toEqual({ source: 'registry' });
  });

  it('whole-entry 同样只带变化字段 + ifMatch + extensions', () => {
    const body = buildPushBody(makeRow(ops), 'whole-entry');
    expect(body.changedFields).toEqual([
      { path: 'stage', oldValue: 'IIIA', newValue: 'IIIB' },
    ]);
    expect(body.ifMatch).toEqual([{ path: 'stage', value: 'IIIA' }]);
    expect(body.extensions).toEqual({ source: 'registry' });
  });

  it('两种 form 都绝不携带未变化字段', () => {
    // 仅一个变化字段，不应出现其它字段
    for (const form of ['field-level', 'whole-entry'] as const) {
      const body = buildPushBody(makeRow(ops), form);
      expect(body.changedFields).toHaveLength(1);
      expect(body.changedFields[0]!.path).toBe('stage');
    }
  });

  it('oldValue/newValue 取 raw* 原值', () => {
    const op = makeOp({
      path: 'birthDate',
      oldValue: '1980-01-01',
      newValue: '1980-01-02',
      rawOldValue: '1980/01/01',
      rawNewValue: '1980/01/02',
    });
    const body = buildPushBody(makeRow([op]), 'field-level');
    expect(body.changedFields[0]).toEqual({
      path: 'birthDate',
      oldValue: '1980/01/01',
      newValue: '1980/01/02',
    });
  });
});

describe('buildPushBody · 非法 form', () => {
  it('非法 form 抛 InvalidEnvError 并点名 REGISTRY_PAYLOAD_FORM 与允许值', () => {
    expect(() =>
      buildPushBody(makeRow([]), 'bogus-form' as 'field-level'),
    ).toThrowError(InvalidEnvError);
    try {
      buildPushBody(makeRow([]), 'bogus-form' as 'field-level');
      expect.unreachable('应当抛出');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidEnvError);
      const e = error as InvalidEnvError;
      expect(e.variable).toBe('REGISTRY_PAYLOAD_FORM');
      expect(e.message).toContain('field-level');
      expect(e.message).toContain('whole-entry');
    }
  });

  it('绝不静默回退到默认 form', () => {
    // 即便传入非法值，也不应返回任何合法体
    expect(() =>
      buildPushBody(makeRow([]), 'patch-only' as 'field-level'),
    ).toThrowError(InvalidEnvError);
  });
});
