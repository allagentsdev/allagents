import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { createOriginSafeMcpFetch } from '../../../src/core/mcp-http-client.js';
import { buildOAuthProvider, getMcpOAuthCacheDir, runWithMcpOAuthReset, resolveMcpOAuthServerUrl } from '../../../src/core/mcp-oauth-provider.js';

const originalHome = process.env.HOME;
const originalTestHome = process.env.ALLAGENTS_TEST_HOME;
const cleanup: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
  process.env.HOME = originalHome;
  if (originalTestHome === undefined) delete process.env.ALLAGENTS_TEST_HOME;
  else process.env.ALLAGENTS_TEST_HOME = originalTestHome;
});
async function home() {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-oauth-parity-'));
  process.env.HOME = directory;
  process.env.ALLAGENTS_TEST_HOME = directory;
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
}
function fixture(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch: handler });
  cleanup.push(() => server.stop(true));
  return server.url.origin;
}

test('static identity, metadata and resource controls isolate private caches while preserving defaults', async () => {
  await home();
  const serverUrl = 'https://example.test/mcp';
  const provider = await buildOAuthProvider(serverUrl, { oauth: {
    clientId: 'registered', clientSecret: '${TEST_SECRET}', scope: 'read',
    clientMetadata: { software_id: 'first-party' }, resource: 'https://example.test/audience',
  }, environment: { TEST_SECRET: 'private-secret' } });
  expect(provider.clientInformation()?.client_id).toBe('registered');
  expect(provider.clientInformation()?.client_secret).toBe('private-secret');
  expect(provider.clientMetadata.software_id).toBe('first-party');
  expect(provider.clientMetadata.scope).toBe('read');
  await provider.saveTokens({ access_token: 'access', token_type: 'Bearer' });
  const base = getMcpOAuthCacheDir(serverUrl);
  const custom = getMcpOAuthCacheDir(serverUrl, undefined, undefined, {
    clientId: 'registered', clientSecret: '${TEST_SECRET}', scope: 'read',
    clientMetadata: { software_id: 'first-party' }, resource: 'https://example.test/audience',
  });
  expect(custom).not.toBe(base);
  expect((await stat(join(custom, 'tokens.json'))).mode & 0o777).toBe(0o600);
  expect((await readFile(join(custom, 'tokens.json'), 'utf8'))).toContain('access');
  provider.dispose();
});

test('client credentials explicit endpoint bypasses discovery and uses negotiated authentication', async () => {
  await home();
  const requests: Array<{ path: string; body: URLSearchParams; auth: string | null }> = [];
  const origin = fixture(async (request) => {
    requests.push({ path: new URL(request.url).pathname, body: new URLSearchParams(await request.text()), auth: request.headers.get('authorization') });
    return Response.json({ access_token: 'machine-access', token_type: 'Bearer', expires_in: 3600 });
  });
  const provider = await buildOAuthProvider(`${origin}/mcp`, { allowAuthorization: false,
    oauth: { grantType: 'client_credentials', clientId: 'machine', clientSecret: 'secret', tokenEndpoint: `${origin}/token`, scope: 'read', resource: `${origin}/audience` },
  });
  await auth(provider, { serverUrl: `${origin}/mcp`, fetchFn: provider.wrapFetch(fetch) });
  expect(requests.map((r) => r.path)).toEqual(['/token']);
  expect(requests[0]?.body.get('grant_type')).toBe('client_credentials');
  expect(requests[0]?.body.get('scope')).toBe('read');
  expect(requests[0]?.body.get('resource')).toBe(`${origin}/audience`);
  expect(requests[0]?.auth).toStartWith('Basic ');
  expect(provider.tokens()?.access_token).toBe('machine-access');
  provider.dispose();
});

test('rotating refresh tokens are coordinated and persisted before concurrent followers continue', async () => {
  await home();
  let refreshes = 0;
  const origin = fixture(async (request) => {
    const body = new URLSearchParams(await request.text());
    expect(body.get('refresh_token')).toBe('old-refresh');
    refreshes++;
    await Bun.sleep(60);
    return Response.json({ access_token: 'new-access', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600 });
  });
  const first = await buildOAuthProvider(`${origin}/mcp`);
  await first.saveTokens({ access_token: 'old-access', refresh_token: 'old-refresh', token_type: 'Bearer' });
  const second = await buildOAuthProvider(`${origin}/mcp`);
  const send = (provider: typeof first) => provider.wrapFetch(fetch)(`${origin}/token`, {
    method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'old-refresh' }),
  });
  const responses = await Promise.all([send(first), send(second)]);
  expect(await responses[0]?.json()).toMatchObject({ refresh_token: 'rotated-refresh' });
  expect(await responses[1]?.json()).toMatchObject({ refresh_token: 'rotated-refresh' });
  expect(refreshes).toBe(1);
  const third = await buildOAuthProvider(`${origin}/mcp`);
  expect(third.tokens()?.refresh_token).toBe('rotated-refresh');
  first.dispose(); second.dispose(); third.dispose();
});

test('fresh consent cycles rotate state and codes and apply authorization-only parameters', async () => {
  await home();
  const seen: URL[] = [];
  const provider = await buildOAuthProvider('https://example.test/mcp', {
    authorizationOutput: () => {}, environment: { ALLAGENTS_MCP_OAUTH_NO_BROWSER: '1' },
    oauth: { authorizationParams: { audience: 'workspace' } },
    callbackUrlReader: async ({ authorizationUrl, redirectUrl, state }) => {
      seen.push(authorizationUrl);
      return `${redirectUrl}?state=${state}&code=code-${seen.length}`;
    },
  });
  const firstState = provider.state();
  provider.redirectToAuthorization(new URL(`https://idp.test/authorize?state=${firstState}`));
  expect(await provider.waitForAuthCode()).toBe('code-1');
  provider.completeAuthorization();
  const secondState = provider.state();
  expect(secondState).not.toBe(firstState);
  provider.redirectToAuthorization(new URL(`https://idp.test/authorize?state=${secondState}`));
  expect(await provider.waitForAuthCode()).toBe('code-2');
  expect(seen[0]?.searchParams.get('audience')).toBe('workspace');
  provider.completeAuthorization(); provider.dispose();
});

test('ID token bearer follows its own expiry and requires an ID token', async () => {
  await home();
  const provider = await buildOAuthProvider('https://example.test/mcp', { oauth: { useIdToken: true } });
  expect(provider.clientMetadata.scope).toContain('openid');
  const idToken = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
  await provider.saveTokens({ access_token: 'access', id_token: idToken, token_type: 'Bearer', expires_in: 5 });
  expect(provider.tokens()?.access_token).toBe(idToken);
  await expect(provider.saveTokens({ access_token: 'missing-id', token_type: 'Bearer' })).rejects.toThrow('ID token');
  provider.dispose();
});

test('device flow rejects new human consent under cached-only authorization policy', async () => {
  await home();
  const provider = await buildOAuthProvider('https://example.test/mcp', { allowAuthorization: false, oauth: { grantType: 'device_code', clientId: 'device' } });
  await expect(provider.prepareTokenRequest()).rejects.toThrow('interactive');
  provider.dispose();
});

test('browser callback waits for exchange before redirecting to the configured success URL', async () => {
  await home();
  let browser: Promise<Response> | undefined;
  const provider = await buildOAuthProvider('https://example.test/mcp', {
    environment: { ALLAGENTS_MCP_OAUTH_NO_BROWSER: '1' },
    oauth: { callback: { host: 'localhost', bindHost: '127.0.0.1', path: '/custom', successUrl: 'https://example.test/success' } },
    authorizationOutput: (message) => {
      if (message.startsWith('If the browser')) browser = fetch(`${provider.redirectUrl}?state=${provider.state()}&code=browser-code`, { redirect: 'manual' });
    },
  });
  provider.redirectToAuthorization(new URL(`https://idp.test/authorize?state=${provider.state()}`));
  expect(await provider.waitForAuthCode()).toBe('browser-code');
  let complete = false;
  void browser?.then(() => { complete = true; });
  await Bun.sleep(20);
  expect(complete).toBe(false);
  provider.completeAuthorization();
  const response = await browser;
  expect(response?.status).toBe(302);
  expect(response?.headers.get('location')).toBe('https://example.test/success');
  provider.dispose();
});

test('browser callback reports exchange failure without a success redirect', async () => {
  await home();
  let browser: Promise<Response> | undefined;
  const provider = await buildOAuthProvider('https://example.test/mcp', {
    environment: { ALLAGENTS_MCP_OAUTH_NO_BROWSER: '1' },
    oauth: { callback: { successUrl: 'https://example.test/success' } },
    authorizationOutput: (message) => {
      if (message.startsWith('If the browser')) browser = fetch(`${provider.redirectUrl}?state=${provider.state()}&code=browser-code`, { redirect: 'manual' });
    },
  });
  provider.redirectToAuthorization(new URL(`https://idp.test/authorize?state=${provider.state()}`));
  await provider.waitForAuthCode();
  provider.completeAuthorization(new Error('exchange rejected'));
  expect((await browser)?.status).toBe(400);
  expect((await browser)?.headers.get('location')).toBeNull();
  provider.dispose();
});

test('device authorization polls pending responses and refreshes cached grants without consent', async () => {
  await home();
  const paths: string[] = [];
  const grants: string[] = [];
  let polls = 0;
  let origin = '';
  origin = fixture(async (request) => {
    const path = new URL(request.url).pathname;
    paths.push(path);
    if (path === '/device') return Response.json({ device_code: 'device-secret', user_code: 'USER-CODE', verification_uri: `${origin}/verify`, expires_in: 10, interval: 0.001 });
    if (path === '/token') {
      const params = new URLSearchParams(await request.text());
      const grant = params.get('grant_type')!;
      grants.push(grant);
      if (grant === 'refresh_token') return Response.json({ access_token: 'refreshed', refresh_token: 'rotated', token_type: 'Bearer', expires_in: 3600 });
      polls++;
      if (polls < 3) return Response.json({ error: 'authorization_pending' }, { status: 400 });
      return Response.json({ access_token: 'device-access', refresh_token: 'device-refresh', token_type: 'Bearer', expires_in: 3600 });
    }
    return new Response(null, { status: 404 });
  });
  const oauth = { grantType: 'device_code' as const, clientId: 'device' };
  const output: string[] = [];
  const provider = await buildOAuthProvider(`${origin}/mcp`, { oauth, authorizationOutput: (message) => output.push(message), fetch });
  await provider.saveDiscoveryState({ authorizationServerUrl: origin, resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] }, authorizationServerMetadata: { issuer: origin, token_endpoint: `${origin}/token`, device_authorization_endpoint: `${origin}/device`, response_types_supported: [] } });
  await auth(provider, { serverUrl: `${origin}/mcp`, fetchFn: provider.wrapFetch(fetch) });
  expect(polls).toBe(3);
  expect(output.join('\n')).toContain('USER-CODE');
  expect(provider.tokens()?.access_token).toBe('device-access');
  const cached = await buildOAuthProvider(`${origin}/mcp`, { oauth, allowAuthorization: false });
  await auth(cached, { serverUrl: `${origin}/mcp`, fetchFn: cached.wrapFetch(fetch) });
  expect(cached.tokens()?.access_token).toBe('refreshed');
  expect(paths.filter((path) => path === '/device')).toHaveLength(1);
  expect(grants.at(-1)).toBe('refresh_token');
  provider.dispose(); cached.dispose();
});

test('device polling denial and expiry fail promptly and disposal cancels polling', async () => {
  await home();
  let mode = 'denied';
  const origin = fixture(async (request) => {
    if (new URL(request.url).pathname === '/device') return Response.json({ device_code: 'code', user_code: 'user', verification_uri: 'https://idp.test/verify', expires_in: mode === 'expired' ? 0.02 : 100, interval: mode === 'denied' ? 0 : 0.01 });
    return Response.json({ error: mode === 'denied' ? 'access_denied' : 'authorization_pending' }, { status: 400 });
  });
  const provider = await buildOAuthProvider(`${origin}/mcp`, { oauth: { grantType: 'device_code', clientId: 'device' }, authorizationOutput: () => {}, fetch });
  await provider.saveDiscoveryState({ authorizationServerUrl: origin, resourceMetadata: { resource: `${origin}/mcp` }, authorizationServerMetadata: { issuer: origin, token_endpoint: `${origin}/token`, device_authorization_endpoint: `${origin}/device`, response_types_supported: [] } });
  await expect(auth(provider, { serverUrl: `${origin}/mcp`, fetchFn: provider.wrapFetch(fetch) })).rejects.toThrow();
  mode = 'expired';
  await expect(auth(provider, { serverUrl: `${origin}/mcp`, fetchFn: provider.wrapFetch(fetch) })).rejects.toThrow('expired');
  mode = 'pending';
  const pending = auth(provider, { serverUrl: `${origin}/mcp`, fetchFn: provider.wrapFetch(fetch) });
  setTimeout(() => provider.dispose(), 20);
  await expect(pending).rejects.toThrow('cancelled');
});

test('authorization lock reloads grants and cancellation releases followers', async () => {
  await home();
  const first = await buildOAuthProvider('https://example.test/mcp');
  const controller = new AbortController();
  const second = await buildOAuthProvider('https://example.test/mcp', { signal: controller.signal });
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const owner = first.runWithAuthorizationLock(async () => {
    started.resolve();
    await finish.promise;
    await first.saveTokens({ access_token: 'owner-token', token_type: 'Bearer' });
  });
  await started.promise;
  const follower = second.runWithAuthorizationLock(async () => { throw new Error('must not enter'); });
  controller.abort(new Error('cancelled follower'));
  await expect(follower).rejects.toThrow('cancelled follower');
  finish.resolve();
  await owner;
  const third = await buildOAuthProvider('https://example.test/mcp');
  await third.runWithAuthorizationLock(async () => expect(third.tokens()?.access_token).toBe('owner-token'));
  first.dispose(); second.dispose(); third.dispose();
});

test('expired ID bearer generates an auth challenge without sending an expired token', async () => {
  await home();
  let requests = 0;
  const origin = fixture(() => { requests++; return new Response('ok'); });
  const provider = await buildOAuthProvider(`${origin}/mcp`, { oauth: { useIdToken: true } });
  const idToken = `e30.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 1 })).toString('base64url')}.signature`;
  await provider.saveTokens({ access_token: 'long-lived-access', id_token: idToken, token_type: 'Bearer', expires_in: 3600 });
  const response = await provider.wrapFetch(fetch)(`${origin}/mcp`, { headers: { authorization: `Bearer ${idToken}` } });
  expect(response.status).toBe(401);
  expect(requests).toBe(0);
  provider.dispose();
});

function worker(mode: string, serverUrl: string) {
  const child = Bun.spawn([process.execPath, 'run', join(import.meta.dir, '../../helpers/mcp-oauth-worker.ts'), mode, serverUrl], {
    env: { ...process.env }, stdout: 'pipe', stderr: 'pipe',
  });
  cleanup.push(async () => { if (child.exitCode === null) child.kill('SIGKILL'); await child.exited; });
  return child;
}

test('independent processes share one cold grant and one rotating-token refresh', async () => {
  await home();
  let authorizations = 0;
  let refreshes = 0;
  const origin = fixture(async (request) => {
    const params = new URLSearchParams(await request.text());
    if (params.get('grant_type') === 'authorization_code') {
      authorizations++;
      await Bun.sleep(50);
      return Response.json({ access_token: 'initial-access', refresh_token: 'old-refresh', token_type: 'Bearer', expires_in: 3600 });
    }
    refreshes++;
    expect(params.get('refresh_token')).toBe('old-refresh');
    await Bun.sleep(50);
    return Response.json({ access_token: 'new-access', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600 });
  });
  const cold = Array.from({ length: 3 }, () => worker('authorize', `${origin}/mcp`));
  const coldResults = await Promise.all(cold.map(async (child) => ({ status: await child.exited, output: await new Response(child.stdout).text(), error: await new Response(child.stderr).text() })));
  expect(coldResults.map((r) => [r.status, r.error])).toEqual([[0, ''], [0, ''], [0, '']]);
  expect(coldResults.every((r) => r.output.includes('initial-access'))).toBe(true);
  expect(authorizations).toBe(1);
  const warm = Array.from({ length: 3 }, () => worker('refresh', `${origin}/mcp`));
  const warmResults = await Promise.all(warm.map(async (child) => ({ status: await child.exited, output: await new Response(child.stdout).text(), error: await new Response(child.stderr).text() })));
  expect(warmResults.map((r) => [r.status, r.error])).toEqual([[0, ''], [0, ''], [0, '']]);
  expect(warmResults.every((r) => r.output.includes('rotated-refresh'))).toBe(true);
  expect(refreshes).toBe(1);
});

test('a killed authorization owner is reclaimed by the next process', async () => {
  await home();
  const origin = fixture(() => Response.json({ access_token: 'recovered', token_type: 'Bearer', expires_in: 3600 }));
  const owner = worker('hold', `${origin}/mcp`);
  const reader = owner.stdout.getReader();
  const chunk = await reader.read();
  expect(new TextDecoder().decode(chunk.value)).toContain('locked');
  reader.releaseLock();
  owner.kill('SIGKILL');
  await owner.exited;
  const follower = worker('authorize', `${origin}/mcp`);
  expect(await follower.exited).toBe(0);
  expect(await new Response(follower.stdout).text()).toContain('recovered');
});

test('discovered registration, consent, exchange and refresh preserve resource and authorize-only controls', async () => {
  await home();
  const registrations: Record<string, unknown>[] = [];
  const authorizations: URL[] = [];
  const tokenRequests: URLSearchParams[] = [];
  let origin = '';
  origin = fixture(async (request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['server-scope'] });
    if (url.pathname === '/.well-known/oauth-authorization-server') return Response.json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_post'] });
    if (url.pathname === '/register') {
      const metadata = await request.json() as Record<string, unknown>;
      registrations.push(metadata);
      return Response.json({ ...metadata, client_id: 'dynamic', client_secret: 'dynamic-secret' }, { status: 201 });
    }
    if (url.pathname === '/authorize') {
      authorizations.push(url);
      const callback = new URL(url.searchParams.get('redirect_uri')!);
      callback.searchParams.set('state', url.searchParams.get('state')!);
      callback.searchParams.set('code', 'real-code');
      return Response.redirect(callback, 302);
    }
    if (url.pathname === '/token') {
      tokenRequests.push(new URLSearchParams(await request.text()));
      return Response.json({ access_token: `access-${tokenRequests.length}`, refresh_token: `refresh-${tokenRequests.length}`, token_type: 'Bearer', expires_in: 3600 });
    }
    return new Response(null, { status: 404 });
  });
  const provider = await buildOAuthProvider(`${origin}/mcp`, {
    oauth: { clientMetadata: { software_id: 'allagents-test' }, scope: 'configured-scope', resource: `${origin}/audience`, authorizationParams: { audience: 'tenant' } },
    authorizationOutput: () => {}, environment: { ALLAGENTS_MCP_OAUTH_NO_BROWSER: '1' },
    callbackUrlReader: async ({ authorizationUrl }) => (await fetch(authorizationUrl, { redirect: 'manual' })).headers.get('location')!,
  });
  const fetchFn = provider.wrapFetch(fetch);
  expect(await auth(provider, { serverUrl: `${origin}/mcp`, fetchFn })).toBe('REDIRECT');
  const authorizationCode = await provider.waitForAuthCode();
  expect(await auth(provider, { serverUrl: `${origin}/mcp`, authorizationCode, fetchFn })).toBe('AUTHORIZED');
  provider.completeAuthorization();
  expect(await auth(provider, { serverUrl: `${origin}/mcp`, fetchFn })).toBe('AUTHORIZED');
  expect(registrations).toHaveLength(1);
  expect(registrations[0]?.software_id).toBe('allagents-test');
  expect(authorizations[0]?.searchParams.get('scope')).toBe('configured-scope');
  expect(authorizations[0]?.searchParams.get('audience')).toBe('tenant');
  expect(authorizations[0]?.searchParams.get('resource')).toBe(`${origin}/audience`);
  expect(tokenRequests.map((params) => params.get('resource'))).toEqual([`${origin}/audience`, `${origin}/audience`]);
  expect(tokenRequests.map((params) => params.get('client_secret'))).toEqual(['dynamic-secret', 'dynamic-secret']);
  expect(tokenRequests.every((params) => !params.has('audience'))).toBe(true);
  provider.dispose();
});

test('CIMD uses advertised metadata-document support and falls back to dynamic registration', async () => {
  await home();
  let supportsDocument = true;
  let registrations = 0;
  let origin = '';
  origin = fixture(async (request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return Response.json({ resource: origin, authorization_servers: [origin] });
    if (url.pathname === '/.well-known/oauth-authorization-server') return Response.json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], client_id_metadata_document_supported: supportsDocument });
    if (url.pathname === '/register') { registrations++; return Response.json({ ...(await request.json() as object), client_id: 'fallback-id' }, { status: 201 }); }
    return new Response(null, { status: 404 });
  });
  for (const documentSupported of [true, false]) {
    supportsDocument = documentSupported;
    const provider = await buildOAuthProvider(`${origin}/mcp/${documentSupported}`, {
      oauth: { clientMetadataUrl: 'https://client.example.test/metadata.json' },
      environment: { ALLAGENTS_MCP_OAUTH_NO_BROWSER: '1' }, authorizationOutput: () => {},
      callbackUrlReader: async ({ redirectUrl, state }) => `${redirectUrl}?state=${state}&code=code`,
    });
    expect(await auth(provider, { serverUrl: `${origin}/mcp/${documentSupported}`, fetchFn: provider.wrapFetch(fetch) })).toBe('REDIRECT');
    await provider.waitForAuthCode();
    expect(provider.clientInformation()?.client_id).toBe(documentSupported ? 'https://client.example.test/metadata.json' : 'fallback-id');
    provider.completeAuthorization(); provider.dispose();
  }
  expect(registrations).toBe(1);
});

test('same-provider machine renewals share one response and delayed SDK saves cannot restore superseded refresh tokens', async () => {
  await home();
  let requests = 0;
  const origin = fixture(async () => {
    requests++;
    await Bun.sleep(20);
    return Response.json({ access_token: `access-${requests}`, refresh_token: `refresh-${requests}`, token_type: 'Bearer', expires_in: 3600 });
  });
  const provider = await buildOAuthProvider(`${origin}/mcp`, { oauth: { grantType: 'client_credentials', clientId: 'machine' } });
  const fetchFn = provider.wrapFetch(fetch);
  const send = () => fetchFn(`${origin}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials' }) });
  const [first, second] = await Promise.all([send(), send()]);
  const initial = await first.json();
  expect(await second.json()).toMatchObject(initial);
  expect(requests).toBe(1);
  await send();
  await provider.saveTokens(initial);
  const reloaded = await buildOAuthProvider(`${origin}/mcp`, { oauth: { grantType: 'client_credentials', clientId: 'machine' } });
  expect(reloaded.tokens()?.refresh_token).toBe('refresh-2');
  provider.dispose(); reloaded.dispose();
});

test('cache identity preserves defaults, ignores completion controls and resolves static client ID references', async () => {
  await home();
  const url = 'https://example.test/mcp';
  expect(getMcpOAuthCacheDir(url, undefined, undefined, { grantType: 'authorization_code', useIdToken: false, disableResourceParameter: false })).toBe(getMcpOAuthCacheDir(url));
  expect(getMcpOAuthCacheDir(url, undefined, undefined, { callback: { bindHost: '127.0.0.1', timeoutSeconds: 20, successUrl: 'https://example.test/complete' } })).toBe(getMcpOAuthCacheDir(url));
  expect(getMcpOAuthCacheDir(url, undefined, undefined, { clientId: '${CLIENT_ID}' }, { CLIENT_ID: 'first' })).not.toBe(getMcpOAuthCacheDir(url, undefined, undefined, { clientId: '${CLIENT_ID}' }, { CLIENT_ID: 'second' }));
  expect(getMcpOAuthCacheDir(url, undefined, undefined, { authorizationParams: { tenant: 'a', audience: 'b' } })).toBe(getMcpOAuthCacheDir(url, undefined, undefined, { authorizationParams: { audience: 'b', tenant: 'a' } }));
});

test('dynamic callbacks recover an occupied cached port while explicit ports remain strict', async () => {
  await home();
  const dynamic = await buildOAuthProvider('https://example.test/dynamic');
  const oldRedirect = dynamic.redirectUrl!;
  await dynamic.saveClientInformation({ ...dynamic.clientMetadata, client_id: 'dynamic' });
  await dynamic.saveTokens({ access_token: 'old-token', token_type: 'Bearer' });
  const occupied = Bun.serve({ port: Number(new URL(oldRedirect).port), hostname: '127.0.0.1', fetch: () => new Response('unrelated') });
  cleanup.push(() => occupied.stop(true));
  await dynamic.runWithAuthorizationLock(async () => {
    expect(dynamic.redirectUrl).not.toBe(oldRedirect);
    expect(dynamic.clientInformation()).toBeUndefined();
    expect(dynamic.tokens()).toBeUndefined();
  });
  const fixed = await buildOAuthProvider('https://example.test/fixed', { oauth: { callback: { port: occupied.port! } }, authorizationOutput: () => {}, environment: { ALLAGENTS_MCP_OAUTH_NO_BROWSER: '1' } });
  await fixed.saveClientInformation({ ...fixed.clientMetadata, client_id: 'fixed' });
  await fixed.saveTokens({ access_token: 'fixed-token', token_type: 'Bearer' });
  await fixed.runWithAuthorizationLock(async () => expect(fixed.tokens()?.access_token).toBe('fixed-token'));
  fixed.redirectToAuthorization(new URL(`https://idp.test/authorize?state=${fixed.state()}`));
  await expect(fixed.waitForAuthCode()).rejects.toThrow();
  expect(new URL(fixed.redirectUrl!).port).toBe(String(occupied.port));
  fixed.completeAuthorization(new Error('occupied'));
  dynamic.dispose(); fixed.dispose();
});

test('cold followers adopt the redirect URI registered by the authorization owner', async () => {
  await home();
  const first = await buildOAuthProvider('https://example.test/mcp');
  const second = await buildOAuthProvider('https://example.test/mcp');
  await first.saveClientInformation({ ...first.clientMetadata, client_id: 'registered-by-owner' });
  await first.saveTokens({ access_token: 'owner-grant', token_type: 'Bearer' });
  await second.runWithAuthorizationLock(async () => {
    expect(second.redirectUrl).toBe(first.redirectUrl);
    expect(second.tokens()?.access_token).toBe('owner-grant');
  });
  first.dispose(); second.dispose();
});

test('callback and follower timeouts release listeners and preserve the active lock owner', async () => {
  await home();
  const callback = await buildOAuthProvider('https://example.test/callback', { oauth: { callback: { timeoutSeconds: 0.02 } }, authorizationOutput: () => {}, environment: { ALLAGENTS_MCP_OAUTH_NO_BROWSER: '1' } });
  callback.redirectToAuthorization(new URL(`https://idp.test/authorize?state=${callback.state()}`));
  await expect(callback.waitForAuthCode()).rejects.toThrow('Timed out');
  const port = Number(new URL(callback.redirectUrl!).port);
  const reusable = Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response('reused') });
  reusable.stop(true);
  callback.completeAuthorization(new Error('timeout')); callback.dispose();
  const owner = await buildOAuthProvider('https://example.test/locked');
  const follower = await buildOAuthProvider('https://example.test/locked', { oauth: { callback: { timeoutSeconds: 0.02 } } });
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const operation = owner.runWithAuthorizationLock(async () => { entered.resolve(); await finish.promise; });
  await entered.promise;
  await expect(follower.runWithAuthorizationLock(async () => {})).rejects.toThrow('Timed out');
  finish.resolve(); await operation;
  owner.dispose(); follower.dispose();
});

test('resource disabling wins over explicit and discovered resource values in machine token requests', async () => {
  await home();
  const bodies: URLSearchParams[] = [];
  const origin = fixture(async (request) => {
    bodies.push(new URLSearchParams(await request.text()));
    return Response.json({ access_token: 'access', token_type: 'Bearer', expires_in: 3600 });
  });
  const provider = await buildOAuthProvider(`${origin}/mcp`, { oauth: { grantType: 'client_credentials', clientId: 'machine', tokenEndpoint: `${origin}/token`, resource: 'https://resource.test/audience', disableResourceParameter: true } });
  await auth(provider, { serverUrl: `${origin}/mcp`, fetchFn: provider.wrapFetch(fetch) });
  expect(bodies[0]?.has('resource')).toBe(false);
  expect(bodies[0]?.has('scope')).toBe(false);
  provider.dispose();
});

test('device slow_down increases polling by five seconds and authenticates the device endpoint', async () => {
  await home();
  const pollTimes: number[] = [];
  let deviceAuthorization: string | null = null;
  let deviceBody = new URLSearchParams();
  const origin = fixture(async (request) => {
    if (new URL(request.url).pathname === '/device') {
      deviceAuthorization = request.headers.get('authorization');
      deviceBody = new URLSearchParams(await request.text());
      return Response.json({ device_code: 'code', user_code: 'user', verification_uri: 'https://idp.test/verify', expires_in: 10, interval: 0 });
    }
    pollTimes.push(Date.now());
    if (pollTimes.length === 1) return Response.json({ error: 'slow_down' }, { status: 400 });
    return Response.json({ access_token: 'device-access', token_type: 'Bearer', expires_in: 3600 });
  });
  const provider = await buildOAuthProvider(`${origin}/mcp`, { oauth: { grantType: 'device_code', clientId: 'device', clientSecret: 'secret', scope: 'read', resource: `${origin}/audience` }, authorizationOutput: () => {}, fetch });
  await provider.saveDiscoveryState({ authorizationServerUrl: origin, resourceMetadata: { resource: `${origin}/mcp` }, authorizationServerMetadata: { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, device_authorization_endpoint: `${origin}/device`, response_types_supported: [], token_endpoint_auth_methods_supported: ['client_secret_basic'] } });
  await auth(provider, { serverUrl: `${origin}/mcp`, fetchFn: provider.wrapFetch(fetch) });
  expect(deviceAuthorization).toStartWith('Basic ');
  expect(deviceBody.get('scope')).toBe('read');
  expect(deviceBody.get('resource')).toBe(`${origin}/audience`);
  expect(pollTimes).toHaveLength(2);
  expect(pollTimes[1]! - pollTimes[0]!).toBeGreaterThanOrEqual(4900);
  provider.dispose();
}, 10000);

test('static redirect metadata configures the callback and rejects conflicting explicit settings', async () => {
  await home();
  const reservation = Bun.serve({ port: 0, fetch: () => new Response('reserve') });
  const port = reservation.port!;
  reservation.stop(true);
  const redirect = `http://127.0.0.1:${port}/metadata-callback`;
  const provider = await buildOAuthProvider('https://example.test/metadata', { oauth: { clientMetadata: { redirect_uris: [redirect] } } });
  expect(provider.redirectUrl).toBe(redirect);
  expect(provider.clientMetadata.redirect_uris).toEqual([redirect]);
  await expect(buildOAuthProvider('https://example.test/conflict', { oauth: { clientMetadata: { redirect_uris: [redirect] }, callback: { path: '/different' } } })).rejects.toThrow('do not match');
  provider.dispose();
});

test('authorization parameter credentials are rejected before any URL can be printed', async () => {
  await home();
  const output: string[] = [];
  for (const key of ['state', 'code', 'client_secret', 'access_token', 'refresh_token', 'id_token', 'token']) {
    await expect(buildOAuthProvider('https://example.test/mcp', { oauth: { authorizationParams: { [key]: 'private-credential' } }, authorizationOutput: (message) => output.push(message) })).rejects.toThrow();
  }
  expect(output).toEqual([]);
});

async function waitForTicket(cacheDir: string, pid: number) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const files = await readdir(`${cacheDir}.authorization.lock`).catch(() => []);
    for (const file of files) {
      if (file.startsWith(`${pid}-`) && file.endsWith('.json')) {
        const record = JSON.parse(await readFile(join(`${cacheDir}.authorization.lock`, file), 'utf8'));
        if (!record.choosing) return;
      }
    }
    await Bun.sleep(5);
  }
  throw new Error('Child did not queue an OAuth lock ticket');
}

test('credential reset waits for an authorizing child before moving its cache and supports nested provider locks', async () => {
  await home();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let resets = 0;
  const origin = fixture(async (request) => {
    if (new URL(request.url).pathname === '/reset-start') { resets++; return new Response('ready'); }
    entered.resolve();
    await release.promise;
    return Response.json({ access_token: 'owner-token', token_type: 'Bearer', expires_in: 3600 });
  });
  const url = `${origin}/mcp`;
  const authorizing = worker('authorize', url);
  await entered.promise;
  const resetting = worker('reset', url);
  try {
    await waitForTicket(getMcpOAuthCacheDir(url), resetting.pid);
    expect(resets).toBe(0);
  } finally { release.resolve(); }
  expect(await authorizing.exited).toBe(0);
  expect(await resetting.exited).toBe(0);
  expect(resets).toBe(1);
  const provider = await buildOAuthProvider(url);
  expect(provider.tokens()?.access_token).toBe('reset-token');
  expect(await readdir(`${getMcpOAuthCacheDir(url)}.authorization.lock`)).toEqual([]);
  provider.dispose();
});

test('cancelling a queued reset leaves the active authorization and credentials intact', async () => {
  await home();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let resets = 0;
  const origin = fixture(async (request) => {
    if (new URL(request.url).pathname === '/reset-start') { resets++; return new Response('ready'); }
    entered.resolve(); await release.promise;
    return Response.json({ access_token: 'owner-token', token_type: 'Bearer', expires_in: 3600 });
  });
  const url = `${origin}/mcp`;
  const authorizing = worker('authorize', url);
  await entered.promise;
  const resetting = worker('reset-cancel', url);
  try {
    await waitForTicket(getMcpOAuthCacheDir(url), resetting.pid);
    resetting.kill('SIGTERM');
    expect(await resetting.exited).not.toBe(0);
    expect(resets).toBe(0);
  } finally { release.resolve(); }
  expect(await authorizing.exited).toBe(0);
  const provider = await buildOAuthProvider(url);
  expect(provider.tokens()?.access_token).toBe('owner-token');
  expect(await readdir(`${getMcpOAuthCacheDir(url)}.authorization.lock`)).toEqual([]);
  provider.dispose();
});

test('delayed SDK token saves cannot restore a pre-reset grant, including after provider reload', async () => {
  await home();
  const origin = fixture(() => Response.json({ access_token: 'pre-reset', refresh_token: 'old-refresh', token_type: 'Bearer', expires_in: 3600 }));
  const url = `${origin}/mcp`;
  const provider = await buildOAuthProvider(url);
  const response = await provider.wrapFetch(fetch)(`${origin}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: 'code' }) });
  const delayed = await response.json();
  const cache = getMcpOAuthCacheDir(url);
  await runWithMcpOAuthReset(cache, async () => {
    await rename(cache, `${cache}.backup`);
    const replacement = await buildOAuthProvider(url);
    await replacement.runWithAuthorizationLock(() => replacement.saveTokens({ access_token: 'replacement', refresh_token: 'new-refresh', token_type: 'Bearer' }));
    replacement.dispose();
    await rm(`${cache}.backup`, { recursive: true, force: true });
  });
  await provider.load();
  await provider.saveTokens(delayed);
  const reloaded = await buildOAuthProvider(url);
  expect(reloaded.tokens()?.access_token).toBe('replacement');
  expect(reloaded.tokens()?.refresh_token).toBe('new-refresh');
  provider.dispose(); reloaded.dispose();
});

test('failed reset restores the exact grant bytes under the same stable authorization transaction', async () => {
  await home();
  const url = 'https://example.test/rollback';
  const provider = await buildOAuthProvider(url);
  await provider.saveTokens({ access_token: 'prior-valid', refresh_token: 'prior-refresh', token_type: 'Bearer', expires_in: 3600 });
  const cache = getMcpOAuthCacheDir(url);
  const before = await readFile(join(cache, 'tokens.json'), 'utf8');
  await expect(runWithMcpOAuthReset(cache, async () => {
    const backup = `${cache}.backup`;
    await rename(cache, backup);
    try {
      const replacement = await buildOAuthProvider(url);
      await replacement.saveTokens({ access_token: 'failed-attempt', token_type: 'Bearer' });
      replacement.dispose();
      throw new Error('consent cancelled');
    } catch (error) {
      await rm(cache, { recursive: true, force: true });
      await rename(backup, cache);
      throw error;
    }
  })).rejects.toThrow('consent cancelled');
  expect(await readFile(join(cache, 'tokens.json'), 'utf8')).toBe(before);
  const reloaded = await buildOAuthProvider(url);
  expect(reloaded.tokens()?.refresh_token).toBe('prior-refresh');
  provider.dispose(); reloaded.dispose();
});

test('two followers reclaim a dead owner without displacing the first new live authorization', async () => {
  await home();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let requests = 0;
  const origin = fixture(async () => {
    requests++; entered.resolve(); await release.promise;
    return Response.json({ access_token: 'recovered-once', token_type: 'Bearer', expires_in: 3600 });
  });
  const url = `${origin}/mcp`;
  const dead = worker('hold', url);
  const reader = dead.stdout.getReader();
  await reader.read(); reader.releaseLock();
  dead.kill('SIGKILL'); await dead.exited;
  const first = worker('authorize', url);
  await entered.promise;
  const second = worker('authorize', url);
  try {
    await waitForTicket(getMcpOAuthCacheDir(url), second.pid);
    expect(requests).toBe(1);
  } finally { release.resolve(); }
  expect(await first.exited).toBe(0);
  expect(await second.exited).toBe(0);
  expect(requests).toBe(1);
  expect(await readdir(`${getMcpOAuthCacheDir(url)}.authorization.lock`)).toEqual([]);
});

test('header identities normalize names and environment references without sharing grants', async () => {
  await home();
  const url = 'https://example.test/mcp';
  const first = await buildOAuthProvider(url, { headers: { 'X-Tenant': '${TENANT}', Authorization: 'Bearer ${TOKEN}' }, environment: { TENANT: 'first', TOKEN: 'first-secret' } });
  await first.saveTokens({ access_token: 'first-grant', token_type: 'Bearer' });
  const same = await buildOAuthProvider(url, { headers: { authorization: 'Bearer first-secret', 'x-tenant': 'first' } });
  expect(same.tokens()?.access_token).toBe('first-grant');
  const other = await buildOAuthProvider(url, { headers: { 'X-Tenant': '${TENANT}', Authorization: 'Bearer ${TOKEN}' }, environment: { TENANT: 'second', TOKEN: 'second-secret' } });
  expect(other.tokens()).toBeUndefined();
  expect(getMcpOAuthCacheDir(url, undefined, undefined, undefined, process.env, {})).toBe(getMcpOAuthCacheDir(url));
  expect(getMcpOAuthCacheDir(url, undefined, undefined, undefined, { TENANT: 'first', TOKEN: 'first-secret' }, { 'X-Tenant': '${TENANT}', Authorization: 'Bearer ${TOKEN}' })).not.toContain('first-secret');
  first.dispose(); same.dispose(); other.dispose();
});

test('issuer-bound static credentials never register or exchange against another discovered issuer', async () => {
  await home();
  let credentialRequests = 0;
  let origin = '';
  origin = fixture(async (request) => {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/.well-known/oauth-protected-resource')) return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    if (path === '/.well-known/oauth-authorization-server') return Response.json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ['code'] });
    credentialRequests++;
    return new Response(null, { status: 500 });
  });
  const provider = await buildOAuthProvider(`${origin}/mcp`, { oauth: { clientId: 'registered', clientSecret: 'private-secret', issuer: 'https://approved-issuer.test' }, allowAuthorization: false });
  expect(provider.clientInformation()?.issuer).toBe('https://approved-issuer.test');
  await expect(auth(provider, { serverUrl: `${origin}/mcp`, fetchFn: provider.wrapFetch(fetch) })).rejects.toThrow('issuer');
  expect(credentialRequests).toBe(0);
  provider.dispose();
});

test('delayed pre-reset token responses cannot repopulate an intentionally empty credential cache', async () => {
  await home();
  const origin = fixture(() => Response.json({ access_token: 'pre-reset', token_type: 'Bearer', expires_in: 3600 }));
  const url = `${origin}/mcp`;
  const provider = await buildOAuthProvider(url);
  const response = await provider.wrapFetch(fetch)(`${origin}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code: 'code' }) });
  const delayed = await response.json();
  const cache = getMcpOAuthCacheDir(url);
  await runWithMcpOAuthReset(cache, () => rm(cache, { recursive: true, force: true }));
  await provider.load();
  await provider.saveTokens(delayed);
  const reloaded = await buildOAuthProvider(url);
  expect(reloaded.tokens()).toBeUndefined();
  await expect(readFile(join(cache, 'tokens.json'))).rejects.toThrow();
  provider.dispose(); reloaded.dispose();
});

test('authored query identity survives credential rotation while whole URL references isolate server destinations', async () => {
  await home();
  const authored = 'https://example.test/mcp?token=${TOKEN}&literal=a%20b';
  const environment = { TOKEN: "first token's/value" };
  const resolved = resolveMcpOAuthServerUrl(authored, environment);
  const authoredCache = getMcpOAuthCacheDir(authored, undefined, undefined, undefined, {});
  const first = await buildOAuthProvider(authored, { environment });
  await first.saveTokens({ access_token: 'authored-query-grant', token_type: 'Bearer' });
  const rotated = await buildOAuthProvider(authored, { environment: { TOKEN: 'different-token' } });
  expect(rotated.tokens()?.access_token).toBe('authored-query-grant');
  const literal = await buildOAuthProvider(resolved);
  expect(literal.tokens()).toBeUndefined();
  expect(getMcpOAuthCacheDir(authored, undefined, undefined, undefined, environment)).toBe(authoredCache);
  expect(getMcpOAuthCacheDir(authored, undefined, undefined, undefined, { TOKEN: 'different-token' })).toBe(authoredCache);
  const firstDestination = { MCP_URL: 'https://first.example.test/mcp' };
  const secondDestination = { MCP_URL: 'https://second.example.test/mcp' };
  const wholeFirst = await buildOAuthProvider('${MCP_URL}', { environment: firstDestination });
  await wholeFirst.saveTokens({ access_token: 'first-server-grant', token_type: 'Bearer' });
  const wholeSecond = await buildOAuthProvider('${MCP_URL}', { environment: secondDestination });
  expect(wholeSecond.tokens()).toBeUndefined();
  expect(getMcpOAuthCacheDir('${MCP_URL}', undefined, undefined, undefined, firstDestination)).toBe(getMcpOAuthCacheDir(firstDestination.MCP_URL));
  expect(getMcpOAuthCacheDir('${MCP_URL}', undefined, undefined, undefined, firstDestination)).not.toBe(getMcpOAuthCacheDir('${MCP_URL}', undefined, undefined, undefined, secondDestination));
  const explicit = await buildOAuthProvider(authored, { environment, oauth: { grantType: 'client_credentials', clientId: 'client', tokenEndpoint: 'https://idp.test/token' } });
  expect(explicit.discoveryState()?.resourceMetadata?.resource).toBe(resolved);
  await expect(buildOAuthProvider(authored, { environment: {} })).rejects.toThrow('TOKEN');
  first.dispose(); rotated.dispose(); literal.dispose(); wholeFirst.dispose(); wholeSecond.dispose(); explicit.dispose();
});

test('explicit HTTP approval enables trusted non-default-loopback OAuth endpoints and success destinations', async () => {
  await home();
  const server = Bun.serve({ hostname: '127.0.0.2', port: 0, fetch: () => Response.json({ access_token: 'approved-http', token_type: 'Bearer', expires_in: 3600 }) });
  cleanup.push(() => server.stop(true));
  const endpoint = `http://127.0.0.2:${server.port}/token`;
  const oauth = { grantType: 'client_credentials' as const, clientId: 'client', tokenEndpoint: endpoint, callback: { successUrl: `http://127.0.0.2:${server.port}/success` } };
  await expect(buildOAuthProvider('https://example.test/mcp', { oauth })).rejects.toThrow('Invalid OAuth');
  const provider = await buildOAuthProvider('https://example.test/mcp', { oauth: { ...oauth, allowHttp: true } });
  await auth(provider, { serverUrl: 'https://example.test/mcp', fetchFn: provider.wrapFetch(fetch) });
  expect(provider.tokens()?.access_token).toBe('approved-http');
  await expect(buildOAuthProvider('https://example.test/mcp', { oauth: { ...oauth, allowHttp: true, tokenEndpoint: 'http://user:secret@127.0.0.2/token' } })).rejects.toThrow('Invalid OAuth');
  await expect(buildOAuthProvider('https://example.test/mcp', { oauth: { ...oauth, allowHttp: true, callback: { successUrl: 'http://127.0.0.2/success?credential=secret' } } })).rejects.toThrow('Invalid OAuth');
  await expect(buildOAuthProvider('https://example.test/mcp', { oauth: { ...oauth, allowHttp: true, tokenEndpoint: `${endpoint}#fragment` } })).rejects.toThrow('Invalid OAuth');
  provider.dispose();
});

test('device authorization rejects a cross-origin 307 before forwarding client_secret_post credentials', async () => {
  await home();
  const redirectedBodies: string[] = [];
  const destination = fixture(async (request) => {
    redirectedBodies.push(await request.text());
    return Response.json({ device_code: 'code', user_code: 'user', verification_uri: 'https://idp.test/verify', expires_in: 60 });
  });
  const authorizedBodies: URLSearchParams[] = [];
  const issuer = fixture(async (request) => {
    authorizedBodies.push(new URLSearchParams(await request.text()));
    return Response.redirect(`${destination}/capture`, 307);
  });
  const resourceUrl = 'https://resource.example.test/mcp';
  const provider = await buildOAuthProvider(resourceUrl, {
    oauth: { grantType: 'device_code', clientId: 'device-client', clientSecret: 'device-client-secret', clientMetadata: { token_endpoint_auth_method: 'client_secret_post' } },
    authorizationOutput: () => {},
    fetch: createOriginSafeMcpFetch(resourceUrl, {}, fetch),
  });
  await provider.saveDiscoveryState({ authorizationServerUrl: issuer, resourceMetadata: { resource: resourceUrl }, authorizationServerMetadata: { issuer, authorization_endpoint: `${issuer}/authorize`, device_authorization_endpoint: `${issuer}/device`, token_endpoint: `${issuer}/token`, token_endpoint_auth_methods_supported: ['client_secret_post'], response_types_supported: [] } });
  let failure: unknown;
  try { await provider.prepareTokenRequest(); }
  catch (error) { failure = error; }
  finally { provider.dispose(); }
  expect(authorizedBodies).toHaveLength(1);
  expect(authorizedBodies[0]?.get('client_secret')).toBe('device-client-secret');
  expect(redirectedBodies).toEqual([]);
  expect(failure).toBeInstanceOf(Error);
});
