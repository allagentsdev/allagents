import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginConfigSource } from '../models/plugin-components.js';
import type { ValidatedPlugin } from './sync.js';
import { assertPluginComponentPath } from './plugin-components.js';
import { isExcluded } from './transform.js';

/** Recheck declarations and never activate an excluded known hook payload. */
export function isPluginHookSourceExcluded(
  plugin: Pick<ValidatedPlugin, 'resolved' | 'exclude' | 'components'>,
  source: PluginConfigSource,
  hookResources: readonly string[] = plugin.components?.hookResources ?? [],
): boolean {
  const declaration = source.path ?? source.declaredIn;
  if (declaration && isExcluded(plugin.resolved, declaration, plugin.exclude)) return true;
  if (source.declaredIn) assertPluginComponentPath(plugin.resolved, source.declaredIn);
  if (source.path) assertPluginComponentPath(plugin.resolved, source.path);
  if (!plugin.exclude?.length) return false;

  const payloadDirectories = new Set([
    join(plugin.resolved, 'hooks'),
    ...hookResources,
  ]);

  function visit(directory: string): boolean {
    if (isExcluded(plugin.resolved, directory, plugin.exclude)) return true;
    assertPluginComponentPath(plugin.resolved, directory);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (isExcluded(plugin.resolved, path, plugin.exclude)) return true;
      assertPluginComponentPath(plugin.resolved, path);
      if (entry.isDirectory() && visit(path)) return true;
      // Do not follow payload symlinks while discovering exclusions.
    }
    return false;
  }

  for (const directory of payloadDirectories) {
    if (!existsSync(directory)) continue;
    if (isExcluded(plugin.resolved, directory, plugin.exclude)) return true;
    assertPluginComponentPath(plugin.resolved, directory);
    if (statSync(directory).isDirectory() && visit(directory)) return true;
  }
  return false;
}
