import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as dump } from 'yaml';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE, SYNC_STATE_FILE } from '../../../constants.js';
import { getTuiContext } from '../context.js';

/**
 * Helper: create a minimal workspace.yaml in the given directory.
 */
async function createWorkspace(
  dir: string,
  opts: { plugins?: string[]; clients?: string[] } = {},
) {
  const configDir = join(dir, CONFIG_DIR);
  await mkdir(configDir, { recursive: true });
  const config = {
    repositories: [],
    plugins: opts.plugins ?? [],
    clients: opts.clients ?? ['claude'],
  };
  await writeFile(
    join(configDir, WORKSPACE_CONFIG_FILE),
    dump(config, { lineWidth: -1 }),
    'utf-8',
  );
}

/**
 * Helper: write a sync-state.json in the workspace.
 */
async function createSyncState(
  dir: string,
  files: Record<string, string[]>,
) {
  const configDir = join(dir, CONFIG_DIR);
  await mkdir(configDir, { recursive: true });
  const state = {
    version: 1,
    lastSync: new Date().toISOString(),
    files,
  };
  await writeFile(
    join(configDir, SYNC_STATE_FILE),
    JSON.stringify(state, null, 2),
    'utf-8',
  );
}

describe('getTuiContext', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-tui-context-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('should detect no workspace when config is missing', async () => {
    const ctx = await getTuiContext(testDir);

    expect(ctx.hasWorkspace).toBe(false);
    expect(ctx.workspacePath).toBeNull();
    expect(ctx.projectPluginCount).toBe(0);
    expect(ctx.needsSync).toBe(false);
  });

  it('should detect workspace with no plugins', async () => {
    await createWorkspace(testDir, { plugins: [], clients: ['claude'] });

    const ctx = await getTuiContext(testDir);

    expect(ctx.hasWorkspace).toBe(true);
    expect(ctx.workspacePath).toBe(testDir);
    expect(ctx.projectPluginCount).toBe(0);
    expect(ctx.needsSync).toBe(false);
  });

  it('should count project plugins from workspace', async () => {
    // Use local plugin paths that exist in the temp dir
    const pluginDir = join(testDir, 'my-plugin');
    await mkdir(pluginDir, { recursive: true });

    await createWorkspace(testDir, {
      plugins: [pluginDir],
      clients: ['claude'],
    });

    const ctx = await getTuiContext(testDir);

    expect(ctx.hasWorkspace).toBe(true);
    expect(ctx.projectPluginCount).toBe(1);
  });

  it('should detect needsSync when plugins exist but no sync state', async () => {
    const pluginDir = join(testDir, 'my-plugin');
    await mkdir(pluginDir, { recursive: true });

    await createWorkspace(testDir, {
      plugins: [pluginDir],
      clients: ['claude'],
    });

    const ctx = await getTuiContext(testDir);

    expect(ctx.needsSync).toBe(true);
  });

  it('should detect needsSync false when sync state has files', async () => {
    const pluginDir = join(testDir, 'my-plugin');
    await mkdir(pluginDir, { recursive: true });

    await createWorkspace(testDir, {
      plugins: [pluginDir],
      clients: ['claude'],
    });
    await createSyncState(testDir, {
      claude: ['.claude/commands/test.md'],
    });

    const ctx = await getTuiContext(testDir);

    expect(ctx.needsSync).toBe(false);
  });

  it('should detect needsSync when sync state exists but has no files', async () => {
    const pluginDir = join(testDir, 'my-plugin');
    await mkdir(pluginDir, { recursive: true });

    await createWorkspace(testDir, {
      plugins: [pluginDir],
      clients: ['claude'],
    });
    await createSyncState(testDir, {});

    const ctx = await getTuiContext(testDir);

    expect(ctx.needsSync).toBe(true);
  });

  it('should return all expected fields', async () => {
    const ctx = await getTuiContext(testDir);

    // Verify shape has all required keys
    expect(ctx).toHaveProperty('hasWorkspace');
    expect(ctx).toHaveProperty('workspacePath');
    expect(ctx).toHaveProperty('projectPluginCount');
    expect(ctx).toHaveProperty('userPluginCount');
    expect(ctx).toHaveProperty('needsSync');
    expect(ctx).toHaveProperty('hasUserConfig');
    expect(ctx).toHaveProperty('marketplaceCount');
  });

  it('should return numeric counts', async () => {
    const ctx = await getTuiContext(testDir);

    expect(typeof ctx.projectPluginCount).toBe('number');
    expect(typeof ctx.userPluginCount).toBe('number');
    expect(typeof ctx.marketplaceCount).toBe('number');
  });
});
