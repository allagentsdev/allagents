import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `repositories[].ref` only matters if it reaches the git invocation, so these
// tests capture the clone/pull calls at the git-client boundary.
const cloneCalls: Array<{ url: string; dest: string; options: string[] }> = [];
const pullCalls: string[] = [];
let checkout = 'release-1.x';
let clean = true;

mock.module('../../../src/core/git.js', () => ({
  createGit: (baseDir?: string) => ({
    clone: mock((url: string, dest: string, options: string[] = []) => {
      cloneCalls.push({ url, dest, options });
      return Promise.resolve();
    }),
    status: mock(() =>
      Promise.resolve({ isClean: () => clean, current: checkout }),
    ),
    pull: mock(() => {
      pullCalls.push(baseDir ?? '');
      return Promise.resolve();
    }),
  }),
}));

// Static import cannot work here: the module under test must be loaded after
// `mock.module` installs the git-client stub.
const { processManagedRepos } = await import(
  '../../../src/core/managed-repos.js'
);

let root = '';

beforeEach(() => {
  cloneCalls.length = 0;
  pullCalls.length = 0;
  checkout = 'release-1.x';
  clean = true;
  root = mkdtempSync(join(tmpdir(), 'allagents-managed-ref-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('processManagedRepos ref plumbing', () => {
  it('clones with --branch set to the configured ref', async () => {
    const results = await processManagedRepos(
      [{ path: 'checkout', source: 'github', repo: 'o/r', managed: true, ref: 'release-1.x' }],
      root,
    );

    expect(cloneCalls).toHaveLength(1);
    expect(cloneCalls[0]?.options).toEqual(['--branch', 'release-1.x']);
    expect(results[0]?.action).toBe('cloned');
  });

  it('clones the default branch when no ref is configured', async () => {
    await processManagedRepos(
      [{ path: 'checkout', source: 'github', repo: 'o/r', managed: true }],
      root,
    );

    expect(cloneCalls[0]?.options).toEqual([]);
  });

  it('pulls when the checkout is on the configured ref', async () => {
    mkdirSync(join(root, 'checkout'));

    const results = await processManagedRepos(
      [{ path: 'checkout', source: 'github', repo: 'o/r', managed: true, ref: 'release-1.x' }],
      root,
    );

    expect(pullCalls).toHaveLength(1);
    expect(results[0]?.action).toBe('pulled');
  });

  it('skips the pull when a pinned ref left the checkout detached', async () => {
    mkdirSync(join(root, 'checkout'));
    checkout = 'HEAD';

    const results = await processManagedRepos(
      [{ path: 'checkout', source: 'github', repo: 'o/r', managed: true, ref: 'v1.0.0' }],
      root,
    );

    expect(pullCalls).toHaveLength(0);
    expect(results[0]?.action).toBe('skipped');
    expect(results[0]?.error).toContain("expected 'v1.0.0'");
  });
});
