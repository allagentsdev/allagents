import { existsSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { getHomeDir } from '../constants.js';
import {
  CLIENT_MAPPINGS,
  USER_CLIENT_MAPPINGS,
  getMapping,
  type ClientMapping,
  type ClientMappings,
} from '../models/client-mapping.js';
import type { ClientType } from '../models/workspace-config.js';

export type ClientScope = 'project' | 'user';

export interface ClientResolutionOptions {
  homeDir?: string;
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  pathExists?: (path: string) => boolean;
  /** Explicit project boundary. `null` means no repository boundary. */
  repoRoot?: string | null;
}

export interface OmpResolvedRoots {
  config: string;
  agent: string;
  data: string;
  state: string;
  cache: string;
  dataAgent: string;
  stateAgent: string;
  cacheAgent: string;
}

export interface ResolvedClientContext {
  client: ClientType;
  scope: ClientScope;
  /** Root that owns materialized files and bounds cleanup. */
  writeRoot: string;
  /** Concrete mapping used by transforms and sync state. */
  mapping: ClientMapping;
  /** Ordered, concrete directories inspected for repository skills. */
  skillDiscoveryRoots: readonly string[];
  commandCwd: string;
  /** Environment for ordinary client commands. OMP profile selectors are absent. */
  commandEnv: Readonly<Record<string, string | undefined>>;
  ompRoots?: OmpResolvedRoots;
}

const MAPPING_PATH_KEYS = [
  'commandsPath',
  'skillsPath',
  'agentsPath',
  'hooksPath',
  'githubPath',
] as const satisfies readonly (keyof ClientMapping)[];

function expandHome(input: string, homeDir: string): string {
  if (input === '~') return homeDir;
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return join(homeDir, input.slice(2));
  }
  return input;
}

function resolveRuntimePath(input: string, cwd: string, homeDir: string): string {
  return resolve(cwd, expandHome(input, homeDir));
}

export function pathIsWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/** Resolve a mapping path without allowing an absolute mapping to be rebased. */
export function resolveMappedPath(base: string, mappedPath: string): string {
  return resolve(base, mappedPath);
}

function withDirectorySuffix(path: string, directory: boolean): string {
  if (!directory || path.endsWith('/') || path.endsWith('\\')) return path;
  return `${path}/`;
}

function representDestination(
  operationRoot: string,
  destination: string,
  directory: boolean,
): string {
  const absoluteRoot = resolve(operationRoot);
  const absoluteDestination = resolve(destination);
  const represented = pathIsWithin(absoluteRoot, absoluteDestination)
    ? relative(absoluteRoot, absoluteDestination) || '.'
    : absoluteDestination;
  return withDirectorySuffix(represented.replaceAll('\\', '/'), directory);
}

function relocateMapping(
  mapping: ClientMapping,
  operationRoot: string,
  fromRoot: string,
  toRoot: string,
): ClientMapping {
  const relocate = (value: string, directory: boolean): string =>
    representDestination(
      operationRoot,
      join(toRoot, relative(fromRoot, resolveMappedPath(operationRoot, value))),
      directory,
    );
  const relocated: ClientMapping = {
    skillsPath: relocate(mapping.skillsPath, true),
  };

  for (const key of MAPPING_PATH_KEYS) {
    if (key === 'skillsPath') continue;
    const value = mapping[key];
    if (!value) continue;
    relocated[key] = relocate(value, true);
  }

  if (mapping.agentFile) {
    relocated.agentFile = relocate(mapping.agentFile, false);
  }

  if (mapping.agentFileFallback) {
    relocated.agentFileFallback = relocate(mapping.agentFileFallback, false);
  }
  return relocated;
}

/**
 * Fail closed when a destination escapes its selected root or any existing
 * component below that root is a symlink. Call immediately before mutation.
 */
export async function assertSafeDestination(
  writeRoot: string,
  destination: string,
  options: { allowFinalSymlink?: boolean } = {},
): Promise<void> {
  const root = resolve(writeRoot);
  const candidate = resolve(destination);
  if (!pathIsWithin(root, candidate)) {
    throw new Error(`Destination escapes selected write root: ${candidate}`);
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    canonicalRoot = root;
  }

  const relativeDestination = relative(root, candidate);
  let current = root;
  let deepestExisting = root;
  for (const segment of relativeDestination.split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        if (current === candidate && options.allowFinalSymlink) break;
        throw new Error(`Destination traverses a symbolic link: ${current}`);
      }
      deepestExisting = current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }

  let canonicalExisting: string;
  try {
    canonicalExisting = await realpath(deepestExisting);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    canonicalExisting = deepestExisting;
  }
  if (!pathIsWithin(canonicalRoot, canonicalExisting)) {
    throw new Error(`Destination resolves outside selected write root: ${candidate}`);
  }
}

function findRepositoryRoot(
  cwd: string,
  pathExists: (path: string) => boolean,
): string | null {
  let current = resolve(cwd);
  while (true) {
    if (pathExists(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function ancestorDirectories(
  cwd: string,
  stopAt: string | null,
): string[] {
  const start = resolve(cwd);
  const stop = stopAt && pathIsWithin(stopAt, start) ? resolve(stopAt) : null;
  const ancestors: string[] = [];
  let current = start;
  while (true) {
    ancestors.push(current);
    if (current === stop) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return ancestors;
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const normalized = resolve(path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function resolveBoundary(
  client: ClientType,
  cwd: string,
  homeDir: string,
  options: ClientResolutionOptions,
  pathExists: (path: string) => boolean,
): string | null {
  if (options.repoRoot !== undefined) return options.repoRoot;
  const repoRoot = findRepositoryRoot(cwd, pathExists);
  if (repoRoot) return repoRoot;
  if (client === 'omp' && pathIsWithin(homeDir, cwd)) return homeDir;
  return null;
}

function resolvePiContext(
  scope: ClientScope,
  operationRoot: string,
  homeDir: string,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  options: ClientResolutionOptions,
  pathExists: (path: string) => boolean,
): ResolvedClientContext {
  const defaultAgentRoot = join(homeDir, '.pi', 'agent');
  const agentRoot = env.PI_CODING_AGENT_DIR
    ? resolveRuntimePath(env.PI_CODING_AGENT_DIR, cwd, homeDir)
    : defaultAgentRoot;

  if (scope === 'user') {
    return {
      client: 'pi',
      scope,
      writeRoot: agentRoot,
      mapping: relocateMapping(
        getMapping('pi', 'user'),
        operationRoot,
        defaultAgentRoot,
        agentRoot,
      ),
      skillDiscoveryRoots: uniquePaths([
        join(agentRoot, 'skills'),
        join(homeDir, '.agents', 'skills'),
      ]),
      commandCwd: cwd,
      commandEnv: { ...env },
    };
  }

  const boundary = resolveBoundary('pi', cwd, homeDir, options, pathExists);
  const ancestors = ancestorDirectories(cwd, boundary);
  return {
    client: 'pi',
    scope,
    writeRoot: operationRoot,
    mapping: CLIENT_MAPPINGS.pi,
    skillDiscoveryRoots: uniquePaths([
      join(cwd, '.pi', 'skills'),
      ...ancestors
        .filter((dir) => dir !== homeDir)
        .map((dir) => join(dir, '.agents', 'skills')),
    ]),
    commandCwd: cwd,
    commandEnv: { ...env },
  };
}

function resolveOmpRoots(
  homeDir: string,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  pathExists: (path: string) => boolean,
): OmpResolvedRoots {
  const config = join(homeDir, env.PI_CONFIG_DIR || '.omp');
  const defaultAgent = join(config, 'agent');
  const agent = env.PI_CODING_AGENT_DIR
    ? resolve(cwd, env.PI_CODING_AGENT_DIR)
    : defaultAgent;
  const xdgEnabled =
    (platform === 'linux' || platform === 'darwin') && agent === defaultAgent;

  const categoryRoot = (name: 'DATA' | 'STATE' | 'CACHE'): string | undefined => {
    if (!xdgEnabled) return undefined;
    const value = env[`XDG_${name}_HOME`];
    if (!value) return undefined;
    const root = join(value, 'omp');
    return pathExists(root) ? root : undefined;
  };

  const data = categoryRoot('DATA');
  const state = categoryRoot('STATE');
  const cache = categoryRoot('CACHE');
  return {
    config,
    agent,
    data: data ?? config,
    state: state ?? config,
    cache: cache ?? config,
    dataAgent: data ?? agent,
    stateAgent: state ?? agent,
    cacheAgent: cache ?? agent,
  };
}

function ordinaryOmpEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  const commandEnv = { ...env };
  commandEnv.OMP_PROFILE = undefined;
  commandEnv.PI_PROFILE = undefined;
  commandEnv.PI_CONFIG_FILES = undefined;
  return commandEnv;
}

function resolveOmpContext(
  scope: ClientScope,
  operationRoot: string,
  homeDir: string,
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform,
  options: ClientResolutionOptions,
  pathExists: (path: string) => boolean,
): ResolvedClientContext {
  const roots = resolveOmpRoots(homeDir, cwd, env, platform, pathExists);
  const commandEnv = ordinaryOmpEnvironment(env);

  if (scope === 'user') {
    const defaultAgentRoot = join(homeDir, '.omp', 'agent');
    return {
      client: 'omp',
      scope,
      writeRoot: roots.agent,
      mapping: relocateMapping(
        getMapping('omp', 'user'),
        operationRoot,
        defaultAgentRoot,
        roots.agent,
      ),
      skillDiscoveryRoots: uniquePaths([
        join(roots.agent, 'skills'),
        join(homeDir, '.agent', 'skills'),
        join(homeDir, '.agents', 'skills'),
      ]),
      commandCwd: cwd,
      commandEnv,
      ompRoots: roots,
    };
  }

  const boundary = resolveBoundary('omp', cwd, homeDir, options, pathExists);
  const ancestors = ancestorDirectories(cwd, boundary);
  return {
    client: 'omp',
    scope,
    writeRoot: operationRoot,
    mapping: CLIENT_MAPPINGS.omp,
    skillDiscoveryRoots: uniquePaths([
      ...ancestors.map((dir) => join(dir, '.omp', 'skills')),
      ...ancestors
        .filter((dir) => dir !== homeDir)
        .flatMap((dir) => [
          join(dir, '.agent', 'skills'),
          join(dir, '.agents', 'skills'),
        ]),
    ]),
    commandCwd: cwd,
    commandEnv,
    ompRoots: roots,
  };
}

export function resolveClientContext(
  client: ClientType,
  scope: ClientScope,
  options: ClientResolutionOptions = {},
): ResolvedClientContext {
  const homeDir = resolve(options.homeDir ?? getHomeDir());
  const cwd = resolve(options.cwd ?? process.cwd());
  const operationRoot = scope === 'user' ? homeDir : cwd;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const pathExists = options.pathExists ?? existsSync;

  if (client === 'pi') {
    return resolvePiContext(
      scope,
      operationRoot,
      homeDir,
      cwd,
      env,
      options,
      pathExists,
    );
  }
  if (client === 'omp') {
    return resolveOmpContext(
      scope,
      operationRoot,
      homeDir,
      cwd,
      env,
      platform,
      options,
      pathExists,
    );
  }

  const mapping = scope === 'user'
    ? USER_CLIENT_MAPPINGS[client]
    : CLIENT_MAPPINGS[client];
  if (!mapping) {
    throw new Error(`Client '${client}' does not support ${scope} scope`);
  }
  return {
    client,
    scope,
    writeRoot: operationRoot,
    mapping,
    skillDiscoveryRoots: [resolveMappedPath(operationRoot, mapping.skillsPath)],
    commandCwd: cwd,
    commandEnv: env,
  };
}

export function resolveClientContexts(
  clients: readonly ClientType[],
  scope: ClientScope,
  options: ClientResolutionOptions = {},
): Map<ClientType, ResolvedClientContext> {
  return new Map(
    clients.map((client) => [client, resolveClientContext(client, scope, options)]),
  );
}

export function clientMappingsFromContexts(
  contexts: ReadonlyMap<ClientType, ResolvedClientContext>,
  fallback: ClientMappings,
): ClientMappings {
  if (contexts.size === 0) return fallback;
  return {
    ...fallback,
    ...Object.fromEntries(
      [...contexts].map(([client, context]) => [client, context.mapping]),
    ),
  };
}
