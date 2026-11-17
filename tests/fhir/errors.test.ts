import { describe, expect, it } from 'vitest';

import {
  BACKOFF_POLICY,
  ERROR_RULES,
  FHIR_ERROR_CODES,
  FhirRequestError,
  backoffDelayMs,
  classifyFailureKind,
  classifyHttpStatus,
  describeError,
  isFatalFhirError,
  isFhirErrorCode,
  isIncompleteFhirError,
  isRetryableCode,
  isZeroHitError,
  retryAdvice,
} from '../../src/fhir/errors.js';

describe('检索错误分类：固定错误码表', () => {
  it('八类固定错误码齐全，且每类都有唯一规则', () => {
    expect([...FHIR_ERROR_CODES].sort()).toEqual(
      [
        'auth_failed',
        'bad_payload',
        'forbidden',
        'missing_field',
        'not_found',
        'rate_limited',
        'server_error',
        'timeout',
      ].sort(),
    );
    for (const code of FHIR_ERROR_CODES) {
      const rule = ERROR_RULES[code];
      expect(rule).toBeDefined();
      expect(rule.code).toBe(code);
      expect(rule.userHint.length).toBeGreaterThan(0);
      expect(typeof rule.retryable).toBe('boolean');
    }
  });

  it('401/403 是终止级错误，处置提示点名 CDR_API_TOKEN 与 CDR_BASE_URL', () => {
    const unauthorized = classifyHttpStatus(401);
    expect(unauthorized.code).toBe('auth_failed');
    expect(unauthorized.retryable).toBe(false);
    expect(unauthorized.userHint).toContain('CDR_API_TOKEN');

    const forbidden = classifyHttpStatus(403);
    expect(forbidden.code).toBe('forbidden');
    expect(forbidden.retryable).toBe(false);
    expect(forbidden.userHint).toContain('CDR_API_TOKEN');
    expect(forbidden.userHint).toContain('CDR_BASE_URL');
  });

  it('404 映射 not_found，并明说按零命中处理', () => {
    const notFound = classifyHttpStatus(404);
    expect(notFound.code).toBe('not_found');
    expect(notFound.retryable).toBe(false);
    expect(notFound.userHint).toContain('零命中');
    expect(
      isZeroHitError(
        new FhirRequestError({
          code: 'not_found',
          message: '404',
          retryable: false,
          userHint: notFound.userHint,
        }),
      ),
    ).toBe(true);
  });

  it('超时 / 5xx / 429 标为可重试并给退避建议', () => {
    const timeout = classifyFailureKind('timeout');
    expect(timeout.code).toBe('timeout');
    expect(timeout.retryable).toBe(true);
    expect(timeout.userHint).toContain('退避');

    const serverError = classifyHttpStatus(503);
    expect(serverError.code).toBe('server_error');
    expect(serverError.retryable).toBe(true);
    expect(serverError.userHint).toContain('退避');

    const limited = classifyHttpStatus(429);
    expect(limited.code).toBe('rate_limited');
    expect(limited.retryable).toBe(true);
    expect(limited.userHint).toContain('退避');
  });

  it('其余 4xx 与坏响应、缺关键字段都不可重试（重跑也是一样的结果）', () => {
    const badRequest = classifyHttpStatus(400);
    expect(badRequest.code).toBe('invalid_request');
    expect(badRequest.retryable).toBe(false);

    const badPayload = classifyFailureKind('bad_payload');
    expect(badPayload.code).toBe('bad_payload');
    expect(badPayload.retryable).toBe(false);

    const missingField = classifyFailureKind('missing_field');
    expect(missingField.code).toBe('missing_field');
    expect(missingField.retryable).toBe(false);
    expect(missingField.userHint).toContain('关键字段');
  });

  it('退避建议按「最小延迟 × 倍数 × 次数」增长并封顶', () => {
    expect(backoffDelayMs(1)).toBe(BACKOFF_POLICY.minDelayMs);
    expect(backoffDelayMs(2)).toBe(BACKOFF_POLICY.minDelayMs * BACKOFF_POLICY.growFactor);
    expect(backoffDelayMs(3)).toBe(
      BACKOFF_POLICY.minDelayMs * BACKOFF_POLICY.growFactor ** 2,
    );
    // 封顶：再多次也不会超过上限
    expect(backoffDelayMs(50)).toBe(BACKOFF_POLICY.maxDelayMs);
    // 非法次数退回最小延迟，不抛错也不猜
    expect(backoffDelayMs(0)).toBe(BACKOFF_POLICY.minDelayMs);
    expect(retryAdvice(1)).toContain(`${BACKOFF_POLICY.maxAttempts} 次`);
  });

  it('终止级 / 未完成 / 零命中三类互不混淆', () => {
    const fatal = new FhirRequestError({
      code: 'auth_failed',
      message: '401',
      retryable: false,
      userHint: 'x',
    });
    const incomplete = new FhirRequestError({
      code: 'timeout',
      message: 'timeout',
      retryable: true,
      userHint: 'x',
    });
    const zeroHit = new FhirRequestError({
      code: 'not_found',
      message: '404',
      retryable: false,
      userHint: 'x',
    });

    expect(isFatalFhirError(fatal)).toBe(true);
    expect(isFatalFhirError(incomplete)).toBe(false);
    expect(isIncompleteFhirError(incomplete)).toBe(true);
    // 零命中不是「未完成」，也不是终止级
    expect(isIncompleteFhirError(zeroHit)).toBe(false);
    expect(isFatalFhirError(zeroHit)).toBe(false);
    expect(isZeroHitError(zeroHit)).toBe(true);
  });

  it('错误码可重试标记与规则表一致（表外错误码按不可重试算）', () => {
    expect(isRetryableCode('timeout')).toBe(true);
    expect(isRetryableCode('server_error')).toBe(true);
    expect(isRetryableCode('rate_limited')).toBe(true);
    expect(isRetryableCode('auth_failed')).toBe(false);
    expect(isRetryableCode('not_found')).toBe(false);
    expect(isRetryableCode('missing_field')).toBe(false);
    expect(isRetryableCode('some_future_code')).toBe(false);
    expect(isFhirErrorCode('timeout')).toBe(true);
    expect(isFhirErrorCode('some_future_code')).toBe(false);
  });

  it('任意异常都能压成可观测的形状（不静默吞掉原因）', () => {
    const described = describeError(
      new FhirRequestError({
        code: 'server_error',
        message: '500',
        retryable: true,
        userHint: '可重试',
        httpStatus: 500,
      }),
    );
    expect(described).toMatchObject({
      code: 'server_error',
      retryable: true,
      httpStatus: 500,
      message: '500',
    });

    const unknown = describeError(new Error('socket hang up'));
    expect(unknown.code).toBe('unknown');
    expect(unknown.retryable).toBe(true);
    expect(unknown.message).toBe('socket hang up');
    expect(unknown.userHint.length).toBeGreaterThan(0);
  });
});
