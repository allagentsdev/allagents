import { existsSync } from 'node:fs';
import { lstat, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { cloneToTemp, createGit, gitHubUrl } from '../git.js';
import { fetchPlugin } from '../plugin.js';
import {
  isPluginSpec,
  parsePluginSpec,
  resolvePluginSpec,
} from '../marketplace.js';
import {
  getPluginCachePath,
  isGitHubUrl,
  parseGitHubUrl,
  validatePluginSource,
} from '../../utils/plugin-path.js';
import type { ProfileResolvedPlugin } from './types.js';
import type { PluginComponents } from '../../models/plugin-components.js';
import { assertPluginComponentPath, resolvePluginComponents } from '../plugin-components.js';

export interface ProfileSourceRuntime {
  readonly workspaceDirectory: string;
  readonly offline: boolean;
  readonly dryRun: boolean;
}

export interface ResolvedProfileFileSource {
  readonly path: string;
  readonly components: PluginComponents;
  readonly source: string;
  readonly requestedRef?: string;
  readonly resolvedRef?: string;
  readonly resolvedSha?: string;
  readonly marketplace?: string;
  readonly pluginName?: string;
  readonly cleanup?: () => Promise<void>;
}

async function resolveRemoteRepository(
  source: string,
  requestedRef: string | undefined,
  runtime: ProfileSourceRuntime,
): Promise<ResolvedProfileFileSource> {
  const parsed = parseGitHubUrl(source);
  if (!parsed) {
    throw new Error(`Unsupported profile file plugin source '${source}'`);
  }
  const ref = requestedRef ?? parsed.branch;
  if (runtime.offline) {
    const cachePath = getPluginCachePath(parsed.owner, parsed.repo, ref);
    if (!existsSync(cachePath)) {
      throw new Error(
        `Profile plugin '${source}' is not available in the offline cache`,
      );
    }
    let resolvedSha: string | undefined;
    try {
      resolvedSha =
        (await createGit(cachePath).revparse(['HEAD'])).trim() || undefined;
    } catch {
      resolvedSha = undefined;
    }
    const pluginPath = parsed.subpath ? join(cachePath, parsed.subpath) : cachePath;
    assertPluginComponentPath(cachePath, pluginPath);
    return {
      path: pluginPath,
      components: resolvePluginComponents(pluginPath),
      source,
      ...(requestedRef && { requestedRef }),
      ...(ref && { resolvedRef: ref }),
      ...(resolvedSha && { resolvedSha }),
    };
  }

  const temporary = await cloneToTemp(
    gitHubUrl(parsed.owner, parsed.repo),
    ref,
  );
  let resolvedSha: string | undefined;
  try {
    resolvedSha =
      (await createGit(temporary).revparse(['HEAD'])).trim() || undefined;
  } catch {
    resolvedSha = undefined;
  }
  try {
    const pluginPath = parsed.subpath ? join(temporary, parsed.subpath) : temporary;
    assertPluginComponentPath(temporary, pluginPath);
    const components = resolvePluginComponents(pluginPath);
    if (components.format === 'portable' && !runtime.dryRun && components.mcpServers.length > 0) {
      // Portable tools may execute files outside a skill directory. Keep their
      // source in the normal ref-qualified cache after the inspection checkout ends.
      const fetched = await fetchPlugin(source, { ...(ref && { branch: ref }) });
      if (!fetched.success) throw new Error(fetched.error ?? 'Cannot retain portable profile source');
      const retained = parsed.subpath ? join(fetched.cachePath, parsed.subpath) : fetched.cachePath;
      assertPluginComponentPath(fetched.cachePath, retained);
      const retainedComponents = resolvePluginComponents(retained);
      await rm(temporary, { recursive: true, force: true });
      return {
        path: retained,
        components: retainedComponents,
        source,
        ...(requestedRef && { requestedRef }),
        ...(ref && { resolvedRef: ref }),
        ...(fetched.resolvedSha && { resolvedSha: fetched.resolvedSha }),
      };
    }
    return {
      path: pluginPath,
      components,
      source,
      ...(requestedRef && { requestedRef }),
      ...(ref && { resolvedRef: ref }),
      ...(resolvedSha && { resolvedSha }),
      cleanup: () => rm(temporary, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function resolveProfileFileSource(
  plugin: ProfileResolvedPlugin,
  runtime: ProfileSourceRuntime,
): Promise<ResolvedProfileFileSource> {
  if (plugin.requestedRef && !isGitHubUrl(plugin.source)) {
    throw new Error(
      `Profile plugin ref '${plugin.requestedRef}' requires a GitHub repository source`,
    );
  }
  if (isPluginSpec(plugin.source)) {
    const parsed = parsePluginSpec(plugin.source);
    const resolved = await resolvePluginSpec(plugin.source, {
      offline: runtime.offline || runtime.dryRun,
      workspacePath: runtime.workspaceDirectory,
    });
    if (!resolved || !parsed) {
      throw new Error(
        `Profile marketplace plugin '${plugin.source}' is not registered and cached`,
      );
    }
    return {
      path: resolved.path,
      components: resolved.components ?? resolvePluginComponents(resolved.path),
      source: plugin.source,
      ...(plugin.requestedRef && { requestedRef: plugin.requestedRef }),
      marketplace: resolved.marketplace,
      pluginName: resolved.plugin,
    };
  }
  if (isGitHubUrl(plugin.source)) {
    return resolveRemoteRepository(plugin.source, plugin.requestedRef, runtime);
  }

  const candidate = isAbsolute(plugin.source)
    ? resolve(plugin.source)
    : resolve(runtime.workspaceDirectory, plugin.source);
  const validation = validatePluginSource(candidate);
  if (!validation.valid) {
    throw new Error(
      validation.error ?? `Invalid profile plugin source '${plugin.source}'`,
    );
  }
  const stats = await lstat(candidate).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(
      `Profile file plugin source must be a real directory: ${candidate}`,
    );
  }
  return {
    path: candidate,
    components: resolvePluginComponents(candidate),
    source: plugin.source,
    ...(plugin.requestedRef && { requestedRef: plugin.requestedRef }),
  };
}
