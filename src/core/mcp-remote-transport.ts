import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { createParser } from 'eventsource-parser';
import {
  UnauthorizedError,
  auth,
  extractWWWAuthenticateParams,
} from '@modelcontextprotocol/sdk/client/auth.js';
import {
  SSEClientTransport,
  SseError,
} from '@modelcontextprotocol/sdk/client/sse.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  FetchLike,
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  type JSONRPCMessage,
  JSONRPCMessageSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpConnectionConfig } from '../models/mcp-options.js';
import type { McpCredentialGuard } from './mcp-http-client.js';
import type { FileOAuthClientProvider } from './mcp-oauth-provider.js';

class McpAuthorizationLockRequired extends UnauthorizedError {}

function isAuthorizationChallenge(response: Response): boolean {
  return (
    response.status === 401 ||
    (response.status === 403 &&
      extractWWWAuthenticateParams(response).error === 'insufficient_scope')
  );
}

/** Observe delivery without consuming or changing the bytes handed to the SDK. */
function observeRequestStream(
  response: Response,
  id: string | number,
  failed: () => void,
): Response {
  if (!response.body) {
    failed();
    return response;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let primed = false;
  let complete = false;
  const parser = createParser({
    onEvent(event) {
      // Match the SDK's emitted-event boundary, including whitespace IDs and
      // non-message events that can prime a stream but cannot answer an RPC.
      if (event.id) primed = true;
      if (!event.data || (event.event && event.event !== 'message')) return;
      try {
        const parsed = JSONRPCMessageSchema.safeParse(JSON.parse(event.data));
        if (
          parsed.success &&
          'id' in parsed.data &&
          parsed.data.id === id &&
          ('result' in parsed.data || 'error' in parsed.data)
        )
          complete = true;
      } catch {}
    },
  });
  const terminal = () => {
    if (!primed && !complete) failed();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          parser.feed(decoder.decode());
          terminal();
          controller.close();
        } else {
          parser.feed(decoder.decode(next.value, { stream: true }));
          controller.enqueue(next.value);
        }
      } catch (error) {
        terminal();
        controller.error(error);
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

type Remote = StreamableHTTPClientTransport | SSEClientTransport;

/** Owns transport selection and authorization without performing a client handshake. */
export class McpRemoteTransport implements Transport {
  onmessage: Transport['onmessage'];
  onerror: Transport['onerror'];
  onclose: Transport['onclose'];
  private remote: Remote;
  private kind: 'http' | 'sse';
  private fallbackUsed = false;
  private established = false;
  private readonly authorizationContext = new AsyncLocalStorage<{
    held: boolean;
    fresh?: boolean;
  }>();
  private started = false;
  private closed = false;
  private violation: Error | undefined;
  private readonly requests = new Set<string | number>();
  private closePromise: Promise<void> | undefined;
  private authorization: Promise<void> | undefined;
  private originalInitialize: JSONRPCMessage | undefined;
  private initializedNotification: JSONRPCMessage = {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  };
  private sessionRecovery: Promise<void> | undefined;
  private recoveryHandshake:
    | { resolve(): void; reject(error: Error): void }
    | undefined;
  private initializeId: string | number | undefined;
  private protocolVersion: string | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private readonly pingPrefix = `allagents-ping-${randomUUID()}-`;
  private pingSequence = 0;
  private readonly pings = new Set<string>();

  constructor(
    private readonly url: URL,
    private readonly provider: FileOAuthClientProvider,
    private readonly fetch: FetchLike,
    private readonly guard: McpCredentialGuard,
    private readonly config: McpConnectionConfig = {},
    private readonly signal?: AbortSignal,
  ) {
    this.kind = config.transportStrategy?.startsWith('sse') ? 'sse' : 'http';
    this.remote = this.build();
  }

  get sessionId(): string | undefined {
    return this.remote instanceof StreamableHTTPClientTransport
      ? this.remote.sessionId
      : undefined;
  }

  private build(): Remote {
    const fetchRemote: FetchLike = async (input, init) => {
      if (this.violation && init?.method !== 'DELETE') throw this.violation;
      const response = await this.fetch(input, init);
      const resourceRequest =
        new Headers(init?.headers)
          .get('accept')
          ?.includes('text/event-stream') ||
        (typeof init?.body === 'string' &&
          /"jsonrpc"\s*:\s*"2\.0"/.test(init.body));
      if (
        isAuthorizationChallenge(response) &&
        resourceRequest &&
        init?.method === 'GET' &&
        new URL(String(input)).origin === this.url.origin
      ) {
        return this.authenticateStream(input, init, response);
      }
      if (
        isAuthorizationChallenge(response) &&
        resourceRequest &&
        this.authorizationContext.getStore()?.fresh
      ) {
        await response.body?.cancel();
        await this.provider.invalidateCredentials('tokens');
        const error = new UnauthorizedError(
          'MCP server rejected freshly issued OAuth credentials',
        );
        this.provider.completeAuthorization(error);
        throw error;
      }
      // A rejected resource request is safe to retry. Acquire coordination before
      // the SDK can begin discovery, registration, refresh, or fresh consent.
      if (
        isAuthorizationChallenge(response) &&
        resourceRequest &&
        new URL(String(input)).origin === this.url.origin &&
        !this.authorizationContext.getStore()?.held
      ) {
        await response.body?.cancel();
        throw new McpAuthorizationLockRequired();
      }
      if (
        init?.method === 'POST' &&
        response.ok &&
        response.headers
          .get('content-type')
          ?.toLowerCase()
          .startsWith('text/event-stream') &&
        typeof init.body === 'string'
      ) {
        let message: JSONRPCMessage | undefined;
        try {
          message = JSON.parse(init.body) as JSONRPCMessage;
        } catch {}
        if (message && 'method' in message && 'id' in message) {
          const id = message.id;
          return observeRequestStream(response, id, () => {
            if (
              this.closed ||
              this.remote !== remote ||
              !this.requests.delete(id)
            )
              return;
            this.onmessage?.({
              jsonrpc: '2.0',
              id,
              error: {
                code: -32603,
                message:
                  'MCP response stream ended before the request completed',
              },
            });
          });
        }
      }
      return response;
    };
    const remote =
      this.kind === 'http'
        ? new StreamableHTTPClientTransport(this.url, {
            authProvider: this.provider,
            fetch: fetchRemote,
          })
        : new SSEClientTransport(this.url, {
            authProvider: this.provider,
            fetch: fetchRemote,
          });
    if (this.protocolVersion) remote.setProtocolVersion(this.protocolVersion);
    remote.onmessage = (incoming) => {
      if (this.closed || this.violation || this.remote !== remote) return;
      const message = incoming;
      try {
        this.guard.assertSafe(message);
      } catch (error) {
        this.failCredentialGuard(error);
        return;
      }
      if (
        'id' in message &&
        !('method' in message) &&
        typeof message.id === 'string' &&
        this.pings.delete(message.id)
      )
        return;
      if (
        'id' in message &&
        message.id === this.initializeId &&
        'result' in message
      ) {
        const version = message.result.protocolVersion;
        if (typeof version === 'string') this.setProtocolVersion(version);
        this.established = true;
        if (this.recoveryHandshake) {
          this.recoveryHandshake.resolve();
          return;
        }
      }
      if (
        'id' in message &&
        message.id === this.initializeId &&
        'error' in message &&
        this.recoveryHandshake
      ) {
        this.recoveryHandshake.reject(
          new Error('MCP session initialization failed'),
        );
        return;
      }
      if (!('method' in message) && 'id' in message && message.id !== undefined)
        this.requests.delete(message.id);
      this.onmessage?.(message);
    };
    remote.onerror = (error) => {
      if (this.closed || this.violation || this.remote !== remote) return;
      // SDKs report a failed send through both onerror and its rejected promise.
      // Consent and startup fallback are handled before the rejection escapes.
      if (error instanceof UnauthorizedError) return;
      if (this.canFallback(error)) return;
      this.onerror?.(this.guard.sanitizeError(error));
    };
    remote.onclose = () => {
      if (!this.closed && this.remote === remote) void this.close();
    };
    return remote;
  }

  private async authenticateStream(
    input: string | URL,
    init: RequestInit,
    response: Response,
  ): Promise<Response> {
    await response.body?.cancel();
    let authenticated: Response | undefined;
    await this.withStartupLock(async () => {
      const request = async () => {
        const headers = new Headers(init.headers);
        const tokens = await this.provider.tokens();
        if (tokens)
          headers.set('authorization', `Bearer ${tokens.access_token}`);
        else headers.delete('authorization');
        return this.fetch(input, { ...init, headers });
      };
      const retry = await request();
      if (!isAuthorizationChallenge(retry)) {
        authenticated = retry;
        return;
      }
      const challenge = extractWWWAuthenticateParams(retry);
      await retry.body?.cancel();
      const options = {
        serverUrl: this.url,
        fetchFn: this.fetch,
        ...challenge,
      };
      try {
        let result = await auth(this.provider, options);
        if (result !== 'AUTHORIZED') {
          const code = await this.provider.waitForAuthCode();
          result = await auth(this.provider, {
            ...options,
            authorizationCode: code,
          });
        }
        if (result !== 'AUTHORIZED')
          throw new UnauthorizedError('MCP stream authorization failed');
        this.provider.completeAuthorization();
      } catch (error) {
        this.provider.completeAuthorization(error);
        throw error;
      }
      authenticated = await request();
      if (isAuthorizationChallenge(authenticated)) {
        await authenticated.body?.cancel();
        await this.provider.invalidateCredentials('tokens');
        throw new UnauthorizedError(
          'MCP server rejected freshly issued OAuth credentials',
        );
      }
    });
    return authenticated as Response;
  }

  private failCredentialGuard(error: unknown): void {
    if (this.violation) return;
    const safe = this.guard.sanitizeError(error);
    this.violation = safe;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.recoveryHandshake?.reject(safe);
    // Transport.onerror is advisory in the SDK. Settle each outstanding RPC via
    // the public JSON-RPC error channel, retaining auth for the caller's DELETE.
    const requests = [...this.requests];
    this.requests.clear();
    for (const id of requests) {
      this.onmessage?.({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: safe.message,
          data: { allagents: 'credential-reflection' },
        },
      });
    }
    this.onerror?.(safe);
  }

  private canFallback(error: unknown): boolean {
    if (this.established || this.fallbackUsed) return false;
    const strategy = this.config.transportStrategy ?? 'http-first';
    return (
      (strategy === 'http-first' &&
        this.kind === 'http' &&
        error instanceof StreamableHTTPError &&
        (error.code === 404 || error.code === 405)) ||
      (strategy === 'sse-first' &&
        this.kind === 'sse' &&
        error instanceof SseError &&
        (error.code === 404 || error.code === 405))
    );
  }

  private async fallback(): Promise<void> {
    this.fallbackUsed = true;
    const previous = this.remote;
    delete previous.onclose;
    delete previous.onerror;
    await previous.close();
    this.kind = this.kind === 'http' ? 'sse' : 'http';
    this.remote = this.build();
    await this.startRemote();
  }

  private authorize(remote: Remote): Promise<void> {
    if (this.authorization) return this.authorization;
    const exchange = async () => {
      try {
        this.signal?.throwIfAborted();
        const code = await this.provider.waitForAuthCode();
        await remote.finishAuth(code);
        this.provider.completeAuthorization();
      } catch (error) {
        this.provider.completeAuthorization(error);
        throw error;
      }
    };
    this.authorization = (
      this.authorizationContext.getStore()?.held
        ? exchange()
        : this.provider.runWithAuthorizationLock(exchange)
    ).finally(() => {
      this.authorization = undefined;
    });
    return this.authorization;
  }

  private async withStartupLock(operation: () => Promise<void>): Promise<void> {
    await this.provider.runWithAuthorizationLock(async () => {
      const context = { held: true };
      try {
        await this.authorizationContext.run(context, operation);
      } finally {
        context.held = false;
      }
    });
  }

  private async withFreshCredentials(
    operation: () => Promise<void>,
  ): Promise<void> {
    const context = {
      held: this.authorizationContext.getStore()?.held ?? false,
      fresh: true,
    };
    try {
      await this.authorizationContext.run(context, operation);
    } finally {
      context.held = false;
      context.fresh = false;
    }
  }

  private async startRemote(): Promise<void> {
    try {
      await this.remote.start();
    } catch (error) {
      if (error instanceof UnauthorizedError) {
        const previous = this.remote;
        await this.authorize(previous);
        delete previous.onclose;
        delete previous.onerror;
        await previous.close();
        this.remote = this.build();
        await this.withFreshCredentials(() => this.remote.start());
      } else if (this.canFallback(error)) await this.fallback();
      else throw error;
    }
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('MCP transport already started');
    this.started = true;
    this.signal?.throwIfAborted();
    if (this.kind === 'sse')
      await this.withStartupLock(() => this.startRemote());
    else await this.startRemote();
  }

  private async sendRemote(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    if (this.remote instanceof StreamableHTTPClientTransport)
      await this.remote.send(message, {
        ...(options?.resumptionToken === undefined
          ? {}
          : { resumptionToken: options.resumptionToken }),
        ...(options?.onresumptiontoken === undefined
          ? {}
          : { onresumptiontoken: options.onresumptiontoken }),
      });
    else await this.remote.send(message);
  }

  async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    if (this.closed) throw new Error('MCP transport is closed');
    if (this.violation) throw this.violation;
    this.signal?.throwIfAborted();
    if (
      'method' in message &&
      message.method === 'initialize' &&
      'id' in message
    ) {
      this.initializeId = message.id;
      this.originalInitialize = message;
    }
    if ('method' in message && message.method === 'notifications/initialized')
      this.initializedNotification = message;
    if ('method' in message && this.sessionRecovery) await this.sessionRecovery;
    if (
      'method' in message &&
      'id' in message &&
      !this.pings.has(String(message.id))
    )
      this.requests.add(message.id);

    const send = async () => {
      try {
        await this.sendRemote(message, options);
      } catch (error) {
        if (error instanceof McpAuthorizationLockRequired) {
          await this.withStartupLock(send);
        } else if (error instanceof UnauthorizedError) {
          await this.authorize(this.remote);
          if (this.closed) throw new Error('MCP transport is closed');
          await this.withFreshCredentials(() =>
            this.sendRemote(message, options),
          );
        } else if (
          error instanceof StreamableHTTPError &&
          error.code === 404 &&
          this.established &&
          this.sessionId &&
          'method' in message &&
          message.method !== 'initialize'
        ) {
          if ('id' in message && !this.requests.has(message.id)) return;
          await this.recoverSession('id' in message ? message.id : undefined);
          await this.sendRemote(message, options);
        } else if (
          this.canFallback(error) &&
          'method' in message &&
          message.method === 'initialize'
        ) {
          await this.fallback();
          await this.sendRemote(message, options);
        } else throw this.guard.sanitizeError(error);
      }
    };
    try {
      if (
        !this.established &&
        'method' in message &&
        message.method === 'initialize'
      )
        await this.withStartupLock(send);
      else await send();
    } catch (error) {
      if ('method' in message && 'id' in message) {
        // Retirement or a terminal stream already answered this RPC. Do not
        // turn the resulting abort into a second response at the relay boundary.
        if (!this.requests.delete(message.id)) return;
      }
      throw error;
    }
    if ('method' in message && message.method === 'notifications/initialized')
      this.startKeepAlive();
  }

  private recoverSession(
    triggerId: string | number | undefined,
  ): Promise<void> {
    this.sessionRecovery ??= this.withStartupLock(async () => {
      if (!this.originalInitialize)
        throw new Error('MCP session cannot be resumed before initialization');
      const previous = this.remote;
      delete previous.onmessage;
      for (const id of [...this.requests]) {
        if (id === triggerId) continue;
        this.requests.delete(id);
        this.onmessage?.({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32603,
            message: 'MCP session expired while the request was in progress',
          },
        });
      }
      delete previous.onclose;
      delete previous.onerror;
      await previous.close();
      this.remote = this.build();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      const handshake = new Promise<void>((resolve, reject) => {
        this.recoveryHandshake = { resolve, reject };
        timer = setTimeout(
          () => reject(new Error('MCP session initialization timed out')),
          30000,
        );
        abort = () =>
          reject(new Error('MCP session initialization was cancelled'));
        this.signal?.addEventListener('abort', abort, { once: true });
      });
      // A send failure can precede awaiting the handshake promise.
      void handshake.catch(() => {});
      try {
        await this.startRemote();
        try {
          await this.sendRemote(this.originalInitialize);
        } catch (error) {
          if (!(error instanceof UnauthorizedError)) throw error;
          await this.authorize(this.remote);
          await this.withFreshCredentials(() =>
            this.sendRemote(this.originalInitialize as JSONRPCMessage),
          );
        }
        await handshake;
        await this.sendRemote(this.initializedNotification);
      } finally {
        this.recoveryHandshake = undefined;
        if (timer) clearTimeout(timer);
        if (abort) this.signal?.removeEventListener('abort', abort);
      }
    }).finally(() => {
      this.sessionRecovery = undefined;
    });
    return this.sessionRecovery;
  }

  private startKeepAlive(): void {
    if (!this.config.keepAliveSeconds || this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      // Modern protocol answers ping locally; its subscription stream owns liveness.
      if (
        this.pings.size ||
        this.closed ||
        this.protocolVersion === '2026-07-28'
      )
        return;
      const id = `${this.pingPrefix}${++this.pingSequence}`;
      this.pings.add(id);
      void this.send({ jsonrpc: '2.0', id, method: 'ping' }).catch((error) => {
        this.pings.delete(id);
        this.onerror?.(this.guard.sanitizeError(error));
      });
    }, this.config.keepAliveSeconds * 1000);
    this.pingTimer.unref?.();
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
    this.remote.setProtocolVersion(version);
  }
  async terminateSession(): Promise<void> {
    if (this.remote instanceof StreamableHTTPClientTransport)
      await this.remote.terminateSession();
  }
  close(): Promise<void> {
    this.closePromise ??= (async () => {
      this.closed = true;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pings.clear();
      this.requests.clear();
      this.provider.dispose();
      try {
        await this.remote.close();
      } finally {
        this.onclose?.();
      }
    })();
    return this.closePromise;
  }
}

/** Apply catalog policy after protocol-era translation so every result has the host shape. */
export function createMcpToolFilterTransport(
  transport: Transport,
  patterns: readonly string[] = [],
): Transport {
  if (!patterns.length) return transport;
  const expressions = patterns.map(
    (pattern) =>
      new RegExp(
        `^${pattern
          .split('*')
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*')}$`,
        'i',
      ),
  );
  const ignored = (name: string) =>
    expressions.some((pattern) => pattern.test(name));
  const lists = new Set<string | number>();
  const filtered: Transport = {
    start: () => transport.start(),
    async send(message, options) {
      if (
        'method' in message &&
        message.method === 'tools/list' &&
        'id' in message
      )
        lists.add(message.id);
      if (
        'method' in message &&
        message.method === 'tools/call' &&
        'id' in message &&
        typeof message.params?.name === 'string' &&
        ignored(message.params.name)
      ) {
        filtered.onmessage?.({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32601,
            message: 'Tool is excluded by the MCP connection policy',
          },
        });
        return;
      }
      try {
        await transport.send(message, options);
      } catch (error) {
        if ('id' in message && message.id !== undefined)
          lists.delete(message.id);
        throw error;
      }
    },
    async close() {
      lists.clear();
      await transport.close();
    },
    setProtocolVersion: (version) => transport.setProtocolVersion?.(version),
    get sessionId() {
      return transport.sessionId;
    },
  };
  transport.onmessage = (incoming) => {
    let message: JSONRPCMessage = incoming;
    if (
      'id' in message &&
      message.id !== undefined &&
      !('method' in message) &&
      lists.delete(message.id) &&
      'result' in message &&
      Array.isArray(message.result.tools)
    ) {
      message = {
        ...message,
        result: {
          ...message.result,
          tools: message.result.tools.filter(
            (tool: unknown) =>
              !(
                tool &&
                typeof tool === 'object' &&
                'name' in tool &&
                typeof tool.name === 'string' &&
                ignored(tool.name)
              ),
          ),
        },
      };
    }
    filtered.onmessage?.(message);
  };
  transport.onerror = (error) => filtered.onerror?.(error);
  transport.onclose = () => {
    lists.clear();
    filtered.onclose?.();
  };
  return filtered;
}
