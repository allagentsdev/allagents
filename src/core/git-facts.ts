import type { GitCloneError } from './git-errors.js';
import {
  canonicalizeGitSource,
  normalizeGitRef,
  parseGitRefIdentity,
} from '../utils/git-source.js';


export interface GitFactClient {
  listRemote(args: string[]): Promise<string>;
  raw(args: string[]): Promise<string>;
}

export interface GitFactDependencies {
  createGit?: (baseDir?: string) => GitFactClient;
}

interface GitFactRuntimeDependencies {
  createGit: (baseDir?: string) => GitFactClient;
  cloneTimeoutMs: number;
  classifyError(
    error: unknown,
    source: string,
    timeoutMs: number,
  ): GitCloneError;
}

export type RemoteRevisionFailureReason =
  | 'ambiguous'
  | 'malformed'
  | 'not-advertised'
  | 'failed';

export type RemoteRevisionResult =
  | {
      status: 'resolved';
      commit: string;
      ref: string;
    }
  | {
      status: 'unresolved';
      reason: RemoteRevisionFailureReason;
      error?: GitCloneError;
    };

interface RemoteAdvertisement {
  value: string;
  name: string;
  symbolic: boolean;
}

function parseRemoteAdvertisement(
  output: string,
): RemoteAdvertisement[] | undefined {
  const advertisements: RemoteAdvertisement[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const symbolic = /^ref:\s+(\S+)\t(\S+)$/.exec(line);
    if (symbolic?.[1] && symbolic[2]) {
      advertisements.push({
        value: symbolic[1],
        name: symbolic[2],
        symbolic: true,
      });
      continue;
    }
    const direct = /^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})\t(\S+)$/.exec(line);
    if (!direct?.[1] || !direct[2]) return undefined;
    advertisements.push({
      value: direct[1].toLowerCase(),
      name: direct[2],
      symbolic: false,
    });
  }
  return advertisements;
}

function uniqueAdvertisementValue(
  advertisements: RemoteAdvertisement[],
  name: string,
): string | undefined | null {
  const values = new Set(
    advertisements
      .filter((entry) => !entry.symbolic && entry.name === name)
      .map((entry) => entry.value),
  );
  if (values.size > 1) return null;
  return values.values().next().value;
}

/**
 * Resolve one advertised remote ref without fetching or mutating a checkout.
 * Ambiguous and unverifiable inputs stay unresolved so callers can fall back.
 */
export async function resolveRemoteRevision(
  source: string,
  requestedRef: string | undefined,
  dependencies: GitFactRuntimeDependencies,
): Promise<RemoteRevisionResult> {
  const git = dependencies.createGit();
  const refIdentity = parseGitRefIdentity(requestedRef);
  const ref = refIdentity?.name;
  const immutablePin =
    refIdentity?.kind === undefined &&
    ref !== undefined &&
    /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(ref);
  const args = ref
    ? immutablePin
      ? [source]
      : refIdentity.kind === 'branch'
        ? [source, `refs/heads/${ref}`]
        : refIdentity.kind === 'tag'
          ? [source, `refs/tags/${ref}`, `refs/tags/${ref}^{}`]
          : [
              source,
              `refs/heads/${ref}`,
              `refs/tags/${ref}`,
              `refs/tags/${ref}^{}`,
            ]
    : ['--symref', source, 'HEAD'];

  let output: string;
  try {
    output = await git.listRemote(args);
  } catch (error) {
    return {
      status: 'unresolved',
      reason: 'failed',
      error: dependencies.classifyError(
        error,
        source,
        dependencies.cloneTimeoutMs,
      ),
    };
  }

  const advertisements = parseRemoteAdvertisement(output);
  if (!advertisements) {
    return { status: 'unresolved', reason: 'malformed' };
  }

  if (!ref) {
    const symbolicHeads = new Set(
      advertisements
        .filter(
          (entry) =>
            entry.symbolic &&
            entry.name === 'HEAD' &&
            entry.value.startsWith('refs/heads/'),
        )
        .map((entry) => entry.value.slice('refs/heads/'.length)),
    );
    const commit = uniqueAdvertisementValue(advertisements, 'HEAD');
    if (symbolicHeads.size !== 1 || commit === null) {
      return { status: 'unresolved', reason: 'ambiguous' };
    }
    const resolvedRef = symbolicHeads.values().next().value;
    if (!resolvedRef || !commit) {
      return { status: 'unresolved', reason: 'malformed' };
    }
    return { status: 'resolved', commit, ref: resolvedRef };
  }

  if (immutablePin) {
    const peeledTags = new Set(
      advertisements
        .filter((entry) => !entry.symbolic && entry.name.endsWith('^{}'))
        .map((entry) => entry.name.slice(0, -3)),
    );
    const advertisedCommits = new Set(
      advertisements
        .filter(
          (entry) =>
            !entry.symbolic &&
            (!entry.name.startsWith('refs/tags/') ||
              entry.name.endsWith('^{}') ||
              !peeledTags.has(entry.name)),
        )
        .map((entry) => entry.value),
    );
    const normalizedPin = ref.toLowerCase();
    return advertisedCommits.has(normalizedPin)
      ? { status: 'resolved', commit: normalizedPin, ref }
      : { status: 'unresolved', reason: 'not-advertised' };
  }

  const branch =
    refIdentity?.kind === 'tag'
      ? undefined
      : uniqueAdvertisementValue(advertisements, `refs/heads/${ref}`);
  const tag =
    refIdentity?.kind === 'branch'
      ? undefined
      : uniqueAdvertisementValue(advertisements, `refs/tags/${ref}`);
  const peeledTag =
    refIdentity?.kind === 'branch'
      ? undefined
      : uniqueAdvertisementValue(advertisements, `refs/tags/${ref}^{}`);
  if (
    branch === null ||
    tag === null ||
    peeledTag === null ||
    (branch && tag)
  ) {
    return { status: 'unresolved', reason: 'ambiguous' };
  }
  const commit = branch ?? peeledTag ?? tag;
  const resolvedRef =
    refIdentity?.kind === 'branch'
      ? `refs/heads/${ref}`
      : refIdentity?.kind === 'tag'
        ? `refs/tags/${ref}`
        : ref;
  return commit
    ? { status: 'resolved', commit, ref: resolvedRef }
    : { status: 'unresolved', reason: 'not-advertised' };
}

export interface RepositoryHealthExpectation {
  source: string;
  ref?: string;
  head: string;
}

export type RepositoryHealthReason =
  | 'not-repository'
  | 'origin-mismatch'
  | 'ref-mismatch'
  | 'head-mismatch'
  | 'dirty'
  | 'inspection-failed';

export type RepositoryHealthResult =
  | {
      status: 'healthy';
      head: string;
      ref?: string;
    }
  | {
      status: 'unhealthy';
      reason: RepositoryHealthReason;
      head?: string;
      ref?: string;
      error?: Error;
    };

function healthError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Inspect reusable checkout facts using read-only Git commands.
 * Domain-specific files and roots remain the caller's responsibility.
 */
export async function checkRepositoryHealth(
  repoPath: string,
  expected: RepositoryHealthExpectation,
  dependencies: Pick<GitFactRuntimeDependencies, 'createGit'>,
): Promise<RepositoryHealthResult> {
  let git: GitFactClient;
  try {
    git = dependencies.createGit(repoPath);
    const insideWorkTree = await git.raw([
      'rev-parse',
      '--is-inside-work-tree',
    ]);
    if (insideWorkTree.trim() !== 'true') {
      return { status: 'unhealthy', reason: 'not-repository' };
    }
  } catch (error) {
    return {
      status: 'unhealthy',
      reason: 'not-repository',
      error: healthError(error),
    };
  }

  try {
    // Compare all declared identities; `remote get-url` expands user insteadOf rules.
    const origins = (await git.raw(['config', '--get-all', 'remote.origin.url'])).trim().split(/\r?\n/);
    if (
      origins.some((origin) => canonicalizeGitSource(origin) !== canonicalizeGitSource(expected.source))
    ) {
      return { status: 'unhealthy', reason: 'origin-mismatch' };
    }

    const head = (await git.raw(['rev-parse', 'HEAD'])).trim().toLowerCase();
    if (head !== expected.head.trim().toLowerCase()) {
      return { status: 'unhealthy', reason: 'head-mismatch', head };
    }

    const expectedIdentity = parseGitRefIdentity(expected.ref);
    const expectedRef = expectedIdentity?.name;
    let actualRef: string | undefined;
    if (expectedRef) {
      if (expectedIdentity.kind !== 'tag') {
        try {
          actualRef = normalizeGitRef(
            await git.raw(['symbolic-ref', '--quiet', '--short', 'HEAD']),
          );
          if (actualRef && actualRef !== expectedRef) {
            return {
              status: 'unhealthy',
              reason: 'ref-mismatch',
              head,
              ...(actualRef && { ref: actualRef }),
            };
          }
        } catch {
          if (expectedIdentity.kind === 'branch') {
            return { status: 'unhealthy', reason: 'ref-mismatch', head };
          }
        }
        if (!actualRef && expectedIdentity.kind === 'branch') {
          return { status: 'unhealthy', reason: 'ref-mismatch', head };
        }
      }
      if (!actualRef) {
        let tagHead: string;
        try {
          tagHead = (
            await git.raw([
              'rev-parse',
              '--verify',
              `refs/tags/${expectedRef}^{commit}`,
            ])
          )
            .trim()
            .toLowerCase();
        } catch {
          return { status: 'unhealthy', reason: 'ref-mismatch', head };
        }
        if (tagHead !== head) {
          return { status: 'unhealthy', reason: 'ref-mismatch', head };
        }
        actualRef =
          expectedIdentity.kind === 'tag'
            ? `refs/tags/${expectedRef}`
            : expectedRef;
      }
    }

    const worktree = await git.raw([
      'status',
      '--porcelain',
      '--untracked-files=all',
    ]);
    if (worktree.trim().length > 0) {
      return {
        status: 'unhealthy',
        reason: 'dirty',
        head,
        ...(actualRef && { ref: actualRef }),
      };
    }
    return {
      status: 'healthy',
      head,
      ...(actualRef && { ref: actualRef }),
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      reason: 'inspection-failed',
      error: healthError(error),
    };
  }
}
