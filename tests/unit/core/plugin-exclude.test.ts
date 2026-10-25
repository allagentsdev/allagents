import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { copyCommands, copyAgents, copySkills, copyPluginToWorkspace } from '../../../src/core/transform.js';

describe('plugin exclude patterns', () => {
  let testDir: string;
  let pluginDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-exclude-test-'));
    pluginDir = join(testDir, 'plugin');
    workspaceDir = join(testDir, 'workspace');
    await mkdir(pluginDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('root skill content', () => {
    beforeEach(async () => {
      await writeFile(join(pluginDir, 'SKILL.md'), '---\nname: demo\ndescription: Demo\n---\n');
      await mkdir(join(pluginDir, 'scripts'));
      await writeFile(join(pluginDir, 'scripts', 'hello.sh'), 'echo hello');
    });

    it.each(['directory', 'file'])('copies supporting content without Git metadata (%s)', async (gitType) => {
      if (gitType === 'directory') {
        await mkdir(join(pluginDir, '.git'));
        await writeFile(join(pluginDir, '.git', 'config'), 'private repository config');
      } else {
        await writeFile(join(pluginDir, '.git'), 'gitdir: /private/worktree');
      }
      await mkdir(join(pluginDir, '.github'));
      await writeFile(join(pluginDir, '.github', 'ci.yml'), 'workflow');
      await mkdir(join(pluginDir, '.allagents'));
      await writeFile(join(pluginDir, '.allagents', 'workspace.yaml'), 'private workspace');
      await mkdir(join(pluginDir, 'assets'));
      await writeFile(join(pluginDir, 'assets', 'page.html'), '<p>demo</p>');
      await writeFile(join(pluginDir, '.skillrc'), 'supporting dotfile');

      const results = await copySkills(pluginDir, workspaceDir, 'claude');
      expect(results.map((result) => result.action)).toEqual(['copied']);
      const destination = join(workspaceDir, '.claude', 'skills', 'demo');
      expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toContain('name: demo');
      expect(await readFile(join(destination, 'scripts', 'hello.sh'), 'utf8')).toBe('echo hello');
      expect(await readFile(join(destination, 'assets', 'page.html'), 'utf8')).toBe('<p>demo</p>');
      expect(await readFile(join(destination, '.skillrc'), 'utf8')).toBe('supporting dotfile');
      for (const metadata of ['.git', '.github', '.allagents']) {
        expect(existsSync(join(destination, metadata))).toBe(false);
      }
    });

    it('applies plugin-relative file and directory excludes to root skill content', async () => {
      await writeFile(join(pluginDir, 'scripts', 'private.sh'), 'private');
      await mkdir(join(pluginDir, 'design'));
      await writeFile(join(pluginDir, 'design', 'draft.md'), 'draft');

      const results = await copyPluginToWorkspace(pluginDir, workspaceDir, 'claude', {
        exclude: ['scripts/private.*', 'design'],
      });
      expect(results.every((result) => result.action === 'copied')).toBe(true);
      const destination = join(workspaceDir, '.claude', 'skills', 'demo');
      expect(await readFile(join(destination, 'scripts', 'hello.sh'), 'utf8')).toBe('echo hello');
      expect(existsSync(join(destination, 'scripts', 'private.sh'))).toBe(false);
      expect(existsSync(join(destination, 'design'))).toBe(false);
    });

    it('keeps root skill dry runs read-only', async () => {
      const results = await copySkills(pluginDir, workspaceDir, 'claude', { dryRun: true });
      expect(results.map((result) => result.action)).toEqual(['copied']);
      expect(existsSync(join(workspaceDir, '.claude'))).toBe(false);
    });

    it.each(['direct', 'alias'])('rejects copying a root skill into its own directory tree (%s)', async (sourceType) => {
      let source = pluginDir;
      if (sourceType === 'alias') {
        source = join(testDir, 'source-alias');
        await symlink(pluginDir, source, process.platform === 'win32' ? 'junction' : 'dir');
      }
      const results = await copySkills(source, pluginDir, 'claude');
      expect(results.map((result) => result.action)).toEqual(['failed']);
      expect(results[0]?.error).toContain('overlap');
      expect(existsSync(join(pluginDir, '.claude', 'skills', 'demo'))).toBe(false);
      expect(await readFile(join(pluginDir, 'scripts', 'hello.sh'), 'utf8')).toBe('echo hello');
    });

    it('rejects a destination that contains the source skill', async () => {
      const results = await copySkills(pluginDir, testDir, 'claude', {
        clientMappings: { claude: { skillsPath: '.' } },
        skillNameMap: new Map([['demo', '.']]),
      });
      expect(results.map((result) => result.action)).toEqual(['failed']);
      expect(results[0]?.error).toContain('overlap');
      expect(existsSync(join(testDir, 'SKILL.md'))).toBe(false);
      expect(await readFile(join(pluginDir, 'scripts', 'hello.sh'), 'utf8')).toBe('echo hello');
    });
  });

  describe('copyCommands', () => {
    it('excludes commands matching exclude patterns', async () => {
      await mkdir(join(pluginDir, 'commands'), { recursive: true });
      await writeFile(join(pluginDir, 'commands', 'public-cmd.md'), '# Public');
      await writeFile(join(pluginDir, 'commands', 'internal-cmd.md'), '# Internal');

      const results = await copyCommands(pluginDir, workspaceDir, 'claude', {
        exclude: ['commands/internal-cmd.md'],
      });

      expect(results).toHaveLength(1);
      expect(existsSync(join(workspaceDir, '.claude', 'commands', 'public-cmd.md'))).toBe(true);
      expect(existsSync(join(workspaceDir, '.claude', 'commands', 'internal-cmd.md'))).toBe(false);
    });
  });

  describe('copyAgents', () => {
    it('excludes agents matching exclude patterns', async () => {
      await mkdir(join(pluginDir, 'agents'), { recursive: true });
      await writeFile(join(pluginDir, 'agents', 'reviewer.md'), '# Reviewer');
      await writeFile(join(pluginDir, 'agents', 'debug-only.md'), '# Debug');

      const results = await copyAgents(pluginDir, workspaceDir, 'claude', {
        exclude: ['agents/debug-only.md'],
      });

      expect(results).toHaveLength(1);
      expect(existsSync(join(workspaceDir, '.claude', 'agents', 'reviewer.md'))).toBe(true);
      expect(existsSync(join(workspaceDir, '.claude', 'agents', 'debug-only.md'))).toBe(false);
    });
  });

  describe('copyPluginToWorkspace', () => {
    it('applies exclude across all content types', async () => {
      // Setup commands (claude supports commandsPath)
      await mkdir(join(pluginDir, 'commands'), { recursive: true });
      await writeFile(join(pluginDir, 'commands', 'keep.md'), '# Keep');
      await writeFile(join(pluginDir, 'commands', 'drop.md'), '# Drop');

      // Setup agents (claude supports agentsPath)
      await mkdir(join(pluginDir, 'agents'), { recursive: true });
      await writeFile(join(pluginDir, 'agents', 'keep.md'), '# Keep');
      await writeFile(join(pluginDir, 'agents', 'drop.md'), '# Drop');

      // Use 'claude' client which supports commands and agents
      await copyPluginToWorkspace(pluginDir, workspaceDir, 'claude', {
        exclude: ['commands/drop.md', 'agents/drop.md'],
      });

      // Commands: kept file exists, excluded does not
      expect(existsSync(join(workspaceDir, '.claude', 'commands', 'keep.md'))).toBe(true);
      expect(existsSync(join(workspaceDir, '.claude', 'commands', 'drop.md'))).toBe(false);

      // Agents: kept file exists, excluded does not
      expect(existsSync(join(workspaceDir, '.claude', 'agents', 'keep.md'))).toBe(true);
      expect(existsSync(join(workspaceDir, '.claude', 'agents', 'drop.md'))).toBe(false);
    });
  });
});
