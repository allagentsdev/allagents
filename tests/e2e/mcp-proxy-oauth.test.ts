import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectHttpMcpServer,
  getMcpOAuthCacheDir,
  hashServerUrl,
} from '../../src/core/mcp-http-stdio-proxy.ts';
import {
  type DummyMcpOAuthServer,
  FIXTURE_ANSWER,
  FIXTURE_TOOL_NAME,
  startDummyMcpOAuthServer,
} from '../helpers/dummy-mcp-oauth-server.ts';
import {
  connectToMcpProxy,
  type McpProxyConnection,
} from '../helpers/mcp-proxy-client.ts';
import { addManagedMcpServer, reauthenticateManagedMcpServer } from '../../src/core/mcp-management.js';
import { connectManagedMcpServer } from '../../src/core/mcp-runtime.js';
import { getMcpServer, type McpDestination } from '../../src/core/mcp-servers.js';
import { ClaudeProfileAdapter } from '../../src/core/profile/adapters/claude.js';
import { CodexProfileAdapter } from '../../src/core/profile/adapters/codex.js';
import { CopilotProfileAdapter } from '../../src/core/profile/adapters/copilot.js';
import { OmpProfileAdapter } from '../../src/core/profile/adapters/omp.js';
import { OpenCodeProfileAdapter } from '../../src/core/profile/adapters/opencode.js';

function connectAndAutoAuthorize(
  serverUrl: string,
  homeDir: string,
): Promise<McpProxyConnection> {
  return connectToMcpProxy({
    serverUrl,
    env: { HOME: homeDir, ALLAGENTS_MCP_OAUTH_NO_BROWSER: '1' },
    // Simulates the browser: the dummy IdP auto-approves and 302s straight to the
    // loopback callback, so a plain fetch completes the flow with no human involved.
    onAuthorizationUrl: (url) => {
      fetch(url).catch((error) => {
        console.error('auto-authorize fetch failed:', error);
      });
    },
  });
}

describe('mcp proxy OAuth e2e', () => {
  let homeDir: string;
  let dummy: DummyMcpOAuthServer | undefined;
  const originalTestHome = process.env.ALLAGENTS_TEST_HOME;
  const originalNoBrowser = process.env.ALLAGENTS_MCP_OAUTH_NO_BROWSER;

  beforeEach(() => {
    homeDir = join(
      tmpdir(),
      `allagents-e2e-oauth-home-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(homeDir, { recursive: true });
    process.env.ALLAGENTS_TEST_HOME = homeDir;
    process.env.ALLAGENTS_MCP_OAUTH_NO_BROWSER = '1';
  });

  afterEach(async () => {
    rmSync(homeDir, { recursive: true, force: true });
    await dummy?.stop();
    dummy = undefined;
    if (originalTestHome === undefined) {
      delete process.env.ALLAGENTS_TEST_HOME;
    } else {
      process.env.ALLAGENTS_TEST_HOME = originalTestHome;
    }
    if (originalNoBrowser === undefined) {
      delete process.env.ALLAGENTS_MCP_OAUTH_NO_BROWSER;
    } else {
      process.env.ALLAGENTS_MCP_OAUTH_NO_BROWSER = originalNoBrowser;
    }
  });

  for (const kind of ['project', 'user', 'profile'] as const) {
    test(`authenticates, persists, calls and reauthenticates the ${kind} OAuth identity`, async () => {
      dummy = await startDummyMcpOAuthServer({ allowedClientNames: ['Codex'] });
      const workspacePath = kind === 'project' ? join(homeDir, 'project') : homeDir;
      const configPath = join(workspacePath, '.allagents', 'workspace.yaml');
      mkdirSync(join(workspacePath, '.allagents'), { recursive: true });
      writeFileSync(configPath, JSON.stringify({
        repositories: [], plugins: [], clients: [],
        ...(kind === 'profile' ? { profiles: { work: { clients: [{ name: 'codex' }] } } } : {}),
      }));
      const destination: McpDestination = kind === 'profile'
        ? { kind, name: 'work', configPath }
        : kind === 'project' ? { kind, workspacePath, configPath } : { kind, configPath };
      const authorization = {
        output() {},
        async readCallback({ authorizationUrl }: { authorizationUrl: URL }) {
          const response = await fetch(authorizationUrl, { redirect: 'manual' });
          const location = response.headers.get('location');
          if (!location) throw new Error('Missing fixture callback');
          return new URL(location, authorizationUrl).toString();
        },
      };
      await expect(connectHttpMcpServer(dummy.mcpUrl, {
        callbackUrlReader: authorization.readCallback,
        authorizationOutput: authorization.output,
      })).rejects.toThrow();
      expect(dummy.authorizeCallCount).toBe(0);
      await addManagedMcpServer({
        destination, name: 'remote',
        config: { url: dummy.mcpUrl, oauth: { clientName: 'Codex' } },
        authorization,
      });
      expect(await getMcpServer(destination, 'remote')).toMatchObject({
        oauth: { clientName: 'Codex' },
      });
      const session = await connectManagedMcpServer(destination, 'remote');
      try {
        const result = await session.client.callTool({
          name: FIXTURE_TOOL_NAME, arguments: { question: 'managed identity' },
        });
        expect(result.content).toEqual([{ type: 'text', text: FIXTURE_ANSWER }]);
      } finally {
        await session.close();
      }
      expect(dummy.authorizeCallCount).toBe(1);
      await reauthenticateManagedMcpServer(destination, 'remote', authorization);
      expect(dummy.authorizeCallCount).toBe(2);
      expect(dummy.activeSessionCount).toBe(0);
    }, 15_000);
  }

  test('runs standalone profile adapter bridges against a name-gated OAuth server', async () => {
    dummy = await startDummyMcpOAuthServer({ allowedClientNames: ['Claude Code'] });
    const adapters = [
      new ClaudeProfileAdapter(), new CodexProfileAdapter(), new CopilotProfileAdapter(),
      new OmpProfileAdapter(), new OpenCodeProfileAdapter(),
    ];
    for (const adapter of adapters) {
      const context = adapter.resolveContext('bridge', {
        homeDir, workspaceDirectory: homeDir,
      });
      const input = { plugins: [], mcpServers: {
        remote: { url: dummy.mcpUrl, oauth: { clientName: 'Claude Code' } },
      } };
      const planned = adapter.client === 'codex' || adapter.client === 'opencode'
        ? adapter.serializeSettings(context, input)
        : adapter.serializeMcp(context, input);
      if (!planned) throw new Error(`Missing ${adapter.client} MCP configuration`);
      const document = adapter.client === 'codex'
        ? Bun.TOML.parse(planned.content)
        : JSON.parse(planned.content);
      const generated = adapter.client === 'codex' ? document.mcp_servers.remote
        : adapter.client === 'opencode' ? document.mcp.remote : document.mcpServers.remote;
      const args: string[] = adapter.client === 'opencode'
        ? generated.command.slice(1) : generated.args;
      const connection = await connectToMcpProxy({
        serverUrl: dummy.mcpUrl,
        proxyArgs: args.slice(2),
        env: { HOME: homeDir, ALLAGENTS_TEST_HOME: homeDir, ALLAGENTS_MCP_OAUTH_NO_BROWSER: '1' },
        onAuthorizationUrl: (url) => { void fetch(url); },
      });
      try {
        const result = await connection.client.callTool({
          name: FIXTURE_TOOL_NAME, arguments: { question: adapter.client },
        });
        expect(result.content).toEqual([{ type: 'text', text: FIXTURE_ANSWER }]);
      } finally {
        await connection.close();
      }
    }
    expect(dummy.authorizeCallCount).toBe(1);
    expect(dummy.callToolCount).toBe(adapters.length);
  }, 30_000);

  test('completes OAuth and calls a tool on the first connection', async () => {
    dummy = await startDummyMcpOAuthServer();
    const connection = await connectAndAutoAuthorize(dummy.mcpUrl, homeDir);

    try {
      const { tools } = await connection.client.listTools();
      expect(tools.map((t) => t.name)).toContain(FIXTURE_TOOL_NAME);

      const result = await connection.client.callTool({
        name: FIXTURE_TOOL_NAME,
        arguments: { question: 'how to rename a company branch' },
      });
      expect(result.content).toEqual([{ type: 'text', text: FIXTURE_ANSWER }]);
      expect(dummy.authorizeCallCount).toBe(1);

      const cacheDir = join(
        homeDir,
        '.allagents',
        'oauth-proxy',
        hashServerUrl(dummy.mcpUrl),
      );
      const clientInfo = JSON.parse(
        readFileSync(join(cacheDir, 'client-info.json'), 'utf-8'),
      );
      const tokens = JSON.parse(
        readFileSync(join(cacheDir, 'tokens.json'), 'utf-8'),
      );
      expect(clientInfo.client_id).toBeTruthy();
      expect(tokens.access_token).toBeTruthy();
    } finally {
      await connection.close();
    }
  }, 15000);

  test('completes OAuth from a callback URL pasted on a headless host', async () => {
    dummy = await startDummyMcpOAuthServer();
    const previousTestHome = process.env.ALLAGENTS_TEST_HOME;
    process.env.ALLAGENTS_TEST_HOME = homeDir;

    try {
      const resourceSecret = 'resource-server-only';
      await connectHttpMcpServer(dummy.mcpUrl, {
        callbackUrlReader: async ({ authorizationUrl }) => {
          const response = await fetch(authorizationUrl, {
            redirect: 'manual',
          });
          expect(response.status).toBe(302);
          const location = response.headers.get('location');
          expect(location).toBeTruthy();
          return new URL(location!, authorizationUrl).toString();
        },
        headers: { 'x-resource-secret': resourceSecret },
      });

      expect(dummy.authorizeCallCount).toBe(1);
      expect(dummy.tokenCallCounts.authorization_code).toBe(1);
      expect(
        dummy.mcpRequestHeaders.some(
          (headers) => headers['x-resource-secret'] === resourceSecret,
        ),
      ).toBe(true);
      expect(
        dummy.idpRequestHeaders.every(
          (headers) => headers['x-resource-secret'] === undefined,
        ),
      ).toBe(true);
      expect(dummy.activeSessionCount).toBe(0);
      const connection = await connectAndAutoAuthorize(dummy.mcpUrl, homeDir);
      await connection.close();
      expect(dummy.authorizeCallCount).toBe(1);
    } finally {
      if (previousTestHome === undefined) {
        delete process.env.ALLAGENTS_TEST_HOME;
      } else {
        process.env.ALLAGENTS_TEST_HOME = previousTestHome;
      }
    }
  }, 15000);

  test('accepts a local callback while the remote paste fallback is pending', async () => {
    dummy = await startDummyMcpOAuthServer();
    let fallbackAborted = false;

    await connectHttpMcpServer(dummy.mcpUrl, {
      callbackUrlReader: ({ authorizationUrl, signal }) => {
        void fetch(authorizationUrl);
        return new Promise((_, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              fallbackAborted = true;
              reject(new Error('Local callback completed'));
            },
            { once: true },
          );
        });
      },
    });

    expect(fallbackAborted).toBe(true);
    expect(dummy.authorizeCallCount).toBe(1);
  }, 15000);

  test('routes authorization guidance through the configured output', async () => {
    dummy = await startDummyMcpOAuthServer();
    const output: string[] = [];

    await connectHttpMcpServer(dummy.mcpUrl, {
      authorizationOutput: (message) => output.push(message),
      callbackUrlReader: async ({ authorizationUrl }) => {
        const response = await fetch(authorizationUrl, {
          redirect: 'manual',
        });
        const location = response.headers.get('location');
        expect(location).toBeTruthy();
        return new URL(location!, authorizationUrl).toString();
      },
    });

    expect(output[0]).toBe('Opening browser for authorization...');
    expect(output[1]).toStartWith(
      'If the browser does not open, visit: http',
    );
    expect(output[2]).toBe(
      'Using a remote browser? Paste its callback URL in this terminal.',
    );
  }, 15000);

  test('forces a fresh OAuth flow when credentials are reset', async () => {
    dummy = await startDummyMcpOAuthServer();
    const authorize = async ({ authorizationUrl }: { authorizationUrl: URL }) => {
      const response = await fetch(authorizationUrl, { redirect: 'manual' });
      const location = response.headers.get('location');
      expect(location).toBeTruthy();
      return new URL(location!, authorizationUrl).toString();
    };

    await connectHttpMcpServer(dummy.mcpUrl, {
      callbackUrlReader: authorize,
    });
    expect(dummy.authorizeCallCount).toBe(1);

    await connectHttpMcpServer(dummy.mcpUrl, {
      callbackUrlReader: authorize,
      resetCredentials: true,
    });
    expect(dummy.authorizeCallCount).toBe(2);
  }, 15000);

  test('restores previous credentials when a reset authorization fails', async () => {
    dummy = await startDummyMcpOAuthServer();
    const authorize = async ({ authorizationUrl }: { authorizationUrl: URL }) => {
      const response = await fetch(authorizationUrl, { redirect: 'manual' });
      const location = response.headers.get('location');
      expect(location).toBeTruthy();
      return new URL(location!, authorizationUrl).toString();
    };

    await connectHttpMcpServer(dummy.mcpUrl, {
      authorizationOutput: () => {},
      callbackUrlReader: authorize,
    });
    const tokensPath = join(getMcpOAuthCacheDir(dummy.mcpUrl), 'tokens.json');
    const previousTokens = readFileSync(tokensPath, 'utf8');

    await expect(
      connectHttpMcpServer(dummy.mcpUrl, {
        authorizationOutput: () => {},
        callbackUrlReader: async () => {
          throw new Error('Authorization cancelled');
        },
        resetCredentials: true,
      }),
    ).rejects.toThrow('Authorization cancelled');

    expect(readFileSync(tokensPath, 'utf8')).toBe(previousTokens);
    const authorizationCount = dummy.authorizeCallCount;
    await connectHttpMcpServer(dummy.mcpUrl, {
      allowAuthorization: false,
      authorizationOutput: () => {},
    });
    expect(dummy.authorizeCallCount).toBe(authorizationCount);
  }, 15000);

  test('isolates OAuth reuse and reset between profiles and ordinary scope', async () => {
    dummy = await startDummyMcpOAuthServer();
    const authorize = async ({ authorizationUrl }: { authorizationUrl: URL }) => {
      const response = await fetch(authorizationUrl, { redirect: 'manual' });
      const location = response.headers.get('location');
      expect(location).toBeTruthy();
      return new URL(location!, authorizationUrl).toString();
    };

    await connectHttpMcpServer(dummy.mcpUrl, {
      profile: 'markets',
      callbackUrlReader: authorize,
    });
    await connectHttpMcpServer(dummy.mcpUrl, {
      profile: 'markets',
      callbackUrlReader: authorize,
    });
    expect(dummy.authorizeCallCount).toBe(1);

    await connectHttpMcpServer(dummy.mcpUrl, {
      profile: 'research',
      callbackUrlReader: authorize,
    });
    await connectHttpMcpServer(dummy.mcpUrl, {
      callbackUrlReader: authorize,
    });
    expect(dummy.authorizeCallCount).toBe(3);
    expect(
      readFileSync(
        join(getMcpOAuthCacheDir(dummy.mcpUrl, 'markets'), 'tokens.json'),
        'utf8',
      ),
    ).toContain('access_token');
    expect(
      readFileSync(
        join(getMcpOAuthCacheDir(dummy.mcpUrl, 'research'), 'tokens.json'),
        'utf8',
      ),
    ).toContain('access_token');
    expect(
      readFileSync(join(getMcpOAuthCacheDir(dummy.mcpUrl), 'tokens.json'), 'utf8'),
    ).toContain('access_token');

    await connectHttpMcpServer(dummy.mcpUrl, {
      profile: 'markets',
      callbackUrlReader: authorize,
      resetCredentials: true,
    });
    expect(dummy.authorizeCallCount).toBe(4);
    await connectHttpMcpServer(dummy.mcpUrl, {
      profile: 'research',
      callbackUrlReader: authorize,
    });
    expect(dummy.authorizeCallCount).toBe(4);
  }, 20000);

  test('fails without prompting when authorization is disabled', async () => {
    dummy = await startDummyMcpOAuthServer();

    await expect(
      connectHttpMcpServer(dummy.mcpUrl, {
        allowAuthorization: false,
      }),
    ).rejects.toThrow('OAuth authorization requires an interactive terminal');
    expect(dummy.authorizeCallCount).toBe(0);
  }, 15000);

  test('resolves header environment references only at connection time', async () => {
    dummy = await startDummyMcpOAuthServer({ requireAuth: false });
    const originalToken = process.env.TRADINGVIEW_TOKEN;
    process.env.TRADINGVIEW_TOKEN = 'runtime-secret';
    try {
      await connectHttpMcpServer(dummy.mcpUrl, {
        headers: { Authorization: '${TRADINGVIEW_TOKEN}' },
        allowAuthorization: false,
      });
      expect(
        dummy.mcpRequestHeaders.some(
          (headers) => headers.authorization === 'runtime-secret',
        ),
      ).toBe(true);
    } finally {
      if (originalToken === undefined) {
        delete process.env.TRADINGVIEW_TOKEN;
      } else {
        process.env.TRADINGVIEW_TOKEN = originalToken;
      }
    }
  }, 15000);

  test('reuses the cached token on a second connection without re-authorizing', async () => {
    dummy = await startDummyMcpOAuthServer();

    const first = await connectAndAutoAuthorize(dummy.mcpUrl, homeDir);
    await first.close();
    expect(dummy.authorizeCallCount).toBe(1);

    const second = await connectAndAutoAuthorize(dummy.mcpUrl, homeDir);
    try {
      const result = await second.client.callTool({
        name: FIXTURE_TOOL_NAME,
        arguments: { question: 'how to rename a company branch' },
      });
      expect(result.content).toEqual([{ type: 'text', text: FIXTURE_ANSWER }]);
      expect(dummy.authorizeCallCount).toBe(1);
    } finally {
      await second.close();
    }
  }, 20000);

  test('refreshes an expired access token without a new browser flow', async () => {
    dummy = await startDummyMcpOAuthServer({ accessTokenTtlMs: 1500 });

    const first = await connectAndAutoAuthorize(dummy.mcpUrl, homeDir);
    await first.close();
    expect(dummy.authorizeCallCount).toBe(1);
    expect(dummy.tokenCallCounts.authorization_code).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 2000));

    const second = await connectAndAutoAuthorize(dummy.mcpUrl, homeDir);
    try {
      const result = await second.client.callTool({
        name: FIXTURE_TOOL_NAME,
        arguments: { question: 'how to rename a company branch' },
      });
      expect(result.content).toEqual([{ type: 'text', text: FIXTURE_ANSWER }]);
      expect(dummy.authorizeCallCount).toBe(1);
      expect(dummy.tokenCallCounts.refresh_token).toBeGreaterThanOrEqual(1);
    } finally {
      await second.close();
    }
  }, 20000);
});
