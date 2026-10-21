import { afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

const cli = join(import.meta.dir, '../../dist/index.js');

beforeAll(() => {
  const build = Bun.spawnSync(['bun', 'run', 'build'], {
    cwd: join(import.meta.dir, '../..'),
    stdout: 'pipe', stderr: 'pipe',
  });
  if (build.exitCode !== 0) throw new Error(`CLI build failed: ${build.stderr.toString()}`);
});

let root: string;
let project: string;
let home: string;
let yaml: string;
let editor: string;
let state: string;

function run(args: string[]) {
  return Bun.spawnSync(['bun', cli, ...args], {
    cwd: project,
    env: { ...process.env, HOME: home, ALLAGENTS_TEST_HOME: home, NO_COLOR: '1', ALLAGENTS_NO_UPDATE_CHECK: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'allagents-legacy-cli-'));
  project = join(root, 'project');
  home = join(root, 'home');
  mkdirSync(join(project, '.allagents'), { recursive: true });
  mkdirSync(home);
  yaml = join(project, '.allagents/workspace.yaml');
  editor = join(project, 'project.code-workspace');
  state = join(project, '.allagents/sync-state.json');
  writeFileSync(yaml, 'repositories:\n  - path: ../repo\n    name: Original\nplugins: [] # keep plugin comment\nclients: [vscode]\n');
  const initial = run(['update', '--scope', 'project', '--offline']);
  expect(initial.exitCode).toBe(0);
  const saved = JSON.parse(readFileSync(state, 'utf8'));
  delete saved.vscodeWorkspaceFolders;
  writeFileSync(state, JSON.stringify(saved));
  writeFileSync(yaml, readFileSync(yaml, 'utf8').replace('Original', 'YAML name'));
  const workspace = JSON.parse(readFileSync(editor, 'utf8'));
  workspace.folders[1].name = 'Editor name';
  writeFileSync(editor, JSON.stringify(workspace));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

for (const json of [false, true]) {
  test(`ambiguous legacy ${json ? 'JSON' : 'redirected'} update requires approval and preserves all three files`, () => {
    const before = [yaml, editor, state].map(file => readFileSync(file, 'utf8'));
    const result = run(['update', '--scope', 'project', '--offline', ...(json ? ['--json'] : [])]);
    expect(result.exitCode).toBe(1);
    expect([yaml, editor, state].map(file => readFileSync(file, 'utf8'))).toEqual(before);
    if (json) {
      const envelope = JSON.parse(result.stdout.toString());
      expect(envelope.success).toBe(false);
      expect(envelope.error).toContain('--yes');
      expect(result.stdout.toString()).not.toContain('\u001b');
    } else expect(result.stderr.toString()).toContain('--yes');
  });
}

test('--yes approves legacy VS Code precedence, retains other YAML bytes, and upgrades the baseline', () => {
  const result = run(['update', '--scope', 'project', '--offline', '--yes', '--json']);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString()).success).toBe(true);
  expect(parse(readFileSync(yaml, 'utf8')).repositories[0].name).toBe('Editor name');
  expect(readFileSync(yaml, 'utf8')).toContain('plugins: [] # keep plugin comment\nclients: [vscode]\n');
  expect(JSON.parse(readFileSync(state, 'utf8')).vscodeWorkspaceFolders).toBeDefined();
});

test.each([false, true])('plugin install --yes carries approval into its invoked project update (selected skill: %s)', selectedSkill => {
  const plugin = join(root, 'plugin');
  mkdirSync(join(plugin, 'skills/demo'), { recursive: true });
  writeFileSync(join(plugin, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: Demo\n---\n# Demo\n');
  const result = run(['plugin', 'install', plugin, '--scope', 'project', '--client', 'vscode', '--yes', '--json', ...(selectedSkill ? ['--skill', 'demo'] : [])]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString()).success).toBe(true);
  const config = parse(readFileSync(yaml, 'utf8'));
  expect(config.repositories[0].name).toBe('Editor name');
  expect(config.plugins).toHaveLength(1);
});

test('plugin install without approval keeps its explicit declaration but preserves pending editor bytes and baseline', () => {
  const plugin = join(root, 'plugin');
  mkdirSync(join(plugin, 'skills/demo'), { recursive: true });
  writeFileSync(join(plugin, 'skills/demo/SKILL.md'), '---\nname: demo\ndescription: Demo\n---\n# Demo\n');
  const before = [editor, state].map(file => readFileSync(file, 'utf8'));
  const result = run(['plugin', 'install', plugin, '--scope', 'project', '--client', 'vscode', '--json']);
  expect(result.exitCode).toBe(1);
  const envelope = JSON.parse(result.stdout.toString());
  expect(envelope.success).toBe(false);
  expect(envelope.error).toContain('--yes');
  expect([editor, state].map(file => readFileSync(file, 'utf8'))).toEqual(before);
  const config = parse(readFileSync(yaml, 'utf8'));
  expect(config.repositories[0].name).toBe('YAML name');
  expect(config.plugins).toHaveLength(1);
});
