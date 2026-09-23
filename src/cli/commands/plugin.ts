import { command, positional, option, string, optional, multioption, array, flag } from 'cmd-ts';
import {
  addMarketplace,
  listMarketplaces,
  removeMarketplace,
  updateMarketplace,
  listMarketplacePlugins,
  findMarketplace,
  findMarketplaceRegistration,
  parsePluginSpec,
  isPluginSpec,
  getAllagentsDir,
  getMarketplaceVersion,
  listMarketplacesWithScope,
  getRegistryPath,
  getProjectRegistryPath,
  loadRegistryFromPath,
  type ScopedMarketplaceEntry,
  getMarketplaceOverrides,
  getMarketplaceAccessError,
} from '../../core/marketplace.js';
import {
  buildPluginSyncPlans,
  nativeIdentityMatches,
  preflightNativePluginDeclaration,
  syncWorkspace,
  syncUserWorkspace,
  type SyncOptions,
} from '../../core/sync.js';
import type { NativeEffectData } from '../../core/native/types.js';
import { loadSyncState } from '../../core/sync-state.js';
import {
  addPluginForTarget,
  removePlugin,
  addEnabledSkill,
  extractPluginNames,
  resolveMarketplacePluginDeclaration,
} from '../../core/workspace-modify.js';
import {
  addUserPluginForTarget,
  removeUserPlugin,
  isUserConfigPath,
  getInstalledUserPlugins,
  getInstalledProjectPlugins,
  getUserWorkspaceConfig,
  addUserEnabledSkill,
  type InstalledPluginInfo,
} from '../../core/user-workspace.js';
import {
  applyPluginUpdate,
  checkPluginUpdate,
  type InstalledPluginUpdateResult,
  type PluginUpdateCheck,
} from '../../core/plugin.js';
import { UpdateContext } from '../../core/update-context.js';
import { getAllSkillsFromPlugins } from '../../core/skills.js';
import {
  getWorkspaceStatus,
  type NativePluginStatus,
} from '../../core/status.js';
import { parseMarketplaceManifest } from '../../utils/marketplace-manifest-parser.js';
import { isJsonMode, jsonOutput } from '../json-output.js';
import { terminalSafe } from '../terminal-output.js';
import { buildDescription, conciseSubcommands } from '../help.js';
import {
  marketplaceListMeta,
  marketplaceAddMeta,
  marketplaceRemoveMeta,
  marketplaceUpdateMeta,
  marketplaceBrowseMeta,
  pluginListMeta,
  pluginValidateMeta,
  pluginInstallMeta,
  pluginUninstallMeta,
  pluginUpdateMeta,
} from '../metadata/plugin.js';
import { skillsCmd } from './plugin-skills.js';
import {
  formatMcpResult,
  formatNativeEffectData,
  formatNativeResult,
  buildSyncData,
  formatPluginArtifacts,
  formatPluginHeader,
} from '../format-sync.js';
import {
  getPluginSource,
  type WorkspaceConfig,
} from '../../models/workspace-config.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE, getHomeDir } from '../../constants.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  formatPluginSource,
  getPluginDisplayName,
} from '../../utils/plugin-path.js';
import {
  parseUserWorkspaceConfig,
  parseWorkspaceConfig,
} from '../../utils/workspace-parser.js';
import { resolveInstallTarget } from '../install-target.js';
import {
  createClackInstallTargetPromptPort,
  getInstallTargetEnvironment,
  isInteractiveInstallEnvironment,
} from '../tui/install-target-prompts.js';


interface SyncDisplayOptions {
  announceWorkspace?: boolean;
  compactSuccess?: boolean;
}

/**
 * Run sync and print results. Returns true if sync succeeded.
 */
async function runSyncAndPrint(
  options: SyncOptions = {},
  {
    announceWorkspace = true,
    compactSuccess = false,
  }: SyncDisplayOptions = {},
) {
  if (!isJsonMode() && announceWorkspace) {
    console.log('\nUpdating workspace...\n');
  }
  const result = await syncWorkspace(process.cwd(), options);

  if (!result.success && result.error && !isJsonMode()) {
    console.error(`Sync error: ${result.error}`);
  }

  const syncData = buildSyncData(result);
  const ok = result.success && result.totalFailed === 0;

  if (
    !isJsonMode() &&
    (!compactSuccess || !ok || (result.warnings?.length ?? 0) > 0)
  ) {
    for (const pluginResult of result.pluginResults) {
      console.log(formatPluginHeader(pluginResult));

      if (pluginResult.error) {
        console.log(`  Error: ${pluginResult.error}`);
      }

      for (const line of formatPluginArtifacts(pluginResult.copyResults)) {
        console.log(line);
      }

      const generated = pluginResult.copyResults.filter(
        (r) => r.action === 'generated',
      ).length;
      const failed = pluginResult.copyResults.filter(
        (r) => r.action === 'failed',
      ).length;

      if (generated > 0) console.log(`  Generated: ${generated} files`);
      if (failed > 0) {
        console.log(`  Failed: ${failed} files`);
        for (const failedResult of pluginResult.copyResults.filter(
          (r) => r.action === 'failed',
        )) {
          console.log(
            `    - ${failedResult.destination}: ${failedResult.error}`,
          );
        }
      }
    }

    // Print MCP server sync results
    if (result.mcpResults) {
      for (const [scope, mcpResult] of Object.entries(result.mcpResults)) {
        if (!mcpResult) continue;
        const mcpLines = formatMcpResult(mcpResult, scope);
        if (mcpLines.length > 0) {
          console.log('');
          for (const line of mcpLines) {
            console.log(line);
          }
        }
      }
    }

    // Print native plugin sync results
    if (result.nativeResult) {
      const nativeLines = formatNativeResult(result.nativeResult);
      if (nativeLines.length > 0) {
        console.log('\nnative:');
        for (const line of nativeLines) {
          console.log(line);
        }
      }
    }

    if (result.warnings && result.warnings.length > 0) {
      console.log('\nWarnings:');
      for (const warning of result.warnings) {
        console.log(`  \u26A0 ${warning}`);
      }
    }
  }

  return { ok, syncData };
}

/**
 * Run user-scope sync and print results. Returns true if sync succeeded.
 */
async function runUserSyncAndPrint(
  options: SyncOptions = {},
  { compactSuccess = false }: SyncDisplayOptions = {},
) {
  const result = await syncUserWorkspace(options);

  if (!result.success && result.error && !isJsonMode()) {
    console.error(`Sync error: ${result.error}`);
  }

  const syncData = buildSyncData(result);
  const ok = result.success && result.totalFailed === 0;

  if (
    !isJsonMode() &&
    (!compactSuccess || !ok || (result.warnings?.length ?? 0) > 0)
  ) {
    for (const pluginResult of result.pluginResults) {
      console.log(formatPluginHeader(pluginResult));

      if (pluginResult.error) {
        console.log(`  Error: ${pluginResult.error}`);
      }

      for (const line of formatPluginArtifacts(pluginResult.copyResults)) {
        console.log(line);
      }

      const generated = pluginResult.copyResults.filter(
        (r) => r.action === 'generated',
      ).length;
      const failed = pluginResult.copyResults.filter(
        (r) => r.action === 'failed',
      ).length;

      if (generated > 0) console.log(`  Generated: ${generated} files`);
      if (failed > 0) {
        console.log(`  Failed: ${failed} files`);
        for (const failedResult of pluginResult.copyResults.filter(
          (r) => r.action === 'failed',
        )) {
          console.log(
            `    - ${failedResult.destination}: ${failedResult.error}`,
          );
        }
      }
    }

    // Print MCP server sync results
    if (result.mcpResults) {
      for (const [scope, mcpResult] of Object.entries(result.mcpResults)) {
        if (!mcpResult) continue;
        const mcpLines = formatMcpResult(mcpResult, scope);
        if (mcpLines.length > 0) {
          console.log('');
          for (const line of mcpLines) {
            console.log(line);
          }
        }
      }
    }

    // Print native plugin sync results
    if (result.nativeResult) {
      const nativeLines = formatNativeResult(result.nativeResult);
      if (nativeLines.length > 0) {
        console.log('\nnative:');
        for (const line of nativeLines) {
          console.log(line);
        }
      }
    }

    if (result.warnings && result.warnings.length > 0) {
      console.log('\nWarnings:');
      for (const warning of result.warnings) {
        console.log(`  ⚠ ${warning}`);
      }
    }
  }

  return { ok, syncData };
}


async function hasTrackedNativeTarget(
  target: string,
  scope: 'user' | 'project',
): Promise<boolean> {
  const state = await loadSyncState(
    scope === 'user' ? getHomeDir() : process.cwd(),
  );
  return (state?.nativeResources?.resources ?? []).some(
    (resource) =>
      resource.scope === scope &&
      nativeIdentityMatches(
        target,
        resource.requestedIdentity,
        resource.resolvedIdentity,
      ),
  );
}

async function configuredPluginTarget(
  target: string,
  scope: 'user' | 'project',
): Promise<string | undefined> {
  const config =
    scope === 'user'
      ? await getUserWorkspaceConfig()
      : existsSync(join(process.cwd(), CONFIG_DIR, WORKSPACE_CONFIG_FILE))
        ? await parseWorkspaceConfig(
            join(process.cwd(), CONFIG_DIR, WORKSPACE_CONFIG_FILE),
          )
        : null;
  const matches = (config?.plugins ?? [])
    .map(getPluginSource)
    .filter((source) => nativeIdentityMatches(target, source, source));
  if (matches.length > 1) {
    throw new Error(
      `Plugin target '${target}' is ambiguous: ${matches.join(', ')}. Use an exact qualified declaration.`,
    );
  }
  return matches[0];
}

// =============================================================================
// plugin marketplace list
// =============================================================================

const marketplaceListCmd = command({
  name: 'list',
  description: buildDescription(marketplaceListMeta),
  args: {
    scope: option({ type: optional(string), long: 'scope', short: 's', description: 'Filter by scope: user or project' }),
  },
  handler: async ({ scope }) => {
    try {
      if (scope && scope !== 'user' && scope !== 'project') {
        const msg = `Invalid scope '${scope}'. Must be 'user' or 'project'.`;
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace list', error: msg });
          process.exit(1);
        }
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
      const userRegistryPath = getRegistryPath();
      const projectRegistryPath = getProjectRegistryPath(process.cwd());
      const loadMarketplaceVersion = (marketplace: ScopedMarketplaceEntry) =>
        getMarketplaceVersion(
          marketplace,
          marketplace.scope === 'project' ? projectRegistryPath : userRegistryPath,
        );

      let marketplaces: ScopedMarketplaceEntry[];
      let overrideNames: string[] = [];

      if (!scope) {
        // Default: show all scopes merged
        const scopedResult = await listMarketplacesWithScope(userRegistryPath, projectRegistryPath);
        marketplaces = scopedResult.entries;
        overrideNames = scopedResult.overrides;
      } else if (scope === 'user') {
        const registry = await loadRegistryFromPath(userRegistryPath);
        marketplaces = Object.values(registry.marketplaces).map((mp) => ({ ...mp, scope: 'user' as const }));
      } else {
        const registry = await loadRegistryFromPath(projectRegistryPath);
        marketplaces = Object.values(registry.marketplaces).map((mp) => ({ ...mp, scope: 'project' as const }));
      }

      if (isJsonMode()) {
        const enriched = await Promise.all(
          marketplaces.map(async (mp) => {
            const version = await loadMarketplaceVersion(mp);
            return {
              ...mp,
              ...(version && {
                commitHash: version.hash,
                commitTimestamp: version.date.toISOString(),
              }),
            };
          }),
        );
        jsonOutput({
          success: true,
          command: 'plugin marketplace list',
          data: { marketplaces: enriched },
        });
        return;
      }

      // Emit override warnings when listing all scopes
      for (const overrideName of overrideNames) {
        console.warn(`Warning: Workspace marketplace '${overrideName}' overrides user marketplace of the same name.`);
      }

      if (marketplaces.length === 0) {
        console.log('No marketplaces registered.\n');
        console.log('Add a marketplace with:');
        console.log('  allagents plugin marketplace add <source>\n');
        console.log('Examples:');
        console.log('  allagents plugin marketplace add owner/repo');
        console.log('  allagents plugin marketplace add https://github.com/owner/repo');
        return;
      }

      console.log('Registered marketplaces:\n');

      for (const mp of marketplaces) {
        let sourceLabel: string;
        switch (mp.source.type) {
          case 'github':
            sourceLabel = `GitHub: ${mp.source.location}`;
            break;
          case 'git':
            sourceLabel = `Git: ${mp.source.location}`;
            break;
          default:
            sourceLabel = `Local: ${mp.source.location}`;
        }

        console.log(`  ❯ ${mp.name} (${mp.scope})`);
        console.log(`    Source: ${sourceLabel}`);

        const version = await loadMarketplaceVersion(mp);
        if (version) {
          const ts = version.date.toISOString().replace('T', ' ').slice(0, 16);
          console.log(`    Version: ${version.hash} (${ts})`);
        }

        console.log();
      }

      console.log(`Total: ${marketplaces.length} marketplace(s)`);
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace list', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// plugin marketplace add
// =============================================================================

const marketplaceAddCmd = command({
  name: 'add',
  description: buildDescription(marketplaceAddMeta),
  args: {
    source: positional({ type: string, displayName: 'source' }),
    name: option({ type: optional(string), long: 'name', short: 'n', description: 'Custom name for the marketplace' }),
    branch: option({ type: optional(string), long: 'branch', short: 'b', description: 'Branch to checkout after cloning' }),
    scope: option({ type: optional(string), long: 'scope', short: 's', description: 'Scope: user (default) or project' }),
  },
  handler: async ({ source, name, branch, scope }) => {
    try {
      const effectiveScope = (scope ?? 'user') as import('../../core/marketplace.js').MarketplaceScope;
      if (effectiveScope !== 'user' && effectiveScope !== 'project') {
        const msg = `Invalid scope '${scope}'. Must be 'user' or 'project'.`;
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace add', error: msg });
          process.exit(1);
        }
        console.error(`Error: ${msg}`);
        process.exit(1);
      }

      if (effectiveScope === 'project') {
        if (!existsSync(join(process.cwd(), CONFIG_DIR, WORKSPACE_CONFIG_FILE))) {
          const msg = 'No workspace found in current directory. Run "allagents workspace init" first.';
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'plugin marketplace add', error: msg });
            process.exit(1);
          }
          console.error(`Error: ${msg}`);
          process.exit(1);
        }
      }

      if (!isJsonMode()) {
        console.log(`Adding marketplace: ${source}...`);
      }

      const result = await addMarketplace(source, name, branch, {
        scope: effectiveScope,
        workspacePath: process.cwd(),
      });

      if (!result.success) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace add', error: result.error ?? 'Unknown error' });
          process.exit(1);
        }
        console.error(`\nError: ${result.error}`);
        process.exit(1);
      }

      if (result.replaced && !isJsonMode()) {
        console.log(`Marketplace '${result.marketplace?.name}' already exists. Replacing with new source.`);
      }

      if (isJsonMode()) {
        jsonOutput({
          success: true,
          command: 'plugin marketplace add',
          data: {
            marketplace: {
              name: result.marketplace?.name,
              path: result.marketplace?.path,
              replaced: result.replaced,
            },
          },
        });
        return;
      }

      console.log(`\u2713 Marketplace '${result.marketplace?.name}' added`);
      console.log(`  Path: ${result.marketplace?.path}`);
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace add', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// plugin marketplace remove
// =============================================================================

const marketplaceRemoveCmd = command({
  name: 'remove',
  description: buildDescription(marketplaceRemoveMeta),
  args: {
    name: positional({ type: string, displayName: 'name' }),
    scope: option({ type: optional(string), long: 'scope', short: 's', description: 'Filter by scope: user or project (default: removes from both)' }),
  },
  handler: async ({ name, scope }) => {
    try {
      if (scope && scope !== 'user' && scope !== 'project') {
        const msg = `Invalid scope '${scope}'. Must be 'user' or 'project'.`;
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace remove', error: msg });
          process.exit(1);
        }
        console.error(`Error: ${msg}`);
        process.exit(1);
      }

      // No --scope: remove from both; --scope user/project: remove from that scope only
      const effectiveScope = (scope ?? 'all') as import('../../core/marketplace.js').MarketplaceScope | 'all';

      const result = await removeMarketplace(name, {
        scope: effectiveScope,
        workspacePath: process.cwd(),
      });

      if (!result.success) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace remove', error: result.error ?? 'Unknown error' });
          process.exit(1);
        }
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      if (isJsonMode()) {
        jsonOutput({
          success: true,
          command: 'plugin marketplace remove',
          data: {
            name,
            path: result.marketplace?.path,
            retainedUserPlugins: result.retainedUserPlugins ?? [],
            warnings: result.warnings ?? [],
          },
        });
        return;
      }

      console.log(`\u2713 Marketplace '${name}' removed`);
      for (const warning of result.warnings ?? []) {
        console.warn(`Warning: ${warning}`);
      }
      if (result.retainedUserPlugins && result.retainedUserPlugins.length > 0) {
        console.log(`\n  \u26A0 ${result.retainedUserPlugins.length} plugin(s) still reference this marketplace:`);
        for (const p of result.retainedUserPlugins) {
          console.log(`    - ${p}`);
        }
        console.log('\n  To remove them: allagents plugin remove <name>');
      }
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace remove', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// plugin marketplace update
// =============================================================================

const marketplaceUpdateCmd = command({
  name: 'update',
  description: buildDescription(marketplaceUpdateMeta),
  args: {
    name: positional({ type: optional(string), displayName: 'name' }),
  },
  handler: async ({ name }) => {
    const updateContext = new UpdateContext();
    try {
      if (!isJsonMode()) {
        console.log(
          name
            ? `Updating marketplace: ${name}...`
            : 'Updating all marketplaces...',
        );
        console.log();
      }

      const results = await updateMarketplace(
        name,
        process.cwd(),
        {},
        updateContext,
      );

      if (isJsonMode()) {
        const succeeded = results.filter((r) => r.success).length;
        const failed = results.filter((r) => !r.success).length;
        jsonOutput({
          success: failed === 0,
          command: 'plugin marketplace update',
          data: {
            results: results.map((result) => ({
              name: result.name,
              success: result.success,
              ...(result.error && { error: result.error }),
            })),
            succeeded,
            failed,
          },
          ...(failed > 0 && { error: `${failed} marketplace(s) failed to update` }),
        });
        if (failed > 0) {
          process.exit(1);
        }
        return;
      }

      if (results.length === 0) {
        console.log('No marketplaces to update.');
        return;
      }

      let successCount = 0;
      let failCount = 0;

      for (const result of results) {
        if (result.success) {
          console.log(`\u2713 ${result.name}`);
          successCount++;
        } else {
          console.log(`\u2717 ${result.name}: ${result.error}`);
          failCount++;
        }
      }

      console.log();
      console.log(`Updated: ${successCount}, Failed: ${failCount}`);

      if (failCount > 0) {
        process.exit(1);
      }
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace update', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    } finally {
      updateContext.dispose();
    }
  },
});

// =============================================================================
// plugin marketplace browse
// =============================================================================

const marketplaceBrowseCmd = command({
  name: 'browse',
  description: buildDescription(marketplaceBrowseMeta),
  args: {
    name: positional({ type: string, displayName: 'name' }),
  },
  handler: async ({ name }) => {
    try {
      if (!await findMarketplace(name, undefined, process.cwd())) {
        const error = `Marketplace '${name}' not found`;
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace browse', error });
          process.exit(1);
        }
        console.error(`Error: ${error}`);
        console.log('\nTo see registered marketplaces:');
        console.log('  allagents plugin marketplace list');
        process.exit(1);
      }

      const result = await listMarketplacePlugins(name, process.cwd());

      // Build installed lookup
      const userPlugins = await getInstalledUserPlugins();
      const projectPlugins = await getInstalledProjectPlugins(process.cwd());
      const installedMap = new Map<string, InstalledPluginInfo>();

      // Build reverse lookup: repo name -> marketplace name
      const marketplaces = await listMarketplaces();
      const repoToMarketplace = new Map<string, string>();
      for (const mp of marketplaces) {
        if (mp.source.type === 'github') {
          const parts = mp.source.location.split('/');
          if (parts.length >= 2 && parts[1]) {
            repoToMarketplace.set(parts[1], mp.name);
          }
        }
      }
      const resolveMarketplaceName = (mpName: string): string => {
        return repoToMarketplace.get(mpName) ?? mpName;
      };

      for (const p of userPlugins) {
        const mpName = resolveMarketplaceName(p.marketplace);
        installedMap.set(`${p.name}@${mpName}`, p);
      }
      for (const p of projectPlugins) {
        const mpName = resolveMarketplaceName(p.marketplace);
        installedMap.set(`${p.name}@${mpName}`, p);
      }

      const plugins = result.plugins.map((plugin) => {
        const key = `${plugin.name}@${name}`;
        const installed = installedMap.get(key);
        return {
          name: plugin.name,
          description: plugin.description ?? null,
          installed: !!installed,
          scope: installed?.scope ?? null,
        };
      });

      const installedCount = plugins.filter((p) => p.installed).length;

      if (isJsonMode()) {
        jsonOutput({
          success: true,
          command: 'plugin marketplace browse',
          data: {
            marketplace: name,
            plugins,
            total: plugins.length,
            installed: installedCount,
            ...(result.warnings.length > 0 && { warnings: result.warnings }),
          },
        });
        return;
      }

      // Print warnings
      for (const warning of result.warnings) {
        console.log(`  Warning: ${warning}`);
      }

      if (plugins.length === 0) {
        console.log(`No plugins found in "${name}" marketplace.`);
        return;
      }

      console.log(`Plugins in "${name}" marketplace:\n`);
      for (const plugin of plugins) {
        const status = plugin.installed ? ` (installed - ${plugin.scope})` : '';
        console.log(`  ❯ ${plugin.name}${status}`);
        if (plugin.description) {
          console.log(`    ${plugin.description}`);
        }
        console.log();
      }

      console.log(`Total: ${plugins.length} plugins (${installedCount} installed)`);
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin marketplace browse', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// plugin marketplace subcommands group
// =============================================================================

const marketplaceCmd = conciseSubcommands({
  name: 'marketplace',
  description: 'Manage plugin marketplaces',
  cmds: {
    list: marketplaceListCmd,
    browse: marketplaceBrowseCmd,
    add: marketplaceAddCmd,
    remove: marketplaceRemoveCmd,
    update: marketplaceUpdateCmd,
  },
});

// =============================================================================
// plugin list command - list installed plugins
// =============================================================================

const pluginListCmd = command({
  name: 'list',
  description: buildDescription(pluginListMeta),
  args: {},
  handler: async () => {
    try {

      const pluginClients = new Map<string, string[]>();

      function sourceKey(
        source: string,
        scope: 'user' | 'project',
      ): string {
        return `source:${scope}:${source}`;
      }

      function marketplaceKey(
        name: string,
        marketplace: string,
        scope: 'user' | 'project',
      ): string {
        return `marketplace:${scope}:${name}@${marketplace}`;
      }

      async function loadConfigClients(
        configPath: string,
        scope: 'user' | 'project',
      ): Promise<void> {
        if (!existsSync(configPath)) return;
        try {
          const config =
            scope === 'user'
              ? await parseUserWorkspaceConfig(configPath)
              : await parseWorkspaceConfig(configPath);
          const { plans } = buildPluginSyncPlans(
            config.plugins,
            config.clients,
            scope,
          );
          for (const plan of plans) {
            pluginClients.set(sourceKey(plan.source, scope), plan.clients);
          }
        } catch {
          // Invalid configs are handled by commands that modify or sync them.
        }
      }

      const userConfigPath = join(getAllagentsDir(), WORKSPACE_CONFIG_FILE);
      const projectConfigPath = join(
        process.cwd(),
        CONFIG_DIR,
        WORKSPACE_CONFIG_FILE,
      );
      const cwdIsHome = isUserConfigPath(process.cwd());
      await loadConfigClients(userConfigPath, 'user');
      if (!cwdIsHome) {
        await loadConfigClients(projectConfigPath, 'project');
      }
      const userSyncState = await loadSyncState(getHomeDir());
      const projectSyncState = cwdIsHome
        ? null
        : await loadSyncState(process.cwd());

      const userPlugins = await getInstalledUserPlugins();
      const projectPlugins = await getInstalledProjectPlugins(process.cwd());
      const allInstalled = [...userPlugins, ...projectPlugins];

      const kindBySource = new Map<string, 'skill' | 'plugin'>();
      const workspaceStatus = await getWorkspaceStatus(process.cwd());
      for (const p of [
        ...workspaceStatus.plugins,
        ...(workspaceStatus.userPlugins ?? []),
      ]) {
        kindBySource.set(p.source, p.kind);
      }



      interface MergedPlugin {
        spec: string;
        effectiveSpec: string;
        name: string;
        marketplace: string;
        scope: 'user' | 'project';
        kind: 'skill' | 'plugin';
        fileClients: string[];
        nativeClients: string[];
        nativeResources: NativePluginStatus[];
      }
      const merged = new Map<string, MergedPlugin>();

      for (const plugin of allInstalled) {
        const key = plugin.marketplace
          ? marketplaceKey(plugin.name, plugin.marketplace, plugin.scope)
          : sourceKey(plugin.effectiveSpec, plugin.scope);
        const clients =
          pluginClients.get(sourceKey(plugin.effectiveSpec, plugin.scope)) ?? [];
        const existing = merged.get(key);
        if (existing) {
          for (const client of clients) {
            if (!existing.fileClients.includes(client)) {
              existing.fileClients.push(client);
            }
          }
          continue;
        }
        merged.set(key, {
          spec: plugin.spec,
          effectiveSpec: plugin.effectiveSpec,
          name: plugin.name,
          marketplace: plugin.marketplace,
          scope: plugin.scope,
          kind: kindBySource.get(plugin.spec) ?? 'plugin',
          fileClients: [...clients],
          nativeClients: [],
          nativeResources: [],
        });
      }

      // Use the legacy identity list only when typed state/live status cannot
      // corroborate the same adapter, scope, and resource.
      for (const [state, stateScope] of [
        [userSyncState, 'user'],
        [projectSyncState, 'project'],
      ] as const) {
        for (const [client, specs] of Object.entries(
          state?.nativePlugins ?? {},
        )) {
          for (const spec of specs) {
            const corroborated = workspaceStatus.nativeResources.some(
              (resource) =>
                resource.client === client &&
                resource.scope === stateScope &&
                nativeIdentityMatches(
                  spec,
                  resource.requestedIdentity,
                  resource.resolvedIdentity,
                ),
            );
            if (corroborated) continue;
            const parsed = parsePluginSpec(spec);
            const key = parsed
              ? marketplaceKey(
                  parsed.plugin,
                  parsed.marketplaceName,
                  stateScope,
                )
              : sourceKey(spec, stateScope);
            const existing = merged.get(key);
            if (existing) {
              if (!existing.nativeClients.includes(client)) {
                existing.nativeClients.push(client);
              }
              continue;
            }
            merged.set(key, {
              spec,
              effectiveSpec: spec,
              name: parsed?.plugin ?? getPluginDisplayName(spec),
              marketplace: parsed?.marketplaceName ?? '',
              scope: stateScope,
              kind: kindBySource.get(spec) ?? 'plugin',
              fileClients: [],
              nativeClients: [client],
              nativeResources: [],
            });
          }
        }
      }

      for (const nativeResource of workspaceStatus.nativeResources) {
        const spec = nativeResource.requestedIdentity;
        const parsed =
          parsePluginSpec(nativeResource.resolvedIdentity) ??
          parsePluginSpec(spec);
        const key = parsed
          ? marketplaceKey(
              parsed.plugin,
              parsed.marketplaceName,
              nativeResource.scope,
            )
          : sourceKey(spec, nativeResource.scope);
        const existing = merged.get(key);
        if (existing) {
          if (!existing.nativeClients.includes(nativeResource.client)) {
            existing.nativeClients.push(nativeResource.client);
          }
          existing.nativeResources.push(nativeResource);
          continue;
        }
        merged.set(key, {
          spec,
          effectiveSpec: spec,
          name: parsed?.plugin ?? getPluginDisplayName(spec),
          marketplace: parsed?.marketplaceName ?? '',
          scope: nativeResource.scope,
          kind: kindBySource.get(spec) ?? 'plugin',
          fileClients: [],
          nativeClients: [nativeResource.client],
          nativeResources: [nativeResource],
        });
      }

      const plugins = [...merged.values()];

      if (isJsonMode()) {
        jsonOutput({
          success: workspaceStatus.success,
          command: 'plugin list',
          data: {
            plugins: plugins.map((p) => ({
              name: p.name,
              spec: p.spec,
              marketplace: p.marketplace,
              scope: p.scope,
              kind: p.kind,
              ...(p.fileClients.length > 0 && { clients: p.fileClients }),
              ...(p.nativeClients.length > 0 && { nativeClients: p.nativeClients }),
              ...(p.nativeResources.length > 0 && {
                nativeResources: p.nativeResources,
              }),
            })),
            total: plugins.length,
          },
          ...(!workspaceStatus.success && {
            error: workspaceStatus.error ?? 'Native inspection failed',
          }),
        });
        if (!workspaceStatus.success) process.exit(1);
        return;
      }

      if (plugins.length === 0) {
        console.log('No plugins installed.\n');
        console.log('To discover available plugins:');
        console.log('  allagents plugin marketplace browse <name>\n');
        console.log('To see registered marketplaces:');
        console.log('  allagents plugin marketplace list');
        if (!workspaceStatus.success) {
          console.error(`Error: ${workspaceStatus.error ?? 'Native inspection failed'}`);
          process.exit(1);
        }
        return;
      }

      const skillCount = plugins.filter((p) => p.kind === 'skill').length;
      const pluginCount = plugins.length - skillCount;

      console.log('Plugins:\n');
      for (const p of plugins) {
        console.log(`  ❯ ${p.marketplace ? p.spec : p.name}`);
        console.log(`    Type: ${p.kind}`);
        console.log(`    Scope: ${p.scope}`);
        if (!p.marketplace) {
          console.log(`    Source: ${formatPluginSource(p.effectiveSpec)}`);
        }

        const hasClients = p.fileClients.length > 0 || p.nativeClients.length > 0;
        if (hasClients) {
          const parts = [
            ...p.nativeClients.map((c) => `native ${c}`),
            ...p.fileClients,
          ];
          console.log(`    Clients: ${parts.join(', ')}`);
        }
        for (const nativeResource of p.nativeResources) {
          console.log(
            `${formatNativeEffectData(nativeResource)} declared=${String(nativeResource.declared)} ownership=${nativeResource.ownership}${nativeResource.transition ? ` transition=${nativeResource.transition}` : ''}`,
          );
        }
        console.log('');
      }

      const summaryParts: string[] = [];
      if (pluginCount > 0) summaryParts.push(`${pluginCount} plugin${pluginCount === 1 ? '' : 's'}`);
      if (skillCount > 0) summaryParts.push(`${skillCount} skill${skillCount === 1 ? '' : 's'}`);
      console.log(`Total: ${summaryParts.join(', ')}`);
      if (!workspaceStatus.success) {
        console.error(`Error: ${workspaceStatus.error ?? 'Native inspection failed'}`);
        process.exit(1);
      }
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin list', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// plugin validate command - validate a plugin structure
// =============================================================================

const pluginValidateCmd = command({
  name: 'validate',
  description: buildDescription(pluginValidateMeta),
  args: {
    path: positional({ type: string, displayName: 'path' }),
  },
  handler: async ({ path }) => {
    if (isJsonMode()) {
      jsonOutput({
        success: true,
        command: 'plugin validate',
        data: { path, valid: false, message: 'not yet implemented' },
      });
      return;
    }
    // TODO: Implement plugin validation
    console.log(`Validating plugin at: ${path}`);
    console.log('(validation not yet implemented)');
  },
});

// =============================================================================
// plugin install
// =============================================================================

const pluginInstallCmd = command({
  name: 'install',
  description: buildDescription(pluginInstallMeta),
  args: {
    plugin: positional({ type: string, displayName: 'plugin' }),
    scope: option({ type: optional(string), long: 'scope', short: 's', description: 'Installation scope: "project" (default) or "user"' }),
    client: option({ type: optional(string), long: 'client', short: 'c', description: 'Comma-separated clients for this plugin' }),
    yes: flag({ long: 'yes', short: 'y', description: 'Run without prompts using configured or default scope and clients' }),
    skills: multioption({
      type: array(string),
      long: 'skill',
      description: 'Only enable specific skills (can be repeated)',
    }),
  },
  handler: async ({ plugin, scope, client, yes, skills }) => {
    try {
      const workspacePath = process.cwd();
      const projectConfigPath = join(
        workspacePath,
        CONFIG_DIR,
        WORKSPACE_CONFIG_FILE,
      );
      const environment = getInstallTargetEnvironment(isJsonMode());
      const target = await resolveInstallTarget({
        workspacePath,
        declaration: plugin,
        action: 'Install plugin',
        payload: plugin,
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
        environment,
        ...(isInteractiveInstallEnvironment(environment) && {
          prompts: createClackInstallTargetPromptPort(),
        }),
        ...(scope !== undefined && { scope }),
        ...(client !== undefined && { clients: client }),
        yes,
      });
      if (!target) {
        if (!isJsonMode()) {
          console.log('Install cancelled. No changes made.');
        }
        return;
      }

      const isUser = target.scope === 'user';
      const selectedClientEntries = target.selectedClientEntries;
      const marketplaceSpec = isPluginSpec(
        getPluginSource(target.prospectiveDeclaration),
      );
      let prospectiveDeclaration = target.prospectiveDeclaration;
      let registeredMarketplace: string | undefined;
      if (marketplaceSpec) {
        const resolution = await resolveMarketplacePluginDeclaration(
          prospectiveDeclaration,
          isUser ? undefined : workspacePath,
        );
        if (!resolution.success) {
          throw new Error(resolution.error);
        }
        prospectiveDeclaration = resolution.declaration;
        registeredMarketplace = resolution.registeredAs;
      }

      // Emit override warnings for project-scope installs

      if (!isUser) {
        const overrideNames = await getMarketplaceOverrides(
          getRegistryPath(),
          getProjectRegistryPath(workspacePath),
        );
        for (const name of overrideNames) {
          console.warn(`Warning: Workspace marketplace '${name}' overrides user marketplace of the same name.`);
        }
      }

      const nativePreflightErrors = await preflightNativePluginDeclaration(
        prospectiveDeclaration,
        selectedClientEntries,
        target.scope,
        workspacePath,
      );
      if (nativePreflightErrors.length > 0) {
        throw new Error(
          `Native preflight failed; workspace declaration was not changed: ${nativePreflightErrors.join('; ')}`,
        );
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
      const result = isUser
        ? await addUserPluginForTarget(installTarget)
        : await addPluginForTarget(installTarget, workspacePath);

      if (!result.success) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin install', error: result.error ?? 'Unknown error' });
          process.exit(1);
        }
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      if (registeredMarketplace) {
        result.autoRegistered ??= registeredMarketplace;
      }

      const displayPlugin = result.normalizedPlugin ?? plugin;

      // Handle --skill flag: write enabledSkills BEFORE sync so only one sync pass is needed
      if (skills.length > 0) {
        const workspacePath = isUser ? getHomeDir() : process.cwd();

        // Do an initial sync to fetch the plugin so we can discover its skills.
        const initialSync = isUser
          ? await syncUserWorkspace()
          : await syncWorkspace(workspacePath);

        if (!initialSync.success) {
          const error = `Initial sync failed: ${initialSync.error ?? 'Unknown error'}`;
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'plugin install', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }

        const allSkills = await getAllSkillsFromPlugins(workspacePath);
        const displayNames = extractPluginNames(displayPlugin);
        const pluginSkills = allSkills.filter((s) =>
          s.pluginSource === displayPlugin || displayNames.includes(s.pluginName),
        );

        if (pluginSkills.length === 0) {
          if (!isJsonMode()) {
            console.error(`Warning: No skills found in plugin ${displayPlugin}`);
          }
        } else {
          const pluginName = pluginSkills[0]?.pluginName;
          const availableNames = pluginSkills.map((s) => s.name);

          // Validate requested skill names
          const invalid = skills.filter((s) => !availableNames.includes(s));
          if (invalid.length > 0) {
            const error = `Unknown skills: ${invalid.join(', ')}. Available: ${availableNames.join(', ')}`;
            if (isJsonMode()) {
              jsonOutput({ success: false, command: 'plugin install', error });
              process.exit(1);
            }
            console.error(`Error: ${error}`);
            process.exit(1);
          }

          // Add each skill to enabledSkills
          for (const skillName of skills) {
            const skillKey = `${pluginName}:${skillName}`;
            const addResult = isUser
              ? await addUserEnabledSkill(skillKey)
              : await addEnabledSkill(skillKey, workspacePath);
            if (!addResult.success && !isJsonMode()) {
              console.error(`Warning: ${addResult.error}`);
            }
          }

          if (!isJsonMode()) {
            console.log(`\nEnabled skills: ${skills.join(', ')}`);
          }
        }
      }

      if (result.replaced && !isJsonMode()) {
        console.log(`Plugin '${displayPlugin}' already exists. Replacing with new source.`);
      }

      if (!isJsonMode()) {
        if (result.autoRegistered) {
          console.log(`  Resolved marketplace: ${result.autoRegistered}`);
        }
        console.log(`Installing plugin "${displayPlugin}"...\n`);
      }

      // Single sync pass (enabledSkills already written if --skill was used)
      const { ok: syncOk, syncData } = isUser
        ? await runUserSyncAndPrint()
        : await runSyncAndPrint();

      if (!isJsonMode() && syncOk) {
        console.log(`\n\u2714 Successfully installed plugin: ${displayPlugin} (scope: ${isUser ? 'user' : 'project'})`);
      }

      if (isJsonMode()) {
        jsonOutput({
          success: syncOk,
          command: 'plugin install',
          data: {
            plugin: displayPlugin,
            scope: isUser ? 'user' : 'project',
            autoRegistered: result.autoRegistered ?? null,
            ...(skills.length > 0 && { enabledSkills: skills }),
            replaced: result.replaced ?? false,
            syncResult: syncData,
          },
          ...(!syncOk && { error: 'Sync completed with failures' }),
        });
        if (!syncOk) process.exit(1);
        return;
      }

      if (!syncOk) process.exit(1);
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin install', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// plugin uninstall
// =============================================================================

const pluginUninstallCmd = command({
  name: 'uninstall',
  description: buildDescription(pluginUninstallMeta),
  aliases: ['remove'],
  args: {
    plugin: positional({ type: string, displayName: 'plugin' }),
    scope: option({ type: optional(string), long: 'scope', short: 's', description: 'Installation scope: "project" (default) or "user"' }),
  },
  handler: async ({ plugin, scope }) => {
    try {
      if (scope && scope !== 'user' && scope !== 'project') {
        throw new Error(
          `Invalid scope '${scope}'. Must be 'user' or 'project'.`,
        );
      }
      const scopes: Array<'project' | 'user'> =
        scope === 'user'
          ? ['user']
          : scope === 'project'
            ? ['project']
            : isUserConfigPath(process.cwd())
              ? ['user']
              : ['project', 'user'];
      const declarations: Array<{
        scope: 'project' | 'user';
        action: 'removed' | 'absent' | 'failed';
        error?: string;
      }> = [];
      const syncResults: Record<string, unknown> = {};
      let found = false;
      let allOk = true;

      for (const targetScope of scopes) {
        const configuredTarget = await configuredPluginTarget(
          plugin,
          targetScope,
        );
        const declared = configuredTarget !== undefined;
        const nativeTarget = configuredTarget ?? plugin;
        const tracked = await hasTrackedNativeTarget(nativeTarget, targetScope);
        if (!declared && !tracked) continue;
        found = true;

        if (declared) {
          const removal =
            targetScope === 'user'
              ? await removeUserPlugin(nativeTarget)
              : await removePlugin(nativeTarget);
          if (!removal.success) {
            allOk = false;
            declarations.push({
              scope: targetScope,
              action: 'failed',
              error: removal.error ?? 'Declaration removal failed',
            });
            if (!isJsonMode()) {
              console.error(
                `\u2717 Declaration removal (${targetScope}): ${removal.error ?? 'Unknown error'}`,
              );
            }
            continue;
          }
          declarations.push({ scope: targetScope, action: 'removed' });
          if (!isJsonMode()) {
            console.log(
              `\u2713 Declaration removed (${targetScope} scope): ${plugin}`,
            );
          }
        } else {
          declarations.push({ scope: targetScope, action: 'absent' });
          if (!isJsonMode()) {
            console.log(
              `= Declaration already absent (${targetScope} scope): ${plugin}`,
            );
          }
        }

        const nativeSelection = {
          mode: 'remove' as const,
          targets: [nativeTarget],
        };
        const sync =
          targetScope === 'user'
            ? await runUserSyncAndPrint({ nativeSelection })
            : await runSyncAndPrint({ nativeSelection });
        syncResults[targetScope] = sync.syncData;
        if (!sync.ok) allOk = false;
      }

      if (!found) {
        const error = `Plugin not found: ${plugin}`;
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin uninstall', error });
          process.exit(1);
        }
        console.error(`Error: ${error}`);
        process.exit(1);
      }

      if (isJsonMode()) {
        jsonOutput({
          success: allOk,
          command: 'plugin uninstall',
          data: {
            plugin,
            scopes: declarations.map((result) => result.scope),
            declarations,
            syncResults,
          },
          ...(!allOk && {
            error: 'Declaration removal or native cleanup failed',
          }),
        });
      }
      if (!allOk) process.exit(1);
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'plugin uninstall', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// plugin update
// =============================================================================

type PluginUpdateEntry = Pick<InstalledPluginInfo, 'spec' | 'scope'>;

const pluginUpdateCmd = command({
  name: 'update',
  description: buildDescription(pluginUpdateMeta),
  args: {
    plugin: positional({ type: optional(string), displayName: 'plugin' }),
    scope: option({ type: optional(string), long: 'scope', short: 's', description: 'Installation scope: "project" (default), "user", or "all"' }),
  },
  handler: async ({ plugin, scope }) => {
    const updateContext = new UpdateContext();
    const jsonMode = isJsonMode();
    const progressiveOutput = Boolean(process.stdout.isTTY) && !jsonMode;
    try {
      if (
        scope &&
        scope !== 'user' &&
        scope !== 'project' &&
        scope !== 'all'
      ) {
        throw new Error(
          `Invalid scope '${scope}'. Must be 'user', 'project', or 'all'.`,
        );
      }
      // Determine which plugins to update based on scope
      const updateAll = scope === 'all';
      const updateUser = scope === 'user' || updateAll;
      const updateProject = scope === 'project' || (!scope && !updateAll) || updateAll;

      // Collect installed plugins based on scope
      const pluginsToUpdate: PluginUpdateEntry[] = [];
      const addPluginToUpdate = (spec: string, pluginScope: 'project' | 'user') => {
        if (!pluginsToUpdate.some((entry) =>
          entry.spec === spec && entry.scope === pluginScope
        )) {
          pluginsToUpdate.push({ spec, scope: pluginScope });
        }
      };

      if (updateProject && !isUserConfigPath(process.cwd())) {
        const projectPlugins = await getInstalledProjectPlugins(process.cwd());
        for (const p of projectPlugins) {
          addPluginToUpdate(p.spec, 'project');
        }
      }

      if (updateUser) {
        const userPlugins = await getInstalledUserPlugins();
        for (const p of userPlugins) {
          addPluginToUpdate(p.spec, 'user');
        }
      }

      const configs: Partial<
        Record<'project' | 'user', WorkspaceConfig>
      > = {};

      // Include declarations, including native-only sources that have no
      // generic installed-plugin cache entry.
      if (updateProject && !isUserConfigPath(process.cwd())) {
        const configPath = join(
          process.cwd(),
          CONFIG_DIR,
          WORKSPACE_CONFIG_FILE,
        );
        if (existsSync(configPath)) {
          const config = await parseWorkspaceConfig(configPath);
          configs.project = config;
          for (const entry of config.plugins) {
            addPluginToUpdate(getPluginSource(entry), 'project');
          }
        }
      }

      if (updateUser) {
        const userConfig = await getUserWorkspaceConfig();
        if (userConfig) {
          configs.user = userConfig;
          for (const entry of userConfig.plugins) {
            addPluginToUpdate(getPluginSource(entry), 'user');
          }
        }
      }

      // Filter to specific plugin if provided
      const toUpdate = plugin
        ? pluginsToUpdate.filter(({ spec }) =>
            nativeIdentityMatches(plugin, spec, spec))
        : pluginsToUpdate;

      if (plugin && toUpdate.length === 0) {
        const error = `Plugin not found: ${plugin}`;
        if (jsonMode) {
          jsonOutput({ success: false, command: 'plugin update', error });
          process.exit(1);
        }
        console.error(`Error: ${error}`);
        process.exit(1);
      }

      if (toUpdate.length === 0) {
        if (jsonMode) {
          jsonOutput({
            success: true,
            command: 'plugin update',
            data: { results: [], updated: 0, skipped: 0, failed: 0 },
          });
          return;
        }
        console.log('No plugins to update.');
        return;
      }
      const duplicateCrossScopeLabels = new Set<string>();
      if (progressiveOutput) {
        const scopesByLabel = new Map<
          string,
          Set<PluginUpdateEntry['scope']>
        >();
        for (const entry of toUpdate) {
          const label = terminalSafe(formatPluginSource(entry.spec));
          const scopes = scopesByLabel.get(label) ?? new Set();
          scopes.add(entry.scope);
          scopesByLabel.set(label, scopes);
        }
        for (const [label, scopes] of scopesByLabel) {
          if (scopes.size > 1) duplicateCrossScopeLabels.add(label);
        }
      }
      const declarationKey = (entry: PluginUpdateEntry) =>
        `${entry.scope}:${entry.spec}`;
      const declarationLabel = (entry: PluginUpdateEntry) => {
        const label = terminalSafe(formatPluginSource(entry.spec));
        return duplicateCrossScopeLabels.has(label)
          ? `${label} (${entry.scope})`
          : label;
      };
      const printUpdateHeader = () => {
        console.log(
          plugin ? `Updating plugin: ${plugin}...` : 'Updating plugins...',
        );
        console.log();
      };
      const announcedDeclarations = new Set<string>();
      const announceDeclaration = (entry: PluginUpdateEntry) => {
        if (!progressiveOutput) return;
        const key = declarationKey(entry);
        if (announcedDeclarations.has(key)) return;
        announcedDeclarations.add(key);
        console.log(`Updating ${declarationLabel(entry)}...`);
      };

      const createUpdateDeps = (pluginScope: 'project' | 'user') => {
        const workspacePath =
          pluginScope === 'project' ? process.cwd() : undefined;
        return {
          parsePluginSpec,
          getMarketplaceRegistration: (name: string, sourceLocation?: string) =>
            findMarketplaceRegistration(name, sourceLocation, workspacePath),
          validateMarketplaceAccess: getMarketplaceAccessError,
          parseMarketplaceManifest,
          updateMarketplace: (name: string) =>
            updateMarketplace(name, workspacePath, {}, updateContext),
        };
      };
      const depsByScope = {
        project: createUpdateDeps('project'),
        user: createUpdateDeps('user'),
      };

      // Non-mutating discovery: classify every declaration before applying.
      const nativeTargets = {
        project: [] as string[],
        user: [] as string[],
      };
      const nativeOnly = new Set<string>();
      const checks = new Map<string, PluginUpdateCheck>();
      for (const entry of toUpdate) {
        const key = declarationKey(entry);
        if (progressiveOutput) {
          console.log(`Checking plugin source: ${declarationLabel(entry)}`);
        }
        const config = configs[entry.scope];
        if (config) {
          const declaration =
            config.plugins.find(
              (candidate) => getPluginSource(candidate) === entry.spec,
            ) ?? entry.spec;
          const plan = buildPluginSyncPlans(
            [declaration],
            config.clients,
            entry.scope,
          ).plans[0];
          const preflightErrors = await preflightNativePluginDeclaration(
            declaration,
            config.clients,
            entry.scope,
            process.cwd(),
          );
          if (preflightErrors.length > 0) {
            throw new Error(
              `Native preflight failed before update: ${preflightErrors.join('; ')}`,
            );
          }
          if ((plan?.nativeClients.length ?? 0) > 0) {
            nativeTargets[entry.scope].push(entry.spec);
            // Native state is outside a Git checkout, so a current checkout can
            // still need native reconciliation. Keep these available.
            checks.set(key, { plugin: entry.spec, status: 'available' });
            if (plan?.clients.length === 0) {
              nativeOnly.add(key);
            }
            continue;
          }
        }
        checks.set(
          key,
          await checkPluginUpdate(
            entry.spec,
            depsByScope[entry.scope],
            updateContext,
          ),
        );
      }

      const found = toUpdate.filter(
        (entry) => checks.get(declarationKey(entry))?.status === 'available',
      ).length;
      if (progressiveOutput && found > 0) {
        console.log(`Found ${found} plugin update${found === 1 ? '' : 's'}.`);
        console.log();
      }

      if (!jsonMode && !progressiveOutput) printUpdateHeader();

      // Update each plugin
      const results: InstalledPluginUpdateResult[] = [];
      const renderUpdateResult = (result: InstalledPluginUpdateResult) => {
        const icon = result.success
          ? result.action === 'updated'
            ? '\u2713'
            : '-'
          : '\u2717';
        console.log(`${icon} ${result.plugin} (${result.action})`);
        if (result.error) console.log(`  Error: ${result.error}`);
      };

      const syncedScopes = new Set<'project' | 'user'>();
      for (const entry of toUpdate) {
        const { spec: pluginSpec, scope: pluginScope } = entry;
        const key = declarationKey(entry);
        const check = checks.get(key);
        let result: InstalledPluginUpdateResult;
        if (check?.status === 'failed') {
          result = {
            plugin: pluginSpec,
            success: false,
            action: 'failed',
            ...(check.error && { error: check.error }),
          };
          if (progressiveOutput) renderUpdateResult(result);
        } else if (check?.status === 'up-to-date') {
          result = {
            plugin: pluginSpec,
            success: true,
            action: 'skipped',
          };
          // A current checkout still re-materializes client artifacts and
          // retries an earlier sync failure, matching the pre-check contract.
          syncedScopes.add(pluginScope);
          if (progressiveOutput) renderUpdateResult(result);
        } else if (nativeOnly.has(key)) {
          announceDeclaration(entry);
          result = {
            plugin: pluginSpec,
            success: true,
            action: 'skipped',
          };
        } else {
          announceDeclaration(entry);
          result = await applyPluginUpdate(
            pluginSpec,
            depsByScope[pluginScope],
            updateContext,
          );
          if (progressiveOutput) renderUpdateResult(result);
        }
        if (result.action === 'updated') syncedScopes.add(pluginScope);
        results.push(result);
      }

      // Sync each affected scope independently. Native mutation is constrained
      // to the declarations named by this invocation.
      let syncOk = true;
      const syncResults: Record<string, unknown> = {};
      const nativeEffects: Partial<
        Record<'project' | 'user', NativeEffectData[]>
      > = {};
      const targetsByScope = {
        project: toUpdate
          .filter((entry) => entry.scope === 'project')
          .map((entry) => entry.spec),
        user: toUpdate
          .filter((entry) => entry.scope === 'user')
          .map((entry) => entry.spec),
      };
      if (
        targetsByScope.project.length > 0 &&
        (syncedScopes.has('project') || nativeTargets.project.length > 0)
      ) {
        const { ok, syncData } = await runSyncAndPrint(
          {
            skipAgentFiles: true,
            nativeSelection: {
              mode: 'update',
              targets: targetsByScope.project,
            },
          },
          {
            announceWorkspace: !progressiveOutput,
            compactSuccess: progressiveOutput,
          },
        );
        syncResults.project = syncData;
        if (!ok) syncOk = false;
        nativeEffects.project = syncData.nativeResources?.effects ?? [];
      }
      if (
        targetsByScope.user.length > 0 &&
        (syncedScopes.has('user') || nativeTargets.user.length > 0)
      ) {
        const { ok, syncData } = await runUserSyncAndPrint(
          {
            skipAgentFiles: true,
            nativeSelection: {
              mode: 'update',
              targets: targetsByScope.user,
            },
          },
          { compactSuccess: progressiveOutput },
        );
        syncResults.user = syncData;
        if (!ok) syncOk = false;
        nativeEffects.user = syncData.nativeResources?.effects ?? [];
      }

      for (let index = 0; index < toUpdate.length; index++) {
        const entry = toUpdate[index];
        if (!entry || !nativeOnly.has(declarationKey(entry))) continue;
        const effects = (nativeEffects[entry.scope] ?? []).filter((effect) =>
          nativeIdentityMatches(
            entry.spec,
            effect.requestedIdentity,
            effect.resolvedIdentity,
          ));
        const failure = effects.find(
          (effect) => effect.action === 'failed' || effect.action === 'unknown',
        );
        const settledResult: InstalledPluginUpdateResult = failure
          ? {
              plugin: entry.spec,
              success: false,
              action: 'failed',
              error:
                failure.error ??
                `Native ${failure.phase} did not establish a known result`,
            }
          : effects.some((effect) => effect.changed)
            ? {
                plugin: entry.spec,
                success: true,
                action: 'updated',
              }
            : effects.length > 0
              ? {
                  plugin: entry.spec,
                  success: true,
                  action: 'skipped',
                }
              : {
                  plugin: entry.spec,
                  success: false,
                  action: 'failed',
                  error: 'Native update produced no matching lifecycle effect',
                };
        results[index] = settledResult;
        if (progressiveOutput) renderUpdateResult(settledResult);
      }

      if (!jsonMode && !progressiveOutput) {
        for (const result of results) renderUpdateResult(result);
      }
      const updated = results.filter((result) => result.action === 'updated').length;
      const skipped = results.filter((result) => result.action === 'skipped').length;
      const failed = results.filter((result) => result.action === 'failed').length;

      if (jsonMode) {
        jsonOutput({
          success: failed === 0 && syncOk,
          command: 'plugin update',
          data: {
            results: results.map((r) => ({
              plugin: r.plugin,
              success: r.success,
              action: r.action,
              ...(r.error && { error: r.error }),
            })),
            updated,
            skipped,
            failed,
            ...(Object.keys(syncResults).length > 0 && { syncResults }),
          },
          ...((failed > 0 || !syncOk) && {
            error:
              failed > 0
                ? `${failed} plugin(s) failed to update`
                : 'Native update or sync failed',
          }),
        });
        if (failed > 0 || !syncOk) {
          process.exit(1);
        }
        return;
      }

      console.log();
      console.log(`Update complete: ${updated} updated, ${skipped} skipped, ${failed} failed`);

      if (failed > 0 || !syncOk) {
        process.exit(1);
      }
    } catch (error) {
      if (error instanceof Error) {
        if (jsonMode) {
          jsonOutput({ success: false, command: 'plugin update', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    } finally {
      updateContext.dispose();
    }
  },
});

// =============================================================================
// plugin subcommands group
// =============================================================================

export const pluginCmd = conciseSubcommands({
  name: 'plugin',
  description: 'Manage plugins and marketplaces',
  cmds: {
    install: pluginInstallCmd,
    uninstall: pluginUninstallCmd,
    update: pluginUpdateCmd,
    marketplace: marketplaceCmd,
    list: pluginListCmd,
    validate: pluginValidateCmd,
    skills: skillsCmd,
  },
});
