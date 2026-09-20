import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { dirname, join } from 'node:path';
import {
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  UnauthorizedError,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type {
  FetchLike,
  Transport,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import { getHomeDir } from '../constants.js';
import { ProfileNameSchema } from '../models/workspace-config.js';

const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
export const AUTH_URL_LOG_PREFIX = 'If the browser does not open, visit: ';

const ENVIRONMENT_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

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

export interface OAuthCallbackRequest {
  authorizationUrl: URL;
  redirectUrl: string;
  state: string;
  signal: AbortSignal;
}

export type OAuthCallbackUrlReader = (
  request: OAuthCallbackRequest,
) => Promise<string>;

type ParsedOAuthCallback =
  | { code: string; authorizationError?: never }
  | { code?: never; authorizationError: true };

export class OAuthAuthorizationError extends Error {
  constructor() {
    super('OAuth authorization failed');
    this.name = 'OAuthAuthorizationError';
  }
}

function parseOAuthCallbackResponse(
  callbackUrl: string,
  redirectUrl: string,
  expectedState: string,
): ParsedOAuthCallback {
  let callback: URL;
  try {
    callback = new URL(callbackUrl.trim());
  } catch {
    throw new Error('Invalid OAuth callback URL');
  }

  const expected = new URL(redirectUrl);
  if (
    callback.username ||
    callback.password ||
    callback.origin !== expected.origin ||
    callback.pathname !== expected.pathname ||
    callback.hash
  ) {
    throw new Error(
      'OAuth callback URL does not match the registered redirect',
    );
  }

  const states = callback.searchParams.getAll('state');
  if (states.length !== 1 || states[0] !== expectedState) {
    throw new Error('OAuth state validation failed');
  }

  const errors = callback.searchParams.getAll('error');
  const codes = callback.searchParams.getAll('code');
  if (errors.length === 1 && errors[0] && codes.length === 0) {
    return { authorizationError: true };
  }
  if (errors.length > 0) {
    throw new Error('Invalid OAuth authorization response');
  }
  if (codes.length !== 1 || !codes[0]) {
    throw new Error('No OAuth authorization code received');
  }
  return { code: codes[0] };
}

export function validateOAuthCallbackUrl(
  callbackUrl: string,
  redirectUrl: string,
  expectedState: string,
): void {
  parseOAuthCallbackResponse(callbackUrl, redirectUrl, expectedState);
}

export function parseOAuthCallbackUrl(
  callbackUrl: string,
  redirectUrl: string,
  expectedState: string,
): string {
  const callback = parseOAuthCallbackResponse(
    callbackUrl,
    redirectUrl,
    expectedState,
  );
  if (callback.authorizationError) {
    throw new OAuthAuthorizationError();
  }
  return callback.code;
}

export function hashServerUrl(serverUrl: string): string {
  return createHash('sha256').update(serverUrl).digest('hex').slice(0, 16);
}

export function getMcpOAuthCacheDir(
  serverUrl: string,
  profile?: string,
): string {
  const hash = hashServerUrl(serverUrl);
  if (!profile) {
    return join(getHomeDir(), '.allagents', 'oauth-proxy', hash);
  }
  return join(
    getHomeDir(),
    '.allagents',
    'profiles',
    ProfileNameSchema.parse(profile),
    'oauth-proxy',
    hash,
  );
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
      throw new Error(
        `MCP HTTP SSE event exceeds ${maxResponseBytes} bytes`,
      );
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  if (!(await pathExists(path))) {
    return undefined;
  }
  return JSON.parse(await readFile(path, 'utf-8')) as T;
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, content, { encoding: 'utf-8', mode: 0o600 });
}

function parseLoopbackPort(
  clientInfo?: OAuthClientInformationMixed,
): number | undefined {
  const redirectUri =
    clientInfo && 'redirect_uris' in clientInfo
      ? clientInfo.redirect_uris?.[0]
      : undefined;
  if (!redirectUri) {
    return undefined;
  }

  try {
    const parsed = new URL(redirectUri);
    if (
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
      parsed.port
    ) {
      return Number(parsed.port);
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port =
        typeof address === 'object' && address ? address.port : undefined;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!port) {
          reject(new Error('Failed to determine a free loopback port'));
          return;
        }
        resolve(port);
      });
    });
  });
}

export function getBrowserOpenCommands(
  url: string,
  platform: NodeJS.Platform = process.platform,
): Array<{ command: string; args: string[] }> {
  return platform === 'darwin'
    ? [{ command: 'open', args: [url] }]
    : platform === 'win32'
      ? [{ command: 'explorer.exe', args: [url] }]
      : [
          { command: 'xdg-open', args: [url] },
          { command: 'gio', args: ['open', url] },
        ];
}

function tryOpenBrowser(url: string): Promise<void> {
  const commands = getBrowserOpenCommands(url);

  return new Promise((resolve) => {
    const tryCommand = (index: number) => {
      if (index >= commands.length) {
        resolve();
        return;
      }

      const entry = commands[index];
      if (!entry) {
        resolve();
        return;
      }
      const { command, args } = entry;
      const child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
      });
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
      child.once('error', () => {
        tryCommand(index + 1);
      });
    };

    tryCommand(0);
  });
}

interface OAuthProviderOptions {
  callbackUrlReader?: OAuthCallbackUrlReader;
  authorizationOutput?: (message: string) => void;
  allowAuthorization?: boolean;
  profile?: string;
  credentialValues?: Set<string>;
}

class FileOAuthClientProvider implements OAuthClientProvider {
  private readonly clientInfoPath: string;
  private readonly tokensPath: string;
  private readonly verifierPath: string;
  private readonly discoveryPath: string;
  private readonly redirectUriValue: string;
  private clientInfo: OAuthClientInformationMixed | undefined = undefined;
  private tokenSet: OAuthTokens | undefined = undefined;
  private discovery: OAuthDiscoveryState | undefined = undefined;
  private codeVerifierValue: string | undefined = undefined;
  private pendingAuth: Promise<string> | undefined = undefined;
  private authorizationUnavailable = false;
  private readonly callbackUrlReader: OAuthCallbackUrlReader | undefined;
  private readonly authorizationOutput: (message: string) => void;
  private readonly allowAuthorization: boolean;
  private readonly credentialValues: Set<string>;
  private readonly stateValue = randomUUID();

  constructor(
    private readonly port: number,
    serverUrl: string,
    options: OAuthProviderOptions = {},
  ) {
    const cacheDir = getMcpOAuthCacheDir(serverUrl, options.profile);
    this.clientInfoPath = join(cacheDir, 'client-info.json');
    this.tokensPath = join(cacheDir, 'tokens.json');
    this.verifierPath = join(cacheDir, 'code-verifier.txt');
    this.discoveryPath = join(cacheDir, 'discovery.json');
    this.redirectUriValue = `http://127.0.0.1:${port}/callback`;
    this.callbackUrlReader = options.callbackUrlReader;
    this.authorizationOutput = options.authorizationOutput ?? console.error;
    this.allowAuthorization = options.allowAuthorization ?? true;
    this.credentialValues = options.credentialValues ?? new Set();
  }

  get redirectUrl(): string {
    return this.redirectUriValue;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'AllAgents',
      redirect_uris: [this.redirectUriValue],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  state(): string {
    return this.stateValue;
  }

  async load(): Promise<void> {
    this.clientInfo = await readJsonFile<OAuthClientInformationMixed>(
      this.clientInfoPath,
    );
    this.tokenSet = await readJsonFile<OAuthTokens>(this.tokensPath);
    this.discovery = await readJsonFile<OAuthDiscoveryState>(
      this.discoveryPath,
    );
    if (await pathExists(this.verifierPath)) {
      this.codeVerifierValue = await readFile(this.verifierPath, 'utf-8');
    }
    const clientSecret = (
      this.clientInfo as (OAuthClientInformationMixed & { client_secret?: string }) | undefined
    )?.client_secret;
    if (clientSecret) this.credentialValues.add(clientSecret);
    if (this.tokenSet?.access_token) {
      this.credentialValues.add(this.tokenSet.access_token);
    }
    if (this.tokenSet?.refresh_token) {
      this.credentialValues.add(this.tokenSet.refresh_token);
    }
    if (this.codeVerifierValue) {
      this.credentialValues.add(this.codeVerifierValue);
    }
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.clientInfo;
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformationMixed,
  ): Promise<void> {
    this.clientInfo = clientInformation;
    const clientSecret = (
      clientInformation as OAuthClientInformationMixed & {
        client_secret?: string;
      }
    ).client_secret;
    if (clientSecret) this.credentialValues.add(clientSecret);
    await writePrivateFile(
      this.clientInfoPath,
      `${JSON.stringify(clientInformation, null, 2)}\n`,
    );
  }

  tokens(): OAuthTokens | undefined {
    return this.tokenSet;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.tokenSet = tokens;
    this.credentialValues.add(tokens.access_token);
    if (tokens.refresh_token) this.credentialValues.add(tokens.refresh_token);
    await writePrivateFile(
      this.tokensPath,
      `${JSON.stringify(tokens, null, 2)}\n`,
    );
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    if (!this.allowAuthorization) {
      this.authorizationUnavailable = true;
      return;
    }
    this.pendingAuth ??= this.waitForAuthorizationCode(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.codeVerifierValue = codeVerifier;
    this.credentialValues.add(codeVerifier);
    await writePrivateFile(this.verifierPath, codeVerifier);
  }

  codeVerifier(): string {
    if (!this.codeVerifierValue) {
      throw new Error('No OAuth code verifier is available');
    }
    return this.codeVerifierValue;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    this.discovery = state;
    await writePrivateFile(
      this.discoveryPath,
      `${JSON.stringify(state, null, 2)}\n`,
    );
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    const removals =
      scope === 'all'
        ? [
            this.clientInfoPath,
            this.tokensPath,
            this.verifierPath,
            this.discoveryPath,
          ]
        : scope === 'client'
          ? [this.clientInfoPath]
          : scope === 'tokens'
            ? [this.tokensPath]
            : scope === 'verifier'
              ? [this.verifierPath]
              : [this.discoveryPath];

    await Promise.all(removals.map((path) => rm(path, { force: true })));
  }

  async waitForAuthCode(): Promise<string> {
    if (this.authorizationUnavailable) {
      throw new Error('OAuth authorization requires an interactive terminal');
    }
    if (!this.pendingAuth) {
      throw new Error('OAuth authorization has not been started');
    }
    const code = await this.pendingAuth;
    this.credentialValues.add(code);
    return code;
  }

  private waitForAuthorizationCode(authorizationUrl: URL): Promise<string> {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const readerAbortController = new AbortController();
    let settled = false;
    const settle = (
      outcome: 'resolve' | 'reject',
      value: string | Error,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      readerAbortController.abort();
      if (server.listening) server.close();
      if (outcome === 'resolve') {
        resolve(value as string);
      } else {
        reject(value as Error);
      }
    };
    const acceptCallback = (callbackUrl: string): void => {
      try {
        settle(
          'resolve',
          parseOAuthCallbackUrl(
            callbackUrl,
            this.redirectUriValue,
            this.stateValue,
          ),
        );
      } catch (error) {
        settle(
          'reject',
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    };
    const server = createServer(
      (request: IncomingMessage, response: ServerResponse) => {
        try {
          const callbackUrl = new URL(
            request.url ?? '/',
            this.redirectUriValue,
          ).toString();
          const code = parseOAuthCallbackUrl(
            callbackUrl,
            this.redirectUriValue,
            this.stateValue,
          );
          response.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
          });
          response.end(
            '<html><body><h1>Authorization complete</h1><p>You can close this window.</p></body></html>',
          );
          settle('resolve', code);
        } catch (error) {
          response.writeHead(400, {
            'content-type': 'text/html; charset=utf-8',
          });
          response.end(
            '<html><body><h1>Authorization failed</h1><p>The OAuth response was rejected.</p></body></html>',
          );
          settle(
            'reject',
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      },
    );
    const timeout = setTimeout(() => {
      settle(
        'reject',
        new Error('Timed out waiting for OAuth authorization callback'),
      );
    }, AUTH_TIMEOUT_MS);
    server.on('error', (error) => settle('reject', error));
    server.listen(this.port, '127.0.0.1', () => {
      this.authorizationOutput('Opening browser for authorization...');
      this.authorizationOutput(
        `${AUTH_URL_LOG_PREFIX}${authorizationUrl.toString()}`,
      );
      this.authorizationOutput(
        this.callbackUrlReader
          ? 'Using a remote browser? Paste its callback URL in this terminal.'
          : 'Using a remote browser? Run `allagents mcp reauth <name>` in this workspace, then reconnect.',
      );
      // Test-only escape hatch: e2e tests fetch the URL themselves against a local
      // dummy IdP, and skipping the real OS browser-open avoids ever launching one.
      if (process.env.ALLAGENTS_MCP_OAUTH_NO_BROWSER === '1') {
        this.authorizationOutput(
          'Skipping automatic browser open (ALLAGENTS_MCP_OAUTH_NO_BROWSER=1).',
        );
      } else {
        void tryOpenBrowser(authorizationUrl.toString());
      }
      if (this.callbackUrlReader) {
        void this.callbackUrlReader({
          authorizationUrl,
          redirectUrl: this.redirectUriValue,
          state: this.stateValue,
          signal: readerAbortController.signal,
        })
          .then(acceptCallback)
          .catch((error) => {
            if (readerAbortController.signal.aborted) return;
            settle(
              'reject',
              error instanceof Error ? error : new Error(String(error)),
            );
          });
      }
    });
    return promise;
  }
}

async function buildOAuthProvider(
  serverUrl: string,
  options: OAuthProviderOptions = {},
): Promise<FileOAuthClientProvider> {
  const cacheDir = getMcpOAuthCacheDir(serverUrl, options.profile);
  const cachedClientInfo = await readJsonFile<OAuthClientInformationMixed>(
    join(cacheDir, 'client-info.json'),
  );

  let port = parseLoopbackPort(cachedClientInfo);
  if (!port) {
    port = await findFreePort();
  }

  const provider = new FileOAuthClientProvider(port, serverUrl, options);
  await provider.load();
  return provider;
}

export interface ConnectMcpHttpClientOptions {
  headers?: Record<string, string>;
  callbackUrlReader?: OAuthCallbackUrlReader;
  authorizationOutput?: (message: string) => void;
  allowAuthorization?: boolean;
  profile?: string;
  environment?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  maxResponseBytes?: number;
}

export interface McpHttpClientConnection {
  client: Client;
  transport: StreamableHTTPClientTransport;
  credentialGuard: McpCredentialGuard;
  close(): Promise<void>;
}

export async function connectMcpHttpClient(
  serverUrl: string,
  options: ConnectMcpHttpClientOptions = {},
): Promise<McpHttpClientConnection> {
  const credentialValues = new Set<string>();
  const headers = resolveMcpHeaderReferences(
    options.headers ?? {},
    options.environment,
  );
  for (const [key, value] of Object.entries(headers)) {
    if (!UNSAFE_CONFIGURED_HEADERS[key.toLowerCase()]) {
      credentialValues.add(value);
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
        ? createOriginSafeMcpFetch(serverUrl, headers, options.fetch, {
            ...(options.maxResponseBytes === undefined
              ? {}
              : { maxResponseBytes: options.maxResponseBytes }),
          })
        : undefined;
    return new StreamableHTTPClientTransport(new URL(serverUrl), {
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
      await client.connect(transport as unknown as Transport);
    } catch (error) {
      if (!(error instanceof UnauthorizedError)) throw error;
      const authorizationCode = await provider.waitForAuthCode();
      await transport.finishAuth(authorizationCode);
      await transport.close();
      transport = buildTransport();
      await client.connect(transport as unknown as Transport);
    }
  } catch (error) {
    const credentialGuard = createMcpCredentialGuard(credentialValues);
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [
          credentialGuard.sanitizeError(error),
          credentialGuard.sanitizeError(cleanupError),
        ],
        'MCP connection failed and its transport could not be closed',
      );
    }
    throw credentialGuard.sanitizeError(error);
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
}

export async function connectHttpMcpServer(
  serverUrl: string,
  options: ConnectHttpMcpServerOptions = {},
): Promise<void> {
  const cacheDir = getMcpOAuthCacheDir(serverUrl, options.profile);
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
