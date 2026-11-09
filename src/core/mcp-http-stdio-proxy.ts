import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import {
  createMcpRemoteConnection,
  McpCredentialReflectionError,
  type ConnectMcpHttpClientOptions,
  type McpRemoteConnection,
} from './mcp-http-client.js';

export {
  AUTH_URL_LOG_PREFIX,
  connectHttpMcpServer,
  getBrowserOpenCommands,
  getMcpOAuthCacheDir,
  hashServerUrl,
  OAuthAuthorizationError,
  parseOAuthCallbackUrl,
  resolveMcpHeaderReferences,
  validateOAuthCallbackUrl,
} from './mcp-http-client.js';
export type {
  ConnectHttpMcpServerOptions,
  OAuthCallbackRequest,
  OAuthCallbackUrlReader,
} from './mcp-http-client.js';

/** A protocol relay: neither side's capabilities or RPC shapes belong to the proxy. */
export async function runHttpMcpStdioProxy(
  serverUrl: string,
  headers: Record<string, string> = {},
  options: ConnectMcpHttpClientOptions = {},
): Promise<void> {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const local = new StdioServerTransport();
  let connection: McpRemoteConnection | undefined;
  let closePromise: Promise<void> | undefined;
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const diagnostic = (error: unknown) => {
    if (
      signal.aborted ||
      (options.connection?.silent && !options.connection.debug)
    )
      return;
    const safe = connection?.credentialGuard.sanitizeError(error);
    console.error(
      safe?.name === 'McpCredentialReflectionError'
        ? safe.message
        : 'MCP remote connection failed',
    );
  };
  const close = (): Promise<void> => {
    closePromise ??= Promise.resolve().then(async () => {
      process.stdin.off('end', onEnd);
      process.stdin.off('close', onEnd);
      process.off('SIGINT', onEnd);
      process.off('SIGTERM', onEnd);
      signal.removeEventListener('abort', onEnd);
      controller.abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([local.close(), connection?.close()]),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, 2000);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        finish();
      }
    });
    return closePromise;
  };
  const onEnd = () => {
    void close();
  };
  process.stdin.once('end', onEnd);
  process.stdin.once('close', onEnd);
  process.once('SIGINT', onEnd);
  process.once('SIGTERM', onEnd);
  signal.addEventListener('abort', onEnd, { once: true });
  try {
    connection = await createMcpRemoteConnection(serverUrl, {
      ...options,
      headers,
      signal,
    });
    if (signal.aborted) {
      await connection.close();
      return;
    }
    const remote = connection.transport;
    remote.onmessage = (message) => {
      try {
        connection?.credentialGuard.assertSafe(message);
      } catch (error) {
        diagnostic(error);
        void close();
        return;
      }
      void local.send(message).catch((error) => {
        diagnostic(error);
        void close();
      });
    };
    remote.onerror = (error) => {
      diagnostic(error);
      if (error instanceof McpCredentialReflectionError) {
        void (async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              connection?.terminateSession().catch(() => {}),
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, 1000);
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
            await close();
          }
        })();
      }
    };
    remote.onclose = onEnd;
    local.onerror = (error) => {
      diagnostic(error);
      void close();
    };
    local.onclose = onEnd;
    const ready = remote.start();
    let initialized: Promise<void> = ready;
    local.onmessage = (message: JSONRPCMessage) => {
      const forward = async () => {
        await ready;
        // Responses must pass an outstanding request that is waiting for roots,
        // sampling or elicitation. Only host requests wait on initialized delivery.
        if (
          'method' in message &&
          message.method !== 'notifications/initialized'
        )
          await initialized;
        await remote.send(message);
      };
      const sending = forward();
      if ('method' in message && message.method === 'notifications/initialized')
        initialized = sending;
      void sending.catch(async (error) => {
        if (signal.aborted) return;
        diagnostic(error);
        if ('method' in message && 'id' in message) {
          await local
            .send({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32603, message: 'MCP remote request failed' },
            })
            .catch(() => {});
        } else if ('method' in message) {
          await close();
        }
      });
    };
    await local.start();
    await ready;
    if (options.connection?.debug) console.error('MCP remote relay connected');
    await finished;
  } catch (error) {
    const cancelled = signal.aborted;
    await close();
    if (!cancelled)
      throw connection?.credentialGuard.sanitizeError(error) ?? error;
  } finally {
    await close();
  }
}
