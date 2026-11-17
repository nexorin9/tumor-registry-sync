import { describe, expect, it } from 'vitest';

import { assertBound, bindPatientHits } from '../../src/fhir/binding.js';

const context = {
  rowNumber: 7,
  registryId: 'REG-0001',
  identifierSystem: 'urn:oid:2.16.156.10011.0.1',
};

describe('实体绑定判定', () => {
  it('命中 1 条 → 绑定成功', () => {
    const decision = bindPatientHits(
      [{ resourceType: 'Patient', id: 'pat-1', identifier: [{ value: 'REG-0001' }] }],
      context,
    );

    expect(decision.outcome).toBe('命中');
    expect(decision.hitCount).toBe(1);
    expect(decision.patient?.id).toBe('pat-1');
    expect(decision.issue).toBeNull();
  });

  it('命中 0 条 → 零命中，且不产出差异值', () => {
    const decision = bindPatientHits([], context);

    expect(decision.outcome).toBe('零命中');
    expect(decision.patient).toBeNull();
    expect(decision.issue?.code).toBe('NO_MATCH');
    expect(decision.issue?.reason).toContain('REG-0001');
    expect(decision.issue?.hint).toContain('不产出差异值');
  });

  it('命中 >1 条 → 歧义，绝不取第一条', () => {
    const decision = bindPatientHits(
      [
        { resourceType: 'Patient', id: 'pat-1' },
        { resourceType: 'Patient', id: 'pat-2' },
      ],
      context,
    );

    expect(decision.outcome).toBe('歧义');
    expect(decision.hitCount).toBe(2);
    expect(decision.patient).toBeNull();
    expect(decision.issue?.code).toBe('AMBIGUOUS_MATCH');
    expect(decision.issue?.reason).toContain('2 条');
  });

  it('命中 1 条但缺 id → 未完成（与零命中分开）', () => {
    const decision = bindPatientHits([{ resourceType: 'Patient' }], context);

    expect(decision.outcome).toBe('未完成');
    expect(decision.patient).toBeNull();
    expect(decision.issue?.code).toBe('MISSING_FIELD');
  });

  it('未命中时断言直接报错，不悄悄拿某一条继续', () => {
    const decision = bindPatientHits([{ resourceType: 'Patient', id: 'pat-1' }, { resourceType: 'Patient', id: 'pat-2' }], context);

    expect(() => assertBound(decision, context)).toThrow(/绑定未命中/);
  });
});
