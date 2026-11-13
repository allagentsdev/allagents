import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = join(import.meta.dir, '../../dist/index.js');

beforeAll(() => {
  const build = Bun.spawnSync(['bun', 'run', 'build'], {
    cwd: join(import.meta.dir, '../..'), stdout: 'pipe', stderr: 'pipe',
  });
  if (build.exitCode !== 0) throw new Error(build.stderr.toString());
});

describe('built mcp list scope selection', () => {
  let root: string;
  let home: string;
  let project: string;
  const configPath = (directory: string) => join(directory, '.allagents/workspace.yaml');
  const writeConfig = (directory: string, extra: string) => {
    mkdirSync(join(directory, '.allagents'), { recursive: true });
    writeFileSync(configPath(directory), `repositories: []\nplugins: []\nclients: []\n${extra}`);
  };
  const run = (args: string[] = [], cwd?: string) => {
    const result = Bun.spawnSync(['node', cli, ...args], {
      cwd: cwd ?? project,
      env: { ...process.env, HOME: home, USERPROFILE: home, ALLAGENTS_TEST_HOME: home, CI: '1', NO_COLOR: '1' },
      stdout: 'pipe', stderr: 'pipe',
    });
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };
  const list = (...args: string[]) => {
    const result = run(['--json', 'mcp', 'list', ...args]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    return JSON.parse(result.stdout).data;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'allagents-mcp-list-'));
    home = join(root, 'home');
    project = join(root, 'project');
    mkdirSync(home);
    mkdirSync(project);
    writeConfig(home, 'mcpServers:\n  shared:\n    command: user-command\nprofiles:\n  markets:\n    clients: [{name: codex}]\n    mcpServers:\n      profile-only:\n        command: profile-command\n');
    writeConfig(project, 'mcpServers:\n  zebra:\n    command: last-command\n  shared:\n    command: project-command\n');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test('lists user then project, preserves duplicate names, and leaves files intact', () => {
    // A local plugin declaration must not expand into the inline inventory.
    const plugin = join(root, 'plugin');
    mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
    writeFileSync(join(plugin, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
    writeFileSync(join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { 'plugin-only': { command: 'plugin-command' } } }));
    const original = readFileSync(configPath(project), 'utf8').replace('plugins: []', `plugins: [${JSON.stringify(plugin)}]`);
    writeFileSync(configPath(project), original);
    expect(list()).toEqual({
      destinations: {
        user: { destination: { kind: 'user' }, servers: { shared: { command: 'user-command' } }, total: 1 },
        project: { destination: { kind: 'project' }, servers: { shared: { command: 'project-command' }, zebra: { command: 'last-command' } }, total: 2 },
      }, total: 3,
    });
    const human = run(['mcp', 'list']);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('user scope');
    expect(human.stdout).toContain('project scope');
    expect(human.stdout.indexOf('user-command')).toBeLessThan(human.stdout.indexOf('project-command'));
    expect(human.stdout.indexOf('project-command')).toBeLessThan(human.stdout.indexOf('last-command'));
    expect(human.stdout).not.toContain('profile-only');
    expect(human.stdout).not.toContain('plugin-only');
    expect(readFileSync(configPath(project), 'utf8')).toBe(original);
  }, 15_000);

  test('preserves explicit scope and profile JSON and redirected output', () => {
    expect(list('--scope', 'user')).toEqual({ destination: { kind: 'user' }, servers: { shared: { command: 'user-command' } }, total: 1 });
    expect(list('--scope', 'project')).toEqual({ destination: { kind: 'project' }, servers: { zebra: { command: 'last-command' }, shared: { command: 'project-command' } }, total: 2 });
    expect(list('--profile', 'markets')).toEqual({ destination: { kind: 'profile', name: 'markets' }, servers: { 'profile-only': { command: 'profile-command' } }, total: 1 });
    expect(run(['mcp', 'list', '--scope', 'user']).stdout).toBe('MCP servers in the user workspace (1):\n\n  shared:\n    transport: stdio\n    command: user-command\n\n');
    const get = run(['--json', 'mcp', 'get', 'shared']);
    expect(JSON.parse(get.stdout).data.config.command).toBe('project-command');
  }, 15_000);

  test('selects aggregate JSON fields without projecting away scope declarations', () => {
    const aggregate = list();
    const destinations = run(['--json=destinations', 'mcp', 'list']);
    expect(destinations.code).toBe(0);
    expect(JSON.parse(destinations.stdout).data).toEqual({ destinations: aggregate.destinations });
    const total = run(['--json=total', 'mcp', 'list']);
    expect(total.code).toBe(0);
    expect(JSON.parse(total.stdout).data).toEqual({ total: 3 });
    const explicit = run(['--json=servers,total', 'mcp', 'list', '--scope', 'user']);
    expect(explicit.code).toBe(0);
    expect(JSON.parse(explicit.stdout).data).toEqual({ servers: { shared: { command: 'user-command' } }, total: 1 });
  }, 15_000);

  test.each(['user', 'project', 'both'])('lists remaining declarations with missing %s config', (missing) => {
    if (missing !== 'project') rmSync(configPath(home));
    if (missing !== 'user') rmSync(configPath(project));
    const result = list();
    expect(result.total).toBe(missing === 'both' ? 0 : missing === 'user' ? 2 : 1);
    expect(result.destinations.user.total).toBe(missing === 'project' ? 1 : 0);
    expect(result.destinations.project.total).toBe(missing === 'user' ? 2 : 0);
    if (missing !== 'project') expect(existsSync(configPath(home))).toBe(false);
    if (missing !== 'user') expect(existsSync(configPath(project))).toBe(false);
  });

  test('lists the HOME alias once and retains explicit project rejection', () => {
    const result = run(['--json', 'mcp', 'list'], home);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data).toEqual({ destinations: { user: { destination: { kind: 'user' }, servers: { shared: { command: 'user-command' } }, total: 1 } }, total: 1 });
    expect(run(['mcp', 'list', '--scope', 'project'], home).code).toBe(1);
  }, 15_000);

  test('rejects conflicting selectors and invalid scopes', () => {
    for (const args of [['--scope', 'user', '--profile', 'markets'], ['--scope', 'invalid']]) {
      const result = run(['--json', 'mcp', 'list', ...args]);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout).success).toBe(false);
    }
  }, 15_000);

  test('redacts both scopes in aggregate JSON and redirected output', () => {
    writeConfig(home, 'mcpServers:\n  secure:\n    command: local\n    args: [--token, user-secret]\n    env:\n      TOKEN: env-secret\n');
    writeConfig(project, 'mcpServers:\n  secure:\n    url: https://user:password@example.com/mcp?token=query-secret\n    headers:\n      Authorization: header-secret\n    oauth:\n      clientId: fixture-client\n      clientSecret: oauth-secret\n');
    for (const args of [['--json', 'mcp', 'list'], ['mcp', 'list']]) {
      const result = run(args);
      expect(result.code, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('[REDACTED]');
      for (const secret of ['user-secret', 'env-secret', 'password', 'query-secret', 'header-secret', 'oauth-secret']) {
        expect(result.stdout).not.toContain(secret);
      }
    }
  }, 15_000);
});
