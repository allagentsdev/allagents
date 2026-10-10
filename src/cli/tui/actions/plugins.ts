import * as p from '@clack/prompts';
import {
  addPluginForTarget,
  resolveMarketplacePluginDeclaration,
  removePlugin,
  removeDisabledSkill,
  addEnabledSkill,
  setPluginSkillsMode,
  setPluginMcpServersExcluded,
} from '../../../core/workspace-modify.js';
import {
  addUserPluginForTarget,
  isUserConfigPath,
  removeUserPlugin,
  removeUserDisabledSkill,
  addUserEnabledSkill,
  setUserPluginSkillsMode,
  setUserPluginMcpServersExcluded,
  getInstalledUserPlugins,
  getInstalledProjectPlugins,
  getUserPluginsForMarketplace,
  getUserWorkspaceConfig,
} from '../../../core/user-workspace.js';
import {
  buildPluginSyncPlans,
  preflightNativePluginDeclaration,
  syncWorkspace,
  syncUserWorkspace,
  validateAllPlugins,
  type SyncResult,
} from '../../../core/sync.js';
import { syncMcpOnly, syncUserMcpOnly } from '../../../core/mcp-sync.js';
import {
  listMarketplaces,
  listMarketplacePlugins,
  addMarketplace,
  removeMarketplace,
  updateMarketplace,
  findMarketplaceRegistration,
  getMarketplaceAccessError,
  parsePluginSpec,
  isPluginSpec,
  type MarketplaceEntry,
  type MarketplacePluginsResult,
} from '../../../core/marketplace.js';
import { resetFetchCache, updatePlugin, type InstalledPluginUpdateResult } from '../../../core/plugin.js';
import { toNativeEffectData } from '../../../core/native/types.js';
import { settleNativePluginUpdate } from '../../native-plugin-update.js';
import { UpdateContext } from '../../../core/update-context.js';
import { terminalSafe } from '../../terminal-output.js';
import { formatVerboseSyncLines } from '../../format-sync.js';
import { parseMarketplaceManifest } from '../../../utils/marketplace-manifest-parser.js';
import { getWorkspaceStatus } from '../../../core/status.js';
import { getAllSkillsFromPlugins, getNativePluginSources, discoverSkillNames, NATIVE_SKILL_SELECTION_ERROR } from '../../../core/skills.js';
import {
  CONFIG_DIR,
  WORKSPACE_CONFIG_FILE,
  getHomeDir,
} from '../../../constants.js';
import { getPluginSource, type ClientEntry, type PluginEntry } from '../../../models/workspace-config.js';
import { mcpClientIdsForScope } from '../../../models/client-mapping.js';
import { readPluginMcpConfig } from '../../../core/vscode-mcp.js';
import type { TuiContext } from '../context.js';
import type { TuiCache } from '../cache.js';
import { removeInstalledSkill } from '../../skill-removal.js';
import {
  buildSkillUpdateInventory,
  createSkillUpdateNodePrecheck,
  type SkillUpdateNodePrecheckDependencies,
  executePreparedSkillUpdate,
  inspectSkillUpdateUnit,
  resolveNonInteractiveSkillUpdateDecisions,
  unitDisplayName,
} from '../../skill-update.js';
import {
  buildPhysicalRefreshUnits,
  buildSkillUpdatePreflight,
  type SkillUpdatePreflight,
  type SkillUpdateScope,
} from '../../../core/skill-update.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorkspaceConfig } from '../../../utils/workspace-parser.js';
import {
  resolveInstallTarget,
  type InstallScope,
} from '../../install-target.js';
import { createClackInstallTargetPromptPort } from '../install-target-prompts.js';
import { formatPluginSource } from '../../../utils/plugin-path.js';

const { select, text, confirm, multiselect, autocomplete } = p;

/**
 * Create dependencies for updatePlugin. Physical work is shared by the action
 * context while each consumer retains its own marketplace result and write.
 */
function createUpdateDeps(
  updateContext: UpdateContext,
  workspacePath?: string,
  cache?: TuiCache,
) {
  return {
    parsePluginSpec,
    getMarketplaceRegistration: (name: string, sourceLocation?: string) =>
      findMarketplaceRegistration(name, sourceLocation, workspacePath),
    validateMarketplaceAccess: getMarketplaceAccessError,
    parseMarketplaceManifest,
    updateMarketplace: async (name: string) => {
      const result = await updateMarketplace(
        name,
        workspacePath,
        {},
        updateContext,
      );
      if (result.some((entry) => entry.success)) {
        cache?.invalidate();
      }
      return result;
    },
  };
}

/**
 * Get marketplace list, using cache when available.
 */
async function getCachedMarketplaces(
  cache?: TuiCache,
): Promise<MarketplaceEntry[]> {
  const cached = cache?.getMarketplaces();
  if (cached) return cached;

  const result = await listMarketplaces();
  cache?.setMarketplaces(result);
  return result;
}

/**
 * Get marketplace plugins, using cache when available.
 */
async function getCachedMarketplacePlugins(
  name: string,
  cache?: TuiCache,
): Promise<MarketplacePluginsResult> {
  const cached = cache?.getMarketplacePlugins(name);
  if (cached) return cached;

  const result = await listMarketplacePlugins(name);
  cache?.setMarketplacePlugins(name, result);
  return result;
}

export type InstallSelectedPluginResult =
  | { status: 'installed'; scope: InstallScope; source: string }
  | { status: 'cancelled' }
  | { status: 'failed' };

/**
 * Resolve the target, install a plugin, run the existing full-scope sync, and
 * return the exact installed scope to callers.
 */
export async function installSelectedPlugin(
  pluginRef: string,
  context: TuiContext,
  cache?: TuiCache,
): Promise<InstallSelectedPluginResult> {
  const workspacePath = context.workspacePath ?? process.cwd();
  const projectConfigPath = join(
    workspacePath,
    CONFIG_DIR,
    WORKSPACE_CONFIG_FILE,
  );
  const target = await resolveInstallTarget({
    workspacePath,
    declaration: pluginRef,
    action: 'Install plugin',
    payload: pluginRef,
    scopeStates: {
      project: async () => {
        if (
          isUserConfigPath(workspacePath) ||
          !existsSync(projectConfigPath)
        ) {
          return null;
        }
        const config = await parseWorkspaceConfig(projectConfigPath);
        return { clients: config.clients, plugins: config.plugins };
      },
      user: async () => {
        const config = await getUserWorkspaceConfig();
        return config
          ? { clients: config.clients, plugins: config.plugins }
          : null;
      },
    },
    environment: {
      json: false,
      ci: false,
      stdinIsTTY: true,
      stdoutIsTTY: true,
    },
    prompts: createClackInstallTargetPromptPort(),
  });

  if (!target) {
    return { status: 'cancelled' };
  }
  const selectedClientEntries = target.selectedClientEntries;
  const marketplaceSpec = isPluginSpec(
    getPluginSource(target.prospectiveDeclaration),
  );
  let prospectiveDeclaration = target.prospectiveDeclaration;
  if (marketplaceSpec) {
    const resolution = await resolveMarketplacePluginDeclaration(
      prospectiveDeclaration,
      target.scope === 'project' ? workspacePath : undefined,
    );
    if (!resolution.success) {
      p.note(resolution.error, 'Installation failed');
      return { status: 'failed' };
    }
    prospectiveDeclaration = resolution.declaration;
  }

  const nativePreflightErrors = await preflightNativePluginDeclaration(
    prospectiveDeclaration,
    selectedClientEntries,
    target.scope,
    workspacePath,
  );
  if (nativePreflightErrors.length > 0) {
    p.note(
      `Native preflight failed; workspace declaration was not changed: ${nativePreflightErrors.join('; ')}`,
      'Installation failed',
    );
    return { status: 'failed' };
  }

  const installPlan = buildPluginSyncPlans(
    [prospectiveDeclaration],
    selectedClientEntries,
    target.scope,
  ).plans[0];
  const nativeOnly =
    !!installPlan &&
    installPlan.clients.length === 0 &&
    installPlan.nativeClients.length > 0;
  const installTarget = {
    declaration: prospectiveDeclaration,
    clients: target.clients,
    ...((marketplaceSpec || nativeOnly) && {
      sourceValidation: 'declaration' as const,
    }),
  };

  const s = p.spinner();
  s.start('Installing plugin...');
  const result =
    target.scope === 'project'
      ? await addPluginForTarget(installTarget, workspacePath)
      : await addUserPluginForTarget(installTarget);
  if (!result.success) {
    s.stop('Installation failed');
    p.note(result.error ?? 'Unknown error', 'Error');
    return { status: 'failed' };
  }

  s.message('Updating...');
  const syncResult: SyncResult =
    target.scope === 'project'
      ? await syncWorkspace(workspacePath)
      : await syncUserWorkspace();
  s.stop('Installed');

  cache?.invalidate();
  const source = result.normalizedPlugin ?? pluginRef;
  const lines = formatVerboseSyncLines(syncResult);
  p.note(lines.join('\n'), `Installed: ${source}`);
  return { status: 'installed', scope: target.scope, source };
}

/**
 * Update a single plugin.
 */
async function runUpdatePlugin(
  pluginSource: string,
  scope: 'project' | 'user',
  index: number,
  context: TuiContext,
  cache?: TuiCache,
): Promise<void> {
  const updateContext = new UpdateContext();
  const s = p.spinner();
  s.start('Updating plugin...');
  try {
    const workspacePath = context.workspacePath ?? process.cwd();
    const config = await getPluginConfiguration(scope, workspacePath);
    const entry = config?.plugins[index];
    if (!config || !entry || getPluginSource(entry) !== pluginSource) {
      throw new Error('Selected plugin declaration changed. Reopen Plugins before updating.');
    }
    const plan = buildPluginSyncPlans([entry], config.clients, scope).plans[0];
    const native = !!plan?.nativeClients.length;
    const nativeOnly = native && plan.clients.length === 0;
    const errors = await preflightNativePluginDeclaration(entry, config.clients, scope, workspacePath);
    if (errors.length > 0) throw new Error(errors.join('; '));

    let result: InstalledPluginUpdateResult = nativeOnly
      ? { plugin: pluginSource, success: true, action: 'skipped' }
      : await updatePlugin(
          plan?.source ?? pluginSource,
          createUpdateDeps(updateContext, scope === 'project' ? workspacePath : undefined, cache),
          updateContext,
        );
    if (!result.success || result.action === 'failed') throw new Error(result.error ?? 'Update failed');

    const options = {
      offline: true,
      skipAgentFiles: true,
      nativeSelection: { mode: 'update' as const, targets: native ? [plan.source] : [], clients: plan?.nativeClients ?? [] },
    };
    const synced = scope === 'project'
      ? await syncWorkspace(workspacePath, options)
      : await syncUserWorkspace(options);
    cache?.invalidate();
    if (native) {
      const settled = settleNativePluginUpdate(plan.source, (synced.nativeResult?.effects ?? []).map(toNativeEffectData), plan.nativeClients);
      if (!settled.success) throw new Error(settled.error ?? 'Native update failed');
      if (nativeOnly || settled.action === 'updated') result = settled;
    }
    if (!synced.success) throw new Error(synced.error ?? ((synced.warnings ?? []).join('; ') || 'Update failed'));
    s.stop(result.action === 'updated' ? 'Updated' : 'Already up to date');
    p.note(
      result.action === 'updated' ? `\u2713 ${pluginSource} (${result.action})` : `- ${pluginSource} (${result.action})`,
      'Update',
    );
  } catch (error) {
    s.stop('Update failed');
    p.note(error instanceof Error ? error.message : String(error), 'Error');
  } finally {
    updateContext.dispose();
  }
}

/**
 * Update all installed plugins.
 */
export async function runUpdateAllPlugins(
  context: TuiContext,
  cache?: TuiCache,
  skillPrecheckDependencies: SkillUpdateNodePrecheckDependencies = {},
): Promise<void> {
  const updateContext = new UpdateContext();
  const s = p.spinner();
  s.start('Gathering plugins...');
  try {
    await runUpdateAllPluginsWithContext(
      context,
      updateContext,
      s,
      cache,
      skillPrecheckDependencies,
    );
  } catch (error) {
    s.error('Update failed');
    throw error;
  } finally {
    updateContext.dispose();
  }
}

async function runUpdateAllPluginsWithContext(
  context: TuiContext,
  updateContext: UpdateContext,
  s: p.SpinnerResult,
  cache?: TuiCache,
  skillPrecheckDependencies: SkillUpdateNodePrecheckDependencies = {},
): Promise<void> {
  // Collect all installed plugins
  const pluginsToUpdate: Array<{ spec: string; effectiveSpec: string; scope: 'project' | 'user' }> = [];

  if (context.workspacePath) {
    const projectPlugins = await getInstalledProjectPlugins(context.workspacePath);
    for (const plugin of projectPlugins) {
      pluginsToUpdate.push({ spec: plugin.spec, effectiveSpec: plugin.effectiveSpec, scope: 'project' });
    }
  }

  const userPlugins = await getInstalledUserPlugins();
  for (const plugin of userPlugins) {
    if (!pluginsToUpdate.some((existing) =>
      existing.spec === plugin.spec && existing.scope === 'user'
    )) {
      pluginsToUpdate.push({ spec: plugin.spec, effectiveSpec: plugin.effectiveSpec, scope: 'user' });
    }
  }

  if (pluginsToUpdate.length === 0) {
    s.stop('No plugins to update');
    return;
  }

  s.message(`Updating ${pluginsToUpdate.length} plugin(s)...`);

  const projectDeps = createUpdateDeps(
    updateContext,
    context.workspacePath ?? undefined,
    cache,
  );
  const userDeps = createUpdateDeps(updateContext, undefined, cache);

  const results: Array<{ plugin: string; scope?: 'project' | 'user'; action: string; error?: string }> = [];
  const nativeTargets = { project: [] as string[], user: [] as string[] };
  const nativeOnly = new Set<string>();
  const nativeSources = new Map<string, string>();
  for (const { spec, scope } of pluginsToUpdate) {
    const config = await getPluginConfiguration(scope, context.workspacePath ?? process.cwd());
    if (!config) throw new Error('Workspace configuration changed. Reopen Workspace before updating.');
    const entries = config.plugins.filter((entry) => getPluginSource(entry) === spec);
    const plans = buildPluginSyncPlans(entries, config.clients, scope).plans;
    for (const entry of entries) {
      const errors = await preflightNativePluginDeclaration(entry, config.clients, scope, context.workspacePath ?? process.cwd());
      if (errors.length > 0) throw new Error(errors.join('; '));
    }
    const nativePlans = plans.filter((plan) => plan.nativeClients.length > 0);
    nativeTargets[scope].push(...nativePlans.map((plan) => plan.source));
    const firstNative = nativePlans[0];
    if (firstNative) {
      nativeSources.set(`${scope}:${spec}`, firstNative.source);
      if (plans.every((plan) => plan.clients.length === 0)) nativeOnly.add(`${scope}:${spec}`);
    }
  }
  let needsProjectSync = false;
  let needsUserSync = false;
  const scopes = [
    ...new Set(pluginsToUpdate.map(({ scope }) => scope)),
  ] as SkillUpdateScope[];
  const workspacePath = context.workspacePath ?? process.cwd();
  const inventory = await buildSkillUpdateInventory(workspacePath, scopes);
  const standaloneIds = new Set(
    inventory.installations
      .filter(
        (installation) =>
          installation.standaloneSkillSource &&
          scopes.includes(installation.scope),
      )
      .map((installation) => installation.id),
  );
  const standaloneUnits = buildPhysicalRefreshUnits(
    inventory.installations,
  ).filter((unit) =>
    unit.installations.some((installation) =>
      standaloneIds.has(installation.id),
    ),
  );
  const handledPlugins = new Set<string>();
  let standalonePlan: SkillUpdatePreflight | undefined;

  if (standaloneUnits.length > 0) {
    const installations = standaloneUnits.flatMap(
      (unit) => unit.installations,
    );
    const nodeIds = new Set(
      standaloneUnits.flatMap((unit) => unit.nodes.map((node) => node.id)),
    );
    const failures = inventory.failures.filter((failure) =>
      failure.nodeIds.some((nodeId) => nodeIds.has(nodeId)),
    );
    standalonePlan = await buildSkillUpdatePreflight(
      {
        installations,
        selectedScopes: scopes,
        failures,
      },
      {
        inspectUnit: inspectSkillUpdateUnit,
        precheckNode: createSkillUpdateNodePrecheck(
          updateContext,
          skillPrecheckDependencies,
        ),
        onUnitCheckStart: (unit) =>
          s.message(`Updating ${terminalSafe(unitDisplayName(unit))}...`),
      },
    );

    for (const installation of installations) {
      if (scopes.includes(installation.scope)) {
        handledPlugins.add(`${installation.scope}:${installation.rawSource}`);
      }
    }
    for (const failure of failures) {
      handledPlugins.add(`${failure.scope}:${failure.source}`);
    }
    for (const consumer of inventory.directRemoteConsumers) {
      if (
        scopes.includes(consumer.scope) &&
        nodeIds.has(consumer.nodeId)
      ) {
        handledPlugins.add(`${consumer.scope}:${consumer.source}`);
      }
    }
  }

  resetFetchCache();
  // Refresh generic sources before standalone execution performs its offline
  // scope sync, otherwise that sync's fetch-cache entries can mask updates.
  for (const { spec, effectiveSpec, scope } of pluginsToUpdate) {
    if (handledPlugins.has(`${scope}:${spec}`)) continue;
    s.message(`Updating ${terminalSafe(formatPluginSource(spec))}...`);
    const result = nativeOnly.has(`${scope}:${spec}`)
      ? { action: 'skipped' }
      : await updatePlugin(
          effectiveSpec,
          scope === 'project' ? projectDeps : userDeps,
          updateContext,
        );
    const entry: { plugin: string; scope: 'project' | 'user'; action: string; error?: string } = {
      plugin: spec,
      scope,
      action: result.action,
    };
    if ('error' in result && result.error) entry.error = result.error;
    results.push(entry);
    if (result.action === 'updated' || result.action === 'skipped') {
      // A current checkout still re-materializes client artifacts and retries
      // an earlier sync failure.
      if (scope === 'project') needsProjectSync = true;
      else needsUserSync = true;
    }
  }

  const standaloneSyncedScopes = new Set<SkillUpdateScope>();
  if (standalonePlan) {
    const prepared = { inventory, plan: standalonePlan };
    const executionUnits = standalonePlan.units;
    let currentExecutionUnitIndex = 0;
    const firstExecutionUnit = executionUnits[currentExecutionUnitIndex];
    if (firstExecutionUnit) {
      s.message(
        `Updating ${terminalSafe(unitDisplayName(firstExecutionUnit))}...`,
      );
    }
    const execution = await executePreparedSkillUpdate(
      prepared,
      resolveNonInteractiveSkillUpdateDecisions(standalonePlan),
      workspacePath,
      {
        onUnitResult: (result) => {
          // Scope-sync failures are synthetic results, not standalone units.
          const currentUnit = executionUnits[currentExecutionUnitIndex];
          if (!currentUnit || result.id !== currentUnit.id) return;
          currentExecutionUnitIndex++;
          const nextUnit = executionUnits[currentExecutionUnitIndex];
          if (nextUnit) {
            s.message(`Updating ${terminalSafe(unitDisplayName(nextUnit))}...`);
          }
        },
      },
    );
    const planById = new Map(
      standalonePlan.units.map((unit) => [unit.id, unit]),
    );

    for (const scope of execution.syncedScopes) {
      standaloneSyncedScopes.add(scope);
    }
    for (const result of execution.units) {
      const unit = planById.get(result.id);
      const action =
        result.status === 'updated' || result.status === 'removed'
          ? 'updated'
          : result.status === 'failed'
            ? 'failed'
            : 'skipped';
      results.push({
        plugin: unit ? unitDisplayName(unit) : result.id,
        action,
        ...(result.error && { error: result.error }),
      });
    }
    if (execution.units.some((result) =>
      result.status === 'updated' || result.status === 'removed'
    )) {
      cache?.invalidate();
    }
  }

  // Generic sources have already refreshed above. Materialize from those cache
  // revisions without letting a retained or failed standalone unit advance.
  const nativeSyncResults = new Map<'project' | 'user', SyncResult>();
  if (
    (needsProjectSync && !standaloneSyncedScopes.has('project')) ||
    (needsUserSync && !standaloneSyncedScopes.has('user')) ||
    nativeTargets.project.length > 0 || nativeTargets.user.length > 0
  ) {
    if (
      ((needsProjectSync && !standaloneSyncedScopes.has('project')) || nativeTargets.project.length > 0) &&
      context.workspacePath
    ) {
      nativeSyncResults.set('project', await syncWorkspace(context.workspacePath, {
        offline: true, skipAgentFiles: true,
        nativeSelection: { mode: 'update', targets: nativeTargets.project },
      }));
    }
    if ((needsUserSync && !standaloneSyncedScopes.has('user')) || nativeTargets.user.length > 0) {
      nativeSyncResults.set('user', await syncUserWorkspace({
        offline: true, skipAgentFiles: true,
        nativeSelection: { mode: 'update', targets: nativeTargets.user },
      }));
    }
    cache?.invalidate();
  }

  for (const { spec, scope } of pluginsToUpdate) {
    const source = nativeSources.get(`${scope}:${spec}`);
    if (!source) continue;
    const synced = nativeSyncResults.get(scope);
    const settled = settleNativePluginUpdate(source, (synced?.nativeResult?.effects ?? []).map(toNativeEffectData));
    const result = results.find((entry) => entry.plugin === spec && entry.scope === scope);
    if (result) {
      if (result.action !== 'failed' && (nativeOnly.has(`${scope}:${spec}`) || !settled.success || settled.action === 'updated')) {
        result.action = settled.action;
      }
      if (settled.error) result.error = [result.error, settled.error].filter(Boolean).join('; ');
    }
  }
  for (const [scope, synced] of nativeSyncResults) {
    const error = synced.error ?? ((synced.warnings ?? []).join('; ') || 'Synchronization failed');
    if (!synced.success && !results.some((entry) => entry.scope === scope && entry.action === 'failed' && entry.error === error)) {
      results.push({ plugin: `${scope} synchronization`, scope, action: 'failed', error });
    }
  }
  s.stop('Update complete');

  // Show results
  const updated = results.filter((r) => r.action === 'updated').length;
  const skipped = results.filter((r) => r.action === 'skipped').length;
  const failed = results.filter((r) => r.action === 'failed').length;

  const lines = results.map((r) => {
    const icon = r.action === 'updated' ? '\u2713' : r.action === 'skipped' ? '-' : '\u2717';
    return `${icon} ${r.plugin} (${r.action})${r.error ? ` - ${r.error}` : ''}`;
  });
  lines.push('');
  lines.push(`Updated: ${updated}  Skipped: ${skipped}  Failed: ${failed}`);

  p.note(lines.join('\n'), 'Update Results');
}

async function getPluginConfiguration(scope: 'project' | 'user', workspacePath: string) {
  if (scope === 'user') return getUserWorkspaceConfig();
  const path = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  return existsSync(path) ? parseWorkspaceConfig(path) : null;
}

function describePluginInstall(
  entry: PluginEntry,
  clients: ClientEntry[],
  scope: 'project' | 'user',
): string {
  const plan = buildPluginSyncPlans([entry], clients, scope).plans[0];
  if (!plan) return '';
  return [
    ...plan.nativeClients.map((client) => `native ${client}`),
    ...plan.clients.map((client) => `file ${client}`),
  ].join(', ');
}

/**
 * Plugins sub-menu.
 * Lists installed plugins (click to remove) and offers adding new ones.
 * Follows the marketplace pattern: list items, drill into details.
 */
export async function runPlugins(context: TuiContext, cache?: TuiCache): Promise<void> {
  try {
    while (true) {
      // Select a resource here; bulk updates live under Workspace -> Status.
      const options: Array<{ label: string; value: string; hint?: string }> = [
        { label: '+ Add plugin', value: '__add__' },
      ];

      const pluginTargets = new Map<
        string,
        { source: string; scope: 'project' | 'user'; index: number }
      >();
      // Gather installed plugins from status
      let status = cache?.getStatus();
      if (!status) {
        status = await getWorkspaceStatus(context.workspacePath ?? undefined);
        cache?.setStatus(status);
      }

      if (status.success) {
        for (const scope of ['project', 'user'] as const) {
          const plugins = scope === 'project' ? status.plugins : (status.userPlugins ?? []);
          if (plugins.length === 0) continue;
          const config = await getPluginConfiguration(scope, context.workspacePath ?? process.cwd());
          const counts = new Map<string, number>();
          for (const plugin of plugins) {
            counts.set(plugin.source, (counts.get(plugin.source) ?? 0) + 1);
          }
          for (const [index, plugin] of plugins.entries()) {
            const count = counts.get(plugin.source) ?? 1;
            const key = `${scope}:${plugin.source}${count > 1 ? `\0${index}` : ''}`;
            pluginTargets.set(key, { source: plugin.source, scope, index });
            const entry = config?.plugins[index];
            const install = config && entry && getPluginSource(entry) === plugin.source
              ? describePluginInstall(entry, config.clients, scope)
              : '';
            options.push({
              label: plugin.source,
              value: key,
              hint: `${plugin.kind} · ${plugin.type}${install ? ` · ${install}` : ''} · ${scope}${count > 1 ? ` · entry ${index + 1}` : ''}`,
            });
          }
        }
      }

      options.push({ label: 'Back', value: '__back__' });

      const selected = await select({
        message: 'Plugins',
        options,
      });

      if (p.isCancel(selected) || selected === '__back__') {
        return;
      }

      if (selected === '__add__') {
        await runInstallPlugin(context, cache);
        continue;
      }

      const target = pluginTargets.get(selected);
      if (target) {
        await runPluginDetail(target, context, cache);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.note(message, 'Error');
  }
}

/**
 * Determine the current skills mode for a plugin.
 * Returns 'allowlist' if the plugin uses an explicit skill list,
 * or 'blocklist' if it uses exclude or has no skills config.
 */
async function getPluginSkillsMode(
  pluginSource: string,
  scope: 'project' | 'user',
  workspacePath: string,
): Promise<'allowlist' | 'blocklist'> {
  const effectivePath = scope === 'user' ? getHomeDir() : workspacePath;
  const allSkills = await getAllSkillsFromPlugins(effectivePath);
  const pluginSkills = allSkills.filter((s) => s.pluginSource === pluginSource);
  const first = pluginSkills[0];
  if (first && first.pluginSkillsMode === 'allowlist') {
    return 'allowlist';
  }
  return 'blocklist';
}

interface PluginMcpSelection {
  names: string[];
  excluded: string[];
  retryRequired?: boolean;
}

/**
 * Resolve only this installed declaration, and only when it has file-installed
 * clients. A native install may have a .mcp.json but never has per-server
 * controls in allagents.
 */
async function getPluginMcpSelection(
  source: string,
  scope: 'project' | 'user',
  workspacePath: string,
  configurationIndex: number,
): Promise<PluginMcpSelection | null> {
  const root = scope === 'user' ? getHomeDir() : workspacePath;
  const config = scope === 'user'
    ? await getUserWorkspaceConfig()
    : await parseWorkspaceConfig(join(root, CONFIG_DIR, WORKSPACE_CONFIG_FILE));
  if (!config) return null;
  const entry = config.plugins[configurationIndex];
  if (!entry || getPluginSource(entry) !== source) return null;
  const plan = buildPluginSyncPlans([entry], config.clients, scope).plans[0];
  const mcpClients = mcpClientIdsForScope(scope);
  if (!plan?.clients.some((client) => mcpClients.includes(client))) return null;

  const [validated] = await validateAllPlugins([plan], root, true);
  if (!validated?.success || validated.fileArtifacts?.mcpServers === false) {
    return null;
  }
  const servers = readPluginMcpConfig(validated.resolved);
  const names = Object.keys(servers ?? {});
  if (names.length === 0) return null;
  return {
    names,
    excluded: typeof entry === 'string' ? [] : entry.mcpServers?.exclude ?? [],
  };
}

async function runPluginMcpSelection(
  source: string,
  scope: 'project' | 'user',
  workspacePath: string,
  selection: PluginMcpSelection,
  configurationIndex: number,
  cache?: TuiCache,
): Promise<void> {
  const previous = new Set(selection.excluded);
  const selected = await multiselect({
    message: `Toggle MCP servers in ${source} (selected = enabled)`,
    options: selection.names.map((name) => ({ label: name, value: name })),
    initialValues: selection.names.filter((name) => !previous.has(name)),
    required: false,
  });
  if (p.isCancel(selected)) return;

  const enabled = new Set(selected);
  const toEnable = selection.names.filter(
    (name) => previous.has(name) && enabled.has(name),
  );
  const toDisable = selection.names.filter(
    (name) => !previous.has(name) && !enabled.has(name),
  );
  const changed = toEnable.length > 0 || toDisable.length > 0;
  if (!changed && !selection.retryRequired) {
    p.note('No changes made.', 'MCP servers');
    return;
  }

  // Keep exclusions for servers not currently discoverable in the checkout.
  const discoverable = new Set(selection.names);
  const excluded = [
    ...selection.excluded.filter((name) => !discoverable.has(name)),
    ...selection.names.filter((name) => !enabled.has(name)),
  ];
  const s = p.spinner();
  s.start('Updating MCP servers...');
  if (changed) {
    const result = scope === 'project'
      ? await setPluginMcpServersExcluded(source, excluded, workspacePath, configurationIndex)
      : await setUserPluginMcpServersExcluded(source, excluded, configurationIndex);
    if (!result.success) {
      s.stop('Update failed');
      p.note(result.error ?? 'Unknown error', 'Error');
      return;
    }
    selection.excluded = excluded;
  }
  s.message('Updating...');
  selection.retryRequired = true;
  try {
    const syncResult = scope === 'project'
      ? await syncMcpOnly(workspacePath, { offline: true })
      : await syncUserMcpOnly({ offline: true });
    if (!syncResult.success) {
      throw new Error(syncResult.error ?? syncResult.warnings.join('; '));
    }
  } catch (error) {
    s.stop('Update failed');
    const message = error instanceof Error ? error.message : String(error);
    p.note(`Selection saved, but MCP update failed: ${message}. Reopen MCP servers and confirm to retry.`, 'Error');
    return;
  }
  selection.retryRequired = false;
  s.stop('Updated');
  cache?.invalidate();
  p.note(
    changed
      ? [
          ...toEnable.map((name) => `✓ Enabled: ${name}`),
          ...toDisable.map((name) => `✗ Disabled: ${name}`),
        ].join('\n')
      : 'Saved selection applied.',
    'MCP servers updated',
  );
}

/**
 * Plugin detail screen.
 * Shows actions for a specific installed plugin: browse skills, remove.
 */
async function runPluginDetail(
  { source: pluginSource, scope, index }: {
    source: string;
    scope: 'project' | 'user';
    index: number;
  },
  context: TuiContext,
  cache?: TuiCache,
): Promise<void> {
  let mcpSelection: PluginMcpSelection | null | undefined;

  while (true) {
    const workspacePath = context.workspacePath ?? process.cwd();
    const native = (await getNativePluginSources(
      scope === 'user' ? getHomeDir() : workspacePath,
      scope,
    )).has(pluginSource);
    const currentMode = native
      ? null
      : await getPluginSkillsMode(pluginSource, scope, workspacePath);
    if (mcpSelection === undefined) {
      mcpSelection = await getPluginMcpSelection(pluginSource, scope, workspacePath, index);
    }
    const config = await getPluginConfiguration(scope, workspacePath);
    const entry = config?.plugins[index];
    const install = config && entry && getPluginSource(entry) === pluginSource
      ? describePluginInstall(entry, config.clients, scope)
      : '';
    const autoEnableLabel = currentMode === 'allowlist'
      ? 'Auto-enable new skills: OFF'
      : 'Auto-enable new skills: ON';

    const action = await select({
      message: `Plugin: ${pluginSource} [${scope}]${install ? ` · ${install}` : native ? ' · native' : ''}`,
      options: [
        ...(!native
          ? [{ label: 'Browse skills', value: 'browse' as const }]
          : []),
        ...(mcpSelection
          ? [{ label: 'MCP servers', value: 'mcp_servers' as const }]
          : []),
        ...(!native
          ? [{ label: autoEnableLabel, value: 'toggle_auto_enable' as const }]
          : []),
        { label: 'Update', value: 'update' as const },
        { label: 'Remove', value: 'remove' as const },
        { label: 'Back', value: 'back' as const },
      ],
    });

    if (p.isCancel(action) || action === 'back') {
      return;
    }

    if (action === 'browse') {
      await runBrowsePluginSkills(pluginSource, scope, context, cache);
      continue;
    }

    if (action === 'mcp_servers' && mcpSelection) {
      await runPluginMcpSelection(
        pluginSource,
        scope,
        workspacePath,
        mcpSelection,
        index,
        cache,
      );
      continue;
    }

    if (action === 'toggle_auto_enable') {
      const effectivePath = scope === 'user' ? getHomeDir() : workspacePath;
      const allSkills = await getAllSkillsFromPlugins(effectivePath);
      const pluginSkills = allSkills.filter((s) => s.pluginSource === pluginSource);

      const firstSkill = pluginSkills[0];
      if (!firstSkill) {
        p.note('No skills found in this plugin.', 'Skills');
        continue;
      }

      const pluginName = firstSkill.pluginName;
      const s = p.spinner();

      if (currentMode === 'allowlist') {
        // Switching to blocklist (OFF → ON): collect currently disabled skills
        const disabledNames = pluginSkills.filter((sk) => sk.disabled).map((sk) => sk.name);
        s.start('Switching to auto-enable...');
        const result = scope === 'user'
          ? await setUserPluginSkillsMode(pluginName, 'blocklist', disabledNames)
          : await setPluginSkillsMode(pluginName, 'blocklist', disabledNames, workspacePath);
        if (!result.success) {
          s.stop('Failed');
          p.note(result.error ?? 'Unknown error', 'Error');
          continue;
        }
      } else {
        // Switching to allowlist (ON → OFF): collect currently enabled skills
        const enabledNames = pluginSkills.filter((sk) => !sk.disabled).map((sk) => sk.name);
        s.start('Switching to manual approval...');
        const result = scope === 'user'
          ? await setUserPluginSkillsMode(pluginName, 'allowlist', enabledNames)
          : await setPluginSkillsMode(pluginName, 'allowlist', enabledNames, workspacePath);
        if (!result.success) {
          s.stop('Failed');
          p.note(result.error ?? 'Unknown error', 'Error');
          continue;
        }
      }

      // Sync
      s.message('Updating...');
      if (scope === 'project' && context.workspacePath) {
        await syncWorkspace(context.workspacePath);
      } else {
        await syncUserWorkspace();
      }
      s.stop('Updated');
      cache?.invalidate();

      const newMode = currentMode === 'allowlist' ? 'ON' : 'OFF';
      p.note(`Auto-enable new skills: ${newMode}`, 'Updated');
      continue;
    }

    if (action === 'update') {
      await runUpdatePlugin(pluginSource, scope, index, context, cache);
      mcpSelection = undefined;
      continue;
    }

    if (action === 'remove') {
      const confirmed = await confirm({
        message: `Remove plugin "${pluginSource}"?`,
      });

      if (p.isCancel(confirmed) || !confirmed) {
        continue;
      }

      const s = p.spinner();
      s.start('Removing plugin...');

      const result = scope === 'project'
        ? await removePlugin(pluginSource, workspacePath, index)
        : await removeUserPlugin(pluginSource, index);
      if (!result.success) {
        s.stop('Removal failed');
        p.note(result.error ?? 'Unknown error', 'Error');
        continue;
      }
      s.message('Updating...');
      try {
        const synced = scope === 'project'
          ? await syncWorkspace(workspacePath)
          : await syncUserWorkspace();
        if (!synced.success) throw new Error(synced.error ?? ((synced.warnings ?? []).join('; ') || 'Cleanup failed'));
        s.stop('Removed');
        p.note(`Removed: ${pluginSource} [${scope}]`, 'Success');
      } catch (error) {
        s.stop('Cleanup failed');
        p.note(`Declaration removed, but cleanup failed for ${pluginSource} [${scope}]: ${error instanceof Error ? error.message : String(error)}. Run allagents update to retry cleanup.`, 'Error');
      }
      cache?.invalidate();
      return;
    }
  }
}

/**
 * Browse skills from a specific plugin.
 * Shows all skills from the plugin with their status (enabled/disabled).
 */
export async function runBrowsePluginSkills(
  pluginSource: string,
  scope: 'project' | 'user',
  context: TuiContext,
  cache?: TuiCache,
): Promise<void> {
  try {
    const workspacePath =
      scope === 'user'
        ? getHomeDir()
        : context.workspacePath ?? process.cwd();
    if ((await getNativePluginSources(workspacePath, scope)).has(pluginSource)) {
      p.note(NATIVE_SKILL_SELECTION_ERROR, 'Skills');
      return;
    }
    const allSkills = await getAllSkillsFromPlugins(workspacePath);
    
    // Filter skills to only those from this plugin
    const pluginSkills = allSkills.filter((s) => s.pluginSource === pluginSource);

    if (pluginSkills.length === 0) {
      p.note('No skills found in this plugin.', 'Skills');
      return;
    }

    // Build multiselect options
    const options = pluginSkills.map((skill) => ({
      label: `${skill.name}`,
      value: skill.name,
    }));

    // Pre-select enabled skills (not disabled)
    const initialValues = pluginSkills.filter((s) => !s.disabled).map((s) => s.name);

    const selected = await multiselect({
      message: `Toggle skills in ${pluginSource} (selected = enabled)`,
      options,
      initialValues,
      required: false,
    });

    if (p.isCancel(selected)) {
      return;
    }

    const selectedSet = new Set(selected);

    // Compute diff
    const toDisable = pluginSkills.filter((s) => !s.disabled && !selectedSet.has(s.name));
    const toEnable = pluginSkills.filter((s) => s.disabled && selectedSet.has(s.name));

    if (toDisable.length === 0 && toEnable.length === 0) {
      p.note('No changes made.', 'Skills');
      return;
    }

    const s = p.spinner();
    s.start('Updating skills...');

    // Disable newly unchecked skills
    for (const skill of toDisable) {
      await removeInstalledSkill({
        targetSkill: skill,
        isUser: scope === 'user',
        workspacePath,
      });
    }

    // Enable newly checked skills
    for (const skill of toEnable) {
      const skillKey = `${skill.pluginName}:${skill.name}`;
      if (skill.pluginSkillsMode === 'allowlist') {
        if (scope === 'user') {
          await addUserEnabledSkill(skillKey);
        } else if (context.workspacePath) {
          await addEnabledSkill(skillKey, context.workspacePath);
        }
      } else {
        if (scope === 'user') {
          await removeUserDisabledSkill(skillKey);
        } else if (context.workspacePath) {
          await removeDisabledSkill(skillKey, context.workspacePath);
        }
      }
    }

    // Auto-sync
    s.message('Updating...');
    if (scope === 'project' && context.workspacePath) {
      await syncWorkspace(context.workspacePath);
    } else if (scope === 'user') {
      await syncUserWorkspace();
    }
    s.stop('Updated');
    cache?.invalidate();

    const changes: string[] = [];
    for (const skill of toEnable) {
      changes.push(`✓ Enabled: ${skill.name}`);
    }
    for (const skill of toDisable) {
      changes.push(`✗ Disabled: ${skill.name}`);
    }
    p.note(changes.join('\n'), 'Updated');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.note(message, 'Error');
  }
}

/**
 * Truncate a list to maxVisible items, appending "+N more" if needed.
 */
function truncateList(items: string[], maxVisible = 3): string {
  if (items.length <= maxVisible) {
    return items.join(', ');
  }
  return `${items.slice(0, maxVisible).join(', ')} +${items.length - maxVisible} more`;
}

/**
 * Plugin installation flow.
 * Lists marketplace plugins, lets user pick one, installs it, and auto-syncs.
 */
export async function runInstallPlugin(context: TuiContext, cache?: TuiCache): Promise<void> {
  try {
    // Get available marketplaces
    const marketplaces = await getCachedMarketplaces(cache);

    if (marketplaces.length === 0) {
      p.note(
        'No marketplaces registered.\nUse "Manage marketplaces" to add one first.',
        'Marketplace',
      );
      return;
    }

    // Collect plugins from all marketplaces with compact skill preview
    const allPlugins: Array<{ label: string; value: string; hint?: string }> = [];
    for (const marketplace of marketplaces) {
      const result = await getCachedMarketplacePlugins(marketplace.name, cache);
      for (const plugin of result.plugins) {
        const skillNames = await discoverSkillNames(plugin.path);
        const desc = plugin.description ? ` - ${plugin.description}` : '';
        const entry: { label: string; value: string; hint?: string } = {
          label: `${plugin.name}${desc} (${marketplace.name})`,
          value: `${plugin.name}@${marketplace.name}`,
        };
        if (skillNames.length > 0) {
          entry.hint = `${skillNames.length} skills: ${truncateList(skillNames)}`;
        }
        allPlugins.push(entry);
      }
    }

    if (allPlugins.length === 0) {
      p.note('No plugins found in any marketplace.', 'Plugins');
      return;
    }

    allPlugins.push({ label: 'Back', value: '__back__' });

    const selected = await autocomplete({
      message: 'Select a plugin to install',
      options: allPlugins,
      placeholder: 'Type to search...',
    });

    if (p.isCancel(selected) || selected === '__back__') {
      return;
    }

    await installSelectedPlugin(selected, context, cache);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.note(message, 'Error');
  }
}


/**
 * Browse and manage registered marketplaces.
 * Lists marketplaces, allows adding new ones, and drilling into marketplace details.
 */
export async function runBrowseMarketplaces(
  context: TuiContext,
  cache?: TuiCache,
): Promise<void> {
  try {
    while (true) {
      const marketplaces = await getCachedMarketplaces(cache);

      const options: Array<{ label: string; value: string }> = [
        { label: '+ Add marketplace', value: '__add__' },
        ...marketplaces.map((m) => ({
          label: `${m.name} (${m.source.type === 'github' ? 'GitHub' : m.source.type === 'git' ? 'Git' : 'Local'}: ${m.source.location})`,
          value: m.name,
        })),
        { label: 'Back', value: '__back__' },
      ];

      const selected = await select({
        message: 'Marketplaces',
        options,
      });

      if (p.isCancel(selected) || selected === '__back__') {
        return;
      }

      if (selected === '__add__') {
        const source = await text({
          message: 'Marketplace source (GitHub URL, owner/repo, or name)',
          placeholder: 'e.g., anthropics/claude-plugins-official',
        });

        if (p.isCancel(source)) {
          continue;
        }

        const s = p.spinner();
        s.start('Adding marketplace...');
        const result = await addMarketplace(source);
        s.stop(
          result.success ? 'Marketplace added' : 'Failed to add marketplace',
        );

        if (!result.success) {
          p.note(result.error ?? 'Unknown error', 'Error');
        } else {
          cache?.invalidate();
        }

        continue;
      }

      // User selected a marketplace — show detail screen
      await runMarketplaceDetail(selected, context, cache);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.note(message, 'Error');
  }
}

/**
 * Marketplace detail screen.
 * Shows actions for a specific marketplace: browse plugins, update, remove.
 */
async function runMarketplaceDetail(
  marketplaceName: string,
  context: TuiContext,
  cache?: TuiCache,
): Promise<void> {
  while (true) {
    const action = await select({
      message: `Marketplace: ${marketplaceName}`,
      options: [
        { label: 'Browse plugins', value: 'browse' as const },
        { label: 'Update marketplace', value: 'update' as const },
        { label: 'Remove marketplace', value: 'remove' as const },
        { label: 'Back', value: 'back' as const },
      ],
    });

    if (p.isCancel(action) || action === 'back') {
      return;
    }

    if (action === 'browse') {
      try {
        const result = await getCachedMarketplacePlugins(marketplaceName, cache);

        if (result.plugins.length === 0) {
          p.note('No plugins found in this marketplace.', 'Plugins');
          continue;
        }

        const pluginOptions: Array<{ label: string; value: string }> =
          result.plugins.map((plugin) => {
            const label = plugin.description
              ? `${plugin.name} - ${plugin.description}`
              : plugin.name;
            return { label, value: plugin.name };
          });
        pluginOptions.push({ label: 'Back', value: '__back__' });

        const selectedPlugin = await autocomplete({
          message: 'Select a plugin to install',
          options: pluginOptions,
          placeholder: 'Type to search...',
        });

        if (p.isCancel(selectedPlugin) || selectedPlugin === '__back__') {
          continue;
        }

        const pluginRef = `${selectedPlugin}@${marketplaceName}`;
        await installSelectedPlugin(pluginRef, context, cache);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        p.note(message, 'Error');
      }

      continue;
    }

    if (action === 'update') {
      const updateContext = new UpdateContext();
      try {
        const s = p.spinner();
        s.start('Updating marketplace...');
        const results = await updateMarketplace(
          marketplaceName,
          undefined,
          {},
          updateContext,
        );
        const summary = results
          .map(
            (r) =>
              `${r.success ? '\u2713' : '\u2717'} ${r.name}${r.error ? ` - ${r.error}` : ''}`,
          )
          .join('\n');
        s.stop('Update complete');
        cache?.invalidate();
        p.note(summary || 'Marketplace updated.', 'Update');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        p.note(message, 'Error');
      } finally {
        updateContext.dispose();
      }

      continue;
    }

    if (action === 'remove') {
      const confirmed = await confirm({
        message: `Remove marketplace "${marketplaceName}"?`,
      });

      if (p.isCancel(confirmed) || !confirmed) {
        continue;
      }

      // Check for linked plugins before removing
      const linkedPlugins = await getUserPluginsForMarketplace(marketplaceName);
      let cascade = false;

      if (linkedPlugins.length > 0) {
        const pluginAction = await select({
          message: `${linkedPlugins.length} plugin(s) still reference this marketplace:\n${linkedPlugins.map((pl) => `  - ${pl}`).join('\n')}\n\nWhat would you like to do with them?`,
          options: [
            { value: 'keep' as const, label: 'Keep plugins (can be removed later)' },
            { value: 'remove' as const, label: 'Remove plugins from config' },
          ],
        });

        if (p.isCancel(pluginAction)) {
          continue;
        }

        cascade = pluginAction === 'remove';
      }

      try {
        const s = p.spinner();
        s.start('Removing marketplace...');
        const result = await removeMarketplace(marketplaceName, { cascade });
        s.stop(
          result.success
            ? 'Marketplace removed'
            : 'Failed to remove marketplace',
        );

        if (!result.success) {
          p.note(result.error ?? 'Unknown error', 'Error');
          continue;
        }

        if (result.warnings && result.warnings.length > 0) {
          p.note(result.warnings.join('\n'), 'Warning');
        }

        cache?.invalidate();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        p.note(message, 'Error');
      }

      // Exit detail loop so marketplace list refreshes
      return;
    }
  }
}
