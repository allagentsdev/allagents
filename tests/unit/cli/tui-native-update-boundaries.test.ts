import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { dump } from 'js-yaml';
import { ClaudeNativeClient, CopilotNativeClient } from '../../../src/core/native/index.js';
import { addMarketplace } from '../../../src/core/marketplace.js';
import { syncUserWorkspace } from '../../../src/core/sync.js';
import { resetUpdatePromptMocks, updateNoteMock, updateSelectMock, updateSelectResponses } from '../../helpers/clack-prompts-mock.js';

const { runPlugins, runUpdateAllPlugins } = await import('../../../src/cli/tui/actions/plugins.js');
const source = 'review@market';
let root: string;
let home: string;
let workspace: string;
let restorers: Array<() => void>;

function context(project = false) {
  return { hasWorkspace: project, workspacePath: project ? workspace : null, projectPluginCount: project ? 1 : 0, userPluginCount: 2, needsSync: false, hasUserConfig: true, marketplaceCount: 0 };
}
function liveVersion(client: string) { return join(root, `${client}-version`); }
async function config(path: string, clients: unknown[], plugins: unknown[]) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, dump({ version: 2, repositories: [], clients, plugins }));
}
function git(path: string, args: string[]) {
  const result = Bun.spawnSync(['git', '-C', path, ...args], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

beforeEach(async () => {
  resetUpdatePromptMocks();
  root = await mkdtemp(join(tmpdir(), 'allagents-native-boundaries-'));
  home = join(root, 'home');
  workspace = join(root, 'workspace');
  await mkdir(home);
  await mkdir(workspace);
  restorers = [];
  const env = { HOME: home, USERPROFILE: home, ALLAGENTS_TEST_HOME: home, GIT_CONFIG_GLOBAL: join(root, 'gitconfig') };
  for (const [key, value] of Object.entries(env)) {
    const before = process.env[key];
    process.env[key] = value;
    restorers.push(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  }
  await writeFile(process.env.GIT_CONFIG_GLOBAL!, '');
  // Model live native backends at their inspection/mutation boundary. Use real
  // source resolution, configuration, sync, state checkpoints and TUI routing.
  for (const Class of [ClaudeNativeClient, CopilotNativeClient]) {
    const available = spyOn(Class.prototype, 'isAvailable').mockResolvedValue(true);
    const inspect = spyOn(Class.prototype, 'inspect').mockImplementation(async (ctx) => {
      const resource = new Class().resolveSource(source, ctx).resource;
      if (!resource) throw new Error('Fixture native source rejected');
      return { success: true, resources: [resource] };
    });
    const update = spyOn(Class.prototype, 'update').mockImplementation(async (_desired, _current, ctx) => {
      await writeFile(liveVersion(ctx.client), '2');
      return { success: true };
    });
    restorers.push(() => available.mockRestore(), () => inspect.mockRestore(), () => update.mockRestore());
  }
  await writeFile(liveVersion('claude'), '1');
  await writeFile(liveVersion('copilot'), '1');
});
afterEach(async () => {
  for (const restore of restorers.reverse()) restore();
  await rm(root, { recursive: true, force: true });
});

test('selecting the second same-source native declaration updates only its destination', async () => {
  await config(join(home, '.allagents', 'workspace.yaml'), [
    { name: 'claude', install: 'native' }, { name: 'copilot', install: 'native' },
  ], [{ source, clients: ['claude'] }, { source, clients: ['copilot'] }]);
  expect((await syncUserWorkspace({ offline: true })).success).toBe(true);
  updateSelectResponses.push(`user:${source}\0${1}`, 'update', 'back', '__back__');
  await runPlugins(context());
  expect(await readFile(liveVersion('copilot'), 'utf8')).toBe('2');
  expect(await readFile(liveVersion('claude'), 'utf8')).toBe('1');
  expect(updateNoteMock).toHaveBeenCalledWith(`✓ ${source} (updated)`, 'Update');
});

test('selected native update is not blocked by an unselected sibling inspection failure', async () => {
  await config(join(home, '.allagents', 'workspace.yaml'), [
    { name: 'claude', install: 'native' }, { name: 'copilot', install: 'native' },
  ], [{ source, clients: ['claude'] }, { source, clients: ['copilot'] }]);
  expect((await syncUserWorkspace({ offline: true })).success).toBe(true);
  const inspect = spyOn(ClaudeNativeClient.prototype, 'inspect');
  updateSelectResponses.push(`user:${source}\0${1}`, 'update', 'back', '__back__');
  updateSelectMock.mockImplementation(async () => {
    const response = updateSelectResponses.shift() ?? '__back__';
    if (response === 'update') inspect.mockResolvedValue({ success: false, resources: [], error: 'sibling inspection failed' });
    return response;
  });
  try {
    await runPlugins(context());
    expect(await readFile(liveVersion('copilot'), 'utf8')).toBe('2');
    expect(await readFile(liveVersion('claude'), 'utf8')).toBe('1');
    expect(updateNoteMock).toHaveBeenCalledWith(`✓ ${source} (updated)`, 'Update');
  } finally {
    updateSelectMock.mockImplementation(async () => updateSelectResponses.shift() ?? '__back__');
  }
});

test('bulk maintenance still updates both native destinations sharing a source', async () => {
  await config(join(home, '.allagents', 'workspace.yaml'), [
    { name: 'claude', install: 'native' }, { name: 'copilot', install: 'native' },
  ], [{ source, clients: ['claude'] }, { source, clients: ['copilot'] }]);
  expect((await syncUserWorkspace({ offline: true })).success).toBe(true);
  await runUpdateAllPlugins(context());
  expect(await readFile(liveVersion('copilot'), 'utf8')).toBe('2');
  expect(await readFile(liveVersion('claude'), 'utf8')).toBe('2');
});

test('bulk mixed native success cannot erase a file-source refresh failure', async () => {
  const remote = join(root, 'remote');
  await mkdir(join(remote, '.claude-plugin'), { recursive: true });
  await mkdir(join(remote, 'plugins', 'review', 'skills', 'work'), { recursive: true });
  await writeFile(join(remote, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'market', owner: { name: 'fixture' }, plugins: [{ name: 'review', source: './plugins/review' }] }));
  await writeFile(join(remote, 'plugins', 'review', 'skills', 'work', 'SKILL.md'), '---\nname: work\ndescription: fixture\n---\nOld usable cache\n');
  git(remote, ['init', '-b', 'main']);
  git(remote, ['config', '--local', 'user.name', 'Fixture']);
  git(remote, ['config', '--local', 'user.email', 'fixture@example.test']);
  git(remote, ['add', '.']);
  git(remote, ['commit', '-m', 'fixture']);
  await writeFile(process.env.GIT_CONFIG_GLOBAL!, `[url "file://${remote}"]\n\tinsteadOf = https://github.com/example/native-market.git\n`);
  expect((await addMarketplace('example/native-market')).success).toBe(true);
  await config(join(home, '.allagents', 'workspace.yaml'), [
    { name: 'claude', install: 'native' }, { name: 'codex', install: 'file' },
  ], [source]);
  expect((await syncUserWorkspace({ offline: true })).success).toBe(true);
  const skill = join(home, '.codex', 'skills', 'work', 'SKILL.md');
  const before = await readFile(skill, 'utf8');
  await rm(remote, { recursive: true });
  await runUpdateAllPlugins(context());
  expect(await readFile(liveVersion('claude'), 'utf8')).toBe('2');
  expect(await readFile(skill, 'utf8')).toBe(before);
  const result = updateNoteMock.mock.calls.find(([, title]) => title === 'Update Results')?.[0];
  expect(result).toContain(`✗ ${source} (failed)`);
  expect(result).not.toContain(`✓ ${source} (updated)`);
});

test('bulk results retain an independent user synchronization failure after a project source failure', async () => {
  const file = join(root, 'file-plugin');
  await mkdir(join(file, 'skills', 'work'), { recursive: true });
  await writeFile(join(file, 'skills', 'work', 'SKILL.md'), '---\nname: work\ndescription: fixture\n---\nContent\n');
  await config(join(home, '.allagents', 'workspace.yaml'), [{ name: 'codex', install: 'file' }], [file]);
  await config(join(workspace, '.allagents', 'workspace.yaml'), [{ name: 'codex', install: 'file' }], ['missing@unregistered']);
  await writeFile(join(home, '.codex'), 'blocks destination directory');
  await runUpdateAllPlugins(context(true));
  const result = updateNoteMock.mock.calls.find(([, title]) => title === 'Update Results')?.[0];
  expect(result).toContain('missing@unregistered (failed)');
  expect(result).toContain('user synchronization (failed)');
  expect(result).toContain('Failed: 2');
});
