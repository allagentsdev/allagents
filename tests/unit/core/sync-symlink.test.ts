import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readFile, lstat, readlink } from 'node:fs/promises';
import { existsSync, lstatSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { syncWorkspace } from '../../../src/core/sync.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';

describe('syncWorkspace with symlink mode', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-sync-symlink-test-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function createPlugin(name: string, skillName: string): Promise<string> {
    const pluginDir = join(testDir, name);
    const skillDir = join(pluginDir, 'skills', skillName);
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---
name: ${skillName}
description: Test skill
---

# ${skillName} skill`,
    );
    return pluginDir;
  }

  it.each(['copy', 'symlink'])('syncs root skill resources and excludes in %s mode', async (syncMode) => {
    const pluginDir = join(testDir, 'root-plugin');
    await mkdir(join(pluginDir, 'assets'), { recursive: true });
    await writeFile(join(pluginDir, 'SKILL.md'), '---\nname: demo\ndescription: Demo\n---\n');
    await writeFile(join(pluginDir, 'server.mjs'), 'console.log("v1")');
    await writeFile(join(pluginDir, 'assets', 'page.html'), '<p>demo</p>');
    await writeFile(join(pluginDir, 'assets', 'draft.html'), 'private draft');
    await mkdir(join(pluginDir, '.git'));
    await writeFile(join(pluginDir, '.git', 'config'), 'repository config');
    await mkdir(join(pluginDir, '.github'));
    await writeFile(join(pluginDir, '.github', 'ci.yml'), 'workflow');

    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE), `
version: 2
repositories: []
plugins:
  - source: ${pluginDir}
    install: file
    skills: [demo]
    exclude: [assets/draft.html]
clients: [universal, claude, copilot]
syncMode: ${syncMode}
`);

    for (const version of ['v1', 'v2']) {
      await writeFile(join(pluginDir, 'server.mjs'), `console.log("${version}")`);
      const result = await syncWorkspace(testDir);
      expect(result.success).toBe(true);
      for (const clientDir of ['.agents', '.claude', '.github']) {
        const destination = join(testDir, clientDir, 'skills', 'demo');
        expect(await readFile(join(destination, 'server.mjs'), 'utf8')).toContain(version);
        expect(await readFile(join(destination, 'assets', 'page.html'), 'utf8')).toBe('<p>demo</p>');
        expect(existsSync(join(destination, 'assets', 'draft.html'))).toBe(false);
        expect(existsSync(join(destination, '.git'))).toBe(false);
        expect(existsSync(join(destination, '.github'))).toBe(false);
        expect((await lstat(destination)).isSymbolicLink()).toBe(syncMode === 'symlink' && clientDir !== '.agents');
      }
    }
  });

  it('creates symlink from non-universal client to canonical location', async () => {
    const pluginDir = await createPlugin('my-plugin', 'my-skill');

    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - claude
  - universal
`,
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);

    // Canonical should exist as a real directory
    const canonicalPath = join(testDir, '.agents', 'skills', 'my-skill');
    expect(existsSync(canonicalPath)).toBe(true);
    const canonicalStats = await lstat(canonicalPath);
    expect(canonicalStats.isSymbolicLink()).toBe(false);
    expect(canonicalStats.isDirectory()).toBe(true);

    // Claude path should be a symlink
    const claudePath = join(testDir, '.claude', 'skills', 'my-skill');
    expect(existsSync(claudePath)).toBe(true);
    const claudeStats = await lstat(claudePath);
    expect(claudeStats.isSymbolicLink()).toBe(true);

    // Symlink should point to canonical
    const target = await readlink(claudePath);
    // On Windows, junction may return absolute or relative path
    // On Unix, it's a relative path. Just check it contains the canonical path.
    const normalizedTarget = target.split(sep).join('/');
    expect(normalizedTarget).toContain('.agents/skills/my-skill');
  });

  it('does not create symlink for universal clients', async () => {
    const pluginDir = await createPlugin('my-plugin', 'my-skill');

    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - universal
`,
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);

    // Universal client uses .agents/skills/ directly as a real directory
    const canonicalPath = join(testDir, '.agents', 'skills', 'my-skill');
    expect(existsSync(canonicalPath)).toBe(true);
    const canonicalStats = await lstat(canonicalPath);
    expect(canonicalStats.isSymbolicLink()).toBe(false);
    expect(canonicalStats.isDirectory()).toBe(true);
  });

  it('creates symlinks for multiple non-universal clients', async () => {
    const pluginDir = await createPlugin('my-plugin', 'my-skill');

    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - claude
  - cursor
  - universal
`,
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);

    // Both should be symlinks pointing to canonical
    for (const client of ['claude', 'cursor']) {
      const clientPath = join(testDir, `.${client}`, 'skills', 'my-skill');
      expect(existsSync(clientPath)).toBe(true);
      const stats = await lstat(clientPath);
      expect(stats.isSymbolicLink()).toBe(true);
    }
  });

  it('purges symlink when plugin is removed', async () => {
    const pluginDir = await createPlugin('my-plugin', 'my-skill');

    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - claude
  - universal
`,
    );

    // First sync
    await syncWorkspace(testDir);
    expect(existsSync(join(testDir, '.claude', 'skills', 'my-skill'))).toBe(true);

    // Remove plugin
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins: []
clients:
  - claude
  - universal
`,
    );

    // Second sync
    await syncWorkspace(testDir);

    // Use lstatSync — existsSync follows symlinks and returns false for
    // broken symlinks, which would hide the bug
    let symlinkStillExists = false;
    try {
      lstatSync(join(testDir, '.claude', 'skills', 'my-skill'));
      symlinkStillExists = true;
    } catch {
      // expected — file doesn't exist
    }
    expect(symlinkStillExists).toBe(false);
  });

  it('purges symlinks when client is removed from workspace', async () => {
    const pluginDir = await createPlugin('my-plugin', 'my-skill');

    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - claude
  - universal
`,
    );

    // First sync — creates canonical + symlink
    await syncWorkspace(testDir);

    const claudeSkillPath = join(testDir, '.claude', 'skills', 'my-skill');
    const claudeStats = await lstat(claudeSkillPath);
    expect(claudeStats.isSymbolicLink()).toBe(true);

    // Remove claude from clients, keep universal
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - universal
`,
    );

    // Second sync — should purge claude symlinks
    await syncWorkspace(testDir);

    // Claude symlink should be gone (use lstatSync to detect dangling symlinks)
    let symlinkStillExists = false;
    try {
      lstatSync(claudeSkillPath);
      symlinkStillExists = true;
    } catch {
      // expected
    }
    expect(symlinkStillExists).toBe(false);

    // Canonical should still exist (universal is still active)
    const canonicalPath = join(testDir, '.agents', 'skills', 'my-skill');
    expect(existsSync(canonicalPath)).toBe(true);
  });

  it('uses copy mode when syncMode is set to copy', async () => {
    const pluginDir = await createPlugin('my-plugin', 'my-skill');

    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - claude
syncMode: copy
`,
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);

    // With copy mode, .claude/skills/my-skill should be a real directory, not a symlink
    const claudePath = join(testDir, '.claude', 'skills', 'my-skill');
    expect(existsSync(claudePath)).toBe(true);
    const stats = await lstat(claudePath);
    expect(stats.isSymbolicLink()).toBe(false);
    expect(stats.isDirectory()).toBe(true);

    // Canonical should NOT exist (copy mode doesn't use canonical)
    const canonicalPath = join(testDir, '.agents', 'skills', 'my-skill');
    expect(existsSync(canonicalPath)).toBe(false);
  });

  it('mixed universal and non-universal clients share canonical', async () => {
    const pluginDir = await createPlugin('my-plugin', 'my-skill');

    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - claude
  - universal
`,
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);

    // Universal uses canonical directly
    const canonicalPath = join(testDir, '.agents', 'skills', 'my-skill');
    expect(existsSync(canonicalPath)).toBe(true);
    const canonicalStats = await lstat(canonicalPath);
    expect(canonicalStats.isDirectory()).toBe(true);
    expect(canonicalStats.isSymbolicLink()).toBe(false);

    // Claude uses symlink
    const claudePath = join(testDir, '.claude', 'skills', 'my-skill');
    expect(existsSync(claudePath)).toBe(true);
    const claudeStats = await lstat(claudePath);
    expect(claudeStats.isSymbolicLink()).toBe(true);

    // Both should have the same content (via symlink for claude)
    expect(existsSync(join(canonicalPath, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(claudePath, 'SKILL.md'))).toBe(true);
  });

  it('does not create canonical when universal is not in clients list', async () => {
    const pluginDir = await createPlugin('my-plugin', 'my-skill');

    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - claude
  - copilot
`,
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);

    // Claude should have a real directory at its own path
    const claudePath = join(testDir, '.claude', 'skills', 'my-skill');
    expect(existsSync(claudePath)).toBe(true);
    const claudeStats = await lstat(claudePath);
    expect(claudeStats.isSymbolicLink()).toBe(false);
    expect(claudeStats.isDirectory()).toBe(true);

    // Copilot should have a real directory at its own path
    const copilotPath = join(testDir, '.github', 'skills', 'my-skill');
    expect(existsSync(copilotPath)).toBe(true);
    const copilotStats = await lstat(copilotPath);
    expect(copilotStats.isSymbolicLink()).toBe(false);
    expect(copilotStats.isDirectory()).toBe(true);

    // Canonical .agents/skills/ should NOT exist
    const canonicalPath = join(testDir, '.agents', 'skills');
    expect(existsSync(canonicalPath)).toBe(false);
  });
});
