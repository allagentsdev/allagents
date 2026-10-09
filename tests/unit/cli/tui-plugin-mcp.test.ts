import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, load } from 'js-yaml';
import {
  CLACK_CANCEL,
  resetUpdatePromptMocks,
  updateMultiselectMock,
  updateMultiselectResponses,
  updateNoteMock,
  updateSelectMock,
  updateSelectResponses,
} from '../../helpers/clack-prompts-mock.js';
import { TuiCache } from '../../../src/cli/tui/cache.js';
import type { ClientEntry, PluginEntry } from '../../../src/models/workspace-config.js';

// The prompt module must be mocked before loading the TUI action.
const { runPlugins } = await import('../../../src/cli/tui/actions/plugins.js');

const oldHome = process.env.HOME;
const oldTestHome = process.env.ALLAGENTS_TEST_HOME;
let root: string;
let home: string;
let workspace: string;
let first: string;
let second: string;

async function configAt(scope: 'project' | 'user', plugins: PluginEntry[], clients: ClientEntry[] = ['vscode']) {
  const path = join(scope === 'project' ? workspace : home, '.allagents', 'workspace.yaml');
  await mkdir(join(scope === 'project' ? workspace : home, '.allagents'), { recursive: true });
  await writeFile(path, dump({ repositories: [], clients, plugins }));
  return path;
}

function statusCache(scope: 'project' | 'user', source: string): TuiCache {
  const cache = new TuiCache();
  const plugin = { source, type: 'local' as const, kind: 'plugin' as const, available: true, path: source };
  cache.setStatus({
    success: true,
    plugins: scope === 'project' ? [plugin] : [],
    userPlugins: scope === 'user' ? [plugin] : [],
    clients: ['vscode'],
    nativeResources: [],
  });
  return cache;
}

const context = () => ({
  hasWorkspace: true,
  workspacePath: workspace,
  projectPluginCount: 1,
  userPluginCount: 1,
  needsSync: false,
  hasUserConfig: true,
  marketplaceCount: 0,
});

beforeEach(async () => {
  resetUpdatePromptMocks();
  root = await mkdtemp(join(tmpdir(), 'allagents-tui-mcp-'));
  home = join(root, 'home');
  workspace = join(root, 'workspace');
  first = join(root, 'same-name', 'one');
  second = join(root, 'another', 'one');
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(first, '.mcp.json'), JSON.stringify({ mcpServers: { alpha: { command: 'echo' }, beta: { command: 'echo' } } }));
  await writeFile(join(second, '.mcp.json'), JSON.stringify({ mcpServers: { alpha: { command: 'echo' } } }));
  process.env.HOME = home;
  process.env.ALLAGENTS_TEST_HOME = home;
});

afterEach(async () => {
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  if (oldTestHome === undefined) delete process.env.ALLAGENTS_TEST_HOME;
  else process.env.ALLAGENTS_TEST_HOME = oldTestHome;
  resetUpdatePromptMocks();
  await rm(root, { recursive: true, force: true });
});

describe('installed plugin MCP selection', () => {
  test('offers only the selected file plugin servers and persists exclusions without touching a same-name plugin', async () => {
    const path = await configAt('project', [
      { source: first, install: 'file', skills: { exclude: ['some-skill'] }, ref: 'v1' },
      { source: second, install: 'file', mcpServers: { exclude: ['alpha'] } },
    ]);
    updateSelectResponses.push(`project:${first}`, 'mcp_servers', 'back', '__back__');
    updateMultiselectResponses.push(['beta']);

    await runPlugins(context(), statusCache('project', first));

    const options = updateSelectMock.mock.calls.find(([input]) => input.message.startsWith(`Plugin: ${first} [project]`))?.[0].options;
    expect(options).toContainEqual({ label: 'MCP servers', value: 'mcp_servers' });
    expect(updateMultiselectMock.mock.calls[0]?.[0].options).toEqual([
      { label: 'alpha', value: 'alpha' },
      { label: 'beta', value: 'beta' },
    ]);
    expect(updateMultiselectMock.mock.calls[0]?.[0].initialValues).toEqual(['alpha', 'beta']);
    const saved = load(await readFile(path, 'utf8')) as { plugins: Array<Record<string, unknown>> };
    expect(saved.plugins[0]).toMatchObject({ source: first, skills: { exclude: ['some-skill'] }, ref: 'v1', mcpServers: { exclude: ['alpha'] } });
    expect(saved.plugins[1]).toEqual({ source: second, install: 'file', mcpServers: { exclude: ['alpha'] } });
    expect(updateNoteMock.mock.calls).toContainEqual(['✗ Disabled: alpha', 'MCP servers updated']);
  });

  test('selects the second declaration when two plugins share a source', async () => {
    const path = await configAt('project', [
      { source: first, clients: ['vscode'], mcpServers: { exclude: ['alpha', 'beta'] } },
      { source: first, clients: ['vscode'] },
    ]);
    const cache = statusCache('project', first);
    const status = cache.getStatus();
    if (!status) throw new Error('Missing fixture status');
    cache.setStatus({ ...status, plugins: [...status.plugins, ...status.plugins] });
    updateSelectResponses.push(`project:${first}\0${1}`, 'mcp_servers', 'back', '__back__');
    updateMultiselectResponses.push(['beta']);

    await runPlugins(context(), cache);

    const saved = load(await readFile(path, 'utf8')) as { plugins: Array<Record<string, unknown>> };
    expect(saved.plugins[0]?.mcpServers).toEqual({ exclude: ['alpha', 'beta'] });
    expect(saved.plugins[1]?.mcpServers).toEqual({ exclude: ['alpha'] });
    expect(JSON.parse(await readFile(join(workspace, '.vscode', 'mcp.json'), 'utf8')).servers).toEqual({
      beta: { command: 'echo' },
    });
  });

  test('retries MCP reconciliation after a failed destination write without refreshing the plugin', async () => {
    const path = await configAt('project', [{ source: first, install: 'file' }]);
    const blocked = join(workspace, '.vscode', 'mcp.json');
    await mkdir(blocked, { recursive: true });
    updateSelectResponses.push(`project:${first}`, 'mcp_servers', 'mcp_servers', 'back', '__back__');
    updateMultiselectMock
      .mockImplementationOnce(async () => ['beta'])
      .mockImplementationOnce(async () => {
        rmSync(blocked, { recursive: true });
        return ['beta'];
      });

    await runPlugins(context(), statusCache('project', first));

    const saved = load(await readFile(path, 'utf8')) as { plugins: Array<Record<string, unknown>> };
    expect(saved.plugins[0]?.mcpServers).toEqual({ exclude: ['alpha'] });
    expect(updateNoteMock.mock.calls.some(
      ([message, title]) =>
        title === 'Error' &&
        message.includes('Selection saved, but MCP update failed:') &&
        message.includes('Reopen MCP servers and confirm to retry.'),
    )).toBe(true);
    expect(updateNoteMock.mock.calls).toContainEqual([
      'Saved selection applied.',
      'MCP servers updated',
    ]);
    expect(JSON.parse(await readFile(blocked, 'utf8')).servers).toEqual({
      beta: { command: 'echo' },
    });
  });


  test('does not offer workspace-owned servers in a plugin with no .mcp.json', async () => {
    const path = await configAt('project', [{ source: second, install: 'file' }]);
    await rm(join(second, '.mcp.json'));
    await writeFile(path, dump({
      repositories: [],
      clients: ['vscode'],
      plugins: [{ source: second, install: 'file' }],
      mcpServers: { workspaceOnly: { command: 'echo' } },
    }));
    updateSelectResponses.push(`project:${second}`, 'back', '__back__');

    await runPlugins(context(), statusCache('project', second));

    const options = updateSelectMock.mock.calls.find(([input]) => input.message.startsWith(`Plugin: ${second} [project]`))?.[0].options;
    expect(options?.some(({ value }) => value === 'mcp_servers')).toBe(false);
    expect(updateMultiselectMock).not.toHaveBeenCalled();
  });

  test('does not offer a picker when file clients have no MCP destination', async () => {
    await configAt('project', [{ source: first, install: 'file' }], ['cursor']);
    updateSelectResponses.push(`project:${first}`, 'back', '__back__');

    await runPlugins(context(), statusCache('project', first));

    const options = updateSelectMock.mock.calls.find(
      ([input]) => input.message.startsWith(`Plugin: ${first} [project]`),
    )?.[0].options;
    expect(options?.some(({ value }) => value === 'mcp_servers')).toBe(false);
  });

  test('does not offer a picker for native-only plugins with discoverable .mcp.json', async () => {
    const path = await configAt('project', [{ source: first, install: 'native' }], ['claude']);
    const before = await readFile(path, 'utf8');
    updateSelectResponses.push(`project:${first}`, 'back', '__back__');

    await runPlugins(context(), statusCache('project', first));

    const options = updateSelectMock.mock.calls.find(
      ([input]) => input.message.startsWith(`Plugin: ${first} [project]`),
    )?.[0].options;
    expect(options).toBeDefined();
    expect(options?.some(({ value }: { value: string }) => value === 'mcp_servers')).toBe(false);
    expect(updateMultiselectMock).not.toHaveBeenCalled();
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  test('offers file servers for mixed native/file installs without changing config on cancellation', async () => {
    const path = await configAt(
      'project',
      [{ source: first, mcpServers: { exclude: ['alpha'] } }],
      [{ name: 'claude', install: 'native' }, { name: 'vscode', install: 'file' }],
    );
    const before = await readFile(path, 'utf8');
    updateSelectResponses.push(`project:${first}`, 'mcp_servers', 'back', '__back__');
    updateMultiselectResponses.push(CLACK_CANCEL);

    await runPlugins(context(), statusCache('project', first));

    const detail = updateSelectMock.mock.calls.find(
      ([input]) => input.message.startsWith(`Plugin: ${first} [project]`),
    )?.[0];
    expect(detail).toBeDefined();
    const actions = detail?.options?.map(({ value }) => value);
    expect(actions).toContain('mcp_servers');
    expect(actions).not.toContain('browse');
    expect(actions).not.toContain('toggle_auto_enable');

    expect(updateMultiselectMock.mock.calls[0]?.[0].initialValues).toEqual(['beta']);
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  test('user scope updates its own declaration without changing project config', async () => {
    const userPath = await configAt('user', [{ source: first, install: 'file', mcpServers: { exclude: ['alpha'] } }]);
    const projectPath = await configAt('project', [{ source: first, install: 'file' }]);
    const beforeProject = await readFile(projectPath, 'utf8');
    updateSelectResponses.push(`user:${first}`, 'mcp_servers', 'back', '__back__');
    updateMultiselectResponses.push(['alpha', 'beta']);

    await runPlugins(context(), statusCache('user', first));

    const user = load(await readFile(userPath, 'utf8')) as { plugins: Array<Record<string, unknown>> };
    expect(user.plugins[0]).toEqual({ source: first, install: 'file' });
    expect(await readFile(projectPath, 'utf8')).toBe(beforeProject);
    expect(updateNoteMock.mock.calls).toContainEqual(['✓ Enabled: alpha', 'MCP servers updated']);
  });

  test('cancel returns to detail without changing user configuration', async () => {
    const path = await configAt('user', [{ source: first, install: 'file', mcpServers: { exclude: ['alpha'] } }]);
    const before = await readFile(path, 'utf8');
    updateSelectResponses.push(`user:${first}`, 'mcp_servers', 'back', '__back__');
    updateMultiselectResponses.push(CLACK_CANCEL);

    await runPlugins(context(), statusCache('user', first));

    expect(updateMultiselectMock.mock.calls[0]?.[0].initialValues).toEqual(['beta']);
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(updateNoteMock.mock.calls.some(([, title]) => title === 'MCP servers updated')).toBe(false);
  });
});
