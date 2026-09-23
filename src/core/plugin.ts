import { mkdir, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  parseGitHubUrl,
  getPluginCachePath,
  parseMarketplaceLocation,
  validatePluginSource,
} from '../utils/plugin-path.js';
import { getHomeDir } from '../constants.js';
import {
  checkRepositoryHealth,
  cloneTo,
  createGit,
  gitHubUrl,
  GitCloneError,
  pull,
  resolveRemoteRevision,
  type RemoteRevisionResult,
  type RepositoryHealthResult,
} from './git.js';
import type { UpdateContext } from './update-context.js';

/**
 * Information about a cached plugin
 */
export interface CachedPlugin {
  name: string;
  path: string;
  lastModified: Date;
}

/**
 * Result of plugin fetch operation
 */
export interface FetchResult {
  success: boolean;
  action: 'fetched' | 'updated' | 'skipped';
  cachePath: string;
  error?: string;
  /** Duration of the git operation in milliseconds */
  durationMs?: number;
  /** The ref (branch/tag) the fetch resolved against, if known. */
  resolvedRef?: string;
  /** Resolved commit SHA of the cached working tree, if known. */
  resolvedSha?: string;
  /** Internal physical-content fact for update orchestration. */
  changed?: boolean;
}

/**
 * Options for fetchPlugin
 */
export interface FetchOptions {
  /** Skip fetching from remote and use cached version if available */
  offline?: boolean;
  /** Branch to checkout after fetching (defaults to default branch) */
  branch?: string;
}

/**
 * Dependencies for fetchPlugin (for testing)
 */
export interface FetchDeps {
  existsSync?: typeof existsSync;
  mkdir?: typeof mkdir;
  cloneTo?: typeof cloneTo;
  pull?: typeof pull;
}

export interface PluginUpdateFetchDeps extends FetchDeps {
  resolveHeadSha?: (repoPath: string) => Promise<string | undefined>;
  resolveRemoteRevision?: (
    source: string,
    requestedRef?: string,
  ) => Promise<RemoteRevisionResult>;
  checkRepositoryHealth?: (
    repoPath: string,
    expected: { source: string; ref?: string; head: string },
  ) => Promise<RepositoryHealthResult>;
}

/**
 * Resolve the HEAD commit SHA of a local repository. Returns undefined if the
 * directory isn't a git repo (e.g., a marketplace subdirectory that was
 * copied rather than cloned) or rev-parse fails for any other reason.
 */
async function resolveHeadSha(repoPath: string): Promise<string | undefined> {
  try {
    const sha = await createGit(repoPath).revparse(['HEAD']);
    const trimmed = sha.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

// Deduplicates git operations for the same cache directory within a sync session.
// Both concurrent and sequential callers targeting the same repo reuse the
// result of the first git operation. Call `resetFetchCache()` between sync
// sessions to allow fresh fetches.
const fetchCache = new Map<string, Promise<FetchResult>>();

/**
 * Reset the fetch cache between sync sessions.
 * Call this at the start of a sync to ensure fresh fetches.
 */
export function resetFetchCache(): void {
  fetchCache.clear();
}

/**
 * Seed the fetch cache with a pre-resolved path for a GitHub URL.
 *
 * Call this after marketplace registration/update so that subsequent
 * `fetchPlugin` calls for the same repo skip the redundant git pull.
 *
 * @param url - GitHub URL or owner/repo shorthand
 * @param path - Local path where the repo already exists
 * @param branch - Optional branch override (seeds branch-qualified cache key)
 */
export function seedFetchCache(url: string, path: string, branch?: string): void {
  const parsed = parseGitHubUrl(url);
  if (!parsed) return;

  const { owner, repo } = parsed;
  const cachePath = getPluginCachePath(owner, repo, branch ?? parsed.branch);

  // Don't overwrite if already populated (e.g. by a prior fetchPlugin call)
  if (fetchCache.has(cachePath)) return;

  fetchCache.set(
    cachePath,
    Promise.resolve({
      success: true,
      action: 'skipped' as const,
      cachePath: path,
    }),
  );
}

/**
 * Fetch a plugin from GitHub to local cache.
 *
 * Deduplicates git operations: the first caller for a given cache path
 * performs the git pull/clone; all subsequent callers (concurrent or
 * sequential) reuse the same result within the current sync session.
 *
 * @param url - GitHub URL of the plugin
 * @param options - Fetch options (force update)
 * @param deps - Optional dependencies for testing
 * @returns Result of the fetch operation
 */
export async function fetchPlugin(
  url: string,
  options: FetchOptions = {},
  deps: FetchDeps = {},
): Promise<FetchResult> {
  const { offline = false, branch } = options;

  // Validate plugin source
  const validation = validatePluginSource(url);
  if (!validation.valid) {
    return {
      success: false,
      action: 'skipped',
      cachePath: '',
      ...(validation.error && { error: validation.error }),
    };
  }

  // Parse GitHub URL
  const parsed = parseGitHubUrl(url);
  if (!parsed) {
    return {
      success: false,
      action: 'skipped',
      cachePath: '',
      error:
        'Invalid GitHub URL format. Expected: https://github.com/owner/repo',
    };
  }

  const { owner, repo } = parsed;
  const effectiveBranch = branch ?? parsed.branch;
  const cachePath = getPluginCachePath(owner, repo, effectiveBranch);

  // Return cached result if this repo was already fetched this session
  const cached = fetchCache.get(cachePath);
  if (cached) {
    return cached;
  }

  const promise = doFetchPlugin(
    cachePath,
    owner,
    repo,
    offline,
    effectiveBranch,
    deps,
  );
  fetchCache.set(cachePath, promise);
  return promise;
}

/**
 * Internal: performs the actual git fetch/pull/clone for a plugin.
 */
async function doFetchPlugin(
  cachePath: string,
  owner: string,
  repo: string,
  offline: boolean,
  branch: string | undefined,
  deps: FetchDeps,
): Promise<FetchResult> {
  const {
    existsSync: existsSyncFn = existsSync,
    mkdir: mkdirFn = mkdir,
    cloneTo: cloneToFn = cloneTo,
    pull: pullFn = pull,
  } = deps;

  // Check if plugin is already cached
  const isCached = existsSyncFn(cachePath);

  if (isCached && offline) {
    // Offline mode: use cached version without fetching
    return {
      success: true,
      action: 'skipped',
      cachePath,
    };
  }

  const repoUrl = gitHubUrl(owner, repo);

  if (isCached) {
    // Pull latest changes, but treat failures as non-fatal since the
    // cached version is still usable (e.g. concurrent pulls on the same
    // shallow clone can fail with "not something we can merge").
    try {
      const pullStart = performance.now();
      await pullFn(cachePath);
      const pullMs = Math.round(performance.now() - pullStart);
      const sha = await resolveHeadSha(cachePath);
      return {
        success: true,
        action: 'updated',
        cachePath,
        durationMs: pullMs,
        ...(branch && { resolvedRef: branch }),
        ...(sha && { resolvedSha: sha }),
      };
    } catch {
      const sha = await resolveHeadSha(cachePath);
      return {
        success: true,
        action: 'skipped',
        cachePath,
        ...(branch && { resolvedRef: branch }),
        ...(sha && { resolvedSha: sha }),
      };
    }
  }

  try {
    // Clone new plugin
    // Ensure parent directory exists
    const parentDir = dirname(cachePath);
    await mkdirFn(parentDir, { recursive: true });

    const cloneStart = performance.now();
    await cloneToFn(repoUrl, cachePath, branch);
    const cloneMs = Math.round(performance.now() - cloneStart);
    const sha = await resolveHeadSha(cachePath);

    return {
      success: true,
      action: 'fetched',
      cachePath,
      durationMs: cloneMs,
      ...(branch && { resolvedRef: branch }),
      ...(sha && { resolvedSha: sha }),
    };
  } catch (error) {
    if (error instanceof GitCloneError) {
      if (error.isAuthError) {
        return {
          success: false,
          action: 'skipped',
          cachePath,
          error: `Authentication failed for ${owner}/${repo}.\n  Check your SSH keys or git credentials.`,
        };
      }
      if (error.isTimeout) {
        return {
          success: false,
          action: 'skipped',
          cachePath,
          error: `Clone timed out for ${owner}/${repo}.\n  Check your network connection.`,
        };
      }
    }

    return {
      success: false,
      action: 'skipped',
      cachePath,
      error: `Failed to fetch plugin: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Get the cache directory for plugins
 * @returns Path to plugin cache directory
 */
export function getPluginCacheDir(): string {
  return resolve(getHomeDir(), '.allagents', 'plugins', 'marketplaces');
}

/**
 * List all cached plugins
 * @returns Array of cached plugin information
 */
export async function listCachedPlugins(): Promise<CachedPlugin[]> {
  const cacheDir = getPluginCacheDir();

  if (!existsSync(cacheDir)) {
    return [];
  }

  const entries = await readdir(cacheDir, { withFileTypes: true });
  const plugins: CachedPlugin[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const pluginPath = join(cacheDir, entry.name);
      const stats = await stat(pluginPath);

      plugins.push({
        name: entry.name,
        path: pluginPath,
        lastModified: stats.mtime,
      });
    }
  }

  // Sort by name
  plugins.sort((a, b) => a.name.localeCompare(b.name));

  return plugins;
}

/**
 * Result of update operation
 */
export interface UpdateResult {
  name: string;
  success: boolean;
  error?: string;
  /** Internal physical-content fact for update orchestration. */
  changed?: boolean;
}

/**
 * Update cached plugins by running git pull
 * @param name - Optional plugin name to update (updates all if not specified)
 * @returns Array of update results
 */
export async function updateCachedPlugins(
  name?: string,
): Promise<UpdateResult[]> {
  const plugins = await listCachedPlugins();
  const results: UpdateResult[] = [];

  // Filter by name if specified
  const toUpdate = name ? plugins.filter((p) => p.name === name) : plugins;

  if (name && toUpdate.length === 0) {
    return [
      {
        name,
        success: false,
        error: `Plugin not found in cache: ${name}`,
      },
    ];
  }

  for (const plugin of toUpdate) {
    try {
      await pull(plugin.path);
      results.push({ name: plugin.name, success: true });
    } catch (error) {
      results.push({
        name: plugin.name,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return results;
}

/**
 * Get the plugin name from the directory name.
 *
 * Cache directories for ref-specific clones use the form
 * `<owner>-<repo>@<sanitized-ref>`. The ref suffix is part of the on-disk
 * layout for collision avoidance, but the logical plugin name is the
 * base — strip the suffix so callers that key workspace.yaml entries by
 * plugin name (e.g., setPluginSkillsMode) match against the base form.
 *
 * @param pluginPath - Resolved path to the plugin directory
 * @returns The plugin name (directory basename, without any `@ref` suffix)
 */
export function getPluginName(pluginPath: string): string {
  const base = basename(pluginPath);
  const atIdx = base.indexOf('@');
  return atIdx === -1 ? base : base.slice(0, atIdx);
}

/**
 * Result of updating an installed plugin
 */
export interface InstalledPluginUpdateResult {
  plugin: string;
  success: boolean;
  action: 'updated' | 'skipped' | 'failed';
  error?: string;
  /** Internal physical-content fact for update orchestration. */
  changed?: boolean;
}

/**
 * Dependencies for classifying whether a declared plugin can be updated.
 * Shared by the non-mutating check and the applying update.
 */
export interface PluginUpdateCheckDeps extends PluginUpdateFetchDeps {
  parsePluginSpec: (spec: string) => { plugin: string; marketplaceName: string; owner?: string; repo?: string } | null;
  getMarketplaceRegistration: (name: string, sourceLocation?: string) => Promise<{
    key: string;
    entry: { name: string; path: string; source: { type: 'github' | 'git' | 'local'; location: string } };
  } | null>;
  validateMarketplaceAccess: (marketplace: { name: string; path: string; source: { type: 'github' | 'git' | 'local'; location: string } }) => string | undefined;
  parseMarketplaceManifest: (path: string) => Promise<{ success: boolean; data?: { plugins: Array<{ name: string; source: string | { url: string } }> } }>;
}

/**
 * Dependencies for updatePlugin (for testing)
 */
export interface UpdatePluginDeps extends PluginUpdateCheckDeps {
  updateMarketplace: (name: string) => Promise<Array<{ name: string; success: boolean; error?: string; changed?: boolean }>>;
  /** Optional fetch function for testing - defaults to fetchPlugin */
  fetchFn?: (url: string) => Promise<FetchResult>;
  /** Optional dependencies for the context-aware direct update path. */
  updateFetchDeps?: PluginUpdateFetchDeps;
}

/**
 * Non-mutating availability of an update for one declared plugin.
 *
 * - `available`: the declaration has remote work to apply (or cannot be proven
 *   current), so the caller should apply it.
 * - `up-to-date`: the backing checkout matches its remote and is healthy, so
 *   applying would be a no-op.
 * - `failed`: the declaration cannot be resolved at all.
 */
export type PluginUpdateCheckStatus = 'available' | 'up-to-date' | 'failed';

export interface PluginUpdateCheck {
  plugin: string;
  status: PluginUpdateCheckStatus;
  error?: string;
}

type CheckoutUpdateState = 'available' | 'up-to-date';

/**
 * Classify one checkout without writing to it: a healthy checkout that already
 * matches its advertised remote revision has nothing to apply.
 */
async function checkoutUpdateState(
  cachePath: string,
  source: string,
  ref: string | undefined,
  context: UpdateContext | undefined,
  deps: PluginUpdateCheckDeps,
): Promise<CheckoutUpdateState> {
  if (!context) return 'available';
  const exists = deps.existsSync ?? existsSync;
  if (!exists(cachePath)) return 'available';
  const resolveRemote = deps.resolveRemoteRevision ?? resolveRemoteRevision;
  let remote: RemoteRevisionResult;
  try {
    remote = await context.getRemote(source, ref, () =>
      resolveRemote(source, ref),
    );
  } catch {
    return 'available';
  }
  if (remote.status !== 'resolved') return 'available';
  const checkHealth = deps.checkRepositoryHealth ?? checkRepositoryHealth;
  const identity = {
    path: cachePath,
    source,
    ...(remote.ref !== undefined && { ref: remote.ref }),
  };
  let health: RepositoryHealthResult;
  try {
    health = await context.getHealth(identity, () =>
      checkHealth(cachePath, {
        source,
        ...(remote.ref !== undefined && { ref: remote.ref }),
        head: remote.commit,
      }),
    );
  } catch {
    return 'available';
  }
  return health.status === 'healthy' ? 'up-to-date' : 'available';
}

/**
 * Classify a marketplace-backed declaration. A local marketplace has no remote
 * revision to compare, so it stays `available` and the apply step re-syncs it.
 */
async function marketplaceUpdateState(
  marketplace: {
    name: string;
    path: string;
    source: { type: 'github' | 'git' | 'local'; location: string };
  },
  deps: PluginUpdateCheckDeps,
  context: UpdateContext | undefined,
): Promise<CheckoutUpdateState> {
  if (marketplace.source.type === 'local') return 'available';
  const location =
    marketplace.source.type === 'github'
      ? parseMarketplaceLocation(marketplace.source.location)
      : undefined;
  return checkoutUpdateState(
    marketplace.path,
    location ? gitHubUrl(location.owner, location.repo) : marketplace.source.location,
    location?.branch,
    context,
    deps,
  );
}

async function directUrlUpdateCheck(
  url: string,
  deps: PluginUpdateCheckDeps,
  context: UpdateContext | undefined,
): Promise<Omit<PluginUpdateCheck, 'plugin'>> {
  const validation = validatePluginSource(url);
  if (!validation.valid) {
    return {
      status: 'failed',
      ...(validation.error && { error: validation.error }),
    };
  }
  const github = parseGitHubUrl(url);
  if (!github) {
    return {
      status: 'failed',
      error: 'Invalid GitHub URL format. Expected: https://github.com/owner/repo',
    };
  }
  return {
    status: await checkoutUpdateState(
      getPluginCachePath(github.owner, github.repo, github.branch),
      gitHubUrl(github.owner, github.repo),
      github.branch,
      context,
      deps,
    ),
  };
}

/**
 * Classify a declared plugin without mutating any checkout, cache, or registry.
 * Callers use this to report discovery and to decide whether to apply.
 */
export async function checkPluginUpdate(
  pluginSpec: string,
  deps: PluginUpdateCheckDeps,
  context?: UpdateContext,
): Promise<PluginUpdateCheck> {
  const parsed = deps.parsePluginSpec(pluginSpec);
  if (!parsed) {
    if (!pluginSpec.startsWith('https://github.com/')) {
      return { plugin: pluginSpec, status: 'available' };
    }
    return { plugin: pluginSpec, ...(await directUrlUpdateCheck(pluginSpec, deps, context)) };
  }

  const sourceLocation =
    parsed.owner && parsed.repo ? `${parsed.owner}/${parsed.repo}` : undefined;
  const registration = await deps.getMarketplaceRegistration(
    parsed.marketplaceName,
    sourceLocation,
  );
  if (!registration) {
    return {
      plugin: pluginSpec,
      status: 'failed',
      error: `Marketplace not found: ${parsed.marketplaceName}`,
    };
  }
  const marketplace = registration.entry;
  const accessError = deps.validateMarketplaceAccess(marketplace);
  if (accessError) {
    return { plugin: pluginSpec, status: 'failed', error: accessError };
  }

  // Without a readable manifest the apply step owns resolution, so treat the
  // declaration as work to do rather than claiming it is current.
  const manifest = await deps.parseMarketplaceManifest(marketplace.path);
  const pluginEntry = manifest.success
    ? manifest.data?.plugins.find((candidate) => candidate.name === parsed.plugin)
    : undefined;
  if (!pluginEntry) {
    return { plugin: pluginSpec, status: 'available' };
  }

  if (typeof pluginEntry.source === 'string') {
    return {
      plugin: pluginSpec,
      status: await marketplaceUpdateState(marketplace, deps, context),
    };
  }

  const external = await directUrlUpdateCheck(
    pluginEntry.source.url,
    deps,
    context,
  );
  if (external.status === 'failed') {
    return { plugin: pluginSpec, ...external };
  }
  const marketplaceState =
    marketplace.source.type === 'github'
      ? await marketplaceUpdateState(marketplace, deps, context)
      : 'up-to-date';
  return {
    plugin: pluginSpec,
    status:
      marketplaceState === 'available' || external.status === 'available'
        ? 'available'
        : 'up-to-date',
  };
}

interface PluginApplyFact {
  success: boolean;
  changed: boolean;
  preCommit?: string;
  postCommit?: string;
  durationMs?: number;
  error?: unknown;
}

async function fetchPluginForUpdate(
  url: string,
  dependencies: PluginUpdateFetchDeps,
  context: UpdateContext,
): Promise<FetchResult> {
  const validation = validatePluginSource(url);
  if (!validation.valid) {
    return {
      success: false,
      action: 'skipped',
      cachePath: '',
      changed: false,
      ...(validation.error && { error: validation.error }),
    };
  }

  const parsed = parseGitHubUrl(url);
  if (!parsed) {
    return {
      success: false,
      action: 'skipped',
      cachePath: '',
      changed: false,
      error:
        'Invalid GitHub URL format. Expected: https://github.com/owner/repo',
    };
  }

  const { owner, repo, branch } = parsed;
  const cachePath = getPluginCachePath(owner, repo, branch);
  const source = gitHubUrl(owner, repo);
  const existsSyncFn = dependencies.existsSync ?? existsSync;
  const pullFn = dependencies.pull ?? pull;
  const mkdirFn = dependencies.mkdir ?? mkdir;
  const cloneToFn = dependencies.cloneTo ?? cloneTo;
  const resolveHead = dependencies.resolveHeadSha ?? resolveHeadSha;
  const resolveRemote =
    dependencies.resolveRemoteRevision ?? resolveRemoteRevision;
  const checkHealth =
    dependencies.checkRepositoryHealth ?? checkRepositoryHealth;
  const readHead = async (): Promise<string | undefined> => {
    try {
      return await resolveHead(cachePath);
    } catch {
      return undefined;
    }
  };

  if (!existsSyncFn(cachePath)) {
    const fact = await context.getApply(
      {
        path: cachePath,
        source,
        ...(branch !== undefined && { ref: branch }),
      },
      async (): Promise<PluginApplyFact> => {
        try {
          await mkdirFn(dirname(cachePath), { recursive: true });
          const start = performance.now();
          await cloneToFn(source, cachePath, branch);
          const durationMs = Math.round(performance.now() - start);
          const postCommit = await readHead();
          return {
            success: true,
            changed: true,
            ...(postCommit !== undefined && { postCommit }),
            durationMs,
          };
        } catch (error) {
          return { success: false, changed: false, error };
        }
      },
    );

    if (fact.success) {
      return {
        success: true,
        action: 'fetched',
        cachePath,
        changed: true,
        ...(fact.durationMs !== undefined && { durationMs: fact.durationMs }),
        ...(branch && { resolvedRef: branch }),
        ...(fact.postCommit && { resolvedSha: fact.postCommit }),
      };
    }

    const error = fact.error;
    if (error instanceof GitCloneError) {
      if (error.isAuthError) {
        return {
          success: false,
          action: 'skipped',
          cachePath,
          changed: false,
          error: `Authentication failed for ${owner}/${repo}.\n  Check your SSH keys or git credentials.`,
        };
      }
      if (error.isTimeout) {
        return {
          success: false,
          action: 'skipped',
          cachePath,
          changed: false,
          error: `Clone timed out for ${owner}/${repo}.\n  Check your network connection.`,
        };
      }
    }
    return {
      success: false,
      action: 'skipped',
      cachePath,
      changed: false,
      error: `Failed to fetch plugin: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let remote: RemoteRevisionResult;
  try {
    remote = await context.getRemote(source, branch, () =>
      resolveRemote(source, branch),
    );
  } catch {
    remote = { status: 'unresolved', reason: 'failed' };
  }

  const expectedRef = remote.status === 'resolved' ? remote.ref : branch;
  const identity = {
    path: cachePath,
    source,
    ...(expectedRef !== undefined && { ref: expectedRef }),
  };
  if (remote.status === 'resolved') {
    let health: RepositoryHealthResult;
    try {
      health = await context.getHealth(identity, () =>
        checkHealth(cachePath, {
          source,
          ref: remote.ref,
          head: remote.commit,
        }),
      );
    } catch (error) {
      health = {
        status: 'unhealthy',
        reason: 'inspection-failed',
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
    if (health.status === 'healthy') {
      return {
        success: true,
        action: 'updated',
        cachePath,
        changed: false,
        ...(branch && { resolvedRef: branch }),
        resolvedSha: remote.commit,
      };
    }
  }

  const fact = await context.getApply(
    identity,
    async (): Promise<PluginApplyFact> => {
      const preCommit = await readHead();
      try {
        const start = performance.now();
        await pullFn(cachePath);
        const durationMs = Math.round(performance.now() - start);
        const postCommit = await readHead();
        return {
          success: true,
          ...(preCommit !== undefined && { preCommit }),
          ...(postCommit !== undefined && { postCommit }),
          changed:
            !preCommit ||
            !postCommit ||
            preCommit.toLowerCase() !== postCommit.toLowerCase(),
          durationMs,
        };
      } catch (error) {
        const postCommit = await readHead();
        return {
          success: false,
          ...(preCommit !== undefined && { preCommit }),
          ...(postCommit !== undefined && { postCommit }),
          changed: false,
          error,
        };
      }
    },
  );

  if (!fact.success) {
    const retainedCommit = fact.postCommit ?? fact.preCommit;
    if (!retainedCommit) {
      return {
        success: false,
        action: 'skipped',
        cachePath,
        changed: false,
        error: `Failed to update cached plugin: ${fact.error instanceof Error ? fact.error.message : String(fact.error)}`,
      };
    }
    return {
      success: true,
      action: 'skipped',
      cachePath,
      changed: false,
      ...(branch && { resolvedRef: branch }),
      resolvedSha: retainedCommit,
    };
  }

  return {
    success: true,
    action: 'updated',
    cachePath,
    changed: fact.changed,
    ...(fact.durationMs !== undefined && { durationMs: fact.durationMs }),
    ...(branch && { resolvedRef: branch }),
    ...(fact.postCommit && { resolvedSha: fact.postCommit }),
  };
}
/**
 * Update a single plugin by pulling from remote.
 * Handles both marketplace-embedded and external plugins.
 *
 * @param pluginSpec - Plugin spec (e.g., "plugin@marketplace" or GitHub URL)
 * @param deps - Dependencies for marketplace operations (lazy loaded to avoid circular imports)
 */
export async function applyPluginUpdate(
  pluginSpec: string,
  deps: UpdatePluginDeps,
  context?: UpdateContext,
): Promise<InstalledPluginUpdateResult> {
  const fetchForUpdate =
    context && !deps.fetchFn
      ? (url: string) =>
          fetchPluginForUpdate(url, deps.updateFetchDeps ?? {}, context)
      : (deps.fetchFn ?? fetchPlugin);

  // Handle plugin@marketplace format
  const parsed = deps.parsePluginSpec(pluginSpec);
  if (!parsed) {
    // Might be a GitHub URL or local path
    if (pluginSpec.startsWith('https://github.com/')) {
      // External GitHub URL - update the cached repo
      const result = await fetchForUpdate(pluginSpec);
      return {
        plugin: pluginSpec,
        success: result.success,
        action:
          result.action === 'updated'
            ? 'updated'
            : result.success
              ? 'skipped'
              : 'failed',
        ...(result.error && { error: result.error }),
        ...(context && { changed: result.success ? (result.changed ?? false) : false }),
      };
    }

    // Local path - nothing to update
    return {
      plugin: pluginSpec,
      success: true,
      action: 'skipped',
      ...(context && { changed: false }),
    };
  }

  // Get marketplace info (with source location fallback for owner/repo format)
  const sourceLocation =
    parsed.owner && parsed.repo ? `${parsed.owner}/${parsed.repo}` : undefined;
  const registration = await deps.getMarketplaceRegistration(
    parsed.marketplaceName,
    sourceLocation,
  );
  if (!registration) {
    return {
      plugin: pluginSpec,
      success: false,
      action: 'failed',
      error: `Marketplace not found: ${parsed.marketplaceName}`,
      ...(context && { changed: false }),
    };
  }
  const marketplace = registration.entry;

  const accessError = deps.validateMarketplaceAccess(marketplace);
  if (accessError) {
    return {
      plugin: pluginSpec,
      success: false,
      action: 'failed',
      error: accessError,
      ...(context && { changed: false }),
    };
  }

  // Registry keys are authoritative. Manifest names can differ for legacy or
  // manually edited entries, especially when lookup fell back to source.
  const marketplaceKey = registration.key;

  // Parse marketplace manifest to determine if plugin is embedded or external
  const manifestResult = await deps.parseMarketplaceManifest(marketplace.path);
  if (!manifestResult.success || !manifestResult.data) {
    // No manifest - update the marketplace itself (plugin might be in directory)
    const updateResults = await deps.updateMarketplace(marketplaceKey);
    const result = updateResults[0];
    return {
      plugin: pluginSpec,
      success: result?.success ?? false,
      action: result?.success ? 'updated' : 'failed',
      ...(result?.error && { error: result.error }),
      ...(context && {
        changed: result?.success ? (result.changed ?? false) : false,
      }),
    };
  }

  // Find plugin entry in manifest
  const pluginEntry = manifestResult.data.plugins.find(
    (candidate) => candidate.name === parsed.plugin,
  );

  if (!pluginEntry) {
    // Plugin not in manifest - update marketplace and hope for the best
    const updateResults = await deps.updateMarketplace(marketplaceKey);
    const result = updateResults[0];
    return {
      plugin: pluginSpec,
      success: result?.success ?? false,
      action: result?.success ? 'updated' : 'failed',
      ...(result?.error && { error: result.error }),
      ...(context && {
        changed: result?.success ? (result.changed ?? false) : false,
      }),
    };
  }

  // Check if embedded (string path) or external (url object)
  if (typeof pluginEntry.source === 'string') {
    // Embedded plugin - update the marketplace
    const updateResults = await deps.updateMarketplace(marketplaceKey);
    const result = updateResults[0];
    return {
      plugin: pluginSpec,
      success: result?.success ?? false,
      action: result?.success ? 'updated' : 'failed',
      ...(result?.error && { error: result.error }),
      ...(context && {
        changed: result?.success ? (result.changed ?? false) : false,
      }),
    };
  }

  // External plugin - update both marketplace (for manifest changes) and the cached repo
  const url = pluginEntry.source.url;
  let marketplaceChanged = false;

  // Update the marketplace first (in case manifest changed)
  if (marketplace.source.type === 'github') {
    const marketplaceResult = (await deps.updateMarketplace(marketplaceKey))[0];
    marketplaceChanged =
      marketplaceResult?.success === true &&
      marketplaceResult.changed === true;
  }

  // Update the external plugin cache. Its public result remains authoritative.
  const fetchResult = await fetchForUpdate(url);
  return {
    plugin: pluginSpec,
    success: fetchResult.success,
    action:
      fetchResult.action === 'updated'
        ? 'updated'
        : fetchResult.success
          ? 'skipped'
          : 'failed',
    ...(fetchResult.error && { error: fetchResult.error }),
    ...(context && {
      changed:
        marketplaceChanged ||
        (fetchResult.success && fetchResult.changed === true),
    }),
  };
}

/**
 * Update a single plugin. Classification happens first so a checkout that is
 * already current is reported as skipped instead of being re-applied.
 */
export async function updatePlugin(
  pluginSpec: string,
  deps: UpdatePluginDeps,
  context?: UpdateContext,
): Promise<InstalledPluginUpdateResult> {
  const check = await checkPluginUpdate(
    pluginSpec,
    { ...deps, ...(deps.updateFetchDeps ?? {}) },
    context,
  );
  if (check.status === 'up-to-date') {
    return {
      plugin: pluginSpec,
      success: true,
      action: 'skipped',
      ...(context && { changed: false }),
    };
  }
  if (check.status === 'failed') {
    return {
      plugin: pluginSpec,
      success: false,
      action: 'failed',
      ...(check.error && { error: check.error }),
      ...(context && { changed: false }),
    };
  }
  return applyPluginUpdate(pluginSpec, deps, context);
}
