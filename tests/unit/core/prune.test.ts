import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as dump, parse as load } from 'yaml';
import { pruneOrphanedPlugins } from '../../../src/core/prune.js';
import { saveRegistry } from '../../../src/core/marketplace.js';
import type { MarketplaceRegistry } from '../../../src/core/marketplace.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';
import type { WorkspaceConfig } from '../../../src/models/workspace-config.js';
import { stubHomeDir } from '../../helpers/env.js';

describe('pruneOrphanedPlugins', () => {
  let testDir: string;
  let restoreHomeDir: () => void;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-prune-test-'));
    restoreHomeDir = stubHomeDir(testDir);
  });

  afterEach(async () => {
    restoreHomeDir();
    await rm(testDir, { recursive: true, force: true });
  });

  async function writeRegistry(marketplaces: MarketplaceRegistry['marketplaces']): Promise<void> {
    const allagentsDir = join(testDir, '.allagents');
    await mkdir(allagentsDir, { recursive: true });
    await saveRegistry({ version: 1, marketplaces });
  }

  async function writeProjectConfig(config: WorkspaceConfig): Promise<void> {
    const configDir = join(testDir, CONFIG_DIR);
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, WORKSPACE_CONFIG_FILE),
      dump(config, { lineWidth: -1 }),
      'utf-8',
    );
  }

  async function writeUserConfig(config: WorkspaceConfig): Promise<void> {
    const allagentsDir = join(testDir, '.allagents');
    await mkdir(allagentsDir, { recursive: true });
    await writeFile(
      join(allagentsDir, WORKSPACE_CONFIG_FILE),
      dump(config, { lineWidth: -1 }),
      'utf-8',
    );
  }

  async function readProjectConfig(): Promise<WorkspaceConfig> {
    const content = await readFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      'utf-8',
    );
    return load(content) as WorkspaceConfig;
  }

  async function readUserConfig(): Promise<WorkspaceConfig> {
    const content = await readFile(
      join(testDir, '.allagents', WORKSPACE_CONFIG_FILE),
      'utf-8',
    );
    return load(content) as WorkspaceConfig;
  }

  it('should remove orphaned project plugins', async () => {
    // Only 'good-mp' is registered
    await writeRegistry({
      'good-mp': {
        name: 'good-mp',
        source: { type: 'local', location: '/tmp/good-mp' },
        path: '/tmp/good-mp',
      },
    });

    // Use a subdirectory as workspace so project config doesn't overlap with user config
    const projectDir = join(testDir, 'project');
    const projectConfigDir = join(projectDir, CONFIG_DIR);
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(
      join(projectConfigDir, WORKSPACE_CONFIG_FILE),
      dump({
        repositories: [],
        plugins: [
          'pluginA@good-mp',
          'pluginB@removed-mp',
          '/local/plugin',
        ],
        clients: ['claude'],
      } satisfies WorkspaceConfig, { lineWidth: -1 }),
      'utf-8',
    );

    const result = await pruneOrphanedPlugins(projectDir);
    expect(result.project.removed).toEqual(['pluginB@removed-mp']);
    expect(result.project.kept).toContain('pluginA@good-mp');
    expect(result.project.kept).toContain('/local/plugin');

    const content = await readFile(
      join(projectConfigDir, WORKSPACE_CONFIG_FILE),
      'utf-8',
    );
    const config = load(content) as WorkspaceConfig;
    expect(config.plugins).toEqual(['pluginA@good-mp', '/local/plugin']);
  });

  it('should remove orphaned user plugins', async () => {
    await writeRegistry({
      'good-mp': {
        name: 'good-mp',
        source: { type: 'local', location: '/tmp/good-mp' },
        path: '/tmp/good-mp',
      },
    });

    // Use a subdirectory as workspace so project and user configs don't overlap
    const projectDir = join(testDir, 'project');
    const projectConfigDir = join(projectDir, CONFIG_DIR);
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(
      join(projectConfigDir, WORKSPACE_CONFIG_FILE),
      dump({ repositories: [], plugins: [], clients: ['claude'] }, { lineWidth: -1 }),
      'utf-8',
    );

    await writeUserConfig({
      repositories: [],
      plugins: [
        'pluginA@good-mp',
        'pluginB@removed-mp',
      ],
      clients: ['claude'],
    });

    const result = await pruneOrphanedPlugins(projectDir);
    expect(result.user.removed).toEqual(['pluginB@removed-mp']);

    const config = await readUserConfig();
    expect(config.plugins).toEqual(['pluginA@good-mp']);
  });

  it('should handle no orphans (nothing to prune)', async () => {
    await writeRegistry({
      'good-mp': {
        name: 'good-mp',
        source: { type: 'local', location: '/tmp/good-mp' },
        path: '/tmp/good-mp',
      },
    });

    // Use a subdirectory as workspace so project config doesn't overlap with user config
    const projectDir = join(testDir, 'project');
    const projectConfigDir = join(projectDir, CONFIG_DIR);
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(
      join(projectConfigDir, WORKSPACE_CONFIG_FILE),
      dump({ repositories: [], plugins: ['pluginA@good-mp'], clients: ['claude'] } satisfies WorkspaceConfig, { lineWidth: -1 }),
      'utf-8',
    );

    const result = await pruneOrphanedPlugins(projectDir);
    expect(result.project.removed).toEqual([]);
    expect(result.user.removed).toEqual([]);
  });

  it('should skip non-marketplace plugins (local paths, GitHub URLs)', async () => {
    await writeRegistry({});

    const localPlugin = join(testDir, 'my-plugin');
    await mkdir(localPlugin, { recursive: true });

    // Use a subdirectory as workspace so project config doesn't overlap with user config
    const projectDir = join(testDir, 'project');
    const projectConfigDir = join(projectDir, CONFIG_DIR);
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(
      join(projectConfigDir, WORKSPACE_CONFIG_FILE),
      dump({
        repositories: [],
        plugins: [localPlugin, 'https://github.com/owner/repo'],
        clients: ['claude'],
      } satisfies WorkspaceConfig, { lineWidth: -1 }),
      'utf-8',
    );

    const result = await pruneOrphanedPlugins(projectDir);
    // Non-marketplace plugins should be kept, not pruned
    expect(result.project.removed).toEqual([]);
  });
});
