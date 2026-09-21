import { z } from 'zod';
import { ClientTypeSchema } from './workspace-config.js';

/**
 * Per-plugin source provenance.
 *
 * Identity for git-based plugins is `url + ref`. `resolvedSha` is the commit
 * SHA returned by `git rev-parse HEAD` after the fetch and is what actually
 * uniquely identifies the installed content; `resolvedRef` is what the Git
 * resolver settled on. `requestedRef` records the user's explicit ref selector
 * (via object-form `ref`, inline `@<ref>`, or `--ref`).
 *
 * Per-skill content hashing was removed in #388 — `git rev-parse HEAD`
 * already gives content identity for free, and recomputing per-skill
 * sha256 trees on every sync was overhead without practical benefit.
 */
export const SyncStateSourceSchema = z.object({
  pluginSpec: z.string(),
  resolvedRef: z.string(),
  resolvedSha: z.string(),
  requestedRef: z.string().optional(),
});

export type SyncStateSource = z.infer<typeof SyncStateSourceSchema>;
export const NativeStateResourceSchema = z.object({
  client: ClientTypeSchema,
  scope: z.enum(['user', 'project']),
  nativeScope: z.string().min(1),
  kind: z.enum(['plugin', 'package']),
  requestedIdentity: z.string().min(1),
  resolvedIdentity: z.string().min(1),
  context: z.string().min(1),
  /** Display/materialization root, separate from the durable native identity. */
  root: z.string().min(1).optional(),
  provenance: z.record(z.string(), z.string()),
  transition: z.enum([
    'managed',
    'referenced',
    'pending-install',
    'pending-update',
    'pending-remove',
    'cleanup-failed',
    'unknown',
  ]),
  error: z.string().optional(),
});

export type NativeStateResource = z.infer<typeof NativeStateResourceSchema>;

export const NativeResourceStateSchema = z.object({
  version: z.literal(1),
  resources: z.array(NativeStateResourceSchema),
});

export type NativeResourceState = z.infer<typeof NativeResourceStateSchema>;


/**
 * Sync state schema - tracks which files were synced per client
 * Used for non-destructive sync (only purge files we previously created)
 */
export const SyncStateSchema = z
  .object({
    version: z.literal(1),
    lastSync: z.string().default('1970-01-01T00:00:00.000Z'),
    files: z.partialRecord(ClientTypeSchema, z.array(z.string())).default({}),
    // Project-scoped Codex hooks managed inside .codex/hooks.json. This stores
    // only the allagents-owned portion so sync can preserve user hooks.
    codexHooks: z
      .object({
        hooks: z.record(z.string(), z.array(z.unknown())),
      })
      .optional(),
    // MCP servers tracked per scope (e.g., "vscode" for user-level mcp.json)
    mcpServers: z.record(z.string(), z.array(z.string())).optional(),
    // Legacy native plugin tracking. Loaded for conservative migration only;
    // string identities never authorize cleanup on their own.
    nativePlugins: z
      .partialRecord(ClientTypeSchema, z.array(z.string()))
      .optional(),
    nativeResources: NativeResourceStateSchema.optional(),
    // Hash of last-written .code-workspace file content (for change detection)
    vscodeWorkspaceHash: z.string().optional(),
    // Repository paths at last sync (for detecting added/removed repos)
    vscodeWorkspaceRepos: z.array(z.string()).optional(),
    // Skills-index files tracked for cleanup (relative to .allagents/)
    skillsIndex: z.array(z.string()).optional(),
    // Per-source resolved ref + SHA + optional requested ref.
    sources: z.record(z.string(), SyncStateSourceSchema).optional(),
  })
  .passthrough();

export type SyncState = z.infer<typeof SyncStateSchema>;
