import {
  CLONE_TIMEOUT_MS,
  createGit,
  createGitEnv,
} from './git-client.js';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  checkRepositoryHealth as checkRepositoryHealthFact,
  resolveRemoteRevision as resolveRemoteRevisionFact,
  type GitFactClient,
  type GitFactDependencies,
  type RemoteRevisionFailureReason,
  type RemoteRevisionResult,
  type RepositoryHealthExpectation,
  type RepositoryHealthReason,
  type RepositoryHealthResult,
} from './git-facts.js';
import { GitCloneError, classifyError } from './git-errors.js';

export { createGit, createGitEnv, GitCloneError, classifyError };
export type {
  GitFactClient,
  GitFactDependencies,
  RemoteRevisionFailureReason,
  RemoteRevisionResult,
  RepositoryHealthExpectation,
  RepositoryHealthReason,
  RepositoryHealthResult,
};

/**
 * Build an HTTPS GitHub URL from owner/repo.
 */
export function gitHubUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

const execFileAsync = promisify(execFile);

/** List authenticated GitHub branch refs matching the first path component. */
export async function listGitHubBranchesWithGh(
  owner: string,
  repo: string,
  prefix: string,
): Promise<string[]> {
  const { stdout } = await execFileAsync(
    'gh',
    [
      'api',
      '--paginate',
      `repos/${owner}/${repo}/git/matching-refs/heads/${encodeURIComponent(prefix)}`,
      '--jq',
      '.[].ref',
    ],
    {
      env: createGitEnv(),
      timeout: CLONE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  return stdout
    .split('\n')
    .filter((line) => line.startsWith('refs/heads/'))
    .map((line) => line.slice('refs/heads/'.length));
}

/** Clone a GitHub repository using the user's GitHub CLI authentication. */
export async function cloneGitHubWithGhToTemp(
  owner: string,
  repo: string,
  ref?: string,
): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'allagents-'));
  const url = gitHubUrl(owner, repo);
  try {
    await execFileAsync(
      'gh',
      [
        'repo', 'clone', `${owner}/${repo}`, tempDir, '--', '--depth', '1',
        ...(ref ? ['--branch', ref] : []),
      ],
      { env: createGitEnv(), timeout: CLONE_TIMEOUT_MS },
    );
    return tempDir;
  } catch (error) {
    await cleanupTempDir(tempDir).catch(() => {});
    throw classifyError(error, url, CLONE_TIMEOUT_MS);
  }
}

/**
 * Shallow-clone a repository to an auto-created temp directory.
 * Caller must call `cleanupTempDir()` when done.
 */
export async function cloneToTemp(
  url: string,
  ref?: string,
): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), 'allagents-'));
  const git = createGit();
  const cloneOptions = ref
    ? ['--depth', '1', '--branch', ref]
    : ['--depth', '1'];

  try {
    await git.clone(url, tempDir, cloneOptions);
    return tempDir;
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw classifyError(error, url, CLONE_TIMEOUT_MS);
  }
}

/**
 * Clone a repository to a specific persistent path (plugin cache, marketplace dir).
 */
export async function cloneTo(
  url: string,
  dest: string,
  ref?: string,
): Promise<void> {
  const git = createGit();
  const cloneOptions = ref
    ? ['--depth', '1', '--branch', ref]
    : ['--depth', '1'];

  try {
    await git.clone(url, dest, cloneOptions);
  } catch (error) {
    throw classifyError(error, url, CLONE_TIMEOUT_MS);
  }
}

/**
 * Pull latest changes in an existing repository.
 */
export async function pull(repoPath: string): Promise<void> {
  const git = createGit(repoPath);
  await git.pull();
}

/**
 * Check if a remote repository is accessible via git ls-remote.
 * Returns true if accessible, false otherwise.
 */
export async function repoExists(url: string): Promise<boolean> {
  const git = createGit();
  try {
    await git.listRemote([url]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a specific ref (branch/tag) exists on the remote.
 */
export async function refExists(
  url: string,
  ref: string,
): Promise<boolean> {
  const git = createGit();
  try {
    const result = await git.listRemote([
      '--refs',
      url,
      ref,
    ]);
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Resolve one advertised remote ref without fetching or mutating a checkout.
 * Ambiguous and unverifiable inputs stay unresolved so callers can fall back.
 */
export async function resolveRemoteRevision(
  source: string,
  requestedRef?: string,
  dependencies: GitFactDependencies = {},
): Promise<RemoteRevisionResult> {
  return resolveRemoteRevisionFact(source, requestedRef, {
    createGit: dependencies.createGit ?? createGit,
    cloneTimeoutMs: CLONE_TIMEOUT_MS,
    classifyError,
  });
}

/**
 * Inspect reusable checkout facts using read-only Git commands.
 * Domain-specific files and roots remain the caller's responsibility.
 */
export async function checkRepositoryHealth(
  repoPath: string,
  expected: RepositoryHealthExpectation,
  dependencies: GitFactDependencies = {},
): Promise<RepositoryHealthResult> {
  return checkRepositoryHealthFact(repoPath, expected, {
    createGit: dependencies.createGit ?? createGit,
  });
}

/**
 * Safe cleanup of a temp directory. Validates path is under os.tmpdir()
 * to prevent accidental deletion of arbitrary paths.
 */
export async function cleanupTempDir(dir: string): Promise<void> {
  const normalizedDir = normalize(resolve(dir));
  const normalizedTmpDir = normalize(resolve(tmpdir()));

  if (
    !normalizedDir.startsWith(normalizedTmpDir + sep) &&
    normalizedDir !== normalizedTmpDir
  ) {
    throw new Error(
      'Attempted to clean up directory outside of temp directory',
    );
  }

  await rm(dir, { recursive: true, force: true });
}
