import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  buildClaudeMcpAddArgs,
  syncClaudeMcpConfig,
  syncClaudeMcpServersViaCli,
} from '../../../src/core/claude-mcp.js';
import { applyMcpProxy } from '../../../src/core/mcp-proxy.js';
import type { NativeCommandResult } from '../../../src/core/native/types.js';
import type { ValidatedPlugin } from '../../../src/core/sync.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `allagents-claude-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makePlugin(resolved: string, plugin = 'test-plugin'): ValidatedPlugin {
  return { plugin, resolved, success: true, clients: ['claude'], nativeClients: [] };
}

describe('buildClaudeMcpAddArgs', () => {
  test('maps HTTP server to --transport http', () => {
    const args = buildClaudeMcpAddArgs('deepwiki', {
      url: 'https://mcp.deepwiki.com/mcp',
    });
    expect(args).toEqual([
      'mcp', 'add', '--transport', 'http', '--scope', 'user',
      'deepwiki', 'https://mcp.deepwiki.com/mcp',
    ]);
  });

  test('maps HTTP server with project scope', () => {
    const args = buildClaudeMcpAddArgs('deepwiki', {
      url: 'https://mcp.deepwiki.com/mcp',
    }, 'project');
    expect(args).toEqual([
      'mcp', 'add', '--transport', 'http', '--scope', 'project',
      'deepwiki', 'https://mcp.deepwiki.com/mcp',
    ]);
  });

  test('maps stdio server to -- command args', () => {
    const args = buildClaudeMcpAddArgs('context7', {
      command: 'npx',
      args: ['-y', '@upstash/context7-mcp@latest'],
    });
    expect(args).toEqual([
      'mcp', 'add', '--scope', 'user',
      'context7', '--', 'npx', '-y', '@upstash/context7-mcp@latest',
    ]);
  });

  test('maps stdio server with env vars to -e flags', () => {
    const args = buildClaudeMcpAddArgs('myserver', {
      command: 'node',
      args: ['server.js'],
      env: { API_KEY: 'abc', MODE: 'prod' },
    });
    expect(args).toEqual([
      'mcp', 'add', '--scope', 'user',
      '-e', 'API_KEY=abc', '-e', 'MODE=prod',
      'myserver', '--', 'node', 'server.js',
    ]);
  });

  test('returns null for unsupported config', () => {
    const args = buildClaudeMcpAddArgs('bad', { type: 'sse' });
    expect(args).toBeNull();
  });
});

describe('syncClaudeMcpConfig (project-scoped file write)', () => {
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

  test('creates .mcp.json with mcpServers when none exists', () => {
    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' } } }),
    );

    const configPath = join(tempDir, '.mcp.json');
    const result = syncClaudeMcpConfig([makePlugin(pluginDir)], { configPath });

    expect(result.added).toBe(1);
    expect(result.addedServers).toEqual(['deepwiki']);
    expect(result.trackedServers).toEqual(['deepwiki']);
    expect(existsSync(configPath)).toBe(true);

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.mcpServers.deepwiki).toEqual({ type: 'http', url: 'https://mcp.deepwiki.com/mcp' });
  });

  test('preserves existing mcpServers entries when adding new ones', () => {
    const configPath = join(tempDir, '.mcp.json');
    writeFileSync(configPath, JSON.stringify({
      mcpServers: { existing: { type: 'http', url: 'https://existing.com' } },
    }));

    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' } } }),
    );

    syncClaudeMcpConfig([makePlugin(pluginDir)], { configPath });

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.mcpServers.existing).toEqual({ type: 'http', url: 'https://existing.com' });
    expect(written.mcpServers.deepwiki).toEqual({ type: 'http', url: 'https://mcp.deepwiki.com/mcp' });
  });

  test('skips user-managed servers with conflicting names', () => {
    const configPath = join(tempDir, '.mcp.json');
    writeFileSync(configPath, JSON.stringify({
      mcpServers: { deepwiki: { type: 'http', url: 'https://my-custom-deepwiki.com' } },
    }));

    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' } } }),
    );

    const result = syncClaudeMcpConfig([makePlugin(pluginDir)], { configPath });

    expect(result.skipped).toBe(1);
    expect(result.added).toBe(0);
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.mcpServers.deepwiki.url).toBe('https://my-custom-deepwiki.com');
  });

  test('updates tracked servers when config changes', () => {
    const configPath = join(tempDir, '.mcp.json');
    writeFileSync(configPath, JSON.stringify({
      mcpServers: { deepwiki: { type: 'http', url: 'https://old.deepwiki.com' } },
    }));

    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { deepwiki: { type: 'http', url: 'https://new.deepwiki.com' } } }),
    );

    const result = syncClaudeMcpConfig([makePlugin(pluginDir)], {
      configPath,
      trackedServers: ['deepwiki'],
    });

    expect(result.overwritten).toBe(1);
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.mcpServers.deepwiki.url).toBe('https://new.deepwiki.com');
  });

  test('removes orphaned tracked servers', () => {
    const configPath = join(tempDir, '.mcp.json');
    writeFileSync(configPath, JSON.stringify({
      mcpServers: { old_server: { type: 'http', url: 'https://old.com' } },
    }));

    const result = syncClaudeMcpConfig([], {
      configPath,
      trackedServers: ['old_server'],
    });

    expect(result.removed).toBe(1);
    expect(result.removedServers).toEqual(['old_server']);
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.mcpServers.old_server).toBeUndefined();
  });

  test('does not write in dry-run mode', () => {
    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' } } }),
    );

    const configPath = join(tempDir, '.mcp.json');
    const result = syncClaudeMcpConfig([makePlugin(pluginDir)], { configPath, dryRun: true });

    expect(result.added).toBe(1);
    expect(existsSync(configPath)).toBe(false);
  });
});

describe('syncClaudeMcpServersViaCli (user-scoped via CLI)', () => {
  let pluginDir: string;

  beforeEach(() => {
    pluginDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(pluginDir, { recursive: true, force: true });
  });

  function mockExec(responses: Record<string, NativeCommandResult>) {
    const calls: Array<{ binary: string; args: string[] }> = [];
    const fn = (binary: string, args: string[]) => {
      calls.push({ binary, args });
      const key = `${binary} ${args.join(' ')}`;
      // Match by prefix for flexible matching
      for (const [pattern, result] of Object.entries(responses)) {
        if (key.startsWith(pattern) || key === pattern) {
          return result;
        }
      }
      return { success: true, output: '' };
    };
    return { fn, calls };
  }

  function bridgeServers(clientName: string) {
    return applyMcpProxy(new Map([
      ['figma', { url: 'https://mcp.figma.com/mcp', oauth: { clientName } }],
    ]), 'claude');
  }

  function fakeClaudeCli(
    initialServers: Map<string, unknown>,
    failedOperation?: 'remove' | 'add',
  ) {
    const servers = new Map(initialServers);
    const mutations: string[] = [];
    const execute = (_binary: string, args: string[]): NativeCommandResult => {
      if (args[0] === '--version') return { success: true, output: '1.0.0' };
      if (args[0] !== 'mcp') throw new Error('Unexpected Claude command');
      if (args[1] === 'get') {
        return servers.has(args[2]!)
          ? { success: true, output: 'Configured server' }
          : { success: false, output: '', error: `No MCP server found with name: ${args[2]}` };
      }
      if (args[1] === failedOperation) {
        return { success: false, output: '', error: 'temporary failure' };
      }
      if (args[1] === 'remove' && args[3] === '--scope' && args[4] === 'user') {
        servers.delete(args[2]!);
        mutations.push('remove');
        return { success: true, output: 'Removed' };
      }
      if (args[1] === 'add' && args[2] === '--scope' && args[3] === 'user' && args[5] === '--') {
        const name = args[4]!;
        if (servers.has(name)) {
          return { success: false, output: '', error: 'Server already exists' };
        }
        servers.set(name, { command: args[6], args: args.slice(7) });
        mutations.push('add');
        return { success: true, output: 'Added' };
      }
      throw new Error('Unexpected Claude MCP command');
    };
    return { servers, mutations, execute };
  }

  test('adds new server when not already present', async () => {
    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' } } }),
    );

    const { fn, calls } = mockExec({
      'claude --version': { success: true, output: '1.0.0' },
      'claude mcp get deepwiki': { success: false, output: '', error: 'not found' },
      'claude mcp add': { success: true, output: 'Added' },
    });

    const result = await syncClaudeMcpServersViaCli([makePlugin(pluginDir)], {
      trackedServers: [],
      _mockExecute: fn,
    });

    expect(result.added).toBe(1);
    expect(result.addedServers).toEqual(['deepwiki']);
    expect(result.trackedServers).toEqual(['deepwiki']);

    const addCall = calls.find(c => c.args[0] === 'mcp' && c.args[1] === 'add');
    expect(addCall).toBeDefined();
    expect(addCall!.args).toContain('--transport');
    expect(addCall!.args).toContain('http');
    expect(addCall!.args).toContain('--scope');
    expect(addCall!.args).toContain('user');
  });

  test('preserves an untracked bridge when the desired OAuth identity changes', async () => {
    const original = bridgeServers('Claude Code');
    const cli = fakeClaudeCli(original);

    const result = await syncClaudeMcpServersViaCli([], {
      trackedServers: [],
      serverOverrides: bridgeServers('Codex'),
      _mockExecute: cli.execute,
    });

    expect(cli.servers).toEqual(original);
    expect(result.skippedServers).toEqual(['figma']);
    expect(result.trackedServers).toEqual([]);
    expect(result.authoritative).toBe(true);
  });

  test('updates an owned bridge to the newly configured OAuth identity', async () => {
    const cli = fakeClaudeCli(bridgeServers('Claude Code'));
    const desired = bridgeServers('Codex');

    const result = await syncClaudeMcpServersViaCli([], {
      trackedServers: ['figma'],
      serverOverrides: desired,
      _mockExecute: cli.execute,
    });

    expect(cli.servers).toEqual(desired);
    expect(result.overwrittenServers).toEqual(['figma']);
    expect(result.overwritten).toBe(1);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(result.trackedServers).toEqual(['figma']);
    expect(result.authoritative).toBe(true);
  });

  test.each(['remove', 'add'] as const)('retains ownership when updating an owned bridge fails during %s', async (operation) => {
    const original = bridgeServers('Claude Code');
    const cli = fakeClaudeCli(original, operation);

    const result = await syncClaudeMcpServersViaCli([], {
      trackedServers: ['figma'],
      serverOverrides: bridgeServers('Codex'),
      _mockExecute: cli.execute,
    });

    expect(cli.servers).toEqual(operation === 'remove' ? original : new Map());
    expect(result.overwritten).toBe(0);
    expect(result.trackedServers).toEqual(['figma']);
    expect(result.authoritative).toBe(false);
    expect(result.warnings[0]).toContain(`Failed to ${operation}`);
  });

  test('previews an owned bridge update without mutating Claude configuration', async () => {
    const original = bridgeServers('Claude Code');
    const cli = fakeClaudeCli(original);

    const result = await syncClaudeMcpServersViaCli([], {
      dryRun: true,
      trackedServers: ['figma'],
      serverOverrides: bridgeServers('Codex'),
      _mockExecute: cli.execute,
    });

    expect(cli.servers).toEqual(original);
    expect(cli.mutations).toEqual([]);
    expect(result.overwrittenServers).toEqual(['figma']);
    expect(result.trackedServers).toEqual(['figma']);
    expect(result.authoritative).toBe(true);
  });

  test('preserves an owned bridge when the replacement configuration is unsupported', async () => {
    const original = bridgeServers('Claude Code');
    const cli = fakeClaudeCli(original);

    const result = await syncClaudeMcpServersViaCli([], {
      trackedServers: ['figma'],
      serverOverrides: new Map([['figma', { type: 'sse' }]]),
      _mockExecute: cli.execute,
    });

    expect(cli.servers).toEqual(original);
    expect(cli.mutations).toEqual([]);
    expect(result.overwritten).toBe(0);
    expect(result.trackedServers).toEqual(['figma']);
    expect(result.authoritative).toBe(false);
    expect(result.warnings[0]).toContain('Unsupported MCP server config');
  });

  test('removes orphaned tracked server', async () => {
    // No plugins with MCP servers
    const { fn, calls } = mockExec({
      'claude --version': { success: true, output: '1.0.0' },
      'claude mcp get old-server': { success: true, output: 'old-server: ...' },
      'claude mcp remove': { success: true, output: 'Removed' },
    });

    const result = await syncClaudeMcpServersViaCli([], {
      trackedServers: ['old-server'],
      _mockExecute: fn,
    });

    expect(result.removed).toBe(1);
    expect(result.removedServers).toEqual(['old-server']);
    const removeCall = calls.find(c => c.args[0] === 'mcp' && c.args[1] === 'remove');
    expect(removeCall).toBeDefined();
    expect(removeCall!.args).toContain('--scope');
    expect(removeCall!.args).toContain('user');
  });

  test('retains ownership when removing an orphan fails', async () => {
    const { fn } = mockExec({
      'claude --version': { success: true, output: '1.0.0' },
      'claude mcp get old-server': {
        success: true,
        output: 'old-server: ...',
      },
      'claude mcp remove': {
        success: false,
        output: '',
        error: 'temporary failure',
      },
    });

    const result = await syncClaudeMcpServersViaCli([], {
      trackedServers: ['old-server'],
      _mockExecute: fn,
    });

    expect(result.authoritative).toBe(false);
    expect(result.trackedServers).toEqual(['old-server']);
    expect(result.removed).toBe(0);
  });


  test('retains ownership when orphan inspection fails transiently', async () => {
    const { fn } = mockExec({
      'claude --version': { success: true, output: '1.0.0' },
      'claude mcp get old-server': {
        success: false,
        output: '',
        error: 'permission denied',
      },
    });

    const result = await syncClaudeMcpServersViaCli([], {
      trackedServers: ['old-server'],
      _mockExecute: fn,
    });

    expect(result.authoritative).toBe(false);
    expect(result.trackedServers).toEqual(['old-server']);
    expect(result.warnings[0]).toContain('Failed to inspect');
  });

  test('only treats the exact Claude server-missing response as absence', async () => {
    const misleading = mockExec({
      'claude --version': { success: true, output: '1.0.0' },
      'claude mcp get old-server': {
        success: false,
        output: '',
        error: 'config file not found',
      },
    });
    const incomplete = await syncClaudeMcpServersViaCli([], {
      trackedServers: ['old-server'],
      _mockExecute: misleading.fn,
    });
    expect(incomplete.authoritative).toBe(false);
    expect(incomplete.trackedServers).toEqual(['old-server']);

    const missing = mockExec({
      'claude --version': { success: true, output: '1.0.0' },
      'claude mcp get old-server': {
        success: false,
        output: '',
        error: 'No MCP server found with name: old-server',
      },
    });
    const authoritative = await syncClaudeMcpServersViaCli([], {
      trackedServers: ['old-server'],
      _mockExecute: missing.fn,
    });
    expect(authoritative.authoritative).toBe(true);
    expect(authoritative.trackedServers).toEqual([]);
  });
  test('retains ownership when the claude CLI is not available', async () => {
    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' } } }),
    );

    const { fn } = mockExec({
      'claude --version': { success: false, output: '', error: 'not found' },
    });

    const result = await syncClaudeMcpServersViaCli([makePlugin(pluginDir)], {
      trackedServers: ['owned-server'],
      _mockExecute: fn,
    });

    expect(result.added).toBe(0);
    expect(result.authoritative).toBe(false);
    expect(result.trackedServers).toEqual(['owned-server']);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('Claude CLI not available');
  });
});
