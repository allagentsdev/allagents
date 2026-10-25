import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stubHomeDir } from '../../../helpers/env.js';

/**
 * Integration test verifying that syncWorkspace calls addMarketplace
 * on the native CLI when the plugin spec uses marketplace-name format
 * (not owner/repo format).
 *
 * This is the core scenario from issue #191: a workspace has
 * "agentv-dev@agentv" where "agentv" is a GitHub marketplace registered
 * as EntityProcess/agentv. Without the fix, addMarketplace was never
 * called and the native install failed.
 */

// Track native CLI calls
const executeCommandCalls: Array<{ binary: string; args: string[] }> = [];

const nativeTypes = await import('../../../../src/core/native/types.js');

// Intercept only native CLI calls; use the real helpers for state and output.
mock.module('../../../../src/core/native/types.js', () => ({
  ...nativeTypes,
  executeCommand: mock(async (binary: string, args: string[]) => {
    executeCommandCalls.push({ binary, args });
    // Simulate successful responses
    if (args[0] === '--version') {
      return {
        success: true,
        output: binary === 'omp' ? 'omp/18.1.20' : 'claude 1.0.0',
      };
    }
    if (
      binary === 'omp' &&
      args[0] === 'plugin' &&
      args[1] === 'list' &&
      args[2] === '--json'
    ) {
      return {
        success: true,
        output: JSON.stringify({ npm: [], marketplace: [] }),
      };
    }
    if (args.includes('marketplace') && args.includes('add')) {
      return { success: true, output: 'Marketplace added' };
    }
    if (args.includes('install')) {
      return { success: true, output: 'Plugin installed' };
    }
    return { success: true, output: '' };
  }),
}));

// Mock git operations
mock.module('../../../../src/core/git.js', () => ({
  createGitEnv: () => ({
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
  }),
  createGit: () => ({
    raw: mock(() => Promise.resolve('origin/main')),
    checkout: mock(() => Promise.resolve()),
  }),
  pull: mock(() => Promise.resolve()),
  cloneTo: mock((_url: string, path: string) => {
    mkdirSync(path, { recursive: true });
    return Promise.resolve();
  }),
  cloneToTemp: mock(() => Promise.resolve('/tmp/fake')),
  gitHubUrl: (owner: string, repo: string) =>
    `https://github.com/${owner}/${repo}.git`,
  GitCloneError: class extends Error {},
  repoExists: mock(() => Promise.resolve(true)),
  refExists: mock(() => Promise.resolve(true)),
  cleanupTempDir: mock(() => Promise.resolve()),
  resolveRemoteRevision: mock(() =>
    Promise.resolve({ status: 'unresolved' as const, reason: 'failed' as const }),
  ),
  checkRepositoryHealth: mock(() =>
    Promise.resolve({
      status: 'unhealthy' as const,
      reason: 'inspection-failed' as const,
    }),
  ),
}));

// Mock simple-git
mock.module('simple-git', () => ({
  default: () => ({
    raw: mock((...args: unknown[]) => {
      const rawArgs = args[0] as string[];
      if (rawArgs?.[0] === 'symbolic-ref') return Promise.resolve('origin/main');
      return Promise.resolve('');
    }),
    checkout: mock(() => Promise.resolve()),
    log: mock(() => Promise.resolve({ latest: { hash: 'abc1234' } })),
  }),
}));

const { syncWorkspace } = await import('../../../../src/core/sync.js');
const { resetUpdatedMarketplaceCache } = await import('../../../../src/core/marketplace.js');

describe('native marketplace registration during syncWorkspace', () => {
  let restoreHomeDir: () => void;
  let testHome: string;
  let testDir: string;

  beforeEach(() => {
    testHome = join(tmpdir(), `native-mp-reg-test-${Date.now()}`);
    testDir = join(testHome, 'workspace');
    restoreHomeDir = stubHomeDir(testHome);
    executeCommandCalls.length = 0;
    resetUpdatedMarketplaceCache();
  });

  afterEach(() => {
    restoreHomeDir();
    rmSync(testHome, { recursive: true, force: true });
  });

  function setupMarketplace(name: string, plugins: Array<{ name: string; source: string }>) {
    const mpPath = join(testHome, '.allagents', 'plugins', 'marketplaces', name);
    mkdirSync(join(mpPath, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(mpPath, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name, plugins }),
    );
    for (const p of plugins) {
      if (p.source.startsWith('./')) {
        const pluginDir = join(mpPath, p.source.slice(2));
        mkdirSync(pluginDir, { recursive: true });
        // Create a minimal skill so the plugin is valid
        const skillDir = join(pluginDir, 'skills', 'test-skill');
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(
          join(skillDir, 'SKILL.md'),
          '---\nname: test-skill\ndescription: test\n---\n',
        );
      }
    }
    return mpPath;
  }

  function setupRegistry(marketplaces: Record<string, unknown>) {
    const registryDir = join(testHome, '.allagents');
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(
      join(registryDir, 'marketplaces.json'),
      JSON.stringify({ version: 1, marketplaces }, null, 2),
    );
  }

  function setupWorkspace(yaml: string) {
    const configDir = join(testDir, '.allagents');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'workspace.yaml'), yaml);
  }

  it('calls addMarketplace when spec uses marketplace-name format (not owner/repo)', async () => {
    // Setup: marketplace "agentv" backed by GitHub repo EntityProcess/agentv
    const mpPath = setupMarketplace('agentv', [
      { name: 'agentv-dev', source: './plugins/agentv-dev' },
    ]);
    setupRegistry({
      agentv: {
        name: 'agentv',
        source: { type: 'github', location: 'EntityProcess/agentv' },
        path: mpPath,
        lastUpdated: new Date().toISOString(),
      },
    });

    // Workspace uses marketplace-name format (the bug scenario)
    setupWorkspace([
      'repositories: []',
      'plugins:',
      '  - agentv-dev@agentv',
      'clients:',
      '  - name: claude',
      '    install: native',
    ].join('\n'));

    await syncWorkspace(testDir);

    // Verify addMarketplace was called with the owner/repo
    const addMarketplaceCalls = executeCommandCalls.filter(
      (c) => c.binary === 'claude' && c.args.includes('marketplace') && c.args.includes('add'),
    );
    expect(addMarketplaceCalls.length).toBeGreaterThanOrEqual(1);
    // The source should be the GitHub owner/repo, not just the marketplace name
    const sources = addMarketplaceCalls.map((c) => c.args[c.args.length - 1]);
    expect(sources).toContain('EntityProcess/agentv');
  });

  it('calls addMarketplace for owner/repo format specs (existing behavior)', async () => {
    // Setup: marketplace "agentv" backed by GitHub repo EntityProcess/agentv
    const mpPath = setupMarketplace('agentv', [
      { name: 'agentv-dev', source: './plugins/agentv-dev' },
    ]);
    setupRegistry({
      agentv: {
        name: 'agentv',
        source: { type: 'github', location: 'EntityProcess/agentv' },
        path: mpPath,
        lastUpdated: new Date().toISOString(),
      },
    });

    // Workspace uses owner/repo format (this already worked before the fix)
    setupWorkspace([
      'repositories: []',
      'plugins:',
      '  - agentv-dev@EntityProcess/agentv',
      'clients:',
      '  - name: claude',
      '    install: native',
    ].join('\n'));

    await syncWorkspace(testDir);

    const addMarketplaceCalls = executeCommandCalls.filter(
      (c) => c.binary === 'claude' && c.args.includes('marketplace') && c.args.includes('add'),
    );
    expect(addMarketplaceCalls.length).toBeGreaterThanOrEqual(1);
    const sources = addMarketplaceCalls.map((c) => c.args[c.args.length - 1]);
    expect(sources).toContain('EntityProcess/agentv');
  });

  it('does not call addMarketplace for local marketplace plugins', async () => {
    // Setup: marketplace "local-mp" backed by a local directory
    const mpPath = setupMarketplace('local-mp', [
      { name: 'local-plugin', source: './plugins/local-plugin' },
    ]);
    setupRegistry({
      'local-mp': {
        name: 'local-mp',
        source: { type: 'local', location: mpPath },
        path: mpPath,
        lastUpdated: new Date().toISOString(),
      },
    });

    setupWorkspace([
      'repositories: []',
      'plugins:',
      '  - local-plugin@local-mp',
      'clients:',
      '  - name: claude',
      '    install: native',
    ].join('\n'));

    await syncWorkspace(testDir);

    const addMarketplaceCalls = executeCommandCalls.filter(
      (c) => c.binary === 'claude' && c.args.includes('marketplace') && c.args.includes('add'),
    );
    // No addMarketplace should be called for local sources
    expect(addMarketplaceCalls.length).toBe(0);
  });

  it('never invokes OMP mutations during AllAgents dry-run', async () => {
    const mpPath = setupMarketplace('agentv', [
      { name: 'agentv-dev', source: './plugins/agentv-dev' },
    ]);
    setupRegistry({
      agentv: {
        name: 'agentv',
        source: { type: 'github', location: 'EntityProcess/agentv' },
        path: mpPath,
        lastUpdated: new Date().toISOString(),
      },
    });
    setupWorkspace([
      'repositories: []',
      'plugins:',
      '  - agentv-dev@agentv',
      'clients:',
      '  - name: omp',
      '    install: native',
    ].join('\n'));

    const result = await syncWorkspace(testDir, { dryRun: true });
    const ompCalls = executeCommandCalls.filter((call) => call.binary === 'omp');

    expect(result.success).toBe(true);
    expect(ompCalls.length).toBeGreaterThan(0);
    expect(
      ompCalls.every(
        (call) =>
          call.args[0] === '--version' ||
          (call.args[0] === 'plugin' && call.args[1] === 'list'),
      ),
    ).toBe(true);
    expect(
      ompCalls.some((call) =>
        ['install', 'upgrade', 'uninstall', 'marketplace'].includes(
          call.args[1] ?? '',
        ),
      ),
    ).toBe(false);
  });
});
