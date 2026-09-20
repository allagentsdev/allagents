import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  shouldProxy,
  applyMcpProxy,
} from '../../../src/core/mcp-proxy.js';
import {
  type McpProxyConfig,
  WorkspaceConfigSchema,
} from '../../../src/models/workspace-config.js';
import packageJson from '../../../package.json';

const packageRef = `allagents@${packageJson.version}`;

function makeTempDir(): string {
  const dir = join(tmpdir(), `allagents-mcp-proxy-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('shouldProxy', () => {
  test('returns true when client is in proxy clients list', () => {
    const config: McpProxyConfig = { clients: ['claude', 'copilot'] };
    expect(shouldProxy('any-server', 'claude', config)).toBe(true);
    expect(shouldProxy('any-server', 'copilot', config)).toBe(true);
  });

  test('returns false when client is not in proxy clients list', () => {
    const config: McpProxyConfig = { clients: ['claude'] };
    expect(shouldProxy('any-server', 'codex', config)).toBe(false);
  });

  test('returns true when server has per-server override for client', () => {
    const config: McpProxyConfig = {
      clients: ['claude'],
      servers: { 'my-api': { proxy: ['codex'] } },
    };
    expect(shouldProxy('my-api', 'codex', config)).toBe(true);
  });

  test('returns true for every client when a server uses the wildcard', () => {
    const config: McpProxyConfig = {
      clients: [],
      servers: { 'my-api': { proxy: ['*'] } },
    };
    expect(shouldProxy('my-api', 'claude', config)).toBe(true);
    expect(shouldProxy('my-api', 'future-client', config)).toBe(true);
  });

  test('returns true when client is in both default and per-server', () => {
    const config: McpProxyConfig = {
      clients: ['claude'],
      servers: { 'my-api': { proxy: ['claude'] } },
    };
    expect(shouldProxy('my-api', 'claude', config)).toBe(true);
  });

  test('returns false for server not in overrides and client not in defaults', () => {
    const config: McpProxyConfig = {
      clients: ['claude'],
      servers: { 'other-api': { proxy: ['codex'] } },
    };
    expect(shouldProxy('my-api', 'codex', config)).toBe(false);
  });

  test('honors aliases after workspace parsing', () => {
    const config = WorkspaceConfigSchema.parse({
      repositories: [],
      plugins: [],
      clients: ['copilot', 'claude'],
      mcpProxy: {
        clients: [
          'github-copilot',
          'copilot',
          'future-client',
          'future-client',
        ],
        servers: {
          'my-api': { proxy: ['claude-code', 'claude', '*'] },
        },
      },
    }).mcpProxy!;

    expect(config.clients).toEqual([
      'copilot',
      'copilot',
      'future-client',
      'future-client',
    ]);
    expect(config.servers?.['my-api']?.proxy).toEqual([
      'claude',
      'claude',
      '*',
    ]);
    expect(shouldProxy('other-api', 'copilot', config)).toBe(true);
    expect(shouldProxy('other-api', 'future-client', config)).toBe(true);
    expect(shouldProxy('my-api', 'claude', config)).toBe(true);
    expect(shouldProxy('my-api', 'other-unknown-client', config)).toBe(true);
  });
});

describe('applyMcpProxy', () => {
  test('rewrites HTTP server config to stdio for proxied client', () => {
    const servers = new Map<string, unknown>([
      ['deepwiki', { url: 'https://mcp.deepwiki.com/mcp' }],
    ]);
    const config: McpProxyConfig = { clients: ['claude'] };
    const result = applyMcpProxy(servers, 'claude', config);
    expect(result.get('deepwiki')).toEqual({
      command: 'npx',
      args: [
        '-y',
        packageRef,
        'mcp',
        'proxy',
        'https://mcp.deepwiki.com/mcp',
      ],
    });
  });

  test('includes the profile selector only for profile-owned bridges', () => {
    const servers = new Map<string, unknown>([
      ['tradingview', { url: 'https://mcp.tradingview.com/mcp' }],
    ]);
    const config: McpProxyConfig = {
      clients: [],
      servers: { tradingview: { proxy: ['codex'] } },
    };

    expect(
      applyMcpProxy(servers, 'codex', config, { profile: 'markets' }).get(
        'tradingview',
      ),
    ).toEqual({
      command: 'npx',
      args: [
        '-y',
        packageRef,
        'mcp',
        'proxy',
        'https://mcp.tradingview.com/mcp',
        '--profile',
        'markets',
      ],
    });
    expect(applyMcpProxy(servers, 'codex', config).get('tradingview')).toEqual({
      command: 'npx',
      args: [
        '-y',
        packageRef,
        'mcp',
        'proxy',
        'https://mcp.tradingview.com/mcp',
      ],
    });
  });

  test('does not rewrite HTTP server for non-proxied client', () => {
    const servers = new Map<string, unknown>([
      ['deepwiki', { url: 'https://mcp.deepwiki.com/mcp' }],
    ]);
    const config: McpProxyConfig = { clients: ['claude'] };
    const result = applyMcpProxy(servers, 'codex', config);
    expect(result.get('deepwiki')).toEqual({ url: 'https://mcp.deepwiki.com/mcp' });
  });

  test('does not rewrite stdio server even for proxied client', () => {
    const servers = new Map<string, unknown>([
      ['local-server', { command: 'node', args: ['server.js'] }],
    ]);
    const config: McpProxyConfig = { clients: ['claude'] };
    const result = applyMcpProxy(servers, 'claude', config);
    expect(result.get('local-server')).toEqual({ command: 'node', args: ['server.js'] });
  });

  test('handles mix of HTTP and stdio servers', () => {
    const servers = new Map<string, unknown>([
      ['http-server', { url: 'https://example.com/mcp' }],
      ['stdio-server', { command: 'npx', args: ['some-mcp'] }],
    ]);
    const config: McpProxyConfig = { clients: ['copilot'] };
    const result = applyMcpProxy(servers, 'copilot', config);
    expect((result.get('http-server') as Record<string, unknown>).command).toBe('npx');
    expect((result.get('stdio-server') as Record<string, unknown>).command).toBe('npx');
    expect((result.get('stdio-server') as Record<string, unknown>).args).toEqual(['some-mcp']);
  });

  test('applies per-server override for additional client', () => {
    const servers = new Map<string, unknown>([
      ['my-api', { url: 'https://api.example.com/mcp' }],
      ['other-api', { url: 'https://other.example.com/mcp' }],
    ]);
    const config: McpProxyConfig = {
      clients: ['claude'],
      servers: { 'my-api': { proxy: ['codex'] } },
    };
    const result = applyMcpProxy(servers, 'codex', config);
    expect((result.get('my-api') as Record<string, unknown>).command).toBe('npx');
    expect(result.get('other-api')).toEqual({ url: 'https://other.example.com/mcp' });
  });

  test('forwards HTTP headers through the proxy helper args', () => {
    const servers = new Map<string, unknown>([
      [
        'secure-api',
        {
          url: 'https://api.example.com/mcp',
          headers: { Authorization: 'Bearer token', 'X-Test': '1' },
        },
      ],
    ]);
    const config: McpProxyConfig = { clients: ['claude'] };
    const result = applyMcpProxy(servers, 'claude', config);
    expect(result.get('secure-api')).toEqual({
      command: 'npx',
      args: [
        '-y',
        packageRef,
        'mcp',
        'proxy',
        'https://api.example.com/mcp',
        '--header',
        'Authorization=Bearer token',
        '--header',
        'X-Test=1',
      ],
    });
  });

  test('keeps profile secrets as environment bindings in generated bridge args', () => {
    const servers = new Map<string, unknown>([
      [
        'secure-api',
        {
          url: 'https://api.example.com/mcp',
          headers: { Authorization: '${TRADINGVIEW_TOKEN}' },
        },
      ],
    ]);
    const config: McpProxyConfig = {
      clients: [],
      servers: { 'secure-api': { proxy: ['codex'] } },
    };

    expect(
      applyMcpProxy(servers, 'codex', config, { profile: 'markets' }).get(
        'secure-api',
      ),
    ).toEqual({
      command: 'npx',
      args: [
        '-y',
        packageRef,
        'mcp',
        'proxy',
        'https://api.example.com/mcp',
        '--profile',
        'markets',
        '--header-env',
        'Authorization=TRADINGVIEW_TOKEN',
      ],
      env: { TRADINGVIEW_TOKEN: '${TRADINGVIEW_TOKEN}' },
    });
  });
});
