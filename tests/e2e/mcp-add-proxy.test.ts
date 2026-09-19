import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import {
  type DummyMcpOAuthServer,
  startDummyMcpOAuthServer,
} from '../helpers/dummy-mcp-oauth-server.js';
import packageJson from '../../package.json';

const packageRef = `allagents@${packageJson.version}`;

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runCli(
  workdir: string,
  homeDir: string,
  args: string[],
  json = true,
): Promise<CliResult> {
  const cliEntry = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');
  const proc = Bun.spawn(
    ['bun', 'run', cliEntry, ...(json ? ['--json'] : []), ...args],
    {
    cwd: workdir,
    env: {
      ...process.env,
      HOME: homeDir,
      ALLAGENTS_TEST_HOME: homeDir,
    },
    stderr: 'pipe',
    stdout: 'pipe',
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
}

function readWorkspaceConfig(workspaceDir: string): Record<string, unknown> {
  return load(readFileSync(join(workspaceDir, '.allagents', 'workspace.yaml'), 'utf-8')) as Record<
    string,
    unknown
  >;
}

describe('mcp add HTTP client routing e2e', () => {
  let workspaceDir: string;
  let homeDir: string;
  let dummy: DummyMcpOAuthServer;

  beforeEach(async () => {
    workspaceDir = join(tmpdir(), `allagents-e2e-mcp-add-proxy-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    homeDir = join(tmpdir(), `allagents-e2e-home-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(workspaceDir, '.allagents'), { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    dummy = await startDummyMcpOAuthServer({ requireAuth: false });
  });

  afterEach(async () => {
    await dummy.stop();
    rmSync(workspaceDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  test('adds deepwiki with proxy enabled for all configured MCP clients', async () => {
    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      `repositories: []
plugins: []
clients:
  - claude
  - codex
  - vscode
  - copilot
`,
      'utf-8',
    );

    const result = await runCli(workspaceDir, homeDir, [
      'mcp',
      'add',
      'deepwiki',
      dummy.mcpUrl,
    ]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.success).toBe(true);

    const workspace = readWorkspaceConfig(workspaceDir);
    expect(workspace.mcpServers).toEqual({
      deepwiki: { type: 'http', url: dummy.mcpUrl },
    });
    expect(workspace.mcpProxy).toEqual({
      servers: {
        deepwiki: {
          proxy: ['*'],
        },
      },
    });

    const claudeConfig = JSON.parse(readFileSync(join(workspaceDir, '.mcp.json'), 'utf-8'));
    expect(claudeConfig.mcpServers.deepwiki.command).toBe('npx');
    expect(claudeConfig.mcpServers.deepwiki.args).toEqual([
      '-y',
      packageRef,
      'mcp',
      'proxy',
      dummy.mcpUrl,
    ]);

    const codexConfig = readFileSync(join(workspaceDir, '.codex', 'config.toml'), 'utf-8');
    expect(codexConfig).toContain('npx');
    expect(codexConfig).toContain(packageRef);

    const vscodeConfig = JSON.parse(readFileSync(join(workspaceDir, '.vscode', 'mcp.json'), 'utf-8'));
    expect(vscodeConfig.servers.deepwiki.command).toBe('npx');
    expect(vscodeConfig.servers.deepwiki.args.slice(0, 4)).toEqual([
      '-y',
      packageRef,
      'mcp',
      'proxy',
    ]);

    const copilotConfig = JSON.parse(readFileSync(join(workspaceDir, '.github', 'mcp.json'), 'utf-8'));
    expect(copilotConfig.mcpServers.deepwiki.command).toBe('npx');
    expect(copilotConfig.mcpServers.deepwiki.args.slice(0, 4)).toEqual([
      '-y',
      packageRef,
      'mcp',
      'proxy',
    ]);

    const rerun = await runCli(workspaceDir, homeDir, ['mcp', 'update']);
    expect(rerun.exitCode).toBe(0);
    const rerunPayload = JSON.parse(rerun.stdout);
    expect(rerunPayload.success).toBe(true);
    expect(rerunPayload.data.mcpResults.claude.added).toBe(0);
    expect(rerunPayload.data.mcpResults.codex.added).toBe(0);
    expect(rerunPayload.data.mcpResults.vscode.added).toBe(0);
    expect(rerunPayload.data.mcpResults.copilot.added).toBe(0);
  }, 15_000);

  test('scopes proxying to selected clients with --client', async () => {
    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      `repositories: []
plugins: []
clients:
  - claude
  - codex
  - vscode
`,
      'utf-8',
    );

    const result = await runCli(workspaceDir, homeDir, [
      'mcp',
      'add',
      'secure-api',
      dummy.mcpUrl,
      '--client',
      'claude,codex',
    ]);

    expect(result.exitCode).toBe(0);

    const workspace = readWorkspaceConfig(workspaceDir);
    expect(workspace.mcpServers).toEqual({
      'secure-api': {
        type: 'http',
        url: dummy.mcpUrl,
        clients: ['claude', 'codex'],
      },
    });
    expect(workspace.mcpProxy).toEqual({
      servers: {
        'secure-api': {
          proxy: ['claude', 'codex'],
        },
      },
    });

    expect(existsSync(join(workspaceDir, '.mcp.json'))).toBe(true);
    expect(existsSync(join(workspaceDir, '.codex', 'config.toml'))).toBe(true);
    expect(existsSync(join(workspaceDir, '.vscode', 'mcp.json'))).toBe(false);
  });

  test('accepts repeatable and comma-compatible client selectors', async () => {
    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      `repositories: []
plugins: []
clients:
  - claude
  - codex
  - copilot
`,
      'utf-8',
    );

    const result = await runCli(workspaceDir, homeDir, [
      'mcp',
      'add',
      'local',
      'local-mcp',
      '--client',
      'claude,codex',
      '--client',
      'copilot',
      '--client',
      'codex',
    ]);

    expect(result.exitCode).toBe(0);
    expect(readWorkspaceConfig(workspaceDir).mcpServers).toEqual({
      local: {
        type: 'stdio',
        command: 'local-mcp',
        clients: ['claude', 'codex', 'copilot'],
      },
    });
  });


  test('rejects empty client segments before mutation', async () => {
    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      'repositories: []\nplugins: []\nclients:\n  - codex\n',
      'utf8',
    );

    const result = await runCli(workspaceDir, homeDir, [
      'mcp',
      'add',
      'local',
      'local-mcp',
      '--client',
      'codex,',
    ]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain('empty segments');
    expect(readWorkspaceConfig(workspaceDir).mcpServers).toBeUndefined();
  });

  test('routes ordinary user declarations and output with --scope user', async () => {
    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      'repositories: []\nplugins: []\nclients: []\n',
      'utf-8',
    );
    mkdirSync(join(homeDir, '.allagents'), { recursive: true });
    writeFileSync(
      join(homeDir, '.allagents', 'workspace.yaml'),
      'repositories: []\nplugins: []\nclients:\n  - copilot\n',
      'utf-8',
    );

    const result = await runCli(workspaceDir, homeDir, [
      'mcp',
      'add',
      'local',
      'local-mcp',
      '--scope',
      'user',
    ]);

    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.data.destination).toEqual({ kind: 'user' });
    expect(
      readWorkspaceConfig(workspaceDir).mcpServers,
    ).toBeUndefined();
    const userConfig = load(
      readFileSync(join(homeDir, '.allagents', 'workspace.yaml'), 'utf8'),
    ) as Record<string, unknown>;
    expect(userConfig.mcpServers).toEqual({
      local: { type: 'stdio', command: 'local-mcp' },
    });
    expect(
      JSON.parse(
        readFileSync(join(homeDir, '.copilot', 'mcp-config.json'), 'utf8'),
      ).mcpServers.local,
    ).toEqual({
      type: 'stdio',
      command: 'local-mcp',
    });
  });

  test('manages a declared profile without implicitly installing it', async () => {
    mkdirSync(join(homeDir, '.allagents'), { recursive: true });
    writeFileSync(
      join(homeDir, '.allagents', 'workspace.yaml'),
      `profiles:
  markets:
    clients:
      - name: codex
      - name: copilot
`,
      'utf-8',
    );

    const add = await runCli(workspaceDir, homeDir, [
      'mcp',
      'add',
      'local',
      'local-mcp',
      '--profile',
      'markets',
      '--client',
      'codex',
      '--client',
      'copilot',
    ]);
    expect(add.exitCode).toBe(0);
    const addPayload = JSON.parse(add.stdout);
    expect(addPayload.data.destination).toEqual({
      kind: 'profile',
      name: 'markets',
    });
    expect(addPayload.data.sync).toEqual({ status: 'not-installed' });

    const list = await runCli(workspaceDir, homeDir, [
      'mcp',
      'list',
      '--profile',
      'markets',
    ]);
    expect(list.exitCode).toBe(0);
    expect(JSON.parse(list.stdout).data.servers).toEqual({
      local: {
        type: 'stdio',
        command: 'local-mcp',
        clients: ['codex', 'copilot'],
      },
    });

    const get = await runCli(workspaceDir, homeDir, [
      'mcp',
      'get',
      'local',
      '--profile',
      'markets',
    ]);
    expect(get.exitCode).toBe(0);
    expect(JSON.parse(get.stdout).data.destination).toEqual({
      kind: 'profile',
      name: 'markets',
    });

    const remove = await runCli(workspaceDir, homeDir, [
      'mcp',
      'remove',
      'local',
      '--profile',
      'markets',
    ]);
    expect(remove.exitCode).toBe(0);
    const userConfig = load(
      readFileSync(join(homeDir, '.allagents', 'workspace.yaml'), 'utf8'),
    ) as {
      profiles: Record<string, Record<string, unknown>>;
    };
    expect(userConfig.profiles.markets.mcpServers).toBeUndefined();
  }, 15_000);

  test('rejects combining --scope and --profile before mutation', async () => {
    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      'repositories: []\nplugins: []\nclients: []\n',
      'utf8',
    );
    const result = await runCli(workspaceDir, homeDir, [
      'mcp',
      'add',
      'local',
      'local-mcp',
      '--scope',
      'user',
      '--profile',
      'markets',
    ]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain(
      '--scope and --profile cannot be used together',
    );
    expect(readWorkspaceConfig(workspaceDir).mcpServers).toBeUndefined();
  });

  test('fails before mutation when a non-interactive HTTP preflight cannot connect', async () => {
    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      `repositories: []
plugins: []
clients:
  - claude
`,
      'utf-8',
    );

    const result = await runCli(workspaceDir, homeDir, [
      'mcp',
      'add',
      'unreachable',
      'http://127.0.0.1:1/mcp',
    ]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).success).toBe(false);
    expect(readWorkspaceConfig(workspaceDir).mcpServers).toBeUndefined();
  });

  test('redacts credential values from list and get JSON output', async () => {
    const userConfigPath = join(homeDir, '.allagents', 'workspace.yaml');
    mkdirSync(join(homeDir, '.allagents'), { recursive: true });
    writeFileSync(
      userConfigPath,
      `repositories: []
plugins: []
clients: []
mcpServers:
  secure-http:
    url: https://user:password@example.com/mcp?accessToken=camel-query-secret&apiKey=api-query-secret&key=generic-query-secret
    headers:
      Authorization: Bearer header-secret
  secure-stdio:
    command: local-mcp
    args:
      - --token
      - arg-secret
      - --apiKey=inline-secret
      - https://example.com/callback?accessToken=arg-query-secret
      - --key
      - generic-arg-secret
      - key=generic-inline-secret
    env:
      API_TOKEN: env-secret
`,
      'utf8',
    );

    const list = await runCli(workspaceDir, homeDir, [
      'mcp',
      'list',
      '--scope',
      'user',
    ]);
    expect(list.exitCode).toBe(0);
    expect(list.stdout).not.toContain('header-secret');
    expect(list.stdout).not.toContain('env-secret');
    expect(list.stdout).not.toContain('camel-query-secret');
    expect(list.stdout).not.toContain('api-query-secret');
    expect(list.stdout).not.toContain('arg-secret');
    expect(list.stdout).not.toContain('inline-secret');
    expect(list.stdout).not.toContain('arg-query-secret');
    expect(list.stdout).not.toContain('generic-query-secret');
    expect(list.stdout).not.toContain('generic-arg-secret');
    expect(list.stdout).not.toContain('generic-inline-secret');
    const listPayload = JSON.parse(list.stdout);
    expect(listPayload.data.servers['secure-http'].headers.Authorization).toBe(
      '[REDACTED]',
    );
    expect(listPayload.data.servers['secure-stdio'].env.API_TOKEN).toBe(
      '[REDACTED]',
    );
    expect(listPayload.data.servers['secure-stdio'].args).toEqual([
      '--token',
      '[REDACTED]',
      '--apiKey=[REDACTED]',
      'https://example.com/callback?accessToken=[REDACTED]',
      '--key',
      '[REDACTED]',
      'key=[REDACTED]',
    ]);

    const get = await runCli(workspaceDir, homeDir, [
      'mcp',
      'get',
      'secure-http',
      '--scope',
      'user',
    ]);
    expect(get.exitCode).toBe(0);
    expect(get.stdout).not.toContain('header-secret');
    expect(get.stdout).not.toContain('password');
    expect(get.stdout).not.toContain('camel-query-secret');
    expect(get.stdout).not.toContain('api-query-secret');
    expect(get.stdout).not.toContain('generic-query-secret');
    expect(JSON.parse(get.stdout).data.config.headers.Authorization).toBe(
      '[REDACTED]',
    );

    const humanList = await runCli(
      workspaceDir,
      homeDir,
      ['mcp', 'list', '--scope', 'user'],
      false,
    );
    expect(humanList.exitCode).toBe(0);
    expect(humanList.stdout).toContain('[REDACTED]');
    expect(humanList.stdout).not.toContain('header-secret');
    expect(humanList.stdout).not.toContain('env-secret');
    expect(humanList.stdout).not.toContain('camel-query-secret');
    expect(humanList.stdout).not.toContain('api-query-secret');
    expect(humanList.stdout).not.toContain('arg-secret');
    expect(humanList.stdout).not.toContain('inline-secret');
    expect(humanList.stdout).not.toContain('arg-query-secret');
    expect(humanList.stdout).not.toContain('generic-query-secret');
    expect(humanList.stdout).not.toContain('generic-arg-secret');
    expect(humanList.stdout).not.toContain('generic-inline-secret');
  });

  test('rejects invalid profile server names before HTTP preflight or persistence', async () => {
    const userConfigPath = join(homeDir, '.allagents', 'workspace.yaml');
    mkdirSync(join(homeDir, '.allagents'), { recursive: true });
    writeFileSync(
      userConfigPath,
      `repositories: []
plugins: []
clients: []
profiles:
  markets:
    clients:
      - name: codex
`,
      'utf8',
    );

    const result = await runCli(workspaceDir, homeDir, [
      'mcp',
      'add',
      'invalid/name',
      dummy.mcpUrl,
      '--profile',
      'markets',
    ]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain('Expected 1-100 ASCII');
    expect(dummy.mcpRequestHeaders).toHaveLength(0);
    const userConfig = load(readFileSync(userConfigPath, 'utf8')) as {
      profiles: Record<string, Record<string, unknown>>;
    };
    expect(userConfig.profiles.markets.mcpServers).toBeUndefined();
  });

  test('returns a structured error for malformed workspace config', async () => {
    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      'repositories: [',
      'utf-8',
    );

    const result = await runCli(workspaceDir, homeDir, [
      'mcp',
      'add',
      'example',
      'https://example.com/mcp',
    ]);

    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(result.stdout);
    expect(payload.success).toBe(false);
    expect(payload.command).toBe('mcp add');
  });
});
