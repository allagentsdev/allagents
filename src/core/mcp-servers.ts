import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { dump } from 'js-yaml';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import {
  type ClientType,
  type McpServerConfig,
  McpServerConfigSchema,
  type ProfileDeclaration,
  ProfileMcpServerConfigSchema,
  type ProfileName,
  ProfileNameSchema,
  type WorkspaceConfig,
} from '../models/workspace-config.js';
import {
  type EditableUserWorkspaceConfig,
  parseUserWorkspaceConfigDocumentForEdit,
  parseWorkspaceConfigForEdit,
  validateProjectWorkspaceConfig,
  validateUserWorkspaceConfig,
} from '../utils/workspace-parser.js';
import { flattenZodIssues } from '../utils/zod-issues.js';
import {
  ensureUserWorkspace,
  getUserWorkspaceConfigPath,
  isUserConfigPath,
} from './user-workspace.js';
import { ensureWorkspace } from './workspace-modify.js';

export type McpDestination =
  | {
      kind: 'project';
      workspacePath: string;
      configPath: string;
    }
  | {
      kind: 'user';
      configPath: string;
    }
  | {
      kind: 'profile';
      name: ProfileName;
      configPath: string;
    };

export function formatMcpDestination(destination: McpDestination): string {
  switch (destination.kind) {
    case 'project':
      return 'workspace.yaml';
    case 'user':
      return 'the user workspace';
    case 'profile':
      return `profile '${destination.name}'`;
  }
}

export interface ResolveMcpDestinationOptions {
  cwd?: string;
  scope?: string;
  profile?: string;
}

export interface AddMcpServerOptions {
  force?: boolean;
  proxy?: false | { clients?: ClientType[] };
}

/**
 * Result of add/remove/update operations on workspace mcpServers.
 */
export interface McpServerModifyResult {
  success: boolean;
  error?: string;
  /** Normalized server config that was written (for add/update) */
  config?: McpServerConfig;
}

type EditableMcpProxy = {
  clients?: string[];
  servers?: Record<string, { proxy: string[] }>;
};

type EditableMcpContainer = {
  mcpServers?: Record<string, McpServerConfig>;
  mcpProxy?: EditableMcpProxy;
};

const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

async function readLockOwner(lockPath: string): Promise<string | null> {
  return readFile(join(lockPath, 'owner'), 'utf8').catch(() => null);
}

async function withDestinationLock<T>(
  configPath: string,
  mutate: () => Promise<T>,
): Promise<T> {
  const lockPath = `${configPath}.lock`;
  const breakPath = `${lockPath}.break`;
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let acquired = false;
  while (!acquired) {
    let created = false;
    try {
      await mkdir(lockPath, { mode: 0o700 });
      created = true;
      await writeFile(join(lockPath, 'owner'), token, {
        encoding: 'utf8',
        mode: 0o600,
      });
      acquired = true;
    } catch (error) {
      if (created) {
        await rm(lockPath, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const lockStats = await lstat(lockPath).catch(() => null);
      if (lockStats && Date.now() - lockStats.mtimeMs > STALE_LOCK_MS) {
        let breaker = false;
        try {
          await mkdir(breakPath, { mode: 0o700 });
          breaker = true;
          const currentStats = await lstat(lockPath).catch(() => null);
          if (
            currentStats &&
            Date.now() - currentStats.mtimeMs > STALE_LOCK_MS
          ) {
            await rm(lockPath, { recursive: true, force: true });
          }
        } catch (breakError) {
          if ((breakError as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw breakError;
          }
        } finally {
          if (breaker) {
            await rm(breakPath, { recursive: true, force: true }).catch(
              () => undefined,
            );
          }
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting to update ${configPath}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting to update ${configPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await mutate();
  } finally {
    if ((await readLockOwner(lockPath)) === token) {
      await rm(lockPath, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}

type EditableMcpDocument = WorkspaceConfig | EditableUserWorkspaceConfig;

function getConfigPath(workspacePath: string): string {
  return join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
}

function parseProfileName(name: string): ProfileName {
  const validation = ProfileNameSchema.safeParse(name);
  if (!validation.success) {
    const detail =
      validation.error.issues[0]?.message ?? 'Invalid portable profile name';
    throw new Error(`Invalid profile name '${name}': ${detail}`);
  }
  return validation.data;
}

function validateDestination(destination: McpDestination): void {
  if (destination.kind === 'profile') {
    parseProfileName(destination.name);
  }
}

/**
 * Resolve the declaration document selected by the MCP command flags.
 */
export function resolveMcpDestination(
  options: ResolveMcpDestinationOptions = {},
): McpDestination {
  if (options.scope !== undefined && options.profile !== undefined) {
    throw new Error('--scope and --profile cannot be used together');
  }

  if (
    options.scope !== undefined &&
    options.scope !== 'project' &&
    options.scope !== 'user'
  ) {
    throw new Error(`Invalid MCP scope '${String(options.scope)}'`);
  }

  if (options.profile !== undefined) {
    return {
      kind: 'profile',
      name: parseProfileName(options.profile),
      configPath: getUserWorkspaceConfigPath(),
    };
  }

  if (options.scope === 'user') {
    return {
      kind: 'user',
      configPath: getUserWorkspaceConfigPath(),
    };
  }

  const workspacePath = options.cwd ?? process.cwd();
  if (isUserConfigPath(workspacePath)) {
    if (options.scope === 'project') {
      throw new Error(
        '--scope project cannot be used from the home directory because it aliases the user workspace; run from a project directory or use --scope user',
      );
    }
    return {
      kind: 'user',
      configPath: getUserWorkspaceConfigPath(),
    };
  }
  return {
    kind: 'project',
    workspacePath,
    configPath: getConfigPath(workspacePath),
  };
}

async function readDestinationConfig(
  destination: McpDestination,
): Promise<EditableMcpDocument> {
  return destination.kind === 'project'
    ? parseWorkspaceConfigForEdit(destination.configPath)
    : parseUserWorkspaceConfigDocumentForEdit(destination.configPath);
}

function selectDestinationContainer(
  destination: McpDestination,
  document: EditableMcpDocument,
): EditableMcpContainer {
  if (destination.kind !== 'profile') {
    return document as EditableMcpContainer;
  }

  const profile = (document as EditableUserWorkspaceConfig).profiles?.[
    destination.name
  ];
  if (!profile) {
    throw new Error(`Profile '${destination.name}' is not declared`);
  }
  return profile as ProfileDeclaration & EditableMcpContainer;
}

async function writeDestinationConfig(
  destination: McpDestination,
  document: EditableMcpDocument,
): Promise<void> {
  if (destination.kind === 'project') {
    validateProjectWorkspaceConfig(document, destination.configPath);
  } else {
    validateUserWorkspaceConfig(document, destination.configPath);
  }
  const existing = await lstat(destination.configPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) {
    throw new Error(
      `Refusing to replace symbolic-link workspace config: ${destination.configPath}`,
    );
  }
  if (existing && !existing.isFile()) {
    throw new Error(
      `Workspace config is not a regular file: ${destination.configPath}`,
    );
  }
  const mode =
    existing?.mode ?? (destination.kind === 'project' ? 0o644 : 0o600);
  const temporaryPath = join(
    dirname(destination.configPath),
    `.${basename(destination.configPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, dump(document, { lineWidth: -1 }), {
      encoding: 'utf-8',
      mode,
    });
    await rename(temporaryPath, destination.configPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function ensureDestinationForAdd(
  destination: McpDestination,
): Promise<void> {
  if (destination.kind === 'project') {
    await ensureWorkspace(destination.workspacePath);
  } else if (
    destination.kind === 'user' &&
    !existsSync(destination.configPath) &&
    resolve(destination.configPath) === resolve(getUserWorkspaceConfigPath())
  ) {
    await ensureUserWorkspace();
  }
}

function removeServerScopedProxyIntent(
  container: EditableMcpContainer,
  name: string,
): void {
  const proxy = container.mcpProxy;
  if (!proxy) return;

  if (proxy.servers) {
    delete proxy.servers[name];
    if (Object.keys(proxy.servers).length === 0) {
      delete proxy.servers;
    }
  }
  if ((proxy.clients?.length ?? 0) === 0 && !proxy.servers) {
    delete container.mcpProxy;
  }
}

function applyServerScopedProxyIntent(
  container: EditableMcpContainer,
  name: string,
  proxy: AddMcpServerOptions['proxy'],
): void {
  if (proxy === undefined) return;
  if (proxy === false) {
    removeServerScopedProxyIntent(container, name);
    return;
  }

  const resolvedClients = [...new Set(proxy.clients ?? ['*'])];
  container.mcpProxy ??= {};
  container.mcpProxy.servers ??= {};
  container.mcpProxy.servers[name] = { proxy: resolvedClients };
}

function validateServerConfig(
  destination: McpDestination,
  config: unknown,
): { valid: true; data: McpServerConfig } | { valid: false; error: string } {
  const result =
    destination.kind === 'profile'
      ? ProfileMcpServerConfigSchema.safeParse(config)
      : McpServerConfigSchema.safeParse(config);
  if (!result.success) {
    const issues = flattenZodIssues(result.error).map(
      (issue) => `  - ${issue.path.join('.')}: ${issue.message}`,
    );
    return {
      valid: false,
      error: `Invalid MCP server config:\n${issues.join('\n')}`,
    };
  }
  return { valid: true, data: result.data };
}

/**
 * Add or replace one inline MCP declaration and its server-local proxy intent
 * in a single validated document write.
 */
export async function addMcpServer(
  destination: McpDestination,
  name: string,
  config: McpServerConfig,
  options: AddMcpServerOptions = {},
): Promise<McpServerModifyResult> {
  try {
    validateDestination(destination);
    const validation = validateServerConfig(destination, config);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    await ensureDestinationForAdd(destination);
    return await withDestinationLock(destination.configPath, async () => {
      const document = await readDestinationConfig(destination);
      const container = selectDestinationContainer(destination, document);
      container.mcpServers ??= {};

      if (container.mcpServers[name] && !options.force) {
        return {
          success: false,
          error: `MCP server '${name}' already exists in workspace.yaml. Pass --force to replace it.`,
        };
      }

      container.mcpServers[name] = validation.data;
      applyServerScopedProxyIntent(container, name, options.proxy);
      await writeDestinationConfig(destination, document);
      return { success: true, config: validation.data };
    });
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Remove one inline MCP declaration and its server-local proxy intent.
 */
export async function removeMcpServer(
  destination: McpDestination,
  name: string,
): Promise<McpServerModifyResult> {
  try {
    validateDestination(destination);
    if (!existsSync(destination.configPath)) {
      return {
        success: false,
        error: `${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE} not found`,
      };
    }

    return await withDestinationLock(destination.configPath, async () => {
      const document = await readDestinationConfig(destination);
      const container = selectDestinationContainer(destination, document);
      if (!container.mcpServers || !(name in container.mcpServers)) {
        return {
          success: false,
          error: `MCP server '${name}' not found in workspace.yaml`,
        };
      }

      delete container.mcpServers[name];
      if (Object.keys(container.mcpServers).length === 0) {
        delete container.mcpServers;
      }
      removeServerScopedProxyIntent(container, name);

      await writeDestinationConfig(destination, document);
      return { success: true };
    });
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Read one inline MCP declaration from exactly the selected destination.
 */
export async function getMcpServer(
  destination: McpDestination,
  name: string,
): Promise<McpServerConfig | null> {
  validateDestination(destination);
  if (!existsSync(destination.configPath)) {
    if (destination.kind === 'profile') {
      throw new Error(`Profile '${destination.name}' is not declared`);
    }
    return null;
  }
  const document = await readDestinationConfig(destination);
  const container = selectDestinationContainer(destination, document);
  return container.mcpServers?.[name] ?? null;
}

/**
 * List inline MCP declarations from exactly the selected destination.
 */
export async function listMcpServers(
  destination: McpDestination,
): Promise<Record<string, McpServerConfig>> {
  validateDestination(destination);
  if (!existsSync(destination.configPath)) {
    if (destination.kind === 'profile') {
      throw new Error(`Profile '${destination.name}' is not declared`);
    }
    return {};
  }
  const document = await readDestinationConfig(destination);
  const container = selectDestinationContainer(destination, document);
  return container.mcpServers ?? {};
}

/**
 * Build an McpServerConfig from CLI flags. Transport defaults:
 * - If commandOrUrl starts with http(s)://, treat as HTTP
 * - Otherwise treat as stdio command
 */
export function buildMcpServerConfigFromFlags(options: {
  commandOrUrl: string;
  transport?: 'http' | 'stdio';
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  clients?: ClientType[];
}): { config: McpServerConfig } | { error: string } {
  const { commandOrUrl, args, env, headers, clients } = options;
  const transport =
    options.transport ??
    (/^https?:\/\//i.test(commandOrUrl) ? 'http' : 'stdio');

  if (transport === 'http') {
    if (!/^https?:\/\//i.test(commandOrUrl)) {
      return {
        error: `HTTP transport requires a URL starting with http:// or https:// (got '${commandOrUrl}')`,
      };
    }
    if (args && args.length > 0) {
      return { error: '--arg is not supported for HTTP transport' };
    }
    if (env && Object.keys(env).length > 0) {
      return { error: '-e/--env is not supported for HTTP transport' };
    }
    const config: McpServerConfig = {
      type: 'http',
      url: commandOrUrl,
      ...(headers && Object.keys(headers).length > 0 && { headers }),
      ...(clients && clients.length > 0 && { clients }),
    };
    return { config };
  }

  if (options.transport === 'stdio' && /^https?:\/\//i.test(commandOrUrl)) {
    return {
      error: `stdio transport requires a command, not a URL (got '${commandOrUrl}')`,
    };
  }
  if (headers && Object.keys(headers).length > 0) {
    return { error: '--header is not supported for stdio transport' };
  }
  const config: McpServerConfig = {
    type: 'stdio',
    command: commandOrUrl,
    ...(args && args.length > 0 && { args }),
    ...(env && Object.keys(env).length > 0 && { env }),
    ...(clients && clients.length > 0 && { clients }),
  };
  return { config };
}

/**
 * Parse KEY=VALUE strings into a record. Returns an error if any entry is
 * malformed.
 */
export function parseKeyValuePairs(
  pairs: string[],
  flagName: string,
): { values: Record<string, string> } | { error: string } {
  const values: Record<string, string> = {};
  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx <= 0) {
      return { error: `Invalid ${flagName}: '${pair}' (expected KEY=VALUE)` };
    }
    const key = pair.slice(0, eqIdx);
    const value = pair.slice(eqIdx + 1);
    values[key] = value;
  }
  return { values };
}
