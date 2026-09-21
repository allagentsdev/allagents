import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { dump } from 'js-yaml';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import type {
  ClientEntry,
  ClientType,
  PluginEntry,
  UserWorkspaceConfig,
  WorkspaceConfig,
} from '../models/workspace-config.js';
import {
  getEffectivePluginSource,
  getPluginSource,
  UserWorkspaceConfigSchema,
} from '../models/workspace-config.js';
import {
  getPluginDisplayName,
  isFilesystemRoot,
  isGitHubUrl,
  validatePluginSource,
  verifyGitHubUrlExists,
} from '../utils/plugin-path.js';
import { loadYaml } from '../utils/yaml.js';
import { getAllagentsDir } from './marketplace.js';
import { isPluginSpec, parsePluginSpec } from './marketplace.js';
import {
  type ModifyResult,
  type PluginInstallTarget,
  type TargetedPluginWriteDependencies,
  ensureObjectPluginEntry,
  extractPluginNames,
  findPluginEntryByName,
  mergeTargetedPluginEntry,
  pruneDisabledSkillsForPlugin,
  resolveMarketplacePluginDeclaration,
  pruneEnabledSkillsForPlugin,
  resolveGitHubIdentity,
  upsertGitHubPluginSourceAllowlistInConfig,
  writeWorkspaceConfigAtomically,
} from './workspace-modify.js';
import { parseUserWorkspaceConfigForEdit } from '../utils/workspace-parser.js';

/**
 * Default clients for user-scope installations.
 * Note: 'claude' is excluded to avoid conflicting with Claude's native
 * plugin system. Claude is only included for project-scoped (.allagents)
 * installations.
 */
const DEFAULT_USER_CLIENTS: ClientEntry[] = [
  'copilot',
  'codex',
  'cursor',
  'opencode',
  'gemini',
  'vscode',
];

/**
 * Get path to user-level workspace config: ~/.allagents/workspace.yaml
 */
export function getUserWorkspaceConfigPath(): string {
  return join(getAllagentsDir(), WORKSPACE_CONFIG_FILE);
}

/**
 * Check if a workspace path's config resolves to the user-level config.
 * This happens when cwd is the user's home directory, causing the project
 * config path (cwd/.allagents/workspace.yaml) to be the same file as the
 * user config (~/.allagents/workspace.yaml).
 */
export function isUserConfigPath(workspacePath: string): boolean {
  const projectConfigPath = join(
    workspacePath,
    CONFIG_DIR,
    WORKSPACE_CONFIG_FILE,
  );
  const userConfigPath = getUserWorkspaceConfigPath();
  return resolve(projectConfigPath) === resolve(userConfigPath);
}

/**
 * Ensure user-level workspace.yaml exists with default config.
 * Creates it if missing, does not overwrite existing.
 */
export async function ensureUserWorkspace(
  clients?: ClientEntry[],
): Promise<void> {
  const configPath = getUserWorkspaceConfigPath();
  if (existsSync(configPath)) return;

  const defaultConfig: UserWorkspaceConfig = {
    repositories: [],
    plugins: [],
    clients: clients ? [...clients] : [...DEFAULT_USER_CLIENTS],
  };

  await mkdir(getAllagentsDir(), { recursive: true });
  await writeFile(configPath, dump(defaultConfig, { lineWidth: -1 }), 'utf-8');
}

/**
 * Read and validate the user-level workspace config. Returns null only when the
 * file is absent; invalid YAML or declarations are surfaced to the caller.
 */
export async function getUserWorkspaceConfig(): Promise<UserWorkspaceConfig | null> {
  const configPath = getUserWorkspaceConfigPath();
  if (!existsSync(configPath)) return null;
  const editable = await parseUserWorkspaceConfigForEdit(configPath);
  return UserWorkspaceConfigSchema.parse(editable);
}

/**
 * Add a plugin to the user-level workspace config.
 * Creates the config file if it doesn't exist.
 *
 * Supports three formats:
 * 1. plugin@marketplace (e.g., "code-review@claude-plugins-official")
 * 2. GitHub URL (e.g., "https://github.com/owner/repo")
 * 3. Local path (e.g., "/home/user/my-plugin")
 */
export async function addUserPlugin(
  plugin: string,
  force?: boolean,
): Promise<ModifyResult> {
  return addValidatedUserPlugin(plugin, force);
}

/**
 * User-scope counterpart to addPluginForTarget.
 */
export async function addUserPluginForTarget(
  target: PluginInstallTarget,
  dependencies: TargetedPluginWriteDependencies = {},
): Promise<ModifyResult> {
  return addValidatedUserPlugin(
    target.declaration,
    true,
    target.clients,
    target.sourceValidation,
    dependencies,
  );
}

async function addValidatedUserPlugin(
  declaration: PluginEntry,
  force?: boolean,
  initialClients?: readonly ClientType[],
  sourceValidation: 'standard' | 'declaration' = 'standard',
  dependencies?: TargetedPluginWriteDependencies,
): Promise<ModifyResult> {
  const plugin = getPluginSource(declaration);
  const configPath = getUserWorkspaceConfigPath();
  const initialConfig =
    dependencies !== undefined && !existsSync(configPath)
      ? {
          repositories: [],
          plugins: [],
          clients: initialClients
            ? [...initialClients]
            : [...DEFAULT_USER_CLIENTS],
        }
      : undefined;
  if (dependencies === undefined) await ensureUserWorkspace();

  if (sourceValidation === 'declaration') {
    return addPluginToUserConfig(
      declaration,
      configPath,
      undefined,
      force,
      dependencies,
      initialConfig,
    );
  }
  if (isPluginSpec(plugin)) {
    const resolved = await resolveMarketplacePluginDeclaration(declaration);
    if (!resolved.success) {
      return resolved;
    }
    return addPluginToUserConfig(
      resolved.declaration,
      configPath,
      resolved.registeredAs,
      force,
      dependencies,
      initialConfig,
    );
  }

  if (isGitHubUrl(plugin)) {
    const validation = validatePluginSource(plugin);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.error || 'Invalid GitHub URL',
      };
    }
    const verifyResult = await verifyGitHubUrlExists(plugin);
    if (!verifyResult.exists) {
      return {
        success: false,
        error: verifyResult.error || `GitHub URL not found: ${plugin}`,
      };
    }
  } else {
    if (!existsSync(plugin)) {
      return {
        success: false,
        error: `Plugin not found at ${plugin}`,
      };
    }
    if (isFilesystemRoot(plugin)) {
      return {
        success: false,
        error: `Plugin source cannot be a filesystem root directory: ${plugin}`,
      };
    }
  }

  return addPluginToUserConfig(
    declaration,
    configPath,
    undefined,
    force,
    dependencies,
    initialConfig,
  );
}

/**
 * Check if a plugin exists in the user-level workspace config.
 * @param plugin - Plugin source to find (exact match or partial match)
 * @returns true if the plugin is found
 */
export async function hasUserPlugin(plugin: string): Promise<boolean> {
  const config = await getUserWorkspaceConfig();
  if (!config) return false;

  // Exact match first
  if (config.plugins.some((entry) => getPluginSource(entry) === plugin))
    return true;

  // Partial match
  return config.plugins.some((entry) => {
    const source = getPluginSource(entry);
    return source.startsWith(`${plugin}@`) || source === plugin;
  });
}

/**
 * Remove a plugin from the user-level workspace config.
 */
export async function removeUserPlugin(plugin: string): Promise<ModifyResult> {
  await ensureUserWorkspace();
  const configPath = getUserWorkspaceConfigPath();

  try {
    const config = await parseUserWorkspaceConfigForEdit(configPath);

    // Exact match first
    let index = config.plugins.findIndex(
      (entry) => getPluginSource(entry) === plugin,
    );

    // Partial match: plugin name without marketplace suffix
    if (index === -1) {
      index = config.plugins.findIndex((entry) => {
        const source = getPluginSource(entry);
        return source.startsWith(`${plugin}@`) || source === plugin;
      });
    }

    // Semantic match: same GitHub repo under a different format
    if (index === -1) {
      const identity = await resolveGitHubIdentity(plugin);
      if (identity) {
        for (let i = 0; i < config.plugins.length; i++) {
          const p = config.plugins[i];
          if (!p) continue;
          const existing = await resolveGitHubIdentity(getPluginSource(p));
          if (existing === identity) {
            index = i;
            break;
          }
        }
      }
    }

    if (index === -1) {
      return {
        success: false,
        error: `Plugin not found in user config: ${plugin}`,
      };
    }

    const removedEntry = getPluginSource(config.plugins[index] as PluginEntry);
    config.plugins.splice(index, 1);
    pruneDisabledSkillsForPlugin(config, removedEntry);
    pruneEnabledSkillsForPlugin(config, removedEntry);
    await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf-8');
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get user plugins that reference a given marketplace name.
 * Matches plugins with `@marketplace-name` suffix.
 */
export async function getUserPluginsForMarketplace(
  marketplaceName: string,
): Promise<string[]> {
  const config = await getUserWorkspaceConfig();
  if (!config) return [];
  return config.plugins
    .map((entry) => getPluginSource(entry))
    .filter((source) => {
      const parsed = parsePluginSpec(source);
      return parsed?.marketplaceName === marketplaceName;
    });
}

/**
 * Remove all user plugins that reference a given marketplace name.
 * Returns the list of removed plugin specs.
 */
export async function removeUserPluginsForMarketplace(
  marketplaceName: string,
): Promise<string[]> {
  const configPath = getUserWorkspaceConfigPath();
  if (!existsSync(configPath)) return [];
  const config = await parseUserWorkspaceConfigForEdit(configPath);

  const matching = config.plugins.filter((entry) => {
    const parsed = parsePluginSpec(getPluginSource(entry));
    return parsed?.marketplaceName === marketplaceName;
  });

  if (matching.length === 0) return [];

  config.plugins = config.plugins.filter((entry) => !matching.includes(entry));
  await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf-8');
  return matching.map((entry) => getPluginSource(entry));
}

/**
 * Add plugin entry to the user-level config file.
 */
async function addPluginToUserConfig(
  plugin: PluginEntry,
  configPath: string,
  autoRegistered?: string,
  force?: boolean,
  targetedDependencies?: TargetedPluginWriteDependencies,
  initialConfig?: WorkspaceConfig,
): Promise<ModifyResult> {
  try {
    const config =
      initialConfig ?? (await parseUserWorkspaceConfigForEdit(configPath));
    const source = getPluginSource(plugin);
    const exactIndex = config.plugins.findIndex(
      (entry) => getPluginSource(entry) === source,
    );
    if (exactIndex !== -1 && !force) {
      return {
        success: false,
        error: `Plugin already exists in user config: ${source}`,
      };
    }

    let semanticIndex = -1;
    const newIdentity = await resolveGitHubIdentity(source);
    if (newIdentity) {
      for (let i = 0; i < config.plugins.length; i++) {
        if (i === exactIndex) continue;
        const existing = config.plugins[i];
        if (!existing) continue;
        if (
          (await resolveGitHubIdentity(getPluginSource(existing))) ===
          newIdentity
        ) {
          semanticIndex = i;
          break;
        }
      }
    }

    if (semanticIndex !== -1 && !force) {
      const existingSource = getPluginSource(
        config.plugins[semanticIndex] as PluginEntry,
      );
      return {
        success: false,
        error: `Plugin duplicates existing entry '${existingSource}': both resolve to ${newIdentity}`,
      };
    }

    let targetedReplaceIndex = -1;
    if (targetedDependencies !== undefined) {
      targetedReplaceIndex = exactIndex !== -1 ? exactIndex : semanticIndex;
      const nextEntry = mergeTargetedPluginEntry(
        targetedReplaceIndex === -1
          ? undefined
          : config.plugins[targetedReplaceIndex],
        plugin,
        source,
        config.clients,
      );
      if (targetedReplaceIndex === -1) config.plugins.push(nextEntry);
      else config.plugins[targetedReplaceIndex] = nextEntry;
      await writeWorkspaceConfigAtomically(
        configPath,
        config,
        'user',
        targetedDependencies,
      );
    } else {
      if (exactIndex !== -1) config.plugins.splice(exactIndex, 1);
      const adjustedSemanticIndex =
        exactIndex !== -1 && semanticIndex > exactIndex
          ? semanticIndex - 1
          : semanticIndex;
      if (adjustedSemanticIndex !== -1) {
        config.plugins.splice(adjustedSemanticIndex, 1);
      }
      config.plugins.push(plugin);
      await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf-8');
    }

    return {
      success: true,
      ...(autoRegistered && { autoRegistered }),
      normalizedPlugin: source,
      ...(force && {
        replaced:
          targetedDependencies !== undefined
            ? targetedReplaceIndex !== -1
            : exactIndex !== -1,
      }),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function addUserPluginDeclaration(
  plugin: string,
  force?: boolean,
): Promise<ModifyResult> {
  await ensureUserWorkspace();
  return addPluginToUserConfig(
    plugin,
    getUserWorkspaceConfigPath(),
    undefined,
    force,
  );
}

/**
 * Set clients in user-level workspace config.
 * Creates the config file if it doesn't exist.
 */
export async function setUserClients(
  clients: ClientEntry[],
): Promise<ModifyResult> {
  await ensureUserWorkspace();
  const configPath = getUserWorkspaceConfigPath();

  try {
    const config = await parseUserWorkspaceConfigForEdit(configPath);
    config.clients = clients;
    await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf-8');
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Parse "pluginName:skillName" into its two parts, or return null on bad format. */
function parseSkillKey(
  skillKey: string,
): { pluginName: string; skillName: string } | null {
  const colonIdx = skillKey.indexOf(':');
  if (colonIdx === -1) return null;
  return {
    pluginName: skillKey.slice(0, colonIdx),
    skillName: skillKey.slice(colonIdx + 1),
  };
}

/**
 * Get disabled skills from user workspace config.
 * Reads from inline plugin entry `skills.exclude` arrays (blocklist mode).
 * Also includes legacy top-level `disabledSkills` for backward compatibility.
 * @returns Array of disabled skill keys (plugin:skill format)
 */
export async function getUserDisabledSkills(): Promise<string[]> {
  const config = await getUserWorkspaceConfig();
  if (!config) return [];

  const result: string[] = [];
  for (const entry of config.plugins) {
    if (
      typeof entry === 'string' ||
      !entry.skills ||
      Array.isArray(entry.skills)
    )
      continue;
    const pluginName = extractPluginNames(getPluginSource(entry))[0];
    if (!pluginName) continue;
    for (const skillName of entry.skills.exclude) {
      result.push(`${pluginName}:${skillName}`);
    }
  }

  // Include legacy top-level disabledSkills
  for (const s of config.disabledSkills ?? []) {
    if (!result.includes(s)) result.push(s);
  }

  return result;
}

/**
 * Add a skill to the plugin entry's `skills.exclude` list (blocklist mode) in user workspace config.
 * Converts a string shorthand plugin entry to object form if needed.
 * @param skillKey - Skill key in plugin:skill format
 */
export async function addUserDisabledSkill(
  skillKey: string,
): Promise<ModifyResult> {
  await ensureUserWorkspace();
  const configPath = getUserWorkspaceConfigPath();

  const parsed = parseSkillKey(skillKey);
  if (!parsed) {
    return {
      success: false,
      error: `Invalid skill key format: '${skillKey}' (expected pluginName:skillName)`,
    };
  }
  const { pluginName, skillName } = parsed;

  try {
    const config = await parseUserWorkspaceConfigForEdit(configPath);

    const index = findPluginEntryByName(config, pluginName);
    if (index === -1) {
      return {
        success: false,
        error: `Plugin '${pluginName}' not found in user workspace config`,
      };
    }

    const entry = ensureObjectPluginEntry(config, index);

    if (Array.isArray(entry.skills)) {
      return {
        success: false,
        error: `Plugin '${pluginName}' is in allowlist mode; use removeUserEnabledSkill to disable a skill`,
      };
    }

    const existing = entry.skills?.exclude ?? [];
    if (existing.includes(skillName)) {
      return {
        success: false,
        error: `Skill '${skillKey}' is already disabled`,
      };
    }

    entry.skills = { exclude: [...existing, skillName] };
    await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf-8');
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Remove a skill from the plugin entry's `skills.exclude` list (blocklist mode) in user workspace config.
 * @param skillKey - Skill key in plugin:skill format
 */
export async function removeUserDisabledSkill(
  skillKey: string,
): Promise<ModifyResult> {
  await ensureUserWorkspace();
  const configPath = getUserWorkspaceConfigPath();

  const parsed = parseSkillKey(skillKey);
  if (!parsed) {
    return {
      success: false,
      error: `Invalid skill key format: '${skillKey}' (expected pluginName:skillName)`,
    };
  }
  const { pluginName, skillName } = parsed;

  try {
    const config = await parseUserWorkspaceConfigForEdit(configPath);

    const index = findPluginEntryByName(config, pluginName);
    if (index === -1) {
      return {
        success: false,
        error: `Plugin '${pluginName}' not found in user workspace config`,
      };
    }

    const entry = config.plugins[index];
    if (!entry) {
      return {
        success: false,
        error: `Plugin '${pluginName}' not found in user workspace config`,
      };
    }
    if (
      typeof entry === 'string' ||
      !entry.skills ||
      Array.isArray(entry.skills)
    ) {
      return {
        success: false,
        error: `Skill '${skillKey}' is already enabled`,
      };
    }

    if (!entry.skills.exclude.includes(skillName)) {
      return {
        success: false,
        error: `Skill '${skillKey}' is already enabled`,
      };
    }

    const newExclude = entry.skills.exclude.filter((s) => s !== skillName);
    entry.skills = newExclude.length > 0 ? { exclude: newExclude } : undefined;

    await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf-8');
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get enabled skills from user workspace config.
 * Reads from inline plugin entry `skills` arrays (allowlist mode).
 * Also includes legacy top-level `enabledSkills` for backward compatibility.
 * @returns Array of enabled skill keys (plugin:skill format)
 */
export async function getUserEnabledSkills(): Promise<string[]> {
  const config = await getUserWorkspaceConfig();
  if (!config) return [];

  const result: string[] = [];
  for (const entry of config.plugins) {
    if (typeof entry === 'string' || !Array.isArray(entry.skills)) continue;
    const pluginName = extractPluginNames(getPluginSource(entry))[0];
    if (!pluginName) continue;
    for (const skillName of entry.skills) {
      result.push(`${pluginName}:${skillName}`);
    }
  }

  // Include legacy top-level enabledSkills
  for (const s of config.enabledSkills ?? []) {
    if (!result.includes(s)) result.push(s);
  }

  return result;
}

/**
 * Add a skill to the plugin entry's `skills` allowlist in user workspace config.
 * Converts a string shorthand plugin entry to object form if needed.
 * @param skillKey - Skill key in plugin:skill format
 */
export async function addUserEnabledSkill(
  skillKey: string,
): Promise<ModifyResult> {
  await ensureUserWorkspace();
  const configPath = getUserWorkspaceConfigPath();

  const parsed = parseSkillKey(skillKey);
  if (!parsed) {
    return {
      success: false,
      error: `Invalid skill key format: '${skillKey}' (expected pluginName:skillName)`,
    };
  }
  const { pluginName, skillName } = parsed;

  try {
    const config = await parseUserWorkspaceConfigForEdit(configPath);

    const index = findPluginEntryByName(config, pluginName);
    if (index === -1) {
      return {
        success: false,
        error: `Plugin '${pluginName}' not found in user workspace config`,
      };
    }

    const entry = ensureObjectPluginEntry(config, index);

    if (entry.skills && !Array.isArray(entry.skills)) {
      return {
        success: false,
        error: `Plugin '${pluginName}' is in blocklist mode; use removeUserDisabledSkill to enable a skill`,
      };
    }

    const existing = (entry.skills as string[] | undefined) ?? [];
    if (existing.includes(skillName)) {
      return {
        success: false,
        error: `Skill '${skillKey}' is already enabled`,
      };
    }

    entry.skills = [...existing, skillName];
    await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf-8');
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Remove a skill from the plugin entry's `skills` allowlist in user workspace config.
 * @param skillKey - Skill key in plugin:skill format
 */
export async function removeUserEnabledSkill(
  skillKey: string,
): Promise<ModifyResult> {
  await ensureUserWorkspace();
  const configPath = getUserWorkspaceConfigPath();

  const parsed = parseSkillKey(skillKey);
  if (!parsed) {
    return {
      success: false,
      error: `Invalid skill key format: '${skillKey}' (expected pluginName:skillName)`,
    };
  }
  const { pluginName, skillName } = parsed;

  try {
    const config = await parseUserWorkspaceConfigForEdit(configPath);

    const index = findPluginEntryByName(config, pluginName);
    if (index === -1) {
      return {
        success: false,
        error: `Plugin '${pluginName}' not found in user workspace config`,
      };
    }

    const entry = config.plugins[index];
    if (!entry) {
      return {
        success: false,
        error: `Plugin '${pluginName}' not found in user workspace config`,
      };
    }
    if (
      typeof entry === 'string' ||
      !entry.skills ||
      !Array.isArray(entry.skills)
    ) {
      return {
        success: false,
        error: `Skill '${skillKey}' is already disabled`,
      };
    }

    if (!entry.skills.includes(skillName)) {
      return {
        success: false,
        error: `Skill '${skillKey}' is already disabled`,
      };
    }

    const newSkills = entry.skills.filter((s) => s !== skillName);
    entry.skills = newSkills;

    await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf-8');
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Set the skills mode for a plugin entry in user workspace config.
 * 'allowlist' sets `skills = [skillNames]` (only listed skills enabled; empty array = all disabled).
 * 'blocklist' sets `skills = { exclude: [skillNames] }` or `undefined` if empty (= all enabled).
 * @param pluginName - Plugin name to modify
 * @param mode - Target mode: 'allowlist' or 'blocklist'
 * @param skillNames - For allowlist: enabled skill names. For blocklist: disabled skill names.
 */
export async function setUserPluginSkillsMode(
  pluginName: string,
  mode: 'allowlist' | 'blocklist',
  skillNames: string[],
): Promise<ModifyResult> {
  await ensureUserWorkspace();
  const configPath = getUserWorkspaceConfigPath();

  try {
    const config = await parseUserWorkspaceConfigForEdit(configPath);

    const index = findPluginEntryByName(config, pluginName);
    if (index === -1) {
      return {
        success: false,
        error: `Plugin '${pluginName}' not found in user workspace config`,
      };
    }

    const entry = ensureObjectPluginEntry(config, index);

    if (mode === 'allowlist') {
      // Always set the array to preserve allowlist mode, even if empty
      entry.skills = [...skillNames];
    } else {
      // For blocklist, clear the field if no exclusions (= all enabled)
      entry.skills =
        skillNames.length > 0 ? { exclude: [...skillNames] } : undefined;
    }

    await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf-8');
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function upsertUserGitHubPluginSourceAllowlist(
  source: string,
  skillNames: string[],
): Promise<ModifyResult> {
  await ensureUserWorkspace();
  const configPath = getUserWorkspaceConfigPath();

  try {
    const config = await parseUserWorkspaceConfigForEdit(configPath);
    const result = await upsertGitHubPluginSourceAllowlistInConfig(
      config,
      source,
      skillNames,
    );
    if (!result.success) return result;

    await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf-8');
    return result;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Scope where a plugin is installed
 */
export type PluginScope = 'user' | 'project';

/**
 * Information about an installed plugin
 */
export interface InstalledPluginInfo {
  /** Raw plugin spec as written in workspace.yaml */
  spec: string;
  /** Effective spec used internally for list identity and client lookup */
  effectiveSpec: string;
  /** Plugin name */
  name: string;
  /** Marketplace name */
  marketplace: string;
  /** Installation scope */
  scope: PluginScope;
}

/**
 * Convert a plugin source string to InstalledPluginInfo.
 * Handles plugin@marketplace, GitHub URLs, and local paths.
 */
function pluginSourceToInfo(
  pluginEntry: PluginEntry,
  scope: PluginScope,
): InstalledPluginInfo {
  const spec = getPluginSource(pluginEntry);
  const effectiveSpec = getEffectivePluginSource(pluginEntry);
  const parsed = isPluginSpec(spec) ? parsePluginSpec(spec) : null;
  if (parsed) {
    return {
      spec,
      effectiveSpec,
      name: parsed.plugin,
      marketplace: parsed.marketplaceName,
      scope,
    };
  }

  return {
    spec,
    effectiveSpec,
    name: getPluginDisplayName(spec),
    marketplace: '',
    scope,
  };
}

/**
 * Get all installed plugins from user workspace config.
 */
export async function getInstalledUserPlugins(): Promise<
  InstalledPluginInfo[]
> {
  const config = await getUserWorkspaceConfig();
  if (!config) return [];

  const result: InstalledPluginInfo[] = [];
  for (const pluginEntry of config.plugins) {
    result.push(pluginSourceToInfo(pluginEntry, 'user'));
  }
  return result;
}

/**
 * Get all installed plugins from project workspace config.
 */
export async function getInstalledProjectPlugins(
  workspacePath: string,
): Promise<InstalledPluginInfo[]> {
  // When cwd is the user's home directory, the project config resolves to the
  // same file as the user config — skip to avoid listing plugins twice.
  if (isUserConfigPath(workspacePath)) return [];

  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  if (!existsSync(configPath)) return [];

  try {
    const content = await readFile(configPath, 'utf-8');
    const config = loadYaml(content) as WorkspaceConfig;

    const result: InstalledPluginInfo[] = [];
    for (const pluginEntry of config.plugins) {
      result.push(pluginSourceToInfo(pluginEntry, 'project'));
    }
    return result;
  } catch {
    return [];
  }
}

// MIGRATION: v1→v2 skill schema. Remove this block after v3 is released.
/**
 * Migrate the user workspace config (~/.allagents/workspace.yaml) from v1 skill
 * schema to v2.
 *
 * v1: top-level `enabledSkills`/`disabledSkills` arrays of "pluginName:skillName" strings.
 * v2: per-plugin `skills` field (allowlist array or `{ exclude: [...] }` blocklist).
 *
 * Idempotent: if `version >= 2`, returns immediately without touching the file.
 * Also upgrades configs that have neither field (first-time users) by setting version:2.
 */
export async function migrateUserWorkspaceSkillsV1toV2(): Promise<void> {
  const configPath = getUserWorkspaceConfigPath();
  if (!existsSync(configPath)) return;

  const config = await parseUserWorkspaceConfigForEdit(configPath);

  if (!config || (config.version !== undefined && config.version >= 2)) return;

  const enabledSkills: string[] = config.enabledSkills ?? [];
  const disabledSkills: string[] = config.disabledSkills ?? [];

  const enabledByPlugin = new Map<string, string[]>();
  for (const skillKey of enabledSkills) {
    const colonIdx = skillKey.indexOf(':');
    if (colonIdx === -1) continue;
    const pluginName = skillKey.slice(0, colonIdx);
    const skillName = skillKey.slice(colonIdx + 1);
    const list = enabledByPlugin.get(pluginName) ?? [];
    list.push(skillName);
    enabledByPlugin.set(pluginName, list);
  }

  const disabledByPlugin = new Map<string, string[]>();
  for (const skillKey of disabledSkills) {
    const colonIdx = skillKey.indexOf(':');
    if (colonIdx === -1) continue;
    const pluginName = skillKey.slice(0, colonIdx);
    const skillName = skillKey.slice(colonIdx + 1);
    const list = disabledByPlugin.get(pluginName) ?? [];
    list.push(skillName);
    disabledByPlugin.set(pluginName, list);
  }

  for (const [pluginName, skillNames] of enabledByPlugin) {
    const index = findPluginEntryByName(config, pluginName);
    if (index === -1) {
      console.warn(
        `[migrate v1→v2] No user plugin found for '${pluginName}', skipping`,
      );
      continue;
    }
    const entry = ensureObjectPluginEntry(config, index);
    entry.skills = skillNames;
  }

  for (const [pluginName, skillNames] of disabledByPlugin) {
    const index = findPluginEntryByName(config, pluginName);
    if (index === -1) {
      console.warn(
        `[migrate v1→v2] No user plugin found for '${pluginName}', skipping`,
      );
      continue;
    }
    const entry = ensureObjectPluginEntry(config, index);
    if (!Array.isArray(entry.skills)) {
      entry.skills = { exclude: skillNames };
    }
  }

  config.enabledSkills = undefined;
  config.disabledSkills = undefined;
  config.version = 2;

  try {
    await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf-8');
  } catch (error) {
    console.warn(
      `[migrate v1→v2] Failed to write migrated user config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
