import { randomUUID } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  FetchLike,
  Transport,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  buildOAuthProvider,
  getMcpOAuthCacheDir,
  OAuthAuthorizationError,
  type OAuthCallbackUrlReader,
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
export type {
  OAuthCallbackRequest,
  OAuthCallbackUrlReader,
} from './mcp-oauth-provider.js';

const ENVIRONMENT_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const ENCODED_ENVIRONMENT_REFERENCE_PREFIX = /(?:\$|%24)(?:\{|%7b)/i;

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
      const reference = ENVIRONMENT_REFERENCE.exec(value);
      if (!reference) return [key, value];
      const variable = reference[1] as string;
      const resolved = environment[variable];
      if (resolved === undefined) {
        throw new Error(
          `MCP header '${key}' references missing environment variable '${variable}'`,
        );
      }
      return [key, resolved];
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
  environment?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

export interface McpHttpClientConnection {
  client: Client;
  transport: StreamableHTTPClientTransport;
  credentialGuard: McpCredentialGuard;
  close(): Promise<void>;
}

function resolveMcpQueryReferences(
  serverUrl: string,
  environment: NodeJS.ProcessEnv,
  credentialValues: Set<string>,
): string {
  if (
    !serverUrl.includes('${') &&
    !ENCODED_ENVIRONMENT_REFERENCE_PREFIX.test(serverUrl)
  ) {
    return serverUrl;
  }

  const url = new URL(serverUrl);
  let changed = false;
  const query = url.search
    .slice(1)
    .split('&')
    .map((parameter) => {
      const separator = parameter.indexOf('=');
      if (separator === -1) return parameter;
      const value = new URLSearchParams(parameter).values().next().value ?? '';
      const reference = ENVIRONMENT_REFERENCE.exec(value);
      if (!reference) return parameter;

      const variable = reference[1] as string;
      const resolved = environment[variable];
      if (resolved === undefined) {
        throw new Error(
          `MCP URL query parameter references missing environment variable '${variable}'`,
        );
      }
      const encoded = encodeURIComponent(resolved);
      credentialValues.add(resolved);
      credentialValues.add(encoded);
      // HTTP URL serialization additionally percent-encodes apostrophes.
      credentialValues.add(encoded.replaceAll("'", '%27'));
      changed = true;
      return `${parameter.slice(0, separator + 1)}${encoded}`;
    })
    .join('&');
  if (!changed) return serverUrl;
  url.search = query;
  return url.toString();
}

export async function connectMcpHttpClient(
  serverUrl: string,
  options: ConnectMcpHttpClientOptions = {},
): Promise<McpHttpClientConnection> {
  const credentialValues = new Set<string>();
  const resolvedServerUrl = resolveMcpQueryReferences(
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
    credentialValues.add(value);
    if (
      key.toLowerCase() === 'authorization' ||
      key.toLowerCase() === 'proxy-authorization'
    ) {
      const credentialComponent = /^\s*\S+\s+(.+?)\s*$/.exec(value)?.[1];
      if (credentialComponent) credentialValues.add(credentialComponent);
    }
  }
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
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    credentialValues,
  });
  const client = new Client(
    {
      name: 'AllAgents',
      version: '1.0.0',
    },
    { capabilities: {} },
  );
  const buildTransport = () => {
    const mcpFetch =
      Object.keys(headers).length > 0 ||
      options.fetch ||
      options.maxResponseBytes !== undefined
        ? createOriginSafeMcpFetch(resolvedServerUrl, headers, options.fetch, {
            ...(options.maxResponseBytes === undefined
              ? {}
              : { maxResponseBytes: options.maxResponseBytes }),
          })
        : undefined;
    return new StreamableHTTPClientTransport(new URL(resolvedServerUrl), {
      authProvider: provider,
      ...(mcpFetch && { fetch: mcpFetch }),
    });
  };

  let transport = buildTransport();
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= client.close();
    return closePromise;
  };

  try {
    try {
      await client.connect(
        transport as unknown as Transport,
        options.signal === undefined ? undefined : { signal: options.signal },
      );
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
      if (options.signal?.aborted) throw error;
      const authorizationCode = await provider.waitForAuthCode();
      await transport.finishAuth(authorizationCode);
      await transport.close();
      transport = buildTransport();
      await client.connect(
        transport as unknown as Transport,
        options.signal === undefined ? undefined : { signal: options.signal },
      );
    }
  } catch (error) {
    const credentialGuard = createMcpCredentialGuard(credentialValues);
    const sanitizedError = credentialGuard.sanitizeError(error);
    const connectionError = isMcpAuthorizationFailure(error)
      ? new UnauthorizedError(sanitizedError.message)
      : sanitizedError;
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [connectionError, credentialGuard.sanitizeError(cleanupError)],
        'MCP connection failed and its transport could not be closed',
      );
    }
    throw connectionError;
  }

  return {
    client,
    transport,
    credentialGuard: createMcpCredentialGuard(credentialValues),
    close,
  };
}

export interface ConnectHttpMcpServerOptions {
  headers?: Record<string, string>;
  callbackUrlReader?: OAuthCallbackUrlReader;
  authorizationOutput?: (message: string) => void;
  resetCredentials?: boolean;
  allowAuthorization?: boolean;
  profile?: string;
  clientName?: string;
  signal?: AbortSignal;
}

export async function connectHttpMcpServer(
  serverUrl: string,
  options: ConnectHttpMcpServerOptions = {},
): Promise<void> {
  const cacheDir = getMcpOAuthCacheDir(
    serverUrl,
    options.profile,
    options.clientName,
  );
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
        !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
      ) {
        throw error;
      }
    }
  }

  try {
    const connection = await connectMcpHttpClient(serverUrl, options);
    try {
      await connection.transport.terminateSession();
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
}
