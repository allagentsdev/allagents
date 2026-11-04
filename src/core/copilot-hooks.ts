import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ValidatedPlugin } from './sync.js';
import type { CopyResult } from './transform.js';
import { resolvePluginComponents } from './plugin-components.js';
import { isPluginHookSourceExcluded } from './plugin-hook-exclusions.js';

export const COPILOT_MANAGED_HOOKS_RELATIVE_PATH =
  '.github/hooks/allagents.json';

type JsonRecord = Record<string, unknown>;

interface CopilotHooksFile {
  version: 1;
  hooks: Record<string, unknown[]>;
}

export interface CopilotHookSyncResult {
  copyResults: CopyResult[];
  warnings: string[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseHooksFile(
  content: string,
  source: string,
  warnings: string[],
): CopilotHooksFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    warnings.push(
      `Copilot hooks: failed to parse ${source}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
  return normalizeHooksFile(parsed, source, warnings);
}

function normalizeHooksFile(
  parsed: unknown,
  source: string,
  warnings: string[],
): CopilotHooksFile | null {

  if (!isRecord(parsed) || (parsed.version !== undefined && parsed.version !== 1) || !isRecord(parsed.hooks)) {
    warnings.push(
      `Copilot hooks: ${source} must contain a hooks object and use version 1 when a version is supplied`,
    );
    return null;
  }

  if (parsed.disableAllHooks === true) {
    return { version: 1, hooks: {} };
  }

  const hooks: Record<string, unknown[]> = {};
  for (const [eventName, entries] of Object.entries(parsed.hooks)) {
    if (!Array.isArray(entries)) {
      warnings.push(
        `Copilot hooks: event '${eventName}' in ${source} must be an array`,
      );
      return null;
    }
    hooks[eventName] = entries;
  }

  return { version: 1, hooks };
}

function withPluginRoot(
  hooksFile: CopilotHooksFile,
  pluginRoot: string,
): CopilotHooksFile {
  const hooks = Object.fromEntries(
    Object.entries(hooksFile.hooks).map(([eventName, entries]) => [
      eventName,
      entries.map((entry) => {
        if (!isRecord(entry)) return entry;
        const existingEnv = isRecord(entry.env) ? entry.env : {};
        return {
          ...entry,
          env: {
            ...existingEnv,
            COPILOT_PLUGIN_ROOT: pluginRoot,
          },
        };
      }),
    ]),
  );
  return { version: 1, hooks };
}

export async function collectPluginCopilotHooks(
  plugin: ValidatedPlugin,
  warnings: string[],
): Promise<CopilotHooksFile | null> {
  const components = plugin.components ?? resolvePluginComponents(plugin.resolved, undefined, { exclude: plugin.exclude, hooks: plugin.hooks });
  const files: CopilotHooksFile[] = [];
  for (const source of components.hooks) {
    if (isPluginHookSourceExcluded(plugin, source, components.hookResources)) continue;
    let hooksFile: CopilotHooksFile | null;
    if (source.path) {
      try {
        hooksFile = parseHooksFile(await readFile(source.path, 'utf-8'), source.path, warnings);
      } catch (error) {
        warnings.push(
          `Copilot hooks: failed to read ${source.path}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
    } else {
      hooksFile = normalizeHooksFile(
        { version: 1, hooks: source.inline },
        `${source.declaredIn ?? plugin.resolved}#hooks`,
        warnings,
      );
    }
    if (!hooksFile) return null;
    files.push(withPluginRoot(hooksFile, plugin.resolved));
  }
  return files.length > 0 ? mergeHooks(files) : null;
}

function pluginTargetsCopilot(plugin: ValidatedPlugin): boolean {
  return (
    plugin.success &&
    plugin.hooks !== false &&
    plugin.clients.includes('copilot')
  );
}

function mergeHooks(files: CopilotHooksFile[]): CopilotHooksFile {
  const hooks: Record<string, unknown[]> = {};
  for (const file of files) {
    for (const [eventName, entries] of Object.entries(file.hooks)) {
      if (entries.length === 0) continue;
      hooks[eventName] = [...(hooks[eventName] ?? []), ...entries];
    }
  }
  return { version: 1, hooks };
}

export async function syncCopilotProjectHooks(
  validatedPlugins: ValidatedPlugin[],
  workspacePath: string,
  options: { dryRun?: boolean; previouslyManaged?: boolean } = {},
): Promise<CopilotHookSyncResult> {
  const warnings: string[] = [];
  const hookFiles = await Promise.all(
    validatedPlugins
      .filter(pluginTargetsCopilot)
      .map((plugin) => collectPluginCopilotHooks(plugin, warnings)),
  );
  const merged = mergeHooks(
    hookFiles.filter((file): file is CopilotHooksFile => file !== null),
  );

  if (Object.keys(merged.hooks).length === 0) {
    return { copyResults: [], warnings };
  }

  const hooksPath = join(workspacePath, COPILOT_MANAGED_HOOKS_RELATIVE_PATH);
  if (existsSync(hooksPath) && !options.previouslyManaged) {
    warnings.push(
      `Copilot hooks: not updating ${COPILOT_MANAGED_HOOKS_RELATIVE_PATH} because the existing file is not owned by AllAgents`,
    );
    return { copyResults: [], warnings };
  }

  if (!options.dryRun) {
    await mkdir(dirname(hooksPath), { recursive: true });
    await writeFile(hooksPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf-8');
  }

  return {
    copyResults: [
      {
        source: 'copilot-plugin-hooks',
        destination: hooksPath,
        action: 'generated',
      },
    ],
    warnings,
  };
}
