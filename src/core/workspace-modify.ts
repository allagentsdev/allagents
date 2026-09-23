import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { dump } from 'js-yaml';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import type {
  ClientEntry,
  ClientType,
  PluginEntry,
  Repository,
  WorkspaceConfig,
} from '../models/workspace-config.js';
import { getClientTypes, getPluginSource } from '../models/workspace-config.js';
import { parseMarketplaceManifest } from '../utils/marketplace-manifest-parser.js';
import {
  parseWorkspaceConfigForEdit,
  validateProjectWorkspaceConfig,
  validateUserWorkspaceConfig,
} from '../utils/workspace-parser.js';
import {
  isFilesystemRoot,
  isGitHubUrl,
  parseGitHubUrl,
  validatePluginSource,
  verifyGitHubUrlExists,
} from '../utils/plugin-path.js';
import {
  getMarketplace,
  getMarketplaceAccessError,
  isPluginSpec,
  parsePluginSpec,
  resolvePluginSpecWithAutoRegister,
} from './marketplace.js';

/**
 * Default clients for auto-created project workspace.yaml.
 * Matches the template at src/templates/default/.allagents/workspace.yaml.
 */
const DEFAULT_PROJECT_CLIENTS: ClientEntry[] = ['universal'];

/**
 * Result of add/remove operations
 */
export interface ModifyResult {
  success: boolean;
  error?: string;
  autoRegistered?: string; // marketplace name if auto-registered
  normalizedPlugin?: string; // plugin spec after normalization (e.g., plugin@manifest-name)
  replaced?: boolean; // true if an existing plugin declaration was replaced
}

export interface PluginInstallTarget {
  declaration: PluginEntry;
  clients: readonly ClientType[];
  /**
   * `declaration` preserves the established native-only path whose source is
   * consumed by a client package manager rather than resolved on disk.
   */
  sourceValidation?: 'standard' | 'declaration';
}

export interface TargetedPluginWriteDependencies {
  beforeRename?(
    temporaryPath: string,
    configPath: string,
  ): void | Promise<void>;
}

export type MarketplacePluginDeclarationResolution =
  | {
      success: true;
      declaration: PluginEntry;
      registeredAs?: string;
    }
  | {
      success: false;
      error: string;
    };

/**
 * Resolve a marketplace plugin declaration through the canonical registration
 * flow and preserve every declaration field while replacing only its source.
 */
export async function resolveMarketplacePluginDeclaration(
  declaration: PluginEntry,
  workspacePath?: string,
): Promise<MarketplacePluginDeclarationResolution> {
  const source = getPluginSource(declaration);
  const resolved = await resolvePluginSpecWithAutoRegister(source, {
    ...(workspacePath && { workspacePath }),
  });
  if (!resolved.success) {
    return {
      success: false,
      error: resolved.error || 'Unknown error',
    };
  }

  const normalizedSource = resolved.registeredAs
    ? source.replace(/@[^@]+$/, `@${resolved.registeredAs}`)
    : source;
  return {
    success: true,
    declaration:
      typeof declaration === 'string'
        ? normalizedSource
        : { ...declaration, source: normalizedSource },
    ...(resolved.registeredAs && { registeredAs: resolved.registeredAs }),
  };
}

export async function writeWorkspaceConfigAtomically(
  configPath: string,
  config: WorkspaceConfig,
  scope: 'project' | 'user',
  dependencies: TargetedPluginWriteDependencies = {},
): Promise<void> {
  if (scope === 'project') {
    validateProjectWorkspaceConfig(config, configPath);
  } else {
    validateUserWorkspaceConfig(config, configPath);
  }

  const directory = dirname(configPath);
  let mode: number | undefined;
  try {
    mode = (await stat(configPath)).mode;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const temporaryPath = join(
    directory,
    `.${basename(configPath)}.${randomUUID()}.tmp`,
  );
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, dump(config, { lineWidth: -1 }), {
      encoding: 'utf-8',
      flag: 'wx',
      ...(mode !== undefined && { mode }),
    });
    if (mode !== undefined) await chmod(temporaryPath, mode);
    await dependencies.beforeRename?.(temporaryPath, configPath);
    await rename(temporaryPath, configPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function sameClients(
  left: readonly ClientType[],
  right: readonly ClientType[],
): boolean {
  return (
    left.length === right.length &&
    left.every((client, index) => client === right[index])
  );
}

export function mergeTargetedPluginEntry(
  existing: PluginEntry | undefined,
  prospective: PluginEntry,
  normalizedSource: string,
  scopeClients: readonly ClientEntry[],
): PluginEntry {
  const existingObject =
    existing && typeof existing !== 'string' ? existing : undefined;
  const prospectiveObject =
    typeof prospective !== 'string' ? prospective : undefined;
  const merged = {
    ...(existingObject ?? {}),
    ...(prospectiveObject ?? {}),
    source: normalizedSource,
  };

  if (
    prospectiveObject?.clients !== undefined &&
    !sameClients(prospectiveObject.clients, getClientTypes([...scopeClients]))
  ) {
    return merged;
  }

  const { clients: _clients, ...inherited } = merged;
  return Object.keys(inherited).length === 1 ? normalizedSource : inherited;
}

/**
 * Update the clients list in .allagents/workspace.yaml
 * @param clients - New list of client types
 * @param workspacePath - Path to workspace directory (default: cwd)
 */
export async function setClients(
  clients: ClientEntry[],
  workspacePath: string = process.cwd(),
): Promise<ModifyResult> {
  try {
    await ensureWorkspace(workspacePath);
    const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
    const config = await parseWorkspaceConfigForEdit(configPath);
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

/**
 * Ensure .allagents/workspace.yaml exists with default config.
 * Creates it if missing, does not overwrite existing.
 */
export async function ensureWorkspace(
  workspacePath: string,
  clients?: ClientEntry[],
): Promise<void> {
  const configDir = join(workspacePath, CONFIG_DIR);
  const configPath = join(configDir, WORKSPACE_CONFIG_FILE);
  if (existsSync(configPath)) return;

  const defaultConfig: WorkspaceConfig = {
    repositories: [],
    plugins: [],
    clients: clients ?? [...DEFAULT_PROJECT_CLIENTS],
  };

  await mkdir(configDir, { recursive: true });
  await writeFile(configPath, dump(defaultConfig, { lineWidth: -1 }), 'utf-8');
}

/**
 * Add a plugin to .allagents/workspace.yaml
 * Supports three formats:
 * 1. plugin@marketplace (e.g., "code-review@claude-plugins-official")
 * 2. GitHub URL (e.g., "https://github.com/owner/repo")
 * 3. Local path (e.g., "./my-plugin")
 *
 * For plugin@marketplace format, will auto-register the marketplace if:
 * - It's a well-known name (e.g., "claude-plugins-official")
 * - It's in owner/repo format (e.g., "plugin@obra/superpowers")
 *
 * @param plugin - Plugin source
 * @param workspacePath - Path to workspace directory (default: cwd)
 * @param force - If true, replace existing plugin with same source
 * @returns Result with success status
 */
export async function addPlugin(
  plugin: string,
  workspacePath: string = process.cwd(),
  force?: boolean,
): Promise<ModifyResult> {
  return addValidatedPlugin(plugin, workspacePath, force);
}

/**
 * Validate and normalize a prospective declaration, then upsert it for a
 * resolved install target. The selected clients initialize a missing config;
 * existing top-level clients are never changed.
 */
export async function addPluginForTarget(
  target: PluginInstallTarget,
  workspacePath: string = process.cwd(),
  dependencies: TargetedPluginWriteDependencies = {},
): Promise<ModifyResult> {
  return addValidatedPlugin(
    target.declaration,
    workspacePath,
    true,
    target.clients,
    target.sourceValidation,
    dependencies,
  );
}

async function addValidatedPlugin(
  declaration: PluginEntry,
  workspacePath: string,
  force?: boolean,
  initialClients?: readonly ClientType[],
  sourceValidation: 'standard' | 'declaration' = 'standard',
  dependencies?: TargetedPluginWriteDependencies,
): Promise<ModifyResult> {
  const plugin = getPluginSource(declaration);
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  const initialConfig =
    dependencies !== undefined && !existsSync(configPath)
      ? {
          repositories: [],
          plugins: [],
          clients: initialClients
            ? [...initialClients]
            : [...DEFAULT_PROJECT_CLIENTS],
        }
      : undefined;
  if (dependencies === undefined) await ensureWorkspace(workspacePath);

  if (sourceValidation === 'declaration') {
    return addPluginToConfig(
      declaration,
      configPath,
      undefined,
      force,
      dependencies,
      initialConfig,
    );
  }

  if (isPluginSpec(plugin)) {
    const resolved = await resolveMarketplacePluginDeclaration(
      declaration,
      workspacePath,
    );
    if (!resolved.success) {
      return resolved;
    }
    return addPluginToConfig(
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
    const fullPath = join(workspacePath, plugin);
    if (!existsSync(fullPath) && !existsSync(plugin)) {
      return {
        success: false,
        error: `Plugin not found at ${plugin}`,
      };
    }
    if (isFilesystemRoot(fullPath) || isFilesystemRoot(plugin)) {
      return {
        success: false,
        error: `Plugin source cannot be a filesystem root directory: ${plugin}`,
      };
    }
  }

  return addPluginToConfig(
    declaration,
    configPath,
    undefined,
    force,
    dependencies,
    initialConfig,
  );
}

export async function addPluginDeclaration(
  plugin: string,
  workspacePath: string = process.cwd(),
  force?: boolean,
): Promise<ModifyResult> {
  await ensureWorkspace(workspacePath);
  return addPluginToConfig(
    plugin,
    join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
    undefined,
    force,
  );
}

/**
 * Add plugin to .allagents/workspace.yaml config file
 */
async function addPluginToConfig(
  plugin: PluginEntry,
  configPath: string,
  autoRegistered?: string,
  force?: boolean,
  targetedDependencies?: TargetedPluginWriteDependencies,
  initialConfig?: WorkspaceConfig,
): Promise<ModifyResult> {
  try {
    const config =
      initialConfig ?? (await parseWorkspaceConfigForEdit(configPath));
    const source = getPluginSource(plugin);
    const exactIndex = config.plugins.findIndex(
      (entry) => getPluginSource(entry) === source,
    );
    if (exactIndex !== -1 && !force) {
      return {
        success: false,
        error: `Plugin already exists in .allagents/workspace.yaml: ${source}`,
      };
    }

    let semanticIndex = -1;
    if (targetedDependencies !== undefined || !force) {
      const newIdentity = await resolveGitHubIdentity(source);
      if (newIdentity) {
        for (let i = 0; i < config.plugins.length; i++) {
          if (i === exactIndex) continue;
          const existing = config.plugins[i];
          if (!existing) continue;
          const existingSource = getPluginSource(existing);
          const existingIdentity = await resolveGitHubIdentity(existingSource);
          if (existingIdentity !== newIdentity) continue;
          if (!force) {
            return {
              success: false,
              error: `Plugin duplicates existing entry '${existingSource}': both resolve to ${newIdentity}`,
            };
          }
          semanticIndex = i;
          break;
        }
      }
    }

    const replaceIndex =
      targetedDependencies !== undefined
        ? exactIndex !== -1
          ? exactIndex
          : semanticIndex
        : exactIndex;
    const wasReplaced = force && replaceIndex !== -1;
    if (targetedDependencies !== undefined) {
      const nextEntry = mergeTargetedPluginEntry(
        replaceIndex === -1 ? undefined : config.plugins[replaceIndex],
        plugin,
        source,
        config.clients,
      );
      if (replaceIndex === -1) config.plugins.push(nextEntry);
      else config.plugins[replaceIndex] = nextEntry;
      await writeWorkspaceConfigAtomically(
        configPath,
        config,
        'project',
        targetedDependencies,
      );
    } else {
      if (wasReplaced) config.plugins.splice(replaceIndex, 1);
      config.plugins.push(plugin);
      await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf-8');
    }

    const result: ModifyResult = {
      success: true,
      normalizedPlugin: source,
    };
    if (autoRegistered) result.autoRegistered = autoRegistered;
    if (wasReplaced) result.replaced = true;
    return result;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Check if a plugin exists in .allagents/workspace.yaml (project scope)
 * @param plugin - Plugin source to find (exact match or partial match)
 * @param workspacePath - Path to workspace directory (default: cwd)
 * @returns true if the plugin is found
 */
export async function hasPlugin(
  plugin: string,
  workspacePath: string = process.cwd(),
): Promise<boolean> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  if (!existsSync(configPath)) return false;

  try {
    const config = await parseWorkspaceConfigForEdit(configPath);

    // Exact match first
    if (config.plugins.some((entry) => getPluginSource(entry) === plugin))
      return true;

    // Partial match
    if (!isPluginSpec(plugin)) {
      return config.plugins.some((entry) => {
        const source = getPluginSource(entry);
        return source.startsWith(`${plugin}@`) || source === plugin;
      });
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Remove a plugin from .allagents/workspace.yaml
 * @param plugin - Plugin source to remove (exact match or partial match)
 * @param workspacePath - Path to workspace directory (default: cwd)
 * @returns Result with success status
 */
export async function removePlugin(
  plugin: string,
  workspacePath: string = process.cwd(),
): Promise<ModifyResult> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);

  // Check if .allagents/workspace.yaml exists
  if (!existsSync(configPath)) {
    return {
      success: false,
      error: `${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE} not found in ${workspacePath}\n  Run 'allagents workspace init <path>' to create a new workspace`,
    };
  }

  try {
    // Read current config
    const config = await parseWorkspaceConfigForEdit(configPath);

    // Find plugin - exact match first
    let index = config.plugins.findIndex(
      (entry) => getPluginSource(entry) === plugin,
    );

    // If not found, try partial match (e.g., "code-review" matches "code-review@claude-plugins-official")
    if (index === -1 && isPluginSpec(plugin) === false) {
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
        error: `Plugin not found in .allagents/workspace.yaml: ${plugin}`,
      };
    }

    // Remove plugin and clean up its disabled skills
    const removedEntry = getPluginSource(config.plugins[index] as PluginEntry);
    config.plugins.splice(index, 1);
    pruneDisabledSkillsForPlugin(config, removedEntry);
    pruneEnabledSkillsForPlugin(config, removedEntry);

    // Write back
    const newContent = dump(config, { lineWidth: -1 });
    await writeFile(configPath, newContent, 'utf-8');

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Remove disabledSkills entries whose plugin name matches the removed plugin entry.
 * Exported for reuse by user-workspace.ts.
 */
export function pruneDisabledSkillsForPlugin(
  config: WorkspaceConfig,
  pluginEntry: string,
): void {
  if (!config.disabledSkills?.length) return;

  const names = extractPluginNames(pluginEntry);
  if (names.length === 0) return;

  const prefixes = names.map((n) => `${n}:`);
  config.disabledSkills = config.disabledSkills.filter(
    (s) => !prefixes.some((p) => s.startsWith(p)),
  );
  if (config.disabledSkills.length === 0) {
    config.disabledSkills = undefined;
  }
}

/**
 * Extract possible plugin names from a plugin source string.
 * Returns all candidate names that might be used as the plugin name prefix
 * in skill keys (e.g., "pluginName:" in "pluginName:skillName").
 *
 * For plugin specs (plugin@marketplace), skill keys may use either the
 * plugin component or the marketplace name (when the marketplace root
 * IS the plugin directory).
 *
 * Exported for reuse by user-workspace.ts.
 */
export function extractPluginNames(pluginSource: string): string[] {
  if (isPluginSpec(pluginSource)) {
    const parsed = parsePluginSpec(pluginSource);
    if (!parsed) return [];
    const names = [parsed.plugin];
    if (parsed.marketplaceName && parsed.marketplaceName !== parsed.plugin) {
      names.push(parsed.marketplaceName);
    }
    return names;
  }
  // For GitHub URLs, include both repo name and {owner}-{repo} (cache directory) format
  if (isGitHubUrl(pluginSource)) {
    const parsed = parseGitHubUrl(pluginSource);
    if (parsed) {
      const names: string[] = [];
      const ownerRepo = `${parsed.owner}-${parsed.repo}`;
      if (ownerRepo !== parsed.repo) names.push(ownerRepo);
      if (parsed.subpath) {
        const subpathName = parsed.subpath.split('/').filter(Boolean).pop();
        if (subpathName && !names.includes(subpathName))
          names.push(subpathName);
      }
      if (!names.includes(parsed.repo)) names.push(parsed.repo);
      if (!names.includes(ownerRepo)) names.push(ownerRepo);
      return names;
    }
  }
  // Split on both / and \ to handle local paths, URLs, and Windows paths
  const parts = pluginSource.split(/[/\\]/).filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return [];
  return [last.replace(/\.git$/, '')];
}

/**
 * Find the index of a plugin entry whose candidate names include pluginName.
 * Exported for reuse by user-workspace.ts.
 */
export function findPluginEntryByName(
  config: WorkspaceConfig,
  pluginName: string,
): number {
  return config.plugins.findIndex((entry) =>
    extractPluginNames(getPluginSource(entry)).includes(pluginName),
  );
}

/**
 * Ensure the plugin entry at config.plugins[index] is in object form.
 * Converts a string shorthand to { source } if needed and returns the mutable object.
 * Exported for reuse by user-workspace.ts.
 */
export function ensureObjectPluginEntry(
  config: WorkspaceConfig,
  index: number,
): Exclude<PluginEntry, string> {
  const entry = config.plugins[index];
  if (entry === undefined)
    throw new Error(`Plugin entry at index ${index} not found`);
  if (typeof entry === 'string') {
    const objectEntry: Exclude<PluginEntry, string> = { source: entry };
    config.plugins[index] = objectEntry;
    return objectEntry;
  }
  return entry;
}

function uniqueSkillNames(skillNames: string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();

  for (const skillName of skillNames) {
    if (seen.has(skillName)) continue;
    seen.add(skillName);
    unique.push(skillName);
  }

  return unique;
}

function formatGitHubSource(
  parsed: { owner: string; repo: string; branch?: string; subpath?: string },
  styleSource: string,
): string {
  const basePath = `${parsed.owner}/${parsed.repo}`;

  if (
    styleSource.startsWith('http://') ||
    styleSource.startsWith('https://') ||
    styleSource.startsWith('github.com/')
  ) {
    const baseUrl = `https://github.com/${basePath}`;
    if (!parsed.branch) return baseUrl;
    return parsed.subpath
      ? `${baseUrl}/tree/${parsed.branch}/${parsed.subpath}`
      : `${baseUrl}/tree/${parsed.branch}`;
  }

  if (!parsed.branch) {
    return parsed.subpath ? `${basePath}/${parsed.subpath}` : basePath;
  }

  return parsed.subpath
    ? `${basePath}@${parsed.branch}/${parsed.subpath}`
    : `${basePath}@${parsed.branch}`;
}

export function canonicalizeGitHubPluginSource(
  currentSource: string,
  nextSource: string,
): string {
  const current = parseGitHubUrl(currentSource);
  const next = parseGitHubUrl(nextSource);

  if (!current || !next) return nextSource;
  if (
    current.owner.toLowerCase() !== next.owner.toLowerCase() ||
    current.repo.toLowerCase() !== next.repo.toLowerCase()
  ) {
    return nextSource;
  }

  if (current.branch && next.branch && current.branch !== next.branch) {
    return currentSource;
  }

  const currentParts = current.subpath?.split('/').filter(Boolean) ?? [];
  const nextParts = next.subpath?.split('/').filter(Boolean) ?? [];
  const sharedParts: string[] = [];
  const sharedLength = Math.min(currentParts.length, nextParts.length);

  for (let i = 0; i < sharedLength; i++) {
    if (currentParts[i] !== nextParts[i]) break;
    sharedParts.push(currentParts[i] as string);
  }

  return formatGitHubSource(
    {
      owner: current.owner,
      repo: current.repo,
      ...(current.branch || next.branch
        ? { branch: current.branch ?? next.branch }
        : {}),
      ...(sharedParts.length > 0 ? { subpath: sharedParts.join('/') } : {}),
    },
    currentSource,
  );
}

async function findPluginEntryByGitHubIdentity(
  config: WorkspaceConfig,
  source: string,
): Promise<number> {
  const identity = await resolveGitHubIdentity(source);
  if (!identity) return -1;

  for (let i = 0; i < config.plugins.length; i++) {
    const entry = config.plugins[i];
    if (!entry) continue;
    const existingIdentity = await resolveGitHubIdentity(
      getPluginSource(entry),
    );
    if (existingIdentity === identity) return i;
  }

  return -1;
}

export async function upsertGitHubPluginSourceAllowlistInConfig(
  config: WorkspaceConfig,
  source: string,
  skillNames: string[],
): Promise<ModifyResult> {
  const normalizedSkills = uniqueSkillNames(skillNames);
  const exactIndex = config.plugins.findIndex(
    (entry) => getPluginSource(entry) === source,
  );

  if (exactIndex !== -1) {
    const entry = ensureObjectPluginEntry(config, exactIndex);
    entry.source = source;
    entry.skills = normalizedSkills;
    return { success: true, normalizedPlugin: source };
  }

  const semanticIndex = await findPluginEntryByGitHubIdentity(config, source);
  if (semanticIndex === -1) {
    config.plugins.push({ source, skills: normalizedSkills });
    return { success: true, normalizedPlugin: source };
  }

  const entry = ensureObjectPluginEntry(config, semanticIndex);
  const normalizedSource = canonicalizeGitHubPluginSource(entry.source, source);
  entry.source = normalizedSource;
  entry.skills = normalizedSkills;
  return { success: true, normalizedPlugin: normalizedSource };
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
 * Get disabled skills from workspace config.
 * Reads from inline plugin entry `skills.exclude` arrays (blocklist mode).
 * Also includes legacy top-level `disabledSkills` for backward compatibility.
 * @param workspacePath - Path to workspace directory (default: cwd)
 * @returns Array of disabled skill keys (plugin:skill format)
 */
export async function getDisabledSkills(
  workspacePath: string = process.cwd(),
): Promise<string[]> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  if (!existsSync(configPath)) return [];

  try {
    const config = await parseWorkspaceConfigForEdit(configPath);
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
  } catch {
    return [];
  }
}

/**
 * Add a skill to the plugin entry's `skills.exclude` list (blocklist mode).
 * Converts a string shorthand plugin entry to object form if needed.
 * @param skillKey - Skill key in plugin:skill format
 * @param workspacePath - Path to workspace directory (default: cwd)
 */
export async function addDisabledSkill(
  skillKey: string,
  workspacePath: string = process.cwd(),
): Promise<ModifyResult> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);

  if (!existsSync(configPath)) {
    return {
      success: false,
      error: `${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE} not found in ${workspacePath}`,
    };
  }

  const parsed = parseSkillKey(skillKey);
  if (!parsed) {
    return {
      success: false,
      error: `Invalid skill key format: '${skillKey}' (expected pluginName:skillName)`,
    };
  }
  const { pluginName, skillName } = parsed;

  try {
    const config = await parseWorkspaceConfigForEdit(configPath);

    const index = findPluginEntryByName(config, pluginName);
    if (index === -1) {
      return {
        success: false,
        error: `Plugin '${pluginName}' not found in workspace config`,
      };
    }

    const entry = ensureObjectPluginEntry(config, index);

    if (Array.isArray(entry.skills)) {
      return {
        success: false,
        error: `Plugin '${pluginName}' is in allowlist mode; use removeEnabledSkill to disable a skill`,
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
 * Remove a skill from the plugin entry's `skills.exclude` list (blocklist mode).
 * @param skillKey - Skill key in plugin:skill format
 * @param workspacePath - Path to workspace directory (default: cwd)
 */
export async function removeDisabledSkill(
  skillKey: string,
  workspacePath: string = process.cwd(),
): Promise<ModifyResult> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);

  if (!existsSync(configPath)) {
    return {
      success: false,
      error: `${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE} not found in ${workspacePath}`,
    };
  }

  const parsed = parseSkillKey(skillKey);
  if (!parsed) {
    return {
      success: false,
      error: `Invalid skill key format: '${skillKey}' (expected pluginName:skillName)`,
    };
  }
  const { pluginName, skillName } = parsed;

  try {
    const config = await parseWorkspaceConfigForEdit(configPath);

    const index = findPluginEntryByName(config, pluginName);
    if (index === -1) {
      return {
        success: false,
        error: `Plugin '${pluginName}' not found in workspace config`,
      };
    }

    const entry = config.plugins[index];
    if (!entry) {
      return {
        success: false,
        error: `Plugin '${pluginName}' not found in workspace config`,
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
 * Get enabled skills from workspace config.
 * Reads from inline plugin entry `skills` arrays (allowlist mode).
 * Also includes legacy top-level `enabledSkills` for backward compatibility.
 * @param workspacePath - Path to workspace directory (default: cwd)
 */
export async function getEnabledSkills(
  workspacePath: string = process.cwd(),
): Promise<string[]> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  if (!existsSync(configPath)) return [];
  try {
    const config = await parseWorkspaceConfigForEdit(configPath);
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
  } catch {
    return [];
  }
}

/**
 * Add a skill to the plugin entry's `skills` allowlist.
 * Converts a string shorthand plugin entry to object form if needed.
 * @param skillKey - Skill key in plugin:skill format
 * @param workspacePath - Path to workspace directory (default: cwd)
 */
export async function addEnabledSkill(
  skillKey: string,
  workspacePath: string = process.cwd(),
): Promise<ModifyResult> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  if (!existsSync(configPath)) {
    return {
      success: false,
      error: `${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE} not found in ${workspacePath}`,
    };
  }

  const parsed = parseSkillKey(skillKey);
  if (!parsed) {
    return {
      success: false,
      error: `Invalid skill key format: '${skillKey}' (expected pluginName:skillName)`,
    };
  }
  const { pluginName, skillName } = parsed;

  try {
    const config = await parseWorkspaceConfigForEdit(configPath);

    const index = findPluginEntryByName(config, pluginName);
    if (index === -1) {
      return {
        success: false,
        error: `Plugin '${pluginName}' not found in workspace config`,
      };
    }

    const entry = ensureObjectPluginEntry(config, index);

    if (entry.skills && !Array.isArray(entry.skills)) {
      return {
        success: false,
        error: `Plugin '${pluginName}' is in blocklist mode; use removeDisabledSkill to enable a skill`,
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
 * Remove a skill from the plugin entry's `skills` allowlist.
 * @param skillKey - Skill key in plugin:skill format
 * @param workspacePath - Path to workspace directory (default: cwd)
 */
export async function removeEnabledSkill(
  skillKey: string,
  workspacePath: string = process.cwd(),
): Promise<ModifyResult> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  if (!existsSync(configPath)) {
    return {
      success: false,
      error: `${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE} not found in ${workspacePath}`,
    };
  }

  const parsed = parseSkillKey(skillKey);
  if (!parsed) {
    return {
      success: false,
      error: `Invalid skill key format: '${skillKey}' (expected pluginName:skillName)`,
    };
  }
  const { pluginName, skillName } = parsed;

  try {
    const config = await parseWorkspaceConfigForEdit(configPath);

    const index = findPluginEntryByName(config, pluginName);
    if (index === -1) {
      return {
        success: false,
        error: `Plugin '${pluginName}' not found in workspace config`,
      };
    }

    const entry = config.plugins[index];
    if (!entry) {
      return {
        success: false,
        error: `Plugin '${pluginName}' not found in workspace config`,
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
 * Set the skills mode for a plugin entry.
 * 'allowlist' sets `skills = [skillNames]` (only listed skills enabled; empty array = all disabled).
 * 'blocklist' sets `skills = { exclude: [skillNames] }` or `undefined` if empty (= all enabled).
 * @param pluginName - Plugin name to modify
 * @param mode - Target mode: 'allowlist' or 'blocklist'
 * @param skillNames - For allowlist: enabled skill names. For blocklist: disabled skill names.
 * @param workspacePath - Path to workspace directory (default: cwd)
 */
export async function setPluginSkillsMode(
  pluginName: string,
  mode: 'allowlist' | 'blocklist',
  skillNames: string[],
  workspacePath: string = process.cwd(),
): Promise<ModifyResult> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  if (!existsSync(configPath)) {
    return {
      success: false,
      error: `${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE} not found in ${workspacePath}`,
    };
  }

  try {
    const config = await parseWorkspaceConfigForEdit(configPath);

    const index = findPluginEntryByName(config, pluginName);
    if (index === -1) {
      return {
        success: false,
        error: `Plugin '${pluginName}' not found in workspace config`,
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

export async function upsertGitHubPluginSourceAllowlist(
  source: string,
  skillNames: string[],
  workspacePath: string = process.cwd(),
): Promise<ModifyResult> {
  await ensureWorkspace(workspacePath);
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  if (!existsSync(configPath)) {
    return {
      success: false,
      error: `${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE} not found in ${workspacePath}`,
    };
  }

  try {
    const config = await parseWorkspaceConfigForEdit(configPath);
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
 * Remove enabledSkills entries whose plugin name matches the removed plugin entry.
 * Exported for reuse by user-workspace.ts.
 */
export function pruneEnabledSkillsForPlugin(
  config: WorkspaceConfig,
  pluginEntry: string,
): void {
  if (!config.enabledSkills?.length) return;
  const names = extractPluginNames(pluginEntry);
  if (names.length === 0) return;
  const prefixes = names.map((n) => `${n}:`);
  config.enabledSkills = config.enabledSkills.filter(
    (s) => !prefixes.some((p) => s.startsWith(p)),
  );
  if (config.enabledSkills.length === 0) {
    config.enabledSkills = undefined;
  }
}

/**
 * Resolve a plugin source to its GitHub owner/repo identity, if it points to
 * a GitHub repo (directly or via a marketplace URL source). Returns null for
 * local-path plugins.
 */
export async function resolveGitHubIdentity(
  pluginSource: string,
): Promise<string | null> {
  if (isGitHubUrl(pluginSource)) {
    const parsed = parseGitHubUrl(pluginSource);
    return parsed ? `${parsed.owner}/${parsed.repo}`.toLowerCase() : null;
  }

  if (isPluginSpec(pluginSource)) {
    const parsed = parsePluginSpec(pluginSource);
    if (!parsed) return null;

    const marketplace = await getMarketplace(parsed.marketplaceName);
    if (!marketplace) return null;
    if (getMarketplaceAccessError(marketplace)) return null;

    const manifestResult = await parseMarketplaceManifest(marketplace.path);
    if (!manifestResult.success) return null;

    const entry = manifestResult.data.plugins.find(
      (p) => p.name === parsed.plugin,
    );
    if (!entry || typeof entry.source === 'string') return null;

    const parsedUrl = parseGitHubUrl(entry.source.url);
    return parsedUrl
      ? `${parsedUrl.owner}/${parsedUrl.repo}`.toLowerCase()
      : null;
  }

  return null;
}

// MIGRATION: v1→v2 skill schema. Remove this block after v3 is released.
/**
 * Migrate a project workspace config from v1 skill schema to v2.
 *
 * v1: top-level `enabledSkills`/`disabledSkills` arrays of "pluginName:skillName" strings.
 * v2: per-plugin `skills` field (allowlist array or `{ exclude: [...] }` blocklist).
 *
 * Idempotent: if `version >= 2`, returns immediately without touching the file.
 * Also upgrades configs that have neither field (first-time users) by setting version:2.
 */
export async function migrateWorkspaceSkillsV1toV2(
  workspacePath: string,
): Promise<void> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  if (!existsSync(configPath)) return;

  let config: WorkspaceConfig;
  try {
    config = await parseWorkspaceConfigForEdit(configPath);
  } catch {
    return;
  }

  if (!config || (config.version !== undefined && config.version >= 2)) return;

  const enabledSkills: string[] = config.enabledSkills ?? [];
  const disabledSkills: string[] = config.disabledSkills ?? [];

  // Group enabledSkills by pluginName
  const enabledByPlugin = new Map<string, string[]>();
  for (const skillKey of enabledSkills) {
    const parsed = parseSkillKey(skillKey);
    if (!parsed) continue;
    const list = enabledByPlugin.get(parsed.pluginName) ?? [];
    list.push(parsed.skillName);
    enabledByPlugin.set(parsed.pluginName, list);
  }

  // Group disabledSkills by pluginName
  const disabledByPlugin = new Map<string, string[]>();
  for (const skillKey of disabledSkills) {
    const parsed = parseSkillKey(skillKey);
    if (!parsed) continue;
    const list = disabledByPlugin.get(parsed.pluginName) ?? [];
    list.push(parsed.skillName);
    disabledByPlugin.set(parsed.pluginName, list);
  }

  // Apply enabledSkills → plugin entry allowlist
  for (const [pluginName, skillNames] of enabledByPlugin) {
    const index = findPluginEntryByName(config, pluginName);
    if (index === -1) {
      console.warn(
        `[migrate v1→v2] No plugin found for '${pluginName}', skipping`,
      );
      continue;
    }
    const entry = ensureObjectPluginEntry(config, index);
    entry.skills = skillNames;
  }

  // Apply disabledSkills → plugin entry blocklist
  for (const [pluginName, skillNames] of disabledByPlugin) {
    const index = findPluginEntryByName(config, pluginName);
    if (index === -1) {
      console.warn(
        `[migrate v1→v2] No plugin found for '${pluginName}', skipping`,
      );
      continue;
    }
    const entry = ensureObjectPluginEntry(config, index);
    // If an allowlist was already set from enabledSkills, prefer it (ignore disabled for same plugin)
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
      `[migrate v1→v2] Failed to write migrated config: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Update repositories in workspace.yaml: remove specified paths and add new entries.
 * Used by .code-workspace reconciliation to sync folder changes back.
 */
export async function updateRepositories(
  changes: { remove: string[]; add: Repository[] },
  workspacePath: string = process.cwd(),
): Promise<ModifyResult> {
  if (changes.remove.length === 0 && changes.add.length === 0) {
    return { success: true };
  }

  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);

  try {
    const config = await parseWorkspaceConfigForEdit(configPath);

    const removeSet = new Set(changes.remove);
    config.repositories = config.repositories.filter(
      (repo) => !removeSet.has(repo.path),
    );
    config.repositories.push(...changes.add);

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
 * Replace the repositories list in workspace.yaml.
 * Used when .code-workspace reconciliation updates metadata on existing entries.
 */
export async function setRepositories(
  repositories: Repository[],
  workspacePath: string = process.cwd(),
): Promise<ModifyResult> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);

  try {
    const config = await parseWorkspaceConfigForEdit(configPath);
    config.repositories = repositories;
    await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf-8');
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
