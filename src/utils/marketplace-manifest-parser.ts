import { lstatSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  type MarketplaceManifest,
  MarketplaceManifestLenientSchema,
  MarketplaceManifestSchema,
  type MarketplacePluginEntry,
  MarketplacePluginEntrySchema,
  type PluginSourceRef,
  PluginSourceRefSchema,
} from '../models/marketplace-manifest.js';
import type { PluginComponentPolicy } from '../models/plugin-components.js';
import { assertPluginComponentPath } from '../core/plugin-components.js';

const MANIFEST_PATHS = [
  '.github/plugin/marketplace.json',
  '.claude-plugin/marketplace.json',
] as const;

export type ParseResult =
  | { success: true; data: MarketplaceManifest; warnings: string[] }
  | { success: false; error: string };

/**
 * Parse and validate a marketplace.json from a marketplace directory.
 * Prefers GitHub Copilot's marketplace location and falls back to Claude's.
 *
 * Uses a two-tier approach:
 * 1. Try strict validation first — if it passes, return with no warnings
 * 2. If strict fails, try lenient parsing — validate each plugin entry
 *    individually, collecting warnings for invalid fields/entries
 */
export async function parseMarketplaceManifest(
  marketplacePath: string,
  selectedPlugin?: string,
  componentPolicy?: PluginComponentPolicy,
): Promise<ParseResult> {
  const manifestPath = MANIFEST_PATHS
    .map((path) => join(marketplacePath, path))
    .find((path) => {
      try { lstatSync(path); return true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
      }
    });

  if (!manifestPath) {
    return {
      success: false,
      error: `Marketplace manifest not found (checked ${MANIFEST_PATHS.join(', ')})`,
    };
  }

  let raw: string;
  try {
    assertPluginComponentPath(marketplacePath, manifestPath);
    raw = await readFile(manifestPath, 'utf-8');
  } catch (err) {
    return {
      success: false,
      error: `Failed to read marketplace manifest: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return {
      success: false,
      error: 'Failed to parse marketplace.json as JSON: invalid syntax',
    };
  }

  // Invalid selected declarations are not authoritative absence. Strict does
  // not change which components load; catalogue shapes are checked in all modes.
  if (selectedPlugin && isRecord(json) && Array.isArray(json.plugins)) {
    for (const [index, entry] of json.plugins.entries()) {
      if (isRecord(entry) && entry.name === selectedPlugin) {
        for (const field of ['skills', 'commands', 'agents', 'hooks', 'mcpServers', 'strict'] as const) {
          if (field === 'hooks' && componentPolicy?.hooks === false) continue;
          const fieldSchema = MarketplacePluginEntrySchema.shape[field];
          if (!fieldSchema.safeParse(entry[field]).success) {
            return { success: false, error: `plugins[${index}]: invalid "${field}" declaration` };
          }
        }
      }
      if (!isRecord(entry) || entry.name !== selectedPlugin) continue;
      if (!PluginSourceRefSchema.safeParse(entry.source).success) {
        return {
          success: false,
          error: isRecord(entry.source)
            ? `plugins[${index}]: invalid external source (SHA pins are not supported by file installations)`
            : `plugins[${index}]: missing or invalid "source" declaration`,
        };
      }
    }
  }

  // Tier 1: strict validation
  const strictResult = MarketplaceManifestSchema.safeParse(json);
  if (strictResult.success) {
    return { success: true, data: strictResult.data, warnings: [] };
  }

  // Tier 2: lenient parsing
  return parseLeniently(json, selectedPlugin);
}

/**
 * Attempt lenient parsing of a marketplace manifest.
 * Requires at minimum a `plugins` array in the JSON.
 * Validates each plugin entry individually, collecting warnings.
 */
function parseLeniently(json: unknown, selectedPlugin?: string): ParseResult {
  const lenientResult = MarketplaceManifestLenientSchema.safeParse(json);
  if (!lenientResult.success) {
    return {
      success: false,
      error: 'Marketplace manifest must contain a "plugins" array',
    };
  }

  const raw = lenientResult.data;
  const warnings: string[] = [];

  const obj = json as Record<string, unknown>;

  // Validate each plugin entry individually
  const validPlugins: MarketplacePluginEntry[] = [];

  for (let i = 0; i < raw.plugins.length; i++) {
    const entry = raw.plugins[i];
    const entryResult = MarketplacePluginEntrySchema.safeParse(entry);

    if (entryResult.success) {
      validPlugins.push(entryResult.data);
      continue;
    }

    // Best-effort extraction
    const entryWarnings: string[] = [];
    const extracted = extractPluginEntry(entry, i, entryWarnings);
    // Unknown identities remain relevant: malformed entries must not be
    // interpreted as authoritative removal of the selected plugin.
    if (!selectedPlugin || !isRecord(entry) || typeof entry.name !== 'string' || !entry.name || entry.name === selectedPlugin) {
      warnings.push(...entryWarnings);
    }
    if (extracted) {
      validPlugins.push(extracted);
    }
  }

  // Build a manifest-like object with the valid plugins
  const data: MarketplaceManifest = {
    name: typeof raw.name === 'string' ? raw.name : 'unknown',
    description: typeof obj.description === 'string' ? obj.description as string : '',
    plugins: validPlugins,
  };

  return { success: true, data, warnings };
}

/**
 * Best-effort extraction of a plugin entry from raw data.
 * Returns null only if the entry is completely unusable (not an object).
 */
function extractPluginEntry(
  entry: unknown,
  index: number,
  warnings: string[],
): MarketplacePluginEntry | null {
  if (!entry || typeof entry !== 'object') {
    warnings.push(`plugins[${index}]: not an object, skipped`);
    return null;
  }

  const obj = entry as Record<string, unknown>;

  const name = typeof obj.name === 'string' && obj.name ? obj.name : undefined;
  if (!name) {
    warnings.push(`plugins[${index}]: missing "name" field, skipped`);
    return null;
  }

  // Try to extract description from common locations
  let description = '';
  if (typeof obj.description === 'string' && obj.description) {
    description = obj.description;
  } else if (
    obj.metadata &&
    typeof obj.metadata === 'object' &&
    typeof (obj.metadata as Record<string, unknown>).description === 'string'
  ) {
    description = (obj.metadata as Record<string, unknown>).description as string;
    warnings.push(`plugins[${index}] ("${name}"): "description" found in metadata instead of top level`);
  } else {
    warnings.push(`plugins[${index}] ("${name}"): missing "description" field`);
  }

  // Try to extract and normalize source via the schema (handles string, url, github→url transform)
  let source: PluginSourceRef = '';
  const sourceResult = PluginSourceRefSchema.safeParse(obj.source);
  if (sourceResult.success) {
    source = sourceResult.data;
  } else {
    warnings.push(`plugins[${index}] ("${name}"): missing or invalid "source" field`);
  }

  return {
    name,
    description,
    source,
    ...(typeof obj.version === 'string' && { version: obj.version }),
    ...(typeof obj.category === 'string' && { category: obj.category }),
    ...(typeof obj.homepage === 'string' && { homepage: obj.homepage }),
    ...(isComponentPath(obj.skills) && { skills: obj.skills }),
    ...(isComponentPath(obj.commands) && { commands: obj.commands }),
    ...(isComponentPath(obj.agents) && { agents: obj.agents }),
    ...((typeof obj.hooks === 'string' || isRecord(obj.hooks)) && {
      hooks: obj.hooks,
    }),
    ...((typeof obj.mcpServers === 'string' || isRecord(obj.mcpServers)) && {
      mcpServers: obj.mcpServers,
    }),
    ...(typeof obj.strict === 'boolean' && { strict: obj.strict }),
  };
}

function isComponentPath(value: unknown): value is string | string[] {
  return (
    typeof value === 'string' ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Resolve a plugin source reference to a usable path.
 *
 * - String sources (relative paths like "./plugins/foo") are resolved
 *   relative to the marketplace directory.
 * - URL source objects return the URL string directly.
 */
export function resolvePluginSourcePath(
  source: PluginSourceRef,
  marketplacePath: string,
): string {
  if (typeof source === 'object') {
    return source.url;
  }
  return resolve(marketplacePath, source);
}
