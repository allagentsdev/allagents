import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Repository, ManagedMode } from '../models/workspace-config.js';
import { getHomeDir } from '../constants.js';
import { createGit } from './git.js';

const CLONE_TIMEOUT_MS = 120_000; // 2 minutes for full clone

export interface ManagedRepoResult {
  path: string;
  repo: string;
  action: 'cloned' | 'pulled' | 'skipped';
  error?: string;
}

/**
 * Expand ~ to home directory in a path.
 */
export function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return p.replace('~', getHomeDir());
  }
  return p;
}

/**
 * Should this repository be cloned if missing?
 */
export function shouldClone(managed: ManagedMode | undefined): boolean {
  if (managed === undefined || managed === false) return false;
  return true; // true, 'clone', 'sync' all clone if missing
}

/**
 * Should this repository be pulled on sync?
 */
export function shouldPull(managed: ManagedMode | undefined): boolean {
  if (managed === true || managed === 'sync') return true;
  return false;
}

/**
 * Validate that a repo identifier looks safe (no shell/git argument injection).
 * Allows alphanumeric, hyphens, underscores, dots, and forward slashes.
 */
export function isValidRepo(repo: string): boolean {
  return /^[\w.\-/]+$/.test(repo);
}

/**
 * Build a clone URL from source platform and owner/repo.
 */
export function buildCloneUrl(source: string, repo: string): string {
  if (!isValidRepo(repo)) {
    throw new Error(`Invalid repo identifier: ${repo}`);
  }
  switch (source) {
    case 'github':
      return `https://github.com/${repo}.git`;
    case 'gitlab':
      return `https://gitlab.com/${repo}.git`;
    case 'bitbucket':
      return `https://bitbucket.org/${repo}.git`;
    case 'azure-devops': {
      // repo format: org/project/repo
      const parts = repo.split('/');
      if (parts.length === 3) {
        return `https://dev.azure.com/${parts[0]}/${parts[1]}/_git/${parts[2]}`;
      }
      return `https://dev.azure.com/${repo}`;
    }
    default:
      return `https://${source}/${repo}.git`;
  }
}

/**
 * Clone a repository to the specified path.
 */
async function cloneRepo(url: string, dest: string, ref?: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  const git = createGit(undefined, CLONE_TIMEOUT_MS);
  // Git accepts a branch or a tag here; a tag leaves the checkout detached.
  const cloneOptions = ref ? ['--branch', ref] : [];
  await git.clone(url, dest, cloneOptions);
}

/**
 * Pull latest changes in an existing repository.
 * Returns a skip reason if pull is unsafe, or undefined on success.
 */
async function pullRepo(repoPath: string, ref?: string): Promise<string | undefined> {
  const git = createGit(repoPath, CLONE_TIMEOUT_MS);

  // Check for uncommitted changes
  const status = await git.status();
  if (!status.isClean()) {
    return 'uncommitted changes';
  }

  // If ref is specified, check we're on it. A tag checkout is detached, which
  // simple-git reports as 'HEAD', so a tag ref never matches here and pull is
  // skipped rather than run against the wrong revision.
  if (ref) {
    const currentRef = status.current;
    if (currentRef !== ref) {
      return `on ref '${currentRef}', expected '${ref}'`;
    }
  }

  await git.pull();
  return undefined;
}

/**
 * Process all managed repositories: clone missing ones and pull updates.
 * Runs before plugin sync so newly cloned repos are available for skill discovery.
 */
export async function processManagedRepos(
  repositories: Repository[],
  workspacePath: string,
  options: { offline?: boolean; skipManaged?: boolean; dryRun?: boolean } = {},
): Promise<ManagedRepoResult[]> {
  if (options.skipManaged || options.offline || options.dryRun) return [];

  const managed = repositories.filter((r) => r.managed);
  if (managed.length === 0) return [];

  const results: ManagedRepoResult[] = [];

  for (const repo of managed) {
    if (!repo.source || !repo.repo) {
      results.push({
        path: repo.path,
        repo: repo.repo ?? repo.path,
        action: 'skipped',
        error: 'managed requires both source and repo fields',
      });
      continue;
    }

    const expandedPath = expandHome(repo.path);
    const absolutePath = resolve(workspacePath, expandedPath);

    if (!existsSync(absolutePath)) {
      // Clone
      if (!shouldClone(repo.managed)) {
        results.push({ path: repo.path, repo: repo.repo, action: 'skipped' });
        continue;
      }

      try {
        const url = buildCloneUrl(repo.source, repo.repo);
        await cloneRepo(url, absolutePath, repo.ref);
        results.push({ path: repo.path, repo: repo.repo, action: 'cloned' });
      } catch (error) {
        results.push({
          path: repo.path,
          repo: repo.repo,
          action: 'skipped',
          error: `clone failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    } else if (shouldPull(repo.managed)) {
      // Pull
      try {
        const skipReason = await pullRepo(absolutePath, repo.ref);
        if (skipReason) {
          results.push({
            path: repo.path,
            repo: repo.repo,
            action: 'skipped',
            error: `pull skipped: ${skipReason}`,
          });
        } else {
          results.push({ path: repo.path, repo: repo.repo, action: 'pulled' });
        }
      } catch (error) {
        results.push({
          path: repo.path,
          repo: repo.repo,
          action: 'skipped',
          error: `pull failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    } else {
      // managed: 'clone' and path exists — nothing to do
      results.push({ path: repo.path, repo: repo.repo, action: 'skipped' });
    }
  }

  return results;
}
