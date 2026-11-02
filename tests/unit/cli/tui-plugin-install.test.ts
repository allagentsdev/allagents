import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as dump, parse as load } from 'yaml';
import { addMarketplace } from '../../../src/core/marketplace.js';
import {
  CLACK_CANCEL as CANCEL,
  autocompleteMock,
  installClientResponses as clientResponses,
  installConfirmationResponses as confirmationResponses,
  installConfirmMock as confirmMock,
  installNoteMock as noteMock,
  updateNoteMock as errorNoteMock,
  installScopeResponses as scopeResponses,
  resetInstallPromptMocks,
} from '../../helpers/clack-prompts-mock.js';



const { installSelectedPlugin, runInstallPlugin } = await import(
  '../../../src/cli/tui/actions/plugins.js'
);
const { formatInstallTargetSummary } = await import(
  '../../../src/cli/tui/install-target-prompts.js'
);
const { runSkills } = await import('../../../src/cli/tui/actions/skills.js');

const originalHome = process.env.HOME;
const originalTestHome = process.env.ALLAGENTS_TEST_HOME;
let root: string;
let home: string;
let workspace: string;
let plugin: string;

async function createFixture(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'allagents-tui-plugin-install-'));
  home = join(root, 'home');
  workspace = join(root, 'workspace');
  plugin = join(root, 'plugin');
  await mkdir(join(workspace, '.allagents'), { recursive: true });
  await mkdir(join(plugin, 'skills', 'demo'), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(
    join(plugin, 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: Demo\n---\n# Demo\n',
  );
  await writeFile(
    join(workspace, '.allagents', 'workspace.yaml'),
    dump({ repositories: [], plugins: [], clients: ['claude', 'codex'] }),
  );
  process.env.ALLAGENTS_TEST_HOME = home;
  process.env.HOME = home;
}

beforeEach(async () => {
  resetInstallPromptMocks();
  await createFixture();
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalTestHome === undefined) delete process.env.ALLAGENTS_TEST_HOME;
  else process.env.ALLAGENTS_TEST_HOME = originalTestHome;
  await rm(root, { recursive: true, force: true });
});

describe('installSelectedPlugin', () => {
  test('returns the exact scope/source and persists only the selected client subset', async () => {
    scopeResponses.push('project');
    clientResponses.push(['codex']);
    confirmationResponses.push(true);

    const result = await installSelectedPlugin(plugin, {
      hasWorkspace: true,
      workspacePath: workspace,
      projectPluginCount: 0,
      userPluginCount: 0,
      needsSync: false,
      hasUserConfig: false,
      marketplaceCount: 0,
    });

    expect(result).toEqual({
      status: 'installed',
      scope: 'project',
      source: plugin,
    });
    const config = load(
      await readFile(join(workspace, '.allagents', 'workspace.yaml'), 'utf8'),
    ) as { clients: string[]; plugins: Array<{ source: string; clients?: string[] }> };
    expect(config.clients).toEqual(['claude', 'codex']);
    expect(config.plugins).toEqual([{ source: plugin, clients: ['codex'] }]);
    expect(noteMock.mock.calls[0]).toEqual([
      [
        `Install plugin: ${plugin}`,
        `Scope: Project — ${join(workspace, '.allagents', 'workspace.yaml')}`,
        'Clients: codex (file)',
        'Targeting: plugin override',
      ].join('\n'),
      'Install summary',
    ]);
    expect(confirmMock).toHaveBeenCalledWith({
      message: 'Install with this target?',
      initialValue: true,
    });
  });

  test('does not label a client as file-backed when planning found no supported method', () => {
    expect(
      formatInstallTargetSummary({
        action: 'Install plugin',
        payload: 'native-package',
        scope: 'project',
        configPath: '/workspace/.allagents/workspace.yaml',
        clients: ['codex'],
        effectiveMethods: [],
        disposition: 'override',
      }),
    ).toContain('Clients: codex (unsupported)');
  });

  test('returns cancelled and leaves config byte-for-byte unchanged when confirmation is declined', async () => {
    const configPath = join(workspace, '.allagents', 'workspace.yaml');
    const before = await readFile(configPath, 'utf8');
    scopeResponses.push('project');
    clientResponses.push(['codex']);
    confirmationResponses.push(false);

    const result = await installSelectedPlugin(plugin, {
      hasWorkspace: true,
      workspacePath: workspace,
      projectPluginCount: 0,
      userPluginCount: 0,
      needsSync: false,
      hasUserConfig: false,
      marketplaceCount: 0,
    });

    expect(result).toEqual({ status: 'cancelled' });
    expect(await readFile(configPath, 'utf8')).toBe(before);
  });

  test('initializes the first user config from the selected clients', async () => {
    scopeResponses.push('user');
    clientResponses.push(['codex', 'cursor']);
    confirmationResponses.push(true);

    const result = await installSelectedPlugin(plugin, {
      hasWorkspace: true,
      workspacePath: workspace,
      projectPluginCount: 0,
      userPluginCount: 0,
      needsSync: false,
      hasUserConfig: false,
      marketplaceCount: 0,
    });

    expect(result).toEqual({ status: 'installed', scope: 'user', source: plugin });
    const config = load(
      await readFile(join(home, '.allagents', 'workspace.yaml'), 'utf8'),
    ) as { clients: string[]; plugins: string[] };
    expect(config.clients).toEqual(['codex', 'cursor']);
    expect(config.plugins).toEqual([plugin]);
  });
});

test('a blocked legacy repository import reports failure after saving the explicit plugin declaration', async () => {
  errorNoteMock.mockClear();
  const configPath = join(workspace, '.allagents', 'workspace.yaml');
  await writeFile(configPath, 'repositories:\n  - path: ../repo\n    name: Original\nplugins: []\nclients: [vscode]\n');
  const { syncWorkspace } = await import('../../../src/core/sync.js');
  expect((await syncWorkspace(workspace)).success).toBe(true);
  const statePath = join(workspace, '.allagents', 'sync-state.json');
  const editorPath = join(workspace, 'workspace.code-workspace');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  delete state.vscodeWorkspaceFolders;
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(configPath, (await readFile(configPath, 'utf8')).replace('Original', 'YAML name'));
  const editor = JSON.parse(await readFile(editorPath, 'utf8'));
  editor.folders[1].name = 'Editor name';
  await writeFile(editorPath, JSON.stringify(editor));
  const pending = await readFile(editorPath, 'utf8');
  const baseline = await readFile(statePath, 'utf8');
  scopeResponses.push('project');
  clientResponses.push(['vscode']);
  confirmationResponses.push(true);
  const result = await installSelectedPlugin(plugin, {
    hasWorkspace: true,
    workspacePath: workspace,
    projectPluginCount: 0,
    userPluginCount: 0,
    needsSync: false,
    hasUserConfig: false,
    marketplaceCount: 0,
  });
  expect(result).toEqual({ status: 'failed' });
  expect(await readFile(editorPath, 'utf8')).toBe(pending);
  expect(await readFile(statePath, 'utf8')).toBe(baseline);
  const config = load(await readFile(configPath, 'utf8')) as { repositories: { name: string }[]; plugins: unknown[] };
  expect(config.repositories[0]!.name).toBe('YAML name');
  expect(config.plugins).toHaveLength(1);
  expect(errorNoteMock.mock.calls.flat().join('\n')).toContain('--yes');
  expect(noteMock.mock.calls.some(call => String(call[1]).startsWith('Installed:'))).toBe(false);
});

describe('marketplace TUI inventory', () => {
  async function catalogue() {
    const marketplace = join(root, 'marketplace');
    await mkdir(join(marketplace, '.claude-plugin'), { recursive: true });
    for (const [path, name] of [
      ['plugins/collection/skills/actual', 'actual'],
      ['plugins/custom/skills/stale', 'stale'],
      ['plugins/custom/library/selected', 'selected'],
      ['plugins/empty/skills/hidden', 'hidden'],
      ['plugins/flat/rogue', 'rogue'],
    ]) {
      await mkdir(join(marketplace, path!), { recursive: true });
      await writeFile(join(marketplace, path!, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} description\n---\n# ${name}\n`);
    }
    await writeFile(join(marketplace, 'plugins/custom/plugin.json'), JSON.stringify({ name: 'custom', skills: './library/' }));
    await writeFile(join(marketplace, 'plugins/empty/plugin.json'), JSON.stringify({ name: 'empty', skills: [] }));
    await writeFile(join(marketplace, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      name: 'inventory', description: 'Inventory fixture', plugins: [
        { name: 'collection', description: 'Collection', source: './plugins/collection', skills: './skills/' },
        { name: 'custom', description: 'Custom', source: './plugins/custom', skills: './skills/' },
        { name: 'empty', description: 'Empty', source: './plugins/empty', skills: './skills/' },
        { name: 'flat', description: 'Flat', source: './plugins/flat', skills: './rogue/' },
        { name: 'unresolved', description: 'Unresolved', source: { source: 'github', repo: 'fixtures/unresolved-inventory' }, skills: './phantom/' },
      ],
    }));
    expect((await addMarketplace(marketplace, 'inventory', undefined, { scope: 'user' })).success).toBe(true);
    return {
      hasWorkspace: true, workspacePath: workspace, projectPluginCount: 0,
      userPluginCount: 0, needsSync: false, hasUserConfig: false, marketplaceCount: 1,
    };
  }

  test('plugin picker previews resolved custom/default names and leaves unresolved inventory unknown', async () => {
    const context = await catalogue();
    const picker = autocompleteMock;
    picker.mockClear();
    picker.mockResolvedValueOnce('__back__');
    await runInstallPlugin(context);
    expect(picker.mock.calls[0]?.[0].options).toEqual([
      { label: 'collection - Collection (inventory)', value: 'collection@inventory', hint: '1 skills: actual' },
      { label: 'custom - Custom (inventory)', value: 'custom@inventory', hint: '1 skills: selected' },
      { label: 'empty - Empty (inventory)', value: 'empty@inventory' },
      { label: 'flat - Flat (inventory)', value: 'flat@inventory' },
      { label: 'unresolved - Unresolved (inventory)', value: 'unresolved@inventory' },
      { label: 'Back', value: '__back__' },
    ]);
  });

  test('skill browser groups the same authoritative names as plugin installation', async () => {
    const context = await catalogue();
    const picker = autocompleteMock;
    picker.mockClear();
    picker.mockResolvedValueOnce('__back__');
    await runSkills(context);
    expect(picker.mock.calls[0]?.[0].options).toEqual([
      { label: 'collection@inventory - Collection', value: 'collection@inventory', hint: '1 skills: actual' },
      { label: 'custom@inventory - Custom', value: 'custom@inventory', hint: '1 skills: selected' },
      { label: 'Back', value: '__back__' },
    ]);
  });
});
