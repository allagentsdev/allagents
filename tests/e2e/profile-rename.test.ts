import { afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const repo = join(import.meta.dir, '../..');
const cli = join(repo, 'dist/index.js');
const fixtureTimeout = 30_000;
const fixtureYaml = [
  '# User workspace',
  'profiles:',
  "    'work': # Keep this declaration comment",
  '        clients:',
  '            - name: codex',
  '              launcher: run-codex',
  '            - name: opencode',
  '              launcher: run-opencode',
  '    spare: {clients: [{name: omp}]} # Leave this syntax alone',
  '',
].join('\n');

let root: string;
let home: string;
let workspace: string;
let profiles: string;
let project: string;
let bin: string;
let env: NodeJS.ProcessEnv;

function read(path: string) {
  return readFileSync(path, 'utf8');
}

function run(args: string[], overrides: NodeJS.ProcessEnv = {}) {
  return Bun.spawnSync(['node', cli, ...args], {
    cwd: project,
    env: { ...env, ...overrides },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

function json(args: string[], exitCode = 0) {
  const result = run(['--json', ...args]);
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(exitCode);
  return JSON.parse(result.stdout.toString());
}

function seedFile(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

beforeAll(() => {
  const result = Bun.spawnSync(['bun', 'run', 'build'], { cwd: repo });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'allagents-profile-rename-'));
  home = join(root, 'home');
  workspace = join(home, '.allagents', 'workspace.yaml');
  profiles = join(home, '.allagents', 'profiles');
  project = join(root, 'project');
  bin = join(home, '.local', 'bin');
  mkdirSync(project);
  mkdirSync(bin, { recursive: true });
  // The version probe and generated launcher invoke the local fixture executable.
  writeFileSync(join(bin, 'codex'), [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "codex-cli 99.0.0"; exit; fi',
    'if [ "$1" = "plugin" ]; then echo "add list marketplace remove"; exit; fi',
    'printf "%s\\n" "$CODEX_HOME" "$@"',
    '',
  ].join('\n'), { mode: 0o755 });
  writeFileSync(join(bin, 'copilot'), '#!/bin/sh\necho "GitHub Copilot CLI 99.0.0"\n', { mode: 0o755 });
  env = {
    ...process.env,
    ALLAGENTS_TEST_HOME: home,
    HOME: home,
    USERPROFILE: home,
    PATH: `${bin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
    CI: '1',
  };
  seedFile(workspace, fixtureYaml);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test('previews a declared-only rename and requires confirmation before changing YAML', () => {
  const dryRun = json(['profile', 'rename', 'spare', 'backup', '--dry-run']);
  expect(dryRun.data).toMatchObject({
    status: 'planned',
    profile: 'spare',
    newProfile: 'backup',
    installed: false,
    steps: [{ kind: 'workspace', from: workspace, to: workspace }],
  });
  expect(json(['profile', 'rename', 'spare', 'backup'], 2).error).toContain('--yes');
  expect(read(workspace)).toBe(fixtureYaml);
  expect(existsSync(profiles)).toBe(false);
  expect(existsSync(`${workspace}.profile-rename.json`)).toBe(false);

  expect(json(['profile', 'rename', 'spare', 'backup', '--yes']).data.status).toBe('renamed');
  expect(read(workspace)).toBe(fixtureYaml.replace('    spare:', '    backup:'));
  expect(existsSync(profiles)).toBe(false);
}, fixtureTimeout);

test.skipIf(process.platform === 'win32')('moves installed data and updates state and the stable launcher through the built CLI', () => {
  expect(json(['profile', 'install', 'work', '--yes', '--offline']).success).toBe(true);
  const oldRoot = join(profiles, 'work');
  const newRoot = join(profiles, 'office');
  const oldClient = join(oldRoot, 'clients', 'codex', 'home');
  const newClient = join(newRoot, 'clients', 'codex', 'home');
  seedFile(join(oldClient, 'sessions/rollout.jsonl'), 'session history');
  seedFile(join(oldClient, 'auth.json'), 'auth fixture');
  seedFile(join(oldRoot, 'oauth-proxy/service/tokens.json'), 'proxy auth fixture');
  seedFile(join(oldRoot, 'clients/opencode/config/user-notes.txt'), 'user notes');
  const oldSettings = read(join(oldClient, 'work.config.toml'));
  const launcher = join(bin, 'run-codex');
  const oldLauncher = read(launcher);
  const oldState = read(join(oldRoot, 'state.json'));

  const preview = json(['profile', 'rename', 'work', 'office', '--dry-run']);
  expect(preview.data.installed).toBe(true);
  expect(preview.data.steps.map((step: { kind: string }) => step.kind))
    .toEqual(['root', 'settings', 'launcher', 'launcher', 'state', 'workspace']);
  expect(existsSync(newRoot)).toBe(false);
  expect(read(launcher)).toBe(oldLauncher);
  expect(read(join(oldRoot, 'state.json'))).toBe(oldState);
  expect(read(workspace)).toBe(fixtureYaml);

  expect(json(['profile', 'rename', 'work', 'office', '--yes']).data.status).toBe('renamed');
  expect(existsSync(oldRoot)).toBe(false);
  expect(read(workspace)).toBe(fixtureYaml.replace("'work':", "'office':"));
  expect(read(join(newClient, 'office.config.toml'))).toBe(oldSettings);
  expect(existsSync(join(newClient, 'work.config.toml'))).toBe(false);
  expect(read(join(newClient, 'sessions/rollout.jsonl'))).toBe('session history');
  expect(read(join(newClient, 'auth.json'))).toBe('auth fixture');
  expect(read(join(newRoot, 'oauth-proxy/service/tokens.json'))).toBe('proxy auth fixture');
  expect(read(join(newRoot, 'clients/opencode/config/user-notes.txt'))).toBe('user notes');
  const launched = Bun.spawnSync([launcher, 'user-arg'], { env });
  expect(launched.exitCode).toBe(0);
  expect(launched.stdout.toString().trim().split('\n')).toEqual([newClient, '--profile', 'office', 'user-arg']);
  expect(read(join(bin, 'run-opencode'))).toContain(join(newRoot, 'clients/opencode/config'));
  expect(json(['profile', 'status', 'office']).data.status).toBe('installed');
  expect(json(['update', '--profile', 'office', '--offline']).success).toBe(true);
  expect(read(join(newClient, 'sessions/rollout.jsonl'))).toBe('session history');
}, fixtureTimeout);

test.skipIf(process.platform === 'win32')('refuses on declaration, directory, settings, launcher, or symlink conflicts before moving data', () => {
  json(['profile', 'install', 'work', '--yes', '--offline']);
  const oldRoot = join(profiles, 'work');
  const newRoot = join(profiles, 'office');
  const client = join(oldRoot, 'clients/codex/home');
  const state = read(join(oldRoot, 'state.json'));
  const firstLauncher = join(bin, 'run-codex');
  const secondLauncher = join(bin, 'run-opencode');
  const firstLauncherContent = read(firstLauncher);
  function reject(error: string) {
    expect(json(['profile', 'rename', 'work', 'office', '--yes'], 1).error).toContain(error);
    expect(read(workspace)).toBe(fixtureYaml);
    expect(read(join(oldRoot, 'state.json'))).toBe(state);
    expect(read(firstLauncher)).toBe(firstLauncherContent);
    expect(existsSync(`${workspace}.profile-rename.json`)).toBe(false);
  }

  expect(json(['profile', 'rename', 'work', 'spare', '--yes'], 1).error).toContain('already declared');
  mkdirSync(newRoot);
  reject('destination already exists');
  rmSync(newRoot, { recursive: true });

  const conflictingSettings = join(client, 'office.config.toml');
  seedFile(conflictingSettings, 'user settings');
  reject('destination already exists');
  expect(read(conflictingSettings)).toBe('user settings');
  rmSync(conflictingSettings);

  symlinkSync(workspace, join(client, 'link'));
  reject('Unsafe profile entry');
  rmSync(join(client, 'link'));

  seedFile(join(client, 'state_5.sqlite'), 'session database fixture');
  reject('session database require a separate migration');
  rmSync(join(client, 'state_5.sqlite'));

  seedFile(join(client, 'plugins/registry.toml'), 'native registry fixture');
  reject('has native data');
  rmSync(join(client, 'plugins'), { recursive: true });

  seedFile(secondLauncher, 'user launcher');
  reject('modified');
  expect(read(secondLauncher)).toBe('user launcher');
  expect(existsSync(newRoot)).toBe(false);
}, fixtureTimeout);

test.skipIf(process.platform === 'win32')('rejects an installed client without a rename implementation', () => {
  const config = 'profiles: {work: {clients: [{name: copilot}]}}\n';
  seedFile(workspace, config);
  json(['profile', 'install', 'work', '--yes', '--offline']);
  expect(json(['profile', 'rename', 'work', 'office', '--yes'], 1).error)
    .toContain("Installed profile rename is unsupported for 'copilot'");
  expect(read(workspace)).toBe(config);
  expect(existsSync(join(profiles, 'work', 'state.json'))).toBe(true);
  expect(existsSync(join(profiles, 'office'))).toBe(false);
}, fixtureTimeout);

test.skipIf(process.platform === 'win32')('resumes after a process stop before publishing the declaration', () => {
  json(['profile', 'install', 'work', '--yes', '--offline']);
  const oldRoot = join(profiles, 'work');
  const newRoot = join(profiles, 'office');
  const journal = `${workspace}.profile-rename.json`;
  const session = 'clients/codex/home/sessions/recover.jsonl';
  seedFile(join(oldRoot, session), 'keep me');
  const preload = join(root, 'stop-before-workspace.cjs');
  writeFileSync(preload, [
    'const fs = require("node:fs/promises");',
    'const rename = fs.rename;',
    'fs.rename = (from, to) => to === process.env.TEST_WORKSPACE',
    '  ? process.kill(process.pid, "SIGKILL") : rename(from, to);',
    'require("node:module").syncBuiltinESMExports();',
  ].join('\n'));
  const interrupted = run(['--json', 'profile', 'rename', 'work', 'office', '--yes'], {
    NODE_OPTIONS: `--require="${preload}"`,
    TEST_WORKSPACE: workspace,
  });
  expect(interrupted.signalCode).toBe('SIGKILL');
  expect(read(workspace)).toBe(fixtureYaml);
  expect(existsSync(journal)).toBe(true);
  expect(existsSync(oldRoot)).toBe(false);
  expect(read(join(newRoot, session))).toBe('keep me');
  expect(json(['profile', 'install', 'work', '--yes'], 1).error).toContain('rename is incomplete');

  const preview = json(['profile', 'rename', 'work', 'office', '--dry-run']);
  expect(preview.data.recovering).toBe(true);
  expect(read(workspace)).toBe(fixtureYaml);
  expect(json(['profile', 'rename', 'work', 'office', '--yes']).data.recovering).toBe(true);
  expect(read(workspace)).toBe(fixtureYaml.replace("'work':", "'office':"));
  expect(read(join(newRoot, session))).toBe('keep me');
  expect(existsSync(journal)).toBe(false);
  expect(readdirSync(dirname(workspace)).sort()).toEqual(['profiles', 'workspace.yaml']);
  expect(json(['profile', 'status', 'office']).data.status).toBe('installed');
}, fixtureTimeout);
