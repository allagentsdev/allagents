import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetFetchCache } from '../../../../src/core/plugin.js';
import { resolveProfileFileSource } from '../../../../src/core/profile/source.js';
import { readPluginMcpConfig } from '../../../../src/core/vscode-mcp.js';
import { getPluginCachePath } from '../../../../src/utils/plugin-path.js';
import { getProfileAdapter } from '../../../../src/core/profile/adapters/registry.js';
import { applyProfilePlan, planProfileOperation } from '../../../../src/core/profile/index.js';
import { stringify } from 'yaml';

const source = 'https://github.com/fixture/portable-profile';

describe('portable profile source lifetime', () => {
  let root: string;
  let originalHome: string | undefined;
  let originalGitConfig: string | undefined;

  function git(cwd: string, args: string[]) {
    const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'allagents-portable-profile-'));
    originalHome = process.env.ALLAGENTS_TEST_HOME;
    originalGitConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.ALLAGENTS_TEST_HOME = join(root, 'home');
    process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig');
    const repository = join(root, 'repository');
    await mkdir(repository);
    git(repository, ['init', '-b', 'main']);
    git(repository, ['config', '--local', 'user.name', 'Fixture']);
    git(repository, ['config', '--local', 'user.email', 'fixture@example.invalid']);
    await writeFile(join(repository, 'plugin.json'), JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: 'profile-tools' }));
    await writeFile(join(repository, 'probe.mjs'), 'console.log(JSON.stringify({cwd:process.cwd(),root:process.env.PLUGIN_ROOT,data:process.env.PLUGIN_DATA}));');
    await writeFile(join(repository, 'mcp.json'), JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: { probe: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/probe.mjs'] } },
    }));
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Fixture']);
    await writeFile(process.env.GIT_CONFIG_GLOBAL, `[url "${repository.replaceAll('\\', '/')}"]\n\tinsteadOf = ${source}.git\n`);
    resetFetchCache();
  });

  afterEach(async () => {
    resetFetchCache();
    if (originalHome === undefined) delete process.env.ALLAGENTS_TEST_HOME;
    else process.env.ALLAGENTS_TEST_HOME = originalHome;
    if (originalGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = originalGitConfig;
    await rm(root, { recursive: true, force: true });
  });

  it('keeps packaged MCP executables usable after profile source inspection cleanup', async () => {
    const resolved = await resolveProfileFileSource({ declarationIndex: 0, source, install: 'file' }, { workspaceDirectory: root, offline: false, dryRun: false });
    const server = readPluginMcpConfig(resolved.path, resolved.components)?.probe as { command: string; args: string[]; env: Record<string, string> };
    await resolved.cleanup?.();
    const child = Bun.spawnSync([server.command, ...server.args], { env: { ...process.env, ...server.env }, stdout: 'pipe', stderr: 'pipe' });
    expect(child.exitCode).toBe(0);
    const observed = JSON.parse(new TextDecoder().decode(child.stdout));
    expect(observed.cwd).toBe(resolved.path);
    expect(observed.root).toBe(resolved.path);
    expect(existsSync(observed.data)).toBe(true);
  });

  it('refreshes the retained remote executable and preserves its data across profile updates', async () => {
    const declaration = { declarationIndex: 0, source, install: 'file' as const };
    const runtime = { workspaceDirectory: root, offline: false, dryRun: false };
    const first = await resolveProfileFileSource(declaration, runtime);
    const runTool = (resolved: typeof first) => {
      const server = readPluginMcpConfig(resolved.path, resolved.components)?.probe as { command: string; args: string[]; env: Record<string, string> };
      const child = Bun.spawnSync([server.command, ...server.args], { env: { ...process.env, ...server.env }, stdout: 'pipe', stderr: 'pipe' });
      expect(child.exitCode).toBe(0);
      return JSON.parse(new TextDecoder().decode(child.stdout));
    };
    await first.cleanup?.();
    const before = runTool(first);
    await writeFile(join(before.data, 'sentinel'), 'preserve saved data');
    const repository = join(root, 'repository');
    await writeFile(join(repository, 'probe.mjs'), 'console.log(JSON.stringify({revision:"updated",data:process.env.PLUGIN_DATA}));');
    git(repository, ['add', 'probe.mjs']);
    git(repository, ['commit', '-m', 'Update tool']);
    resetFetchCache();
    const next = await resolveProfileFileSource(declaration, runtime);
    await next.cleanup?.();
    const after = runTool(next);
    expect(after.revision).toBe('updated');
    expect(after.data).toBe(before.data);
    expect(await readFile(join(after.data, 'sentinel'), 'utf8')).toBe('preserve saved data');
  });

  it('does not populate a persistent cache while previewing a portable profile source', async () => {
    const resolved = await resolveProfileFileSource({ declarationIndex: 0, source, install: 'file' }, { workspaceDirectory: root, offline: false, dryRun: true });
    expect(resolved.components.format).toBe('portable');
    expect(existsSync(getPluginCachePath('fixture', 'portable-profile'))).toBe(false);
    await resolved.cleanup?.();
  });

  it.each(['codex', 'claude', 'copilot', 'opencode'] as const)('materializes an executable portable launcher in a %s profile', async (client) => {
    const serverName = 'portable/tools';
    const mcpPath = join(root, 'repository/mcp.json');
    const declaration = JSON.parse(await readFile(mcpPath, 'utf8'));
    declaration.mcpServers = { [serverName]: declaration.mcpServers.probe };
    await writeFile(mcpPath, JSON.stringify(declaration));
    const userConfigPath = join(root, 'home/.allagents/workspace.yaml');
    await mkdir(join(root, 'home/.allagents'), { recursive: true });
    await writeFile(userConfigPath, stringify({ profiles: { portable: {
      plugins: [{ source: join(root, 'repository'), install: 'file' }],
      clients: [{ name: client, install: 'file' }],
    } } }));
    const options = { homeDir: join(root, 'home'), userConfigPath, workspaceDirectory: root, binDir: join(root, 'bin'), offline: true };
    const plan = await planProfileOperation('portable', 'install', options, {
      getAdapter(name) {
        const adapter = getProfileAdapter(name);
        return adapter && Object.create(adapter, {
          isRuntimeAvailable: { value: async () => true },
        });
      },
    });
    const result = await applyProfilePlan(plan, options);
    expect(result.success).toBe(true);
    const files = {
      codex: 'codex/home/portable.config.toml',
      claude: 'claude/config/allagents.mcp.json',
      copilot: 'copilot/home/mcp-config.json',
      opencode: 'opencode/config/opencode.json',
    };
    const content = await readFile(join(root, 'home/.allagents/profiles/portable/clients', files[client]), 'utf8');
    let command: string, args: string[], env: Record<string, string>;
    if (client === 'codex') {
      const server = (Bun.TOML.parse(content) as { mcp_servers: Record<string, { command: string; args: string[]; env: Record<string, string> }> }).mcp_servers[serverName];
      ({ command, args, env } = server);
    } else if (client === 'opencode') {
      const server = JSON.parse(content).mcp[serverName];
      [command, ...args] = server.command;
      env = server.environment;
    } else {
      ({ command, args, env } = JSON.parse(content).mcpServers[serverName]);
    }
    expect(command).toBe('node');
    const child = Bun.spawnSync([command, ...args], { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(child.stdout)).root).toBe(join(root, 'repository'));
  });
  it('still rejects literal secrets in an authored override of a portable server', async () => {
    const userConfigPath = join(root, 'home/.allagents/workspace.yaml');
    await mkdir(join(root, 'home/.allagents'), { recursive: true });
    await writeFile(userConfigPath, stringify({ profiles: { portable: {
      plugins: [{ source: join(root, 'repository'), install: 'file' }],
      clients: [{ name: 'codex', install: 'file' }],
      mcpServers: { probe: { command: 'node', env: { TOKEN: 'literal-secret' } } },
    } } }));
    await expect(planProfileOperation('portable', 'install', { homeDir: join(root, 'home'), userConfigPath, workspaceDirectory: root, offline: true })).rejects.toThrow('exact');
  });

});
