import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { getCopilotMcpConfigPath } from '../../../src/core/copilot-mcp.js';
import { syncClaudeMcpConfig } from '../../../src/core/claude-mcp.js';
import type { ValidatedPlugin } from '../../../src/core/sync.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `allagents-copilot-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makePlugin(resolved: string, plugin = 'test-plugin'): ValidatedPlugin {
  return { plugin, resolved, success: true, clients: ['copilot'], nativeClients: [] };
}

describe('getCopilotMcpConfigPath', () => {
  test('returns path under .copilot directory', () => {
    const path = getCopilotMcpConfigPath();
    expect(path).toMatch(/\.copilot[/\\]mcp-config\.json$/);
  });
});

describe('syncClaudeMcpConfig for copilot (mcpServers format)', () => {
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

  test('creates mcp-config.json in non-existent .copilot directory', () => {
    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' } } }),
    );

    // Use a nested path to simulate ~/.copilot/ not existing
    const configPath = join(tempDir, '.copilot', 'mcp-config.json');
    const result = syncClaudeMcpConfig([makePlugin(pluginDir)], { configPath });

    expect(result.added).toBe(1);
    expect(result.addedServers).toEqual(['deepwiki']);
    expect(existsSync(configPath)).toBe(true);

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.mcpServers.deepwiki).toEqual({ type: 'http', url: 'https://mcp.deepwiki.com/mcp' });
  });

  test('syncs HTTP server with url field', () => {
    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' },
        },
      }),
    );

    const configPath = join(tempDir, 'mcp-config.json');
    const result = syncClaudeMcpConfig([makePlugin(pluginDir)], { configPath });

    expect(result.added).toBe(1);
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.mcpServers.deepwiki.type).toBe('http');
    expect(written.mcpServers.deepwiki.url).toBe('https://mcp.deepwiki.com/mcp');
  });

  test('syncs stdio server with command and args', () => {
    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          context7: {
            command: 'npx',
            args: ['-y', '@upstash/context7-mcp@latest'],
          },
        },
      }),
    );

    const configPath = join(tempDir, 'mcp-config.json');
    syncClaudeMcpConfig([makePlugin(pluginDir)], { configPath });

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.mcpServers.context7.command).toBe('npx');
    expect(written.mcpServers.context7.args).toEqual(['-y', '@upstash/context7-mcp@latest']);
  });

  test('preserves existing user-managed servers', () => {
    const configPath = join(tempDir, 'mcp-config.json');
    writeFileSync(configPath, JSON.stringify({
      mcpServers: { 'user-server': { type: 'http', url: 'https://user.com/mcp' } },
    }));

    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' } } }),
    );

    syncClaudeMcpConfig([makePlugin(pluginDir)], { configPath });

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.mcpServers['user-server']).toEqual({ type: 'http', url: 'https://user.com/mcp' });
    expect(written.mcpServers.deepwiki).toBeDefined();
  });

  test('removes orphaned tracked servers from non-existent directory', () => {
    const configPath = join(tempDir, '.copilot', 'mcp-config.json');
    mkdirSync(join(tempDir, '.copilot'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      mcpServers: { old_server: { type: 'http', url: 'https://old.com' } },
    }));

    const result = syncClaudeMcpConfig([], {
      configPath,
      trackedServers: ['old_server'],
    });

    expect(result.removed).toBe(1);
    expect(result.removedServers).toEqual(['old_server']);
  });
});
