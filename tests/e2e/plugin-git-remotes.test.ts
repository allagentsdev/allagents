import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '../..');
const cli = join(repoRoot, 'dist/index.js');
const decoder = new TextDecoder();
let root: string;
let project: string;
let home: string;
let upstream: string;
let remote: string;
let gitConfig: string;

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1', PATH: `/usr/bin:${process.env.PATH ?? ''}` },
    stdout: 'pipe', stderr: 'pipe',
  });
  if (result.exitCode !== 0) throw new Error(decoder.decode(result.stderr));
  return decoder.decode(result.stdout).trim();
}

function run(args: string[], extra: Record<string, string> = {}) {
  const result = Bun.spawnSync([cli, '--json', ...args], {
    cwd: project,
    env: {
      ...process.env,
      HOME: home, USERPROFILE: home, ALLAGENTS_TEST_HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1',
      PATH: `/usr/bin:${process.env.PATH ?? ''}`,
      GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1', ...extra,
    },
    stdout: 'pipe', stderr: 'pipe',
  });
  return { exit: result.exitCode, stdout: decoder.decode(result.stdout), stderr: decoder.decode(result.stderr) };
}

function content(version: string) {
  return `---\nname: fixture\ndescription: Git remote fixture\n---\n${version}\n`;
}

function artifact(client: string) {
  return join(project, `.${client}`, 'skills', 'fixture', 'SKILL.md');
}

function sources() {
  return JSON.parse(readFileSync(join(project, '.allagents', 'sync-state.json'), 'utf8')).sources;
}

beforeAll(() => {
  const result = Bun.spawnSync(['bun', 'run', 'build'], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(decoder.decode(result.stderr));
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'allagents-git-remote-'));
  project = join(root, 'project'); home = join(root, 'home');
  upstream = join(root, 'upstream'); remote = join(root, 'remote.git');
  gitConfig = join(root, 'gitconfig');
  for (const path of [project, home, upstream, join(project, '.allagents')]) mkdirSync(path, { recursive: true });
  writeFileSync(gitConfig, '');
  git(upstream, 'init', '--initial-branch=main');
  git(upstream, 'config', '--local', 'user.name', 'Git fixture');
  git(upstream, 'config', '--local', 'user.email', 'fixture@example.invalid');
  for (const name of ['fixture', 'unselected']) {
    const path = join(upstream, 'collection', name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'SKILL.md'), name === 'fixture' ? content('one') : '---\nname: unselected\ndescription: unselected\n---\n');
  }
  git(upstream, 'add', 'collection'); git(upstream, 'commit', '-m', 'initial fixture');
  git(upstream, 'tag', 'v1');
  git(root, 'clone', '--bare', upstream, remote);
  writeFileSync(gitConfig, `[url "file://${remote}"]\n\tinsteadOf = ssh://git@git.example.invalid:2222/team/skills.git\n\tinsteadOf = git@git.example.invalid:team/skills.git\n\tinsteadOf = https://git.example.invalid/team/skills.git\n`);
  writeFileSync(join(project, '.allagents', 'workspace.yaml'), 'version: 2\nrepositories: []\nclients: [codex, pi]\nplugins: []\n');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('file-mode Git remotes through the built CLI', () => {
  for (const transport of [
    'ssh://git@git.example.invalid:2222/team/skills.git',
    'git@git.example.invalid:team/skills.git',
    'https://git.example.invalid/team/skills.git',
  ]) {
    test(`installs, refreshes and removes selected skills from ${transport}`, () => {
      const source = `${transport}#subdir=collection&ref=main`;
      const installed = run(['plugin', 'install', source, '--scope', 'project', '--client', 'codex,pi', '--skill', 'fixture', '--yes']);
      expect(installed.stdout).not.toContain('Plugin not found at');
      expect(installed.exit, installed.stdout + installed.stderr).toBe(0);
      for (const client of ['codex', 'pi']) {
        expect(readFileSync(artifact(client), 'utf8')).toBe(content('one'));
        expect(existsSync(join(project, `.${client}`, 'skills', 'unselected'))).toBe(false);
      }
      const initialSha = git(upstream, 'rev-parse', 'HEAD');
      expect(Object.values(sources())).toContainEqual(expect.objectContaining({ resolvedSha: initialSha, requestedRef: 'main' }));

      const ownedByUser = join(project, '.codex', 'skills', 'user-owned', 'SKILL.md');
      mkdirSync(join(project, '.codex', 'skills', 'user-owned'), { recursive: true });
      writeFileSync(ownedByUser, 'user-owned\n');
      writeFileSync(join(upstream, 'collection', 'fixture', 'SKILL.md'), content('two'));
      git(upstream, 'add', 'collection'); git(upstream, 'commit', '-m', 'advance fixture');
      git(upstream, 'push', remote, 'main');
      const updated = run(['plugin', 'update', '--scope', 'project']);
      expect(updated.exit).toBe(0);
      for (const client of ['codex', 'pi']) expect(readFileSync(artifact(client), 'utf8')).toBe(content('two'));
      expect(Object.values(sources())).toContainEqual(expect.objectContaining({ resolvedSha: git(upstream, 'rev-parse', 'HEAD') }));
      expect(run(['plugin', 'update', '--scope', 'project']).exit).toBe(0);
      const status = run(['status']);
      expect(status.exit).toBe(0);
      expect(status.stdout).toContain('"available": true');

      rmSync(remote, { recursive: true, force: true });
      const offline = run(['workspace', 'sync', '--offline']);
      expect(offline.exit).toBe(0);
      expect(readFileSync(artifact('codex'), 'utf8')).toBe(content('two'));
      expect(run(['plugin', 'uninstall', source, '--scope', 'project']).exit).toBe(0);
      expect(existsSync(artifact('codex'))).toBe(false);
      expect(readFileSync(ownedByUser, 'utf8')).toBe('user-owned\n');
    }, 30_000);
  }

  test('uses an object ref and keeps a tagged checkout separate from default HEAD', () => {
    const source = 'ssh://git@git.example.invalid:2222/team/skills.git#subdir=collection';
    writeFileSync(join(upstream, 'collection', 'fixture', 'SKILL.md'), content('two'));
    git(upstream, 'add', 'collection'); git(upstream, 'commit', '-m', 'advance'); git(upstream, 'push', remote, 'main');
    writeFileSync(join(project, '.allagents', 'workspace.yaml'), `version: 2\nrepositories: []\nclients: [codex, pi]\nplugins:\n  - source: '${source}'\n    install: file\n    ref: v1\n    skills: [fixture]\n`);
    const synced = run(['workspace', 'sync']);
    expect(synced.exit).toBe(0);
    expect(readFileSync(artifact('codex'), 'utf8')).toBe(content('one'));
    expect(run(['plugin', 'update', '--scope', 'project']).exit).toBe(0);
    expect(readFileSync(artifact('codex'), 'utf8')).toBe(content('one'));
    expect(Object.values(sources())).toContainEqual(expect.objectContaining({ requestedRef: 'v1', resolvedSha: git(upstream, 'rev-parse', 'v1') }));
    writeFileSync(join(project, '.allagents', 'workspace.yaml'), `version: 2\nrepositories: []\nclients: [codex, pi]\nplugins:\n  - source: '${source}'\n    install: file\n    ref: v1\n    skills: [fixture]\n  - source: '${source}'\n    install: file\n    skills: [unselected]\n`);
    expect(run(['workspace', 'sync']).exit).toBe(0);
    const cacheRoot = join(home, '.allagents', 'plugins', 'marketplaces');
    expect(readdirSync(cacheRoot).filter((name) => name.startsWith('git-')).length).toBe(2);
    expect(Object.keys(sources()).length).toBe(2);
    expect(Object.values(sources())).toContainEqual(expect.objectContaining({ resolvedSha: git(upstream, 'rev-parse', 'main') }));
  }, 30_000);

  test('lists the file selection once beside a native declaration sharing its cache', () => {
    const source = 'git@git.example.invalid:team/skills.git#subdir=collection&ref=main';
    const installed = run(['plugin', 'install', source, '--scope', 'project', '--client', 'codex', '--skill', 'fixture', '--yes']);
    expect(installed.exit, installed.stdout + installed.stderr).toBe(0);
    writeFileSync(join(project, '.allagents', 'workspace.yaml'), `version: 2\nrepositories: []\nclients: [codex, pi]\nplugins:\n  - source: '${source}'\n    install: file\n    clients: [codex]\n    skills: [fixture]\n  - source: '${source}'\n    install: native\n    clients: [pi]\n`);
    const listed = run(['skill', 'list', '--scope', 'project']);
    expect(listed.exit, listed.stdout + listed.stderr).toBe(0);
    const skills = JSON.parse(listed.stdout).data.skills;
    expect(skills).toHaveLength(2);
    expect(skills.filter((skill: { disabled: boolean }) => !skill.disabled).map((skill: { name: string }) => skill.name)).toEqual(['fixture']);
  }, 30_000);

  test('refreshes a direct GitHub HTTPS declaration with an object ref', () => {
    const source = 'https://github.com/fixture/skills';
    writeFileSync(gitConfig, readFileSync(gitConfig, 'utf8') + `[url "file://${remote}"]\n\tinsteadOf = ${source}.git\n`);
    writeFileSync(join(project, '.allagents', 'workspace.yaml'), `version: 2\nrepositories: []\nclients: [codex]\nplugins:\n  - source: '${source}'\n    ref: main\n    install: file\n    skills: [fixture]\n`);
    const synced = run(['workspace', 'sync']);
    expect(synced.exit, synced.stdout + synced.stderr).toBe(0);
    expect(readFileSync(artifact('codex'), 'utf8')).toBe(content('one'));
    writeFileSync(join(upstream, 'collection', 'fixture', 'SKILL.md'), content('two'));
    git(upstream, 'add', 'collection'); git(upstream, 'commit', '-m', 'advance HTTPS fixture'); git(upstream, 'push', remote, 'main');
    const updated = run(['plugin', 'update', '--scope', 'project']);
    expect(updated.exit, updated.stdout + updated.stderr).toBe(0);
    expect(readFileSync(artifact('codex'), 'utf8')).toBe(content('two'));
    expect(Object.values(sources())).toContainEqual(expect.objectContaining({ requestedRef: 'main', resolvedSha: git(upstream, 'rev-parse', 'main') }));
  }, 30_000);

  test('fails offline without a cache and reports remote transport failures', () => {
    const source = 'ssh://git@git.example.invalid:2222/team/skills.git';
    writeFileSync(join(project, '.allagents', 'workspace.yaml'), `version: 2\nrepositories: []\nclients: [codex]\nplugins:\n  - source: '${source}'\n    install: file\n`);
    const offline = run(['workspace', 'sync', '--offline']);
    expect(offline.exit).toBe(1);
    expect(offline.stdout.toLowerCase()).toContain('offline');
    rmSync(remote, { recursive: true, force: true });
    const failed = run(['plugin', 'install', source, '--scope', 'user', '--client', 'codex', '--yes']);
    expect(failed.exit).toBe(1);
    expect(failed.stdout).not.toContain('Plugin not found at');
    expect(failed.stdout.toLowerCase()).toMatch(/git|repository|fetch|clone/);
  }, 30_000);
});


describe('credential rejection through the built CLI', () => {
  for (const source of [
    'https://fake-token@git.example.invalid/team/skills.git',
    'https:///fake-token@git.example.invalid/team/skills.git',
    'git:https://fake-token@git.example.invalid/team/skills.git',
    'https://fake-user:fake-password@github.com/team/skills.git',
    'ssh://git:fake-password@git.example.invalid:2222/team/skills.git',
    'ssh:/git:fake-password@git.example.invalid/team/skills.git',
  ]) {
    test('rejects credentials before project/user writes or terminal output', () => {
      const config = join(project, '.allagents', 'workspace.yaml');
      const original = readFileSync(config, 'utf8');
      for (const scope of ['project', 'user']) {
        const result = run(['plugin', 'install', source, '--scope', scope, '--client', 'codex', '--yes']);
        expect(result.exit).toBe(1);
        expect(JSON.parse(result.stdout).error).toContain('credential');
        expect(result.stdout + result.stderr).not.toContain('fake');
        expect(readFileSync(config, 'utf8')).toBe(original);
        expect(existsSync(join(home, '.allagents'))).toBe(false);
      }
      writeFileSync(config, `version: 2\nrepositories: []\nclients: [codex]\nplugins:\n  - source: '${source}'\n    install: file\n`);
      for (const args of [['workspace', 'sync'], ['plugin', 'update', '--scope', 'project'], ['status'], ['plugin', 'list']]) {
        const result = run(args);
        expect(result.exit).toBe(1);
        expect(result.stdout + result.stderr).not.toContain('fake');
      }
      expect(existsSync(join(project, '.allagents', 'sync-state.json'))).toBe(false);
    });
  }
});


test('skill add rejects a padded credential source before human output', () => {
  const config = join(project, '.allagents', 'workspace.yaml');
  const original = readFileSync(config, 'utf8');
  for (const source of [' https://fake-token@git.example.invalid/team/skills.git', 'git: https://fake-token@git.example.invalid/team/skills.git', 'ssh:/git:fake-password@git.example.invalid/team/skills.git']) {
    for (const args of [['skill', 'add', 'fixture', '--from', source], ['skill', 'add', source, '--all']]) {
      const result = Bun.spawnSync([cli, ...args, '--scope', 'project', '--client', 'codex', '--yes'], {
        cwd: project,
        env: { ...process.env, ALLAGENTS_TEST_HOME: home, HOME: home, USERPROFILE: home, NO_COLOR: '1', ALLAGENTS_SKIP_UPDATE_CHECK: '1' },
        stdout: 'pipe', stderr: 'pipe',
      });
      const output = decoder.decode(result.stdout) + decoder.decode(result.stderr);
      expect(result.exitCode).toBe(1);
      expect(output).toContain('credential');
      expect(output).not.toContain('fake');
      expect(readFileSync(config, 'utf8')).toBe(original);
      expect(existsSync(join(project, '.allagents', 'sync-state.json'))).toBe(false);
    }
  }
});
