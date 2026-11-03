import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { syncWorkspace } from '../../src/core/sync.js';

// Exercise the real file installation and generated client configuration.
describe('marketplace component resolution', () => {
  let root: string;
  let plugin: string;
  let project: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'allagents-components-'));
    plugin = join(root, 'plugin');
    project = join(root, 'project');
    originalHome = process.env.ALLAGENTS_TEST_HOME;
    process.env.ALLAGENTS_TEST_HOME = join(root, 'home');
    await mkdir(join(plugin, '.github/plugin'), { recursive: true });
    await mkdir(join(project, '.allagents'), { recursive: true });
    await writeFile(join(project, '.allagents/workspace.yaml'), stringify({
      version: 2,
      repositories: [],
      plugins: [{ source: plugin, install: 'file' }],
      clients: ['copilot', 'claude', 'codex', 'vscode'],
      syncMode: 'copy',
    }));
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.ALLAGENTS_TEST_HOME;
    else process.env.ALLAGENTS_TEST_HOME = originalHome;
    await rm(root, { recursive: true, force: true });
  });

  it('installs an explicitly declared MCP file outside the conventional root location', async () => {
    await mkdir(join(plugin, 'config'), { recursive: true });
    await writeFile(join(plugin, '.github/plugin/marketplace.json'), JSON.stringify({
      name: 'components', owner: { name: 'Fixture' }, description: 'Components',
      plugins: [{ name: 'custom', description: 'Custom', source: './', strict: false,
        mcpServers: './config/servers.json' }],
    }));
    await writeFile(join(plugin, 'config/servers.json'), JSON.stringify({
      mcpServers: { custom: { type: 'http', url: 'http://127.0.0.1:9/custom' } },
    }));

    const result = await syncWorkspace(project);
    expect(result.success).toBe(true);
    for (const [path, key] of [
      ['.github/mcp.json', 'mcpServers'],
      ['.mcp.json', 'mcpServers'],
      ['.vscode/mcp.json', 'servers'],
    ] as const) {
      const config = JSON.parse(await readFile(join(project, path), 'utf-8'));
      expect(config[key].custom.url).toBe('http://127.0.0.1:9/custom');
    }
    const config = Bun.TOML.parse(await readFile(join(project, '.codex/config.toml'), 'utf-8')) as Record<string, unknown>;
    expect(config.mcp_servers).toEqual({ custom: { url: 'http://127.0.0.1:9/custom' } });
    expect(existsSync(join(project, '.github/plugin'))).toBe(false);
  });
  for (const declaration of ['../outside.json', './linked.json']) {
    it(`rejects an escaping MCP component source (${declaration}) before writing client config`, async () => {
      await writeFile(join(root, 'outside.json'), JSON.stringify({
        mcpServers: { escaped: { type: 'http', url: 'http://127.0.0.1:9/escaped' } },
      }));
      await symlink(join(root, 'outside.json'), join(plugin, 'linked.json'));
      await writeFile(join(plugin, '.github/plugin/marketplace.json'), JSON.stringify({
        name: 'components', owner: { name: 'Fixture' }, description: 'Components',
        plugins: [{ name: 'unsafe', description: 'Unsafe', source: './', strict: false,
          mcpServers: declaration }],
      }));
      const result = await syncWorkspace(project);
      expect(result.success).toBe(false);
      expect(existsSync(join(project, '.github/mcp.json'))).toBe(false);
      expect(existsSync(join(project, '.mcp.json'))).toBe(false);
      expect(existsSync(join(project, '.codex/config.toml'))).toBe(false);
      expect(existsSync(join(project, '.vscode/mcp.json'))).toBe(false);
    });
  }

  it('does not fall back from an invalid preferred marketplace to a valid Claude marketplace', async () => {
    await mkdir(join(plugin, '.claude-plugin'), { recursive: true });
    await writeFile(join(plugin, '.github/plugin/marketplace.json'), '{invalid');
    await writeFile(join(plugin, '.claude-plugin/marketplace.json'), JSON.stringify({
      name: 'components', owner: { name: 'Fixture' }, description: 'Components',
      plugins: [{ name: 'fallback', description: 'Fallback', source: './' }],
    }));
    await writeFile(join(plugin, '.mcp.json'), JSON.stringify({
      mcpServers: { fallback: { type: 'http', url: 'http://127.0.0.1:9/fallback' } },
    }));
    const result = await syncWorkspace(project);
    expect(result.success).toBe(false);
    expect(existsSync(join(project, '.github/mcp.json'))).toBe(false);
  });
  it('uses plugin manifest custom files instead of conventional skill command and agent sources', async () => {
    for (const directory of ['skills/default', 'commands', 'agents', 'custom/skill']) {
      await mkdir(join(plugin, directory), { recursive: true });
    }
    await writeFile(join(plugin, 'skills/default/SKILL.md'), '---\nname: default\ndescription: Default\n---\nDefault.\n');
    await writeFile(join(plugin, 'commands/default.md'), 'Default command.\n');
    await writeFile(join(plugin, 'agents/default.agent.md'), '---\nname: default\ndescription: Default\n---\nDefault agent.\n');
    await writeFile(join(plugin, 'custom/skill/SKILL.md'), '---\nname: selected\ndescription: Selected\n---\nSelected skill.\n');
    await writeFile(join(plugin, 'custom/selected.md'), 'Selected command.\n');
    await writeFile(join(plugin, 'custom/selected.agent.md'), '---\nname: selected\ndescription: Selected\n---\nSelected agent.\n');
    await writeFile(join(plugin, '.github/plugin/marketplace.json'), JSON.stringify({
      name: 'components', owner: { name: 'Fixture' }, description: 'Components',
      plugins: [{ name: 'selected', description: 'Selected', source: './', strict: false,
        skills: './skills', commands: './commands', agents: './agents' }],
    }));
    await writeFile(join(plugin, '.github/plugin/plugin.json'), JSON.stringify({
      name: 'selected', skills: './custom/skill', commands: './custom/selected.md',
      agents: './custom/selected.agent.md',
    }));

    const result = await syncWorkspace(project);
    expect(result.success).toBe(true);
    expect(await readFile(join(project, '.github/skills/skill/SKILL.md'), 'utf-8')).toContain('Selected skill.');
    expect(await readFile(join(project, '.claude/commands/selected.md'), 'utf-8')).toBe('Selected command.\n');
    expect(await readFile(join(project, '.github/agents/selected.agent.md'), 'utf-8')).toContain('Selected agent.');
    expect(existsSync(join(project, '.github/skills/default'))).toBe(false);
    expect(existsSync(join(project, '.claude/commands/default.md'))).toBe(false);
    expect(existsSync(join(project, '.github/agents/default.agent.md'))).toBe(false);
  });

  for (const strict of [false, undefined, true]) {
    it(`discovers components and preserves assistant GitHub content without workflows (strict=${strict})`, async () => {
      await mkdir(join(plugin, 'skills/default'), { recursive: true });
      await mkdir(join(plugin, 'commands'), { recursive: true });
      await mkdir(join(plugin, 'agents'), { recursive: true });
      await mkdir(join(plugin, '.github/hooks'), { recursive: true });
      await writeFile(join(plugin, 'skills/default/SKILL.md'), '---\nname: default\ndescription: Default\n---\nDefault skill.\n');
      await writeFile(join(plugin, 'commands/default.md'), 'Default command.\n');
      await writeFile(join(plugin, 'agents/default.agent.md'), '---\nname: default\ndescription: Default\n---\nDefault agent.\n');
      await writeFile(join(plugin, '.github/hooks/dev.json'), '{"version":1,"hooks":{}}');
      await writeFile(join(plugin, '.github/copilot-instructions.md'), 'Repository-wide assistant instructions.');
      await mkdir(join(plugin, '.github/workflows'), { recursive: true });
      await writeFile(join(plugin, '.github/workflows/ci.yml'), 'name: Build\n');
      await writeFile(join(plugin, '.github/plugin/marketplace.json'), JSON.stringify({
        name: 'components', owner: { name: 'Fixture' }, description: 'Components',
        plugins: [{ name: 'default', description: 'Default', source: './', strict }],
      }));

      const result = await syncWorkspace(project);
      expect(result.success).toBe(true);
      expect(await readFile(join(project, '.github/skills/default/SKILL.md'), 'utf-8')).toContain('Default skill.');
      expect(await readFile(join(project, '.claude/commands/default.md'), 'utf-8')).toBe('Default command.\n');
      expect(await readFile(join(project, '.github/agents/default.agent.md'), 'utf-8')).toContain('Default agent.');
      expect(await readFile(join(project, '.github/hooks/dev.json'), 'utf-8')).toBe('{"version":1,"hooks":{}}');
      expect(await readFile(join(project, '.github/copilot-instructions.md'), 'utf-8')).toBe('Repository-wide assistant instructions.');
      expect(existsSync(join(project, '.github/workflows'))).toBe(false);
      expect(existsSync(join(project, '.github/plugin'))).toBe(false);
    });
  }
  it('preserves installed GitHub agents instructions prompts and supporting assets when manifests are added', async () => {
    const assets = {
      'agents/reviewer.agent.md': '---\nname: reviewer\ndescription: Copilot reviewer\n---\nReview the change.\n',
      'instructions/repository.instructions.md': '---\napplyTo: "**"\n---\nRepository instructions.\n',
      'prompts/review.prompt.md': 'Review this change with the repository instructions.\n',
      'scripts/helper.ps1': 'Write-Output "Helper"\n',
      'tools/helper/config.json': '{"enabled":true}\n',
      'copilot-instructions.md': 'Repository-wide instructions.\n',
    };
    for (const [path, content] of Object.entries(assets)) {
      await mkdir(join(plugin, '.github', path, '..'), { recursive: true });
      await writeFile(join(plugin, '.github', path), content);
    }
    expect((await syncWorkspace(project)).success).toBe(true);
    await writeFile(join(plugin, '.github/plugin/plugin.json'), JSON.stringify({ name: 'assistant' }));
    await writeFile(join(plugin, '.github/plugin/marketplace.json'), JSON.stringify({
      name: 'components', owner: { name: 'Fixture' }, plugins: [{ name: 'assistant', description: 'Assistant', source: './', strict: false }],
    }));
    expect((await syncWorkspace(project)).success).toBe(true);
    for (const [path, content] of Object.entries(assets)) {
      expect(await readFile(join(project, '.github', path), 'utf-8')).toBe(content);
    }
    expect(existsSync(join(project, '.github/plugin'))).toBe(false);
  });

  it('disables raw GitHub hooks independently of assistant instructions', async () => {
    await mkdir(join(plugin, '.github/hooks'), { recursive: true });
    await writeFile(join(plugin, '.github/hooks/assistant.json'), '{"version":1,"hooks":{"sessionStart":[]}}');
    await writeFile(join(plugin, '.github/copilot-instructions.md'), 'Keep these instructions.\n');
    await writeFile(join(plugin, '.github/plugin/plugin.json'), JSON.stringify({ name: 'assistant' }));
    expect((await syncWorkspace(project)).success).toBe(true);
    expect(existsSync(join(project, '.github/hooks/assistant.json'))).toBe(true);
    await writeFile(join(project, '.allagents/workspace.yaml'), stringify({
      version: 2, repositories: [], clients: ['copilot'], plugins: [{ source: plugin, install: 'file', hooks: false }],
    }));
    expect((await syncWorkspace(project)).success).toBe(true);
    expect(existsSync(join(project, '.github/hooks/assistant.json'))).toBe(false);
    expect(await readFile(join(project, '.github/copilot-instructions.md'), 'utf-8')).toBe('Keep these instructions.\n');
  });

  it('updates and removes declared components while preserving personal MCP configuration', async () => {
    await mkdir(join(plugin, 'custom/kept'), { recursive: true });
    await mkdir(join(plugin, 'custom/excluded'), { recursive: true });
    await writeFile(join(plugin, 'custom/kept/SKILL.md'), '---\nname: kept\ndescription: Kept\n---\nKept.\n');
    await writeFile(join(plugin, 'custom/excluded/SKILL.md'), '---\nname: excluded\ndescription: Excluded\n---\nExcluded.\n');
    await writeFile(join(plugin, '.github/plugin/marketplace.json'), JSON.stringify({
      name: 'components', owner: { name: 'Fixture' }, description: 'Components',
      plugins: [{ name: 'lifecycle', description: 'Lifecycle', source: './', strict: false }],
    }));
    const manifestPath = join(plugin, '.github/plugin/plugin.json');
    const declaration = {
      name: 'lifecycle', skills: './custom',
      mcpServers: {
        owned: { type: 'http', url: 'http://127.0.0.1:9/old' },
        excluded: { type: 'http', url: 'http://127.0.0.1:9/excluded' },
      },
    };
    await writeFile(manifestPath, JSON.stringify(declaration));
    const workspacePath = join(project, '.allagents/workspace.yaml');
    await writeFile(workspacePath, stringify({
      version: 2, repositories: [], clients: ['claude', 'copilot', 'codex', 'vscode'], syncMode: 'copy',
      plugins: [{ source: plugin, install: 'file', exclude: ['custom/excluded/**'],
        mcpServers: { exclude: ['excluded'] } }],
    }));
    const configPath = join(project, '.mcp.json');
    await writeFile(configPath, JSON.stringify({ mcpServers: {
      personal: { type: 'http', url: 'http://127.0.0.1:9/personal' },
    } }));
    expect((await syncWorkspace(project)).success).toBe(true);
    expect(existsSync(join(project, '.github/skills/kept/SKILL.md'))).toBe(true);
    expect(existsSync(join(project, '.github/skills/excluded/SKILL.md'))).toBe(false);
    expect(JSON.parse(await readFile(configPath, 'utf-8')).mcpServers).toEqual({
      personal: { type: 'http', url: 'http://127.0.0.1:9/personal' },
      owned: { type: 'http', url: 'http://127.0.0.1:9/old' },
    });
    declaration.mcpServers.owned.url = 'http://127.0.0.1:9/new';
    await writeFile(manifestPath, JSON.stringify(declaration));
    expect((await syncWorkspace(project)).success).toBe(true);
    expect(JSON.parse(await readFile(configPath, 'utf-8')).mcpServers.owned.url).toBe('http://127.0.0.1:9/new');

    await writeFile(workspacePath, stringify({
      version: 2, repositories: [], plugins: [], clients: ['claude', 'copilot', 'codex', 'vscode'], syncMode: 'copy',
    }));
    expect((await syncWorkspace(project)).success).toBe(true);
    expect(existsSync(join(project, '.github/skills/kept/SKILL.md'))).toBe(false);
    expect(JSON.parse(await readFile(configPath, 'utf-8')).mcpServers).toEqual({
      personal: { type: 'http', url: 'http://127.0.0.1:9/personal' },
    });
  });

  it('retains installed components and tracking when a component source becomes unsafe', async () => {
    await mkdir(join(plugin, 'config'), { recursive: true });
    const marketplacePath = join(plugin, '.github/plugin/marketplace.json');
    const marketplace = {
      name: 'components', owner: { name: 'Fixture' }, description: 'Components',
      plugins: [{ name: 'safe', description: 'Safe', source: './', strict: false,
        mcpServers: './config/servers.json' }],
    };
    await writeFile(marketplacePath, JSON.stringify(marketplace));
    await writeFile(join(plugin, 'config/servers.json'), JSON.stringify({
      mcpServers: { retained: { type: 'http', url: 'http://127.0.0.1:9/retained' } },
    }));
    expect((await syncWorkspace(project)).success).toBe(true);
    const configPath = join(project, '.mcp.json');
    const originalConfig = await readFile(configPath, 'utf-8');
    const statePath = join(project, '.allagents/sync-state.json');
    const originalTracking = JSON.parse(await readFile(statePath, 'utf-8')).mcpServers;
    marketplace.plugins[0]!.mcpServers = '../escaped.json';
    await writeFile(marketplacePath, JSON.stringify(marketplace));
    expect((await syncWorkspace(project)).success).toBe(false);
    expect(await readFile(configPath, 'utf-8')).toBe(originalConfig);
    expect(JSON.parse(await readFile(statePath, 'utf-8')).mcpServers).toEqual(originalTracking);
  });
  it('can disable inline hooks independently of MCP and preserves personal hooks on update', async () => {
    await writeFile(join(plugin, '.github/plugin/marketplace.json'), JSON.stringify({
      name: 'components', owner: { name: 'Fixture' }, description: 'Components',
      plugins: [{ name: 'inline', description: 'Inline', source: './', strict: false }],
    }));
    await writeFile(join(plugin, '.github/plugin/plugin.json'), JSON.stringify({
      name: 'inline',
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo inline-fixture' }] }] },
      mcpServers: { inline: { type: 'http', url: 'http://127.0.0.1:9/inline' } },
    }));
    await mkdir(join(project, '.codex'), { recursive: true });
    const hooksPath = join(project, '.codex/hooks.json');
    const personal = { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo personal' }] }] };
    await writeFile(hooksPath, JSON.stringify({ hooks: personal }));
    expect((await syncWorkspace(project)).success).toBe(true);
    const generated = JSON.parse(await readFile(hooksPath, 'utf-8'));
    expect(generated.hooks.SessionStart[0].hooks[0].command).toBe('echo inline-fixture');
    expect(generated.hooks.UserPromptSubmit).toEqual(personal.UserPromptSubmit);

    await writeFile(join(project, '.allagents/workspace.yaml'), stringify({
      version: 2, repositories: [], clients: ['claude', 'copilot', 'codex', 'vscode'], syncMode: 'copy',
      plugins: [{ source: plugin, install: 'file', hooks: false }],
    }));
    expect((await syncWorkspace(project)).success).toBe(true);
    expect(JSON.parse(await readFile(hooksPath, 'utf-8')).hooks).toEqual(personal);
    expect(JSON.parse(await readFile(join(project, '.mcp.json'), 'utf-8')).mcpServers.inline.url)
      .toBe('http://127.0.0.1:9/inline');
  });

  it('prefers conventional MCP files over manifest and entry declarations', async () => {
    await writeFile(join(plugin, '.github/plugin/marketplace.json'), JSON.stringify({
      name: 'components', owner: { name: 'Fixture' }, description: 'Components',
      plugins: [{ name: 'precedence', description: 'Precedence', source: './', strict: false,
        mcpServers: { entry: { type: 'http', url: 'http://127.0.0.1:9/entry' } } }],
    }));
    await writeFile(join(plugin, '.github/plugin/plugin.json'), JSON.stringify({
      name: 'precedence', mcpServers: { manifest: { type: 'http', url: 'http://127.0.0.1:9/manifest' } },
    }));
    await writeFile(join(plugin, '.github/mcp.json'), JSON.stringify({
      mcpServers: { github: { type: 'http', url: 'http://127.0.0.1:9/github' } },
    }));
    expect((await syncWorkspace(project)).success).toBe(true);
    const configPath = join(project, '.mcp.json');
    expect(JSON.parse(await readFile(configPath, 'utf-8')).mcpServers).toEqual({
      github: { type: 'http', url: 'http://127.0.0.1:9/github' },
    });
    await writeFile(join(plugin, '.mcp.json'), JSON.stringify({
      mcpServers: { root: { type: 'http', url: 'http://127.0.0.1:9/root' } },
    }));
    expect((await syncWorkspace(project)).success).toBe(true);
    expect(JSON.parse(await readFile(configPath, 'utf-8')).mcpServers).toEqual({
      root: { type: 'http', url: 'http://127.0.0.1:9/root' },
    });
  });
  it('uses the preferred legacy plugin manifest and honors an empty component array', async () => {
    await mkdir(join(plugin, '.plugin'), { recursive: true });
    await mkdir(join(plugin, 'custom'), { recursive: true });
    await mkdir(join(plugin, 'skills/default'), { recursive: true });
    await writeFile(join(plugin, 'skills/default/SKILL.md'), '---\nname: default\ndescription: Default\n---\nDefault.\n');
    await writeFile(join(plugin, 'custom/preferred.md'), 'Preferred command.\n');
    await writeFile(join(plugin, 'custom/root.md'), 'Root command.\n');
    await writeFile(join(plugin, '.github/plugin/marketplace.json'), JSON.stringify({
      name: 'components', owner: { name: 'Fixture' }, description: 'Components',
      plugins: [{ name: 'priority', description: 'Priority', source: './', strict: true }],
    }));
    await writeFile(join(plugin, 'plugin.json'), JSON.stringify({
      name: 'priority', commands: './custom/root.md',
    }));
    await writeFile(join(plugin, '.plugin/plugin.json'), JSON.stringify({
      name: 'priority', skills: [], commands: './custom/preferred.md',
    }));
    expect((await syncWorkspace(project)).success).toBe(true);
    expect(await readFile(join(project, '.claude/commands/preferred.md'), 'utf-8')).toBe('Preferred command.\n');
    expect(existsSync(join(project, '.claude/commands/root.md'))).toBe(false);
    expect(existsSync(join(project, '.github/skills/default/SKILL.md'))).toBe(false);
  });
  it('does not copy a lower-priority raw GitHub MCP file over personal project servers', async () => {
    await writeFile(join(plugin, '.github/mcp.json'), JSON.stringify({
      mcpServers: { ignored: { type: 'http', url: 'http://127.0.0.1:9/ignored' } },
    }));
    await writeFile(join(plugin, '.mcp.json'), JSON.stringify({
      mcpServers: { owned: { type: 'http', url: 'http://127.0.0.1:9/owned' } },
    }));
    await mkdir(join(project, '.github'), { recursive: true });
    const configPath = join(project, '.github/mcp.json');
    await writeFile(configPath, JSON.stringify({ mcpServers: {
      personal: { type: 'http', url: 'http://127.0.0.1:9/personal' },
    } }));
    expect((await syncWorkspace(project)).success).toBe(true);
    expect(JSON.parse(await readFile(configPath, 'utf-8')).mcpServers).toEqual({
      personal: { type: 'http', url: 'http://127.0.0.1:9/personal' },
      owned: { type: 'http', url: 'http://127.0.0.1:9/owned' },
    });
    await writeFile(join(project, '.allagents/workspace.yaml'), stringify({
      version: 2, repositories: [], plugins: [], clients: ['copilot', 'claude', 'codex', 'vscode'],
    }));
    expect((await syncWorkspace(project)).success).toBe(true);
    expect(JSON.parse(await readFile(configPath, 'utf-8')).mcpServers).toEqual({
      personal: { type: 'http', url: 'http://127.0.0.1:9/personal' },
    });
  });
});
