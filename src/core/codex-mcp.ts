import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
 * Build CLI args for `codex mcp add <name>` from a .mcp.json server config.
 * Returns null if the config format is unsupported.
 */
export function buildCodexMcpAddArgs(
  name: string,
  config: Record<string, unknown>,
): string[] | null {
  // URL-based (streamable HTTP)
  if (typeof config.url === 'string') {
    return ['mcp', 'add', name, '--url', config.url];
  }

  // stdio-based (command + args)
  if (typeof config.command === 'string') {
    const args: string[] = ['mcp', 'add', name];

    // Add --env flags if present
    if (config.env && typeof config.env === 'object') {
      for (const [key, value] of Object.entries(
        config.env as Record<string, string>,
      )) {
        args.push('--env', `${key}=${value}`);
      }
    }

    // Add -- separator and command
    args.push('--', config.command);

    // Add command args if present
    if (Array.isArray(config.args)) {
      args.push(...(config.args as string[]));
    }

    return args;
  }

  return null;
}

/**
 * Sync MCP servers from plugins into the Codex CLI via `codex mcp add/remove`.
 *
 * Uses the same ownership model as syncVscodeMcpConfig:
 * - Only tracked servers are updated/removed
 * - Pre-existing user-managed servers are skipped
 */
export async function syncCodexMcpServers(
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

  // Collect servers from all plugins
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

  // Skip calling codex CLI entirely when there are no MCP servers to sync and nothing to remove
  if (pluginServers.size === 0 && previouslyTracked.size === 0) {
    return result;
  }

  // List existing Codex MCP servers
  const listResult = await exec('codex', ['mcp', 'list', '--json']);
  if (!listResult.success) {
    result.warnings.push(
      `Codex CLI not available or 'codex mcp list' failed: ${listResult.error ?? 'unknown error'}`,
    );
    result.authoritative = false;
    result.trackedServers = [...previouslyTracked];
    return result;
  }

  let existingNames: Set<string>;
  try {
    const parsed = JSON.parse(listResult.output) as Array<{ name: string }>;
    existingNames = new Set(parsed.map((s) => s.name));
  } catch {
    result.warnings.push('Failed to parse codex mcp list output');
    result.authoritative = false;
    result.trackedServers = [...previouslyTracked];
    return result;
  }

  // Process plugin servers: add new, skip existing user-managed
  for (const [name, config] of pluginServers) {
    if (existingNames.has(name)) {
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
      const addArgs = buildCodexMcpAddArgs(
        name,
        config as Record<string, unknown>,
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
        const addResult = await exec('codex', addArgs);
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

  // Remove orphaned tracked servers (previously tracked but no longer in plugins)
  if (hasTracking) {
    const currentServerNames = new Set(pluginServers.keys());
    for (const trackedName of previouslyTracked) {
      if (
        !currentServerNames.has(trackedName) &&
        existingNames.has(trackedName)
      ) {
        if (!dryRun) {
          const removeResult = await exec('codex', [
            'mcp',
            'remove',
            trackedName,
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

  return result;
}

// ---------------------------------------------------------------------------
// Project-scoped .codex/config.toml helpers
// ---------------------------------------------------------------------------

/**
 * Convert a TOML value to its string representation.
 */
function toTomlValue(value: unknown): string {
  if (typeof value === 'string')
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (Array.isArray(value)) return `[${value.map(toTomlValue).join(', ')}]`;
  return `"${String(value)}"`;
}

/**
 * Generate TOML for a single MCP server entry.
 */
export function serverToToml(
  name: string,
  config: Record<string, unknown>,
): string {
  const lines: string[] = [`[mcp_servers.${name}]`];
  const envEntries: [string, unknown][] = [];

  for (const [key, value] of Object.entries(config)) {
    if (key === 'type') continue; // "type": "http" is implicit from url presence in codex
    if (key === 'env' && typeof value === 'object' && value !== null) {
      envEntries.push(...Object.entries(value as Record<string, unknown>));
      continue;
    }
    lines.push(`${key} = ${toTomlValue(value)}`);
  }

  if (envEntries.length > 0) {
    lines.push('');
    lines.push(`[mcp_servers.${name}.env]`);
    for (const [envKey, envValue] of envEntries) {
      lines.push(`${envKey} = ${toTomlValue(envValue)}`);
    }
  }

  return lines.join('\n');
}

/**
 * Parse existing .codex/config.toml to extract mcp_servers names.
 * Returns the set of server names and the non-mcp lines (to preserve).
 */
export function parseCodexConfigToml(content: string): {
  serverNames: Set<string>;
  nonMcpContent: string;
  serverSections: Map<string, string>;
} {
  const serverNames = new Set<string>();
  const serverSections = new Map<string, string>();
  const nonMcpLines: string[] = [];
  const lines = content.split('\n');

  let currentServer: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    // Match [mcp_servers.<name>] or [mcp_servers.<name>.env]
    const sectionMatch = line.match(
      /^\[mcp_servers\.([^\].]+?)(?:\.[^\]]+)?\]$/,
    );
    if (sectionMatch) {
      // Save previous server if any
      if (currentServer) {
        serverSections.set(
          currentServer,
          (serverSections.get(currentServer) ?? '') +
            (serverSections.has(currentServer) ? '\n' : '') +
            currentLines.join('\n'),
        );
      }
      currentServer = sectionMatch[1] ?? null;
      if (currentServer) serverNames.add(currentServer);
      currentLines = [line];
      continue;
    }

    // Check if we're entering a non-mcp section
    const otherSectionMatch = line.match(/^\[(?!mcp_servers\.)/);
    if (otherSectionMatch) {
      // Save previous server if any
      if (currentServer) {
        serverSections.set(
          currentServer,
          (serverSections.get(currentServer) ?? '') +
            (serverSections.has(currentServer) ? '\n' : '') +
            currentLines.join('\n'),
        );
        currentServer = null;
        currentLines = [];
      }
      nonMcpLines.push(line);
      continue;
    }

    if (currentServer) {
      currentLines.push(line);
    } else {
      nonMcpLines.push(line);
    }
  }

  // Save last server if any
  if (currentServer) {
    serverSections.set(
      currentServer,
      (serverSections.get(currentServer) ?? '') +
        (serverSections.has(currentServer) ? '\n' : '') +
        currentLines.join('\n'),
    );
  }

  return {
    serverNames,
    nonMcpContent: nonMcpLines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    serverSections,
  };
}

/**
 * Sync MCP server configs from plugins into project-scoped .codex/config.toml.
 *
 * Codex reads .codex/config.toml at the project root for project-scoped config
 * (in trusted projects). MCP servers are stored as [mcp_servers.<name>] sections.
 *
 * Uses the same ownership/tracking model as other MCP sync implementations.
 */
export function syncCodexProjectMcpConfig(
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
    throw new Error('configPath is required for syncCodexProjectMcpConfig');
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

  // Read existing config
  let existingContent = '';
  if (existsSync(configPath)) {
    try {
      existingContent = readFileSync(configPath, 'utf-8');
    } catch {
      result.warnings.push(
        `Could not read existing ${configPath}, starting fresh`,
      );
    }
  }

  const {
    serverNames: existingNames,
    nonMcpContent,
    serverSections,
  } = parseCodexConfigToml(existingContent);

  // Track which servers to keep in the final output
  const finalServers = new Map<string, string>(serverSections);

  // Process plugin servers
  for (const [name, config] of pluginServers) {
    if (existingNames.has(name)) {
      if (hasTracking && previouslyTracked.has(name)) {
        // We own it — overwrite with new config
        finalServers.set(
          name,
          serverToToml(name, config as Record<string, unknown>),
        );
        result.overwritten++;
        result.overwrittenServers.push(name);
        result.trackedServers.push(name);
      } else if (force) {
        finalServers.set(
          name,
          serverToToml(name, config as Record<string, unknown>),
        );
        result.overwritten++;
        result.overwrittenServers.push(name);
        result.trackedServers.push(name);
      } else {
        // User-managed — skip
        result.skipped++;
        result.skippedServers.push(name);
      }
    } else {
      finalServers.set(
        name,
        serverToToml(name, config as Record<string, unknown>),
      );
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
        finalServers.has(trackedName)
      ) {
        finalServers.delete(trackedName);
        result.removed++;
        result.removedServers.push(trackedName);
      }
    }
  }

  // Write back if changes occurred
  const hasChanges =
    result.added > 0 || result.overwritten > 0 || result.removed > 0;
  if (hasChanges && !dryRun) {
    const parts: string[] = [];
    if (nonMcpContent) {
      parts.push(nonMcpContent);
    }
    for (const toml of finalServers.values()) {
      parts.push(toml);
    }
    const output = `${parts.join('\n\n')}\n`;
    const dir = dirname(configPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(configPath, output, 'utf-8');
    result.configPath = configPath;
  }

  return result;
}
