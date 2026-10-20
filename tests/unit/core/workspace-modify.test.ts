import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { dump, load } from 'js-yaml';
import type { WorkspaceConfig } from '../../../src/models/workspace-config.js';
import {
  checkRepositoryHealth as checkRepositoryHealthFact,
  resolveRemoteRevision as resolveRemoteRevisionFact,
} from '../../../src/core/git-facts.js';
import { classifyError } from '../../../src/core/git-errors.js';

// Bun module mocks update live bindings and persist across test files. Keep
// unrelated Git exports functional so this verification stub cannot disable
// later integration tests that exercise real cached repositories.
function runWithGit(path: string | undefined, args: string[]): string {
  const result = Bun.spawnSync(
    ['git', ...(path ? ['-C', path] : []), ...args],
    {
      env: {
        ...process.env,
        GIT_LFS_SKIP_SMUDGE: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed${path ? ` in ${path}` : ''}: ${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout.toString();
}

function createGitClient(path?: string) {
  return {
    listRemote: async (args: string[]) =>
      runWithGit(path, ['ls-remote', ...args]),
    raw: async (args: string[]) => runWithGit(path, args),
    checkout: async (branch: string) => {
      runWithGit(path, ['checkout', branch]);
    },
  };
}

async function cloneToWithGit(
  url: string,
  destination: string,
  ref?: string,
): Promise<void> {
  runWithGit(undefined, [
    'clone',
    '--depth',
    '1',
    ...(ref ? ['--branch', ref] : []),
    '--',
    url,
    destination,
  ]);
}

async function pullWithGit(path: string): Promise<void> {
  runWithGit(path, ['pull']);
}

// Mock git module to avoid network calls in verifyGitHubUrlExists
mock.module('../../../src/core/git.js', () => ({
  createGit: createGitClient,
  repoExists: async () => true,
  cloneToTemp: async () => '',
  cloneTo: cloneToWithGit,
  pull: pullWithGit,
  refExists: async () => false,
  cleanupTempDir: async () => {},
  resolveRemoteRevision: (source: string, requestedRef?: string) =>
    resolveRemoteRevisionFact(source, requestedRef, {
      createGit: createGitClient,
      cloneTimeoutMs: 300_000,
      classifyError,
    }),
  checkRepositoryHealth: (
    path: string,
    expected: { source: string; ref?: string; head: string },
  ) =>
    checkRepositoryHealthFact(path, expected, {
      createGit: createGitClient,
    }),
  gitHubUrl: (owner: string, repo: string) => `https://github.com/${owner}/${repo}.git`,
  GitCloneError: class GitCloneError extends Error {
    url: string;
    isTimeout: boolean;
    isAuthError: boolean;
    constructor(message: string, url: string, isTimeout = false, isAuthError = false) {
      super(message);
      this.name = 'GitCloneError';
      this.url = url;
      this.isTimeout = isTimeout;
      this.isAuthError = isAuthError;
    }
  },
}));

const { updateRepositories, addPlugin, addPluginForTarget, removePlugin } =
  await import('../../../src/core/workspace-modify.js');

describe('removePlugin', () => {
  const testDir = join(tmpdir(), `allagents-test-remove-comments-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(join(testDir, '.allagents'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('indexed plugin removal keeps comments on the surviving duplicate source declaration', async () => {
    const configPath = join(testDir, '.allagents', 'workspace.yaml');
    writeFileSync(configPath, `repositories: []
plugins:
  - source: ./shared-plugin # Remove the Claude installation
    clients:
      - claude
  - source: ./shared-plugin # Keep the Copilot installation
    clients:
      - copilot # Preferred client

# Workspace clients
clients:
  - claude
  - copilot
`);

    expect((await removePlugin('./shared-plugin', testDir, 0)).success).toBe(true);

    const content = readFileSync(configPath, 'utf-8');
    expect((load(content) as WorkspaceConfig).plugins).toEqual([
      { source: './shared-plugin', clients: ['copilot'] },
    ]);
    expect(content).toContain('source: ./shared-plugin # Keep the Copilot installation');
    expect(content).toContain('- copilot # Preferred client');
    expect(content).not.toContain('Remove the Claude installation');
    expect(content).toContain('\n\n# Workspace clients\nclients:');
  });

});

describe('updateRepositories', () => {
  const testDir = join(tmpdir(), `allagents-test-repos-${Date.now()}`);

  beforeEach(() => {
    mkdirSync(join(testDir, '.allagents'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('removes specified repositories and adds new ones', async () => {
    const configPath = join(testDir, '.allagents', 'workspace.yaml');
    const yaml = 'repositories:\n  - path: ../backend\n  - path: ../frontend\n  - path: ../shared\nplugins: []\nclients:\n  - claude\n';
    writeFileSync(configPath, yaml);

    const result = await updateRepositories(
      { remove: ['../frontend'], add: [{ path: '../new-service' }] },
      testDir,
    );

    expect(result.success).toBe(true);
    const updated = load(readFileSync(configPath, 'utf-8')) as any;
    expect(updated.repositories).toEqual([
      { path: '../backend' },
      { path: '../shared' },
      { path: '../new-service' },
    ]);
  });

  test('returns success with no changes when nothing to add or remove', async () => {
    const configPath = join(testDir, '.allagents', 'workspace.yaml');
    const yaml = 'repositories:\n  - path: ../backend\nplugins: []\nclients:\n  - claude\n';
    writeFileSync(configPath, yaml);

    const result = await updateRepositories({ remove: [], add: [] }, testDir);
    expect(result.success).toBe(true);
  });

  test('handles remove-only operation', async () => {
    const configPath = join(testDir, '.allagents', 'workspace.yaml');
    const yaml = 'repositories:\n  - path: ../backend\n  - path: ../frontend\nplugins: []\nclients:\n  - claude\n';
    writeFileSync(configPath, yaml);

    const result = await updateRepositories(
      { remove: ['../frontend'], add: [] },
      testDir,
    );

    expect(result.success).toBe(true);
    const updated = load(readFileSync(configPath, 'utf-8')) as any;
    expect(updated.repositories).toEqual([{ path: '../backend' }]);
  });

  test('handles add-only operation', async () => {
    const configPath = join(testDir, '.allagents', 'workspace.yaml');
    const yaml = 'repositories:\n  - path: ../backend\nplugins: []\nclients:\n  - claude\n';
    writeFileSync(configPath, yaml);

    const result = await updateRepositories(
      { remove: [], add: [{ path: '../new-service' }] },
      testDir,
    );

    expect(result.success).toBe(true);
    const updated = load(readFileSync(configPath, 'utf-8')) as any;
    expect(updated.repositories).toEqual([
      { path: '../backend' },
      { path: '../new-service' },
    ]);
  });
});

describe('addPlugin with --force flag', () => {
  let testDir = join(tmpdir(), `allagents-force-test-${Date.now()}`);

  beforeEach(() => {
    testDir = join(tmpdir(), `allagents-force-test-${Date.now()}`);
    mkdirSync(join(testDir, '.allagents'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('addPlugin with force replaces existing exact match plugin', async () => {
    const configPath = join(testDir, '.allagents', 'workspace.yaml');
    const initialConfig = {
      repositories: [],
      plugins: ['https://github.com/owner/plugin1'],
      clients: ['universal'],
    };
    writeFileSync(configPath, dump(initialConfig, { lineWidth: -1 }));

    // Action: add same plugin spec with force=true
    const result = await addPlugin('https://github.com/owner/plugin1', testDir, true);

    // Assert: succeeds with replaced=true
    expect(result.success).toBe(true);
    expect(result.replaced).toBe(true);

    // Verify: config still has one entry
    const updated = load(readFileSync(configPath, 'utf-8')) as any;
    expect(updated.plugins.length).toBe(1);
    expect(updated.plugins[0]).toBe('https://github.com/owner/plugin1');
  });

  test('addPlugin with force on first add returns replaced=undefined', async () => {
    const result = await addPlugin('https://github.com/owner/brand-new-plugin', testDir, true);

    expect(result.success).toBe(true);
    expect(result.replaced).toBeUndefined();
  });

  test('addPlugin without force errors on existing exact match', async () => {
    const configPath = join(testDir, '.allagents', 'workspace.yaml');
    const initialConfig = {
      repositories: [],
      plugins: ['https://github.com/owner/plugin1'],
      clients: ['universal'],
    };
    writeFileSync(configPath, dump(initialConfig, { lineWidth: -1 }));

    // Action: try to add same plugin without force
    const result = await addPlugin('https://github.com/owner/plugin1', testDir, false);

    // Assert: fails with error
    expect(result.success).toBe(false);
    expect(result.error).toContain('already exists');
    expect(result.replaced).toBeUndefined();
  });

  test('addPlugin with force skips semantic duplicate check and adds new entry', async () => {
    const configPath = join(testDir, '.allagents', 'workspace.yaml');
    const initialConfig = {
      repositories: [],
      plugins: ['https://github.com/owner/repo'],
      clients: ['universal'],
    };
    writeFileSync(configPath, dump(initialConfig, { lineWidth: -1 }));

    // Action: add same repo via different format with force=true
    // (These resolve to the same GitHub identity, so normally semantic duplicate)
    const result = await addPlugin('https://github.com/owner/repo.git', testDir, true);

    // Assert: succeeds with force despite semantic duplicate
    // Note: force skips semantic check but doesn't "replace" semantic duplicates,
    // it just adds the new entry alongside the existing one
    expect(result.success).toBe(true);
    expect(result.replaced).toBeUndefined();

    // Verify: both entries exist (force allowed the semantic duplicate)
    const updated = load(readFileSync(configPath, 'utf-8')) as any;
    expect(updated.plugins.length).toBe(2);
    expect(updated.plugins).toContain('https://github.com/owner/repo');
    expect(updated.plugins).toContain('https://github.com/owner/repo.git');
  });

  test('addPlugin without force errors on semantic duplicate (same repo, different format)', async () => {
    const configPath = join(testDir, '.allagents', 'workspace.yaml');
    const initialConfig = {
      repositories: [],
      plugins: ['https://github.com/owner/repo'],
      clients: ['universal'],
    };
    writeFileSync(configPath, dump(initialConfig, { lineWidth: -1 }));

    // Action: try to add same repo via different format without force
    const result = await addPlugin('https://github.com/owner/repo.git', testDir, false);

    // Assert: fails due to semantic duplicate
    expect(result.success).toBe(false);
    expect(result.error).toContain('duplicates');
    expect(result.replaced).toBeUndefined();
  });

  test('addPlugin with force replaces and keeps only one entry when multiple plugins exist', async () => {
    const configPath = join(testDir, '.allagents', 'workspace.yaml');
    const initialConfig = {
      repositories: [],
      plugins: [
        'https://github.com/owner/plugin1',
        'https://github.com/owner/plugin2',
        'https://github.com/owner/plugin3',
      ],
      clients: ['universal'],
    };
    writeFileSync(configPath, dump(initialConfig, { lineWidth: -1 }));

    // Action: replace middle plugin with force
    const result = await addPlugin('https://github.com/owner/plugin2', testDir, true);

    // Assert: succeeds with replaced=true
    expect(result.success).toBe(true);
    expect(result.replaced).toBe(true);

    // Verify: config has three entries with plugin2 still there
    const updated = load(readFileSync(configPath, 'utf-8')) as any;
    expect(updated.plugins.length).toBe(3);
    expect(updated.plugins).toContain('https://github.com/owner/plugin2');
  });

  test('addPlugin without force on empty config adds plugin with replaced=undefined', async () => {
    // Config exists but is empty
    const configPath = join(testDir, '.allagents', 'workspace.yaml');
    const initialConfig = {
      repositories: [],
      plugins: [],
      clients: ['universal'],
    };
    writeFileSync(configPath, dump(initialConfig, { lineWidth: -1 }));

    const result = await addPlugin('https://github.com/owner/new-plugin', testDir, false);

    expect(result.success).toBe(true);
    expect(result.replaced).toBeUndefined();

    const updated = load(readFileSync(configPath, 'utf-8')) as any;
    expect(updated.plugins.length).toBe(1);
  });
});

describe('addPluginForTarget', () => {
  let testDir: string;
  let configPath: string;
  let pluginDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `allagents-target-test-${Date.now()}-${Math.random()}`);
    configPath = join(testDir, '.allagents', 'workspace.yaml');
    pluginDir = join(testDir, 'plugin');
    mkdirSync(join(testDir, '.allagents'), { recursive: true });
    mkdirSync(pluginDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('initializes a first config with selected clients and inherited string declaration', async () => {
    const result = await addPluginForTarget(
      { declaration: pluginDir, clients: ['claude', 'codex'] },
      testDir,
    );

    expect(result.success).toBe(true);
    const config = load(readFileSync(configPath, 'utf-8')) as WorkspaceConfig;
    expect(config.clients).toEqual(['claude', 'codex']);
    expect(config.plugins).toEqual([pluginDir]);
  });

  test('does not publish a first config when atomic staging fails', async () => {
    rmSync(join(testDir, '.allagents'), { recursive: true, force: true });

    const result = await addPluginForTarget(
      { declaration: pluginDir, clients: ['claude', 'codex'] },
      testDir,
      {
        beforeRename() {
          throw new Error('injected first-write failure');
        },
      },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('injected first-write failure');
    expect(existsSync(configPath)).toBe(false);
    expect(readdirSync(join(testDir, '.allagents'))).toEqual([]);
  });

  test('persists a native-only declaration without treating its source as a local path', async () => {
    const result = await addPluginForTarget(
      {
        declaration: { source: 'npm:pi-extension', install: 'native' },
        clients: ['pi'],
        sourceValidation: 'declaration',
      },
      testDir,
    );

    expect(result.success).toBe(true);
    const config = load(readFileSync(configPath, 'utf-8')) as WorkspaceConfig;
    expect(config.clients).toEqual(['pi']);
    expect(config.plugins).toEqual([
      { source: 'npm:pi-extension', install: 'native' },
    ]);
  });

  test('stores only a differing client override and isolates unrelated config', async () => {
    const initial = {
      repositories: [{ path: '../keep' }],
      plugins: ['../other-plugin'],
      clients: ['claude', 'codex'],
    };
    writeFileSync(configPath, dump(initial, { lineWidth: -1 }));

    const result = await addPluginForTarget(
      {
        declaration: { source: pluginDir, clients: ['cursor'] },
        clients: ['cursor'],
      },
      testDir,
    );

    expect(result.success).toBe(true);
    const config = load(readFileSync(configPath, 'utf-8')) as WorkspaceConfig;
    expect(config.clients).toEqual(initial.clients);
    expect(config.repositories).toEqual(initial.repositories);
    expect(config.plugins).toEqual([
      '../other-plugin',
      { source: pluginDir, clients: ['cursor'] },
    ]);
  });

  test('preserves object fields while clearing clients on exact reinstall', async () => {
    writeFileSync(
      configPath,
      dump({
        repositories: [],
        clients: ['claude'],
        plugins: [
          {
            source: pluginDir,
            clients: ['cursor'],
            skills: { exclude: ['private'] },
            install: 'native',
            exclude: ['fixtures/**'],
            ref: 'stable',
          },
          '../keep',
        ],
      }),
    );

    const result = await addPluginForTarget(
      { declaration: pluginDir, clients: ['claude'] },
      testDir,
    );

    expect(result.success).toBe(true);
    expect(result.replaced).toBe(true);
    const config = load(readFileSync(configPath, 'utf-8')) as WorkspaceConfig;
    expect(config.clients).toEqual(['claude']);
    expect(config.plugins).toEqual([
      {
        source: pluginDir,
        skills: { exclude: ['private'] },
        install: 'native',
        exclude: ['fixtures/**'],
        ref: 'stable',
      },
      '../keep',
    ]);
  });

  test('preserves per-client modes and unrelated config when reinstall targets match defaults', async () => {
    const initial = {
      repositories: [{ path: '../keep' }],
      clients: ['pi', 'codex'],
      plugins: [{ source: pluginDir, clients: ['pi:native', { name: 'codex', install: 'file' }], install: 'file', ref: 'stable' }, '../keep'],
    };
    writeFileSync(configPath, dump(initial));
    const result = await addPluginForTarget({ declaration: pluginDir, clients: ['pi', 'codex'] }, testDir);
    expect(result.success).toBe(true);
    expect(load(readFileSync(configPath, 'utf-8'))).toEqual(initial);
  });

  test('reinstall retains first-entry precedence for raw duplicate client modes', async () => {
    for (const clients of [['pi', 'pi:native'], ['github-copilot', 'copilot:file']]) {
      const selected = clients[0] === 'pi' ? 'pi' : 'copilot';
      writeFileSync(configPath, dump({
        repositories: [],
        clients: [selected],
        plugins: [{ source: pluginDir, clients }],
      }));

      const result = await addPluginForTarget({ declaration: pluginDir, clients: [selected] }, testDir);
      expect(result.success).toBe(true);
      const config = load(readFileSync(configPath, 'utf-8')) as WorkspaceConfig;
      expect(config.plugins).toEqual([pluginDir]);
    }
  });

  test('replaces a semantic match in place and preserves its object fields', async () => {
    writeFileSync(
      configPath,
      dump({
        repositories: [],
        clients: ['claude'],
        plugins: [
          {
            source: 'https://github.com/owner/repo',
            skills: ['one'],
            ref: 'main',
          },
          'https://github.com/other/keep',
        ],
      }),
    );

    const result = await addPluginForTarget(
      {
        declaration: {
          source: 'https://github.com/owner/repo.git',
          clients: ['cursor'],
        },
        clients: ['cursor'],
      },
      testDir,
    );

    expect(result.success).toBe(true);
    const config = load(readFileSync(configPath, 'utf-8')) as WorkspaceConfig;
    expect(config.plugins).toEqual([
      {
        source: 'https://github.com/owner/repo.git',
        skills: ['one'],
        ref: 'main',
        clients: ['cursor'],
      },
      'https://github.com/other/keep',
    ]);
  });

  test('leaves original bytes and mode intact and removes the temp file on pre-rename failure', async () => {
    const original =
      'repositories: []\nplugins:\n  - ../keep\nclients:\n  - claude\n';
    writeFileSync(configPath, original);
    chmodSync(configPath, 0o640);

    const result = await addPluginForTarget(
      { declaration: pluginDir, clients: ['claude'] },
      testDir,
      {
        beforeRename() {
          throw new Error('injected pre-rename failure');
        },
      },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('injected pre-rename failure');
    expect(readFileSync(configPath, 'utf-8')).toBe(original);
    expect(statSync(configPath).mode & 0o777).toBe(0o640);
    expect(readdirSync(join(testDir, '.allagents'))).toEqual(['workspace.yaml']);
  });
});

describe('addPlugin rejects filesystem-root local paths', () => {
  let testDir = join(tmpdir(), `allagents-root-reject-test-${Date.now()}`);

  beforeEach(() => {
    testDir = join(tmpdir(), `allagents-root-reject-test-${Date.now()}`);
    mkdirSync(join(testDir, '.allagents'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('rejects a bare path separator as a local plugin source', async () => {
    const configPath = join(testDir, '.allagents', 'workspace.yaml');
    const initialConfig = { repositories: [], plugins: [], clients: ['universal'] };
    writeFileSync(configPath, dump(initialConfig, { lineWidth: -1 }));

    const result = await addPlugin(sep, testDir, false);

    expect(result.success).toBe(false);
    expect(result.error).toContain('filesystem root');

    const updated = load(readFileSync(configPath, 'utf-8')) as any;
    expect(updated.plugins).toEqual([]);
  });
});
