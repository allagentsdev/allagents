import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { dump, load } from 'js-yaml';
import { WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';
import { getCopilotMcpConfigPath } from '../../../src/core/copilot-mcp.js';
import { syncUserMcpOnly } from '../../../src/core/mcp-sync.js';
import { getSyncStatePath } from '../../../src/core/sync-state.js';
import { getVscodeMcpConfigPath } from '../../../src/core/vscode-mcp.js';
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
    expect(JSON.parse(await readFile(getVscodeMcpConfigPath(), 'utf8'))).toEqual({
      servers: {
        tradingview: {
          type: 'http',
          url: 'https://mcp.tradingview.com/mcp',
        },
      },
    });
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
      vscode: ['tradingview'],
      copilot: ['tradingview'],
    });
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
