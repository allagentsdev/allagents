import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CodexProfileAdapter } from '../../src/core/profile/adapters/codex.js';

// Uses a real SDK host and the packaged Node CLI. The npm prefix is replaced by
// the local artifact because this branch's bridge has not been released yet.
test('generated advanced Codex bridge authenticates OAuth references through the built Node CLI', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mcp-generated-policy-'));
  const values = {
    CLIENT_ID: 'generated-client',
    CLIENT_SECRET: 'generated-private-client-secret',
    API_KEY: 'generated-private-parameter',
    LOGIN_HINT: 'fixture-user@example.test',
  };
  let authorization: URL | undefined;
  let tokenAuthorization: string | null = null;
  let origin = '';
  let calls = 0;
  let client: Client | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fixture = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
        });
      if (url.pathname.startsWith('/.well-known/oauth-authorization-server'))
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic'],
        });
      if (url.pathname === '/authorize') {
        authorization = url;
        if (
          url.searchParams.get('client_id') !== values.CLIENT_ID ||
          url.searchParams.get('api_key') !== values.API_KEY ||
          url.searchParams.get('login_hint') !== values.LOGIN_HINT ||
          url.searchParams.get('audience') !== 'https://api.example.test/'
        )
          return new Response('invalid authorization', { status: 400 });
        const callback = new URL(url.searchParams.get('redirect_uri')!);
        callback.searchParams.set('code', 'fixture-code');
        callback.searchParams.set('state', url.searchParams.get('state')!);
        return Response.redirect(callback);
      }
      if (url.pathname === '/token') {
        tokenAuthorization = request.headers.get('authorization');
        const body = new URLSearchParams(await request.text());
        if (
          tokenAuthorization !==
            `Basic ${Buffer.from(`${values.CLIENT_ID}:${values.CLIENT_SECRET}`).toString('base64')}` ||
          body.get('code') !== 'fixture-code'
        )
          return Response.json({ error: 'invalid_client' }, { status: 401 });
        return Response.json({
          access_token: 'generated-access-token',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      if (
        request.headers.get('authorization') !== 'Bearer generated-access-token'
      )
        return new Response(null, {
          status: 401,
          headers: {
            'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
          },
        });
      if (request.method === 'GET') return new Response(null, { status: 405 });
      if (request.method === 'DELETE')
        return new Response(null, { status: 200 });
      const message = (await request.json()) as {
        id?: string | number;
        method?: string;
      };
      if (message.method === 'initialize')
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'generated-policy-peer', version: '1' },
          },
        });
      if (message.method === 'tools/list')
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            tools: [
              { name: 'read_record', inputSchema: { type: 'object' } },
              { name: 'delete_record', inputSchema: { type: 'object' } },
            ],
          },
        });
      if (message.method === 'tools/call') {
        calls++;
        return Response.json({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            content: [{ type: 'text', text: 'authenticated generated bridge' }],
          },
        });
      }
      return new Response(null, { status: 202 });
    },
  });
  try {
    origin = fixture.url.origin;
    const adapter = new CodexProfileAdapter();
    const context = adapter.resolveContext('work', {
      homeDir: home,
      workspaceDirectory: home,
    });
    const file = adapter.serializeSettings(context, {
      plugins: [],
      mcpServers: {
        remote: {
          url: `${origin}/mcp`,
          oauth: {
            clientId: '${CLIENT_ID}',
            clientSecret: '${CLIENT_SECRET}',
            authorizationParams: {
              api_key: '${API_KEY}',
              login_hint: '${LOGIN_HINT}',
              audience: 'https://api.example.test/',
            },
          },
          connection: {
            transportStrategy: 'http-only',
            ignoreTools: ['delete*'],
          },
        },
      },
    })!;
    const document = Bun.TOML.parse(file.content) as {
      mcp_servers: {
        remote: { args: string[]; env_vars: Array<keyof typeof values> };
      };
    };
    const generated = document.mcp_servers.remote;
    expect(generated.args.join(' ')).not.toContain('${');
    for (const secret of Object.values(values))
      expect(generated.args.join(' ')).not.toContain(secret);
    const transport = new StdioClientTransport({
      command: 'node',
      args: [
        join(import.meta.dir, '../../dist/index.js'),
        ...generated.args.slice(2),
      ],
      cwd: home,
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([name]) => !(name in values)),
        ),
        HOME: home,
        ALLAGENTS_TEST_HOME: home,
        ALLAGENTS_MCP_OAUTH_NO_BROWSER: '1',
        ...Object.fromEntries(
          generated.env_vars.map((name) => [name, values[name]]),
        ),
      } as Record<string, string>,
      stderr: 'pipe',
    });
    let stderr = '';
    let authorizing: Promise<Response> | undefined;
    transport.stderr?.setEncoding('utf8');
    transport.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
      const match = /If the browser does not open, visit: (\S+)\n/.exec(stderr);
      if (match && !authorizing) {
        authorizing = fetch(match[1]!);
        void authorizing.catch(() => {});
      }
    });
    client = new Client(
      { name: 'real-generated-policy-host', version: '1' },
      { capabilities: {} },
    );
    timer = setTimeout(() => {
      void transport.close();
    }, 12000);
    await client.connect(transport, { timeout: 10000 });
    expect(client.getServerVersion()?.name).toBe('generated-policy-peer');
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      'read_record',
    ]);
    expect((await client.callTool({ name: 'read_record' })).content).toEqual([
      { type: 'text', text: 'authenticated generated bridge' },
    ]);
    expect(calls).toBe(1);
    expect(authorization?.searchParams.get('api_key')).toBe(values.API_KEY);
    expect(tokenAuthorization).toBe(
      `Basic ${Buffer.from(`${values.CLIENT_ID}:${values.CLIENT_SECRET}`).toString('base64')}`,
    );
    expect((await authorizing)?.status).toBe(200);
  } finally {
    if (timer) clearTimeout(timer);
    await client?.close();
    fixture.stop(true);
    await rm(home, { recursive: true, force: true });
  }
}, 15000);
