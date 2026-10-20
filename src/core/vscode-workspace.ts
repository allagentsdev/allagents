import { createHash } from 'node:crypto';
import { resolve, basename, relative } from 'node:path';
import type { Repository, VscodeConfig } from '../models/workspace-config.js';

/**
 * Input for generating a VSCode workspace
 */
export interface GenerateVscodeWorkspaceInput {
  workspacePath: string;
  repositories: Repository[];
  template: Record<string, unknown> | undefined;
}

/**
 * Folder entry in a .code-workspace file
 */
export interface WorkspaceFolder {
  path: string;
  name?: string | undefined;
}

/**
 * Default VSCode settings when no template is provided
 */
const DEFAULT_SETTINGS: Record<string, unknown> = {
  'chat.agent.maxRequests': 999,
};

/**
 * Map for path placeholder resolution.
 * Keys are relative paths from workspace.yaml (e.g., "../Glow")
 */
export type PathPlaceholderMap = Map<string, string>;

function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, '/');
}

function resolveFolderAbsolutePath(
  workspacePath: string,
  folderPath: string,
): string {
  return resolve(workspacePath, folderPath).replace(/\\/g, '/');
}

function resolveFolderDisplayPath(folderPath: string): string {
  return normalizeWorkspacePath(folderPath);
}

/**
 * Build a placeholder map from repositories using path as the lookup key.
 *
 * @param repositories - Repository list from workspace.yaml
 * @param workspacePath - Workspace root for resolving relative paths
 * @returns Map of relative paths to absolute paths
 *
 * @example
 * // Given: { path: "../Glow" } and workspacePath: "/home/user/workspace"
 * // Result: Map { "../Glow" => "/home/user/Glow" }
 */
export function buildPathPlaceholderMap(
  repositories: Repository[],
  workspacePath: string,
): PathPlaceholderMap {
  const map = new Map<string, string>();

  for (const repo of repositories) {
    const absolutePath = resolve(workspacePath, repo.path);
    map.set(repo.path, absolutePath);
  }

  return map;
}

/**
 * Recursively substitute {path:...} placeholders and normalize backslashes to forward slashes.
 *
 * Placeholder format: {path:../Glow} where the value matches a repository path from workspace.yaml
 *
 * @example
 * // Given repositories: [{ path: "../Glow" }]
 * "{path:../Glow}/src" → "/home/user/Glow/src"
 * "D:\\GitHub\\Glow" → "D:/GitHub/Glow"
 */
export function substitutePathPlaceholders<T>(
  obj: T,
  pathMap: PathPlaceholderMap,
): T {
  if (typeof obj === 'string') {
    // First substitute placeholders, then normalize backslashes to forward slashes
    const substituted = obj.replace(/\{path:([^}]+)\}/g, (_match, pathKey: string) => {
      const resolved = pathMap.get(pathKey);
      if (resolved) {
        return resolved;
      }
      // Keep unresolved placeholders for debugging
      return `{path:${pathKey}}`;
    });
    // Normalize all backslashes to forward slashes (cross-platform compatible)
    return substituted.replace(/\\/g, '/') as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => substitutePathPlaceholders(item, pathMap)) as T;
  }

  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substitutePathPlaceholders(value, pathMap);
    }
    return result as T;
  }

  return obj;
}

/**
 * Generate a .code-workspace JSON structure from workspace config and optional template
 */
export function generateVscodeWorkspace(
  input: GenerateVscodeWorkspaceInput,
): Record<string, unknown> {
  const { workspacePath, repositories, template } = input;

  // Build path placeholder map for substitution
  const pathMap = buildPathPlaceholderMap(repositories, workspacePath);

  // Substitute placeholders in template
  const resolvedTemplate = template
    ? substitutePathPlaceholders(template, pathMap)
    : undefined;

  // Build folders list
  const folders: WorkspaceFolder[] = [];
  const seenPaths = new Set<string>();

  // 0. Current workspace folder
  folders.push({ path: '.' });
  // Track absolute path for deduplication
  seenPaths.add(resolve(workspacePath, '.'));

  // 1. Repository folders (from workspace.yaml)
  for (const repo of repositories) {
    const absolutePath = resolveFolderAbsolutePath(workspacePath, repo.path);
    const entry: WorkspaceFolder = {
      path: resolveFolderDisplayPath(repo.path),
    };
    if (repo.name !== undefined) entry.name = repo.name;
    folders.push(entry);
    seenPaths.add(absolutePath);
  }

  // 2. Template folders (deduplicated against repo folders, preserve optional name)
  if (resolvedTemplate && Array.isArray(resolvedTemplate.folders)) {
    for (const folder of resolvedTemplate.folders as WorkspaceFolder[]) {
      const rawPath = folder.path as string;
      const normalizedPath = resolveFolderAbsolutePath(workspacePath, rawPath);
      if (!seenPaths.has(normalizedPath)) {
        const entry: WorkspaceFolder = {
          path: resolveFolderDisplayPath(rawPath),
        };
        if (folder.name !== undefined) entry.name = folder.name;
        folders.push(entry);
        seenPaths.add(normalizedPath);
      }
    }
  }

  // Build settings
  let settings: Record<string, unknown>;
  if (resolvedTemplate?.settings) {
    // Template has full control over settings
    settings = { ...(resolvedTemplate.settings as Record<string, unknown>) };
  } else {
    settings = { ...DEFAULT_SETTINGS };
  }

  // Build result — folders and settings first, then pass through all other template keys
  const result: Record<string, unknown> = { folders, settings };

  if (resolvedTemplate) {
    for (const [key, value] of Object.entries(resolvedTemplate)) {
      if (key !== 'folders' && key !== 'settings') {
        result[key] = value;
      }
    }
  }

  return result;
}

/**
 * Determine the output filename for the .code-workspace file
 *
 * Priority: vscodeConfig.output > <dirname>.code-workspace
 */
export function getWorkspaceOutputPath(
  workspacePath: string,
  vscodeConfig: VscodeConfig | undefined,
): string {
  const name = vscodeConfig?.output;

  if (name) {
    const filename = name.endsWith('.code-workspace') ? name : `${name}.code-workspace`;
    return resolve(workspacePath, filename);
  }

  // Default: use workspace directory name
  const dirName = basename(resolve(workspacePath));
  return resolve(workspacePath, `${dirName}.code-workspace`);
}

/**
 * Compute SHA-256 hash of .code-workspace file content.
 * Used to detect external modifications between syncs.
 */
export function computeWorkspaceHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Result of reconciling .code-workspace folders with workspace.yaml repositories.
 */
export interface ReconcileResult {
  /** Updated repositories list after merging changes */
  updatedRepos: Repository[];
  /** Relative paths of repositories added from .code-workspace */
  added: string[];
  /** Relative paths of repositories removed (were in .code-workspace before, now gone) */
  removed: string[];
  /** Relative paths of repositories whose display name changed in .code-workspace */
  renamed: string[];
}

/** Normalize folder identity without retaining editor path spelling in sync state. */
export function snapshotVscodeWorkspaceFolders(
  workspacePath: string,
  folders: WorkspaceFolder[],
): WorkspaceFolder[] {
  return folders.map(({ path, name }) => ({
    path: resolveFolderAbsolutePath(workspacePath, path),
    ...(name !== undefined && { name }),
  }));
}

/** Merge actual editor folder/name edits, retaining independent YAML changes. */
export function reconcileVscodeWorkspaceFolders(
  workspacePath: string,
  codeWorkspaceFolders: WorkspaceFolder[],
  lastSyncedFolders: WorkspaceFolder[],
  lastSyncedRepos: string[],
  currentRepos: Repository[],
): ReconcileResult {
  const root = resolveFolderAbsolutePath(workspacePath, '.');
  const folders = new Map(
    snapshotVscodeWorkspaceFolders(workspacePath, codeWorkspaceFolders)
      .filter((folder) => folder.path !== root)
      .map((folder) => [folder.path, folder]),
  );
  const baseline = new Map(
    lastSyncedFolders.map((folder) => [folder.path, folder]),
  );
  const previousRepos = new Set(lastSyncedRepos);
  const currentPaths = new Set(
    currentRepos.map((repo) =>
      resolveFolderAbsolutePath(workspacePath, repo.path),
    ),
  );
  const result: ReconcileResult = {
    updatedRepos: [],
    added: [],
    removed: [],
    renamed: [],
  };

  for (const repo of currentRepos) {
    const path = resolveFolderAbsolutePath(workspacePath, repo.path);
    const folder = folders.get(path);
    if (previousRepos.has(path) && !folder) {
      result.removed.push(repo.path);
      continue;
    }
    if (
      folder &&
      folder.name !== baseline.get(path)?.name &&
      folder.name !== repo.name
    ) {
      const { name: _name, ...updated } = repo;
      result.updatedRepos.push(
        folder.name === undefined ? updated : { ...updated, name: folder.name },
      );
      result.renamed.push(repo.path);
    } else {
      result.updatedRepos.push(repo);
    }
  }

  for (const [path, folder] of folders) {
    if (previousRepos.has(path) || currentPaths.has(path)) continue;
    const prior = baseline.get(path);
    if (prior && prior.name === folder.name) continue;
    const repo: Repository = { path: relative(root, path).replace(/\\/g, '/') };
    if (folder.name !== undefined) repo.name = folder.name;
    result.added.push(repo.path);
    result.updatedRepos.push(repo);
  }
  return result;
}
