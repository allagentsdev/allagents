import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import chalk from 'chalk';
import {
  command,
  flag,
  option,
  optional,
  positional,
  restPositionals,
  string,
} from 'cmd-ts';
import {
  CONFIG_DIR,
  WORKSPACE_CONFIG_FILE,
  getHomeDir,
} from '../../constants.js';
import {
  addMarketplace,
  findMarketplaceRegistration,
  listMarketplacePlugins,
  updateMarketplace,
} from '../../core/marketplace.js';
import {
  fetchPlugin,
  getPluginName,
  seedFetchCache,
} from '../../core/plugin.js';
import {
  SkillSearchError,
  type SkillSearchItem,
  type SkillSearchOptions,
  qualifiedName,
  searchSkills,
} from '../../core/skill-search.js';
import {
  type DiscoveredSkillEntry,
  discoverSkillEntries,
  discoverSkillNames,
  findSkillByName,
  getAllSkillsFromPlugins,
} from '../../core/skills.js';
import { upsertSyncStateSource } from '../../core/sync-state.js';
import {
  mergeSyncResults,
  syncUserWorkspace,
  syncWorkspace,
} from '../../core/sync.js';
import type { SyncResult } from '../../core/sync.js';
import {
  addUserEnabledSkill,
  addUserPlugin,
  addUserPluginForTarget,
  getUserWorkspaceConfig,
  hasUserPlugin,
  isUserConfigPath,
  removeUserDisabledSkill,
  setUserPluginSkillsMode,
  upsertUserGitHubPluginSourceAllowlist,
} from '../../core/user-workspace.js';
import {
  addEnabledSkill,
  addPlugin,
  addPluginForTarget,
  hasPlugin,
  removeDisabledSkill,
  resolveGitHubIdentity,
  setPluginSkillsMode,
  upsertGitHubPluginSourceAllowlist,
} from '../../core/workspace-modify.js';
import {
  parseMarketplaceManifest,
  resolvePluginSourcePath,
} from '../../utils/marketplace-manifest-parser.js';
import {
  formatPluginSource,
  isGitHubUrl,
  parseGitHubUrl,
  stripGitRef,
} from '../../utils/plugin-path.js';
import {
  getPluginSource,
  type PluginEntry,
} from '../../models/workspace-config.js';
import { parseWorkspaceConfig } from '../../utils/workspace-parser.js';
import { parseSkillMetadata } from '../../validators/skill.js';
import {
  formatSyncHeader,
  formatSyncSummary,
  formatVerboseSyncLines,
} from '../format-sync.js';
import { buildDescription, conciseSubcommands } from '../help.js';
import { isJsonMode, jsonOutput } from '../json-output.js';
import {
  resolveInstallTarget,
  type InstallScope,
  type InstallScopeState,
  type ResolvedInstallTarget,
} from '../install-target.js';
import {
  createClackInstallTargetPromptPort,
  getInstallTargetEnvironment,
  isInteractiveInstallEnvironment,
} from '../tui/install-target-prompts.js';
import {
  skillsAddMeta,
  skillsListMeta,
  skillsRemoveMeta,
  skillsSearchMeta,
} from '../metadata/plugin-skills.js';
import { removeInstalledSkill } from '../skill-removal.js';
import { hasProjectSkillConfig } from '../skill-update.js';
import { skillUpdateCmd } from './skill-update.js';

/**
 * Determine effective scope when no --scope flag is provided.
 * Defaults to user scope unless cwd has a project config.
 */
function resolveScope(cwd: string): 'user' | 'project' {
  if (isUserConfigPath(cwd)) return 'user';
  if (hasProjectSkillConfig(cwd)) return 'project';
  return 'user';
}

type SkillInstallTargetOptions = {
  scope?: string | undefined;
  clients?: string | undefined;
  yes?: boolean | undefined;
};

type SkillInstallLocation = {
  scope: InstallScope;
  workspacePath: string;
};

type SkillInstallTargetContext = {
  workspacePath: string;
  options: SkillInstallTargetOptions;
  payload: string;
  scopeState(scope: InstallScope): Promise<InstallScopeState | null>;
  resolve(declaration: PluginEntry): Promise<ResolvedInstallTarget | null>;
};

function createSkillInstallTargetContext(
  workspacePath: string,
  payload: string,
  options: SkillInstallTargetOptions,
): SkillInstallTargetContext {
  let resolved: Promise<ResolvedInstallTarget | null> | undefined;
  let projectState: Promise<InstallScopeState | null> | undefined;
  let userState: Promise<InstallScopeState | null> | undefined;
  const environment = getInstallTargetEnvironment(isJsonMode());
  const loadProjectState = () => {
    projectState ??= (async () => {
      if (isUserConfigPath(workspacePath)) return null;
      const projectConfigPath = join(
        workspacePath,
        CONFIG_DIR,
        WORKSPACE_CONFIG_FILE,
      );
      if (!existsSync(projectConfigPath)) return null;
      const config = await parseWorkspaceConfig(projectConfigPath);
      return { clients: config.clients, plugins: config.plugins };
    })();
    return projectState;
  };
  const loadUserState = () => {
    userState ??= (async () => {
      const config = await getUserWorkspaceConfig();
      return config
        ? { clients: config.clients, plugins: config.plugins }
        : null;
    })();
    return userState;
  };
  return {
    workspacePath,
    options,
    payload,
    scopeState(scope) {
      return scope === 'user' ? loadUserState() : loadProjectState();
    },
    resolve(declaration) {
      resolved ??= resolveInstallTarget({
        workspacePath,
        declaration,
        action: 'Install skills',
        payload,
        scopeStates: {
          project: loadProjectState,
          user: loadUserState,
        },
        environment,
        ...(isInteractiveInstallEnvironment(environment) && {
          prompts: createClackInstallTargetPromptPort(),
        }),
        ...(options.scope !== undefined && { scope: options.scope }),
        ...(options.clients !== undefined && { clients: options.clients }),
        ...(options.yes !== undefined && { yes: options.yes }),
        defaultScope: 'project',
      });
      return resolved;
    },
  };
}

function declarationForSkillTarget(
  declaration: Exclude<PluginEntry, string>,
  target: ResolvedInstallTarget,
): Exclude<PluginEntry, string> {
  if (
    typeof target.prospectiveDeclaration !== 'string' &&
    getPluginSource(target.prospectiveDeclaration) === declaration.source
  ) {
    return target.prospectiveDeclaration;
  }
  if (target.disposition === 'override') {
    return { ...declaration, clients: [...target.clients] };
  }
  const { clients: _clients, ...inherited } = declaration;
  return inherited;
}

async function scopeContainsSkillSource(
  source: string,
  state: InstallScopeState | null,
): Promise<boolean> {
  if (!state) return false;
  if (state.plugins?.some((entry) => getPluginSource(entry) === source)) {
    return true;
  }
  const identity = await resolveGitHubIdentity(source);
  if (!identity) return false;
  for (const entry of state.plugins ?? []) {
    if ((await resolveGitHubIdentity(getPluginSource(entry))) === identity) {
      return true;
    }
  }
  return false;
}

async function installedSkillSourceScope(
  source: string,
  context: SkillInstallTargetContext,
): Promise<InstallScope | null> {
  if (isUserConfigPath(context.workspacePath)) {
    return (await scopeContainsSkillSource(
      source,
      await context.scopeState('user'),
    ))
      ? 'user'
      : null;
  }
  const [installedInProject, installedForUser] = await Promise.all([
    context
      .scopeState('project')
      .then((state) => scopeContainsSkillSource(source, state))
      .catch(() => false),
    context
      .scopeState('user')
      .then((state) => scopeContainsSkillSource(source, state))
      .catch(() => false),
  ]);
  if (installedInProject && installedForUser) {
    return context.options.scope === 'user' ? 'user' : 'project';
  }
  if (installedInProject) return 'project';
  if (installedForUser) return 'user';
  return null;
}

function installLocation(
  scope: InstallScope,
  projectWorkspacePath: string,
): SkillInstallLocation {
  return {
    scope,
    workspacePath: scope === 'user' ? getHomeDir() : projectWorkspacePath,
  };
}

function installLocations(
  scopes: ReadonlySet<InstallScope>,
  projectWorkspacePath: string,
): SkillInstallLocation[] {
  const locations: SkillInstallLocation[] = [];
  if (scopes.has('user')) {
    locations.push(installLocation('user', projectWorkspacePath));
  }
  if (scopes.has('project')) {
    locations.push(installLocation('project', projectWorkspacePath));
  }
  return locations;
}

async function syncSkillInstallScopes(
  scopes: ReadonlySet<InstallScope>,
  projectWorkspacePath: string,
): Promise<SyncResult> {
  const results: SyncResult[] = [];
  if (scopes.has('user')) {
    results.push(await syncUserWorkspace());
  }
  if (scopes.has('project')) {
    results.push(await syncWorkspace(projectWorkspacePath));
  }
  const [first, ...rest] = results;
  if (!first) {
    throw new Error('Cannot sync a skill install without an affected scope.');
  }
  return rest.reduce(mergeSyncResults, first);
}

async function addSkillDeclarationForTarget(
  declaration: Exclude<PluginEntry, string>,
  context: SkillInstallTargetContext,
): Promise<
  | { status: 'installed'; scope: InstallScope; normalizedPlugin?: string }
  | { status: 'cancelled' }
  | { status: 'failed'; error: string }
> {
  const target = await context.resolve(declaration);
  if (!target) return { status: 'cancelled' };
  const targetedDeclaration = declarationForSkillTarget(declaration, target);
  const installTarget = {
    declaration: targetedDeclaration,
    clients: target.clients,
    ...(isGitHubUrl(targetedDeclaration.source) && {
      sourceValidation: 'declaration' as const,
    }),
  };
  const result =
    target.scope === 'user'
      ? await addUserPluginForTarget(installTarget)
      : await addPluginForTarget(installTarget, context.workspacePath);
  if (!result.success) {
    return {
      status: 'failed',
      error: result.error ?? 'Unknown error',
    };
  }
  return {
    status: 'installed',
    scope: target.scope,
    ...(result.normalizedPlugin && {
      normalizedPlugin: result.normalizedPlugin,
    }),
  };
}

/**
 * Record per-source provenance (resolvedRef + resolvedSha + optional requested ref)
 * into sync-state for the given install. Identity for git-based plugins is
 * `url + ref`; `resolvedSha` (from `git rev-parse HEAD` after fetch) gives
 * content identity, so per-skill content hashing is unnecessary.
 *
 * The source key is the spec with any `@<ref>` suffix stripped so all installs
 * of `owner/repo` map to one entry regardless of requested ref.
 *
 * No-op for non-GitHub sources (local paths, marketplace shorthand) since we
 * can't resolve a SHA from them.
 */
async function recordSourceProvenance(opts: {
  from: string;
  requestedRef?: string | undefined;
  workspacePath: string;
  isUser: boolean;
}): Promise<void> {
  const { from, requestedRef, workspacePath, isUser } = opts;
  if (!isGitHubUrl(from)) return;
  const parsed = parseGitHubUrl(from);
  if (!parsed) return;

  const fetchResult = await fetchPlugin(from, {
    ...(parsed.branch && { branch: parsed.branch }),
  });
  if (!fetchResult.success || !fetchResult.resolvedSha) return;

  const stateRoot = isUser ? getHomeDir() : workspacePath;
  const key = stripGitRef(`${parsed.owner}/${parsed.repo}`);

  await upsertSyncStateSource(stateRoot, key, {
    pluginSpec: key,
    resolvedRef: fetchResult.resolvedRef ?? parsed.branch ?? 'HEAD',
    resolvedSha: fetchResult.resolvedSha,
    ...(requestedRef && { requestedRef }),
  });
}
async function recordSourceProvenanceAtLocations(opts: {
  from: string;
  requestedRef?: string | undefined;
  locations: readonly SkillInstallLocation[];
}): Promise<void> {
  const seen = new Set<string>();
  await Promise.all(
    opts.locations.map((location) => {
      const key = `${location.scope}:${location.workspacePath}`;
      if (seen.has(key)) return Promise.resolve();
      seen.add(key);
      return recordSourceProvenance({
        from: opts.from,
        requestedRef: opts.requestedRef,
        workspacePath: location.workspacePath,
        isUser: location.scope === 'user',
      });
    }),
  );
}

function reportSkillInstallCancellation(): void {
  if (!isJsonMode()) {
    console.log('Install cancelled. No changes made.');
  }
}


export function resolveFetchedSourcePath(
  source: string,
  cachePath: string,
): string {
  if (!isGitHubUrl(source)) return cachePath;
  const parsed = parseGitHubUrl(source);
  return parsed?.subpath ? join(cachePath, parsed.subpath) : cachePath;
}

/**
 * Extract the inline `@<ref>` suffix from a plugin source spec, if present.
 * Only matches owner/repo-style sources (must have a slash before the `@`),
 * so `plugin@marketplace` returns undefined.
 */
function extractInlineRef(spec: string): string | undefined {
  const slashIdx = spec.indexOf('/');
  if (slashIdx === -1) return undefined;
  const atIdx = spec.indexOf('@', slashIdx);
  if (atIdx === -1) return undefined;
  const ref = spec.slice(atIdx + 1);
  // If the @ref contains another slash, it's the subpath portion; the ref is
  // the chunk between @ and the next slash.
  const nextSlash = ref.indexOf('/');
  const cleanRef = nextSlash === -1 ? ref : ref.slice(0, nextSlash);
  return cleanRef.length > 0 ? cleanRef : undefined;
}

/**
 * If the skill argument is a GitHub URL, extract the skill name and return
 * it along with the URL as the plugin source. Returns null if not a URL.
 *
 * With subpath: skill name = last path segment. A URL ending in SKILL.md is
 * normalized to its containing skill directory.
 * Without subpath: skill name = repo name (caller should use resolveSkillNameFromRepo to check frontmatter)
 */
export function resolveSkillFromUrl(skill: string): {
  skill: string;
  from: string;
  parsed: ReturnType<typeof parseGitHubUrl>;
} | null {
  if (!isGitHubUrl(skill)) return null;

  const parsed = parseGitHubUrl(skill);
  if (!parsed) return null;

  if (parsed.subpath) {
    const segments = parsed.subpath.split('/').filter(Boolean);
    if (segments.at(-1) === 'SKILL.md') {
      const from = skill.slice(0, -'/SKILL.md'.length);
      const containingParsed = parseGitHubUrl(from);
      if (!containingParsed) return null;
      return {
        skill: segments.at(-2) ?? parsed.repo,
        from,
        parsed: containingParsed,
      };
    }

    const name = segments.at(-1);
    if (!name) return null;
    return { skill: name, from: skill, parsed };
  }

  return { skill: parsed.repo, from: skill, parsed };
}

/**
 * For a no-subpath GitHub URL, fetch the repo and read SKILL.md frontmatter
 * to get the real skill name. Falls back to the provided default name.
 */
export async function resolveSkillNameFromRepo(
  url: string,
  parsed: NonNullable<ReturnType<typeof parseGitHubUrl>>,
  fallbackName: string,
  fetchFn: typeof fetchPlugin = fetchPlugin,
): Promise<string> {
  const fetchResult = await fetchFn(url, {
    ...(parsed.branch && { branch: parsed.branch }),
  });
  if (!fetchResult.success) return fallbackName;

  try {
    const skillMd = await readFile(
      join(fetchResult.cachePath, 'SKILL.md'),
      'utf-8',
    );
    const metadata = parseSkillMetadata(skillMd);
    return metadata?.name ?? fallbackName;
  } catch {
    return fallbackName;
  }
}

/**
 * Group skills by plugin for display
 */
function groupSkillsByPlugin(
  skills: Array<{
    name: string;
    pluginName: string;
    pluginSource: string;
    disabled: boolean;
    skillSubpath?: string;
  }>,
): Map<
  string,
  {
    source: string;
    skills: Array<{ name: string; subpath: string; disabled: boolean }>;
  }
> {
  const grouped = new Map<
    string,
    {
      source: string;
      skills: Array<{ name: string; subpath: string; disabled: boolean }>;
    }
  >();

  for (const skill of skills) {
    const entry = {
      name: skill.name,
      subpath: skill.skillSubpath ?? skill.name,
      disabled: skill.disabled,
    };
    const existing = grouped.get(skill.pluginName);
    if (existing) {
      existing.skills.push(entry);
    } else {
      grouped.set(skill.pluginName, {
        source: skill.pluginSource,
        skills: [entry],
      });
    }
  }

  return grouped;
}

// =============================================================================
// plugin skills list
// =============================================================================

const listCmd = command({
  name: 'list',
  description: buildDescription(skillsListMeta),
  args: {
    scope: option({
      type: optional(string),
      long: 'scope',
      short: 's',
      description: 'Scope: "project" (default) or "user"',
    }),
  },
  handler: async ({ scope }) => {
    try {
      const cwd = process.cwd();
      const inProjectDir = !isUserConfigPath(cwd) && hasProjectSkillConfig(cwd);

      // Resolve which scopes to display
      const showUser = scope !== 'project';
      const showProject = scope === 'project' || (!scope && inProjectDir);

      const userSkills = showUser
        ? await getAllSkillsFromPlugins(getHomeDir())
        : [];
      const projectSkills = showProject
        ? await getAllSkillsFromPlugins(cwd)
        : [];

      // For dedup: if same plugin:skill exists in both, only show in user
      const userKeys = new Set(
        userSkills.map((s) => `${s.pluginName}:${s.name}`),
      );
      const dedupedProjectSkills = projectSkills.filter(
        (s) => !userKeys.has(`${s.pluginName}:${s.name}`),
      );

      if (isJsonMode()) {
        const effectiveScope =
          scope === 'user' ? 'user' : scope === 'project' ? 'project' : 'all';
        const allSkills = [...userSkills, ...dedupedProjectSkills];
        jsonOutput({
          success: true,
          command: 'skill list',
          data: {
            scope: effectiveScope,
            skills: allSkills.map((s) => ({
              name: s.name,
              plugin: s.pluginName,
              disabled: s.disabled,
            })),
          },
        });
        return;
      }

      if (userSkills.length === 0 && dedupedProjectSkills.length === 0) {
        console.log('No skills found. Install a plugin first with:');
        console.log('  allagents plugin install <plugin>');
        return;
      }

      // Display user skills
      if (userSkills.length > 0 && scope !== 'project') {
        console.log(`\n${chalk.whiteBright('User Skills:')}`);
        const grouped = groupSkillsByPlugin(userSkills);
        for (const [pluginName, data] of grouped) {
          console.log(
            `\n${chalk.hex('#89b4fa')(pluginName)} (${formatPluginSource(data.source)}):`,
          );
          for (const skill of data.skills) {
            const icon = skill.disabled ? '\u2717' : '\u2713';
            const status = skill.disabled ? ' (disabled)' : '';
            const displayName =
              skill.subpath !== skill.name ? skill.subpath : skill.name;
            console.log(`  ${icon} ${displayName}${status}`);
          }
        }
      }

      // Display project skills
      if (dedupedProjectSkills.length > 0) {
        console.log(`\n${chalk.whiteBright('Project Skills:')}`);
        const grouped = groupSkillsByPlugin(dedupedProjectSkills);
        for (const [pluginName, data] of grouped) {
          console.log(
            `\n${chalk.hex('#89b4fa')(pluginName)} (${formatPluginSource(data.source)}):`,
          );
          for (const skill of data.skills) {
            const icon = skill.disabled ? '\u2717' : '\u2713';
            const status = skill.disabled ? ' (disabled)' : '';
            const displayName =
              skill.subpath !== skill.name ? skill.subpath : skill.name;
            console.log(`  ${icon} ${displayName}${status}`);
          }
        }
      }
      console.log();
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({
            success: false,
            command: 'skill list',
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
// plugin skills remove
// =============================================================================

const removeCmd = command({
  name: 'remove',
  description: buildDescription(skillsRemoveMeta),
  args: {
    skill: positional({ type: string, displayName: 'skill' }),
    scope: option({
      type: optional(string),
      long: 'scope',
      short: 's',
      description: 'Scope: "project" (default) or "user"',
    }),
    plugin: option({
      type: optional(string),
      long: 'plugin',
      short: 'p',
      description: 'Plugin name (required if skill exists in multiple plugins)',
    }),
  },
  handler: async ({ skill, scope, plugin }) => {
    try {
      const isUser =
        scope === 'user' || (!scope && resolveScope(process.cwd()) === 'user');
      const workspacePath = isUser ? getHomeDir() : process.cwd();

      // Find the skill
      const allSkills = await getAllSkillsFromPlugins(workspacePath);
      const matches = allSkills.filter((candidate) => candidate.name === skill);

      if (matches.length === 0) {
        const skillNames = [...new Set(allSkills.map((s) => s.name))].join(
          ', ',
        );
        const error = `Skill '${skill}' not found in any installed plugin.\n\nAvailable skills: ${skillNames || 'none'}`;
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'skill remove', error });
          process.exit(1);
        }
        console.error(`Error: ${error}`);
        process.exit(1);
      }

      // Handle ambiguity
      let targetSkill = matches[0];
      if (!targetSkill) {
        // This should never happen since we checked matches.length === 0 above
        throw new Error('Unexpected empty matches array');
      }
      if (matches.length > 1) {
        if (!plugin) {
          const pluginList = matches
            .map((m) => `  - ${m.pluginName} (${m.pluginSource})`)
            .join('\n');
          const error = `'${skill}' exists in multiple plugins:\n${pluginList}\n\nUse --plugin to specify: allagents skill remove ${skill} --plugin <name>`;
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill remove', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }
        const filtered = matches.find((m) => m.pluginName === plugin);
        if (!filtered) {
          const error = `Plugin '${plugin}' not found. Installed plugins: ${matches.map((m) => m.pluginName).join(', ')}`;
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill remove', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }
        targetSkill = filtered;
      }

      // Check if already disabled
      if (targetSkill.disabled) {
        const msg = `Skill '${skill}' is already disabled.`;
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'skill remove', error: msg });
          process.exit(1);
        }
        console.log(msg);
        return;
      }

      const result = await removeInstalledSkill({
        targetSkill,
        isUser,
        workspacePath,
        allSkills,
      });
      if (!result.success) {
        if (isJsonMode()) {
          jsonOutput({
            success: false,
            command: 'skill remove',
            error: result.error ?? 'Unknown error',
          });
          process.exit(1);
        }
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      if (!isJsonMode()) {
        if (result.action === 'removed-plugin') {
          console.log(`\u2713 Removed plugin: ${targetSkill.pluginSource}`);
        } else if (result.action === 'removed-skill') {
          console.log(
            `\u2713 Removed skill: ${skill} (${targetSkill.pluginName})`,
          );
        } else {
          console.log(
            `\u2713 Disabled skill: ${skill} (${targetSkill.pluginName})`,
          );
        }
      }

      const syncResult = isUser
        ? await syncUserWorkspace()
        : await syncWorkspace(workspacePath);

      if (isJsonMode()) {
        jsonOutput({
          success: syncResult.success,
          command: 'skill remove',
          data: {
            skill,
            plugin: targetSkill.pluginName,
            syncResult: {
              copied: syncResult.totalCopied,
              failed: syncResult.totalFailed,
            },
          },
        });
        if (!syncResult.success) process.exit(1);
        return;
      }
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({
            success: false,
            command: 'skill remove',
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
// Install skill from --from source (marketplace-aware)
// =============================================================================

type InstallSkillResult =
  | {
      success: true;
      pluginName: string;
      syncResult: { copied: number; failed: number };
      location: SkillInstallLocation;
    }
  | { success: false; error: string }
  | { success: 'cancelled' };

/**
 * Install a skill from a --from source. If the source is a marketplace
 * (has .claude-plugin/marketplace.json), register/update the marketplace,
 * find the plugin containing the skill, and install it via plugin@marketplace.
 * Otherwise, install the source directly as a plugin.
 *
 * In both cases, set the plugin to allowlist mode with only the requested skill.
 */
type InstallSkillFromSourceDeps = {
  fetchPlugin?: typeof fetchPlugin;
  parseMarketplaceManifest?: typeof parseMarketplaceManifest;
  installSkillViaMarketplace?: typeof installSkillViaMarketplace;
  installSkillDirect?: typeof installSkillDirect;
};

export async function installSkillFromSource(
  opts: {
    skill: string;
    from: string;
    isUser: boolean;
    workspacePath: string;
    targetContext?: SkillInstallTargetContext | undefined;
  },
  deps: InstallSkillFromSourceDeps = {},
): Promise<InstallSkillResult> {
  const { skill, from, isUser, workspacePath, targetContext } = opts;
  const fetchPluginFn = deps.fetchPlugin ?? fetchPlugin;
  const parseMarketplaceManifestFn =
    deps.parseMarketplaceManifest ?? parseMarketplaceManifest;
  const installSkillViaMarketplaceFn =
    deps.installSkillViaMarketplace ?? installSkillViaMarketplace;
  const installSkillDirectFn = deps.installSkillDirect ?? installSkillDirect;

  if (!isJsonMode()) {
    console.log(`Installing skill '${skill}' from ${from}...`);
  }

  // Fetch the source to a local cache so we can inspect it
  const parsed = isGitHubUrl(from) ? parseGitHubUrl(from) : null;
  const fetchResult = await fetchPluginFn(from, {
    ...(parsed?.branch && { branch: parsed.branch }),
  });
  if (!fetchResult.success) {
    return {
      success: false,
      error: `Failed to fetch '${from}': ${fetchResult.error ?? 'Unknown error'}`,
    };
  }

  const sourcePath = resolveFetchedSourcePath(from, fetchResult.cachePath);

  // Check if the source is a marketplace
  const manifestResult = await parseMarketplaceManifestFn(sourcePath);

  if (manifestResult.success) {
    return installSkillViaMarketplaceFn({
      skill,
      from,
      isUser,
      workspacePath,
      ...(targetContext && { targetContext }),
    });
  }

  // Not a marketplace — install as a direct plugin
  return installSkillDirectFn({
    skill,
    from,
    isUser,
    workspacePath,
    sourcePath,
    ...(targetContext && { targetContext }),
  });
}

async function ensureMarketplaceRegistrationForScope(opts: {
  from: string;
  marketplaceName: string;
  scope: InstallScope;
  projectWorkspacePath: string;
}): Promise<
  | { success: true; marketplaceName: string; workspacePath: string }
  | { success: false; error: string }
> {
  const { from, scope, projectWorkspacePath } = opts;
  const parsed = isGitHubUrl(from) ? parseGitHubUrl(from) : null;
  const sourceLocation = parsed ? `${parsed.owner}/${parsed.repo}` : undefined;
  const lookupWorkspace =
    scope === 'project' ? projectWorkspacePath : undefined;
  const visible = await findMarketplaceRegistration(
    opts.marketplaceName,
    sourceLocation,
    lookupWorkspace,
  );
  if (visible?.scope === scope) {
    return {
      success: true,
      marketplaceName: visible.key,
      workspacePath:
        scope === 'user' ? getHomeDir() : projectWorkspacePath,
    };
  }

  const scopeOptions =
    scope === 'project'
      ? { scope: 'project' as const, workspacePath: projectWorkspacePath }
      : undefined;
  const result = await addMarketplace(
    from,
    opts.marketplaceName,
    parsed?.branch ?? undefined,
    scopeOptions,
  );
  if (!result.success || !result.marketplace?.name) {
    return {
      success: false,
      error: result.error ?? `Failed to register marketplace from '${from}'`,
    };
  }
  return {
    success: true,
    marketplaceName: result.marketplace.name,
    workspacePath: scope === 'user' ? getHomeDir() : projectWorkspacePath,
  };
}

type MarketplaceSkillSelection = {
  pluginName: string;
  skills: string[];
};

async function applyMarketplaceSkillSelections(opts: {
  from: string;
  marketplaceName: string;
  registrationScope: InstallScope;
  selections: MarketplaceSkillSelection[];
  isUser: boolean;
  projectWorkspacePath: string;
  targetContext?: SkillInstallTargetContext | undefined;
}): Promise<
  | {
      success: true;
      installed: MarketplaceSkillSelection[];
      changedScopes: Set<InstallScope>;
    }
  | { success: false; error: string }
  | { success: 'cancelled' }
> {
  const {
    from,
    selections,
    projectWorkspacePath,
    targetContext,
  } = opts;
  let { marketplaceName, registrationScope } = opts;
  const discovered = await Promise.all(
    selections.map(async (selection) => {
      const pluginSpec = `${selection.pluginName}@${marketplaceName}`;
      const existingScope = targetContext
        ? await installedSkillSourceScope(pluginSpec, targetContext)
        : null;
      return { ...selection, pluginSpec, existingScope };
    }),
  );
  const firstNew = discovered.find((entry) => !entry.existingScope);
  let targetScope: InstallScope | undefined;
  if (targetContext && firstNew) {
    const target = await targetContext.resolve({
      source: firstNew.pluginSpec,
      install: 'file',
      skills: firstNew.skills,
    });
    if (!target) return { success: 'cancelled' };
    targetScope = target.scope;
    const ensured = await ensureMarketplaceRegistrationForScope({
      from,
      marketplaceName,
      scope: target.scope,
      projectWorkspacePath,
    });
    if (!ensured.success) return ensured;
    marketplaceName = ensured.marketplaceName;
    registrationScope = target.scope;
  }

  await updateMarketplace(
    marketplaceName,
    registrationScope === 'user' ? undefined : projectWorkspacePath,
  );
  const installed: MarketplaceSkillSelection[] = [];
  const changedScopes = new Set<InstallScope>();
  for (const entry of discovered) {
    let pluginScope: InstallScope =
      entry.existingScope ??
      targetScope ??
      (opts.isUser ? 'user' : 'project');
    const pluginSpec = `${entry.pluginName}@${marketplaceName}`;
    if (entry.existingScope) {
      const setModeResult =
        pluginScope === 'user'
          ? await setUserPluginSkillsMode(
              entry.pluginName,
              'allowlist',
              entry.skills,
            )
          : await setPluginSkillsMode(
              entry.pluginName,
              'allowlist',
              entry.skills,
              projectWorkspacePath,
            );
      if (!setModeResult.success) {
        return {
          success: false,
          error: `Failed to configure skill allowlist for '${entry.pluginName}': ${setModeResult.error ?? 'Unknown error'}`,
        };
      }
    } else if (targetContext) {
      const installResult = await addSkillDeclarationForTarget(
        { source: pluginSpec, install: 'file', skills: entry.skills },
        targetContext,
      );
      if (installResult.status === 'cancelled') {
        return { success: 'cancelled' };
      }
      if (installResult.status === 'failed') {
        return {
          success: false,
          error: `Failed to install plugin '${pluginSpec}': ${installResult.error}`,
        };
      }
      pluginScope = installResult.scope;
    } else {
      const installResult =
        pluginScope === 'user'
          ? await addUserPlugin(pluginSpec)
          : await addPlugin(pluginSpec, projectWorkspacePath);
      if (!installResult.success) {
        return {
          success: false,
          error: `Failed to install plugin '${pluginSpec}': ${installResult.error ?? 'Unknown error'}`,
        };
      }
      const setModeResult =
        pluginScope === 'user'
          ? await setUserPluginSkillsMode(
              entry.pluginName,
              'allowlist',
              entry.skills,
            )
          : await setPluginSkillsMode(
              entry.pluginName,
              'allowlist',
              entry.skills,
              projectWorkspacePath,
            );
      if (!setModeResult.success) {
        return {
          success: false,
          error: `Failed to configure skill allowlist for '${entry.pluginName}': ${setModeResult.error ?? 'Unknown error'}`,
        };
      }
    }
    changedScopes.add(pluginScope);
    installed.push({ pluginName: entry.pluginName, skills: entry.skills });
  }
  return { success: true, installed, changedScopes };
}

/**
 * Source is a marketplace: register it, find the plugin with the skill, install via spec.
 */
async function installSkillViaMarketplace(opts: {
  skill: string;
  from: string;
  isUser: boolean;
  workspacePath: string;
  targetContext?: SkillInstallTargetContext | undefined;
}): Promise<InstallSkillResult> {
  let { isUser, workspacePath } = opts;
  const { skill, from, targetContext } = opts;
  const projectWorkspacePath = targetContext?.workspacePath ?? workspacePath;
  const parsed = isGitHubUrl(from) ? parseGitHubUrl(from) : null;
  const sourceLocation = parsed ? `${parsed.owner}/${parsed.repo}` : undefined;
  let registration = await findMarketplaceRegistration(
    parsed?.repo ?? from,
    sourceLocation,
    targetContext ? projectWorkspacePath : isUser ? undefined : workspacePath,
  );
  let marketplaceName =
    registration?.key ??
    (parsed?.branch
      ? `${parsed.repo}-${parsed.branch}`
      : (parsed?.repo ?? getPluginName(from)));

  if (!registration) {
    let scope: InstallScope = isUser ? 'user' : 'project';
    if (targetContext) {
      const target = await targetContext.resolve({
        source: from,
        install: 'file',
        skills: [skill],
      });
      if (!target) return { success: 'cancelled' };
      scope = target.scope;
    }
    const ensured = await ensureMarketplaceRegistrationForScope({
      from,
      marketplaceName,
      scope,
      projectWorkspacePath,
    });
    if (!ensured.success) return ensured;
    marketplaceName = ensured.marketplaceName;
    isUser = scope === 'user';
    workspacePath = ensured.workspacePath;
    registration = await findMarketplaceRegistration(
      marketplaceName,
      sourceLocation,
      isUser ? undefined : projectWorkspacePath,
    );
  } else {
    isUser = registration.scope === 'user';
    workspacePath = isUser ? getHomeDir() : projectWorkspacePath;
  }

  const mktPlugins = await listMarketplacePlugins(
    marketplaceName,
    isUser ? undefined : workspacePath,
  );
  if (mktPlugins.plugins.length === 0) {
    return {
      success: false,
      error: `No plugins found in marketplace '${marketplaceName}'.`,
    };
  }

  let targetPluginName: string | null = null;
  const allAvailableSkills: string[] = [];
  for (const mktPlugin of mktPlugins.plugins) {
    const skillNames = mktPlugin.skills
      ? mktPlugin.skills.map((entry) => entry.split('/').pop() ?? '').filter(Boolean)
      : await discoverSkillNames(mktPlugin.path);
    allAvailableSkills.push(...skillNames);
    if (!targetPluginName && skillNames.includes(skill)) {
      targetPluginName = mktPlugin.name;
    }
  }
  if (!targetPluginName) {
    return {
      success: false,
      error: `Skill '${skill}' not found in marketplace '${marketplaceName}'.\n\nAvailable skills: ${allAvailableSkills.join(', ') || 'none'}`,
    };
  }

  const pluginSpec = `${targetPluginName}@${marketplaceName}`;
  const existingScope = targetContext
    ? await installedSkillSourceScope(pluginSpec, targetContext)
    : isUser
      ? (await hasUserPlugin(pluginSpec))
        ? 'user'
        : null
      : (await hasPlugin(pluginSpec, workspacePath))
        ? 'project'
        : null;
  if (existingScope) {
    isUser = existingScope === 'user';
    workspacePath = isUser ? getHomeDir() : projectWorkspacePath;
    await updateMarketplace(
      marketplaceName,
      registration?.scope === 'user' ? undefined : projectWorkspacePath,
    );
    return applySkillAllowlist({
      skill,
      pluginName: targetPluginName,
      isUser,
      workspacePath,
    });
  }

  if (targetContext) {
    const target = await targetContext.resolve({
      source: pluginSpec,
      install: 'file',
      skills: [skill],
    });
    if (!target) return { success: 'cancelled' };
    const ensured = await ensureMarketplaceRegistrationForScope({
      from,
      marketplaceName,
      scope: target.scope,
      projectWorkspacePath,
    });
    if (!ensured.success) return ensured;
    marketplaceName = ensured.marketplaceName;
    const targetedSpec = `${targetPluginName}@${marketplaceName}`;
    await updateMarketplace(
      marketplaceName,
      target.scope === 'user' ? undefined : projectWorkspacePath,
    );
    const installResult = await addSkillDeclarationForTarget(
      { source: targetedSpec, install: 'file', skills: [skill] },
      targetContext,
    );
    if (installResult.status === 'cancelled') return { success: 'cancelled' };
    if (installResult.status === 'failed') {
      return {
        success: false,
        error: `Failed to install plugin '${targetedSpec}': ${installResult.error}`,
      };
    }
    isUser = installResult.scope === 'user';
    workspacePath = isUser ? getHomeDir() : projectWorkspacePath;
    return finishSkillEnable({
      skill,
      pluginName: targetPluginName,
      isUser,
      workspacePath,
    });
  }

  await updateMarketplace(marketplaceName, isUser ? undefined : workspacePath);
  const installResult = isUser
    ? await addUserPlugin(pluginSpec)
    : await addPlugin(pluginSpec, workspacePath);
  if (!installResult.success) {
    return {
      success: false,
      error: `Failed to install plugin '${pluginSpec}': ${installResult.error ?? 'Unknown error'}`,
    };
  }
  return applySkillAllowlist({
    skill,
    pluginName: targetPluginName,
    isUser,
    workspacePath,
  });
}

/**
 * Decide whether the positional argument to `skill add` is a plugin source
 * (npx-skills shape), an auto-install source, or a skill name (legacy shape).
 *
 * shape: 'source'      — GitHub spec + explicit selector (--skill/--list/--all)
 * shape: 'source-auto' — GitHub spec, no selector, no subpath: treat the repo
 *                        as a collection of skills and install all of them. This
 *                        mirrors `npx skills add owner/repo` where the repo is
 *                        just a transport for its skills, not a named entity.
 * shape: 'skill-name'  — everything else, including deep-URL forms with a
 *                        subpath (e.g. owner/repo/skills/foo) which are handled
 *                        by the legacy resolveSkillFromUrl path.
 */
export function classifySkillAddPositional(
  positional: string | undefined,
  skillFlag: string | undefined,
  list: boolean,
  all: boolean,
):
  | { shape: 'none' }
  | { shape: 'skill-name' }
  | { shape: 'source'; skills: string[] }
  | { shape: 'source-auto' } {
  if (!positional) return { shape: 'none' };
  const skills = skillFlag
    ? skillFlag
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const hasSelector = skills.length > 0 || list || all;
  if (isGitHubUrl(positional)) {
    if (hasSelector) return { shape: 'source', skills };
    // No subpath → the repo is a standalone skill or skill bundle; auto-install all.
    // Subpath → legacy deep-URL form handled by resolveSkillFromUrl.
    if (!parseGitHubUrl(positional)?.subpath) return { shape: 'source-auto' };
  }
  return { shape: 'skill-name' };
}

/**
 * Resolve a user-supplied skill spec (bare leaf name or `parent/leaf`) against
 * the available entries in a plugin. Returns the canonical identifier to
 * persist in the allowlist — bare leaf name when unambiguous, qualified
 * subpath when the leaf is shared by multiple nested skills.
 */
function resolveSkillSpec(
  spec: string,
  available: DiscoveredSkillEntry[],
): { canonical: string; matched: DiscoveredSkillEntry } | { error: string } {
  const exact = available.find((e) => e.subpath === spec);
  if (exact) {
    const canonical = exact.subpath === exact.name ? exact.name : exact.subpath;
    return { canonical, matched: exact };
  }

  const nameMatches = available.filter((e) => e.name === spec);
  if (nameMatches.length === 1) {
    const m = nameMatches[0] as DiscoveredSkillEntry;
    return { canonical: m.name, matched: m };
  }
  if (nameMatches.length > 1) {
    const paths = nameMatches.map((m) => m.subpath).join(', ');
    return {
      error: `Multiple skills named '${spec}': ${paths}. Use the qualified form (e.g., --skill ${nameMatches[0]?.subpath}) to choose one.`,
    };
  }

  const available_names = available.map((e) => e.subpath).join(', ');
  return {
    error: `Skill '${spec}' not found.\n\nAvailable skills: ${available_names || 'none'}`,
  };
}

/**
 * Source is not a marketplace — install the GitHub URL / path directly as a plugin.
 */
async function installSkillDirect(opts: {
  skill: string;
  from: string;
  isUser: boolean;
  workspacePath: string;
  sourcePath: string;
  targetContext?: SkillInstallTargetContext | undefined;
}): Promise<InstallSkillResult> {
  let { isUser, workspacePath } = opts;
  const { skill, from, sourcePath, targetContext } = opts;

  const availableEntries = await discoverSkillEntries(sourcePath);
  const resolved = resolveSkillSpec(skill, availableEntries);
  if ('error' in resolved) {
    return {
      success: false,
      error: `${resolved.error}\n\nTip: run \`allagents skill add --list --from ${from}\` to see all available skills.`,
    };
  }
  const canonicalSkill = resolved.canonical;
  const pluginName = isGitHubUrl(from)
    ? extractPrimaryPluginName(from)
    : getPluginName(sourcePath);

  if (targetContext) {
    const existingScope = await installedSkillSourceScope(from, targetContext);
    if (existingScope) {
      isUser = existingScope === 'user';
      workspacePath = isUser ? getHomeDir() : targetContext.workspacePath;
      if (isGitHubUrl(from)) {
        const existingEnabledSkills = await getEnabledSkillsForGitHubSource(
          from,
          workspacePath,
        );
        const desiredSkills = [...existingEnabledSkills];
        if (!desiredSkills.includes(canonicalSkill)) {
          desiredSkills.push(canonicalSkill);
        }
        const updateResult = isUser
          ? await upsertUserGitHubPluginSourceAllowlist(from, desiredSkills)
          : await upsertGitHubPluginSourceAllowlist(
              from,
              desiredSkills,
              workspacePath,
            );
        if (!updateResult.success) {
          return {
            success: false,
            error: `Failed to update plugin '${from}': ${updateResult.error ?? 'Unknown error'}`,
          };
        }
        return finishSkillEnable({
          skill: canonicalSkill,
          pluginName: extractPrimaryPluginName(
            updateResult.normalizedPlugin ?? from,
          ),
          isUser,
          workspacePath,
        });
      }
      return applySkillAllowlist({
        skill: canonicalSkill,
        pluginName,
        isUser,
        workspacePath,
      });
    }

    const installResult = await addSkillDeclarationForTarget(
      {
        source: from,
        install: 'file',
        skills: [canonicalSkill],
      },
      targetContext,
    );
    if (installResult.status === 'cancelled') return { success: 'cancelled' };
    if (installResult.status === 'failed') {
      return {
        success: false,
        error: `Failed to install plugin '${from}': ${installResult.error}`,
      };
    }
    isUser = installResult.scope === 'user';
    workspacePath = isUser ? getHomeDir() : targetContext.workspacePath;
    return finishSkillEnable({
      skill: canonicalSkill,
      pluginName: extractPrimaryPluginName(
        installResult.normalizedPlugin ?? pluginName,
      ),
      isUser,
      workspacePath,
    });
  }

  if (isGitHubUrl(from)) {
    const existingEnabledSkills = await getEnabledSkillsForGitHubSource(
      from,
      workspacePath,
    );
    const desiredSkills = [...existingEnabledSkills];
    if (!desiredSkills.includes(canonicalSkill)) {
      desiredSkills.push(canonicalSkill);
    }
    const updateResult = isUser
      ? await upsertUserGitHubPluginSourceAllowlist(from, desiredSkills)
      : await upsertGitHubPluginSourceAllowlist(
          from,
          desiredSkills,
          workspacePath,
        );
    if (!updateResult.success) {
      return {
        success: false,
        error: `Failed to update plugin '${from}': ${updateResult.error ?? 'Unknown error'}`,
      };
    }
    return finishSkillEnable({
      skill: canonicalSkill,
      pluginName: extractPrimaryPluginName(
        updateResult.normalizedPlugin ?? from,
      ),
      isUser,
      workspacePath,
    });
  }

  const installResult = isUser
    ? await addUserPlugin(from)
    : await addPlugin(from, workspacePath);
  if (!installResult.success) {
    if (
      !installResult.error?.includes('already exists') &&
      !installResult.error?.includes('duplicates existing')
    ) {
      return {
        success: false,
        error: `Failed to install plugin '${from}': ${installResult.error ?? 'Unknown error'}`,
      };
    }
    if (!isJsonMode()) console.log('Plugin already installed.');
  }
  return applySkillAllowlist({
    skill: canonicalSkill,
    pluginName,
    isUser,
    workspacePath,
  });
}

function extractPrimaryPluginName(source: string): string {
  const parsed = isGitHubUrl(source) ? parseGitHubUrl(source) : null;
  if (parsed?.subpath) {
    const segments = parsed.subpath.split('/').filter(Boolean);
    const leaf = segments[segments.length - 1];
    if (leaf) return leaf;
  }

  return getPluginName(source);
}

async function getEnabledSkillsForGitHubSource(
  source: string,
  workspacePath: string,
): Promise<string[]> {
  const identity = await resolveGitHubIdentity(source);
  if (!identity) return [];

  const enabledSkills: string[] = [];
  const allSkills = await getAllSkillsFromPlugins(workspacePath);

  for (const skill of allSkills) {
    if (skill.disabled) continue;
    const skillIdentity = await resolveGitHubIdentity(skill.pluginSource);
    if (skillIdentity !== identity) continue;
    if (!enabledSkills.includes(skill.name)) enabledSkills.push(skill.name);
  }

  return enabledSkills;
}

/**
 * Set or extend the plugin's skill allowlist with the requested skill, then sync.
 */
async function applySkillAllowlist(opts: {
  skill: string;
  pluginName: string;
  isUser: boolean;
  workspacePath: string;
}): Promise<InstallSkillResult> {
  const { skill, pluginName, isUser, workspacePath } = opts;

  // Check current state: if plugin already has an allowlist, add to it; otherwise create one
  const allSkills = await getAllSkillsFromPlugins(workspacePath);
  const pluginSkills = allSkills.filter((s) => s.pluginName === pluginName);
  const currentMode = pluginSkills[0]?.pluginSkillsMode ?? 'none';

  if (currentMode === 'allowlist') {
    // Add to existing allowlist
    const skillKey = `${pluginName}:${skill}`;
    const addResult = isUser
      ? await addUserEnabledSkill(skillKey)
      : await addEnabledSkill(skillKey, workspacePath);

    if (!addResult.success) {
      // Already in allowlist = already enabled
      if (!addResult.error?.includes('already enabled')) {
        return {
          success: false,
          error: `Failed to enable skill: ${addResult.error ?? 'Unknown error'}`,
        };
      }
    }
  } else {
    // No allowlist yet — create one with just this skill
    const setModeResult = isUser
      ? await setUserPluginSkillsMode(pluginName, 'allowlist', [skill])
      : await setPluginSkillsMode(
          pluginName,
          'allowlist',
          [skill],
          workspacePath,
        );

    if (!setModeResult.success) {
      return {
        success: false,
        error: `Failed to configure skill allowlist: ${setModeResult.error ?? 'Unknown error'}`,
      };
    }
  }

  return finishSkillEnable({ skill, pluginName, isUser, workspacePath });
}

async function finishSkillEnable(opts: {
  skill: string;
  pluginName: string;
  isUser: boolean;
  workspacePath: string;
}): Promise<InstallSkillResult> {
  const { skill, pluginName, isUser, workspacePath } = opts;

  if (!isJsonMode()) {
    console.log(`\u2713 Enabled skill: ${skill} (${pluginName})`);
  }

  const syncResult = isUser
    ? await syncUserWorkspace()
    : await syncWorkspace(workspacePath);
  if (!syncResult.success) {
    return { success: false, error: 'Sync failed' };
  }

  return {
    success: true,
    pluginName,
    location: installLocation(
      isUser ? 'user' : 'project',
      isUser ? getHomeDir() : workspacePath,
    ),
    syncResult: {
      copied: syncResult.totalCopied,
      failed: syncResult.totalFailed,
    },
  };
}

// =============================================================================
// Skill discovery helpers (for --list and --all)
// =============================================================================

interface DiscoveredSkill {
  name: string;
  /** Path-qualified identifier when the skill is nested below `skills/`. */
  subpath: string;
  description: string;
  pluginName?: string;
}

/**
 * Read SKILL.md frontmatter for each discovered skill in a plugin directory.
 */
export async function discoverSkillsWithMetadata(
  pluginPath: string,
  pluginName?: string,
): Promise<DiscoveredSkill[]> {
  const entries = await discoverSkillEntries(pluginPath);
  const results: DiscoveredSkill[] = [];

  for (const entry of entries) {
    const skillMdPath = join(entry.skillPath, 'SKILL.md');
    let description = '';
    try {
      const content = await readFile(skillMdPath, 'utf-8');
      const metadata = parseSkillMetadata(content);
      description = metadata?.description ?? '';
    } catch {
      // Leave description empty
    }
    results.push({
      name: entry.name,
      subpath: entry.subpath,
      description,
      ...(pluginName && { pluginName }),
    });
  }

  return results;
}

/**
 * Discover all skills available at a --from source. Handles both direct plugins
 * and marketplaces (in which case skills from all marketplace plugins are returned).
 */
async function discoverSkillsFromSource(
  from: string,
): Promise<
  | { success: true; skills: DiscoveredSkill[]; isMarketplace: boolean }
  | { success: false; error: string }
> {
  const parsed = isGitHubUrl(from) ? parseGitHubUrl(from) : null;
  const fetchResult = await fetchPlugin(from, {
    ...(parsed?.branch && { branch: parsed.branch }),
  });
  if (!fetchResult.success) {
    return {
      success: false,
      error: `Failed to fetch '${from}': ${fetchResult.error ?? 'Unknown error'}`,
    };
  }

  const sourcePath = resolveFetchedSourcePath(from, fetchResult.cachePath);
  const manifestResult = await parseMarketplaceManifest(sourcePath);
  if (manifestResult.success) {
    const all: DiscoveredSkill[] = [];
    for (const plugin of manifestResult.data.plugins) {
      // Skip remote URL sources — listing would need extra fetches
      if (typeof plugin.source === 'object') continue;
      const resolved = resolvePluginSourcePath(plugin.source, sourcePath);
      if (!existsSync(resolved)) continue;
      const skills = await discoverSkillsWithMetadata(resolved, plugin.name);
      all.push(...skills);
    }
    return { success: true, skills: all, isMarketplace: true };
  }

  const skills = await discoverSkillsWithMetadata(sourcePath);
  return { success: true, skills, isMarketplace: false };
}

/**
 * Skill-first interactive install for `skill add owner/repo` (source-auto).
 *
 * When connected to a TTY without `--yes`, discovers skills from the source
 * and shows an interactive picker with all skills pre-selected — the user can
 * deselect any they don't want before confirming. Falls back to install-all in
 * non-TTY, JSON, or `--yes` mode.
 *
 * Direct repos (non-marketplace): autocompleteMultiselect — flat list.
 * Marketplace repos: groupMultiselect — skills grouped by plugin.
 */
async function selectAndInstallSkillsFromSource(opts: {
  from: string;
  isUser: boolean;
  workspacePath: string;
  targetContext?: SkillInstallTargetContext | undefined;
}): Promise<
  | {
      success: true;
      installed: Array<{ pluginName: string; skills: string[] }>;
      syncResult: SyncResult;
      locations: SkillInstallLocation[];
    }
  | { success: false; error: string }
  | { success: 'cancelled' }
> {
  let { isUser, workspacePath } = opts;
  const { from, targetContext } = opts;
  const isTTY = process.stdout.isTTY && process.stdin.isTTY;

  // Non-interactive path: install everything silently
  if (!isTTY || isJsonMode() || targetContext?.options.yes) {
    return installAllSkillsFromSource(opts);
  }

  // Discover available skills (fetches the repo)
  const discovered = await discoverSkillsFromSource(from);
  if (!discovered.success) return { success: false, error: discovered.error };
  if (discovered.skills.length === 0) {
    return { success: false, error: `No skills found in '${from}'.` };
  }

  // Single-skill repos: skip the picker
  if (discovered.skills.length === 1) {
    return installAllSkillsFromSource(opts);
  }

  const p = await import('@clack/prompts');

  // Marketplace repos: show a grouped multiselect picker by plugin
  if (discovered.isMarketplace) {
    const allSkillNames = discovered.skills.map((s) => s.name);

    // Group skills by pluginName
    const groups: Record<
      string,
      Array<{ label: string; value: string; hint?: string }>
    > = {};
    for (const skill of discovered.skills) {
      const group = skill.pluginName ?? 'Other';
      if (!groups[group]) groups[group] = [];
      groups[group].push({
        label: skill.name,
        value: skill.name,
        ...(skill.description ? { hint: skill.description } : {}),
      });
    }

    const selected = await p.groupMultiselect({
      message: `Select skills to install from ${chalk.bold(from)}`,
      options: groups,
      initialValues: allSkillNames,
      required: false,
    });

    if (p.isCancel(selected) || (selected as string[]).length === 0) {
      return { success: 'cancelled' };
    }

    const selectedNames = selected as string[];

    // All selected → use the efficient bulk path
    if (selectedNames.length === allSkillNames.length) {
      return installAllSkillsFromSource(opts);
    }

    // Subset selected → discover every affected declaration before mutating.
    const parsed = isGitHubUrl(from) ? parseGitHubUrl(from) : null;
    const sourceLocation = parsed
      ? `${parsed.owner}/${parsed.repo}`
      : undefined;
    const projectWorkspacePath = targetContext?.workspacePath ?? workspacePath;
    let registration = await findMarketplaceRegistration(
      parsed?.repo ?? from,
      sourceLocation,
      targetContext ? projectWorkspacePath : isUser ? undefined : workspacePath,
    );
    let marketplaceName =
      registration?.key ??
      (parsed?.branch
        ? `${parsed.repo}-${parsed.branch}`
        : (parsed?.repo ?? getPluginName(from)));
    if (!registration) {
      let registrationScope: InstallScope = isUser ? 'user' : 'project';
      if (targetContext) {
        const target = await targetContext.resolve({
          source: from,
          install: 'file',
          skills: selectedNames,
        });
        if (!target) return { success: 'cancelled' };
        registrationScope = target.scope;
      }
      const ensured = await ensureMarketplaceRegistrationForScope({
        from,
        marketplaceName,
        scope: registrationScope,
        projectWorkspacePath,
      });
      if (!ensured.success) return ensured;
      marketplaceName = ensured.marketplaceName;
      registration = await findMarketplaceRegistration(
        marketplaceName,
        sourceLocation,
        registrationScope === 'user' ? undefined : projectWorkspacePath,
      );
      isUser = registrationScope === 'user';
      workspacePath = ensured.workspacePath;
    } else {
      isUser = registration.scope === 'user';
      workspacePath = isUser ? getHomeDir() : projectWorkspacePath;
    }

    const mktPlugins = await listMarketplacePlugins(
      marketplaceName,
      isUser ? undefined : workspacePath,
    );
    if (mktPlugins.plugins.length === 0) {
      return {
        success: false,
        error: `No plugins found in marketplace '${marketplaceName}'.`,
      };
    }
    const selections: MarketplaceSkillSelection[] = [];
    for (const mktPlugin of mktPlugins.plugins) {
      const allPluginSkillNames = mktPlugin.skills
        ? mktPlugin.skills
            .map((entry) => entry.split('/').pop() ?? '')
            .filter(Boolean)
        : await discoverSkillNames(mktPlugin.path);
      const skills = allPluginSkillNames.filter((name) =>
        selectedNames.includes(name),
      );
      if (skills.length > 0) {
        selections.push({ pluginName: mktPlugin.name, skills });
      }
    }
    if (selections.length === 0) {
      return {
        success: false,
        error: 'No matching skills found in marketplace plugins.',
      };
    }
    const applied = await applyMarketplaceSkillSelections({
      from,
      marketplaceName,
      registrationScope:
        registration?.scope ?? (isUser ? 'user' : 'project'),
      selections,
      isUser,
      projectWorkspacePath,
      ...(targetContext && { targetContext }),
    });
    if (applied.success !== true) return applied;
    const { installed, changedScopes } = applied;

    if (installed.length === 0) {
      return {
        success: false,
        error: 'No matching skills found in marketplace plugins.',
      };
    }

    if (!isJsonMode()) {
      const total = installed.reduce((sum, i) => sum + i.skills.length, 0);
      console.log(
        `✓ Enabled ${total} skill(s) across ${installed.length} plugin(s)`,
      );
    }

    const syncResult = await syncSkillInstallScopes(
      changedScopes,
      projectWorkspacePath,
    );
    if (!syncResult.success) return { success: false, error: 'Sync failed' };

    return {
      success: true,
      installed,
      syncResult,
      locations: installLocations(changedScopes, projectWorkspacePath),
    };
  }

  // Multiple skills on a direct repo: show a multiselect with all pre-selected
  const allNames = discovered.skills.map((s) => s.name);
  const options = discovered.skills.map((s) => ({
    label: s.name,
    value: s.name,
    ...(s.description ? { hint: s.description } : {}),
  }));

  const selected = await p.autocompleteMultiselect({
    message: `Select skills to install from ${chalk.bold(from)}`,
    options,
    initialValues: allNames,
    placeholder: 'Type to filter  ·  Space to toggle  ·  Enter to confirm',
    required: false,
  });

  if (p.isCancel(selected) || (selected as string[]).length === 0) {
    return { success: 'cancelled' };
  }

  const selectedNames = selected as string[];

  // All skills selected: use the efficient bulk path
  if (selectedNames.length === allNames.length) {
    return installAllSkillsFromSource(opts);
  }

  // Subset selected: configure allowlist with just those names, then sync once
  const parsed = isGitHubUrl(from) ? parseGitHubUrl(from) : null;
  const fetchResult = await fetchPlugin(from, {
    ...(parsed?.branch && { branch: parsed.branch }),
  });
  if (!fetchResult.success) {
    return {
      success: false,
      error: `Failed to fetch '${from}': ${fetchResult.error ?? 'Unknown error'}`,
    };
  }

  const existingScope = targetContext
    ? await installedSkillSourceScope(from, targetContext)
    : null;
  if (existingScope) {
    isUser = existingScope === 'user';
    workspacePath = isUser
      ? getHomeDir()
      : (targetContext?.workspacePath ?? workspacePath);
  }
  const existingEnabled = existingScope
    ? await getEnabledSkillsForGitHubSource(from, workspacePath)
    : [];
  const desiredSkills = [...existingEnabled];
  for (const name of selectedNames) {
    if (!desiredSkills.includes(name)) desiredSkills.push(name);
  }

  let pluginName: string;
  if (!existingScope && targetContext) {
    const installResult = await addSkillDeclarationForTarget(
      { source: from, install: 'file', skills: desiredSkills },
      targetContext,
    );
    if (installResult.status === 'cancelled') return { success: 'cancelled' };
    if (installResult.status === 'failed') {
      return {
        success: false,
        error: `Failed to configure skill allowlist: ${installResult.error}`,
      };
    }
    isUser = installResult.scope === 'user';
    workspacePath = isUser ? getHomeDir() : targetContext.workspacePath;
    pluginName = extractPrimaryPluginName(
      installResult.normalizedPlugin ?? from,
    );
  } else {
    const updateResult = isUser
      ? await upsertUserGitHubPluginSourceAllowlist(from, desiredSkills)
      : await upsertGitHubPluginSourceAllowlist(
          from,
          desiredSkills,
          workspacePath,
        );
    if (!updateResult.success) {
      return {
        success: false,
        error: `Failed to configure skill allowlist: ${updateResult.error ?? 'Unknown error'}`,
      };
    }
    pluginName = extractPrimaryPluginName(
      updateResult.normalizedPlugin ?? from,
    );
  }
  console.log(
    `✓ Enabled ${selectedNames.length} skill(s) from ${pluginName}: ${selectedNames.join(', ')}`,
  );

  const syncResult = isUser
    ? await syncUserWorkspace()
    : await syncWorkspace(workspacePath);
  if (!syncResult.success) return { success: false, error: 'Sync failed' };

  return {
    success: true,
    installed: [{ pluginName, skills: desiredSkills }],
    syncResult,
    locations: [
      installLocation(isUser ? 'user' : 'project', workspacePath),
    ],
  };
}

/**
 * Install all skills from a --from source. Mirrors installSkillFromSource but
 * enables every discovered skill rather than a single named one.
 */
async function installAllSkillsFromSource(opts: {
  from: string;
  isUser: boolean;
  workspacePath: string;
  targetContext?: SkillInstallTargetContext | undefined;
}): Promise<
  | {
      success: true;
      installed: Array<{ pluginName: string; skills: string[] }>;
      syncResult: SyncResult;
      locations: SkillInstallLocation[];
    }
  | { success: false; error: string }
  | { success: 'cancelled' }
> {
  let { isUser, workspacePath } = opts;
  const { from, targetContext } = opts;

  if (!isJsonMode()) {
    console.log(`Installing all skills from ${from}...`);
  }

  const parsed = isGitHubUrl(from) ? parseGitHubUrl(from) : null;
  const fetchResult = await fetchPlugin(from, {
    ...(parsed?.branch && { branch: parsed.branch }),
  });
  if (!fetchResult.success) {
    return {
      success: false,
      error: `Failed to fetch '${from}': ${fetchResult.error ?? 'Unknown error'}`,
    };
  }

  const sourcePath = resolveFetchedSourcePath(from, fetchResult.cachePath);
  const manifestResult = await parseMarketplaceManifest(sourcePath);

  if (manifestResult.success) {
    return installAllViaMarketplace({
      from,
      isUser,
      workspacePath,
      cachedPath: fetchResult.cachePath,
      targetContext,
    });
  }

  // Direct plugin install — enable every discovered skill
  const skillNames = await discoverSkillNames(sourcePath);
  if (skillNames.length === 0) {
    return { success: false, error: `No skills found in '${from}'.` };
  }

  if (targetContext) {
    const existingScope = await installedSkillSourceScope(from, targetContext);
    if (existingScope) {
      isUser = existingScope === 'user';
      workspacePath = isUser ? getHomeDir() : targetContext.workspacePath;
    } else {
      const installResult = await addSkillDeclarationForTarget(
        { source: from, install: 'file', skills: skillNames },
        targetContext,
      );
      if (installResult.status === 'cancelled') {
        return { success: 'cancelled' };
      }
      if (installResult.status === 'failed') {
        return {
          success: false,
          error: `Failed to install plugin '${from}': ${installResult.error}`,
        };
      }
      isUser = installResult.scope === 'user';
      workspacePath = isUser ? getHomeDir() : targetContext.workspacePath;
      const pluginName = extractPrimaryPluginName(
        installResult.normalizedPlugin ??
          (isGitHubUrl(from) ? from : getPluginName(sourcePath)),
      );
      if (!isJsonMode()) {
        console.log(
          `✓ Enabled ${skillNames.length} skill(s) from ${pluginName}: ${skillNames.join(', ')}`,
        );
      }
      const syncResult = isUser
        ? await syncUserWorkspace()
        : await syncWorkspace(workspacePath);
      if (!syncResult.success) {
        return { success: false, error: 'Sync failed' };
      }
      return {
        success: true,
        installed: [{ pluginName, skills: skillNames }],
        syncResult,
        locations: [
          installLocation(isUser ? 'user' : 'project', workspacePath),
        ],
      };
    }
  }

  if (isGitHubUrl(from)) {
    const existingEnabledSkills = await getEnabledSkillsForGitHubSource(
      from,
      workspacePath,
    );
    const desiredSkills = [...existingEnabledSkills];
    for (const skillName of skillNames) {
      if (!desiredSkills.includes(skillName)) desiredSkills.push(skillName);
    }

    const updateResult = isUser
      ? await upsertUserGitHubPluginSourceAllowlist(from, desiredSkills)
      : await upsertGitHubPluginSourceAllowlist(
          from,
          desiredSkills,
          workspacePath,
        );

    if (!updateResult.success) {
      return {
        success: false,
        error: `Failed to configure skill allowlist: ${updateResult.error ?? 'Unknown error'}`,
      };
    }

    const pluginName = extractPrimaryPluginName(
      updateResult.normalizedPlugin ?? from,
    );

    if (!isJsonMode()) {
      console.log(
        `✓ Enabled ${skillNames.length} skill(s) from ${pluginName}: ${skillNames.join(', ')}`,
      );
    }

    const syncResult = isUser
      ? await syncUserWorkspace()
      : await syncWorkspace(workspacePath);
    if (!syncResult.success) {
      return { success: false, error: 'Sync failed' };
    }

    return {
      success: true,
      installed: [{ pluginName, skills: desiredSkills }],
      syncResult,
      locations: [
        installLocation(isUser ? 'user' : 'project', workspacePath),
      ],
    };
  }

  const installResult = isUser
    ? await addUserPlugin(from)
    : await addPlugin(from, workspacePath);
  if (!installResult.success) {
    if (
      !installResult.error?.includes('already exists') &&
      !installResult.error?.includes('duplicates existing')
    ) {
      return {
        success: false,
        error: `Failed to install plugin '${from}': ${installResult.error ?? 'Unknown error'}`,
      };
    }
    if (!isJsonMode()) {
      console.log('Plugin already installed.');
    }
  }

  const pluginName = getPluginName(sourcePath);

  const setModeResult = isUser
    ? await setUserPluginSkillsMode(pluginName, 'allowlist', skillNames)
    : await setPluginSkillsMode(
        pluginName,
        'allowlist',
        skillNames,
        workspacePath,
      );

  if (!setModeResult.success) {
    return {
      success: false,
      error: `Failed to configure skill allowlist: ${setModeResult.error ?? 'Unknown error'}`,
    };
  }

  if (!isJsonMode()) {
    console.log(
      `✓ Enabled ${skillNames.length} skill(s) from ${pluginName}: ${skillNames.join(', ')}`,
    );
  }

  const syncResult = isUser
    ? await syncUserWorkspace()
    : await syncWorkspace(workspacePath);
  if (!syncResult.success) {
    return { success: false, error: 'Sync failed' };
  }

  return {
    success: true,
    installed: [{ pluginName, skills: skillNames }],
    syncResult,
    locations: [
      installLocation(isUser ? 'user' : 'project', workspacePath),
    ],
  };
}

/**
 * Install every plugin from a marketplace source and enable every skill in each.
 */
async function installAllViaMarketplace(opts: {
  from: string;
  isUser: boolean;
  workspacePath: string;
  cachedPath?: string;
  targetContext?: SkillInstallTargetContext | undefined;
}): Promise<
  | {
      success: true;
      installed: Array<{ pluginName: string; skills: string[] }>;
      syncResult: SyncResult;
      locations: SkillInstallLocation[];
    }
  | { success: false; error: string }
  | { success: 'cancelled' }
> {
  let { isUser, workspacePath } = opts;
  const { from, cachedPath, targetContext } = opts;
  const parsed = isGitHubUrl(from) ? parseGitHubUrl(from) : null;
  const sourceLocation = parsed ? `${parsed.owner}/${parsed.repo}` : undefined;
  const projectWorkspacePath = targetContext?.workspacePath ?? workspacePath;
  let registration = await findMarketplaceRegistration(
    parsed?.repo ?? from,
    sourceLocation,
    targetContext ? projectWorkspacePath : isUser ? undefined : workspacePath,
  );
  let marketplaceName =
    registration?.key ??
    (parsed?.branch
      ? `${parsed.repo}-${parsed.branch}`
      : (parsed?.repo ?? getPluginName(from)));

  if (!registration) {
    if (cachedPath) seedFetchCache(from, cachedPath);
    let registrationScope: InstallScope = isUser ? 'user' : 'project';
    if (targetContext) {
      const target = await targetContext.resolve({
        source: from,
        install: 'file',
      });
      if (!target) return { success: 'cancelled' };
      registrationScope = target.scope;
    }
    const ensured = await ensureMarketplaceRegistrationForScope({
      from,
      marketplaceName,
      scope: registrationScope,
      projectWorkspacePath,
    });
    if (!ensured.success) return ensured;
    marketplaceName = ensured.marketplaceName;
    registration = await findMarketplaceRegistration(
      marketplaceName,
      sourceLocation,
      registrationScope === 'user' ? undefined : projectWorkspacePath,
    );
    isUser = registrationScope === 'user';
    workspacePath = ensured.workspacePath;
  } else {
    isUser = registration.scope === 'user';
    workspacePath = isUser ? getHomeDir() : projectWorkspacePath;
  }

  const mktPlugins = await listMarketplacePlugins(
    marketplaceName,
    isUser ? undefined : workspacePath,
  );
  if (mktPlugins.plugins.length === 0) {
    return {
      success: false,
      error: `No plugins found in marketplace '${marketplaceName}'.`,
    };
  }
  const selections: MarketplaceSkillSelection[] = [];
  for (const mktPlugin of mktPlugins.plugins) {
    const skills = mktPlugin.skills
      ? mktPlugin.skills
          .map((entry) => entry.split('/').pop() ?? '')
          .filter(Boolean)
      : await discoverSkillNames(mktPlugin.path);
    if (skills.length > 0) {
      selections.push({ pluginName: mktPlugin.name, skills });
    }
  }
  if (selections.length === 0) {
    return {
      success: false,
      error: `No skills found across plugins in marketplace '${marketplaceName}'.`,
    };
  }
  const applied = await applyMarketplaceSkillSelections({
    from,
    marketplaceName,
    registrationScope:
      registration?.scope ?? (isUser ? 'user' : 'project'),
    selections,
    isUser,
    projectWorkspacePath,
    ...(targetContext && { targetContext }),
  });
  if (applied.success !== true) return applied;
  const { installed, changedScopes } = applied;

  if (installed.length === 0) {
    return {
      success: false,
      error: `No skills found across plugins in marketplace '${marketplaceName}'.`,
    };
  }

  if (!isJsonMode()) {
    const total = installed.reduce((sum, i) => sum + i.skills.length, 0);
    console.log(
      `✓ Enabled ${total} skill(s) across ${installed.length} plugin(s)`,
    );
  }

  const syncResult = await syncSkillInstallScopes(
    changedScopes,
    projectWorkspacePath,
  );
  if (!syncResult.success) {
    return { success: false, error: 'Sync failed' };
  }

  return {
    success: true,
    installed,
    syncResult,
    locations: installLocations(changedScopes, projectWorkspacePath),
  };
}

// =============================================================================
// plugin skills add
// =============================================================================

const addCmd = command({
  name: 'add',
  description: buildDescription(skillsAddMeta),
  args: {
    skill: positional({
      type: optional(string),
      displayName: 'skill-or-source',
    }),
    scope: option({
      type: optional(string),
      long: 'scope',
      short: 's',
      description: 'Scope: "project" (default) or "user"',
    }),
    client: option({
      type: optional(string),
      long: 'client',
      short: 'c',
      description: 'Comma-separated clients for this skill source',
    }),
    yes: flag({
      long: 'yes',
      short: 'y',
      description: 'Run without prompts using configured or default scope and clients',
    }),
    plugin: option({
      type: optional(string),
      long: 'plugin',
      short: 'p',
      description: 'Plugin name (required if skill exists in multiple plugins)',
    }),
    from: option({
      type: optional(string),
      long: 'from',
      short: 'f',
      description:
        'Plugin source to install if the skill is not already available',
    }),
    skillFlag: option({
      type: optional(string),
      long: 'skill',
      description:
        'Comma-separated skill names to install when the positional argument is a plugin source (e.g., owner/repo --skill foo,bar)',
    }),
    ref: option({
      type: optional(string),
      long: 'ref',
      description:
        'Git ref to use for the plugin (tag or branch). Mutually exclusive with inline @ref in --from.',
    }),
    list: flag({
      long: 'list',
      short: 'l',
      description: 'List available skills at --from without installing',
    }),
    all: flag({
      long: 'all',
      description: 'Install every skill from --from',
    }),
  },
  handler: async ({
    skill: skillArg,
    scope,
    client,
    yes,
    plugin,
    from: fromArg,
    skillFlag,
    ref,
    list,
    all,
  }) => {
    try {
      // Classify the positional argument so we know which code path to take.
      const classified = classifySkillAddPositional(
        skillArg,
        skillFlag,
        list,
        all,
      );
      let skillsFromFlag: string[] = [];
      // source-auto: bare owner/repo (no subpath, no selector) — install all skills
      // from the repo as if --all were passed. Mirrors `npx skills add owner/repo`.
      let autoAll = false;
      if (classified.shape === 'source' || classified.shape === 'source-auto') {
        if (fromArg) {
          const error =
            'Cannot use --from when the positional argument is already a plugin source.';
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill add', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }
        fromArg = skillArg;
        skillArg = undefined;
        if (classified.shape === 'source') {
          skillsFromFlag = classified.skills;
        } else {
          autoAll = true;
        }
      } else if (skillFlag) {
        const error =
          '--skill requires the positional argument to be a plugin source (e.g., `skill add owner/repo --skill foo`). To install a known skill, pass the skill name as the positional.';
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'skill add', error });
          process.exit(1);
        }
        console.error(`Error: ${error}`);
        process.exit(1);
      }

      // Resolve --ref together with inline @ref. Three legal states:
      //   • --ref only  → splice into fromArg
      //   • inline @ref → leave fromArg alone, remember requestedRef
      //   • neither     → use the source's default branch
      // Mutex: --ref combined with inline @ref is rejected.
      let requestedRef: string | undefined;
      if (ref || fromArg) {
        const inlineRef = fromArg ? extractInlineRef(fromArg) : undefined;
        if (ref && inlineRef) {
          const error =
            'Cannot combine inline @ref in --from with --ref. Use one or the other.';
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill add', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }
        if (ref && fromArg) {
          // Splice the ref into the source string so downstream parseGitHubUrl
          // picks it up as the branch/tag.
          fromArg = `${fromArg}@${ref}`;
          requestedRef = ref;
        } else if (inlineRef) {
          requestedRef = inlineRef;
        } else if (ref && !fromArg) {
          const error = '--ref requires --from to specify a plugin source.';
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill add', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }
      }

      // --list: dry-run discovery, no workspace changes
      if (list) {
        if (skillArg) {
          const error =
            'Cannot combine a skill argument with --list. Use --list alone to discover available skills.';
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill add', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }
        if (!fromArg) {
          const error = '--list requires --from to specify a plugin source.';
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill add', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }
        if (all) {
          const error = '--list and --all cannot be used together.';
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill add', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }

        const discovered = await discoverSkillsFromSource(fromArg);
        if (!discovered.success) {
          if (isJsonMode()) {
            jsonOutput({
              success: false,
              command: 'skill add',
              error: discovered.error,
            });
            process.exit(1);
          }
          console.error(`Error: ${discovered.error}`);
          process.exit(1);
        }

        if (isJsonMode()) {
          jsonOutput({
            success: true,
            command: 'skill add',
            data: {
              source: fromArg,
              isMarketplace: discovered.isMarketplace,
              skills: discovered.skills.map((s) => ({
                name: s.name,
                ...(s.subpath !== s.name && { path: s.subpath }),
                description: s.description,
                ...(s.pluginName && { plugin: s.pluginName }),
              })),
            },
          });
          return;
        }

        if (discovered.skills.length === 0) {
          console.log(`No skills found in ${fromArg}.`);
          return;
        }

        console.log(`\nAvailable skills in ${fromArg}:\n`);
        for (const s of discovered.skills) {
          const displayName = s.subpath !== s.name ? s.subpath : s.name;
          const label = s.pluginName
            ? `${displayName} ${chalk.gray(`(${s.pluginName})`)}`
            : displayName;
          console.log(`  ${chalk.hex('#89b4fa')(label)}`);
          if (s.description) console.log(`    ${s.description}`);
          console.log();
        }
        return;
      }

      // --all or auto-install (bare owner/repo with no selector): bulk install
      if (all || autoAll) {
        if (!fromArg) {
          const error = '--all requires --from to specify a plugin source.';
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill add', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }
        if (skillArg) {
          const error =
            'Cannot combine a skill argument with --all. Use --all alone to install every skill.';
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill add', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }

        const isUserAll = scope === 'user';
        const workspacePathAll = isUserAll ? getHomeDir() : process.cwd();
        const targetContext = createSkillInstallTargetContext(
          process.cwd(),
          `${fromArg} (${autoAll ? 'selected skills' : 'all skills'})`,
          { scope, clients: client, yes },
        );

        // source-auto: interactive picker on TTY; --all: direct bulk install
        const installResult = autoAll
          ? await selectAndInstallSkillsFromSource({
              from: fromArg,
              isUser: isUserAll,
              workspacePath: workspacePathAll,
              targetContext,
            })
          : await installAllSkillsFromSource({
              from: fromArg,
              isUser: isUserAll,
              workspacePath: workspacePathAll,
              targetContext,
            });

        if (installResult.success === 'cancelled') {
          reportSkillInstallCancellation();
          return;
        }

        if (!installResult.success) {
          if (isJsonMode()) {
            jsonOutput({
              success: false,
              command: 'skill add',
              error: installResult.error,
            });
            process.exit(1);
          }
          console.error(`Error: ${installResult.error}`);
          process.exit(1);
        }

        await recordSourceProvenanceAtLocations({
          from: fromArg,
          requestedRef,
          locations: installResult.locations,
        });

        if (isJsonMode()) {
          jsonOutput({
            success: true,
            command: 'skill add',
            data: {
              source: fromArg,
              installed: installResult.installed,
              syncResult: {
                copied: installResult.syncResult.totalCopied,
                failed: installResult.syncResult.totalFailed,
              },
              ...(requestedRef && { requestedRef }),
            },
          });
          return;
        }

        for (const line of formatSyncHeader(installResult.syncResult)) {
          console.log(line);
        }
        const summaryLines = formatSyncSummary(installResult.syncResult);
        if (summaryLines.length > 0) {
          console.log('');
          for (const line of summaryLines) {
            console.log(line);
          }
        }
        return;
      }

      // --skill <names>: install one-or-more named skills from the positional source.
      if (skillsFromFlag.length > 0) {
        if (!fromArg) {
          // Defensive: positional detection above already guarantees fromArg
          // when skillsFromFlag is non-empty.
          const error = '--skill requires a plugin source positional argument.';
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill add', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }

        const isUserSel = scope === 'user';
        const workspacePathSel = isUserSel ? getHomeDir() : process.cwd();
        const targetContext = createSkillInstallTargetContext(
          process.cwd(),
          `${fromArg}: ${skillsFromFlag.join(', ')}`,
          { scope, clients: client, yes },
        );

        const succeeded: Array<{
          skill: string;
          plugin: string;
          copied: number;
          failed: number;
        }> = [];
        const succeededLocations: SkillInstallLocation[] = [];
        const failures: Array<{ skill: string; error: string }> = [];

        for (const skill of skillsFromFlag) {
          const result = await installSkillFromSource({
            skill,
            from: fromArg,
            isUser: isUserSel,
            workspacePath: workspacePathSel,
            targetContext,
          });
          if (result.success === 'cancelled') {
            reportSkillInstallCancellation();
            return;
          }
          if (result.success === true) {
            succeeded.push({
              skill,
              plugin: result.pluginName,
              copied: result.syncResult.copied,
              failed: result.syncResult.failed,
            });
            succeededLocations.push(result.location);
          } else {
            failures.push({ skill, error: result.error });
          }
        }

        if (succeeded.length > 0) {
          await recordSourceProvenanceAtLocations({
            from: fromArg,
            requestedRef,
            locations: succeededLocations,
          });
        }

        const allFailed = succeeded.length === 0;
        if (isJsonMode()) {
          jsonOutput({
            success: !allFailed,
            command: 'skill add',
            data: {
              source: fromArg,
              installed: succeeded,
              failed: failures,
              ...(requestedRef && { requestedRef }),
            },
            ...(allFailed && {
              error: failures.map((f) => `${f.skill}: ${f.error}`).join('; '),
            }),
          });
          if (allFailed) process.exit(1);
          return;
        }

        for (const f of failures) {
          console.error(`Error installing '${f.skill}': ${f.error}`);
        }
        if (requestedRef && succeeded.length > 0) {
          console.log(`Using ref ${requestedRef}.`);
        }
        if (allFailed) process.exit(1);
        return;
      }

      // Without --list or --all, skill argument is required.
      if (!skillArg) {
        const error =
          'A skill name is required. Use --list to discover available skills or --all to install everything.';
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'skill add', error });
          process.exit(1);
        }
        console.error(`Error: ${error}`);
        process.exit(1);
      }

      let skill = skillArg;
      let from = fromArg;

      // Auto-detect GitHub URL as skill argument
      const urlResolved = resolveSkillFromUrl(skill);
      if (urlResolved) {
        if (from) {
          const error =
            'Cannot use --from when the skill argument is a GitHub URL. The URL is used as the plugin source automatically.';
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill add', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }
        from = urlResolved.from;

        // For URLs without subpath, try to read skill name from SKILL.md frontmatter
        if (urlResolved.parsed && !urlResolved.parsed.subpath) {
          skill = await resolveSkillNameFromRepo(
            skill,
            urlResolved.parsed,
            urlResolved.skill,
          );
        } else {
          skill = urlResolved.skill;
        }
      }

      // When --from is used (installing a new plugin), default to project scope
      const hasFromSource = Boolean(from);
      const isUser =
        scope === 'user' ||
        (!scope && !hasFromSource && resolveScope(process.cwd()) === 'user');
      const workspacePath = isUser ? getHomeDir() : process.cwd();

      // Find the skill
      const matches = await findSkillByName(skill, workspacePath);

      if (matches.length === 0) {
        if (from) {
          const targetContext = createSkillInstallTargetContext(
            process.cwd(),
            `${from}: ${skill}`,
            { scope, clients: client, yes },
          );
          // Install the plugin from --from source, then enable only the requested skill
          const installFromResult = await installSkillFromSource({
            skill,
            from,
            isUser,
            workspacePath,
            targetContext,
          });

          if (installFromResult.success === 'cancelled') {
            reportSkillInstallCancellation();
            return;
          }

          if (!installFromResult.success) {
            if (isJsonMode()) {
              jsonOutput({
                success: false,
                command: 'skill add',
                error: installFromResult.error,
              });
              process.exit(1);
            }
            console.error(`Error: ${installFromResult.error}`);
            process.exit(1);
          }

          await recordSourceProvenanceAtLocations({
            from,
            requestedRef,
            locations: [installFromResult.location],
          });

          if (isJsonMode()) {
            jsonOutput({
              success: true,
              command: 'skill add',
              data: {
                skill,
                plugin: installFromResult.pluginName,
                syncResult: installFromResult.syncResult,
                ...(requestedRef && { requestedRef }),
              },
            });
            return;
          }

          if (requestedRef) {
            console.log(`Using ref ${requestedRef}.`);
          }
          return;
        }

        const allSkills = await getAllSkillsFromPlugins(workspacePath);
        const skillNames = [...new Set(allSkills.map((s) => s.name))].join(
          ', ',
        );
        const error = `Skill '${skill}' not found in any installed plugin.\n\nAvailable skills: ${skillNames || 'none'}`;
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'skill add', error });
          process.exit(1);
        }
        console.error(`Error: ${error}`);
        process.exit(1);
      }

      // Handle ambiguity
      let targetSkill = matches[0];
      if (!targetSkill) {
        // This should never happen since we checked matches.length === 0 above
        throw new Error('Unexpected empty matches array');
      }
      if (matches.length > 1) {
        if (!plugin) {
          const pluginList = matches
            .map((m) => `  - ${m.pluginName} (${m.pluginSource})`)
            .join('\n');
          const error = `'${skill}' exists in multiple plugins:\n${pluginList}\n\nUse --plugin to specify: allagents skill add ${skill} --plugin <name>`;
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill add', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }
        const filtered = matches.find((m) => m.pluginName === plugin);
        if (!filtered) {
          const error = `Plugin '${plugin}' not found. Installed plugins: ${matches.map((m) => m.pluginName).join(', ')}`;
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill add', error });
            process.exit(1);
          }
          console.error(`Error: ${error}`);
          process.exit(1);
        }
        targetSkill = filtered;
      }

      // Check if already enabled
      if (!targetSkill.disabled) {
        const msg = `Skill '${skill}' is already enabled.`;
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'skill add', error: msg });
          process.exit(1);
        }
        console.log(msg);
        return;
      }

      const skillKey = `${targetSkill.pluginName}:${skill}`;

      const result =
        targetSkill.pluginSkillsMode === 'blocklist'
          ? isUser
            ? await removeUserDisabledSkill(skillKey)
            : await removeDisabledSkill(skillKey, workspacePath)
          : isUser
            ? await addUserEnabledSkill(skillKey)
            : await addEnabledSkill(skillKey, workspacePath);

      if (!result.success) {
        if (isJsonMode()) {
          jsonOutput({
            success: false,
            command: 'skill add',
            error: result.error ?? 'Unknown error',
          });
          process.exit(1);
        }
        console.error(`Error: ${result.error}`);
        process.exit(1);
      }

      if (!isJsonMode()) {
        console.log(
          `\u2713 Enabled skill: ${skill} (${targetSkill.pluginName})`,
        );
      }

      const syncResult = isUser
        ? await syncUserWorkspace()
        : await syncWorkspace(workspacePath);

      if (isJsonMode()) {
        jsonOutput({
          success: syncResult.success,
          command: 'skill add',
          data: {
            skill,
            plugin: targetSkill.pluginName,
            syncResult: {
              copied: syncResult.totalCopied,
              failed: syncResult.totalFailed,
            },
          },
        });
        if (!syncResult.success) process.exit(1);
        return;
      }
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({
            success: false,
            command: 'skill add',
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
// skill search (GitHub Code Search)
// =============================================================================

export function formatSkillSearchSummary(
  count: number,
  query: string,
  truncated: boolean,
): string {
  return `Showing ${count} skill${count !== 1 ? 's' : ''} matching "${query}"${truncated ? ' (truncated)' : ''}`;
}

export function formatSkillSearchHint(
  item: Pick<SkillSearchItem, 'stars' | 'description'>,
): string {
  return [item.stars > 0 ? `★ ${item.stars}` : '', item.description ?? '']
    .filter(Boolean)
    .join('  ');
}

export function collectSelectedSkillSearchRepos(
  items: Pick<SkillSearchItem, 'path' | 'repo'>[],
  selectedPaths: string[],
): string[] {
  const selectedSet = new Set(selectedPaths);
  const repos: string[] = [];
  const seenRepos = new Set<string>();

  for (const item of items) {
    if (!selectedSet.has(item.path) || seenRepos.has(item.repo)) continue;
    seenRepos.add(item.repo);
    repos.push(item.repo);
  }

  return repos;
}

/** Print results in gh-compatible tabular format: repo, skillName, description, stars. */
function printSearchResults(
  items: SkillSearchItem[],
  query: string,
  truncated: boolean,
): void {
  console.log(
    `\n${formatSkillSearchSummary(items.length, query, truncated)}\n`,
  );
  for (const item of items) {
    const repoCol = item.repo.padEnd(30);
    const nameCol = qualifiedName(item).padEnd(24);
    const stars = item.stars > 0 ? chalk.yellow(`★ ${item.stars}`) : '';
    const desc = item.description
      ? chalk.dim(
          item.description.length > 60
            ? `${item.description.slice(0, 57)}...`
            : item.description,
        )
      : '';
    const starsAndDesc = [stars, desc].filter(Boolean).join('  ');
    console.log(
      `  ${chalk.cyan(repoCol)}  ${chalk.bold(nameCol)}  ${starsAndDesc}`,
    );
  }
  console.log('');
}

/**
 * Interactive install flow for a selected plugin from search results.
 * Returns true if plugin was installed.
 */
async function installFromSearch(
  selections: Array<{ repo: string; skills: string[] }>,
): Promise<boolean> {
  const p = await import('@clack/prompts');

  const workspacePath = process.cwd();
  const installableSelections: Array<{ repo: string; skills: string[] }> = [];

  for (const selection of selections) {
    const { repo } = selection;
    const isInstalledProject = hasProjectSkillConfig(workspacePath)
      ? await hasPlugin(repo, workspacePath)
      : false;
    const isInstalledUser = await hasUserPlugin(repo);

    if (isInstalledProject || isInstalledUser) {
      const scopeLabel = isInstalledUser ? 'user' : 'project';
      p.log.info(
        `Plugin ${chalk.bold(repo)} is already installed (${scopeLabel} scope).`,
      );
      continue;
    }

    installableSelections.push(selection);
  }

  const firstSelection = installableSelections[0];
  if (!firstSelection) {
    return false;
  }

  const targetContext = createSkillInstallTargetContext(
    workspacePath,
    installableSelections
      .map(({ repo, skills }) => `${repo}: ${skills.join(', ')}`)
      .join('; '),
    {},
  );
  const target = await targetContext.resolve({
    source: firstSelection.repo,
    install: 'file',
    skills: firstSelection.skills,
  });
  if (!target) return false;

  const s = p.spinner();
  s.start(
    `Installing ${installableSelections.length === 1 ? 'plugin' : 'plugins'}...`,
  );

  try {
    const installedRepos: string[] = [];
    const failedRepos: Array<{ repo: string; error: string }> = [];

    for (const { repo, skills } of installableSelections) {
      const result = await addSkillDeclarationForTarget(
        { source: repo, install: 'file', skills },
        targetContext,
      );
      if (result.status === 'cancelled') return false;
      if (result.status === 'failed') {
        failedRepos.push({ repo, error: result.error });
        continue;
      }
      installedRepos.push(repo);
    }

    if (installedRepos.length === 0) {
      s.stop('Installation failed');
      for (const { repo, error } of failedRepos) {
        p.log.error(`${chalk.bold(repo)}: ${error}`);
      }
      return false;
    }

    s.message('Syncing...');
    const syncResult =
      target.scope === 'project'
        ? await syncWorkspace(workspacePath)
        : await syncUserWorkspace();

    s.stop(
      installedRepos.length === 1
        ? 'Installed and synced'
        : 'Installed plugins and synced',
    );

    for (const { repo, error } of failedRepos) {
      p.log.error(`${chalk.bold(repo)}: ${error}`);
    }

    const lines = formatVerboseSyncLines(syncResult);
    const noteLines =
      installedRepos.length > 1 ? [...installedRepos, '', ...lines] : lines;
    if (noteLines.length > 0) {
      p.note(
        noteLines.join('\n'),
        installedRepos.length === 1
          ? `Installed: ${installedRepos[0]}`
          : `Installed: ${installedRepos.length} plugins`,
      );
    }

    return true;
  } catch (err) {
    s.stop('Installation failed');
    p.log.error(err instanceof Error ? err.message : String(err));
    return false;
  }
}

const searchCmd = command({
  name: 'search',
  description: buildDescription(skillsSearchMeta),
  args: {
    query: restPositionals({ type: string, displayName: 'query' }),
    owner: option({
      type: optional(string),
      long: 'owner',
      description: 'Scope to a single GitHub owner (org or user).',
    }),
    page: option({
      type: optional(string),
      long: 'page',
      description: 'Result page (1-indexed, default 1).',
    }),
    limit: option({
      type: optional(string),
      long: 'limit',
      description: 'Results per page (1–100, default 15).',
    }),
  },
  handler: async ({ query, owner, page, limit }) => {
    try {
      const searchQuery = query.join(' ').trim();
      const opts: SkillSearchOptions = {};
      if (owner) opts.owner = owner;
      if (page !== undefined) {
        const n = Number.parseInt(page, 10);
        if (Number.isNaN(n)) {
          const err = '--page must be an integer.';
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill search', error: err });
            process.exit(2);
          }
          console.error(`Error: ${err}`);
          process.exit(2);
        }
        opts.page = n;
      }
      if (limit !== undefined) {
        const n = Number.parseInt(limit, 10);
        if (Number.isNaN(n)) {
          const err = '--limit must be an integer.';
          if (isJsonMode()) {
            jsonOutput({ success: false, command: 'skill search', error: err });
            process.exit(2);
          }
          console.error(`Error: ${err}`);
          process.exit(2);
        }
        opts.limit = n;
      }

      const result = await searchSkills(searchQuery, opts);

      if (isJsonMode()) {
        jsonOutput({
          success: true,
          command: 'skill search',
          data: result,
        });
        return;
      }

      if (result.items.length === 0) {
        console.log(`No skills found for "${searchQuery}".`);
        return;
      }

      const isTTY = process.stdout.isTTY && process.stdin.isTTY;

      if (!isTTY) {
        // Non-interactive: print table with stars and exit
        printSearchResults(result.items, searchQuery, result.truncated);
        return;
      }

      // Interactive mode: filter-as-you-type multiselect with install support
      const { autocompleteMultiselect, isCancel, log } = await import(
        '@clack/prompts'
      );

      log.success(
        formatSkillSearchSummary(
          result.items.length,
          searchQuery,
          result.truncated,
        ),
      );

      const options = result.items.map((item) => ({
        label: `${qualifiedName(item)}  ${chalk.dim(item.repo)}`,
        value: item.path,
        hint: formatSkillSearchHint(item),
      }));

      const selected = await autocompleteMultiselect({
        message: 'Select skills to install',
        options,
        placeholder: 'Type to filter...',
        required: false,
      });

      if (isCancel(selected)) {
        return;
      }

      const selectedPaths = new Set(selected as string[]);
      const installsByRepo = new Map<string, string[]>();
      for (const item of result.items) {
        if (!selectedPaths.has(item.path)) continue;
        const skills = installsByRepo.get(item.repo);
        if (skills) {
          skills.push(qualifiedName(item));
        } else {
          installsByRepo.set(item.repo, [qualifiedName(item)]);
        }
      }
      const selections = [...installsByRepo].map(([repo, skills]) => ({
        repo,
        skills,
      }));
      if (selections.length === 0) return;
      await installFromSearch(selections);
    } catch (error) {
      if (error instanceof SkillSearchError) {
        const exitCode = error.kind === 'validation' ? 2 : 1;
        if (isJsonMode()) {
          jsonOutput({
            success: false,
            command: 'skill search',
            error: error.message,
          });
          process.exit(exitCode);
        }
        console.error(`Error: ${error.message}`);
        process.exit(exitCode);
      }
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({
            success: false,
            command: 'skill search',
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
// skill subcommands group (canonical singular; `skills` is a CLI alias)
// =============================================================================

export const skillsCmd = conciseSubcommands({
  name: 'skill',
  description: 'Manage individual skills from plugins',
  cmds: {
    list: listCmd,
    remove: removeCmd,
    add: addCmd,
    search: searchCmd,
    update: skillUpdateCmd,
  },
});
