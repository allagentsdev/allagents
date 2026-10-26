import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  checkRepositoryHealth,
  resolveRemoteRevision,
} from '../../../src/core/git-facts.js';
import { createGitEnv } from '../../../src/core/git-client.js';

const gitPolicyProbe = join(import.meta.dir, '..', '..', 'helpers', 'git-client-policy.ts');

describe('createGitEnv', () => {
  const originalHome = process.env.HOME;
  const originalPath = process.env.PATH;
  const originalPrompt = process.env.GIT_TERMINAL_PROMPT;
  const originalSkipSmudge = process.env.GIT_LFS_SKIP_SMUDGE;

  beforeEach(() => {
    process.env.HOME = '/tmp/test-home';
    process.env.PATH = '/tmp/test-path';
    process.env.GIT_TERMINAL_PROMPT = '1';
    process.env.GIT_LFS_SKIP_SMUDGE = '0';
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    process.env.PATH = originalPath;
    process.env.GIT_TERMINAL_PROMPT = originalPrompt;
    process.env.GIT_LFS_SKIP_SMUDGE = originalSkipSmudge;
  });

  it('preserves inherited git environment while applying allagents overrides', () => {
    const gitEnv = createGitEnv();

    expect(gitEnv).toMatchObject({
      HOME: '/tmp/test-home',
      PATH: '/tmp/test-path',
      GIT_TERMINAL_PROMPT: '0',
      GIT_LFS_SKIP_SMUDGE: '1',
    });
  });
});

describe('createGit', () => {
  let repoPath: string;

  beforeEach(() => {
    repoPath = mkdtempSync(join(tmpdir(), 'allagents-git-client-'));
    execFileSync('git', ['init', repoPath], {
      env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined },
      stdio: 'ignore',
    });
  });

  afterEach(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  it('accepts an inherited credential helper configuration', () => {
    const result = Bun.spawnSync([process.execPath, gitPolicyProbe, repoPath], {
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'credential.helper',
        GIT_CONFIG_VALUE_0: 'store',
      },
      stderr: 'pipe',
    });

    expect(result.exitCode).toBe(0);
  });

  it('rejects an inherited protocol override', () => {
    const result = Bun.spawnSync([process.execPath, gitPolicyProbe, repoPath], {
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'protocol.file.allow',
        GIT_CONFIG_VALUE_0: 'always',
      },
      stderr: 'pipe',
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain(
      'not permitted without enabling allowUnsafeProtocolOverride',
    );
  });
});

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function gitFacts(listRemoteOutput: string | Error) {
  const listRemote = mock(async (_args: string[]) => {
    if (listRemoteOutput instanceof Error) throw listRemoteOutput;
    return listRemoteOutput;
  });
  const raw = mock(async (_args: string[]) => '');
  const classifyError = mock((error: unknown, source: string) => {
    const message = error instanceof Error ? error.message : String(error);
    return Object.assign(new Error(`Classified Git failure: ${message}`), {
      name: 'GitCloneError',
      url: source,
      isTimeout: false,
      isAuthError: message.includes('Permission denied'),
    });
  });
  return {
    dependencies: {
      createGit: () => ({ listRemote, raw }),
      cloneTimeoutMs: 300_000,
      classifyError,
    },
    listRemote,
    raw,
    classifyError,
  };
}

describe('resolveRemoteRevision', () => {
  it('resolves default HEAD to its symbolic branch and advertised commit', async () => {
    const facts = gitFacts(
      `ref: refs/heads/main\tHEAD\n${SHA_A}\tHEAD\n`,
    );

    await expect(
      resolveRemoteRevision('https://github.com/acme/tools.git', undefined, facts.dependencies),
    ).resolves.toEqual({
      status: 'resolved',
      commit: SHA_A,
      ref: 'main',
    });
    expect(facts.listRemote).toHaveBeenCalledWith([
      '--symref',
      'https://github.com/acme/tools.git',
      'HEAD',
    ]);
  });

  it('resolves an explicit branch', async () => {
    const facts = gitFacts(`${SHA_A}\trefs/heads/main\n`);

    await expect(
      resolveRemoteRevision('https://github.com/acme/tools', 'refs/heads/main', facts.dependencies),
    ).resolves.toEqual({
      status: 'resolved',
      commit: SHA_A,
      ref: 'refs/heads/main',
    });
  });

  it('preserves qualified branch and tag namespaces', async () => {
    const qualifiedTag = gitFacts(`${SHA_A}\trefs/heads/release\n`);
    const qualifiedBranch = gitFacts(`${SHA_A}\trefs/tags/release\n`);

    await expect(
      resolveRemoteRevision(
        'https://github.com/acme/tools',
        'refs/tags/release',
        qualifiedTag.dependencies,
      ),
    ).resolves.toEqual({
      status: 'unresolved',
      reason: 'not-advertised',
    });
    expect(qualifiedTag.listRemote).toHaveBeenCalledWith([
      'https://github.com/acme/tools',
      'refs/tags/release',
      'refs/tags/release^{}',
    ]);

    await expect(
      resolveRemoteRevision(
        'https://github.com/acme/tools',
        'refs/heads/release',
        qualifiedBranch.dependencies,
      ),
    ).resolves.toEqual({
      status: 'unresolved',
      reason: 'not-advertised',
    });
    expect(qualifiedBranch.listRemote).toHaveBeenCalledWith([
      'https://github.com/acme/tools',
      'refs/heads/release',
    ]);
  });

  it('resolves lightweight and peeled annotated tags to commit objects', async () => {
    const lightweight = gitFacts(`${SHA_A}\trefs/tags/v1\n`);
    const annotated = gitFacts(
      `${SHA_B}\trefs/tags/v2\n${SHA_A}\trefs/tags/v2^{}\n`,
    );

    await expect(
      resolveRemoteRevision('https://github.com/acme/tools', 'v1', lightweight.dependencies),
    ).resolves.toEqual({
      status: 'resolved',
      commit: SHA_A,
      ref: 'v1',
    });
    await expect(
      resolveRemoteRevision('https://github.com/acme/tools', 'v2', annotated.dependencies),
    ).resolves.toEqual({
      status: 'resolved',
      commit: SHA_A,
      ref: 'v2',
    });
  });

  it('returns unresolved for branch/tag collisions and malformed advertisements', async () => {
    const collision = gitFacts(
      `${SHA_A}\trefs/heads/release\n${SHA_B}\trefs/tags/release\n`,
    );
    const malformed = gitFacts(`not-a-sha\trefs/heads/main\n`);

    await expect(
      resolveRemoteRevision('https://github.com/acme/tools', 'release', collision.dependencies),
    ).resolves.toEqual({
      status: 'unresolved',
      reason: 'ambiguous',
    });
    await expect(
      resolveRemoteRevision('https://github.com/acme/tools', 'main', malformed.dependencies),
    ).resolves.toEqual({
      status: 'unresolved',
      reason: 'malformed',
    });
  });

  it('does not guess that an unadvertised immutable pin resolves', async () => {
    const facts = gitFacts(`${SHA_B}\trefs/heads/main\n`);

    await expect(
      resolveRemoteRevision('https://github.com/acme/tools', SHA_A, facts.dependencies),
    ).resolves.toEqual({
      status: 'unresolved',
      reason: 'not-advertised',
    });
  });

  it('preserves classified authentication and transport failure details', async () => {
    const authError = new Error('Permission denied (publickey)');
    const transportError = new Error('connection reset by peer');
    const auth = gitFacts(authError);
    const transport = gitFacts(transportError);

    const authResult = await resolveRemoteRevision(
      'git@github.com:acme/private.git',
      'main',
      auth.dependencies,
    );
    const transportResult = await resolveRemoteRevision(
      'https://github.com/acme/tools',
      'main',
      transport.dependencies,
    );

    expect(authResult.status).toBe('unresolved');
    expect(authResult.reason).toBe('failed');
    expect(authResult.error).toMatchObject({
      name: 'GitCloneError',
      isAuthError: true,
    });
    expect(auth.classifyError).toHaveBeenCalledWith(
      authError,
      'git@github.com:acme/private.git',
      300_000,
    );
    expect(transportResult.status).toBe('unresolved');
    expect(transportResult.reason).toBe('failed');
    expect(transportResult.error?.message).toContain('connection reset by peer');
    expect(transport.classifyError).toHaveBeenCalledWith(
      transportError,
      'https://github.com/acme/tools',
      300_000,
    );
  });
});

function repositoryFacts(
  overrides: Partial<Record<string, string | Error>> = {},
) {
  const calls: string[][] = [];
  const values: Record<string, string | Error> = {
    'rev-parse --is-inside-work-tree': 'true\n',
    'config --get-all remote.origin.url': 'git@github.com:Acme/Tools.git\n',
    'rev-parse HEAD': `${SHA_A}\n`,
    'symbolic-ref --quiet --short HEAD': 'main\n',
    'status --porcelain --untracked-files=all': '',
    ...overrides,
  };
  const raw = mock(async (args: string[]) => {
    calls.push(args);
    const value = values[args.join(' ')];
    if (value instanceof Error) throw value;
    return value ?? '';
  });
  return {
    dependencies: {
      createGit: () => ({
        raw,
        listRemote: async () => '',
      }),
    },
    calls,
  };
}

const expectedCheckout = {
  source: 'https://github.com/acme/tools',
  ref: 'refs/heads/main',
  head: SHA_A,
};

describe('checkRepositoryHealth', () => {
  it('accepts a detached tag with empty symbolic-ref output but rejects an explicit branch there', async () => {
    const facts = repositoryFacts({
      'symbolic-ref --quiet --short HEAD': '',
      'rev-parse --verify refs/tags/v1^{commit}': `${SHA_A}\n`,
    });
    await expect(checkRepositoryHealth('/cache/tools', {
      ...expectedCheckout, ref: 'v1',
    }, facts.dependencies)).resolves.toMatchObject({ status: 'healthy', head: SHA_A, ref: 'v1' });
    await expect(checkRepositoryHealth('/cache/tools', expectedCheckout, facts.dependencies))
      .resolves.toMatchObject({ status: 'unhealthy', reason: 'ref-mismatch' });
  });

  it('accepts only the canonical origin, expected ref and HEAD, and a clean tree without mutation', async () => {
    const facts = repositoryFacts();

    await expect(
      checkRepositoryHealth('/cache/tools', expectedCheckout, facts.dependencies),
    ).resolves.toEqual({
      status: 'healthy',
      head: SHA_A,
      ref: 'main',
    });
    expect(facts.calls).toEqual([
      ['rev-parse', '--is-inside-work-tree'],
      ['config', '--get-all', 'remote.origin.url'],
      ['rev-parse', 'HEAD'],
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      ['status', '--porcelain', '--untracked-files=all'],
    ]);
  });

  it('rejects tracked or untracked dirtiness', async () => {
    const facts = repositoryFacts({
      'status --porcelain --untracked-files=all': '?? scratch.txt\n',
    });

    await expect(
      checkRepositoryHealth('/cache/tools', expectedCheckout, facts.dependencies),
    ).resolves.toMatchObject({
      status: 'unhealthy',
      reason: 'dirty',
    });
  });

  it('rejects wrong origin, ref, and HEAD identities', async () => {
    const wrongOrigin = repositoryFacts({
      'config --get-all remote.origin.url': 'https://github.com/acme/other\n',
    });
    const wrongRef = repositoryFacts({
      'symbolic-ref --quiet --short HEAD': 'next\n',
    });
    const wrongHead = repositoryFacts({
      'rev-parse HEAD': `${SHA_B}\n`,
    });

    await expect(
      checkRepositoryHealth('/cache/tools', expectedCheckout, wrongOrigin.dependencies),
    ).resolves.toMatchObject({ status: 'unhealthy', reason: 'origin-mismatch' });
    await expect(
      checkRepositoryHealth('/cache/tools', expectedCheckout, wrongRef.dependencies),
    ).resolves.toMatchObject({ status: 'unhealthy', reason: 'ref-mismatch' });
    await expect(
      checkRepositoryHealth('/cache/tools', expectedCheckout, wrongHead.dependencies),
    ).resolves.toMatchObject({ status: 'unhealthy', reason: 'head-mismatch' });
  });

  it('returns unhealthy for a missing or unreadable Git checkout', async () => {
    const facts = repositoryFacts({
      'rev-parse --is-inside-work-tree': new Error('not a git repository'),
    });

    await expect(
      checkRepositoryHealth('/cache/tools', expectedCheckout, facts.dependencies),
    ).resolves.toMatchObject({
      status: 'unhealthy',
      reason: 'not-repository',
    });
  });
});
