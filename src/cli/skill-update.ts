import { execFile } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { normalize, sep } from 'node:path';
import { promisify } from 'node:util';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import {
  type MarketplaceEntry,
  findMarketplace,
  getMarketplacesDir,
  parsePluginSpec,
} from '../core/marketplace.js';
import { parseMarketplaceLocation } from '../utils/plugin-path.js';
import {
  checkRepositoryHealth,
  resolveRemoteRevision,
  type RemoteRevisionResult,
  type RepositoryHealthResult,
} from '../core/git.js';
import { getPluginName, resetFetchCache } from '../core/plugin.js';
import {
  type CheckoutNode,
  type InstallationInspection,
  type InstalledSkill,
  type SkillUpdateDecision,
  type SkillUpdateExecutionResult,
  type SkillUpdateUnitExecution,
  type SkillUpdateInstallation,
  type SkillUpdateInventoryFailure,
  type SkillUpdatePreflight,
  type SkillUpdateNodePrecheck,
  type SkillUpdateScope,
  type SkillUpdateUnit,
  type SkillUpdateUnitInput,
  type UnitInspection,
  buildSkillUpdatePreflight,
  createGitHubSkillUpdateInstallation,
  executeSkillUpdatePlan,
  matchesSkillUpdateFilter,
  resolveCheckoutSubpath,
} from '../core/skill-update.js';
import { UpdateContext } from '../core/update-context.js';
import {
  type DiscoveredSkillEntry,
  discoverSkillEntriesFromPluginRoot,
} from '../core/skills.js';
import { syncUserWorkspace, syncWorkspace } from '../core/sync.js';
import { getUserWorkspaceConfigPath } from '../core/user-workspace.js';
import type {
  PluginEntry,
  PluginSkillsConfig,
  UserWorkspaceConfig,
  WorkspaceConfig,
} from '../models/workspace-config.js';
import {
  getEffectivePluginSource,
  getPluginSource,
} from '../models/workspace-config.js';
import { canonicalizeGitSource } from '../utils/git-source.js';
import { parseMarketplaceManifest } from '../utils/marketplace-manifest-parser.js';
import {
  formatPluginSource,
  getPluginCachePath,
  isGitHubUrl,
  parseGitHubUrl,
} from '../utils/plugin-path.js';
import {
  parseUserWorkspaceConfig,
  parseWorkspaceConfig,
} from '../utils/workspace-parser.js';
import { createSkillUpdateReconciler } from './skill-update-reconciliation.js';

const execFileAsync = promisify(execFile);
const SKILL_UPDATE_GIT_TIMEOUT_MS = 300_000;
const SKILL_UPDATE_GIT_CONFIG = [
  '-c',
  'filter.lfs.required=false',
  '-c',
  'filter.lfs.smudge=',
  '-c',
  'filter.lfs.clean=',
  '-c',
  'filter.lfs.process=',
];

async function runSkillUpdateGit(
  args: string[],
  cwd?: string,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      [...SKILL_UPDATE_GIT_CONFIG, ...args],
      {
        ...(cwd && { cwd }),
        env: {
          ...process.env,
          GIT_LFS_SKIP_SMUDGE: '1',
          GIT_TERMINAL_PROMPT: '0',
        },
        maxBuffer: 4 * 1024 * 1024,
        timeout: SKILL_UPDATE_GIT_TIMEOUT_MS,
      },
    );
    return String(stdout).trim();
  } catch (error) {
    const detail =
      error && typeof error === 'object' && 'stderr' in error
        ? String(error.stderr).trim()
        : '';
    throw new Error(
      `git ${args.join(' ')} failed${cwd ? ` in ${cwd}` : ''}${detail ? `: ${detail}` : ''}`,
      { cause: error },
    );
  }
}

function skillUpdateGitHubUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

async function cloneSkillUpdateCheckout(
  url: string,
  ref?: string,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'allagents-skill-update-'));
  try {
    await runSkillUpdateGit([
      'clone',
      '--depth',
      '1',
      ...(ref ? ['--branch', ref] : []),
      '--',
      url,
      directory,
    ]);
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function cleanupSkillUpdateCheckout(directory: string): Promise<void> {
  const normalizedDirectory = normalize(resolve(directory));
  const normalizedTemp = normalize(resolve(tmpdir()));
  if (
    normalizedDirectory === normalizedTemp ||
    !normalizedDirectory.startsWith(`${normalizedTemp}${sep}`)
  ) {
    throw new Error(
      'Refusing to clean a skill update checkout outside the temp directory',
    );
  }
  await rm(directory, { recursive: true, force: true });
}

export interface SkillUpdateInventory {
  installations: SkillUpdateInstallation[];
  skippedLocalSources: string[];
  failures: SkillUpdateInventoryFailure[];
  /** Direct config entries consuming a cache, including those with no enabled skills. */
  directRemoteConsumers: Array<{
    scope: SkillUpdateScope;
    source: string;
    nodeId: string;
  }>;
}

export interface PrepareSkillUpdateOptions {
  workspacePath: string;
  scopes: SkillUpdateScope[];
  filters?: string[];
  onUnitCheckStart?: (unit: SkillUpdateUnitInput) => void;
}

export interface PrepareSkillUpdateDependencies
  extends SkillUpdateNodePrecheckDependencies {
  buildInventory?: (
    workspacePath: string,
    selectedScopes?: SkillUpdateScope[],
  ) => Promise<SkillUpdateInventory>;
  inspectUnit?: (unit: SkillUpdateUnitInput) => Promise<UnitInspection>;
}

export interface PreparedSkillUpdate {
  inventory: SkillUpdateInventory;
  plan: SkillUpdatePreflight;
}

export interface ExecutePreparedSkillUpdateOptions {
  onUnitApplyStart?: (unit: SkillUpdateUnit) => void;
  onUnitResult?: (result: SkillUpdateUnitExecution) => void;
}

/** Normalize the public scope flag after the caller has resolved its default. */
export function normalizeSkillUpdateScopes(
  scope: string | undefined,
): SkillUpdateScope[] {
  switch (scope ?? 'project') {
    case 'project':
      return ['project'];
    case 'user':
      return ['user'];
    case 'all':
      return ['project', 'user'];
    default:
      throw new Error(
        `Invalid scope '${scope}'. Expected project, user, or all.`,
      );
  }
}

/** --yes suppresses questions; it intentionally never authorizes deletion. */
export function resolveNonInteractiveSkillUpdateDecisions(
  plan: SkillUpdatePreflight,
): Record<string, SkillUpdateDecision> {
  return Object.fromEntries(
    plan.units
      .filter((unit) => unit.deleted.length > 0)
      .map((unit) => [unit.id, 'retain' as const]),
  );
}

export function findUnmatchedSkillUpdateFilters(
  inventory: SkillUpdateInventory,
  scopes: SkillUpdateScope[],
  filters: string[],
): string[] {
  const selected = new Set(scopes);
  return filters.filter((filter) => {
    return !inventory.installations.some(
      (installation) =>
        selected.has(installation.scope) &&
        matchesSkillUpdateFilter(installation, filter),
    );
  });
}

function configPath(scope: SkillUpdateScope, workspacePath: string): string {
  return scope === 'project'
    ? join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE)
    : getUserWorkspaceConfigPath();
}

type SkillUpdateWorkspaceConfig = WorkspaceConfig | UserWorkspaceConfig;

async function readConfig(
  scope: SkillUpdateScope,
  workspacePath: string,
): Promise<SkillUpdateWorkspaceConfig | null> {
  const path = configPath(scope, workspacePath);
  if (!existsSync(path)) return null;
  return scope === 'user'
    ? parseUserWorkspaceConfig(path)
    : parseWorkspaceConfig(path);
}

async function revision(path: string): Promise<string> {
  if (!existsSync(path)) throw new Error(`Checkout not found: ${path}`);
  const sha = await runSkillUpdateGit(['rev-parse', 'HEAD'], path);
  if (!sha) throw new Error(`Could not resolve checkout revision: ${path}`);
  return sha;
}

function posixPath(path: string): string {
  return path.split(/[\\/]/).join('/');
}

function enabledSkills(
  entries: DiscoveredSkillEntry[],
  pluginName: string,
  config: SkillUpdateWorkspaceConfig,
  pluginSkills: PluginSkillsConfig | undefined,
): InstalledSkill[] {
  const isV1 = config.version === undefined || config.version < 2;
  const topDisabled = new Set(config.disabledSkills ?? []);
  const topEnabled = config.enabledSkills
    ? new Set(config.enabledSkills)
    : undefined;
  const hasTopEnabled =
    isV1 &&
    topEnabled !== undefined &&
    [...topEnabled].some((value) => value.startsWith(`${pluginName}:`));

  return entries.map(({ name, subpath }) => {
    let enabled = true;
    let selector: string | undefined;
    if (Array.isArray(pluginSkills)) {
      selector = pluginSkills.includes(subpath)
        ? subpath
        : pluginSkills.includes(name)
          ? name
          : undefined;
      enabled = selector !== undefined;
    } else if (pluginSkills) {
      enabled =
        !pluginSkills.exclude.includes(subpath) &&
        !pluginSkills.exclude.includes(name);
    } else if (isV1) {
      const nameKey = `${pluginName}:${name}`;
      const pathKey = `${pluginName}:${subpath}`;
      enabled = hasTopEnabled
        ? (topEnabled?.has(nameKey) ?? false) ||
          (topEnabled?.has(pathKey) ?? false)
        : !topDisabled.has(nameKey) && !topDisabled.has(pathKey);
    }
    return {
      name,
      subpath,
      enabled,
      ...(selector && { selector }),
    };
  });
}

function pluginSkillsConfig(
  plugin: PluginEntry,
): PluginSkillsConfig | undefined {
  return typeof plugin === 'string' ? undefined : plugin.skills;
}

function isStandaloneSkillRoot(
  root: string,
  entries: DiscoveredSkillEntry[],
): boolean {
  if (
    !existsSync(join(root, 'SKILL.md')) ||
    entries.length !== 1 ||
    resolve(entries[0]?.skillPath ?? '') !== resolve(root)
  ) {
    return false;
  }
  return ![
    '.claude-plugin',
    '.github',
    '.mcp.json',
    'commands',
    'hooks',
    'mcp.json',
  ].some((artifact) => existsSync(join(root, artifact)));
}

function nodeForMarketplace(entry: MarketplaceEntry): CheckoutNode | null {
  if (entry.source.type === 'local') return null;
  const managedPath = resolveCheckoutSubpath(getMarketplacesDir(), entry.name);
  if (resolve(entry.path) !== resolve(managedPath)) {
    throw new Error(
      `Remote marketplace '${entry.name}' is outside the AllAgents-managed cache: ${entry.path}`,
    );
  }
  if (entry.source.type === 'github') {
    const parsed = parseMarketplaceLocation(entry.source.location);
    return {
      id: managedPath,
      cachePath: managedPath,
      remoteUrl: skillUpdateGitHubUrl(parsed.owner, parsed.repo),
      role: 'root',
      currentSha: '',
      ...(parsed.branch && { ref: parsed.branch }),
    };
  }
  return {
    id: managedPath,
    cachePath: managedPath,
    remoteUrl: entry.source.location,
    role: 'root',
    currentSha: '',
  };
}

async function marketplaceForScope(
  name: string,
  scope: SkillUpdateScope,
  workspacePath: string,
  sourceLocation?: string,
): Promise<MarketplaceEntry | null> {
  return findMarketplace(
    name,
    sourceLocation,
    scope === 'project' ? workspacePath : undefined,
  );
}

async function inventoryDirect(
  scope: SkillUpdateScope,
  configIndex: number,
  plugin: PluginEntry,
  config: SkillUpdateWorkspaceConfig,
): Promise<SkillUpdateInstallation | null> {
  const effectiveSource = getEffectivePluginSource(plugin);
  const parsed = parseGitHubUrl(effectiveSource);
  if (!parsed) return null;
  const cachePath = getPluginCachePath(
    parsed.owner,
    parsed.repo,
    parsed.branch,
  );
  const root = resolveCheckoutSubpath(cachePath, parsed.subpath ?? '');
  if (!existsSync(root)) {
    throw new Error(
      `Cached plugin root not found for ${effectiveSource}: ${root}`,
    );
  }
  const discovered = await discoverSkillEntriesFromPluginRoot(root);
  const pluginName = getPluginName(root);
  const skills = enabledSkills(
    discovered,
    pluginName,
    config,
    pluginSkillsConfig(plugin),
  );
  if (!skills.some((skill) => skill.enabled)) return null;
  return createGitHubSkillUpdateInstallation({
    scope,
    configIndex,
    plugin,
    pluginName,
    currentSha: await revision(cachePath),
    skills,
    standaloneSkillSource: isStandaloneSkillRoot(root, discovered),
  });
}

async function inventoryMarketplace(
  scope: SkillUpdateScope,
  configIndex: number,
  plugin: PluginEntry,
  config: SkillUpdateWorkspaceConfig,
  workspacePath: string,
): Promise<SkillUpdateInstallation | null | 'local'> {
  const rawSource = getPluginSource(plugin);
  const spec = parsePluginSpec(rawSource);
  if (!spec) return null;
  const marketplace = await marketplaceForScope(
    spec.marketplaceName,
    scope,
    workspacePath,
    spec.owner && spec.repo ? `${spec.owner}/${spec.repo}` : undefined,
  );
  if (!marketplace) {
    throw new Error(
      `Marketplace '${spec.marketplaceName}' for ${rawSource} is not registered in ${scope} scope`,
    );
  }
  const marketplaceNode = nodeForMarketplace(marketplace);
  if (!marketplaceNode) return 'local';
  marketplaceNode.currentSha = await revision(marketplaceNode.cachePath);

  const manifest = await parseMarketplaceManifest(marketplace.path);
  if (!manifest.success) {
    throw new Error(
      `Could not inventory marketplace '${marketplace.name}': ${manifest.error}`,
    );
  }
  if (manifest.warnings.length > 0) {
    throw new Error(
      `Could not safely inventory marketplace '${marketplace.name}': ${manifest.warnings.join('; ')}`,
    );
  }
  const manifestPlugin = manifest.data.plugins.find(
    (entry) => entry.name === spec.plugin,
  );

  let root: string;
  let rootNode: CheckoutNode = marketplaceNode;
  const nodes: CheckoutNode[] = [marketplaceNode];
  if (manifestPlugin && typeof manifestPlugin.source === 'object') {
    const parsed = parseGitHubUrl(manifestPlugin.source.url);
    if (!parsed) {
      throw new Error(
        `External marketplace plugin '${rawSource}' is not backed by a supported GitHub source`,
      );
    }
    const cachePath = getPluginCachePath(
      parsed.owner,
      parsed.repo,
      parsed.branch,
    );
    rootNode = {
      id: cachePath,
      cachePath,
      remoteUrl: skillUpdateGitHubUrl(parsed.owner, parsed.repo),
      role: 'dependency',
      currentSha: await revision(cachePath),
      ...(parsed.branch && { ref: parsed.branch }),
    };
    nodes.unshift(rootNode);
    root = resolveCheckoutSubpath(cachePath, parsed.subpath ?? '');
  } else {
    const source =
      manifestPlugin && typeof manifestPlugin.source === 'string'
        ? manifestPlugin.source
        : join(spec.subpath ?? 'plugins', spec.plugin);
    root = resolveCheckoutSubpath(marketplaceNode.cachePath, source);
  }
  if (!existsSync(root)) {
    throw new Error(`Installed marketplace plugin root not found: ${root}`);
  }
  const discovered = await discoverSkillEntriesFromPluginRoot(root);
  const skills = enabledSkills(
    discovered,
    spec.plugin,
    config,
    pluginSkillsConfig(plugin),
  );
  if (!skills.some((skill) => skill.enabled)) return null;

  return {
    id: `${scope}:${configIndex}`,
    scope,
    configIndex,
    rawSource,
    effectiveSource: rawSource,
    pluginName: spec.plugin,
    rootNodeId: rootNode.id,
    rootSubpath:
      rootNode.id === marketplaceNode.id
        ? posixPath(relative(marketplace.path, root))
        : posixPath(relative(rootNode.cachePath, root)),
    nodes,
    skills,
    marketplace: {
      nodeId: marketplaceNode.id,
      pluginName: spec.plugin,
    },
  };
}

/** Snapshot raw config entries across both scopes before any remote checkout. */
export async function buildSkillUpdateInventory(
  workspacePath: string,
  selectedScopes: SkillUpdateScope[] = ['project', 'user'],
): Promise<SkillUpdateInventory> {
  const installations: SkillUpdateInstallation[] = [];
  const skippedLocalSources: string[] = [];
  const failures: SkillUpdateInventoryFailure[] = [];
  const directRemoteConsumers: SkillUpdateInventory['directRemoteConsumers'] =
    [];
  const deferred: SkillUpdateInstallation[] = [];
  const deferredErrors: Array<
    SkillUpdateInventoryFailure & { errorCause: unknown }
  > = [];
  const selected = new Set(selectedScopes);

  const potentialNodeIds = async (
    source: string,
    plugin: PluginEntry,
    scope: SkillUpdateScope,
  ): Promise<string[]> => {
    const direct = parseGitHubUrl(getEffectivePluginSource(plugin));
    if (direct) {
      return [getPluginCachePath(direct.owner, direct.repo, direct.branch)];
    }
    const spec = parsePluginSpec(source);
    if (!spec) return [];
    const marketplace = await marketplaceForScope(
      spec.marketplaceName,
      scope,
      workspacePath,
      spec.owner && spec.repo ? `${spec.owner}/${spec.repo}` : undefined,
    );
    const node = marketplace ? nodeForMarketplace(marketplace) : null;
    return node ? [node.id] : [];
  };

  // Inventory selected scopes first, then attach healthy consumers from the
  // other scope only when their physical checkout graph intersects. This keeps
  // an unrelated broken user plugin from blocking a project-only update while
  // still making shared caches a cross-scope safety boundary.
  for (const scope of ['project', 'user'] as const) {
    let config: SkillUpdateWorkspaceConfig | null;
    try {
      config = await readConfig(scope, workspacePath);
    } catch (error) {
      if (selected.has(scope)) {
        failures.push({
          id: `inventory:${scope}:config`,
          scope,
          source: configPath(scope, workspacePath),
          nodeIds: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }
    if (!config) continue;
    for (const [configIndex, plugin] of config.plugins.entries()) {
      const rawSource = getPluginSource(plugin);
      const effectiveSource = getEffectivePluginSource(plugin);
      const direct = isGitHubUrl(effectiveSource)
        ? parseGitHubUrl(effectiveSource)
        : null;
      if (direct) {
        directRemoteConsumers.push({
          scope,
          source: rawSource,
          nodeId: getPluginCachePath(direct.owner, direct.repo, direct.branch),
        });
      }
      let installation: SkillUpdateInstallation | null | 'local';
      try {
        // Inline Git refs also use `@` (owner/repo@ref). Direct GitHub
        // recognition must therefore take precedence over marketplace syntax.
        if (isGitHubUrl(effectiveSource)) {
          installation = await inventoryDirect(
            scope,
            configIndex,
            plugin,
            config,
          );
        } else if (parsePluginSpec(rawSource)) {
          installation = await inventoryMarketplace(
            scope,
            configIndex,
            plugin,
            config,
            workspacePath,
          );
        } else {
          installation = 'local';
        }
      } catch (error) {
        const failure = {
          id: `inventory:${scope}:${configIndex}`,
          scope,
          source: rawSource,
          nodeIds: [] as string[],
          error: error instanceof Error ? error.message : String(error),
        };
        try {
          failure.nodeIds = await potentialNodeIds(rawSource, plugin, scope);
        } catch {
          // The original inventory error remains authoritative. An unknown
          // physical identity becomes a standalone selected-scope failure.
        }
        if (selected.has(scope)) failures.push(failure);
        else deferredErrors.push({ ...failure, errorCause: error });
        continue;
      }
      if (installation === 'local') {
        if (selected.has(scope)) {
          skippedLocalSources.push(`${scope}:${rawSource}`);
        }
      } else if (installation) {
        (selected.has(scope) ? installations : deferred).push(installation);
      }
    }
  }

  const touchedNodeIds = new Set(
    installations.flatMap((installation) =>
      installation.nodes.map((node) => node.id),
    ),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = deferred.length - 1; index >= 0; index--) {
      const installation = deferred[index];
      if (!installation?.nodes.some((node) => touchedNodeIds.has(node.id))) {
        continue;
      }
      deferred.splice(index, 1);
      installations.push(installation);
      for (const node of installation.nodes) touchedNodeIds.add(node.id);
      changed = true;
    }
  }
  const sharedFailures = deferredErrors.filter((candidate) =>
    candidate.nodeIds.some((nodeId) => touchedNodeIds.has(nodeId)),
  );
  for (const sharedFailure of sharedFailures) {
    failures.push({
      id: sharedFailure.id,
      scope: sharedFailure.scope,
      source: sharedFailure.source,
      nodeIds: sharedFailure.nodeIds,
      error: `Could not safely inventory shared source: ${sharedFailure.errorCause instanceof Error ? sharedFailure.errorCause.message : String(sharedFailure.errorCause)}`,
    });
  }
  return {
    installations,
    skippedLocalSources,
    failures,
    directRemoteConsumers,
  };
}

async function inspectInstallation(
  installation: SkillUpdateInstallation,
  checkoutPaths: Map<string, string>,
): Promise<InstallationInspection> {
  let root: string;
  if (installation.marketplace) {
    const marketplaceCheckout = checkoutPaths.get(
      installation.marketplace.nodeId,
    );
    if (!marketplaceCheckout) {
      throw new Error(
        `Inspected marketplace checkout missing for ${installation.rawSource}`,
      );
    }
    const manifest = await parseMarketplaceManifest(marketplaceCheckout);
    if (!manifest.success) {
      return {
        installationId: installation.id,
        outcome: 'failed',
        error: manifest.error,
      };
    }
    if (manifest.warnings.length > 0) {
      return {
        installationId: installation.id,
        outcome: 'failed',
        error: manifest.warnings.join('; '),
      };
    }
    const entry = manifest.data.plugins.find(
      (candidate) => candidate.name === installation.marketplace?.pluginName,
    );
    if (!entry) {
      return { installationId: installation.id, outcome: 'plugin-removed' };
    }
    if (typeof entry.source === 'object') {
      const parsed = parseGitHubUrl(entry.source.url);
      if (!parsed) {
        return {
          installationId: installation.id,
          outcome: 'failed',
          error: `Unsupported external source for ${installation.rawSource}`,
        };
      }
      const expectedNode = getPluginCachePath(
        parsed.owner,
        parsed.repo,
        parsed.branch,
      );
      if (expectedNode !== installation.rootNodeId) {
        return {
          installationId: installation.id,
          outcome: 'failed',
          error: `External source for ${installation.rawSource} changed; run plugin update before skill update`,
        };
      }
      const checkout = checkoutPaths.get(expectedNode);
      if (!checkout) {
        throw new Error(
          `Inspected external checkout missing for ${expectedNode}`,
        );
      }
      root = resolveCheckoutSubpath(checkout, parsed.subpath ?? '');
    } else {
      root = resolveCheckoutSubpath(marketplaceCheckout, entry.source);
    }
  } else {
    const checkout = checkoutPaths.get(installation.rootNodeId);
    if (!checkout) {
      throw new Error(
        `Inspected checkout missing for ${installation.rawSource}`,
      );
    }
    root = resolveCheckoutSubpath(checkout, installation.rootSubpath);
  }

  if (!existsSync(root)) {
    return {
      installationId: installation.id,
      outcome: 'failed',
      error: `Declared plugin root no longer exists for ${installation.rawSource}`,
    };
  }
  const warnings: string[] = [];
  const discovered = await discoverSkillEntriesFromPluginRoot(root, warnings);
  if (warnings.length > 0) {
    return {
      installationId: installation.id,
      outcome: 'failed',
      error: warnings.join('; '),
    };
  }
  return {
    installationId: installation.id,
    outcome: 'resolved',
    skills: discovered.map(({ name, subpath }) => ({ name, subpath })),
  };
}

/** Inspect direct, embedded-marketplace, and external-marketplace units in temp clones. */
export async function inspectSkillUpdateUnit(
  unit: SkillUpdateUnitInput,
): Promise<UnitInspection> {
  const checkoutPaths = new Map<string, string>();
  try {
    const nodes: UnitInspection['nodes'] = [];
    const cloneNode = async (node: CheckoutNode): Promise<void> => {
      if (checkoutPaths.has(node.id)) return;
      const checkout = await cloneSkillUpdateCheckout(node.remoteUrl, node.ref);
      checkoutPaths.set(node.id, checkout);
      nodes.push({ nodeId: node.id, sha: await revision(checkout) });
    };

    // Marketplace roots authoritatively determine whether an external plugin
    // still exists. Inspect them before touching dependencies that may now be
    // obsolete or unreachable.
    for (const node of unit.nodes.filter(
      (candidate) => candidate.role === 'root',
    )) {
      await cloneNode(node);
    }
    const installations: InstallationInspection[] = [];
    const removed = new Set<string>();
    for (const installation of unit.installations.filter(
      (candidate) => candidate.marketplace,
    )) {
      const marketplaceCheckout = checkoutPaths.get(
        installation.marketplace?.nodeId ?? '',
      );
      if (!marketplaceCheckout) continue;
      const manifest = await parseMarketplaceManifest(marketplaceCheckout);
      if (!manifest.success || manifest.warnings.length > 0) continue;
      const entry = manifest.data.plugins.find(
        (candidate) => candidate.name === installation.marketplace?.pluginName,
      );
      if (!entry) {
        removed.add(installation.id);
        installations.push({
          installationId: installation.id,
          outcome: 'plugin-removed',
        });
      }
    }

    const neededNodeIds = new Set(
      unit.installations
        .filter((installation) => !removed.has(installation.id))
        .flatMap((installation) => installation.nodes.map((node) => node.id)),
    );
    for (const node of unit.nodes.filter(
      (candidate) =>
        candidate.role === 'dependency' && neededNodeIds.has(candidate.id),
    )) {
      await cloneNode(node);
    }
    for (const installation of unit.installations) {
      if (removed.has(installation.id)) continue;
      installations.push(
        await inspectInstallation(installation, checkoutPaths),
      );
    }
    const failed = installations.find((entry) => entry.outcome === 'failed');
    return failed?.outcome === 'failed'
      ? {
          outcome: 'failed',
          nodes,
          installations,
          error: failed.error,
        }
      : { outcome: 'resolved', nodes, installations };
  } catch (error) {
    return {
      outcome: 'failed',
      nodes: [],
      installations: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await Promise.all(
      [...checkoutPaths.values()].map((path) =>
        cleanupSkillUpdateCheckout(path).catch(() => {}),
      ),
    );
  }
}

async function skillUpdateDomainRootsReadable(
  node: CheckoutNode,
  unit: SkillUpdateUnitInput,
): Promise<boolean> {
  const roots = new Set<string>();
  let includesMarketplace = false;
  for (const installation of unit.installations) {
    if (installation.rootNodeId === node.id) {
      try {
        roots.add(
          resolveCheckoutSubpath(node.cachePath, installation.rootSubpath),
        );
      } catch {
        return false;
      }
    }
    if (installation.marketplace?.nodeId === node.id) {
      roots.add(node.cachePath);
      includesMarketplace = true;
    }
  }
  if (roots.size === 0) return false;
  if (includesMarketplace) {
    const manifest = await parseMarketplaceManifest(node.cachePath);
    if (!manifest.success || manifest.warnings.length > 0) return false;
  }
  const readable = await Promise.all(
    [...roots].map((root) =>
      access(root, constants.R_OK | constants.X_OK).then(
        () => true,
        () => false,
      ),
    ),
  );
  return readable.every(Boolean);
}

export interface SkillUpdateNodePrecheckDependencies {
  resolveRemoteRevision?: typeof resolveRemoteRevision;
  checkRepositoryHealth?: typeof checkRepositoryHealth;
  domainRootsReadable?: (
    node: CheckoutNode,
    unit: SkillUpdateUnitInput,
  ) => Promise<boolean>;
}

/**
 * Build the non-mutating node check used before exact skill inspection.
 * Callers provide their action context so plugin and skill consumers share
 * remote and checkout-health facts without sharing domain projections.
 */
export function createSkillUpdateNodePrecheck(
  context: UpdateContext,
  dependencies: SkillUpdateNodePrecheckDependencies = {},
): (
  node: CheckoutNode,
  unit: SkillUpdateUnitInput,
) => Promise<SkillUpdateNodePrecheck> {
  const resolveRemote =
    dependencies.resolveRemoteRevision ?? resolveRemoteRevision;
  const checkHealth =
    dependencies.checkRepositoryHealth ?? checkRepositoryHealth;
  const checkDomainRoots =
    dependencies.domainRootsReadable ?? skillUpdateDomainRootsReadable;

  return async (node, unit) => {
    const domainRootsPromise = checkDomainRoots(node, unit).catch(() => false);
    let remote: RemoteRevisionResult;
    try {
      remote = await context.getRemote(node.remoteUrl, node.ref, () =>
        resolveRemote(node.remoteUrl, node.ref),
      );
    } catch {
      remote = { status: 'unresolved', reason: 'failed' };
    }

    const expectedRef = remote.status === 'resolved' ? remote.ref : node.ref;
    const identity = {
      path: node.cachePath,
      source: node.remoteUrl,
      ...(expectedRef !== undefined && { ref: expectedRef }),
    };
    const [health, domainRootsHealthy] = await Promise.all([
      context
        .getHealth(identity, () =>
          checkHealth(node.cachePath, {
            source: node.remoteUrl,
            ...(expectedRef !== undefined && { ref: expectedRef }),
            head: node.currentSha,
          }),
        )
        .catch(
          (error): RepositoryHealthResult => ({
            status: 'unhealthy',
            reason: 'inspection-failed',
            error: error instanceof Error ? error : new Error(String(error)),
          }),
        ),
      domainRootsPromise,
    ]);
    return {
      remoteEqual:
        remote.status === 'resolved' &&
        remote.commit.toLowerCase() === node.currentSha.toLowerCase(),
      repositoryHealthy:
        remote.status === 'resolved' && health.status === 'healthy',
      domainRootsHealthy,
    };
  };
}


export async function prepareSkillUpdateFromInventory(
  options: PrepareSkillUpdateOptions,
  inventory: SkillUpdateInventory,
  dependencies: PrepareSkillUpdateDependencies = {},
): Promise<PreparedSkillUpdate> {
  const context = new UpdateContext();
  try {
    const plan = await buildSkillUpdatePreflight(
      {
        installations: inventory.installations,
        selectedScopes: options.scopes,
        failures: inventory.failures,
        ...(options.filters && { filters: options.filters }),
      },
      {
        inspectUnit: dependencies.inspectUnit ?? inspectSkillUpdateUnit,
        precheckNode: createSkillUpdateNodePrecheck(context, dependencies),
        ...(options.onUnitCheckStart && {
          onUnitCheckStart: options.onUnitCheckStart,
        }),
      },
    );
    return { inventory, plan };
  } finally {
    context.dispose();
  }
}

export async function prepareSkillUpdate(
  options: PrepareSkillUpdateOptions,
  dependencies: PrepareSkillUpdateDependencies = {},
): Promise<PreparedSkillUpdate> {
  const inventory = await (
    dependencies.buildInventory ?? buildSkillUpdateInventory
  )(options.workspacePath, options.scopes);
  return prepareSkillUpdateFromInventory(options, inventory, dependencies);
}


async function assertExpectedOrigin(node: CheckoutNode): Promise<void> {
  // `git remote get-url` applies url.<base>.insteadOf rewriting. Read the
  // configured value so an isolated/local transport override cannot make a
  // correctly configured GitHub checkout fail the origin safety check.
  const origin = await runSkillUpdateGit(
    ['config', '--get', 'remote.origin.url'],
    node.cachePath,
  );
  if (
    canonicalizeGitSource(origin) !== canonicalizeGitSource(node.remoteUrl)
  ) {
    throw new Error(
      `Refusing to update ${node.cachePath}: origin '${origin}' does not match expected remote '${node.remoteUrl}'`,
    );
  }
}

export async function moveSkillUpdateCheckout(
  node: CheckoutNode,
  sha: string,
): Promise<void> {
  await assertExpectedOrigin(node);

  try {
    await runSkillUpdateGit(
      ['fetch', '--depth', '1', 'origin', node.ref ?? 'HEAD'],
      node.cachePath,
    );
  } catch (refError) {
    try {
      await runSkillUpdateGit(
        ['fetch', '--depth', '1', 'origin', sha],
        node.cachePath,
      );
    } catch (shaError) {
      throw new Error(
        `Could not fetch ref '${node.ref ?? 'HEAD'}' or inspected revision '${sha}': ${refError instanceof Error ? refError.message : String(refError)}; ${shaError instanceof Error ? shaError.message : String(shaError)}`,
      );
    }
  }
  try {
    await runSkillUpdateGit(
      ['cat-file', '-e', `${sha}^{commit}`],
      node.cachePath,
    );
  } catch {
    // Some servers do not include the exact preflight commit in the shallow
    // ref fetch. Try the immutable SHA before declaring the transaction failed.
    await runSkillUpdateGit(
      ['fetch', '--depth', '1', 'origin', sha],
      node.cachePath,
    );
  }
  await runSkillUpdateGit(['reset', '--hard', sha], node.cachePath);
}

async function restoreCheckout(node: CheckoutNode, sha: string): Promise<void> {
  await assertExpectedOrigin(node);
  await runSkillUpdateGit(
    ['cat-file', '-e', `${sha}^{commit}`],
    node.cachePath,
  );
  await runSkillUpdateGit(['reset', '--hard', sha], node.cachePath);
}

export async function executePreparedSkillUpdate(
  prepared: PreparedSkillUpdate,
  decisions: Record<string, SkillUpdateDecision>,
  workspacePath: string,
  options: ExecutePreparedSkillUpdateOptions = {},
): Promise<SkillUpdateExecutionResult> {
  const result = await executeSkillUpdatePlan(prepared.plan, decisions, {
    advanceNode: moveSkillUpdateCheckout,
    restoreNode: restoreCheckout,
    reconcileUnit: createSkillUpdateReconciler({ workspacePath }),
    syncScope: async (scope) => {
      resetFetchCache();
      const syncResult =
        scope === 'project'
          ? await syncWorkspace(workspacePath, { offline: true })
          : await syncUserWorkspace({ offline: true });
      return syncResult.success
        ? { success: true }
        : { success: false, error: `Offline ${scope} sync failed` };
    },
    ...(options.onUnitApplyStart && {
      onUnitApplyStart: options.onUnitApplyStart,
    }),
    ...(options.onUnitResult && { onUnitResult: options.onUnitResult }),
  });
  return result;
}

export function hasProjectSkillConfig(workspacePath: string): boolean {
  return existsSync(join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE));
}

export function unitDisplayName(
  unit: SkillUpdateUnitInput,
): string {
  const labels = [
    ...new Set(
      unit.installations.flatMap((installation) =>
        installation.standaloneSkillSource
          ? installation.skills
              .filter((skill) => skill.enabled)
              .map((skill) => skill.name)
          : [formatPluginSource(installation.rawSource)],
      ),
    ),
  ];
  return labels.length > 0 ? labels.join(', ') : basename(unit.id);
}

export function unitSourceDisplayName(unit: SkillUpdateUnitInput): string {
  const sources = [
    ...new Set(
      unit.installations.map((installation) =>
        formatPluginSource(installation.rawSource),
      ),
    ),
  ];
  return sources.length > 0 ? sources.join(', ') : basename(unit.id);
}

export interface SkillUpdateSummary {
  updated: number;
  removed: number;
  retained: number;
  skipped: number;
  failed: number;
  cancelled: number;
}

export function skillUpdateSummary(
  result: SkillUpdateExecutionResult,
): SkillUpdateSummary {
  const summary: SkillUpdateSummary = {
    updated: 0,
    removed: 0,
    retained: 0,
    skipped: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const unit of result.units) {
    summary.updated += unit.skillCounts.updated;
    summary.removed += unit.skillCounts.removed;
    summary.retained += unit.skillCounts.retained;
    if (unit.status === 'retained' || unit.status === 'skipped') {
      summary.skipped += 1;
    } else if (unit.status === 'failed') {
      summary.failed += 1;
    } else if (unit.status === 'cancelled') {
      summary.cancelled += 1;
    }
  }
  return summary;
}

/** Map an orchestration result to the documented process exit contract. */
export function skillUpdateExitCode(
  result: SkillUpdateExecutionResult,
): number {
  if (result.cancelled) return 0;
  return result.success ? 0 : 1;
}
