import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import { resetUpdatePromptMocks, skillMultiselectMock, updateSelectMock, updateSelectResponses } from '../../helpers/clack-prompts-mock.js';
import { TuiCache } from '../../../src/cli/tui/cache.js';

// The prompt mock must be registered before importing actions that capture Clack functions.
const { runBrowsePluginSkills, runPlugins } = await import('../../../src/cli/tui/actions/plugins.js');
const { runSkills } = await import('../../../src/cli/tui/actions/skills.js');

let root: string;
let home: string;
let workspace: string;
let plugin: string;
const originalHome = process.env.HOME;
const originalTestHome = process.env.ALLAGENTS_TEST_HOME;

beforeEach(async () => {
  resetUpdatePromptMocks();
  root = await mkdtemp(join(tmpdir(), 'allagents-native-tui-skills-'));
  home = join(root, 'home');
  workspace = join(root, 'workspace');
  plugin = join(root, 'plugin');
  await mkdir(home, { recursive: true });
  await mkdir(join(workspace, '.allagents'), { recursive: true });
  await mkdir(join(plugin, 'skills', 'demo'), { recursive: true });
  await writeFile(join(plugin, 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Demo\n---\n');
  process.env.HOME = home;
  process.env.ALLAGENTS_TEST_HOME = home;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalTestHome === undefined) delete process.env.ALLAGENTS_TEST_HOME;
  else process.env.ALLAGENTS_TEST_HOME = originalTestHome;
  await rm(root, { recursive: true, force: true });
});

test('native plugins have no ineffective skill choices in plugin and global menus', async () => {
  await writeFile(join(workspace, '.allagents', 'workspace.yaml'), dump({
    repositories: [], clients: ['claude'],
    plugins: [{ source: plugin, install: 'native' }],
  }));
  const context = {
    hasWorkspace: true, workspacePath: workspace, projectPluginCount: 1,
    userPluginCount: 0, needsSync: false, hasUserConfig: false, marketplaceCount: 0,
  };
  await runBrowsePluginSkills(plugin, 'project', context);
  expect(updateSelectMock.mock.calls).toHaveLength(0);
  expect(skillMultiselectMock).not.toHaveBeenCalled();

  await runSkills(context);
  const menus = updateSelectMock.mock.calls.map(([options]) => options);
  expect(menus.some((menu) => menu.options?.some((option) => option.value === 'toggle'))).toBe(false);
  expect(skillMultiselectMock).not.toHaveBeenCalled();
});

test('plugin detail hides native skill browsing and auto-enable actions', async () => {
  await writeFile(join(workspace, '.allagents', 'workspace.yaml'), dump({
    repositories: [], clients: [{ name: 'claude', install: 'native' }],
    plugins: [{ source: plugin }],
  }));
  const context = {
    hasWorkspace: true, workspacePath: workspace, projectPluginCount: 1,
    userPluginCount: 0, needsSync: false, hasUserConfig: false, marketplaceCount: 0,
  };
  const cache = new TuiCache();
  cache.setStatus({
    success: true, plugins: [{ source: plugin, kind: 'plugin', type: 'local', available: true, path: plugin }],
    userPlugins: [], clients: [], nativeResources: [],
  });
  updateSelectResponses.push(`project:${plugin}`, 'back', '__back__');
  await runPlugins(context, cache);
  const detail = updateSelectMock.mock.calls.find(([options]) => options.message.startsWith('Plugin:'));
  expect(detail).toBeDefined();
  expect(detail?.[0].message).toContain('· native');
  const options = detail?.[0].options ?? [];
  expect(options.map((option) => option.value)).not.toContain('browse');
  expect(options.map((option) => option.value)).not.toContain('toggle_auto_enable');
});

test('file override retains skill controls for a native-default client', async () => {
  await writeFile(join(workspace, '.allagents', 'workspace.yaml'), dump({
    repositories: [], clients: [{ name: 'claude', install: 'native' }],
    plugins: [{ source: plugin, install: 'file' }],
  }));
  const context = {
    hasWorkspace: true, workspacePath: workspace, projectPluginCount: 1,
    userPluginCount: 0, needsSync: false, hasUserConfig: false, marketplaceCount: 0,
  };
  await runSkills(context);
  const menus = updateSelectMock.mock.calls.map(([options]) => options);
  expect(menus.some((menu) => menu.options?.some((option) => option.value === 'toggle'))).toBe(true);
  await runBrowsePluginSkills(plugin, 'project', context);
  expect(skillMultiselectMock).toHaveBeenCalledTimes(1);
});

test('explicit native mode hides skill choices even before clients are configured', async () => {
  await writeFile(join(workspace, '.allagents', 'workspace.yaml'), dump({
    repositories: [], clients: [],
    plugins: [{ source: plugin, install: 'native' }],
  }));
  const context = {
    hasWorkspace: true, workspacePath: workspace, projectPluginCount: 1,
    userPluginCount: 0, needsSync: false, hasUserConfig: false, marketplaceCount: 0,
  };
  await runBrowsePluginSkills(plugin, 'project', context);
  expect(skillMultiselectMock).not.toHaveBeenCalled();
});

test('user-scope native plugins cannot open a skill picker', async () => {
  await mkdir(join(home, '.allagents'), { recursive: true });
  await writeFile(join(home, '.allagents', 'workspace.yaml'), dump({
    clients: ['claude:native'],
    plugins: [{ source: plugin }],
  }));
  const context = {
    hasWorkspace: true, workspacePath: workspace, projectPluginCount: 0,
    userPluginCount: 1, needsSync: false, hasUserConfig: true, marketplaceCount: 0,
  };
  await runBrowsePluginSkills(plugin, 'user', context);
  expect(skillMultiselectMock).not.toHaveBeenCalled();
});
