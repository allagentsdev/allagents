import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as dump } from 'yaml';
import { syncWorkspace, syncUserWorkspace } from '../../../src/core/sync.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';
import type { WorkspaceConfig } from '../../../src/models/workspace-config.js';
import { stubHomeDir } from '../../helpers/env.js';
import { getSyncStatePath } from '../../../src/core/sync-state.js';

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

  it('preserves previously owned files and tracking when one plugin fails validation', async () => {
    const goodPlugin = await createLocalPlugin('good-plugin', 'good-skill');
    await writeProjectConfig({ repositories: [], plugins: [goodPlugin], clients: ['claude'] });
    expect((await syncWorkspace(testDir)).success).toBe(true);
    const skillPath = join(testDir, '.claude', 'skills', 'good-skill', 'SKILL.md');
    const original = await readFile(skillPath, 'utf8');
    const state = await readFile(getSyncStatePath(testDir), 'utf8');
    await writeProjectConfig({ repositories: [], plugins: [goodPlugin, './missing-plugin'], clients: ['claude'] });
    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(false);
    expect(result.totalCopied).toBe(0);
    expect(result.error).toContain('workspace unchanged');
    expect(await readFile(skillPath, 'utf8')).toBe(original);
    expect(await readFile(getSyncStatePath(testDir), 'utf8')).toBe(state);
  });

  it('should fail when ALL plugins are invalid', async () => {
    await writeProjectConfig({
      repositories: [],
      plugins: [
        './missing-plugin-1',
        './missing-plugin-2',
      ],
      clients: ['claude'],
    });

    const result = await syncWorkspace(testDir);

    // When everything fails, sync should fail
    expect(result.success).toBe(false);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.length).toBe(2);
  });

  it('returns an unchanged failure rather than throwing for a non-directory plugin source', async () => {
    const goodPlugin = await createLocalPlugin('good-plugin', 'good-skill');
    const badPluginPath = join(testDir, 'bad-plugin-is-a-file');
    await writeFile(badPluginPath, 'not a directory');

    await writeProjectConfig({
      repositories: [],
      plugins: [goodPlugin, badPluginPath],
      clients: ['claude'],
    });

    const result = await syncWorkspace(testDir);

    expect(result.success).toBe(false);
    expect(result.totalCopied).toBe(0);
    expect(result.warnings).toBeDefined();
    expect(result.warnings!.some((w) => w.includes(badPluginPath))).toBe(true);
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

  it('preserves owned user files and tracking when another source is invalid', async () => {
    const goodPlugin = await createLocalPlugin('good-plugin', 'good-skill');
    await writeUserConfig({ repositories: [], plugins: [goodPlugin], clients: ['copilot'] });
    expect((await syncUserWorkspace()).success).toBe(true);
    const skillPath = join(testDir, '.copilot', 'skills', 'good-skill', 'SKILL.md');
    const original = await readFile(skillPath, 'utf8');
    const state = await readFile(getSyncStatePath(testDir), 'utf8');
    await writeUserConfig({ repositories: [], plugins: [goodPlugin, './missing-plugin'], clients: ['copilot'] });
    const result = await syncUserWorkspace();
    expect(result.success).toBe(false);
    expect(result.totalCopied).toBe(0);
    expect(result.error).toContain('user workspace unchanged');
    expect(await readFile(skillPath, 'utf8')).toBe(original);
    expect(await readFile(getSyncStatePath(testDir), 'utf8')).toBe(state);
  });
});
