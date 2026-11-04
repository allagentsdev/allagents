import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { copyGitHubContent } from '../../../src/core/transform.js';
import { resolvePluginComponents } from '../../../src/core/plugin-components.js';
import { USER_CLIENT_MAPPINGS } from '../../../src/models/client-mapping.js';

describe('copyGitHubContent', () => {
  let testDir: string;
  let pluginDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-github-test-'));
    pluginDir = join(testDir, 'plugin');
    workspaceDir = join(testDir, 'workspace');
    await mkdir(pluginDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('copies GitHub assistant content for copilot', async () => {
    // Setup: Create .github folder with prompts in plugin
    await mkdir(join(pluginDir, '.github', 'prompts'), { recursive: true });
    await writeFile(join(pluginDir, '.github', 'prompts', 'test.md'), '# Test Prompt');
    await writeFile(join(pluginDir, '.github', 'copilot-instructions.md'), '# Copilot Instructions');

    await copyGitHubContent(pluginDir, workspaceDir, 'copilot');

    expect(existsSync(join(workspaceDir, '.github', 'prompts', 'test.md'))).toBe(true);
    expect(await readFile(join(workspaceDir, '.github', 'copilot-instructions.md'), 'utf-8')).toBe('# Copilot Instructions');

    const content = await readFile(join(workspaceDir, '.github', 'prompts', 'test.md'), 'utf-8');
    expect(content).toBe('# Test Prompt');
  });

  for (const preferRoot of [false, true]) {
    it(`preserves user MCP configuration during raw overlays${preferRoot ? ' with root MCP precedence' : ''}`, async () => {
      await mkdir(join(pluginDir, '.github/prompts'), { recursive: true });
      await writeFile(join(pluginDir, '.github/mcp.json'), JSON.stringify({
        mcpServers: { plugin_server: { command: 'plugin-command' } },
      }));
      await writeFile(join(pluginDir, '.github/prompts/keep.md'), '# Keep');
      if (preferRoot) {
        await writeFile(join(pluginDir, '.mcp.json'), JSON.stringify({
          mcpServers: { preferred_server: { command: 'preferred-command' } },
        }));
      }
      await mkdir(join(workspaceDir, '.github'), { recursive: true });
      const userConfig = JSON.stringify({
        servers: { user_server: { command: 'user-command' } },
      });
      await writeFile(join(workspaceDir, '.github/mcp.json'), userConfig);
      const results = await copyGitHubContent(pluginDir, workspaceDir, 'copilot');
      expect(results.every((result) => result.action === 'copied')).toBe(true);
      expect(await readFile(join(workspaceDir, '.github/mcp.json'), 'utf-8')).toBe(userConfig);
      expect(await readFile(join(workspaceDir, '.github/prompts/keep.md'), 'utf-8')).toBe('# Keep');

      await rm(join(workspaceDir, '.github/mcp.json'));
      await copyGitHubContent(pluginDir, workspaceDir, 'copilot');
      expect(existsSync(join(workspaceDir, '.github/mcp.json'))).toBe(false);
    });
  }

  it('copies .github/agents/ for copilot client', async () => {
    await mkdir(join(pluginDir, '.github', 'agents'), { recursive: true });
    await writeFile(join(pluginDir, '.github', 'agents', 'reviewer.agent.md'), '# Reviewer');
    await mkdir(join(pluginDir, '.github', 'agents', 'support'), {
      recursive: true,
    });
    await writeFile(
      join(pluginDir, '.github', 'agents', 'support', 'schema.json'),
      '{"type":"object"}',
    );

    const results = await copyGitHubContent(pluginDir, workspaceDir, 'copilot');

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.action === 'copied')).toBe(true);
    expect(existsSync(join(workspaceDir, '.github', 'agents', 'reviewer.agent.md'))).toBe(true);
    expect(
      existsSync(
        join(
          workspaceDir,
          '.github',
          'agents',
          'support',
          'schema.json',
        ),
      ),
    ).toBe(true);

    const content = await readFile(join(workspaceDir, '.github', 'agents', 'reviewer.agent.md'), 'utf-8');
    expect(content).toBe('# Reviewer');
  });

  it('does not let dot-prefixed agent definitions bypass an ownership plan', async () => {
    await mkdir(join(pluginDir, '.github', 'agents'), { recursive: true });
    await writeFile(
      join(pluginDir, '.github', 'agents', '.reviewer.agent.md'),
      '# Reviewer',
    );

    const results = await copyGitHubContent(
      pluginDir,
      workspaceDir,
      'copilot',
      { agentOutputs: [] },
    );

    expect(results).toEqual([]);
    expect(
      existsSync(
        join(
          workspaceDir,
          '.github',
          'agents',
          '.reviewer.agent.md',
        ),
      ),
    ).toBe(false);
  });

  it('preserves native Copilot hook schema in project GitHub content', async () => {
    await mkdir(join(pluginDir, '.github', 'hooks'), { recursive: true });
    const nativeHooks = '{"version":1,"hooks":{"sessionStart":[{"type":"command","bash":"echo safe"}]}}';
    await writeFile(join(pluginDir, '.github', 'hooks', 'safety.json'), nativeHooks);

    const results = await copyGitHubContent(pluginDir, workspaceDir, 'copilot');

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('copied');
    expect(existsSync(join(workspaceDir, '.github', 'hooks', 'safety.json'))).toBe(true);

    const content = await readFile(join(workspaceDir, '.github', 'hooks', 'safety.json'), 'utf-8');
    expect(content).toBe(nativeHooks);
  });

  it('does not inspect disabled raw GitHub hooks while copying other assistant content', async () => {
    await mkdir(join(pluginDir, '.github/hooks'), { recursive: true });
    await mkdir(join(pluginDir, '.github/prompts'), { recursive: true });
    await writeFile(join(pluginDir, '.github/hooks/repository.json'), '{"version":1,"hooks":{}}');
    await writeFile(join(pluginDir, '.github/prompts/review.md'), '# Review');
    const components = resolvePluginComponents(pluginDir);
    const outside = join(testDir, 'outside-hooks');
    await mkdir(outside);
    await writeFile(join(outside, 'private.json'), '{"private":true}');
    await rm(join(pluginDir, '.github/hooks'), { recursive: true });
    await symlink(outside, join(pluginDir, '.github/hooks'),
      process.platform === 'win32' ? 'junction' : 'dir');
    const results = await copyGitHubContent(pluginDir, workspaceDir, 'copilot', {
      components,
      hooks: false,
    });
    expect(results.some((result) => result.action === 'failed')).toBe(false);
    expect(await readFile(join(workspaceDir, '.github/prompts/review.md'), 'utf-8')).toBe('# Review');
    expect(existsSync(join(workspaceDir, '.github/hooks'))).toBe(false);
  });

  it('copies assistant prompts but not package metadata from manifest-bearing plugins', async () => {
    await mkdir(join(pluginDir, '.github', 'plugin'), { recursive: true });
    await mkdir(join(pluginDir, '.github', 'prompts'), { recursive: true });
    await writeFile(
      join(pluginDir, '.github', 'plugin', 'plugin.json'),
      '{"name":"package-only"}',
    );
    await writeFile(join(pluginDir, '.github', 'prompts', 'keep.md'), '# Keep');

    const results = await copyGitHubContent(pluginDir, workspaceDir, 'copilot');

    expect(results.every((result) => result.action === 'copied')).toBe(true);
    expect(
      existsSync(join(workspaceDir, '.github', 'plugin', 'plugin.json')),
    ).toBe(false);
    expect(await readFile(join(workspaceDir, '.github', 'prompts', 'keep.md'), 'utf-8')).toBe('# Keep');
  });

  for (const scope of ['project', 'user'] as const) {
    it(`preserves supported assistant roots and excludes repository configuration in ${scope} scope`, async () => {
      const artifacts = {
        'agents/reviewer.agent.md': '# Reviewer',
        'agents/support/schema.json': '{"type":"object"}',
        'instructions/guide.instructions.md': '# Guide',
        'prompts/review.prompt.md': '# Review',
        'skills/review/SKILL.md': '# Skill',
        'scripts/run.sh': 'echo run',
        'tools/tool.json': '{"name":"tool"}',
        'copilot-instructions.md': '# Copilot Instructions',
      };
      const rejected = {
        'workflows/ci.yml': 'name: CI',
        'plugin/plugin.json': '{"name":"assistant-config"}',
        'plugin/marketplace.json': '{"plugins":[]}',
        'ISSUE_TEMPLATE/bug.md': '# Bug Report',
        'dependabot.yml': 'version: 2',
        'CODEOWNERS': '* @owner',
        'marketplace.json': '{"plugins":[]}',
        'mcp.json': '{"mcpServers":{}}',
      };
      for (const [path, content] of Object.entries({ ...artifacts, ...rejected })) {
        const source = join(pluginDir, '.github', path);
        await mkdir(join(source, '..'), { recursive: true });
        await writeFile(source, content);
      }
      const results = await copyGitHubContent(pluginDir, workspaceDir, 'copilot', {
        ...(scope === 'user' && { clientMappings: USER_CLIENT_MAPPINGS }),
      });
      expect(results.some((result) => result.action === 'failed')).toBe(false);
      const destinationRoot = join(workspaceDir, scope === 'user' ? '.copilot' : '.github');
      for (const [path, content] of Object.entries(artifacts)) {
        expect(await readFile(join(destinationRoot, path), 'utf-8')).toBe(content);
      }
      for (const path of Object.keys(rejected)) {
        expect(existsSync(join(destinationRoot, path))).toBe(false);
      }
    });

    it(`does not inspect rejected or excluded GitHub symlink roots in ${scope} scope`, async () => {
      await mkdir(join(pluginDir, '.github/prompts'), { recursive: true });
      await writeFile(join(pluginDir, '.github/prompts/keep.md'), '# Keep');
      const outside = join(testDir, 'outside');
      await mkdir(outside);
      await writeFile(join(outside, 'private.md'), '# Private');
      for (const root of ['workflows', 'ISSUE_TEMPLATE', 'tools']) {
        await symlink(outside, join(pluginDir, '.github', root),
          process.platform === 'win32' ? 'junction' : 'dir');
      }
      for (const root of ['dependabot.yml', 'marketplace.json']) {
        await symlink(join(outside, 'private.md'), join(pluginDir, '.github', root));
      }
      const results = await copyGitHubContent(pluginDir, workspaceDir, 'copilot', {
        exclude: ['.github/tools/**'],
        ...(scope === 'user' && { clientMappings: USER_CLIENT_MAPPINGS }),
      });
      expect(results.some((result) => result.action === 'failed')).toBe(false);
      const destinationRoot = join(workspaceDir, scope === 'user' ? '.copilot' : '.github');
      expect(await readFile(join(destinationRoot, 'prompts/keep.md'), 'utf-8')).toBe('# Keep');
      for (const root of ['workflows', 'plugin', 'ISSUE_TEMPLATE', 'tools', 'dependabot.yml', 'marketplace.json']) {
        expect(existsSync(join(destinationRoot, root))).toBe(false);
      }
    });
  }

  it.each(['root', 'file'] as const)('rechecks the containment of a changed GitHub %s source', async (sourceKind) => {
    await mkdir(join(pluginDir, '.github/prompts'), { recursive: true });
    await writeFile(join(pluginDir, '.github/prompts/review.md'), '# Initial');
    const components = resolvePluginComponents(pluginDir);
    const outside = join(testDir, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'review.md'), '# Private');
    const source = join(pluginDir, '.github/prompts', sourceKind === 'file' ? 'review.md' : '');
    await rm(source, { recursive: true });
    await symlink(sourceKind === 'file' ? join(outside, 'review.md') : outside, source,
      sourceKind === 'root' && process.platform === 'win32' ? 'junction' : sourceKind === 'root' ? 'dir' : 'file');
    const results = await copyGitHubContent(pluginDir, workspaceDir, 'copilot', { components });
    expect(results.some((result) => result.action === 'failed' && result.error?.includes('escapes plugin root'))).toBe(true);
    expect(existsSync(join(workspaceDir, '.github/prompts/review.md'))).toBe(false);
  });

  it('skips clients without githubPath', async () => {
    await mkdir(join(pluginDir, '.github', 'prompts'), { recursive: true });
    await writeFile(join(pluginDir, '.github', 'prompts', 'test.md'), '# Test');

    // Claude doesn't have githubPath, so should skip
    const results = await copyGitHubContent(pluginDir, workspaceDir, 'claude');

    expect(results).toHaveLength(0);
    expect(existsSync(join(workspaceDir, '.github'))).toBe(false);
  });

  it('returns empty when plugin has no .github folder', async () => {
    const results = await copyGitHubContent(pluginDir, workspaceDir, 'copilot');

    expect(results).toHaveLength(0);
  });

  it('supports dry run mode', async () => {
    await mkdir(join(pluginDir, '.github', 'prompts'), { recursive: true });
    await writeFile(join(pluginDir, '.github', 'prompts', 'test.md'), '# Test');

    const results = await copyGitHubContent(pluginDir, workspaceDir, 'copilot', { dryRun: true });

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('copied');
    // Should not actually copy in dry run
    expect(existsSync(join(workspaceDir, '.github'))).toBe(false);
  });

  it('adjusts relative links to skills in markdown files', async () => {
    // Setup: Create .github/instructions/cargowise.instructions.md with skill references
    await mkdir(join(pluginDir, '.github', 'instructions'), { recursive: true });
    const originalContent = `# Cargowise Instructions

See #file:../../skills/cw-coding/SKILL.md for coding guidelines.

Also check [API Guide](../../skills/cw-api/README.md).
`;
    await writeFile(join(pluginDir, '.github', 'instructions', 'cargowise.instructions.md'), originalContent);

    const results = await copyGitHubContent(pluginDir, workspaceDir, 'copilot');

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('copied');

    const copiedContent = await readFile(
      join(workspaceDir, '.github', 'instructions', 'cargowise.instructions.md'),
      'utf-8',
    );

    // Links should be adjusted to workspace skills path (.github/skills/)
    expect(copiedContent).toContain('#file:../../.github/skills/cw-coding/SKILL.md');
    expect(copiedContent).toContain('[API Guide](../../.github/skills/cw-api/README.md)');
  });

  it('adjusts links using skill name map for renamed skills', async () => {
    await mkdir(join(pluginDir, '.github', 'instructions'), { recursive: true });
    const originalContent = `See #file:../../skills/my-skill/SKILL.md`;
    await writeFile(join(pluginDir, '.github', 'instructions', 'file.md'), originalContent);

    const skillNameMap = new Map([['my-skill', 'plugin-name:my-skill']]);
    const results = await copyGitHubContent(pluginDir, workspaceDir, 'copilot', { skillNameMap });

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('copied');

    const copiedContent = await readFile(join(workspaceDir, '.github', 'instructions', 'file.md'), 'utf-8');
    expect(copiedContent).toContain('#file:../../.github/skills/plugin-name:my-skill/SKILL.md');
  });

  it('excludes files matching exclude patterns', async () => {
    await mkdir(join(pluginDir, '.github', 'instructions'), { recursive: true });
    await writeFile(
      join(pluginDir, '.github', 'instructions', 'skills.instructions.md'),
      '# Generated - should be excluded',
    );
    await writeFile(
      join(pluginDir, '.github', 'instructions', 'coding.instructions.md'),
      '# Coding guide - should be copied',
    );

    const results = await copyGitHubContent(pluginDir, workspaceDir, 'copilot', {
      exclude: ['.github/instructions/skills.instructions.md'],
    });

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('copied');
    expect(existsSync(join(workspaceDir, '.github', 'instructions', 'skills.instructions.md'))).toBe(false);
    expect(existsSync(join(workspaceDir, '.github', 'instructions', 'coding.instructions.md'))).toBe(true);
  });

  it('supports glob patterns in exclude', async () => {
    await mkdir(join(pluginDir, '.github', 'instructions'), { recursive: true });
    await writeFile(join(pluginDir, '.github', 'instructions', 'a.md'), '# A');
    await writeFile(join(pluginDir, '.github', 'instructions', 'b.md'), '# B');
    await mkdir(join(pluginDir, '.github', 'prompts'), { recursive: true });
    await writeFile(join(pluginDir, '.github', 'prompts', 'keep.md'), '# Keep');

    const results = await copyGitHubContent(pluginDir, workspaceDir, 'copilot', {
      exclude: ['.github/instructions/**'],
    });

    expect(results).toHaveLength(1);
    expect(results[0].action).toBe('copied');
    expect(existsSync(join(workspaceDir, '.github', 'instructions'))).toBe(false);
    expect(existsSync(join(workspaceDir, '.github', 'prompts', 'keep.md'))).toBe(true);
  });

  it('preserves non-skill links and external URLs', async () => {
    await mkdir(join(pluginDir, '.github', 'instructions'), { recursive: true });
    const originalContent = `# Instructions

See [GitHub](https://github.com) for more info.
Local link: [Setup](#setup)
Relative to .github: [Other](../prompts/other.md)
`;
    await writeFile(join(pluginDir, '.github', 'instructions', 'file.md'), originalContent);

    await copyGitHubContent(pluginDir, workspaceDir, 'copilot');

    const copiedContent = await readFile(join(workspaceDir, '.github', 'instructions', 'file.md'), 'utf-8');

    // External URLs unchanged
    expect(copiedContent).toContain('[GitHub](https://github.com)');
    // Anchor links unchanged
    expect(copiedContent).toContain('[Setup](#setup)');
    // Links within .github unchanged
    expect(copiedContent).toContain('[Other](../prompts/other.md)');
  });
});
