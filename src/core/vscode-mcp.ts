import { syncJsonMcpConfig } from './json-mcp-config.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import JSON5 from 'json5';
import { getHomeDir } from '../constants.js';
import type {
  ClientType,
  McpServerConfig,
} from '../models/workspace-config.js';
import type { ValidatedPlugin } from './sync.js';

/**
 * Result of merging MCP server configs into VS Code
 */
export interface McpMergeResult {
  added: number;
  skipped: number;
  overwritten: number;
  removed: number;
  warnings: string[];
  addedServers: string[];
  skippedServers: string[];
  overwrittenServers: string[];
  removedServers: string[];
  /** All servers that are now tracked (for saving to sync state) */
  trackedServers: string[];
  /** False when the adapter could not determine or apply authoritative state. */
  authoritative?: boolean;
  /** Path to the config file that was modified (set when changes are written) */
  configPath?: string;
}

/**
 * Get the cross-platform path to VS Code's user-level mcp.json
 */
export function getVscodeMcpConfigPath(): string {
  const platform = process.platform;
  if (platform === 'win32') {
    const appData = process.env.APPDATA;
    if (!appData) {
      throw new Error('APPDATA environment variable not set');
    }
    return join(appData, 'Code', 'User', 'mcp.json');
  }
  const home = getHomeDir();
  if (platform === 'darwin') {
    return join(
      home,
      'Library',
      'Application Support',
      'Code',
      'User',
      'mcp.json',
    );
  }
  // Linux
  return join(home, '.config', 'Code', 'User', 'mcp.json');
}

/**
 * Read .mcp.json from a plugin root directory.
 * Returns the mcpServers object or null if absent/invalid.
 */
export function readPluginMcpConfig(
  pluginPath: string,
): Record<string, unknown> | null {
  const mcpPath = join(pluginPath, '.mcp.json');
  if (!existsSync(mcpPath)) {
    return null;
  }
  try {
    const content = readFileSync(mcpPath, 'utf-8');
    const parsed = JSON5.parse(content);
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.mcpServers &&
      typeof parsed.mcpServers === 'object'
    ) {
      return parsed.mcpServers as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Strip allagents-only metadata fields from a workspace MCP server config
 * before it is passed to a client sync function. Currently removes `clients`
 * (a sync filter that should never be written into client MCP configs).
 */
function stripWorkspaceMcpMeta(
  config: McpServerConfig,
): Record<string, unknown> {
  const { clients: _clients, ...rest } = config as McpServerConfig & {
    clients?: ClientType[];
  };
  return rest as Record<string, unknown>;
}

/**
 * Collect MCP servers from all validated plugins, optionally merged with
 * workspace-level inline servers.
 *
 * Precedence: workspace > plugin. Name conflicts emit a warning.
 * If a targetClient is supplied, workspace servers whose `clients` list
 * excludes it are omitted.
 *
 * Plugin-level conflicts fall back to first-plugin-wins.
 */
export function collectMcpServers(
  validatedPlugins: ValidatedPlugin[],
  workspaceServers?: Record<string, McpServerConfig>,
  targetClient?: ClientType,
): { servers: Map<string, unknown>; warnings: string[] } {
  const servers = new Map<string, unknown>();
  const warnings: string[] = [];

  for (const plugin of validatedPlugins) {
    if (plugin.clients.length === 0) continue;
    if (targetClient && !plugin.clients.includes(targetClient)) continue;
    if (plugin.fileArtifacts?.mcpServers === false) continue;
    const mcpServers = readPluginMcpConfig(plugin.resolved);
    if (!mcpServers) continue;

    for (const [name, config] of Object.entries(mcpServers)) {
      if (plugin.mcpServers?.exclude.includes(name)) continue;
      if (servers.has(name)) {
        warnings.push(
          `MCP server '${name}' from ${plugin.plugin} conflicts with earlier plugin (skipped)`,
        );
      } else {
        servers.set(name, config);
      }
    }
  }

  if (workspaceServers) {
    for (const [name, config] of Object.entries(workspaceServers)) {
      if (
        targetClient &&
        config.clients &&
        !config.clients.includes(targetClient)
      ) {
        continue;
      }
      if (servers.has(name)) {
        warnings.push(
          `MCP server '${name}' from workspace.yaml overrides plugin-provided server`,
        );
      }
      servers.set(name, stripWorkspaceMcpMeta(config));
    }
  }

  return { servers, warnings };
}

/**
 * Sync MCP server configs from plugins into VS Code's user-level mcp.json.
 *
 * With tracking enabled:
 * - Tracked servers with changed configs are updated (not skipped)
 * - Tracked servers no longer in plugins are removed
 * - User-managed servers (not tracked) are preserved
 *
 * Without tracking (trackedServers not provided):
 * - Falls back to legacy behavior (skip conflicts unless force=true)
 */
export function syncVscodeMcpConfig(
  validatedPlugins: ValidatedPlugin[],
  options?: {
    dryRun?: boolean;
    configPath?: string;
    force?: boolean;
    /** Previously tracked server names (enables update/remove behavior) */
    trackedServers?: string[];
    /** Pre-computed servers (e.g. after proxy transform) — bypasses collectMcpServers */
    serverOverrides?: Map<string, unknown>;
  },
): McpMergeResult {
  const configPath = options?.configPath ?? getVscodeMcpConfigPath();

  // Collect servers from all plugins
  const { servers: pluginServers, warnings } = options?.serverOverrides
    ? { servers: options.serverOverrides, warnings: [] as string[] }
    : collectMcpServers(validatedPlugins);

  return syncJsonMcpConfig(pluginServers, 'servers', {
    ...options,
    configPath,
  }, warnings);
}
