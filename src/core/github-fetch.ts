import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGitHubUrl } from '../utils/plugin-path.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import {
  cloneToTemp,
  cloneGitHubWithGhToTemp,
  listGitHubBranchesWithGh,
  cleanupTempDir,
  gitHubUrl,
  refExists,
  GitCloneError,
} from './git.js';
import { findWorkspaceTemplatesInDirectory } from './workspace-templates.js';

/**
 * Result of fetching workspace from GitHub
 */
export interface FetchWorkspaceResult {
  success: boolean;
  content?: string;
  error?: string;
  /** Temp directory containing the cloned repo. Caller must call cleanupTempDir() when done. */
  tempDir?: string;
  /** Resolved subpath within the repo (after branch resolution and .allagents stripping) */
  resolvedSubpath?: string;
  /** Resolved branch name (after branch/subpath resolution) */
  resolvedBranch?: string;
  /** Workspace roots found below the requested path when it has no workspace.yaml. */
  availableTemplates?: string[];
}

/**
 * Read a file from an already-cloned temp directory.
 * @param tempDir - Path to the cloned repository
 * @param filePath - Relative file path within the repository
 * @returns File content or null if not found
 */
export function readFileFromClone(
  tempDir: string,
  filePath: string,
): string | null {
  const fullPath = join(tempDir, filePath);
  if (existsSync(fullPath)) {
    return readFileSync(fullPath, 'utf-8');
  }
  return null;
}

/**
 * Resolve branch/subpath combination by checking which refs exist on the remote.
 * Handles branch names with slashes by trying different split points.
 */
async function resolveBranchAndSubpath(
  repoUrl: string,
  pathAfterTree: string,
): Promise<{ branch: string; subpath?: string } | null> {
  const parts = pathAfterTree.split('/');

  // Try each possible split point, starting from the longest branch name
  for (let i = parts.length - 1; i >= 1; i--) {
    const branch = parts.slice(0, i).join('/');
    const subpath = parts.slice(i).join('/');

    if (await refExists(repoUrl, branch)) {
      return { branch, ...(subpath && { subpath }) };
    }
  }

  return null;
}

/**
 * Fetch workspace.yaml from a GitHub URL
 *
 * Supports:
 * - https://github.com/owner/repo (looks for .allagents/workspace.yaml or workspace.yaml)
 * - https://github.com/owner/repo/tree/branch/path (looks in path/.allagents/workspace.yaml or path/workspace.yaml)
 * - owner/repo (shorthand)
 * - owner/repo/path/to/workspace (shorthand with subpath)
 *
 * Intelligently resolves branch names with slashes by checking which refs exist.
 *
 * Returns a tempDir when a workspace or nested templates are found. The caller
 * must call cleanupTempDir() when done reading from the clone.
 *
 * @param url - GitHub URL or shorthand
 * @returns Result with workspace.yaml content, tempDir, or error
 */
export async function fetchWorkspaceFromGitHub(
  url: string,
): Promise<FetchWorkspaceResult> {
  const parsed = parseGitHubUrl(url);
  if (!parsed) {
    return {
      success: false,
      error:
        'Invalid GitHub URL format. Expected: https://github.com/owner/repo',
    };
  }

  const { owner, repo, branch } = parsed;
  // Normalize subpath to remove trailing slashes
  const subpath = parsed.subpath?.replace(/\/+$/, '');
  const repoUrl = gitHubUrl(owner, repo);

  // If we have both branch and subpath, try to resolve the correct split
  // before cloning. The URL parser's heuristic may split incorrectly when
  // path components (like .allagents) are in commonPathDirs but earlier
  // directories (like templates/) are not.
  let effectiveBranch = branch;
  let effectiveSubpath = subpath;

  if (branch && subpath) {
    const pathAfterTree = `${branch}/${subpath}`;
    const resolved = await resolveBranchAndSubpath(repoUrl, pathAfterTree);
    let authenticated = resolved;
    if (!authenticated) {
      try {
        const branches = await listGitHubBranchesWithGh(
          owner,
          repo,
          pathAfterTree.split('/')[0] ?? '',
        );
        const match = branches
          .filter((candidate) => pathAfterTree.startsWith(`${candidate}/`))
          .sort((left, right) => right.length - left.length)[0];
        if (match) {
          authenticated = {
            branch: match,
            subpath: pathAfterTree.slice(match.length + 1),
          };
        }
      } catch {
        // GitHub CLI may be unavailable; clone will report the access error.
      }
    }
    if (authenticated) {
      effectiveBranch = authenticated.branch;
      effectiveSubpath = authenticated.subpath;
    }
  }

  // Normalize: if user pointed directly at .allagents folder, strip it.
  // The workspace.yaml search already looks inside .allagents/ relative to the base path.
  if (effectiveSubpath === CONFIG_DIR) {
    effectiveSubpath = undefined;
  } else if (effectiveSubpath?.endsWith(`/${CONFIG_DIR}`)) {
    effectiveSubpath = effectiveSubpath.slice(0, -(CONFIG_DIR.length + 1));
  }

  // Clone the repository to a temp directory
  let tempDir: string | undefined;
  try {
    tempDir = await cloneToTemp(repoUrl, effectiveBranch);
  } catch (error) {
    if (error instanceof GitCloneError && error.isAuthError) {
      try {
        tempDir = await cloneGitHubWithGhToTemp(owner, repo, effectiveBranch);
      } catch {
        // Keep the original Git authentication error below.
      }
    }
    if (!tempDir && error instanceof GitCloneError) {
      if (error.isAuthError) {
        return {
          success: false,
          error: `Authentication failed for ${owner}/${repo}.\n  Check your Git credentials, SSH keys, or GitHub CLI login.`,
        };
      }
      if (error.isTimeout) {
        return {
          success: false,
          error: `Clone timed out for ${owner}/${repo}.\n  Check your network connection.`,
        };
      }
    }
    if (!tempDir) {
      return {
        success: false,
        error: `Failed to access repository: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  if (!tempDir) throw new Error('GitHub checkout was not created');

  // Determine the base path to look for workspace.yaml
  const basePath = effectiveSubpath || '';

  // Try to find workspace.yaml in order of preference:
  // 1. {basePath}/.allagents/workspace.yaml
  // 2. {basePath}/workspace.yaml
  const pathsToTry = basePath
    ? [
        `${basePath}/${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE}`,
        `${basePath}/${WORKSPACE_CONFIG_FILE}`,
      ]
    : [`${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE}`, WORKSPACE_CONFIG_FILE];

  for (const filePath of pathsToTry) {
    const content = readFileFromClone(tempDir, filePath);
    if (content) {
      const result: FetchWorkspaceResult = { success: true, content, tempDir };
      if (basePath) result.resolvedSubpath = basePath;
      if (effectiveBranch) result.resolvedBranch = effectiveBranch;
      return result;
    }
  }

  // No workspace.yaml at the requested path. Report nested templates.
  let availableTemplates: string[] = [];
  try {
    const scanRoot = basePath ? join(tempDir, basePath) : tempDir;
    availableTemplates = (await findWorkspaceTemplatesInDirectory(scanRoot))
      .filter(Boolean)
      .map((path) => (basePath ? `${basePath}/${path}` : path));
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      await cleanupTempDir(tempDir);
      throw error;
    }
  }
  if (availableTemplates.length === 0) {
    await cleanupTempDir(tempDir);
  }

  return {
    success: false,
    error: `No workspace.yaml found in: ${owner}/${repo}${effectiveBranch ? `@${effectiveBranch}` : ''}${effectiveSubpath ? `/${effectiveSubpath}` : ''}\n  Expected at: ${pathsToTry.join(' or ')}`,
    ...(availableTemplates.length > 0 && { availableTemplates, tempDir }),
    ...(effectiveBranch && { resolvedBranch: effectiveBranch }),
  };
}
