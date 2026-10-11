const GITHUB_HOST = 'github.com';
const GITHUB_PART = /^[a-zA-Z0-9_.-]+$/;

export interface GitHubSourceIdentity {
  owner: string;
  repo: string;
}

function githubIdentity(
  owner: string,
  rawRepo: string,
): GitHubSourceIdentity | null {
  const repo = rawRepo.replace(/\.git$/i, '');
  if (
    owner === '.' ||
    owner === '..' ||
    repo === '.' ||
    repo === '..' ||
    !GITHUB_PART.test(owner) ||
    !GITHUB_PART.test(repo)
  ) {
    return null;
  }
  return { owner: owner.toLowerCase(), repo: repo.toLowerCase() };
}

/** Parse only transport forms known to identify a GitHub repository. */
export function parseGitHubSource(source: string): GitHubSourceIdentity | null {
  const value = source.trim().replace(/\/$/, '');

  const scp = /^git@github\.com:([^/]+)\/([^/]+)$/i.exec(value);
  if (scp?.[1] && scp[2]) return githubIdentity(scp[1], scp[2]);

  const hostPath = /^(?:www\.)?github\.com\/([^/]+)\/([^/]+)$/i.exec(value);
  if (hostPath?.[1] && hostPath[2]) {
    return githubIdentity(hostPath[1], hostPath[2]);
  }

  const shorthand = value.startsWith('gh:') ? value.slice(3) : value;
  if (
    !shorthand.startsWith('.') &&
    !shorthand.startsWith('/') &&
    !shorthand.includes('\\') &&
    !shorthand.includes('://') &&
    !shorthand.includes('@') &&
    !shorthand.includes(':')
  ) {
    const parts = shorthand.split('/');
    if (parts.length === 2) {
      const [owner, repo] = parts;
      if (owner && repo) return githubIdentity(owner, repo);
    }
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== GITHUB_HOST || url.port || url.search || url.hash) {
    return null;
  }
  const isHttps =
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.username.length === 0 &&
    url.password.length === 0;
  const isSsh =
    url.protocol === 'ssh:' &&
    url.username === 'git' &&
    url.password.length === 0;
  if (!isHttps && !isSsh) return null;

  const parts = url.pathname.replace(/^\//, '').split('/');
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo || parts.length !== 2) return null;
  return githubIdentity(owner, repo);
}

/**
 * Return a stable remote identity. Only GitHub's known equivalent shorthand,
 * HTTPS, and SSH forms are collapsed; unfamiliar remotes remain byte-distinct
 * apart from surrounding whitespace.
 */
export function canonicalizeGitSource(source: string): string {
  const github = parseGitHubSource(source);
  return github
    ? `https://${GITHUB_HOST}/${github.owner}/${github.repo}`
    : source.trim();
}

export type GitRefKind = 'branch' | 'tag';

export interface GitRefIdentity {
  name: string;
  kind?: GitRefKind;
}

/** Preserve explicit branch/tag qualification while normalizing aliases. */
export function parseGitRefIdentity(
  ref: string | undefined,
): GitRefIdentity | undefined {
  const value = ref?.trim();
  if (!value) return undefined;
  if (value.startsWith('refs/heads/')) {
    return { name: value.slice('refs/heads/'.length), kind: 'branch' };
  }
  if (value.startsWith('refs/tags/')) {
    return { name: value.slice('refs/tags/'.length), kind: 'tag' };
  }
  if (value.startsWith('refs/remotes/origin/')) {
    return {
      name: value.slice('refs/remotes/origin/'.length),
      kind: 'branch',
    };
  }
  if (value.startsWith('origin/')) {
    return { name: value.slice('origin/'.length), kind: 'branch' };
  }
  return { name: value };
}

/** Normalize caller spellings without changing ref case or path segments. */
export function normalizeGitRef(ref: string | undefined): string | undefined {
  return parseGitRefIdentity(ref)?.name;
}

/** Collision-safe key for one physical remote and requested ref. */
export function gitSourceKey(source: string, ref?: string): string {
  const identity = parseGitRefIdentity(ref);
  return JSON.stringify([
    canonicalizeGitSource(source),
    identity?.kind ?? null,
    identity?.name ?? null,
  ]);
}


/** Reject inline secrets before plugin sources reach output or persisted state. */
export function assertPluginSourceNoCredentials(source: string): void {
  // URL parsing ignores embedded tabs/newlines; inspect the same authority.
  const value = source.replace(/[\t\r\n]/g, '')
    .replace(/^[\p{Cc}\s]+|[\p{Cc}\s]+$/gu, '')
    .replace(/^git:/i, '')
    .replace(/^[\p{Cc}\s]+|[\p{Cc}\s]+$/gu, '');
  const scheme = /^(https?|ssh):/i.exec(value)?.[1]?.toLowerCase();
  if (!scheme) return;
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    // Still reject userinfo in malformed authorities without echoing input.
  }
  const authority = /^(?:https?|ssh):\/+([^/?#]*)/i.exec(value)?.[1] ?? '';
  const at = authority.lastIndexOf('@');
  const userinfo = at < 0 ? undefined : authority.slice(0, at);
  const hasCredentials = scheme === 'ssh'
    ? !!url?.password || !!userinfo?.includes(':')
    : !!url?.username || !!url?.password || userinfo !== undefined;
  if (hasCredentials) {
    throw new Error(
      'Plugin source URLs must not contain credentials. Use Git credential helpers or SSH keys/agents.',
    );
  }
}
