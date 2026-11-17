/**
 * 假专病库登记接口（仅测试层）。
 *
 * 这是 `src/push/registry-client.ts` 的替身：起一个真的本地 HTTP 服务
 * （`node:http`），生产代码用 `globalThis.fetch` 就能无改动地打到它。替身只在
 * `tests/` 内使用，`src/` 不得引用本文件。
 *
 * 复现的写入链路：
 * - `POST {baseUrl}/api/v1/registry-entries`
 *   - 请求头 `Authorization: Bearer <token>`、`Idempotency-Key: <key>`
 *   - 请求体为 RegistryEntry JSON
 *
 * 幂等语义：`Idempotency-Key` 已出现过 → 返回 200 且回写**同一份**已存条目，
 * **不**重复入库（`storedCount` 不 +1）；首次出现 → 入库并 +1，返回 201。
 *
 * 可注入的故障（通过 `FakeRegistryOptions.fault`）：
 * 'auth'(401) / 'serverError'(500) / 'timeout'(挂起不响应)。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeRegistryFault = 'none' | 'auth' | 'serverError' | 'timeout';

export interface FakeRegistryOptions {
  /** 监听端口（harness 用 node:net 找出的空闲端口） */
  port: number;
  /** 故障注入类型，默认 'none' */
  fault?: FakeRegistryFault;
}

export interface FakeRegistryReceived {
  idempotencyKey: string;
  body: unknown;
  headers: Record<string, string>;
}

/** 假专病库登记接口。 */
export class FakeRegistry {
  /** 收到的每一次请求（含首请求与幂等重放），带请求头 */
  readonly received: FakeRegistryReceived[] = [];
  /** 实际入库条数（幂等键重复不计数） */
  storedCount = 0;
  /** 已见过的幂等键集合 */
  readonly dedupeKeys = new Set<string>();
  /** 服务基地址（不含 /api/v1/registry-entries），`start()` 后可用 */
  url = '';

  private readonly options: FakeRegistryOptions;
  private readonly store = new Map<string, unknown>();
  private server: Server | null = null;

  constructor(options: FakeRegistryOptions) {
    this.options = options;
  }

  /** 启动本地 HTTP 服务。 */
  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      const server = this.server as Server;
      server.once('error', reject);
      server.listen(this.options.port, '127.0.0.1', () => resolve());
    });
    this.url = `http://127.0.0.1:${this.options.port}`;
  }

  /** 停止本地 HTTP 服务。 */
  async stop(): Promise<void> {
    if (this.server === null) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const idempotencyKey = String(req.headers['idempotency-key'] ?? '');
    const headers = normalizeHeaders(req.headers);

    const fault: FakeRegistryFault = this.options.fault ?? 'none';
    if (fault !== 'none') {
      switch (fault) {
        case 'auth':
          this.received.push({ idempotencyKey, body: null, headers });
          this.respond(res, 401, 'unauthorized');
          return;
        case 'serverError':
          this.received.push({ idempotencyKey, body: null, headers });
          this.respond(res, 500, 'server error');
          return;
        case 'timeout':
          // 故意挂起不响应：依赖客户端超时（AbortController）来中断
          return;
      }
    }

    let bodyText = '';
    req.on('data', (chunk: Buffer) => {
      bodyText += chunk.toString('utf8');
    });
    req.on('end', () => {
      let body: unknown = null;
      try {
        body = bodyText.length > 0 ? JSON.parse(bodyText) : null;
      } catch {
        body = bodyText;
      }

      this.received.push({ idempotencyKey, body, headers });

      if (this.dedupeKeys.has(idempotencyKey)) {
        // 幂等重放：返回同一份已存条目，不重复入库
        const stored = this.store.get(idempotencyKey);
        this.respond(res, 200, JSON.stringify(stored ?? body));
        return;
      }

      this.dedupeKeys.add(idempotencyKey);
      this.storedCount += 1;
      this.store.set(idempotencyKey, body);
      this.respond(res, 201, JSON.stringify(body));
    });
    req.on('error', () => {
      res.destroy();
    });
  }

  private respond(res: ServerResponse, status: number, body: string): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  }
}

/** 把 IncomingHttpHeaders 规整成小写键的字符串记录。 */
function normalizeHeaders(headers: IncomingMessage['headers']): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    result[key.toLowerCase()] = Array.isArray(value) ? value.join(',') : String(value);
  }
  return result;
}
