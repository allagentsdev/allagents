import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import JSON5 from 'json5';
import type { NativeCommandResult } from './native/types.js';
import { executeCommand } from './native/types.js';
import type { ValidatedPlugin } from './sync.js';
import type { McpMergeResult } from './vscode-mcp.js';
import { collectMcpServers } from './vscode-mcp.js';

type ExecuteFn = (
  binary: string,
  args: string[],
) => NativeCommandResult | Promise<NativeCommandResult>;

/**
 * Deep equality check for MCP server configs.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, i) => deepEqual(val, b[i]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => key in bObj && deepEqual(aObj[key], bObj[key]));
}

/**
 * Build CLI args for `claude mcp add <name>` from a .mcp.json server config.
 * Returns null if the config format is unsupported.
 */
export function buildClaudeMcpAddArgs(
  name: string,
  config: Record<string, unknown>,
  scope: 'user' | 'project' = 'user',
): string[] | null {
  // HTTP-based
  if (typeof config.url === 'string') {
    return [
      'mcp',
      'add',
      '--transport',
      'http',
      '--scope',
      scope,
      name,
      config.url,
    ];
  }

  // stdio-based (command + args)
  if (typeof config.command === 'string') {
    const args: string[] = ['mcp', 'add', '--scope', scope];

    // Add --env flags if present
    if (config.env && typeof config.env === 'object') {
      for (const [key, value] of Object.entries(
        config.env as Record<string, string>,
      )) {
        args.push('-e', `${key}=${value}`);
      }
    }

    args.push(name, '--', config.command);

    // Add command args if present
    if (Array.isArray(config.args)) {
      args.push(...(config.args as string[]));
    }

    return args;
  }

  return null;
}

/**
 * Sync MCP server configs from plugins into project-scoped .mcp.json.
 *
 * Claude Code reads .mcp.json at the project root for project-scoped MCP servers.
 * This is the same file that `claude mcp add --scope project` writes to.
 * The format uses "mcpServers" as the top-level key.
 *
 * With tracking enabled:
 * - Tracked servers with changed configs are updated (not skipped)
 * - Tracked servers no longer in plugins are removed
 * - User-managed servers (not tracked) are preserved
 */
export function syncClaudeMcpConfig(
  validatedPlugins: ValidatedPlugin[],
  options?: {
    dryRun?: boolean;
    configPath?: string;
    force?: boolean;
    trackedServers?: string[];
    /** Pre-computed servers (e.g. after proxy transform) — bypasses collectMcpServers */
    serverOverrides?: Map<string, unknown>;
  },
): McpMergeResult {
  const dryRun = options?.dryRun ?? false;
  const force = options?.force ?? false;
  const configPath = options?.configPath;
  if (!configPath) {
    throw new Error('configPath is required for syncClaudeMcpConfig');
  }
  const previouslyTracked = new Set(options?.trackedServers ?? []);
  const hasTracking = options?.trackedServers !== undefined;

  const { servers: pluginServers, warnings } = options?.serverOverrides
    ? { servers: options.serverOverrides, warnings: [] as string[] }
    : collectMcpServers(validatedPlugins);

  const result: McpMergeResult = {
    added: 0,
    skipped: 0,
    overwritten: 0,
    removed: 0,
    warnings: [...warnings],
    addedServers: [],
    skippedServers: [],
    overwrittenServers: [],
    removedServers: [],
    trackedServers: [],
  };

  // Read existing .mcp.json (or start fresh)
  let existingConfig: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const content = readFileSync(configPath, 'utf-8');
      existingConfig = JSON5.parse(content);
    } catch {
      result.warnings.push(
        `Could not parse existing ${configPath}, starting fresh`,
      );
      existingConfig = {};
    }
  }

  const existingServers =
    (existingConfig.mcpServers as Record<string, unknown>) ?? {};

  // Process plugin servers: add new, update tracked, skip user-managed conflicts
  for (const [name, config] of pluginServers) {
    if (name in existingServers) {
      if (!deepEqual(existingServers[name], config)) {
        if (hasTracking && previouslyTracked.has(name)) {
          existingServers[name] = config;
          result.overwritten++;
          result.overwrittenServers.push(name);
          result.trackedServers.push(name);
        } else if (force) {
          existingServers[name] = config;
          result.overwritten++;
          result.overwrittenServers.push(name);
          result.trackedServers.push(name);
        } else {
          result.skipped++;
          result.skippedServers.push(name);
        }
      } else if (hasTracking && previouslyTracked.has(name)) {
        result.trackedServers.push(name);
      }
    } else {
      existingServers[name] = config;
      result.added++;
      result.addedServers.push(name);
      result.trackedServers.push(name);
    }
  }

  // Remove orphaned tracked servers
  if (hasTracking) {
    const currentServerNames = new Set(pluginServers.keys());
    for (const trackedName of previouslyTracked) {
      if (
        !currentServerNames.has(trackedName) &&
        trackedName in existingServers
      ) {
        delete existingServers[trackedName];
        result.removed++;
        result.removedServers.push(trackedName);
      }
    }
  }

  // Write back if there were changes and not dry-run
  const hasChanges =
    result.added > 0 || result.overwritten > 0 || result.removed > 0;
  if (hasChanges && !dryRun) {
    existingConfig.mcpServers = existingServers;
    const dir = dirname(configPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(
      configPath,
      `${JSON.stringify(existingConfig, null, 2)}\n`,
      'utf-8',
    );
    result.configPath = configPath;
  }

  // Handle edge case: no plugins have MCP servers but we need to clean up
  if (pluginServers.size === 0 && hasTracking && previouslyTracked.size > 0) {
    for (const trackedName of previouslyTracked) {
      if (trackedName in existingServers) {
        delete existingServers[trackedName];
        result.removed++;
        result.removedServers.push(trackedName);
      }
    }
    if (result.removed > 0 && !dryRun) {
      existingConfig.mcpServers = existingServers;
      const dir = dirname(configPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(
        configPath,
        `${JSON.stringify(existingConfig, null, 2)}\n`,
        'utf-8',
      );
      result.configPath = configPath;
    }
  }

  return result;
}

/**
 * Sync MCP servers from plugins into Claude Code via `claude mcp add/remove --scope user`.
 *
 * Uses the same ownership model as codex-mcp:
 * - Only tracked servers are updated/removed
 * - Pre-existing user-managed servers are skipped
 * - Uses `claude mcp get <name>` (exit code) to detect existing servers
 */
export async function syncClaudeMcpServersViaCli(
  validatedPlugins: ValidatedPlugin[],
  options?: {
    dryRun?: boolean;
    trackedServers?: string[];
    serverOverrides?: Map<string, unknown>;
    _mockExecute?: ExecuteFn;
  },
): Promise<McpMergeResult> {
  const dryRun = options?.dryRun ?? false;
  const previouslyTracked = new Set(options?.trackedServers ?? []);
  const hasTracking = options?.trackedServers !== undefined;
  const exec: ExecuteFn =
    options?._mockExecute ?? ((binary, args) => executeCommand(binary, args));

  const { servers: pluginServers, warnings } = options?.serverOverrides
    ? { servers: options.serverOverrides, warnings: [] as string[] }
    : collectMcpServers(validatedPlugins);

  const result: McpMergeResult = {
    added: 0,
    skipped: 0,
    overwritten: 0,
    removed: 0,
    warnings: [...warnings],
    addedServers: [],
    skippedServers: [],
    overwrittenServers: [],
    removedServers: [],
    trackedServers: [],
    authoritative: true,
  };

  // Skip entirely when there are no MCP servers to sync and nothing to remove
  if (pluginServers.size === 0 && previouslyTracked.size === 0) {
    return result;
  }

  // Check if claude CLI is available
  const versionResult = await exec('claude', ['--version']);
  if (!versionResult.success) {
    result.warnings.push(
      `Claude CLI not available: ${versionResult.error ?? 'unknown error'}`,
    );
    result.authoritative = false;
    result.trackedServers = [...previouslyTracked];
    return result;
  }

  function isMissingClaudeMcpServer(
    result: NativeCommandResult,
    name: string,
  ): boolean {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(
      `^(?:Error:\\s*)?No MCP server found with name:\\s*${escapedName}\\.?$`,
      'i',
    ).test(`${result.output}\n${result.error ?? ''}`.trim());
  }

  // Process plugin servers: add new, skip existing user-managed
  for (const [name, config] of pluginServers) {
    // Check if server already exists via `claude mcp get <name>`
    const getResult = await exec('claude', ['mcp', 'get', name]);
    const exists = getResult.success;

    if (exists) {
      if (hasTracking && previouslyTracked.has(name)) {
        // We own this server - keep tracking
        result.trackedServers.push(name);
      } else {
        // User-managed server - skip (do not track)
        result.skipped++;
        result.skippedServers.push(name);
      }
    } else {
      // New server - add it
      const addArgs = buildClaudeMcpAddArgs(
        name,
        config as Record<string, unknown>,
        'user',
      );
      if (!addArgs) {
        result.warnings.push(
          `Unsupported MCP server config for '${name}', skipping`,
        );
        result.authoritative = false;
        if (previouslyTracked.has(name)) result.trackedServers.push(name);
        continue;
      }

      if (!dryRun) {
        const addResult = await exec('claude', addArgs);
        if (!addResult.success) {
          result.warnings.push(
            `Failed to add MCP server '${name}': ${addResult.error ?? 'unknown error'}`,
          );
          result.authoritative = false;
          if (previouslyTracked.has(name)) result.trackedServers.push(name);
          continue;
        }
      }

      result.added++;
      result.addedServers.push(name);
      result.trackedServers.push(name);
    }
  }

  // Remove orphaned tracked servers
  if (hasTracking) {
    const currentServerNames = new Set(pluginServers.keys());
    for (const trackedName of previouslyTracked) {
      if (!currentServerNames.has(trackedName)) {
        // Check if it still exists before trying to remove
        const getResult = await exec('claude', ['mcp', 'get', trackedName]);
        if (
          !getResult.success &&
          !isMissingClaudeMcpServer(getResult, trackedName)
        ) {
          result.warnings.push(
            `Failed to inspect MCP server '${trackedName}': ${getResult.error ?? 'unknown error'}`,
          );
          result.authoritative = false;
          result.trackedServers.push(trackedName);
          continue;
        }
        if (getResult.success) {
          if (!dryRun) {
            const removeResult = await exec('claude', [
              'mcp',
              'remove',
              trackedName,
              '--scope',
              'user',
            ]);
            if (!removeResult.success) {
              result.warnings.push(
                `Failed to remove MCP server '${trackedName}': ${removeResult.error ?? 'unknown error'}`,
              );
              result.authoritative = false;
              result.trackedServers.push(trackedName);
              continue;
            }
          }
          result.removed++;
          result.removedServers.push(trackedName);
        }
      }
    }
  }

  return result;
}
