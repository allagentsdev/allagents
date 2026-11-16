import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import { resolveConfiguredMcpServer } from '../../../src/core/mcp-runtime.js';
import { resolveMcpDestination } from '../../../src/core/mcp-servers.js';
import { syncMcpOnly, syncUserMcpOnly } from '../../../src/core/mcp-sync.js';
import { getSyncStatePath } from '../../../src/core/sync-state.js';
import { stubHomeDir } from '../../helpers/env.js';

let root: string;
let home: string;
let project: string;
let restoreHome: () => void;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'allagents-universal-mcp-'));
  home = join(root, 'home');
  project = join(root, 'project');
  restoreHome = stubHomeDir(home);
  await mkdir(project, { recursive: true });
});

afterEach(async () => {
  restoreHome();
  await rm(root, { recursive: true, force: true });
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

async function writeWorkspace(
  scopeRoot: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await mkdir(join(scopeRoot, '.allagents'), { recursive: true });
  await writeFile(join(scopeRoot, '.allagents', 'workspace.yaml'), stringify({
    repositories: [], plugins: [], clients: ['universal'], ...extra,
  }));
}

const managedPath = (scopeRoot: string) => join(scopeRoot, '.allagents', 'mcp.json');
const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));

describe('Universal MCP reconciliation', () => {
  test.each(['project', 'user'] as const)('%s plugin sync tracks, updates and removes owned servers while preserving personal entries', async (scope) => {
    const scopeRoot = scope === 'project' ? project : home;
    const sync = () => scope === 'project'
      ? syncMcpOnly(project, { offline: true })
      : syncUserMcpOnly({ offline: true });
    const plugin = join(root, 'plugin');
    await writeJson(join(plugin, '.mcp.json'), { mcpServers: {
      owned: { command: 'first' }, personal: { command: 'plugin-personal' },
    } });
    await writeWorkspace(scopeRoot, { plugins: [plugin] });
    await writeJson(managedPath(scopeRoot), {
      keep: 'metadata', mcpServers: { personal: { command: 'personal' } },
    });

    const installed = await sync();
    expect(installed.success).toBe(true);
    expect(installed.mcpResults.universal?.addedServers).toEqual(['owned']);
    expect(installed.mcpResults.universal?.skippedServers).toEqual(['personal']);
    expect((await readJson(getSyncStatePath(scopeRoot))).mcpServers.universal).toEqual(['owned']);
    expect(await readJson(managedPath(scopeRoot))).toEqual({
      keep: 'metadata', mcpServers: { personal: { command: 'personal' }, owned: { command: 'first' } },
    });

    await writeJson(join(plugin, '.mcp.json'), { mcpServers: { owned: { command: 'second' } } });
    expect((await sync()).mcpResults.universal?.overwrittenServers).toEqual(['owned']);
    expect((await readJson(managedPath(scopeRoot))).mcpServers.owned.command).toBe('second');

    await writeWorkspace(scopeRoot);
    expect((await sync()).mcpResults.universal?.removedServers).toEqual(['owned']);
    expect(await readJson(managedPath(scopeRoot))).toEqual({
      keep: 'metadata', mcpServers: { personal: { command: 'personal' } },
    });
    expect((await readJson(getSyncStatePath(scopeRoot))).mcpServers.universal).toEqual([]);
  });

  test.each(['project', 'user'] as const)('%s dry-run reports additions without writing destination or state', async (scope) => {
    const scopeRoot = scope === 'project' ? project : home;
    await writeWorkspace(scopeRoot, { mcpServers: { direct: { command: 'direct' } } });
    const result = scope === 'project'
      ? await syncMcpOnly(project, { offline: true, dryRun: true })
      : await syncUserMcpOnly({ offline: true, dryRun: true });
    expect(result.mcpResults.universal?.addedServers).toEqual(['direct']);
    expect(existsSync(managedPath(scopeRoot))).toBe(false);
    expect(existsSync(getSyncStatePath(scopeRoot))).toBe(false);
  });

  test.each(['project', 'user'] as const)('%s honors client selection and proxy policy before writing managed servers', async (scope) => {
    const scopeRoot = scope === 'project' ? project : home;
    await writeWorkspace(scopeRoot, {
      mcpServers: {
        ignored: { command: 'ignored', clients: ['claude'] },
        included: { command: 'included', clients: ['universal'] },
        remote: { url: 'https://mcp.example/rpc', headers: { Authorization: '${TOKEN}' } },
      },
      mcpProxy: { clients: ['universal'] },
    });
    const result = scope === 'project'
      ? await syncMcpOnly(project, { offline: true })
      : await syncUserMcpOnly({ offline: true });
    expect(result.success).toBe(true);
    const servers = (await readJson(managedPath(scopeRoot))).mcpServers;
    expect(servers.ignored).toBeUndefined();
    expect(servers.included).toEqual({ command: 'included' });
    expect(servers.remote.command).toBe('npx');
    expect(servers.remote.args).toContain('https://mcp.example/rpc');
    expect(servers.remote.env).toEqual({ TOKEN: '${TOKEN}' });
  });

  test.each(['source', 'destination'] as const)('invalid %s preserves the managed bytes and prior ownership', async (invalid) => {
    const plugin = join(root, 'plugin');
    await writeJson(join(plugin, '.mcp.json'), { mcpServers: { owned: { command: 'owned' } } });
    await writeWorkspace(project, { plugins: [plugin] });
    expect((await syncMcpOnly(project, { offline: true })).success).toBe(true);
    const configPath = invalid === 'source' ? join(plugin, '.mcp.json') : managedPath(project);
    await writeFile(configPath, '{invalid');
    const previous = await readFile(managedPath(project), 'utf8');
    const state = await readFile(getSyncStatePath(project), 'utf8');
    expect((await syncMcpOnly(project, { offline: true })).success).toBe(false);
    expect(await readFile(managedPath(project), 'utf8')).toBe(previous);
    expect(await readFile(getSyncStatePath(project), 'utf8')).toBe(state);
  });
});

describe('Universal runtime lookup', () => {
  test('prefers inline declarations and preserves the selected destination identity', async () => {
    await writeWorkspace(project, { mcpServers: { same: { command: 'inline' } } });
    await writeJson(managedPath(project), { mcpServers: { same: { command: 'managed' }, plugin: { command: 'plugin' } } });
    const destination = resolveMcpDestination({ cwd: project, scope: 'project' });
    expect(await resolveConfiguredMcpServer(destination, 'same')).toEqual({ destination, config: { command: 'inline' } });
    expect(await resolveConfiguredMcpServer(destination, 'plugin')).toEqual({ destination, config: { command: 'plugin' } });
    // A valid inline declaration does not need to inspect the managed file.
    await writeFile(managedPath(project), '{invalid');
    expect((await resolveConfiguredMcpServer(destination, 'same')).config).toEqual({ command: 'inline' });
  });

  test('uses project managed servers before user inline and only allows requested project-to-user fallback', async () => {
    await writeWorkspace(project);
    await writeWorkspace(home, { mcpServers: { same: { command: 'user-inline' } } });
    await writeJson(managedPath(project), { mcpServers: { same: { command: 'project-managed' } } });
    await writeJson(managedPath(home), { mcpServers: {
      plugin: { command: 'user-managed' }, same: { command: 'user-managed-shadowed' },
    } });
    const destination = resolveMcpDestination({ cwd: project, scope: 'project' });
    expect((await resolveConfiguredMcpServer(destination, 'same', true)).config).toEqual({ command: 'project-managed' });
    await expect(resolveConfiguredMcpServer(destination, 'plugin')).rejects.toThrow('not defined');
    const user = resolveMcpDestination({ scope: 'user' });
    expect(await resolveConfiguredMcpServer(destination, 'plugin', true)).toEqual({ destination: user, config: { command: 'user-managed' } });
    await rm(managedPath(project));
    expect(await resolveConfiguredMcpServer(destination, 'same', true)).toEqual({ destination: user, config: { command: 'user-inline' } });
  });

  test('user lookup stays in the explicitly selected user root and profiles never use managed ordinary config', async () => {
    await writeWorkspace(home, { profiles: { isolated: { clients: [{ name: 'claude' }] } } });
    await writeJson(managedPath(home), { mcpServers: { plugin: { command: 'user-managed' } } });
    const user = resolveMcpDestination({ scope: 'user' });
    expect((await resolveConfiguredMcpServer(user, 'plugin')).config).toEqual({ command: 'user-managed' });
    const otherRoot = join(root, 'other-user');
    await writeJson(managedPath(otherRoot), { mcpServers: { plugin: { command: 'other-managed' } } });
    const otherUser = { kind: 'user' as const, configPath: join(otherRoot, '.allagents', 'workspace.yaml') };
    expect(await resolveConfiguredMcpServer(otherUser, 'plugin')).toEqual({ destination: otherUser, config: { command: 'other-managed' } });
    const profile = resolveMcpDestination({ profile: 'isolated' });
    await expect(resolveConfiguredMcpServer(profile, 'plugin', true)).rejects.toThrow("not defined in profile 'isolated'");
  });

  test('can resolve managed config without an authored workspace file', async () => {
    await writeJson(managedPath(project), { mcpServers: { plugin: { command: 'managed' } } });
    const destination = resolveMcpDestination({ cwd: project, scope: 'project' });
    expect((await resolveConfiguredMcpServer(destination, 'plugin')).config).toEqual({ command: 'managed' });
  });

  test.each(['{invalid', 'null', '[]', '{"mcpServers":null}', '{"mcpServers":[]}', '{"mcpServers":{"plugin":42}}'])('rejects invalid managed config instead of falling back (%s)', async (content) => {
    await writeWorkspace(project);
    await writeWorkspace(home, { mcpServers: { plugin: { command: 'user-inline' } } });
    await writeFile(managedPath(project), content);
    const destination = resolveMcpDestination({ cwd: project, scope: 'project' });
    await expect(resolveConfiguredMcpServer(destination, 'plugin', true)).rejects.toThrow('Invalid Universal MCP configuration');
  });

  test('reports unreadable managed config without user fallback', async () => {
    await writeWorkspace(project);
    await writeWorkspace(home, { mcpServers: { plugin: { command: 'user-inline' } } });
    await mkdir(managedPath(project));
    const destination = resolveMcpDestination({ cwd: project, scope: 'project' });
    await expect(resolveConfiguredMcpServer(destination, 'plugin', true)).rejects.toThrow('Cannot read Universal MCP configuration');
  });
});
