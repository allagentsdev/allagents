import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildClaudeMcpAddArgs } from '../../../src/core/claude-mcp.js';
import { buildCodexMcpAddArgs } from '../../../src/core/codex-mcp.js';
import { syncVscodeMcpConfig } from '../../../src/core/vscode-mcp.js';
import { applyMcpProxy } from '../../../src/core/mcp-proxy.js';
import type { McpProxyConfig } from '../../../src/models/workspace-config.js';
import packageJson from '../../../package.json';

const packageRef = `allagents@${packageJson.version}`;

describe('CLI args with proxy transform', () => {
  test('buildClaudeMcpAddArgs handles proxied HTTP config', () => {
    const servers = new Map<string, unknown>([
      ['deepwiki', { url: 'https://mcp.deepwiki.com/mcp' }],
    ]);
    const config: McpProxyConfig = { clients: ['claude'] };
    const proxied = applyMcpProxy(servers, 'claude', config);
    const proxiedConfig = proxied.get('deepwiki') as Record<string, unknown>;

    const args = buildClaudeMcpAddArgs('deepwiki', proxiedConfig);
    expect(args).toEqual([
      'mcp', 'add', '--scope', 'user', 'deepwiki', '--', 'npx',
      '-y', packageRef, 'mcp', 'proxy', 'https://mcp.deepwiki.com/mcp',
    ]);
  });

  test('buildCodexMcpAddArgs handles proxied HTTP config', () => {
    const servers = new Map<string, unknown>([
      ['deepwiki', { url: 'https://mcp.deepwiki.com/mcp' }],
    ]);
    const config: McpProxyConfig = { clients: ['codex'] };
    const proxied = applyMcpProxy(servers, 'codex', config);
    const proxiedConfig = proxied.get('deepwiki') as Record<string, unknown>;

    const args = buildCodexMcpAddArgs('deepwiki', proxiedConfig);
    expect(args).toEqual([
      'mcp', 'add', 'deepwiki', '--', 'npx',
      '-y', packageRef, 'mcp', 'proxy', 'https://mcp.deepwiki.com/mcp',
    ]);
  });
});

describe('syncVscodeMcpConfig with serverOverrides', () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `allagents-mcp-proxy-override-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tempDir, { recursive: true });
    configPath = join(tempDir, 'mcp.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('writes proxied stdio config when serverOverrides is provided', () => {
    const proxiedServers = new Map<string, unknown>([
      ['deepwiki', {
        command: 'npx',
        args: ['-y', packageRef, 'mcp', 'proxy', 'https://mcp.deepwiki.com/mcp'],
      }],
    ]);

    const result = syncVscodeMcpConfig([], { configPath, serverOverrides: proxiedServers });

    expect(result.added).toBe(1);
    expect(result.addedServers).toEqual(['deepwiki']);

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.servers.deepwiki.command).toBe('npx');
    expect(written.servers.deepwiki.args.slice(0, 4)).toEqual([
      '-y',
      packageRef,
      'mcp',
      'proxy',
    ]);
  });
});
