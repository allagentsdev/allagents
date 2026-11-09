import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, readFile, rm } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { join } from 'node:path';
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { selectClientAuthMethod } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { OAuthTokensSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { getHomeDir } from '../constants.js';
import {
  type McpOAuthConfig,
  McpOAuthConfigSchema,
} from '../models/mcp-options.js';
import { ProfileNameSchema } from '../models/workspace-config.js';
import {
  oauthAuthorizationLockPath,
  oauthTokenLockPath,
  readOAuthGeneration,
  readOAuthJson,
  waitForOAuth,
  withOAuthLock,
  writeOAuthFile,
} from './mcp-oauth-storage.js';

export { runWithMcpOAuthReset } from './mcp-oauth-storage.js';

import { resolveMcpOAuthServerUrl } from './mcp-oauth-url.js';

export { resolveMcpOAuthServerUrl } from './mcp-oauth-url.js';

const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_OAUTH_CLIENT_NAME = 'AllAgents';
const DeviceAuthorizationSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.url(),
  verification_uri_complete: z.url().optional(),
  expires_in: z.number().finite().positive(),
  interval: z.number().finite().nonnegative().optional(),
});
export const AUTH_URL_LOG_PREFIX = 'If the browser does not open, visit: ';

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
  constructor(message = 'OAuth authorization failed') {
    super(message);
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

function resolveOAuthClientName(clientName?: string): string {
  if (clientName === undefined) return DEFAULT_OAUTH_CLIENT_NAME;
  const resolved = clientName.trim();
  if (!resolved) throw new Error('OAuth client name must not be empty');
  return resolved;
}

export function getMcpOAuthCacheDir(
  serverUrl: string,
  profile?: string,
  clientName?: string,
  oauth?: McpOAuthConfig,
  environment: NodeJS.ProcessEnv = process.env,
  headers?: Record<string, string>,
): string {
  const effectiveClientName = resolveOAuthClientName(
    oauth?.clientName ??
      clientName ??
      (typeof oauth?.clientMetadata?.client_name === 'string'
        ? oauth.clientMetadata.client_name
        : undefined),
  );
  // Query credential references are an authored workspace identity: rotating
  // their values must reuse the existing grant and reauthorization destination.
  // A whole-URL reference can select a different server, so scope it by value.
  const serverHash = hashServerUrl(
    /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(serverUrl)
      ? resolveMcpOAuthServerUrl(serverUrl, environment)
      : serverUrl,
  );
  // Keep the legacy default location and place aliases beside it, so resetting
  // one identity never removes credentials belonging to another identity.
  let hash =
    effectiveClientName === DEFAULT_OAUTH_CLIENT_NAME
      ? serverHash
      : `${serverHash}-client-${createHash('sha256')
          .update(effectiveClientName)
          .digest('hex')}`;
  const identity = { ...oauth };
  delete identity.clientName;
  delete identity.allowHttp;
  if (identity.clientId)
    identity.clientId = expandOAuthValue(identity.clientId, environment);
  if (identity.grantType === 'authorization_code') delete identity.grantType;
  if (identity.useIdToken === false) delete identity.useIdToken;
  if (identity.disableResourceParameter === false)
    delete identity.disableResourceParameter;
  if (identity.callback) {
    const { port, host, path } = identity.callback;
    identity.callback = {
      ...(port === undefined ? {} : { port }),
      ...(host === undefined ? {} : { host }),
      ...(path === undefined ? {} : { path }),
    };
    if (!Object.keys(identity.callback).length) delete identity.callback;
  }
  if (identity.clientMetadata) {
    identity.clientMetadata = { ...identity.clientMetadata };
    delete identity.clientMetadata.client_name;
    if (!Object.keys(identity.clientMetadata).length)
      delete identity.clientMetadata;
  }
  const resolvedHeaders = new Headers();
  for (const [name, value] of Object.entries(headers ?? {})) {
    resolvedHeaders.set(
      name,
      value.replace(
        /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
        (_, variable: string) => {
          const resolved = environment[variable];
          if (resolved === undefined)
            throw new Error(
              `Missing MCP header environment variable: ${variable}`,
            );
          return resolved;
        },
      ),
    );
  }
  const cacheIdentity = {
    ...identity,
    ...(Array.from(resolvedHeaders.keys()).length
      ? { headers: Object.fromEntries(resolvedHeaders.entries()) }
      : {}),
  };
  if (Object.keys(cacheIdentity).length) {
    const stable = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(stable)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, child]) => [key, stable(child)]),
            )
          : value;
    hash += `-options-${createHash('sha256')
      .update(JSON.stringify(stable(cacheIdentity)))
      .digest('hex')}`;
  }
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const readJsonFile = readOAuthJson;
const writePrivateFile = writeOAuthFile;

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
      ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) &&
      parsed.port
    ) {
      return Number(parsed.port);
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function findFreePort(
  requestedPort = 0,
  bindHost = '127.0.0.1',
): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(requestedPort, bindHost, () => {
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

export interface OAuthProviderOptions {
  callbackUrlReader?: OAuthCallbackUrlReader;
  authorizationOutput?: (message: string) => void;
  allowAuthorization?: boolean;
  profile?: string;
  clientName?: string;
  credentialValues?: Set<string>;
  signal?: AbortSignal;
  oauth?: McpOAuthConfig;
  environment?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  headers?: Record<string, string>;
}

function expandOAuthValue(
  value: string,
  environment: NodeJS.ProcessEnv,
): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const resolved = environment[name];
    if (!resolved)
      throw new Error(`Missing OAuth environment variable: ${name}`);
    return resolved;
  });
}

function validateOAuthDestination(
  value: string,
  kind: 'success' | 'token',
  allowHttp = false,
): void {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.hash ||
    (kind === 'success' && url.search) ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && (loopback || allowHttp)))
  )
    throw new Error(`Invalid OAuth ${kind} URL`);
}

function metadataRedirect(oauth?: McpOAuthConfig): URL | undefined {
  if (
    oauth?.grantType === 'client_credentials' ||
    oauth?.grantType === 'device_code'
  )
    return undefined;
  const redirects = oauth?.clientMetadata?.redirect_uris;
  if (redirects === undefined) return undefined;
  if (
    !Array.isArray(redirects) ||
    !redirects.length ||
    redirects.some((uri) => typeof uri !== 'string')
  )
    throw new Error('OAuth client metadata requires valid redirect URIs');
  for (const uri of redirects) {
    const parsed = new URL(uri);
    if (
      parsed.protocol !== 'http:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new Error(
        'OAuth callback metadata requires an HTTP redirect without credentials, query or fragment',
      );
    const callback = oauth?.callback;
    if (callback?.port && Number(parsed.port || 80) !== callback.port) continue;
    if (
      callback?.host &&
      parsed.hostname !== callback.host &&
      parsed.hostname !== `[${callback.host}]`
    )
      continue;
    if (callback?.path && parsed.pathname !== callback.path) continue;
    return parsed;
  }
  throw new Error(
    'OAuth callback settings do not match client metadata redirect URIs',
  );
}

function tokenSetKey(tokens: OAuthTokens): string {
  return JSON.stringify([
    tokens.access_token,
    tokens.refresh_token,
    tokens.id_token,
  ]);
}

function idTokenExpiry(token: string): number {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString(),
    ) as { exp?: number };
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp))
      throw new Error();
    return payload.exp * 1000;
  } catch {
    throw new Error('OAuth ID token does not contain a valid expiry');
  }
}

export class FileOAuthClientProvider implements OAuthClientProvider {
  private readonly clientInfoPath: string;
  private readonly tokensPath: string;
  private readonly verifierPath: string;
  private readonly discoveryPath: string;
  private redirectUriValue: string;
  private readonly clientName: string;
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
  private readonly signal: AbortSignal | undefined;
  private stateValue = randomUUID();
  private readonly oauth: McpOAuthConfig;
  private readonly cacheDir: string;
  private readonly controller = new AbortController();
  private readonly environment: NodeJS.ProcessEnv;
  private readonly fetchFn: FetchLike;
  private callbackResponse: ServerResponse | undefined;
  private cancelCallback: (() => void) | undefined;
  private deviceExpiresAt = 0;
  private deviceIntervalMs = 5000;
  private tokenExpiresAt: number | undefined;
  private readonly externalAbort: () => void;
  private readonly issuedTokenSets = new Map<string, string>();
  private cacheGeneration = '';
  private challengedScope: string | undefined;

  constructor(
    private port: number,
    private readonly serverUrl: string,
    options: OAuthProviderOptions = {},
  ) {
    this.oauth = McpOAuthConfigSchema.parse(options.oauth ?? {});
    for (const key of Object.keys(this.oauth.authorizationParams ?? {})) {
      if (
        [
          'code',
          'client_secret',
          'access_token',
          'refresh_token',
          'id_token',
          'token',
        ].includes(key.toLowerCase())
      )
        throw new Error(
          'OAuth authorization parameters cannot contain credentials',
        );
    }
    this.environment = options.environment ?? process.env;
    this.credentialValues = options.credentialValues ?? new Set();
    this.serverUrl = resolveMcpOAuthServerUrl(
      serverUrl,
      this.environment,
      this.credentialValues,
    );
    if (this.oauth.clientMetadataUrl)
      this.clientMetadataUrl = this.oauth.clientMetadataUrl;
    this.clientName = resolveOAuthClientName(
      this.oauth.clientName ??
        options.clientName ??
        (typeof this.oauth.clientMetadata?.client_name === 'string'
          ? this.oauth.clientMetadata.client_name
          : undefined),
    );
    const cacheDir = getMcpOAuthCacheDir(
      serverUrl,
      options.profile,
      this.clientName,
      this.oauth,
      this.environment,
      options.headers,
    );
    this.cacheDir = cacheDir;
    this.clientInfoPath = join(cacheDir, 'client-info.json');
    this.tokensPath = join(cacheDir, 'tokens.json');
    this.verifierPath = join(cacheDir, 'code-verifier.txt');
    this.discoveryPath = join(cacheDir, 'discovery.json');
    const configuredRedirect = metadataRedirect(this.oauth);
    const host =
      this.oauth.callback?.host ?? configuredRedirect?.hostname ?? '127.0.0.1';
    this.redirectUriValue = `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}${this.oauth.callback?.path ?? configuredRedirect?.pathname ?? '/callback'}`;
    const redirect = new URL(this.redirectUriValue);
    if (
      redirect.username ||
      redirect.password ||
      redirect.hash ||
      redirect.search
    )
      throw new Error('Invalid OAuth callback address');
    if (this.oauth.callback?.successUrl)
      validateOAuthDestination(
        this.oauth.callback.successUrl,
        'success',
        this.oauth.allowHttp,
      );
    if (this.oauth.tokenEndpoint)
      validateOAuthDestination(
        this.oauth.tokenEndpoint,
        'token',
        this.oauth.allowHttp,
      );
    if (
      this.oauth.disableResourceParameter ||
      this.oauth.resource !== undefined ||
      this.oauth.tokenEndpoint
    ) {
      this.validateResourceURL = async () =>
        this.oauth.disableResourceParameter || !this.oauth.resource
          ? undefined
          : new URL(this.oauth.resource);
    }
    this.callbackUrlReader = options.callbackUrlReader;
    this.authorizationOutput = options.authorizationOutput ?? console.error;
    this.allowAuthorization = options.allowAuthorization ?? true;
    this.signal = this.controller.signal;
    this.externalAbort = () =>
      this.controller.abort(
        options.signal?.reason ?? new Error('MCP connection was cancelled'),
      );
    if (options.signal?.aborted) this.externalAbort();
    else
      options.signal?.addEventListener('abort', this.externalAbort, {
        once: true,
      });
    this.controller.signal.addEventListener(
      'abort',
      () => options.signal?.removeEventListener('abort', this.externalAbort),
      { once: true },
    );
    this.fetchFn = this.wrapFetch(options.fetch ?? fetch);
  }

  get redirectUrl(): string | undefined {
    return this.oauth.grantType === 'client_credentials' ||
      this.oauth.grantType === 'device_code'
      ? undefined
      : this.redirectUriValue;
  }

  readonly clientMetadataUrl?: string;

  get clientMetadata(): OAuthClientMetadata {
    const metadata = {
      redirect_uris: this.redirectUrl ? [this.redirectUriValue] : [],
      grant_types:
        this.oauth.grantType === 'client_credentials'
          ? ['client_credentials']
          : this.oauth.grantType === 'device_code'
            ? ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token']
            : ['authorization_code', 'refresh_token'],
      response_types: this.redirectUrl ? ['code'] : [],
      token_endpoint_auth_method: this.oauth.clientSecret
        ? 'client_secret_basic'
        : 'none',
      ...this.oauth.clientMetadata,
      client_name: this.clientName,
      ...(this.oauth.scope !== undefined ? { scope: this.oauth.scope } : {}),
    } as OAuthClientMetadata;
    if (
      this.oauth.useIdToken &&
      !metadata.scope?.split(/\s+/).includes('openid')
    )
      metadata.scope = ['openid', metadata.scope].filter(Boolean).join(' ');
    return metadata;
  }

  state(): string {
    return this.stateValue;
  }

  async load(): Promise<void> {
    return withOAuthLock(
      oauthAuthorizationLockPath(this.cacheDir),
      this.controller.signal,
      this.authorizationTimeoutMs,
      () => this.loadCache(),
    );
  }

  private async loadCache(): Promise<void> {
    this.cacheGeneration = await readOAuthGeneration(this.cacheDir);
    this.clientInfo = await readJsonFile<OAuthClientInformationMixed>(
      this.clientInfoPath,
    );
    const registeredPort = parseLoopbackPort(this.clientInfo);
    if (registeredPort && !this.oauth.callback?.port && !this.pendingAuth) {
      this.port = registeredPort;
      const redirect = new URL(this.redirectUriValue);
      redirect.port = String(registeredPort);
      this.redirectUriValue = redirect.toString();
    }
    const stored = await readJsonFile<OAuthTokens & { expires_at?: number }>(
      this.tokensPath,
    );
    this.tokenSet = stored ? OAuthTokensSchema.parse(stored) : undefined;
    this.tokenExpiresAt = stored?.expires_at;
    if (this.oauth.useIdToken && stored?.id_token)
      this.tokenExpiresAt = idTokenExpiry(stored.id_token);
    this.discovery = await readJsonFile<OAuthDiscoveryState>(
      this.discoveryPath,
    );
    this.codeVerifierValue = undefined;
    if (await pathExists(this.verifierPath)) {
      this.codeVerifierValue = await readFile(this.verifierPath, 'utf-8');
    }
    if (this.oauth.clientId)
      this.clientInfo = {
        ...this.clientInfo,
        client_id: expandOAuthValue(this.oauth.clientId, this.environment),
        ...(this.oauth.issuer ? { issuer: this.oauth.issuer } : {}),
        ...(this.oauth.clientSecret
          ? {
              client_secret: expandOAuthValue(
                this.oauth.clientSecret,
                this.environment,
              ),
            }
          : {}),
      };
    if (this.oauth.tokenEndpoint) {
      const issuer =
        this.oauth.issuer ?? new URL(this.oauth.tokenEndpoint).origin;
      this.discovery = {
        authorizationServerUrl: issuer,
        resourceMetadata: {
          resource: this.serverUrl,
          authorization_servers: [issuer],
        },
        authorizationServerMetadata: {
          issuer,
          // The SDK metadata shape requires this field. Machine grants only
          // use token_endpoint and never visit an authorization endpoint.
          authorization_endpoint: this.oauth.tokenEndpoint,
          token_endpoint: this.oauth.tokenEndpoint,
          response_types_supported: [],
          grant_types_supported: ['client_credentials'],
          token_endpoint_auth_methods_supported: [
            this.clientMetadata.token_endpoint_auth_method ?? 'none',
          ],
        },
      };
    }
    const clientSecret = (
      this.clientInfo as
        | (OAuthClientInformationMixed & { client_secret?: string })
        | undefined
    )?.client_secret;
    if (clientSecret) this.credentialValues.add(clientSecret);
    if (this.tokenSet?.access_token) {
      this.credentialValues.add(this.tokenSet.access_token);
    }
    if (this.tokenSet?.id_token)
      this.credentialValues.add(this.tokenSet.id_token);
    if (this.tokenSet?.refresh_token) {
      this.credentialValues.add(this.tokenSet.refresh_token);
    }
    if (this.codeVerifierValue) {
      this.credentialValues.add(this.codeVerifierValue);
    }
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (
      this.oauth.clientId &&
      this.oauth.issuer &&
      this.discovery?.authorizationServerUrl &&
      this.oauth.issuer !== this.discovery.authorizationServerUrl
    )
      throw new OAuthAuthorizationError(
        'Configured OAuth client issuer does not match the discovered authorization server',
      );
    return this.clientInfo;
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformationMixed,
  ): Promise<void> {
    return this.mutateCache(async () => {
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
    });
  }

  tokens(): OAuthTokens | undefined {
    if (!this.tokenSet || !this.oauth.useIdToken) return this.tokenSet;
    if (!this.tokenSet.id_token)
      throw new Error('OAuth response does not contain an ID token');
    return { ...this.tokenSet, access_token: this.tokenSet.id_token };
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    return this.mutateCache(async () => {
      await withOAuthLock(
        oauthTokenLockPath(this.cacheDir),
        this.controller.signal,
        this.authorizationTimeoutMs,
        async () => {
          const stored = await readJsonFile<
            OAuthTokens & { expires_at?: number }
          >(this.tokensPath);
          const issuedGeneration = this.issuedTokenSets.get(
            tokenSetKey(tokens),
          );
          if (
            issuedGeneration !== undefined &&
            issuedGeneration !== this.cacheGeneration
          ) {
            await this.loadCache();
            return;
          }
          // The SDK saves the same response after wrapFetch returns. A later owner
          // may already have refreshed it again; never roll a rotated token back.
          if (
            stored &&
            this.issuedTokenSets.has(tokenSetKey(tokens)) &&
            tokenSetKey(stored) !== tokenSetKey(tokens)
          ) {
            this.tokenSet = stored
              ? OAuthTokensSchema.parse(stored)
              : undefined;
            this.tokenExpiresAt = stored.expires_at;
            return;
          }
          await this.persistTokens(tokens);
        },
      );
    });
  }

  private async mutateCache(operation: () => Promise<void>): Promise<void> {
    return withOAuthLock(
      oauthAuthorizationLockPath(this.cacheDir),
      this.controller.signal,
      this.authorizationTimeoutMs,
      async () => {
        if (
          (await readOAuthGeneration(this.cacheDir)) !== this.cacheGeneration
        ) {
          await this.loadCache();
          return;
        }
        return operation();
      },
    );
  }

  private async runTokenTransaction<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    return withOAuthLock(
      oauthAuthorizationLockPath(this.cacheDir),
      signal,
      this.authorizationTimeoutMs,
      () =>
        withOAuthLock(
          oauthTokenLockPath(this.cacheDir),
          signal,
          this.authorizationTimeoutMs,
          operation,
        ),
    );
  }

  private trackTokens(tokens: OAuthTokens): void {
    this.credentialValues.add(tokens.access_token);
    if (tokens.refresh_token) this.credentialValues.add(tokens.refresh_token);
    if (tokens.id_token) this.credentialValues.add(tokens.id_token);
  }

  private async persistTokens(tokens: OAuthTokens): Promise<void> {
    if (this.oauth.useIdToken) {
      if (!tokens.id_token)
        throw new Error('OAuth response does not contain an ID token');
      this.tokenExpiresAt = idTokenExpiry(tokens.id_token);
    } else if (
      tokens.access_token !== this.tokenSet?.access_token ||
      this.tokenExpiresAt === undefined
    ) {
      this.tokenExpiresAt =
        tokens.expires_in === undefined
          ? undefined
          : Date.now() + tokens.expires_in * 1000;
    }
    this.tokenSet = tokens;
    this.trackTokens(tokens);
    await writePrivateFile(
      this.tokensPath,
      `${JSON.stringify({ ...tokens, expires_at: this.tokenExpiresAt }, null, 2)}\n`,
    );
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    if (!this.allowAuthorization) {
      this.authorizationUnavailable = true;
      return;
    }
    if (this.oauth.disableResourceParameter || this.oauth.resource === '')
      authorizationUrl.searchParams.delete('resource');
    else if (this.oauth.resource !== undefined)
      authorizationUrl.searchParams.set('resource', this.oauth.resource);
    if (this.oauth.scope !== undefined)
      authorizationUrl.searchParams.set(
        'scope',
        this.clientMetadata.scope ?? '',
      );
    for (const [key, value] of Object.entries(
      this.oauth.authorizationParams ?? {},
    ))
      authorizationUrl.searchParams.set(
        key,
        expandOAuthValue(value, this.environment),
      );
    if (this.oauth.disableResourceParameter || this.oauth.resource === '')
      authorizationUrl.searchParams.delete('resource');
    else if (this.oauth.resource !== undefined)
      authorizationUrl.searchParams.set('resource', this.oauth.resource);
    this.pendingAuth ??= this.waitForAuthorizationCode(authorizationUrl);
    void this.pendingAuth.catch(() => {});
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    return this.mutateCache(async () => {
      this.codeVerifierValue = codeVerifier;
      this.credentialValues.add(codeVerifier);
      await writePrivateFile(this.verifierPath, codeVerifier);
    });
  }

  codeVerifier(): string {
    if (!this.codeVerifierValue) {
      throw new Error('No OAuth code verifier is available');
    }
    return this.codeVerifierValue;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    return this.mutateCache(async () => {
      this.discovery = state;
      await writePrivateFile(
        this.discoveryPath,
        `${JSON.stringify(state, null, 2)}\n`,
      );
    });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.discovery;
  }

  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ): Promise<void> {
    return this.mutateCache(async () => {
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
      if (scope === 'all' || scope === 'client') this.clientInfo = undefined;
      if (scope === 'all' || scope === 'tokens') {
        this.tokenSet = undefined;
        this.tokenExpiresAt = undefined;
      }
      if (scope === 'all' || scope === 'verifier')
        this.codeVerifierValue = undefined;
      if (scope === 'all' || scope === 'discovery') this.discovery = undefined;
    });
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

  private get authorizationTimeoutMs(): number {
    return this.oauth.callback?.timeoutSeconds
      ? this.oauth.callback.timeoutSeconds * 1000
      : AUTH_TIMEOUT_MS;
  }

  async runWithAuthorizationLock<T>(operation: () => Promise<T>): Promise<T> {
    return withOAuthLock(
      oauthAuthorizationLockPath(this.cacheDir),
      this.controller.signal,
      this.authorizationTimeoutMs,
      async () => {
        await this.load();
        await this.prepareCallbackPort();
        return operation();
      },
    );
  }

  private async prepareCallbackPort(): Promise<void> {
    if (
      !this.redirectUrl ||
      !this.clientInfo ||
      this.pendingAuth ||
      this.oauth.callback?.port ||
      this.oauth.clientId ||
      this.clientMetadataUrl ||
      this.oauth.clientMetadata?.redirect_uris
    )
      return;
    const bindHost = this.oauth.callback?.bindHost ?? '127.0.0.1';
    try {
      await findFreePort(this.port, bindHost);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      this.port = await findFreePort(0, bindHost);
      const redirect = new URL(this.redirectUriValue);
      redirect.port = String(this.port);
      this.redirectUriValue = redirect.toString();
      this.controller.signal.throwIfAborted();
      // A dynamic registration belongs to its advertised redirect URI. Moving
      // an automatic callback port requires a new registration and grant.
      await this.invalidateCredentials('client');
      await this.invalidateCredentials('tokens');
    }
  }

  completeAuthorization(error?: unknown): void {
    if (error) this.cancelCallback?.();
    const response = this.callbackResponse;
    this.callbackResponse = undefined;
    if (response && !response.writableEnded) {
      if (!error && this.oauth.callback?.successUrl) {
        response.writeHead(302, { location: this.oauth.callback.successUrl });
        response.end();
      } else {
        response.writeHead(error ? 400 : 200, {
          'content-type': 'text/html; charset=utf-8',
        });
        response.end(
          error
            ? '<html><body><h1>Authorization failed</h1><p>The token exchange failed.</p></body></html>'
            : '<html><body><h1>Authorization complete</h1><p>You can close this window.</p></body></html>',
        );
      }
    }
    this.pendingAuth = undefined;
    this.authorizationUnavailable = false;
    this.stateValue = randomUUID();
  }

  dispose(): void {
    this.controller.abort(new Error('MCP connection was cancelled'));
    this.cancelCallback?.();
    this.completeAuthorization(new Error('OAuth authorization cancelled'));
  }

  validateResourceURL?: NonNullable<OAuthClientProvider['validateResourceURL']>;

  addClientAuthentication: NonNullable<
    OAuthClientProvider['addClientAuthentication']
  > = (headers, params, _url, metadata) => {
    const info = this.clientInfo;
    if (!info) return;
    const supported = metadata?.token_endpoint_auth_methods_supported ?? [];
    const configured =
      typeof this.oauth.clientMetadata?.token_endpoint_auth_method === 'string'
        ? this.oauth.clientMetadata.token_endpoint_auth_method
        : undefined;
    const method =
      configured && (supported.length === 0 || supported.includes(configured))
        ? configured
        : selectClientAuthMethod(info, supported);
    if (method === 'client_secret_basic' && info.client_secret) {
      headers.set(
        'Authorization',
        `Basic ${Buffer.from(`${encodeURIComponent(info.client_id)}:${encodeURIComponent(info.client_secret)}`).toString('base64')}`,
      );
    } else {
      params.set('client_id', info.client_id);
      if (method === 'client_secret_post' && info.client_secret)
        params.set('client_secret', info.client_secret);
    }
    if (this.oauth.disableResourceParameter || this.oauth.resource === '')
      params.delete('resource');
    else if (this.oauth.resource !== undefined)
      params.set('resource', this.oauth.resource);
  };

  async prepareTokenRequest(
    scope?: string,
  ): Promise<URLSearchParams | undefined> {
    if (this.oauth.grantType === 'client_credentials') {
      const params = new URLSearchParams({ grant_type: 'client_credentials' });
      const effectiveScope =
        this.clientMetadata.scope ?? this.challengedScope ?? scope;
      if (effectiveScope) params.set('scope', effectiveScope);
      return params;
    }
    if (this.oauth.grantType !== 'device_code') return undefined;
    if (
      this.tokenSet?.refresh_token &&
      (!this.tokenSet.issuer ||
        this.tokenSet.issuer === this.discovery?.authorizationServerUrl)
    )
      return new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.tokenSet.refresh_token,
      });
    if (!this.allowAuthorization)
      throw new Error('OAuth authorization requires an interactive terminal');
    const metadata = this.discovery?.authorizationServerMetadata;
    const endpoint =
      metadata && 'device_authorization_endpoint' in metadata
        ? metadata.device_authorization_endpoint
        : undefined;
    if (
      typeof endpoint !== 'string' ||
      !metadata?.token_endpoint ||
      (metadata.grant_types_supported &&
        !metadata.grant_types_supported.includes(
          'urn:ietf:params:oauth:grant-type:device_code',
        ))
    )
      throw new Error('OAuth server does not support device authorization');
    const clientId = this.clientInfo?.client_id;
    if (!clientId)
      throw new Error('Device authorization requires an OAuth client ID');
    const params = new URLSearchParams({ client_id: clientId });
    const effectiveScope =
      this.clientMetadata.scope ?? this.challengedScope ?? scope;
    if (effectiveScope) params.set('scope', effectiveScope);
    const resource =
      this.oauth.resource ?? this.discovery?.resourceMetadata?.resource;
    if (resource && !this.oauth.disableResourceParameter)
      params.set('resource', resource);
    const headers = new Headers({
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    });
    await this.addClientAuthentication(headers, params, endpoint, metadata);
    const response = await this.fetchFn(endpoint, {
      method: 'POST',
      headers,
      body: params,
      redirect: 'error',
      signal: this.controller.signal,
    });
    if (!response.ok)
      throw new Error(`OAuth device authorization failed (${response.status})`);
    const parsedDevice = DeviceAuthorizationSchema.safeParse(
      await response.json(),
    );
    if (!parsedDevice.success)
      throw new Error('Invalid OAuth device authorization response');
    const device = parsedDevice.data;
    this.credentialValues.add(device.device_code);
    this.credentialValues.add(device.user_code);
    this.deviceExpiresAt =
      Date.now() +
      Math.min(device.expires_in * 1000, this.authorizationTimeoutMs);
    this.deviceIntervalMs = Math.max(0, (device.interval ?? 5) * 1000);
    this.authorizationOutput(
      `Authorize this device at ${device.verification_uri_complete ?? device.verification_uri}; code: ${device.user_code}`,
    );
    return new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
    });
  }

  wrapFetch(fetchFn: FetchLike): FetchLike {
    return async (input, init) => {
      const request = new Request(input.toString(), init);
      const combinedSignal = AbortSignal.any([
        request.signal,
        this.controller.signal,
      ]);
      const requestInit = { ...init, signal: combinedSignal };
      const send = async () => {
        const response = await fetchFn(input, requestInit);
        if (response.status === 401) {
          const scope = response.headers
            .get('www-authenticate')
            ?.match(/\bscope="([^"\r\n]*)"/i)?.[1];
          if (scope) this.challengedScope = scope;
        }
        return response;
      };
      if (
        this.oauth.useIdToken &&
        this.tokenSet?.id_token &&
        this.tokenExpiresAt !== undefined &&
        this.tokenExpiresAt <= Date.now() &&
        request.headers.get('authorization') ===
          `Bearer ${this.tokenSet.id_token}`
      )
        return new Response(null, { status: 401 });
      if (request.method !== 'POST') return send();
      const params = new URLSearchParams(await request.clone().text());
      const grant = params.get('grant_type');
      if (!grant) return send();
      const requestedAccessToken = this.tokenSet?.access_token;
      const requestedGeneration = this.cacheGeneration;
      return this.runTokenTransaction(combinedSignal, async () => {
        if (
          (await readOAuthGeneration(this.cacheDir)) !== requestedGeneration
        ) {
          await this.loadCache();
          if (!this.tokenSet)
            throw new OAuthAuthorizationError(
              'OAuth credentials changed during authorization; reconnect',
            );
          this.issuedTokenSets.set(
            tokenSetKey(this.tokenSet),
            this.cacheGeneration,
          );
          return Response.json(this.tokenSet);
        }
        const stored = await readJsonFile<
          OAuthTokens & { expires_at?: number }
        >(this.tokensPath);
        if (
          grant === 'refresh_token' &&
          stored?.refresh_token &&
          stored.refresh_token !== params.get('refresh_token')
        ) {
          this.tokenSet = stored ? OAuthTokensSchema.parse(stored) : undefined;
          this.tokenExpiresAt = stored.expires_at;
          this.trackTokens(stored);
          this.issuedTokenSets.set(tokenSetKey(stored), this.cacheGeneration);
          return Response.json(OAuthTokensSchema.parse(stored));
        }
        if (
          grant === 'client_credentials' &&
          stored &&
          stored.access_token !== requestedAccessToken &&
          stored.expires_at &&
          stored.expires_at > Date.now()
        ) {
          this.tokenSet = stored ? OAuthTokensSchema.parse(stored) : undefined;
          this.tokenExpiresAt = stored.expires_at;
          this.trackTokens(stored);
          this.issuedTokenSets.set(tokenSetKey(stored), this.cacheGeneration);
          return Response.json(OAuthTokensSchema.parse(stored));
        }
        while (true) {
          if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
            const remaining = this.deviceExpiresAt - Date.now();
            if (remaining <= 0)
              throw new OAuthAuthorizationError(
                'OAuth device authorization expired',
              );
            await waitForOAuth(
              Math.min(this.deviceIntervalMs, remaining),
              combinedSignal,
            );
            if (Date.now() >= this.deviceExpiresAt)
              throw new OAuthAuthorizationError(
                'OAuth device authorization expired',
              );
          }
          const response = await send();
          if (response.ok) {
            const parsed = OAuthTokensSchema.safeParse(
              await response.clone().json(),
            );
            if (parsed.success) {
              const tokens = {
                ...parsed.data,
                ...(this.discovery?.authorizationServerUrl
                  ? { issuer: this.discovery.authorizationServerUrl }
                  : stored?.issuer
                    ? { issuer: stored.issuer }
                    : {}),
                ...(parsed.data.refresh_token
                  ? {}
                  : grant === 'refresh_token' && stored?.refresh_token
                    ? { refresh_token: stored.refresh_token }
                    : {}),
              };
              await this.persistTokens(tokens);
              this.issuedTokenSets.set(
                tokenSetKey(tokens),
                this.cacheGeneration,
              );
            }
            return response;
          }
          if (grant !== 'urn:ietf:params:oauth:grant-type:device_code')
            return response;
          const failure = (await response.clone().json()) as {
            error?: string;
          };
          if (failure.error === 'slow_down') {
            this.deviceIntervalMs += 5000;
            continue;
          }
          if (failure.error === 'authorization_pending') continue;
          if (failure.error === 'access_denied')
            throw new OAuthAuthorizationError(
              'OAuth device authorization was denied',
            );
          if (failure.error === 'expired_token')
            throw new OAuthAuthorizationError(
              'OAuth device authorization expired',
            );
          return response;
        }
      });
    };
  }

  private waitForAuthorizationCode(authorizationUrl: URL): Promise<string> {
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const readerAbortController = new AbortController();
    let cancelAuthorization: (() => void) | undefined;
    let settled = false;
    const settle = (
      outcome: 'resolve' | 'reject',
      value: string | Error,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      readerAbortController.abort();
      if (cancelAuthorization) {
        this.signal?.removeEventListener('abort', cancelAuthorization);
      }
      if (server.listening) server.close();
      this.cancelCallback = undefined;
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
          if (settled) {
            response.writeHead(409);
            response.end('OAuth callback already received');
            return;
          }
          if (
            request.method !== 'GET' ||
            request.headers.host !== new URL(this.redirectUriValue).host
          )
            throw new Error('OAuth callback host validation failed');
          const callbackUrl = new URL(
            request.url ?? '/',
            this.redirectUriValue,
          ).toString();
          const code = parseOAuthCallbackUrl(
            callbackUrl,
            this.redirectUriValue,
            this.stateValue,
          );
          this.callbackResponse = response;
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
    }, this.authorizationTimeoutMs);
    cancelAuthorization = () => {
      const reason = this.signal?.reason;
      settle(
        'reject',
        reason instanceof Error
          ? reason
          : new Error('MCP connection was cancelled'),
      );
    };
    if (this.signal?.aborted) {
      cancelAuthorization();
      return promise;
    }
    this.signal?.addEventListener('abort', cancelAuthorization, { once: true });
    server.on('error', (error) => settle('reject', error));
    this.cancelCallback = cancelAuthorization;
    server.listen(
      this.port,
      this.oauth.callback?.bindHost ?? '127.0.0.1',
      () => {
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
        if (this.environment.ALLAGENTS_MCP_OAUTH_NO_BROWSER === '1') {
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
      },
    );
    return promise;
  }
}

export async function buildOAuthProvider(
  serverUrl: string,
  options: OAuthProviderOptions = {},
): Promise<FileOAuthClientProvider> {
  const cacheDir = getMcpOAuthCacheDir(
    serverUrl,
    options.profile,
    options.clientName,
    options.oauth,
    options.environment,
    options.headers,
  );
  const cachedClientInfo = await readJsonFile<OAuthClientInformationMixed>(
    join(cacheDir, 'client-info.json'),
  );

  const configuredRedirect = metadataRedirect(options.oauth);
  const nonInteractive =
    options.oauth?.grantType === 'device_code' ||
    options.oauth?.grantType === 'client_credentials';
  let port =
    options.oauth?.callback?.port ??
    (configuredRedirect ? Number(configuredRedirect.port || 80) : undefined) ??
    parseLoopbackPort(cachedClientInfo) ??
    (nonInteractive ? 0 : undefined);
  if (port === undefined) {
    port = await findFreePort(
      0,
      options.oauth?.callback?.bindHost ?? '127.0.0.1',
    );
  }

  const provider = new FileOAuthClientProvider(port, serverUrl, options);
  await provider.load();
  return provider;
}
