import { describe, expect, it } from 'vitest';

import { makeBatchKey, normalizeSearchParams, tableFingerprint } from '../../src/audit/batch-key.js';

describe('tableFingerprint', () => {
  it('相同输入得到相同指纹（与时间无关）', () => {
    const header = ['登记号', '姓名', '分期'];
    const rows: unknown[][] = [
      ['REG-0001', '张三', 'II'],
      ['REG-0002', '李四', 'III'],
    ];
    const a = tableFingerprint(header, rows);
    const b = tableFingerprint(header, rows);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('任意一行内容变化都改变指纹', () => {
    const header = ['登记号', '姓名'];
    const base: unknown[][] = [
      ['REG-0001', '张三'],
      ['REG-0002', '李四'],
    ];
    const changed: unknown[][] = [
      ['REG-0001', '张三'],
      ['REG-0002', '王五'],
    ];
    expect(tableFingerprint(header, base)).not.toBe(tableFingerprint(header, changed));
  });

  it('行数放在最前，避免前缀碰撞（A 是 B 的前缀时不撞指纹）', () => {
    const header = ['登记号'];
    const a: unknown[][] = [['REG-0001']];
    const b: unknown[][] = [['REG-0001'], ['REG-0002']];
    expect(tableFingerprint(header, a)).not.toBe(tableFingerprint(header, b));
  });

  it('对象型单元格也稳定（key 顺序不同仍同指纹）', () => {
    const header = ['登记号', '扩展'];
    const x: unknown[][] = [['REG-0001', { b: 2, a: 1 }]];
    const y: unknown[][] = [['REG-0001', { a: 1, b: 2 }]];
    expect(tableFingerprint(header, x)).toBe(tableFingerprint(header, y));
  });
});

describe('makeBatchKey', () => {
  it('相同指纹+参数+时间得到相同批次键', () => {
    const fp = 'abc123';
    const sp = 'REG-0001:[Patient{...}]';
    const t = '2026-11-08T00:00:00.000Z';
    expect(makeBatchKey(fp, sp, t)).toBe(makeBatchKey(fp, sp, t));
    expect(makeBatchKey(fp, sp, t)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('时间或参数任一变化都得到不同批次键', () => {
    const fp = 'abc123';
    const sp = 'REG-0001:[Patient{...}]';
    const t1 = '2026-11-08T00:00:00.000Z';
    const t2 = '2026-11-08T00:00:01.000Z';
    expect(makeBatchKey(fp, sp, t1)).not.toBe(makeBatchKey(fp, sp, t2));
    expect(makeBatchKey(fp, sp, t1)).not.toBe(makeBatchKey(fp, '其它', t1));
  });
});

describe('normalizeSearchParams', () => {
  it('顺序不同得到同一串（按登记号、资源类型、参数 key 排序）', () => {
    const entriesA = [
      {
        registryId: 'REG-0002',
        steps: [
          { resourceType: 'Condition', params: { onset: '2020', code: 'C50' } },
          { resourceType: 'Patient', params: { identifier: 'REG-0002' } },
        ],
      },
      {
        registryId: 'REG-0001',
        steps: [{ resourceType: 'Patient', params: { identifier: 'REG-0001' } }],
      },
    ];
    const entriesB = [
      {
        registryId: 'REG-0001',
        steps: [{ resourceType: 'Patient', params: { identifier: 'REG-0001' } }],
      },
      {
        registryId: 'REG-0002',
        steps: [
          { resourceType: 'Patient', params: { identifier: 'REG-0002' } },
          { resourceType: 'Condition', params: { code: 'C50', onset: '2020' } },
        ],
      },
    ];
    expect(normalizeSearchParams(entriesA)).toBe(normalizeSearchParams(entriesB));
  });

  it('数组型参数值内部排序，顺序无关', () => {
    const a = [{ registryId: 'R1', steps: [{ resourceType: 'Patient', params: { tag: ['x', 'y'] } }] }];
    const b = [{ registryId: 'R1', steps: [{ resourceType: 'Patient', params: { tag: ['y', 'x'] } }] }];
    expect(normalizeSearchParams(a)).toBe(normalizeSearchParams(b));
  });
});
