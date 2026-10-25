import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stringify as dump, parse as load } from 'yaml';
import { WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';
import { getCopilotMcpConfigPath } from '../../../src/core/copilot-mcp.js';
import { syncUserMcpOnly } from '../../../src/core/mcp-sync.js';
import { syncUserWorkspace } from '../../../src/core/sync.js';
import { getSyncStatePath } from '../../../src/core/sync-state.js';
import { stubHomeDir } from '../../helpers/env.js';

describe('syncUserMcpOnly', () => {
  let home: string;
  let restoreHome: () => void;
  let configPath: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'allagents-mcp-user-sync-'));
    restoreHome = stubHomeDir(home);
    configPath = join(home, '.allagents', WORKSPACE_CONFIG_FILE);
  });

  afterEach(async () => {
    restoreHome();
    await rm(home, { recursive: true, force: true });
  });

  async function writeUserConfig(config: Record<string, unknown>): Promise<void> {
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf8');
  }

  test('reconciles only ordinary user MCP destinations and preserves profiles', async () => {
    const config = {
      repositories: [],
      plugins: [],
      clients: ['vscode', 'copilot'],
      mcpServers: {
        tradingview: {
          type: 'http',
          url: 'https://mcp.tradingview.com/mcp',
        },
      },
      profiles: {
        markets: {
          clients: [{ name: 'codex' }],
          mcpServers: {
            private: { command: 'private-mcp' },
          },
        },
      },
    };
    await writeUserConfig(config);
    const statePath = getSyncStatePath(home);
    await writeFile(
      statePath,
      `${JSON.stringify({
        version: 1,
        lastSync: '2026-01-01T00:00:00.000Z',
        files: { cursor: ['keep.md'] },
        mcpServers: { claude: ['keep'] },
        skillsIndex: ['keep-skill'],
        unknownFutureField: { keep: true },
      })}\n`,
      'utf8',
    );

    const result = await syncUserMcpOnly({ offline: true });

    expect(result.success).toBe(true);
    expect(result.mcpResults.vscode).toBeUndefined();
    expect(existsSync(join(home, '.config', 'Code', 'User', 'mcp.json'))).toBe(false);
    expect(JSON.parse(await readFile(getCopilotMcpConfigPath(), 'utf8'))).toEqual({
      mcpServers: {
        tradingview: {
          type: 'http',
          url: 'https://mcp.tradingview.com/mcp',
        },
      },
    });
    expect(existsSync(join(home, '.github', 'mcp.json'))).toBe(false);

    const writtenConfig = load(await readFile(configPath, 'utf8')) as typeof config;
    expect(writtenConfig.profiles).toEqual(config.profiles);
    const state = JSON.parse(await readFile(statePath, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(state.files).toEqual({ cursor: ['keep.md'] });
    expect(state.skillsIndex).toEqual(['keep-skill']);
    expect(state.unknownFutureField).toEqual({ keep: true });
    expect(state.mcpServers).toEqual({
      claude: ['keep'],
      copilot: ['tradingview'],
    });
  });

  test('full user sync and MCP-only update reconcile selected plugin servers and workspace overrides', async () => {
    const pluginPath = join(home, 'plugin');
    await mkdir(pluginPath);
    await writeFile(join(pluginPath, '.mcp.json'), JSON.stringify({
      mcpServers: {
        ignored: { command: 'plugin-ignored' },
        replacement: { command: 'plugin-replacement' },
        kept: { command: 'plugin-kept' },
      },
    }));
    const config = {
      repositories: [],
      plugins: [{ source: pluginPath, mcpServers: { exclude: [] } }],
      clients: ['copilot'],
      mcpServers: { replacement: { command: 'workspace-replacement' } },
    };
    await writeUserConfig(config);

    const full = await syncUserWorkspace({ offline: true });
    expect(full.success).toBe(true);
    expect(JSON.parse(await readFile(getCopilotMcpConfigPath(), 'utf8')).mcpServers).toEqual({
      ignored: { command: 'plugin-ignored' },
      replacement: { command: 'workspace-replacement' },
      kept: { command: 'plugin-kept' },
    });
    await writeUserConfig({
      ...config,
      plugins: [{ source: pluginPath, mcpServers: { exclude: ['ignored', 'replacement'] } }],
    });

    const result = await syncUserMcpOnly({ offline: true });

    expect(result.success).toBe(true);
    expect(result.mcpResults.copilot?.removedServers).toEqual(['ignored']);
    expect(JSON.parse(await readFile(getCopilotMcpConfigPath(), 'utf8')).mcpServers).toEqual({
      replacement: { command: 'workspace-replacement' },
      kept: { command: 'plugin-kept' },
    });
  });

  test.each([
    ['MCP-only update', syncUserMcpOnly],
    ['full user sync', syncUserWorkspace],
  ] as const)('%s leaves deprecated VS Code files untouched even with old ownership', async (_name, sync) => {
    const legacyPaths = [
      join(home, '.config', 'Code', 'User', 'mcp.json'),
      join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
      join(home, 'AppData', 'Roaming', 'Code', 'User', 'mcp.json'),
    ];
    const legacy = '{\n  // Preserve user formatting and entries\n  "servers": {"personal": {"command": "personal-mcp"}, "old": {"command": "old-mcp"}}\n}\n';
    for (const path of legacyPaths) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, legacy);
    }
    await writeUserConfig({
      repositories: [],
      plugins: [],
      clients: ['vscode'],
      mcpServers: { local: { command: 'local-mcp' } },
    });
    await writeFile(getSyncStatePath(home), JSON.stringify({
      version: 1,
      lastSync: '2026-01-01T00:00:00.000Z',
      files: {},
      mcpServers: { vscode: ['old'] },
    }));
    const originalAppData = process.env.APPDATA;
    process.env.APPDATA = join(home, 'AppData', 'Roaming');
    try {
      const result = await sync({ offline: true });
      expect(result.success).toBe(true);
      expect(result.mcpResults?.vscode).toBeUndefined();
      expect(result.warnings).toContain(
        'MCP servers not synced for vscode (not supported at user scope); configure the copilot client for ~/.copilot/mcp-config.json instead',
      );
      for (const path of legacyPaths) {
        expect(await readFile(path, 'utf8')).toBe(legacy);
      }
      expect(existsSync(getCopilotMcpConfigPath())).toBe(false);
    } finally {
      if (originalAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = originalAppData;
    }
  });

  test.each(['local-mcp', 'user-mcp'])('old VS Code tracking does not adopt an existing Copilot server (%s)', async (command) => {
    const existing = { mcpServers: { local: { command } } };
    await mkdir(dirname(getCopilotMcpConfigPath()), { recursive: true });
    await writeFile(getCopilotMcpConfigPath(), JSON.stringify(existing));
    const config = {
      repositories: [],
      plugins: [],
      clients: ['vscode', 'copilot'],
      mcpServers: { local: { command: 'local-mcp' } },
    };
    await writeUserConfig(config);
    await writeFile(getSyncStatePath(home), JSON.stringify({
      version: 1,
      lastSync: '2026-01-01T00:00:00.000Z',
      files: {},
      mcpServers: { vscode: ['local'] },
    }));

    const result = await syncUserMcpOnly({ offline: true });
    expect(result.success).toBe(true);
    expect(result.mcpResults.copilot?.trackedServers).toEqual([]);

    await writeUserConfig({ ...config, mcpServers: {} });
    const removed = await syncUserMcpOnly({ offline: true });
    expect(removed.success).toBe(true);
    expect(removed.mcpResults.copilot?.removed).toBe(0);
    expect(JSON.parse(await readFile(getCopilotMcpConfigPath(), 'utf8'))).toEqual(existing);
  });

  test('returns an empty success when no user config exists', async () => {
    const result = await syncUserMcpOnly({ offline: true });

    expect(result).toEqual({ success: true, mcpResults: {}, warnings: [] });
  });

  test('keeps dry-run free of destination and state writes', async () => {
    await writeUserConfig({
      repositories: [],
      plugins: [],
      clients: ['copilot'],
      mcpServers: {
        local: { command: 'local-mcp' },
      },
    });

    const result = await syncUserMcpOnly({ offline: true, dryRun: true });

    expect(result.success).toBe(true);
    expect(result.mcpResults.copilot?.added).toBe(1);
    expect(existsSync(getCopilotMcpConfigPath())).toBe(false);
    expect(existsSync(getSyncStatePath(home))).toBe(false);
  });
});
