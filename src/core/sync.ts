import {
  existsSync,
  lstatSync,
  readFileSync,
  type Stats,
  writeFileSync,
} from 'node:fs';
import { copyFile, rm, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import JSON5 from 'json5';
import {
  AGENT_FILES,
  CONFIG_DIR,
  getHomeDir,
  WORKSPACE_CONFIG_FILE,
} from '../constants.js';
import type { ClientMapping } from '../models/client-mapping.js';
import {
  CANONICAL_SKILLS_PATH,
  CLIENT_MAPPINGS,
  isUniversalClient,
  resolveClientMappings,
  USER_CLIENT_MAPPINGS,
} from '../models/client-mapping.js';
import type { MarketplaceFileArtifacts } from '../models/marketplace-manifest.js';
import type {
  NativeStateResource,
  SyncState,
  SyncStateSource,
} from '../models/sync-state.js';
import type {
  ClientType,
  PluginEntry,
  PluginSkillsConfig,
  SyncMode,
  WorkspaceConfig,
  WorkspaceFile,
} from '../models/workspace-config.js';
import {
  type ClientEntry,
  getClientTypes,
  getEffectivePluginSource,
  getPluginClients,
  getPluginExclude,
  normalizeClientEntry,
  resolveInstallMode,
} from '../models/workspace-config.js';
import { getEmbeddedMarketplaceFileArtifacts } from '../utils/marketplace-manifest-parser.js';
import {
  isGitHubUrl,
  parseFileSource,
  parseGitHubUrl,
  stripGitRef,
} from '../utils/plugin-path.js';
import {
  getSkillKey,
  resolveSkillNames,
  type SkillEntry,
} from '../utils/skill-name-resolver.js';
import { Stopwatch } from '../utils/stopwatch.js';
import { parseWorkspaceConfig } from '../utils/workspace-parser.js';
import {
  assertSafeDestination,
  clientMappingsFromContexts,
  pathIsWithin,
  type ResolvedClientContext,
  resolveClientContexts,
  resolveMappedPath,
} from './client-context.js';
import { syncCodexProjectHooks } from './codex-hooks.js';
import {
  COPILOT_MANAGED_HOOKS_RELATIVE_PATH,
  syncCopilotProjectHooks,
} from './copilot-hooks.js';
import { processManagedRepos } from './managed-repos.js';
import {
  ensureMarketplacesRegistered,
  getMarketplace,
  getMarketplaceAccessError,
  getMarketplaceOverrides,
  getProjectRegistryPath,
  getRegistryPath,
  isPluginSpec,
  parsePluginSpec,
  resolvePluginSpecWithAutoRegister,
} from './marketplace.js';
import { syncMcpServers as runMcpSync } from './mcp-sync.js';
import {
  getNativeClient,
  mergeNativeSyncResults,
  type NativeEffect,
  type NativeMutationResult,
  type NativeOperationContext,
  type NativeResource,
  type NativeSyncResult,
  sanitizeNativeProvenance,
} from './native/index.js';
import { fetchPlugin, getPluginName, seedFetchCache } from './plugin.js';
import {
  cleanupSkillsIndex,
  discoverWorkspaceSkills,
  groupSkillsByRepo,
  writeSkillsIndex,
} from './repo-skills.js';
import {
  getNativeStateResources,
  getPreviouslySyncedFiles,
  loadSyncState,
  nativeStateOwnership,
  saveNativeStateResources,
  saveSyncState,
} from './sync-state.js';
import {
  type AgentDedupeRecord,
  type AgentOutput,
  type AgentOutputConflict,
  type AgentOutputFailure,
  type AgentOutputPlan,
  type CopyResult,
  collectPluginSkills,
  copyPluginToWorkspace,
  copyWorkspaceFiles,
  dedupeAgentFilesByName,
  findRelocatedGitHubHooks,
  planAgentOutputs,
} from './transform.js';
import { syncUserMcpAdapters } from './user-mcp-sync.js';
import {
  getUserWorkspaceConfig,
  migrateUserWorkspaceSkillsV1toV2,
} from './user-workspace.js';
import type { McpMergeResult } from './vscode-mcp.js';
import {
  computeWorkspaceHash,
  generateVscodeWorkspace,
  getWorkspaceOutputPath,
  reconcileVscodeWorkspaceFolders,
} from './vscode-workspace.js';
import {
  migrateWorkspaceSkillsV1toV2,
  setRepositories,
  updateRepositories,
} from './workspace-modify.js';
import { updateAgentFiles } from './workspace-repo.js';

/**
 * Result of deduplicating clients by skillsPath
 */
interface DeduplicatedClients {
  /** Representative client for each unique path (used for copying) */
  representativeClients: ClientType[];
  /** Map from representative client to all clients sharing that path */
  clientGroups: Map<ClientType, ClientType[]>;
}

/**
 * Deduplicate clients by their skillsPath to avoid copying skills multiple times
 * to the same directory when multiple clients share the same path.
 *
 * For example, copilot, codex, opencode, gemini, ampcode all use `.agents/skills/`,
 * so we only need to copy skills once but track files for all these clients.
 *
 * @param clients - List of clients to deduplicate
 * @param clientMappings - Client path mappings to use (defaults to CLIENT_MAPPINGS)
 * @returns Deduplicated result with representative clients and their groups
 */
export function deduplicateClientsByPath(
  clients: ClientType[],
  clientMappings: Record<string, ClientMapping> = CLIENT_MAPPINGS,
): DeduplicatedClients {
  // Group clients by their skillsPath
  const pathToClients = new Map<string, ClientType[]>();

  for (const client of clients) {
    const mapping = clientMappings[client];
    // Use skillsPath as the grouping key, or a unique key for clients without skillsPath
    const pathKey = mapping?.skillsPath || `__no_skills_${client}__`;

    const existing = pathToClients.get(pathKey) || [];
    existing.push(client);
    pathToClients.set(pathKey, existing);
  }

  // Build result: use first client in each group as representative
  const representativeClients: ClientType[] = [];
  const clientGroups = new Map<ClientType, ClientType[]>();

  for (const clientsInGroup of pathToClients.values()) {
    const representative = clientsInGroup[0];
    if (representative) {
      representativeClients.push(representative);
      clientGroups.set(representative, clientsInGroup);
    }
  }

  return { representativeClients, clientGroups };
}

/**
 * Result of a sync operation
 */
/**
 * A named artifact (skill, command, hook, or agent) that was deleted during sync
 * because it was no longer provided by any plugin.
 */
export interface DeletedArtifact {
  client: ClientType;
  type: 'skill' | 'command' | 'agent' | 'hook';
  name: string;
}

export interface SyncResult {
  success: boolean;
  pluginResults: PluginSyncResult[];
  totalCopied: number;
  totalFailed: number;
  totalSkipped: number;
  totalGenerated: number;
  /** Paths that were/would be purged per client */
  purgedPaths?: PurgePaths[];
  /** Named artifacts that were deleted and not re-synced by any plugin */
  deletedArtifacts?: DeletedArtifact[];
  error?: string;
  /** Warnings for plugins that were skipped during sync */
  warnings?: string[];
  /** Informational messages (non-warning) */
  messages?: string[];
  /** Results of syncing MCP server configs, keyed by scope (e.g., 'vscode', 'codex') */
  mcpResults?: Record<string, McpMergeResult>;
  /** Result of native CLI plugin installations */
  nativeResult?: NativeSyncResult;
  /** Timing data for sync steps (when available) */
  timing?: {
    totalMs: number;
    steps: Array<{ label: string; durationMs: number; detail?: string }>;
  };
  /** Results of managed repository clone/pull operations */
  managedRepoResults?: import('./managed-repos.js').ManagedRepoResult[];
}

/**
 * Merge two SyncResult objects into one combined result.
 */
export function mergeSyncResults(a: SyncResult, b: SyncResult): SyncResult {
  const warnings = [...(a.warnings || []), ...(b.warnings || [])];
  const messages = [...(a.messages || []), ...(b.messages || [])];
  const purgedPaths = [...(a.purgedPaths || []), ...(b.purgedPaths || [])];
  const deletedArtifacts = [
    ...(a.deletedArtifacts || []),
    ...(b.deletedArtifacts || []),
  ];
  const mcpResults =
    a.mcpResults || b.mcpResults
      ? { ...a.mcpResults, ...b.mcpResults }
      : undefined;
  // Merge native effects in execution order across the two ordinary scopes.
  const nativeResult =
    a.nativeResult && b.nativeResult
      ? mergeNativeSyncResults([a.nativeResult, b.nativeResult])
      : (a.nativeResult ?? b.nativeResult);
  return {
    success: a.success && b.success,
    pluginResults: [...a.pluginResults, ...b.pluginResults],
    totalCopied: a.totalCopied + b.totalCopied,
    totalFailed: a.totalFailed + b.totalFailed,
    totalSkipped: a.totalSkipped + b.totalSkipped,
    totalGenerated: a.totalGenerated + b.totalGenerated,
    ...(warnings.length > 0 && { warnings }),
    ...(messages.length > 0 && { messages }),
    ...(purgedPaths.length > 0 && { purgedPaths }),
    ...(deletedArtifacts.length > 0 && { deletedArtifacts }),
    ...(mcpResults && { mcpResults }),
    ...(nativeResult && { nativeResult }),
    ...(() => {
      const managedRepoResults = [
        ...(a.managedRepoResults || []),
        ...(b.managedRepoResults || []),
      ];
      return managedRepoResults.length > 0 ? { managedRepoResults } : {};
    })(),
    ...mergeTiming(a.timing, b.timing),
  };
}

function mergeTiming(
  a?: SyncResult['timing'],
  b?: SyncResult['timing'],
): { timing: NonNullable<SyncResult['timing']> } | Record<string, never> {
  if (!a && !b) return {};
  const aSteps = (a?.steps ?? []).map((s) => ({
    ...s,
    label: `user:${s.label}`,
  }));
  const bSteps = (b?.steps ?? []).map((s) => ({
    ...s,
    label: `project:${s.label}`,
  }));
  return {
    timing: {
      totalMs: (a?.totalMs ?? 0) + (b?.totalMs ?? 0),
      steps: [...aSteps, ...bSteps],
    },
  };
}

/**
 * Result of syncing a single plugin
 */
export interface PluginSyncResult {
  plugin: string;
  resolved: string;
  success: boolean;
  copyResults: CopyResult[];
  error?: string;
  /** Whether this plugin was synced at project or user scope */
  scope?: 'project' | 'user';
}

/**
 * Options for workspace sync
 */
export interface SyncOptions {
  /** Skip fetching from remote and use cached version if available */
  offline?: boolean;
  /** Simulate sync without making changes */
  dryRun?: boolean;
  /** Overwrite differing MCP entries where the scoped sync supports it. */
  force?: boolean;
  /**
   * Base path for resolving relative workspace.source paths.
   * Used during init to resolve paths relative to the --from source directory
   * instead of the target workspace. If not provided, defaults to workspacePath.
   */
  workspaceSourceBase?: string;
  /** Skip updating AGENTS.md and other generated agent files. Use for plugin-only updates. */
  skipAgentFiles?: boolean;
  /** Skip managed repository clone/pull operations */
  skipManaged?: boolean;
  /**
   * Restrict native mutation to explicit declaration/state identities.
   * Ordinary workspace sync leaves this unset and performs full reconciliation.
   */
  nativeSelection?: {
    mode: 'update' | 'remove';
    targets: readonly string[];
  };
}

/**
 * Result of validating a plugin (resolving its path without copying)
 */
export interface ValidatedPlugin {
  /** Zero-based position of this plugin in the configured plugin list. */
  configurationIndex?: number;
  plugin: string;
  resolved: string;
  success: boolean;
  clients: ClientType[];
  /** Clients that should use native install for this plugin */
  nativeClients: ClientType[];
  error?: string;
  /** Plugin name from marketplace manifest (overrides directory name) */
  pluginName?: string;
  /** Canonical marketplace name when it differs from the spec (e.g., manifest overrides repo name) */
  registeredAs?: string;
  /** GitHub marketplace source (owner/repo) for native CLI registration */
  marketplaceSource?: string;
  /** File artifacts declared by a non-strict marketplace entry. */
  fileArtifacts?: MarketplaceFileArtifacts;
  /** Glob patterns of files to exclude when syncing (from workspace.yaml) */
  exclude?: string[];
  /** Inline skill selection config from plugin entry (v2+) */
  pluginSkillsConfig?: PluginSkillsConfig;
}

export interface PluginSyncPlan {
  /** Zero-based position of this plugin in the configured plugin list. */
  configurationIndex: number;
  source: string;
  clients: ClientType[];
  /** Clients that should use native install for this plugin */
  nativeClients: ClientType[];
  /** Glob patterns of files to exclude when syncing (from workspace.yaml) */
  exclude?: string[];
  /** Inline skill selection config from plugin entry (v2+) */
  pluginSkillsConfig?: PluginSkillsConfig;
}

/**
 * Build a native-friendly plugin spec using the canonical marketplace name.
 * When a marketplace manifest overrides the repo name (e.g., repo "WTG.AI.Prompts"
 * → manifest name "wtg-ai-prompts"), the native CLI only knows the canonical name.
 *
 * Returns the canonical spec and, if applicable, the original owner/repo source
 * needed to pre-register the marketplace with the native CLI.
 */
function resolveNativePluginSource(vp: ValidatedPlugin): {
  spec: string;
  marketplaceSource?: string;
} {
  if (!vp.registeredAs) {
    return {
      spec: vp.plugin,
      ...(vp.marketplaceSource && { marketplaceSource: vp.marketplaceSource }),
    };
  }

  const parsed = parsePluginSpec(vp.plugin);
  if (!parsed) {
    return {
      spec: vp.plugin,
      ...(vp.marketplaceSource && { marketplaceSource: vp.marketplaceSource }),
    };
  }

  const canonicalSpec = `${parsed.plugin}@${vp.registeredAs}`;
  if (parsed.owner && parsed.repo) {
    return {
      spec: canonicalSpec,
      marketplaceSource: `${parsed.owner}/${parsed.repo}`,
    };
  }
  return {
    spec: canonicalSpec,
    ...(vp.marketplaceSource && { marketplaceSource: vp.marketplaceSource }),
  };
}

export function nativeOperationContext(
  client: ClientType,
  scope: 'user' | 'project',
  context: ResolvedClientContext,
): NativeOperationContext {
  return {
    client,
    scope,
    nativeScope: scope,
    root: resolve(context.writeRoot),
    cwd: context.commandCwd,
    env: context.commandEnv,
    ...(context.ompRoots && { roots: { ...context.ompRoots } }),
  };
}

export function nativeContextIdentity(context: NativeOperationContext): string {
  if (context.client !== 'omp') return resolve(context.root);
  const roots = Object.entries(context.roots ?? {})
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, path]) => [name, resolve(path)]);
  return JSON.stringify({
    root: resolve(context.root),
    roots,
  });
}

function nativeLogicalIdentity(
  client: ClientType,
  resource: NativeResource,
): string {
  if (client === 'pi') {
    const packageIdentity = resource.provenance.packageIdentity;
    if (packageIdentity) return `package:${packageIdentity}`;
  }
  return `${resource.kind}:${resource.resolvedIdentity}`;
}

function collectNativeResources(
  validPlugins: ValidatedPlugin[],
  scope: 'user' | 'project',
  contexts: Map<ClientType, ResolvedClientContext>,
): Map<ClientType, NativeResource[]> {
  const resources = new Map<ClientType, NativeResource[]>();
  for (const plugin of validPlugins) {
    const { spec, marketplaceSource } = resolveNativePluginSource(plugin);
    for (const client of plugin.nativeClients) {
      const adapter = getNativeClient(client);
      const context = contexts.get(client);
      if (!adapter || !context) continue;
      const resolution = adapter.resolveSource(
        spec,
        nativeOperationContext(client, scope, context),
        {
          source: plugin.plugin,
          ...(marketplaceSource && { marketplaceSource }),
        },
      );
      if (!resolution.success || !resolution.resource) continue;
      const existing = resources.get(client) ?? [];
      existing.push({
        ...resolution.resource,
        requestedIdentity: plugin.plugin,
      });
      resources.set(client, existing);
    }
  }
  return resources;
}
export function nativeIdentityMatches(
  target: string,
  requestedIdentity: string,
  resolvedIdentity: string,
): boolean {
  if (target === requestedIdentity || target === resolvedIdentity) return true;
  const targetSpec = parsePluginSpec(target);
  const requestedSpec = parsePluginSpec(requestedIdentity);
  const resolvedSpec = parsePluginSpec(resolvedIdentity);
  if (targetSpec) {
    return [requestedSpec, resolvedSpec].some(
      (candidate) =>
        candidate?.plugin === targetSpec.plugin &&
        candidate.marketplaceName === targetSpec.marketplaceName,
    );
  }
  if (requestedSpec?.plugin === target || resolvedSpec?.plugin === target) {
    return true;
  }

  const packageName = (identity: string): string | null => {
    if (!identity.startsWith('npm:')) return null;
    const spec = identity.slice(4);
    const versionSeparator = spec.startsWith('@')
      ? spec.indexOf('@', spec.indexOf('/') + 1)
      : spec.lastIndexOf('@');
    return versionSeparator > 0 ? spec.slice(0, versionSeparator) : spec;
  };
  return (
    packageName(requestedIdentity) === target ||
    packageName(resolvedIdentity) === target
  );
}

function nativeSelectionMatches(
  selection: SyncOptions['nativeSelection'],
  requestedIdentity: string,
  resolvedIdentity: string,
): boolean {
  return (
    !selection ||
    selection.targets.some((target) =>
      nativeIdentityMatches(target, requestedIdentity, resolvedIdentity),
    )
  );
}

async function preflightNativePlans(
  plans: PluginSyncPlan[],
  scope: 'user' | 'project',
  contexts: Map<ClientType, ResolvedClientContext>,
  selection?: SyncOptions['nativeSelection'],
): Promise<string[]> {
  const desiredIdentities = new Map<ClientType, Map<string, string>>();
  const errors: string[] = [];
  const available = new Map<ClientType, boolean>();
  const inspected = new Map<ClientType, string | null>();
  for (const plan of plans) {
    if (
      selection &&
      !nativeSelectionMatches(selection, plan.source, plan.source)
    ) {
      continue;
    }
    for (const client of plan.nativeClients) {
      const adapter = getNativeClient(client);
      const context = contexts.get(client);
      if (!adapter || !context) {
        errors.push(`${client} has no native lifecycle adapter`);
        continue;
      }
      const operationContext = nativeOperationContext(client, scope, context);
      const resolution = adapter.resolveSource(plan.source, operationContext, {
        source: plan.source,
      });
      if (!resolution.success || !resolution.resource) {
        errors.push(resolution.error ?? `${client} rejected '${plan.source}'`);
        continue;
      }
      const logicalIdentity = nativeLogicalIdentity(
        client,
        resolution.resource,
      );
      const clientIdentities = desiredIdentities.get(client) ?? new Map();
      const duplicate = clientIdentities.get(logicalIdentity);
      if (duplicate) {
        errors.push(
          `${client} native declarations '${duplicate}' and '${plan.source}' both resolve to ${logicalIdentity}`,
        );
        continue;
      }
      clientIdentities.set(logicalIdentity, plan.source);
      desiredIdentities.set(client, clientIdentities);
      let cliAvailable = available.get(client);
      if (cliAvailable === undefined) {
        cliAvailable = await adapter.isAvailable(operationContext);
        available.set(client, cliAvailable);
      }
      if (!cliAvailable) {
        errors.push(`${client} CLI is unavailable for required native install`);
        continue;
      }
      if (!inspected.has(client)) {
        const inspection = await adapter.inspect(operationContext);
        inspected.set(
          client,
          inspection.success
            ? null
            : (inspection.error ?? 'native inspection failed'),
        );
      }
      const inspectionError = inspected.get(client);
      if (inspectionError) {
        errors.push(`${client} native inspection failed: ${inspectionError}`);
      }
    }
  }
  return [...new Set(errors)];
}

function nativePreflightFailureResult(
  plans: PluginSyncPlan[],
  scope: 'user' | 'project',
  contexts: Map<ClientType, ResolvedClientContext>,
  errors: string[],
  selection?: SyncOptions['nativeSelection'],
): NativeSyncResult {
  const effects: NativeEffect[] = [];
  for (const plan of plans) {
    if (
      selection &&
      !nativeSelectionMatches(selection, plan.source, plan.source)
    ) {
      continue;
    }
    for (const client of plan.nativeClients) {
      const resolvedContext = contexts.get(client);
      if (!resolvedContext) continue;
      const context = nativeOperationContext(client, scope, resolvedContext);
      const adapter = getNativeClient(client);
      const resolution = adapter?.resolveSource(plan.source, context, {
        source: plan.source,
      });
      const resource: NativeResource = resolution?.resource ?? {
        kind: client === 'pi' ? 'package' : 'plugin',
        requestedIdentity: plan.source,
        resolvedIdentity: plan.source,
        context,
        provenance: { source: plan.source },
      };
      const error =
        errors.find(
          (candidate) =>
            candidate.startsWith(`${client} `) ||
            candidate.startsWith(`${client.toUpperCase()} `) ||
            candidate.includes(`${client} native`),
        ) ?? errors.join('; ');
      effects.push({
        action: 'failed',
        phase: 'inspection',
        changed: false,
        resource,
        error,
      });
    }
  }
  return { success: false, effects };
}

/**
 * Validate a prospective plugin declaration against every native client before
 * a CLI handler edits workspace.yaml or triggers generic source fetching.
 */
export async function preflightNativePluginDeclaration(
  plugin: PluginEntry,
  clientEntries: ClientEntry[],
  scope: 'user' | 'project',
  workspacePath: string,
): Promise<string[]> {
  const { plans, errors } = buildPluginSyncPlans(
    [plugin],
    clientEntries,
    scope,
  );
  if (errors.length > 0) return errors;
  const nativePlans = plans.filter((plan) => plan.nativeClients.length > 0);
  if (nativePlans.length === 0) return [];
  const clients = collectSyncClients(clientEntries, nativePlans);
  const contexts = resolveClientContexts(clients, scope, {
    cwd: workspacePath,
    homeDir: getHomeDir(),
    env: process.env,
  });
  return preflightNativePlans(nativePlans, scope, contexts);
}

export function collectSyncClients(
  clientEntries: ClientEntry[],
  plans: PluginSyncPlan[],
): ClientType[] {
  const workspaceClientTypes = getClientTypes(clientEntries);
  return [
    ...new Set([
      ...workspaceClientTypes,
      ...plans.flatMap((plan) => [...plan.clients, ...plan.nativeClients]),
    ]),
  ];
}

/**
 * Paths that would be purged for a client
 */
export interface PurgePaths {
  client: ClientType;
  paths: string[];
}

/**
 * Purge all managed directories for configured clients
 * This removes commands, skills, hooks directories and agent files
 * @param workspacePath - Path to workspace directory
 * @param clients - List of clients to purge
 * @returns List of paths that were purged per client
 */
export async function purgeWorkspace(
  workspacePath: string,
  clients: ClientType[],
): Promise<PurgePaths[]> {
  const result: PurgePaths[] = [];

  for (const client of clients) {
    const mapping = CLIENT_MAPPINGS[client];
    const purgedPaths: string[] = [];

    // Purge commands directory
    if (mapping.commandsPath) {
      const commandsDir = join(workspacePath, mapping.commandsPath);
      await rm(commandsDir, { recursive: true, force: true });
      purgedPaths.push(mapping.commandsPath);
    }

    // Purge skills directory
    if (mapping.skillsPath) {
      const skillsDir = join(workspacePath, mapping.skillsPath);
      await rm(skillsDir, { recursive: true, force: true });
      purgedPaths.push(mapping.skillsPath);
    }

    // Purge hooks directory
    if (mapping.hooksPath) {
      const hooksDir = join(workspacePath, mapping.hooksPath);
      await rm(hooksDir, { recursive: true, force: true });
      purgedPaths.push(mapping.hooksPath);
    }

    // Purge agents directory
    if (mapping.agentsPath) {
      const agentsDir = join(workspacePath, mapping.agentsPath);
      await rm(agentsDir, { recursive: true, force: true });
      purgedPaths.push(mapping.agentsPath);
    }

    // Purge agent file
    const agentPath = join(workspacePath, mapping.agentFile);
    if (existsSync(agentPath)) {
      await rm(agentPath);
      purgedPaths.push(mapping.agentFile);
    }

    result.push({ client, paths: purgedPaths });
  }

  return result;
}

/**
 * Get paths that would be purged without actually purging
 * @param workspacePath - Path to workspace directory
 * @param clients - List of clients to check
 * @returns List of paths that would be purged per client
 */
export function getPurgePaths(
  workspacePath: string,
  clients: ClientType[],
): PurgePaths[] {
  const result: PurgePaths[] = [];

  for (const client of clients) {
    const mapping = CLIENT_MAPPINGS[client];
    const paths: string[] = [];

    // Check commands directory
    if (
      mapping.commandsPath &&
      existsSync(join(workspacePath, mapping.commandsPath))
    ) {
      paths.push(mapping.commandsPath);
    }

    // Check skills directory
    if (
      mapping.skillsPath &&
      existsSync(join(workspacePath, mapping.skillsPath))
    ) {
      paths.push(mapping.skillsPath);
    }

    // Check hooks directory
    if (
      mapping.hooksPath &&
      existsSync(join(workspacePath, mapping.hooksPath))
    ) {
      paths.push(mapping.hooksPath);
    }

    // Check agents directory
    if (
      mapping.agentsPath &&
      existsSync(join(workspacePath, mapping.agentsPath))
    ) {
      paths.push(mapping.agentsPath);
    }

    // Check agent file
    if (existsSync(join(workspacePath, mapping.agentFile))) {
      paths.push(mapping.agentFile);
    }

    if (paths.length > 0) {
      result.push({ client, paths });
    }
  }

  return result;
}

const MANAGED_DIRECTORY_KEYS = [
  'commandsPath',
  'skillsPath',
  'hooksPath',
  'agentsPath',
  'githubPath',
] as const satisfies readonly (keyof ClientMapping)[];

function resolveTrackedPath(workspacePath: string, filePath: string): string {
  return resolveMappedPath(workspacePath, filePath.replace(/[\\/]$/, ''));
}

function trackedPathIsAllowed(
  workspacePath: string,
  filePath: string,
  mapping: ClientMapping,
  context?: ResolvedClientContext,
): boolean {
  const candidate = resolveTrackedPath(workspacePath, filePath);
  const agentFiles = [mapping.agentFile, mapping.agentFileFallback].filter(
    (path): path is string => path !== undefined,
  );
  if (
    agentFiles.some(
      (path) => resolveMappedPath(workspacePath, path) === candidate,
    )
  ) {
    return true;
  }

  const writeRoot = context?.writeRoot ?? workspacePath;
  if (!pathIsWithin(writeRoot, candidate)) return false;

  return MANAGED_DIRECTORY_KEYS.some((key) => {
    const mappedPath = mapping[key];
    return Boolean(
      mappedPath &&
        pathIsWithin(resolveMappedPath(workspacePath, mappedPath), candidate),
    );
  });
}

/**
 * Selectively purge only files that were previously synced
 * Non-destructive: preserves user-created files
 * @param workspacePath - Path to workspace directory
 * @param state - Previous sync state (if null, skips purge entirely)
 * @param clients - List of clients to purge files for
 * @returns List of paths that were purged per client
 */
export async function selectivePurgeWorkspace(
  workspacePath: string,
  state: SyncState | null,
  clients: ClientType[],
  clientMappings: Record<string, ClientMapping> = CLIENT_MAPPINGS,
  clientContexts?: ReadonlyMap<ClientType, ResolvedClientContext>,
): Promise<PurgePaths[]> {
  // First sync - no state, skip purge entirely (safe overlay)
  if (!state) {
    return [];
  }

  const result: PurgePaths[] = [];

  // Include both current clients AND clients that were removed from config.
  const previousClients = Object.keys(state.files) as ClientType[];
  const clientsToProcess = [...new Set([...clients, ...previousClients])];

  for (const client of clientsToProcess) {
    const previousFiles = getPreviouslySyncedFiles(state, client);
    const mapping = clientMappings[client];
    if (!mapping) continue;
    const context = clientContexts?.get(client);
    const purgedPaths: string[] = [];

    for (const filePath of previousFiles) {
      if (!trackedPathIsAllowed(workspacePath, filePath, mapping, context)) {
        continue;
      }
      const cleanPath = resolveTrackedPath(workspacePath, filePath);
      let stats: Stats;
      try {
        stats = lstatSync(cleanPath);
      } catch {
        continue;
      }

      try {
        await assertSafeDestination(
          context?.writeRoot ?? workspacePath,
          cleanPath,
          { allowFinalSymlink: true },
        );
        if (stats.isSymbolicLink()) {
          await unlink(cleanPath);
        } else if (filePath.endsWith('/') || filePath.endsWith('\\')) {
          await rm(cleanPath, { recursive: true, force: true });
        } else {
          await unlink(cleanPath);
        }
        purgedPaths.push(filePath);
        await cleanupEmptyParents(
          context?.writeRoot ?? workspacePath,
          cleanPath,
        );
      } catch {
        // Best effort - continue with other files
      }
    }

    if (purgedPaths.length > 0) {
      result.push({ client, paths: purgedPaths });
    }
  }

  return result;
}

/**
 * Clean up empty parent directories after file deletion.
 * The resolved write root itself is never removed.
 */
async function cleanupEmptyParents(
  writeRoot: string,
  deletedPath: string,
): Promise<void> {
  const root = resolve(writeRoot);
  let parentPath = dirname(deletedPath);

  while (parentPath !== root && pathIsWithin(root, parentPath)) {
    if (!existsSync(parentPath)) {
      parentPath = dirname(parentPath);
      continue;
    }

    try {
      await assertSafeDestination(root, parentPath);
      await rmdir(parentPath);
      parentPath = dirname(parentPath);
    } catch {
      break;
    }
  }
}

/**
 * Collected GitHub repository info for file sources
 */
interface GitHubRepoInfo {
  owner: string;
  repo: string;
  key: string; // "owner/repo" for deduplication
}

/**
 * Collect unique GitHub repositories from workspace file sources
 * @param files - Array of workspace file entries
 * @returns Array of unique GitHub repo info
 */
/**
 * Check if a source string is an explicit GitHub reference (for repo collection)
 * More conservative than isGitHubUrl - requires 3+ segments for shorthand format
 */
function isExplicitGitHubSourceForCollection(source: string): boolean {
  if (
    source.startsWith('https://github.com/') ||
    source.startsWith('http://github.com/') ||
    source.startsWith('github.com/') ||
    source.startsWith('gh:')
  ) {
    return true;
  }

  // For shorthand format, require at least 3 segments (owner/repo/path)
  if (
    !source.startsWith('.') &&
    !source.startsWith('/') &&
    source.includes('/')
  ) {
    const parts = source.split('/');
    if (parts.length >= 3) {
      const validOwnerRepo = /^[a-zA-Z0-9_.-]+$/;
      if (
        parts[0] &&
        parts[1] &&
        validOwnerRepo.test(parts[0]) &&
        validOwnerRepo.test(parts[1])
      ) {
        return true;
      }
    }
  }

  return false;
}

function collectGitHubReposFromFiles(files: WorkspaceFile[]): GitHubRepoInfo[] {
  const repos = new Map<string, GitHubRepoInfo>();

  for (const file of files) {
    // Only object entries can have explicit GitHub sources
    if (typeof file === 'string') {
      continue;
    }

    // Check if the file has an explicit source that's a GitHub URL
    // Use conservative check to avoid treating local paths like "config/file.json" as GitHub
    if (file.source && isExplicitGitHubSourceForCollection(file.source)) {
      const parsed = parseFileSource(file.source);
      if (parsed.type === 'github' && parsed.owner && parsed.repo) {
        const key = `${parsed.owner}/${parsed.repo}`;
        if (!repos.has(key)) {
          repos.set(key, {
            owner: parsed.owner,
            repo: parsed.repo,
            key,
          });
        }
      }
    }
  }

  return Array.from(repos.values());
}

/**
 * Fetch GitHub repositories for file sources and build cache map
 * @param repos - Array of GitHub repo info to fetch
 * @returns Map from "owner/repo" to cache path, and any errors
 */
async function fetchFileSourceRepos(
  repos: GitHubRepoInfo[],
): Promise<{ cache: Map<string, string>; errors: string[] }> {
  const cache = new Map<string, string>();
  const errors: string[] = [];

  for (const repo of repos) {
    // File sources always pull latest (default behavior)
    const result = await fetchPlugin(`${repo.owner}/${repo.repo}`);

    if (result.success) {
      cache.set(repo.key, result.cachePath);
    } else {
      errors.push(
        `Failed to fetch ${repo.key}: ${result.error || 'Unknown error'}`,
      );
    }
  }

  return { cache, errors };
}

/**
 * Check if a source string is an explicit GitHub reference (for validation)
 * Matches the logic in transform.ts isExplicitGitHubSource
 */
function isExplicitGitHubSourceForValidation(source: string): boolean {
  if (
    source.startsWith('https://github.com/') ||
    source.startsWith('http://github.com/') ||
    source.startsWith('github.com/') ||
    source.startsWith('gh:')
  ) {
    return true;
  }

  // For shorthand format, require at least 3 segments (owner/repo/path)
  if (
    !source.startsWith('.') &&
    !source.startsWith('/') &&
    source.includes('/')
  ) {
    const parts = source.split('/');
    if (parts.length >= 3) {
      const validOwnerRepo = /^[a-zA-Z0-9_.-]+$/;
      if (
        parts[0] &&
        parts[1] &&
        validOwnerRepo.test(parts[0]) &&
        validOwnerRepo.test(parts[1])
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Validate that file sources exist (for GitHub sources, check path in cache)
 * @param files - Array of workspace file entries
 * @param defaultSourcePath - Default source path for files without explicit source
 * @param githubCache - Map of owner/repo to cache paths
 * @returns Array of validation errors
 */
function validateFileSources(
  files: WorkspaceFile[],
  defaultSourcePath: string | undefined,
  githubCache: Map<string, string>,
): string[] {
  const errors: string[] = [];

  for (const file of files) {
    if (typeof file === 'string') {
      // String entries are resolved relative to defaultSourcePath
      if (!defaultSourcePath) {
        errors.push(
          `Cannot resolve file '${file}' - no workspace.source configured`,
        );
        continue;
      }
      const fullPath = join(defaultSourcePath, file);
      if (!existsSync(fullPath)) {
        errors.push(`File source not found: ${fullPath}`);
      }
      continue;
    }

    // Object entry
    if (file.source) {
      // Has explicit source - check if it's GitHub or local
      if (isExplicitGitHubSourceForValidation(file.source)) {
        // GitHub source - validate path exists in cache
        const parsed = parseFileSource(file.source);
        if (!parsed.owner || !parsed.repo || !parsed.filePath) {
          errors.push(
            `Invalid GitHub file source: ${file.source}. Must include path to file.`,
          );
          continue;
        }
        const cacheKey = `${parsed.owner}/${parsed.repo}`;
        const cachePath = githubCache.get(cacheKey);
        if (!cachePath) {
          errors.push(`GitHub cache not found for ${cacheKey}`);
          continue;
        }
        const fullPath = join(cachePath, parsed.filePath);
        if (!existsSync(fullPath)) {
          errors.push(
            `Path not found in repository: ${cacheKey}/${parsed.filePath}`,
          );
        }
      } else {
        // Local path with explicit source
        let fullPath: string;
        if (file.source.startsWith('/')) {
          // Absolute path
          fullPath = file.source;
        } else if (file.source.startsWith('../')) {
          // Relative path going "up" - resolve from workspace root (cwd)
          fullPath = resolve(file.source);
        } else if (defaultSourcePath) {
          // Relative path within source - resolve from defaultSourcePath
          fullPath = join(defaultSourcePath, file.source);
        } else {
          // No defaultSourcePath - resolve from cwd
          fullPath = resolve(file.source);
        }
        if (!existsSync(fullPath)) {
          errors.push(`File source not found: ${fullPath}`);
        }
      }
    } else {
      // No explicit source - resolve relative to defaultSourcePath
      if (!defaultSourcePath) {
        errors.push(
          `Cannot resolve file '${file.dest}' - no workspace.source configured and no explicit source provided`,
        );
        continue;
      }
      const fullPath = join(defaultSourcePath, file.dest ?? '');
      if (!existsSync(fullPath)) {
        errors.push(`File source not found: ${fullPath}`);
      }
    }
  }

  return errors;
}

/**
 * Collect synced file paths from copy results, grouped by client
 *
 * When multiple clients share the same skillsPath (e.g., copilot, codex, opencode
 * all use `.agents/skills/`), the file is tracked for ALL clients that share that path.
 * This ensures proper cleanup when any of those clients is removed from the config.
 *
 * @param copyResults - Array of copy results from plugins
 * @param workspacePath - Path to workspace directory
 * @param clients - List of clients to track
 * @param clientMappings - Optional client path mappings (defaults to CLIENT_MAPPINGS)
 * @returns Per-client file lists
 */
export function collectSyncedPaths(
  copyResults: CopyResult[],
  workspacePath: string,
  clients: ClientType[],
  clientMappings?: Record<string, ClientMapping>,
  agentDedupeRecords?: AgentDedupeRecord[],
  clientContexts?: ReadonlyMap<ClientType, ResolvedClientContext>,
): Partial<Record<ClientType, string[]>> {
  const result: Partial<Record<ClientType, string[]>> = {};
  const mappings = clientMappings ?? CLIENT_MAPPINGS;
  const absoluteWorkspace = resolve(workspacePath);

  for (const client of clients) {
    result[client] = [];
  }

  for (const copyResult of copyResults) {
    if (copyResult.action !== 'copied' && copyResult.action !== 'generated') {
      continue;
    }
    const destination = resolve(copyResult.destination);

    for (const client of clients) {
      const mapping = mappings[client];
      if (!mapping) continue;
      const context = clientContexts?.get(client);
      const agentFileDestinations = [
        mapping.agentFile,
        mapping.agentFileFallback,
      ]
        .filter((path): path is string => path !== undefined)
        .map((path) => resolveMappedPath(workspacePath, path));
      const belongsToAgentFile = agentFileDestinations.includes(destination);
      if (
        context &&
        !pathIsWithin(context.writeRoot, destination) &&
        !belongsToAgentFile
      ) {
        continue;
      }

      const trackedPath = (
        pathIsWithin(absoluteWorkspace, destination)
          ? relative(absoluteWorkspace, destination)
          : destination
      ).replaceAll('\\', '/');
      const skillsRoot = resolveMappedPath(workspacePath, mapping.skillsPath);
      if (pathIsWithin(skillsRoot, destination)) {
        const skillName = relative(skillsRoot, destination);
        if (
          skillName &&
          !skillName.includes('/') &&
          !skillName.includes('\\')
        ) {
          result[client]?.push(`${trackedPath}/`);
          continue;
        }
      }

      const directoryRoots = MANAGED_DIRECTORY_KEYS.map((key) => mapping[key])
        .filter((path): path is string => path !== undefined)
        .map((path) => resolveMappedPath(workspacePath, path));
      const belongsToDirectory = directoryRoots.some((root) =>
        pathIsWithin(root, destination),
      );

      if (belongsToDirectory || belongsToAgentFile) {
        result[client]?.push(trackedPath);
      }
    }
  }

  // A dedupe record is proof that both exact copies succeeded and the
  // portable representation was removed. The preferred GitHub path is already
  // tracked by its own CopyResult; never synthesize ownership here.
  if (agentDedupeRecords && agentDedupeRecords.length > 0) {
    for (const client of clients) {
      const mapping = mappings[client];
      if (!mapping.agentsPath) continue;
      const tracked = result[client];
      if (!tracked) continue;

      for (const record of agentDedupeRecords) {
        if (!record.removedPath.startsWith(mapping.agentsPath)) continue;
        const removedIndex = tracked.indexOf(record.removedPath);
        if (removedIndex !== -1) tracked.splice(removedIndex, 1);
      }
    }
  }

  return result;
}

/**
 * Classify a single sync-state path into a named artifact for a given client.
 * Returns null for paths that are not top-level artifacts or not part of the
 * managed artifact directories (e.g. files nested inside a skill directory are
 * skipped – the skill directory entry itself is sufficient).
 */
function classifyDeletedPath(
  path: string,
  client: ClientType,
  mapping: ClientMapping,
): DeletedArtifact | null {
  // Skills are tracked as "<skillsPath><name>/" (trailing slash) by collectSyncedPaths.
  // Files inside a skill directory are also stored, but we skip them to avoid duplicates.
  if (mapping.skillsPath && path.startsWith(mapping.skillsPath)) {
    const rest = path.slice(mapping.skillsPath.length);
    if (rest.endsWith('/') && !rest.slice(0, -1).includes('/')) {
      return { client, type: 'skill', name: rest.slice(0, -1) };
    }
    return null;
  }

  if (mapping.commandsPath && path.startsWith(mapping.commandsPath)) {
    const rest = path.slice(mapping.commandsPath.length);
    const topLevel = rest.split('/')[0];
    if (!topLevel) return null;
    return { client, type: 'command', name: topLevel.replace(/\.md$/i, '') };
  }

  if (mapping.hooksPath && path.startsWith(mapping.hooksPath)) {
    const rest = path.slice(mapping.hooksPath.length);
    const topLevel = rest.split('/')[0];
    if (!topLevel) return null;
    return { client, type: 'hook', name: topLevel.replace(/\.md$/i, '') };
  }

  if (mapping.agentsPath && path.startsWith(mapping.agentsPath)) {
    const rest = path.slice(mapping.agentsPath.length);
    const topLevel = rest.split('/')[0];
    if (!topLevel) return null;
    return {
      client,
      type: 'agent',
      name: topLevel.replace(/(?:\.agent)?\.md$/i, ''),
    };
  }

  return null;
}

/**
 * Compute which named artifacts were deleted during sync by comparing the
 * previous sync state with the paths that were re-synced in this run.
 *
 * An artifact is considered deleted when it existed in the previous state but
 * is not present in the new state (i.e. no plugin re-provided it).
 *
 * Skills that are still available in installed plugins but just not synced
 * (disabled via --skill) are excluded — they are not truly deleted.
 */
export function computeDeletedArtifacts(
  previousState: SyncState | null,
  newStatePaths: Partial<Record<ClientType, string[]>>,
  clients: ClientType[],
  clientMappings: Record<string, ClientMapping>,
  availableSkillNames?: Set<string>,
  agentDedupeRecords: AgentDedupeRecord[] = [],
): DeletedArtifact[] {
  if (!previousState) return [];

  const deleted: DeletedArtifact[] = [];
  const seen = new Set<string>();
  const representationAliases = new Map(
    agentDedupeRecords.map((record) => [record.removedPath, record.keptPath]),
  );

  for (const client of clients) {
    const oldPaths = previousState.files[client] ?? [];
    const newPaths = new Set(newStatePaths[client] ?? []);
    const mapping = clientMappings[client];
    if (!mapping) continue;

    for (const path of oldPaths) {
      const replacement = representationAliases.get(path);
      if (
        newPaths.has(path) ||
        (replacement !== undefined && newPaths.has(replacement))
      ) {
        continue;
      }

      const artifact = classifyDeletedPath(path, client, mapping);
      if (!artifact) continue;

      // Skip skills that still exist in installed plugins but are just disabled
      if (artifact.type === 'skill' && availableSkillNames?.has(artifact.name))
        continue;

      const key = `${client}:${artifact.type}:${artifact.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        deleted.push(artifact);
      }
    }
  }

  return deleted;
}

/**
 * Collect all skill folder names from installed plugins, regardless of
 * enabled/disabled state. Used by computeDeletedArtifacts to distinguish
 * truly deleted skills from ones that are just disabled.
 */
async function collectAvailableSkillNames(
  validPlugins: ValidatedPlugin[],
  warnings?: string[],
): Promise<Set<string>> {
  const names = new Set<string>();
  for (const plugin of validPlugins) {
    if (plugin.fileArtifacts && !plugin.fileArtifacts.skills) continue;
    const skills = await collectPluginSkills(
      plugin.resolved,
      plugin.plugin,
      undefined,
      undefined,
      undefined,
      undefined,
      warnings,
    );
    for (const skill of skills) {
      names.add(skill.folderName);
    }
  }
  return names;
}

/**
 * Validate a single plugin by resolving its path without copying
 * @param workspacePath - Path to workspace directory
 * @param offline - Skip fetching from remote and use cached version
 * @returns Validation result with resolved path
 */
async function validatePlugin(
  pluginSource: string,
  workspacePath: string,
  offline: boolean,
): Promise<ValidatedPlugin> {
  // Check for plugin@marketplace format first
  if (isPluginSpec(pluginSource)) {
    const resolved = await resolvePluginSpecWithAutoRegister(pluginSource, {
      offline,
      workspacePath,
    });
    if (!resolved.success) {
      return {
        plugin: pluginSource,
        resolved: '',
        success: false,
        clients: [],
        nativeClients: [],
        error: resolved.error || 'Unknown error',
      };
    }
    return {
      plugin: pluginSource,
      resolved: resolved.path ?? '',
      success: true,
      clients: [],
      nativeClients: [],
      ...(resolved.pluginName && { pluginName: resolved.pluginName }),
      ...(resolved.registeredAs && { registeredAs: resolved.registeredAs }),
      ...(resolved.marketplaceSource && {
        marketplaceSource: resolved.marketplaceSource,
      }),
      ...(resolved.fileArtifacts && {
        fileArtifacts: resolved.fileArtifacts,
      }),
    };
  }

  if (isGitHubUrl(pluginSource)) {
    // Parse URL to extract branch and subpath
    const parsed = parseGitHubUrl(pluginSource);

    // Fetch remote plugin (with offline option and branch if specified)
    const fetchResult = await fetchPlugin(pluginSource, {
      offline,
      ...(parsed?.branch && { branch: parsed.branch }),
    });
    if (!fetchResult.success) {
      return {
        plugin: pluginSource,
        resolved: '',
        success: false,
        clients: [],
        nativeClients: [],
        ...(fetchResult.error && { error: fetchResult.error }),
      };
    }
    // Handle subpath in GitHub URL (e.g., /tree/main/plugins/name)
    const resolvedPath = parsed?.subpath
      ? join(fetchResult.cachePath, parsed.subpath)
      : fetchResult.cachePath;
    const fileArtifacts = await getEmbeddedMarketplaceFileArtifacts(
      resolvedPath,
      parsed?.repo,
    );
    return {
      plugin: pluginSource,
      resolved: resolvedPath,
      success: true,
      clients: [],
      nativeClients: [],
      ...(fileArtifacts && { fileArtifacts }),
    };
  }

  // Local plugin
  const resolvedPath = resolve(workspacePath, pluginSource);
  if (!existsSync(resolvedPath)) {
    return {
      plugin: pluginSource,
      resolved: resolvedPath,
      success: false,
      clients: [],
      nativeClients: [],
      error: `Plugin not found at ${resolvedPath}`,
    };
  }
  const fileArtifacts = await getEmbeddedMarketplaceFileArtifacts(
    resolvedPath,
    getPluginName(resolvedPath),
  );
  return {
    plugin: pluginSource,
    resolved: resolvedPath,
    success: true,
    clients: [],
    nativeClients: [],
    ...(fileArtifacts && { fileArtifacts }),
  };
}

/**
 * Build plugin sync plans with effective clients per plugin.
 * Effective clients are plugin.clients when provided, otherwise workspace clients.
 */
export function buildPluginSyncPlans(
  plugins: PluginEntry[],
  clientEntries: ClientEntry[],
  scope: 'user' | 'project',
): { plans: PluginSyncPlan[]; warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  const workspaceClientTypes = getClientTypes(clientEntries);

  const plans = plugins.map((plugin, configurationIndex) => {
    const source = getEffectivePluginSource(plugin);
    const pluginClientTypes = getPluginClients(plugin) ?? workspaceClientTypes;

    if (pluginClientTypes.length === 0) {
      warnings.push(
        `${source} has no clients configured and was not synced. Add clients to workspace.yaml or specify clients on the plugin entry.`,
      );
    }

    const fileClients: ClientType[] = [];
    const nativeClients: ClientType[] = [];
    for (const client of pluginClientTypes) {
      const clientEntry = normalizeClientEntry(
        clientEntries.find(
          (entry) =>
            (typeof entry === 'string' ? entry : entry.name) === client,
        ) ?? client,
      );
      if (resolveInstallMode(plugin, clientEntry) === 'file') {
        fileClients.push(client);
        continue;
      }

      const adapter = getNativeClient(client);
      if (!adapter) {
        errors.push(
          `${client} does not support explicit native install for '${source}'`,
        );
        continue;
      }
      if (!adapter.supportsScope(scope)) {
        errors.push(
          `${client} does not support explicit native install at ${scope} scope for '${source}'`,
        );
        continue;
      }
      const classification = adapter.resolveSource(source, {
        client,
        scope,
        nativeScope: scope,
        root: '',
      });
      if (!classification.success) {
        errors.push(
          classification.error ??
            `${client} does not support native source '${source}'`,
        );
        continue;
      }
      nativeClients.push(client);
    }

    const exclude = getPluginExclude(plugin);
    const pluginSkillsConfig =
      typeof plugin === 'string' ? undefined : plugin.skills;
    return {
      configurationIndex,
      source,
      clients: fileClients,
      nativeClients,
      ...(exclude && { exclude }),
      ...(pluginSkillsConfig !== undefined && { pluginSkillsConfig }),
    };
  });

  return { plans, warnings, errors: [...new Set(errors)] };
}

/**
 * Validate all plugins before any destructive action
 * @param plans - List of plugin sync plans
 * @param workspacePath - Path to workspace directory
 * @param offline - Skip fetching from remote and use cached version
 * @returns Array of validation results
 */
export async function validateAllPlugins(
  plans: PluginSyncPlan[],
  workspacePath: string,
  offline: boolean,
): Promise<ValidatedPlugin[]> {
  return Promise.all(
    plans.map(
      async ({
        configurationIndex,
        source,
        clients,
        nativeClients,
        exclude,
        pluginSkillsConfig,
      }) => {
        let validated: ValidatedPlugin;
        if (clients.length === 0 && nativeClients.length > 0) {
          const parsed = parsePluginSpec(source);
          const marketplace = parsed
            ? await getMarketplace(parsed.marketplaceName, workspacePath)
            : null;
          const declaredMarketplaceSource =
            parsed?.owner && parsed.repo
              ? `${parsed.owner}/${parsed.repo}`
              : undefined;
          validated = {
            plugin: source,
            resolved: '',
            success: true,
            clients: [],
            nativeClients: [],
            ...(parsed && { pluginName: parsed.plugin }),
            ...(parsed && {
              registeredAs: marketplace?.name ?? parsed.marketplaceName,
            }),
            ...(declaredMarketplaceSource
              ? { marketplaceSource: declaredMarketplaceSource }
              : marketplace?.source.type === 'github'
                ? { marketplaceSource: marketplace.source.location }
                : {}),
          };
        } else {
          validated = await validatePlugin(source, workspacePath, offline);
        }
        const result: ValidatedPlugin = {
          ...validated,
          configurationIndex,
          clients,
          nativeClients,
        };
        if (exclude) result.exclude = exclude;
        if (pluginSkillsConfig !== undefined) {
          result.pluginSkillsConfig = pluginSkillsConfig;
        }
        return result;
      },
    ),
  );
}

/**
 * Copy content from a validated plugin to workspace
 *
 * Uses deduplication to avoid copying skills multiple times when clients share
 * the same skillsPath. For example, if copilot, codex, and opencode all use
 * `.agents/skills/`, skills will only be copied once.
 *
 * When syncMode is 'symlink':
 * 1. First copy skills to canonical .agents/skills/ location
 * 2. For non-universal clients, create symlinks from their paths to canonical
 *
 * @param validatedPlugin - Already validated plugin with resolved path
 * @param workspacePath - Path to workspace directory
 * @param clients - List of clients to sync for
 * @param dryRun - Simulate without making changes
 * @param skillNameMap - Optional map of skill folder names to resolved names
 * @param clientMappings - Optional client path mappings (defaults to CLIENT_MAPPINGS)
 * @param syncMode - Sync mode ('symlink' or 'copy', defaults to 'symlink')
 * @returns Plugin sync result
 */
async function copyValidatedPlugin(
  validatedPlugin: ValidatedPlugin,
  workspacePath: string,
  clients: ClientType[],
  dryRun: boolean,
  skillNameMap?: Map<string, string>,
  clientMappings?: Record<string, ClientMapping>,
  syncMode: SyncMode = 'symlink',
  agentOutputs: readonly AgentOutput[] = [],
  agentConflicts: readonly AgentOutputConflict[] = [],
  agentFailures: readonly AgentOutputFailure[] = [],
  clientWriteRoots: Partial<Record<ClientType, string>> = {},
): Promise<PluginSyncResult> {
  const copyResults: CopyResult[] = [];
  let agentOutputsAssigned = false;
  const mappings = resolveClientMappings(
    clients,
    clientMappings ?? CLIENT_MAPPINGS,
  );
  const clientList = clients;

  const exclude = validatedPlugin.exclude;

  const hasUniversalClient = clientList.some((c) => isUniversalClient(c));

  if (syncMode === 'symlink' && hasUniversalClient) {
    // Symlink mode with universal: copy to canonical .agents/skills/, symlink from client paths
    //
    // Phase 1: Copy skills to canonical location using deduplication
    // This ensures canonical is only copied once, and tracked under the universal client
    const { representativeClients } = deduplicateClientsByPath(
      clientList,
      mappings,
    );

    // Phase 2: Copy for each representative client
    for (const representative of representativeClients) {
      if (isUniversalClient(representative)) {
        // Universal client: copy directly to canonical .agents/skills/
        const results = await copyPluginToWorkspace(
          validatedPlugin.resolved,
          workspacePath,
          representative,
          {
            dryRun,
            ...(skillNameMap && { skillNameMap }),
            clientMappings: mappings,
            writeRoot: clientWriteRoots[representative] ?? workspacePath,
            syncMode: 'copy',
            agentOutputs: agentOutputsAssigned ? [] : agentOutputs,
            ...(exclude && { exclude }),
            ...(validatedPlugin.fileArtifacts && {
              fileArtifacts: validatedPlugin.fileArtifacts,
            }),
          },
        );
        agentOutputsAssigned = true;
        copyResults.push(...results);
      } else {
        // Non-universal client: create symlinks to canonical
        const results = await copyPluginToWorkspace(
          validatedPlugin.resolved,
          workspacePath,
          representative,
          {
            dryRun,
            ...(skillNameMap && { skillNameMap }),
            clientMappings: mappings,
            writeRoot: clientWriteRoots[representative] ?? workspacePath,
            syncMode: 'symlink',
            canonicalSkillsPath: CANONICAL_SKILLS_PATH,
            agentOutputs: agentOutputsAssigned ? [] : agentOutputs,
            ...(exclude && { exclude }),
            ...(validatedPlugin.fileArtifacts && {
              fileArtifacts: validatedPlugin.fileArtifacts,
            }),
          },
        );
        agentOutputsAssigned = true;
        copyResults.push(...results);
      }
    }
  } else {
    // No universal client or copy mode: copy directly to each client's path
    const { representativeClients } = deduplicateClientsByPath(
      clientList,
      mappings,
    );

    for (const client of representativeClients) {
      const results = await copyPluginToWorkspace(
        validatedPlugin.resolved,
        workspacePath,
        client,
        {
          dryRun,
          ...(skillNameMap && { skillNameMap }),
          clientMappings: mappings,
          writeRoot: clientWriteRoots[client] ?? workspacePath,
          syncMode: 'copy',
          agentOutputs: agentOutputsAssigned ? [] : agentOutputs,
          ...(exclude && { exclude }),
          ...(validatedPlugin.fileArtifacts && {
            fileArtifacts: validatedPlugin.fileArtifacts,
          }),
        },
      );
      agentOutputsAssigned = true;
      copyResults.push(...results);
    }
  }
  for (const { loser } of agentConflicts) {
    copyResults.push({
      source: loser.source,
      destination: loser.destination,
      action: 'skipped',
    });
  }
  for (const failure of agentFailures) {
    copyResults.push({
      source: failure.source,
      destination: failure.destination,
      action: 'failed',
      error: failure.error,
    });
  }

  const hasFailures = copyResults.some((r) => r.action === 'failed');

  return {
    plugin: validatedPlugin.plugin,
    resolved: validatedPlugin.resolved,
    success: !hasFailures,
    copyResults,
  };
}

/**
 * Collected skill information with plugin context for name resolution
 */
interface CollectedSkillEntry {
  /** Skill folder name */
  folderName: string;
  /** Plugin name (directory name) */
  pluginName: string;
  /** Plugin source reference */
  pluginSource: string;
  /** Resolved plugin path */
  pluginPath: string;
}

/**
 * Collect all skills from all validated plugins
 * This is the first pass of two-pass name resolution
 * @param validatedPlugins - Array of validated plugins with resolved paths
 * @param disabledSkills - Optional set of disabled skill keys (v1 fallback)
 * @param enabledSkills - Optional set of enabled skill keys (v1 fallback)
 * @returns Array of collected skill entries
 */
async function collectAllSkills(
  validatedPlugins: ValidatedPlugin[],
  disabledSkills?: Set<string>,
  enabledSkills?: Set<string>,
  warnings?: string[],
): Promise<CollectedSkillEntry[]> {
  const allSkills: CollectedSkillEntry[] = [];

  for (const plugin of validatedPlugins) {
    if (plugin.fileArtifacts && !plugin.fileArtifacts.skills) continue;
    const pluginName = plugin.pluginName ?? getPluginName(plugin.resolved);
    const skills = await collectPluginSkills(
      plugin.resolved,
      plugin.plugin,
      disabledSkills,
      pluginName,
      enabledSkills,
      plugin.pluginSkillsConfig,
      warnings,
    );

    for (const skill of skills) {
      allSkills.push({
        folderName: skill.folderName,
        pluginName,
        pluginSource: plugin.plugin,
        pluginPath: plugin.resolved,
      });
    }
  }

  return allSkills;
}

/**
 * Build skill name maps for each plugin based on resolved names
 * @param allSkills - Collected skills from all plugins
 * @returns Map from plugin path to skill name map (folder name -> resolved name)
 */
function buildPluginSkillNameMaps(
  allSkills: CollectedSkillEntry[],
): Map<string, Map<string, string>> {
  // Convert to SkillEntry format for resolver
  const skillEntries: SkillEntry[] = allSkills.map((skill) => ({
    folderName: skill.folderName,
    pluginName: skill.pluginName,
    pluginSource: skill.pluginSource,
  }));

  // Resolve names using the skill name resolver
  const resolution = resolveSkillNames(skillEntries);

  // Build per-plugin maps
  const pluginMaps = new Map<string, Map<string, string>>();

  for (let i = 0; i < allSkills.length; i++) {
    const skill = allSkills[i];
    const entry = skillEntries[i];
    if (!skill || !entry) continue;
    const resolvedName = resolution.nameMap.get(getSkillKey(entry));

    if (resolvedName) {
      let pluginMap = pluginMaps.get(skill.pluginPath);
      if (!pluginMap) {
        pluginMap = new Map<string, string>();
        pluginMaps.set(skill.pluginPath, pluginMap);
      }
      pluginMap.set(skill.folderName, resolvedName);
    }
  }

  return pluginMaps;
}

const VSCODE_TEMPLATE_FILE = 'template.code-workspace';

/**
 * Generate a VSCode .code-workspace file from workspace config.
 * Called automatically during sync when 'vscode' client is configured.
 */
function generateVscodeWorkspaceFile(
  workspacePath: string,
  config: WorkspaceConfig,
): string {
  const configDir = join(workspacePath, CONFIG_DIR);

  // Load template if it exists (supports JSON with comments via JSON5)
  const templatePath = join(configDir, VSCODE_TEMPLATE_FILE);
  let template: Record<string, unknown> | undefined;
  if (existsSync(templatePath)) {
    try {
      template = JSON5.parse(readFileSync(templatePath, 'utf-8'));
    } catch (error) {
      throw new Error(
        `Failed to parse ${templatePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const content = generateVscodeWorkspace({
    workspacePath,
    repositories: config.repositories,
    template,
  });

  const outputPath = getWorkspaceOutputPath(workspacePath, config.vscode);
  const contentStr = `${JSON.stringify(content, null, '\t')}\n`;
  writeFileSync(outputPath, contentStr, 'utf-8');
  return contentStr;
}

function failedSyncResult(
  error: string,
  overrides?: Partial<SyncResult>,
): SyncResult {
  return {
    success: false,
    pluginResults: [],
    totalCopied: 0,
    totalFailed: 0,
    totalSkipped: 0,
    totalGenerated: 0,
    error,
    ...overrides,
  };
}

function countCopyResults(
  pluginResults: PluginSyncResult[],
  workspaceFileResults: CopyResult[],
): {
  totalCopied: number;
  totalFailed: number;
  totalSkipped: number;
  totalGenerated: number;
} {
  let totalCopied = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  let totalGenerated = 0;

  for (const pluginResult of pluginResults) {
    for (const copyResult of pluginResult.copyResults) {
      switch (copyResult.action) {
        case 'copied':
          totalCopied++;
          break;
        case 'failed':
          totalFailed++;
          break;
        case 'skipped':
          totalSkipped++;
          break;
        case 'generated':
          totalGenerated++;
          break;
      }
    }
  }

  for (const result of workspaceFileResults) {
    switch (result.action) {
      case 'copied':
        totalCopied++;
        break;
      case 'generated':
        totalGenerated++;
        break;
      case 'failed':
        totalFailed++;
        break;
      case 'skipped':
        totalSkipped++;
        break;
    }
  }

  return { totalCopied, totalFailed, totalSkipped, totalGenerated };
}

function nativeStateKey(resource: NativeStateResource): string {
  return JSON.stringify([
    resource.client,
    resource.scope,
    resource.nativeScope,
    resource.kind,
    resource.requestedIdentity,
    resource.resolvedIdentity,
    resource.context,
  ]);
}

function stateFromNativeResource(
  resource: NativeResource,
  transition: NativeStateResource['transition'],
  error?: string,
): NativeStateResource {
  return {
    client: resource.context.client as ClientType,
    scope: resource.context.scope,
    nativeScope: resource.context.nativeScope,
    kind: resource.kind,
    requestedIdentity: resource.requestedIdentity,
    resolvedIdentity: resource.resolvedIdentity,
    context: nativeContextIdentity(resource.context),
    root: resolve(resource.context.root),
    provenance: sanitizeNativeProvenance(resource.provenance),
    transition,
    ...(error && { error }),
  };
}

function nativeResourceFromState(
  state: NativeStateResource,
  context: NativeOperationContext,
): NativeResource {
  return {
    kind: state.kind,
    requestedIdentity: state.requestedIdentity,
    resolvedIdentity: state.resolvedIdentity,
    context: { ...context, root: state.root ?? context.root },
    provenance: state.provenance,
  };
}

async function syncNativePlugins(
  validPlugins: ValidatedPlugin[],
  previousState: SyncState | null,
  scope: 'project' | 'user',
  workspacePath: string,
  dryRun: boolean,
  contexts: Map<ClientType, ResolvedClientContext>,
  selection?: SyncOptions['nativeSelection'],
): Promise<NativeSyncResult | undefined> {
  const allDesiredByClient = collectNativeResources(
    validPlugins,
    scope,
    contexts,
  );
  const desiredByClient = new Map<ClientType, NativeResource[]>();
  if (selection?.mode !== 'remove') {
    for (const [client, resources] of allDesiredByClient) {
      const selected = resources.filter((resource) =>
        nativeSelectionMatches(
          selection,
          resource.requestedIdentity,
          resource.resolvedIdentity,
        ),
      );
      if (selected.length > 0) desiredByClient.set(client, selected);
    }
  }
  let stateResources = [...(previousState?.nativeResources?.resources ?? [])];
  const clients = new Set<ClientType>(desiredByClient.keys());
  if (selection?.mode !== 'update') {
    for (const client of contexts.keys()) {
      const context = contexts.get(client);
      if (!context) continue;
      const operationContext = nativeOperationContext(client, scope, context);
      const tracked = getNativeStateResources(
        previousState,
        client,
        scope,
        nativeContextIdentity(operationContext),
      );
      if (
        tracked.some((resource) =>
          nativeSelectionMatches(
            selection,
            resource.requestedIdentity,
            resource.resolvedIdentity,
          ),
        )
      ) {
        clients.add(client);
      }
    }
  }
  const effects: NativeEffect[] = [];
  if (selection?.mode !== 'update') {
    for (const stateResource of stateResources) {
      if (
        stateResource.scope !== scope ||
        !nativeSelectionMatches(
          selection,
          stateResource.requestedIdentity,
          stateResource.resolvedIdentity,
        )
      ) {
        continue;
      }
      const resolvedContext = contexts.get(stateResource.client);
      const currentContext = resolvedContext
        ? nativeOperationContext(stateResource.client, scope, resolvedContext)
        : {
            client: stateResource.client,
            scope,
            nativeScope: stateResource.nativeScope,
            root: stateResource.root ?? stateResource.context,
          };
      if (
        resolvedContext &&
        nativeContextIdentity(currentContext) === stateResource.context
      ) {
        continue;
      }
      effects.push({
        action: 'unknown',
        phase: 'state',
        changed: false,
        resource: nativeResourceFromState(stateResource, currentContext),
        error: resolvedContext
          ? `Recorded native context ${stateResource.context} differs from selected context ${nativeContextIdentity(currentContext)}`
          : 'Recorded native resource has no resolvable client context',
      });
    }
  }
  if (clients.size === 0 && effects.length === 0) return undefined;
  const replaceStateRecord = (
    previous: NativeStateResource | undefined,
    next: NativeStateResource | undefined,
  ): void => {
    if (previous) {
      const key = nativeStateKey(previous);
      stateResources = stateResources.filter(
        (resource) => nativeStateKey(resource) !== key,
      );
    }
    if (next) {
      const key = nativeStateKey(next);
      stateResources = stateResources.filter(
        (resource) => nativeStateKey(resource) !== key,
      );
      stateResources.push(next);
    }
  };
  const checkpoint = async (
    previous: NativeStateResource | undefined,
    next: NativeStateResource | undefined,
  ): Promise<void> => {
    const snapshot = stateResources;
    replaceStateRecord(previous, next);
    try {
      await saveNativeStateResources(workspacePath, stateResources);
    } catch (error) {
      stateResources = snapshot;
      throw error;
    }
  };

  for (const client of clients) {
    const adapter = getNativeClient(client);
    const resolvedContext = contexts.get(client);
    if (!adapter || !resolvedContext) continue;
    const context = nativeOperationContext(client, scope, resolvedContext);
    const desired = desiredByClient.get(client) ?? [];
    const allDesired = allDesiredByClient.get(client) ?? [];
    const tracked = getNativeStateResources(
      previousState,
      client,
      scope,
      nativeContextIdentity(context),
    ).filter((resource) =>
      selection
        ? nativeSelectionMatches(
            selection,
            resource.requestedIdentity,
            resource.resolvedIdentity,
          )
        : true,
    );

    let inspection = await adapter.inspect(context);
    if (!inspection.success) {
      const affected =
        desired.length > 0
          ? desired
          : tracked.map((resource) =>
              nativeResourceFromState(resource, context),
            );
      for (const resource of affected) {
        effects.push({
          action: 'failed',
          resource,
          error: inspection.error ?? 'Native inspection failed',
        });
      }
      continue;
    }

    for (const resource of desired) {
      const exactObservation = inspection.observations?.find(
        (candidate) =>
          candidate.resource.kind === resource.kind &&
          candidate.resource.resolvedIdentity === resource.resolvedIdentity,
      );
      if (
        exactObservation?.status === 'disabled' ||
        exactObservation?.status === 'unusable'
      ) {
        effects.push({
          action: 'failed',
          phase: 'inspection',
          changed: false,
          resource,
          error:
            exactObservation.error ??
            `Native resource is ${exactObservation.status}`,
        });
        continue;
      }
      const exactLive = inspection.resources.find(
        (candidate) =>
          candidate.kind === resource.kind &&
          candidate.resolvedIdentity === resource.resolvedIdentity,
      );
      const prior = tracked.find(
        (candidate) =>
          candidate.kind === resource.kind &&
          (candidate.requestedIdentity === resource.requestedIdentity ||
            candidate.resolvedIdentity === resource.resolvedIdentity),
      );
      if (exactLive && selection?.mode !== 'update') {
        effects.push({
          action: 'unchanged',
          phase: 'inspection',
          changed: false,
          resource,
        });
        if (!dryRun) {
          const transition =
            prior && nativeStateOwnership(prior.transition) === 'managed'
              ? 'managed'
              : 'referenced';
          try {
            await checkpoint(
              prior,
              stateFromNativeResource(resource, transition),
            );
          } catch (error) {
            effects.push({
              action: 'failed',
              phase: 'state',
              changed: false,
              resource,
              error: `Could not checkpoint native reference: ${error instanceof Error ? error.message : String(error)}`,
            });
          }
        }
        continue;
      }

      const priorLive =
        exactLive ??
        (prior
          ? inspection.resources.find(
              (candidate) =>
                candidate.kind === prior.kind &&
                candidate.resolvedIdentity === prior.resolvedIdentity,
            )
          : undefined);
      const action = priorLive ? 'update' : 'install';
      if (dryRun) {
        if (resource.provenance.marketplaceSource && !priorLive) {
          effects.push({ action: 'would-register', resource });
        }
        effects.push({
          action: priorLive ? 'would-update' : 'would-install',
          resource,
        });
        continue;
      }

      const pendingTransition: NativeStateResource['transition'] =
        priorLive && (!prior || prior.transition === 'referenced')
          ? 'referenced'
          : priorLive
            ? 'pending-update'
            : 'pending-install';
      const pending = stateFromNativeResource(resource, pendingTransition);
      try {
        await checkpoint(prior, pending);
      } catch (error) {
        effects.push({
          action: 'failed',
          phase: 'state',
          changed: false,
          resource,
          error: `Could not checkpoint native ${action}: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }

      let mutation: NativeMutationResult;
      try {
        mutation = priorLive
          ? await adapter.update(resource, priorLive, context)
          : await adapter.install(resource, context);
      } catch (error) {
        mutation = {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      for (const registration of mutation.registrations ?? []) {
        effects.push({
          action: 'registered',
          resource: {
            ...resource,
            provenance: {
              ...resource.provenance,
              marketplaceSource: registration,
            },
          },
        });
      }
      if (!mutation.success) {
        const retained = priorLive
          ? stateFromNativeResource(
              nativeResourceFromState(prior ?? pending, context),
              !prior || prior.transition === 'referenced'
                ? 'referenced'
                : 'managed',
            )
          : stateFromNativeResource(resource, 'unknown', mutation.error);
        try {
          await checkpoint(pending, retained);
        } catch {
          // The pending checkpoint already preserves retry authority.
        }
        effects.push({
          action: 'failed',
          resource,
          error: mutation.error ?? `Native ${action} failed`,
        });
        continue;
      }

      inspection = await adapter.inspect(context);
      if (!inspection.success) {
        const unknown = stateFromNativeResource(
          resource,
          'unknown',
          inspection.error,
        );
        try {
          await checkpoint(pending, unknown);
        } catch {
          // The pending checkpoint still prevents unsafe cleanup.
        }
        effects.push({
          action: 'unknown',
          resource,
          error: inspection.error ?? `Could not verify native ${action}`,
        });
        continue;
      }
      const confirmed = inspection.resources.some(
        (candidate) =>
          candidate.kind === resource.kind &&
          candidate.resolvedIdentity === resource.resolvedIdentity,
      );
      if (!confirmed) {
        const error = `Native ${action} completed but '${resource.resolvedIdentity}' was not present in live inventory`;
        try {
          await checkpoint(
            pending,
            stateFromNativeResource(resource, 'unknown', error),
          );
        } catch {
          // The pending checkpoint still prevents unsafe cleanup.
        }
        effects.push({ action: 'unknown', resource, error });
        continue;
      }
      try {
        const transition: NativeStateResource['transition'] =
          priorLive && (!prior || prior.transition === 'referenced')
            ? 'referenced'
            : 'managed';
        await checkpoint(
          pending,
          stateFromNativeResource(resource, transition),
        );
        effects.push({
          action: priorLive ? 'updated' : 'installed',
          resource,
        });
      } catch (error) {
        effects.push({
          action: 'failed',
          resource,
          error: `Native ${action} succeeded but state checkpoint failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }

    for (const prior of tracked) {
      const desiredMatch = allDesired.some(
        (resource) =>
          resource.kind === prior.kind &&
          (resource.requestedIdentity === prior.requestedIdentity ||
            resource.resolvedIdentity === prior.resolvedIdentity),
      );
      if (desiredMatch) continue;
      const resource = nativeResourceFromState(prior, context);
      const liveObservation = inspection.observations?.find(
        (candidate) =>
          candidate.resource.kind === prior.kind &&
          candidate.resource.resolvedIdentity === prior.resolvedIdentity,
      );
      const live =
        inspection.resources.find(
          (candidate) =>
            candidate.kind === prior.kind &&
            candidate.resolvedIdentity === prior.resolvedIdentity,
        ) ??
        (liveObservation?.status === 'disabled' ||
        liveObservation?.status === 'unusable'
          ? liveObservation.resource
          : undefined);
      if (!live) {
        if (!dryRun) {
          try {
            await checkpoint(prior, undefined);
          } catch (error) {
            effects.push({
              action: 'failed',
              phase: 'state',
              changed: false,
              resource,
              error: `Could not release absent native state: ${error instanceof Error ? error.message : String(error)}`,
            });
            continue;
          }
        }
        effects.push({
          action: dryRun ? 'would-remove' : 'removed',
          phase: 'state',
          resource,
        });
        continue;
      }
      if (prior.transition === 'referenced') {
        effects.push({
          action: 'retained',
          phase: 'state',
          changed: false,
          resource,
          error: 'Native resource predates AllAgents ownership',
        });
        continue;
      }
      if (nativeStateOwnership(prior.transition) !== 'managed') {
        effects.push({
          action: 'unknown',
          phase: 'state',
          changed: false,
          resource,
          error: 'Native cleanup retained because ownership is unconfirmed',
        });
        continue;
      }
      if (dryRun) {
        effects.push({ action: 'would-remove', resource });
        continue;
      }

      const pending = { ...prior, transition: 'pending-remove' as const };
      try {
        await checkpoint(prior, pending);
      } catch (error) {
        effects.push({
          action: 'failed',
          resource,
          error: `Could not checkpoint native removal: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
      let removal: NativeMutationResult;
      try {
        removal = await adapter.remove(live, context);
      } catch (error) {
        removal = {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      if (!removal.success) {
        const failed = {
          ...prior,
          transition: 'cleanup-failed' as const,
          ...(removal.error && { error: removal.error }),
        };
        try {
          await checkpoint(pending, failed);
        } catch {
          // Pending removal remains durable and retryable.
        }
        effects.push({
          action: 'failed',
          resource,
          error: removal.error ?? 'Native removal failed',
        });
        continue;
      }
      inspection = await adapter.inspect(context);
      if (!inspection.success) {
        const unknown = {
          ...prior,
          transition: 'cleanup-failed' as const,
          error: inspection.error ?? 'Native removal verification failed',
        };
        try {
          await checkpoint(pending, unknown);
        } catch {
          // Pending removal remains durable and retryable.
        }
        effects.push({
          action: 'unknown',
          resource,
          error: unknown.error,
        });
        continue;
      }
      const stillPresent = inspection.resources.some(
        (candidate) =>
          candidate.kind === prior.kind &&
          candidate.resolvedIdentity === prior.resolvedIdentity,
      );
      if (stillPresent) {
        const error = `Native remove completed but '${prior.resolvedIdentity}' remains present`;
        try {
          await checkpoint(pending, {
            ...prior,
            transition: 'cleanup-failed',
            error,
          });
        } catch {
          // Pending removal remains durable and retryable.
        }
        effects.push({ action: 'unknown', resource, error });
        continue;
      }
      try {
        await checkpoint(pending, undefined);
        effects.push({ action: 'removed', resource });
      } catch (error) {
        effects.push({
          action: 'failed',
          resource,
          error: `Native removal succeeded but state release failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  return {
    success: effects.every(
      (effect) => effect.action !== 'failed' && effect.action !== 'unknown',
    ),
    effects,
  };
}

async function syncVscodeWorkspaceFile(
  workspacePath: string,
  config: WorkspaceConfig,
  configPath: string,
  previousState: SyncState | null,
  messages: string[],
): Promise<{ config: WorkspaceConfig; hash?: string; repos?: string[] }> {
  // Reconcile .code-workspace -> workspace.yaml if the file was externally modified
  let updatedConfig = config;
  if (
    previousState?.vscodeWorkspaceHash &&
    previousState?.vscodeWorkspaceRepos
  ) {
    const outputPath = getWorkspaceOutputPath(workspacePath, config.vscode);
    if (existsSync(outputPath)) {
      const existingContent = readFileSync(outputPath, 'utf-8');
      const currentHash = computeWorkspaceHash(existingContent);

      if (currentHash !== previousState.vscodeWorkspaceHash) {
        try {
          const existingWorkspace = JSON.parse(existingContent);
          const folders = Array.isArray(existingWorkspace.folders)
            ? existingWorkspace.folders
            : [];

          const reconciled = reconcileVscodeWorkspaceFolders(
            workspacePath,
            folders,
            previousState.vscodeWorkspaceRepos,
            config.repositories,
          );

          if (
            reconciled.added.length > 0 ||
            reconciled.removed.length > 0 ||
            reconciled.renamed.length > 0
          ) {
            const updateResult =
              reconciled.renamed.length > 0
                ? await setRepositories(reconciled.updatedRepos, workspacePath)
                : await updateRepositories(
                    {
                      remove: reconciled.removed,
                      add: reconciled.added.map((p) => ({ path: p })),
                    },
                    workspacePath,
                  );
            if (!updateResult.success) {
              throw new Error(
                updateResult.error ?? 'Failed to update repositories',
              );
            }
            updatedConfig = await parseWorkspaceConfig(configPath);

            if (reconciled.removed.length > 0) {
              messages.push(
                `Repositories removed (from .code-workspace): ${reconciled.removed.join(', ')}`,
              );
            }
            if (reconciled.added.length > 0) {
              messages.push(
                `Repositories added (from .code-workspace): ${reconciled.added.join(', ')}`,
              );
            }
            if (reconciled.renamed.length > 0) {
              messages.push(
                `Repository names updated (from .code-workspace): ${reconciled.renamed.join(', ')}`,
              );
            }
          }
        } catch {
          // If .code-workspace is malformed, skip reconciliation silently
        }
      }
    }
  }

  // Generate .code-workspace (always, even after reconciliation)
  const writtenContent = generateVscodeWorkspaceFile(
    workspacePath,
    updatedConfig,
  );
  const hash = computeWorkspaceHash(writtenContent);
  const repos = updatedConfig.repositories.map((r) =>
    resolve(workspacePath, r.path).replace(/\\/g, '/'),
  );

  return { config: updatedConfig, hash, repos };
}

async function planValidatedPluginAgentOutputs(
  validPlugins: ValidatedPlugin[],
  basePath: string,
  mappings: Record<string, ClientMapping>,
): Promise<AgentOutputPlan> {
  return planAgentOutputs(
    validPlugins.map((plugin, validIndex) => ({
      configurationIndex: plugin.configurationIndex ?? validIndex,
      plugin: plugin.plugin,
      pluginPath: plugin.resolved,
      clients: plugin.clients,
      ...(plugin.exclude && { exclude: plugin.exclude }),
      ...(plugin.fileArtifacts && { fileArtifacts: plugin.fileArtifacts }),
    })),
    basePath,
    mappings,
  );
}

function appendAgentOutputConflictWarnings(
  plan: AgentOutputPlan,
  warnings: string[],
): void {
  for (const conflict of plan.conflicts) {
    if (
      conflict.winner.configurationIndex === conflict.loser.configurationIndex
    ) {
      continue;
    }
    const subject =
      conflict.reason === 'logical-name' && conflict.loser.logicalName
        ? `logical agent '${conflict.loser.logicalName}' at ${conflict.loser.workspaceRelativeDestination}`
        : `agent output '${conflict.loser.workspaceRelativeDestination}'`;
    warnings.push(
      `${conflict.loser.plugin}: skipped ${subject}; first configured provider ${conflict.winner.plugin} owns it`,
    );
  }
}

function indexAgentOutputPlan(plan: AgentOutputPlan): {
  outputs: Map<number, AgentOutput[]>;
  conflicts: Map<number, AgentOutputConflict[]>;
  failures: Map<number, AgentOutputFailure[]>;
} {
  const outputs = new Map<number, AgentOutput[]>();
  const conflicts = new Map<number, AgentOutputConflict[]>();
  const failures = new Map<number, AgentOutputFailure[]>();
  for (const output of plan.outputs) {
    const owned = outputs.get(output.configurationIndex) ?? [];
    owned.push(output);
    outputs.set(output.configurationIndex, owned);
  }
  for (const conflict of plan.conflicts) {
    const lost = conflicts.get(conflict.loser.configurationIndex) ?? [];
    lost.push(conflict);
    conflicts.set(conflict.loser.configurationIndex, lost);
  }
  for (const failure of plan.failures) {
    const pluginFailures = failures.get(failure.configurationIndex) ?? [];
    pluginFailures.push(failure);
    failures.set(failure.configurationIndex, pluginFailures);
  }
  return { outputs, conflicts, failures };
}

/**
 * Correlate the immutable plan with exact copy outcomes. Dedupe never
 * rediscovers source or destination files.
 */
async function dedupePlannedAgentFiles(
  plan: AgentOutputPlan,
  copyResults: CopyResult[],
  dryRun: boolean,
  messages: string[],
  warnings: string[],
): Promise<AgentDedupeRecord[]> {
  const records = await dedupeAgentFilesByName(plan, copyResults, {
    dryRun,
    onWarning: (warning) => warnings.push(warning),
  });
  for (const record of records) {
    messages.push(
      `${dryRun ? 'Would dedupe' : 'Deduped'} agent '${record.name}': removed ${record.removedPath} (kept ${record.keptPath})`,
    );
  }
  return records;
}

async function buildSourcesProvenance(
  validatedPlugins: ValidatedPlugin[],
  pluginEntries: PluginEntry[],
): Promise<Record<string, SyncStateSource>> {
  const sources: Record<string, SyncStateSource> = {};

  // Index user-declared refs by their raw source string so we can attach them
  // to the matching validated plugin (whose `.plugin` may have `@ref` spliced in).
  const refByRawSource = new Map<string, string>();
  for (const entry of pluginEntries) {
    if (typeof entry === 'string') continue;
    if (entry.ref) refByRawSource.set(entry.source, entry.ref);
  }

  for (const validated of validatedPlugins) {
    if (!validated.success) continue;
    const spec = validated.plugin;
    if (!isGitHubUrl(spec)) continue;
    const parsed = parseGitHubUrl(spec);
    if (!parsed) continue;

    // Re-call fetchPlugin to pick up the cached resolvedSha / resolvedRef.
    const fetchResult = await fetchPlugin(spec, {
      ...(parsed.branch && { branch: parsed.branch }),
    });
    if (!fetchResult.success || !fetchResult.resolvedSha) continue;

    const rawBase = stripGitRef(`${parsed.owner}/${parsed.repo}`);
    const requestedRef = refByRawSource.get(rawBase) ?? parsed.branch;

    sources[rawBase] = {
      pluginSpec: rawBase,
      resolvedRef: fetchResult.resolvedRef ?? parsed.branch ?? 'HEAD',
      resolvedSha: fetchResult.resolvedSha,
      ...(requestedRef && { requestedRef }),
    };
  }

  return sources;
}

async function persistSyncState(
  workspacePath: string,
  syncedFiles: Partial<Record<ClientType, string[]>>,
  extra?: {
    vscodeState?: { hash: string; repos: string[] };
    codexHooks?: SyncState['codexHooks'];
    mcpTrackedServers?: Partial<Record<string, string[]>>;
    skillsIndex?: string[];
    sources?: Record<string, SyncStateSource>;
  },
): Promise<void> {
  await saveSyncState(workspacePath, {
    files: syncedFiles,
    ...(extra?.codexHooks && { codexHooks: extra.codexHooks }),
    ...(extra?.vscodeState?.hash && {
      vscodeWorkspaceHash: extra.vscodeState.hash,
    }),
    ...(extra?.vscodeState?.repos && {
      vscodeWorkspaceRepos: extra.vscodeState.repos,
    }),
    ...(extra?.mcpTrackedServers && { mcpServers: extra.mcpTrackedServers }),
    ...(extra?.skillsIndex &&
      extra.skillsIndex.length > 0 && { skillsIndex: extra.skillsIndex }),
    ...(extra?.sources &&
      Object.keys(extra.sources).length > 0 && { sources: extra.sources }),
  });
}

/**
 * Sync all plugins to workspace for all configured clients
 *
 * Flow:
 * 1. Validate all plugins (fetch/resolve paths)
 * 2. If any validation fails, abort without changes
 * 3. Purge managed directories (declarative sync)
 * 4. Copy fresh from all validated plugins
 *
 * @param workspacePath - Path to workspace directory (defaults to current directory)
 * @param options - Sync options (offline, dryRun)
 * @returns Sync result
 */
export async function syncWorkspace(
  workspacePath: string = process.cwd(),
  options: SyncOptions = {},
): Promise<SyncResult> {
  const {
    offline = false,
    dryRun = false,
    workspaceSourceBase,
    skipAgentFiles = false,
    skipManaged = false,
    nativeSelection,
  } = options;
  const sw = new Stopwatch();
  const configDir = join(workspacePath, CONFIG_DIR);
  const configPath = join(configDir, WORKSPACE_CONFIG_FILE);

  // Check .allagents/workspace.yaml exists
  if (!existsSync(configPath)) {
    return failedSyncResult(
      `${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE} not found in ${workspacePath}\n  Run 'allagents workspace init <path>' to create a new workspace`,
    );
  }

  // Parse workspace config
  let config: WorkspaceConfig;
  try {
    config = await parseWorkspaceConfig(configPath);
  } catch (error) {
    return failedSyncResult(
      error instanceof Error
        ? error.message
        : `Failed to parse ${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE}`,
    );
  }

  // Check for marketplace overrides (project shadowing user)
  const overrides = await getMarketplaceOverrides(
    getRegistryPath(),
    getProjectRegistryPath(workspacePath),
  );
  for (const name of overrides) {
    console.warn(
      `Warning: Workspace marketplace '${name}' overrides user marketplace of the same name.`,
    );
  }

  const {
    plans: pluginPlans,
    warnings: planWarnings,
    errors: allPlanErrors,
  } = buildPluginSyncPlans(config.plugins, config.clients, 'project');
  const planErrors = nativeSelection
    ? buildPluginSyncPlans(
        config.plugins.filter((plugin) => {
          const source = getEffectivePluginSource(plugin);
          return nativeSelectionMatches(nativeSelection, source, source);
        }),
        config.clients,
        'project',
      ).errors
    : allPlanErrors;
  if (planErrors.length > 0) {
    return failedSyncResult(
      `Native preflight failed (workspace unchanged):\n${planErrors.map((error) => `  - ${error}`).join('\n')}`,
      { totalFailed: planErrors.length, warnings: planWarnings },
    );
  }

  const workspaceClients = config.clients;
  const filteredPlans = pluginPlans.filter(
    (plan) => plan.clients.length > 0 || plan.nativeClients.length > 0,
  );
  const syncClients = collectSyncClients(workspaceClients, filteredPlans);
  const staleNativeState =
    syncClients.length === 0
      ? (await loadSyncState(workspacePath))?.nativeResources?.resources.some(
          (resource) => resource.scope === 'project',
        ) === true
      : false;
  if (syncClients.length === 0 && !staleNativeState) {
    return {
      success: true,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
      warnings: [
        "No clients configured in workspace.yaml — no artifacts were synced. Add clients to workspace.yaml or run 'allagents workspace init' to configure.",
      ],
    };
  }

  const preflightContexts = resolveClientContexts(syncClients, 'project', {
    cwd: workspacePath,
    homeDir: getHomeDir(),
    env: process.env,
  });
  const nativePreflightErrors = await preflightNativePlans(
    filteredPlans,
    'project',
    preflightContexts,
    nativeSelection,
  );
  if (nativePreflightErrors.length > 0) {
    return failedSyncResult(
      `Native preflight failed (workspace unchanged):\n${nativePreflightErrors.map((error) => `  - ${error}`).join('\n')}`,
      {
        totalFailed: nativePreflightErrors.length,
        warnings: planWarnings,
        nativeResult: nativePreflightFailureResult(
          filteredPlans,
          'project',
          preflightContexts,
          nativePreflightErrors,
          nativeSelection,
        ),
      },
    );
  }

  // Generic marketplace registration/fetch is needed only by file targets.
  const filePlans = filteredPlans.filter((plan) => plan.clients.length > 0);
  const marketplaceResults = await sw.measure('marketplace-registration', () =>
    ensureMarketplacesRegistered(filePlans.map((plan) => plan.source)),
  );
  await seedFetchCacheFromMarketplaces(marketplaceResults);

  // Step 1: Validate all plugins before any destructive action
  const validatedPlugins = await sw.measure(
    'plugin-validation',
    () => validateAllPlugins(filteredPlans, workspacePath, offline),
    `${filteredPlans.length} plugin(s)`,
  );

  // Step 1b: Validate workspace.source if defined
  // Use workspaceSourceBase if provided (during init with --from) to resolve
  // relative paths correctly relative to the source directory
  let validatedWorkspaceSource: ValidatedPlugin | null = null;
  const workspaceSourceWarnings: string[] = [];
  if (config.workspace?.source) {
    sw.start('workspace-source-validation');
    const sourceBasePath = workspaceSourceBase ?? workspacePath;
    const wsSourceResult = await validatePlugin(
      config.workspace.source,
      sourceBasePath,
      offline,
    );
    if (wsSourceResult.success) {
      validatedWorkspaceSource = wsSourceResult;
    } else {
      // Non-blocking: warn but continue updating plugins
      workspaceSourceWarnings.push(`Workspace source: ${wsSourceResult.error}`);
    }
    sw.stop('workspace-source-validation');
  }

  const failedValidations = validatedPlugins.filter(
    (plugin) => !plugin.success,
  );
  const requiredNativeFailures = failedValidations.filter((plugin) => {
    const plan = filteredPlans.find(
      (candidate) => candidate.configurationIndex === plugin.configurationIndex,
    );
    return (
      (plan?.nativeClients.length ?? 0) > 0 &&
      nativeSelectionMatches(
        nativeSelection,
        plan?.source ?? plugin.plugin,
        plan?.source ?? plugin.plugin,
      )
    );
  });
  const validationWarnings = [
    ...planWarnings,
    ...workspaceSourceWarnings,
    ...failedValidations.map(
      (plugin) => `${plugin.plugin}: ${plugin.error} (skipped)`,
    ),
  ];
  if (requiredNativeFailures.length > 0) {
    return failedSyncResult(
      `Mixed native/file preflight failed (workspace unchanged):\n${requiredNativeFailures.map((plugin) => `  - ${plugin.plugin}: ${plugin.error}`).join('\n')}`,
      {
        totalFailed: requiredNativeFailures.length,
        warnings: validationWarnings,
      },
    );
  }

  const validPlugins = validatedPlugins.filter((plugin) => plugin.success);
  const filePlugins = validPlugins.filter(
    (plugin) => plugin.clients.length > 0,
  );
  if (validPlugins.length === 0 && filteredPlans.length > 0) {
    return failedSyncResult(
      `All plugins failed validation (workspace unchanged):\n${failedValidations.map((plugin) => `  - ${plugin.plugin}: ${plugin.error}`).join('\n')}`,
      { totalFailed: failedValidations.length, warnings: validationWarnings },
    );
  }

  const hasRepositories = (config.repositories?.length ?? 0) > 0;
  const skipWorkspaceFiles =
    !!config.workspace?.source && !validatedWorkspaceSource;
  const workspaceFilesSourcePath = validatedWorkspaceSource?.resolved;
  const workspaceFilesToCopy =
    config.workspace && !skipWorkspaceFiles ? [...config.workspace.files] : [];
  let workspaceFilesGithubCache = new Map<string, string>();
  if (config.workspace && !skipWorkspaceFiles) {
    if (hasRepositories && workspaceFilesSourcePath) {
      for (const agentFile of AGENT_FILES) {
        const agentPath = join(workspaceFilesSourcePath, agentFile);
        if (
          existsSync(agentPath) &&
          !workspaceFilesToCopy.includes(agentFile)
        ) {
          workspaceFilesToCopy.push(agentFile);
        }
      }
    }
    const fileSourceRepos = collectGitHubReposFromFiles(workspaceFilesToCopy);
    if (fileSourceRepos.length > 0) {
      const { cache, errors } = await fetchFileSourceRepos(fileSourceRepos);
      if (errors.length > 0) {
        return failedSyncResult(
          `File source fetch failed (workspace unchanged):\n${errors.map((error) => `  - ${error}`).join('\n')}`,
          { totalFailed: errors.length, warnings: validationWarnings },
        );
      }
      workspaceFilesGithubCache = cache;
    }
    const fileValidationErrors = validateFileSources(
      workspaceFilesToCopy,
      workspaceFilesSourcePath,
      workspaceFilesGithubCache,
    );
    if (fileValidationErrors.length > 0) {
      return failedSyncResult(
        `File source validation failed (workspace unchanged):\n${fileValidationErrors.map((error) => `  - ${error}`).join('\n')}`,
        {
          totalFailed: fileValidationErrors.length,
          warnings: validationWarnings,
        },
      );
    }
  }

  if (!dryRun) {
    // MIGRATION: v1→v2 - remove after v3 release.
    await migrateWorkspaceSkillsV1toV2(workspacePath);
  }

  const managedRepoResults = await sw.measure('managed-repos', () =>
    processManagedRepos(config.repositories ?? [], workspacePath, {
      offline,
      skipManaged,
      dryRun,
    }),
  );
  const managedWarnings = managedRepoResults
    .filter((result) => result.error)
    .map((result) => `${result.repo}: ${result.error}`);
  const warnings = [...managedWarnings, ...validationWarnings];
  const messages: string[] = [];

  // Step 2: Load previous sync state for selective purge
  const previousState = await loadSyncState(workspacePath);
  const contextClients = [
    ...new Set([
      ...syncClients,
      ...(Object.keys(previousState?.files ?? {}) as ClientType[]),
      ...(previousState?.nativeResources?.resources
        .filter((resource) => resource.scope === 'project')
        .map((resource) => resource.client) ?? []),
    ]),
  ];
  const clientContexts = resolveClientContexts(contextClients, 'project', {
    cwd: workspacePath,
    homeDir: getHomeDir(),
    env: process.env,
  });
  const contextMappings = clientMappingsFromContexts(
    clientContexts,
    CLIENT_MAPPINGS,
  );
  const resolvedMappings = resolveClientMappings(syncClients, contextMappings);

  // Step 2b: Get paths that will be purged (for dry-run reporting)
  // In non-destructive mode, only show files from state (or nothing on first sync)
  const purgedPaths = previousState
    ? syncClients
        .map((client) => ({
          client,
          paths: getPreviouslySyncedFiles(previousState, client).filter(
            (path) =>
              trackedPathIsAllowed(
                workspacePath,
                path,
                resolvedMappings[client],
                clientContexts.get(client),
              ),
          ),
        }))
        .filter((entry) => entry.paths.length > 0)
    : [];

  // Step 3: Selective purge - only remove files we previously synced (skip in dry-run mode)
  if (!dryRun) {
    await sw.measure('selective-purge', () =>
      selectivePurgeWorkspace(
        workspacePath,
        previousState,
        syncClients,
        resolvedMappings,
        clientContexts,
      ),
    );
  }

  // Step 3b: Two-pass skill name resolution
  // Pass 1: Collect all skills from all plugins (excluding disabled/non-enabled skills)
  // v1 fallback: only use top-level disabledSkills/enabledSkills for configs that haven't migrated
  const isV1Fallback = config.version === undefined || config.version < 2;
  const disabledSkillsSet = isV1Fallback
    ? new Set(config.disabledSkills ?? [])
    : undefined;
  const enabledSkillsSet =
    isV1Fallback && config.enabledSkills
      ? new Set(config.enabledSkills)
      : undefined;
  const allSkills = await sw.measure('skill-collection', () =>
    collectAllSkills(
      filePlugins,
      disabledSkillsSet,
      enabledSkillsSet,
      warnings,
    ),
  );

  // Build per-plugin skill name maps (handles conflicts automatically)
  const pluginSkillMaps = buildPluginSkillNameMaps(allSkills);
  // Context mappings preserve legacy paths and carry Pi/OMP concrete roots.
  const agentOutputPlan = await sw.measure('agent-output-planning', () =>
    planValidatedPluginAgentOutputs(
      filePlugins,
      workspacePath,
      contextMappings,
    ),
  );
  appendAgentOutputConflictWarnings(agentOutputPlan, warnings);
  const indexedAgentOutputPlan = indexAgentOutputPlan(agentOutputPlan);

  // Step 4: Copy fresh from all validated plugins
  // Pass 2: Copy skills using resolved names
  // Use syncMode from config (defaults to 'symlink')
  const syncMode = config.syncMode ?? 'symlink';
  const pluginResults = await sw.measure(
    'plugin-copy',
    () =>
      Promise.all(
        filePlugins.map(async (validatedPlugin, validIndex) => {
          const skillNameMap = pluginSkillMaps.get(validatedPlugin.resolved);
          const configurationIndex =
            validatedPlugin.configurationIndex ?? validIndex;
          const agentOutputs =
            indexedAgentOutputPlan.outputs.get(configurationIndex) ?? [];
          const agentConflicts =
            indexedAgentOutputPlan.conflicts.get(configurationIndex) ?? [];
          const agentFailures =
            indexedAgentOutputPlan.failures.get(configurationIndex) ?? [];
          const result = await copyValidatedPlugin(
            validatedPlugin,
            workspacePath,
            validatedPlugin.clients,
            dryRun,
            skillNameMap,
            contextMappings,
            syncMode,
            agentOutputs,
            agentConflicts,
            agentFailures,
            Object.fromEntries(
              [...clientContexts].map(([client, context]) => [
                client,
                context.writeRoot,
              ]),
            ),
          );
          return { ...result, scope: 'project' as const };
        }),
      ),
    `${filePlugins.length} plugin(s)`,
  );

  // Step 4b: Native CLI installations
  const nativeResult = await sw.measure('native-plugin-sync', () =>
    syncNativePlugins(
      validPlugins,
      previousState,
      'project',
      workspacePath,
      dryRun,
      clientContexts,
      nativeSelection,
    ),
  );

  // Step 4c: Merge Codex plugin hooks into project-scoped .codex/hooks.json.
  // This preserves user-owned hooks and replaces only the allagents-managed
  // subset recorded in sync state.
  const codexHookSync = await sw.measure('codex-hooks-sync', async () =>
    syncCodexProjectHooks(
      filePlugins,
      workspacePath,
      previousState?.codexHooks,
      {
        dryRun,
      },
    ),
  );
  warnings.push(...codexHookSync.warnings);

  // Step 4d: Materialize Copilot plugin hook declarations as a repository hook
  // file. Copilot discovers project hooks only from .github/hooks/*.json;
  // copying a plugin's hook scripts there does not activate its root hooks.json.
  const copilotHookSync = await sw.measure('copilot-hooks-sync', () =>
    syncCopilotProjectHooks(filePlugins, workspacePath, {
      dryRun,
      previouslyManaged: getPreviouslySyncedFiles(
        previousState,
        'copilot',
      ).includes(COPILOT_MANAGED_HOOKS_RELATIVE_PATH),
    }),
  );
  warnings.push(...copilotHookSync.warnings);

  // Step 5: Copy workspace files if configured
  // Supports both workspace.source (default base) and file-level sources
  // Skip when workspace.source was configured but validation failed (plugins still synced above)
  const workspaceFileResults: CopyResult[] = [
    ...codexHookSync.copyResults,
    ...copilotHookSync.copyResults,
  ];
  let writtenSkillsIndexFiles: string[] = [];
  if (config.workspace && !skipWorkspaceFiles) {
    sw.start('workspace-files');
    const sourcePath = workspaceFilesSourcePath;
    const filesToCopy = workspaceFilesToCopy;
    const githubCache = workspaceFilesGithubCache;

    // Step 5c: Discover skills from workspace repositories
    const repoSkills =
      hasRepositories && !dryRun
        ? await discoverWorkspaceSkills(
            workspacePath,
            config.repositories,
            syncClients as string[],
          )
        : [];

    // Step 5c.1: Write skills-index files and clean up stale ones
    let skillsIndexRefs: { repoName: string; indexPath: string }[] = [];
    if (!dryRun) {
      if (repoSkills.length > 0) {
        const grouped = groupSkillsByRepo(repoSkills, config.repositories);
        const result = writeSkillsIndex(workspacePath, grouped);
        writtenSkillsIndexFiles = result.writtenFiles;
        skillsIndexRefs = result.refs;
      }
      // Always clean up stale index files (handles case where all skills were removed)
      cleanupSkillsIndex(workspacePath, writtenSkillsIndexFiles);
    }

    // Step 5d: Copy workspace files with GitHub cache
    // Pass repositories and skillsIndexRefs so conditional links are embedded in WORKSPACE-RULES
    workspaceFileResults.push(
      ...(await copyWorkspaceFiles(sourcePath, workspacePath, filesToCopy, {
        dryRun,
        githubCache,
        repositories: config.repositories,
        skillsIndexRefs,
      })),
    );

    // If claude is a client and CLAUDE.md doesn't exist, copy AGENTS.md to CLAUDE.md
    // Skip when repositories is empty (no agent files should be created)
    if (
      hasRepositories &&
      !dryRun &&
      syncClients.includes('claude') &&
      sourcePath
    ) {
      const claudePath = join(workspacePath, 'CLAUDE.md');
      const agentsPath = join(workspacePath, 'AGENTS.md');
      const claudeExistsInSource = existsSync(join(sourcePath, 'CLAUDE.md'));

      // Only copy if CLAUDE.md wasn't in source and AGENTS.md exists
      if (
        !claudeExistsInSource &&
        existsSync(agentsPath) &&
        !existsSync(claudePath)
      ) {
        await copyFile(agentsPath, claudePath);
      }
    }
    sw.stop('workspace-files');
  }

  // When repositories are configured but no workspace.source is set,
  // ensure WORKSPACE-RULES are injected into agent files directly.
  // This handles the case where a user has repositories but no workspace: section.
  // (When workspace.source exists, rules are injected via copyWorkspaceFiles above.)
  if (!config.workspace && !dryRun && !skipAgentFiles) {
    await updateAgentFiles(workspacePath);
  }

  // Step 5d: Reconcile and generate VSCode .code-workspace file
  let vscodeState: { hash: string; repos: string[] } | undefined;
  if (syncClients.includes('vscode') && !dryRun) {
    const result = await sw.measure('vscode-workspace-file', () =>
      syncVscodeWorkspaceFile(
        workspacePath,
        config,
        configPath,
        previousState,
        messages,
      ),
    );
    config = result.config;
    if (result.hash && result.repos) {
      vscodeState = { hash: result.hash, repos: result.repos };
    }
  }

  // Step 5e–h: Sync MCP server configs across all project-scoped clients.
  // Delegated to mcp-sync.ts so the same pipeline can be reused by the
  // standalone `allagents mcp update` command.
  sw.start('mcp-sync');
  const mcpSyncResult = runMcpSync(
    workspacePath,
    filePlugins,
    config,
    previousState,
    syncClients,
    { dryRun },
  );
  const mcpResults: Record<string, McpMergeResult> = {
    ...mcpSyncResult.mcpResults,
  };
  warnings.push(...mcpSyncResult.warnings);
  sw.stop('mcp-sync');

  // Compute deleted artifacts: compare previous state vs what was just synced
  // Collect all skill names from installed plugins (including disabled) so that
  // skills that are still available but just not synced are not reported as deleted.
  const availableSkillNames = await collectAvailableSkillNames(
    filePlugins,
    warnings,
  );
  const allCopyResultsForState = [
    ...pluginResults.flatMap((r) => r.copyResults),
    ...workspaceFileResults,
  ];
  const agentDedupeRecords = await dedupePlannedAgentFiles(
    agentOutputPlan,
    allCopyResultsForState,
    dryRun,
    messages,
    warnings,
  );
  // Count results
  const {
    totalCopied,
    totalFailed: fileFailures,
    totalSkipped,
    totalGenerated,
  } = countCopyResults(pluginResults, workspaceFileResults);
  const nativeFailures =
    nativeResult?.effects.filter(
      (effect) => effect.action === 'failed' || effect.action === 'unknown',
    ).length ?? 0;
  const totalFailed = fileFailures + nativeFailures;
  const hasFailures =
    pluginResults.some((result) => !result.success) ||
    totalFailed > 0 ||
    nativeResult?.success === false;

  const newStatePaths = collectSyncedPaths(
    allCopyResultsForState,
    workspacePath,
    syncClients,
    resolvedMappings,
    agentDedupeRecords,
    clientContexts,
  );
  const deletedArtifacts = computeDeletedArtifacts(
    previousState,
    newStatePaths,
    syncClients,
    resolvedMappings,
    availableSkillNames,
    agentDedupeRecords,
  );

  // Persist sync state (skip in dry-run mode)
  if (!dryRun) {
    const sources = await buildSourcesProvenance(filePlugins, config.plugins);
    await sw.measure('persist-state', () =>
      persistSyncState(workspacePath, newStatePaths, {
        ...(vscodeState && { vscodeState }),
        ...(codexHookSync.managedHooks && {
          codexHooks: codexHookSync.managedHooks,
        }),
        ...(Object.keys(mcpResults).length > 0 && {
          mcpTrackedServers: Object.fromEntries(
            Object.entries(mcpResults).map(([scope, r]) => [
              scope,
              r.trackedServers,
            ]),
          ),
        }),
        ...(writtenSkillsIndexFiles.length > 0 && {
          skillsIndex: writtenSkillsIndexFiles,
        }),
        ...(Object.keys(sources).length > 0 && { sources }),
      }),
    );
  }

  const uniqueWarnings = [...new Set(warnings)];
  return {
    success: !hasFailures,
    pluginResults,
    totalCopied,
    totalFailed,
    totalSkipped,
    totalGenerated,
    purgedPaths,
    ...(deletedArtifacts.length > 0 && { deletedArtifacts }),
    ...(uniqueWarnings.length > 0 && { warnings: uniqueWarnings }),
    ...(messages.length > 0 && { messages }),
    ...(Object.keys(mcpResults).length > 0 && { mcpResults }),
    ...(nativeResult && { nativeResult }),
    ...(managedRepoResults.length > 0 && { managedRepoResults }),
    timing: sw.toJSON(),
  };
}

/**
 * Seed the fetchPlugin cache with paths from successfully registered marketplaces.
 * This prevents fetchPlugin from performing a redundant git pull for repos
 * that the marketplace has already cloned/pulled.
 */
export async function seedFetchCacheFromMarketplaces(
  results: Array<{ source: string; success: boolean; name?: string }>,
): Promise<void> {
  for (const result of results) {
    if (!result.success || !result.name) continue;

    const entry = await getMarketplace(result.name);
    if (entry?.source.type !== 'github') continue;
    if (getMarketplaceAccessError(entry)) continue;

    // Seed the bare key (owner/repo without branch)
    seedFetchCache(entry.source.location, entry.path);

    // Also seed the branch-qualified key so that callers using an explicit
    // branch (e.g. workspace.source URLs with /tree/main/) get a cache hit.
    // The marketplace repo content will be pulled fresh during validateAllPlugins
    // before any caller reads from this path.
    const branch = readGitBranch(entry.path);
    if (branch) {
      seedFetchCache(entry.source.location, entry.path, branch);
    }
  }
}

/**
 * Read the current branch from a git repo's HEAD file without spawning a process.
 * Returns null if the branch cannot be determined (detached HEAD, missing file, etc.).
 */
function readGitBranch(repoPath: string): string | null {
  try {
    const head = readFileSync(join(repoPath, '.git', 'HEAD'), 'utf-8').trim();
    const prefix = 'ref: refs/heads/';
    return head.startsWith(prefix) ? head.slice(prefix.length) : null;
  } catch {
    return null;
  }
}

/**
 * Sync user-scoped plugins to user home directories using USER_CLIENT_MAPPINGS.
 * Reads config from ~/.allagents/workspace.yaml and syncs to paths relative to $HOME.
 *
 * @param options - Sync options (offline, dryRun)
 * @returns Sync result
 */
export async function syncUserWorkspace(
  options: SyncOptions = {},
): Promise<SyncResult> {
  const sw = new Stopwatch();
  const homeDir = resolve(getHomeDir());
  const {
    offline = false,
    dryRun = false,
    force = false,
    nativeSelection,
  } = options;
  let config = await getUserWorkspaceConfig();

  if (!config) {
    return {
      success: true,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
    };
  }

  const {
    plans: allPluginPlans,
    warnings: planWarnings,
    errors: allPlanErrors,
  } = buildPluginSyncPlans(config.plugins, config.clients, 'user');
  const planErrors = nativeSelection
    ? buildPluginSyncPlans(
        config.plugins.filter((plugin) => {
          const source = getEffectivePluginSource(plugin);
          return nativeSelectionMatches(nativeSelection, source, source);
        }),
        config.clients,
        'user',
      ).errors
    : allPlanErrors;
  if (planErrors.length > 0) {
    return failedSyncResult(
      `Native preflight failed (user workspace unchanged):\n${planErrors.map((error) => `  - ${error}`).join('\n')}`,
      { totalFailed: planErrors.length, warnings: planWarnings },
    );
  }

  const pluginPlans = allPluginPlans.filter(
    (plan) => plan.clients.length > 0 || plan.nativeClients.length > 0,
  );
  const syncClients = collectSyncClients(config.clients, pluginPlans);
  const preflightContexts = resolveClientContexts(syncClients, 'user', {
    homeDir,
    cwd: process.cwd(),
    env: process.env,
  });
  const nativePreflightErrors = await preflightNativePlans(
    pluginPlans,
    'user',
    preflightContexts,
    nativeSelection,
  );
  if (nativePreflightErrors.length > 0) {
    return failedSyncResult(
      `Native preflight failed (user workspace unchanged):\n${nativePreflightErrors.map((error) => `  - ${error}`).join('\n')}`,
      {
        totalFailed: nativePreflightErrors.length,
        warnings: planWarnings,
        nativeResult: nativePreflightFailureResult(
          pluginPlans,
          'user',
          preflightContexts,
          nativePreflightErrors,
          nativeSelection,
        ),
      },
    );
  }

  if (!dryRun) {
    // MIGRATION: v1→v2 - remove after v3 release.
    await migrateUserWorkspaceSkillsV1toV2();
    config = (await getUserWorkspaceConfig()) ?? config;
  }

  const filePlans = pluginPlans.filter((plan) => plan.clients.length > 0);
  const marketplaceResults = await sw.measure('marketplace-registration', () =>
    ensureMarketplacesRegistered(filePlans.map((plan) => plan.source)),
  );
  await seedFetchCacheFromMarketplaces(marketplaceResults);

  const validatedPlugins = await sw.measure(
    'plugin-validation',
    () => validateAllPlugins(pluginPlans, homeDir, offline),
    `${pluginPlans.length} plugin(s)`,
  );
  const failedValidations = validatedPlugins.filter(
    (plugin) => !plugin.success,
  );
  const requiredNativeFailures = failedValidations.filter((plugin) => {
    const plan = pluginPlans.find(
      (candidate) => candidate.configurationIndex === plugin.configurationIndex,
    );
    return (
      (plan?.nativeClients.length ?? 0) > 0 &&
      nativeSelectionMatches(
        nativeSelection,
        plan?.source ?? plugin.plugin,
        plan?.source ?? plugin.plugin,
      )
    );
  });
  const warnings = [
    ...planWarnings,
    ...failedValidations.map(
      (plugin) => `${plugin.plugin}: ${plugin.error} (skipped)`,
    ),
  ];
  if (requiredNativeFailures.length > 0) {
    return failedSyncResult(
      `Mixed native/file preflight failed (user workspace unchanged):\n${requiredNativeFailures.map((plugin) => `  - ${plugin.plugin}: ${plugin.error}`).join('\n')}`,
      { totalFailed: requiredNativeFailures.length, warnings },
    );
  }
  const validPlugins = validatedPlugins.filter((plugin) => plugin.success);
  const filePlugins = validPlugins.filter(
    (plugin) => plugin.clients.length > 0,
  );
  const messages: string[] = [];
  if (validPlugins.length === 0 && pluginPlans.length > 0) {
    return failedSyncResult(
      `All plugins failed validation:\n${failedValidations.map((plugin) => `  - ${plugin.plugin}: ${plugin.error}`).join('\n')}`,
      { totalFailed: failedValidations.length, warnings },
    );
  }

  // Load previous sync state (stored at ~/.allagents/sync-state.json)
  const previousState = await loadSyncState(homeDir);
  const userContextClients = [
    ...new Set([
      ...syncClients,
      ...(Object.keys(previousState?.files ?? {}) as ClientType[]),
      ...(previousState?.nativeResources?.resources
        .filter((resource) => resource.scope === 'user')
        .map((resource) => resource.client) ?? []),
    ]),
  ];
  const userClientContexts = resolveClientContexts(userContextClients, 'user', {
    homeDir,
    cwd: process.cwd(),
    env: process.env,
  });
  const userContextMappings = clientMappingsFromContexts(
    userClientContexts,
    USER_CLIENT_MAPPINGS,
  );
  const resolvedUserMappings = resolveClientMappings(
    syncClients,
    userContextMappings,
  );

  // Selective purge
  if (!dryRun) {
    await sw.measure('selective-purge', () =>
      selectivePurgeWorkspace(
        homeDir,
        previousState,
        syncClients,
        resolvedUserMappings,
        userClientContexts,
      ),
    );

    const relocatedHooks = await sw.measure('legacy-copilot-hook-scan', () =>
      findRelocatedGitHubHooks(
        filePlugins
          .filter(
            (plugin) =>
              plugin.clients.includes('copilot') &&
              plugin.fileArtifacts?.github !== false,
          )
          .map((plugin) => ({
            pluginPath: plugin.resolved,
            ...(plugin.exclude && { exclude: plugin.exclude }),
          })),
        homeDir,
        'copilot',
        { clientMappings: userContextMappings },
      ),
    );

    for (const filePath of relocatedHooks.found) {
      const displayPath = relative(homeDir, filePath).replace(/\\/g, '/');
      warnings.push(
        `Copilot user hook '${displayPath}' shares a path with a repository .github/hooks artifact. Repository hooks are no longer synced at user scope; review this file manually if an older AllAgents version installed it. A root hooks/ artifact may still manage the same path.`,
      );
    }
  }

  // Two-pass skill name resolution (excluding disabled/non-enabled skills)
  // v1 fallback: only use top-level disabledSkills/enabledSkills for configs that haven't migrated
  const isV1FallbackUser = config.version === undefined || config.version < 2;
  const disabledSkillsSet = isV1FallbackUser
    ? new Set(config.disabledSkills ?? [])
    : undefined;
  const enabledSkillsSet =
    isV1FallbackUser && config.enabledSkills
      ? new Set(config.enabledSkills)
      : undefined;
  const allSkills = await sw.measure('skill-collection', () =>
    collectAllSkills(
      filePlugins,
      disabledSkillsSet,
      enabledSkillsSet,
      warnings,
    ),
  );
  const pluginSkillMaps = buildPluginSkillNameMaps(allSkills);
  const agentOutputPlan = await sw.measure('agent-output-planning', () =>
    planValidatedPluginAgentOutputs(filePlugins, homeDir, userContextMappings),
  );
  appendAgentOutputConflictWarnings(agentOutputPlan, warnings);
  const indexedAgentOutputPlan = indexAgentOutputPlan(agentOutputPlan);

  // Copy plugins using USER_CLIENT_MAPPINGS
  // Use syncMode from config (defaults to 'symlink')
  const syncMode = config.syncMode ?? 'symlink';
  const pluginResults = await sw.measure(
    'plugin-copy',
    () =>
      Promise.all(
        filePlugins.map(async (vp, validIndex) => {
          const skillNameMap = pluginSkillMaps.get(vp.resolved);
          const configurationIndex = vp.configurationIndex ?? validIndex;
          const agentOutputs =
            indexedAgentOutputPlan.outputs.get(configurationIndex) ?? [];
          const agentConflicts =
            indexedAgentOutputPlan.conflicts.get(configurationIndex) ?? [];
          const agentFailures =
            indexedAgentOutputPlan.failures.get(configurationIndex) ?? [];
          const pluginMappings = resolveClientMappings(
            vp.clients,
            userContextMappings,
          );
          const result = await copyValidatedPlugin(
            vp,
            homeDir,
            vp.clients,
            dryRun,
            skillNameMap,
            pluginMappings,
            syncMode,
            agentOutputs,
            agentConflicts,
            agentFailures,
            Object.fromEntries(
              [...userClientContexts].map(([client, context]) => [
                client,
                context.writeRoot,
              ]),
            ),
          );
          return { ...result, scope: 'user' as const };
        }),
      ),
    `${filePlugins.length} plugin(s)`,
  );

  sw.start('mcp-sync');
  const userMcpSyncResult = await syncUserMcpAdapters({
    validPlugins: filePlugins,
    config,
    previousState,
    syncClients,
    dryRun,
    force,
  });
  sw.stop('mcp-sync');
  warnings.push(...userMcpSyncResult.warnings);
  const mcpResults: Record<string, McpMergeResult> = {
    ...userMcpSyncResult.mcpResults,
  };

  // Run native CLI installations for user scope
  const nativeResult = await sw.measure('native-plugin-sync', () =>
    syncNativePlugins(
      validPlugins,
      previousState,
      'user',
      homeDir,
      dryRun,
      userClientContexts,
      nativeSelection,
    ),
  );

  // Compute deleted artifacts: compare previous state vs what was just synced
  const availableUserSkillNames = await collectAvailableSkillNames(
    filePlugins,
    warnings,
  );
  const allCopyResultsForState = pluginResults.flatMap((r) => r.copyResults);
  const agentDedupeRecords = await dedupePlannedAgentFiles(
    agentOutputPlan,
    allCopyResultsForState,
    dryRun,
    messages,
    warnings,
  );
  // Count results
  const {
    totalCopied,
    totalFailed: fileFailures,
    totalSkipped,
    totalGenerated,
  } = countCopyResults(pluginResults, []);
  const nativeFailures =
    nativeResult?.effects.filter(
      (effect) => effect.action === 'failed' || effect.action === 'unknown',
    ).length ?? 0;
  const totalFailed = fileFailures + nativeFailures;

  const newStatePaths = collectSyncedPaths(
    allCopyResultsForState,
    homeDir,
    syncClients,
    resolvedUserMappings,
    agentDedupeRecords,
    userClientContexts,
  );
  const deletedArtifacts = computeDeletedArtifacts(
    previousState,
    newStatePaths,
    syncClients,
    resolvedUserMappings,
    availableUserSkillNames,
    agentDedupeRecords,
  );

  // Save sync state (including MCP servers and native resources).
  if (!dryRun) {
    await sw.measure('persist-state', () =>
      persistSyncState(homeDir, newStatePaths, {
        ...(Object.keys(mcpResults).length > 0 && {
          mcpTrackedServers: Object.fromEntries(
            Object.entries(mcpResults).map(([scope, r]) => [
              scope,
              r.trackedServers,
            ]),
          ),
        }),
      }),
    );
  }

  const uniqueWarnings = [...new Set(warnings)];
  return {
    success:
      totalFailed === 0 &&
      pluginResults.every((result) => result.success) &&
      nativeResult?.success !== false,
    pluginResults,
    totalCopied,
    totalFailed,
    totalSkipped,
    totalGenerated,
    ...(deletedArtifacts.length > 0 && { deletedArtifacts }),
    ...(uniqueWarnings.length > 0 && { warnings: uniqueWarnings }),
    ...(messages.length > 0 && { messages }),
    ...(Object.keys(mcpResults).length > 0 && { mcpResults }),
    ...(nativeResult && { nativeResult }),
    timing: sw.toJSON(),
  };
}
