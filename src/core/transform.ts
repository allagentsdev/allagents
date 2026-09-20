import { existsSync, type Dirent } from 'node:fs';
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import matter from 'gray-matter';
import micromatch from 'micromatch';
import {
  type SkillsIndexRef,
  type WorkspaceRepository,
  generateWorkspaceRules,
} from '../constants.js';
import {
  CLIENT_MAPPINGS,
  isUniversalClient,
  resolveClientMappings,
  type ClientMapping,
  type ClientMappings,
} from '../models/client-mapping.js';
import type { MarketplaceFileArtifacts } from '../models/marketplace-manifest.js';
import type {
  ClientType,
  PluginSkillsConfig,
  SyncMode,
  WorkspaceFile,
} from '../models/workspace-config.js';
import { isGlobPattern, resolveGlobPatterns } from '../utils/glob-patterns.js';
import { adjustLinksInContent } from '../utils/link-adjuster.js';
import { parseFileSource } from '../utils/plugin-path.js';
import { createSymlink } from '../utils/symlink.js';
import { parseSkillMetadata } from '../validators/skill.js';
import { discoverNestedSkillEntries } from './skills.js';
import {
  assertSafeDestination,
  resolveMappedPath,
} from './client-context.js';

/**
 * Agent instruction files that receive WORKSPACE-RULES injection
 */
const AGENT_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;

/**
 * Ensure WORKSPACE-RULES exist in a file (creates file if needed)
 * - If file doesn't exist: creates it with just the rules
 * - If file exists without markers: appends rules
 * - If file exists with markers: replaces content between markers (idempotent)
 * @param filePath - Path to the agent file (CLAUDE.md or AGENTS.md)
 * @param repositories - Array of repositories to include in the rules (paths embedded directly)
 */
export async function ensureWorkspaceRules(
  filePath: string,
  repositories: WorkspaceRepository[],
  skillsIndexRefs: SkillsIndexRef[] = [],
): Promise<void> {
  const rulesContent = generateWorkspaceRules(repositories, skillsIndexRefs);
  const startMarker = '<!-- WORKSPACE-RULES:START -->';
  const endMarker = '<!-- WORKSPACE-RULES:END -->';

  if (!existsSync(filePath)) {
    // Create new file with just the rules
    await writeFile(filePath, `${rulesContent.trim()}\n`, 'utf-8');
    return;
  }

  const content = await readFile(filePath, 'utf-8');
  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker);

  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    // Markers exist - replace content between them (including markers)
    const before = content.substring(0, startIndex);
    const after = content.substring(endIndex + endMarker.length);
    await writeFile(filePath, before + rulesContent.trim() + after, 'utf-8');
  } else {
    // No markers - append
    await writeFile(filePath, content + rulesContent, 'utf-8');
  }
}

/**
 * Result of a file copy operation
 */
export type CopyArtifactType = 'skill' | 'command' | 'agent' | 'hook';

export interface CopyResult {
  source: string;
  destination: string;
  action: 'copied' | 'deduped' | 'skipped' | 'failed' | 'generated';
  error?: string;
  /** Resolved ownership supplied by the copy operation, when applicable. */
  client?: ClientType;
  artifactType?: CopyArtifactType;
}

/**
 * Options for copy operations
 */
export interface CopyOptions {
  /** Simulate copy without making changes */
  dryRun?: boolean;
  /** Override client path mappings (defaults to CLIENT_MAPPINGS) */
  clientMappings?: ClientMappings;
  /** Selected filesystem root that bounds this client's external writes. */
  writeRoot?: string;
  /**
   * Glob patterns of files to exclude during sync.
   * Paths are relative to the plugin root (e.g., ".github/instructions/file.md",
   * "commands/my-command.md", "skills/my-skill").
   */
  exclude?: string[];
}

/**
 * Check if a file path (relative to plugin root) matches any exclude pattern.
 */
export function isExcluded(
  pluginPath: string,
  filePath: string,
  exclude?: string[],
): boolean {
  if (!exclude || exclude.length === 0) return false;
  const relativePath = relative(pluginPath, filePath).replaceAll('\\', '/');
  return micromatch.isMatch(relativePath, exclude);
}

/**
 * Recursively copy a directory, skipping files that match exclude patterns.
 */
async function copyDirectoryWithExclusions(
  sourceDir: string,
  destDir: string,
  pluginPath: string,
  exclude: string[],
): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name);
    const destPath = join(destDir, entry.name);

    if (isExcluded(pluginPath, sourcePath, exclude)) {
      continue;
    }

    if (entry.isDirectory()) {
      await copyDirectoryWithExclusions(
        sourcePath,
        destPath,
        pluginPath,
        exclude,
      );
    } else {
      await cp(sourcePath, destPath);
    }
  }
}

async function collectDirectoryFiles(
  sourceRoot: string,
  pluginPath: string,
  exclude?: string[],
  relativeDir = '',
): Promise<string[]> {
  const directory = join(sourceRoot, relativeDir);
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = join(relativeDir, entry.name);
    const source = join(sourceRoot, relativePath);
    if (isExcluded(pluginPath, source, exclude)) continue;

    if (entry.isDirectory()) {
      files.push(
        ...(await collectDirectoryFiles(
          sourceRoot,
          pluginPath,
          exclude,
          relativePath,
        )),
      );
    } else {
      files.push(relativePath);
    }
  }
  return files;
}

/**
 * Options for skill copy operations
 */
export interface SkillCopyOptions extends CopyOptions {
  /**
   * Map of skill folder name to resolved name.
   * When provided, skills will be copied using the resolved name instead of folder name.
   * Key format: "folderName" (just the skill folder name)
   * Value: resolved name to use for the destination
   */
  skillNameMap?: Map<string, string>;
  /**
   * Sync mode for skills.
   * - 'symlink': Create symlinks from client paths to canonical location
   * - 'copy': Copy files directly (default for backward compatibility)
   */
  syncMode?: SyncMode;
  /**
   * Path to canonical skills location (e.g., '.agents/skills/').
   * Required when syncMode is 'symlink' and client is non-universal.
   */
  canonicalSkillsPath?: string;
}

/**
 * Options for workspace file copy operations
 */
export interface WorkspaceCopyOptions extends CopyOptions {
  /**
   * Map of GitHub repo keys (owner/repo) to their cache paths.
   * Required for resolving GitHub file sources.
   */
  githubCache?: Map<string, string>;
  /**
   * Repositories to embed in WORKSPACE-RULES.
   * When provided, rules include actual repository paths directly.
   * When empty/absent, WORKSPACE-RULES injection is skipped.
   */
  repositories?: WorkspaceRepository[];
  /**
   * References to per-repo skills-index files.
   * Embedded in WORKSPACE-RULES as conditional links.
   */
  skillsIndexRefs?: SkillsIndexRef[];
}

/**
 * Get the client mapping, using the supplied scope map when present.
 */
function getMapping(
  client: ClientType,
  options?: { clientMappings?: ClientMappings },
): ClientMapping {
  const mapping = options?.clientMappings
    ? options.clientMappings[client]
    : CLIENT_MAPPINGS[client];
  if (!mapping) {
    throw new Error(`Client '${client}' has no mapping for this scope`);
  }
  return mapping;
}

/**
 * Copy commands from plugin to workspace for a specific client
 * Commands are copied to clients that support commandsPath
 * @param pluginPath - Path to plugin directory
 * @param workspacePath - Path to workspace directory
 * @param client - Target client type
 * @param options - Copy options (dryRun)
 * @returns Array of copy results
 */
export async function copyCommands(
  pluginPath: string,
  workspacePath: string,
  client: ClientType,
  options: CopyOptions = {},
): Promise<CopyResult[]> {
  const { dryRun = false } = options;
  const mapping = getMapping(client, options);
  const results: CopyResult[] = [];

  // Skip if client doesn't support commands (only Claude has commandsPath)
  if (!mapping.commandsPath) {
    return results;
  }

  const sourceDir = join(pluginPath, 'commands');
  if (!existsSync(sourceDir)) {
    return results;
  }

  const destDir = resolveMappedPath(workspacePath, mapping.commandsPath);
  try {
    await assertSafeDestination(options.writeRoot ?? workspacePath, destDir);
  } catch (error) {
    return [{
      source: sourceDir,
      destination: destDir,
      action: 'failed',
      error: error instanceof Error ? error.message : 'Unsafe destination',
      client,
      artifactType: 'command',
    }];
  }
  if (!dryRun) await mkdir(destDir, { recursive: true });

  const files = await readdir(sourceDir);
  const mdFiles = files.filter((f) => f.endsWith('.md'));

  // Process files in parallel for better performance
  const copyPromises = mdFiles
    .filter(
      (file) => !isExcluded(pluginPath, join(sourceDir, file), options.exclude),
    )
    .map(async (file): Promise<CopyResult> => {
      const sourcePath = join(sourceDir, file);
      const destPath = join(destDir, file);

      if (dryRun) {
        return { source: sourcePath, destination: destPath, action: 'copied' };
      }

      try {
        const content = await readFile(sourcePath, 'utf-8');
        await writeFile(destPath, content, 'utf-8');
        return { source: sourcePath, destination: destPath, action: 'copied' };
      } catch (error) {
        return {
          source: sourcePath,
          destination: destPath,
          action: 'failed',
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    });

  return Promise.all(copyPromises);
}

/**
 * Copy skills from plugin to workspace for a specific client.
 * Validates each skill before copying.
 *
 * When syncMode is 'symlink' and client is non-universal:
 * - Skills should already be copied to canonical location
 * - Creates symlinks from client path to canonical location
 * - Falls back to copy if symlink creation fails
 *
 * @param pluginPath - Path to plugin directory
 * @param workspacePath - Path to workspace directory
 * @param client - Target client type
 * @param options - Copy options (dryRun, skillNameMap, syncMode, canonicalSkillsPath)
 * @returns Array of copy results
 */
export async function copySkills(
  pluginPath: string,
  workspacePath: string,
  client: ClientType,
  options: SkillCopyOptions = {},
): Promise<CopyResult[]> {
  const {
    dryRun = false,
    skillNameMap,
    syncMode = 'copy',
    canonicalSkillsPath,
  } = options;
  const mapping = getMapping(client, options);
  const results: CopyResult[] = [];

  // Skip if client doesn't support skills
  if (!mapping.skillsPath) {
    return results;
  }

  // Discover skill sources across all layouts. Skills can be nested below
  // `skills/<category>/`; the subpath relative to the scan root is preserved
  // so the allowlist can target nested skills with `category/skill` form.
  const skillsDir = join(pluginPath, 'skills');
  let skillSources: {
    name: string;
    subpath: string;
    sourcePath: string;
    isRootLevel: boolean;
  }[];

  if (existsSync(skillsDir)) {
    const entries = await discoverNestedSkillEntries(skillsDir);
    skillSources = entries
      .filter(
        (entry) => !isExcluded(pluginPath, entry.skillPath, options.exclude),
      )
      .map((entry) => ({
        name: entry.name,
        subpath: entry.subpath,
        sourcePath: entry.skillPath,
        isRootLevel: false,
      }));
  } else {
    const nestedSkills = (await discoverNestedSkillEntries(pluginPath))
      .filter(
        (entry) => !isExcluded(pluginPath, entry.skillPath, options.exclude),
      )
      .map((entry) => ({
        name: entry.name,
        subpath: entry.subpath,
        sourcePath: entry.skillPath,
        isRootLevel: false,
      }));

    if (nestedSkills.length > 0) {
      skillSources = nestedSkills;
    } else {
      // Root-level single-skill layout: plugin/SKILL.md
      const rootSkillMd = join(pluginPath, 'SKILL.md');
      if (existsSync(rootSkillMd)) {
        const content = await readFile(rootSkillMd, 'utf-8');
        const metadata = parseSkillMetadata(content);
        const skillName = metadata?.name ?? basename(pluginPath);
        skillSources = [
          {
            name: skillName,
            subpath: skillName,
            sourcePath: pluginPath,
            isRootLevel: true,
          },
        ];
      } else {
        return results;
      }
    }
  }

  // When skillNameMap is provided, only copy skills that are in the map.
  // Match by either bare leaf name or qualified subpath so the map can carry
  // either form.
  if (skillNameMap) {
    skillSources = skillSources.filter(
      (s) => skillNameMap.has(s.name) || skillNameMap.has(s.subpath),
    );
  }

  if (skillSources.length === 0) {
    return results;
  }

  const destDir = resolveMappedPath(workspacePath, mapping.skillsPath);
  const writeRoot = options.writeRoot ?? workspacePath;
  if (!dryRun) {
    try {
      await assertSafeDestination(writeRoot, destDir);
      await mkdir(destDir, { recursive: true });
    } catch (error) {
      return skillSources.map((skill) => ({
        source: skill.sourcePath,
        destination: join(destDir, skill.name),
        action: 'failed',
        error: error instanceof Error ? error.message : 'Unsafe destination',
        client,
        artifactType: 'skill',
      }));
    }
  }

  // Determine if we should use symlinks for this client
  const useSymlinks =
    syncMode === 'symlink' && !isUniversalClient(client) && canonicalSkillsPath;

  // Process skill directories in parallel for better performance
  const copyPromises = skillSources.map(async (skill): Promise<CopyResult> => {
    // Use resolved name from skillNameMap if available, otherwise use folder name
    const resolvedName = skillNameMap?.get(skill.name) ?? skill.name;
    const skillDestPath = join(destDir, resolvedName);

    if (dryRun) {
      return {
        source: skill.sourcePath,
        destination: skillDestPath,
        action: 'copied',
        client,
        artifactType: 'skill',
      };
    }

    try {
      await assertSafeDestination(writeRoot, skillDestPath);
    } catch (error) {
      return {
        source: skill.sourcePath,
        destination: skillDestPath,
        action: 'failed',
        error: error instanceof Error ? error.message : 'Unsafe destination',
        client,
        artifactType: 'skill',
      };
    }

    // If using symlinks, create symlink from client path to canonical location
    if (useSymlinks) {
      const canonicalSkillPath = join(
        workspacePath,
        canonicalSkillsPath,
        resolvedName,
      );
      const symlinkCreated = await createSymlink(
        canonicalSkillPath,
        skillDestPath,
      );

      if (symlinkCreated) {
        return {
          source: canonicalSkillPath,
          destination: skillDestPath,
          action: 'copied', // Report as copied for consistency
          client,
          artifactType: 'skill',
        };
      }
      // Symlink failed, fall back to copy
    }

    try {
      if (skill.isRootLevel) {
        // Root-level: copy only the SKILL.md into a new skill directory
        await mkdir(skillDestPath, { recursive: true });
        await cp(
          join(skill.sourcePath, 'SKILL.md'),
          join(skillDestPath, 'SKILL.md'),
        );
      } else if (options.exclude && options.exclude.length > 0) {
        await copyDirectoryWithExclusions(
          skill.sourcePath,
          skillDestPath,
          pluginPath,
          options.exclude,
        );
      } else {
        await cp(skill.sourcePath, skillDestPath, { recursive: true });
      }
      return {
        source: skill.sourcePath,
        destination: skillDestPath,
        action: 'copied',
        client,
        artifactType: 'skill',
      };
    } catch (error) {
      return {
        source: skill.sourcePath,
        destination: skillDestPath,
        action: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
        client,
        artifactType: 'skill',
      };
    }
  });

  return Promise.all(copyPromises);
}

/**
 * Information about a skill collected from a plugin
 */
export interface CollectedSkill {
  /** Skill folder name */
  folderName: string;
  /** Path to the skill directory */
  skillPath: string;
  /** Plugin path this skill belongs to */
  pluginPath: string;
  /** Plugin source (original reference, e.g., GitHub URL or local path) */
  pluginSource: string;
}

/**
 * Collect skill information from a plugin without copying
 * Used for the first pass of two-pass name resolution
 * @param pluginPath - Resolved path to plugin directory
 * @param pluginSource - Original plugin source reference
 * @param disabledSkills - Optional set of disabled skill keys (plugin:skill format); used as v1 fallback
 * @param pluginName - Optional plugin name for building skill keys
 * @param enabledSkills - Optional set of enabled skill keys (allowlist mode); used as v1 fallback
 * @param pluginSkillsConfig - Optional inline plugin-level skills config (v2+); takes priority over disabledSkills/enabledSkills
 * @returns Array of collected skill information
 */
export async function collectPluginSkills(
  pluginPath: string,
  pluginSource: string,
  disabledSkills?: Set<string>,
  pluginName?: string,
  enabledSkills?: Set<string>,
  pluginSkillsConfig?: PluginSkillsConfig,
  warnings?: string[],
): Promise<CollectedSkill[]> {
  const skillsDir = join(pluginPath, 'skills');
  const skillWalkWarnings: string[] = [];

  // v1 fallback: only apply enabledSkills to plugins that actually have entries in the set
  const hasEnabledEntries =
    !pluginSkillsConfig &&
    enabledSkills &&
    pluginName &&
    [...enabledSkills].some((s) => s.startsWith(`${pluginName}:`));

  let candidateDirs: { name: string; subpath: string; path: string }[];

  if (existsSync(skillsDir)) {
    const entries = await discoverNestedSkillEntries(
      skillsDir,
      skillWalkWarnings,
    );
    candidateDirs = entries.map((entry) => ({
      name: entry.name,
      subpath: entry.subpath,
      path: entry.skillPath,
    }));
  } else {
    const nestedDirs = (
      await discoverNestedSkillEntries(pluginPath, skillWalkWarnings)
    ).map((entry) => ({
      name: entry.name,
      subpath: entry.subpath,
      path: entry.skillPath,
    }));

    if (nestedDirs.length > 0) {
      candidateDirs = nestedDirs;
    } else {
      // Root-level single-skill layout: plugin/SKILL.md
      const rootSkillMd = join(pluginPath, 'SKILL.md');
      if (existsSync(rootSkillMd)) {
        const content = await readFile(rootSkillMd, 'utf-8');
        const metadata = parseSkillMetadata(content);
        const skillName = metadata?.name ?? basename(pluginPath);
        candidateDirs = [
          { name: skillName, subpath: skillName, path: pluginPath },
        ];
      } else {
        candidateDirs = [];
      }
    }
  }

  const matchesAllowlist = (
    entry: { name: string; subpath: string },
    allowlist: string[],
  ): boolean =>
    allowlist.includes(entry.name) || allowlist.includes(entry.subpath);

  let filteredDirs: typeof candidateDirs;
  if (pluginSkillsConfig !== undefined) {
    // Inline config takes priority (v2+). Match by either bare leaf name or
    // qualified subpath so nested skills can be targeted unambiguously.
    if (Array.isArray(pluginSkillsConfig)) {
      filteredDirs = candidateDirs.filter((e) =>
        matchesAllowlist(e, pluginSkillsConfig),
      );
    } else {
      filteredDirs = candidateDirs.filter(
        (e) => !matchesAllowlist(e, pluginSkillsConfig.exclude),
      );
    }
  } else if (pluginName) {
    // v1 fallback: use disabledSkills/enabledSkills
    if (hasEnabledEntries) {
      filteredDirs = candidateDirs.filter(
        (e) =>
          enabledSkills?.has(`${pluginName}:${e.name}`) ||
          enabledSkills?.has(`${pluginName}:${e.subpath}`),
      );
    } else if (disabledSkills) {
      filteredDirs = candidateDirs.filter(
        (e) =>
          !disabledSkills.has(`${pluginName}:${e.name}`) &&
          !disabledSkills.has(`${pluginName}:${e.subpath}`),
      );
    } else {
      filteredDirs = candidateDirs;
    }
  } else {
    filteredDirs = candidateDirs;
  }

  if (warnings && skillWalkWarnings.length > 0) {
    warnings.push(
      ...skillWalkWarnings.map((w) => `Plugin '${pluginSource}': ${w}`),
    );
  }

  return filteredDirs.map((entry) => ({
    folderName: entry.name,
    skillPath: entry.path,
    pluginPath,
    pluginSource,
  }));
}

/**
 * Copy hooks from plugin to workspace for a specific client
 * Only copies if client supports hooks
 * @param pluginPath - Path to plugin directory
 * @param workspacePath - Path to workspace directory
 * @param client - Target client type
 * @param options - Copy options (dryRun)
 * @returns Array of copy results
 */
export async function copyHooks(
  pluginPath: string,
  workspacePath: string,
  client: ClientType,
  options: CopyOptions = {},
): Promise<CopyResult[]> {
  const { dryRun = false } = options;
  const mapping = getMapping(client, options);

  if (!mapping.hooksPath) {
    return [];
  }

  const sourceDir = join(pluginPath, 'hooks');
  if (!existsSync(sourceDir)) {
    return [];
  }

  const destDir = resolveMappedPath(workspacePath, mapping.hooksPath);

  // hooks/hooks.json is a plugin declaration, not a repository hook payload.
  // Project Copilot sync materializes it separately with COPILOT_PLUGIN_ROOT
  // bound to the plugin installation path; copying it verbatim would register
  // the same hooks twice and leave the plugin-root variable unresolved.
  const effectiveExclude =
    mapping.hooksPath === '.github/hooks/' &&
    existsSync(join(sourceDir, 'hooks.json'))
      ? [...(options.exclude ?? []), 'hooks/hooks.json']
      : options.exclude;
  let hookFiles: string[];
  try {
    hookFiles = await collectDirectoryFiles(
      sourceDir,
      pluginPath,
      effectiveExclude,
    );
  } catch (error) {
    return [{
      source: sourceDir,
      destination: destDir,
      action: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
      client,
      artifactType: 'hook',
    }];
  }
  const writeRoot = options.writeRoot ?? workspacePath;

  try {
    await assertSafeDestination(writeRoot, destDir);
  } catch (error) {
    return [{
      source: sourceDir,
      destination: destDir,
      action: 'failed',
      error: error instanceof Error ? error.message : 'Unsafe destination',
      client,
      artifactType: 'hook',
    }];
  }

  const results: CopyResult[] = [];
  const preparedDirectories = new Set<string>();
  for (const relativePath of hookFiles) {
    const source = join(sourceDir, relativePath);
    const destination = join(destDir, relativePath);
    if (dryRun) {
      results.push({ source, destination, action: 'copied' });
      continue;
    }

    try {
      await assertSafeDestination(writeRoot, destination);
      const destinationDirectory = dirname(destination);
      if (!preparedDirectories.has(destinationDirectory)) {
        await mkdir(destinationDirectory, { recursive: true });
        preparedDirectories.add(destinationDirectory);
      }
      await cp(source, destination);
      results.push({ source, destination, action: 'copied' });
    } catch (error) {
      results.push({
        source,
        destination,
        action: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
        client,
        artifactType: 'hook',
      });
    }
  }
  return results;
}

/**
 * Copy agents from plugin to workspace for a specific client
 * Agents are subagent definitions (.md files) that can be spawned via Task tool
 * @param pluginPath - Path to plugin directory
 * @param workspacePath - Path to workspace directory
 * @param client - Target client type
 * @param options - Copy options (dryRun)
 * @returns Array of copy results
 */
export async function copyAgents(
  pluginPath: string,
  workspacePath: string,
  client: ClientType,
  options: CopyOptions = {},
): Promise<CopyResult[]> {
  const { dryRun = false } = options;
  const mapping = getMapping(client, options);
  const results: CopyResult[] = [];

  // Skip if client doesn't support agents
  if (!mapping.agentsPath) {
    return results;
  }

  const sourceDir = join(pluginPath, 'agents');
  if (!existsSync(sourceDir)) {
    return results;
  }

  const destDir = resolveMappedPath(workspacePath, mapping.agentsPath);
  try {
    await assertSafeDestination(options.writeRoot ?? workspacePath, destDir);
  } catch (error) {
    return [{
      source: sourceDir,
      destination: destDir,
      action: 'failed',
      error: error instanceof Error ? error.message : 'Unsafe destination',
      client,
      artifactType: 'agent',
    }];
  }
  if (!dryRun) await mkdir(destDir, { recursive: true });

  const files = await readdir(sourceDir);
  const mdFiles = files.filter((f) => f.endsWith('.md'));

  // Process files in parallel for better performance
  const copyPromises = mdFiles
    .filter(
      (file) => !isExcluded(pluginPath, join(sourceDir, file), options.exclude),
    )
    .map(async (file): Promise<CopyResult> => {
      const sourcePath = join(sourceDir, file);
      const destPath = join(destDir, file);

      if (dryRun) {
        return { source: sourcePath, destination: destPath, action: 'copied' };
      }

      try {
        const content = await readFile(sourcePath, 'utf-8');
        await writeFile(destPath, content, 'utf-8');
        return { source: sourcePath, destination: destPath, action: 'copied' };
      } catch (error) {
        return {
          source: sourcePath,
          destination: destPath,
          action: 'failed',
          error: error instanceof Error ? error.message : 'Unknown error',
        };
      }
    });

  return Promise.all(copyPromises);
}

export type AgentOutputRoute = 'portable' | 'github';

/**
 * One immutable copy decision for an agent file. The destination and logical
 * ownership recorded here are reused by copying, dedupe, warnings, and state.
 */
export interface AgentOutput {
  readonly configurationIndex: number;
  readonly plugin: string;
  readonly pluginPath: string;
  readonly source: string;
  readonly destination: string;
  readonly workspaceRelativeDestination: string;
  readonly route: AgentOutputRoute;
  readonly logicalName?: string;
  readonly clients: readonly ClientType[];
}

export interface AgentOutputConflict {
  readonly reason: 'destination' | 'logical-name';
  readonly winner: AgentOutput;
  readonly loser: AgentOutput;
}

export interface AgentOutputFailure {
  readonly configurationIndex: number;
  readonly plugin: string;
  readonly source: string;
  readonly destination: string;
  readonly error: string;
}

export interface AgentOutputPlan {
  readonly outputs: readonly AgentOutput[];
  readonly conflicts: readonly AgentOutputConflict[];
  readonly failures: readonly AgentOutputFailure[];
}

export interface AgentOutputPlugin {
  readonly configurationIndex: number;
  readonly plugin: string;
  readonly pluginPath: string;
  readonly clients: readonly ClientType[];
  readonly exclude?: string[];
  readonly fileArtifacts?: MarketplaceFileArtifacts;
}

/**
 * One agent representation removed after both planned representations copied
 * successfully.
 */
export interface AgentDedupeRecord {
  name: string;
  removedPath: string;
  keptPath: string;
}

function workspaceRelativePath(
  workspacePath: string,
  destination: string,
): string {
  return relative(workspacePath, destination).replaceAll('\\', '/');
}

async function readAgentLogicalName(
  source: string,
  cache: Map<string, string | undefined>,
): Promise<string | undefined> {
  if (cache.has(source)) return cache.get(source);

  let name: string | undefined;
  try {
    const parsed = matter(await readFile(source, 'utf-8')).data?.name;
    if (typeof parsed === 'string' && parsed.length > 0) name = parsed;
  } catch {
    // An unreadable name cannot participate in logical-name ownership.
  }
  cache.set(source, name);
  return name;
}

function mergeAgentOutputConsumer(
  candidates: Map<string, AgentOutput>,
  candidate: AgentOutput,
): void {
  const key = `${candidate.route}\0${candidate.source}\0${candidate.destination}`;
  const existing = candidates.get(key);
  if (existing) {
    const additionalClients = candidate.clients.filter(
      (client) => !existing.clients.includes(client),
    );
    if (additionalClients.length > 0) {
      candidates.set(key, {
        ...existing,
        clients: [...existing.clients, ...additionalClients],
      });
    }
    return;
  }
  candidates.set(key, candidate);
}

async function readAgentSourceEntries(
  sourceDir: string,
): Promise<{ files: Dirent[]; error?: string }> {
  if (!existsSync(sourceDir)) return { files: [] };
  try {
    return {
      files: (await readdir(sourceDir, { withFileTypes: true }))
        .filter((entry) => !entry.isDirectory() && entry.name.endsWith('.md'))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  } catch (error) {
    return {
      files: [],
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Discover agent sources once and choose their owners before plugin copying
 * starts. Plugins are considered in configuration order; an earlier valid
 * plugin owns both exact destinations and logical names within a physical
 * agents directory. Within one plugin, a GitHub-route source owns an exact
 * destination over its portable counterpart.
 */
export async function planAgentOutputs(
  plugins: readonly AgentOutputPlugin[],
  workspacePath: string,
  clientMappings: ClientMappings = CLIENT_MAPPINGS,
): Promise<AgentOutputPlan> {
  const outputs: AgentOutput[] = [];
  const conflicts: AgentOutputConflict[] = [];
  const failures: AgentOutputFailure[] = [];
  const destinationOwners = new Map<string, AgentOutput>();
  const logicalNameOwners = new Map<string, AgentOutput>();
  const logicalNames = new Map<string, string | undefined>();

  const orderedPlugins = plugins
    .map((plugin, order) => ({ plugin, order }))
    .sort(
      (a, b) =>
        a.plugin.configurationIndex - b.plugin.configurationIndex ||
        a.order - b.order,
    );

  for (const { plugin } of orderedPlugins) {
    const resolvedPluginMappings = resolveClientMappings(
      [...plugin.clients],
      clientMappings,
    );
    const candidates = new Map<string, AgentOutput>();
    const includePortable = plugin.fileArtifacts?.agents ?? true;
    const includeGithub = plugin.fileArtifacts?.github ?? true;

    const portableDestination = plugin.clients
      .map((client) => resolvedPluginMappings[client]?.agentsPath)
      .find((path): path is string => path !== undefined);
    if (includePortable && portableDestination) {
      const sourceDir = join(plugin.pluginPath, 'agents');
      const sourceEntries = await readAgentSourceEntries(sourceDir);
      if (sourceEntries.error) {
        failures.push({
          configurationIndex: plugin.configurationIndex,
          plugin: plugin.plugin,
          source: sourceDir,
          destination: join(workspacePath, portableDestination),
          error: sourceEntries.error,
        });
      }
      for (const entry of sourceEntries.files) {
        const source = join(sourceDir, entry.name);
        if (isExcluded(plugin.pluginPath, source, plugin.exclude)) continue;
        const logicalName = await readAgentLogicalName(source, logicalNames);
        for (const client of plugin.clients) {
          const agentsPath = resolvedPluginMappings[client]?.agentsPath;
          if (!agentsPath) continue;
          const destination = join(
            resolveMappedPath(workspacePath, agentsPath),
            entry.name,
          );
          mergeAgentOutputConsumer(candidates, {
            configurationIndex: plugin.configurationIndex,
            plugin: plugin.plugin,
            pluginPath: plugin.pluginPath,
            source,
            destination,
            workspaceRelativeDestination: workspaceRelativePath(
              workspacePath,
              destination,
            ),
            route: 'portable',
            ...(logicalName && { logicalName }),
            clients: [client],
          });
        }
      }
    }

    const githubDestination = plugin.clients
      .map((client) => resolvedPluginMappings[client]?.githubPath)
      .find((path): path is string => path !== undefined);
    if (includeGithub && githubDestination) {
      const sourceDir = join(plugin.pluginPath, '.github', 'agents');
      const sourceEntries = await readAgentSourceEntries(sourceDir);
      if (sourceEntries.error) {
        failures.push({
          configurationIndex: plugin.configurationIndex,
          plugin: plugin.plugin,
          source: sourceDir,
          destination: join(workspacePath, githubDestination, 'agents'),
          error: sourceEntries.error,
        });
      }
      for (const entry of sourceEntries.files) {
        const source = join(sourceDir, entry.name);
        if (isExcluded(plugin.pluginPath, source, plugin.exclude)) continue;
        const logicalName = await readAgentLogicalName(source, logicalNames);
        for (const client of plugin.clients) {
          const githubPath = resolvedPluginMappings[client]?.githubPath;
          if (!githubPath) continue;
          const destination = join(
            workspacePath,
            githubPath,
            'agents',
            entry.name,
          );
          mergeAgentOutputConsumer(candidates, {
            configurationIndex: plugin.configurationIndex,
            plugin: plugin.plugin,
            pluginPath: plugin.pluginPath,
            source,
            destination,
            workspaceRelativeDestination: workspaceRelativePath(
              workspacePath,
              destination,
            ),
            route: 'github',
            ...(logicalName && { logicalName }),
            clients: [client],
          });
        }
      }
    }

    const candidatesByDestination = new Map<string, AgentOutput[]>();
    for (const candidate of candidates.values()) {
      const grouped = candidatesByDestination.get(candidate.destination) ?? [];
      grouped.push(candidate);
      candidatesByDestination.set(candidate.destination, grouped);
    }

    const pluginWinners: AgentOutput[] = [];
    for (const sameDestination of candidatesByDestination.values()) {
      const preferred =
        sameDestination.find((candidate) => candidate.route === 'github') ??
        sameDestination[0];
      if (!preferred) continue;
      const consumingClients = [
        ...new Set(sameDestination.flatMap((candidate) => candidate.clients)),
      ];
      const winner: AgentOutput = {
        ...preferred,
        clients: consumingClients,
      };
      pluginWinners.push(winner);
      for (const loser of sameDestination) {
        if (loser !== preferred) {
          conflicts.push({ reason: 'destination', winner, loser });
        }
      }
    }

    for (const candidate of pluginWinners) {
      const destinationWinner = destinationOwners.get(candidate.destination);
      const logicalKey = candidate.logicalName
        ? `${dirname(candidate.destination)}\0${candidate.logicalName}`
        : undefined;
      const logicalWinner = logicalKey
        ? logicalNameOwners.get(logicalKey)
        : undefined;
      const destinationConflict =
        destinationWinner &&
        destinationWinner.configurationIndex !== candidate.configurationIndex
          ? destinationWinner
          : undefined;
      const logicalConflict =
        logicalWinner &&
        logicalWinner.configurationIndex !== candidate.configurationIndex
          ? logicalWinner
          : undefined;
      const winner = destinationConflict ?? logicalConflict;

      if (winner) {
        conflicts.push({
          reason: destinationWinner === winner ? 'destination' : 'logical-name',
          winner,
          loser: candidate,
        });
        continue;
      }

      outputs.push(candidate);
      if (!destinationWinner) {
        destinationOwners.set(candidate.destination, candidate);
      }
      if (logicalKey && !logicalWinner) {
        logicalNameOwners.set(logicalKey, candidate);
      }
    }
  }

  return { outputs, conflicts, failures };
}

/**
 * Collapse a same-plugin portable/GitHub pair only when both exact planned
 * copies succeeded. No source or destination discovery occurs here.
 */
export async function dedupeAgentFilesByName(
  plan: AgentOutputPlan,
  copyResults: readonly CopyResult[],
  options: { dryRun?: boolean; onWarning?: (warning: string) => void } = {},
): Promise<AgentDedupeRecord[]> {
  const copiedOutputs = new Map(
    copyResults
      .filter((result) => result.action === 'copied')
      .map((result) => [`${result.source}\0${result.destination}`, result]),
  );
  const groups = new Map<
    string,
    { portable: AgentOutput[]; github: AgentOutput[] }
  >();
  for (const output of plan.outputs) {
    if (!output.logicalName) continue;
    const key = `${dirname(output.destination)}\0${output.logicalName}`;
    const group = groups.get(key) ?? { portable: [], github: [] };
    group[output.route].push(output);
    groups.set(key, group);
  }

  const records: AgentDedupeRecord[] = [];
  for (const group of groups.values()) {
    const github = group.github.find(
      (output) =>
        output.destination.endsWith('.agent.md') &&
        copiedOutputs.has(`${output.source}\0${output.destination}`),
    );
    if (!github) continue;

    for (const portable of group.portable) {
      const name = portable.logicalName;
      const portableResult = copiedOutputs.get(
        `${portable.source}\0${portable.destination}`,
      );
      if (portable.destination.endsWith('.agent.md')) continue;
      if (
        !name ||
        portable.configurationIndex !== github.configurationIndex ||
        !portableResult
      ) {
        continue;
      }
      if (!options.dryRun) {
        try {
          await unlink(portable.destination);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Unknown error';
          options.onWarning?.(
            `Could not dedupe agent '${name}': failed to remove ${portable.workspaceRelativeDestination}: ${message}`,
          );
          continue;
        }
      }
      portableResult.action = 'deduped';
      records.push({
        name,
        removedPath: portable.workspaceRelativeDestination,
        keptPath: github.workspaceRelativeDestination,
      });
    }
  }

  return records;
}

/**
 * Options for copying GitHub content
 */
export interface GitHubCopyOptions extends CopyOptions {
  /**
   * Map of skill folder name to resolved name.
   * Used when skills are renamed due to conflicts, so links can be adjusted accordingly.
   */
  skillNameMap?: Map<string, string>;
  /**
   * Preselected GitHub-route agent files. When omitted, this direct caller gets
   * a one-plugin plan so aggregate GitHub copying still cannot bypass planning.
   */
  agentOutputs?: readonly AgentOutput[];
}

function relocatesGitHubContent(mapping: ClientMapping): boolean {
  return mapping.githubPath !== '.github/';
}

function githubContentExcludes(
  mapping: ClientMapping,
  exclude?: string[],
): string[] | undefined {
  const effectiveExclude = [...(exclude ?? [])];
  // Top-level Markdown definitions use the per-file ownership plan. Nested
  // files and companion assets retain the aggregate copy behavior.
  effectiveExclude.push('.github/agents/*.md', '.github/agents/.*.md');

  // Copilot plugin package metadata is used to discover a native plugin, but
  // it has no runtime role after file-mode content is overlaid into a project.
  if (!relocatesGitHubContent(mapping)) {
    effectiveExclude.push('.github/plugin');
  }

  // .github/hooks is repository-owned. Root hooks/ remains the portable
  // plugin artifact that can be installed into a client's user hook path.
  if (relocatesGitHubContent(mapping)) {
    effectiveExclude.push('.github/hooks');
  }

  return effectiveExclude.length > 0 ? effectiveExclude : undefined;
}

export interface RelocatedGitHubHooksSource {
  pluginPath: string;
  exclude?: string[];
}

export interface RelocatedGitHubHooksResult {
  found: string[];
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

/**
 * Find files that older versions may have mirrored from repository
 * .github/hooks into a relocated user directory. Historical sync state did not
 * record ownership of these files, so callers must leave them in place and
 * report them for manual review.
 */
export async function findRelocatedGitHubHooks(
  sources: RelocatedGitHubHooksSource[],
  workspacePath: string,
  client: ClientType,
  options: Pick<CopyOptions, 'dryRun' | 'clientMappings'> = {},
): Promise<RelocatedGitHubHooksResult> {
  const emptyResult: RelocatedGitHubHooksResult = { found: [] };
  const mapping = getMapping(client, options);
  if (
    options.dryRun ||
    !mapping.githubPath ||
    !relocatesGitHubContent(mapping)
  ) {
    return emptyResult;
  }

  const destDir = join(
    resolveMappedPath(workspacePath, mapping.githubPath),
    'hooks',
  );
  const candidates = new Set<string>();
  await Promise.all(
    sources.map(async ({ pluginPath, exclude }) => {
      const sourceRoot = join(pluginPath, '.github', 'hooks');

      async function collect(sourceDir: string): Promise<void> {
        let entries: Dirent[];
        try {
          entries = await readdir(sourceDir, { withFileTypes: true });
        } catch (error) {
          if (isNotFoundError(error)) return;
          throw error;
        }

        await Promise.all(
          entries.map(async (entry) => {
            const sourcePath = join(sourceDir, entry.name);
            if (isExcluded(pluginPath, sourcePath, exclude)) return;
            if (entry.isDirectory()) return collect(sourcePath);

            const relativePath = relative(sourceRoot, sourcePath);
            candidates.add(relativePath);
          }),
        );
      }

      await collect(sourceRoot);
    }),
  );

  const found = await Promise.all(
    [...candidates].sort().map(async (relativePath) => {
      const destPath = join(destDir, relativePath);
      try {
        await access(destPath);
        return destPath;
      } catch (error) {
        return isNotFoundError(error) ? undefined : destPath;
      }
    }),
  );

  return { found: found.filter((path) => path !== undefined) };
}

/**
 * Recursively process a directory, copying files and adjusting links in markdown.
 * Single-pass approach: read source → transform if markdown → write to dest.
 */
function isMalformedGitHubAgentsEntry(
  pluginPath: string,
  sourcePath: string,
  entry: Dirent,
): boolean {
  return (
    !entry.isDirectory() &&
    relative(pluginPath, sourcePath).replaceAll('\\', '/') === '.github/agents'
  );
}

async function copyAndAdjustDirectory(
  sourceDir: string,
  destDir: string,
  sourceBase: string,
  pluginPath: string,
  skillsPath: string,
  skillNameMap?: Map<string, string>,
  exclude?: string[],
): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const sourcePath = join(sourceDir, entry.name);
    const destPath = join(destDir, entry.name);
    if (isMalformedGitHubAgentsEntry(pluginPath, sourcePath, entry)) continue;

    if (isExcluded(pluginPath, sourcePath, exclude)) {
      continue;
    }

    if (entry.isDirectory()) {
      await copyAndAdjustDirectory(
        sourcePath,
        destPath,
        sourceBase,
        pluginPath,
        skillsPath,
        skillNameMap,
        exclude,
      );
    } else {
      const relativePath = relative(sourceBase, sourcePath).replaceAll(
        '\\',
        '/',
      );
      const isMarkdown =
        entry.name.endsWith('.md') || entry.name.endsWith('.markdown');

      if (isMarkdown) {
        // Read, transform, write in one pass
        let content = await readFile(sourcePath, 'utf-8');
        content = adjustLinksInContent(content, relativePath, {
          ...(skillNameMap && { skillNameMap }),
          workspaceSkillsPath: skillsPath,
        });
        await writeFile(destPath, content, 'utf-8');
      } else {
        // Copy non-markdown files directly
        await cp(sourcePath, destPath);
      }
    }
  }
}

async function hasIncludedFiles(
  sourceDir: string,
  pluginPath: string,
  exclude?: string[],
): Promise<boolean> {
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name);
    if (isMalformedGitHubAgentsEntry(pluginPath, sourcePath, entry)) continue;
    if (isExcluded(pluginPath, sourcePath, exclude)) continue;
    if (!entry.isDirectory()) return true;
    if (await hasIncludedFiles(sourcePath, pluginPath, exclude)) return true;
  }
  return false;
}

interface PlannedAgentCopyOptions {
  dryRun: boolean;
  clientMappings: ClientMappings;
  skillNameMap?: Map<string, string>;
  writeRoot?: string;
}

async function copyPlannedAgentOutputs(
  outputs: readonly AgentOutput[],
  options: PlannedAgentCopyOptions,
): Promise<CopyResult[]> {
  return Promise.all(
    outputs.map(async (output): Promise<CopyResult> => {
      const client = output.clients[0];
      try {
        await assertSafeDestination(
          options.writeRoot ?? dirname(output.destination),
          output.destination,
        );
      } catch (error) {
        return {
          source: output.source,
          destination: output.destination,
          action: 'failed',
          error: error instanceof Error ? error.message : 'Unsafe destination',
          ...(client && { client }),
          artifactType: 'agent',
        };
      }
      if (options.dryRun) {
        return {
          source: output.source,
          destination: output.destination,
          action: 'copied',
          ...(client && { client }),
          artifactType: 'agent',
        };
      }

      try {
        await mkdir(dirname(output.destination), { recursive: true });
        let content = await readFile(output.source, 'utf-8');
        if (output.route === 'github') {
          const sourceRelativeToGithub = relative(
            join(output.pluginPath, '.github'),
            output.source,
          ).replaceAll('\\', '/');
          const skillsPath = client
            ? (options.clientMappings[client]?.skillsPath ?? '')
            : '';
          content = adjustLinksInContent(content, sourceRelativeToGithub, {
            ...(options.skillNameMap && {
              skillNameMap: options.skillNameMap,
            }),
            workspaceSkillsPath: skillsPath,
          });
        }
        await writeFile(output.destination, content, 'utf-8');
        return {
          source: output.source,
          destination: output.destination,
          action: 'copied',
          ...(client && { client }),
          artifactType: 'agent',
        };
      } catch (error) {
        return {
          source: output.source,
          destination: output.destination,
          action: 'failed',
          error: error instanceof Error ? error.message : 'Unknown error',
          ...(client && { client }),
          artifactType: 'agent',
        };
      }
    }),
  );
}

/**
 * Copy GitHub-specific content from plugin to workspace. Agent files always
 * use the immutable per-file ownership plan and are excluded from aggregate
 * traversal.
 */
export async function copyGitHubContent(
  pluginPath: string,
  workspacePath: string,
  client: ClientType,
  options: GitHubCopyOptions = {},
): Promise<CopyResult[]> {
  const { dryRun = false, skillNameMap } = options;
  const mapping = getMapping(client, options);
  const mappings = options.clientMappings ?? CLIENT_MAPPINGS;
  const results: CopyResult[] = [];
  if (!mapping.githubPath) {
    return options.agentOutputs
      ? copyPlannedAgentOutputs(options.agentOutputs, {
          dryRun,
          clientMappings: mappings,
          ...(skillNameMap && { skillNameMap }),
          ...(options.writeRoot && { writeRoot: options.writeRoot }),
        })
      : results;
  }

  const sourceDir = join(pluginPath, '.github');
  if (!existsSync(sourceDir)) return results;

  let agentOutputs = options.agentOutputs;
  let planningFailures: readonly AgentOutputFailure[] = [];
  if (agentOutputs === undefined) {
    const directPlan = await planAgentOutputs(
      [
        {
          configurationIndex: 0,
          plugin: basename(pluginPath),
          pluginPath,
          clients: [client],
          ...(options.exclude && { exclude: options.exclude }),
        },
      ],
      workspacePath,
      mappings,
    );
    agentOutputs = directPlan.outputs.filter(
      (output) => output.route === 'github',
    );
    planningFailures = directPlan.failures;
  }

  const destDir = resolveMappedPath(workspacePath, mapping.githubPath);
  const effectiveExclude = githubContentExcludes(mapping, options.exclude);
  let hasAggregateContent = false;
  try {
    hasAggregateContent = await hasIncludedFiles(
      sourceDir,
      pluginPath,
      effectiveExclude,
    );
  } catch (error) {
    results.push({
      source: sourceDir,
      destination: destDir,
      action: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
  if (hasAggregateContent) {
    if (dryRun) {
      results.push({
        source: sourceDir,
        destination: destDir,
        action: 'copied',
      });
    } else {
      try {
        await copyAndAdjustDirectory(
          sourceDir,
          destDir,
          sourceDir,
          pluginPath,
          mapping.skillsPath,
          skillNameMap,
          effectiveExclude,
        );
        results.push({
          source: sourceDir,
          destination: destDir,
          action: 'copied',
        });
      } catch (error) {
        results.push({
          source: sourceDir,
          destination: destDir,
          action: 'failed',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  results.push(
    ...(await copyPlannedAgentOutputs(agentOutputs, {
      dryRun,
      clientMappings: mappings,
      ...(skillNameMap && { skillNameMap }),
      ...(options.writeRoot && { writeRoot: options.writeRoot }),
    })),
  );
  results.push(
    ...planningFailures.map((failure) => ({
      source: failure.source,
      destination: failure.destination,
      action: 'failed' as const,
      error: failure.error,
    })),
  );
  return results;
}

/**
 * Options for copying a plugin to workspace
 */
export interface PluginCopyOptions extends CopyOptions {
  /**
   * File artifacts explicitly exposed by a non-strict marketplace entry.
   * Undefined preserves conventional plugin-directory discovery.
   */
  fileArtifacts?: MarketplaceFileArtifacts;
  /**
   * Map of skill folder name to resolved name for this specific plugin.
   * When provided, skills will be copied using the resolved name instead of folder name.
   */
  skillNameMap?: Map<string, string>;
  /**
   * Sync mode for skills.
   * - 'symlink': Create symlinks from client paths to canonical location
   * - 'copy': Copy files directly (default for backward compatibility)
   */
  syncMode?: SyncMode;
  /**
   * Path to canonical skills location (e.g., '.agents/skills/').
   * Required when syncMode is 'symlink' and client is non-universal.
   */
  canonicalSkillsPath?: string;
  /**
   * Agent files already selected by a scope-level plan. Undefined creates a
   * one-plugin plan for direct callers; an empty array intentionally copies no
   * agent files.
   */
  agentOutputs?: readonly AgentOutput[];
}

/**
 * Copy all plugin content to workspace for a specific client
 * Plugins provide: commands, skills, hooks, agents, and GitHub-specific content
 * @param pluginPath - Path to plugin directory
 * @param workspacePath - Path to workspace directory
 * @param client - Target client type
 * @param options - Copy options (dryRun, skillNameMap, syncMode, canonicalSkillsPath)
 * @returns All copy results
 */
export async function copyPluginToWorkspace(
  pluginPath: string,
  workspacePath: string,
  client: ClientType,
  options: PluginCopyOptions = {},
): Promise<CopyResult[]> {
  const {
    skillNameMap,
    syncMode,
    canonicalSkillsPath,
    fileArtifacts,
    agentOutputs: providedAgentOutputs,
    ...baseOptions
  } = options;
  const shouldCopy = (artifact: keyof MarketplaceFileArtifacts): boolean =>
    fileArtifacts?.[artifact] ?? true;
  const mappings = options.clientMappings ?? CLIENT_MAPPINGS;

  let agentOutputs = providedAgentOutputs;
  let directConflicts: readonly AgentOutputConflict[] = [];
  let directFailures: readonly AgentOutputFailure[] = [];
  if (agentOutputs === undefined) {
    const directPlan = await planAgentOutputs(
      [
        {
          configurationIndex: 0,
          plugin: basename(pluginPath),
          pluginPath,
          clients: [client],
          ...(baseOptions.exclude && { exclude: baseOptions.exclude }),
          ...(fileArtifacts && { fileArtifacts }),
        },
      ],
      workspacePath,
      mappings,
    );
    agentOutputs = directPlan.outputs;
    directConflicts = directPlan.conflicts;
    directFailures = directPlan.failures;
  }

  const [commandResults, skillResults, hookResults, portableAgentResults] =
    await Promise.all([
      shouldCopy('commands')
        ? copyCommands(pluginPath, workspacePath, client, baseOptions)
        : [],
      shouldCopy('skills')
        ? copySkills(pluginPath, workspacePath, client, {
            ...baseOptions,
            ...(skillNameMap && { skillNameMap }),
            ...(syncMode && { syncMode }),
            ...(canonicalSkillsPath && { canonicalSkillsPath }),
          })
        : [],
      shouldCopy('hooks')
        ? copyHooks(pluginPath, workspacePath, client, baseOptions)
        : [],
      copyPlannedAgentOutputs(
        agentOutputs.filter((output) => output.route === 'portable'),
        {
          dryRun: baseOptions.dryRun ?? false,
          clientMappings: mappings,
          ...(skillNameMap && { skillNameMap }),
          ...(baseOptions.writeRoot && { writeRoot: baseOptions.writeRoot }),
        },
      ),
    ]);

  const githubResults = shouldCopy('github')
    ? await copyGitHubContent(pluginPath, workspacePath, client, {
        ...baseOptions,
        ...(skillNameMap && { skillNameMap }),
        agentOutputs: agentOutputs.filter(
          (output) => output.route === 'github',
        ),
      })
    : [];
  const skippedAgentResults: CopyResult[] = directConflicts.map(
    ({ loser }) => ({
      source: loser.source,
      destination: loser.destination,
      action: 'skipped',
    }),
  );
  const failedAgentResults: CopyResult[] = directFailures.map((failure) => ({
    source: failure.source,
    destination: failure.destination,
    action: 'failed',
    error: failure.error,
  }));

  return [
    ...commandResults,
    ...skillResults,
    ...hookResults,
    ...portableAgentResults,
    ...githubResults,
    ...skippedAgentResults,
    ...failedAgentResults,
  ];
}

/**
 * Check if a source string is an explicit GitHub reference
 *
 * More conservative than isGitHubUrl - only returns true for explicit GitHub formats:
 * - https://github.com/...
 * - github.com/...
 * - gh:owner/repo/...
 * - owner/repo/path/to/file (must have at least 3 path segments for file sources)
 *
 * This prevents ambiguous paths like "config/settings.json" from being treated as GitHub URLs.
 */
function isExplicitGitHubSource(source: string): boolean {
  // Explicit URL patterns
  if (
    source.startsWith('https://github.com/') ||
    source.startsWith('http://github.com/') ||
    source.startsWith('github.com/') ||
    source.startsWith('gh:')
  ) {
    return true;
  }

  // For shorthand format (owner/repo/path), require at least 3 segments
  // This ensures paths like "config/settings.json" are treated as local
  if (
    !source.startsWith('.') &&
    !source.startsWith('/') &&
    source.includes('/')
  ) {
    const parts = source.split('/');
    // Need owner, repo, AND at least one path segment for file sources
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
 * Resolve a file source to an absolute path
 *
 * For local paths:
 * - Absolute paths are used as-is
 * - Relative paths are resolved relative to defaultSourcePath
 *
 * For GitHub paths:
 * - Resolved from the githubCache using owner/repo as key
 *
 * @param source - The source string (local path or GitHub URL)
 * @param defaultSourcePath - Default source directory for resolving relative local paths
 * @param githubCache - Map of owner/repo to cache paths for GitHub sources
 * @returns Resolved absolute path or null if cannot resolve
 */
function resolveFileSourcePath(
  source: string,
  defaultSourcePath: string | undefined,
  githubCache: Map<string, string> | undefined,
): { path: string; error?: string } | null {
  // First, check if this is an explicit GitHub source
  // This prevents paths like "config/settings.json" from being treated as GitHub URLs
  if (!isExplicitGitHubSource(source)) {
    // Treat as local path
    if (source.startsWith('/')) {
      // Absolute path
      return { path: source };
    }
    if (source.startsWith('../')) {
      // Relative path going "up" - resolve from workspace root (cwd)
      return { path: join(process.cwd(), source) };
    }
    // Relative path within source - resolve from defaultSourcePath
    if (defaultSourcePath) {
      return { path: join(defaultSourcePath, source) };
    }
    // No defaultSourcePath - resolve from cwd
    return { path: join(process.cwd(), source) };
  }

  // Parse as GitHub source
  const parsed = parseFileSource(source);

  // GitHub source - need to resolve from cache
  if (
    parsed.type === 'github' &&
    parsed.owner &&
    parsed.repo &&
    parsed.filePath
  ) {
    const cacheKey = `${parsed.owner}/${parsed.repo}`;
    const cachePath = githubCache?.get(cacheKey);

    if (!cachePath) {
      return {
        path: '',
        error: `GitHub cache not found for ${cacheKey}. Ensure the repo is fetched.`,
      };
    }

    return { path: join(cachePath, parsed.filePath) };
  }

  // GitHub source without file path - invalid for file sources
  if (parsed.type === 'github') {
    return {
      path: '',
      error: `Invalid GitHub file source: ${source}. Must include path to file (e.g., owner/repo/path/to/file.md)`,
    };
  }

  return null;
}

/**
 * Copy workspace files from source to workspace root
 * Supports glob patterns with gitignore-style negation for string entries.
 * Object entries ({source, dest}) are copied directly without pattern expansion.
 *
 * File source resolution:
 * - String entries: resolved relative to sourcePath (supports globs)
 * - Object entries with explicit source: resolved directly (local path or GitHub URL)
 * - Object entries without source: dest is used as path relative to sourcePath
 *
 * @param sourcePath - Path to source directory (resolved workspace.source), can be undefined if all files have explicit source
 * @param workspacePath - Path to workspace directory
 * @param files - Array of workspace file entries (strings support globs, objects are literal)
 * @param options - Copy options (dryRun, githubCache)
 * @returns Array of copy results
 */
export async function copyWorkspaceFiles(
  sourcePath: string | undefined,
  workspacePath: string,
  files: WorkspaceFile[],
  options: WorkspaceCopyOptions = {},
): Promise<CopyResult[]> {
  const {
    dryRun = false,
    githubCache,
    repositories = [],
    skillsIndexRefs = [],
  } = options;
  const results: CopyResult[] = [];

  // Separate string patterns from object entries
  const stringPatterns: string[] = [];
  const objectEntries: Array<{ source?: string; dest: string }> = [];

  // Track which agent files were copied for WORKSPACE-RULES injection
  const copiedAgentFiles: string[] = [];

  for (const file of files) {
    if (typeof file === 'string') {
      stringPatterns.push(file);
    } else {
      // Compute dest from source basename if not provided
      let dest = file.dest;
      if (!dest && file.source) {
        // Extract basename from source (handles both local paths and GitHub paths)
        const parts = file.source.split('/');
        dest = parts[parts.length - 1] || file.source;
      }
      if (!dest) {
        // Neither source nor dest provided - this is invalid
        results.push({
          source: 'unknown',
          destination: join(workspacePath, 'unknown'),
          action: 'failed',
          error: 'File entry must have at least source or dest specified',
        });
        continue;
      }
      objectEntries.push(
        file.source ? { source: file.source, dest } : { dest },
      );
    }
  }

  // Process string patterns through glob resolution (requires sourcePath)
  if (stringPatterns.length > 0) {
    if (!sourcePath) {
      // String patterns require a source path
      for (const pattern of stringPatterns) {
        if (!isGlobPattern(pattern) && !pattern.startsWith('!')) {
          results.push({
            source: pattern,
            destination: join(workspacePath, pattern),
            action: 'failed',
            error: `Cannot resolve file '${pattern}' - no workspace.source configured and no explicit source provided`,
          });
        }
      }
    } else {
      const resolvedFiles = await resolveGlobPatterns(
        sourcePath,
        stringPatterns,
      );
      for (const resolved of resolvedFiles) {
        const destPath = join(workspacePath, resolved.relativePath);

        if (!existsSync(resolved.sourcePath)) {
          // Only report error for literal (non-glob) patterns
          const wasLiteral = stringPatterns.some(
            (p) =>
              !isGlobPattern(p) &&
              !p.startsWith('!') &&
              p === resolved.relativePath,
          );
          if (wasLiteral) {
            results.push({
              source: resolved.sourcePath,
              destination: destPath,
              action: 'failed',
              error: `Source file not found: ${resolved.sourcePath}`,
            });
          }
          continue;
        }

        if (dryRun) {
          results.push({
            source: resolved.sourcePath,
            destination: destPath,
            action: 'copied',
          });
          // Track agent files even in dry-run for accurate reporting
          if (
            (AGENT_FILES as readonly string[]).includes(resolved.relativePath)
          ) {
            copiedAgentFiles.push(resolved.relativePath);
          }
          continue;
        }

        try {
          await mkdir(dirname(destPath), { recursive: true });
          const content = await readFile(resolved.sourcePath, 'utf-8');
          await writeFile(destPath, content, 'utf-8');
          results.push({
            source: resolved.sourcePath,
            destination: destPath,
            action: 'copied',
          });

          // Track if this is an agent file
          if (
            (AGENT_FILES as readonly string[]).includes(resolved.relativePath)
          ) {
            copiedAgentFiles.push(resolved.relativePath);
          }
        } catch (error) {
          results.push({
            source: resolved.sourcePath,
            destination: destPath,
            action: 'failed',
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    }
  }

  // Process object entries directly (no pattern support)
  for (const entry of objectEntries) {
    const destPath = join(workspacePath, entry.dest);
    let srcPath: string;

    if (entry.source) {
      // Has explicit source - resolve it (can be local or GitHub)
      const resolved = resolveFileSourcePath(
        entry.source,
        sourcePath,
        githubCache,
      );
      if (!resolved) {
        results.push({
          source: entry.source,
          destination: destPath,
          action: 'failed',
          error: `Failed to resolve source: ${entry.source}`,
        });
        continue;
      }
      if (resolved.error) {
        results.push({
          source: entry.source,
          destination: destPath,
          action: 'failed',
          error: resolved.error,
        });
        continue;
      }
      srcPath = resolved.path;
    } else {
      // No explicit source - use dest as path relative to sourcePath
      if (!sourcePath) {
        results.push({
          source: entry.dest,
          destination: destPath,
          action: 'failed',
          error: `Cannot resolve file '${entry.dest}' - no workspace.source configured and no explicit source provided`,
        });
        continue;
      }
      srcPath = join(sourcePath, entry.dest);
    }

    if (!existsSync(srcPath)) {
      results.push({
        source: srcPath,
        destination: destPath,
        action: 'failed',
        error: `Source file not found: ${srcPath}`,
      });
      continue;
    }

    if (dryRun) {
      results.push({
        source: srcPath,
        destination: destPath,
        action: 'copied',
      });
      // Track agent files even in dry-run for accurate reporting
      if ((AGENT_FILES as readonly string[]).includes(entry.dest)) {
        copiedAgentFiles.push(entry.dest);
      }
      continue;
    }

    try {
      await mkdir(dirname(destPath), { recursive: true });
      const content = await readFile(srcPath, 'utf-8');
      await writeFile(destPath, content, 'utf-8');
      results.push({
        source: srcPath,
        destination: destPath,
        action: 'copied',
      });

      // Track if this is an agent file
      if ((AGENT_FILES as readonly string[]).includes(entry.dest)) {
        copiedAgentFiles.push(entry.dest);
      }
    } catch (error) {
      results.push({
        source: srcPath,
        destination: destPath,
        action: 'failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Inject WORKSPACE-RULES into all copied agent files (idempotent)
  // Skip when repositories is empty — rules reference repository paths that don't exist
  if (!dryRun && repositories.length > 0) {
    for (const agentFile of copiedAgentFiles) {
      const targetPath = join(workspacePath, agentFile);
      try {
        await ensureWorkspaceRules(targetPath, repositories, skillsIndexRefs);
      } catch (error) {
        results.push({
          source: 'WORKSPACE-RULES',
          destination: targetPath,
          action: 'failed',
          error:
            error instanceof Error
              ? error.message
              : 'Failed to inject WORKSPACE-RULES',
        });
      }
    }
  }

  return results;
}
