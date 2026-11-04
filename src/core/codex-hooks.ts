import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import type { SyncState } from '../models/sync-state.js';
import type { ClientType } from '../models/workspace-config.js';
import { isExcluded, type CopyResult } from './transform.js';
import type { ValidatedPlugin } from './sync.js';
import type { PluginConfigSource } from '../models/plugin-components.js';
import { assertPluginComponentPath, resolvePluginComponents } from './plugin-components.js';
import { isPluginHookSourceExcluded } from './plugin-hook-exclusions.js';

const CODEX_HOOKS_RELATIVE_PATH = '.codex/hooks.json';
const CODEX_PLUGIN_MANIFEST_RELATIVE_PATH = '.codex-plugin/plugin.json';

const CODEX_HOOK_EVENT_ORDER = [
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SessionStart',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'Stop',
] as const;

const CODEX_HOOK_EVENTS = new Set<string>(CODEX_HOOK_EVENT_ORDER);

type JsonRecord = Record<string, unknown>;
interface NormalizeHooksOptions {
  filterCodexEvents: boolean;
  strictEventArrays?: boolean;
}

export type CodexHooksFile = NonNullable<SyncState['codexHooks']>;

interface CodexHookSyncResult {
  copyResults: CopyResult[];
  warnings: string[];
  managedHooks?: CodexHooksFile;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function hasHooks(file: CodexHooksFile | undefined): file is CodexHooksFile {
  if (!file) return false;
  return Object.values(file.hooks).some((groups) => groups.length > 0);
}

function orderedHooks(hooks: Record<string, unknown[]>): Record<string, unknown[]> {
  const ordered: Record<string, unknown[]> = {};
  const remaining = new Set(Object.keys(hooks));

  for (const event of CODEX_HOOK_EVENT_ORDER) {
    if (remaining.has(event)) {
      ordered[event] = hooks[event] ?? [];
      remaining.delete(event);
    }
  }

  for (const event of [...remaining].sort()) {
    ordered[event] = hooks[event] ?? [];
  }

  return ordered;
}

function normalizeHooksObject(
  value: unknown,
  source: string,
  warnings: string[],
  options: NormalizeHooksOptions,
): CodexHooksFile | null {
  if (!isRecord(value) || !isRecord(value.hooks)) {
    warnings.push(`Codex hooks: ${source} must contain a hooks object`);
    return null;
  }

  const hooks: Record<string, unknown[]> = {};
  for (const [eventName, groups] of Object.entries(value.hooks)) {
    if (options.filterCodexEvents && !CODEX_HOOK_EVENTS.has(eventName)) {
      warnings.push(`Codex hooks: unsupported event '${eventName}' in ${source} was skipped`);
      continue;
    }
    if (!Array.isArray(groups)) {
      warnings.push(`Codex hooks: event '${eventName}' in ${source} must be an array`);
      if (options.strictEventArrays) {
        return null;
      }
      continue;
    }
    hooks[eventName] = cloneJson(groups);
  }

  return { hooks: orderedHooks(hooks) };
}

function parseHooksJson(
  content: string,
  source: string,
  warnings: string[],
  options: NormalizeHooksOptions,
): CodexHooksFile | null {
  try {
    return normalizeHooksObject(JSON.parse(content), source, warnings, options);
  } catch (error) {
    warnings.push(
      `Codex hooks: failed to parse ${source}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function readHooksJson(
  path: string,
  warnings: string[],
  options: NormalizeHooksOptions,
): CodexHooksFile | null {
  try {
    return parseHooksJson(readFileSync(path, 'utf-8'), path, warnings, options);
  } catch (error) {
    warnings.push(
      `Codex hooks: failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function resolveManifestPath(
  pluginPath: string,
  field: string,
  rawPath: string,
  warnings: string[],
): string | null {
  if (!rawPath.startsWith('./')) {
    warnings.push(`Codex hooks: ignoring ${field}; path must start with './'`);
    return null;
  }

  const relativePath = rawPath.slice(2);
  if (!relativePath) {
    warnings.push(`Codex hooks: ignoring ${field}; path must not be './'`);
    return null;
  }
  if (isAbsolute(relativePath)) {
    warnings.push(`Codex hooks: ignoring ${field}; path must stay within the plugin root`);
    return null;
  }

  const normalized = normalize(relativePath).replace(/\\/g, '/');
  if (normalized === '..' || normalized.startsWith('../')) {
    warnings.push(`Codex hooks: ignoring ${field}; path must not contain '..'`);
    return null;
  }

  return join(pluginPath, normalized);
}

function substitutePluginEnv(value: unknown, env: Record<string, string>): unknown {
  if (typeof value === 'string') {
    return Object.entries(env).reduce(
      (current, [key, replacement]) => current.replaceAll(`\${${key}}`, replacement),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => substitutePluginEnv(entry, env));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, substitutePluginEnv(entry, env)]),
    );
  }
  return value;
}

function withPluginEnv(
  hooksFile: CodexHooksFile,
  pluginPath: string,
  pluginDataPath: string,
): CodexHooksFile {
  const env = {
    PLUGIN_ROOT: pluginPath,
    CLAUDE_PLUGIN_ROOT: pluginPath,
    PLUGIN_DATA: pluginDataPath,
    CLAUDE_PLUGIN_DATA: pluginDataPath,
  };
  return substitutePluginEnv(hooksFile, env) as CodexHooksFile;
}

function pluginDataPath(workspacePath: string, plugin: ValidatedPlugin): string {
  const rawName = plugin.pluginName ?? basename(plugin.resolved) ?? 'plugin';
  const safeName = rawName.replace(/[^a-zA-Z0-9_.-]/g, '-');
  return join(workspacePath, '.allagents', 'plugin-data', safeName);
}

function readManifestHookDeclarations(
  pluginPath: string,
  manifestPath: string,
  warnings: string[],
): PluginConfigSource[] | null {
  assertPluginComponentPath(pluginPath, manifestPath);
  let manifest: JsonRecord;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    if (!isRecord(parsed)) {
      throw new Error('Codex plugin hook manifest must contain a JSON object');
    }
    manifest = parsed;
  } catch (error) {
    throw new Error(`Invalid Codex plugin hook manifest: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!('hooks' in manifest)) {
    return null;
  }

  const hooks = manifest.hooks;
  if (typeof hooks === 'string') {
    const path = resolveManifestPath(pluginPath, 'hooks', hooks, warnings);
    if (!path) throw new Error('Codex plugin hook path is invalid');
    return [{ path, declaredIn: manifestPath }];
  }

  if (Array.isArray(hooks) && hooks.every((entry) => typeof entry === 'string')) {
    const paths = hooks
      .map((entry) => resolveManifestPath(pluginPath, 'hooks', entry, warnings))
      .filter((entry): entry is string => entry !== null);
    if (paths.length !== hooks.length) throw new Error('Codex plugin hook paths are invalid');
    return paths.map((path) => ({ path, declaredIn: manifestPath }));
  }

  if (Array.isArray(hooks) && hooks.every(isRecord)) {
    const declarations: PluginConfigSource[] = [];
    for (const [index, entry] of hooks.entries()) {
      const inline = normalizeHooksObject(entry, `${manifestPath}#hooks[${index}]`, warnings, {
        filterCodexEvents: true,
        strictEventArrays: true,
      });
      if (!inline) throw new Error('Codex plugin inline hook configuration is invalid');
      declarations.push({ inline: inline.hooks, declaredIn: manifestPath });
    }
    return declarations;
  }

  if (isRecord(hooks)) {
    const inline = normalizeHooksObject(hooks, `${manifestPath}#hooks`, warnings, {
      filterCodexEvents: true,
      strictEventArrays: true,
    });
    if (!inline) throw new Error('Codex plugin inline hook configuration is invalid');
    return [{ inline: inline.hooks, declaredIn: manifestPath }];
  }

  throw new Error('Codex plugin hooks must be configuration paths or inline hook maps');
}

export function collectPluginCodexHooks(
  plugin: ValidatedPlugin,
  workspacePath: string,
  warnings: string[],
): CodexHooksFile[] {
  if (plugin.hooks === false) return [];
  const pluginPath = plugin.resolved;
  const manifestPath = join(pluginPath, CODEX_PLUGIN_MANIFEST_RELATIVE_PATH);
  const declarations = existsSync(manifestPath)
    ? (isExcluded(pluginPath, manifestPath, plugin.exclude)
      ? []
      : readManifestHookDeclarations(pluginPath, manifestPath, warnings))
    : null;
  const components = plugin.components ?? resolvePluginComponents(pluginPath, undefined, { exclude: plugin.exclude, hooks: plugin.hooks });
  const effectiveDeclarations = declarations ?? components.hooks;

  const dataPath = pluginDataPath(workspacePath, plugin);
  const hooksFiles: CodexHooksFile[] = [];

  for (const declaration of effectiveDeclarations) {
    if (isPluginHookSourceExcluded(plugin, declaration, components.hookResources)) continue;
    const hooksFile = declaration.path
      ? readHooksJson(declaration.path, warnings, { filterCodexEvents: true, strictEventArrays: true })
      : normalizeHooksObject(
        { hooks: declaration.inline },
        `${declaration.declaredIn ?? pluginPath}#hooks`,
        warnings,
        { filterCodexEvents: true, strictEventArrays: true },
      );
    if (!hooksFile) throw new Error('Selected Codex plugin hook configuration is unreadable or invalid');
    if (hasHooks(hooksFile)) {
      hooksFiles.push(withPluginEnv(hooksFile, pluginPath, dataPath));
    }
  }

  return hooksFiles;
}

function mergeHooks(files: CodexHooksFile[]): CodexHooksFile {
  const merged: Record<string, unknown[]> = {};
  for (const file of files) {
    for (const [eventName, groups] of Object.entries(file.hooks)) {
      if (groups.length === 0) continue;
      merged[eventName] = [...(merged[eventName] ?? []), ...cloneJson(groups)];
    }
  }
  return { hooks: orderedHooks(merged) };
}

function removeManagedHooks(
  existing: CodexHooksFile,
  previousManaged: CodexHooksFile | undefined,
): CodexHooksFile {
  if (!hasHooks(previousManaged)) return cloneJson(existing);

  const hooks = cloneJson(existing.hooks);
  for (const [eventName, previousGroups] of Object.entries(previousManaged.hooks)) {
    const groups = hooks[eventName];
    if (!groups || groups.length === 0) continue;

    for (const previousGroup of previousGroups) {
      const previousKey = JSON.stringify(previousGroup);
      const index = groups.findIndex((group) => JSON.stringify(group) === previousKey);
      if (index !== -1) {
        groups.splice(index, 1);
      }
    }

    if (groups.length === 0) {
      delete hooks[eventName];
    }
  }

  return { hooks: orderedHooks(hooks) };
}

function appendManagedHooks(base: CodexHooksFile, currentManaged: CodexHooksFile): CodexHooksFile {
  const hooks = cloneJson(base.hooks);
  for (const [eventName, groups] of Object.entries(currentManaged.hooks)) {
    if (groups.length === 0) continue;
    hooks[eventName] = [...(hooks[eventName] ?? []), ...cloneJson(groups)];
  }
  return { hooks: orderedHooks(hooks) };
}

function readExistingProjectHooks(
  hooksPath: string,
  warnings: string[],
): { hooks: CodexHooksFile; valid: boolean } {
  if (!existsSync(hooksPath)) {
    return { hooks: { hooks: {} }, valid: true };
  }

  const parsed = readHooksJson(hooksPath, warnings, {
    filterCodexEvents: false,
    strictEventArrays: true,
  });
  return parsed
    ? { hooks: parsed, valid: true }
    : { hooks: { hooks: {} }, valid: false };
}

function writeProjectHooks(hooksPath: string, hooksFile: CodexHooksFile): void {
  mkdirSync(dirname(hooksPath), { recursive: true });
  writeFileSync(hooksPath, `${JSON.stringify(hooksFile, null, 2)}\n`, 'utf-8');
}

function pluginTargetsCodex(plugin: ValidatedPlugin): boolean {
  return (
    plugin.success &&
    plugin.hooks !== false &&
    plugin.clients.includes('codex' as ClientType)
  );
}

export function syncCodexProjectHooks(
  validatedPlugins: ValidatedPlugin[],
  workspacePath: string,
  previousManagedHooks: CodexHooksFile | undefined,
  options: { dryRun?: boolean } = {},
): CodexHookSyncResult {
  const warnings: string[] = [];
  const codexPlugins = validatedPlugins.filter((plugin) => plugin.success && pluginTargetsCodex(plugin));
  const currentManagedHooks = mergeHooks(
    codexPlugins.flatMap((plugin) => collectPluginCodexHooks(plugin, workspacePath, warnings)),
  );
  const hasCurrentManagedHooks = hasHooks(currentManagedHooks);
  const hadPreviousManagedHooks = hasHooks(previousManagedHooks);

  if (!hasCurrentManagedHooks && !hadPreviousManagedHooks) {
    return { copyResults: [], warnings };
  }

  const hooksPath = join(workspacePath, CODEX_HOOKS_RELATIVE_PATH);
  const { hooks: existingHooks, valid } = readExistingProjectHooks(hooksPath, warnings);
  if (!valid) {
    warnings.push(
      `Codex hooks: not updating ${CODEX_HOOKS_RELATIVE_PATH} because the existing file could not be parsed`,
    );
    return {
      copyResults: [],
      warnings,
      ...(hadPreviousManagedHooks && { managedHooks: previousManagedHooks }),
    };
  }

  const withoutPreviousManaged = removeManagedHooks(existingHooks, previousManagedHooks);
  const withoutManagedDuplicates = removeManagedHooks(
    withoutPreviousManaged,
    currentManagedHooks,
  );
  const finalHooks = hasCurrentManagedHooks
    ? appendManagedHooks(withoutManagedDuplicates, currentManagedHooks)
    : withoutManagedDuplicates;
  const hasFinalHooks = hasHooks(finalHooks);

  if (!options.dryRun) {
    if (hasFinalHooks) {
      writeProjectHooks(hooksPath, finalHooks);
    } else if (existsSync(hooksPath)) {
      unlinkSync(hooksPath);
    }

    for (const plugin of codexPlugins) {
      const dataPath = pluginDataPath(workspacePath, plugin);
      if (hasCurrentManagedHooks) {
        mkdirSync(dataPath, { recursive: true });
      }
    }
  }

  return {
    copyResults: [
      {
        source: 'codex-plugin-hooks',
        destination: hooksPath,
        action: 'generated',
      },
    ],
    warnings,
    ...(hasCurrentManagedHooks && { managedHooks: currentManagedHooks }),
  };
}
