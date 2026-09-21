import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE, getHomeDir } from '../constants.js';
import {
  getPluginSource,
  getClientTypes,
  type ClientEntry,
  type ClientType,
  type WorkspaceConfig,
} from '../models/workspace-config.js';
import {
  parsePluginSource,
  parseGitHubUrl,
  getPluginCachePath,
  type ParsedPluginSource,
} from '../utils/plugin-path.js';
import { parseWorkspaceConfig } from '../utils/workspace-parser.js';
import { isPluginSpec, resolvePluginSpec } from './marketplace.js';
import { getUserWorkspaceConfig, isUserConfigPath } from './user-workspace.js';
import {
  getNativeStateResources,
  loadSyncState,
  nativeStateOwnership,
} from './sync-state.js';
import type { NativeStateResource } from '../models/sync-state.js';
import {
  getNativeClient,
  toNativeEffectData,
  type NativeEffectData,
  type NativeOperationContext,
  type NativeResource,
  type NativeResourceObservation,
} from './native/index.js';
import {
  buildPluginSyncPlans,
  nativeContextIdentity,
  nativeOperationContext,
} from './sync.js';
import { resolveClientContexts } from './client-context.js';

/**
 * Status of a single plugin
 */
export interface PluginStatus {
  source: string;
  type: 'local' | 'github' | 'marketplace';
  /**
   * 'skill' when the resolved path looks like a single-skill source (root
   * SKILL.md, no skills/ subdir — matches the auto-wrap layout from #232/#249).
   * 'plugin' otherwise, including when the path can't be inspected (not cached,
   * not synced, missing locally).
   */
  kind: 'skill' | 'plugin';
  available: boolean;
  path: string;
  owner?: string;
  repo?: string;
}

/**
 * Classify a resolved cache/local path as a standalone skill or a plugin
 * bundle. A "skill" has a SKILL.md at its root and no skills/ subdir; anything
 * else (including paths that don't exist) is treated as a plugin.
 */
function classifyKind(path: string): 'skill' | 'plugin' {
  if (!path) return 'plugin';
  try {
    if (
      existsSync(join(path, 'SKILL.md')) &&
      !existsSync(join(path, 'skills'))
    ) {
      return 'skill';
    }
  } catch {
    // ignore — default to plugin
  }
  return 'plugin';
}

export interface NativePluginStatus extends NativeEffectData {
  declared: boolean;
  ownership: 'managed' | 'referenced' | 'uncertain' | 'none';
  transition?: NativeStateResource['transition'];
}

/**
 * Result of workspace status check
 */
export interface WorkspaceStatusResult {
  success: boolean;
  error?: string;
  plugins: PluginStatus[];
  /** User-level plugins from ~/.allagents/workspace.yaml */
  userPlugins?: PluginStatus[];
  clients: string[];
  nativeResources: NativePluginStatus[];
}

function nativeOwnership(
  state: NativeStateResource | undefined,
): NativePluginStatus['ownership'] {
  return state ? nativeStateOwnership(state.transition) : 'none';
}

function stateMatchesResource(
  state: NativeStateResource,
  resource: NativeResource,
): boolean {
  return (
    state.kind === resource.kind &&
    (state.requestedIdentity === resource.requestedIdentity ||
      state.resolvedIdentity === resource.resolvedIdentity)
  );
}

function resourceFromNativeState(
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

function findExactNativeObservation(
  resource: NativeResource,
  observations: readonly NativeResourceObservation[] | undefined,
  inspectedResources: readonly NativeResource[],
): NativeResourceObservation | undefined {
  const observation = observations?.find(
    (candidate) =>
      candidate.resource.kind === resource.kind &&
      candidate.resource.resolvedIdentity === resource.resolvedIdentity,
  );
  if (observation) return observation;

  const inspectedResource = inspectedResources.find(
    (candidate) =>
      candidate.kind === resource.kind &&
      candidate.resolvedIdentity === resource.resolvedIdentity,
  );
  return inspectedResource
    ? { resource: inspectedResource, status: 'installed' }
    : undefined;
}

function statusFromObservation(
  resource: NativeResource,
  observation: NativeResourceObservation | undefined,
  state: NativeStateResource | undefined,
  declared: boolean,
  inspectionError?: string,
): NativePluginStatus {
  const action: NativeEffectData['action'] = inspectionError
    ? 'unknown'
    : observation?.status ?? 'configured-missing';
  return {
    ...toNativeEffectData({
      action,
      phase: 'inspection',
      changed: false,
      resource,
      ...(inspectionError && { error: inspectionError }),
      ...(!inspectionError && observation?.error && {
        error: observation.error,
      }),
    }),
    declared,
    ownership: nativeOwnership(state),
    ...(state && { transition: state.transition }),
  };
}

async function getNativeStatusesForScope(
  config: WorkspaceConfig | null,
  scope: 'user' | 'project',
  workspacePath: string,
): Promise<{ statuses: NativePluginStatus[]; errors: string[] }> {
  const homeDir = getHomeDir();
  const stateRoot = scope === 'user' ? homeDir : workspacePath;
  const state = await loadSyncState(stateRoot);
  const stateResources = (state?.nativeResources?.resources ?? []).filter(
    (resource) => resource.scope === scope && !!getNativeClient(resource.client),
  );
  const clientEntries: ClientEntry[] = config?.clients ?? [];
  const { plans, errors: planErrors } = buildPluginSyncPlans(
    config?.plugins ?? [],
    clientEntries,
    scope,
  );
  const nativePlans = plans.filter((plan) => plan.nativeClients.length > 0);
  // Only inspect native clients that have tracked state. Declarations describe
  // desired sync work; status must not require an installed CLI before sync.
  const clients = [
    ...new Set<ClientType>(
      stateResources.map((resource) => resource.client),
    ),
  ];
  const contexts = resolveClientContexts(clients, scope, {
    cwd: workspacePath,
    homeDir,
    env: process.env,
  });
  const statuses: NativePluginStatus[] = [];
  const errors = [...planErrors];

  for (const client of clients) {
    const adapter = getNativeClient(client);
    const resolvedContext = contexts.get(client);
    if (!adapter || !resolvedContext) {
      errors.push(`${client} has no native lifecycle context`);
      continue;
    }
    const context = nativeOperationContext(client, scope, resolvedContext);
    const desired: NativeResource[] = [];
    for (const plan of nativePlans) {
      if (!plan.nativeClients.includes(client)) continue;
      const resolution = adapter.resolveSource(plan.source, context, {
        source: plan.source,
      });
      if (!resolution.success || !resolution.resource) {
        errors.push(
          resolution.error ?? `${client} rejected '${plan.source}'`,
        );
        continue;
      }
      desired.push(resolution.resource);
    }

    const contextIdentity = nativeContextIdentity(context);
    const tracked = getNativeStateResources(
      state,
      client,
      scope,
      contextIdentity,
    );
    const staleContextState = stateResources.filter(
      (resource) =>
        resource.client === client && resource.context !== contextIdentity,
    );
    const available = await adapter.isAvailable(context);
    const inspection = available
      ? await adapter.inspect(context)
      : {
          success: false,
          resources: [],
          observations: [],
          error: `${client} CLI is unavailable or unsupported`,
        };
    const inspectionError = inspection.success
      ? undefined
      : (inspection.error ?? `${client} native inspection failed`);
    if (inspectionError) errors.push(inspectionError);

    const emittedState = new Set<NativeStateResource>();
    for (const resource of desired) {
      const trackedResource = tracked.find((candidate) =>
        stateMatchesResource(candidate, resource));
      if (trackedResource) emittedState.add(trackedResource);
      const observation = inspection.success
        ? findExactNativeObservation(
            resource,
            inspection.observations,
            inspection.resources,
          )
        : undefined;
      statuses.push(
        statusFromObservation(
          resource,
          observation,
          trackedResource,
          true,
          inspectionError,
        ),
      );
    }

    for (const trackedResource of tracked) {
      if (emittedState.has(trackedResource)) continue;
      const resource = resourceFromNativeState(trackedResource, context);
      const observation = inspection.success
        ? findExactNativeObservation(
            resource,
            inspection.observations,
            inspection.resources,
          )
        : undefined;
      statuses.push(
        statusFromObservation(
          resource,
          observation,
          trackedResource,
          false,
          inspectionError,
        ),
      );
    }

    for (const trackedResource of staleContextState) {
      const staleResource = resourceFromNativeState(trackedResource, context);
      const error = `Recorded native root ${trackedResource.context} differs from selected root ${context.root}`;
      errors.push(error);
      statuses.push(
        statusFromObservation(
          staleResource,
          undefined,
          trackedResource,
          false,
          error,
        ),
      );
    }
  }

  return { statuses, errors: [...new Set(errors)] };
}

/**
 * Get status of workspace and its plugins
 * @param workspacePath - Path to workspace directory (default: cwd)
 * @returns Status result with plugin availability
 */
export async function getWorkspaceStatus(
  workspacePath: string = process.cwd(),
): Promise<WorkspaceStatusResult> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);

  // If no project workspace.yaml, or project config IS the user config
  // (i.e. cwd is the home directory), return user-level plugins only.
  if (!existsSync(configPath) || isUserConfigPath(workspacePath)) {
    const userConfig = await getUserWorkspaceConfig();
    const userPlugins = await getUserPluginStatuses();
    const native = await getNativeStatusesForScope(
      userConfig,
      'user',
      workspacePath,
    );
    return {
      success: native.errors.length === 0,
      ...(native.errors.length > 0 && { error: native.errors.join('; ') }),
      plugins: [],
      userPlugins,
      clients: [],
      nativeResources: native.statuses,
    };
  }

  try {
    const config = await parseWorkspaceConfig(configPath);
    const plugins: PluginStatus[] = [];

    for (const pluginEntry of config.plugins) {
      const pluginSource = getPluginSource(pluginEntry);
      if (isPluginSpec(pluginSource)) {
        const status = await getMarketplacePluginStatus(
          pluginSource,
          workspacePath,
        );
        plugins.push(status);
      } else {
        const parsed = parsePluginSource(pluginSource, workspacePath);
        const status = getPluginStatus(parsed);
        plugins.push(status);
      }
    }

    const userConfig = await getUserWorkspaceConfig();
    const userPlugins = await getUserPluginStatuses();
    const userNative = await getNativeStatusesForScope(
      userConfig,
      'user',
      workspacePath,
    );
    const projectNative = await getNativeStatusesForScope(
      config,
      'project',
      workspacePath,
    );
    const nativeErrors = [...userNative.errors, ...projectNative.errors];

    return {
      success: nativeErrors.length === 0,
      ...(nativeErrors.length > 0 && {
        error: [...new Set(nativeErrors)].join('; '),
      }),
      plugins,
      userPlugins,
      clients: getClientTypes(config.clients),
      nativeResources: [
        ...userNative.statuses,
        ...projectNative.statuses,
      ],
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      plugins: [],
      clients: [],
      nativeResources: [],
    };
  }
}

/**
 * Get status of a single plugin
 */
function getPluginStatus(parsed: ParsedPluginSource): PluginStatus {
  if (parsed.type === 'github') {
    // Check if cached
    const cachePath =
      parsed.owner && parsed.repo
        ? getPluginCachePath(parsed.owner, parsed.repo, parsed.branch)
        : '';
    const available = cachePath ? existsSync(cachePath) : false;

    // For GitHub plugins with a subpath, classify the resolved subdir rather
    // than the repo root — that's what users actually consume. ParsedPluginSource
    // drops the subpath, so re-parse the original URL to recover it.
    const subpath = parseGitHubUrl(parsed.original)?.subpath;
    const classifyPath =
      available && cachePath
        ? subpath
          ? join(cachePath, subpath)
          : cachePath
        : '';

    return {
      source: parsed.original,
      type: 'github',
      kind: classifyKind(classifyPath),
      available,
      path: cachePath,
      ...(parsed.owner && { owner: parsed.owner }),
      ...(parsed.repo && { repo: parsed.repo }),
    };
  }

  // Local plugin - check if path exists
  const available = existsSync(parsed.normalized);

  return {
    source: parsed.original,
    type: 'local',
    kind: classifyKind(available ? parsed.normalized : ''),
    available,
    path: parsed.normalized,
  };
}

/**
 * Get statuses for all user-level plugins from ~/.allagents/workspace.yaml
 */
async function getUserPluginStatuses(): Promise<PluginStatus[]> {
  const config = await getUserWorkspaceConfig();
  if (!config) return [];

  const statuses: PluginStatus[] = [];
  for (const pluginEntry of config.plugins) {
    const pluginSource = getPluginSource(pluginEntry);
    if (isPluginSpec(pluginSource)) {
      statuses.push(await getMarketplacePluginStatus(pluginSource));
    } else {
      const parsed = parsePluginSource(pluginSource, getHomeDir());
      statuses.push(getPluginStatus(parsed));
    }
  }
  return statuses;
}

/**
 * Get status of a plugin@marketplace spec
 */
async function getMarketplacePluginStatus(
  spec: string,
  workspacePath?: string,
): Promise<PluginStatus> {
  const resolved = await resolvePluginSpec(spec, {
    offline: true,
    ...(workspacePath && { workspacePath }),
  });
  const path = resolved?.path ?? '';

  return {
    source: spec,
    type: 'marketplace',
    kind: classifyKind(path),
    available: resolved !== null,
    path,
  };
}
