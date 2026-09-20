import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  array,
  command,
  flag,
  multioption,
  option,
  optional,
  positional,
  string,
} from 'cmd-ts';
import { resetFetchCache } from '../../core/plugin.js';
import { pruneOrphanedPlugins } from '../../core/prune.js';
import { getWorkspaceStatus } from '../../core/status.js';
import {
  mergeSyncResults,
  syncUserWorkspace,
  syncWorkspace,
} from '../../core/sync.js';
import type { SyncResult } from '../../core/sync.js';
import { updateInstalledProfiles } from '../../core/profile/index.js';
import type { ProfileApplyResult } from '../../core/profile/index.js';
import {
  ensureUserWorkspace,
  getUserWorkspaceConfigPath,
  isUserConfigPath,
} from '../../core/user-workspace.js';
import {
  addRepository,
  detectRemote,
  listRepositories,
  removeRepository,
  updateAgentFiles,
} from '../../core/workspace-repo.js';
import { runWorkspaceSetup } from '../../core/workspace-setup.js';
import { initWorkspace } from '../../core/workspace.js';
import {
  CLIENT_INPUT_TYPES,
  type ClientEntry,
  ClientEntrySchema,
  ClientTypeSchema,
  deduplicateClientEntries,
  InstallModeSchema,
} from '../../models/workspace-config.js';
import { formatPluginSource } from '../../utils/plugin-path.js';
import {
  buildSyncData,
  formatManagedRepoResults,
  formatMcpResult,
  formatNativeEffectData,
  formatNativeResult,
  formatPluginArtifacts,
  formatPluginHeader,
  formatSyncHeader,
  formatSyncSummary,
} from '../format-sync.js';
import { buildProfileData, formatProfileResult } from '../format-profile.js';
import { buildDescription, conciseSubcommands } from '../help.js';
import { isJsonMode, jsonOutput } from '../json-output.js';
import {
  repoAddMeta,
  repoListMeta,
  repoRemoveMeta,
} from '../metadata/workspace-repo.js';
import {
  initMeta,
  pruneMeta,
  setupMeta,
  statusMeta,
  syncMeta,
} from '../metadata/workspace.js';

// =============================================================================
// workspace init
// =============================================================================

/**
 * Parse comma-separated client string with optional :mode suffix.
 * "claude:native,copilot,vscode" → [{ name: 'claude', install: 'native' }, 'copilot', 'vscode']
 */
export function parseClientEntries(input: string): ClientEntry[] {
  const entries: ClientEntry[] = [];

  for (const part of input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const result = ClientEntrySchema.safeParse(part);
    if (!result.success) {
      // Provide user-friendly error messages
      const colonIdx = part.indexOf(':');
      if (colonIdx === -1) {
        throw new Error(
          `Invalid client(s): ${part}\n  Valid clients: ${CLIENT_INPUT_TYPES.join(', ')}`,
        );
      }
      const name = part.slice(0, colonIdx);
      const mode = part.slice(colonIdx + 1);
      if (!ClientTypeSchema.safeParse(name).success) {
        throw new Error(
          `Invalid client(s): ${name}\n  Valid clients: ${CLIENT_INPUT_TYPES.join(', ')}`,
        );
      }
      throw new Error(
        `Invalid install mode '${mode}' for client '${name}'. Valid modes: ${InstallModeSchema.options.join(', ')}`,
      );
    }
    entries.push(result.data);
  }

  return deduplicateClientEntries(entries);
}

const initCmd = command({
  name: 'init',
  description: buildDescription(initMeta),
  args: {
    path: positional({ type: optional(string), displayName: 'path' }),
    from: option({
      type: optional(string),
      long: 'from',
      description: 'Copy workspace.yaml from existing template/workspace',
    }),
    client: option({
      type: optional(string),
      long: 'client',
      short: 'c',
      description:
        'Comma-separated clients with optional :mode (e.g., claude:native,copilot,cursor)',
    }),
    force: flag({
      long: 'force',
      short: 'f',
      description: 'Overwrite existing workspace.yaml',
    }),
  },
  handler: async ({ path, from, client, force }) => {
    try {
      const targetPath = path ?? '.';
      let clients = client ? parseClientEntries(client) : undefined;

      // If no --client flag and no --from, prompt interactively.
      // When --from is used, the remote workspace.yaml defines the clients.
      if (!clients && !from) {
        const { promptForClients } = await import('../tui/prompt-clients.js');
        const prompted = await promptForClients();
        if (prompted === null) {
          if (isJsonMode()) {
            jsonOutput({
              success: false,
              command: 'workspace init',
              error: 'Cancelled',
            });
          }
          return;
        }
        clients = prompted;
      }

      const result = await initWorkspace(targetPath, {
        ...(from ? { from } : {}),
        ...(clients ? { clients } : {}),
        ...(force ? { force } : {}),
      });

      if (isJsonMode()) {
        const syncData = result.syncResult
          ? buildSyncData(result.syncResult)
          : null;
        jsonOutput({
          success: true,
          command: 'workspace init',
          data: { path: targetPath, syncResult: syncData },
        });
        return;
      }

      // Print sync results if sync was performed
      if (result.syncResult) {
        const syncResult = result.syncResult;

        if (syncResult.pluginResults.length > 0) {
          console.log('\nPlugin sync results:');
          for (const pluginResult of syncResult.pluginResults) {
            console.log(`  ${formatPluginHeader(pluginResult)}`);
            if (pluginResult.error) {
              console.log(`    Error: ${pluginResult.error}`);
            }
          }
        }

        console.log('');
        for (const line of formatSyncSummary(syncResult)) {
          console.log(line);
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({
            success: false,
            command: 'workspace init',
            error: error.message,
          });
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
// workspace setup
// =============================================================================

const setupCmd = command({
  name: 'setup',
  description: buildDescription(setupMeta),
  args: {},
  handler: async () => {
    try {
      const result = await runWorkspaceSetup(process.cwd(), {
        jsonMode: isJsonMode(),
      });
      const failed = result.commands.find(({ status }) => status === 'failed');

      if (failed) {
        const error =
          failed.signal !== null
            ? `Setup command terminated by signal ${failed.signal}: ${failed.command}`
            : `Setup command failed with exit code ${failed.exitCode}: ${failed.command}`;
        if (isJsonMode()) {
          jsonOutput({
            success: false,
            command: 'workspace setup',
            data: result,
            error,
          });
        } else {
          console.error(`Error: ${error}`);
        }
        process.exit(1);
      }

      if (isJsonMode()) {
        jsonOutput({
          success: true,
          command: 'workspace setup',
          data: result,
        });
        return;
      }

      if (result.commands.length === 0) {
        console.log('No setup commands configured.');
      } else {
        const ran = result.commands.filter(
          ({ status }) => status !== 'skipped',
        ).length;
        const skipped = result.commands.length - ran;
        console.log(
          `Setup complete. ${ran} command(s) ran; ${skipped} skipped.`,
        );
      }
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({
            success: false,
            command: 'workspace setup',
            error: error.message,
          });
        } else {
          console.error(`Error: ${error.message}`);
        }
        process.exit(1);
      }
      throw error;
    }
  },
});

// =============================================================================
// workspace sync
// =============================================================================

export interface WorkspaceSyncCommandOptions {
  readonly offline: boolean;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly verbose: boolean;
  readonly noManaged: boolean;
  readonly profile: readonly string[];
}

export interface WorkspaceSyncCommandDependencies {
  readonly userConfigExists: () => boolean;
  readonly projectConfigExists: (cwd: string) => boolean;
  readonly ensureUserWorkspace: typeof ensureUserWorkspace;
  readonly resetFetchCache: () => void | Promise<void>;
  readonly syncUserWorkspace: typeof syncUserWorkspace;
  readonly syncWorkspace: typeof syncWorkspace;
  readonly updateInstalledProfiles: typeof updateInstalledProfiles;
  readonly exit: (code: number) => void;
}

const workspaceSyncCommandDependencies: WorkspaceSyncCommandDependencies = {
  userConfigExists: () => existsSync(getUserWorkspaceConfigPath()),
  projectConfigExists: (cwd) =>
    !isUserConfigPath(cwd) &&
    existsSync(join(cwd, '.allagents', 'workspace.yaml')),
  ensureUserWorkspace,
  resetFetchCache,
  syncUserWorkspace,
  syncWorkspace,
  updateInstalledProfiles,
  exit: (code) => {
    process.exit(code);
  },
};


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printSyncResult(
  result: SyncResult,
  options: Pick<WorkspaceSyncCommandOptions, 'dryRun' | 'verbose'>,
): void {
  // Show purge plan in dry-run mode
  if (
    options.dryRun &&
    result.purgedPaths &&
    result.purgedPaths.length > 0
  ) {
    console.log('Would purge managed directories:');
    for (const purgePath of result.purgedPaths) {
      console.log(`  ${purgePath.client}:`);
      for (const path of purgePath.paths) {
        console.log(`    - ${path}`);
      }
    }
    console.log('');
  }

  // Print managed repo results
  if (result.managedRepoResults && result.managedRepoResults.length > 0) {
    for (const line of formatManagedRepoResults(result.managedRepoResults)) {
      console.log(line);
    }
    console.log('');
  }

  // Print sync header
  for (const line of formatSyncHeader(result)) {
    console.log(line);
  }
  console.log('');

  // Print plugin results
  for (const pluginResult of result.pluginResults) {
    console.log(formatPluginHeader(pluginResult));

    if (pluginResult.error) {
      console.log(`  Error: ${pluginResult.error}`);
    }

    for (const line of formatPluginArtifacts(pluginResult.copyResults)) {
      console.log(line);
    }

    const generated = pluginResult.copyResults.filter(
      (copyResult) => copyResult.action === 'generated',
    ).length;
    const failed = pluginResult.copyResults.filter(
      (copyResult) => copyResult.action === 'failed',
    ).length;

    if (generated > 0) console.log(`  Generated: ${generated} files`);
    if (failed > 0) {
      console.log(`  Failed: ${failed} files`);
      for (const failedResult of pluginResult.copyResults.filter(
        (copyResult) => copyResult.action === 'failed',
      )) {
        console.log(
          `    - ${failedResult.destination}: ${failedResult.error}`,
        );
      }
    }
  }

  // Show warnings
  if (result.warnings && result.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const warning of result.warnings) {
      console.log(`  \u26A0 ${warning}`);
    }
  }

  // Show informational messages
  if (options.verbose && result.messages && result.messages.length > 0) {
    console.log('');
    for (const message of result.messages) {
      console.log(`  ${message}`);
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

  // Print summary (only generated/failed/skipped/deleted totals)
  const summaryLines = formatSyncSummary(result);
  if (summaryLines.length > 0) {
    console.log('');
    for (const line of summaryLines) {
      console.log(line);
    }
  }

  // Print timing breakdown (debug only: ALLAGENTS_DEBUG=timing)
  if (process.env.ALLAGENTS_DEBUG?.includes('timing') && result.timing) {
    console.error('');
    const totalMs = result.timing.totalMs;
    console.error(`[debug] Sync timing (total: ${formatTimingMs(totalMs)})`);
    console.error(`[debug] ${'─'.repeat(56)}`);
    for (const step of result.timing.steps) {
      const pct =
        totalMs > 0 ? ((step.durationMs / totalMs) * 100).toFixed(1) : '0.0';
      const detail = step.detail ? ` [${step.detail}]` : '';
      const label = step.label.padEnd(40);
      const duration = formatTimingMs(step.durationMs).padStart(8);
      console.error(
        `[debug]   ${label} ${duration}  ${pct.padStart(5)}%${detail}`,
      );
    }
    console.error(`[debug] ${'─'.repeat(56)}`);
  }
}

export async function executeWorkspaceSyncCommand(
  options: WorkspaceSyncCommandOptions,
  dependencies: WorkspaceSyncCommandDependencies = workspaceSyncCommandDependencies,
): Promise<void> {
  try {
    if (!isJsonMode() && options.dryRun) {
      console.log('Dry run mode - no changes will be made\n');
    }

    const requestedProfiles = [...new Set(options.profile)];
    const targetedProfileUpdate = requestedProfiles.length > 0;
    let userConfigExists = false;
    let projectConfigExists = false;

    if (!targetedProfileUpdate) {
      userConfigExists = dependencies.userConfigExists();
      projectConfigExists = dependencies.projectConfigExists(process.cwd());

      // If neither config exists, auto-create user config and show guidance.
      if (!userConfigExists && !projectConfigExists) {
        await dependencies.ensureUserWorkspace();
        if (isJsonMode()) {
          jsonOutput({
            success: true,
            command: 'workspace sync',
            data: { message: 'No plugins configured', profiles: [] },
          });
        } else {
          console.log(
            'No plugins configured. Run `allagents plugin install <plugin>` to get started.',
          );
        }
        return;
      }
    }

    let combined: SyncResult | null = null;
    let profileResults: readonly ProfileApplyResult[] = [];
    const passErrors: string[] = [];

    // All ordinary and profile passes share one fetch cache.
    await dependencies.resetFetchCache();

    if (userConfigExists) {
      try {
        combined = await dependencies.syncUserWorkspace({
          offline: options.offline,
          dryRun: options.dryRun,
          force: options.force,
        });
      } catch (error) {
        passErrors.push(`User workspace: ${errorMessage(error)}`);
      }
    }

    if (targetedProfileUpdate || userConfigExists) {
      try {
        profileResults = await dependencies.updateInstalledProfiles(
          targetedProfileUpdate ? requestedProfiles : undefined,
          {
            offline: options.offline,
            dryRun: options.dryRun,
          },
        );
      } catch (error) {
        passErrors.push(`Profiles: ${errorMessage(error)}`);
      }
    }

    if (projectConfigExists) {
      try {
        const projectResult = await dependencies.syncWorkspace(process.cwd(), {
          offline: options.offline,
          dryRun: options.dryRun,
          skipManaged: options.noManaged,
        });
        combined = combined
          ? mergeSyncResults(combined, projectResult)
          : projectResult;
      } catch (error) {
        passErrors.push(`Project workspace: ${errorMessage(error)}`);
      }
    }

    const ordinarySuccess =
      combined === null ||
      (combined.success && combined.totalFailed === 0);
    const success =
      passErrors.length === 0 &&
      ordinarySuccess &&
      profileResults.every((result) => result.success);

    if (isJsonMode()) {
      jsonOutput({
        success,
        command: 'workspace sync',
        data: {
          ...(combined ? buildSyncData(combined) : {}),
          profiles: profileResults.map(buildProfileData),
        },
        ...(!success && {
          error:
            passErrors.length > 0
              ? passErrors.join('; ')
              : 'Sync completed with failures',
        }),
      });
      if (!success) dependencies.exit(1);
      return;
    }

    if (combined) {
      printSyncResult(combined, options);
    }

    let separateProfileOutput = combined !== null;
    for (const profileResult of profileResults) {
      if (separateProfileOutput) console.log('');
      for (const line of formatProfileResult(profileResult)) {
        console.log(line);
      }
      separateProfileOutput = true;
    }

    if (passErrors.length > 0) {
      if (combined || profileResults.length > 0) console.error('');
      for (const error of passErrors) {
        console.error(`Error: ${error}`);
      }
    }

    if (!success) dependencies.exit(1);
  } catch (error) {
    if (error instanceof Error) {
      if (isJsonMode()) {
        jsonOutput({
          success: false,
          command: 'workspace sync',
          error: error.message,
        });
        dependencies.exit(1);
        return;
      }
      console.error(`Error: ${error.message}`);
      dependencies.exit(1);
      return;
    }
    throw error;
  }
}

const syncCmd = command({
  name: 'update',
  aliases: ['sync'],
  description: buildDescription(syncMeta),
  args: {
    offline: flag({
      long: 'offline',
      description: 'Use cached plugins without fetching latest from remote',
    }),
    dryRun: flag({
      long: 'dry-run',
      short: 'n',
      description: 'Simulate sync without making changes',
    }),
    force: flag({
      long: 'force',
      short: 'f',
      description:
        'Overwrite existing MCP server entries that differ from plugin config',
    }),
    verbose: flag({
      long: 'verbose',
      short: 'v',
      description: 'Show informational sync messages',
    }),
    noManaged: flag({
      long: 'no-managed',
      description: 'Skip managed repository clone/pull operations',
    }),
    profile: multioption({
      type: array(string),
      long: 'profile',
      description: 'Update only this installed profile (repeatable)',
    }),
  },
  handler: executeWorkspaceSyncCommand,
});

function formatTimingMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

// =============================================================================
// workspace status
// =============================================================================

function formatPluginStatusLine(plugin: {
  source: string;
  type: 'local' | 'github' | 'marketplace';
  kind: 'skill' | 'plugin';
  available: boolean;
}): string {
  const status = plugin.available ? '✓' : '✗';
  const labels: string[] = [plugin.kind];
  if (plugin.type === 'marketplace') {
    if (!plugin.available) labels.push('not synced');
  } else if (plugin.type === 'github') {
    labels.push(plugin.available ? 'cached' : 'not cached');
  } else {
    labels.push('local');
  }
  return `${status} ${formatPluginSource(plugin.source)} (${labels.join(', ')})`;
}

const statusCmd = command({
  name: 'status',
  description: buildDescription(statusMeta),
  args: {},
  handler: async () => {
    try {
      const result = await getWorkspaceStatus();

      if (isJsonMode()) {
        jsonOutput({
          success: result.success,
          command: 'workspace status',
          data: {
            plugins: result.plugins,
            userPlugins: result.userPlugins ?? [],
            clients: result.clients,
            nativeResources: result.nativeResources,
          },
          ...(!result.success && {
            error: result.error ?? 'Native inspection failed',
          }),
        });
        if (!result.success) process.exit(1);
        return;
      }

      // Display project plugins
      console.log(`Project Plugins (${result.plugins.length}):`);
      if (result.plugins.length === 0) {
        console.log('  No plugins configured');
      } else {
        for (const plugin of result.plugins) {
          console.log(`  ${formatPluginStatusLine(plugin)}`);
        }
      }

      // Display user plugins
      if (result.userPlugins) {
        console.log(`\nUser Plugins (${result.userPlugins.length}):`);
        if (result.userPlugins.length === 0) {
          console.log('  No user plugins configured');
        } else {
          for (const plugin of result.userPlugins) {
            console.log(`  ${formatPluginStatusLine(plugin)}`);
          }
        }
      }

      if (result.nativeResources.length > 0) {
        console.log(`\nNative Resources (${result.nativeResources.length}):`);
        for (const nativeResource of result.nativeResources) {
          console.log(
            `${formatNativeEffectData(nativeResource)} declared=${String(nativeResource.declared)} ownership=${nativeResource.ownership}${nativeResource.transition ? ` transition=${nativeResource.transition}` : ''}`,
          );
        }
      }

      // Display clients
      console.log(`\nClients (${result.clients.length}):`);
      if (result.clients.length === 0) {
        console.log('  No clients configured');
      } else {
        console.log(`  ${result.clients.join(', ')}`);
      }

      if (!result.success) {
        console.error(`Error: ${result.error ?? 'Native inspection failed'}`);
        process.exit(1);
      }
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({
            success: false,
            command: 'workspace status',
            error: error.message,
          });
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
// workspace prune
// =============================================================================

const pruneCmd = command({
  name: 'prune',
  description: buildDescription(pruneMeta),
  args: {},
  handler: async () => {
    try {
      const result = await pruneOrphanedPlugins(process.cwd());

      if (isJsonMode()) {
        jsonOutput({
          success: true,
          command: 'workspace prune',
          data: result,
        });
        return;
      }

      const totalRemoved =
        result.project.removed.length + result.user.removed.length;

      if (totalRemoved === 0) {
        console.log('No orphaned plugins found.');
        return;
      }

      if (result.project.removed.length > 0) {
        console.log(
          `Project plugins pruned (${result.project.removed.length}):`,
        );
        for (const p of result.project.removed) {
          console.log(`  - ${p}`);
        }
      }

      if (result.user.removed.length > 0) {
        console.log(`User plugins pruned (${result.user.removed.length}):`);
        for (const p of result.user.removed) {
          console.log(`  - ${p}`);
        }
      }

      console.log(`\n\u2713 Removed ${totalRemoved} orphaned plugin(s)`);
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({
            success: false,
            command: 'workspace prune',
            error: error.message,
          });
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
// workspace repo add
// =============================================================================

const repoAddCmd = command({
  name: 'add',
  description: buildDescription(repoAddMeta),
  args: {
    path: positional({ type: string, displayName: 'path' }),
    description: option({
      type: optional(string),
      long: 'description',
      short: 'd',
      description: 'Repository description',
    }),
  },
  handler: async ({ path: repoPath, description }) => {
    try {
      // Auto-detect source and repo from git remote
      const resolvedPath = resolve(process.cwd(), repoPath);
      const remote = await detectRemote(resolvedPath);

      const result = await addRepository(repoPath, {
        source: remote?.source,
        repo: remote?.repo,
        description,
      });

      if (!result.success) {
        if (isJsonMode()) {
          jsonOutput({
            success: false,
            command: 'workspace repo add',
            error: result.error ?? 'Unknown error',
          });
          process.exit(1);
        }
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      // Ensure WORKSPACE-RULES are injected into agent files
      await updateAgentFiles();

      if (isJsonMode()) {
        jsonOutput({
          success: true,
          command: 'workspace repo add',
          data: {
            path: repoPath,
            source: remote?.source ?? null,
            repo: remote?.repo ?? null,
            description: description ?? null,
          },
        });
        return;
      }

      console.log(`\u2713 Added repository: ${repoPath}`);
      if (remote) console.log(`  Source: ${remote.source} (${remote.repo})`);
      if (description) console.log(`  Description: ${description}`);
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({
            success: false,
            command: 'workspace repo add',
            error: error.message,
          });
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
// workspace repo remove
// =============================================================================

const repoRemoveCmd = command({
  name: 'remove',
  description: buildDescription(repoRemoveMeta),
  args: {
    path: positional({ type: string, displayName: 'path' }),
  },
  handler: async ({ path: repoPath }) => {
    try {
      const result = await removeRepository(repoPath);

      if (!result.success) {
        if (isJsonMode()) {
          jsonOutput({
            success: false,
            command: 'workspace repo remove',
            error: result.error ?? 'Unknown error',
          });
          process.exit(1);
        }
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      // Ensure WORKSPACE-RULES are injected into agent files
      await updateAgentFiles();

      if (isJsonMode()) {
        jsonOutput({
          success: true,
          command: 'workspace repo remove',
          data: { path: repoPath },
        });
        return;
      }

      console.log(`\u2713 Removed repository: ${repoPath}`);
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({
            success: false,
            command: 'workspace repo remove',
            error: error.message,
          });
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
// workspace repo list
// =============================================================================

const repoListCmd = command({
  name: 'list',
  description: buildDescription(repoListMeta),
  args: {},
  handler: async () => {
    try {
      const repos = await listRepositories();

      if (isJsonMode()) {
        jsonOutput({
          success: true,
          command: 'workspace repo list',
          data: { repositories: repos, total: repos.length },
        });
        return;
      }

      if (repos.length === 0) {
        console.log('No repositories configured.\n');
        console.log('Add a repository with:');
        console.log('  allagents workspace repo add <path>');
        return;
      }

      console.log('Repositories:\n');
      for (const repo of repos) {
        console.log(`  ${repo.path}`);
        if (repo.source && repo.repo)
          console.log(`    Source: ${repo.source} (${repo.repo})`);
        if (repo.description)
          console.log(`    Description: ${repo.description}`);
        console.log();
      }
      console.log(`Total: ${repos.length} repository(ies)`);
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({
            success: false,
            command: 'workspace repo list',
            error: error.message,
          });
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
// workspace repo subcommands group
// =============================================================================

const repoCmd = conciseSubcommands({
  name: 'repo',
  description: 'Manage workspace repositories',
  cmds: {
    add: repoAddCmd,
    remove: repoRemoveCmd,
    list: repoListCmd,
  },
});

// =============================================================================
// workspace subcommands group
// =============================================================================

export { syncCmd, initCmd, statusCmd };

export const workspaceCmd = conciseSubcommands({
  name: 'workspace',
  description:
    'Manage AI agent workspaces - initialize, sync, and configure plugins',
  cmds: {
    init: initCmd,
    setup: setupCmd,
    sync: syncCmd,
    status: statusCmd,
    prune: pruneCmd,
    repo: repoCmd,
  },
});
