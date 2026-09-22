import { type Dirent, existsSync, lstatSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import {
  type PluginSkillsConfig,
  type WorkspaceConfig,
  getPluginSource,
} from '../models/workspace-config.js';
import { isGitHubUrl, parseGitHubUrl } from '../utils/plugin-path.js';
import { loadYaml } from '../utils/yaml.js';
import { parseSkillMetadata } from '../validators/skill.js';
import {
  isPluginSpec,
  resolvePluginSpecWithAutoRegister,
} from './marketplace.js';
import { fetchPlugin, getPluginName } from './plugin.js';

/**
 * Information about a skill from an installed plugin
 */
export interface SkillInfo {
  /** Skill folder name */
  name: string;
  /** Plugin name this skill belongs to */
  pluginName: string;
  /** Plugin source reference */
  pluginSource: string;
  /** Path to the skill directory */
  path: string;
  /** Whether the skill is disabled */
  disabled: boolean;
  /**
   * The inline skills mode for the plugin this skill belongs to.
   * 'allowlist' = plugin has `skills: [...]`, 'blocklist' = plugin has `skills: { exclude: [...] }`,
   * 'none' = no inline skills field (all skills enabled by default).
   */
  pluginSkillsMode: 'allowlist' | 'blocklist' | 'none';
  /**
   * Path from the scan root (a plugin's `skills/` dir, or the plugin root when
   * there is no `skills/`) to this skill's directory. For depth-1 skills this
   * is the same as `name`; for nested skills it includes parent segments
   * (e.g. `research/llm-wiki`). Used for disambiguation when multiple skills
   * share a leaf name.
   */
  skillSubpath: string;
}

export interface DiscoveredSkillEntry {
  name: string;
  /** Path from the scan root to the skill directory (POSIX-style separators). */
  subpath: string;
  skillPath: string;
}

/**
 * Result of resolving a plugin source
 */
interface ResolvedPlugin {
  path: string;
  /** Plugin name from marketplace manifest (overrides directory basename) */
  pluginName?: string | undefined;
}

/**
 * Resolve a plugin source to its local path and optional manifest-derived name
 */
async function resolvePluginPath(
  pluginSource: string,
  workspacePath: string,
): Promise<ResolvedPlugin | null> {
  if (isPluginSpec(pluginSource)) {
    const resolved = await resolvePluginSpecWithAutoRegister(pluginSource, {
      offline: true,
      workspacePath,
    });
    if (!resolved.success || !resolved.path) return null;
    return {
      path: resolved.path,
      pluginName: resolved.pluginName,
    };
  }

  if (isGitHubUrl(pluginSource)) {
    const parsed = parseGitHubUrl(pluginSource);
    const result = await fetchPlugin(pluginSource, {
      offline: true,
      ...(parsed?.branch && { branch: parsed.branch }),
    });
    if (!result.success) return null;
    const path = parsed?.subpath
      ? join(result.cachePath, parsed.subpath)
      : result.cachePath;
    return existsSync(path) ? { path } : null;
  }

  // Local path
  const resolved = resolve(workspacePath, pluginSource);
  return existsSync(resolved) ? { path: resolved } : null;
}

export async function discoverNestedSkillEntries(
  scanRoot: string,
  warnings: string[] = [],
): Promise<DiscoveredSkillEntry[]> {
  return walkForSkillMd(scanRoot, scanRoot, warnings);
}

/** Discover all skills owned by a resolved plugin root. */
export async function discoverSkillEntriesFromPluginRoot(
  pluginPath: string,
  warnings: string[] = [],
): Promise<DiscoveredSkillEntry[]> {
  const skillsDir = join(pluginPath, 'skills');
  if (existsSync(skillsDir)) {
    return discoverNestedSkillEntries(skillsDir, warnings);
  }

  const nestedSkills = await discoverNestedSkillEntries(pluginPath, warnings);
  if (nestedSkills.length > 0) return nestedSkills;

  const rootSkillMd = join(pluginPath, 'SKILL.md');
  if (!existsSync(rootSkillMd)) return [];
  const skillContent = await readFile(rootSkillMd, 'utf-8');
  const metadata = parseSkillMetadata(skillContent);
  const skillName = metadata?.name ?? basename(pluginPath);
  return [{ name: skillName, subpath: skillName, skillPath: pluginPath }];
}

async function walkForSkillMd(
  scanRoot: string,
  currentDir: string,
  warnings: string[],
): Promise<DiscoveredSkillEntry[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(currentDir, { withFileTypes: true });
  } catch (err) {
    const code =
      err && typeof err === 'object' && 'code' in err
        ? String((err as NodeJS.ErrnoException).code)
        : undefined;
    warnings.push(
      `Could not read '${currentDir}'${code ? ` (${code})` : ''} while scanning for skills. If this path looks unexpected (e.g. rooted near a drive root), check ~/.allagents/workspace.yaml for a stale plugin path, or rename ~/.allagents to ~/.allagents.bak and reinstall your plugins to reset it.`,
    );
    return [];
  }
  const discovered: DiscoveredSkillEntry[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillPath = join(currentDir, entry.name);

    // Skip symlinks/junctions to avoid unbounded recursion through loops.
    try {
      if (lstatSync(skillPath).isSymbolicLink()) continue;
    } catch {
      continue;
    }

    if (existsSync(join(skillPath, 'SKILL.md'))) {
      const subpath = relative(scanRoot, skillPath).split(/[\\/]/).join('/');
      discovered.push({ name: entry.name, subpath, skillPath });
      continue;
    }

    discovered.push(...(await walkForSkillMd(scanRoot, skillPath, warnings)));
  }

  return discovered;
}

/**
 * Get all skills from all installed plugins
 * @param workspacePath - Path to workspace directory
 * @returns Array of skill information
 */
export async function getAllSkillsFromPlugins(
  workspacePath: string = process.cwd(),
): Promise<SkillInfo[]> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);

  if (!existsSync(configPath)) {
    return [];
  }

  const content = await readFile(configPath, 'utf-8');
  const config = loadYaml(content) as WorkspaceConfig;

  // v1 fallback: use top-level disabledSkills/enabledSkills only for configs that haven't migrated
  const isV1Fallback = config.version === undefined || config.version < 2;
  const disabledSkills = isV1Fallback
    ? new Set(config.disabledSkills ?? [])
    : new Set<string>();
  const enabledSkills =
    isV1Fallback && config.enabledSkills ? new Set(config.enabledSkills) : null;

  const skills: SkillInfo[] = [];

  // `plugins` is optional in hand-written and profile-only configs; the schema
  // defaults it to [], but this reader consumes the raw YAML.
  for (const pluginEntry of config.plugins ?? []) {
    const pluginSource = getPluginSource(pluginEntry);
    const resolved = await resolvePluginPath(pluginSource, workspacePath);
    if (!resolved) continue;

    const pluginPath = resolved.path;
    const pluginName = resolved.pluginName ?? getPluginName(pluginPath);
    // Inline plugin-level skills config (v2+); undefined = all enabled (or use v1 fallback below)
    const pluginSkillsConfig: PluginSkillsConfig | undefined =
      typeof pluginEntry === 'string' ? undefined : pluginEntry.skills;

    // v1 fallback: only apply enabledSkills to plugins with entries in the set
    const hasEnabledEntries =
      !pluginSkillsConfig &&
      enabledSkills &&
      [...enabledSkills].some((s) => s.startsWith(`${pluginName}`));

    const skillEntries = await discoverSkillEntriesFromPluginRoot(pluginPath);

    const pluginSkillsMode: SkillInfo['pluginSkillsMode'] =
      pluginSkillsConfig === undefined
        ? 'none'
        : Array.isArray(pluginSkillsConfig)
          ? 'allowlist'
          : 'blocklist';

    for (const { name, subpath, skillPath } of skillEntries) {
      const skillKey = `${pluginName}:${name}`;
      const qualifiedKey = `${pluginName}:${subpath}`;
      let isDisabled: boolean;

      if (pluginSkillsConfig !== undefined) {
        // Inline skills config takes priority (v2+). Allow either bare leaf
        // name (`llm-wiki`) or qualified subpath (`research/llm-wiki`) so
        // users can disambiguate when multiple skills share a leaf name.
        if (Array.isArray(pluginSkillsConfig)) {
          isDisabled =
            !pluginSkillsConfig.includes(name) &&
            !pluginSkillsConfig.includes(subpath);
        } else {
          isDisabled =
            pluginSkillsConfig.exclude.includes(name) ||
            pluginSkillsConfig.exclude.includes(subpath);
        }
      } else if (isV1Fallback) {
        // v1 fallback: top-level disabledSkills/enabledSkills
        isDisabled = hasEnabledEntries
          ? !(enabledSkills?.has(skillKey) || enabledSkills?.has(qualifiedKey))
          : disabledSkills.has(skillKey) || disabledSkills.has(qualifiedKey);
      } else {
        isDisabled = false;
      }

      skills.push({
        name,
        pluginName,
        pluginSource,
        path: skillPath,
        disabled: isDisabled,
        pluginSkillsMode,
        skillSubpath: subpath,
      });
    }
  }

  return skills;
}

/**
 * Find a skill by name across all plugins
 * @param skillName - The skill name to find
 * @param workspacePath - Path to workspace directory
 * @returns Matching skills (may be multiple if name exists in multiple plugins)
 */
export async function findSkillByName(
  skillName: string,
  workspacePath: string = process.cwd(),
): Promise<SkillInfo[]> {
  const allSkills = await getAllSkillsFromPlugins(workspacePath);
  return allSkills.filter((s) => s.name === skillName);
}

/**
 * Discover skill names from a plugin directory without workspace config.
 * Used for marketplace plugin preview — shows what skills a plugin provides.
 * @param pluginPath - Path to plugin directory
 * @returns Array of skill names
 */
export async function discoverSkillNames(
  pluginPath: string,
): Promise<string[]> {
  return (await discoverSkillEntries(pluginPath)).map((entry) => entry.name);
}

/**
 * Discover skill entries (name + subpath) from a plugin directory without
 * workspace config. Mirrors `discoverSkillNames` but exposes the qualified
 * path for disambiguation when nested skills share a leaf name.
 */
export async function discoverSkillEntries(
  pluginPath: string,
): Promise<DiscoveredSkillEntry[]> {
  if (!existsSync(pluginPath)) return [];

  const skillsDir = join(pluginPath, 'skills');
  if (existsSync(skillsDir)) {
    return discoverNestedSkillEntries(skillsDir);
  }

  const nestedSkills = await discoverNestedSkillEntries(pluginPath);
  if (nestedSkills.length > 0) return nestedSkills;

  const rootSkillMd = join(pluginPath, 'SKILL.md');
  if (existsSync(rootSkillMd)) {
    let name = basename(pluginPath);
    try {
      const content = await readFile(rootSkillMd, 'utf-8');
      const metadata = parseSkillMetadata(content);
      if (metadata?.name) name = metadata.name;
    } catch {
      // Fall through to basename
    }
    return [{ name, subpath: name, skillPath: pluginPath }];
  }

  return [];
}
