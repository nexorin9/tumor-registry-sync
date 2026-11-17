/**
 * 本地替身专病库登记接口（只在 tests/ 内使用）。
 *
 * 职责：
 * - 接收 POST /api/v1/registry-entries
 * - 读取 Idempotency-Key 头，按该键去重（每个唯一键只存一条）
 * - 按每测试的 handler 返回可配置状态码（200/401/403/404/429/500/超时）
 * - 记录每次请求的头与体，供断言使用
 */
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRequestRecord {
  key: string | null;
  auth: string | null;
  contentType: string | null;
  body: unknown;
  headers: Record<string, string | undefined>;
}

export interface FakeHandlerResult {
  status: number;
  delayMs?: number;
  /** 是否计入「已存储」（仅 2xx 计入；去重：同一 key 只存一次） */
  store?: boolean;
}

export type FakeHandler = (
  req: IncomingMessage,
  key: string | null,
) => FakeHandlerResult;

export interface FakeRegistry {
  url: string;
  server: Server;
  stored: Map<string, number>;
  requests: FakeRequestRecord[];
  close: () => Promise<void>;
}

export function createFakeRegistry(handler: FakeHandler): FakeRegistry {
  const stored = new Map<string, number>();
  const requests: FakeRequestRecord[] = [];

  const server = createServer((req, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const key = req.headers['idempotency-key'] ?? null;
      const auth = (req.headers['authorization'] as string | undefined) ?? null;
      const contentType = req.headers['content-type'] ?? null;
      let body: unknown = null;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
      }
      const record: FakeRequestRecord = {
        key,
        auth,
        contentType,
        body,
        headers: req.headers as Record<string, string | undefined>,
      };
      requests.push(record);

      const result = handler(req, key);

      const finish = (status: number, store: boolean): void => {
        if (store && status >= 200 && status < 300 && key !== null) {
          if (!stored.has(key)) stored.set(key, 1);
        }
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: status < 300, status }));
      };

      if (result.delayMs && result.delayMs > 0) {
        setTimeout(() => finish(result.status, result.store ?? false), result.delayMs);
      } else {
        finish(result.status, result.store ?? false);
      }
    });
  });

  const started = new Promise<void>((resolve) => server.listen(0, resolve));
  // 同步返回一个对象，url 在 listen 后填充
  const fake: FakeRegistry = {
    url: '',
    server,
    stored,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };

  // 阻塞直到端口就绪（测试用，简单可靠）
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  started.then(() => {
    const addr = server.address() as AddressInfo;
    fake.url = `http://127.0.0.1:${addr.port}`;
  });

  return fake;
}

/** 等待替身就绪（url 已填充）。 */
export async function waitReady(fake: FakeRegistry): Promise<FakeRegistry> {
  for (let i = 0; i < 100; i++) {
    if (fake.url.length > 0) return fake;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('fake registry 未在超时内就绪');
}
