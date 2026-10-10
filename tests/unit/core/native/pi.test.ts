import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  PiNativeClient,
  inspectPiProjectTrust,
  normalizePiPackageSource,
} from '../../../../src/core/native/pi.js';
import type {
  NativeCommandOptions,
  NativeCommandResult,
  NativeOperationContext,
  NativeResource,
} from '../../../../src/core/native/types.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface PiFixture {
  home: string;
  agentRoot: string;
  workspace: string;
}

function fixture(): PiFixture {
  const home = mkdtempSync(join(tmpdir(), 'allagents-pi-'));
  temporaryDirectories.push(home);
  const agentRoot = join(home, 'pi-agent');
  const workspace = join(home, 'workspace');
  mkdirSync(agentRoot, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  return { home, agentRoot, workspace };
}

function context(
  scope: 'user' | 'project',
  paths: PiFixture,
): NativeOperationContext {
  return {
    client: 'pi',
    scope,
    nativeScope: scope,
    root: scope === 'user' ? paths.agentRoot : paths.workspace,
    cwd: paths.workspace,
    env: {
      HOME: paths.home,
      PI_CODING_AGENT_DIR: paths.agentRoot,
      SENTINEL: 'preserved',
    },
  };
}

function writeJson(path: string, value: unknown) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function installNpmPackage(
  root: string,
  name: string,
  manifest: Record<string, unknown> = { name, version: '1.0.0' },
) {
  const packageRoot = join(root, 'npm', 'node_modules', ...name.split('/'));
  mkdirSync(packageRoot, { recursive: true });
  writeJson(join(packageRoot, 'package.json'), manifest);
  return packageRoot;
}

function packageResource(
  client: PiNativeClient,
  source: string,
  operationContext: NativeOperationContext,
): NativeResource {
  const result = client.resolveSource(source, operationContext);
  expect(result.success).toBe(true);
  expect(result.resource).toBeDefined();
  return result.resource!;
}

describe('native/pi source normalization', () => {
  test('preserves requested pins while resolving npm identity', () => {
    const paths = fixture();
    const operationContext = context('user', paths);
    const normalized = normalizePiPackageSource(
      ' npm:@scope/tool@1.2.3 ',
      operationContext,
    );

    expect(normalized).toEqual({
      kind: 'npm',
      requested: 'npm:@scope/tool@1.2.3',
      resolvedIdentity: 'npm:@scope/tool@1.2.3',
      packageIdentity: 'npm:@scope/tool',
      commandSource: 'npm:@scope/tool@1.2.3',
      packageName: '@scope/tool',
    });
  });

  test('normalizes git shorthand, URLs, and refs to one transport-neutral identity', () => {
    const paths = fixture();
    const operationContext = context('user', paths);

    expect(
      normalizePiPackageSource(
        'git:github.com/acme/pi-tool.git@v1',
        operationContext,
      )?.resolvedIdentity,
    ).toBe('git:github.com/acme/pi-tool@v1');
    expect(
      normalizePiPackageSource(
        'https://github.com/acme/pi-tool.git@v1',
        operationContext,
      )?.resolvedIdentity,
    ).toBe('git:github.com/acme/pi-tool@v1');
    expect(
      normalizePiPackageSource(
        'git:git@github.com:acme/pi-tool.git@v1',
        operationContext,
      )?.resolvedIdentity,
    ).toBe('git:github.com/acme/pi-tool@v1');
    expect(
      normalizePiPackageSource(
        'ssh://git@github.com/acme/pi-tool.git@v1',
        operationContext,
      )?.resolvedIdentity,
    ).toBe('git:github.com/acme/pi-tool@v1');
  });

  test('resolves absolute and relative packages against command cwd', () => {
    const paths = fixture();
    const operationContext = context('project', paths);
    const absolute = join(paths.home, 'packages', 'absolute');

    expect(
      normalizePiPackageSource(absolute, operationContext)?.resolvedIdentity,
    ).toBe(`local:${absolute}`);
    expect(
      normalizePiPackageSource('./packages/relative', operationContext)
        ?.resolvedIdentity,
    ).toBe(`local:${join(paths.workspace, 'packages', 'relative')}`);
  });

  test('rejects bare names and malformed package sources', () => {
    const paths = fixture();
    const operationContext = context('user', paths);

    expect(normalizePiPackageSource('bare-package', operationContext)).toBeNull();
    expect(normalizePiPackageSource('npm:', operationContext)).toBeNull();
    expect(
      normalizePiPackageSource('https://github.com/only-one-part', operationContext),
    ).toBeNull();
    expect(
      normalizePiPackageSource(
        'https://token:secret@github.com/acme/private-plugin.git',
        operationContext,
      ),
    ).toBeNull();
  });
});

describe('native/pi inspection', () => {
  test('credits only enabled packages with corroborated installed manifests', async () => {
    const paths = fixture();
    const operationContext = context('user', paths);
    writeJson(join(paths.agentRoot, 'settings.json'), {
      packages: [
        'npm:installed',
        'npm:missing',
        { source: 'npm:disabled', autoload: false },
        'npm:wrong-manifest',
      ],
    });
    installNpmPackage(paths.agentRoot, 'installed');
    installNpmPackage(paths.agentRoot, 'disabled');
    installNpmPackage(paths.agentRoot, 'wrong-manifest', {
      name: 'different-package',
      version: '1.0.0',
    });

    const result = await new PiNativeClient().inspect(operationContext);

    expect(result.success).toBe(true);
    expect(result.resources.map((resource) => resource.resolvedIdentity)).toEqual([
      'npm:installed',
    ]);
    expect(
      result.observations?.map((observation) => [
        observation.resource.resolvedIdentity,
        observation.status,
      ]),
    ).toEqual([
      ['npm:installed', 'installed'],
      ['npm:missing', 'configured-missing'],
      ['npm:disabled', 'disabled'],
      ['npm:wrong-manifest', 'unusable'],
    ]);
  });

  test('keeps user and project settings observations isolated', async () => {
    const paths = fixture();
    const userContext = context('user', paths);
    const projectContext = context('project', paths);
    writeJson(join(paths.agentRoot, 'settings.json'), {
      defaultProjectTrust: 'always',
      packages: ['npm:user-only'],
    });
    writeJson(join(paths.workspace, '.pi', 'settings.json'), {
      packages: ['npm:project-only'],
    });
    installNpmPackage(paths.agentRoot, 'user-only');
    installNpmPackage(join(paths.workspace, '.pi'), 'project-only');

    const [user, project] = await Promise.all([
      new PiNativeClient().inspect(userContext),
      new PiNativeClient().inspect(projectContext),
    ]);

    expect(user.resources.map((resource) => resource.resolvedIdentity)).toEqual([
      'npm:user-only',
    ]);
    expect(project.resources.map((resource) => resource.resolvedIdentity)).toEqual([
      'npm:project-only',
    ]);
  });

  test('fails closed on duplicate package identities', async () => {
    const paths = fixture();
    const operationContext = context('user', paths);
    writeJson(join(paths.agentRoot, 'settings.json'), {
      packages: ['npm:duplicate@1', 'npm:duplicate@2'],
    });

    const result = await new PiNativeClient().inspect(operationContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Ambiguous duplicate Pi package identity');
    expect(result.resources).toEqual([]);
  });
});

describe('native/pi project trust', () => {
  test('uses the nearest canonical saved ancestor decision', async () => {
    const paths = fixture();
    const nested = join(paths.workspace, 'nested', 'project');
    mkdirSync(nested, { recursive: true });
    const linked = join(paths.home, 'workspace-link');
    symlinkSync(paths.workspace, linked, 'dir');
    writeJson(join(paths.agentRoot, 'settings.json'), {
      defaultProjectTrust: 'never',
    });
    writeJson(join(paths.agentRoot, 'trust.json'), {
      [paths.home]: false,
      [paths.workspace]: true,
    });
    const operationContext = {
      ...context('project', paths),
      cwd: join(linked, 'nested', 'project'),
    };

    expect(await inspectPiProjectTrust(operationContext)).toEqual({
      status: 'allowed',
      allowed: true,
      source: 'saved',
      matchedPath: paths.workspace,
    });
  });

  test('classifies ask, deny, unreadable, and ambiguous trust as not allowed', async () => {
    const paths = fixture();
    const operationContext = context('project', paths);
    writeJson(join(paths.agentRoot, 'settings.json'), {
      defaultProjectTrust: 'ask',
    });
    expect((await inspectPiProjectTrust(operationContext)).status).toBe('ask');

    writeJson(join(paths.agentRoot, 'settings.json'), {
      defaultProjectTrust: 'never',
    });
    expect((await inspectPiProjectTrust(operationContext)).status).toBe('denied');

    mkdirSync(join(paths.agentRoot, 'trust.json'), { recursive: true });
    expect((await inspectPiProjectTrust(operationContext)).status).toBe(
      'inspection-failed',
    );
    rmSync(join(paths.agentRoot, 'trust.json'), { recursive: true, force: true });

    writeJson(join(paths.agentRoot, 'trust.json'), {
      [paths.workspace]: true,
      [`${paths.workspace}/.`]: false,
    });
    expect((await inspectPiProjectTrust(operationContext)).status).toBe(
      'ambiguous',
    );
  });
});

describe('native/pi command effects', () => {
  test.each([
    ['0.84.9', false],
    ['0.85.0', false],
    ['0.85.1', true],
    ['0.85.2', true],
    ['0.86.0', true],
    ['1.1.0', true],
    ['2.0.0', true],
    ['', false],
    ['not-a-version', false],
  ])('checks the minimum Pi version for %s', async (output, available) => {
    const paths = fixture();
    const client = new PiNativeClient({
      execute: async () => ({ success: true, output }),
    });

    expect(await client.isAvailable(context('user', paths))).toBe(available);
  });

  test('rejects a failed version command even when its output names a supported version', async () => {
    const paths = fixture();
    const client = new PiNativeClient({
      execute: async () => ({ success: false, output: '1.1.0', exitCode: 1 }),
    });

    expect(await client.isAvailable(context('user', paths))).toBe(false);
  });

  test('uses exact user and trusted-project install/remove argv, cwd, and env', async () => {
    const paths = fixture();
    writeJson(join(paths.agentRoot, 'settings.json'), {
      defaultProjectTrust: 'always',
    });
    const calls: Array<{
      binary: string;
      args: string[];
      options?: NativeCommandOptions;
    }> = [];
    const execute = async (
      binary: string,
      args: string[],
      options?: NativeCommandOptions,
    ): Promise<NativeCommandResult> => {
      calls.push({ binary, args, ...(options && { options }) });
      return { success: true, output: '' };
    };
    const client = new PiNativeClient({ execute });
    const userContext = context('user', paths);
    const projectContext = context('project', paths);
    const userResource = packageResource(client, 'npm:user-pkg', userContext);
    const projectResource = packageResource(
      client,
      './packages/project-pkg',
      projectContext,
    );

    await client.install(userResource, userContext);
    await client.install(projectResource, projectContext);
    await client.remove(userResource, userContext);
    await client.remove(projectResource, projectContext);

    expect(calls.map(({ binary, args }) => [binary, args])).toEqual([
      ['pi', ['install', 'npm:user-pkg', '--no-approve']],
      [
        'pi',
        [
          'install',
          join(paths.workspace, 'packages', 'project-pkg'),
          '-l',
          '--approve',
        ],
      ],
      ['pi', ['remove', 'npm:user-pkg', '--no-approve']],
      [
        'pi',
        [
          'remove',
          join(paths.workspace, 'packages', 'project-pkg'),
          '-l',
          '--approve',
        ],
      ],
    ]);
    expect(calls.every((call) => call.options?.cwd === paths.workspace)).toBe(
      true,
    );
    expect(
      calls.every((call) => call.options?.env?.SENTINEL === 'preserved'),
    ).toBe(true);
  });

  test('always names a targeted update and never invokes bare pi update', async () => {
    const paths = fixture();
    const operationContext = context('user', paths);
    writeJson(join(paths.agentRoot, 'settings.json'), {
      packages: ['npm:target'],
    });
    installNpmPackage(paths.agentRoot, 'target');
    const calls: string[][] = [];
    const client = new PiNativeClient({
      execute: async (_binary, args) => {
        calls.push(args);
        return { success: true, output: '' };
      },
    });
    const resource = packageResource(client, 'npm:target', operationContext);

    const result = await client.update(resource, resource, operationContext);

    expect(result.success).toBe(true);
    expect(calls).toEqual([['update', 'npm:target', '--no-approve']]);
    expect(calls).not.toContainEqual(['update']);
  });

  test('targets a trusted project update without using user scope', async () => {
    const paths = fixture();
    const operationContext = context('project', paths);
    writeJson(join(paths.agentRoot, 'settings.json'), {
      defaultProjectTrust: 'always',
      packages: [],
    });
    writeJson(join(paths.workspace, '.pi', 'settings.json'), {
      packages: ['npm:project-target'],
    });
    installNpmPackage(join(paths.workspace, '.pi'), 'project-target');
    const calls: string[][] = [];
    const client = new PiNativeClient({
      execute: async (_binary, args) => {
        calls.push(args);
        return { success: true, output: '' };
      },
    });
    const resource = packageResource(
      client,
      'npm:project-target',
      operationContext,
    );

    const result = await client.update(resource, resource, operationContext);

    expect(result.success).toBe(true);
    expect(calls).toEqual([
      ['update', 'npm:project-target', '--approve'],
    ]);
  });

  test('refuses a targeted update when Pi would affect the same identity in both scopes', async () => {
    const paths = fixture();
    const operationContext = context('project', paths);
    writeJson(join(paths.agentRoot, 'settings.json'), {
      defaultProjectTrust: 'always',
      packages: ['npm:shared'],
    });
    writeJson(join(paths.workspace, '.pi', 'settings.json'), {
      packages: ['npm:shared'],
    });
    installNpmPackage(paths.agentRoot, 'shared');
    installNpmPackage(join(paths.workspace, '.pi'), 'shared');
    const calls: string[][] = [];
    const client = new PiNativeClient({
      execute: async (_binary, args) => {
        calls.push(args);
        return { success: true, output: '' };
      },
    });
    const resource = packageResource(client, 'npm:shared', operationContext);

    const result = await client.update(resource, resource, operationContext);

    expect(result.success).toBe(false);
    expect(result.error).toContain('both user and project scopes');
    expect(calls).toEqual([]);
  });

  test('fails project mutations before command execution when trust is not already allowed', async () => {
    const paths = fixture();
    const operationContext = context('project', paths);
    writeJson(join(paths.agentRoot, 'settings.json'), {
      defaultProjectTrust: 'ask',
    });
    const calls: string[][] = [];
    const client = new PiNativeClient({
      execute: async (_binary, args) => {
        calls.push(args);
        return { success: true, output: '' };
      },
    });
    const resource = packageResource(client, 'npm:blocked', operationContext);

    expect((await client.install(resource, operationContext)).success).toBe(false);
    expect((await client.remove(resource, operationContext)).success).toBe(false);
    expect(calls).toEqual([]);
  });
});
