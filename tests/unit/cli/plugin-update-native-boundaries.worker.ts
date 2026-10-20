import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from 'cmd-ts';
import { stringify as dump } from 'yaml';
import { PiNativeClient } from '../../../src/core/native/index.js';
import { syncUserWorkspace } from '../../../src/core/sync.js';
import { parseRemotePluginSource, withPluginSourceRef } from '../../../src/utils/plugin-path.js';
import { pluginCmd } from '../../../src/cli/commands/plugin.js';
import { setJsonMode } from '../../../src/cli/json-output.js';

let root: string;
let home: string;
let source: string;
let restores: Array<() => void>;
let output: string[];
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, PATH: `/usr/bin:${process.env.PATH}` }, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}
async function configure(plugins: unknown[]) {
  await mkdir(join(home, '.allagents'), { recursive: true });
  await writeFile(join(home, '.allagents', 'workspace.yaml'), dump({ version: 2, repositories: [], clients: ['pi', 'codex'], plugins }));
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'allagents-cli-native-boundary-'));
  home = join(root, 'home');
  await mkdir(home);
  await writeFile(join(root, 'version'), '1');
  restores = [];
  const overrides = { HOME: home, USERPROFILE: home, ALLAGENTS_TEST_HOME: home, GIT_CONFIG_GLOBAL: join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  for (const [key, value] of Object.entries(overrides)) {
    const previous = process.env[key];
    process.env[key] = value;
    restores.push(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  await writeFile(join(root, 'gitconfig'), '');
  source = 'ssh://git@git.example.invalid:2222/team/skills.git';
  const available = spyOn(PiNativeClient.prototype, 'isAvailable').mockResolvedValue(true);
  const inspect = spyOn(PiNativeClient.prototype, 'inspect').mockImplementation(async (context) => {
    const resource = new PiNativeClient().resolveSource(source, context).resource;
    if (!resource) throw new Error('Fixture native source rejected');
    return { success: true, resources: [resource] };
  });
  const update = spyOn(PiNativeClient.prototype, 'update').mockImplementation(async () => {
    await writeFile(join(root, 'version'), '2');
    return { success: true };
  });
  restores.push(() => available.mockRestore(), () => inspect.mockRestore(), () => update.mockRestore());
  output = [];
  const log = spyOn(console, 'log').mockImplementation((value) => output.push(String(value)));
  const exit = spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`CLI exit ${code}: ${output.join('\n')}`); });
  restores.push(() => log.mockRestore(), () => exit.mockRestore());
  setJsonMode(true);
});
afterEach(async () => {
  setJsonMode(false);
  for (const restore of restores.reverse()) restore();
  await rm(root, { recursive: true, force: true });
});

test('targeting a file ref reconciles files without updating its native sibling', async () => {
  const upstream = join(root, 'upstream');
  await mkdir(join(upstream, 'skills', 'fixture'), { recursive: true });
  await writeFile(join(upstream, 'skills', 'fixture', 'SKILL.md'), '---\nname: fixture\ndescription: fixture\n---\ncontent\n');
  git(upstream, 'init', '--initial-branch=main');
  git(upstream, 'config', '--local', 'user.name', 'Fixture');
  git(upstream, 'config', '--local', 'user.email', 'fixture@example.invalid');
  git(upstream, 'add', '.'); git(upstream, 'commit', '-m', 'fixture'); git(upstream, 'tag', 'v1');
  await writeFile(join(root, 'gitconfig'), `[url "file://${upstream}"]\n\tinsteadOf = ${source}\n`);
  const effectiveSource = withPluginSourceRef(source, 'v1');
  const remote = parseRemotePluginSource(effectiveSource);
  if (!remote) throw new Error('Fixture file source rejected');
  git(root, 'clone', '--branch', 'v1', source, remote.cachePath);
  await configure([{ source, install: 'native', clients: ['pi'] }, { source, ref: 'v1', install: 'file', clients: ['codex'] }]);
  expect((await syncUserWorkspace({ offline: true })).success).toBe(true);
  await rm(join(home, '.codex', 'skills', 'fixture'), { recursive: true });
  output = [];
  await run(pluginCmd, ['update', effectiveSource, '--scope', 'user']);
  expect(await readFile(join(root, 'version'), 'utf8')).toBe('1');
  expect(await readFile(join(home, '.codex', 'skills', 'fixture', 'SKILL.md'), 'utf8')).toContain('content');
  expect(JSON.parse(output.at(-1) ?? '')).toMatchObject({ success: true, data: { results: [{ plugin: source, success: true }] } });
});

test('a selected native source still updates its lifecycle and reports the configured source', async () => {
  await configure([{ source, clients: ['pi:native'] }]);
  expect((await syncUserWorkspace({ offline: true })).success).toBe(true);
  output = [];
  await run(pluginCmd, ['update', source, '--scope', 'user']);
  expect(await readFile(join(root, 'version'), 'utf8')).toBe('2');
  expect(JSON.parse(output.at(-1) ?? '')).toMatchObject({ success: true, data: { results: [{ plugin: source, success: true, action: 'updated' }] } });
});
