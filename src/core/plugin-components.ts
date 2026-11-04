import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import JSON5 from 'json5';
import { MarketplacePluginEntrySchema, type MarketplacePluginEntry } from '../models/marketplace-manifest.js';
import { GITHUB_ASSISTANT_ENTRIES, ROOT_SKILL_EXCLUDED_ENTRIES, type PluginComponentPolicy, type PluginComponents, type PluginConfigSource } from '../models/plugin-components.js';
import picomatch from 'picomatch';

const PLUGIN_MANIFEST_PATHS = [
  '.plugin/plugin.json',
  'plugin.json',
  '.github/plugin/plugin.json',
  '.claude-plugin/plugin.json',
] as const;
const MARKETPLACE_MANIFEST_PATHS = [
  '.github/plugin/marketplace.json',
  '.claude-plugin/marketplace.json',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function excluded(root: string, path: string, patterns?: string[]): boolean {
  const source = relative(root, path).replaceAll('\\', '/');
  return patterns?.some((pattern) => {
    const matches = picomatch(pattern);
    return matches(source) || matches(`${source}/`);
  }) ?? false;
}

function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Recheck source containment immediately before reading a resolved component. */
export function assertPluginComponentPath(pluginRoot: string, sourcePath: string, exclude?: string[]): void {
  const root = resolve(pluginRoot);
  const source = resolve(sourcePath);
  const within = (base: string, candidate: string) => {
    const path = relative(base, candidate);
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
  };
  if (!within(root, source)) throw new Error('Plugin component path is outside the plugin root');
  if (excluded(root, source, exclude)) return;
  let ancestor = source;
  while (!exists(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error('Plugin component path cannot be resolved safely');
    ancestor = parent;
  }
  if (!within(realpathSync(root), realpathSync(ancestor))) {
    throw new Error('Plugin component symlink points outside the plugin root');
  }
}

function componentPath(root: string, declaration: string, exclude?: string[]): string {
  for (let index = 0; index < declaration.length; index++) {
    const code = declaration.charCodeAt(index);
    if (code < 32 || code === 127) {
      throw new Error('Plugin component paths must be contained in the plugin root');
    }
  }
  if (!declaration || /^[A-Za-z]:/.test(declaration) ||
      declaration.includes('\\') || declaration.split('/').includes('..')) {
    throw new Error('Plugin component paths must be contained in the plugin root');
  }
  const path = resolve(root, declaration);
  assertPluginComponentPath(root, path, exclude);
  return path;
}

/** Validate a distributed source tree before ownership reconciliation. */
export function assertPluginComponentTree(root: string, path: string, exclude?: string[], visited = new Set<string>()): void {
  assertPluginComponentPath(root, path, exclude);
  if (excluded(root, path, exclude)) return;
  if (!exists(path)) return;
  const canonical = realpathSync(path);
  if (visited.has(canonical)) return;
  visited.add(canonical);
  if (!statSync(path).isDirectory()) return;
  for (const entry of readdirSync(path)) {
    if (path === root && ROOT_SKILL_EXCLUDED_ENTRIES.some((excluded) => excluded === entry)) continue;
    assertPluginComponentTree(root, join(path, entry), exclude, visited);
  }
}

function readObject(root: string, path: string, json5 = false): Record<string, unknown> {
  assertPluginComponentPath(root, path);
  let value: unknown;
  try {
    const text = readFileSync(path, 'utf-8');
    value = json5 ? JSON5.parse(text) : JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid plugin configuration '${relative(root, path)}': ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value)) throw new Error(`Plugin configuration '${relative(root, path)}' must be an object`);
  if (typeof value.$schema === 'string' && /agent[-_]?plugins(?:\.dev|\.org|\/)/i.test(value.$schema)) {
    throw new Error('The portable Agent Plugins schema is not supported; use the existing Copilot/Claude plugin manifest and .mcp.json format');
  }
  return value;
}

function firstExisting(root: string, candidates: readonly string[], exclude?: string[]): string | undefined {
  for (const candidate of candidates) {
    const path = resolve(root, candidate);
    assertPluginComponentPath(root, path, exclude);
    if (exists(path)) return path;
  }
  return undefined;
}

function embeddedEntry(root: string, path: string): MarketplacePluginEntry | undefined {
  const marketplace = readObject(root, path);
  if (!Array.isArray(marketplace.plugins)) throw new Error('Marketplace manifest must contain a "plugins" array');
  const entries = marketplace.plugins.filter((entry): entry is Record<string, unknown> =>
    isRecord(entry) && typeof entry.source === 'string' && entry.source.length > 0 && resolve(root, entry.source) === root,
  );
  const selected = entries.find((entry) => entry.name === basename(root)) ?? (entries.length === 1 ? entries[0] : undefined);
  if (!selected) return undefined;
  const parsed = MarketplacePluginEntrySchema.safeParse({
    ...selected,
    description: typeof selected.description === 'string' && selected.description ? selected.description : String(selected.name),
  });
  if (!parsed.success) throw new Error(`Invalid embedded marketplace plugin declaration: ${parsed.error.message}`);
  return parsed.data;
}

/** Resolve native distribution sources once, after the actual plugin root is known. */
export function resolvePluginComponents(pluginPath: string, entry?: MarketplacePluginEntry, policy: PluginComponentPolicy = {}): PluginComponents {
  const root = resolve(pluginPath);
  if (!statSync(root).isDirectory()) throw new Error('Plugin source must be a directory');
  const marketplacePath = firstExisting(root, MARKETPLACE_MANIFEST_PATHS);
  // An embedded catalogue is still validated when an outer catalogue selected this root.
  const ownEntry = marketplacePath ? embeddedEntry(root, marketplacePath) : undefined;
  const selectedEntry = entry ?? ownEntry;
  const manifestPath = firstExisting(root, PLUGIN_MANIFEST_PATHS);
  const manifest = manifestPath ? readObject(root, manifestPath) : undefined;
  const legacyRepository = !manifestPath && !marketplacePath && !entry;
  const warnings: string[] = [];

  const paths = (kind: 'skills' | 'commands' | 'agents'): string[] => {
    // Copilot 1.0.103 ignores catalogue declarations for these component kinds.
    // Plugin manifest declarations replace conventional directories, including [].
    const value = manifest?.[kind];
    if (value !== undefined) {
      if (typeof value !== 'string' && !(Array.isArray(value) && value.every((path) => typeof path === 'string'))) {
        throw new Error(`Plugin manifest ${kind} has an invalid component declaration`);
      }
      const resolved = (typeof value === 'string' ? [value] : value).map((path) => componentPath(root, path, policy.exclude));
      return resolved.filter((path) => {
        if (excluded(root, path, policy.exclude)) return false;
        if (!exists(path)) throw new Error(`Plugin manifest ${kind} path '${relative(root, path)}' was not found`);
        const info = statSync(path);
        if (kind === 'skills' ? !info.isDirectory() : !info.isDirectory() && (!info.isFile() || !path.endsWith('.md'))) {
          throw new Error(`Plugin manifest ${kind} path '${relative(root, path)}' has an unsupported resource type`);
        }
        assertPluginComponentTree(root, path, policy.exclude);
        return true;
      });
    }
    const conventional = componentPath(root, kind, policy.exclude);
    if (excluded(root, conventional, policy.exclude)) return [];
    if (exists(conventional)) {
      if (!statSync(conventional).isDirectory()) throw new Error(`Conventional plugin ${kind} source must be a directory`);
      assertPluginComponentTree(root, conventional, policy.exclude);
      return [conventional];
    }
    if (kind === 'skills' && !excluded(root, join(root, 'SKILL.md'), policy.exclude) && exists(join(root, 'SKILL.md'))) {
      if (!statSync(join(root, 'SKILL.md')).isFile()) throw new Error('Root SKILL.md must be a file');
      assertPluginComponentTree(root, root, policy.exclude);
      return [root];
    }
    return kind === 'skills' && legacyRepository ? [root] : [];
  };

  const conventionalHooks = (): PluginConfigSource[] => {
    const path = firstExisting(root, ['hooks.json', 'hooks/hooks.json'], policy.exclude);
    return path ? [{ path }] : [];
  };
  const configDeclaration = (value: unknown, declaredIn?: string, kind?: 'hooks' | 'mcpServers'): PluginConfigSource[] => {
    if (typeof value === 'string') {
      const path = componentPath(root, value, policy.exclude);
      if (excluded(root, path, policy.exclude)) return [];
      if (kind === 'mcpServers' && isAbsolute(value)) {
        throw new Error('Absolute plugin mcpServers paths are not supported; use a relative configuration path');
      }
      if (!exists(path)) {
        if (kind === 'hooks') return [];
        throw new Error(`Plugin ${kind} path '${relative(root, path)}' was not found`);
      }
      if (!statSync(path).isFile()) throw new Error(`Plugin ${kind} path '${relative(root, path)}' must be a configuration file`);
      return [{ path, ...(declaredIn && { declaredIn }) }];
    }
    if (declaredIn && excluded(root, declaredIn, policy.exclude)) return [];
    if (isRecord(value)) return [{ inline: value, ...(declaredIn && { declaredIn }) }];
    if (value === undefined) return [];
    throw new Error(`Plugin ${kind} has an invalid configuration declaration`);
  };

  let hooks: PluginConfigSource[];
  if (policy.hooks === false) hooks = [];
  else if (manifest?.hooks === undefined) hooks = conventionalHooks();
  else if (typeof manifest.hooks === 'string') {
    hooks = configDeclaration(manifest.hooks, manifestPath, 'hooks');
    if (hooks.length === 0 && !excluded(root, resolve(root, manifest.hooks), policy.exclude) && !exists(componentPath(root, manifest.hooks, policy.exclude))) {
      warnings.push('Plugin manifest hooks path was not found; conventional hooks will be loaded');
      hooks = conventionalHooks();
    }
  } else if (isRecord(manifest.hooks)) hooks = configDeclaration(manifest.hooks, manifestPath, 'hooks');
  else hooks = configDeclaration(manifest.hooks, manifestPath, 'hooks');
  const hooksDirectory = join(root, 'hooks');
  const hookResources = policy.hooks !== false && !excluded(root, hooksDirectory, policy.exclude) && exists(hooksDirectory) && statSync(hooksDirectory).isDirectory()
    ? [hooksDirectory] : [];
  for (const path of hookResources) assertPluginComponentTree(root, path, policy.exclude);

  const conventionalMcp = firstExisting(root, ['.mcp.json', '.github/mcp.json'], policy.exclude);
  let mcpServers: PluginConfigSource[];
  if (conventionalMcp) mcpServers = [{ path: conventionalMcp }];
  else {
    const ownMcp = manifest?.mcpServers;
    const ownEmpty = isRecord(ownMcp) && Object.keys(ownMcp).length === 0;
    const declaration = ownMcp === undefined || ownEmpty ? selectedEntry?.mcpServers : ownMcp;
    const entryDeclaredIn = !entry || (typeof entry.source === 'string' && resolve(root, entry.source) === root && ownEntry?.name === entry.name) ? marketplacePath : undefined;
    const declaredIn = ownMcp === undefined || ownEmpty ? entryDeclaredIn : manifestPath;
    mcpServers = configDeclaration(declaration, declaredIn, 'mcpServers');
  }

  // Malformed source containers are not authoritative absence. Validate before
  // any tracked-file or MCP removal, even where native readers fall back.
  hooks = hooks.filter((source) => {
    if (excluded(root, source.path ?? source.declaredIn ?? root, policy.exclude)) return false;
    const value = source.inline !== undefined ? source.inline : readObject(root, source.path);
    const events = source.path ? value.hooks : value;
    if ((source.path && events === undefined) || (events !== undefined && (!isRecord(events) || Object.values(events).some((event) => !Array.isArray(event))))) {
      throw new Error('Plugin hooks configuration must contain an event map of arrays');
    }
    return true;
  });
  mcpServers = mcpServers.filter((source) => {
    if (excluded(root, source.path ?? source.declaredIn ?? root, policy.exclude)) return false;
    const value = source.inline !== undefined ? source.inline : readObject(root, source.path, true);
    const servers = source.path ? value.mcpServers : value;
    if (!isRecord(servers) || Object.values(servers).some((server) => !isRecord(server) || (typeof server.command !== 'string' && typeof server.url !== 'string'))) {
      throw new Error('Plugin MCP configuration must contain an object of server configurations');
    }
    return true;
  });
  const githubRoot = join(root, '.github');
  if (!excluded(root, githubRoot, policy.exclude) && exists(githubRoot)) {
    assertPluginComponentPath(root, githubRoot, policy.exclude);
    for (const entry of GITHUB_ASSISTANT_ENTRIES) {
      if (entry === 'hooks' && policy.hooks === false) continue;
      const source = join(githubRoot, entry);
      if (!excluded(root, source, policy.exclude) && exists(source)) {
        assertPluginComponentTree(root, source, policy.exclude);
      }
    }
  }
  return { skills: paths('skills'), commands: paths('commands'), agents: paths('agents'), hooks, hookResources, mcpServers, github: true, legacyRepository, ...(warnings.length > 0 && { warnings }) };
}
