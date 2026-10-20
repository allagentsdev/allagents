import { writeWorkspaceConfig } from '../utils/workspace-writer.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import { isPluginSpec, parsePluginSpec, getMarketplace } from './marketplace.js';
import { getUserWorkspaceConfigPath, isUserConfigPath } from './user-workspace.js';
import { getPluginSource, type PluginEntry } from '../models/workspace-config.js';
import {
  parseUserWorkspaceConfigForEdit,
  parseWorkspaceConfigForEdit,
} from '../utils/workspace-parser.js';

export interface PruneScopeResult {
  removed: string[];
  kept: string[];
}

export interface PruneResult {
  project: PruneScopeResult;
  user: PruneScopeResult;
}

/**
 * Check if a marketplace plugin is orphaned (marketplace not in registry)
 */
async function isOrphanedPlugin(pluginSpec: string): Promise<boolean> {
  if (!isPluginSpec(pluginSpec)) return false;
  const parsed = parsePluginSpec(pluginSpec);
  if (!parsed) return false;
  const marketplace = await getMarketplace(parsed.marketplaceName);
  return marketplace === null;
}

/**
 * Prune orphaned plugins from a config, returning removed and kept lists
 */
interface InternalPruneScopeResult extends PruneScopeResult {
  keptEntries: PluginEntry[];
}

async function prunePlugins(plugins: PluginEntry[]): Promise<InternalPruneScopeResult> {
  const removed: string[] = [];
  const kept: string[] = [];
  const keptEntries: PluginEntry[] = [];

  for (const pluginEntry of plugins) {
    const plugin = getPluginSource(pluginEntry);
    if (await isOrphanedPlugin(plugin)) {
      removed.push(plugin);
    } else {
      kept.push(plugin);
      keptEntries.push(pluginEntry);
    }
  }

  return { removed, kept, keptEntries };
}

/**
 * Prune orphaned plugin references from both project and user workspace configs.
 * An orphaned plugin is a marketplace plugin whose marketplace is no longer registered.
 *
 * @param workspacePath - Path to project workspace directory
 * @returns Results showing what was removed from each scope
 */
export async function pruneOrphanedPlugins(
  workspacePath: string,
): Promise<PruneResult> {
  // Prune project-level plugins
  let projectResult: InternalPruneScopeResult = { removed: [], kept: [], keptEntries: [] };
  const projectConfigPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);

  if (existsSync(projectConfigPath) && !isUserConfigPath(workspacePath)) {
    const config = await parseWorkspaceConfigForEdit(projectConfigPath);
    projectResult = await prunePlugins(config.plugins);

    if (projectResult.removed.length > 0) {
      config.plugins = projectResult.keptEntries;
      await writeWorkspaceConfig(projectConfigPath, config);
    }
  }

  // Prune user-level plugins
  let userResult: InternalPruneScopeResult = {
    removed: [],
    kept: [],
    keptEntries: [],
  };
  const userConfigPath = getUserWorkspaceConfigPath();
  const userConfig = existsSync(userConfigPath)
    ? await parseUserWorkspaceConfigForEdit(userConfigPath)
    : null;
  if (userConfig) {
    userResult = await prunePlugins(userConfig.plugins);

    if (userResult.removed.length > 0) {
      userConfig.plugins = userResult.keptEntries;
      await writeWorkspaceConfig(userConfigPath, userConfig);
    }
  }

  return {
    project: projectResult,
    user: userResult,
  };
}
