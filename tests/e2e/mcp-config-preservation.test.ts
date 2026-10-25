import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const cli = join(import.meta.dir, '../../dist/index.js');

describe.each([
  ['claude', 'project', '.mcp.json', 'mcpServers'],
  ['vscode', 'project', '.vscode/mcp.json', 'servers'],
  ['copilot', 'user', '.copilot/mcp-config.json', 'mcpServers'],
] as const)('%s %s built CLI preserves invalid MCP configuration', (client, scope, relativePath, key) => {
  let root: string;
  let project: string;
  let home: string;
  let configRoot: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'allagents-mcp-preservation-'));
    project = join(root, 'project');
    home = join(root, 'home');
    mkdirSync(home);
    mkdirSync(project);
    configRoot = scope === 'user' ? home : project;
    mkdirSync(join(configRoot, '.allagents'), { recursive: true });
    writeFileSync(join(configRoot, '.allagents/workspace.yaml'),
      `repositories: []\nplugins: []\nclients: [${client}]\nmcpServers:\n  new-server:\n    command: new-command\n`);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  test.each([
    ['update', '--scope', scope, '--offline'],
    ['mcp', 'update', '--scope', scope, '--offline'],
  ])('%s reports failure, retains tracking, and recovers after repair', (...args) => {
    const configPath = join(configRoot, relativePath);
    const statePath = join(configRoot, '.allagents/sync-state.json');
    mkdirSync(dirname(configPath), { recursive: true });
    const original = `{ "${key}": { "personal": { "command": "keep" } }, // pending edit\n`;
    writeFileSync(configPath, original);
    writeFileSync(statePath, JSON.stringify({
      version: 1, files: {}, mcpServers: { [client]: ['old-server'] },
    }));
    const run = () => Bun.spawnSync(['node', cli, ...args, '--json'], {
      cwd: project,
      env: { ...process.env, HOME: home, USERPROFILE: home, ALLAGENTS_TEST_HOME: home, CI: '1' },
      stdout: 'pipe', stderr: 'pipe',
    });

    if (args[0] === 'update') {
      const preview = Bun.spawnSync(['node', cli, ...args, '--dry-run', '--json'], {
        cwd: project,
        env: { ...process.env, HOME: home, USERPROFILE: home, ALLAGENTS_TEST_HOME: home, CI: '1' },
        stdout: 'pipe', stderr: 'pipe',
      });
      expect(preview.exitCode).toBe(1);
      expect(JSON.parse(preview.stdout.toString()).success).toBe(false);
      expect(readFileSync(configPath, 'utf8')).toBe(original);
      expect(JSON.parse(readFileSync(statePath, 'utf8')).mcpServers[client]).toEqual(['old-server']);
    }

    const failed = run();
    expect(failed.exitCode, failed.stdout.toString() + failed.stderr.toString()).toBe(1);
    expect(JSON.parse(failed.stdout.toString()).success).toBe(false);
    expect(failed.stdout.toString()).toContain('Refusing to overwrite');
    expect(failed.stdout.toString()).toContain(configPath);
    expect(readFileSync(configPath, 'utf8')).toBe(original);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).mcpServers[client]).toEqual(['old-server']);

    writeFileSync(configPath, JSON.stringify({ [key]: {
      personal: { command: 'keep' }, 'old-server': { command: 'remove' },
    }, unrelated: true }));
    const repaired = run();
    expect(repaired.exitCode, repaired.stdout.toString() + repaired.stderr.toString()).toBe(0);
    expect(JSON.parse(repaired.stdout.toString()).success).toBe(true);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      [key]: { personal: { command: 'keep' }, 'new-server': { command: 'new-command' } },
      unrelated: true,
    });
    expect(JSON.parse(readFileSync(statePath, 'utf8')).mcpServers[client]).toEqual(['new-server']);
  });
});
