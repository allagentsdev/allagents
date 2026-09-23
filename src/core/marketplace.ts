import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { getHomeDir } from '../constants.js';
import {
  type MarketplaceFileArtifacts,
  getMarketplaceFileArtifacts,
} from '../models/marketplace-manifest.js';
import {
  getEmbeddedMarketplaceFileArtifacts,
  parseMarketplaceManifest,
  resolvePluginSourcePath,
} from '../utils/marketplace-manifest-parser.js';
import { normalizeGitRef } from '../utils/git-source.js';
import {
  getPluginCachePath,
  isFilesystemRoot,
  parseGitHubUrl,
  parseMarketplaceLocation,
} from '../utils/plugin-path.js';
import {
  checkRepositoryHealth,
  GitCloneError,
  cloneTo,
  createGit,
  gitHubUrl,
  pull,
  resolveRemoteRevision,
  type RemoteRevisionResult,
  type RepositoryHealthResult,
} from './git.js';
import type { UpdateContext } from './update-context.js';
import { fetchPlugin } from './plugin.js';
import type { FetchResult, UpdateResult } from './plugin.js';

/**
 * Source types for marketplaces
 */
export type MarketplaceSourceType = 'github' | 'git' | 'local';

/**
 * Source configuration for a marketplace
 */
export interface MarketplaceSource {
  type: MarketplaceSourceType;
  /** GitHub: "owner/repo", Git: full URL, Local: absolute path */
  location: string;
}

/**
 * Marketplace entry in registry
 */
export interface MarketplaceEntry {
  name: string;
  source: MarketplaceSource;
  /** Local path where marketplace is stored (for GitHub) or linked (for local) */
  path: string;
  lastUpdated?: string;
}

/** Exact registry identity for an entry; embedded names are not authoritative keys. */
export interface MarketplaceRegistration {
  key: string;
  entry: MarketplaceEntry;
  scope: MarketplaceScope;
  registryPath: string;
}

/**
 * Marketplace registry structure
 */
export interface MarketplaceRegistry {
  version: 1;
  marketplaces: Record<string, MarketplaceEntry>;
}

/** Registry aliases are untrusted keys and may overlap Object.prototype. */
function getRegistryMarketplace(
  registry: MarketplaceRegistry,
  key: string,
): MarketplaceEntry | undefined {
  return Object.hasOwn(registry.marketplaces, key)
    ? registry.marketplaces[key]
    : undefined;
}

function setRegistryMarketplace(
  registry: MarketplaceRegistry,
  key: string,
  entry: MarketplaceEntry,
): void {
  Object.defineProperty(registry.marketplaces, key, {
    value: entry,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function deleteRegistryMarketplace(
  registry: MarketplaceRegistry,
  key: string,
): boolean {
  return Object.hasOwn(registry.marketplaces, key)
    ? delete registry.marketplaces[key]
    : false;
}

/**
 * Result of marketplace operations
 */
export interface MarketplaceResult {
  success: boolean;
  marketplace?: MarketplaceEntry;
  error?: string;
  /** @deprecated No longer returned — add always replaces existing entries */
  alreadyRegistered?: boolean;
  /** True when addMarketplace replaced an existing marketplace entry */
  replaced?: boolean;
  /** User-level plugins that were removed during marketplace removal cascade */
  removedUserPlugins?: string[];
  /** User-level plugins that still reference the removed marketplace (returned when cascade is off) */
  retainedUserPlugins?: string[];
  /** Non-fatal safety warnings produced by the operation. */
  warnings?: string[];
}

/**
 * Get the allagents config directory
 */
export function getAllagentsDir(): string {
  return resolve(getHomeDir(), '.allagents');
}

/**
 * Get the marketplaces directory
 */
export function getMarketplacesDir(): string {
  return join(getAllagentsDir(), 'plugins', 'marketplaces');
}

/** Keep registry aliases unambiguous without imposing filesystem rules. */
function isValidMarketplaceAlias(name: string): boolean {
  const hasControlCharacter = Array.from(name).some((character) => {
    const codePoint = character.charCodeAt(0);
    return codePoint < 32 || codePoint === 127;
  });
  return !(
    !name ||
    name === '.' ||
    name === '..' ||
    /[/\\]/.test(name) ||
    hasControlCharacter
  );
}

/**
 * Remote marketplace names become directory names for managed caches. Apply
 * portable filesystem restrictions in addition to the registry-alias rules.
 */
function isValidManagedMarketplaceName(name: string): boolean {
  if (
    !isValidMarketplaceAlias(name) ||
    /[<>:"|?*]/.test(name) ||
    /[ .]$/.test(name) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  ) {
    return false;
  }

  const cacheRoot = resolve(getMarketplacesDir());
  return dirname(resolve(cacheRoot, name)) === cacheRoot;
}

/** Return the managed cache root owned by one registry scope. */
function getMarketplaceCacheRoot(registryPath: string): string {
  const cacheRoot = resolve(getMarketplacesDir());
  if (resolve(registryPath) === resolve(getRegistryPath())) {
    return cacheRoot;
  }

  const scopeKey = createHash('sha256')
    .update(resolve(registryPath))
    .digest('hex')
    .slice(0, 16);
  return resolve(cacheRoot, '.projects', scopeKey);
}

/** Return the exact managed cache path for a safe marketplace name and scope. */
function getManagedMarketplacePath(
  name: string,
  registryPath = getRegistryPath(),
): string | null {
  const cacheRoot = getMarketplaceCacheRoot(registryPath);
  if (
    !isValidManagedMarketplaceName(name) ||
    !hasSafeManagedMarketplaceRoot(cacheRoot)
  ) {
    return null;
  }
  return resolve(cacheRoot, name);
}

/**
 * Local marketplaces are user-owned, but a filesystem root or the user's
 * entire home directory is too broad to be a marketplace boundary.
 */
function isUnsafeLocalMarketplacePath(marketplacePath: string): boolean {
  const resolvedPath = canonicalizeExistingPath(marketplacePath);
  const homePath = canonicalizeExistingPath(getHomeDir());
  return isFilesystemRoot(resolvedPath) || resolvedPath === homePath;
}

/** Resolve symlinks for existing paths while retaining a stable fallback. */
function canonicalizeExistingPath(candidatePath: string): string {
  try {
    return realpathSync(candidatePath);
  } catch {
    return resolve(candidatePath);
  }
}

/**
 * AllAgents creates managed remote caches as real directories. A symlink at
 * that location has unknown ownership and must not be followed or removed.
 */
function isSymbolicLinkPath(candidatePath: string): boolean {
  try {
    return lstatSync(candidatePath).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Check for a filesystem entry without following a dangling symlink. */
function pathEntryExists(candidatePath: string): boolean {
  try {
    lstatSync(candidatePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * The complete AllAgents state directory may be relocated as one unit, but
 * its internal plugin/cache directories must remain real owned directories.
 */
function hasSafeManagedMarketplaceRoot(cacheRoot: string): boolean {
  const allagentsPath = canonicalizeExistingPath(getAllagentsDir());
  const homePath = canonicalizeExistingPath(getHomeDir());
  if (isFilesystemRoot(allagentsPath) || allagentsPath === homePath) {
    return false;
  }

  const projectScopesRoot = join(getMarketplacesDir(), '.projects');
  return (
    !isSymbolicLinkPath(join(getAllagentsDir(), 'plugins')) &&
    !isSymbolicLinkPath(getMarketplacesDir()) &&
    !isSymbolicLinkPath(projectScopesRoot) &&
    !isSymbolicLinkPath(cacheRoot)
  );
}

type ManagedMarketplacePathOwnership = 'owned' | 'legacy-project' | 'unmanaged';

/**
 * Classify a remote cache against its registry scope. Legacy project entries
 * remain readable until refresh migrates them, but must never be deleted by
 * the project registry.
 */
function classifyManagedMarketplacePath(
  marketplace: MarketplaceEntry,
  registryPath = getRegistryPath(),
  registryKey = marketplace.name,
): ManagedMarketplacePathOwnership {
  if (marketplace.source.type === 'local') return 'unmanaged';
  if (!isValidManagedMarketplaceName(marketplace.name)) return 'unmanaged';

  const cacheRoot = getMarketplaceCacheRoot(registryPath);
  if (!hasSafeManagedMarketplaceRoot(cacheRoot)) return 'unmanaged';
  if (isSymbolicLinkPath(marketplace.path)) return 'unmanaged';

  const sourceName =
    marketplace.source.type === 'github'
      ? parseMarketplaceLocation(marketplace.source.location).repo
      : parseMarketplaceSource(marketplace.source.location)?.name;
  const allowedNames = [
    ...new Set([registryKey, marketplace.name, sourceName]),
  ].filter(
    (name): name is string =>
      name != null && isValidManagedMarketplaceName(name),
  );
  const marketplacePath = resolve(marketplace.path);
  if (
    allowedNames.some((name) => resolve(cacheRoot, name) === marketplacePath)
  ) {
    return 'owned';
  }

  const isProjectRegistry =
    resolve(registryPath) !== resolve(getRegistryPath());
  if (!isProjectRegistry) return 'unmanaged';
  const userCacheRoot = resolve(getMarketplacesDir());
  return allowedNames.some(
    (name) => resolve(userCacheRoot, name) === marketplacePath,
  )
    ? 'legacy-project'
    : 'unmanaged';
}

function hasManagedRemotePath(
  marketplace: MarketplaceEntry,
  registryPath = getRegistryPath(),
  registryKey = marketplace.name,
): boolean {
  return (
    classifyManagedMarketplacePath(marketplace, registryPath, registryKey) !==
    'unmanaged'
  );
}

function hasOwnedManagedRemotePath(
  marketplace: MarketplaceEntry,
  registryPath: string,
  registryKey: string,
): boolean {
  return (
    classifyManagedMarketplacePath(marketplace, registryPath, registryKey) ===
    'owned'
  );
}

/** Return a safety error before reading, updating, or deleting registry paths. */
export function getMarketplaceAccessError(
  marketplace: MarketplaceEntry,
  registryPath = getRegistryPath(),
  registryKey = marketplace.name,
): string | undefined {
  if (marketplace.source.type === 'local') {
    return isUnsafeLocalMarketplacePath(marketplace.path)
      ? `Refused to access overly broad local marketplace path: ${marketplace.path}`
      : undefined;
  }
  return hasManagedRemotePath(marketplace, registryPath, registryKey)
    ? undefined
    : `Refused to access unmanaged marketplace path: ${marketplace.path}`;
}

/**
 * Get the registry file path
 */
export function getRegistryPath(): string {
  return join(getAllagentsDir(), 'marketplaces.json');
}

/**
 * Get the project-level registry file path
 */
export function getProjectRegistryPath(workspacePath: string): string {
  return join(workspacePath, '.allagents', 'marketplaces.json');
}

/**
 * Load marketplace registry from a specific file path
 */
export async function loadRegistryFromPath(
  registryPath: string,
): Promise<MarketplaceRegistry> {
  try {
    const content = await readFile(registryPath, 'utf-8');
    return JSON.parse(content) as MarketplaceRegistry;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, marketplaces: {} };
    }

    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Marketplace registry at ${registryPath} is unreadable: ${detail}. Refusing to overwrite it; fix or delete the file to continue.`,
      { cause: error },
    );
  }
}

/**
 * Save marketplace registry to a specific file path
 */
export async function saveRegistryToPath(
  registry: MarketplaceRegistry,
  registryPath: string,
): Promise<void> {
  const dir = dirname(registryPath);
  await mkdir(dir, { recursive: true });

  let mode: number | undefined;
  try {
    mode = (await stat(registryPath)).mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const temporaryPath = join(
    dir,
    `.${basename(registryPath)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, {
      encoding: 'utf-8',
      flag: 'wx',
      ...(mode !== undefined && { mode }),
    });
    if (mode !== undefined) {
      await chmod(temporaryPath, mode);
    }
    await rename(temporaryPath, registryPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

/** Serialize operations by resolved filesystem key without poisoning successors. */
function serializeByKey<T>(
  tails: Map<string, Promise<void>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previousTail = tails.get(key) ?? Promise.resolve();
  const result = previousTail.then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  // A successor can replace this tail before its cleanup microtask runs.
  void tail.then(() => {
    if (tails.get(key) === tail) {
      tails.delete(key);
    }
  });
  return result;
}

/** Tail of the in-process mutation queue for each resolved registry path. */
const registryMutationTails = new Map<string, Promise<void>>();

interface RegistryMutation<T> {
  result: T;
  changed: boolean;
}

/**
 * Run one registry mutation against a fresh snapshot and save it when changed.
 *
 * This only protects against concurrent writers within one process; it is not
 * a cross-process file lock.
 */
function mutateRegistry<T>(
  registryPath: string,
  mutate: (
    registry: MarketplaceRegistry,
  ) => RegistryMutation<T> | Promise<RegistryMutation<T>>,
): Promise<T> {
  const key = resolve(registryPath);
  return serializeByKey(registryMutationTails, key, async () => {
    const registry = await loadRegistryFromPath(key);
    const mutation = await mutate(registry);
    if (mutation.changed) {
      await saveRegistryToPath(registry, key);
    }
    return mutation.result;
  });
}

/** Tail of the in-process lifecycle queue for each managed cache path. */
const marketplaceCacheMutationTails = new Map<string, Promise<void>>();

/**
 * Serialize filesystem mutations for one managed marketplace cache.
 *
 * Registry transactions remain the persistence boundary. This queue only
 * coordinates cache users within this process; it is not a cross-process lock.
 */
function withMarketplaceCacheLock<T>(
  marketplacePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  return serializeByKey(
    marketplaceCacheMutationTails,
    resolve(marketplacePath),
    operation,
  );
}

async function removePathWithWarning(
  targetPath: string,
  description: string,
): Promise<string | undefined> {
  try {
    await rm(targetPath, { recursive: true, force: true });
    return undefined;
  } catch (error) {
    return `Failed to clean up ${description} at ${targetPath}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

class MarketplaceCachePublicationError extends Error {}

/**
 * Publish a staged cache and commit its matching registry mutation. Any failure
 * before a successful registry save restores the previous managed cache.
 */
async function replaceManagedMarketplaceCache(
  marketplaceName: string,
  managedPath: string,
  stagingPath: string,
  commit: () => Promise<MarketplaceResult>,
): Promise<MarketplaceResult> {
  if (isSymbolicLinkPath(managedPath)) {
    throw new MarketplaceCachePublicationError(
      `Remote marketplace cache cannot be a symbolic link: ${managedPath}`,
    );
  }

  const backupPath = join(dirname(managedPath), `.backup-${randomUUID()}`);
  const hadExistingCache = pathEntryExists(managedPath);
  if (hadExistingCache) {
    try {
      await rename(managedPath, backupPath);
    } catch (error) {
      throw new MarketplaceCachePublicationError(
        `Failed to prepare marketplace cache for '${marketplaceName}': ${error instanceof Error ? error.message : String(error)} The existing registration and cache were preserved.`,
        { cause: error },
      );
    }
  }

  try {
    await rename(stagingPath, managedPath);
  } catch (error) {
    let recoveryError: unknown;
    if (hadExistingCache && pathEntryExists(backupPath)) {
      try {
        await rename(backupPath, managedPath);
      } catch (restoreError) {
        recoveryError = restoreError;
      }
    }
    const detail = error instanceof Error ? error.message : String(error);
    const recoveryMessage = recoveryError
      ? ` Automatic recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}. The original cache remains at ${backupPath}.`
      : ' The existing registration and cache were preserved.';
    throw new MarketplaceCachePublicationError(
      `Failed to replace marketplace cache for '${marketplaceName}': ${detail}.${recoveryMessage}`,
      { cause: error },
    );
  }

  try {
    const result = await commit();
    if (!hadExistingCache) return result;

    const cleanupWarning = await removePathWithWarning(
      backupPath,
      `previous marketplace cache for '${marketplaceName}'`,
    );
    return cleanupWarning
      ? {
          ...result,
          warnings: [...(result.warnings ?? []), cleanupWarning],
        }
      : result;
  } catch (error) {
    let recoveryError: unknown;
    try {
      await rm(managedPath, { recursive: true, force: true });
      if (hadExistingCache && pathEntryExists(backupPath)) {
        await rename(backupPath, managedPath);
      }
    } catch (restoreError) {
      recoveryError = restoreError;
    }
    if (recoveryError) {
      const detail =
        recoveryError instanceof Error
          ? recoveryError.message
          : String(recoveryError);
      const recoveryLocation = hadExistingCache
        ? `The replacement may remain at ${managedPath}, and the original cache remains at ${backupPath}.`
        : `The unregistered replacement may remain at ${managedPath}.`;
      throw new Error(
        `Failed to commit marketplace '${marketplaceName}' and automatic cache recovery failed: ${detail}. ${recoveryLocation}`,
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * Load marketplace registry from disk
 */
export async function loadRegistry(): Promise<MarketplaceRegistry> {
  return loadRegistryFromPath(getRegistryPath());
}

/**
 * Save marketplace registry to disk
 */
export async function saveRegistry(
  registry: MarketplaceRegistry,
): Promise<void> {
  return saveRegistryToPath(registry, getRegistryPath());
}

/**
 * Get the source location key for a marketplace.
 * Each branch is treated as a separate marketplace, so the full location
 * (including branch) is used as the key.
 */
function getSourceLocationKey(source: MarketplaceSource): string {
  return source.location;
}

/**
 * Find a marketplace by source location in the registry
 */
function findBySourceLocation(
  registry: MarketplaceRegistry,
  sourceLocation: string,
): MarketplaceEntry | null {
  for (const entry of Object.values(registry.marketplaces)) {
    if (getSourceLocationKey(entry.source) === sourceLocation) {
      return entry;
    }
  }
  return null;
}

/**
 * Parse a marketplace source string
 * Supports:
 * - GitHub URL: https://github.com/owner/repo
 * - GitHub shorthand: owner/repo
 * - Local path: /absolute/path or ./relative/path
 */
export function parseMarketplaceSource(source: string): {
  type: MarketplaceSourceType;
  location: string;
  name: string;
  branch?: string;
} | null {
  // GitHub URL
  if (source.startsWith('https://github.com/')) {
    const parsed = parseGitHubUrl(source);
    if (parsed) {
      // In marketplace context, subpath after /tree/ is part of the branch name
      const branch =
        parsed.branch && parsed.subpath
          ? `${parsed.branch}/${parsed.subpath}`
          : parsed.branch;
      const location = branch
        ? `${parsed.owner}/${parsed.repo}/${branch}`
        : `${parsed.owner}/${parsed.repo}`;
      return {
        type: 'github',
        location,
        name: parsed.repo,
        ...(branch && { branch }),
      };
    }
    return null;
  }

  // Non-GitHub git URL (https://, git://, or ssh:// with a host)
  if (source.match(/^(https?|git|ssh):\/\/.+\/.+/)) {
    const name =
      source
        .split('/')
        .filter(Boolean)
        .pop()
        ?.replace(/\.git$/, '') || 'repo';
    return {
      type: 'git',
      location: source,
      name,
    };
  }

  // GitHub shorthand: owner/repo (exactly one slash, no backslashes, no protocol)
  const parts = source.split('/');
  if (
    parts.length === 2 &&
    parts[0] &&
    parts[1] &&
    !source.includes('\\') &&
    !source.includes('://')
  ) {
    return {
      type: 'github',
      location: source,
      name: parts[1],
    };
  }

  // Everything else is a local path
  const absPath = resolve(source);
  // Split on both / and \ so basename extraction works for Windows paths on any OS
  const name =
    source.split(/[/\\]/).filter(Boolean).pop() || basename(absPath) || 'local';
  return {
    type: 'local',
    location: absPath,
    name,
  };
}

/**
 * Options for specifying marketplace scope
 */
export interface MarketplaceScopeOptions {
  scope?: MarketplaceScope;
  workspacePath?: string;
}

function getMarketplaceCloneError(location: string, error: unknown): string {
  if (error instanceof GitCloneError) {
    if (error.isAuthError) {
      return `Authentication failed for ${location}.\n  Check your SSH keys or git credentials.`;
    }
    if (error.isTimeout) {
      return `Clone timed out for ${location}.\n  Check your network connection.`;
    }
  }

  const message = error instanceof Error ? error.message : String(error);
  if (message.toLowerCase().includes('not found') || message.includes('404')) {
    return `Repository not found: ${location}`;
  }
  return `Failed to clone marketplace: ${message}`;
}

/**
 * Add or replace a marketplace while preserving the existing registration and
 * managed cache when staging or persistence fails.
 *
 * @param source - Marketplace source (URL, path, or name)
 * @param customName - Optional custom name for the marketplace
 * @param branch - Optional branch for GitHub marketplaces
 * @param scopeOptions - Optional scope options (user or project)
 */
export async function addMarketplace(
  source: string,
  customName?: string,
  branch?: string,
  scopeOptions?: MarketplaceScopeOptions,
): Promise<MarketplaceResult> {
  const parsed = parseMarketplaceSource(source);

  if (!parsed) {
    return {
      success: false,
      error: `Invalid marketplace source: ${source}\n  Use: GitHub URL, owner/repo, or local path`,
    };
  }

  // Resolve branch: explicit --branch flag wins over URL-parsed branch
  const effectiveBranch = branch || parsed.branch;
  let name = customName || parsed.name;

  const isRemoteMarketplace = parsed.type === 'github' || parsed.type === 'git';
  const hasValidName = isRemoteMarketplace
    ? isValidManagedMarketplaceName(name)
    : isValidMarketplaceAlias(name);
  if (!hasValidName) {
    return {
      success: false,
      error: `Invalid marketplace name '${name}'. Use a single directory name without path separators or traversal segments.`,
    };
  }

  // Naming rules for non-default branches
  if (effectiveBranch) {
    if (!customName) {
      return {
        success: false,
        error: `--name is required when registering a non-default branch.\n  Example: allagents plugin marketplace add ${source} --name <custom-name>`,
      };
    }
    if (customName === parsed.name) {
      return {
        success: false,
        error: `Name '${customName}' is reserved for the default branch of ${parsed.location}.\n  Choose a different --name for branch '${effectiveBranch}'.`,
      };
    }
  }

  const registryPath =
    scopeOptions?.scope === 'project' && scopeOptions?.workspacePath
      ? getProjectRegistryPath(scopeOptions.workspacePath)
      : getRegistryPath();
  // Fail before cache work if the existing registry cannot be read. The
  // mutation transaction reloads the authoritative snapshot before saving.
  await loadRegistryFromPath(registryPath);

  // Check if already registered by source location (idempotent)
  // Use the full location including branch — each branch is a separate marketplace.
  // For branch-specific registrations, effectiveBranch overrides parsed.location.
  const sourceLocation = (() => {
    if (parsed.type === 'github') {
      const { owner, repo } = parseMarketplaceLocation(parsed.location);
      return effectiveBranch
        ? `${owner}/${repo}/${effectiveBranch}`
        : `${owner}/${repo}`;
    }
    return parsed.location;
  })();

  let marketplacePath: string;
  let stagedMarketplacePath: string | undefined;

  if (isRemoteMarketplace) {
    const managedMarketplacePath = getManagedMarketplacePath(
      name,
      registryPath,
    );
    if (managedMarketplacePath === null) {
      return {
        success: false,
        error: `Marketplace cache root is not a safe AllAgents-owned directory: ${getMarketplacesDir()}`,
      };
    }
    marketplacePath = managedMarketplacePath;
    if (isSymbolicLinkPath(marketplacePath)) {
      return {
        success: false,
        error: `Remote marketplace cache cannot be a symbolic link: ${marketplacePath}`,
      };
    }

    const cacheRoot = getMarketplaceCacheRoot(registryPath);
    stagedMarketplacePath = join(cacheRoot, `.add-${randomUUID()}`);
    await mkdir(cacheRoot, { recursive: true });
    const repoUrl =
      parsed.type === 'github'
        ? (() => {
            const { owner, repo } = parseMarketplaceLocation(parsed.location);
            return gitHubUrl(owner, repo);
          })()
        : parsed.location;

    try {
      await cloneTo(repoUrl, stagedMarketplacePath, effectiveBranch);
    } catch (error) {
      const cleanupWarning = await removePathWithWarning(
        stagedMarketplacePath,
        'incomplete marketplace clone',
      );
      return {
        success: false,
        error: getMarketplaceCloneError(parsed.location, error),
        ...(cleanupWarning && { warnings: [cleanupWarning] }),
      };
    }
  } else {
    // Local directories are user-owned. Verify them without moving or deleting.
    marketplacePath = parsed.location;
    if (isUnsafeLocalMarketplacePath(marketplacePath)) {
      return {
        success: false,
        error: `Local marketplace source must be a specific directory, not a filesystem root or the user's home directory: ${marketplacePath}`,
      };
    }
    if (!existsSync(marketplacePath)) {
      return {
        success: false,
        error: `Local directory not found: ${marketplacePath}`,
      };
    }
  }

  // Read the staged remote manifest before publication. A canonical manifest
  // name overrides the requested repository/directory name.
  if (!customName) {
    const manifestResult = await parseMarketplaceManifest(
      stagedMarketplacePath ?? marketplacePath,
    );
    if (manifestResult.success && manifestResult.data.name) {
      const manifestName = manifestResult.data.name;
      const hasValidManifestName = isRemoteMarketplace
        ? isValidManagedMarketplaceName(manifestName)
        : isValidMarketplaceAlias(manifestName);
      if (!hasValidManifestName) {
        const cleanupWarning = stagedMarketplacePath
          ? await removePathWithWarning(
              stagedMarketplacePath,
              'invalid staged marketplace',
            )
          : undefined;
        return {
          success: false,
          error: `Invalid marketplace name '${manifestName}' in marketplace manifest. Use a single directory name without path separators or traversal segments.`,
          ...(cleanupWarning && { warnings: [cleanupWarning] }),
        };
      }
      if (manifestName !== name) {
        name = manifestName;
      }
    }
  }

  if (isRemoteMarketplace) {
    const managedMarketplacePath = getManagedMarketplacePath(
      name,
      registryPath,
    );
    if (managedMarketplacePath === null) {
      const cleanupWarning = stagedMarketplacePath
        ? await removePathWithWarning(
            stagedMarketplacePath,
            'staged marketplace',
          )
        : undefined;
      return {
        success: false,
        error: `Marketplace cache root is not a safe AllAgents-owned directory: ${getMarketplacesDir()}`,
        ...(cleanupWarning && { warnings: [cleanupWarning] }),
      };
    }
    marketplacePath = managedMarketplacePath;
    if (isSymbolicLinkPath(marketplacePath)) {
      const cleanupWarning = stagedMarketplacePath
        ? await removePathWithWarning(
            stagedMarketplacePath,
            'staged marketplace',
          )
        : undefined;
      return {
        success: false,
        error: `Remote marketplace cache cannot be a symbolic link: ${marketplacePath}`,
        ...(cleanupWarning && { warnings: [cleanupWarning] }),
      };
    }
  }

  const entry: MarketplaceEntry = {
    name,
    source: {
      type: parsed.type,
      location: sourceLocation,
    },
    path: marketplacePath,
    lastUpdated: new Date().toISOString(),
  };
  const commitRegistration = () =>
    mutateRegistry(registryPath, (registry) => {
      const alreadyRegistered =
        !!findBySourceLocation(registry, sourceLocation) ||
        !!getRegistryMarketplace(registry, name);
      setRegistryMarketplace(registry, name, entry);
      return {
        changed: true,
        result: {
          success: true,
          marketplace: entry,
          ...(alreadyRegistered && { replaced: true }),
        },
      };
    });

  if (!stagedMarketplacePath) {
    return commitRegistration();
  }

  const stagingPath = stagedMarketplacePath;
  try {
    return await withMarketplaceCacheLock(marketplacePath, () =>
      replaceManagedMarketplaceCache(
        name,
        marketplacePath,
        stagingPath,
        commitRegistration,
      ),
    );
  } catch (error) {
    if (error instanceof MarketplaceCachePublicationError) {
      return {
        success: false,
        error: `Failed to publish marketplace cache for '${name}': ${error.message}`,
      };
    }
    throw error;
  } finally {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => {});
  }
}

interface MarketplaceRemoval {
  entry?: MarketplaceEntry;
  retry: boolean;
  warning?: string;
}

interface MarketplaceRemovalDeps {
  beforeCacheLock(marketplacePath: string): void;
}

async function removeMarketplaceRegistration(
  registryPath: string,
  name: string,
  beforeCacheLock?: (marketplacePath: string) => void,
): Promise<MarketplaceRemoval> {
  while (true) {
    const registry = await loadRegistryFromPath(registryPath);
    const observedEntry = getRegistryMarketplace(registry, name);
    if (!observedEntry) {
      return { retry: false };
    }

    const managedPath = hasManagedRemotePath(observedEntry, registryPath, name)
      ? resolve(observedEntry.path)
      : null;
    if (managedPath === null) {
      const removal = await mutateRegistry<MarketplaceRemoval>(
        registryPath,
        (latestRegistry) => {
          const latestEntry = getRegistryMarketplace(latestRegistry, name);
          if (!latestEntry) {
            return { changed: false, result: { retry: false } };
          }
          if (!hasSameMarketplaceIdentity(latestEntry, observedEntry)) {
            return { changed: false, result: { retry: true } };
          }
          deleteRegistryMarketplace(latestRegistry, name);
          return {
            changed: true,
            result: {
              entry: latestEntry,
              retry: false,
              ...(latestEntry.source.type !== 'local' && {
                warning: `Refused to delete unmanaged marketplace path: ${latestEntry.path}`,
              }),
            },
          };
        },
      );
      if (removal.retry) continue;
      return removal;
    }

    beforeCacheLock?.(managedPath);
    const removal = await withMarketplaceCacheLock(managedPath, async () => {
      const result = await mutateRegistry<MarketplaceRemoval>(
        registryPath,
        (latestRegistry) => {
          const latestEntry = getRegistryMarketplace(latestRegistry, name);
          if (!latestEntry) {
            return { changed: false, result: { retry: false } };
          }
          if (
            hasManagedRemotePath(latestEntry, registryPath, name) &&
            resolve(latestEntry.path) !== managedPath
          ) {
            return { changed: false, result: { retry: true } };
          }
          deleteRegistryMarketplace(latestRegistry, name);
          return {
            changed: true,
            result: {
              entry: latestEntry,
              retry: false,
              ...(latestEntry.source.type !== 'local' &&
                !hasOwnedManagedRemotePath(latestEntry, registryPath, name) && {
                  warning: `Preserved legacy marketplace cache shared with another registry scope: ${latestEntry.path}`,
                }),
            },
          };
        },
      );
      if (
        result.entry &&
        result.entry.source.type !== 'local' &&
        hasOwnedManagedRemotePath(result.entry, registryPath, name) &&
        resolve(result.entry.path) === managedPath &&
        pathEntryExists(managedPath)
      ) {
        await rm(managedPath, { recursive: true, force: true });
      }
      return result;
    });
    if (removal.retry) continue;
    return removal;
  }
}

/**
 * Remove a marketplace from the registry and delete its files.
 *
 * By default, user-level plugins referencing the marketplace are **retained**
 * (listed in `retainedUserPlugins`). Pass `{ cascade: true }` to remove them
 * (listed in `removedUserPlugins`).
 *
 * @param name - Marketplace name to remove
 * @param options.cascade - Remove user-level plugins referencing this marketplace
 * @param options.scope - Scope to remove from: 'user', 'project', or 'all' (default)
 * @param options.workspacePath - Project path (required for project/all scope)
 * @param options.userRegistryPath - Override user registry path (for testing)
 */
export async function removeMarketplace(
  name: string,
  options: {
    cascade?: boolean;
    scope?: MarketplaceScope | 'all';
    workspacePath?: string;
    userRegistryPath?: string;
  } = {},
  deps: Partial<MarketplaceRemovalDeps> = {},
): Promise<MarketplaceResult> {
  const scope = options.scope ?? 'all';

  // Guard: project scope requires workspacePath
  if (
    (scope === 'project' || scope === 'all') &&
    !options.workspacePath &&
    !options.userRegistryPath
  ) {
    if (scope === 'project') {
      return {
        success: false,
        error: 'workspacePath is required when scope is "project"',
      };
    }
    // scope === 'all' without workspacePath: fall back to user-only removal
  }

  const userRegPath = options.userRegistryPath ?? getRegistryPath();
  let removedEntry: MarketplaceEntry | undefined;
  const warnings: string[] = [];

  // Remove from user scope
  if (scope === 'user' || scope === 'all') {
    const removal = await removeMarketplaceRegistration(
      userRegPath,
      name,
      deps.beforeCacheLock,
    );
    if (removal.entry) {
      removedEntry = removal.entry;
    }
    if (removal.warning) {
      warnings.push(removal.warning);
    }
  }

  // Remove from project scope
  if ((scope === 'project' || scope === 'all') && options.workspacePath) {
    const projectRegPath = getProjectRegistryPath(options.workspacePath);
    const removal = await removeMarketplaceRegistration(
      projectRegPath,
      name,
      deps.beforeCacheLock,
    );
    if (removal.entry) {
      removedEntry = removal.entry;
    }
    if (removal.warning) {
      warnings.push(removal.warning);
    }
  }

  if (!removedEntry) {
    return {
      success: false,
      error: `Marketplace '${name}' not found in registry`,
    };
  }

  if (options.cascade) {
    // Cascade: remove user-level plugins referencing this marketplace
    const { removeUserPluginsForMarketplace } = await import(
      './user-workspace.js'
    );
    const removedUserPlugins = await removeUserPluginsForMarketplace(name);

    return {
      success: true,
      marketplace: removedEntry,
      removedUserPlugins,
      ...(warnings.length > 0 && { warnings }),
    };
  }

  // No cascade (default): report which plugins still reference this marketplace
  const { getUserPluginsForMarketplace } = await import('./user-workspace.js');
  const retainedUserPlugins = await getUserPluginsForMarketplace(name);

  return {
    success: true,
    marketplace: removedEntry,
    retainedUserPlugins,
    ...(warnings.length > 0 && { warnings }),
  };
}

/**
 * List all registered marketplaces
 */
export async function listMarketplaces(): Promise<MarketplaceEntry[]> {
  const registry = await loadRegistry();
  return Object.values(registry.marketplaces).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

/**
 * Get a marketplace by name
 */
export async function getMarketplace(
  name: string,
  workspacePath?: string,
): Promise<MarketplaceEntry | null> {
  return (
    (await findMarketplaceRegistration(name, undefined, workspacePath))
      ?.entry ?? null
  );
}

async function loadMarketplaceRegistrations(
  workspacePath?: string,
): Promise<Map<string, MarketplaceRegistration>> {
  const userRegistryPath = getRegistryPath();
  const userRegistry = await loadRegistryFromPath(userRegistryPath);
  const registrations = new Map<string, MarketplaceRegistration>();
  for (const [key, entry] of Object.entries(userRegistry.marketplaces)) {
    registrations.set(key, {
      key,
      entry,
      scope: 'user',
      registryPath: userRegistryPath,
    });
  }

  if (!workspacePath) return registrations;
  const projectRegistryPath = getProjectRegistryPath(workspacePath);
  if (resolve(projectRegistryPath) === resolve(userRegistryPath)) {
    return registrations;
  }
  const projectRegistry = await loadRegistryFromPath(projectRegistryPath);
  for (const [key, entry] of Object.entries(projectRegistry.marketplaces)) {
    registrations.set(key, {
      key,
      entry,
      scope: 'project',
      registryPath: projectRegistryPath,
    });
  }
  return registrations;
}

export async function findMarketplaceRegistration(
  name: string,
  sourceLocation?: string,
  workspacePath?: string,
): Promise<MarketplaceRegistration | null> {
  const registrations = await loadMarketplaceRegistrations(workspacePath);
  const exact = registrations.get(name);
  if (exact) return exact;
  if (!sourceLocation) return null;
  return (
    Array.from(registrations.values()).find(
      ({ entry }) => getSourceLocationKey(entry.source) === sourceLocation,
    ) ?? null
  );
}

/**
 * Find a marketplace by name, falling back to source location lookup.
 * Single registry load for both checks.
 */
export async function findMarketplace(
  name: string,
  sourceLocation?: string,
  workspacePath?: string,
): Promise<MarketplaceEntry | null> {
  return (
    (await findMarketplaceRegistration(name, sourceLocation, workspacePath))
      ?.entry ?? null
  );
}
interface MarketplaceUpdateGitClient {
  raw(args: string[]): Promise<string>;
  checkout(branch: string): Promise<unknown>;
}

interface MarketplaceUpdateDeps {
  createGit(path: string): MarketplaceUpdateGitClient;
  pull(path: string): Promise<void>;
  now(): Date;
  resolveRemoteRevision(
    source: string,
    requestedRef?: string,
  ): Promise<RemoteRevisionResult>;
  checkRepositoryHealth(
    repoPath: string,
    expected: { source: string; ref?: string; head: string },
  ): Promise<RepositoryHealthResult>;
}

interface MarketplaceApplyFact {
  preCommit?: string;
  postCommit?: string;
  changed: boolean;
}

/**
 * Update marketplace(s) by pulling latest changes
 * @param name - Optional marketplace name (updates all if not specified)
 */
export async function updateMarketplace(
  name?: string,
  workspacePath?: string,
  deps: Partial<MarketplaceUpdateDeps> = {},
  context?: UpdateContext,
): Promise<UpdateResult[]> {
  const userRegistry = await loadRegistry();
  let projectRegistry: MarketplaceRegistry | undefined;

  if (workspacePath) {
    const projectPath = getProjectRegistryPath(workspacePath);
    if (existsSync(projectPath)) {
      projectRegistry = await loadRegistryFromPath(projectPath);
    }
  }

  // Merge for lookup, tracking which scope each entry came from
  const userRegistryPath = getRegistryPath();
  const projectRegistryPath = workspacePath
    ? getProjectRegistryPath(workspacePath)
    : undefined;
  const mergedEntries = new Map<string, MarketplaceRegistration>();
  for (const [key, entry] of Object.entries(userRegistry.marketplaces)) {
    mergedEntries.set(key, {
      key,
      entry,
      scope: 'user',
      registryPath: userRegistryPath,
    });
  }
  if (projectRegistry) {
    for (const [key, entry] of Object.entries(projectRegistry.marketplaces)) {
      mergedEntries.set(key, {
        key,
        entry,
        scope: 'project',
        registryPath: projectRegistryPath as string,
      });
    }
  }

  const toUpdateScoped = name
    ? (() => {
        const entry = mergedEntries.get(name);
        return entry ? [entry] : [];
      })()
    : Array.from(mergedEntries.values());

  const results: UpdateResult[] = [];

  if (name && toUpdateScoped.length === 0) {
    return [
      {
        name,
        success: false,
        error: `Marketplace '${name}' not found`,
        ...(context && { changed: false }),
      },
    ];
  }

  for (const registration of toUpdateScoped) {
    const { entry: marketplace } = registration;
    const accessError = getMarketplaceAccessError(
      marketplace,
      registration.registryPath,
      registration.key,
    );
    if (accessError) {
      const removal = await removeInvalidMarketplaceRegistration(registration);
      results.push({
        name: marketplace.name,
        success: false,
        error:
          removal.error ?? 'Unsafe marketplace registration was not updated.',
        ...(context && { changed: false }),
      });
      continue;
    }

    if (marketplace.source.type === 'local') {
      // Local marketplaces don't need updating
      results.push({
        name: marketplace.name,
        success: true,
        ...(context && { changed: false }),
      });
      continue;
    }

    const ownedMarketplacePath = getManagedMarketplacePath(
      registration.key,
      registration.registryPath,
    );

    if (
      resolve(registration.registryPath) !== resolve(getRegistryPath()) &&
      ownedMarketplacePath !== null &&
      resolve(marketplace.path) !== ownedMarketplacePath
    ) {
      const migration = await refreshMarketplace(registration);
      results.push({
        name: marketplace.name,
        success: migration.success,
        ...(migration.error && { error: migration.error }),
        ...(context && { changed: migration.success }),
      });
      continue;
    }

    const result: UpdateResult = await withMarketplaceCacheLock(
      marketplace.path,
      async () => {
        const currentRegistry = await loadRegistryFromPath(
          registration.registryPath,
        );
        const currentEntry = getRegistryMarketplace(
          currentRegistry,
          registration.key,
        );
        if (
          !currentEntry ||
          !hasSameMarketplaceIdentity(currentEntry, registration.entry)
        ) {
          return {
            name: marketplace.name,
            success: false,
            error: `Marketplace '${registration.key}' changed during update. The registry was not overwritten; retry the command.`,
            ...(context && { changed: false }),
          };
        }

        if (!existsSync(marketplace.path)) {
          return {
            name: marketplace.name,
            success: false,
            error: `Marketplace directory not found: ${marketplace.path}`,
            ...(context && { changed: false }),
          };
        }

        try {
          // Check if location includes a branch (only for github type; git type has no branch in location)
          const parsedLocation =
            marketplace.source.type === 'github'
              ? parseMarketplaceLocation(marketplace.source.location)
              : undefined;
          const storedBranch = parsedLocation?.branch;
          const remoteSource = parsedLocation
            ? gitHubUrl(parsedLocation.owner, parsedLocation.repo)
            : marketplace.source.location;

          let remote: RemoteRevisionResult | undefined;
          if (context) {
            try {
              const resolveRevision =
                deps.resolveRemoteRevision ?? resolveRemoteRevision;
              remote = await context.getRemote(
                remoteSource,
                storedBranch,
                () => resolveRevision(remoteSource, storedBranch),
              );
            } catch {
              remote = { status: 'unresolved', reason: 'failed' };
            }
          }

          const expectedRef =
            remote?.status === 'resolved' ? remote.ref : storedBranch;
          const identity = {
            path: marketplace.path,
            source: remoteSource,
            ...(expectedRef !== undefined && { ref: expectedRef }),
          };
          let applyFact: MarketplaceApplyFact | undefined;

          if (context && remote?.status === 'resolved') {
            let health: RepositoryHealthResult;
            try {
              const checkHealth =
                deps.checkRepositoryHealth ?? checkRepositoryHealth;
              health = await context.getHealth(identity, () =>
                checkHealth(marketplace.path, {
                  source: remoteSource,
                  ref: remote.ref,
                  head: remote.commit,
                }),
              );
            } catch (error) {
              health = {
                status: 'unhealthy',
                reason: 'inspection-failed',
                error:
                  error instanceof Error ? error : new Error(String(error)),
              };
            }
            if (health.status === 'healthy') {
              applyFact = {
                preCommit: remote.commit,
                postCommit: remote.commit,
                changed: false,
              };
            }
          }

          const applyUpdate = async (): Promise<MarketplaceApplyFact> => {
            const git = (deps.createGit ?? createGit)(marketplace.path);
            let preCommit: string | undefined;
            if (context) {
              try {
                const value = (await git.raw(['rev-parse', 'HEAD'])).trim();
                preCommit = value || undefined;
              } catch {
                preCommit = undefined;
              }
            }

            let targetBranch: string;
            if (storedBranch) {
              // Branch-specific marketplace: use stored branch directly
              targetBranch = storedBranch;
            } else {
              // Default branch marketplace: detect default branch
              targetBranch = 'main';
              try {
                const ref = await git.raw([
                  'symbolic-ref',
                  'refs/remotes/origin/HEAD',
                  '--short',
                ]);
                targetBranch = normalizeGitRef(ref) ?? ref.trim();
              } catch {
                try {
                  const showOutput = await git.raw([
                    'remote',
                    'show',
                    'origin',
                  ]);
                  const match = showOutput.match(/HEAD branch:\s*(\S+)/);
                  if (match?.[1]) {
                    targetBranch = match[1];
                  }
                } catch {
                  // Network unavailable; fall back to 'main'
                }
              }
            }

            await git.checkout(targetBranch);
            await (deps.pull ?? pull)(marketplace.path);

            let postCommit: string | undefined;
            if (context) {
              try {
                const value = (await git.raw(['rev-parse', 'HEAD'])).trim();
                postCommit = value || undefined;
              } catch {
                postCommit = undefined;
              }
            }
            return {
              ...(preCommit !== undefined && { preCommit }),
              ...(postCommit !== undefined && { postCommit }),
              changed: context
                ? !preCommit ||
                  !postCommit ||
                  preCommit.toLowerCase() !== postCommit.toLowerCase()
                : false,
            };
          };

          if (!applyFact) {
            applyFact = context
              ? await context.getApply(identity, applyUpdate)
              : await applyUpdate();
          }

          const lastUpdated = deps.now
            ? deps.now().toISOString()
            : new Date().toISOString();
          return mutateRegistry<UpdateResult>(
            registration.registryPath,
            (latestRegistry) => {
              const latestEntry = getRegistryMarketplace(
                latestRegistry,
                registration.key,
              );
              if (
                !latestEntry ||
                !hasSameMarketplaceIdentity(latestEntry, registration.entry)
              ) {
                return {
                  changed: false,
                  result: {
                    name: marketplace.name,
                    success: false,
                    error: `Marketplace '${registration.key}' changed during update. The registry was not overwritten; retry the command.`,
                    ...(context && { changed: false }),
                  },
                };
              }
              if (latestEntry.lastUpdated !== registration.entry.lastUpdated) {
                return {
                  changed: false,
                  result: {
                    name: marketplace.name,
                    success: true,
                    ...(context && { changed: applyFact.changed }),
                  },
                };
              }
              latestEntry.lastUpdated = lastUpdated;
              return {
                changed: true,
                result: {
                  name: marketplace.name,
                  success: true,
                  ...(context && { changed: applyFact.changed }),
                },
              };
            },
          );
        } catch (error) {
          return {
            name: marketplace.name,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            ...(context && { changed: false }),
          };
        }
      },
    );
    results.push(result);
  }

  return results;
}

/**
 * Get the path to a marketplace
 */
export async function getMarketplacePath(name: string): Promise<string | null> {
  const marketplace = await getMarketplace(name);
  if (!marketplace || getMarketplaceAccessError(marketplace)) return null;
  return marketplace.path;
}

/**
 * Plugin info returned from marketplace discovery
 */
export interface MarketplacePluginInfo {
  name: string;
  path: string;
  description?: string;
  category?: string;
  homepage?: string;
  source?: string;
  skills?: string[];
}

function normalizeComponentPaths(
  paths: string | string[] | undefined,
): string[] | undefined {
  if (paths === undefined) return undefined;
  return Array.isArray(paths) ? paths : [paths];
}

/**
 * Result of listing marketplace plugins, including any warnings
 * from lenient manifest parsing.
 */
export interface MarketplacePluginsResult {
  plugins: MarketplacePluginInfo[];
  warnings: string[];
}

/**
 * Get plugins from a marketplace directory using its manifest.
 * Returns an empty array if no manifest is found.
 * Includes warnings from lenient parsing when applicable.
 */
export async function getMarketplacePluginsFromManifest(
  marketplacePath: string,
): Promise<MarketplacePluginsResult> {
  const result = await parseMarketplaceManifest(marketplacePath);
  if (!result.success) {
    return { plugins: [], warnings: [] };
  }

  const plugins = result.data.plugins.map((plugin) => {
    const resolvedSource = resolvePluginSourcePath(
      plugin.source,
      marketplacePath,
    );
    const info: MarketplacePluginInfo = {
      name: plugin.name,
      path:
        typeof plugin.source === 'string'
          ? resolve(marketplacePath, plugin.source)
          : resolvedSource,
      description: plugin.description,
      source: resolvedSource,
    };
    if (plugin.category) info.category = plugin.category;
    if (plugin.homepage) info.homepage = plugin.homepage;
    const skills = normalizeComponentPaths(plugin.skills);
    if (skills) info.skills = skills;
    return info;
  });

  return { plugins, warnings: result.warnings };
}

/**
 * List plugins available in a marketplace.
 * Prefers .claude-plugin/marketplace.json when available,
 * falls back to scanning the plugins/ directory.
 */
export async function listMarketplacePlugins(
  name: string,
  workspacePath?: string,
): Promise<MarketplacePluginsResult> {
  const registration = await findMarketplaceRegistration(
    name,
    undefined,
    workspacePath,
  );
  if (!registration) {
    return { plugins: [], warnings: [] };
  }
  const marketplace = registration.entry;

  const accessError = getMarketplaceAccessError(
    marketplace,
    registration.registryPath,
    registration.key,
  );
  if (accessError) {
    return { plugins: [], warnings: [accessError] };
  }

  // Try manifest first
  const manifestResult = await getMarketplacePluginsFromManifest(
    marketplace.path,
  );
  if (manifestResult.plugins.length > 0) {
    return manifestResult;
  }

  // Fall back to directory scanning
  const pluginsDir = join(marketplace.path, 'plugins');
  if (!existsSync(pluginsDir)) {
    return { plugins: [], warnings: manifestResult.warnings };
  }

  try {
    const entries = await readdir(pluginsDir, { withFileTypes: true });
    const plugins = entries
      .filter((e) => e.isDirectory())
      .map((e) => ({
        name: e.name,
        path: join(pluginsDir, e.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { plugins, warnings: manifestResult.warnings };
  } catch {
    return { plugins: [], warnings: manifestResult.warnings };
  }
}

/**
 * Parse a plugin@marketplace spec into components
 * Supports:
 * - plugin@marketplace-name
 * - plugin@owner/repo
 * - plugin@owner/repo/subpath
 *
 * @param spec - Plugin spec string
 * @returns Parsed components or null if invalid
 */
export function parsePluginSpec(spec: string): {
  plugin: string;
  marketplaceName: string;
  owner?: string;
  repo?: string;
  subpath?: string;
} | null {
  const atIndex = spec.lastIndexOf('@');
  if (atIndex === -1 || atIndex === 0 || atIndex === spec.length - 1) {
    return null;
  }

  const plugin = spec.slice(0, atIndex);
  const marketplacePart = spec.slice(atIndex + 1);

  if (!plugin || !marketplacePart) {
    return null;
  }

  // Check if it's owner/repo or owner/repo/subpath format
  if (marketplacePart.includes('/') && !marketplacePart.includes('://')) {
    const parts = marketplacePart.split('/');
    if (parts.length >= 2 && parts[0] && parts[1]) {
      const owner = parts[0];
      const repo = parts[1];
      const subpath = parts.length > 2 ? parts.slice(2).join('/') : undefined;

      return {
        plugin,
        marketplaceName: repo, // Marketplace is registered by repo name
        owner,
        repo,
        ...(subpath && { subpath }),
      };
    }
  }

  // Simple marketplace name (e.g., "claude-plugins-official")
  return {
    plugin,
    marketplaceName: marketplacePart,
  };
}

/**
 * Resolve a plugin@marketplace spec to a local path
 * Supports:
 * - plugin@marketplace-name (looks in plugins/ subdir)
 * - plugin@owner/repo (looks in plugins/ subdir)
 * - plugin@owner/repo/subpath (looks in subpath/ subdir)
 *
 * Resolution order:
 * 1. If marketplace has a manifest, look up plugin by name in manifest entries
 * 2. Fall back to directory-based lookup: <marketplace>/<subpath>/<plugin-name>/
 *
 * @param spec - Plugin spec (e.g., "code-review@claude-plugins-official")
 * @param options - Resolution options
 * @returns Local path to plugin directory, or null if not found
 */
export async function resolvePluginSpec(
  spec: string,
  options: {
    subpath?: string;
    marketplaceNameOverride?: string;
    /** Trusted explicit path that bypasses registry lookup (primarily for isolated resolution). */
    marketplacePathOverride?: string;
    offline?: boolean;
    fetchFn?: (url: string) => Promise<FetchResult>;
    workspacePath?: string;
  } = {},
): Promise<{
  path: string;
  marketplace: string;
  plugin: string;
  fileArtifacts?: MarketplaceFileArtifacts;
} | null> {
  const parsed = parsePluginSpec(spec);
  if (!parsed) {
    return null;
  }

  // Use override name if provided (e.g., when manifest changed the marketplace name)
  const marketplaceName =
    options.marketplaceNameOverride ?? parsed.marketplaceName;

  // Determine marketplace path: use override or look up from registry
  let marketplacePath: string | null = options.marketplacePathOverride ?? null;
  if (!marketplacePath) {
    const registration = await findMarketplaceRegistration(
      marketplaceName,
      undefined,
      options.workspacePath,
    );
    if (!registration) {
      return null;
    }
    const marketplace = registration.entry;
    if (
      getMarketplaceAccessError(
        marketplace,
        registration.registryPath,
        registration.key,
      )
    ) {
      return null;
    }
    marketplacePath = marketplace.path;
  }

  // Try manifest-based resolution first: look up plugin name in manifest entries
  const manifestResult = await parseMarketplaceManifest(marketplacePath);
  if (manifestResult.success) {
    const pluginEntry = manifestResult.data.plugins.find(
      (p) => p.name === parsed.plugin,
    );
    if (pluginEntry) {
      const declaredFileArtifacts = getMarketplaceFileArtifacts(pluginEntry);
      if (typeof pluginEntry.source === 'string') {
        // Local path source - resolve relative to marketplace
        const resolvedPath = resolve(marketplacePath, pluginEntry.source);
        if (existsSync(resolvedPath)) {
          return {
            path: resolvedPath,
            marketplace: marketplaceName,
            plugin: parsed.plugin,
            ...(declaredFileArtifacts && {
              fileArtifacts: declaredFileArtifacts,
            }),
          };
        }
      } else {
        if (options.offline) {
          // Offline mode: check if plugin is already cached, don't fetch
          const parsedUrl = parseGitHubUrl(pluginEntry.source.url);
          if (parsedUrl) {
            const cachePath = getPluginCachePath(
              parsedUrl.owner,
              parsedUrl.repo,
            );
            if (existsSync(cachePath)) {
              const fileArtifacts =
                declaredFileArtifacts ??
                (await getEmbeddedMarketplaceFileArtifacts(
                  cachePath,
                  parsed.plugin,
                ));
              return {
                path: cachePath,
                marketplace: marketplaceName,
                plugin: parsed.plugin,
                ...(fileArtifacts && { fileArtifacts }),
              };
            }
          }
          return null;
        }
        // URL source - fetch/clone the plugin
        const fetchFn = options.fetchFn ?? fetchPlugin;
        const fetchResult = await fetchFn(pluginEntry.source.url);
        if (fetchResult.success && fetchResult.cachePath) {
          const fileArtifacts =
            declaredFileArtifacts ??
            (await getEmbeddedMarketplaceFileArtifacts(
              fetchResult.cachePath,
              parsed.plugin,
            ));
          return {
            path: fetchResult.cachePath,
            marketplace: marketplaceName,
            plugin: parsed.plugin,
            ...(fileArtifacts && { fileArtifacts }),
          };
        }
      }
    }
  }

  // Fall back to directory-based lookup
  const subpath = options.subpath ?? parsed.subpath ?? 'plugins';
  const pluginPath = join(marketplacePath, subpath, parsed.plugin);

  if (!existsSync(pluginPath)) {
    return null;
  }

  return {
    path: pluginPath,
    marketplace: marketplaceName,
    plugin: parsed.plugin,
  };
}

/**
 * Result of resolving a plugin spec with auto-registration
 */
export interface ResolvePluginSpecResult {
  success: boolean;
  path?: string;
  pluginName?: string;
  registeredAs?: string;
  /** GitHub marketplace source (owner/repo) for native CLI registration */
  marketplaceSource?: string;
  /** File artifacts declared by a non-strict marketplace entry. */
  fileArtifacts?: MarketplaceFileArtifacts;
  error?: string;
}

interface InvalidMarketplaceRemovalResult extends MarketplaceResult {
  removed: boolean;
}

async function removeInvalidMarketplaceRegistration(
  registration: MarketplaceRegistration,
): Promise<InvalidMarketplaceRemovalResult> {
  return mutateRegistry<InvalidMarketplaceRemovalResult>(
    registration.registryPath,
    (registry) => {
      const currentEntry = getRegistryMarketplace(registry, registration.key);
      if (
        !currentEntry ||
        !hasSameMarketplaceIdentity(currentEntry, registration.entry)
      ) {
        return {
          changed: false,
          result: {
            success: false,
            removed: false,
            error: `Marketplace registration '${registration.key}' changed before unsafe cleanup. The registry was not overwritten and no filesystem path was removed; retry the command.`,
          },
        };
      }
      deleteRegistryMarketplace(registry, registration.key);
      return {
        changed: true,
        result: {
          success: false,
          removed: true,
          error: getInvalidMarketplaceRegistrationError(
            registration.key,
            registration.entry,
          ),
        },
      };
    },
  );
}

function hasSameMarketplaceIdentity(
  current: MarketplaceEntry,
  expected: MarketplaceEntry,
): boolean {
  return (
    current.name === expected.name &&
    current.path === expected.path &&
    current.source.type === expected.source.type &&
    current.source.location === expected.source.location
  );
}

function getInvalidMarketplaceRegistrationError(
  registrationKey: string,
  marketplace: MarketplaceEntry,
): string {
  return `Removed invalid marketplace registration '${registrationKey}'. Refused to access or delete unmanaged path: ${marketplace.path}. Re-add the marketplace to restore it safely.`;
}

/**
 * Refresh a remote marketplace through a staged clone. Valid registrations and
 * cached files survive clone failures; unsafe legacy registrations are removed
 * without touching their untrusted paths.
 */
async function refreshMarketplace(
  registration: MarketplaceRegistration,
): Promise<MarketplaceResult> {
  const marketplace = registration.entry;
  if (marketplace.source.type === 'local') {
    return { success: true, marketplace };
  }

  if (
    !hasManagedRemotePath(
      marketplace,
      registration.registryPath,
      registration.key,
    )
  ) {
    return removeInvalidMarketplaceRegistration(registration);
  }
  const managedPath = getManagedMarketplacePath(
    registration.key,
    registration.registryPath,
  );
  if (managedPath === null) {
    return removeInvalidMarketplaceRegistration(registration);
  }

  let cloneUrl: string;
  let branch: string | undefined;
  if (marketplace.source.type === 'github') {
    const parsed = parseMarketplaceLocation(marketplace.source.location);
    cloneUrl = gitHubUrl(parsed.owner, parsed.repo);
    branch = parsed.branch;
  } else {
    cloneUrl = marketplace.source.location;
  }

  const cacheRoot = dirname(managedPath);
  const refreshId = randomUUID();
  const stagingPath = join(cacheRoot, `.refresh-${refreshId}`);
  await mkdir(cacheRoot, { recursive: true });

  try {
    await cloneTo(cloneUrl, stagingPath, branch);
  } catch (error) {
    const cleanupWarning = await removePathWithWarning(
      stagingPath,
      'incomplete marketplace refresh',
    );
    return {
      success: false,
      error: `Failed to refresh marketplace '${marketplace.name}': ${getMarketplaceCloneError(marketplace.source.location, error)}\n  The existing registration and any cached files were preserved.`,
      ...(cleanupWarning && { warnings: [cleanupWarning] }),
    };
  }

  return withMarketplaceCacheLock(managedPath, async () => {
    try {
      const currentRegistry = await loadRegistryFromPath(
        registration.registryPath,
      );
      const currentEntry = getRegistryMarketplace(
        currentRegistry,
        registration.key,
      );
      if (
        !currentEntry ||
        !hasSameMarketplaceIdentity(currentEntry, marketplace)
      ) {
        return {
          success: false,
          error: `Marketplace registration '${registration.key}' changed during refresh. The registry was not overwritten; retry the command.`,
        };
      }

      const refreshedMarketplace: MarketplaceEntry = {
        ...marketplace,
        path: managedPath,
        lastUpdated: new Date().toISOString(),
      };
      return await replaceManagedMarketplaceCache(
        marketplace.name,
        managedPath,
        stagingPath,
        () =>
          mutateRegistry<MarketplaceResult>(
            registration.registryPath,
            (registry) => {
              const latestEntry = getRegistryMarketplace(
                registry,
                registration.key,
              );
              if (
                !latestEntry ||
                !hasSameMarketplaceIdentity(latestEntry, marketplace)
              ) {
                throw new Error(
                  `Marketplace registration '${registration.key}' changed during refresh. The registry was not overwritten; retry the command.`,
                );
              }
              setRegistryMarketplace(
                registry,
                registration.key,
                refreshedMarketplace,
              );
              return {
                changed: true,
                result: {
                  success: true,
                  marketplace: refreshedMarketplace,
                  replaced: true,
                },
              };
            },
          ),
      );
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      await rm(stagingPath, { recursive: true, force: true }).catch(() => {});
    }
  });
}

/**
 * Resolve a plugin@marketplace spec with auto-registration support
 *
 * Auto-registration rules:
 * 1. plugin@owner/repo format → auto-register owner/repo as marketplace
 * 2. plugin@owner/repo/subpath → auto-register owner/repo, look in subpath/
 * 3. Unknown short name → error with helpful message
 */
export async function resolvePluginSpecWithAutoRegister(
  spec: string,
  options: { offline?: boolean; workspacePath?: string } = {},
): Promise<ResolvePluginSpecResult> {
  // Parse plugin@marketplace using the parser
  const parsed = parsePluginSpec(spec);

  if (!parsed) {
    return {
      success: false,
      error: `Invalid plugin spec format: ${spec}\n  Expected: plugin@marketplace or plugin@owner/repo[/subpath]`,
    };
  }

  const { plugin: pluginName, marketplaceName, owner, repo, subpath } = parsed;

  // Check if the marketplace is already registered by its declared name or by
  // the canonical source identity shared with marketplace registration.
  const parsedMarketplaceSource = parseMarketplaceSource(marketplaceName);
  const sourceLocation =
    owner && repo
      ? `${owner}/${repo}`
      : parsedMarketplaceSource?.type === 'github'
        ? parsedMarketplaceSource.location
        : undefined;
  let registration = await findMarketplaceRegistration(
    marketplaceName,
    sourceLocation,
    options.workspacePath,
  );
  let didAutoRegister = false;

  // If not registered, try auto-registration
  if (!registration) {
    const sourceToRegister =
      owner && repo ? `${owner}/${repo}` : marketplaceName;
    const autoRegResult = await autoRegisterMarketplace(sourceToRegister);
    if (!autoRegResult.success) {
      return {
        success: false,
        error: autoRegResult.error || 'Unknown error',
      };
    }
    registration = await findMarketplaceRegistration(
      autoRegResult.name ?? marketplaceName,
      undefined,
      options.workspacePath,
    );
    didAutoRegister = true;
  }

  if (!registration) {
    return {
      success: false,
      error: `Marketplace '${marketplaceName}' not found`,
    };
  }

  let marketplace = registration.entry;
  const accessError = getMarketplaceAccessError(
    marketplace,
    registration.registryPath,
    registration.key,
  );
  if (accessError) {
    const invalidResult =
      await removeInvalidMarketplaceRegistration(registration);
    return {
      success: false,
      error: `Plugin '${pluginName}' could not be resolved from marketplace '${marketplaceName}'.\n  ${invalidResult.error}`,
    };
  }
  const updateCacheKey = `${registration.registryPath}:${registration.key}`;

  // Pull latest marketplace if online, not freshly cloned, and not yet updated this session
  if (
    !didAutoRegister &&
    !options.offline &&
    marketplace.source.type !== 'local' &&
    !updatedMarketplaceCache.has(updateCacheKey)
  ) {
    const results = await updateMarketplace(
      registration.key,
      options.workspacePath,
    );
    const result = results[0];
    if (result?.success) {
      updatedMarketplaceCache.add(updateCacheKey);
      const refreshedRegistry = await loadRegistryFromPath(
        registration.registryPath,
      );
      const refreshedEntry = getRegistryMarketplace(
        refreshedRegistry,
        registration.key,
      );
      if (refreshedEntry) {
        registration = { ...registration, entry: refreshedEntry };
        marketplace = refreshedEntry;
      }
    }
  }
  // Mark freshly cloned marketplaces as updated so subsequent calls skip the pull
  if (didAutoRegister) {
    updatedMarketplaceCache.add(updateCacheKey);
  }

  // Determine the expected subpath for error messages
  const expectedSubpath = subpath ?? 'plugins';

  // Now resolve the plugin within the marketplace
  // Pass the actual marketplace name (may differ from spec if manifest overrode it)
  const resolveOpts = {
    ...(subpath && { subpath }),
    marketplaceNameOverride: marketplace.name,
    marketplacePathOverride: marketplace.path,
    ...(options.offline != null && { offline: options.offline }),
    ...(options.workspacePath && { workspacePath: options.workspacePath }),
  };

  let resolved = await resolvePluginSpec(spec, resolveOpts);

  // If not found and online, refresh the marketplace (re-clone) and retry
  if (!resolved && !options.offline && marketplace.source.type !== 'local') {
    console.log(
      `Plugin '${pluginName}' not found in cached marketplace '${marketplace.name}', refreshing...`,
    );
    const refreshResult = await refreshMarketplace(registration);
    if (!refreshResult.success) {
      return {
        success: false,
        error: `Plugin '${pluginName}' could not be resolved from marketplace '${marketplaceName}'.\n  ${refreshResult.error ?? 'Marketplace refresh failed.'}`,
      };
    }
    if (refreshResult.marketplace) {
      marketplace = refreshResult.marketplace;
      registration = { ...registration, entry: marketplace };
      resolved = await resolvePluginSpec(spec, {
        ...(subpath && { subpath }),
        marketplaceNameOverride: marketplace.name,
        marketplacePathOverride: marketplace.path,
        ...(options.workspacePath && { workspacePath: options.workspacePath }),
      });
    }
  }

  if (!resolved) {
    return {
      success: false,
      error: `Plugin '${pluginName}' not found in marketplace '${marketplaceName}'\n  Expected at: ${join(marketplace.path, expectedSubpath, pluginName)}`,
    };
  }

  // Return registeredAs when we auto-registered, when the canonical name differs,
  // or when the spec used owner/repo format without subpath
  // (so "plugin@owner/repo" normalizes to "plugin@name").
  // Subpath specs (plugin@owner/repo/subpath) are NOT normalized because the
  // subpath is needed for resolution and would be lost by the replacement.
  const shouldReturnRegisteredAs =
    didAutoRegister ||
    marketplace.name !== marketplaceName ||
    (owner != null && subpath == null);

  // Include marketplace source for GitHub marketplaces so native CLIs can register them
  const marketplaceSource =
    marketplace.source.type === 'github'
      ? marketplace.source.location
      : undefined;

  return {
    success: true,
    path: resolved.path,
    pluginName: resolved.plugin,
    ...(shouldReturnRegisteredAs && { registeredAs: marketplace.name }),
    ...(marketplaceSource && { marketplaceSource }),
    ...(resolved.fileArtifacts && { fileArtifacts: resolved.fileArtifacts }),
  };
}

/**
 * In-memory cache of marketplace sources registered in this process (source → name).
 * Prevents duplicate log messages without relying on disk I/O for deduplication,
 * which can fail on Windows due to transient file locking (antivirus, search indexer).
 */
const registeredSourceCache = new Map<string, string>();

/** Reset the auto-register cache (for testing only). */
export function resetAutoRegisterCache(): void {
  registeredSourceCache.clear();
}

/**
 * In-memory cache of marketplaces already updated (git pull) in this process.
 * Ensures each marketplace is only pulled once per CLI session.
 */
const updatedMarketplaceCache = new Set<string>();

/** Reset the updated-marketplace cache (for testing only). */
export function resetUpdatedMarketplaceCache(): void {
  updatedMarketplaceCache.clear();
}

/**
 * Auto-register a GitHub marketplace using the same source parser and
 * registration path as the explicit marketplace add command.
 */
async function autoRegisterMarketplace(
  source: string,
): Promise<{ success: boolean; name?: string; error?: string }> {
  const parsedSource = parseMarketplaceSource(source);
  if (parsedSource?.type === 'github') {
    const canonicalSource = parsedSource.location;

    // Fast in-memory check: skip if already registered in this process.
    const cachedName = registeredSourceCache.get(canonicalSource);
    if (cachedName) {
      return { success: true, name: cachedName };
    }

    // Match by canonical source only. Repository basenames are not identities.
    const existing = findBySourceLocation(
      await loadRegistry(),
      canonicalSource,
    );
    if (existing) {
      registeredSourceCache.set(canonicalSource, existing.name);
      return { success: true, name: existing.name };
    }

    const result = await addMarketplace(source);
    if (!result.success) {
      return { success: false, error: result.error || 'Unknown error' };
    }
    const name = result.marketplace?.name ?? parsedSource.name;
    if (!result.replaced) {
      console.log(`Auto-registered GitHub marketplace: ${canonicalSource}`);
    }
    registeredSourceCache.set(canonicalSource, name);
    return { success: true, name };
  }

  // Unknown marketplace name - provide helpful error
  return {
    success: false,
    error: `Marketplace '${source}' not found.\n  Use fully qualified format: plugin@owner/repo`,
  };
}

/**
 * Check if a spec is in plugin@marketplace format
 *
 * `plugin@marketplace`        → true   (plain marketplace shorthand)
 * `plugin@owner/repo[/sub]`   → true   (marketplace by GitHub repo)
 * `owner/repo@ref[/sub]`      → false  (GitHub plugin with an inline ref)
 *
 * The disambiguation: when the segment before the last `@` itself contains a
 * `/`, the spec is an `owner/repo` GitHub URL with an inline ref, not a
 *
 * plugin@marketplace pair. Plugin names in marketplaces are bare identifiers
 * without slashes.
 */
export function isPluginSpec(spec: string): boolean {
  const atIndex = spec.lastIndexOf('@');
  if (atIndex === -1 || atIndex === 0 || atIndex === spec.length - 1) {
    return false;
  }
  const beforeAt = spec.slice(0, atIndex);
  if (beforeAt.includes('/')) {
    return false;
  }
  return true;
}

/**
 * Extract unique marketplace sources from a list of plugin specs.
 * Used to pre-register marketplaces before parallel plugin validation.
 */
export function extractUniqueMarketplaceSources(plugins: string[]): string[] {
  const sources = new Set<string>();

  for (const plugin of plugins) {
    if (!isPluginSpec(plugin)) continue;

    const parsed = parsePluginSpec(plugin);
    if (!parsed) continue;

    if (parsed.owner && parsed.repo) {
      sources.add(`${parsed.owner}/${parsed.repo}`);
      continue;
    }

    const parsedSource = parseMarketplaceSource(parsed.marketplaceName);
    if (parsedSource?.type === 'github') {
      sources.add(
        parsedSource.branch ? parsed.marketplaceName : parsedSource.location,
      );
    }
  }

  return Array.from(sources);
}

/**
 * Ensure all marketplaces for the given plugins are registered.
 * Called before parallel plugin validation to avoid race conditions.
 *
 * @param plugins - List of plugin sources (may include plugin@marketplace specs)
 * @returns Results of marketplace registration attempts
 */
export async function ensureMarketplacesRegistered(
  plugins: string[],
): Promise<
  Array<{ source: string; success: boolean; name?: string; error?: string }>
> {
  const sources = extractUniqueMarketplaceSources(plugins);
  const results: Array<{
    source: string;
    success: boolean;
    name?: string;
    error?: string;
  }> = [];

  for (const source of sources) {
    const result = await autoRegisterMarketplace(source);
    results.push({ source, ...result });
  }

  return results;
}

/**
 * Scope of a marketplace entry (user-level or project-level)
 */
export type MarketplaceScope = 'user' | 'project';

/**
 * Result of merging user and project registries
 */
export interface MergedRegistriesResult {
  registry: MarketplaceRegistry;
  /** Marketplace names where project overrides user */
  overrides: string[];
}

/**
 * Load and merge user and project registries.
 * Project entries take precedence over user entries on name collision.
 */
export async function loadMergedRegistries(
  userRegistryPath: string,
  projectRegistryPath: string,
): Promise<MergedRegistriesResult> {
  // When both paths resolve to the same file (e.g. cwd is the home directory),
  // there is no separate project registry — return user entries with no overrides.
  if (resolve(userRegistryPath) === resolve(projectRegistryPath)) {
    const registry = await loadRegistryFromPath(userRegistryPath);
    return { registry, overrides: [] };
  }

  const [userRegistry, projectRegistry] = await Promise.all([
    loadRegistryFromPath(userRegistryPath),
    loadRegistryFromPath(projectRegistryPath),
  ]);

  const merged: MarketplaceRegistry = {
    version: 1,
    marketplaces: { ...userRegistry.marketplaces },
  };

  const overrides: string[] = [];

  for (const [name, entry] of Object.entries(projectRegistry.marketplaces)) {
    if (getRegistryMarketplace(merged, name)) {
      overrides.push(name);
    }
    setRegistryMarketplace(merged, name, entry);
  }

  return { registry: merged, overrides };
}

/**
 * Check for marketplace overrides where a project registry entry
 * shadows a user registry entry of the same name.
 * Returns the list of overridden marketplace names.
 */
export async function getMarketplaceOverrides(
  userRegistryPath: string,
  projectRegistryPath: string,
): Promise<string[]> {
  if (!existsSync(projectRegistryPath)) {
    return [];
  }
  const { overrides } = await loadMergedRegistries(
    userRegistryPath,
    projectRegistryPath,
  );
  return overrides;
}

/**
 * A marketplace entry annotated with its scope
 */
export interface ScopedMarketplaceEntry extends MarketplaceEntry {
  scope: MarketplaceScope;
}

/**
 * Result of listing marketplaces with scope annotations
 */
export interface ScopedMarketplaceListResult {
  entries: ScopedMarketplaceEntry[];
  overrides: string[];
}

/**
 * List marketplaces from both user and project registries with scope annotations.
 * Project entries override user entries on name collision.
 * Results are sorted by name. Also returns override names to avoid a second registry read.
 */
export async function listMarketplacesWithScope(
  userRegistryPath: string,
  projectRegistryPath: string,
): Promise<ScopedMarketplaceListResult> {
  // When both paths resolve to the same file (e.g. cwd is the home directory),
  // treat all entries as user scope — there is no separate project registry.
  if (resolve(userRegistryPath) === resolve(projectRegistryPath)) {
    const registry = await loadRegistryFromPath(userRegistryPath);
    return {
      entries: Object.values(registry.marketplaces)
        .map((entry) => ({ ...entry, scope: 'user' as const }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      overrides: [],
    };
  }

  const [userRegistry, projectRegistry] = await Promise.all([
    loadRegistryFromPath(userRegistryPath),
    loadRegistryFromPath(projectRegistryPath),
  ]);

  const projectNames = new Set(Object.keys(projectRegistry.marketplaces));
  const entries: ScopedMarketplaceEntry[] = [];
  const overrides: string[] = [];

  // Add user entries that aren't overridden by project
  for (const [key, entry] of Object.entries(userRegistry.marketplaces)) {
    if (projectNames.has(key)) {
      overrides.push(key);
    } else {
      entries.push({ ...entry, scope: 'user' });
    }
  }

  // Add all project entries
  for (const entry of Object.values(projectRegistry.marketplaces)) {
    entries.push({ ...entry, scope: 'project' });
  }

  return {
    entries: entries.sort((a, b) => a.name.localeCompare(b.name)),
    overrides,
  };
}

interface MarketplaceGitClient {
  log(options: {
    maxCount: number;
  }): Promise<{ latest: { hash: string; date: string } | null }>;
}

/**
 * Get the short git commit hash and date for a safely accessible marketplace.
 * Returns null if the marketplace is unsafe, not a git repo, or has no commits.
 */
export async function getMarketplaceVersion(
  marketplace: MarketplaceEntry,
  registryPath = getRegistryPath(),
  gitFactory: (baseDir: string) => MarketplaceGitClient = createGit,
): Promise<{ hash: string; date: Date } | null> {
  const accessError = getMarketplaceAccessError(marketplace, registryPath);
  if (accessError) {
    return null;
  }
  const marketplacePath = marketplace.path;
  if (!existsSync(marketplacePath)) {
    return null;
  }

  try {
    const git = gitFactory(marketplacePath);
    const log = await git.log({ maxCount: 1 });
    if (!log.latest) return null;
    return {
      hash: log.latest.hash.slice(0, 7),
      date: new Date(log.latest.date),
    };
  } catch {
    return null;
  }
}
