import { getHomeDir } from '../constants.js';
import {
  type McpServerConfig,
  ProfileDeclarationSchema,
} from '../models/workspace-config.js';
import { parseUserWorkspaceConfig } from '../utils/workspace-parser.js';
import { flattenZodIssues } from '../utils/zod-issues.js';
import {
  connectHttpMcpServer,
  type OAuthCallbackUrlReader,
} from './mcp-http-client.js';
import {
  addMcpServer,
  formatMcpDestination,
  getMcpServer,
  listMcpServers,
  type McpDestination,
  removeMcpServer,
} from './mcp-servers.js';
import {
  type SyncMcpOnlyResult,
  syncMcpOnly,
  syncUserMcpOnly,
} from './mcp-sync.js';
import {
  type ProfileApplyResult,
  updateInstalledProfiles,
} from './profile/index.js';

export interface McpAuthorizationInteraction {
  output(message: string): void;
  readCallback: OAuthCallbackUrlReader;
}

export type McpDestinationSync =
  | { kind: 'mcp'; result: SyncMcpOnlyResult }
  | { kind: 'profile'; result: ProfileApplyResult | null };

export interface AddManagedMcpServerRequest {
  destination: McpDestination;
  name: string;
  config: McpServerConfig;
  force?: boolean;
  authorization?: McpAuthorizationInteraction;
}

export interface UpdateManagedMcpServersOptions {
  offline?: boolean;
}

export class McpUpdateError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'McpUpdateError';
  }
}

async function validateProfileAddCandidate(
  destination: McpDestination,
  name: string,
  config: McpServerConfig,
): Promise<void> {
  if (destination.kind !== 'profile') return;

  const workspace = await parseUserWorkspaceConfig(destination.configPath);
  const profile = workspace.profiles?.[destination.name];
  if (!profile) {
    throw new Error(`Profile '${destination.name}' is not declared`);
  }
  const validation = ProfileDeclarationSchema.safeParse({
    ...profile,
    mcpServers: {
      ...profile.mcpServers,
      [name]: config,
    },
  });
  if (!validation.success) {
    const issues = flattenZodIssues(validation.error).map(
      (issue) => `  - ${issue.path.join('.')}: ${issue.message}`,
    );
    throw new Error(`Invalid MCP server config:\n${issues.join('\n')}`);
  }
}

async function connectConfiguredHttpServer(
  destination: McpDestination,
  config: Extract<McpServerConfig, { url: string }>,
  authorization: McpAuthorizationInteraction | undefined,
  resetCredentials: boolean,
): Promise<void> {
  await connectHttpMcpServer(config.url, {
    headers: config.headers ?? {},
    resetCredentials,
    allowAuthorization: authorization !== undefined,
    ...(destination.kind === 'profile' ? { profile: destination.name } : {}),
    ...(authorization
      ? {
          authorizationOutput: authorization.output,
          callbackUrlReader: authorization.readCallback,
        }
      : {}),
  });
}

export async function updateManagedMcpServers(
  destination: McpDestination,
  options: UpdateManagedMcpServersOptions = {},
): Promise<McpDestinationSync> {
  const offline = options.offline ?? false;
  if (destination.kind === 'project') {
    const result = await syncMcpOnly(destination.workspacePath, { offline });
    if (!result.success) {
      throw new Error(result.error ?? 'MCP sync failed');
    }
    return { kind: 'mcp', result };
  }
  if (destination.kind === 'user') {
    const result = await syncUserMcpOnly({ offline });
    if (!result.success) {
      throw new Error(result.error ?? 'MCP sync failed');
    }
    return { kind: 'mcp', result };
  }

  let results: readonly ProfileApplyResult[];
  try {
    results = await updateInstalledProfiles([destination.name], {
      offline,
      homeDir: getHomeDir(),
      userConfigPath: destination.configPath,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === `Profile '${destination.name}' is not installed`) {
      return { kind: 'profile', result: null };
    }
    throw new Error(message);
  }

  const result = results[0];
  if (!result) {
    throw new Error(`Profile '${destination.name}' was not reconciled`);
  }
  if (!result.success) {
    throw new Error(
      result.error ?? `Profile '${destination.name}' update failed`,
    );
  }
  return { kind: 'profile', result };
}

export async function addManagedMcpServer(
  request: AddManagedMcpServerRequest,
): Promise<{ config: McpServerConfig; sync: McpDestinationSync }> {
  const { destination, name, config, force = false, authorization } = request;
  const existing = await getMcpServer(destination, name);
  if (existing && !force) {
    throw new Error(
      `MCP server '${name}' already exists in ${formatMcpDestination(destination)}. Use --force to replace it.`,
    );
  }
  await validateProfileAddCandidate(destination, name, config);

  if ('url' in config) {
    await connectConfiguredHttpServer(
      destination,
      config,
      authorization,
      false,
    );
  }

  const addResult = await addMcpServer(destination, name, config, {
    force,
    proxy:
      'url' in config
        ? {
            ...(config.clients === undefined
              ? {}
              : { clients: config.clients }),
          }
        : false,
  });
  if (!addResult.success) {
    throw new Error(addResult.error ?? 'Unknown error');
  }

  let sync: McpDestinationSync;
  try {
    sync = await updateManagedMcpServers(destination, { offline: true });
  } catch (error) {
    throw new McpUpdateError(error);
  }
  return { config: addResult.config ?? config, sync };
}

export async function removeManagedMcpServer(
  destination: McpDestination,
  name: string,
): Promise<McpDestinationSync> {
  const removeResult = await removeMcpServer(destination, name);
  if (!removeResult.success) {
    throw new Error(removeResult.error ?? 'Unknown error');
  }
  try {
    return await updateManagedMcpServers(destination, { offline: true });
  } catch (error) {
    throw new McpUpdateError(error);
  }
}

export async function reauthenticateManagedMcpServer(
  destination: McpDestination,
  name: string,
  authorization: McpAuthorizationInteraction,
): Promise<void> {
  const config = await getMcpServer(destination, name);
  if (!config) {
    throw new Error(
      `MCP server '${name}' is not defined in ${formatMcpDestination(destination)}`,
    );
  }
  if (!('url' in config)) {
    throw new Error(
      `MCP server '${name}' uses stdio and cannot be reauthenticated`,
    );
  }
  await connectConfiguredHttpServer(destination, config, authorization, true);
}

export async function listManagedMcpServers(
  destination: McpDestination,
): Promise<Record<string, McpServerConfig>> {
  return listMcpServers(destination);
}
