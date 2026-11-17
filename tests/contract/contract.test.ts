import { describe, expect, it } from 'vitest';

import {
  CONFIRM_VALUES,
  ContractError,
  ROW_STATUSES,
  errorResponse,
  okResponse,
  parseAlignRequest,
  parseCommandResponse,
} from '../../src/contract/index.js';

describe('三入口共用契约', () => {
  it('align 请求接受宏导出的表头与数据行', () => {
    const request = parseAlignRequest({
      header: ['登记号', '分期', '随访电话'],
      rows: [
        ['REG-0001', 'ⅢB', '138****0001'],
        ['REG-0002', 'IIIB', ''],
      ],
      source: 'excel-macro',
    });

    expect(request.source).toBe('excel-macro');
    expect(request.rows).toHaveLength(2);
    expect(request.confirmColumn).toBe('确认');
    expect(request.dryRun).toBe(false);
  });

  it('align 请求缺表头时报错并指出字段路径', () => {
    try {
      parseAlignRequest({ rows: [] });
      expect.unreachable('应当抛出 ContractError');
    } catch (error) {
      expect(error).toBeInstanceOf(ContractError);
      expect((error as ContractError).message).toContain('header');
    }
  });

  it('未知确认列取值不在白名单内', () => {
    expect(CONFIRM_VALUES).toEqual(['待确认', '采纳', '不采纳', '无需确认']);
    expect(ROW_STATUSES).toContain('院内已变更，需重查');
    expect(ROW_STATUSES).toContain('命中歧义');
  });

  it('统一响应包络：成功与失败都能解析', () => {
    const ok = parseCommandResponse(okResponse('doctor', { loadable: true }, null));
    expect(ok.ok).toBe(true);

    const failed = parseCommandResponse(
      errorResponse('align', {
        code: 'missing_env',
        message: '缺少环境变量：CDR_BASE_URL',
        hint: '请在 .env 中配置 CDR_BASE_URL 后重试',
      }),
    );
    expect(failed.ok).toBe(false);
    if (failed.ok === false) {
      expect(failed.error.hint).toContain('CDR_BASE_URL');
    }
  });
});
