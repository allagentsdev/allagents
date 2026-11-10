import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { createMcpRemoteConnection, connectMcpHttpClient } from '../../../src/core/mcp-http-client.js';

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Protocol response timed out'); await new Promise((resolve) => setTimeout(resolve, 5)); }
}

const originalHome = process.env.HOME;
let fixtureHome = '';
beforeEach(async () => {
  fixtureHome = await mkdtemp(join(tmpdir(), 'mcp-protocol-transport-'));
  process.env.HOME = fixtureHome;
});
afterEach(async () => {
  process.env.HOME = originalHome;
  await rm(fixtureHome, { recursive: true, force: true });
});

const init: JSONRPCMessage = { jsonrpc: '2.0', id: 'initialize', method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'host', version: '1' } } };
const result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'remote', version: '1' } };

for (const { strategy, failureStatus } of [
  { strategy: 'http-first', failureStatus: 404 }, { strategy: 'sse-first', failureStatus: 405 },
  { strategy: 'http-only', failureStatus: 404 }, { strategy: 'sse-only', failureStatus: 405 },
  { strategy: 'http-first', failureStatus: 405 }, { strategy: 'sse-first', failureStatus: 404 },
] as const) {
  test(`${strategy} (${failureStatus} startup) selects the matching transport and falls back only during startup`, async () => {
    const methods: string[] = [];
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    const isSse = strategy === 'http-first' || strategy === 'sse-only';
    const server = Bun.serve({ port: 0, async fetch(request) {
      methods.push(`${request.method} ${new URL(request.url).pathname}`);
      if (request.method === 'GET') {
        if (!isSse) return new Response(null, { status: failureStatus });
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          stream = controller; controller.enqueue(new TextEncoder().encode('event: endpoint\ndata: /messages\n\n'));
        } }), { headers: { 'content-type': 'text/event-stream' } });
      }
      if (isSse && new URL(request.url).pathname !== '/messages') return new Response(null, { status: failureStatus });
      const message = await request.json() as any;
      if (message.method === 'tools/call') return new Response(null, { status: failureStatus });
      const response = { jsonrpc: '2.0', id: message.id, result };
      if (isSse) { stream?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(response)}\n\n`)); return new Response(null, { status: 202 }); }
      return Response.json(response);
    } });
    const connection = await createMcpRemoteConnection(server.url.toString(), { connection: { transportStrategy: strategy }, allowAuthorization: false });
    const incoming: JSONRPCMessage[] = [];
    connection.transport.onmessage = (message) => { incoming.push(message); };
    try {
      await connection.transport.start();
      await connection.transport.send(init);
      await waitFor(() => incoming.length === 1);
      expect(incoming[0]).toEqual({ jsonrpc: '2.0', id: 'initialize', result });
      const before = methods.filter((entry) => entry.startsWith('GET')).length;
      await expect(connection.transport.send({ jsonrpc: '2.0', id: 'tool', method: 'tools/call', params: { name: 'mutate' } })).rejects.toThrow();
      expect(methods.filter((entry) => entry.startsWith('GET')).length).toBe(before);
      expect(methods.filter((entry) => entry === 'POST /').length).toBe(isSse ? (strategy === 'http-first' ? 1 : 0) : 2);
    } finally { await connection.close(); server.stop(true); }
  });
}

test('tool filtering preserves pagination and blocks direct calls; keepalive replies stay private', async () => {
  const requests: any[] = [];
  const server = Bun.serve({ port: 0, async fetch(request) {
    if (request.method === 'GET') return new Response(null, { status: 405 });
    const message = await request.json() as any;
    requests.push(message);
    if (!('id' in message)) return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: '2.0', id: message.id, result: message.method === 'initialize' ? result : message.method === 'tools/list' ? { tools: [{ name: 'Read' }, { name: 'DELETE_File' }, { name: 'write' }], nextCursor: 'next-page', _meta: { extension: 1 } } : {} });
  } });
  const connection = await createMcpRemoteConnection(server.url.toString(), { connection: { ignoreTools: ['delete*', '*write*'], keepAliveSeconds: 0.02 }, allowAuthorization: false });
  const incoming: JSONRPCMessage[] = [];
  connection.transport.onmessage = (message) => { incoming.push(message); };
  try {
    await connection.transport.start(); await connection.transport.send(init);
    await connection.transport.send({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: { cursor: 'page' } });
    expect(incoming[1]).toEqual({ jsonrpc: '2.0', id: 7, result: { tools: [{ name: 'Read' }], nextCursor: 'next-page', _meta: { extension: 1 } } });
    await connection.transport.send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'dElEtE_file' } });
    expect(incoming[2]).toMatchObject({ id: 8, error: { code: -32601 } });
    expect(requests.some((request) => request.method === 'tools/call')).toBe(false);
    await connection.transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await waitFor(() => requests.some((request) => request.method === 'ping'));
    await waitFor(() => incoming.length === 3);
    expect(incoming).toHaveLength(3);
    await connection.close();
    const count = requests.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(requests).toHaveLength(count);
  } finally { await connection.close(); server.stop(true); }
});

test('mid-session fresh consent retries once, rotates callbacks, and keeps runtime cached-only', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const previousHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), 'mcp-protocol-auth-'));
  process.env.HOME = home;
  let origin = '';
  let accepted = '';
  let rejectNewTokens = false;
  let exchanges = 0;
  let consents = 0;
  let successfulCalls = 0;
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/.well-known/oauth-protected-resource')) return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    if (path.startsWith('/.well-known/oauth-authorization-server')) return Response.json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    if (path === '/token') {
      const body = new URLSearchParams(await request.text());
      exchanges++;
      expect(body.get('code')).toBe(`consent-${exchanges}`);
      accepted = `private-bearer-${exchanges}`;
      return Response.json({ access_token: accepted, token_type: 'Bearer', expires_in: 3600 });
    }
    if (request.method === 'GET') return new Response(null, { status: 405 });
    const message = await request.json() as any;
    if (message.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: message.id, result });
    if (request.headers.get('authorization') !== `Bearer ${accepted}` || !accepted || rejectNewTokens) return new Response(null, { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` } });
    successfulCalls++;
    return Response.json({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } });
  } });
  origin = server.url.origin;
  const options = {
    oauth: { clientId: 'pre-registered' },
    authorizationOutput: () => {},
    environment: { ALLAGENTS_MCP_OAUTH_NO_BROWSER: '1' },
    callbackUrlReader: async ({ redirectUrl, state }: { redirectUrl: string; state: string }) => `${redirectUrl}?state=${state}&code=consent-${++consents}`,
  };
  let first: Awaited<ReturnType<typeof createMcpRemoteConnection>> | undefined;
  let cachedOnly: Awaited<ReturnType<typeof createMcpRemoteConnection>> | undefined;
  let follower: Awaited<ReturnType<typeof createMcpRemoteConnection>> | undefined;
  try {
    first = await createMcpRemoteConnection(`${origin}/mcp`, options);
    await first.transport.start(); await first.transport.send(init);
    follower = await createMcpRemoteConnection(`${origin}/mcp`, options);
    await follower.transport.start(); await follower.transport.send(init);
    await Promise.all([
      first.transport.send({ jsonrpc: '2.0', id: 'call-1', method: 'tools/call', params: { name: 'protected' } }),
      follower.transport.send({ jsonrpc: '2.0', id: 'follower-call', method: 'tools/call', params: { name: 'protected' } }),
    ]);
    expect(consents).toBe(1); expect(exchanges).toBe(1);
    await follower.close();
    accepted = '';
    await first.transport.send({ jsonrpc: '2.0', id: 'call-2', method: 'tools/call', params: { name: 'protected' } });
    expect(consents).toBe(2); expect(exchanges).toBe(2); expect(successfulCalls).toBe(3);
    accepted = '';
    rejectNewTokens = true;
    await expect(first.transport.send({ jsonrpc: '2.0', id: 'rejected-new-token', method: 'tools/call', params: { name: 'protected' } })).rejects.toThrow('freshly issued');
    expect(consents).toBe(3); expect(exchanges).toBe(3);
    await first.close();
    accepted = '';
    cachedOnly = await createMcpRemoteConnection(`${origin}/mcp`, { ...options, allowAuthorization: false });
    await cachedOnly.transport.start(); await cachedOnly.transport.send(init);
    await expect(cachedOnly.transport.send({ jsonrpc: '2.0', id: 'cached-call', method: 'tools/call', params: { name: 'protected' } })).rejects.toThrow('interactive');
    expect(consents).toBe(3);
  } finally {
    await first?.close(); await follower?.close(); await cachedOnly?.close(); server.stop(true);
    process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
}, 10000);

test('expired HTTP session reinitializes once without leaking the handshake or switching transport', async () => {
  const initializationRequests: unknown[] = [];
  const calls: string[] = [];
  let sessions = 0;
  const server = Bun.serve({ port: 0, async fetch(request) {
    if (request.method === 'GET') return new Response(null, { status: 405 });
    const message = await request.json() as any;
    if (message.method === 'initialize') {
      initializationRequests.push(message); sessions++;
      return Response.json({ jsonrpc: '2.0', id: message.id, result }, { headers: { 'mcp-session-id': `session-${sessions}` } });
    }
    if (!('id' in message)) return new Response(null, { status: 202 });
    calls.push(request.headers.get('mcp-session-id') ?? '');
    if (request.headers.get('mcp-session-id') === 'session-1') return new Response(null, { status: 404 });
    return Response.json({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'recovered' }] } });
  } });
  const connection = await createMcpRemoteConnection(server.url.toString(), { allowAuthorization: false });
  const incoming: JSONRPCMessage[] = [];
  connection.transport.onmessage = (message) => { incoming.push(message); };
  try {
    await connection.transport.start(); await connection.transport.send(init);
    await connection.transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await connection.transport.send({ jsonrpc: '2.0', id: 'once', method: 'tools/call', params: { name: 'read' } });
    expect(initializationRequests).toEqual([init, init]);
    expect(calls).toEqual(['session-1', 'session-2']);
    expect(incoming).toEqual([{ jsonrpc: '2.0', id: 'initialize', result }, { jsonrpc: '2.0', id: 'once', result: { content: [{ type: 'text', text: 'recovered' }] } }]);
  } finally { await connection.close(); server.stop(true); }
});

test('embedded header references are resolved and their credential fragments cannot reach the host', async () => {
  const sentinel = 'private-environment-sentinel';
  let header: string | null = null;
  const server = Bun.serve({ port: 0, async fetch(request) {
    header = request.headers.get('x-configured');
    const message = await request.json() as any;
    return Response.json({ jsonrpc: '2.0', id: message.id, result: { ...result, instructions: sentinel } });
  } });
  const connection = await createMcpRemoteConnection(server.url.toString(), { headers: { 'x-configured': 'prefix ${KEY} suffix' }, environment: { KEY: sentinel }, allowAuthorization: false });
  const messages: JSONRPCMessage[] = [];
  const errors: Error[] = [];
  connection.transport.onmessage = (message) => { messages.push(message); };
  connection.transport.onerror = (error) => { errors.push(error); };
  try {
    await connection.transport.start(); await connection.transport.send(init);
    expect(header).toBe(`prefix ${sentinel} suffix`);
    expect(messages).toEqual([{ jsonrpc: '2.0', id: 'initialize', error: { code: -32603, message: 'MCP output contained a configured credential value', data: { allagents: 'credential-reflection' } } }]);
    expect(JSON.stringify(messages)).not.toContain(sentinel);
    expect(errors[0]?.name).toBe('McpCredentialReflectionError');
    expect(errors[0]?.message).not.toContain(sentinel);
  } finally { await connection.close(); server.stop(true); }
});

for (const reflectedIn of ['response', 'notification'] as const) {
test(`finite SDK calls reject credentials reflected in a ${reflectedIn} promptly and can still terminate their session`, async () => {
  const credential = 'private-reflection-credential';
  let activeSession = false;
  const server = Bun.serve({ port: 0, async fetch(request) {
    if (request.method === 'GET') return new Response(null, { status: 405 });
    if (request.method === 'DELETE') { activeSession = false; return new Response(null, { status: 200 }); }
    const message = await request.json() as any;
    if (message.method === 'initialize') {
      activeSession = true;
      return Response.json({ jsonrpc: '2.0', id: message.id, result }, { headers: { 'mcp-session-id': 'session-reflection' } });
    }
    if (!('id' in message)) return new Response(null, { status: 202 });
    if (reflectedIn === 'notification') {
      return new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: credential } })}\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: credential }] } });
  } });
  const connection = await connectMcpHttpClient(server.url.toString(), { headers: { 'x-credential': credential }, allowAuthorization: false });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await expect(Promise.race([
      connection.client.callTool({ name: 'reflect' }).catch((error) => {
        expect(connection.credentialGuard.sanitizeError(error).message).toBe('MCP output contained a configured credential value');
        expect(error.message).not.toContain(credential);
        throw error;
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Credential rejection did not settle the SDK request')), 500); }),
    ])).rejects.toThrow('MCP output contained a configured credential value');
    await connection.terminateSession();
    expect(activeSession).toBe(false);
  } finally { if (timer) clearTimeout(timer); await connection.close(); server.stop(true); }
});

}

test('a background GET-only challenge completes consent and resumes notifications without a host request', async () => {
  const { startProtocolAuthServer } = await import('../../fixtures/mcp-protocol-auth-server.js');
  const server = startProtocolAuthServer('http-background');
  let consents = 0;
  const connection = await createMcpRemoteConnection(server.url, {
    oauth: { clientId: 'pre-registered' }, environment: { ALLAGENTS_MCP_OAUTH_NO_BROWSER: '1' }, authorizationOutput: () => {},
    callbackUrlReader: async ({ redirectUrl, state }) => `${redirectUrl}?state=${state}&code=background-${++consents}`,
  });
  const messages: JSONRPCMessage[] = [];
  const errors: Error[] = [];
  connection.transport.onmessage = (message) => { messages.push(message); };
  connection.transport.onerror = (error) => { errors.push(error); };
  try {
    await connection.transport.start(); await connection.transport.send(init);
    await connection.transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await waitFor(() => messages.some((message) => 'method' in message && message.method === 'notifications/tools/list_changed') || errors.length > 0);
    expect(errors.map((error) => error.message)).toEqual([]);
    expect(consents).toBe(1); expect(server.exchanges).toBe(1); expect(server.calls).toBe(0);
    expect(messages).toContainEqual({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: { _meta: { stream: 1 } } });
    server.revoke(); server.closeStream();
    await waitFor(() => server.successfulStreams === 2 || errors.length > 0);
    expect(errors.map((error) => error.message)).toEqual([]);
    expect(consents).toBe(2); expect(server.exchanges).toBe(2); expect(server.calls).toBe(0);
    await waitFor(() => messages.some((message) => 'method' in message && message.params?._meta && (message.params._meta as { stream?: number }).stream === 2));
    await connection.close();
    await waitFor(() => server.activeStreams === 0);
    const attempts = server.streamAttempts;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(server.streamAttempts).toBe(attempts);
  } finally { await connection.close(); server.stop(); }
});

test('legacy SSE recovers fresh consent during a tool call and preserves its notification channel', async () => {
  const { startProtocolAuthServer } = await import('../../fixtures/mcp-protocol-auth-server.js');
  const server = startProtocolAuthServer('sse');
  let consents = 0;
  const connection = await createMcpRemoteConnection(server.url, {
    connection: { transportStrategy: 'sse-only' }, oauth: { clientId: 'pre-registered' },
    environment: { ALLAGENTS_MCP_OAUTH_NO_BROWSER: '1' }, authorizationOutput: () => {},
    callbackUrlReader: async ({ redirectUrl, state }) => `${redirectUrl}?state=${state}&code=sse-${++consents}`,
  });
  const messages: JSONRPCMessage[] = [];
  connection.transport.onmessage = (message) => { messages.push(message); };
  try {
    await connection.transport.start(); await connection.transport.send(init);
    await waitFor(() => messages.length === 1);
    await connection.transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await connection.transport.send({ jsonrpc: '2.0', id: 'sse-first', method: 'tools/call', params: { name: 'protected' } });
    server.revoke();
    await connection.transport.send({ jsonrpc: '2.0', id: 'sse-second', method: 'tools/call', params: { name: 'protected' } });
    await waitFor(() => messages.length === 3);
    expect(messages.slice(1)).toEqual(['sse-first', 'sse-second'].map((id) => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'authenticated' }] } })));
    expect(consents).toBe(2); expect(server.exchanges).toBe(2); expect(server.calls).toBe(2);
    expect(server.successfulStreams).toBe(1);
    await connection.close(); await waitFor(() => server.activeStreams === 0);
  } finally { await connection.close(); server.stop(); }
});

for (const { strategy, status } of [{ strategy: 'http-only', status: 405 }, { strategy: 'sse-only', status: 404 }] as const) {
  test(`${strategy} fails at startup without falling back on ${status}`, async () => {
    const requests: string[] = [];
    const server = Bun.serve({ port: 0, fetch(request) { requests.push(request.method); return new Response(null, { status }); } });
    const connection = await createMcpRemoteConnection(server.url.toString(), { connection: { transportStrategy: strategy }, allowAuthorization: false });
    try {
      await expect((async () => { await connection.transport.start(); await connection.transport.send(init); })()).rejects.toMatchObject({ code: status });
      expect(requests).toEqual([strategy === 'http-only' ? 'POST' : 'GET']);
    } finally { await connection.close(); server.stop(true); }
  });
}

test('session recovery settles an accepted concurrent SSE call before retiring its transport', async () => {
  let sessions = 0;
  let accepted = false;
  const server = Bun.serve({ port: 0, async fetch(request) {
    if (request.method === 'GET') return new Response(null, { status: 405 });
    const message = await request.json() as any;
    if (message.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: message.id, result }, { headers: { 'mcp-session-id': `session-${++sessions}` } });
    if (!('id' in message)) return new Response(null, { status: 202 });
    if (message.params.name === 'accepted') return new Response(new ReadableStream({ start(controller) { accepted = true; controller.enqueue(new TextEncoder().encode(': accepted\n\n')); } }), { headers: { 'content-type': 'text/event-stream' } });
    if (request.headers.get('mcp-session-id') === 'session-1') return new Response(null, { status: 404 });
    return Response.json({ jsonrpc: '2.0', id: message.id, result: { content: [] } });
  } });
  const connection = await connectMcpHttpClient(server.url.toString(), { allowAuthorization: false });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const long = connection.client.callTool({ name: 'accepted' });
    void long.catch(() => {});
    await waitFor(() => accepted);
    await connection.client.callTool({ name: 'expired' });
    await expect(Promise.race([long, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Accepted request was stranded')), 500); })])).rejects.toThrow('session expired');
    expect(sessions).toBe(2);
  } finally { if (timer) clearTimeout(timer); await connection.close(); server.stop(true); }
});

test('concurrent real connection processes coordinate insufficient-scope registration and consent', async () => {
  const { createHash } = await import('node:crypto');
  let origin = ''; let registrations = 0; let consents = 0; let invalid = 0; let arrivals = 0;
  let release: () => void = () => {}; const together = new Promise<void>((resolve) => { release = resolve; });
  const codes = new Map<string, string>();
  const server = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) return Response.json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    if (url.pathname === '/register') { registrations++; const metadata = await request.json() as any; return Response.json({ ...metadata, client_id: `registered-${registrations}` }, { status: 201 }); }
    if (url.pathname === '/authorize') {
      const code = `scope-consent-${++consents}`; codes.set(code, url.searchParams.get('code_challenge') ?? '');
      await new Promise((resolve) => setTimeout(resolve, 80));
      const callback = new URL(url.searchParams.get('redirect_uri') as string); callback.searchParams.set('state', url.searchParams.get('state') as string); callback.searchParams.set('code', code);
      return new Response(null, { status: 302, headers: { location: callback.toString() } });
    }
    if (url.pathname === '/token') { const body = new URLSearchParams(await request.text()); if (createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url') !== codes.get(body.get('code') ?? '')) { invalid++; return Response.json({ error: 'invalid_grant' }, { status: 400 }); } return Response.json({ access_token: 'scope-private-access', token_type: 'Bearer', expires_in: 3600 }); }
    if (request.method === 'GET') return new Response(null, { status: 405 });
    const message = await request.json() as any;
    if (message.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: message.id, result });
    if (!('id' in message)) return new Response(null, { status: 202 });
    if (request.headers.get('authorization') !== 'Bearer scope-private-access') { if (++arrivals === 2) release(); await together; return new Response(null, { status: 403, headers: { 'www-authenticate': `Bearer error="insufficient_scope", scope="expanded", resource_metadata="${origin}/.well-known/oauth-protected-resource"` } }); }
    return Response.json({ jsonrpc: '2.0', id: message.id, result: { content: [] } });
  } }); origin = server.url.origin;
  const children = Array.from({ length: 2 }, () => Bun.spawn(['bun', join(import.meta.dir, '../../fixtures/mcp-protocol-scope-worker.ts'), `${origin}/mcp`], { env: { ...process.env, HOME: fixtureHome, ALLAGENTS_TEST_HOME: fixtureHome }, stdout: 'pipe', stderr: 'pipe' }));
  try {
    const results = await Promise.all(children.map(async (child) => ({ exit: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() })));
    expect(results).toEqual([{ exit: 0, stdout: 'success\n', stderr: '' }, { exit: 0, stdout: 'success\n', stderr: '' }]);
    expect(registrations).toBe(1); expect(consents).toBe(1); expect(invalid).toBe(0);
  } finally { for (const child of children) child.kill(); server.stop(true); }
}, 10000);

for (const eventId of ['event-1', ' ']) {
test(`a primed POST stream (${JSON.stringify(eventId)}) resumes through the SDK and returns one result without replaying the tool`, async () => {
  let calls = 0; let resumes = 0; let pendingId: string | number = 0;
  const server = Bun.serve({ port: 0, async fetch(request) {
    if (request.method === 'GET') {
      if (!request.headers.has('last-event-id') || request.headers.get('last-event-id') !== eventId.trim()) return new Response(null, { status: 405 });
      resumes++;
      return new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: pendingId, result: { content: [] } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }
    const message = await request.json() as any;
    if (message.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: message.id, result });
    if (!('id' in message)) return new Response(null, { status: 202 });
    calls++; pendingId = message.id;
    return new Response(`id: ${eventId}\r\nretry: 5\r\ndata: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\r\n\r\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const connection = await connectMcpHttpClient(server.url.toString(), { allowAuthorization: false });
  const errors: Error[] = []; connection.client.onerror = (error) => { errors.push(error); };
  try {
    expect(await connection.client.callTool({ name: 'accepted' })).toEqual({ content: [] });
    expect(calls).toBe(1); expect(resumes).toBe(1); expect(errors).toEqual([]);
  } finally { await connection.close(); server.stop(true); }
});

}
