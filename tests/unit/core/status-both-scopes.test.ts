import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dump } from 'js-yaml';
import { getWorkspaceStatus } from '../../../src/core/status.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';
import type { WorkspaceConfig } from '../../../src/models/workspace-config.js';
import { stubHomeDir } from '../../helpers/env.js';

describe('workspace status - both scopes', () => {
  let testDir: string;
  let restoreHomeDir: () => void;
  let restoreScopedHomeDir: (() => void) | undefined;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-status-test-'));
    restoreHomeDir = stubHomeDir(testDir);
    restoreScopedHomeDir = undefined;
  });

  afterEach(async () => {
    restoreScopedHomeDir?.();
    restoreHomeDir();
    await rm(testDir, { recursive: true, force: true });
  });

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

  async function createLocalPlugin(name: string): Promise<string> {
    const pluginDir = join(testDir, 'plugins', name);
    await mkdir(pluginDir, { recursive: true });
    return pluginDir;
  }

  it('should include userPlugins in status result', async () => {
    // Use a separate HOME so user config doesn't overlap with project dir.
    const homeDir = await mkdtemp(join(tmpdir(), 'allagents-status-home-'));
    restoreScopedHomeDir = stubHomeDir(homeDir);

    const projectPlugin = await createLocalPlugin('project-plugin');
    const userPlugin = await createLocalPlugin('user-plugin');

    await writeProjectConfig({
      repositories: [],
      plugins: [projectPlugin],
      clients: ['claude'],
    });

    const allagentsDir = join(homeDir, '.allagents');
    await mkdir(allagentsDir, { recursive: true });
    await writeFile(
      join(allagentsDir, WORKSPACE_CONFIG_FILE),
      dump({ repositories: [], plugins: [userPlugin], clients: ['claude'] } satisfies WorkspaceConfig, { lineWidth: -1 }),
      'utf-8',
    );

    const result = await getWorkspaceStatus(testDir);
    expect(result.success).toBe(true);
    expect(result.plugins.length).toBe(1);
    expect(result.userPlugins).toBeDefined();
    expect(result.userPlugins!.length).toBe(1);

    await rm(homeDir, { recursive: true, force: true });
  });

  it('should fall back to user plugins when no project workspace exists', async () => {
    // Use a separate HOME so user config doesn't overlap with project dir
    const homeDir = await mkdtemp(join(tmpdir(), 'allagents-status-home-'));
    restoreScopedHomeDir = stubHomeDir(homeDir);

    const userPlugin = await createLocalPlugin('user-plugin');
    const allagentsDir = join(homeDir, '.allagents');
    await mkdir(allagentsDir, { recursive: true });
    await writeFile(
      join(allagentsDir, WORKSPACE_CONFIG_FILE),
      dump({ repositories: [], plugins: [userPlugin], clients: ['claude'] } satisfies WorkspaceConfig, { lineWidth: -1 }),
      'utf-8',
    );

    // No project config — should succeed with user plugins only
    const result = await getWorkspaceStatus(testDir);
    expect(result.success).toBe(true);
    expect(result.plugins).toEqual([]);
    expect(result.clients).toEqual(['claude']);
    expect(result.userPlugins!.length).toBe(1);

    await rm(homeDir, { recursive: true, force: true });
  });

  it('should not duplicate plugins when workspace is the home directory', async () => {
    // When cwd === HOME, project config and user config are the same file.
    // Plugins should only appear as userPlugins, not both.
    const userPlugin = await createLocalPlugin('shared-plugin');

    // Both writeProjectConfig and writeUserConfig write to testDir/.allagents/
    // which is the same path since HOME = testDir
    await writeUserConfig({
      repositories: [],
      plugins: [userPlugin],
      clients: ['claude'],
    });

    const result = await getWorkspaceStatus(testDir);
    expect(result.success).toBe(true);
    expect(result.plugins).toEqual([]);
    expect(result.userPlugins!.length).toBe(1);
    expect(result.userPlugins![0].source).toBe(userPlugin);
  });

  it('distinguishes a native npm package from the upstream file plugin', async () => {
    await writeUserConfig({
      repositories: [],
      clients: ['pi:native', 'codex'],
      plugins: [
        { source: 'npm:pi-compound-engineering@3.19.2', clients: ['pi'] },
        { source: 'https://github.com/EveryInc/compound-engineering-plugin', clients: ['codex'] },
      ],
    });
    const result = await getWorkspaceStatus(testDir);
    expect(result.success).toBe(true);
    expect(result.plugins).toEqual([]);
    expect(result.userPlugins).toHaveLength(2);
    expect(result.clients).toEqual(['pi', 'codex']);
    expect(result.userPlugins?.[0]).toEqual({
      source: 'npm:pi-compound-engineering@3.19.2', type: 'package',
      kind: 'plugin', available: false, path: '',
    });
    expect(result.userPlugins?.[1]?.type).toBe('github');
    // Declarations alone must not claim a native package is installed.
    expect(result.nativeResources).toEqual([]);
  });

  it('should show empty userPlugins when no user config exists', async () => {
    // Use a separate HOME dir so there's no user config
    const separateHome = await mkdtemp(join(tmpdir(), 'allagents-status-home-'));
    restoreScopedHomeDir = stubHomeDir(separateHome);

    const projectPlugin = await createLocalPlugin('project-plugin');

    await writeProjectConfig({
      repositories: [],
      plugins: [projectPlugin],
      clients: ['claude'],
    });

    const result = await getWorkspaceStatus(testDir);
    expect(result.success).toBe(true);
    expect(result.userPlugins).toEqual([]);

    await rm(separateHome, { recursive: true, force: true });
  });

  it('uses a configured Git ref for availability while preserving the raw source', async () => {
    const source = 'https://github.com/EveryInc/compound-engineering-plugin';
    const ref = 'compound-engineering-v3.23.3';
    const cache = join(testDir, '.allagents', 'plugins', 'marketplaces', `EveryInc-compound-engineering-plugin@${ref}`);
    await mkdir(cache, { recursive: true });
    await writeUserConfig({
      repositories: [], clients: ['codex'], plugins: [{ source, ref }],
    });
    const user = await getWorkspaceStatus(testDir);
    expect(user.userPlugins?.[0]).toMatchObject({ source, available: true, path: cache });

    const project = join(testDir, 'project');
    await mkdir(join(project, CONFIG_DIR), { recursive: true });
    await writeFile(join(project, CONFIG_DIR, WORKSPACE_CONFIG_FILE), dump({
      repositories: [], clients: ['codex'], plugins: [{ source, ref }],
    }));
    const both = await getWorkspaceStatus(project);
    expect(both.plugins[0]).toMatchObject({ source, available: true, path: cache });
    expect(both.userPlugins?.[0]).toMatchObject({ source, available: true, path: cache });
  });

  it('should mark GitHub plugin as cached when cache is branch-qualified', async () => {
    // Regression: `skills add <github-blob-url>` clones into `<owner>-<repo>@<branch>`,
    // but `workspace status` looked up `<owner>-<repo>` and reported "not cached".
    const homeDir = await mkdtemp(join(tmpdir(), 'allagents-status-home-'));
    restoreScopedHomeDir = stubHomeDir(homeDir);

    const branchedCache = join(
      homeDir,
      '.allagents',
      'plugins',
      'marketplaces',
      'NousResearch-hermes-agent@main',
    );
    await mkdir(branchedCache, { recursive: true });

    await writeProjectConfig({
      repositories: [],
      plugins: [
        'https://github.com/NousResearch/hermes-agent/blob/main/skills/research/llm-wiki',
      ],
      clients: ['claude'],
    });

    const result = await getWorkspaceStatus(testDir);
    expect(result.success).toBe(true);
    expect(result.plugins.length).toBe(1);
    expect(result.plugins[0]?.type).toBe('github');
    expect(result.plugins[0]?.available).toBe(true);
    expect(result.plugins[0]?.path).toBe(branchedCache);

    await rm(homeDir, { recursive: true, force: true });
  });
});
