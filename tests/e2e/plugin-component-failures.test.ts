import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import { syncWorkspace } from '../../src/core/sync.js';

const personalUrl = 'http://127.0.0.1:9/personal';
const ownedUrl = 'http://127.0.0.1:9/owned';
const jsonConfigs = [
  ['.github/mcp.json', 'mcpServers'],
  ['.mcp.json', 'mcpServers'],
  ['.vscode/mcp.json', 'servers'],
] as const;
const installedFiles = [
  ['.github/skills/selected/SKILL.md', 'Selected skill.'],
  ['.claude/commands/selected.md', 'Selected command.'],
  ['.github/agents/selected.agent.md', 'Selected agent.'],
] as const;

// A failed source read must stop the real sync before owned artifacts are purged.
describe('plugin component source failures', () => {
  let root: string;
  let plugin: string;
  let project: string;
  let manifest: Record<string, unknown>;
  let originalHome: string | undefined;

  const writeManifest = async () => {
    await writeFile(join(plugin, '.github/plugin/plugin.json'), JSON.stringify(manifest));
  };

  const writeWorkspace = async (policy: { exclude?: string[]; hooks?: false } = {}) => {
    await writeFile(join(project, '.allagents/workspace.yaml'), stringify({
      version: 2,
      repositories: [],
      plugins: [{ source: plugin, install: 'file', ...policy }],
      clients: ['copilot', 'claude', 'codex', 'vscode'],
      syncMode: 'copy',
    }));
  };

  const expectServers = async (owned: boolean) => {
    const expectedNames = owned ? ['owned', 'personal'] : ['personal'];
    for (const [path, key] of jsonConfigs) {
      const servers = JSON.parse(await readFile(join(project, path), 'utf-8'))[key];
      expect(Object.keys(servers).sort()).toEqual(expectedNames);
      expect(servers.personal).toEqual({ type: 'http', url: personalUrl });
      if (owned) expect(servers.owned.url).toBe(ownedUrl);
    }
    const codex = Bun.TOML.parse(await readFile(join(project, '.codex/config.toml'), 'utf-8')) as {
      mcp_servers: Record<string, { url: string }>;
    };
    expect(Object.keys(codex.mcp_servers).sort()).toEqual(expectedNames);
    expect(codex.mcp_servers.personal).toEqual({ url: personalUrl });
    if (owned) expect(codex.mcp_servers.owned.url).toBe(ownedUrl);
  };

  const expectInstalledFiles = async () => {
    for (const [path, content] of installedFiles) {
      expect(await readFile(join(project, path), 'utf-8')).toContain(content);
    }
  };

  const snapshotOutputs = async (extraPaths: string[] = []) => {
    const paths = [
      ...jsonConfigs.map(([path]) => path),
      '.codex/config.toml',
      ...installedFiles.map(([path]) => path),
      '.allagents/sync-state.json',
      ...extraPaths,
    ];
    return new Map(await Promise.all(paths.map(async (path) =>
      [path, await readFile(join(project, path))] as const,
    )));
  };

  const expectFailedUpdate = async (original: Map<string, Buffer>) => {
    const result = await syncWorkspace(project);
    expect(result.success).toBe(false);
    expect(result.totalCopied).toBe(0);
    for (const [path, bytes] of original) {
      expect(await readFile(join(project, path))).toEqual(bytes);
    }
  };

  const installBaseline = async () => {
    expect((await syncWorkspace(project)).success).toBe(true);
    await expectServers(true);
    await expectInstalledFiles();
    const state = JSON.parse(await readFile(join(project, '.allagents/sync-state.json'), 'utf-8'));
    for (const client of ['copilot', 'claude', 'codex', 'vscode']) {
      expect(state.mcpServers[client]).toEqual(['owned']);
    }
  };

  const expectUntrackedMcp = async () => {
    const state = JSON.parse(await readFile(join(project, '.allagents/sync-state.json'), 'utf-8'));
    for (const client of ['copilot', 'claude', 'codex', 'vscode']) {
      expect(state.mcpServers[client]).toEqual([]);
    }
  };

  beforeEach(async () => {
    originalHome = process.env.ALLAGENTS_TEST_HOME;
    root = await mkdtemp(join(tmpdir(), 'allagents-component-failures-'));
    plugin = join(root, 'plugin');
    project = join(root, 'project');
    process.env.ALLAGENTS_TEST_HOME = join(root, 'home');
    for (const directory of ['.github/plugin', 'config', 'custom/selected']) {
      await mkdir(join(plugin, directory), { recursive: true });
    }
    await mkdir(join(project, '.allagents'), { recursive: true });
    // No entry MCP declaration or conventional MCP file can mask an empty manifest map.
    await writeFile(join(plugin, '.github/plugin/marketplace.json'), JSON.stringify({
      name: 'failures', owner: { name: 'Fixture' }, description: 'Source failures',
      plugins: [{ name: 'selected', description: 'Selected', source: './', strict: false }],
    }));
    manifest = {
      name: 'selected',
      skills: './custom/selected',
      commands: './custom/selected.md',
      agents: './custom/selected.agent.md',
      mcpServers: './config/servers.json',
    };
    await writeFile(join(plugin, 'custom/selected/SKILL.md'),
      '---\nname: selected\ndescription: Selected\n---\nSelected skill.\n');
    await writeFile(join(plugin, 'custom/selected.md'), 'Selected command.\n');
    await writeFile(join(plugin, 'custom/selected.agent.md'),
      '---\nname: selected\ndescription: Selected\n---\nSelected agent.\n');
    await writeFile(join(plugin, 'config/servers.json'), JSON.stringify({
      mcpServers: { owned: { type: 'http', url: ownedUrl } },
    }));
    await writeManifest();
    await writeWorkspace();
    for (const [path, key] of jsonConfigs) {
      await mkdir(dirname(join(project, path)), { recursive: true });
      await writeFile(join(project, path), JSON.stringify({
        [key]: { personal: { type: 'http', url: personalUrl } },
      }));
    }
    await mkdir(join(project, '.codex'), { recursive: true });
    await writeFile(join(project, '.codex/config.toml'),
      `[mcp_servers.personal]\nurl = "${personalUrl}"\n`);
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.ALLAGENTS_TEST_HOME;
    else process.env.ALLAGENTS_TEST_HOME = originalHome;
    await rm(root, { recursive: true, force: true });
  });

  for (const [kind, sourcePath] of [
    ['MCP', 'config/servers.json'],
    ['skill', 'custom/selected'],
    ['command', 'custom/selected.md'],
    ['agent', 'custom/selected.agent.md'],
  ] as const) {
    it(`preserves client config, installed components and tracking when the explicit ${kind} source disappears`, async () => {
      await installBaseline();
      const original = await snapshotOutputs();
      await rm(join(plugin, sourcePath), { recursive: true });
      await expectFailedUpdate(original);
    });
  }

  for (const [kind, sourcePath, replacement] of [
    ['MCP', 'config/servers.json', 'directory'],
    ['skill', 'custom/selected', 'file'],
  ] as const) {
    it(`preserves client config, installed components and tracking when the explicit ${kind} source becomes a ${replacement}`, async () => {
      await installBaseline();
      const original = await snapshotOutputs();
      await rm(join(plugin, sourcePath), { recursive: true });
      if (replacement === 'directory') await mkdir(join(plugin, sourcePath));
      else await writeFile(join(plugin, sourcePath), 'Not a skill directory.\n');
      await expectFailedUpdate(original);
    });
  }

  it('rejects an invalid inline MCP server map instead of removing or partially replacing owned servers', async () => {
    await installBaseline();
    const original = await snapshotOutputs();
    manifest.mcpServers = {
      owned: { type: 'http', url: 'http://127.0.0.1:9/replacement' },
      invalid: { type: 'http' },
    };
    await writeManifest();
    await expectFailedUpdate(original);
  });

  it('reconciles explicit empty component arrays without rediscovering conventional components', async () => {
    await installBaseline();
    for (const [path, content] of [
      ['.github/skills/personal/SKILL.md', 'Personal skill.'],
      ['.claude/commands/personal.md', 'Personal command.'],
      ['.github/agents/personal.agent.md', 'Personal agent.'],
    ] as const) {
      await mkdir(dirname(join(project, path)), { recursive: true });
      await writeFile(join(project, path), content);
    }
    for (const directory of ['skills/fallback', 'commands', 'agents']) {
      await mkdir(join(plugin, directory), { recursive: true });
    }
    await writeFile(join(plugin, 'skills/fallback/SKILL.md'),
      '---\nname: fallback\ndescription: Fallback\n---\nFallback skill.\n');
    await writeFile(join(plugin, 'commands/fallback.md'), 'Fallback command.\n');
    await writeFile(join(plugin, 'agents/fallback.agent.md'),
      '---\nname: fallback\ndescription: Fallback\n---\nFallback agent.\n');
    manifest.skills = [];
    manifest.commands = [];
    manifest.agents = [];
    await writeManifest();
    expect((await syncWorkspace(project)).success).toBe(true);
    for (const [path] of installedFiles) expect(existsSync(join(project, path))).toBe(false);
    expect(existsSync(join(project, '.github/skills/fallback'))).toBe(false);
    expect(existsSync(join(project, '.claude/commands/fallback.md'))).toBe(false);
    expect(existsSync(join(project, '.github/agents/fallback.agent.md'))).toBe(false);
    expect(await readFile(join(project, '.github/skills/personal/SKILL.md'), 'utf-8')).toBe('Personal skill.');
    expect(await readFile(join(project, '.claude/commands/personal.md'), 'utf-8')).toBe('Personal command.');
    expect(await readFile(join(project, '.github/agents/personal.agent.md'), 'utf-8')).toBe('Personal agent.');
    const state = JSON.parse(await readFile(join(project, '.allagents/sync-state.json'), 'utf-8'));
    const trackedFiles = Object.values(state.files).flat() as string[];
    expect(trackedFiles.some((path) => path.includes('/skills/selected') || path.includes('/commands/selected') || path.includes('/agents/selected'))).toBe(false);
    await expectServers(true);
  });

  for (const source of ['inline', 'file'] as const) {
    it(`treats an empty configured ${source} MCP map as authoritative removal when no entry fallback exists`, async () => {
      await installBaseline();
      if (source === 'inline') {
        manifest.mcpServers = {};
        await writeManifest();
      } else {
        await writeFile(join(plugin, 'config/servers.json'), JSON.stringify({ mcpServers: {} }));
      }
      expect((await syncWorkspace(project)).success).toBe(true);
      await expectServers(false);
      await expectUntrackedMcp();
      await expectInstalledFiles();
    });
  }

  it('excludes a malformed selected MCP file before reading it and removes only previously owned servers', async () => {
    await installBaseline();
    const original = await snapshotOutputs();
    await writeFile(join(plugin, 'config/servers.json'), '{"mcpServers":');
    await expectFailedUpdate(original);
    await writeWorkspace({ exclude: ['config/servers.json'] });
    expect((await syncWorkspace(project)).success).toBe(true);
    await expectServers(false);
    await expectUntrackedMcp();
    await expectInstalledFiles();
    expect(await readFile(join(plugin, 'config/servers.json'), 'utf-8')).toBe('{"mcpServers":');
  });

  for (const [label, payload] of [
    ['malformed JSON', '{"hooks":'],
    ['an invalid event map', JSON.stringify({ hooks: { SessionStart: { command: 'invalid' } } })],
    ['an unsupported portable schema', JSON.stringify({
      $schema: 'https://agent-plugins.dev/schema.json',
      hooks: { SessionStart: [] },
    })],
  ] as const) {
    it(`honors hooks:false before reading hook payloads containing ${label}`, async () => {
      manifest.hooks = './config/hooks.json';
      await writeManifest();
      await writeFile(join(plugin, 'config/hooks.json'), JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'printf component-fixture' }] }] },
      }));
      const personal = { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'printf personal' }] }] };
      const hooksPath = join(project, '.codex/hooks.json');
      await writeFile(hooksPath, JSON.stringify({ hooks: personal }));
      await installBaseline();
      expect(JSON.parse(await readFile(hooksPath, 'utf-8')).hooks.SessionStart[0].hooks[0].command)
        .toBe('printf component-fixture');
      const original = await snapshotOutputs(['.codex/hooks.json']);
      await writeFile(join(plugin, 'config/hooks.json'), payload);
      await expectFailedUpdate(original);
      await writeWorkspace({ hooks: false });
      expect((await syncWorkspace(project)).success).toBe(true);
      expect(JSON.parse(await readFile(hooksPath, 'utf-8')).hooks).toEqual(personal);
      const state = JSON.parse(await readFile(join(project, '.allagents/sync-state.json'), 'utf-8'));
      expect(Object.keys(state.codexHooks?.hooks ?? {})).toEqual([]);
      await expectServers(true);
      await expectInstalledFiles();
      expect(await readFile(join(plugin, 'config/hooks.json'), 'utf-8')).toBe(payload);
    });
  }

  it('does not scan or copy an excluded nested symlink outside the selected skill root', async () => {
    await installBaseline();
    const original = await snapshotOutputs();
    await mkdir(join(plugin, 'custom/selected/resources'), { recursive: true });
    const outsidePath = join(root, 'outside.md');
    await writeFile(outsidePath, 'Outside content must never be distributed.\n');
    await symlink(outsidePath, join(plugin, 'custom/selected/resources/outside.md'));
    await writeFile(join(plugin, 'custom/selected/resources/included.txt'), 'Included skill resource.\n');
    await expectFailedUpdate(original);
    await writeWorkspace({ exclude: ['custom/selected/resources/outside.md'] });
    expect((await syncWorkspace(project)).success).toBe(true);
    expect(await readFile(join(project, '.github/skills/selected/resources/included.txt'), 'utf-8'))
      .toBe('Included skill resource.\n');
    for (const clientDirectory of ['.github', '.claude', '.codex']) {
      expect(existsSync(join(project, clientDirectory, 'skills/selected/resources/outside.md'))).toBe(false);
    }
    expect(await readFile(outsidePath, 'utf-8')).toBe('Outside content must never be distributed.\n');
    await expectServers(true);
    await expectInstalledFiles();
  });
  it('retains owned output when a Codex-specific hook manifest or selected file becomes unreadable', async () => {
    await mkdir(join(plugin, '.codex-plugin'), { recursive: true });
    const codexManifestPath = join(plugin, '.codex-plugin/plugin.json');
    const declaration = { name: 'selected', hooks: './config/codex-hooks.json' };
    await writeFile(codexManifestPath, JSON.stringify(declaration));
    const hookPath = join(plugin, 'config/codex-hooks.json');
    await writeFile(hookPath, JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo preserved-hook' }] }] },
    }));
    await installBaseline();
    const original = await snapshotOutputs(['.codex/hooks.json']);
    await writeFile(codexManifestPath, '{invalid');
    await expectFailedUpdate(original);
    await writeFile(codexManifestPath, JSON.stringify(declaration));
    await rm(hookPath);
    await expectFailedUpdate(original);
  });
});
