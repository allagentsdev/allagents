import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
// Explicit package entry avoids Bun's partial built-in Undici shim, which lacks
// dispatcher lifecycle and would silently ignore per-connection network policy.
import {
  Agent,
  EnvHttpProxyAgent,
  fetch as undiciFetch,
} from 'undici/index.js';
import { getHomeDir } from '../constants.js';
import type { McpConnectionConfig } from '../models/mcp-options.js';

export interface McpNetworkOptions {
  serverUrl: string;
  connection?: McpConnectionConfig;
  fetch?: FetchLike;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

interface StoredCookie {
  name: string;
  path: string;
  secure: boolean;
  value: string;
  expiresAt: number | undefined;
}

function idleBoundBody(response: Response, timeoutMs: number): Response {
  if (!response.body || timeoutMs === 0) return response;
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error('MCP response body exceeded its idle timeout'),
                ),
              timeoutMs,
            );
          }),
        ]);
        if (chunk.done) {
          controller.close();
          reader.releaseLock();
        } else controller.enqueue(chunk.value);
      } catch (error) {
        controller.error(error);
        await reader.cancel(error).catch(() => undefined);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** One connection owns its dispatcher, cookie store, cancellation and diagnostics. */
export function createMcpNetwork(options: McpNetworkOptions): {
  fetch: FetchLike;
  close(): Promise<void>;
} {
  const policy = options.connection ?? {};
  const environment = options.environment ?? process.env;
  const controller = new AbortController();
  const cookies = new Map<string, Map<string, StoredCookie>>();
  const connect = {
    timeout: (policy.connectTimeoutSeconds ?? 10) * 1000,
    ...(policy.ipv4 ? { family: 4 } : {}),
  };
  const httpProxy = environment.HTTP_PROXY ?? environment.http_proxy;
  const httpsProxy = environment.HTTPS_PROXY ?? environment.https_proxy;
  const noProxy = environment.NO_PROXY ?? environment.no_proxy;
  const dispatcher = options.fetch
    ? undefined
    : policy.enableProxy
      ? new EnvHttpProxyAgent({
          ...(httpProxy === undefined ? {} : { httpProxy }),
          ...(httpsProxy === undefined ? {} : { httpsProxy }),
          ...(noProxy === undefined ? {} : { noProxy }),
          connect,
          headersTimeout: (policy.headersTimeoutSeconds ?? 300) * 1000,
          bodyTimeout: (policy.bodyTimeoutSeconds ?? 300) * 1000,
        })
      : new Agent({
          connect,
          headersTimeout: (policy.headersTimeoutSeconds ?? 300) * 1000,
          bodyTimeout: (policy.bodyTimeoutSeconds ?? 300) * 1000,
        });
  const configuredDispatcher = dispatcher?.compose(
    (dispatch) => (request, handler) =>
      dispatch(
        {
          ...request,
          headersTimeout: (policy.headersTimeoutSeconds ?? 300) * 1000,
          bodyTimeout: (policy.bodyTimeoutSeconds ?? 300) * 1000,
        },
        handler,
      ),
  );
  const baseFetch: FetchLike =
    options.fetch ??
    (async (input, init) => {
      // Both libraries expose Web Fetch; Undici's additional dispatcher is private
      // to this connection rather than changing the process-wide fetch dispatcher.
      const response = await undiciFetch(input, {
        ...init,
        dispatcher: configuredDispatcher,
      } as Parameters<typeof undiciFetch>[1]);
      return response as unknown as Response;
    });
  const headersTimeout = (policy.headersTimeoutSeconds ?? 300) * 1000;
  const bodyTimeout = (policy.bodyTimeoutSeconds ?? 300) * 1000;
  const debugPath = policy.debug
    ? join(
        getHomeDir(),
        '.allagents',
        'mcp-debug',
        `${createHash('sha256').update(options.serverUrl).digest('hex').slice(0, 16)}-${process.pid}-${randomUUID()}.log`,
      )
    : undefined;
  let diagnostics = Promise.resolve();
  let closePromise: Promise<void> | undefined;

  function debug(message: string): void {
    if (!debugPath) return;
    diagnostics = diagnostics
      .then(async () => {
        await mkdir(join(debugPath, '..'), { recursive: true, mode: 0o700 });
        await appendFile(
          debugPath,
          `${new Date().toISOString()} ${message}\n`,
          { mode: 0o600 },
        );
      })
      .catch(() => undefined);
  }
  if (debugPath) console.error(`MCP connection diagnostics: ${debugPath}`);

  const fetch: FetchLike = async (input, init) => {
    if (controller.signal.aborted) throw new Error('MCP connection is closed');
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    if (!policy.disableCookies && !headers.has('cookie')) {
      const originCookies = cookies.get(url.origin);
      if (originCookies) {
        const values: string[] = [];
        const ordered = [...originCookies].sort(
          ([, left], [, right]) => right.path.length - left.path.length,
        );
        for (const [key, cookie] of ordered) {
          if (
            cookie.expiresAt !== undefined &&
            cookie.expiresAt <= Date.now()
          ) {
            originCookies.delete(key);
            continue;
          }
          if (cookie.secure && url.protocol !== 'https:') continue;
          if (
            url.pathname !== cookie.path &&
            !(
              url.pathname.startsWith(cookie.path) &&
              (cookie.path.endsWith('/') ||
                url.pathname[cookie.path.length] === '/')
            )
          )
            continue;
          values.push(`${cookie.name}=${cookie.value}`);
        }
        if (values.length) headers.set('cookie', values.join('; '));
      }
    }
    const requestController = new AbortController();
    const signals = [
      controller.signal,
      requestController.signal,
      ...(options.signal ? [options.signal] : []),
      ...(init?.signal ? [init.signal] : []),
    ];
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (headersTimeout > 0)
      timer = setTimeout(
        () =>
          requestController.abort(
            new Error('MCP request timed out waiting for response headers'),
          ),
        headersTimeout,
      );
    debug(`${init?.method ?? 'GET'} ${url.origin}`);
    try {
      const response = await baseFetch(input, {
        ...init,
        headers,
        signal: AbortSignal.any(signals),
      });
      debug(`Response ${response.status} ${url.origin}`);
      if (!policy.disableCookies) {
        const originCookies =
          cookies.get(url.origin) ?? new Map<string, StoredCookie>();
        for (const value of response.headers.getSetCookie()) {
          const [pair, ...attributes] = value.split(';');
          const separator = pair?.indexOf('=') ?? -1;
          if (!pair || separator <= 0) continue;
          const name = pair.slice(0, separator).trim();
          let expiresAt: number | undefined;
          const lastSlash = url.pathname.lastIndexOf('/');
          let path = lastSlash <= 0 ? '/' : url.pathname.slice(0, lastSlash);
          let secure = false;
          for (const attribute of attributes) {
            const [key, ...parts] = attribute.trim().split('=');
            const field = parts.join('=');
            if (key?.toLowerCase() === 'path' && field.startsWith('/'))
              path = field;
            if (key?.toLowerCase() === 'secure') secure = true;
            if (key?.toLowerCase() === 'max-age' && /^-?\d+$/.test(field))
              expiresAt = Date.now() + Number(field) * 1000;
            if (key?.toLowerCase() === 'expires' && expiresAt === undefined) {
              const expiry = Date.parse(field);
              if (Number.isFinite(expiry)) expiresAt = expiry;
            }
          }
          const cookieKey = JSON.stringify([name, path]);
          if (expiresAt !== undefined && expiresAt <= Date.now())
            originCookies.delete(cookieKey);
          else
            originCookies.set(cookieKey, {
              name,
              path,
              secure,
              value: pair.slice(separator + 1).trim(),
              expiresAt,
            });
        }
        if (originCookies.size) cookies.set(url.origin, originCookies);
      }
      return idleBoundBody(response, bodyTimeout);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  return {
    fetch,
    close() {
      closePromise ??= (async () => {
        controller.abort(new Error('MCP connection is closed'));
        cookies.clear();
        await dispatcher?.destroy();
        await diagnostics;
      })();
      return closePromise;
    },
  };
}
