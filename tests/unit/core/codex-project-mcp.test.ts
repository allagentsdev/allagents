import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  serverToToml,
  parseCodexConfigToml,
  syncCodexProjectMcpConfig,
} from '../../../src/core/codex-mcp.js';
import type { ValidatedPlugin } from '../../../src/core/sync.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `allagents-codex-proj-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makePlugin(resolved: string, plugin = 'test-plugin'): ValidatedPlugin {
  return { plugin, resolved, success: true, clients: ['codex'], nativeClients: [] };
}

describe('serverToToml', () => {
  test('keeps a dotted server name as one configuration key', () => {
    const source = serverToToml('reports.tools', { command: 'node', env: { MODE: 'safe' } });
    const value = Bun.TOML.parse(source) as { mcp_servers: Record<string, { command: string }> };
    expect(Object.keys(value.mcp_servers)).toEqual(['reports.tools']);
    expect(value.mcp_servers['reports.tools']?.command).toBe('node');
    expect([...parseCodexConfigToml(source).serverNames]).toEqual(['reports.tools']);
  });
  test('round-trips executable arguments containing newlines and control escapes', () => {
    const args = ['line one\nline two', 'tab\tvalue', 'quoted "value"', 'C:\\tools\\server.js'];
    const value = Bun.TOML.parse(serverToToml('portable', { command: 'node', args })) as { mcp_servers: { portable: { args: string[] } } };
    expect(value.mcp_servers.portable.args).toEqual(args);
  });
  test('generates TOML for HTTP server', () => {
    const toml = serverToToml('deepwiki', { type: 'http', url: 'https://mcp.deepwiki.com/mcp' });
    expect(toml).toBe('[mcp_servers.deepwiki]\nurl = "https://mcp.deepwiki.com/mcp"');
  });

  test('generates TOML for stdio server with args and env', () => {
    const toml = serverToToml('myserver', {
      command: 'npx',
      args: ['-y', '@some/server'],
      env: { API_KEY: 'abc' },
    });
    expect(toml).toContain('[mcp_servers.myserver]');
    expect(toml).toContain('command = "npx"');
    expect(toml).toContain('args = ["-y", "@some/server"]');
    expect(toml).toContain('[mcp_servers.myserver.env]');
    expect(toml).toContain('API_KEY = "abc"');
  });
});

describe('parseCodexConfigToml', () => {
  test('parses empty content', () => {
    const { serverNames, nonMcpContent } = parseCodexConfigToml('');
    expect(serverNames.size).toBe(0);
    expect(nonMcpContent).toBe('');
  });

  test('extracts server names and preserves non-mcp content', () => {
    const content = `model = "gpt-5"\n\n[mcp_servers.deepwiki]\nurl = "https://mcp.deepwiki.com/mcp"\n`;
    const { serverNames, nonMcpContent, serverSections } = parseCodexConfigToml(content);
    expect(serverNames.has('deepwiki')).toBe(true);
    expect(nonMcpContent).toContain('model = "gpt-5"');
    expect(serverSections.get('deepwiki')).toContain('url = "https://mcp.deepwiki.com/mcp"');
  });

  test('handles server with env subsection', () => {
    const content = `[mcp_servers.myserver]\ncommand = "npx"\n\n[mcp_servers.myserver.env]\nKEY = "val"\n`;
    const { serverNames, serverSections } = parseCodexConfigToml(content);
    expect(serverNames.has('myserver')).toBe(true);
    expect(serverSections.get('myserver')).toContain('[mcp_servers.myserver.env]');
    expect(serverSections.get('myserver')).toContain('KEY = "val"');
  });
});

describe('syncCodexProjectMcpConfig', () => {
  let tempDir: string;
  let pluginDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    pluginDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(pluginDir, { recursive: true, force: true });
  });

  test('creates .codex/config.toml with mcp_servers when none exists', () => {
    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' } } }),
    );

    const configPath = join(tempDir, '.codex', 'config.toml');
    const result = syncCodexProjectMcpConfig([makePlugin(pluginDir)], { configPath });

    expect(result.added).toBe(1);
    expect(result.addedServers).toEqual(['deepwiki']);
    expect(existsSync(configPath)).toBe(true);

    const content = readFileSync(configPath, 'utf-8');
    expect(content).toContain('[mcp_servers.deepwiki]');
    expect(content).toContain('url = "https://mcp.deepwiki.com/mcp"');
  });

  test('preserves non-mcp config when adding servers', () => {
    const configPath = join(tempDir, '.codex', 'config.toml');
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, 'model = "gpt-5"\n');

    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' } } }),
    );

    syncCodexProjectMcpConfig([makePlugin(pluginDir)], { configPath });

    const content = readFileSync(configPath, 'utf-8');
    expect(content).toContain('model = "gpt-5"');
    expect(content).toContain('[mcp_servers.deepwiki]');
  });

  test.each([
    [String.raw`"\U0001F600"`, '😀'],
    [String.raw`"literal\\U0001F600"`, String.raw`literal\U0001F600`],
    [String.raw`"\U0000005C\U00000022"`, '\\"'],
    ['"with\ttab"', 'with\ttab'],
  ])('preserves the existing server with TOML key %s', (quoted, name) => {
    const configPath = join(tempDir, '.codex', 'config.toml');
    mkdirSync(dirname(configPath), { recursive: true });
    const existing = `[mcp_servers.${quoted}]\ncommand = "personal"\n`;
    writeFileSync(configPath, existing);
    const result = syncCodexProjectMcpConfig([], {
      configPath,
      trackedServers: [],
      serverOverrides: new Map([
        [name!, { command: 'managed' }],
        ['added', { command: 'node' }],
      ]),
    });
    expect(result.skippedServers).toEqual([name!]);
    expect(result.addedServers).toEqual(['added']);
    const content = readFileSync(configPath, 'utf8');
    expect(content).toContain(existing.trim());
    const parsed = Bun.TOML.parse(content) as { mcp_servers: Record<string, { command: string }> };
    expect(parsed.mcp_servers[name!]?.command).toBe('personal');
  });

  test('skips user-managed servers', () => {
    const configPath = join(tempDir, '.codex', 'config.toml');
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, '[mcp_servers.deepwiki]\nurl = "https://custom.com"\n');

    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' } } }),
    );

    const result = syncCodexProjectMcpConfig([makePlugin(pluginDir)], { configPath });

    expect(result.skipped).toBe(1);
    expect(result.added).toBe(0);
  });

  test('removes orphaned tracked servers', () => {
    const configPath = join(tempDir, '.codex', 'config.toml');
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, '[mcp_servers.old_server]\nurl = "https://old.com"\n');

    const result = syncCodexProjectMcpConfig([], {
      configPath,
      trackedServers: ['old_server'],
    });

    expect(result.removed).toBe(1);
    const content = readFileSync(configPath, 'utf-8');
    expect(content).not.toContain('old_server');
  });

  test('does not write in dry-run mode', () => {
    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' } } }),
    );

    const configPath = join(tempDir, '.codex', 'config.toml');
    const result = syncCodexProjectMcpConfig([makePlugin(pluginDir)], { configPath, dryRun: true });

    expect(result.added).toBe(1);
    expect(existsSync(configPath)).toBe(false);
  });
});

function dirname(p: string) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i === -1 ? '.' : p.substring(0, i);
}
