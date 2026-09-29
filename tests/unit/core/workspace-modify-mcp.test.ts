import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, load } from 'js-yaml';
import { setPluginMcpServersExcluded } from '../../../src/core/workspace-modify.js';
import { setUserPluginMcpServersExcluded } from '../../../src/core/user-workspace.js';

const originalHome = process.env.HOME;
const originalTestHome = process.env.ALLAGENTS_TEST_HOME;
let root: string;
let project: string;
let home: string;
let projectConfigPath: string;
let userConfigPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'allagents-mcp-config-'));
  project = join(root, 'project');
  home = join(root, 'home');
  projectConfigPath = join(project, '.allagents', 'workspace.yaml');
  userConfigPath = join(home, '.allagents', 'workspace.yaml');
  await mkdir(join(project, '.allagents'), { recursive: true });
  await mkdir(join(home, '.allagents'), { recursive: true });
  process.env.HOME = home;
  process.env.ALLAGENTS_TEST_HOME = home;
  const config = {
    repositories: [],
    clients: ['vscode'],
    plugins: [
      { source: '/different/tree/plugin', clients: ['vscode'], skills: { exclude: ['build'] }, exclude: ['tmp/**'], mcpServers: { exclude: ['before'] } },
      { source: '/same/name/plugin', mcpServers: { exclude: ['keep'] } },
    ],
  };
  await writeFile(projectConfigPath, dump(config));
  await writeFile(userConfigPath, dump(config));
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalTestHome === undefined) delete process.env.ALLAGENTS_TEST_HOME;
  else process.env.ALLAGENTS_TEST_HOME = originalTestHome;
  await rm(root, { recursive: true, force: true });
});

describe('per-plugin MCP exclusions', () => {
  test('updates only exact project source and preserves unrelated plugin fields', async () => {
    expect(await setPluginMcpServersExcluded('/different/tree/plugin', ['alpha', 'beta', 'alpha'], project)).toEqual({ success: true });
    const config = load(await readFile(projectConfigPath, 'utf8')) as { plugins: Array<Record<string, unknown>> };
    expect(config.plugins).toEqual([
      { source: '/different/tree/plugin', clients: ['vscode'], skills: { exclude: ['build'] }, exclude: ['tmp/**'], mcpServers: { exclude: ['alpha', 'beta'] } },
      { source: '/same/name/plugin', mcpServers: { exclude: ['keep'] } },
    ]);
  });

  test('empty selection removes the blocklist without modifying the user or project peer', async () => {
    expect(await setUserPluginMcpServersExcluded('/different/tree/plugin', [])).toEqual({ success: true });
    const user = load(await readFile(userConfigPath, 'utf8')) as { plugins: Array<Record<string, unknown>> };
    const projectSaved = load(await readFile(projectConfigPath, 'utf8')) as { plugins: Array<Record<string, unknown>> };
    expect(user.plugins[0]).toEqual({ source: '/different/tree/plugin', clients: ['vscode'], skills: { exclude: ['build'] }, exclude: ['tmp/**'] });
    expect(user.plugins[1]?.mcpServers).toEqual({ exclude: ['keep'] });
    expect(projectSaved.plugins[0]?.mcpServers).toEqual({ exclude: ['before'] });
  });

  test('converts shorthand source to an object only for the selected plugin', async () => {
    await writeFile(projectConfigPath, dump({
      repositories: [],
      clients: ['vscode'],
      plugins: ['/different/tree/plugin', '/same/name/plugin'],
    }));

    expect(await setPluginMcpServersExcluded('/different/tree/plugin', ['alpha'], project)).toEqual({ success: true });
    const config = load(await readFile(projectConfigPath, 'utf8')) as { plugins: unknown[] };
    expect(config.plugins).toEqual([
      { source: '/different/tree/plugin', mcpServers: { exclude: ['alpha'] } },
      '/same/name/plugin',
    ]);
  });

  test('targets the second declaration when sources are identical', async () => {
    const source = '/different/tree/plugin';
    await writeFile(projectConfigPath, dump({
      repositories: [],
      clients: ['vscode', 'copilot'],
      plugins: [
        { source, clients: ['vscode'], mcpServers: { exclude: ['alpha'] } },
        { source, clients: ['copilot'] },
      ],
    }));
    expect(await setPluginMcpServersExcluded(source, ['beta'], project, 1)).toEqual({
      success: true,
    });
    const saved = load(await readFile(projectConfigPath, 'utf8')) as { plugins: Array<Record<string, unknown>> };
    expect(saved.plugins[0]?.mcpServers).toEqual({ exclude: ['alpha'] });
    expect(saved.plugins[1]?.mcpServers).toEqual({ exclude: ['beta'] });

    const before = await readFile(projectConfigPath, 'utf8');
    expect((await setPluginMcpServersExcluded(source, ['alpha'], project, 3)).success).toBe(false);
    expect(await readFile(projectConfigPath, 'utf8')).toBe(before);
  });

  test('missing exact source makes no changes even when a different plugin shares its short name', async () => {
    const before = await readFile(projectConfigPath, 'utf8');
    const result = await setPluginMcpServersExcluded('/another/path/plugin', ['hidden'], project);
    expect(result.success).toBe(false);
    expect(await readFile(projectConfigPath, 'utf8')).toBe(before);
  });
});
