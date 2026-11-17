/**
 * 测试层替身：一个 OpenAI 兼容的 /chat/completions 假端点。
 *
 * 替身只在 tests/ 下使用，src/ 不引用本文件。用来复现：正常结构化输出、
 * 429 / 5xx / 401 / 403 / 超时 / 非 JSON 内容等故障场景。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** 假端点的一次响应配置。 */
export interface MockResponse {
  /** HTTP 状态码，默认 200 */
  status?: number;
  /** 放进 choices[0].message.content 的 JSON 字符串 */
  content?: string;
  /** 放进响应根的 usage（缺省不返回 usage 字段） */
  usage?: unknown;
  /** 响应延迟（毫秒），用于复现超时 */
  delayMs?: number;
}

export type MockHandler = MockResponse | ((body: unknown) => MockResponse);

export interface MockModelServer {
  /** 形如 http://127.0.0.1:PORT 的 baseUrl */
  url: string;
  /** 设置/更换响应策略 */
  setResponse(handler: MockHandler): void;
  /** 关闭服务器 */
  close(): Promise<void>;
}

/** 启动一个假模型端点。 */
export async function startMockModelServer(initial?: MockHandler): Promise<MockModelServer> {
  let handler: MockHandler = initial ?? { content: '{}' };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let body: unknown = null;
      try {
        if (chunks.length > 0) body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        body = null;
      }
      const cfg = typeof handler === 'function' ? handler(body) : handler;
      const status = cfg.status ?? 200;
      const envelope = {
        choices: [
          {
            message: { role: 'assistant', content: cfg.content ?? '{}' },
          },
        ],
        ...(cfg.usage === undefined ? {} : { usage: cfg.usage }),
      };
      const send = (): void => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(envelope));
      };
      if ((cfg.delayMs ?? 0) > 0) {
        setTimeout(send, cfg.delayMs);
      } else {
        send();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    setResponse(next: MockHandler) {
      handler = next;
    },
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
