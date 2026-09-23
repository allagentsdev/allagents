import { describe, it, expect, mock, beforeEach } from 'bun:test';
import {
  checkPluginUpdate,
  fetchPlugin,
  resetFetchCache,
  seedFetchCache,
  updatePlugin,
  type FetchDeps,
  type PluginUpdateCheckDeps,
  type UpdatePluginDeps,
} from '../../../src/core/plugin.js';
import { GitCloneError } from '../../../src/core/git.js';
import { UpdateContext } from '../../../src/core/update-context.js';

// Create mock functions for dependency injection
const existsSyncMock = mock(() => false);
const mkdirMock = mock(() => Promise.resolve());
const cloneToMock = mock(() => Promise.resolve());
const pullMock = mock(() => Promise.resolve());

// Dependencies object passed to fetchPlugin
const deps: FetchDeps = {
  existsSync: existsSyncMock as unknown as FetchDeps['existsSync'],
  mkdir: mkdirMock as unknown as FetchDeps['mkdir'],
  cloneTo: cloneToMock as unknown as FetchDeps['cloneTo'],
  pull: pullMock as unknown as FetchDeps['pull'],
};

beforeEach(() => {
  existsSyncMock.mockReset();
  mkdirMock.mockReset();
  cloneToMock.mockReset();
  pullMock.mockReset();
  resetFetchCache();
});

describe('fetchPlugin', () => {
  it('should validate GitHub URL', async () => {
    const result = await fetchPlugin('not-a-github-url', {}, deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid GitHub URL');
  });

  it('should update cached plugin by default (pull latest)', async () => {
    existsSyncMock.mockReturnValueOnce(true);

    const result = await fetchPlugin('https://github.com/owner/repo', {}, deps);
    expect(result.success).toBe(true);
    expect(result.action).toBe('updated');
  });

  it('should skip fetching when offline is true and plugin is cached', async () => {
    existsSyncMock.mockReturnValueOnce(true);

    const result = await fetchPlugin('https://github.com/owner/repo', { offline: true }, deps);
    expect(result.success).toBe(true);
    expect(result.action).toBe('skipped');
  });

  it('should fetch new plugin when not cached', async () => {
    existsSyncMock.mockReturnValueOnce(false);

    const result = await fetchPlugin('https://github.com/owner/repo', {}, deps);
    expect(result.success).toBe(true);
    expect(result.action).toBe('fetched');
    expect(result.cachePath).toContain('owner-repo');
  });

  it('uses the branch encoded in a deep GitHub URL', async () => {
    existsSyncMock.mockReturnValueOnce(false);

    const result = await fetchPlugin(
      'https://github.com/owner/repo/blob/main/skills/example',
      {},
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.cachePath).toContain('owner-repo@main');
    expect(cloneToMock).toHaveBeenCalledWith(
      'https://github.com/owner/repo.git',
      expect.stringContaining('owner-repo@main'),
      'main',
    );
  });

  it('prefers an explicit branch override to the URL branch', async () => {
    existsSyncMock.mockReturnValueOnce(false);

    const result = await fetchPlugin(
      'https://github.com/owner/repo/blob/main/skills/example',
      { branch: 'release' },
      deps,
    );

    expect(result.success).toBe(true);
    expect(result.cachePath).toContain('owner-repo@release');
    expect(cloneToMock).toHaveBeenCalledWith(
      'https://github.com/owner/repo.git',
      expect.stringContaining('owner-repo@release'),
      'release',
    );
  });

  it('should handle authentication errors', async () => {
    existsSyncMock.mockReturnValueOnce(false);
    cloneToMock.mockRejectedValueOnce(
      new GitCloneError('Authentication failed', 'https://github.com/owner/repo.git', false, true),
    );

    const result = await fetchPlugin('https://github.com/owner/repo', {}, deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Authentication failed');
  });

  it('should handle clone timeout errors', async () => {
    existsSyncMock.mockReturnValueOnce(false);
    cloneToMock.mockRejectedValueOnce(
      new GitCloneError('Clone timed out', 'https://github.com/owner/repo.git', true, false),
    );

    const result = await fetchPlugin('https://github.com/owner/repo', {}, deps);
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('should parse different GitHub URL formats', async () => {
    const urls = [
      'https://github.com/owner/repo',
      'https://github.com/owner/repo.git',
      'github.com/owner/repo',
      'gh:owner/repo',
    ];

    for (const url of urls) {
      existsSyncMock.mockReturnValueOnce(true);
      pullMock.mockResolvedValueOnce(undefined);

      const result = await fetchPlugin(url, {}, deps);
      expect(result.success).toBe(true);
    }
  });

  it('should treat pull failure as non-fatal when cached', async () => {
    existsSyncMock.mockReturnValueOnce(true);
    pullMock.mockRejectedValueOnce(new Error('not something we can merge'));

    const result = await fetchPlugin('https://github.com/owner/repo', {}, deps);
    expect(result.success).toBe(true);
    expect(result.action).toBe('skipped');
    expect(result.cachePath).toContain('owner-repo');
  });

  it('should coalesce concurrent fetches for the same repo', async () => {
    existsSyncMock.mockReturnValue(true);
    pullMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 10)),
    );

    const [result1, result2] = await Promise.all([
      fetchPlugin('https://github.com/owner/repo', {}, deps),
      fetchPlugin('https://github.com/owner/repo', {}, deps),
    ]);

    // Both callers get the exact same result object
    expect(result1).toBe(result2);
    expect(result1.success).toBe(true);
    // Only one pull should have occurred despite two concurrent calls
    expect(pullMock).toHaveBeenCalledTimes(1);
  });
});

describe('updatePlugin', () => {
  const mockParsePluginSpec = mock((spec: string) => {
    if (spec.includes('@')) {
      const [plugin, marketplace] = spec.split('@');
      return { plugin, marketplaceName: marketplace };
    }
    return null;
  });

  const mockGetMarketplaceRegistration = mock(async (name: string) => {
    if (name === 'test-marketplace') {
      return {
        key: 'test-marketplace',
        entry: { name: 'test-marketplace', path: '/mock/marketplace/path', source: { type: 'github' as const, location: 'owner/test-marketplace' } },
      };
    }
    return null;
  });

  const mockParseManifest = mock(async (_path: string) => ({
    success: true,
    data: {
      plugins: [
        { name: 'embedded-plugin', source: './plugins/embedded' },
        { name: 'external-plugin', source: { url: 'https://github.com/external/repo' } },
      ],
    },
  }));

  const mockUpdateMarketplace = mock(async (name: string) => [{ name, success: true }]);
  const mockFetchFn = mock(async (_url: string) => ({
    success: true,
    action: 'updated' as const,
    cachePath: '/mock/cache/path',
  }));

  const updateDeps: UpdatePluginDeps = {
    parsePluginSpec: mockParsePluginSpec as unknown as UpdatePluginDeps['parsePluginSpec'],
    getMarketplaceRegistration: mockGetMarketplaceRegistration as unknown as UpdatePluginDeps['getMarketplaceRegistration'],
    validateMarketplaceAccess: () => undefined,
    parseMarketplaceManifest: mockParseManifest as unknown as UpdatePluginDeps['parseMarketplaceManifest'],
    updateMarketplace: mockUpdateMarketplace as unknown as UpdatePluginDeps['updateMarketplace'],
    fetchFn: mockFetchFn as unknown as UpdatePluginDeps['fetchFn'],
  };

  beforeEach(() => {
    mockParsePluginSpec.mockClear();
    mockGetMarketplaceRegistration.mockClear();
    mockParseManifest.mockClear();
    mockUpdateMarketplace.mockClear();
    mockFetchFn.mockClear();
  });

  it('should skip local path plugins', async () => {
    const result = await updatePlugin('./local/plugin', updateDeps);
    expect(result.success).toBe(true);
    expect(result.action).toBe('skipped');
  });

  it('keeps the existing skipped label when a direct plugin cache is first created', async () => {
    const fetchFn = mock(async () => ({
      success: true,
      action: 'fetched' as const,
      cachePath: '/mock/cache/path',
    }));

    const result = await updatePlugin('https://github.com/external/new-repo', {
      ...updateDeps,
      fetchFn,
    });

    expect(result).toEqual({
      plugin: 'https://github.com/external/new-repo',
      success: true,
      action: 'skipped',
    });
  });

  it('preserves missing-cache public semantics and marks a successful clone changed', async () => {
    const url = 'https://github.com/external/missing-repo';
    const cloneTo = mock(async () => undefined);

    const result = await updatePlugin(
      url,
      {
        ...updateDeps,
        fetchFn: undefined,
        updateFetchDeps: {
          existsSync: () => false,
          mkdir: async () => undefined,
          cloneTo,
          resolveHeadSha: async () => 'a'.repeat(40),
        },
      },
      new UpdateContext(),
    );

    expect(result).toEqual({
      plugin: url,
      success: true,
      action: 'skipped',
      changed: true,
    });
    expect(cloneTo).toHaveBeenCalledTimes(1);
  });

  it('bypasses a stale global seed and skips pull for a healthy equal direct update', async () => {
    const url = 'https://github.com/external/equal-repo';
    seedFetchCache(url, '/stale/global/cache');
    const pull = mock(async () => undefined);
    const resolveRemoteRevision = mock(async () => ({
      status: 'resolved' as const,
      commit: 'a'.repeat(40),
      ref: 'main',
    }));
    const checkRepositoryHealth = mock(async () => ({
      status: 'healthy' as const,
      head: 'a'.repeat(40),
      ref: 'main',
    }));

    const result = await updatePlugin(
      url,
      {
        ...updateDeps,
        fetchFn: undefined,
        updateFetchDeps: {
          existsSync: () => true,
          pull,
          resolveRemoteRevision,
          checkRepositoryHealth,
        },
      },
      new UpdateContext(),
    );

    expect(result).toEqual({
      plugin: url,
      success: true,
      action: 'skipped',
      changed: false,
    });
    expect(resolveRemoteRevision).toHaveBeenCalledTimes(1);
    expect(checkRepositoryHealth).toHaveBeenCalledTimes(1);
    expect(pull).not.toHaveBeenCalled();
  });

  it('derives a direct update change from fallback pre and post commits', async () => {
    const url = 'https://github.com/external/changed-repo';
    seedFetchCache(url, '/stale/global/cache');
    let head = 'a'.repeat(40);
    const pull = mock(async () => {
      head = 'b'.repeat(40);
    });

    const result = await updatePlugin(
      url,
      {
        ...updateDeps,
        fetchFn: undefined,
        updateFetchDeps: {
          existsSync: () => true,
          pull,
          resolveHeadSha: async () => head,
          resolveRemoteRevision: async () => ({
            status: 'resolved' as const,
            commit: 'b'.repeat(40),
            ref: 'main',
          }),
          checkRepositoryHealth: async () => ({
            status: 'unhealthy' as const,
            reason: 'head-mismatch' as const,
            head,
          }),
        },
      },
      new UpdateContext(),
    );

    expect(result).toEqual({
      plugin: url,
      success: true,
      action: 'updated',
      changed: true,
    });
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it('marks an equal unresolved direct fallback unchanged', async () => {
    const url = 'https://github.com/external/equal-fallback';
    seedFetchCache(url, '/stale/global/cache');
    const pull = mock(async () => undefined);

    const result = await updatePlugin(
      url,
      {
        ...updateDeps,
        fetchFn: undefined,
        updateFetchDeps: {
          existsSync: () => true,
          pull,
          resolveHeadSha: async () => 'a'.repeat(40),
          resolveRemoteRevision: async () => ({
            status: 'unresolved' as const,
            reason: 'failed' as const,
          }),
        },
      },
      new UpdateContext(),
    );

    expect(result).toEqual({
      plugin: url,
      success: true,
      action: 'updated',
      changed: false,
    });
    expect(pull).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed usable-cache fallback non-fatal and unchanged', async () => {
    const url = 'https://github.com/external/fallback-failure';
    seedFetchCache(url, '/stale/global/cache');
    const pull = mock(async () => {
      throw new Error('not something we can merge');
    });

    const result = await updatePlugin(
      url,
      {
        ...updateDeps,
        fetchFn: undefined,
        updateFetchDeps: {
          existsSync: () => true,
          pull,
          resolveHeadSha: async () => 'a'.repeat(40),
          resolveRemoteRevision: async () => ({
            status: 'unresolved' as const,
            reason: 'failed' as const,
          }),
          checkRepositoryHealth: async () => ({
            status: 'unhealthy' as const,
            reason: 'inspection-failed' as const,
          }),
        },
      },
      new UpdateContext(),
    );

    expect(result).toEqual({
      plugin: url,
      success: true,
      action: 'skipped',
      changed: false,
    });
  });

  it('fails when a pull error leaves no usable cached revision', async () => {
    const url = 'https://github.com/external/corrupt-cache';
    const pull = mock(async () => {
      throw new Error('not a repository');
    });

    const result = await updatePlugin(
      url,
      {
        ...updateDeps,
        fetchFn: undefined,
        updateFetchDeps: {
          existsSync: () => true,
          pull,
          resolveHeadSha: async () => {
            throw new Error('bad revision HEAD');
          },
          resolveRemoteRevision: async () => ({
            status: 'unresolved' as const,
            reason: 'failed' as const,
          }),
        },
      },
      new UpdateContext(),
    );

    expect(result).toMatchObject({
      plugin: url,
      success: false,
      action: 'failed',
      changed: false,
    });
  });

  it('should return error when marketplace not found', async () => {
    const result = await updatePlugin('plugin@unknown-marketplace', updateDeps);
    expect(result.success).toBe(false);
    expect(result.action).toBe('failed');
    expect(result.error).toContain('Marketplace not found');
  });

  it('should update successfully for embedded plugins', async () => {
    const result = await updatePlugin('embedded-plugin@test-marketplace', updateDeps);
    expect(result.success).toBe(true);
    expect(result.action).toBe('updated');
  });

  it('should update successfully for external plugins', async () => {
    const result = await updatePlugin('external-plugin@test-marketplace', updateDeps);
    expect(result.success).toBe(true);
    expect(result.action).toBe('updated');
  });

  it('keeps the external checkout result authoritative when marketplace refresh fails', async () => {
    const updateMarketplace = mock(async (name: string) => [
      { name, success: false, error: 'marketplace failed' },
    ]);
    const fetchFn = mock(async () => ({
      success: true,
      action: 'updated' as const,
      cachePath: '/mock/cache/path',
    }));

    const result = await updatePlugin('external-plugin@test-marketplace', {
      ...updateDeps,
      updateMarketplace,
      fetchFn,
    });

    expect(result).toEqual({
      plugin: 'external-plugin@test-marketplace',
      success: true,
      action: 'updated',
    });
  });

  it('keeps an external checkout failure authoritative after marketplace refresh succeeds', async () => {
    const fetchFn = mock(async () => ({
      success: false,
      action: 'skipped' as const,
      cachePath: '/mock/cache/path',
      error: 'external failed',
    }));

    const result = await updatePlugin('external-plugin@test-marketplace', {
      ...updateDeps,
      fetchFn,
    });

    expect(result).toEqual({
      plugin: 'external-plugin@test-marketplace',
      success: false,
      action: 'failed',
      error: 'external failed',
    });
  });

  it('ORs successful marketplace change into an authoritative external failure', async () => {
    const updateMarketplace = mock(async (name: string) => [
      { name, success: true, changed: true },
    ]);
    const fetchFn = mock(async () => ({
      success: false,
      action: 'skipped' as const,
      cachePath: '/mock/cache/path',
      changed: false,
      error: 'external failed',
    }));

    const result = await updatePlugin(
      'external-plugin@test-marketplace',
      {
        ...updateDeps,
        updateMarketplace,
        fetchFn,
      },
      new UpdateContext(),
    );

    expect(result).toEqual({
      plugin: 'external-plugin@test-marketplace',
      success: false,
      action: 'failed',
      error: 'external failed',
      changed: true,
    });
  });

  it('should update the exact registry key after source fallback lookup', async () => {
    const deps: UpdatePluginDeps = {
      ...updateDeps,
      getMarketplaceRegistration: mock(async () => ({
        key: 'legacy-alias',
        entry: {
          name: 'canonical-name',
          path: '/mock/marketplace/path',
          source: { type: 'github' as const, location: 'owner/test-marketplace' },
        },
      })),
    };

    const result = await updatePlugin(
      'embedded-plugin@owner/test-marketplace',
      deps,
    );

    expect(result.success).toBe(true);
    expect(mockUpdateMarketplace).toHaveBeenCalledWith('legacy-alias');
    expect(mockUpdateMarketplace).not.toHaveBeenCalledWith('canonical-name');
  });

  it('should reject unsafe marketplace access before parsing its manifest', async () => {
    const deps: UpdatePluginDeps = {
      ...updateDeps,
      validateMarketplaceAccess: () => 'Refused unsafe marketplace path',
    };

    const result = await updatePlugin('embedded-plugin@test-marketplace', deps);

    expect(result.success).toBe(false);
    expect(result.error).toBe('Refused unsafe marketplace path');
    expect(mockParseManifest).not.toHaveBeenCalled();
    expect(mockUpdateMarketplace).not.toHaveBeenCalled();
  });
});

describe('checkPluginUpdate', () => {
  const healthy = (head: string) =>
    mock(async () => ({ status: 'healthy' as const, head, ref: 'main' }));
  const resolved = (commit: string) =>
    mock(async () => ({
      status: 'resolved' as const,
      commit,
      ref: 'main',
    }));

  function checkDeps(
    overrides: Partial<PluginUpdateCheckDeps> = {},
  ): PluginUpdateCheckDeps {
    return {
      parsePluginSpec: (spec) => {
        const [plugin, marketplaceName] = spec.split('@');
        return plugin && marketplaceName ? { plugin, marketplaceName } : null;
      },
      getMarketplaceRegistration: async () => null,
      validateMarketplaceAccess: () => undefined,
      parseMarketplaceManifest: async () => ({
        success: true,
        data: { plugins: [] },
      }),
      existsSync: () => true,
      ...overrides,
    };
  }

  it('classifies a healthy equal direct checkout as up-to-date', async () => {
    const pull = mock(async () => undefined);
    const result = await checkPluginUpdate(
      'https://github.com/owner/repo',
      checkDeps({
        pull,
        resolveRemoteRevision: resolved('a'.repeat(40)),
        checkRepositoryHealth: healthy('a'.repeat(40)),
      }),
      new UpdateContext(),
    );

    expect(result).toEqual({
      plugin: 'https://github.com/owner/repo',
      status: 'up-to-date',
    });
    expect(pull).not.toHaveBeenCalled();
  });

  it('classifies a checkout behind its remote as available', async () => {
    const result = await checkPluginUpdate(
      'https://github.com/owner/repo',
      checkDeps({
        resolveRemoteRevision: resolved('b'.repeat(40)),
        checkRepositoryHealth: mock(async () => ({
          status: 'unhealthy' as const,
          reason: 'head-mismatch' as const,
          head: 'a'.repeat(40),
        })),
      }),
      new UpdateContext(),
    );

    expect(result.status).toBe('available');
  });

  it('treats a local marketplace plugin as available work', async () => {
    const result = await checkPluginUpdate(
      'embedded@local-marketplace',
      checkDeps({
        getMarketplaceRegistration: async () => ({
          key: 'local-marketplace',
          entry: {
            name: 'local-marketplace',
            path: '/mock/local',
            source: { type: 'local', location: '/mock/local' },
          },
        }),
        parseMarketplaceManifest: async () => ({
          success: true,
          data: { plugins: [{ name: 'embedded', source: './plugins/embedded' }] },
        }),
      }),
      new UpdateContext(),
    );

    expect(result.status).toBe('available');
  });

  it('requires both the marketplace and external checkout to be current', async () => {
    const deps = checkDeps({
      getMarketplaceRegistration: async () => ({
        key: 'test-marketplace',
        entry: {
          name: 'test-marketplace',
          path: '/mock/marketplace',
          source: { type: 'github', location: 'owner/marketplace' },
        },
      }),
      parseMarketplaceManifest: async () => ({
        success: true,
        data: {
          plugins: [
            { name: 'external', source: { url: 'https://github.com/external/repo' } },
          ],
        },
      }),
      resolveRemoteRevision: resolved('a'.repeat(40)),
    });

    const current = await checkPluginUpdate(
      'external@test-marketplace',
      { ...deps, checkRepositoryHealth: healthy('a'.repeat(40)) },
      new UpdateContext(),
    );
    expect(current.status).toBe('up-to-date');

    const stale = await checkPluginUpdate(
      'external@test-marketplace',
      {
        ...deps,
        checkRepositoryHealth: mock(async (path: string) =>
          path.includes('external')
            ? {
                status: 'unhealthy' as const,
                reason: 'head-mismatch' as const,
                head: 'b'.repeat(40),
              }
            : { status: 'healthy' as const, head: 'a'.repeat(40), ref: 'main' },
        ),
      },
      new UpdateContext(),
    );
    expect(stale.status).toBe('available');
  });

  it('reports a declaration with no remote source as not-remote', async () => {
    const result = await checkPluginUpdate('./local/plugin', checkDeps());

    expect(result).toEqual({
      plugin: './local/plugin',
      status: 'not-remote',
    });
  });

  it('reports an unresolvable marketplace as failed', async () => {
    const result = await checkPluginUpdate(
      'plugin@unknown-marketplace',
      checkDeps(),
    );

    expect(result).toEqual({
      plugin: 'plugin@unknown-marketplace',
      status: 'failed',
      error: 'Marketplace not found: unknown-marketplace',
    });
  });
});
