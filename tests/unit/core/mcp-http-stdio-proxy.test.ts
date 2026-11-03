import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  getBrowserOpenCommands,
  getMcpOAuthCacheDir,
  hashServerUrl,
  parseOAuthCallbackUrl,
  validateOAuthCallbackUrl,
  resolveMcpHeaderReferences,
} from '../../../src/core/mcp-http-stdio-proxy.js';
import {
  connectHttpMcpServer,
  connectMcpHttpClient,
  createOriginSafeMcpFetch,
  isMcpAuthorizationFailure,
} from '../../../src/core/mcp-http-client.js';
import {
  type DummyMcpOAuthServer,
  FIXTURE_ANSWER,
  FIXTURE_TOOL_NAME,
  startDummyMcpOAuthServer,
} from '../../helpers/dummy-mcp-oauth-server.js';


describe('resolveMcpHeaderReferences', () => {
  test('resolves exact environment references and preserves literal values', () => {
    expect(
      resolveMcpHeaderReferences(
        {
          Authorization: '${TRADINGVIEW_TOKEN}',
          'X-Literal': 'public',
        },
        { TRADINGVIEW_TOKEN: 'secret-token' },
      ),
    ).toEqual({
      Authorization: 'secret-token',
      'X-Literal': 'public',
    });
  });

  test('rejects a missing referenced environment variable', () => {
    expect(() =>
      resolveMcpHeaderReferences(
        { Authorization: '${TRADINGVIEW_TOKEN}' },
        {},
      ),
    ).toThrow("missing environment variable 'TRADINGVIEW_TOKEN'");
  });
});

describe('createOriginSafeMcpFetch', () => {
  test('lets transport headers override configured headers at the MCP origin', async () => {
    const calls: Array<{ url: string; headers: Headers; redirect?: RequestRedirect }> =
      [];
    const mcpFetch = createOriginSafeMcpFetch(
      'https://mcp.example/rpc',
      {
        Authorization: 'configured-secret',
        'Content-Length': '999',
        'X-Configured': 'same-origin-only',
      },
      async (input, init) => {
        calls.push({
          url: input.toString(),
          headers: new Headers(init?.headers),
          redirect: init?.redirect,
        });
        return new Response(null, { status: 204 });
      },
    );

    await mcpFetch(new URL('https://mcp.example/rpc'), {
      headers: {
        Authorization: 'Bearer sdk-token',
        Accept: 'application/json',
      },
    });

    expect(calls[0]?.headers.get('authorization')).toBe('Bearer sdk-token');
    expect(calls[0]?.headers.get('accept')).toBe('application/json');
    expect(calls[0]?.headers.get('content-length')).toBeNull();
    expect(calls[0]?.headers.get('x-configured')).toBe('same-origin-only');
    expect(calls[0]?.redirect).toBe('error');
  });

  test('never forwards configured headers to another origin', async () => {
    const calls: Headers[] = [];
    const mcpFetch = createOriginSafeMcpFetch(
      'https://mcp.example/rpc',
      { Authorization: 'configured-secret', 'X-Configured': 'private' },
      async (_input, init) => {
        calls.push(new Headers(init?.headers));
        return new Response(null, { status: 204 });
      },
    );

    await mcpFetch(new URL('https://identity.example/token'), {
      headers: { Accept: 'application/json' },
    });

    expect(calls[0]?.get('authorization')).toBeNull();
    expect(calls[0]?.get('x-configured')).toBeNull();
    expect(calls[0]?.get('accept')).toBe('application/json');
  });

  test('bounds response bodies without changing response metadata or no-body responses', async () => {
    const responses = [
      new Response('1234', {
        status: 201,
        statusText: 'Created',
        headers: { 'x-response': 'exact' },
      }),
      new Response('12345'),
      new Response(null, {
        status: 204,
        headers: { 'content-length': '999' },
      }),
    ];
    const mcpFetch = createOriginSafeMcpFetch(
      'https://mcp.example/rpc',
      {},
      async () => {
        const response = responses.shift();
        if (!response) throw new Error('unexpected fetch');
        return response;
      },
      { maxResponseBytes: 4 },
    );

    const exact = await mcpFetch(new URL('https://mcp.example/rpc'));
    expect(exact.status).toBe(201);
    expect(exact.statusText).toBe('Created');
    expect(exact.headers.get('x-response')).toBe('exact');
    await expect(exact.text()).resolves.toBe('1234');

    const over = await mcpFetch(new URL('https://mcp.example/rpc'));
    await expect(over.text()).rejects.toThrow(
      'MCP HTTP response exceeds 4 bytes',
    );

    const noBody = await mcpFetch(new URL('https://mcp.example/rpc'));
    expect(noBody.status).toBe(204);
    await expect(noBody.text()).resolves.toBe('');
  });

  test('bounds each SSE event instead of the total event stream', async () => {
    const responses = [
      new Response('data:1234\n\ndata:5678\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
      new Response('data:12345\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
    ];
    const mcpFetch = createOriginSafeMcpFetch(
      'https://mcp.example/rpc',
      {},
      async () => {
        const response = responses.shift();
        if (!response) throw new Error('unexpected fetch');
        return response;
      },
      { maxResponseBytes: 10 },
    );

    const boundedStream = await mcpFetch(new URL('https://mcp.example/rpc'));
    await expect(boundedStream.text()).resolves.toBe(
      'data:1234\n\ndata:5678\n\n',
    );

    const oversizedEvent = await mcpFetch(new URL('https://mcp.example/rpc'));
    await expect(oversizedEvent.text()).rejects.toThrow(
      'MCP HTTP SSE event exceeds 10 bytes',
    );
  });
});

describe('MCP authorization failures', () => {
  test('recognizes SDK unauthorized, invalid-grant, and interactive-consent failures', () => {
    expect(isMcpAuthorizationFailure(new UnauthorizedError())).toBe(true);
    expect(
      isMcpAuthorizationFailure(new InvalidGrantError('refresh expired')),
    ).toBe(true);
    expect(
      isMcpAuthorizationFailure(
        new Error('OAuth authorization requires an interactive terminal'),
      ),
    ).toBe(true);
    expect(isMcpAuthorizationFailure(new Error('network unavailable'))).toBe(
      false,
    );
  });
});

describe('connectMcpHttpClient', () => {
  test('resolves exact query references only on requests while preserving duplicate and ordinary parameters', async () => {
    const secret = "fixture &=+/ #?ü'";
    const encodedSecret = encodeURIComponent(secret);
    const requests: string[] = [];
    const server = createServer(async (request, response) => {
      requests.push(request.url ?? '');
      if (request.method === 'GET') {
        response.writeHead(405).end();
        return;
      }
      let body = '';
      for await (const chunk of request) body += chunk.toString();
      const message = JSON.parse(body) as {
        id?: string | number;
        method: string;
        params?: { protocolVersion?: string };
      };
      if (message.method === 'initialize') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: message.params?.protocolVersion,
              capabilities: {},
              serverInfo: { name: 'query-reference-test', version: '0.0.0' },
            },
          }),
        );
        return;
      }
      response.writeHead(202).end();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('HTTP fixture did not expose a TCP port');
      }
      const authoredUrl = `http://127.0.0.1:${address.port}/mcp?token=\${MCP_QUERY_SECRET}&token=public&token=\${MCP_QUERY_SECRET}&ordinary=a+b&escape=%2f&partial=prefix\${UNSET}&empty=&flag`;
      const config = { url: authoredUrl };
      const connection = await connectMcpHttpClient(config.url, {
        allowAuthorization: false,
        environment: { MCP_QUERY_SECRET: secret },
      });
      try {
        expect(requests.length).toBeGreaterThan(0);
        const expected = new URL(
          authoredUrl.replaceAll('${MCP_QUERY_SECRET}', encodedSecret),
        );
        for (const request of requests) {
          expect(request).toBe(`${expected.pathname}${expected.search}`);
          expect(
            new URL(request, authoredUrl).searchParams.getAll('token'),
          ).toEqual([secret, 'public', secret]);
        }
        expect(config.url).toBe(authoredUrl);
        expect(config.url).not.toContain(secret);
        expect(config.url).not.toContain(encodedSecret);
        for (const reflected of [
          secret,
          encodedSecret,
          encodedSecret.replaceAll("'", '%27'),
        ]) {
          expect(() => connection.credentialGuard.assertSafe(reflected)).toThrow(
            'MCP output contained a configured credential value',
          );
        }
      } finally {
        await connection.close();
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  });

  test('rejects missing query references before making any request without exposing the URL', async () => {
    let requested = false;
    const result = connectMcpHttpClient(
      'https://mcp.example/rpc?token=${MISSING_MCP_QUERY_TOKEN}&ordinary=private-url-value',
      {
        allowAuthorization: false,
        environment: {},
        fetch: async () => {
          requested = true;
          throw new Error('unexpected request');
        },
      },
    );
    await expect(result).rejects.toThrow(
      "MCP URL query parameter references missing environment variable 'MISSING_MCP_QUERY_TOKEN'",
    );
    expect(requested).toBe(false);
    await expect(result).rejects.not.toThrow('private-url-value');
  });

  test.each([
    ['raw', '${MCP_QUERY_SECRET}'],
    ['encoded', '${MCP_QUERY_SECRET}'],
    ['url-encoded', '${MCP_QUERY_SECRET}'],
    ['encoded', '%24%7BMCP_QUERY_SECRET%7D'],
    ['encoded', '$%7BMCP_QUERY_SECRET%7D'],
    ['encoded', '%24{MCP_QUERY_SECRET}'],
  ])(
    'sanitizes %s credentials reflected from query reference %s',
    async (reflection, reference) => {
      const secret = "reflected &=+/ #?ü'";
      const encodedSecret = encodeURIComponent(secret);
      const reflected = reflection === 'raw'
        ? secret
        : reflection === 'url-encoded'
          ? encodedSecret.replaceAll("'", '%27')
          : encodedSecret;
      const requests: string[] = [];
      const result = connectMcpHttpClient(
        `https://mcp.example/rpc?token=${reference}`,
        {
          allowAuthorization: false,
          environment: { MCP_QUERY_SECRET: secret },
          fetch: async (input, init) => {
            requests.push(input.toString());
            return init?.method === 'GET'
              ? new Response(null, { status: 405 })
              : new Response(`rejected ${reflected}`, { status: 500 });
          },
        },
      );
      await expect(result).rejects.toThrow(
        'MCP output contained a configured credential value',
      );
      await expect(result).rejects.not.toThrow(secret);
      await expect(result).rejects.not.toThrow(encodeURIComponent(secret));
      await expect(result).rejects.not.toThrow(reflected);
      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests) {
        expect(new URL(request).searchParams.get('token')).toBe(secret);
      }
    },
  );

  test('closes a created transport when initialization fails', async () => {
    let transportSignal: AbortSignal | undefined;

    await expect(
      connectMcpHttpClient('https://mcp.example/rpc', {
        allowAuthorization: false,
        fetch: async (_input, init) => {
          transportSignal = init?.signal ?? undefined;
          if (init?.method === 'GET') {
            return new Response(null, { status: 405 });
          }
          return new Response('initialization failed', {
            status: 500,
            statusText: 'Internal Server Error',
          });
        },
      }),
    ).rejects.toThrow('Streamable HTTP error');

    expect(transportSignal?.aborted).toBe(true);
  });

  test('propagates startup cancellation and closes the pending transport', async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    let transportSignal: AbortSignal | undefined;
    const connection = connectMcpHttpClient('https://mcp.example/rpc', {
      allowAuthorization: false,
      signal: controller.signal,
      fetch: async (_input, init) => {
        if (init?.method === 'GET') {
          return new Response(null, { status: 405 });
        }
        transportSignal = init?.signal ?? undefined;
        started.resolve();
        const pending = Promise.withResolvers<Response>();
        init?.signal?.addEventListener(
          'abort',
          () => pending.reject(init.signal?.reason),
          { once: true },
        );
        return pending.promise;
      },
    });

    await started.promise;
    controller.abort();

    await expect(connection).rejects.toThrow();
    expect(transportSignal?.aborted).toBe(true);
  });

  test('guards credential components from configured authorization headers', async () => {
    const connection = await connectMcpHttpClient(
      'https://mcp.example/rpc',
      {
        allowAuthorization: false,
        headers: {
          Authorization: 'Bearer header-secret',
          'Proxy-Authorization': 'Basic proxy-secret',
        },
        fetch: async (_input, init) => {
          if (init?.method === 'GET') {
            return new Response(null, { status: 405 });
          }
          const message = JSON.parse(String(init?.body)) as {
            id?: string | number;
            method: string;
            params?: { protocolVersion?: string };
          };
          if (message.method === 'initialize') {
            return Response.json({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                protocolVersion: message.params?.protocolVersion,
                capabilities: {},
                serverInfo: { name: 'runtime-test', version: '0.0.0' },
              },
            });
          }
          return new Response(null, { status: 202 });
        },
      },
    );

    try {
      expect(() =>
        connection.credentialGuard.assertSafe('echoed header-secret'),
      ).toThrow('MCP output contained a configured credential value');
      expect(() =>
        connection.credentialGuard.assertSafe('echoed proxy-secret'),
      ).toThrow('MCP output contained a configured credential value');
    } finally {
      await connection.close();
    }
  });
});

describe('HTTP OAuth client-name compatibility', () => {
  let home: string;
  let server: DummyMcpOAuthServer | undefined;
  const originalHome = process.env.ALLAGENTS_TEST_HOME;
  const originalNoBrowser = process.env.ALLAGENTS_MCP_OAUTH_NO_BROWSER;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'allagents-oauth-client-name-'));
    process.env.ALLAGENTS_TEST_HOME = home;
    process.env.ALLAGENTS_MCP_OAUTH_NO_BROWSER = '1';
  });

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    await rm(home, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.ALLAGENTS_TEST_HOME;
    else process.env.ALLAGENTS_TEST_HOME = originalHome;
    if (originalNoBrowser === undefined) {
      delete process.env.ALLAGENTS_MCP_OAUTH_NO_BROWSER;
    } else {
      process.env.ALLAGENTS_MCP_OAUTH_NO_BROWSER = originalNoBrowser;
    }
  });

  const authorize = async ({ authorizationUrl }: { authorizationUrl: URL }) => {
    const response = await fetch(authorizationUrl, { redirect: 'manual' });
    expect(response.status).toBe(302);
    const location = response.headers.get('location');
    if (!location) throw new Error('OAuth fixture did not return a callback');
    return location;
  };

  test('keeps authored query URLs as cache and reauthorization identities after environment rotation', async () => {
    server = await startDummyMcpOAuthServer();
    const originalToken = process.env.ALLAGENTS_TEST_QUERY_TOKEN;
    const authoredUrl = `${server.mcpUrl}?token=\${ALLAGENTS_TEST_QUERY_TOKEN}`;
    const options = {
      profile: 'markets',
      clientName: 'Codex',
      authorizationOutput: () => {},
      callbackUrlReader: authorize,
    };
    const cacheDir = getMcpOAuthCacheDir(authoredUrl, 'markets', 'Codex');
    try {
      process.env.ALLAGENTS_TEST_QUERY_TOKEN = 'first &= query credential';
      await connectHttpMcpServer(authoredUrl, options);
      const tokens = await readFile(join(cacheDir, 'tokens.json'), 'utf-8');
      expect(server.authorizeCallCount).toBe(1);

      process.env.ALLAGENTS_TEST_QUERY_TOKEN = 'rotated &= query credential';
      await connectHttpMcpServer(authoredUrl, {
        ...options,
        allowAuthorization: false,
      });
      expect(server.authorizeCallCount).toBe(1);
      expect(await readFile(join(cacheDir, 'tokens.json'), 'utf-8')).toBe(tokens);

      await connectHttpMcpServer(authoredUrl, {
        ...options,
        resetCredentials: true,
      });
      expect(server.authorizeCallCount).toBe(2);
      expect(await readFile(join(cacheDir, 'tokens.json'), 'utf-8')).not.toBe(
        tokens,
      );
      for (const secret of [
        'first &= query credential',
        'rotated &= query credential',
      ]) {
        const resolvedUrl = authoredUrl.replace(
          '${ALLAGENTS_TEST_QUERY_TOKEN}',
          encodeURIComponent(secret),
        );
        await expect(
          readFile(join(
            getMcpOAuthCacheDir(resolvedUrl, 'markets', 'Codex'),
            'tokens.json',
          )),
        ).rejects.toThrow();
      }
    } finally {
      if (originalToken === undefined) {
        delete process.env.ALLAGENTS_TEST_QUERY_TOKEN;
      } else {
        process.env.ALLAGENTS_TEST_QUERY_TOKEN = originalToken;
      }
    }
  }, 15000);

  test.each(['Codex', 'Claude Code'])(
    'authorizes and calls a tool as %s when registration rejects the default',
    async (clientName) => {
      server = await startDummyMcpOAuthServer({
        allowedClientNames: [clientName],
      });
      await expect(
        connectMcpHttpClient(server.mcpUrl, {
          authorizationOutput: () => {},
          callbackUrlReader: authorize,
        }),
      ).rejects.toThrow();
      expect(server.authorizeCallCount).toBe(0);

      const connection = await connectMcpHttpClient(server.mcpUrl, {
        clientName: ` ${clientName} `,
        authorizationOutput: () => {},
        callbackUrlReader: authorize,
      });
      try {
        const result = await connection.client.callTool({
          name: FIXTURE_TOOL_NAME,
          arguments: { question: 'OAuth client identity compatibility' },
        });
        expect(result.content).toEqual([{ type: 'text', text: FIXTURE_ANSWER }]);
        expect(server.authorizeCallCount).toBe(1);
        expect(server.tokenCallCounts.authorization_code).toBe(1);
      } finally {
        await connection.close();
      }
    },
    15000,
  );

  test.each([undefined, 'markets'])(
    'isolates identity credentials and reset while preserving the default cache (profile %s)',
    async (profile) => {
      server = await startDummyMcpOAuthServer();
      const options = {
        ...(profile === undefined ? {} : { profile }),
        authorizationOutput: () => {},
        callbackUrlReader: authorize,
      };
      await connectHttpMcpServer(server.mcpUrl, options);
      const defaultCache = getMcpOAuthCacheDir(server.mcpUrl, profile);
      const defaultTokens = await readFile(join(defaultCache, 'tokens.json'), 'utf-8');
      const defaultClient = await readFile(join(defaultCache, 'client-info.json'), 'utf-8');
      const oldBearer = `Bearer ${JSON.parse(defaultTokens).access_token}`;
      const requestsBeforeAlias = server.mcpRequestHeaders.length;

      await expect(
        connectHttpMcpServer(server.mcpUrl, {
          ...options,
          clientName: 'Codex',
          allowAuthorization: false,
        }),
      ).rejects.toThrow('OAuth authorization requires an interactive terminal');
      expect(server.authorizeCallCount).toBe(1);

      await connectHttpMcpServer(server.mcpUrl, { ...options, clientName: 'Codex' });
      expect(server.authorizeCallCount).toBe(2);
      const aliasCache = getMcpOAuthCacheDir(server.mcpUrl, profile, 'Codex');
      const aliasTokens = await readFile(join(aliasCache, 'tokens.json'), 'utf-8');
      const aliasClient = JSON.parse(
        await readFile(join(aliasCache, 'client-info.json'), 'utf-8'),
      );
      expect(aliasTokens).not.toBe(defaultTokens);
      expect(aliasClient.client_name).toBe('Codex');
      expect(aliasClient.client_id).not.toBe(JSON.parse(defaultClient).client_id);
      expect(
        server.mcpRequestHeaders.slice(requestsBeforeAlias)
          .some((headers) => headers.authorization === oldBearer),
      ).toBe(false);
      expect(server.tokenCallCounts.refresh_token).toBe(0);

      await expect(
        connectHttpMcpServer(server.mcpUrl, {
          ...options,
          clientName: 'Codex',
          resetCredentials: true,
          callbackUrlReader: async () => {
            throw new Error('Consent cancelled');
          },
        }),
      ).rejects.toThrow('Consent cancelled');
      expect(await readFile(join(aliasCache, 'tokens.json'), 'utf-8')).toBe(aliasTokens);
      await connectHttpMcpServer(server.mcpUrl, {
        ...options,
        clientName: 'Codex',
        resetCredentials: true,
      });
      expect(await readFile(join(aliasCache, 'tokens.json'), 'utf-8')).not.toBe(aliasTokens);
      expect(server.authorizeCallCount).toBe(3);

      await connectHttpMcpServer(server.mcpUrl, {
        ...options,
        clientName: 'AllAgents',
        allowAuthorization: false,
      });
      expect(server.authorizeCallCount).toBe(3);
      expect(await readFile(join(defaultCache, 'tokens.json'), 'utf-8')).toBe(defaultTokens);
      expect(await readFile(join(defaultCache, 'client-info.json'), 'utf-8')).toBe(defaultClient);

      const resetAliasTokens = await readFile(join(aliasCache, 'tokens.json'), 'utf-8');
      await connectHttpMcpServer(server.mcpUrl, {
        ...options,
        resetCredentials: true,
      });
      await connectHttpMcpServer(server.mcpUrl, {
        ...options,
        clientName: 'Codex',
        allowAuthorization: false,
      });
      expect(server.authorizeCallCount).toBe(4);
      expect(await readFile(join(aliasCache, 'tokens.json'), 'utf-8')).toBe(resetAliasTokens);
    },
    15000,
  );
});

describe('getBrowserOpenCommands', () => {
  test('uses explorer on Windows so OAuth URLs are not parsed by cmd', () => {
    const url =
      'https://idp.example/auth?response_type=code&client_id=test&state=abc';

    expect(getBrowserOpenCommands(url, 'win32')).toEqual([
      { command: 'explorer.exe', args: [url] },
    ]);
  });
});

describe('getMcpOAuthCacheDir', () => {
  const originalHome = process.env.ALLAGENTS_TEST_HOME;
  const home = '/tmp/allagents-mcp-oauth-home';
  const url = 'https://mcp.tradingview.com/mcp';

  beforeEach(() => {
    process.env.ALLAGENTS_TEST_HOME = home;
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.ALLAGENTS_TEST_HOME;
    } else {
      process.env.ALLAGENTS_TEST_HOME = originalHome;
    }
  });

  test('shares ordinary project and user credentials by URL', () => {
    expect(getMcpOAuthCacheDir(url)).toBe(
      join(home, '.allagents', 'oauth-proxy', hashServerUrl(url)),
    );
  });

  test('isolates credentials inside each profile root', () => {
    expect(getMcpOAuthCacheDir(url, 'markets')).toBe(
      join(
        home,
        '.allagents',
        'profiles',
        'markets',
        'oauth-proxy',
        hashServerUrl(url),
      ),
    );
    expect(getMcpOAuthCacheDir(url, 'research')).not.toBe(
      getMcpOAuthCacheDir(url, 'markets'),
    );
  });

  test('preserves the default cache for an explicit AllAgents identity', () => {
    expect(getMcpOAuthCacheDir(url, undefined, 'AllAgents')).toBe(
      getMcpOAuthCacheDir(url),
    );
    expect(getMcpOAuthCacheDir(url, 'markets', ' AllAgents ')).toBe(
      getMcpOAuthCacheDir(url, 'markets'),
    );
  });

  test('isolates nondefault names without putting names in filesystem paths', () => {
    const codex = getMcpOAuthCacheDir(url, 'markets', 'Codex');
    expect(codex).not.toBe(getMcpOAuthCacheDir(url, 'markets'));
    expect(codex).not.toBe(getMcpOAuthCacheDir(url, 'markets', 'Claude Code'));
    expect(codex).not.toBe(getMcpOAuthCacheDir(url, 'research', 'Codex'));
    expect(codex).toBe(getMcpOAuthCacheDir(url, 'markets', ' Codex '));
    expect(codex).not.toContain('Codex');
    expect(getMcpOAuthCacheDir(url, undefined, '../outside')).not.toContain('outside');
  });

  test.each(['', '   '])('rejects an empty configured identity %j', (clientName) => {
    expect(() => getMcpOAuthCacheDir(url, undefined, clientName)).toThrow(
      'OAuth client name must not be empty',
    );
  });

  test('rejects unsafe profile names before constructing a path', () => {
    expect(() => getMcpOAuthCacheDir(url, '../outside')).toThrow();
  });
});

describe('parseOAuthCallbackUrl', () => {
  const redirectUrl = 'http://127.0.0.1:38421/callback';
  const state = 'expected-state';

  test('returns the code from the registered callback URL', () => {
    expect(
      parseOAuthCallbackUrl(
        `${redirectUrl}?code=authorization-code&state=${state}`,
        redirectUrl,
        state,
      ),
    ).toBe('authorization-code');
  });

  test.each([
    [
      'different state',
      `${redirectUrl}?code=authorization-code&state=wrong-state`,
      'OAuth state validation failed',
    ],
    [
      'duplicate state',
      `${redirectUrl}?code=authorization-code&state=${state}&state=${state}`,
      'OAuth state validation failed',
    ],
    [
      'missing state',
      `${redirectUrl}?code=authorization-code`,
      'OAuth state validation failed',
    ],
    [
      'different loopback port',
      `http://127.0.0.1:9999/callback?code=authorization-code&state=${state}`,
      'OAuth callback URL does not match',
    ],
    [
      'different callback path',
      `http://127.0.0.1:38421/other?code=authorization-code&state=${state}`,
      'OAuth callback URL does not match',
    ],
    [
      'embedded credentials',
      `http://user@127.0.0.1:38421/callback?code=authorization-code&state=${state}`,
      'OAuth callback URL does not match',
    ],
    [
      'fragment',
      `${redirectUrl}?code=authorization-code&state=${state}#fragment`,
      'OAuth callback URL does not match',
    ],
    [
      'missing code',
      `${redirectUrl}?state=${state}`,
      'No OAuth authorization code received',
    ],
    [
      'empty code',
      `${redirectUrl}?code=&state=${state}`,
      'No OAuth authorization code received',
    ],
    [
      'duplicate code',
      `${redirectUrl}?code=one&code=two&state=${state}`,
      'No OAuth authorization code received',
    ],
    [
      'code and error',
      `${redirectUrl}?code=one&error=access_denied&state=${state}`,
      'Invalid OAuth authorization response',
    ],
  ])('rejects a callback with %s', (_name, callbackUrl, message) => {
    expect(() =>
      parseOAuthCallbackUrl(callbackUrl, redirectUrl, state),
    ).toThrow(message);
  });

  test('accepts an authorization denial as a valid callback envelope', () => {
    const callbackUrl = `${redirectUrl}?error=access_denied&state=${state}`;

    expect(() =>
      validateOAuthCallbackUrl(callbackUrl, redirectUrl, state),
    ).not.toThrow();
    expect(() =>
      parseOAuthCallbackUrl(callbackUrl, redirectUrl, state),
    ).toThrow('OAuth authorization failed');
  });

  test('does not include provider-controlled error text in the exception', () => {
    expect(() =>
      parseOAuthCallbackUrl(
        `${redirectUrl}?error=%1B%5B31maccess_denied&state=${state}`,
        redirectUrl,
        state,
      ),
    ).toThrow(new Error('OAuth authorization failed'));
  });
});
