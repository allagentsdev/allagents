import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { createMcpNetwork } from '../../../src/core/mcp-network.js';

describe('MCP connection networking', () => {
  test('uses the configured proxy without changing the process dispatcher', async () => {
    let tunnels = 0;
    const sockets = new Set<Socket>();
    const target = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { return new Response('through proxy'); } });
    const proxy = createServer((_request, response) => { response.writeHead(502); response.end(); });
    proxy.on('connect', (request, incoming, head) => {
      tunnels++;
      const destination = new URL(`http://${request.url}`);
      const outgoing = connect(Number(destination.port), destination.hostname, () => {
        incoming.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) outgoing.write(head);
        outgoing.pipe(incoming); incoming.pipe(outgoing);
      });
      sockets.add(incoming); sockets.add(outgoing);
      outgoing.on('error', () => incoming.destroy());
      incoming.on('error', () => outgoing.destroy());
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const network = createMcpNetwork({ serverUrl: target.url.toString(), connection: { enableProxy: true }, environment: { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: '' } });
    try {
      const response = await network.fetch(target.url);
      expect(await response.text()).toBe('through proxy');
      expect(tunnels).toBe(1);
    } finally {
      await network.close(); target.stop(true);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
  });
  test('uses the real per-connection dispatcher and closes it after a real request', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
      return Response.json({ path: new URL(request.url).pathname });
    } });
    const network = createMcpNetwork({ serverUrl: `http://127.0.0.1:${server.port}`, connection: { ipv4: true } });
    try {
      const response = await network.fetch(`http://127.0.0.1:${server.port}/probe`);
      expect(await response.json()).toEqual({ path: '/probe' });
    } finally { await network.close(); server.stop(true); }
  });
  test('keeps sticky cookies within the exact response origin', async () => {
    const seen: Array<{ url: string; cookie: string | null }> = [];
    const network = createMcpNetwork({
      serverUrl: 'https://resource.example.test/mcp',
      fetch: async (input, init) => {
        seen.push({ url: String(input), cookie: new Headers(init?.headers).get('cookie') });
        return new Response('ok', { headers: { 'set-cookie': 'route=node-2; Domain=.example.test; Path=/' } });
      },
    });
    try {
      await network.fetch('https://resource.example.test/mcp');
      await network.fetch('https://resource.example.test/messages');
      await network.fetch('https://identity.example.test/token');
      expect(seen.map(entry => entry.cookie)).toEqual([null, 'route=node-2', null]);
    } finally { await network.close(); }
  });

  test('preserves explicit cookies and supports disabling automatic cookies', async () => {
    const seen: Array<string | null> = [];
    const network = createMcpNetwork({
      serverUrl: 'https://example.test/mcp', connection: { disableCookies: true },
      fetch: async (_input, init) => {
        seen.push(new Headers(init?.headers).get('cookie'));
        return new Response('ok', { headers: { 'set-cookie': 'route=automatic' } });
      },
    });
    try {
      await network.fetch('https://example.test/mcp');
      await network.fetch('https://example.test/mcp');
      await network.fetch('https://example.test/mcp', { headers: { Cookie: 'route=explicit' } });
      expect(seen).toEqual([null, null, 'route=explicit']);
    } finally { await network.close(); }
  });

  test('bounds waiting for response headers and cancels the request', async () => {
    let aborted = false;
    const network = createMcpNetwork({
      serverUrl: 'https://example.test/mcp', connection: { headersTimeoutSeconds: 0.02 },
      fetch: async (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { aborted = true; reject(init.signal?.reason); }, { once: true });
      }),
    });
    try {
      await expect(network.fetch('https://example.test/mcp')).rejects.toThrow();
      expect(aborted).toBe(true);
    } finally { await network.close(); }
  });

  test('bounds an idle response body without imposing a total stream lifetime', async () => {
    let cancelled = false;
    const network = createMcpNetwork({
      serverUrl: 'https://example.test/mcp', connection: { bodyTimeoutSeconds: 0.02 },
      fetch: async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('first')); },
        cancel() { cancelled = true; },
      })),
    });
    try {
      const response = await network.fetch('https://example.test/mcp');
      await expect(response.text()).rejects.toThrow('idle');
      expect(cancelled).toBe(true);
    } finally { await network.close(); }
  });
});

test('sticky cookies retain their path scope, default path and same-name sessions', async () => {
  const seen: Array<string | null> = [];
  const network = createMcpNetwork({ serverUrl: 'https://example.test/mcp', fetch: async (input, init) => {
    seen.push(new Headers(init?.headers).get('cookie'));
    const headers = new Headers();
    if (new URL(String(input)).pathname === '/oauth/start') {
      headers.append('set-cookie', 'session=oauth-session; Path=/oauth; Secure');
      headers.append('set-cookie', 'session=root-session; Path=/');
      headers.append('set-cookie', 'default_scope=oauth-default');
    }
    return new Response(null, { headers });
  } });
  try {
    for (const path of ['/oauth/start', '/mcp', '/oauth/token', '/oauthish', '/oauth']) await network.fetch(`https://example.test${path}`);
    expect(seen).toEqual([null, 'session=root-session', 'session=oauth-session; default_scope=oauth-default; session=root-session', 'session=root-session', 'session=oauth-session; default_scope=oauth-default; session=root-session']);
  } finally { await network.close(); }
});

test('sticky Secure cookies are never replayed on an HTTP connection', async () => {
  const seen: Array<string | null> = [];
  const network = createMcpNetwork({ serverUrl: 'http://example.test/mcp', fetch: async (_input, init) => {
    seen.push(new Headers(init?.headers).get('cookie'));
    return new Response(null, { headers: { 'set-cookie': 'session=secure-session; Path=/; Secure' } });
  } });
  try { await network.fetch('http://example.test/mcp'); await network.fetch('http://example.test/mcp'); expect(seen).toEqual([null, null]); }
  finally { await network.close(); }
});
