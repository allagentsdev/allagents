import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import JSON5 from 'json5';
import type { McpMergeResult } from './vscode-mcp.js';

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

/** Merge JSON client configuration without claiming or discarding user-owned entries. */
export function syncJsonMcpConfig(
  pluginServers: Map<string, unknown>,
  serverKey: 'servers' | 'mcpServers',
  options: {
    configPath: string;
    dryRun?: boolean;
    force?: boolean;
    trackedServers?: string[];
  },
  warnings: string[],
): McpMergeResult {
  const { configPath, dryRun = false, force = false } = options;
  const previouslyTracked = new Set(options.trackedServers ?? []);
  const hasTracking = options.trackedServers !== undefined;

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

  let existingConfig: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON5.parse(readFileSync(configPath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Expected a configuration object');
    }
    existingConfig = parsed as Record<string, unknown>;
    const servers = existingConfig[serverKey];
    if (servers !== undefined &&
      (!servers || typeof servers !== 'object' || Array.isArray(servers))) {
      throw new Error('Expected a server mapping');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      result.authoritative = false;
      result.trackedServers = [...previouslyTracked];
      result.warnings.push(
        `Refusing to overwrite unreadable or invalid MCP configuration at ${configPath}. Repair the file and retry.`,
      );
      return result;
    }
  }

  const existingServers =
    (existingConfig[serverKey] as Record<string, unknown> | undefined) ?? {};

  // Process plugin servers: add new, update tracked, skip user-managed conflicts
  for (const [name, config] of pluginServers) {
    if (name in existingServers) {
      if (!deepEqual(existingServers[name], config)) {
        if ((hasTracking && previouslyTracked.has(name)) || force) {
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

  // Remove orphaned tracked servers (previously tracked but no longer in plugins)
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
    existingConfig[serverKey] = existingServers;
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

  return result;
}
