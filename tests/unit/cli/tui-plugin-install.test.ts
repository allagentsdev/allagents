import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as dump, parse as load } from 'yaml';
import {
  CLACK_CANCEL as CANCEL,
  installClientResponses as clientResponses,
  installConfirmationResponses as confirmationResponses,
  installConfirmMock as confirmMock,
  installNoteMock as noteMock,
  installScopeResponses as scopeResponses,
  resetInstallPromptMocks,
} from '../../helpers/clack-prompts-mock.js';


// Load after the Clack mock so the action captures deterministic prompt functions.

const { installSelectedPlugin } = await import(
  '../../../src/cli/tui/actions/plugins.js'
);
const { formatInstallTargetSummary } = await import(
  '../../../src/cli/tui/install-target-prompts.js'
);

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
