import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCodexMcpAddArgs, syncCodexMcpServers } from '../../../src/core/codex-mcp.js';
import type { NativeCommandResult } from '../../../src/core/native/types.js';
import type { ValidatedPlugin } from '../../../src/core/sync.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `allagents-codex-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makePlugin(resolved: string, plugin = 'test-plugin'): ValidatedPlugin {
  return { plugin, resolved, success: true };
}

describe('buildCodexMcpAddArgs', () => {
  test('maps URL-based server to --url flag', () => {
    const args = buildCodexMcpAddArgs('deepwiki', {
      url: 'https://mcp.deepwiki.com/mcp',
    });
    expect(args).toEqual(['mcp', 'add', 'deepwiki', '--url', 'https://mcp.deepwiki.com/mcp']);
  });

  test('maps stdio server to -- command args', () => {
    const args = buildCodexMcpAddArgs('context7', {
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp@latest'],
    });
    expect(args).toEqual(['mcp', 'add', 'context7', '--', 'npx', '-y', '@upstash/context7-mcp@latest']);
  });

  test('maps stdio server with env vars to --env flags', () => {
    const args = buildCodexMcpAddArgs('myserver', {
      command: 'node',
      args: ['server.js'],
      env: { API_KEY: 'abc', MODE: 'prod' },
    });
    expect(args).toEqual([
      'mcp', 'add', 'myserver',
      '--env', 'API_KEY=abc', '--env', 'MODE=prod',
      '--', 'node', 'server.js',
    ]);
  });

  test('maps stdio server with no args', () => {
    const args = buildCodexMcpAddArgs('simple', {
      command: 'my-mcp-server',
    });
    expect(args).toEqual(['mcp', 'add', 'simple', '--', 'my-mcp-server']);
  });

  test('returns null for unsupported config (no url or command)', () => {
    const args = buildCodexMcpAddArgs('bad', { type: 'sse' });
    expect(args).toBeNull();
  });
});

describe('syncCodexMcpServers', () => {
  let pluginDir: string;

  beforeEach(() => {
    pluginDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(pluginDir, { recursive: true, force: true });
  });

  test('adds new servers when codex has none', async () => {
    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          myserver: { url: 'https://example.com/mcp' },
        },
      }),
    );

    const addCalls: string[][] = [];
    const mockExecute = (_binary: string, args: string[]): NativeCommandResult => {
      if (args.includes('list')) {
        return { success: true, output: '[]' };
      }
      if (args.includes('add')) {
        addCalls.push(args);
        return { success: true, output: 'added' };
      }
      return { success: false, output: '', error: 'unexpected' };
    };

    const result = await syncCodexMcpServers([makePlugin(pluginDir)], {
      _mockExecute: mockExecute,
    });

    expect(result.added).toBe(1);
    expect(result.addedServers).toEqual(['myserver']);
    expect(result.trackedServers).toContain('myserver');
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0]).toContain('myserver');
  });

  test('skips servers that already exist and are not tracked', async () => {
    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          existing: { url: 'https://example.com/mcp' },
        },
      }),
    );

    const mockExecute = (_binary: string, args: string[]): NativeCommandResult => {
      if (args.includes('list')) {
        return { success: true, output: JSON.stringify([{ name: 'existing' }]) };
      }
      return { success: true, output: '' };
    };

    const result = await syncCodexMcpServers([makePlugin(pluginDir)], {
      trackedServers: [],
      _mockExecute: mockExecute,
    });

    expect(result.skipped).toBe(1);
    expect(result.skippedServers).toEqual(['existing']);
    expect(result.trackedServers).not.toContain('existing');
  });

  test('removes orphaned tracked servers', async () => {
    // Plugin has no .mcp.json, so no MCP servers
    const removeCalls: string[][] = [];
    const mockExecute = (_binary: string, args: string[]): NativeCommandResult => {
      if (args.includes('list')) {
        return { success: true, output: JSON.stringify([{ name: 'old-server' }]) };
      }
      if (args.includes('remove')) {
        removeCalls.push(args);
        return { success: true, output: 'removed' };
      }
      return { success: false, output: '', error: 'unexpected' };
    };

    const result = await syncCodexMcpServers([makePlugin(pluginDir)], {
      trackedServers: ['old-server'],
      _mockExecute: mockExecute,
    });

    expect(result.removed).toBe(1);
    expect(result.removedServers).toEqual(['old-server']);
    expect(removeCalls).toHaveLength(1);
    expect(removeCalls[0]).toContain('old-server');
  });

  test('skips sync when codex CLI is not available', async () => {
    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          myserver: { url: 'https://example.com/mcp' },
        },
      }),
    );

    const mockExecute = (_binary: string, _args: string[]): NativeCommandResult => {
      return { success: false, output: '', error: 'command not found' };
    };

    const result = await syncCodexMcpServers([makePlugin(pluginDir)], {
      trackedServers: ['owned-server'],
      _mockExecute: mockExecute,
    });

    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.authoritative).toBe(false);
    expect(result.trackedServers).toEqual(['owned-server']);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.toLowerCase().includes('codex'))).toBe(true);
  });

  test('retains ownership when removing an orphan fails', async () => {
    const mockExecute = (_binary: string, args: string[]): NativeCommandResult => {
      if (args.includes('list')) {
        return {
          success: true,
          output: JSON.stringify([{ name: 'old-server' }]),
        };
      }
      return { success: false, output: '', error: 'temporary failure' };
    };

    const result = await syncCodexMcpServers([], {
      trackedServers: ['old-server'],
      _mockExecute: mockExecute,
    });

    expect(result.authoritative).toBe(false);
    expect(result.trackedServers).toEqual(['old-server']);
    expect(result.removed).toBe(0);
  });

  test('skips codex CLI call when no plugins have MCP servers and nothing previously tracked', async () => {
    // Plugin has no .mcp.json
    let execCalled = false;
    const mockExecute = (_binary: string, _args: string[]): NativeCommandResult => {
      execCalled = true;
      return { success: true, output: '[]' };
    };

    const result = await syncCodexMcpServers([makePlugin(pluginDir)], {
      _mockExecute: mockExecute,
    });

    expect(execCalled).toBe(false);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.warnings).toHaveLength(0);
  });

  test('dryRun does not call add or remove', async () => {
    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          newserver: { url: 'https://example.com/mcp' },
        },
      }),
    );

    const addCalls: string[][] = [];
    const removeCalls: string[][] = [];
    const mockExecute = (_binary: string, args: string[]): NativeCommandResult => {
      if (args.includes('list')) {
        return { success: true, output: '[]' };
      }
      if (args.includes('add')) {
        addCalls.push(args);
        return { success: true, output: 'added' };
      }
      if (args.includes('remove')) {
        removeCalls.push(args);
        return { success: true, output: 'removed' };
      }
      return { success: false, output: '', error: 'unexpected' };
    };

    const result = await syncCodexMcpServers([makePlugin(pluginDir)], {
      dryRun: true,
      _mockExecute: mockExecute,
    });

    expect(result.added).toBe(1);
    expect(result.addedServers).toEqual(['newserver']);
    expect(addCalls).toHaveLength(0);
    expect(removeCalls).toHaveLength(0);
  });
});
