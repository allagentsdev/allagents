import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import JSON5 from 'json5';
import { CONFIG_DIR } from '../constants.js';
import {
  type McpServerConfig,
  McpServerConfigSchema,
} from '../models/workspace-config.js';
import type { McpDestination } from './mcp-servers.js';

/** Ordinary project/user MCP configuration shared by Universal and the CLI. */
export function getUniversalMcpConfigPath(scopeRoot: string): string {
  return join(scopeRoot, CONFIG_DIR, 'mcp.json');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read a synchronized server without broadening the selected runtime scope. */
export async function getUniversalMcpServer(
  destination: Exclude<McpDestination, { kind: 'profile' }>,
  name: string,
): Promise<McpServerConfig | null> {
  const configPath =
    destination.kind === 'project'
      ? getUniversalMcpConfigPath(destination.workspacePath)
      : join(dirname(destination.configPath), 'mcp.json');
  let content: string;
  try {
    content = await readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Cannot read Universal MCP configuration at ${configPath}`);
  }

  let config: unknown;
  try {
    config = JSON5.parse(content);
  } catch {
    throw new Error(`Invalid Universal MCP configuration at ${configPath}`);
  }
  if (
    !isObject(config) ||
    (config.mcpServers !== undefined && !isObject(config.mcpServers))
  ) {
    throw new Error(`Invalid Universal MCP configuration at ${configPath}`);
  }
  const servers = config.mcpServers;
  if (!isObject(servers) || !Object.hasOwn(servers, name)) return null;
  const server = McpServerConfigSchema.safeParse(servers[name]);
  if (!server.success) {
    throw new Error(
      `Invalid Universal MCP configuration for server '${name}' at ${configPath}`,
    );
  }
  return server.data;
}
