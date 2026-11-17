/**
 * 测试替身编排（仅测试层）。
 *
 * 负责：起停假 CDR / 假专病库，用 `node:net` 找出两个空闲端口，把替身地址与故障
 * 开关暴露给被测 CLI；同时提供 `envForHarness` 把替身地址/令牌塞进环境变量，
 * 让生产代码在完全离线的情况下跑到真实端点形态。
 *
 * 重要边界：替身只在 `tests/` 内。生产代码 `src/` 一律只认环境变量里的真实端点，
 * 绝不引用本文件（由 fakes.test.ts 的 grep 断言守住）。
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FakeCdr, type FakeCdrRecord, type FakeCdrFault } from './fake-cdr.js';
import { FakeRegistry, type FakeRegistryFault } from './fake-registry.js';

export interface Harness {
  cdr: FakeCdr;
  registry: FakeRegistry;
  /** 假 CDR 基地址（不含 /fhir/R4），即 `http://127.0.0.1:{port}` */
  cdrBaseUrl: string;
  /** 假专病库基地址（不含 /api/v1/registry-entries），即 `http://127.0.0.1:{port}` */
  registryBaseUrl: string;
  stop(): Promise<void>;
}

export interface StartHarnessOptions {
  cdrFault?: FakeCdrFault;
  registryFault?: FakeRegistryFault;
}

/** 找出一个当前空闲的 TCP 端口。 */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

/** 起两个替身，返回编排句柄（含基地址）。 */
export async function startHarness(
  records: FakeCdrRecord[],
  opts?: StartHarnessOptions,
): Promise<Harness> {
  const cdrPort = await getFreePort();
  const registryPort = await getFreePort();

  const cdr = new FakeCdr(records, { port: cdrPort, fault: opts?.cdrFault ?? 'none' });
  const registry = new FakeRegistry({ port: registryPort, fault: opts?.registryFault ?? 'none' });

  await cdr.start();
  await registry.start();

  const cdrBaseUrl = cdr.url;
  const registryBaseUrl = registry.url;

  return {
    cdr,
    registry,
    cdrBaseUrl,
    registryBaseUrl,
    stop: async () => {
      await cdr.stop();
      await registry.stop();
    },
  };
}

/** 停掉编排里的全部替身。 */
export async function stopHarness(h: Harness): Promise<void> {
  await h.stop();
}

/**
 * 构造注入被测 CLI 的环境变量。
 *
 * 始终包含 CDR_* 与 REGISTRY_* 五项；当传入 `modelBaseUrl` 时再补上
 * MODEL_BASE_URL / MODEL_API_KEY / MODEL_NAME（模型三项必须齐备，否则生产代码会报错）。
 */
export function envForHarness(
  h: Harness,
  modelBaseUrl?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    CDR_BASE_URL: h.cdrBaseUrl,
    CDR_API_TOKEN: 'test-token',
    CDR_IDENTIFIER_SYSTEM: 'urn:oid:1.2.3',
    REGISTRY_BASE_URL: h.registryBaseUrl,
    REGISTRY_API_TOKEN: 'reg-token',
  };
  if (modelBaseUrl !== undefined) {
    env['MODEL_BASE_URL'] = modelBaseUrl;
    env['MODEL_API_KEY'] = 'model-test-key';
    env['MODEL_NAME'] = 'test-model';
  }
  return env;
}
