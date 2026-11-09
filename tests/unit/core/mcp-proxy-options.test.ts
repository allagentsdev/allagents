import { describe, expect, test } from 'bun:test';
import { applyMcpProxy } from '../../../src/core/mcp-proxy.js';
import type { McpServerConfig } from '../../../src/models/workspace-config.js';
import { serializeProfileMcpServers } from '../../../src/core/profile/adapters/mcp.js';

describe('managed connection policy in generated bridges', () => {
  test('routes advanced HTTP declarations through the bridge and preserves their policy', () => {
    const declaration: McpServerConfig = {
      url: 'https://example.test/mcp',
      oauth: {
        clientId: 'registered-client',
        clientSecret: 'private-value',
        scope: 'read',
      },
      connection: { transportStrategy: 'sse-only', ignoreTools: ['delete*'] },
    };
    const result = applyMcpProxy(
      new Map([['server', declaration]]),
      'codex',
    ).get('server') as Extract<McpServerConfig, { command: string }>;
    expect(result.command).toBe('npx');
    expect(result.args?.join(' ')).not.toContain('private-value');
    const oauthIndex = result.args!.indexOf('--oauth-config');
    expect(JSON.parse(result.args![oauthIndex + 1]!)).toEqual({
      clientId: 'registered-client',
      clientSecret: '${ALLAGENTS_MCP_OAUTH_CLIENT_SECRET}',
      scope: 'read',
    });
    expect(result.env?.ALLAGENTS_MCP_OAUTH_CLIENT_SECRET).toBe('private-value');
    const connectionIndex = result.args!.indexOf('--connection-config');
    expect(JSON.parse(result.args![connectionIndex + 1]!)).toEqual(
      declaration.connection,
    );
  });

  test('preserves profile environment references and connection controls', () => {
    const result = serializeProfileMcpServers(
      {
        mcpServers: {
          server: {
            url: 'https://example.test/mcp',
            oauth: { clientId: 'client', clientSecret: '${CLIENT_SECRET}' },
            connection: { protocol: 'auto' },
          },
        },
      },
      'codex',
      'work',
    )!;
    const server = result.server as Extract<
      McpServerConfig,
      { command: string }
    >;
    expect(server.args).toContain('--profile');
    expect(server.args).toContain('work');
    expect(server.env?.CLIENT_SECRET).toBe('${CLIENT_SECRET}');
    const index = server.args!.indexOf('--connection-config');
    expect(JSON.parse(server.args![index + 1]!)).toEqual({ protocol: 'auto' });
  });
});

test('full Codex profile preserves bridge-owned OAuth references without putting secrets in args', async () => {
  const { CodexProfileAdapter } = await import(
    '../../../src/core/profile/adapters/codex.js'
  );
  const adapter = new CodexProfileAdapter();
  const context = adapter.resolveContext('work', {
    homeDir: '/home/test',
    workspaceDirectory: '/work/project',
  });
  const file = adapter.serializeSettings(context, {
    plugins: [],
    mcpServers: {
      server: {
        url: 'https://example.test/mcp',
        oauth: {
          clientId: '${CLIENT_ID}',
          clientSecret: '${CLIENT_SECRET}',
          authorizationParams: {
            api_key: '${API_KEY}',
            login_hint: '${LOGIN_HINT}',
            audience: 'https://api.example.test/',
          },
        },
      },
    },
  })!;
  const args = JSON.parse(/^args = (.+)$/m.exec(file.content)![1]!);
  expect(args.join(' ')).not.toContain('${');
  const oauth = JSON.parse(args[args.indexOf('--oauth-config') + 1]);
  expect(oauth).toEqual({
    clientId: '${CLIENT_ID}',
    clientSecret: '${CLIENT_SECRET}',
    authorizationParams: {
      api_key: '${API_KEY}',
      login_hint: '${LOGIN_HINT}',
      audience: 'https://api.example.test/',
    },
  });
  expect(file.content).toContain(
    'env_vars = ["API_KEY", "CLIENT_ID", "CLIENT_SECRET", "LOGIN_HINT"]',
  );
});

test('generated bridge binds literal credential parameters and preserves distinct variable names', () => {
  const declaration: McpServerConfig = {
    url: 'https://example.test/mcp',
    oauth: {
      clientId: 'registered',
      clientSecret: 'client-private',
      authorizationParams: {
        api_key: 'parameter-private',
        'api-key': 'second-private',
        key: '${ALLAGENTS_MCP_OAUTH_PARAM_API_KEY}',
        audience: 'https://api.example.test/',
      },
    },
  };
  const server = applyMcpProxy(
    new Map([['server', declaration]]),
    'copilot',
  ).get('server') as Extract<McpServerConfig, { command: string }>;
  const args = server.args!;
  for (const secret of [
    'client-private',
    'parameter-private',
    'second-private',
  ])
    expect(args.join(' ')).not.toContain(secret);
  expect(args.join(' ')).not.toContain('${');
  const oauth = JSON.parse(args[args.indexOf('--oauth-config') + 1]!);
  const resolve = (reference: string) => server.env![reference.slice(2, -1)];
  expect(resolve(oauth.clientSecret)).toBe('client-private');
  expect(resolve(oauth.authorizationParams.api_key)).toBe('parameter-private');
  expect(resolve(oauth.authorizationParams['api-key'])).toBe('second-private');
  expect(oauth.authorizationParams.key).toBe(
    '${ALLAGENTS_MCP_OAUTH_PARAM_API_KEY}',
  );
  expect(resolve(oauth.authorizationParams.key)).toBe(
    '${ALLAGENTS_MCP_OAUTH_PARAM_API_KEY}',
  );
  expect(oauth.authorizationParams.audience).toBe('https://api.example.test/');
});

test('all JSON profile adapters keep bridge policy references opaque to native interpolation', async () => {
  const { ClaudeProfileAdapter } = await import(
    '../../../src/core/profile/adapters/claude.js'
  );
  const { CopilotProfileAdapter } = await import(
    '../../../src/core/profile/adapters/copilot.js'
  );
  const { OpenCodeProfileAdapter } = await import(
    '../../../src/core/profile/adapters/opencode.js'
  );
  const { OmpProfileAdapter } = await import(
    '../../../src/core/profile/adapters/omp.js'
  );
  const { PiProfileAdapter } = await import(
    '../../../src/core/profile/adapters/pi.js'
  );
  const oauth = {
    clientId: '${CLIENT_ID}',
    clientSecret: '${CLIENT_SECRET}',
    authorizationParams: {
      api_key: '${API_KEY}',
      login_hint: '${LOGIN_HINT}',
      audience: 'https://api.example.test/',
    },
  };
  for (const adapter of [
    new ClaudeProfileAdapter(),
    new CopilotProfileAdapter(),
    new OpenCodeProfileAdapter(),
    new OmpProfileAdapter(),
    new PiProfileAdapter(),
  ]) {
    const context = adapter.resolveContext('work', {
      homeDir: '/home/test',
      workspaceDirectory: '/work/project',
    });
    const input = {
      plugins: [],
      mcpServers: { server: { url: 'https://example.test/mcp', oauth } },
    };
    const file =
      adapter.client === 'opencode'
        ? adapter.serializeSettings(context, input)
        : adapter.serializeMcp(context, input);
    const document = JSON.parse(file!.content);
    const server =
      adapter.client === 'opencode'
        ? document.mcp.server
        : document.mcpServers.server;
    const args: string[] =
      adapter.client === 'opencode' ? server.command.slice(1) : server.args;
    expect(args.join(' ')).not.toContain('${');
    expect(args.join(' ')).not.toContain('{env:');
    expect(JSON.parse(args[args.indexOf('--oauth-config') + 1]!)).toEqual(
      oauth,
    );
    expect(
      adapter.client === 'opencode' ? server.environment : server.env,
    ).toEqual(
      adapter.client === 'opencode'
        ? {
            CLIENT_ID: '{env:CLIENT_ID}',
            CLIENT_SECRET: '{env:CLIENT_SECRET}',
            API_KEY: '{env:API_KEY}',
            LOGIN_HINT: '{env:LOGIN_HINT}',
          }
        : {
            CLIENT_ID: '${CLIENT_ID}',
            CLIENT_SECRET: '${CLIENT_SECRET}',
            API_KEY: '${API_KEY}',
            LOGIN_HINT: '${LOGIN_HINT}',
          },
    );
  }
});
