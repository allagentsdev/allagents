import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as dump } from 'yaml';
import { syncWorkspace, syncUserWorkspace } from '../../../src/core/sync.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';
import type { WorkspaceConfig } from '../../../src/models/workspace-config.js';
import { stubHomeDir } from '../../helpers/env.js';

describe('sync resilience - project scope', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-sync-resilient-'));
  });

  afterEach(async () => {
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

  async function createLocalPlugin(name: string, skillName: string): Promise<string> {
    const pluginDir = join(testDir, 'plugins', name);
    const skillDir = join(pluginDir, 'skills', skillName);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), [
      '---',
      `name: ${skillName}`,
      `description: Test skill ${skillName}`,
      '---',
      '',
      `# ${skillName}`,
    ].join('\n'));
    return pluginDir;
  }

  it('should sync valid plugins and skip invalid ones with warnings', async () => {
    const goodPlugin = await createLocalPlugin('good-plugin', 'good-skill');

    await writeProjectConfig({
      repositories: [],
      plugins: [
        goodPlugin,
        'nonexistent@fake-marketplace',
      ],
      clients: ['claude'],
    });

    const result = await syncWorkspace(testDir);

    // Should succeed overall (partial success)
    expect(result.success).toBe(true);
    expect(result.totalCopied).toBeGreaterThan(0);

    // Should have warnings for the failed plugin
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThan(0);
    expect(result.warnings![0]).toContain('nonexistent@fake-marketplace');

    // The good plugin should have been synced
    expect(result.pluginResults.length).toBe(1);
    expect(result.pluginResults[0].success).toBe(true);
  });

  it('should fail when ALL plugins are invalid', async () => {
    await writeProjectConfig({
      repositories: [],
      plugins: [
        'bad1@fake-marketplace',
        'bad2@fake-marketplace',
      ],
      clients: ['claude'],
    });

    const result = await syncWorkspace(testDir);

    // When everything fails, sync should fail
    expect(result.success).toBe(false);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBe(2);
  });

  it('should sync the good plugin and warn (not throw) when another plugin path cannot be scanned for skills', async () => {
    // A plugin whose *source* resolves to a real file (not a directory) passes
    // plugin validation (existsSync) but can't be readdir'd during skill
    // collection — this is what used to crash the whole sync with an uncaught
    // EPERM/ENOTDIR (see #433-style bad-path bugs).
    const goodPlugin = await createLocalPlugin('good-plugin', 'good-skill');
    const badPluginPath = join(testDir, 'bad-plugin-is-a-file');
    await writeFile(badPluginPath, 'not a directory');

    await writeProjectConfig({
      repositories: [],
      plugins: [goodPlugin, badPluginPath],
      clients: ['claude'],
    });

    const result = await syncWorkspace(testDir);

    expect(result.totalCopied).toBeGreaterThan(0);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes(badPluginPath))).toBe(true);
    // The same bad path is scanned twice internally (once to collect enabled
    // skills, once to collect all skill names for deleted-artifact detection)
    // — warnings should be deduplicated rather than shown twice.
    const matching = result.warnings!.filter((w) => w.includes(badPluginPath));
    expect(matching).toHaveLength(1);
  });
});

describe('sync resilience - user scope', () => {
  let testDir: string;
  let restoreHomeDir: () => void;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-sync-user-resilient-'));
    restoreHomeDir = stubHomeDir(testDir);
  });

  afterEach(async () => {
    restoreHomeDir();
    await rm(testDir, { recursive: true, force: true });
  });

  async function writeUserConfig(config: WorkspaceConfig): Promise<void> {
    const allagentsDir = join(testDir, '.allagents');
    await mkdir(allagentsDir, { recursive: true });
    await writeFile(
      join(allagentsDir, WORKSPACE_CONFIG_FILE),
      dump(config, { lineWidth: -1 }),
      'utf-8',
    );
  }

  async function createLocalPlugin(name: string, skillName: string): Promise<string> {
    const pluginDir = join(testDir, 'plugins', name);
    const skillDir = join(pluginDir, 'skills', skillName);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), [
      '---',
      `name: ${skillName}`,
      `description: Test skill ${skillName}`,
      '---',
      '',
      `# ${skillName}`,
    ].join('\n'));
    return pluginDir;
  }

  it('should sync valid user plugins and skip invalid ones with warnings', async () => {
    const goodPlugin = await createLocalPlugin('good-plugin', 'good-skill');

    await writeUserConfig({
      repositories: [],
      plugins: [
        goodPlugin,
        'nonexistent@fake-marketplace',
      ],
      clients: ['claude'],
    });

    const result = await syncUserWorkspace();

    expect(result.success).toBe(true);
    expect(result.totalCopied).toBeGreaterThan(0);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBeGreaterThan(0);
  });
});
