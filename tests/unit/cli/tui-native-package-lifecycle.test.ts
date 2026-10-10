import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import { resetUpdatePromptMocks, spinnerStopMock, updateNoteMock, updateSelectResponses } from '../../helpers/clack-prompts-mock.js';
import { syncUserWorkspace } from '../../../src/core/sync.js';
import { getWorkspaceStatus } from '../../../src/core/status.js';

const { runPlugins, runUpdateAllPlugins } = await import('../../../src/cli/tui/actions/plugins.js');
const source = 'npm:pi-coexist-fixture@latest';
const other = 'npm:pi-unrelated-fixture@1.0.0';
let root: string;
let home: string;
let fileSource: string;
let restoreEnv: () => void;

const fakePi = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const [operation, source] = process.argv.slice(2);
if (operation === '--version') { console.log('0.85.1'); process.exit(0); }
const root = process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME, '.pi', 'agent');
const settingsPath = path.join(root, 'settings.json');
const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : { packages: [] };
const name = source.replace(/^npm:/, '').split('@')[0];
const packageRoot = path.join(root, 'npm', 'node_modules', name);
const manifest = path.join(packageRoot, 'package.json');
if (operation === 'update' && fs.existsSync(path.join(root, 'fail-update'))) { console.error('fixture update refused'); process.exit(37); }
if (operation === 'remove') {
  settings.packages = settings.packages.filter(entry => entry !== source);
  fs.rmSync(packageRoot, { recursive: true, force: true });
} else if (operation === 'install' || operation === 'update') {
  const version = operation === 'update' ? '2.0.0' : '1.0.0';
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({ name, version, pi: { skills: [] } }));
  if (!settings.packages.includes(source)) settings.packages.push(source);
} else { console.error('unsupported fixture operation'); process.exit(38); }
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings));
`;

function context() {
  return { hasWorkspace: false, workspacePath: null, projectPluginCount: 0, userPluginCount: 3, needsSync: false, hasUserConfig: true, marketplaceCount: 0 };
}
async function version(name: string) {
  return JSON.parse(await readFile(join(home, '.pi', 'agent', 'npm', 'node_modules', name, 'package.json'), 'utf8')).version;
}
async function codexSkill() {
  return readFile(join(home, '.codex', 'skills', 'ce-work', 'SKILL.md'), 'utf8');
}

beforeEach(async () => {
  resetUpdatePromptMocks();
  root = await mkdtemp(join(tmpdir(), 'allagents-tui-native-lifecycle-'));
  home = join(root, 'home');
  const bin = join(root, 'bin');
  fileSource = join(root, 'compound-engineering-plugin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'pi'), fakePi);
  await chmod(join(bin, 'pi'), 0o755);
  const overrides = { HOME: home, USERPROFILE: home, ALLAGENTS_TEST_HOME: home, PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'), PATH: `${bin}:${process.env.PATH}` };
  const originals = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  restoreEnv = () => {
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  await mkdir(join(fileSource, 'skills', 'ce-work'), { recursive: true });
  await writeFile(join(fileSource, 'skills', 'ce-work', 'SKILL.md'), '---\nname: ce-work\ndescription: Codex fixture\n---\nCodex content\n');
  await mkdir(join(home, '.allagents'), { recursive: true });
  await mkdir(join(home, '.pi', 'agent'), { recursive: true });
  await writeFile(join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({ packages: [], sentinel: 'preserve' }));
  await writeFile(join(home, '.allagents', 'workspace.yaml'), dump({
    version: 2, repositories: [], clients: ['pi:native', 'codex'],
    plugins: [{ source, clients: ['pi'] }, { source: other, clients: ['pi'] }, { source: fileSource, clients: ['codex'] }],
  }));
  const result = await syncUserWorkspace({ offline: true });
  expect(result.success).toBe(true);
});

afterEach(async () => {
  restoreEnv?.();
  await rm(root, { recursive: true, force: true });
});

test('native detail Update changes only the selected package and reports the real result', async () => {
  const codexBefore = await codexSkill();
  updateSelectResponses.push(`user:${source}`, 'update', 'back', '__back__');
  await runPlugins(context());
  expect(await version('pi-coexist-fixture')).toBe('2.0.0');
  expect(await version('pi-unrelated-fixture')).toBe('1.0.0');
  expect(await codexSkill()).toBe(codexBefore);
  expect(spinnerStopMock).toHaveBeenCalledWith('Updated');
  expect(updateNoteMock).toHaveBeenCalledWith(`✓ ${source} (updated)`, 'Update');
  const status = await getWorkspaceStatus(root);
  expect(status.userPlugins?.find(plugin => plugin.source === source)).toMatchObject({ type: 'package', available: true, path: '' });
});

test('native update failure is truthful and a later retry can succeed', async () => {
  const marker = join(home, '.pi', 'agent', 'fail-update');
  await writeFile(marker, 'fail');
  updateSelectResponses.push(`user:${source}`, 'update', 'back', '__back__');
  await runPlugins(context());
  expect(await version('pi-coexist-fixture')).toBe('1.0.0');
  expect(spinnerStopMock).toHaveBeenCalledWith('Update failed');
  expect(spinnerStopMock).not.toHaveBeenCalledWith('Already up to date');
  expect(updateNoteMock.mock.calls.some(([message]) => String(message).includes('fixture update refused'))).toBe(true);
  await rm(marker);
  resetUpdatePromptMocks();
  updateSelectResponses.push(`user:${source}`, 'update', 'back', '__back__');
  await runPlugins(context());
  expect(await version('pi-coexist-fixture')).toBe('2.0.0');
  expect(await version('pi-unrelated-fixture')).toBe('1.0.0');
});

test('updating the file plugin does not update coexisting native packages', async () => {
  const before = await codexSkill();
  updateSelectResponses.push(`user:${fileSource}`, 'update', 'back', '__back__');
  await runPlugins(context());
  expect(await version('pi-coexist-fixture')).toBe('1.0.0');
  expect(await version('pi-unrelated-fixture')).toBe('1.0.0');
  expect(await codexSkill()).toBe(before);
});

test('cancelling native removal preserves both declarations and installations', async () => {
  const configPath = join(home, '.allagents', 'workspace.yaml');
  const before = await readFile(configPath, 'utf8');
  updateSelectResponses.push(`user:${source}`, 'remove', 'back', '__back__');
  await runPlugins(context());
  expect(await readFile(configPath, 'utf8')).toBe(before);
  expect(await version('pi-coexist-fixture')).toBe('1.0.0');
  expect(await codexSkill()).toContain('Codex content');
});

test('bulk update performs native updates rather than reporting them as skipped', async () => {
  const codexBefore = await codexSkill();
  await runUpdateAllPlugins(context());
  expect(await version('pi-coexist-fixture')).toBe('2.0.0');
  expect(await version('pi-unrelated-fixture')).toBe('2.0.0');
  expect(await codexSkill()).toBe(codexBefore);
  expect(updateNoteMock.mock.calls.some(([message]) => String(message).includes('Updated: 2  Skipped: 1  Failed: 0'))).toBe(true);
});
