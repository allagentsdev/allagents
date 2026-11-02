import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncMcpOnly, syncMcpServers } from '../../../src/core/mcp-sync.js';
import { resolvePluginComponents } from '../../../src/core/plugin-components.js';
import { getSyncStatePath } from '../../../src/core/sync-state.js';
import type { ValidatedPlugin } from '../../../src/core/sync.js';
import { stubHomeDir } from '../../helpers/env.js';

let root: string;
let restoreHome: () => void;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'allagents-component-mcp-sync-'));
  restoreHome = stubHomeDir(join(root, 'home'));
  await mkdir(join(root, '.allagents'), { recursive: true });
});
afterEach(async () => {
  restoreHome();
  await rm(root, { recursive: true, force: true });
});

async function pluginFixture(): Promise<string> {
  const plugin = join(root, 'plugin');
  await mkdir(plugin);
  await writeFile(join(plugin, 'plugin.json'), JSON.stringify({ name: 'plugin', mcpServers: './custom.json' }));
  await writeFile(join(plugin, 'custom.json'), JSON.stringify({ mcpServers: { owned: { command: 'owned-mcp' } } }));
  await writeFile(join(root, '.allagents', 'workspace.yaml'), 'version: 2\nrepositories: []\nplugins: [./plugin]\nclients: [copilot]\n');
  return plugin;
}

describe('project MCP component reconciliation', () => {
  test('discovers custom sources and preserves config and tracking on invalid preferred manifest', async () => {
    const plugin = await pluginFixture();
    expect((await syncMcpOnly(root, { offline: true })).success).toBe(true);
    const configPath = join(root, '.github', 'mcp.json');
    const original = await readFile(configPath, 'utf8');
    expect(JSON.parse(original).mcpServers.owned.command).toBe('owned-mcp');
    const state = await readFile(getSyncStatePath(root), 'utf8');
    await mkdir(join(plugin, '.plugin'));
    await writeFile(join(plugin, '.plugin', 'plugin.json'), '{invalid');
    expect((await syncMcpOnly(root, { offline: true })).success).toBe(false);
    expect(await readFile(configPath, 'utf8')).toBe(original);
    expect(await readFile(getSyncStatePath(root), 'utf8')).toBe(state);
  });

  test('returns non-authoritative tracking when a resolved config becomes unreadable', async () => {
    const path = await pluginFixture();
    const plugin: ValidatedPlugin = {
      plugin: './plugin', resolved: path, success: true, clients: ['copilot'], nativeClients: [],
      components: resolvePluginComponents(path),
    };
    await mkdir(join(root, '.github'));
    const configPath = join(root, '.github', 'mcp.json');
    const original = JSON.stringify({ mcpServers: { owned: { command: 'owned-mcp' }, personal: { command: 'personal-mcp' } } });
    await writeFile(configPath, original);
    await writeFile(join(path, 'custom.json'), '{invalid');
    const result = syncMcpServers(root, [plugin], { repositories: [], plugins: ['./plugin'], clients: ['copilot'] }, {
      version: 1, lastSync: '2026-01-01T00:00:00.000Z', files: {}, mcpServers: { copilot: ['owned'] },
    }, ['copilot']);
    expect(result.mcpResults.copilot?.authoritative).toBe(false);
    expect(result.trackedServers.copilot).toEqual(['owned']);
    expect(await readFile(configPath, 'utf8')).toBe(original);
  });
});
