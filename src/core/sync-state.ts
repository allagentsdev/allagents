import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { CONFIG_DIR, SYNC_STATE_FILE } from '../constants.js';
import {
  SyncStateSchema,
  type NativeResourceState,
  type NativeStateResource,
  type SyncState,
  type SyncStateSource,
} from '../models/sync-state.js';
import type { ClientType } from '../models/workspace-config.js';
import { ensureConfigGitignore } from './config-gitignore.js';

/** MCP client identifier (e.g., "vscode" for project .vscode/mcp.json) */
export type McpScope = 'vscode' | 'codex' | 'claude' | 'copilot';

/**
 * Data structure for saving sync state with optional MCP servers
 */
export interface SyncStateData {
  files: Partial<Record<ClientType, string[]>>;
  codexHooks?: SyncState['codexHooks'];
  mcpServers?: Partial<Record<McpScope, string[]>>;
  /** Legacy native identities, retained only for conservative migration. */
  nativePlugins?: Partial<Record<ClientType, string[]>>;
  nativeResources?: NativeResourceState;
  vscodeWorkspaceHash?: string;
  vscodeWorkspaceRepos?: string[];
  vscodeWorkspaceFolders?: SyncState['vscodeWorkspaceFolders'];
  skillsIndex?: string[];
  sources?: Record<string, SyncStateSource>;
}

/**
 * Get the path to the sync state file
 * @param workspacePath - Path to workspace directory
 * @returns Path to .allagents/sync-state.json
 */
export function getSyncStatePath(workspacePath: string): string {
  return join(workspacePath, CONFIG_DIR, SYNC_STATE_FILE);
}
async function readRawState(statePath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(statePath, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function writeStateAtomically(
  statePath: string,
  state: SyncState,
): Promise<void> {
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(state, null, 2), 'utf-8');
    await rename(tempPath, statePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}


/**
 * Load sync state from disk
 * Returns null if file doesn't exist or is corrupted (safe behavior)
 * @param workspacePath - Path to workspace directory
 * @returns Parsed sync state or null
 */
export async function loadSyncState(workspacePath: string): Promise<SyncState | null> {
  const statePath = getSyncStatePath(workspacePath);

  try {
    const parsed = await readRawState(statePath);
    if (!parsed) return null;
    const result = SyncStateSchema.safeParse(parsed);
    if (!result.success) {
      // Unknown/corrupt state grants no deletion authority.
      return null;
    }
    return result.data;
  } catch {
    // Read or parse error - treat as no state
    return null;
  }
}

/**
 * Save sync state to disk
 * @param workspacePath - Path to workspace directory
 * @param data - Sync state data including files and optional MCP servers
 */
export async function saveSyncState(
  workspacePath: string,
  data: SyncStateData | Partial<Record<ClientType, string[]>>,
): Promise<void> {
  const statePath = getSyncStatePath(workspacePath);

  // Support the historical files-only signature.
  const normalizedData: SyncStateData = 'files' in data
    ? data as SyncStateData
    : { files: data as Partial<Record<ClientType, string[]>> };
  const existing = (await readRawState(statePath)) ?? {};
  const candidate: Record<string, unknown> = {
    ...existing,
    version: 1,
    lastSync: new Date().toISOString(),
    files: normalizedData.files,
  };

  for (const key of [
    'codexHooks',
    'mcpServers',
    'nativePlugins',
    'nativeResources',
    'vscodeWorkspaceHash',
    'vscodeWorkspaceRepos',
    'vscodeWorkspaceFolders',
    'skillsIndex',
    'sources',
  ] as const) {
    if (key in normalizedData) {
      const value = normalizedData[key];
      if (value === undefined) delete candidate[key];
      else candidate[key] = value;
    }
  }

  const parsed = SyncStateSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`Refusing to write invalid sync state: ${parsed.error.message}`);
  }

  await mkdir(dirname(statePath), { recursive: true });
  await ensureConfigGitignore(workspacePath);
  await writeStateAtomically(statePath, parsed.data);
}


/**
 * Get files that were previously synced for a specific client
 * @param state - Loaded sync state (or null)
 * @param client - Client type to get files for
 * @returns Array of file paths, empty if no state or no files for client
 */
export function getPreviouslySyncedFiles(
  state: SyncState | null,
  client: ClientType,
): string[] {
  if (!state) {
    return [];
  }

  return state.files[client] ?? [];
}

/**
 * Get MCP servers that were previously synced for a specific scope
 * @param state - Loaded sync state (or null)
 * @param scope - MCP scope to get servers for (e.g., "vscode")
 * @returns Array of server names, empty if no state or no servers for scope
 */
export function getPreviouslySyncedMcpServers(
  state: SyncState | null,
  scope: McpScope,
): string[] {
  if (!state?.mcpServers) {
    return [];
  }

  return state.mcpServers[scope] ?? [];
}

/**
 * Return exact native state records for one ordinary client/scope/context.
 * Legacy string identities are intentionally excluded: they are not cleanup
 * authority until live inspection and a desired declaration corroborate them.
 */
export function getNativeStateResources(
  state: SyncState | null,
  client: ClientType,
  scope: 'user' | 'project',
  context: string,
): NativeStateResource[] {
  return (state?.nativeResources?.resources ?? []).filter(
    (resource) =>
      resource.client === client &&
      resource.scope === scope &&
      resource.context === context,
  );
}

export function nativeStateOwnership(
  transition: NativeStateResource['transition'],
): 'managed' | 'referenced' | 'uncertain' {
  if (transition === 'referenced') return 'referenced';
  if (
    transition === 'managed' ||
    transition === 'pending-install' ||
    transition === 'pending-update' ||
    transition === 'pending-remove' ||
    transition === 'cleanup-failed'
  ) {
    return 'managed';
  }
  return 'uncertain';
}

export async function saveNativeStateResources(
  workspacePath: string,
  resources: NativeStateResource[],
): Promise<void> {
  const statePath = getSyncStatePath(workspacePath);
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(statePath, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected an object');
    }
    raw = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(
        `Refusing to patch malformed sync state: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const files = SyncStateSchema.shape.files.safeParse(raw.files);
  if (!files.success) {
    throw new Error(
      `Refusing to patch native state because file ownership is invalid: ${files.error.message}`,
    );
  }
  const candidate = SyncStateSchema.safeParse({
    ...raw,
    version: 1,
    lastSync: new Date().toISOString(),
    files: files.data,
    nativeResources: { version: 1, resources },
  });
  if (!candidate.success) {
    throw new Error(
      `Refusing to patch native state because unrelated state is invalid: ${candidate.error.message}`,
    );
  }

  await mkdir(dirname(statePath), { recursive: true });
  await ensureConfigGitignore(workspacePath);
  await writeStateAtomically(statePath, candidate.data);
}

/**
 * Upsert a source provenance record into sync-state, preserving all other
 * fields. Use when recording the resolved ref/SHA after a fetch.
 */
export async function upsertSyncStateSource(
  workspacePath: string,
  key: string,
  source: SyncStateSource,
): Promise<void> {
  const existing = await loadSyncState(workspacePath);
  const sources = { ...(existing?.sources ?? {}), [key]: source };

  await saveSyncState(workspacePath, {
    files: (existing?.files ?? {}) as Partial<Record<ClientType, string[]>>,
    ...(existing?.codexHooks && { codexHooks: existing.codexHooks }),
    ...(existing?.mcpServers && {
      mcpServers: existing.mcpServers as Partial<Record<McpScope, string[]>>,
    }),
    ...(existing?.nativePlugins && {
      nativePlugins: existing.nativePlugins as Partial<Record<ClientType, string[]>>,
    }),
    ...(existing?.vscodeWorkspaceHash && {
      vscodeWorkspaceHash: existing.vscodeWorkspaceHash,
    }),
    ...(existing?.vscodeWorkspaceRepos && {
      vscodeWorkspaceRepos: existing.vscodeWorkspaceRepos,
    }),
    ...(existing?.skillsIndex && { skillsIndex: existing.skillsIndex }),
    sources,
  });
}
