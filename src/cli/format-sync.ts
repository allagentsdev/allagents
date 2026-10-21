import {
  toNativeEffectData,
  type NativeEffectData,
  type NativeSyncResult,
} from '../core/native/types.js';
import type { SyncResult, DeletedArtifact, PluginSyncResult } from '../core/sync.js';
import type { CopyResult } from '../core/transform.js';
import type { McpMergeResult } from '../core/vscode-mcp.js';
import type { ManagedRepoResult } from '../core/managed-repos.js';
import { CLIENT_MAPPINGS, USER_CLIENT_MAPPINGS, getDisplayName } from '../models/client-mapping.js';
import type { ClientMapping } from '../models/client-mapping.js';

type ArtifactType = 'skill' | 'command' | 'agent' | 'hook';

interface ArtifactCounts {
  skills: number;
  commands: number;
  agents: number;
  hooks: number;
}

interface PathEntry {
  path: string;
  client: string;
  artifactType: ArtifactType;
}

/**
 * Build a reverse lookup from client mapping paths to client name + artifact type.
 * Sorted by path length descending so longer (more specific) paths match first.
 */
function buildPathLookup(): PathEntry[] {
  const entries: PathEntry[] = [];
  const seen = new Set<string>();

  for (const mappings of [CLIENT_MAPPINGS, USER_CLIENT_MAPPINGS]) {
    for (const [client, mapping] of Object.entries(mappings) as [string, ClientMapping][]) {
      const paths: [string | undefined, ArtifactType][] = [
        [mapping.skillsPath, 'skill'],
        [mapping.commandsPath, 'command'],
        [mapping.agentsPath, 'agent'],
        [mapping.hooksPath, 'hook'],
      ];
      for (const [path, artifactType] of paths) {
        if (!path) continue;
        // Dedup by path+artifactType so the first client to register a path wins
        // (e.g., vscode and universal both use .agents/skills/)
        const key = `${path}|${artifactType}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ path, client, artifactType });
      }
    }
  }

  entries.sort((a, b) => b.path.length - a.path.length);
  return entries;
}

let cachedLookup: PathEntry[] | null = null;

function getPathLookup(): PathEntry[] {
  if (!cachedLookup) cachedLookup = buildPathLookup();
  return cachedLookup;
}

/**
 * Classify a CopyResult's destination into client + artifact type
 * by matching against known client mapping paths.
 */
function classifyDestination(dest: string): { client: string; artifactType: ArtifactType } | null {
  const normalized = dest.replace(/\\/g, '/');
  for (const entry of getPathLookup()) {
    if (normalized.includes(`/${entry.path}`) || normalized.startsWith(entry.path)) {
      return { client: entry.client, artifactType: entry.artifactType };
    }
  }
  return null;
}

/**
 * Classify CopyResults into per-client artifact counts.
 * Only counts results with action 'copied'.
 */
export function classifyCopyResults(copyResults: CopyResult[]): Map<string, ArtifactCounts> {
  const clientCounts = new Map<string, ArtifactCounts>();
  const seenDestinations = new Set<string>();
  // Dedup by (displayClient, artifactType, artifact-name) to prevent double-counting
  // when aliased clients (e.g. vscode→copilot) or symlink targets (universal→copilot)
  // write the same artifact to different destination directories. Two plugins that share
  // a skill name write to the same canonical path, so seenDestinations already deduplicates
  // them — meaning this check is safe to key on just the artifact's folder/file name.
  const seenClientArtifacts = new Set<string>();

  for (const result of copyResults) {
    if (result.action !== 'copied') continue;
    if (seenDestinations.has(result.destination)) continue;
    seenDestinations.add(result.destination);
    const classification =
      result.client && result.artifactType
        ? { client: result.client, artifactType: result.artifactType }
        : classifyDestination(result.destination);
    if (!classification) continue;

    const { artifactType } = classification;
    const client = getDisplayName(classification.client);

    const artifactName = result.destination.replace(/\\/g, '/').split('/').pop() ?? result.destination;
    const clientArtifactKey = `${client}|${artifactType}|${artifactName}`;
    if (seenClientArtifacts.has(clientArtifactKey)) continue;
    seenClientArtifacts.add(clientArtifactKey);
    let counts = clientCounts.get(client);
    if (!counts) {
      counts = { skills: 0, commands: 0, agents: 0, hooks: 0 };
      clientCounts.set(client, counts);
    }
    switch (artifactType) {
      case 'skill': counts.skills++; break;
      case 'command': counts.commands++; break;
      case 'agent': counts.agents++; break;
      case 'hook': counts.hooks++; break;
    }
  }

  return clientCounts;
}

/**
 * Format per-client artifact counts as display lines.
 * Example: "  claude: 2 commands, 3 skills, 1 agent"
 */
export function formatArtifactLines(
  clientCounts: Map<string, ArtifactCounts>,
  indent = '  ',
): string[] {
  const lines: string[] = [];

  for (const [client, counts] of clientCounts) {
    const parts: string[] = [];
    if (counts.commands > 0) parts.push(`${counts.commands} ${counts.commands === 1 ? 'command' : 'commands'}`);
    if (counts.skills > 0) parts.push(`${counts.skills} ${counts.skills === 1 ? 'skill' : 'skills'}`);
    if (counts.agents > 0) parts.push(`${counts.agents} ${counts.agents === 1 ? 'agent' : 'agents'}`);
    if (counts.hooks > 0) parts.push(`${counts.hooks} ${counts.hooks === 1 ? 'hook' : 'hooks'}`);

    if (parts.length > 0) {
      lines.push(`${indent}${client}: ${parts.join(', ')}`);
    }
  }

  return lines;
}

/**
 * Format artifact summary for a set of copy results.
 * Returns formatted lines showing per-client artifact counts,
 * or falls back to file count if no artifacts could be classified.
 */
export function formatPluginArtifacts(copyResults: CopyResult[], indent = '  '): string[] {
  const copied = copyResults.filter((r) => r.action === 'copied');
  if (copied.length === 0) return [];

  const classified = classifyCopyResults(copied);
  if (classified.size === 0) {
    // Fallback: unclassifiable files
    return [`${indent}Copied: ${copied.length} ${copied.length === 1 ? 'file' : 'files'}`];
  }

  return formatArtifactLines(classified, indent);
}

/**
 * Format the sync header shown before individual plugin results.
 */
export function formatSyncHeader(result: SyncResult): string[] {
  const pluginCount = result.pluginResults.length;
  const successCount = result.pluginResults.filter((p) => p.success).length;
  return [
    `Updating ${pluginCount} plugin(s)...`,
    '',
    `\u2713 Successfully updated ${successCount} plugin(s)`,
  ];
}

/**
 * Format the plugin header line with optional scope.
 * Example: "✓ Plugin: deepwiki@allagents (scope: project)"
 */
export function formatPluginHeader(pluginResult: PluginSyncResult): string {
  const status = pluginResult.success ? '\u2713' : '\u2717';
  const scopeSuffix = pluginResult.scope ? ` (scope: ${pluginResult.scope})` : '';
  return `${status} Plugin: ${pluginResult.plugin}${scopeSuffix}`;
}

/**
 * Format the overall sync summary with totals for generated/failed/skipped/deleted.
 * Artifact counts per client are no longer shown here — they are displayed per-plugin.
 */
export function formatSyncSummary(
  result: SyncResult,
): string[] {
  const lines: string[] = [];

  if (result.totalGenerated > 0) lines.push(`  Total generated: ${result.totalGenerated}`);
  if (result.totalFailed > 0) lines.push(`  Total failed: ${result.totalFailed}`);
  if (result.totalSkipped > 0) lines.push(`  Total skipped: ${result.totalSkipped}`);

  if (result.deletedArtifacts && result.deletedArtifacts.length > 0) {
    lines.push(...formatDeletedArtifacts(result.deletedArtifacts));
  }

  return lines;
}

/**
 * Format deleted artifacts as a single deduplicated line.
 * Artifacts are deduplicated by type:name across all clients since
 * the user cares about what was removed, not which client directories
 * contained it.
 * Example: "  Deleted: skill 'old-skill', command 'deprecated-cmd'"
 */
export function formatDeletedArtifacts(artifacts: DeletedArtifact[]): string[] {
  const seen = new Set<string>();
  const unique: DeletedArtifact[] = [];
  for (const a of artifacts) {
    const key = `${a.type}:${a.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(a);
  }

  if (unique.length === 0) return [];

  const names = unique.map((a) => `${a.type} '${a.name}'`).join(', ');
  return [`  Deleted: ${names}`];
}

/**
 * Format MCP server sync results as display lines.
 * Returns an array of strings (one per line), or empty array if no changes.
 */
export function formatMcpResult(
  mcpResult: McpMergeResult,
  scope?: string,
): string[] {
  const { added, overwritten, removed, skipped } = mcpResult;
  if (added === 0 && overwritten === 0 && removed === 0 && skipped === 0) {
    return [];
  }

  const lines: string[] = [];

  const parts = [`${added} added`];
  if (overwritten > 0) parts.push(`${overwritten} updated`);
  if (removed > 0) parts.push(`${removed} removed`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  // MCP scopes use the raw client name (no aliasing) because
  // vscode and copilot have independent MCP support.
  const displayScope = scope;
  const label = displayScope ? `MCP servers (${displayScope})` : 'MCP servers';
  lines.push(`${label}: ${parts.join(', ')}`);

  for (const name of mcpResult.addedServers) {
    lines.push(`  + ${name}`);
  }
  for (const name of mcpResult.overwrittenServers) {
    lines.push(`  ~ ${name}`);
  }
  for (const name of mcpResult.removedServers) {
    lines.push(`  - ${name}`);
  }
  if (mcpResult.configPath) {
    lines.push(`File modified: ${mcpResult.configPath}`);
  }

  return lines;
}

function nativeActionIcon(action: NativeEffectData['action']): string {
  switch (action) {
    case 'registered':
    case 'installed':
    case 'would-register':
    case 'would-install':
      return '+';
    case 'updated':
    case 'would-update':
      return '\u2191';
    case 'removed':
    case 'would-remove':
      return '-';
    case 'failed':
      return '\u2717';
    case 'unknown':
      return '?';
    case 'configured-missing':
    case 'disabled':
    case 'unusable':
    case 'retained':
      return '!';
    case 'unchanged':
      return '=';
  }
}

export function formatNativeEffectData(data: NativeEffectData): string {
  const provider = `[${data.client}:${data.scope}]`;
  const details = [
    `kind=${data.kind}`,
    `requested=${JSON.stringify(data.requestedIdentity)}`,
    `resolved=${JSON.stringify(data.resolvedIdentity)}`,
    `root=${JSON.stringify(data.root)}`,
    `action=${data.action}`,
    `phase=${data.phase}`,
    `changed=${String(data.changed)}`,
  ].join(' ');
  return `  ${nativeActionIcon(data.action)} ${provider} ${details}${data.error ? ` error=${JSON.stringify(data.error)}` : ''}`;
}

/**
 * Format typed native lifecycle results. Human and JSON rendering both consume
 * toNativeEffectData so identity, scope, phase, root, and sanitized failures
 * cannot drift between output modes.
 */
export function formatNativeResult(nativeResult: NativeSyncResult): string[] {
  return nativeResult.effects.map((effect) =>
    formatNativeEffectData(toNativeEffectData(effect)));
}

/**
 * Format verbose sync result lines suitable for display in both headless and TUI modes.
 * Includes per-plugin headers, per-client artifact counts, generated/failed breakdowns,
 * MCP server changes, native plugin results, warnings, and summary totals.
 */
export function formatVerboseSyncLines(result: SyncResult): string[] {
  const lines: string[] = [];

  for (const pluginResult of result.pluginResults) {
    lines.push(formatPluginHeader(pluginResult));

    if (pluginResult.error) {
      lines.push(`  Error: ${pluginResult.error}`);
    }

    lines.push(...formatPluginArtifacts(pluginResult.copyResults));

    const generated = pluginResult.copyResults.filter((r) => r.action === 'generated').length;
    const failed = pluginResult.copyResults.filter((r) => r.action === 'failed').length;

    if (generated > 0) lines.push(`  Generated: ${generated} files`);
    if (failed > 0) {
      lines.push(`  Failed: ${failed} files`);
      for (const failedResult of pluginResult.copyResults.filter((r) => r.action === 'failed')) {
        lines.push(`    - ${failedResult.destination}: ${failedResult.error}`);
      }
    }
  }

  if (result.warnings && result.warnings.length > 0) {
    lines.push('');
    for (const warning of result.warnings) {
      lines.push(`  \u26A0 ${warning}`);
    }
  }

  if (result.mcpResults) {
    for (const [scope, mcpResult] of Object.entries(result.mcpResults)) {
      if (!mcpResult) continue;
      const mcpLines = formatMcpResult(mcpResult, scope);
      if (mcpLines.length > 0) {
        lines.push('');
        lines.push(...mcpLines);
      }
    }
  }

  if (result.nativeResult) {
    const nativeLines = formatNativeResult(result.nativeResult);
    if (nativeLines.length > 0) {
      lines.push('');
      lines.push(...nativeLines);
    }
  }

  const summaryLines = formatSyncSummary(result);
  if (summaryLines.length > 0) {
    lines.push('');
    lines.push(...summaryLines);
  }

  return lines;
}

/**
 * Build a JSON-friendly sync data object from a sync result.
 */
export function buildSyncData(result: SyncResult) {
  return {
    ...(result.error && { error: result.error }),
    copied: result.totalCopied,
    generated: result.totalGenerated,
    failed: result.totalFailed,
    skipped: result.totalSkipped,
    ...(result.messages &&
      result.messages.length > 0 && { messages: result.messages }),
    plugins: result.pluginResults.map((pr) => ({
      plugin: pr.plugin,
      success: pr.success,
      error: pr.error,
      copied: pr.copyResults.filter((r) => r.action === 'copied').length,
      generated: pr.copyResults.filter((r) => r.action === 'generated').length,
      failed: pr.copyResults.filter((r) => r.action === 'failed').length,
      copyResults: pr.copyResults,
    })),
    purgedPaths: result.purgedPaths ?? [],
    deletedArtifacts: result.deletedArtifacts ?? [],
    ...(result.mcpResults && {
      mcpServers: Object.fromEntries(
        Object.entries(result.mcpResults)
          .filter((entry): entry is [string, McpMergeResult] => entry[1] != null)
          .map(([scope, r]) => [
            scope,
            {
              added: r.added,
              skipped: r.skipped,
              overwritten: r.overwritten,
              removed: r.removed,
              addedServers: r.addedServers,
              skippedServers: r.skippedServers,
              overwrittenServers: r.overwrittenServers,
              removedServers: r.removedServers,
              ...(r.configPath && { configPath: r.configPath }),
            },
          ]),
      ),
    }),
    ...(result.nativeResult && {
      nativeResources: {
        success: result.nativeResult.success,
        effects: result.nativeResult.effects.map(toNativeEffectData),
      },
    }),
    ...(result.managedRepoResults && result.managedRepoResults.length > 0 && {
      managedRepos: result.managedRepoResults.map((r) => ({
        repo: r.repo,
        path: r.path,
        action: r.action,
        ...(r.error && { error: r.error }),
      })),
    }),
  };
}

/**
 * Format managed repository results for display.
 */
export function formatManagedRepoResults(results: ManagedRepoResult[]): string[] {
  const actionResults = results.filter((r) => r.action !== 'skipped' || r.error);
  if (actionResults.length === 0) return [];

  const lines: string[] = ['Repositories:'];
  for (const r of actionResults) {
    if (r.action === 'cloned') {
      lines.push(`  \u2713 Cloned ${r.repo} \u2192 ${r.path}`);
    } else if (r.action === 'pulled') {
      lines.push(`  \u2713 Pulled ${r.repo}`);
    } else if (r.error) {
      lines.push(`  \u2717 ${r.repo}: ${r.error}`);
    }
  }
  return lines;
}
