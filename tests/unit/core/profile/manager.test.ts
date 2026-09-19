import { afterEach, describe, expect, it, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { dump } from 'js-yaml';
import packageJson from '../../../../package.json';
import {
  applyProfilePlan,
  getProfileStatus,
  getProfileStatuses,
  planProfileOperation,
  updateInstalledProfiles,
  type ProfileManagerDependencies,
  type ProfileRuntimeOptions,
} from '../../../../src/core/profile/index.js';
import { resolveOmpProfileMetadata } from '../../../../src/core/profile/native-metadata.js';
import type {
  ProfileAdapter,
  ProfileClientContext,
  ProfileMarketplaceRegistration,
  ProfileNativeCommandRequest,
  ProfileNativeMetadataOptions,
  ProfileResolvedPlugin,
  ProfileSerializationInput,
} from '../../../../src/core/profile/types.js';
import type {
  NativeClient,
  NativeInspectionResult,
  NativeMutationResult,
  NativeOperationContext,
  NativeResource,
  NativeResourceObservation,
} from '../../../../src/core/native/types.js';
import type { ClientType } from '../../../../src/models/workspace-config.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'allagents-profile-manager-'));
  roots.push(home);
  const workspaceDirectory = join(home, 'workspace');
  const userConfigPath = join(home, '.allagents', 'workspace.yaml');
  const binDir = join(home, 'bin');
  await mkdir(workspaceDirectory, { recursive: true });
  const options: ProfileRuntimeOptions = {
    homeDir: home,
    workspaceDirectory,
    userConfigPath,
    binDir,
    environment: { PATH: binDir },
    platform: 'linux',
  };
  return { home, workspaceDirectory, userConfigPath, binDir, options };
}

async function writeWorkspace(path: string, profiles: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, dump({ profiles }, { lineWidth: -1 }), 'utf8');
}

async function pluginFixture(root: string, name = 'demo', body = '# Demo\n'): Promise<string> {
  const plugin = join(root, `plugin-${name}`);
  await mkdir(join(plugin, 'skills', name), { recursive: true });
  await writeFile(join(plugin, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n${body}`, 'utf8');
  return plugin;
}

class MemoryNativeClient implements NativeClient {
  readonly client: string;
  readonly resources: NativeResource[] = [];
  readonly observations: NativeResourceObservation[] = [];
  readonly calls: string[] = [];
  failUpdate = false;
  failInstall = false;

  constructor(client: string) {
    this.client = client;
  }

  failInstallRegistration?: string;
  async isAvailable(): Promise<boolean> {
    return true;
  }

  supportsScope(): boolean {
    return true;
  }

  resolveSource(source: string, context: NativeOperationContext) {
    return {
      success: true,
      resource: this.resource(source, context),
    };
  }

  async inspect(): Promise<NativeInspectionResult> {
    return {
      success: true,
      resources: [...this.resources],
      observations: [...this.observations],
    };
  }

  async install(resource: NativeResource): Promise<NativeMutationResult> {
    this.calls.push(`install:${resource.resolvedIdentity}`);
    if (this.failInstall) {
      return { success: false, error: 'install failed' };
    }
    if (this.failInstallRegistration) {
      return {
        success: false,
        error: 'install failed after registration',
        registrations: [this.failInstallRegistration],
      };
    }
    if (!this.resources.some((entry) => entry.resolvedIdentity === resource.resolvedIdentity)) {
      this.resources.push(resource);
    }
    return { success: true };
  }
  async update(resource: NativeResource): Promise<NativeMutationResult> {
    this.calls.push(`update:${resource.resolvedIdentity}`);
    return this.failUpdate
      ? { success: false, error: `failed ${resource.resolvedIdentity}` }
      : { success: true };
  }

  async remove(resource: NativeResource): Promise<NativeMutationResult> {
    this.calls.push(`remove:${resource.resolvedIdentity}`);
    const index = this.resources.findIndex(
      (entry) => entry.resolvedIdentity === resource.resolvedIdentity,
    );
    if (index >= 0) this.resources.splice(index, 1);
    const observationIndex = this.observations.findIndex(
      (entry) =>
        entry.resource.resolvedIdentity === resource.resolvedIdentity,
    );
    if (observationIndex >= 0) this.observations.splice(observationIndex, 1);
    return { success: true };
  }

  resource(source: string, context: NativeOperationContext): NativeResource {
    const normalized = source.replace(/@[^@/]+$/, '');
    return {
      kind: 'package',
      requestedIdentity: source,
      resolvedIdentity: normalized,
      context,
      provenance: {
        packageIdentity: normalized,
        commandSource: source,
      },
    };
  }
}

class MemoryProfileAdapter implements ProfileAdapter {
  readonly capabilities = {
    nativeInstall: true,
    fileInstall: true,
    launchers: true,
    skillFilters: true,
    mcp: true,
    settings: false,
    status: true,
    cleanup: true,
    recursiveRootCleanup: true,
  };
  readonly nativeClient: MemoryNativeClient;
  readonly mcpPrerequisite:
    | {
        matches(resource: NativeResource): boolean;
        inspect(context: ProfileClientContext): Promise<{
          classification: string;
          packageSource?: string;
        }>;
      }
    | undefined;
  mcpInspections = 0;
  readonly marketplaceCalls: string[] = [];
  runtimeAvailable = true;
  runtimeChecks = 0;

  constructor(
    readonly client: ClientType,
    private readonly home: string,
  ) {
    this.nativeClient = new MemoryNativeClient(client);
    this.mcpPrerequisite =
      client === 'pi'
        ? {
            matches(resource) {
              return resource.resolvedIdentity === 'npm:pi-mcp-adapter';
            },
            inspect: () => this.inspectMcpAdapter(),
          }
        : undefined;
  }

  resolveContext(profileName: string, options: { workspaceDirectory: string }): ProfileClientContext {
    const root = join(this.home, '.allagents', 'profiles', profileName, 'clients', this.client, 'agent');
    const operationContext: NativeOperationContext = {
      client: this.client,
      scope: 'user',
      nativeScope: `profile:${profileName}`,
      root,
      cwd: options.workspaceDirectory,
      roots:
        this.client === 'omp'
          ? {
              agent: root,
              config: root,
              data: join(
                this.home,
                '.allagents',
                'profiles',
                profileName,
                'clients',
                this.client,
                'data',
              ),
            }
          : { agent: root },
    };
    return {
      profileName,
      client: this.client,
      mechanism: 'test-root',
      root,
      operationContext,
      fileMapping: { skillsPath: 'skills/', agentFile: 'AGENTS.md' },
      launcher: { command: this.client, args: [], env: {} },
    };
  }

  async isRuntimeAvailable() {
    this.runtimeChecks++;
    return this.runtimeAvailable;

  }

  resolveNativeSource(
    plugin: ProfileResolvedPlugin,
    context: ProfileClientContext,
  ) {
    if (
      this.client === 'omp' &&
      plugin.marketplace &&
      plugin.pluginName &&
      plugin.marketplaceSource
    ) {
      return {
        success: true,
        resource: {
          kind: 'plugin' as const,
          requestedIdentity: plugin.source,
          resolvedIdentity: `${plugin.pluginName}@${plugin.marketplace}`,
          context: context.operationContext,
          provenance: {
            marketplaceName: plugin.marketplace,
            marketplaceSource: plugin.marketplaceSource,
            ...(plugin.marketplaceRegistrationManaged && {
              managedMarketplaceRegistration: 'true',
            }),
          },
        },
      };
    }
    return this.nativeClient.resolveSource(
      plugin.source,
      context.operationContext,
    );
  }
  resolveNativeMetadata(
    plugin: ProfileResolvedPlugin,
    context: ProfileClientContext,
    options: ProfileNativeMetadataOptions,
  ) {
    return this.client === 'omp'
      ? resolveOmpProfileMetadata(plugin, context, options)
      : Promise.resolve(plugin);
  }

  discloseNativeCommands(
    request: ProfileNativeCommandRequest,
    context: ProfileClientContext,
  ) {
    if (request.kind === 'marketplace') {
      return [
        {
          command: 'omp',
          args: [
            '--profile',
            context.profileName,
            'plugin',
            'marketplace',
            'add',
            request.registration.source,
          ],
        },
      ];
    }
    return [
      {
        command: this.client,
        args:
          this.client === 'omp'
            ? [
                '--profile',
                context.profileName,
                'plugin',
                'install',
                '--scope',
                'user',
                request.resource.resolvedIdentity,
              ]
            : [
                request.action === 'remove' ? 'remove' : 'install',
                request.resource.requestedIdentity,
                '--no-approve',
              ],
      },
    ];
  }

  async applyMarketplaceRegistration(
    registration: ProfileMarketplaceRegistration,
  ) {
    this.marketplaceCalls.push(`register:${registration.name}`);
    return { success: true };
  }

  async removeMarketplaceRegistration() {
    return { success: true };
  }


  serializeSettings() {
    return null;
  }

  serializeMcp(context: ProfileClientContext, input: ProfileSerializationInput) {
    if (!input.mcpServers) return null;
    return {
      key: `${this.client}:mcp`,
      client: this.client,
      kind: 'mcp' as const,
      path: join(context.root, 'mcp.json'),
      content: `${JSON.stringify({ mcpServers: input.mcpServers }, null, 2)}\n`,
      mode: 0o600,
    };
  }

  async inspectMcpAdapter() {
    this.mcpInspections++;
    const usable = this.nativeClient.resources.some((resource) =>
      resource.resolvedIdentity === 'npm:pi-mcp-adapter',
    );
    return {
      classification: usable ? 'usable' : 'absent',
      ...(usable && { packageSource: 'npm:pi-mcp-adapter' }),
    };
  }
}

function dependencies(...adapters: MemoryProfileAdapter[]): ProfileManagerDependencies {
  return {
    getAdapter(client) {
      return adapters.find((adapter) => adapter.client === client) ?? null;
    },
  };
}

describe('profile lifecycle manager', () => {
  test.skipIf(process.platform !== 'win32')(
    'installs and executes generated Windows profile launchers through a nested command shim',
    async () => {
      const fixturePaths = await fixture();
      const launcherBin = join(fixturePaths.home, 'profile bin with spaces');
      const nativeBin = join(fixturePaths.home, 'native bin');
      const workingDirectory = join(fixturePaths.home, 'working directory');
      const nativeTarget = join(nativeBin, 'pi.js');
      const invoker = join(fixturePaths.home, 'invoke launcher.ps1');
      await Promise.all([
        mkdir(nativeBin, { recursive: true }),
        mkdir(workingDirectory, { recursive: true }),
      ]);
      const canonicalWorkingDirectory = await realpath(workingDirectory);
      await writeFile(
        nativeTarget,
        [
          '#!/usr/bin/env bun',
          "if (process.argv[2] === '--version') { console.log('0.85.1'); process.exit(0); }",
          "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR }));",
          'process.exit(23);',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(nativeBin, 'pi.cmd'),
        ['@echo off', 'bun "%~dp0\\pi.js" %*', 'exit /b %ERRORLEVEL%', ''].join('\r\n'),
        'utf8',
      );
      await writeFile(
        invoker,
        [
          'param(',
          '  [Parameter(Mandatory = $true, Position = 0)]',
          '  [string] $Launcher,',
          '  [Parameter(Mandatory = $true, Position = 1)]',
          '  [string] $Payload',
          ')',
          '$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload))',
          '$decoded = ConvertFrom-Json -InputObject $json',
          '$forwarded = @()',
          'foreach ($item in $decoded) { $forwarded += [string] $item }',
          '& $Launcher @forwarded',
          'exit $LASTEXITCODE',
          '',
        ].join('\r\n'),
        'utf8',
      );
      await writeWorkspace(fixturePaths.userConfigPath, {
        work: {
          clients: [{ name: 'pi', install: 'file', launcher: 'work' }],
          plugins: [],
        },
      });
      const pathKey =
        Object.keys(process.env).find((name) => name.toLowerCase() === 'path') ?? 'PATH';
      const environment = {
        ...process.env,
        [pathKey]: `${launcherBin};${nativeBin};${process.env[pathKey] ?? ''}`,
      };
      const options: ProfileRuntimeOptions = {
        ...fixturePaths.options,
        binDir: launcherBin,
        environment,
        platform: 'win32',
      };
      const agentDirectory = join(
        fixturePaths.home,
        '.allagents',
        'profiles',
        'work',
        'clients',
        'pi',
        'agent',
      );
      const plan = await planProfileOperation('work', 'install', options);
      expect((await applyProfilePlan(plan, options)).success).toBe(true);

      function invoke(runtimeArguments: readonly string[], launcher = 'work.ps1') {
        const child = spawnSync(
          'powershell.exe',
          [
            '-NoLogo',
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            invoker,
            launcher,
            Buffer.from(JSON.stringify(runtimeArguments), 'utf8').toString('base64'),
          ],
          {
            cwd: workingDirectory,
            env: environment,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        if (child.status !== 23) {
          throw new Error(
            `Expected Windows profile launcher exit 23, received ${String(child.status)}; signal=${String(child.signal)}; error=${child.error?.message ?? ''}; stdout=${JSON.stringify(child.stdout.toString())}; stderr=${JSON.stringify(child.stderr.toString())}`,
          );
        }
        return JSON.parse(child.stdout.toString()) as {
          args: string[];
          cwd: string;
          agentDir: string;
        };
      }
      const cmdArguments = [
        'space value',
        "single'quote",
        'plain-value',
        'trailing\\',
        'unicode-日本語',
      ];
      expect(invoke(cmdArguments, 'work.cmd')).toEqual({
        args: cmdArguments,
        cwd: canonicalWorkingDirectory,
        agentDir: agentDirectory,
      });
      const arbitrary = [
        'space value',
        'double"quote',
        "single'quote",
        'literal&operator',
        'literal|pipe',
        'literal^caret',
        'literal%PATH%',
        'backslash\\"quote',
        'trailing\\',
        '',
        'unicode-日本語',
      ];
      expect(invoke(arbitrary)).toEqual({
        args: arbitrary,
        cwd: canonicalWorkingDirectory,
        agentDir: agentDirectory,
      });
    },
    30_000,
  );
  it('honors plugin install precedence and client selectors before planning', async () => {
    const test = await fixture();
    const local = await pluginFixture(test.workspaceDirectory);
    await writeWorkspace(test.userConfigPath, {
      work: {
        clients: [{ name: 'pi', install: 'native' }],
        plugins: [
          { source: local, install: 'file', clients: ['pi'] },
          { source: 'npm:default', clients: ['pi'] },
          { source: 'npm:override', install: 'native', clients: ['pi'] },
        ],
      },
    });
    const pi = new MemoryProfileAdapter('pi', test.home);
    const plan = await planProfileOperation(
      'work',
      'install',
      test.options,
      dependencies(pi),
    );

    expect(plan.steps.some((step) => step.client === 'pi' && step.kind === 'native' && step.identity === 'npm:default')).toBe(true);
    expect(plan.steps.some((step) => step.client === 'pi' && step.kind === 'native' && step.identity === 'npm:override')).toBe(true);
    expect(plan.steps.some((step) => step.client === 'pi' && step.kind === 'file')).toBe(true);

    await writeWorkspace(test.userConfigPath, {
      invalid: {
        clients: [{ name: 'pi' }],
        plugins: [{ source: local, clients: ['omp'] }],
      },
    });
    await expect(planProfileOperation('invalid', 'install', test.options, dependencies(pi))).rejects.toThrow("not declared by this profile");
  });

  it('checks adapter runtime support for file-only plans and status', async () => {
    const test = await fixture();
    const local = await pluginFixture(test.workspaceDirectory);
    await writeWorkspace(test.userConfigPath, {
      work: {
        clients: [{ name: 'pi', install: 'file' }],
        plugins: [{ source: local, install: 'file', clients: ['pi'] }],
      },
    });
    const pi = new MemoryProfileAdapter('pi', test.home);
    pi.runtimeAvailable = false;
    const deps = dependencies(pi);

    await expect(
      planProfileOperation('work', 'install', test.options, deps),
    ).rejects.toThrow('pi CLI is unavailable or unsupported');
    const status = (await getProfileStatuses(test.options, deps)).find(
      (entry) => entry.profile === 'work',
    );
    expect(status?.status).toBe('unsupported');
    expect(pi.runtimeChecks).toBe(2);
  });

  it('rejects unsupported skill filtering and unowned collisions before mutation', async () => {
    const test = await fixture();
    const local = await pluginFixture(test.workspaceDirectory);
    await writeWorkspace(test.userConfigPath, {
      work: { clients: [{ name: 'pi' }], plugins: [{ source: local, skills: ['demo'] }] },
    });
    const pi = new MemoryProfileAdapter('pi', test.home);
    (pi.capabilities as { skillFilters: boolean }).skillFilters = false;
    await expect(planProfileOperation('work', 'install', test.options, dependencies(pi))).rejects.toThrow('does not support plugin skill filters');

    (pi.capabilities as { skillFilters: boolean }).skillFilters = true;
    const destination = join(test.home, '.allagents', 'profiles', 'work', 'clients', 'pi', 'agent', 'skills', 'demo', 'SKILL.md');
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, 'user owned', 'utf8');
    await expect(planProfileOperation('work', 'install', test.options, dependencies(pi))).rejects.toThrow('collides with an unowned file');
  });

  it('keeps dry-run side-effect free and fails closed on malformed state', async () => {
    const test = await fixture();
    const local = await pluginFixture(test.workspaceDirectory);
    await writeWorkspace(test.userConfigPath, {
      work: { clients: [{ name: 'pi' }], plugins: [local] },
    });
    const pi = new MemoryProfileAdapter('pi', test.home);
    const plan = await planProfileOperation('work', 'install', { ...test.options, dryRun: true }, dependencies(pi));
    const result = await applyProfilePlan(plan, { ...test.options, dryRun: true }, dependencies(pi));
    expect(result.success).toBe(true);
    await expect(stat(join(test.home, '.allagents', 'profiles', 'work', 'state.json'))).rejects.toThrow();

    const statePath = join(test.home, '.allagents', 'profiles', 'work', 'state.json');
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, '{broken', 'utf8');
    await expect(planProfileOperation('work', 'install', test.options, dependencies(pi))).rejects.toThrow('state is malformed');
  });

  it('orders and revalidates a declared Pi MCP adapter before writing MCP', async () => {
    const test = await fixture();
    await writeWorkspace(test.userConfigPath, {
      work: {
        clients: [{ name: 'pi', install: 'native' }],
        plugins: ['npm:other', 'npm:pi-mcp-adapter'],
        mcpServers: {
          docs: {
            command: 'docs-mcp',
            args: ['--token', '${API_TOKEN}'],
            env: { API_TOKEN: '${API_TOKEN}' },
          },
        },
      },
    });
    const pi = new MemoryProfileAdapter('pi', test.home);
    const plan = await planProfileOperation('work', 'install', test.options, dependencies(pi));
    const adapterIndex = plan.steps.findIndex((step) => step.kind === 'native' && step.identity === 'npm:pi-mcp-adapter');
    const mcpIndex = plan.steps.findIndex((step) => step.kind === 'mcp');
    expect(adapterIndex).toBeGreaterThan(-1);
    expect(adapterIndex).toBeLessThan(mcpIndex);
    expect(plan.steps[mcpIndex]?.detail?.mcpServers?.[0]?.requestedSecrets).toEqual(['API_TOKEN']);
    expect(
      plan.steps[mcpIndex]?.detail?.mcpServers?.[0]?.command?.args,
    ).toEqual(['--token', '[REDACTED]']);

    const result = await applyProfilePlan(plan, test.options, dependencies(pi));
    expect(result.success).toBe(true);
    expect(pi.mcpInspections).toBe(1);
    expect(await readFile(join(test.home, '.allagents', 'profiles', 'work', 'clients', 'pi', 'agent', 'mcp.json'), 'utf8')).toContain('docs-mcp');
  });

  it('applies profile proxy policy after client selection', async () => {
    const test = await fixture();
    await writeWorkspace(test.userConfigPath, {
      markets: {
        clients: [{ name: 'codex' }, { name: 'omp' }],
        plugins: [],
        mcpServers: {
          tradingview: {
            url: 'https://mcp.tradingview.com/mcp',
            headers: { Authorization: '${TRADINGVIEW_TOKEN}' },
            clients: ['codex'],
          },
          excluded: {
            url: 'https://mcp.example/excluded',
            clients: ['omp'],
          },
        },
        mcpProxy: {
          servers: {
            tradingview: { proxy: ['codex'] },
            excluded: { proxy: ['codex'] },
          },
        },
      },
    });
    const codex = new MemoryProfileAdapter('codex', test.home);
    const omp = new MemoryProfileAdapter('omp', test.home);
    const deps = dependencies(codex, omp);

    const plan = await planProfileOperation(
      'markets',
      'install',
      test.options,
      deps,
    );
    const mcpStep = plan.steps.find(
      (step) => step.kind === 'mcp' && step.client === 'codex',
    );
    expect(mcpStep?.detail?.mcpServers).toEqual([
      {
        name: 'tradingview',
        transport: 'stdio',
        command: {
          command: 'npx',
          args: [
            '-y',
            `allagents@${packageJson.version}`,
            'mcp',
            'proxy',
            'https://mcp.tradingview.com/mcp',
            '--profile',
            'markets',
            '--header-env',
            'Authorization=TRADINGVIEW_TOKEN',
          ],
        },
        requestedSecrets: ['TRADINGVIEW_TOKEN'],
      },
    ]);

    expect((await applyProfilePlan(plan, test.options, deps)).success).toBe(true);
    const mcpPath = join(
      test.home,
      '.allagents',
      'profiles',
      'markets',
      'clients',
      'codex',
      'agent',
      'mcp.json',
    );
    expect(JSON.parse(await readFile(mcpPath, 'utf8'))).toEqual({
      mcpServers: {
        tradingview: {
          command: 'npx',
          args: [
            '-y',
            `allagents@${packageJson.version}`,
            'mcp',
            'proxy',
            'https://mcp.tradingview.com/mcp',
            '--profile',
            'markets',
            '--header-env',
            'Authorization=TRADINGVIEW_TOKEN',
          ],
          env: { TRADINGVIEW_TOKEN: '${TRADINGVIEW_TOKEN}' },
        },
      },
    });
  });

  it('references a usable preexisting Pi MCP adapter without taking cleanup ownership', async () => {
    const test = await fixture();
    await writeWorkspace(test.userConfigPath, {
      work: {
        clients: [{ name: 'pi' }],
        plugins: [],
        mcpServers: { docs: { command: 'docs-mcp' } },
      },
    });
    const pi = new MemoryProfileAdapter('pi', test.home);
    const context = pi.resolveContext('work', { workspaceDirectory: test.workspaceDirectory });
    pi.nativeClient.resources.push(pi.nativeClient.resource('npm:pi-mcp-adapter', context.operationContext));
    const plan = await planProfileOperation('work', 'install', test.options, dependencies(pi));
    expect(plan.steps.find((step) => step.kind === 'native')?.action).toBe('reference');
    const result = await applyProfilePlan(plan, test.options, dependencies(pi));
    expect(result.success).toBe(true);
    expect(pi.nativeClient.calls).toEqual([]);
  });

  it('rejects a preexisting disabled native plugin without taking ownership', async () => {
    const test = await fixture();
    await writeWorkspace(test.userConfigPath, {
      work: {
        clients: [{ name: 'pi', install: 'native' }],
        plugins: ['npm:external'],
      },
    });
    const pi = new MemoryProfileAdapter('pi', test.home);
    const context = pi.resolveContext('work', test.options);
    pi.nativeClient.observations.push({
      resource: pi.nativeClient.resource(
        'npm:external',
        context.operationContext,
      ),
      status: 'disabled',
    });

    await expect(
      planProfileOperation(
        'work',
        'install',
        test.options,
        dependencies(pi),
      ),
    ).rejects.toThrow(
      "Native profile plugin 'npm:external' is disabled and is not owned by AllAgents",
    );
    expect(pi.nativeClient.calls).toEqual([]);
  });

  it('rejects a referenced native plugin that becomes disabled', async () => {
    const test = await fixture();
    await writeWorkspace(test.userConfigPath, {
      work: {
        clients: [{ name: 'pi', install: 'native' }],
        plugins: ['npm:external'],
      },
    });
    const pi = new MemoryProfileAdapter('pi', test.home);
    const context = pi.resolveContext('work', test.options);
    pi.nativeClient.resources.push(
      pi.nativeClient.resource('npm:external', context.operationContext),
    );
    const deps = dependencies(pi);
    const install = await planProfileOperation(
      'work',
      'install',
      test.options,
      deps,
    );
    expect((await applyProfilePlan(install, test.options, deps)).success).toBe(
      true,
    );
    const referenced = pi.nativeClient.resources.pop();
    expect(referenced).toBeDefined();
    pi.nativeClient.observations.push({
      resource: referenced as NativeResource,
      status: 'disabled',
    });
    pi.nativeClient.calls.length = 0;

    await expect(
      planProfileOperation('work', 'update', test.options, deps),
    ).rejects.toThrow(
      "Native profile plugin 'npm:external' is disabled and is not owned by AllAgents",
    );
    expect(pi.nativeClient.calls).toEqual([]);
  });

  it('removes a managed native plugin after it becomes disabled', async () => {
    const test = await fixture();
    await writeWorkspace(test.userConfigPath, {
      work: {
        clients: [{ name: 'pi', install: 'native' }],
        plugins: ['npm:managed'],
      },
    });
    const pi = new MemoryProfileAdapter('pi', test.home);
    const deps = dependencies(pi);
    const install = await planProfileOperation(
      'work',
      'install',
      test.options,
      deps,
    );
    expect((await applyProfilePlan(install, test.options, deps)).success).toBe(
      true,
    );
    const managed = pi.nativeClient.resources.pop();
    expect(managed).toBeDefined();
    pi.nativeClient.observations.push({
      resource: managed as NativeResource,
      status: 'disabled',
    });
    pi.nativeClient.calls.length = 0;

    const removal = await planProfileOperation(
      'work',
      'remove',
      test.options,
      deps,
    );
    expect(
      removal.steps.find((step) => step.kind === 'native')?.action,
    ).toBe('remove');
    expect((await applyProfilePlan(removal, test.options, deps)).success).toBe(
      true,
    );
    expect(pi.nativeClient.calls).toEqual(['remove:npm:managed']);
  });

  it('releases stale referenced relationships during update', async () => {
    const test = await fixture();
    await writeWorkspace(test.userConfigPath, {
      work: {
        clients: [{ name: 'pi', install: 'native' }],
        plugins: ['npm:external'],
      },
    });
    const pi = new MemoryProfileAdapter('pi', test.home);
    pi.nativeClient.resources.push(
      pi.nativeClient.resource(
        'npm:external',
        pi.resolveContext('work', test.options).operationContext,
      ),
    );
    const deps = dependencies(pi);
    const install = await planProfileOperation('work', 'install', test.options, deps);
    await applyProfilePlan(install, test.options, deps);
    await writeWorkspace(test.userConfigPath, {
      work: { clients: [{ name: 'pi', install: 'native' }], plugins: [] },
    });
    const update = await planProfileOperation('work', 'update', test.options, deps);
    expect(
      update.steps.find(
        (step) => step.kind === 'native' && step.identity === 'npm:external',
      )?.action,
    ).toBe('retain');
    await applyProfilePlan(update, test.options, deps);
    const state = JSON.parse(
      await readFile(
        join(test.home, '.allagents', 'profiles', 'work', 'state.json'),
        'utf8',
      ),
    ) as { resources: Array<{ kind: string; identity: string }> };
    expect(
      state.resources.some(
        (resource) =>
          resource.kind === 'native' && resource.identity === 'npm:external',
      ),
    ).toBe(false);
  });

  it('releases retained modified files after preserving them', async () => {
    const test = await fixture();
    const local = await pluginFixture(test.workspaceDirectory);
    await writeWorkspace(test.userConfigPath, {
      work: { clients: [{ name: 'pi' }], plugins: [local] },
    });
    const pi = new MemoryProfileAdapter('pi', test.home);
    const deps = dependencies(pi);
    const install = await planProfileOperation('work', 'install', test.options, deps);
    expect((await applyProfilePlan(install, test.options, deps)).success).toBe(true);
    const destination = install.steps.find((step) => step.kind === 'file')?.identity;
    expect(destination).toBeTruthy();

    const repeat = await planProfileOperation('work', 'update', test.options, deps);
    expect(repeat.steps.find((step) => step.identity === destination)?.action).toBe('unchanged');
    expect((await applyProfilePlan(repeat, test.options, deps)).success).toBe(true);

    await writeFile(destination as string, 'user modified', 'utf8');
    await writeWorkspace(test.userConfigPath, {
      work: { clients: [{ name: 'pi' }], plugins: [] },
    });
    const stale = await planProfileOperation('work', 'update', test.options, deps);
    expect(stale.steps.find((step) => step.identity === destination)?.action).toBe('retain');
    const staleResult = await applyProfilePlan(stale, test.options, deps);
    expect(staleResult.status).toBe('installed');
    expect(staleResult.success).toBe(true);
    expect(staleResult.error).toBeUndefined();
    expect(await readFile(destination as string, 'utf8')).toBe('user modified');
    const state = JSON.parse(
      await readFile(
        join(test.home, '.allagents', 'profiles', 'work', 'state.json'),
        'utf8',
      ),
    ) as { resources: Array<{ identity: string }> };
    expect(
      state.resources.some((resource) => resource.identity === destination),
    ).toBe(false);
  });

  it('releases files retained because they changed after planning', async () => {
    const test = await fixture();
    const local = await pluginFixture(test.workspaceDirectory);
    await writeWorkspace(test.userConfigPath, {
      work: { clients: [{ name: 'pi' }], plugins: [local] },
    });
    const pi = new MemoryProfileAdapter('pi', test.home);
    const deps = dependencies(pi);
    const install = await planProfileOperation(
      'work',
      'install',
      test.options,
      deps,
    );
    await applyProfilePlan(install, test.options, deps);
    const destination = install.steps.find((step) => step.kind === 'file')
      ?.identity as string;

    await writeWorkspace(test.userConfigPath, {
      work: { clients: [{ name: 'pi' }], plugins: [] },
    });
    const update = await planProfileOperation(
      'work',
      'update',
      test.options,
      deps,
    );
    expect(
      update.steps.find((step) => step.identity === destination)?.action,
    ).toBe('remove');
    await writeFile(destination, 'changed after planning', 'utf8');

    const result = await applyProfilePlan(update, test.options, deps);
    expect(result.status).toBe('installed');
    expect(result.success).toBe(true);
    expect(await readFile(destination, 'utf8')).toBe('changed after planning');
    const state = JSON.parse(
      await readFile(
        join(test.home, '.allagents', 'profiles', 'work', 'state.json'),
        'utf8',
      ),
    ) as { resources: Array<{ identity: string }> };
    expect(
      state.resources.some((resource) => resource.identity === destination),
    ).toBe(false);
  });

  it('preserves the published fingerprint across a failed file update and retries it', async () => {
    const test = await fixture();
    const local = await pluginFixture(test.workspaceDirectory);
    await writeWorkspace(test.userConfigPath, {
      work: { clients: [{ name: 'pi' }], plugins: [local] },
    });
    const pi = new MemoryProfileAdapter('pi', test.home);
    const deps = dependencies(pi);
    const install = await planProfileOperation('work', 'install', test.options, deps);
    await applyProfilePlan(install, test.options, deps);
    const destination = install.steps.find((step) => step.kind === 'file')
      ?.identity as string;
    const published = await readFile(destination, 'utf8');
    await writeFile(
      join(local, 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: test\n---\n# Updated\n',
      'utf8',
    );
    const update = await planProfileOperation('work', 'update', test.options, deps);
    await writeFile(destination, 'raced', 'utf8');
    const failed = await applyProfilePlan(update, test.options, deps);
    expect(failed.success).toBe(false);

    await writeFile(destination, published);
    const [retried] = await updateInstalledProfiles(
      ['work'],
      test.options,
      deps,
    );
    expect(retried?.success).toBe(true);
    expect(await readFile(destination, 'utf8')).toContain('# Updated');
  });

  it('refuses recursive cleanup when recorded root ownership points elsewhere', async () => {
    const test = await fixture();
    await writeWorkspace(test.userConfigPath, {
      work: { clients: [{ name: 'pi' }], plugins: [] },
    });
    const pi = new MemoryProfileAdapter('pi', test.home);
    const deps = dependencies(pi);
    const install = await planProfileOperation('work', 'install', test.options, deps);
    await applyProfilePlan(install, test.options, deps);
    const unrelated = join(test.home, 'unrelated');
    const sentinel = join(unrelated, 'keep.txt');
    await mkdir(unrelated);
    await writeFile(sentinel, 'owned by user', 'utf8');
    const statePath = join(
      test.home,
      '.allagents',
      'profiles',
      'work',
      'state.json',
    );
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      resources: Array<{ kind: string; identity: string; path?: string }>;
    };
    const root = state.resources.find((resource) => resource.kind === 'root');
    expect(root).toBeTruthy();
    if (!root) throw new Error('expected root relationship');
    root.identity = unrelated;
    root.path = unrelated;
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');

    const removal = await planProfileOperation('work', 'remove', test.options, deps);
    const result = await applyProfilePlan(removal, test.options, deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain('outside the selected client root');
    expect(await readFile(sentinel, 'utf8')).toBe('owned by user');
  });

  it('completes removal while preserving modified managed files', async () => {
    const test = await fixture();
    const local = await pluginFixture(test.workspaceDirectory);
    await writeWorkspace(test.userConfigPath, {
      work: { clients: [{ name: 'pi' }], plugins: [local] },
    });
    const pi = new MemoryProfileAdapter('pi', test.home);
    const deps = dependencies(pi);
    const install = await planProfileOperation('work', 'install', test.options, deps);
    await applyProfilePlan(install, test.options, deps);
    const destination = install.steps.find((step) => step.kind === 'file')
      ?.identity as string;
    await writeFile(destination, 'modified', 'utf8');
    const removal = await planProfileOperation('work', 'remove', test.options, deps);
    const result = await applyProfilePlan(removal, test.options, deps);
    expect(result.status).toBe('removed');
    expect(result.success).toBe(true);
    expect(await readFile(destination, 'utf8')).toBe('modified');
    await expect(
      stat(join(test.home, '.allagents', 'profiles', 'work', 'state.json')),
    ).rejects.toThrow();
  });

  it('reports and removes declaration-missing state even without a workspace file', async () => {
    const test = await fixture();
    const local = await pluginFixture(test.workspaceDirectory);
    await writeWorkspace(test.userConfigPath, {
      work: { clients: [{ name: 'pi' }], plugins: [local] },
    });
    const pi = new MemoryProfileAdapter('pi', test.home);
    const deps = dependencies(pi);
    const install = await planProfileOperation('work', 'install', test.options, deps);
    await applyProfilePlan(install, test.options, deps);
    await rm(test.userConfigPath);

    const before = await getProfileStatus('work', test.options, deps);
    expect(before.status).toBe('declaration-missing');
    expect(before.installed).toBe(true);
    expect((await getProfileStatuses(test.options, deps)).map((entry) => entry.profile)).toContain('work');

    const removePlan = await planProfileOperation('work', 'remove', test.options, deps);
    const removed = await applyProfilePlan(removePlan, test.options, deps);
    expect(removed.status).toBe('removed');
    await expect(stat(join(test.home, '.allagents', 'profiles', 'work', 'state.json'))).rejects.toThrow();
    await expect(
      stat(join(test.home, '.allagents', 'profiles', 'work')),
    ).rejects.toThrow();
  });

  it('excludes empty and invalid profile directories without losing declared or installed profiles', async () => {
    const test = await fixture();
    await writeWorkspace(test.userConfigPath, {
      orphan: { clients: [{ name: 'pi' }], plugins: [] },
    });
    const pi = new MemoryProfileAdapter('pi', test.home);
    const deps = dependencies(pi);
    const install = await planProfileOperation(
      'orphan',
      'install',
      test.options,
      deps,
    );
    expect((await applyProfilePlan(install, test.options, deps)).success).toBe(
      true,
    );

    await writeWorkspace(test.userConfigPath, {
      declared: { clients: [{ name: 'pi' }], plugins: [] },
    });
    const profilesRoot = join(test.home, '.allagents', 'profiles');
    await mkdir(join(profilesRoot, 'empty'), { recursive: true });
    const invalidRoot = join(profilesRoot, 'Invalid Profile');
    await mkdir(invalidRoot, { recursive: true });
    await writeFile(join(invalidRoot, 'state.json'), '{broken', 'utf8');

    const statuses = await getProfileStatuses(test.options, deps);

    expect(
      statuses.map(({ profile, status, declared, installed }) => ({
        profile,
        status,
        declared,
        installed,
      })),
    ).toEqual([
      {
        profile: 'declared',
        status: 'missing',
        declared: true,
        installed: false,
      },
      {
        profile: 'orphan',
        status: 'declaration-missing',
        declared: false,
        installed: true,
      },
    ]);
  });

  it('removes runtime artifacts inside an AllAgents-owned profile root', async () => {
    const test = await fixture();
    await writeWorkspace(test.userConfigPath, {
      work: { clients: [{ name: 'pi' }], plugins: [] },
    });
    const pi = new MemoryProfileAdapter('pi', test.home);
    const deps = dependencies(pi);
    const install = await planProfileOperation('work', 'install', test.options, deps);
    expect((await applyProfilePlan(install, test.options, deps)).success).toBe(true);
    const clientRoot = install.clients[0]?.root as string;
    await mkdir(join(clientRoot, 'logs'), { recursive: true });
    await writeFile(join(clientRoot, 'logs', 'runtime.log'), 'runtime state', 'utf8');

    const removal = await planProfileOperation('work', 'remove', test.options, deps);
    expect((await applyProfilePlan(removal, test.options, deps)).status).toBe(
      'removed',
    );
    await expect(stat(clientRoot)).rejects.toThrow();
  });

  it('removes profile-owned OAuth state while preserving unrelated residue', async () => {
    const test = await fixture();
    await writeWorkspace(test.userConfigPath, {
      work: { clients: [{ name: 'pi' }], plugins: [] },
    });
    const pi = new MemoryProfileAdapter('pi', test.home);
    const deps = dependencies(pi);
    const install = await planProfileOperation(
      'work',
      'install',
      test.options,
      deps,
    );
    expect((await applyProfilePlan(install, test.options, deps)).success).toBe(
      true,
    );
    const profileRoot = join(test.home, '.allagents', 'profiles', 'work');
    const oauthRoot = join(profileRoot, 'oauth-proxy');
    const residue = join(profileRoot, 'notes.txt');
    await mkdir(join(oauthRoot, 'server'), { recursive: true });
    await writeFile(join(oauthRoot, 'server', 'tokens.json'), '{}', 'utf8');
    await writeFile(residue, 'keep', 'utf8');

    const removal = await planProfileOperation(
      'work',
      'remove',
      test.options,
      deps,
    );
    const result = await applyProfilePlan(removal, test.options, deps);

    expect(result.status).toBe('removed');
    await expect(stat(oauthRoot)).rejects.toThrow();
    expect(await readFile(residue, 'utf8')).toBe('keep');
    await expect(stat(join(profileRoot, 'state.json'))).rejects.toThrow();
  });

  it('removes OAuth state for a declared profile that was never installed', async () => {
    const test = await fixture();
    await writeWorkspace(test.userConfigPath, {
      work: { clients: [{ name: 'pi' }], plugins: [] },
    });
    const deps = dependencies(new MemoryProfileAdapter('pi', test.home));
    const profileRoot = join(test.home, '.allagents', 'profiles', 'work');
    const oauthRoot = join(profileRoot, 'oauth-proxy');
    await mkdir(join(oauthRoot, 'server'), { recursive: true });
    await writeFile(join(oauthRoot, 'server', 'tokens.json'), '{}', 'utf8');

    const removal = await planProfileOperation(
      'work',
      'remove',
      test.options,
      deps,
    );
    const result = await applyProfilePlan(removal, test.options, deps);

    expect(result.status).toBe('removed');
    await expect(stat(oauthRoot)).rejects.toThrow();
    await expect(stat(join(profileRoot, 'state.json'))).rejects.toThrow();
  });

  it('rejects a symlinked OAuth root without deleting its target or removal state', async () => {
    const test = await fixture();
    await writeWorkspace(test.userConfigPath, {
      work: { clients: [{ name: 'pi' }], plugins: [] },
    });
    const deps = dependencies(new MemoryProfileAdapter('pi', test.home));
    const install = await planProfileOperation(
      'work',
      'install',
      test.options,
      deps,
    );
    expect((await applyProfilePlan(install, test.options, deps)).success).toBe(
      true,
    );
    const profileRoot = join(test.home, '.allagents', 'profiles', 'work');
    const oauthRoot = join(profileRoot, 'oauth-proxy');
    const externalRoot = join(test.home, 'external-oauth');
    const externalToken = join(externalRoot, 'tokens.json');
    await mkdir(externalRoot, { recursive: true });
    await writeFile(externalToken, 'keep', 'utf8');
    await symlink(externalRoot, oauthRoot, 'dir');

    const removal = await planProfileOperation(
      'work',
      'remove',
      test.options,
      deps,
    );
    const result = await applyProfilePlan(removal, test.options, deps);

    expect(result.status).toBe('partial');
    expect(result.success).toBe(false);
    expect(result.error).toContain('symbolic link');
    expect(await readFile(externalToken, 'utf8')).toBe('keep');
    expect((await stat(join(profileRoot, 'state.json'))).isFile()).toBe(true);

    await unlink(oauthRoot);
    const retry = await planProfileOperation(
      'work',
      'remove',
      test.options,
      deps,
    );
    expect((await applyProfilePlan(retry, test.options, deps)).status).toBe(
      'removed',
    );
  });

  it('inspects replaced managed roots for state-only clients', async () => {
    const test = await fixture();
    await writeWorkspace(test.userConfigPath, {
      work: { clients: [{ name: 'pi' }], plugins: [] },
    });
    const pi = new MemoryProfileAdapter('pi', test.home);
    const deps = dependencies(pi);
    const plan = await planProfileOperation('work', 'install', test.options, deps);
    await applyProfilePlan(plan, test.options, deps);
    await rm(test.userConfigPath);
    const clientRoot = plan.clients[0]?.root as string;
    await rm(clientRoot, { recursive: true, force: true });
    await writeFile(clientRoot, 'not a directory', 'utf8');
    const result = await getProfileStatus('work', test.options, deps);
    expect(result.clients).toContain('pi');
    expect(result.status).toBe('declaration-missing');
    expect(
      result.steps.find((step) => step.kind === 'root')?.status,
    ).toBe('failed');
  });

  it('keeps status read-only while detecting fingerprint drift', async () => {
    const test = await fixture();
    const local = await pluginFixture(test.workspaceDirectory);
    await writeWorkspace(test.userConfigPath, {
      work: { clients: [{ name: 'pi' }], plugins: [local] },
    });
    const pi = new MemoryProfileAdapter('pi', test.home);
    const deps = dependencies(pi);
    const plan = await planProfileOperation('work', 'install', test.options, deps);
    await applyProfilePlan(plan, test.options, deps);
    const statePath = join(test.home, '.allagents', 'profiles', 'work', 'state.json');
    const before = await readFile(statePath);
    const file = plan.steps.find((step) => step.kind === 'file')?.identity as string;
    await writeFile(file, 'drift', 'utf8');

    const statusResult = await getProfileStatus('work', test.options, deps);
    expect(statusResult.status).toBe('drifted');
    expect(await readFile(statePath)).toEqual(before);
  });

  it('checkpoints registration side effects returned with a failed native install', async () => {
    const test = await fixture();
    await writeWorkspace(test.userConfigPath, {
      work: {
        clients: [{ name: 'pi', install: 'native' }],
        plugins: ['npm:partial'],
      },
    });
    const pi = new MemoryProfileAdapter('pi', test.home);
    pi.nativeClient.failInstallRegistration = 'catalog-source';
    const deps = dependencies(pi);
    const plan = await planProfileOperation('work', 'install', test.options, deps);
    const result = await applyProfilePlan(plan, test.options, deps);
    expect(result.success).toBe(false);
    const state = JSON.parse(
      await readFile(
        join(test.home, '.allagents', 'profiles', 'work', 'state.json'),
        'utf8',
      ),
    ) as { resources: Array<{ kind: string; identity: string }> };
    expect(state.resources).toContainEqual(
      expect.objectContaining({ kind: 'marketplace', identity: 'catalog-source' }),
    );
  });

  it('discloses OMP marketplace registration before plugin installation', async () => {
    const test = await fixture();
    const marketplace = join(test.workspaceDirectory, 'catalog');
    await mkdir(join(marketplace, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(marketplace, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'catalog',
        owner: { name: 'test' },
        plugins: [{ name: 'tool', source: './tool' }],
      }),
      'utf8',
    );
    await writeWorkspace(test.userConfigPath, {
      work: {
        clients: [{ name: 'omp', install: 'native' }],
        plugins: [marketplace],
      },
    });
    const omp = new MemoryProfileAdapter('omp', test.home);
    const plan = await planProfileOperation(
      'work',
      'install',
      test.options,
      dependencies(omp),
    );
    const commands = plan.steps.flatMap((step) => step.detail?.commands ?? []);
    expect(commands.map(({ args }) => args.slice(2, 5).join(' '))).toEqual([
      'plugin marketplace add',
      'plugin install --scope',
    ]);
  });

  it('checkpoints an OMP marketplace before a dependent plugin failure', async () => {
    const test = await fixture();
    const marketplace = join(test.workspaceDirectory, 'checkpoint-catalog');
    await mkdir(join(marketplace, '.claude-plugin'), { recursive: true });
    await writeFile(
      join(marketplace, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'checkpoint-catalog',
        owner: { name: 'test' },
        plugins: [{ name: 'tool', source: './tool' }],
      }),
      'utf8',
    );
    await writeWorkspace(test.userConfigPath, {
      work: {
        clients: [{ name: 'omp', install: 'native' }],
        plugins: [marketplace],
      },
    });
    const omp = new MemoryProfileAdapter('omp', test.home);
    omp.nativeClient.failInstall = true;
    const deps = dependencies(omp);
    const plan = await planProfileOperation(
      'work',
      'install',
      test.options,
      deps,
    );
    expect(
      plan.steps
        .filter((step) => ['marketplace', 'native'].includes(step.kind))
        .map((step) => step.kind),
    ).toEqual(['marketplace', 'native']);

    const result = await applyProfilePlan(plan, test.options, deps);
    expect(result.success).toBe(false);
    expect(omp.marketplaceCalls).toEqual(['register:checkpoint-catalog']);
    const state = JSON.parse(
      await readFile(
        join(test.home, '.allagents', 'profiles', 'work', 'state.json'),
        'utf8',
      ),
    ) as {
      resources: Array<{
        kind: string;
        identity: string;
        transition: string;
      }>;
    };
    expect(state.resources).toContainEqual(
      expect.objectContaining({
        kind: 'marketplace',
        identity: 'checkpoint-catalog',
        transition: 'installed',
      }),
    );
  });

  it('rejects direct OMP plugin IDs absent from the selected profile registry', async () => {
    const test = await fixture();
    await writeWorkspace(test.userConfigPath, {
      work: {
        clients: [{ name: 'omp', install: 'native' }],
        plugins: ['tool@missing-marketplace'],
      },
    });
    const omp = new MemoryProfileAdapter('omp', test.home);
    await expect(
      planProfileOperation('work', 'install', test.options, dependencies(omp)),
    ).rejects.toThrow('authoritative single catalog identity');
    await expect(
      stat(join(test.home, '.allagents', 'profiles', 'work', 'state.json')),
    ).rejects.toThrow();
  });

  it('plans every batch profile before applying and continues after independent failures', async () => {
    const test = await fixture();
    await writeWorkspace(test.userConfigPath, {
      first: { clients: [{ name: 'pi', install: 'native' }], plugins: ['npm:first'] },
      second: { clients: [{ name: 'pi', install: 'native' }], plugins: ['npm:second'] },
    });
    const pi = new MemoryProfileAdapter('pi', test.home);
    const deps = dependencies(pi);
    for (const name of ['first', 'second']) {
      const plan = await planProfileOperation(name, 'install', test.options, deps);
      await applyProfilePlan(plan, test.options, deps);
    }
    pi.nativeClient.calls.length = 0;
    pi.nativeClient.failUpdate = true;
    const originalUpdate = pi.nativeClient.update.bind(pi.nativeClient);
    pi.nativeClient.update = async (resource) => {
      if (resource.resolvedIdentity === 'npm:first') return originalUpdate(resource);
      pi.nativeClient.calls.push(`update:${resource.resolvedIdentity}`);
      return { success: true };
    };
    const results = await updateInstalledProfiles(['first', 'first', 'second'], test.options, deps);
    expect(results.map((result) => result.profile)).toEqual(['first', 'second']);
    expect(results.map((result) => result.success)).toEqual([false, true]);
    expect(pi.nativeClient.calls).toEqual(['update:npm:first', 'update:npm:second']);

    pi.nativeClient.failUpdate = false;
    const reinstall = await planProfileOperation('first', 'update', test.options, deps);
    await applyProfilePlan(reinstall, test.options, deps);
    const missing = join(test.workspaceDirectory, 'missing-plugin');
    await writeWorkspace(test.userConfigPath, {
      first: { clients: [{ name: 'pi', install: 'native' }], plugins: ['npm:first'] },
      second: {
        clients: [{ name: 'pi', install: 'native' }],
        plugins: ['npm:second', { source: missing, install: 'file' }],
      },
    });
    pi.nativeClient.calls.length = 0;
    await expect(
      updateInstalledProfiles(['first', 'second'], test.options, deps),
    ).rejects.toThrow('must be a real directory');
    expect(pi.nativeClient.calls).toEqual([]);
  });

  it('continues ordinary updates when one profile cannot be planned', async () => {
    const test = await fixture();
    await writeWorkspace(test.userConfigPath, {
      first: {
        clients: [{ name: 'pi', install: 'native' }],
        plugins: ['npm:first'],
      },
      second: {
        clients: [{ name: 'pi', install: 'native' }],
        plugins: ['npm:second'],
      },
      third: {
        clients: [{ name: 'pi', install: 'native' }],
        plugins: ['npm:third'],
      },
    });
    const pi = new MemoryProfileAdapter('pi', test.home);
    const deps = dependencies(pi);
    for (const name of ['first', 'second', 'third']) {
      const plan = await planProfileOperation(
        name,
        'install',
        test.options,
        deps,
      );
      await applyProfilePlan(plan, test.options, deps);
    }

    const missing = join(test.workspaceDirectory, 'missing-plugin');
    await writeWorkspace(test.userConfigPath, {
      first: {
        clients: [{ name: 'pi', install: 'native' }],
        plugins: ['npm:first'],
      },
      second: {
        clients: [{ name: 'pi', install: 'native' }],
        plugins: ['npm:second', { source: missing, install: 'file' }],
      },
      third: {
        clients: [{ name: 'pi', install: 'native' }],
        plugins: ['npm:third'],
      },
    });
    pi.nativeClient.calls.length = 0;

    const results = await updateInstalledProfiles(
      undefined,
      test.options,
      deps,
    );
    expect(results.map((result) => result.profile)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(results.map((result) => result.success)).toEqual([
      true,
      false,
      true,
    ]);
    expect(results[1]?.error).toContain('must be a real directory');
    expect(pi.nativeClient.calls).toEqual([
      'update:npm:first',
      'update:npm:third',
    ]);
  });
});
