import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { syncWorkspace } from '../../src/core/sync.js';
import { discoverSkillEntriesFromPluginRoot } from '../../src/core/skills.js';
import { validateLocalPlugin } from '../../src/validators/plugin.js';

const schema = 'https://agent-plugins.org/schemas/1.0.0/';

describe('portable plugin installation', () => {
  let root: string;
  let plugin: string;
  let project: string;
  let oldHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'allagents-portable-install-'));
    plugin = join(root, 'plugin');
    project = join(root, 'project');
    oldHome = process.env.ALLAGENTS_TEST_HOME;
    process.env.ALLAGENTS_TEST_HOME = join(root, 'home');
    await mkdir(join(plugin, 'skills/reports/references'), { recursive: true });
    await mkdir(join(project, '.allagents'), { recursive: true });
    await writeFile(join(plugin, 'plugin.json'), JSON.stringify({ $schema: `${schema}plugin.schema.json`, name: 'reports' }));
    await writeFile(join(plugin, 'skills/reports/SKILL.md'), '---\nname: reports\ndescription: Report writing\n---\nWrite a report.\n');
    await writeFile(join(plugin, 'skills/reports/references/rules.md'), 'Keep supporting resources.\n');
    await writeFile(join(plugin, 'probe.mjs'), 'console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), root: process.env.PLUGIN_ROOT, data: process.env.PLUGIN_DATA }));\n');
    await writeFile(join(plugin, 'mcp.json'), JSON.stringify({
      $schema: `${schema}mcp.schema.json`,
      mcpServers: { reports: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/probe.mjs', '${UNKNOWN}', 'two words'] } },
    }));
    await writeFile(join(project, '.allagents/workspace.yaml'), stringify({
      version: 2, repositories: [], plugins: [{ source: plugin, install: 'file' }],
      clients: ['universal', 'claude', 'copilot', 'codex', 'vscode'], syncMode: 'copy',
    }));
    await writeFile(join(project, '.mcp.json'), JSON.stringify({ mcpServers: { personal: { url: 'http://127.0.0.1:9/personal' } } }));
  });

  afterEach(async () => {
    if (oldHome === undefined) delete process.env.ALLAGENTS_TEST_HOME;
    else process.env.ALLAGENTS_TEST_HOME = oldHome;
    await rm(root, { recursive: true, force: true });
  });

  it('installs portable skills and working MCP configurations across file destinations', async () => {
    const result = await syncWorkspace(project);
    expect(result.success).toBe(true);
    for (const directory of ['.agents', '.claude', '.github', '.codex']) {
      expect(await readFile(join(project, directory, 'skills/reports/SKILL.md'), 'utf8')).toContain('Write a report.');
      expect(await readFile(join(project, directory, 'skills/reports/references/rules.md'), 'utf8')).toBe('Keep supporting resources.\n');
    }
    for (const [path, key] of [['.allagents/mcp.json', 'mcpServers'], ['.mcp.json', 'mcpServers'], ['.github/mcp.json', 'mcpServers'], ['.vscode/mcp.json', 'servers']] as const) {
      const config = JSON.parse(await readFile(join(project, path), 'utf8'))[key].reports;
      const child = Bun.spawnSync([config.command, ...config.args], { env: { ...process.env, ...config.env }, stdout: 'pipe', stderr: 'pipe' });
      expect(child.exitCode).toBe(0);
      expect(JSON.parse(new TextDecoder().decode(child.stdout))).toMatchObject({ cwd: plugin, root: plugin, args: ['${UNKNOWN}', 'two words'] });
    }
    const codex = Bun.TOML.parse(await readFile(join(project, '.codex/config.toml'), 'utf8')) as { mcp_servers: Record<string, unknown> };
    expect(codex.mcp_servers.reports).toBeDefined();
    const servers = JSON.parse(await readFile(join(project, '.mcp.json'), 'utf8')).mcpServers;
    expect(servers.personal.url).toBe('http://127.0.0.1:9/personal');
    expect((await validateLocalPlugin(plugin)).valid).toBe(true);
  });

  it('keeps prior MCP configuration when a portable MCP document becomes invalid while updating valid skills', async () => {
    expect((await syncWorkspace(project)).success).toBe(true);
    const before = await readFile(join(project, '.allagents/mcp.json'));
    await writeFile(join(plugin, 'mcp.json'), '{invalid');
    await writeFile(join(plugin, 'skills/reports/SKILL.md'), '---\nname: reports\ndescription: Updated report writing\n---\nUpdated report.\n');
    const result = await syncWorkspace(project);
    expect(result.success).toBe(false);
    expect(await readFile(join(project, '.allagents/mcp.json'))).toEqual(before);
    expect(await readFile(join(project, '.agents/skills/reports/SKILL.md'), 'utf8')).toContain('Updated report.');
  });

  it('preserves supported native manifests and native MCP precedence in dual-format plugins', async () => {
    await mkdir(join(plugin, '.claude-plugin'));
    await writeFile(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'reports', skills: [] }));
    await writeFile(join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { native: { url: 'http://127.0.0.1:9/native' } } }));
    expect((await syncWorkspace(project)).success).toBe(true);
    expect(existsSync(join(project, '.agents/skills/reports'))).toBe(false);
    const servers = JSON.parse(await readFile(join(project, '.allagents/mcp.json'), 'utf8')).mcpServers;
    expect(Object.keys(servers)).toEqual(['native']);
  });

  it('discovers only immediate valid portable skills and ignores unrelated native resources', async () => {
    await mkdir(join(plugin, 'skills/category/nested'), { recursive: true });
    await writeFile(join(plugin, 'skills/category/nested/SKILL.md'), '---\nname: nested\ndescription: Nested\n---\nNested.');
    await mkdir(join(plugin, '.github/instructions'), { recursive: true });
    await writeFile(join(plugin, '.github/instructions/ignored.instructions.md'), 'Not a portable component.');
    const entries = await discoverSkillEntriesFromPluginRoot(plugin);
    expect(entries.map((entry) => entry.name)).toEqual(['reports']);
    expect((await syncWorkspace(project)).success).toBe(true);
    expect(existsSync(join(project, '.github/instructions/ignored.instructions.md'))).toBe(false);
  });
});
