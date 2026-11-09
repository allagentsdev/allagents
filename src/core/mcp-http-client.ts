import { randomUUID } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  FetchLike,
  Transport,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type {
  McpConnectionConfig,
  McpOAuthConfig,
} from '../models/mcp-options.js';
import { createMcpNetwork } from './mcp-network.js';
import {
  buildOAuthProvider,
  getMcpOAuthCacheDir,
  OAuthAuthorizationError,
  type OAuthCallbackUrlReader,
  resolveMcpOAuthServerUrl,
  runWithMcpOAuthReset,
} from './mcp-oauth-provider.js';
import {
  createMcpToolFilterTransport,
  McpRemoteTransport,
} from './mcp-remote-transport.js';

export type {
  OAuthCallbackRequest,
  OAuthCallbackUrlReader,
} from './mcp-oauth-provider.js';
export {
  AUTH_URL_LOG_PREFIX,
  getBrowserOpenCommands,
  getMcpOAuthCacheDir,
  hashServerUrl,
  OAuthAuthorizationError,
  parseOAuthCallbackUrl,
  validateOAuthCallbackUrl,
} from './mcp-oauth-provider.js';

export class McpCredentialReflectionError extends Error {
  constructor() {
    super('MCP output contained a configured credential value');
    this.name = 'McpCredentialReflectionError';
  }
}

export interface McpCredentialGuard {
  assertSafe(value: unknown): void;
  sanitizeError(error: unknown): Error;
}

function containsCredential(
  value: unknown,
  credentials: ReadonlySet<string>,
  seen: Set<object>,
): boolean {
  if (typeof value === 'string') {
    for (const credential of credentials) {
      if (credential && value.includes(credential)) return true;
    }
    return false;
  }
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (value instanceof Error) {
    if (
      containsCredential(value.message, credentials, seen) ||
      containsCredential(value.cause, credentials, seen) ||
      (value instanceof AggregateError &&
        containsCredential(value.errors, credentials, seen))
    ) {
      return true;
    }
  }
  for (const [key, nested] of Object.entries(value)) {
    if (
      containsCredential(key, credentials, seen) ||
      containsCredential(nested, credentials, seen)
    ) {
      return true;
    }
  }
  return false;
}

export function createMcpCredentialGuard(
  values: Iterable<string>,
): McpCredentialGuard {
  const credentials: ReadonlySet<string> =
    values instanceof Set ? values : new Set(values);
  return {
    assertSafe(value) {
      if (containsCredential(value, credentials, new Set())) {
        throw new McpCredentialReflectionError();
      }
    },
    sanitizeError(error) {
      if (
        error instanceof McpError &&
        error.code === -32603 &&
        error.data &&
        typeof error.data === 'object' &&
        'allagents' in error.data &&
        error.data.allagents === 'credential-reflection'
      ) {
        return new McpCredentialReflectionError();
      }
      if (containsCredential(error, credentials, new Set())) {
        return new McpCredentialReflectionError();
      }
      return error instanceof Error ? error : new Error(String(error));
    },
  };
}

export function resolveMcpHeaderReferences(
  headers: Record<string, string>,
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      return [
        key,
        value.replace(
          /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
          (_reference, variable: string) => {
            const resolved = environment[variable];
            if (resolved === undefined)
              throw new Error(
                `MCP header '${key}' references missing environment variable '${variable}'`,
              );
            return resolved;
          },
        ),
      ];
    }),
  );
}

function containsMcpAuthorizationFailure(
  error: unknown,
  seen: Set<object>,
): boolean {
  if (
    error instanceof UnauthorizedError ||
    error instanceof InvalidGrantError ||
    error instanceof OAuthAuthorizationError
  ) {
    return true;
  }
  if (error === null || typeof error !== 'object') return false;
  if (seen.has(error)) return false;
  seen.add(error);

  const candidate = error as {
    error?: unknown;
    errorCode?: unknown;
    cause?: unknown;
  };
  if (
    candidate.error === 'invalid_grant' ||
    candidate.errorCode === 'invalid_grant'
  ) {
    return true;
  }
  if (
    error instanceof Error &&
    error.message === 'OAuth authorization requires an interactive terminal'
  ) {
    return true;
  }
  if (
    containsMcpAuthorizationFailure(candidate.cause, seen) ||
    (error instanceof AggregateError &&
      error.errors.some((nested) =>
        containsMcpAuthorizationFailure(nested, seen),
      ))
  ) {
    return true;
  }
  return false;
}

export function isMcpAuthorizationFailure(error: unknown): boolean {
  return containsMcpAuthorizationFailure(error, new Set());
}

function mcpConnectionError(error: unknown, guard: McpCredentialGuard): Error {
  const sanitized = guard.sanitizeError(error);
  let message = sanitized.message.trim();
  if (!message)
    message =
      'MCP authorization or connection failed; check OAuth client settings';
  else if (message === 'fetch failed' || message === 'Network request failed') {
    message =
      'Could not reach the MCP endpoint; check the server address, network, proxy and certificate settings';
  }
  if (isMcpAuthorizationFailure(error)) return new UnauthorizedError(message);
  return message === sanitized.message ? sanitized : new Error(message);
}

const UNSAFE_CONFIGURED_HEADERS: Record<string, true> = {
  connection: true,
  'content-length': true,
  host: true,
  te: true,
  trailer: true,
  'transfer-encoding': true,
  upgrade: true,
};

export interface McpFetchResponseLimitOptions {
  maxResponseBytes?: number;
}

function boundMcpResponse(
  response: Response,
  maxResponseBytes: number,
): Response {
  if (!response.body) return response;
  const isEventStream = response.headers
    .get('content-type')
    ?.toLowerCase()
    .startsWith('text/event-stream');
  let responseBytes = 0;
  let eventBytes = 0;
  let lineBytes = 0;
  let pendingCarriageReturn = false;

  const finishEventLine = (lineEndingBytes: number): void => {
    if (lineBytes === 0) {
      eventBytes = 0;
      return;
    }
    eventBytes += lineBytes + lineEndingBytes;
    lineBytes = 0;
    if (eventBytes > maxResponseBytes) {
      throw new Error(`MCP HTTP SSE event exceeds ${maxResponseBytes} bytes`);
    }
  };
  const boundedBody = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!isEventStream) {
          responseBytes += chunk.byteLength;
          if (responseBytes > maxResponseBytes) {
            throw new Error(
              `MCP HTTP response exceeds ${maxResponseBytes} bytes`,
            );
          }
          controller.enqueue(chunk);
          return;
        }

        for (const byte of chunk) {
          if (pendingCarriageReturn) {
            finishEventLine(byte === 0x0a ? 2 : 1);
            pendingCarriageReturn = false;
            if (byte === 0x0a) continue;
          }
          if (byte === 0x0d) {
            pendingCarriageReturn = true;
          } else if (byte === 0x0a) {
            finishEventLine(1);
          } else {
            lineBytes += 1;
            if (eventBytes + lineBytes > maxResponseBytes) {
              throw new Error(
                `MCP HTTP SSE event exceeds ${maxResponseBytes} bytes`,
              );
            }
          }
        }
        controller.enqueue(chunk);
      },
      flush() {
        if (pendingCarriageReturn) finishEventLine(1);
      },
    }),
  );
  return new Response(boundedBody, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
}

export function createOriginSafeMcpFetch(
  serverUrl: string,
  headers: Record<string, string>,
  fetchFn: FetchLike = fetch,
  options: McpFetchResponseLimitOptions = {},
): FetchLike {
  const serverOrigin = new URL(serverUrl).origin;
  const configuredHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (!UNSAFE_CONFIGURED_HEADERS[key.toLowerCase()]) {
      configuredHeaders.set(key, value);
    }
  }

  const maxResponseBytes = options.maxResponseBytes;
  if (
    maxResponseBytes !== undefined &&
    (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 0)
  ) {
    throw new Error('MCP HTTP response byte limit must be a safe integer');
  }

  return async (input, init) => {
    const requestUrl = new URL(input.toString());
    let requestInit = init;
    if (requestUrl.origin === serverOrigin) {
      const mergedHeaders = new Headers(configuredHeaders);
      new Headers(init?.headers).forEach((value, key) => {
        mergedHeaders.set(key, value);
      });
      requestInit = {
        ...init,
        headers: mergedHeaders,
        redirect: 'error',
      };
    }
    const response = await fetchFn(input, requestInit);

    return maxResponseBytes === undefined
      ? response
      : boundMcpResponse(response, maxResponseBytes);
  };
}

export interface ConnectMcpHttpClientOptions {
  headers?: Record<string, string>;
  callbackUrlReader?: OAuthCallbackUrlReader;
  authorizationOutput?: (message: string) => void;
  allowAuthorization?: boolean;
  profile?: string;
  clientName?: string;
  oauth?: McpOAuthConfig;
  connection?: McpConnectionConfig;
  environment?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

export interface McpRemoteConnection {
  transport: Transport;
  credentialGuard: McpCredentialGuard;
  terminateSession(): Promise<void>;
  close(): Promise<void>;
}

export interface McpHttpClientConnection extends McpRemoteConnection {
  client: Client;
}

export async function createMcpRemoteConnection(
  serverUrl: string,
  options: ConnectMcpHttpClientOptions = {},
): Promise<McpRemoteConnection> {
  const credentialValues = new Set<string>();
  const resolvedServerUrl = resolveMcpOAuthServerUrl(
    serverUrl,
    options.environment ?? process.env,
    credentialValues,
  );
  const headers = resolveMcpHeaderReferences(
    options.headers ?? {},
    options.environment,
  );
  for (const [key, value] of Object.entries(headers)) {
    if (UNSAFE_CONFIGURED_HEADERS[key.toLowerCase()]) continue;
    for (const reference of (options.headers?.[key] ?? '').matchAll(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    )) {
      const credential = (options.environment ?? process.env)[
        reference[1] as string
      ];
      if (credential) credentialValues.add(credential);
    }
    credentialValues.add(value);
    if (
      key.toLowerCase() === 'authorization' ||
      key.toLowerCase() === 'proxy-authorization'
    ) {
      const credentialComponent = /^\s*\S+\s+(.+?)\s*$/.exec(value)?.[1];
      if (credentialComponent) credentialValues.add(credentialComponent);
    }
  }
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const network = createMcpNetwork({
    serverUrl: resolvedServerUrl,
    ...(options.connection && { connection: options.connection }),
    ...(options.fetch && { fetch: options.fetch }),
    ...(options.environment && { environment: options.environment }),
    signal,
  });
  const safeFetch = createOriginSafeMcpFetch(
    resolvedServerUrl,
    headers,
    network.fetch,
    {
      ...(options.maxResponseBytes === undefined
        ? {}
        : { maxResponseBytes: options.maxResponseBytes }),
    },
  );
  const credentialGuard = createMcpCredentialGuard(credentialValues);
  try {
    const provider = await buildOAuthProvider(serverUrl, {
      ...(options.callbackUrlReader && {
        callbackUrlReader: options.callbackUrlReader,
      }),
      ...(options.authorizationOutput && {
        authorizationOutput: options.authorizationOutput,
      }),
      ...(options.allowAuthorization === undefined
        ? {}
        : { allowAuthorization: options.allowAuthorization }),
      ...(options.profile === undefined ? {} : { profile: options.profile }),
      ...(options.clientName === undefined
        ? {}
        : { clientName: options.clientName }),
      ...(options.oauth === undefined ? {} : { oauth: options.oauth }),
      ...(options.environment === undefined
        ? {}
        : { environment: options.environment }),
      ...(options.headers && { headers: options.headers }),
      fetch: safeFetch,
      signal,
      credentialValues,
    });
    const remote = new McpRemoteTransport(
      new URL(resolvedServerUrl),
      provider,
      provider.wrapFetch(safeFetch),
      credentialGuard,
      options.connection,
      signal,
    );
    const protocolTransport =
      options.connection?.protocol === 'auto'
        ? (await import('./mcp-protocol-era.js')).createMcpProtocolAdapter(
            remote,
            { mode: 'auto', signal },
          )
        : remote;
    const transport = createMcpToolFilterTransport(
      protocolTransport,
      options.connection?.ignoreTools,
    );
    let closePromise: Promise<void> | undefined;
    const onAbort = () => {
      void close().catch(() => {});
    };
    const close = (): Promise<void> => {
      closePromise ??= (async () => {
        signal.removeEventListener('abort', onAbort);
        controller.abort();
        try {
          await transport.close();
        } finally {
          provider.dispose();
          await network.close();
        }
      })();
      return closePromise;
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) await close();
    return {
      transport,
      credentialGuard,
      terminateSession: () => remote.terminateSession(),
      close,
    };
  } catch (error) {
    controller.abort();
    await network.close();
    throw mcpConnectionError(error, credentialGuard);
  }
}

export async function connectMcpHttpClient(
  serverUrl: string,
  options: ConnectMcpHttpClientOptions = {},
): Promise<McpHttpClientConnection> {
  const connection = await createMcpRemoteConnection(serverUrl, options);
  const client = new Client(
    { name: 'AllAgents', version: '1.0.0' },
    { capabilities: {} },
  );
  try {
    await client.connect(
      connection.transport,
      options.signal ? { signal: options.signal } : undefined,
    );
  } catch (error) {
    const sanitized = mcpConnectionError(error, connection.credentialGuard);
    try {
      await connection.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [sanitized, connection.credentialGuard.sanitizeError(cleanupError)],
        'MCP connection failed and its transport could not be closed',
      );
    }
    throw sanitized;
  }
  let closePromise: Promise<void> | undefined;
  return {
    ...connection,
    client,
    close: () => {
      closePromise ??= (async () => {
        try {
          await client.close();
        } finally {
          await connection.close();
        }
      })();
      return closePromise;
    },
  };
}

export interface ConnectHttpMcpServerOptions
  extends ConnectMcpHttpClientOptions {
  resetCredentials?: boolean;
}

export async function connectHttpMcpServer(
  serverUrl: string,
  options: ConnectHttpMcpServerOptions = {},
): Promise<void> {
  const cacheDir = getMcpOAuthCacheDir(
    serverUrl,
    options.profile,
    options.clientName,
    options.oauth,
    options.environment,
    options.headers,
  );
  const connect = async (): Promise<void> => {
    const backupDir = options.resetCredentials
      ? `${cacheDir}.reauth-backup-${randomUUID()}`
      : undefined;
    let hasBackup = false;

    if (backupDir) {
      try {
        await rename(cacheDir, backupDir);
        hasBackup = true;
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            error.code === 'ENOENT'
          )
        ) {
          throw error;
        }
      }
    }

    try {
      const connection = await connectMcpHttpClient(serverUrl, options);
      try {
        await connection.terminateSession();
      } finally {
        await connection.close();
      }
    } catch (error) {
      if (backupDir) {
        try {
          await rm(cacheDir, { recursive: true, force: true });
          if (hasBackup) await rename(backupDir, cacheDir);
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            'MCP reauthentication failed and the previous credentials could not be restored',
          );
        }
      }
      throw error;
    }

    if (hasBackup && backupDir) {
      await rm(backupDir, { recursive: true, force: true });
    }
  };
  if (options.resetCredentials) {
    await runWithMcpOAuthReset(cacheDir, connect, {
      ...(options.signal && { signal: options.signal }),
    });
  } else {
    await connect();
  }
}
