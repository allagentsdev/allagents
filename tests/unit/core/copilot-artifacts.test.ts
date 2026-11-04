import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink, readlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { copyAgents, copyCommands, copyHooks, copySkills, copyPluginToWorkspace, collectPluginSkills } from '../../../src/core/transform.js';
import { resolvePluginComponents } from '../../../src/core/plugin-components.js';
import { USER_CLIENT_MAPPINGS } from '../../../src/models/client-mapping.js';

describe('copilot agents and hooks sync', () => {
  let testDir: string;
  let pluginDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-copilot-test-'));
    pluginDir = join(testDir, 'plugin');
    workspaceDir = join(testDir, 'workspace');
    await mkdir(pluginDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  describe('copyAgents for copilot', () => {
    it('copies root agents/ to .github/agents/ for copilot client', async () => {
      await mkdir(join(pluginDir, 'agents'), { recursive: true });
      await writeFile(join(pluginDir, 'agents', 'reviewer.agent.md'), '# Reviewer Agent');

      const results = await copyAgents(pluginDir, workspaceDir, 'copilot');

      expect(results).toHaveLength(1);
      expect(results[0].action).toBe('copied');
      expect(existsSync(join(workspaceDir, '.github', 'agents', 'reviewer.agent.md'))).toBe(true);

      const content = await readFile(join(workspaceDir, '.github', 'agents', 'reviewer.agent.md'), 'utf-8');
      expect(content).toBe('# Reviewer Agent');
    });

    it('returns empty when plugin has no agents/ directory', async () => {
      const results = await copyAgents(pluginDir, workspaceDir, 'copilot');
      expect(results).toHaveLength(0);
    });
  });

  describe('copyHooks for copilot', () => {
    it('copies root hooks/ to .github/hooks/ for copilot client', async () => {
      await mkdir(join(pluginDir, 'hooks'), { recursive: true });
      await writeFile(join(pluginDir, 'hooks', 'safety.json'), '{"hooks":[]}');

      const results = await copyHooks(pluginDir, workspaceDir, 'copilot');

      expect(results).toHaveLength(1);
      expect(results[0].action).toBe('copied');
      expect(existsSync(join(workspaceDir, '.github', 'hooks', 'safety.json'))).toBe(true);

      const content = await readFile(join(workspaceDir, '.github', 'hooks', 'safety.json'), 'utf-8');
      expect(content).toBe('{"hooks":[]}');
    });

    it('never copies a lower-priority hook declaration as a resource payload', async () => {
      await mkdir(join(pluginDir, 'hooks'), { recursive: true });
      const rootConfig = '{"hooks":{"SessionStart":[]},"source":"root"}';
      await writeFile(join(pluginDir, 'hooks.json'), rootConfig);
      await writeFile(join(pluginDir, 'hooks/hooks.json'), '{"hooks":{"SessionStart":[]},"source":"fallback"}');
      await writeFile(join(pluginDir, 'hooks/safety.sh'), 'echo safe');
      await copyHooks(pluginDir, workspaceDir, 'copilot');
      await copyHooks(pluginDir, workspaceDir, 'claude');
      expect(existsSync(join(workspaceDir, '.github/hooks/hooks.json'))).toBe(false);
      expect(existsSync(join(workspaceDir, '.github/hooks/safety.sh'))).toBe(true);
      expect(await readFile(join(workspaceDir, '.claude/hooks/hooks.json'), 'utf-8')).toBe(rootConfig);
    });

    it('returns empty when plugin has no hooks/ directory', async () => {
      const results = await copyHooks(pluginDir, workspaceDir, 'copilot');
      expect(results).toHaveLength(0);
    });
    it('does not rediscover portable hooks when resolved sources are empty', async () => {
      await mkdir(join(pluginDir, 'hooks'), { recursive: true });
      await writeFile(join(pluginDir, 'hooks/portable.json'), '{"hooks":[]}');
      const components = resolvePluginComponents(pluginDir);
      components.hooks = [];
      components.hookResources = [];
      expect(await copyHooks(pluginDir, workspaceDir, 'copilot', { components })).toEqual([]);
      expect(existsSync(join(workspaceDir, '.github/hooks/portable.json'))).toBe(false);
    });
  });
  describe('manifest-selected components', () => {
    async function manifest(components: Record<string, unknown>): Promise<void> {
      await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true });
      await writeFile(join(pluginDir, '.claude-plugin', 'plugin.json'),
        JSON.stringify({ name: 'selected-plugin', version: '1.0.0', ...components }));
    }

    it('replaces conventional components and honors original-root exclusions', async () => {
      for (const path of ['skills/default', 'commands', 'agents', 'custom/skills/category/keep',
        'custom/skills/category/drop', 'custom/commands/nested', 'custom/agents/nested', '.github/workflows']) {
        await mkdir(join(pluginDir, path), { recursive: true });
      }
      await writeFile(join(pluginDir, 'skills/default/SKILL.md'), '# Default');
      await writeFile(join(pluginDir, 'commands/default.md'), '# Default');
      await writeFile(join(pluginDir, 'agents/default.agent.md'), '# Default');
      await writeFile(join(pluginDir, 'custom/skills/category/keep/SKILL.md'), '# Keep');
      await writeFile(join(pluginDir, 'custom/skills/category/keep/private.txt'), 'private');
      await writeFile(join(pluginDir, 'custom/skills/category/drop/SKILL.md'), '# Drop');
      await writeFile(join(pluginDir, 'custom/commands/keep.md'), '# Keep');
      await writeFile(join(pluginDir, 'custom/commands/drop.md'), '# Drop');
      await writeFile(join(pluginDir, 'custom/commands/nested/ignored.md'), '# Nested');
      await writeFile(join(pluginDir, 'custom/agents/keep.agent.md'), '# Keep');
      await writeFile(join(pluginDir, 'custom/agents/nested/ignored.agent.md'), '# Nested');
      await writeFile(join(pluginDir, '.github/workflows/dev.yml'), 'development');
      await manifest({ skills: './custom/skills', commands: './custom/commands', agents: './custom/agents' });

      const results = await copyPluginToWorkspace(pluginDir, workspaceDir, 'claude', {
        exclude: ['custom/commands/drop.md', 'custom/skills/category/drop', 'custom/skills/category/keep/private.txt'],
        skillNameMap: new Map([['category/keep', 'renamed']]),
      });
      expect(results.every((result) => result.action === 'copied')).toBe(true);
      expect(await readFile(join(workspaceDir, '.claude/skills/renamed/SKILL.md'), 'utf-8')).toBe('# Keep');
      expect(existsSync(join(workspaceDir, '.claude/skills/renamed/private.txt'))).toBe(false);
      expect(existsSync(join(workspaceDir, '.claude/commands/keep.md'))).toBe(true);
      expect(existsSync(join(workspaceDir, '.claude/commands/drop.md'))).toBe(false);
      expect(existsSync(join(workspaceDir, '.claude/commands/nested'))).toBe(false);
      expect(existsSync(join(workspaceDir, '.claude/agents/keep.agent.md'))).toBe(true);
      expect(existsSync(join(workspaceDir, '.claude/agents/nested'))).toBe(false);
      expect(existsSync(join(workspaceDir, '.claude/skills/default'))).toBe(false);
      expect(existsSync(join(workspaceDir, '.claude/commands/default.md'))).toBe(false);
      expect(existsSync(join(workspaceDir, '.claude/agents/default.agent.md'))).toBe(false);
      expect(existsSync(join(workspaceDir, '.github/workflows/dev.yml'))).toBe(false);
    });

    it('copies an explicit plugin-root skill collection without a root definition', async () => {
      await mkdir(join(pluginDir, 'category/keep/scripts'), { recursive: true });
      await mkdir(join(pluginDir, 'category/drop'), { recursive: true });
      await writeFile(join(pluginDir, 'category/keep/SKILL.md'), '# Keep');
      await writeFile(join(pluginDir, 'category/keep/scripts/run.sh'), 'echo keep');
      await writeFile(join(pluginDir, 'category/drop/SKILL.md'), '# Drop');
      await manifest({ skills: '.' });
      const components = resolvePluginComponents(pluginDir);
      const exclude = ['category/drop/**'];
      const inventory = await collectPluginSkills(
        pluginDir, 'selected', undefined, undefined, undefined, undefined, undefined, components, exclude,
      );
      expect(inventory.map((skill) => skill.folderName)).toEqual(['keep']);
      const results = await copyPluginToWorkspace(pluginDir, workspaceDir, 'claude', {
        components, exclude, skillNameMap: new Map([['category/keep', 'selected']]),
      });
      expect(results.map((result) => result.action)).toEqual(['copied']);
      expect(await readFile(join(workspaceDir, '.claude/skills/selected/SKILL.md'), 'utf-8')).toBe('# Keep');
      expect(await readFile(join(workspaceDir, '.claude/skills/selected/scripts/run.sh'), 'utf-8')).toBe('echo keep');
      expect(existsSync(join(workspaceDir, '.claude/skills/drop'))).toBe(false);
    });

    it('copies individual command and agent files and a direct skill directory', async () => {
      await mkdir(join(pluginDir, 'custom/direct-skill'), { recursive: true });
      await writeFile(join(pluginDir, 'custom/direct-skill/SKILL.md'), '---\nname: frontmatter-name\n---\n# Skill');
      await writeFile(join(pluginDir, 'custom/command.md'), '# Command');
      await writeFile(join(pluginDir, 'custom/agent.agent.md'), '# Agent');
      await manifest({ skills: './custom/direct-skill', commands: './custom/command.md', agents: './custom/agent.agent.md' });
      const inventory = await collectPluginSkills(pluginDir, 'test');
      expect(inventory.map((skill) => skill.folderName)).toEqual(['direct-skill']);
      await copyPluginToWorkspace(pluginDir, workspaceDir, 'claude');
      expect(existsSync(join(workspaceDir, '.claude/skills/direct-skill/SKILL.md'))).toBe(true);
      expect(await readFile(join(workspaceDir, '.claude/commands/command.md'), 'utf-8')).toBe('# Command');
      expect(await readFile(join(workspaceDir, '.claude/agents/agent.agent.md'), 'utf-8')).toBe('# Agent');
    });

    it('uses selected skill paths in both canonical copy and client symlink modes', async () => {
      await mkdir(join(pluginDir, 'custom/selected'), { recursive: true });
      await writeFile(join(pluginDir, 'custom/selected/SKILL.md'), '# Selected');
      await manifest({ skills: './custom/selected' });
      const components = resolvePluginComponents(pluginDir);
      const skillNameMap = new Map([['selected', 'renamed']]);
      await copySkills(pluginDir, workspaceDir, 'universal', { components, skillNameMap });
      await copySkills(pluginDir, workspaceDir, 'claude', {
        components, skillNameMap, syncMode: 'symlink', canonicalSkillsPath: '.agents/skills/',
      });
      const destination = join(workspaceDir, '.claude/skills/renamed');
      expect(await readFile(join(destination, 'SKILL.md'), 'utf-8')).toBe('# Selected');
      expect(await readlink(destination)).toContain('renamed');
    });

    it('copies selected hook declarations and portable root resources without custom-source siblings', async () => {
      await mkdir(join(pluginDir, 'custom-hooks/nested'), { recursive: true });
      await mkdir(join(pluginDir, 'hooks'), { recursive: true });
      await writeFile(join(pluginDir, 'hooks/old.json'), '{"old":true}');
      await writeFile(join(pluginDir, 'hooks/hooks.json'), '{"hooks":{"SessionStart":[]}}');
      await writeFile(join(pluginDir, 'custom-hooks/config.json'), '{"hooks":{"SessionStart":[]}}');
      await writeFile(join(pluginDir, 'custom-hooks/nested/keep.sh'), 'echo keep');
      await writeFile(join(pluginDir, 'custom-hooks/nested/drop.sh'), 'echo drop');
      await manifest({ hooks: './custom-hooks/config.json' });
      await copyHooks(pluginDir, workspaceDir, 'claude', { exclude: ['custom-hooks/nested/drop.sh'] });
      await copyHooks(pluginDir, workspaceDir, 'copilot', { exclude: ['custom-hooks/nested/drop.sh'] });
      expect(existsSync(join(workspaceDir, '.claude/hooks/hooks.json'))).toBe(true);
      expect(existsSync(join(workspaceDir, '.github/hooks/config.json'))).toBe(false);
      expect(existsSync(join(workspaceDir, '.github/hooks/hooks.json'))).toBe(false);
      expect(existsSync(join(workspaceDir, '.github/hooks/nested/keep.sh'))).toBe(false);
      expect(existsSync(join(workspaceDir, '.github/hooks/nested/drop.sh'))).toBe(false);
      expect(await readFile(join(workspaceDir, '.github/hooks/old.json'), 'utf-8')).toBe('{"old":true}');
      expect(existsSync(join(workspaceDir, '.github/hooks/hooks.json'))).toBe(false);
    });
    it.each(['file', 'inline'] as const)(
      'does not copy %s hook declarations when a known payload is excluded',
      async (kind) => {
        await mkdir(join(pluginDir, 'hooks'), { recursive: true });
        await writeFile(join(pluginDir, 'hooks/keep.sh'), 'echo keep');
        await writeFile(join(pluginDir, 'hooks/drop.sh'), 'echo drop');
        const hooks = { SessionStart: [{ type: 'command', command: 'sh hooks/drop.sh' }] };
        if (kind === 'file') {
          await writeFile(join(pluginDir, 'hooks/config.json'), JSON.stringify({ hooks }));
          await manifest({ hooks: './hooks/config.json' });
        } else {
          await manifest({ hooks });
        }
        const components = resolvePluginComponents(pluginDir);
        for (const client of ['claude', 'omp', 'copilot'] as const) {
          const clientMappings = client === 'copilot' ? USER_CLIENT_MAPPINGS : undefined;
          const results = await copyHooks(pluginDir, workspaceDir, client, {
            components, clientMappings, exclude: ['hooks/drop.sh'],
          });
          const hooksDir = client === 'claude' ? '.claude/hooks'
            : client === 'omp' ? '.omp/hooks' : '.copilot/hooks';
          expect(results.map((result) => result.source)).toEqual([join(pluginDir, 'hooks/keep.sh')]);
          expect(await readFile(join(workspaceDir, hooksDir, 'keep.sh'), 'utf-8')).toBe('echo keep');
          expect(existsSync(join(workspaceDir, hooksDir, 'drop.sh'))).toBe(false);
          expect(existsSync(join(workspaceDir, hooksDir, 'config.json'))).toBe(false);
          expect(existsSync(join(workspaceDir, hooksDir, 'hooks.json'))).toBe(false);
        }
      },
    );

    it('omits a declaration before inspecting an excluded unsafe payload directory', async () => {
      await mkdir(join(pluginDir, 'hooks/unsafe'), { recursive: true });
      await writeFile(join(pluginDir, 'hooks/keep.sh'), 'echo keep');
      await writeFile(join(pluginDir, 'hooks/unsafe/run.sh'), 'echo initial');
      await manifest({ hooks: { SessionStart: [{ type: 'command', command: 'sh hooks/unsafe/run.sh' }] } });
      const components = resolvePluginComponents(pluginDir);
      const outside = join(testDir, 'outside-hooks');
      await mkdir(outside);
      await writeFile(join(outside, 'run.sh'), 'echo outside');
      await rm(join(pluginDir, 'hooks/unsafe'), { recursive: true });
      await symlink(outside, join(pluginDir, 'hooks/unsafe'), process.platform === 'win32' ? 'junction' : 'dir');
      const results = await copyHooks(pluginDir, workspaceDir, 'claude', {
        components, exclude: ['hooks/unsafe/**'],
      });
      expect(results.map((result) => result.action)).toEqual(['copied']);
      expect(await readFile(join(workspaceDir, '.claude/hooks/keep.sh'), 'utf-8')).toBe('echo keep');
      expect(existsSync(join(workspaceDir, '.claude/hooks/hooks.json'))).toBe(false);
      expect(existsSync(join(workspaceDir, '.claude/hooks/unsafe'))).toBe(false);
    });

    it('materializes inline hooks for file-supported clients and honors origin exclusions', async () => {
      await manifest({ hooks: { SessionStart: [{ type: 'command', command: 'echo safe' }] } });
      const [planned] = await copyHooks(pluginDir, workspaceDir, 'claude', { dryRun: true });
      expect(JSON.parse(planned?.content ?? '{}').hooks.SessionStart[0].command).toBe('echo safe');
      expect(existsSync(join(workspaceDir, '.claude/hooks/hooks.json'))).toBe(false);
      await copyHooks(pluginDir, workspaceDir, 'claude');
      const hooks = JSON.parse(await readFile(join(workspaceDir, '.claude/hooks/hooks.json'), 'utf-8'));
      expect(hooks.hooks.SessionStart[0].command).toBe('echo safe');
      expect(await copyHooks(pluginDir, workspaceDir, 'copilot')).toEqual([]);
      expect(await copyHooks(pluginDir, workspaceDir, 'omp', { exclude: ['.claude-plugin/plugin.json'] })).toEqual([]);
    });

    it('never copies repository-root siblings of a custom hook declaration', async () => {
      await writeFile(join(pluginDir, 'custom-hooks.json'), '{"hooks":{"SessionStart":[]}}');
      await writeFile(join(pluginDir, 'private.txt'), 'private');
      await manifest({ hooks: './custom-hooks.json' });
      await copyHooks(pluginDir, workspaceDir, 'claude');
      expect(existsSync(join(workspaceDir, '.claude/hooks/hooks.json'))).toBe(true);
      expect(existsSync(join(workspaceDir, '.claude/hooks/private.txt'))).toBe(false);
    });

    it('rechecks contained component sources after resolution', async () => {
      await mkdir(join(pluginDir, 'custom'), { recursive: true });
      await writeFile(join(pluginDir, 'custom/command.md'), '# Initial');
      await manifest({ commands: './custom/command.md' });
      const components = resolvePluginComponents(pluginDir);
      const outside = join(testDir, 'outside.md');
      await writeFile(outside, '# Outside');
      await rm(join(pluginDir, 'custom/command.md'));
      await symlink(outside, join(pluginDir, 'custom/command.md'));
      await expect(copyCommands(pluginDir, workspaceDir, 'claude', { components })).rejects.toThrow('escapes plugin root');
      expect(existsSync(join(workspaceDir, '.claude/commands/command.md'))).toBe(false);
    });
  });

  describe('github override precedence', () => {
    it('copies portable defaults and repository assistant resources from a manifest-bearing plugin', async () => {
      await mkdir(join(pluginDir, 'skills', 'public-skill'), { recursive: true });
      await writeFile(
        join(pluginDir, 'skills', 'public-skill', 'SKILL.md'),
        '---\nname: public-skill\n---\n',
      );
      await mkdir(join(pluginDir, 'hooks'), { recursive: true });
      await writeFile(join(pluginDir, 'hooks', 'portable.json'), '{"hooks":[]}');
      await mkdir(join(pluginDir, '.github', 'hooks'), { recursive: true });
      await writeFile(
        join(pluginDir, '.github', 'hooks', 'repository.json'),
        '{"hooks":[]}',
      );

      await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true });
      await writeFile(join(pluginDir, '.claude-plugin/plugin.json'),
        '{"name":"portable-and-github","version":"1.0.0"}');
      await copyPluginToWorkspace(pluginDir, workspaceDir, 'copilot');

      expect(
        existsSync(join(workspaceDir, '.github', 'skills', 'public-skill', 'SKILL.md')),
      ).toBe(true);
      expect(existsSync(join(workspaceDir, '.github', 'hooks', 'portable.json'))).toBe(true);
      expect(await readFile(join(workspaceDir, '.github', 'hooks', 'repository.json'), 'utf-8')).toBe('{"hooks":[]}');
    });

    it('.github/agents/ overrides root agents/ on name conflict', async () => {
      // Root agent
      await mkdir(join(pluginDir, 'agents'), { recursive: true });
      await writeFile(join(pluginDir, 'agents', 'conflict.agent.md'), 'ROOT VERSION');

      // .github override
      await mkdir(join(pluginDir, '.github', 'agents'), { recursive: true });
      await writeFile(join(pluginDir, '.github', 'agents', 'conflict.agent.md'), 'OVERRIDE VERSION');

      await copyPluginToWorkspace(pluginDir, workspaceDir, 'copilot');

      const content = await readFile(join(workspaceDir, '.github', 'agents', 'conflict.agent.md'), 'utf-8');
      expect(content).toBe('OVERRIDE VERSION');
    });

    it('.github/hooks/ overrides root hooks/ on name conflict', async () => {
      await mkdir(join(pluginDir, 'hooks'), { recursive: true });
      await writeFile(join(pluginDir, 'hooks', 'conflict.json'), '{"source":"root"}');

      await mkdir(join(pluginDir, '.github', 'hooks'), { recursive: true });
      await writeFile(join(pluginDir, '.github', 'hooks', 'conflict.json'), '{"source":"override"}');

      await copyPluginToWorkspace(pluginDir, workspaceDir, 'copilot');

      const content = await readFile(join(workspaceDir, '.github', 'hooks', 'conflict.json'), 'utf-8');
      expect(content).toBe('{"source":"override"}');
    });

    it.each(['project', 'user'] as const)('disables portable and repository hooks without dropping assistant artifacts in %s scope', async (scope) => {
      const artifacts = {
        'agents/reviewer.agent.md': '# Reviewer',
        '.github/agents/reviewer.agent.md': '# GitHub Reviewer',
        '.github/instructions/guide.instructions.md': '# Guide',
        '.github/prompts/review.prompt.md': '# Review',
        '.github/skills/review/SKILL.md': '# Skill',
        '.github/scripts/run.sh': 'echo run',
        '.github/tools/tool.json': '{"name":"tool"}',
        '.github/copilot-instructions.md': '# Copilot Instructions',
        'hooks/portable.sh': 'echo portable',
        'hooks/hooks.json': '{"hooks":{"SessionStart":[]}}',
        '.github/hooks/repository.json': '{"hooks":[]}',
      };
      for (const [path, content] of Object.entries(artifacts)) {
        const source = join(pluginDir, path);
        await mkdir(join(source, '..'), { recursive: true });
        await writeFile(source, content);
      }
      await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true });
      await writeFile(join(pluginDir, '.claude-plugin/plugin.json'),
        '{"name":"hooks-disabled","version":"1.0.0"}');
      const results = await copyPluginToWorkspace(pluginDir, workspaceDir, 'copilot', {
        hooks: false,
        ...(scope === 'user' && { clientMappings: USER_CLIENT_MAPPINGS }),
      });
      expect(results.some((result) => result.action === 'failed')).toBe(false);
      const destinationRoot = join(workspaceDir, scope === 'user' ? '.copilot' : '.github');
      expect(existsSync(join(destinationRoot, 'hooks'))).toBe(false);
      expect(await readFile(join(destinationRoot, 'agents/reviewer.agent.md'), 'utf-8')).toBe('# GitHub Reviewer');
      for (const [path, content] of Object.entries(artifacts)) {
        if (!path.startsWith('.github/') || path.startsWith('.github/hooks/')) continue;
        expect(await readFile(join(destinationRoot, path.slice('.github/'.length)), 'utf-8')).toBe(content);
      }
    });

    it('keeps raw repository hooks project-scoped while retaining portable user hooks', async () => {
      await mkdir(join(pluginDir, 'hooks'), { recursive: true });
      await mkdir(join(pluginDir, '.github/hooks'), { recursive: true });
      await writeFile(join(pluginDir, 'hooks/portable.sh'), 'echo portable');
      await writeFile(join(pluginDir, '.github/hooks/repository.json'), '{"version":1,"hooks":{}}');
      await copyPluginToWorkspace(pluginDir, workspaceDir, 'copilot', {
        clientMappings: USER_CLIENT_MAPPINGS,
      });
      expect(await readFile(join(workspaceDir, '.copilot/hooks/portable.sh'), 'utf-8')).toBe('echo portable');
      expect(existsSync(join(workspaceDir, '.copilot/hooks/repository.json'))).toBe(false);
    });

    it('merges root and .github when no conflict', async () => {
      // Root agent (unique name)
      await mkdir(join(pluginDir, 'agents'), { recursive: true });
      await writeFile(join(pluginDir, 'agents', 'root-only.agent.md'), '# Root Agent');

      // .github agent (different name)
      await mkdir(join(pluginDir, '.github', 'agents'), { recursive: true });
      await writeFile(join(pluginDir, '.github', 'agents', 'github-only.agent.md'), '# GitHub Agent');

      await copyPluginToWorkspace(pluginDir, workspaceDir, 'copilot');

      expect(existsSync(join(workspaceDir, '.github', 'agents', 'root-only.agent.md'))).toBe(true);
      expect(existsSync(join(workspaceDir, '.github', 'agents', 'github-only.agent.md'))).toBe(true);
    });
  });
});
