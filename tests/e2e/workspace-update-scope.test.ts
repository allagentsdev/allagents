import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { stringify as dump } from 'yaml';

const repoRoot = join(import.meta.dir, '..', '..');
const cliEntry = join(repoRoot, 'dist', 'index.js');
const decoder = new TextDecoder();

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function snapshot(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  if (!existsSync(root)) return entries;
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const key = relative(root, path);
      if (entry.isDirectory()) {
        entries[key] = 'directory';
        visit(path);
      } else if (entry.isSymbolicLink()) {
        entries[key] = `symlink:${readlinkSync(path)}`;
      } else {
        entries[key] = readFileSync(path).toString('base64');
      }
    }
  };
  visit(root);
  return entries;
}

describe('workspace update reconciliation scope (built CLI)', () => {
  let root: string;
  let home: string;
  let project: string;
  let bin: string;
  let userSource: string;
  let profileSource: string;
  let projectSource: string;

  beforeAll(() => {
    const build = Bun.spawnSync(['bun', 'run', 'build'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (build.exitCode !== 0) {
      throw new Error(`Build failed: ${decoder.decode(build.stderr)}`);
    }
  });

  beforeEach(() => {
    root = mkdtempSync(
      join(
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(),
        'allagents-scope-',
      ),
    );
    home = join(root, 'home');
    project = join(root, 'project');
    bin = join(root, 'bin');
    mkdirSync(home);
    mkdirSync(project);
    mkdirSync(bin);
    // Keep synthetic Git fixtures clear of host authentication wrappers.
    const realGit = process.env.ALLAGENTS_TEST_REAL_GIT ?? Bun.which('git');
    if (!realGit) throw new Error('Git is required for the scope fixture');
    symlinkSync(realGit, join(bin, 'git'));
    // Only file-mode resources are installed. This runtime stand-in answers
    // availability probes; the real CLI performs all profile file operations.
    write(
      join(bin, 'codex'),
      '#!/bin/sh\ncase "$*" in\n  --version) echo "codex-cli 0.149.0" ;;\n  "plugin --help") echo "add list marketplace remove" ;;\n  *) exit 1 ;;\nesac\n',
    );
    Bun.spawnSync(['chmod', '+x', join(bin, 'codex')]);
    userSource = join(root, 'user-plugin');
    profileSource = join(root, 'profile-plugin');
    projectSource = join(root, 'project-plugin');
    skill(userSource, 'user-skill', 'user v1');
    skill(profileSource, 'profile-skill', 'profile v1');
    skill(projectSource, 'project-skill', 'project v1');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function env(): Record<string, string> {
    return {
      ...process.env,
      ALLAGENTS_TEST_HOME: home,
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: join(home, '.codex'),
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
      GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      NO_COLOR: '1',
      PATH: `${bin}:${process.env.PATH ?? ''}`,
    } as Record<string, string>;
  }

  function cli(args: string[]) {
    const proc = Bun.spawnSync([cliEntry, ...args], {
      cwd: project,
      env: env(),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      exitCode: proc.exitCode,
      stdout: decoder.decode(proc.stdout),
      stderr: decoder.decode(proc.stderr),
    };
  }

  function update(args: string[] = [], command = ['update']) {
    const result = cli([...command, ...args, '--json']);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.success).toBe(true);
    expect(payload.command).toBe('workspace update');
    return payload;
  }

  function skill(source: string, name: string, contents: string): void {
    write(
      join(source, 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Scope fixture\n---\n${contents}\n`,
    );
  }

  function projectConfig(
    plugins: unknown[] = [{ source: projectSource, install: 'file' }],
    repositories: unknown[] = [],
  ): void {
    write(
      join(project, '.allagents', 'workspace.yaml'),
      dump({
        version: 2,
        clients: [
          { name: 'codex', install: 'file' },
          { name: 'pi', install: 'file' },
        ],
        repositories,
        plugins,
      }),
    );
  }

  function configuredTargets(): void {
    projectConfig();
    write(
      join(home, '.allagents', 'workspace.yaml'),
      dump({
        version: 2,
        clients: [{ name: 'codex', install: 'file' }],
        repositories: [],
        plugins: [{ source: userSource, install: 'file' }],
        profiles: {
          work: {
            clients: [
              {
                name: 'codex',
                install: 'file',
                settings: { model: 'fixture-model' },
              },
            ],
            plugins: [{ source: profileSource, install: 'file' }],
          },
        },
      }),
    );
    write(join(home, '.codex', 'config.toml'), 'model = "user-owned-model"\n');
    const install = cli([
      'profile',
      'install',
      'work',
      '--offline',
      '--yes',
      '--json',
    ]);
    expect(install.exitCode, `${install.stdout}\n${install.stderr}`).toBe(0);
    expect(JSON.parse(install.stdout).success).toBe(true);
    update(['--offline']);
    expect(readFileSync(profileSkill(), 'utf8')).toContain('profile v1');
  }

  function projectSkill(name = 'project-skill', client = 'codex'): string {
    return join(project, `.${client}`, 'skills', name, 'SKILL.md');
  }

  function userSkill(): string {
    return join(home, '.codex', 'skills', 'user-skill', 'SKILL.md');
  }

  function profileSkill(): string {
    return join(
      home,
      '.allagents',
      'profiles',
      'work',
      'clients',
      'codex',
      'home',
      'skills',
      'profile-skill',
      'SKILL.md',
    );
  }

  test('project declarations add, filter, and remove files without changing user or installed profile targets', () => {
    configuredTargets();
    skill(userSource, 'user-skill', 'user v2');
    skill(profileSource, 'profile-skill', 'profile v2');
    const userBefore = snapshot(home);
    write(projectSkill('personal'), 'user-owned project skill\n');
    skill(projectSource, 'alternative', 'alternative v1');
    projectConfig([
      { source: projectSource, install: 'file', skills: ['alternative'] },
    ]);
    const filtered = update(['--scope', 'project', '--offline']);
    expect(filtered.data.profiles).toEqual([]);
    for (const client of ['codex', 'pi']) {
      expect(existsSync(projectSkill('project-skill', client))).toBe(false);
      expect(
        readFileSync(projectSkill('alternative', client), 'utf8'),
      ).toContain('alternative v1');
    }
    expect(snapshot(home)).toEqual(userBefore);

    projectConfig([
      {
        source: projectSource,
        install: 'file',
        skills: ['alternative'],
        clients: ['pi'],
      },
    ]);
    update(['--scope', 'project', '--offline']);
    expect(existsSync(projectSkill('alternative', 'codex'))).toBe(false);
    expect(readFileSync(projectSkill('alternative', 'pi'), 'utf8')).toContain(
      'alternative v1',
    );
    expect(snapshot(home)).toEqual(userBefore);

    const addedSource = join(root, 'added-plugin');
    skill(addedSource, 'added', 'added v1');
    projectConfig([{ source: addedSource, install: 'file' }]);
    update(['--scope', 'project', '--offline'], ['workspace', 'update']);
    for (const client of ['codex', 'pi']) {
      expect(existsSync(projectSkill('alternative', client))).toBe(false);
      expect(readFileSync(projectSkill('added', client), 'utf8')).toContain(
        'added v1',
      );
    }
    expect(snapshot(home)).toEqual(userBefore);

    projectConfig([]);
    update(['--scope', 'project', '--offline'], ['workspace', 'sync']);
    for (const client of ['codex', 'pi']) {
      expect(existsSync(projectSkill('added', client))).toBe(false);
    }
    expect(readFileSync(projectSkill('personal'), 'utf8')).toBe(
      'user-owned project skill\n',
    );
    expect(snapshot(home)).toEqual(userBefore);
  });

  test('project-only update does not create a user workspace', () => {
    projectConfig();
    update(['--scope', 'project', '--offline']);
    expect(readFileSync(projectSkill(), 'utf8')).toContain('project v1');
    expect(existsSync(join(home, '.allagents'))).toBe(false);
    expect(snapshot(home)).toEqual({});
  });

  test('user scope updates user plugins and installed profiles while preserving the project', () => {
    configuredTargets();
    skill(userSource, 'user-skill', 'user v2');
    skill(profileSource, 'profile-skill', 'profile v2');
    skill(projectSource, 'project-skill', 'project v2');
    const projectBefore = snapshot(project);
    const result = update(['--scope', 'user', '--offline']);
    expect(result.data.profiles).toMatchObject([
      { profile: 'work', status: 'installed' },
    ]);
    expect(readFileSync(userSkill(), 'utf8')).toContain('user v2');
    expect(readFileSync(profileSkill(), 'utf8')).toContain('profile v2');
    expect(snapshot(project)).toEqual(projectBefore);
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe(
      'model = "user-owned-model"\n',
    );
  });

  test('default and explicit all scope reconcile every configured target', () => {
    configuredTargets();
    for (const selector of [[], ['--scope', 'all']]) {
      const revision = selector.length === 0 ? 'v2' : 'v3';
      skill(userSource, 'user-skill', `user ${revision}`);
      skill(profileSource, 'profile-skill', `profile ${revision}`);
      skill(projectSource, 'project-skill', `project ${revision}`);
      update([...selector, '--offline']);
      expect(readFileSync(userSkill(), 'utf8')).toContain(`user ${revision}`);
      expect(readFileSync(profileSkill(), 'utf8')).toContain(
        `profile ${revision}`,
      );
      expect(readFileSync(projectSkill(), 'utf8')).toContain(
        `project ${revision}`,
      );
    }
  });

  test('dry-run leaves selected and excluded targets unchanged', () => {
    configuredTargets();
    skill(projectSource, 'project-skill', 'project v2');
    const homeBefore = snapshot(home);
    const projectBefore = snapshot(project);
    update(['--scope', 'project', '--offline', '--dry-run']);
    expect(snapshot(home)).toEqual(homeBefore);
    expect(snapshot(project)).toEqual(projectBefore);
  });

  test('scope errors and an invalid selected project retain nonzero JSON reporting without target writes', () => {
    for (const args of [
      ['--scope', 'project'],
      ['--scope', 'invalid'],
      ['--scope', 'all', '--profile', 'work'],
    ]) {
      const before = snapshot(root);
      const result = cli(['update', ...args, '--json']);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        success: false,
        command: 'workspace update',
        error: expect.any(String),
      });
      expect(snapshot(root)).toEqual(before);
    }
    write(
      join(project, '.allagents', 'workspace.yaml'),
      'repositories:\n  - managed: true\nplugins: []\nclients: [codex]\n',
    );
    const before = snapshot(root);
    const invalid = cli([
      'workspace',
      'update',
      '--scope',
      'project',
      '--offline',
      '--json',
    ]);
    expect(invalid.exitCode).toBe(1);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      success: false,
      error: expect.stringContaining('repositories.0.path'),
    });
    expect(snapshot(root)).toEqual(before);
  });

  test('project scope honors managed repository operations and their skip flags', () => {
    const upstream = join(root, 'upstream');
    mkdirSync(upstream);
    const git = (args: string[], cwd = upstream) => {
      const result = Bun.spawnSync(['git', ...args], {
        cwd,
        env: env(),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(result.exitCode).toBe(0);
    };
    git(['init', '-b', 'main']);
    git(['config', '--local', 'user.name', 'Scope Fixture']);
    git(['config', '--local', 'user.email', 'fixture@example.test']);
    write(join(upstream, 'README.md'), 'managed fixture\n');
    git(['add', 'README.md']);
    git(['commit', '-m', 'fixture']);
    // Redirect only this synthetic HTTPS remote to a local repository.
    write(
      join(root, 'gitconfig'),
      `[url "file://${upstream}"]\n  insteadOf = https://github.com/scope-fixture/managed.git\n`,
    );
    projectConfig(undefined, [
      {
        path: 'managed',
        source: 'github',
        repo: 'scope-fixture/managed',
        managed: true,
        ref: 'main',
      },
    ]);
    for (const flag of ['--no-managed', '--offline', '--dry-run']) {
      update(['--scope', 'project', flag]);
      expect(existsSync(join(project, 'managed'))).toBe(false);
      expect(existsSync(join(home, '.allagents'))).toBe(false);
    }
    const cloned = update(['--scope', 'project']);
    expect(cloned.data.managedRepos).toMatchObject([{ action: 'cloned' }]);
    expect(readFileSync(join(project, 'managed', 'README.md'), 'utf8')).toBe(
      'managed fixture\n',
    );
    expect(existsSync(join(home, '.allagents'))).toBe(false);
  });
});
