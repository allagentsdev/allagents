import { randomUUID } from 'node:crypto';
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { serializeWorkspaceConfig } from '../utils/workspace-writer.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import type {
  PreparedUnitReconciliation,
  SkillUpdateInstallation,
  SkillUpdateUnit,
} from '../core/skill-update.js';
import { getUserWorkspaceConfigPath } from '../core/user-workspace.js';
import {
  pruneDisabledSkillsForPlugin,
  pruneEnabledSkillsForPlugin,
} from '../core/workspace-modify.js';
import {
  type WorkspaceConfig,
  getPluginSource,
} from '../models/workspace-config.js';
import {
  validateProjectWorkspaceConfig,
  validateUserWorkspaceConfig,
} from '../utils/workspace-parser.js';
import { loadYaml } from '../utils/yaml.js';

export interface CreateSkillUpdateReconcilerOptions {
  workspacePath: string;
  userConfigPath?: string;
  /** Fault-injection seam used to prove multi-file rollback. */
  beforeReplace?: (path: string) => void | Promise<void>;
}

interface ConfigStage {
  path: string;
  original: string;
  tempPath: string;
}

function configPathForInstallation(
  installation: SkillUpdateInstallation,
  options: CreateSkillUpdateReconcilerOptions,
): string {
  return installation.scope === 'project'
    ? join(options.workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE)
    : (options.userConfigPath ?? getUserWorkspaceConfigPath());
}

function parseConfig(
  content: string,
  path: string,
  scope: SkillUpdateInstallation['scope'],
): WorkspaceConfig {
  const raw = loadYaml(content);
  if (scope === 'user') {
    validateUserWorkspaceConfig(raw, path);
  } else {
    validateProjectWorkspaceConfig(raw, path);
  }
  // Validate with the correct scoped schema, but transform the raw object so
  // defaults and client shorthand normalization do not rewrite unrelated user
  // configuration.
  return raw as WorkspaceConfig;
}

function removePluginEntry(config: WorkspaceConfig, index: number): void {
  const entry = config.plugins[index];
  if (!entry) throw new Error(`Plugin entry at index ${index} not found`);
  const source = getPluginSource(entry);
  config.plugins.splice(index, 1);
  pruneDisabledSkillsForPlugin(config, source);
  pruneEnabledSkillsForPlugin(config, source);
}

function selectorForImpact(
  allowlist: string[],
  impact: SkillUpdateUnit['deleted'][number],
  allowBareWithQualified = false,
): string | undefined {
  if (impact.selector && allowlist.includes(impact.selector)) {
    return impact.selector;
  }
  if (allowlist.includes(impact.subpath)) return impact.subpath;
  // Older bare-name configs did not retain a qualified selector. Only use the
  // leaf fallback when there is no competing qualified selector in the entry.
  if (
    allowlist.includes(impact.name) &&
    (allowBareWithQualified ||
      !allowlist.some(
        (selector) =>
          selector !== impact.name &&
          selector.split('/').at(-1) === impact.name,
      ))
  ) {
    return impact.name;
  }
  return undefined;
}

function reconcileSelectorList(
  selectors: string[],
  deleted: SkillUpdateUnit['deleted'],
  survivors: SkillUpdateUnit['survivors'],
  prefix = '',
): string[] {
  const localSelectors = prefix
    ? selectors
        .filter((selector) => selector.startsWith(prefix))
        .map((selector) => selector.slice(prefix.length))
    : selectors;
  const replacements = new Map<string, string[]>();

  for (const impact of deleted) {
    const selector = selectorForImpact(
      localSelectors,
      impact,
      prefix.length > 0,
    );
    if (!selector) continue;

    const survivingPaths =
      selector === impact.name
        ? survivors
            .filter(
              (survivor) =>
                survivor.name === impact.name &&
                survivor.subpath !== impact.subpath,
            )
            .map((survivor) => `${prefix}${survivor.subpath}`)
        : [];
    replacements.set(`${prefix}${selector}`, survivingPaths);
  }

  if (replacements.size === 0) return selectors;

  const replacementValues = new Set([...replacements.values()].flat());
  const emittedReplacementValues = new Set<string>();
  const reconciled: string[] = [];

  for (const selector of selectors) {
    const replacement = replacements.get(selector);
    if (replacement) {
      for (const survivingSelector of replacement) {
        if (emittedReplacementValues.has(survivingSelector)) continue;
        reconciled.push(survivingSelector);
        emittedReplacementValues.add(survivingSelector);
      }
      continue;
    }
    if (
      replacementValues.has(selector) &&
      emittedReplacementValues.has(selector)
    ) {
      continue;
    }
    reconciled.push(selector);
    if (replacementValues.has(selector)) {
      emittedReplacementValues.add(selector);
    }
  }

  return reconciled;
}

function reconcileLegacySelectors(
  config: WorkspaceConfig,
  installations: SkillUpdateInstallation[],
  unit: SkillUpdateUnit,
): void {
  if (config.version !== undefined && config.version >= 2) return;

  const installationIdsByPlugin = new Map<string, Set<string>>();
  for (const installation of installations) {
    const ids =
      installationIdsByPlugin.get(installation.pluginName) ?? new Set();
    ids.add(installation.id);
    installationIdsByPlugin.set(installation.pluginName, ids);
  }

  for (const [pluginName, installationIds] of installationIdsByPlugin) {
    const deleted = unit.deleted.filter((impact) =>
      installationIds.has(impact.installationId),
    );
    if (deleted.length === 0) continue;
    const survivors = unit.survivors.filter((impact) =>
      installationIds.has(impact.installationId),
    );
    const prefix = `${pluginName}:`;

    if (config.enabledSkills) {
      config.enabledSkills = reconcileSelectorList(
        config.enabledSkills,
        deleted,
        survivors,
        prefix,
      );
      if (config.enabledSkills.length === 0) config.enabledSkills = undefined;
    }
    if (config.disabledSkills) {
      config.disabledSkills = reconcileSelectorList(
        config.disabledSkills,
        deleted,
        survivors,
        prefix,
      );
      if (config.disabledSkills.length === 0) config.disabledSkills = undefined;
    }
  }
}

function transformConfig(
  original: string,
  path: string,
  installations: SkillUpdateInstallation[],
  unit: SkillUpdateUnit,
): string {
  const scope = installations[0]?.scope;
  if (!scope) {
    throw new Error(`No installations supplied for staged config ${path}`);
  }
  if (installations.some((installation) => installation.scope !== scope)) {
    throw new Error(`Mixed user and project installations target ${path}`);
  }
  const config = parseConfig(original, path, scope);
  const removedInstallationIds = new Set(unit.removedInstallationIds ?? []);
  const survivorInstallationIds = new Set(
    unit.survivors.map((impact) => impact.installationId),
  );
  const deletedByInstallation = new Map<string, SkillUpdateUnit['deleted']>();
  for (const impact of unit.deleted) {
    const deleted = deletedByInstallation.get(impact.installationId) ?? [];
    deleted.push(impact);
    deletedByInstallation.set(impact.installationId, deleted);
  }
  const removeIndexes = new Set<number>();

  for (const installation of installations) {
    const entry = config.plugins[installation.configIndex];
    if (!entry) {
      throw new Error(
        `Plugin entry ${installation.configIndex} for ${installation.rawSource} no longer exists in ${path}`,
      );
    }
    if (getPluginSource(entry) !== installation.rawSource) {
      throw new Error(
        `Plugin entry ${installation.configIndex} changed in ${path}; expected ${installation.rawSource}`,
      );
    }

    if (removedInstallationIds.has(installation.id)) {
      removeIndexes.add(installation.configIndex);
      continue;
    }

    const deleted = deletedByInstallation.get(installation.id) ?? [];
    if (deleted.length === 0) continue;
    if (
      installation.standaloneSkillSource &&
      !survivorInstallationIds.has(installation.id)
    ) {
      removeIndexes.add(installation.configIndex);
      continue;
    }
    if (typeof entry === 'string') continue;
    if (!Array.isArray(entry.skills)) {
      // Implicit and blocklist installs are purged by the confirmed offline
      // sync. Recording an exclusion for content that no longer exists would
      // leave stale user configuration behind.
      continue;
    }

    for (const impact of deleted) {
      if (!selectorForImpact(entry.skills, impact)) {
        throw new Error(
          `Configured selector for ${installation.pluginName}:${impact.subpath} no longer matches ${path}`,
        );
      }
    }
    const survivors = unit.survivors.filter(
      (impact) => impact.installationId === installation.id,
    );
    entry.skills = reconcileSelectorList(entry.skills, deleted, survivors);
    if (entry.skills.length === 0 && installation.standaloneSkillSource) {
      removeIndexes.add(installation.configIndex);
    }
  }

  reconcileLegacySelectors(config, installations, unit);

  for (const index of [...removeIndexes].sort((left, right) => right - left)) {
    removePluginEntry(config, index);
  }

  const replacement = serializeWorkspaceConfig(config, original, {
    removedPluginIndexes: [...removeIndexes],
  });
  parseConfig(replacement, path, scope);
  return replacement;
}

function tempPathFor(path: string, label: string): string {
  return join(
    dirname(path),
    `.${basename(path)}.allagents-${label}-${randomUUID()}.tmp`,
  );
}

async function writeTemp(
  path: string,
  content: string,
  mode: number,
): Promise<void> {
  await writeFile(path, content, {
    encoding: 'utf-8',
    flag: 'wx',
    mode,
  });
}

async function cleanupTemp(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

/**
 * Build the config side of a physical skill-update transaction. Preparation
 * validates and stages every affected file without changing live config. The
 * returned commit replaces files atomically one at a time and restores every
 * earlier replacement if a later one fails.
 */
export function createSkillUpdateReconciler(
  options: CreateSkillUpdateReconcilerOptions,
): (unit: SkillUpdateUnit) => Promise<PreparedUnitReconciliation> {
  return async (unit: SkillUpdateUnit) => {
    const affectedInstallationIds = new Set([
      ...unit.deleted.map((impact) => impact.installationId),
      ...(unit.removedInstallationIds ?? []),
    ]);
    const byPath = new Map<string, SkillUpdateInstallation[]>();
    for (const installation of unit.installations) {
      if (!affectedInstallationIds.has(installation.id)) continue;
      const path = configPathForInstallation(installation, options);
      const entries = byPath.get(path) ?? [];
      entries.push(installation);
      byPath.set(path, entries);
    }

    const stages: ConfigStage[] = [];
    try {
      for (const [path, installations] of byPath) {
        const original = await readFile(path, 'utf-8');
        const replacement = transformConfig(
          original,
          path,
          installations,
          unit,
        );
        if (replacement === original) continue;
        const tempPath = tempPathFor(path, 'next');
        const currentStat = await stat(path);
        await writeTemp(tempPath, replacement, currentStat.mode);
        stages.push({ path, original, tempPath });
      }
    } catch (error) {
      await Promise.all(stages.map((stage) => cleanupTemp(stage.tempPath)));
      throw error;
    }

    let state: 'prepared' | 'committed' | 'rolled-back' = 'prepared';
    const committed: ConfigStage[] = [];

    const restore = async (stage: ConfigStage): Promise<void> => {
      const current = await readFile(stage.path, 'utf-8');
      if (current === stage.original) return;
      const restorePath = tempPathFor(stage.path, 'rollback');
      const currentStat = await stat(stage.path);
      try {
        await writeTemp(restorePath, stage.original, currentStat.mode);
        await rename(restorePath, stage.path);
      } finally {
        await cleanupTemp(restorePath);
      }
    };

    const rollback = async (): Promise<void> => {
      if (state === 'rolled-back') return;
      for (const stage of [...committed].reverse()) await restore(stage);
      await Promise.all(stages.map((stage) => cleanupTemp(stage.tempPath)));
      state = 'rolled-back';
    };

    return {
      commit: async () => {
        if (state !== 'prepared') {
          throw new Error(`Config reconciliation is already ${state}`);
        }
        // Fail before the first rename if any config changed since preflight.
        for (const stage of stages) {
          if ((await readFile(stage.path, 'utf-8')) !== stage.original) {
            await rollback();
            throw new Error(
              `Workspace config changed during update: ${stage.path}`,
            );
          }
        }
        try {
          for (const stage of stages) {
            await options.beforeReplace?.(stage.path);
            await rename(stage.tempPath, stage.path);
            committed.push(stage);
          }
          state = 'committed';
        } catch (error) {
          await rollback();
          throw error;
        }
      },
      rollback,
    };
  };
}
