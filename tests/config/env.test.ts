import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MODEL_TIMEOUT_MS,
  ENV_NAMES,
  InvalidEnvError,
  MissingEnvError,
  inspectEnv,
  loadEnv,
} from '../../src/config/env.js';

const FULL_ENV: Record<string, string> = {
  [ENV_NAMES.cdrBaseUrl]: 'https://cdr.example.internal/',
  [ENV_NAMES.cdrApiToken]: 'cdr-token',
  [ENV_NAMES.cdrIdentifierSystem]: 'urn:oid:2.16.156.10011.0.1',
  [ENV_NAMES.registryBaseUrl]: 'https://registry.example.internal/',
  [ENV_NAMES.registryApiToken]: 'registry-token',
};

describe('loadEnv', () => {
  it('读齐九项环境变量并去掉基地址结尾斜杠', () => {
    const env = loadEnv({
      ...FULL_ENV,
      [ENV_NAMES.modelBaseUrl]: 'https://model.example.internal/v1/',
      [ENV_NAMES.modelApiKey]: 'model-key',
      [ENV_NAMES.modelName]: 'merge-model',
      [ENV_NAMES.modelTimeoutMs]: '5000',
    });

    expect(env.cdr.baseUrl).toBe('https://cdr.example.internal');
    expect(env.cdr.identifierSystem).toBe('urn:oid:2.16.156.10011.0.1');
    expect(env.registry.baseUrl).toBe('https://registry.example.internal');
    expect(env.registry.payloadForm).toBe('field-level');
    expect(env.model).not.toBeNull();
    expect(env.model?.timeoutMs).toBe(5000);
  });

  it('缺必填项时点名具体变量名', () => {
    expect(() => loadEnv({ ...FULL_ENV, [ENV_NAMES.cdrBaseUrl]: undefined })).toThrowError(
      MissingEnvError,
    );

    try {
      loadEnv({ ...FULL_ENV, [ENV_NAMES.cdrBaseUrl]: undefined });
      expect.unreachable('应当抛出 MissingEnvError');
    } catch (error) {
      expect(error).toBeInstanceOf(MissingEnvError);
      expect((error as MissingEnvError).missing).toEqual(['CDR_BASE_URL']);
      expect((error as MissingEnvError).message).toContain('CDR_BASE_URL');
    }
  });

  it('模型三项只配一部分时点名缺哪一项', () => {
    try {
      loadEnv({ ...FULL_ENV, [ENV_NAMES.modelBaseUrl]: 'https://model.example.internal' });
      expect.unreachable('应当抛出 MissingEnvError');
    } catch (error) {
      expect((error as MissingEnvError).missing).toEqual(['MODEL_API_KEY', 'MODEL_NAME']);
    }
  });

  it('未配置模型时 model 为 null，模型超时取默认值', () => {
    const env = loadEnv({ ...FULL_ENV });
    expect(env.model).toBeNull();
    expect(DEFAULT_MODEL_TIMEOUT_MS).toBe(20000);
  });

  it('推送体形态取值非法时点名配置项与允许值', () => {
    try {
      loadEnv({ ...FULL_ENV, REGISTRY_PAYLOAD_FORM: 'patch-only' });
      expect.unreachable('应当抛出 InvalidEnvError');
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidEnvError);
      expect((error as InvalidEnvError).variable).toBe('REGISTRY_PAYLOAD_FORM');
      expect((error as InvalidEnvError).message).toContain('field-level');
      expect((error as InvalidEnvError).message).toContain('whole-entry');
    }
  });
});

describe('inspectEnv', () => {
  it('逐项报出缺失变量而不抛错', () => {
    const report = inspectEnv({ [ENV_NAMES.cdrBaseUrl]: 'https://cdr.example.internal' });
    expect(report.missing).toEqual([
      ENV_NAMES.cdrApiToken,
      ENV_NAMES.cdrIdentifierSystem,
      ENV_NAMES.registryBaseUrl,
      ENV_NAMES.registryApiToken,
    ]);
    expect(report.modelConfigured).toBe(false);
  });

  it('配置齐备时无缺失无非法', () => {
    const report = inspectEnv({ ...FULL_ENV });
    expect(report.missing).toEqual([]);
    expect(report.invalid).toEqual([]);
    expect(report.modelConfigured).toBe(false);
  });
});
