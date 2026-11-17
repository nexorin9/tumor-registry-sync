import { describe, expect, it } from 'vitest';

import {
  buildDerivedRow,
  comparableDerivedFields,
  DEFAULT_DERIVED_CALIBERS,
  normalizeHospitalDate,
  type DerivedCaliberDeclaration,
} from '../../src/fhir/derived-view.js';
import type { EncounterView } from '../../src/fhir/parse.js';

/** 造一条就诊记录（只写本层用得到的字段）。 */
function encounter(init: Partial<EncounterView> & { id: string }): EncounterView {
  return {
    id: init.id,
    periodStart: init.periodStart ?? null,
    periodEnd: init.periodEnd ?? null,
    class: init.class ?? null,
    type: init.type ?? null,
    status: init.status ?? 'finished',
  };
}

describe('日期归一：四种写法折算到同一基准', () => {
  it('ISO 日期 → 院内本地日期，按本地零点计时', () => {
    const normalized = normalizeHospitalDate('2024-03-05');

    expect(normalized?.date).toBe('2024-03-05');
    expect(normalized?.format).toBe('iso-date');
    expect(normalized?.hasTime).toBe(false);
    expect(normalized?.instant).toBe('2024-03-05T00:00:00+08:00');
  });

  it('带时区偏移的 ISO 时刻 → 折算到院内本地时刻', () => {
    const normalized = normalizeHospitalDate('2024-03-05T08:00:00+08:00');

    expect(normalized?.date).toBe('2024-03-05');
    expect(normalized?.format).toBe('iso-datetime');
    expect(normalized?.hasTime).toBe(true);
    expect(normalized?.instant).toBe('2024-03-05T08:00:00+08:00');
  });

  it('纯数字 8 位 → 同一个日期', () => {
    const normalized = normalizeHospitalDate('20240305');

    expect(normalized?.date).toBe('2024-03-05');
    expect(normalized?.format).toBe('compact-8');
  });

  it('斜杠分隔 → 同一个日期', () => {
    const normalized = normalizeHospitalDate('2024/03/05');

    expect(normalized?.date).toBe('2024-03-05');
    expect(normalized?.format).toBe('slash');
  });

  it('中文年月日 → 同一个日期（登记表里常见的写法）', () => {
    const normalized = normalizeHospitalDate('2024年3月5日');

    expect(normalized?.date).toBe('2024-03-05');
    expect(normalized?.format).toBe('chinese');
  });

  it('四种写法折算到同一基准后是同一天、同一时刻', () => {
    const forms = ['2024-03-05', '20240305', '2024/03/05', '2024-03-05T00:00:00+08:00'];
    const normalized = forms.map((form) => normalizeHospitalDate(form));

    for (const item of normalized) {
      expect(item?.date).toBe('2024-03-05');
      expect(item?.epochMs).toBe(normalized[0]?.epochMs);
    }
  });

  it('归一失败一律返回 null（不猜日期）', () => {
    expect(normalizeHospitalDate(null)).toBeNull();
    expect(normalizeHospitalDate('')).toBeNull();
    expect(normalizeHospitalDate('   ')).toBeNull();
    expect(normalizeHospitalDate('不是日期')).toBeNull();
    expect(normalizeHospitalDate('2024-13-01')).toBeNull();
    expect(normalizeHospitalDate('20240230')).toBeNull();
    expect(normalizeHospitalDate('2024-03-05T25:00:00+08:00')).toBeNull();
  });
});

describe('时区偏移跨日边界', () => {
  it('同一绝对时刻的两种写法落在同一个院内本地日期', () => {
    const utc = normalizeHospitalDate('2024-03-04T20:00:00Z');
    const local = normalizeHospitalDate('2024-03-05T04:00:00+08:00');

    expect(utc?.epochMs).toBe(local?.epochMs);
    expect(utc?.date).toBe('2024-03-05');
    expect(local?.date).toBe('2024-03-05');
  });

  it('西半球的晚上写法折算到院内已是次日', () => {
    const normalized = normalizeHospitalDate('2024-03-04T20:00:00-04:00');

    expect(normalized?.date).toBe('2024-03-05');
    expect(normalized?.instant).toBe('2024-03-05T08:00:00+08:00');
  });

  it('没有偏移的写法按院内本地时间理解', () => {
    const normalized = normalizeHospitalDate('2024-03-05T08:00:00');

    expect(normalized?.date).toBe('2024-03-05');
    expect(normalized?.instant).toBe('2024-03-05T08:00:00+08:00');
  });

  it('院内时区可配置（换偏移后日期随之改变）', () => {
    const normalized = normalizeHospitalDate('2024-03-04T20:00:00Z', {
      hospitalUtcOffsetMinutes: 0,
    });

    expect(normalized?.date).toBe('2024-03-04');
    expect(normalized?.instant).toBe('2024-03-04T20:00:00+00:00');
  });
});

describe('派生字段口径：多 Encounter 取最早 / 取最近', () => {
  it('首次入院日取最早一次就诊开始，本次就诊开始取最近一次', () => {
    const view = buildDerivedRow({
      rowNumber: 2,
      registryId: 'REG-0001',
      encounters: [
        encounter({ id: 'enc-3', periodStart: '2024-05-06T08:00:00+08:00' }),
        encounter({ id: 'enc-1', periodStart: '2024-01-08T08:00:00+08:00' }),
        encounter({ id: 'enc-2', periodStart: '2024-03-05T08:00:00+08:00' }),
      ],
    });

    expect(view.derived['首次入院日'].status).toBe('已取到');
    expect(view.derived['首次入院日'].date).toBe('2024-01-08');
    expect(view.derived['首次入院日'].sourceEncounterIds).toEqual(['enc-1']);
    expect(view.derived['本次就诊开始'].status).toBe('已取到');
    expect(view.derived['本次就诊开始'].date).toBe('2024-05-06');
    expect(view.derived['本次就诊开始'].sourceEncounterIds).toEqual(['enc-3']);
  });

  it('口径声明说了算：声明成「取最近」就取最近', () => {
    const calibers: DerivedCaliberDeclaration = {
      首次入院日: { rule: 'latest-encounter-start' },
    };

    const view = buildDerivedRow({
      rowNumber: 2,
      registryId: 'REG-0001',
      encounters: [
        encounter({ id: 'enc-1', periodStart: '2024-01-08T08:00:00+08:00' }),
        encounter({ id: 'enc-2', periodStart: '2024-03-05T08:00:00+08:00' }),
      ],
      calibers,
    });

    expect(view.derived['首次入院日'].date).toBe('2024-03-05');
    // 口径没声明的字段：不参与比对
    expect(view.derived['本次就诊开始'].status).toBe('口径未声明');
    expect(view.derived['本次就诊开始'].participatesInDiff).toBe(false);
    expect(view.unavailableFields).toContain('本次就诊开始');
  });

  it('默认口径就是「最早 + 最近」这两条', () => {
    expect(DEFAULT_DERIVED_CALIBERS['首次入院日']?.rule).toBe('earliest-encounter-start');
    expect(DEFAULT_DERIVED_CALIBERS['本次就诊开始']?.rule).toBe('latest-encounter-start');
  });

  it('口径可按就诊分类收窄（只按住院口径取）', () => {
    const calibers: DerivedCaliberDeclaration = {
      首次入院日: {
        rule: 'earliest-encounter-start',
        encounterFilter: { classCode: 'inpatient' },
      },
    };

    const view = buildDerivedRow({
      rowNumber: 2,
      registryId: 'REG-0001',
      encounters: [
        encounter({ id: 'enc-1', periodStart: '2024-01-08T08:00:00+08:00', class: 'outpatient' }),
        encounter({ id: 'enc-2', periodStart: '2024-03-05T08:00:00+08:00', class: 'inpatient' }),
      ],
      calibers,
    });

    expect(view.derived['首次入院日'].date).toBe('2024-03-05');
    expect(view.derived['首次入院日'].sourceEncounterIds).toEqual(['enc-2']);
  });

  it('同一时刻有多条就诊时按 id 稳定取同一条', () => {
    const encounters = [
      encounter({ id: 'enc-b', periodStart: '2024-03-05T08:00:00+08:00' }),
      encounter({ id: 'enc-a', periodStart: '2024-03-05T08:00:00+08:00' }),
    ];

    const first = buildDerivedRow({ rowNumber: 2, registryId: 'REG-0001', encounters });
    const second = buildDerivedRow({ rowNumber: 2, registryId: 'REG-0001', encounters });

    expect(first.derived['首次入院日'].sourceEncounterIds).toEqual(['enc-a']);
    expect(second.derived['首次入院日'].sourceEncounterIds).toEqual(first.derived['首次入院日'].sourceEncounterIds);
  });
});

describe('派生字段降级：口径未声明 / 日期不可解析', () => {
  it('口径表没声明该字段 → 口径未声明，不参与比对', () => {
    const view = buildDerivedRow({
      rowNumber: 2,
      registryId: 'REG-0001',
      encounters: [encounter({ id: 'enc-1', periodStart: '2024-03-05T08:00:00+08:00' })],
      calibers: {},
    });

    expect(view.derived['首次入院日'].status).toBe('口径未声明');
    expect(view.derived['首次入院日'].date).toBeNull();
    expect(view.derived['首次入院日'].participatesInDiff).toBe(false);
    expect(view.derived['首次入院日'].reason).toContain('口径表未声明');
    expect(view.unavailableFields).toEqual(['首次入院日', '本次就诊开始']);
  });

  it('院内没有就诊记录 → 口径未声明（不按空值参与比对）', () => {
    const view = buildDerivedRow({ rowNumber: 2, registryId: 'REG-0001', encounters: [] });

    expect(view.derived['首次入院日'].status).toBe('口径未声明');
    expect(view.derived['首次入院日'].date).toBeNull();
    expect(view.derived['首次入院日'].reason).toContain('院内没有就诊记录');
  });

  it('筛选后没有可用就诊 → 口径未声明并说明筛选条件', () => {
    const view = buildDerivedRow({
      rowNumber: 2,
      registryId: 'REG-0001',
      encounters: [encounter({ id: 'enc-1', periodStart: '2024-03-05T08:00:00+08:00', class: 'outpatient' })],
      calibers: {
        首次入院日: { rule: 'earliest-encounter-start', encounterFilter: { classCode: 'inpatient' } },
      },
    });

    expect(view.derived['首次入院日'].status).toBe('口径未声明');
    expect(view.derived['首次入院日'].reason).toContain('inpatient');
  });

  it('period 缺失 → 口径未声明，不按空值参与比对', () => {
    const view = buildDerivedRow({
      rowNumber: 2,
      registryId: 'REG-0001',
      encounters: [encounter({ id: 'enc-1', periodStart: null, periodEnd: '2024-03-12T08:00:00+08:00' })],
    });

    expect(view.derived['首次入院日'].status).toBe('口径未声明');
    expect(view.derived['首次入院日'].date).toBeNull();
    expect(view.derived['首次入院日'].participatesInDiff).toBe(false);
    expect(view.derived['首次入院日'].reason).toContain('缺 period.start');
    expect(view.unavailableFields).toContain('首次入院日');
  });

  it('部分就诊缺 period.start → 同样降级（不猜最早是哪一次）', () => {
    const view = buildDerivedRow({
      rowNumber: 2,
      registryId: 'REG-0001',
      encounters: [
        encounter({ id: 'enc-1', periodStart: '2024-01-08T08:00:00+08:00' }),
        encounter({ id: 'enc-2', periodStart: null }),
      ],
    });

    expect(view.derived['首次入院日'].status).toBe('口径未声明');
    expect(view.derived['首次入院日'].reason).toContain('1/2');
  });

  it('日期写法认不出 → 日期不可解析，并给行级错误码', () => {
    const view = buildDerivedRow({
      rowNumber: 2,
      registryId: 'REG-0001',
      encounters: [encounter({ id: 'enc-1', periodStart: '去年秋天' })],
    });

    expect(view.derived['首次入院日'].status).toBe('日期不可解析');
    expect(view.derived['首次入院日'].date).toBeNull();
    expect(view.derived['首次入院日'].participatesInDiff).toBe(false);
    expect(view.derived['首次入院日'].reason).toContain('日期不可解析');
    expect(view.issues).toHaveLength(1);
    expect(view.issues[0]?.code).toBe('DATE_UNPARSEABLE');
    expect(view.issues[0]?.rowNumber).toBe(2);
    expect(view.issues[0]?.registryId).toBe('REG-0001');
    expect(view.issues[0]?.blocking).toBe(false);
    expect(view.unavailableFields).toContain('首次入院日');
  });

  it('上游行级问题与不参与比对字段一并带过来', () => {
    const view = buildDerivedRow({
      rowNumber: 3,
      registryId: 'REG-0002',
      encounters: [],
      issues: [
        {
          rowNumber: 3,
          registryId: 'REG-0002',
          code: 'MISSING_FIELD',
          reason: '院内就诊资源缺 period.start',
          hint: '该字段本轮不参与比对',
          blocking: false,
        },
      ],
      unavailableFields: ['Encounter.period.start'],
    });

    expect(view.issues).toHaveLength(1);
    expect(view.issues[0]?.code).toBe('MISSING_FIELD');
    expect(view.unavailableFields).toContain('Encounter.period.start');
  });
});

describe('参与比对的派生字段', () => {
  it('只返回「已取到」的字段', () => {
    const view = buildDerivedRow({
      rowNumber: 2,
      registryId: 'REG-0001',
      encounters: [encounter({ id: 'enc-1', periodStart: '2024-01-08T08:00:00+08:00' })],
      calibers: { 首次入院日: { rule: 'earliest-encounter-start' } },
    });

    const comparable = comparableDerivedFields(view);

    expect(comparable.map((item) => item.field)).toEqual(['首次入院日']);
    expect(comparable[0]?.result.date).toBe('2024-01-08');
  });

  it('一条就诊的日期认不出 → 两个派生字段都不参与比对（不猜哪次最早/最近）', () => {
    const view = buildDerivedRow({
      rowNumber: 2,
      registryId: 'REG-0001',
      encounters: [
        encounter({ id: 'enc-1', periodStart: '2024-01-08T08:00:00+08:00' }),
        encounter({ id: 'enc-2', periodStart: '去年秋天' }),
      ],
    });

    expect(view.derived['首次入院日'].status).toBe('日期不可解析');
    expect(view.derived['本次就诊开始'].status).toBe('日期不可解析');
    expect(comparableDerivedFields(view)).toHaveLength(0);
    // 同一行只记一条日期问题
    expect(view.issues.filter((issue) => issue.code === 'DATE_UNPARSEABLE')).toHaveLength(1);
  });
});
