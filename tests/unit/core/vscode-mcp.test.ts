import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  readPluginMcpConfig,
  collectMcpServers,
  syncVscodeMcpConfig,
} from '../../../src/core/vscode-mcp.js';
import type { ValidatedPlugin } from '../../../src/core/sync.js';
import { resolvePluginComponents } from '../../../src/core/plugin-components.js';

/** Create a temp directory for each test */
function makeTempDir(): string {
  const dir = join(tmpdir(), `allagents-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Helper to create a validated plugin with a resolved path */
function makePlugin(resolved: string, plugin = 'test-plugin'): ValidatedPlugin {
  return { plugin, resolved, success: true, clients: ['vscode'], nativeClients: [] };
}

describe('readPluginMcpConfig', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('returns null when no .mcp.json exists', () => {
    const result = readPluginMcpConfig(tempDir);
    expect(result).toBeNull();
  });

  test('returns servers when valid .mcp.json exists', () => {
    writeFileSync(
      join(tempDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          ediprod: { type: 'http', url: 'https://ediprod.mcp.wtg.zone' },
        },
      }),
    );

    const result = readPluginMcpConfig(tempDir);
    expect(result).toEqual({
      ediprod: { type: 'http', url: 'https://ediprod.mcp.wtg.zone' },
    });
  });

  test('returns null when a previously resolved config becomes invalid JSON', () => {
    writeFileSync(join(tempDir, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
    const components = resolvePluginComponents(tempDir);
    writeFileSync(join(tempDir, '.mcp.json'), 'not valid json {{{');
    expect(readPluginMcpConfig(tempDir, components)).toBeNull();
  });

  test('reads .github/mcp.json with the native mcpServers envelope', () => {
    mkdirSync(join(tempDir, '.github'));
    writeFileSync(join(tempDir, '.github', 'mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'github' } } }));
    expect(readPluginMcpConfig(tempDir)).toEqual({ github: { command: 'github' } });
  });

  test('reads custom manifest MCP files and excludes their selected paths', () => {
    mkdirSync(join(tempDir, '.claude-plugin'));
    mkdirSync(join(tempDir, 'config'));
    writeFileSync(join(tempDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'custom', mcpServers: './config/custom.json' }));
    writeFileSync(join(tempDir, 'config', 'custom.json'), JSON.stringify({ mcpServers: { custom: { command: 'custom' } } }));
    const components = resolvePluginComponents(tempDir);
    expect(readPluginMcpConfig(tempDir, components)).toEqual({ custom: { command: 'custom' } });
    expect(readPluginMcpConfig(tempDir, components, ['config/custom.json'])).toBeNull();
  });

  test('reads direct inline maps and excludes their declaration manifest', () => {
    mkdirSync(join(tempDir, '.claude-plugin'));
    writeFileSync(join(tempDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'inline', mcpServers: { inline: { command: 'inline' } } }));
    const components = resolvePluginComponents(tempDir);
    expect(readPluginMcpConfig(tempDir, components)).toEqual({ inline: { command: 'inline' } });
    expect(readPluginMcpConfig(tempDir, components, ['.claude-plugin/plugin.json'])).toBeNull();
  });

  test('uses conventional MCP instead of conflicting custom and inline sources', () => {
    mkdirSync(join(tempDir, '.claude-plugin'));
    mkdirSync(join(tempDir, '.github'));
    writeFileSync(join(tempDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'inline', mcpServers: { inline: { command: 'inline' } } }));
    writeFileSync(join(tempDir, '.github', 'mcp.json'), JSON.stringify({ mcpServers: { github: { command: 'github' } } }));
    writeFileSync(join(tempDir, '.mcp.json'), JSON.stringify({ mcpServers: { root: { command: 'root' } } }));
    expect(readPluginMcpConfig(tempDir)).toEqual({ root: { command: 'root' } });
  });

  test('rejects source symlinks that escape after component resolution', () => {
    const path = join(tempDir, '.mcp.json');
    writeFileSync(path, JSON.stringify({ mcpServers: { safe: { command: 'safe' } } }));
    const components = resolvePluginComponents(tempDir);
    const outsideDir = makeTempDir();
    const outsidePath = join(outsideDir, 'outside-mcp.json');
    writeFileSync(outsidePath, JSON.stringify({ mcpServers: { outside: { command: 'outside' } } }));
    try {
      rmSync(path);
      symlinkSync(outsidePath, path);
      expect(() => readPluginMcpConfig(tempDir, components)).toThrow();
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test('rejects malformed server maps rather than loading a valid subset', () => {
    writeFileSync(join(tempDir, '.mcp.json'), JSON.stringify({ mcpServers: {} }));
    const components = resolvePluginComponents(tempDir);
    writeFileSync(join(tempDir, '.mcp.json'), JSON.stringify({ mcpServers: { invalid: 42, valid: { command: 'safe' } } }));
    expect(readPluginMcpConfig(tempDir, components)).toBeNull();
    writeFileSync(join(tempDir, '.mcp.json'), JSON.stringify({ mcpServers: [] }));
    expect(readPluginMcpConfig(tempDir, components)).toBeNull();
  });
});

describe('collectMcpServers', () => {
  let tempDir1: string;
  let tempDir2: string;

  beforeEach(() => {
    tempDir1 = makeTempDir();
    tempDir2 = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir1, { recursive: true, force: true });
    rmSync(tempDir2, { recursive: true, force: true });
  });

  test('merges servers from multiple plugins', () => {
    writeFileSync(
      join(tempDir1, '.mcp.json'),
      JSON.stringify({ mcpServers: { server1: { type: 'http', url: 'https://a.test' } } }),
    );
    writeFileSync(
      join(tempDir2, '.mcp.json'),
      JSON.stringify({ mcpServers: { server2: { type: 'http', url: 'https://b.test' } } }),
    );

    const { servers, warnings } = collectMcpServers([
      makePlugin(tempDir1, 'plugin-a'),
      makePlugin(tempDir2, 'plugin-b'),
    ]);

    expect(servers.size).toBe(2);
    expect(servers.get('server1')).toEqual({ type: 'http', url: 'https://a.test' });
    expect(servers.get('server2')).toEqual({ type: 'http', url: 'https://b.test' });
    expect(warnings).toHaveLength(0);
  });

  test('warns on duplicate server names, first plugin wins', () => {
    writeFileSync(
      join(tempDir1, '.mcp.json'),
      JSON.stringify({ mcpServers: { dup: { type: 'http', url: 'https://first.test' } } }),
    );
    writeFileSync(
      join(tempDir2, '.mcp.json'),
      JSON.stringify({ mcpServers: { dup: { type: 'http', url: 'https://second.test' } } }),
    );

    const { servers, warnings } = collectMcpServers([
      makePlugin(tempDir1, 'plugin-a'),
      makePlugin(tempDir2, 'plugin-b'),
    ]);

    expect(servers.size).toBe(1);
    expect(servers.get('dup')).toEqual({ type: 'http', url: 'https://first.test' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('plugin-b');
    expect(warnings[0]).toContain('dup');
  });

  test('exclusions apply per plugin before duplicate precedence and workspace overrides', () => {
    writeFileSync(
      join(tempDir1, '.mcp.json'),
      JSON.stringify({ mcpServers: {
        shared: { command: 'first' },
        removed: { command: 'removed' },
        override: { command: 'plugin' },
      } }),
    );
    writeFileSync(
      join(tempDir2, '.mcp.json'),
      JSON.stringify({ mcpServers: { shared: { command: 'second' } } }),
    );
    const first = makePlugin(tempDir1, 'first');
    first.nativeClients = ['claude'];
    first.mcpServers = { exclude: ['shared', 'removed', 'override'] };
    const second = makePlugin(tempDir2, 'second');

    const { servers, warnings } = collectMcpServers(
      [first, second],
      { override: { command: 'workspace' } },
    );

    expect(Object.fromEntries(servers)).toEqual({
      shared: { command: 'second' },
      override: { command: 'workspace' },
    });
    expect(warnings).toEqual([]);
  });

  test('an empty exclusion leaves plugin MCP servers enabled', () => {
    writeFileSync(
      join(tempDir1, '.mcp.json'),
      JSON.stringify({ mcpServers: { kept: { command: 'kept' } } }),
    );
    const plugin = makePlugin(tempDir1);
    plugin.mcpServers = { exclude: [] };
    expect(Object.fromEntries(collectMcpServers([plugin]).servers)).toEqual({
      kept: { command: 'kept' },
    });
  });

  test('does not collect file MCP servers from native-only plugin units', () => {
    writeFileSync(
      join(tempDir1, '.mcp.json'),
      JSON.stringify({ mcpServers: { nativeOnly: { command: 'native' } } }),
    );
    const native = makePlugin(tempDir1);
    native.clients = [];
    native.nativeClients = ['claude'];
    native.mcpServers = { exclude: [] };

    expect(Object.fromEntries(collectMcpServers([native]).servers)).toEqual({});
  });

  test('mixed installs only supply MCP servers to file-installed clients', () => {
    writeFileSync(
      join(tempDir1, '.mcp.json'),
      JSON.stringify({ mcpServers: { fileOnly: { command: 'file' } } }),
    );
    const mixed = makePlugin(tempDir1);
    mixed.nativeClients = ['claude'];

    expect(
      Object.fromEntries(collectMcpServers([mixed], undefined, 'vscode').servers),
    ).toEqual({ fileOnly: { command: 'file' } });
    expect(
      Object.fromEntries(collectMcpServers([mixed], undefined, 'claude').servers),
    ).toEqual({});
  });

  test('generic config exclusions do not fall back to lower-precedence MCP sources', () => {
    mkdirSync(join(tempDir1, '.claude-plugin'));
    writeFileSync(join(tempDir1, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'inline', mcpServers: { fallback: { command: 'fallback' } } }));
    writeFileSync(join(tempDir1, '.mcp.json'), JSON.stringify({ mcpServers: { selected: { command: 'selected' } } }));
    const plugin = makePlugin(tempDir1);
    plugin.exclude = ['.mcp.json'];
    const { servers, warnings } = collectMcpServers([plugin]);
    expect(servers.size).toBe(0);
    expect(warnings).toEqual([]);
  });
});

describe('syncVscodeMcpConfig', () => {
  let tempDir: string;
  let pluginDir: string;
  let configPath: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    pluginDir = makeTempDir();
    configPath = join(tempDir, 'mcp.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(pluginDir, { recursive: true, force: true });
  });

  test('adds new servers to empty config', () => {
    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          ediprod: { type: 'http', url: 'https://ediprod.mcp.wtg.zone' },
          wtgkb: { type: 'http', url: 'https://wtgkb.mcp.wtg.zone' },
        },
      }),
    );

    const result = syncVscodeMcpConfig([makePlugin(pluginDir)], { configPath });

    expect(result.added).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.addedServers).toEqual(['ediprod', 'wtgkb']);
    expect(result.configPath).toBe(configPath);

    // Verify file was written
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.servers.ediprod).toEqual({ type: 'http', url: 'https://ediprod.mcp.wtg.zone' });
    expect(written.servers.wtgkb).toEqual({ type: 'http', url: 'https://wtgkb.mcp.wtg.zone' });
  });

  test('preserves existing servers and other keys', () => {
    // Pre-existing VS Code config with existing server and custom key
    writeFileSync(
      configPath,
      JSON.stringify({
        servers: {
          existing: { type: 'http', url: 'https://existing.test' },
        },
        customKey: 'preserved',
      }),
    );

    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: { newserver: { type: 'http', url: 'https://new.test' } },
      }),
    );

    const result = syncVscodeMcpConfig([makePlugin(pluginDir)], { configPath });

    expect(result.added).toBe(1);
    expect(result.addedServers).toEqual(['newserver']);

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.servers.existing).toEqual({ type: 'http', url: 'https://existing.test' });
    expect(written.servers.newserver).toEqual({ type: 'http', url: 'https://new.test' });
    expect(written.customKey).toBe('preserved');
  });

  test('skips servers that already exist with different config', () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        servers: {
          ediprod: { type: 'http', url: 'https://user-configured.test' },
        },
      }),
    );

    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: { ediprod: { type: 'http', url: 'https://plugin.test' } },
      }),
    );

    const result = syncVscodeMcpConfig([makePlugin(pluginDir)], { configPath });

    expect(result.added).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.skippedServers).toEqual(['ediprod']);
    // Skipped user-managed servers should not be tracked
    expect(result.trackedServers).toEqual([]);

    // Verify original value is preserved
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.servers.ediprod.url).toBe('https://user-configured.test');
  });

  test('silently skips servers with identical config (no skip count, not tracked)', () => {
    const serverConfig = { type: 'http', url: 'https://ediprod.mcp.wtg.zone' };

    writeFileSync(
      configPath,
      JSON.stringify({
        servers: {
          ediprod: serverConfig,
        },
      }),
    );

    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: { ediprod: serverConfig },
      }),
    );

    const result = syncVscodeMcpConfig([makePlugin(pluginDir)], { configPath });

    expect(result.added).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.addedServers).toEqual([]);
    expect(result.skippedServers).toEqual([]);
    // Pre-existing user entry should not be tracked
    expect(result.trackedServers).toEqual([]);
  });

  test('dry-run does not write file', () => {
    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: { ediprod: { type: 'http', url: 'https://ediprod.test' } },
      }),
    );

    const result = syncVscodeMcpConfig([makePlugin(pluginDir)], { configPath, dryRun: true });

    expect(result.added).toBe(1);
    expect(result.addedServers).toEqual(['ediprod']);
    expect(result.configPath).toBeUndefined();
    // File should NOT have been created
    expect(existsSync(configPath)).toBe(false);
  });

  test('no-op when no plugins have .mcp.json', () => {
    // pluginDir has no .mcp.json
    const result = syncVscodeMcpConfig([makePlugin(pluginDir)], { configPath });

    expect(result.added).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.addedServers).toEqual([]);
    expect(result.skippedServers).toEqual([]);
    expect(result.configPath).toBeUndefined();
    expect(existsSync(configPath)).toBe(false);
  });

  test('force overwrites servers with different config', () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        servers: {
          ediprod: { type: 'http', url: 'https://user-configured.test' },
        },
      }),
    );

    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: { ediprod: { type: 'http', url: 'https://plugin.test' } },
      }),
    );

    const result = syncVscodeMcpConfig([makePlugin(pluginDir)], { configPath, force: true });

    expect(result.added).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.overwritten).toBe(1);
    expect(result.overwrittenServers).toEqual(['ediprod']);

    // Verify the config was overwritten
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.servers.ediprod.url).toBe('https://plugin.test');
  });

  test('force does not re-add servers with identical config', () => {
    const serverConfig = { type: 'http', url: 'https://ediprod.mcp.wtg.zone' };

    writeFileSync(
      configPath,
      JSON.stringify({
        servers: {
          ediprod: serverConfig,
        },
      }),
    );

    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: { ediprod: serverConfig },
      }),
    );

    const result = syncVscodeMcpConfig([makePlugin(pluginDir)], { configPath, force: true });

    expect(result.added).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.overwritten).toBe(0);
    expect(result.overwrittenServers).toEqual([]);
  });

  test('returns trackedServers list for saving to sync state', () => {
    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          server1: { type: 'http', url: 'https://a.test' },
          server2: { type: 'http', url: 'https://b.test' },
        },
      }),
    );

    const result = syncVscodeMcpConfig([makePlugin(pluginDir)], { configPath });

    expect(result.trackedServers).toEqual(['server1', 'server2']);
  });
});

describe('syncVscodeMcpConfig with tracking', () => {
  let tempDir: string;
  let pluginDir: string;
  let configPath: string;

  beforeEach(() => {
    tempDir = makeTempDir();
    pluginDir = makeTempDir();
    configPath = join(tempDir, 'mcp.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(pluginDir, { recursive: true, force: true });
  });

  test('updates tracked server with changed config without force flag', () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        servers: {
          tracked: { type: 'http', url: 'https://old.test' },
        },
      }),
    );

    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: { tracked: { type: 'http', url: 'https://new.test' } },
      }),
    );

    const result = syncVscodeMcpConfig([makePlugin(pluginDir)], {
      configPath,
      trackedServers: ['tracked'],
    });

    expect(result.overwritten).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.overwrittenServers).toEqual(['tracked']);

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.servers.tracked.url).toBe('https://new.test');
  });

  test('removes tracked servers no longer in plugins', () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        servers: {
          orphaned: { type: 'http', url: 'https://orphaned.test' },
          stillUsed: { type: 'http', url: 'https://still.test' },
        },
      }),
    );

    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: { stillUsed: { type: 'http', url: 'https://still.test' } },
      }),
    );

    const result = syncVscodeMcpConfig([makePlugin(pluginDir)], {
      configPath,
      trackedServers: ['orphaned', 'stillUsed'],
    });

    expect(result.removed).toBe(1);
    expect(result.removedServers).toEqual(['orphaned']);
    expect(result.trackedServers).toEqual(['stillUsed']);

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.servers.orphaned).toBeUndefined();
    expect(written.servers.stillUsed).toBeDefined();
  });

  test('preserves user-managed servers (not in trackedServers)', () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        servers: {
          userManaged: { type: 'http', url: 'https://user.test' },
        },
      }),
    );

    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: { pluginServer: { type: 'http', url: 'https://plugin.test' } },
      }),
    );

    const result = syncVscodeMcpConfig([makePlugin(pluginDir)], {
      configPath,
      trackedServers: [], // User managed server was never tracked
    });

    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.servers.userManaged).toBeDefined();
    expect(written.servers.pluginServer).toBeDefined();
  });

  test('skips user-managed server with conflicting name (not tracked)', () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        servers: {
          conflict: { type: 'http', url: 'https://user-configured.test' },
        },
      }),
    );

    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: { conflict: { type: 'http', url: 'https://plugin.test' } },
      }),
    );

    const result = syncVscodeMcpConfig([makePlugin(pluginDir)], {
      configPath,
      trackedServers: [], // 'conflict' is not tracked, so it's user-managed
    });

    expect(result.skipped).toBe(1);
    expect(result.overwritten).toBe(0);
    expect(result.skippedServers).toEqual(['conflict']);
    // Skipped user-managed servers should not be tracked
    expect(result.trackedServers).toEqual([]);

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.servers.conflict.url).toBe('https://user-configured.test');
  });

  test('removes all tracked servers when no plugins have MCP configs', () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        servers: {
          orphan1: { type: 'http', url: 'https://orphan1.test' },
          orphan2: { type: 'http', url: 'https://orphan2.test' },
          userManaged: { type: 'http', url: 'https://user.test' },
        },
      }),
    );

    // Plugin has no .mcp.json
    const result = syncVscodeMcpConfig([makePlugin(pluginDir)], {
      configPath,
      trackedServers: ['orphan1', 'orphan2'],
    });

    expect(result.removed).toBe(2);
    expect(result.removedServers).toContain('orphan1');
    expect(result.removedServers).toContain('orphan2');
    expect(result.trackedServers).toEqual([]);
    expect(result.configPath).toBe(configPath);

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.servers.orphan1).toBeUndefined();
    expect(written.servers.orphan2).toBeUndefined();
    expect(written.servers.userManaged).toBeDefined();
  });

  test('dry-run with tracking does not write file', () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        servers: {
          orphaned: { type: 'http', url: 'https://orphaned.test' },
        },
      }),
    );

    const result = syncVscodeMcpConfig([makePlugin(pluginDir)], {
      configPath,
      trackedServers: ['orphaned'],
      dryRun: true,
    });

    expect(result.removed).toBe(1);
    expect(result.removedServers).toEqual(['orphaned']);

    // File should still have the orphaned server
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.servers.orphaned).toBeDefined();
  });
});

test('invalid refreshed plugin MCP preserves owned and user configuration bytes', () => {
  const pluginDir = makeTempDir();
  const workspaceDir = makeTempDir();
  try {
    const source = join(pluginDir, '.mcp.json');
    writeFileSync(source, JSON.stringify({ mcpServers: { owned: { command: 'before' } } }));
    const plugin = makePlugin(pluginDir);
    plugin.components = resolvePluginComponents(pluginDir);
    const configPath = join(workspaceDir, 'mcp.json');
    const original = JSON.stringify({ servers: { owned: { command: 'before' }, user: { command: 'user' } } });
    writeFileSync(configPath, original);
    writeFileSync(source, '{invalid');
    expect(() => syncVscodeMcpConfig([plugin], { configPath, trackedServers: ['owned'] })).toThrow();
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
  } finally {
    rmSync(pluginDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test('readPluginMcpConfig does not accept a wrapped inline server map', () => {
  const pluginDir = makeTempDir();
  try {
    const components = resolvePluginComponents(pluginDir);
    components.mcpServers = [{ inline: { mcpServers: { wrapped: { command: 'wrapped' } } } }];
    expect(readPluginMcpConfig(pluginDir, components)).toBeNull();
  } finally {
    rmSync(pluginDir, { recursive: true, force: true });
  }
});
