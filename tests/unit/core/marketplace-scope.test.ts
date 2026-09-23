import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stubHomeDir } from '../../helpers/env.js';

// Mock git module before importing marketplace (needed for addMarketplace tests)
mock.module('../../../src/core/git.js', () => ({
  createGit: () => ({}),
  cloneTo: mock((url: string, dest: string) => {
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'origin.txt'), url);
    return Promise.resolve();
  }),
  gitHubUrl: (owner: string, repo: string) => `https://github.com/${owner}/${repo}.git`,
  GitCloneError: class GitCloneError extends Error {
    url: string;
    isTimeout: boolean;
    isAuthError: boolean;
    constructor(message: string, url: string, isTimeout = false, isAuthError = false) {
      super(message);
      this.url = url;
      this.isTimeout = isTimeout;
      this.isAuthError = isAuthError;
    }
  },
  pull: mock(() => Promise.resolve()),
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

mock.module('simple-git', () => ({
  default: () => ({
    raw: mock(() => Promise.resolve('')),
    checkout: mock(() => Promise.resolve()),
  }),
}));

import {
  loadRegistryFromPath,
  saveRegistryToPath,
  getProjectRegistryPath,
  loadMergedRegistries,
  listMarketplacesWithScope,
  addMarketplace,
  removeMarketplace,
  getRegistryPath,
  getMarketplace,
  findMarketplace,
  getMarketplaceOverrides,
} from '../../../src/core/marketplace.js';
import type { MarketplaceRegistry } from '../../../src/core/marketplace.js';

describe('scope-aware registry loading and saving', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `marketplace-scope-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getProjectRegistryPath', () => {
    it('returns correct path under .allagents', () => {
      const result = getProjectRegistryPath('/some/workspace');
      expect(result).toBe(join('/some/workspace', '.allagents', 'marketplaces.json'));
    });
  });

  describe('loadRegistryFromPath', () => {
    it('loads valid registry from file', async () => {
      const registryPath = join(tmpDir, 'marketplaces.json');
      const registry: MarketplaceRegistry = {
        version: 1,
        marketplaces: {
          'test-marketplace': {
            name: 'test-marketplace',
            source: { type: 'github', location: 'owner/repo' },
            path: '/some/path',
            lastUpdated: '2026-01-01T00:00:00.000Z',
          },
        },
      };
      writeFileSync(registryPath, JSON.stringify(registry, null, 2));

      const loaded = await loadRegistryFromPath(registryPath);
      expect(loaded).toEqual(registry);
    });

    it('returns empty registry for nonexistent path', async () => {
      const loaded = await loadRegistryFromPath(join(tmpDir, 'nonexistent.json'));
      expect(loaded).toEqual({ version: 1, marketplaces: {} });
    });

    it('rejects invalid JSON instead of treating the registry as empty', async () => {
      const registryPath = join(tmpDir, 'bad.json');
      writeFileSync(registryPath, 'not valid json {{{');

      await expect(loadRegistryFromPath(registryPath)).rejects.toThrow(
        `Marketplace registry at ${registryPath} is unreadable`,
      );
    });

    it('rejects filesystem read errors instead of treating the registry as absent', async () => {
      const registryPath = join(tmpDir, 'directory-registry');
      mkdirSync(registryPath);

      await expect(loadRegistryFromPath(registryPath)).rejects.toThrow(
        `Marketplace registry at ${registryPath} is unreadable`,
      );
    });
  });

  describe('saveRegistryToPath', () => {
    it('atomically replaces an existing registry without leaving temporary files', async () => {
      const registryPath = join(tmpDir, 'marketplaces.json');
      const originalContent = JSON.stringify({
        version: 1,
        marketplaces: { stale: {} },
      });
      writeFileSync(registryPath, originalContent);
      chmodSync(registryPath, 0o660);
      const originalMode = statSync(registryPath).mode;
      const originalDescriptor = openSync(registryPath, 'r');
      const registry: MarketplaceRegistry = {
        version: 1,
        marketplaces: {
          'my-marketplace': {
            name: 'my-marketplace',
            source: { type: 'local', location: '/local/path' },
            path: '/local/path',
          },
        },
      };

      try {
        await saveRegistryToPath(registry, registryPath);

        const content = readFileSync(registryPath, 'utf-8');
        expect(JSON.parse(content)).toEqual(registry);
        expect(content.endsWith('\n')).toBe(true);
        expect(readFileSync(originalDescriptor, 'utf-8')).toBe(originalContent);
        expect(statSync(registryPath).mode).toBe(originalMode);
        expect(readdirSync(tmpDir)).toEqual(['marketplaces.json']);
      } finally {
        closeSync(originalDescriptor);
      }
    });

    it('cleans up the temporary file when replacement fails', async () => {
      const registryPath = join(tmpDir, 'marketplaces.json');
      mkdirSync(registryPath);
      writeFileSync(join(registryPath, 'keep'), 'original');

      await expect(
        saveRegistryToPath({ version: 1, marketplaces: {} }, registryPath),
      ).rejects.toThrow();

      expect(readFileSync(join(registryPath, 'keep'), 'utf-8')).toBe('original');
      expect(readdirSync(tmpDir)).toEqual(['marketplaces.json']);
    });
  });

  describe('loadMergedRegistries', () => {
    it('merges user and project registries with project taking precedence', async () => {
      const userPath = join(tmpDir, 'user-marketplaces.json');
      const projectPath = join(tmpDir, 'project-marketplaces.json');

      const userRegistry: MarketplaceRegistry = {
        version: 1,
        marketplaces: {
          'shared': {
            name: 'shared',
            source: { type: 'github', location: 'user-org/shared' },
            path: '/user/shared',
          },
          'user-only': {
            name: 'user-only',
            source: { type: 'github', location: 'user-org/user-only' },
            path: '/user/user-only',
          },
        },
      };

      const projectRegistry: MarketplaceRegistry = {
        version: 1,
        marketplaces: {
          'shared': {
            name: 'shared',
            source: { type: 'github', location: 'project-org/shared' },
            path: '/project/shared',
          },
          'project-only': {
            name: 'project-only',
            source: { type: 'local', location: '/project/project-only' },
            path: '/project/project-only',
          },
        },
      };

      writeFileSync(userPath, JSON.stringify(userRegistry));
      writeFileSync(projectPath, JSON.stringify(projectRegistry));

      const result = await loadMergedRegistries(userPath, projectPath);

      // Project wins on shared name
      expect(result.registry.marketplaces['shared'].source.location).toBe('project-org/shared');
      // Both unique entries present
      expect(result.registry.marketplaces['user-only']).toBeDefined();
      expect(result.registry.marketplaces['project-only']).toBeDefined();
      // Overrides list correct
      expect(result.overrides).toEqual(['shared']);
    });

    it('works when project registry does not exist', async () => {
      const userPath = join(tmpDir, 'user-marketplaces.json');
      const projectPath = join(tmpDir, 'nonexistent.json');

      const userRegistry: MarketplaceRegistry = {
        version: 1,
        marketplaces: {
          'user-mp': {
            name: 'user-mp',
            source: { type: 'github', location: 'org/repo' },
            path: '/user/mp',
          },
        },
      };
      writeFileSync(userPath, JSON.stringify(userRegistry));

      const result = await loadMergedRegistries(userPath, projectPath);

      expect(result.registry.marketplaces['user-mp']).toBeDefined();
      expect(result.overrides).toEqual([]);
    });

    it('returns user entries with no overrides when both paths are the same file', async () => {
      const sharedPath = join(tmpDir, 'same-registry.json');

      const registry: MarketplaceRegistry = {
        version: 1,
        marketplaces: {
          'my-mp': {
            name: 'my-mp',
            source: { type: 'github', location: 'org/repo' },
            path: '/some/path',
          },
        },
      };
      writeFileSync(sharedPath, JSON.stringify(registry));

      const result = await loadMergedRegistries(sharedPath, sharedPath);

      expect(result.registry.marketplaces['my-mp']).toBeDefined();
      expect(result.overrides).toEqual([]);
    });

    it('works when user registry does not exist', async () => {
      const userPath = join(tmpDir, 'nonexistent.json');
      const projectPath = join(tmpDir, 'project-marketplaces.json');

      const projectRegistry: MarketplaceRegistry = {
        version: 1,
        marketplaces: {
          'project-mp': {
            name: 'project-mp',
            source: { type: 'local', location: '/local/path' },
            path: '/local/path',
          },
        },
      };
      writeFileSync(projectPath, JSON.stringify(projectRegistry));

      const result = await loadMergedRegistries(userPath, projectPath);

      expect(result.registry.marketplaces['project-mp']).toBeDefined();
      expect(Object.keys(result.registry.marketplaces)).toHaveLength(1);
    });
  });

  describe('listMarketplacesWithScope', () => {
    it('lists entries with correct scope annotations', async () => {
      const userPath = join(tmpDir, 'user-marketplaces.json');
      const projectPath = join(tmpDir, 'project-marketplaces.json');

      const userRegistry: MarketplaceRegistry = {
        version: 1,
        marketplaces: {
          'alpha': {
            name: 'alpha',
            source: { type: 'github', location: 'org/alpha' },
            path: '/user/alpha',
          },
        },
      };

      const projectRegistry: MarketplaceRegistry = {
        version: 1,
        marketplaces: {
          'beta': {
            name: 'beta',
            source: { type: 'local', location: '/project/beta' },
            path: '/project/beta',
          },
        },
      };

      writeFileSync(userPath, JSON.stringify(userRegistry));
      writeFileSync(projectPath, JSON.stringify(projectRegistry));

      const result = await listMarketplacesWithScope(userPath, projectPath);

      expect(result.entries).toHaveLength(2);
      expect(result.entries[0].name).toBe('alpha');
      expect(result.entries[0].scope).toBe('user');
      expect(result.entries[1].name).toBe('beta');
      expect(result.entries[1].scope).toBe('project');
      expect(result.overrides).toEqual([]);
    });

    it('treats all entries as user scope when both paths resolve to the same file', async () => {
      const sharedPath = join(tmpDir, 'same-registry.json');

      const registry: MarketplaceRegistry = {
        version: 1,
        marketplaces: {
          'my-mp': {
            name: 'my-mp',
            source: { type: 'github', location: 'org/repo' },
            path: '/some/path',
          },
        },
      };
      writeFileSync(sharedPath, JSON.stringify(registry));

      const result = await listMarketplacesWithScope(sharedPath, sharedPath);

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].name).toBe('my-mp');
      expect(result.entries[0].scope).toBe('user');
      expect(result.overrides).toEqual([]);
    });

    it('overridden entries show as project scope with project values', async () => {
      const userPath = join(tmpDir, 'user-marketplaces.json');
      const projectPath = join(tmpDir, 'project-marketplaces.json');

      const userRegistry: MarketplaceRegistry = {
        version: 1,
        marketplaces: {
          'shared': {
            name: 'shared',
            source: { type: 'github', location: 'user-org/shared' },
            path: '/user/shared',
          },
        },
      };

      const projectRegistry: MarketplaceRegistry = {
        version: 1,
        marketplaces: {
          'shared': {
            name: 'shared',
            source: { type: 'local', location: '/project/shared' },
            path: '/project/shared',
          },
        },
      };

      writeFileSync(userPath, JSON.stringify(userRegistry));
      writeFileSync(projectPath, JSON.stringify(projectRegistry));

      const result = await listMarketplacesWithScope(userPath, projectPath);

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].name).toBe('shared');
      expect(result.entries[0].scope).toBe('project');
      expect(result.entries[0].source.location).toBe('/project/shared');
      expect(result.overrides).toEqual(['shared']);
    });

    it('uses registry keys for project precedence when embedded names differ', async () => {
      const userPath = join(tmpDir, 'user-marketplaces.json');
      const projectPath = join(tmpDir, 'project-marketplaces.json');

      writeFileSync(userPath, JSON.stringify({
        version: 1,
        marketplaces: {
          alias: {
            name: 'user-canonical',
            source: { type: 'github', location: 'user-org/repo' },
            path: '/user/repo',
          },
        },
      } satisfies MarketplaceRegistry));
      writeFileSync(projectPath, JSON.stringify({
        version: 1,
        marketplaces: {
          alias: {
            name: 'project-canonical',
            source: { type: 'local', location: '/project/repo' },
            path: '/project/repo',
          },
        },
      } satisfies MarketplaceRegistry));

      const result = await listMarketplacesWithScope(userPath, projectPath);

      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].name).toBe('project-canonical');
      expect(result.entries[0].scope).toBe('project');
      expect(result.overrides).toEqual(['alias']);
    });
  });
});

describe('addMarketplace with scope', () => {
  let restoreHomeDir: () => void;
  let testHome: string;
  let tmpProject: string;

  beforeEach(() => {
    testHome = join(tmpdir(), `marketplace-scope-add-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    restoreHomeDir = stubHomeDir(testHome);
    mkdirSync(join(testHome, '.allagents'), { recursive: true });

    tmpProject = join(tmpdir(), `marketplace-scope-project-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpProject, '.allagents'), { recursive: true });
  });

  afterEach(() => {
    restoreHomeDir();
    rmSync(testHome, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
  });

  it('should add local marketplace to project scope', async () => {
    // Create a local marketplace directory
    const localMarketplace = join(tmpProject, 'my-local-marketplace');
    mkdirSync(localMarketplace, { recursive: true });

    const result = await addMarketplace(localMarketplace, undefined, undefined, {
      scope: 'project',
      workspacePath: tmpProject,
    });

    expect(result.success).toBe(true);
    expect(result.marketplace?.name).toBe('my-local-marketplace');

    // Verify project registry was written
    const projectRegistryPath = getProjectRegistryPath(tmpProject);
    expect(existsSync(projectRegistryPath)).toBe(true);
    const projectRegistry = JSON.parse(readFileSync(projectRegistryPath, 'utf-8'));
    expect(projectRegistry.marketplaces['my-local-marketplace']).toBeDefined();

    // Verify user registry was NOT written to
    const userRegistryPath = getRegistryPath();
    expect(existsSync(userRegistryPath)).toBe(false);
  });

  it('keeps project and user remote caches independently owned', async () => {
    const userResult = await addMarketplace(
      'owner/source-a',
      'shared',
      undefined,
      { scope: 'user', workspacePath: tmpProject },
    );
    const projectResult = await addMarketplace(
      'owner/source-b',
      'shared',
      undefined,
      { scope: 'project', workspacePath: tmpProject },
    );

    const userRegistry = await loadRegistryFromPath(getRegistryPath());
    const projectRegistry = await loadRegistryFromPath(
      getProjectRegistryPath(tmpProject),
    );
    const userEntry = userRegistry.marketplaces.shared;
    const projectEntry = projectRegistry.marketplaces.shared;

    expect(userResult.success).toBe(true);
    expect(projectResult.success).toBe(true);
    expect(userEntry.path).not.toBe(projectEntry.path);
    expect(userEntry.source.location).toBe('owner/source-a');
    expect(projectEntry.source.location).toBe('owner/source-b');
    expect(readFileSync(join(userEntry.path, 'origin.txt'), 'utf-8')).toBe(
      'https://github.com/owner/source-a.git',
    );
    expect(readFileSync(join(projectEntry.path, 'origin.txt'), 'utf-8')).toBe(
      'https://github.com/owner/source-b.git',
    );

    const removal = await removeMarketplace('shared', {
      scope: 'project',
      workspacePath: tmpProject,
    });
    const userRegistryAfterRemoval = await loadRegistryFromPath(
      getRegistryPath(),
    );

    expect(removal.success).toBe(true);
    expect(existsSync(projectEntry.path)).toBe(false);
    expect(existsSync(userEntry.path)).toBe(true);
    expect(userRegistryAfterRemoval.marketplaces.shared.source.location).toBe(
      'owner/source-a',
    );
  });

  it('refuses to overwrite a corrupt project registry', async () => {
    const localMarketplace = join(tmpProject, 'replacement-marketplace');
    const projectRegistryPath = getProjectRegistryPath(tmpProject);
    const corruptContent = '{"version":1,"marketplaces":';
    mkdirSync(localMarketplace);
    writeFileSync(projectRegistryPath, corruptContent);

    await expect(
      addMarketplace(localMarketplace, undefined, undefined, {
        scope: 'project',
        workspacePath: tmpProject,
      }),
    ).rejects.toThrow(`Marketplace registry at ${projectRegistryPath} is unreadable`);

    expect(readFileSync(projectRegistryPath, 'utf-8')).toBe(corruptContent);
  });

  it('should default to user scope when no scope provided', async () => {
    // Create a local marketplace directory
    const localMarketplace = join(testHome, 'default-scope-marketplace');
    mkdirSync(localMarketplace, { recursive: true });

    const result = await addMarketplace(localMarketplace);

    expect(result.success).toBe(true);
    expect(result.marketplace?.name).toBe('default-scope-marketplace');

    // Verify user registry was written
    const userRegistryPath = getRegistryPath();
    expect(existsSync(userRegistryPath)).toBe(true);
    const userRegistry = JSON.parse(readFileSync(userRegistryPath, 'utf-8'));
    expect(userRegistry.marketplaces['default-scope-marketplace']).toBeDefined();
  });
});

describe('removeMarketplace with scope', () => {
  let restoreHomeDir: () => void;
  let testHome: string;
  let tmpProject: string;
  let userRegistryPath: string;
  let projectRegistryPath: string;

  const sharedEntry = (path: string) => ({
    name: 'shared',
    source: { type: 'local' as const, location: path },
    path,
  });

  beforeEach(() => {
    testHome = join(tmpdir(), `marketplace-scope-remove-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    restoreHomeDir = stubHomeDir(testHome);
    mkdirSync(join(testHome, '.allagents'), { recursive: true });

    tmpProject = join(tmpdir(), `marketplace-scope-remove-project-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpProject, '.allagents'), { recursive: true });

    userRegistryPath = getRegistryPath();
    projectRegistryPath = getProjectRegistryPath(tmpProject);
  });

  afterEach(() => {
    restoreHomeDir();
    rmSync(testHome, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
  });

  it('should remove only from project scope when scope is project', async () => {
    const userPath = join(testHome, 'shared-user');
    const projectPath = join(tmpProject, 'shared-project');
    mkdirSync(userPath, { recursive: true });
    mkdirSync(projectPath, { recursive: true });

    // Set up both registries with 'shared'
    await saveRegistryToPath({ version: 1, marketplaces: { shared: sharedEntry(userPath) } }, userRegistryPath);
    await saveRegistryToPath({ version: 1, marketplaces: { shared: sharedEntry(projectPath) } }, projectRegistryPath);

    const result = await removeMarketplace('shared', {
      scope: 'project',
      workspacePath: tmpProject,
      userRegistryPath,
    });

    expect(result.success).toBe(true);

    // Project registry should be empty
    const projReg = await loadRegistryFromPath(projectRegistryPath);
    expect(projReg.marketplaces['shared']).toBeUndefined();

    // User registry should still have 'shared'
    const userReg = await loadRegistryFromPath(userRegistryPath);
    expect(userReg.marketplaces['shared']).toBeDefined();
  });

  it('should remove only from user scope when scope is user', async () => {
    const userPath = join(testHome, 'shared-user');
    const projectPath = join(tmpProject, 'shared-project');
    mkdirSync(userPath, { recursive: true });
    mkdirSync(projectPath, { recursive: true });

    await saveRegistryToPath({ version: 1, marketplaces: { shared: sharedEntry(userPath) } }, userRegistryPath);
    await saveRegistryToPath({ version: 1, marketplaces: { shared: sharedEntry(projectPath) } }, projectRegistryPath);

    const result = await removeMarketplace('shared', {
      scope: 'user',
      workspacePath: tmpProject,
      userRegistryPath,
    });

    expect(result.success).toBe(true);

    // User registry should be empty
    const userReg = await loadRegistryFromPath(userRegistryPath);
    expect(userReg.marketplaces['shared']).toBeUndefined();

    // Project registry should still have 'shared'
    const projReg = await loadRegistryFromPath(projectRegistryPath);
    expect(projReg.marketplaces['shared']).toBeDefined();
  });

  it('should remove from both scopes when scope is all', async () => {
    const userPath = join(testHome, 'shared-user');
    const projectPath = join(tmpProject, 'shared-project');
    mkdirSync(userPath, { recursive: true });
    mkdirSync(projectPath, { recursive: true });

    await saveRegistryToPath({ version: 1, marketplaces: { shared: sharedEntry(userPath) } }, userRegistryPath);
    await saveRegistryToPath({ version: 1, marketplaces: { shared: sharedEntry(projectPath) } }, projectRegistryPath);

    const result = await removeMarketplace('shared', {
      scope: 'all',
      workspacePath: tmpProject,
      userRegistryPath,
    });

    expect(result.success).toBe(true);

    // Both registries should be empty
    const userReg = await loadRegistryFromPath(userRegistryPath);
    expect(userReg.marketplaces['shared']).toBeUndefined();

    const projReg = await loadRegistryFromPath(projectRegistryPath);
    expect(projReg.marketplaces['shared']).toBeUndefined();
  });

  it('should return error when marketplace not found in any scope', async () => {
    const result = await removeMarketplace('nonexistent', {
      scope: 'all',
      workspacePath: tmpProject,
      userRegistryPath,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

describe('runtime resolution with merged registries', () => {
  let restoreHomeDir: () => void;
  let testHome: string;
  let tmpProject: string;

  beforeEach(() => {
    testHome = join(tmpdir(), `marketplace-resolve-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    restoreHomeDir = stubHomeDir(testHome);
    mkdirSync(join(testHome, '.allagents'), { recursive: true });

    tmpProject = join(tmpdir(), `marketplace-resolve-project-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tmpProject, '.allagents'), { recursive: true });
  });

  afterEach(() => {
    restoreHomeDir();
    rmSync(testHome, { recursive: true, force: true });
    rmSync(tmpProject, { recursive: true, force: true });
  });

  it('should find marketplace from project registry via getMarketplace', async () => {
    const projectRegistryPath = getProjectRegistryPath(tmpProject);
    const projectRegistry: MarketplaceRegistry = {
      version: 1,
      marketplaces: {
        'project-mp': {
          name: 'project-mp',
          source: { type: 'local', location: '/project/mp' },
          path: '/project/mp',
        },
      },
    };
    writeFileSync(projectRegistryPath, JSON.stringify(projectRegistry));

    const result = await getMarketplace('project-mp', tmpProject);

    expect(result).not.toBeNull();
    expect(result!.name).toBe('project-mp');
    expect(result!.path).toBe('/project/mp');
  });

  it('should return null from getMarketplace when not in any registry', async () => {
    const result = await getMarketplace('nonexistent', tmpProject);
    expect(result).toBeNull();
  });

  it('should prefer project entry via getMarketplace when both registries have same name', async () => {
    // Set up user registry
    const userRegistryPath = getRegistryPath();
    const userRegistry: MarketplaceRegistry = {
      version: 1,
      marketplaces: {
        'shared': {
          name: 'shared',
          source: { type: 'github', location: 'user-org/shared' },
          path: '/user/shared',
        },
      },
    };
    writeFileSync(userRegistryPath, JSON.stringify(userRegistry));

    // Set up project registry with same name but different path
    const projectRegistryPath = getProjectRegistryPath(tmpProject);
    const projectRegistry: MarketplaceRegistry = {
      version: 1,
      marketplaces: {
        'shared': {
          name: 'shared',
          source: { type: 'local', location: '/project/shared' },
          path: '/project/shared',
        },
      },
    };
    writeFileSync(projectRegistryPath, JSON.stringify(projectRegistry));

    const result = await getMarketplace('shared', tmpProject);

    expect(result).not.toBeNull();
    expect(result!.path).toBe('/project/shared');
    expect(result!.source.location).toBe('/project/shared');
  });

  it('should prefer project entry via findMarketplace', async () => {
    // Set up user registry
    const userRegistryPath = getRegistryPath();
    const userRegistry: MarketplaceRegistry = {
      version: 1,
      marketplaces: {
        'shared': {
          name: 'shared',
          source: { type: 'github', location: 'user-org/shared' },
          path: '/user/shared',
        },
      },
    };
    writeFileSync(userRegistryPath, JSON.stringify(userRegistry));

    // Set up project registry with same name
    const projectRegistryPath = getProjectRegistryPath(tmpProject);
    const projectRegistry: MarketplaceRegistry = {
      version: 1,
      marketplaces: {
        'shared': {
          name: 'shared',
          source: { type: 'local', location: '/project/shared' },
          path: '/project/shared',
        },
      },
    };
    writeFileSync(projectRegistryPath, JSON.stringify(projectRegistry));

    const result = await findMarketplace('shared', undefined, tmpProject);

    expect(result).not.toBeNull();
    expect(result!.path).toBe('/project/shared');
  });

  it('should fall back to user registry via getMarketplace when not in project', async () => {
    // Set up user registry only
    const userRegistryPath = getRegistryPath();
    const userRegistry: MarketplaceRegistry = {
      version: 1,
      marketplaces: {
        'user-only': {
          name: 'user-only',
          source: { type: 'github', location: 'org/user-only' },
          path: '/user/user-only',
        },
      },
    };
    writeFileSync(userRegistryPath, JSON.stringify(userRegistry));

    const result = await getMarketplace('user-only', tmpProject);

    expect(result).not.toBeNull();
    expect(result!.name).toBe('user-only');
  });
});

describe('getMarketplaceOverrides', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `marketplace-overrides-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return override names when project overrides user', async () => {
    const userPath = join(tmpDir, 'user-marketplaces.json');
    const projectPath = join(tmpDir, 'project-marketplaces.json');

    const userRegistry: MarketplaceRegistry = {
      version: 1,
      marketplaces: {
        'shared': {
          name: 'shared',
          source: { type: 'github', location: 'user-org/shared' },
          path: '/user/shared',
        },
        'user-only': {
          name: 'user-only',
          source: { type: 'github', location: 'user-org/user-only' },
          path: '/user/user-only',
        },
      },
    };

    const projectRegistry: MarketplaceRegistry = {
      version: 1,
      marketplaces: {
        'shared': {
          name: 'shared',
          source: { type: 'local', location: '/project/shared' },
          path: '/project/shared',
        },
      },
    };

    writeFileSync(userPath, JSON.stringify(userRegistry));
    writeFileSync(projectPath, JSON.stringify(projectRegistry));

    const overrides = await getMarketplaceOverrides(userPath, projectPath);
    expect(overrides).toEqual(['shared']);
  });

  it('should return empty when no project registry exists', async () => {
    const userPath = join(tmpDir, 'user-marketplaces.json');
    const projectPath = join(tmpDir, 'nonexistent.json');

    writeFileSync(userPath, JSON.stringify({ version: 1, marketplaces: {} }));

    const overrides = await getMarketplaceOverrides(userPath, projectPath);
    expect(overrides).toEqual([]);
  });

  it('should return empty when no overlapping names', async () => {
    const userPath = join(tmpDir, 'user-marketplaces.json');
    const projectPath = join(tmpDir, 'project-marketplaces.json');

    writeFileSync(userPath, JSON.stringify({
      version: 1,
      marketplaces: {
        'user-mp': {
          name: 'user-mp',
          source: { type: 'github', location: 'org/user-mp' },
          path: '/user/mp',
        },
      },
    }));

    writeFileSync(projectPath, JSON.stringify({
      version: 1,
      marketplaces: {
        'project-mp': {
          name: 'project-mp',
          source: { type: 'local', location: '/project/mp' },
          path: '/project/mp',
        },
      },
    }));

    const overrides = await getMarketplaceOverrides(userPath, projectPath);
    expect(overrides).toEqual([]);
  });
});
