import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { join, resolve, sep } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { getHomeDir } from '../../../src/constants.js';

// Mock the git module for verifyGitHubUrlExists tests
const repoExistsMock = mock(() => Promise.resolve(true));
const cloneToTempMock = mock(() => Promise.resolve(''));
const cleanupTempDirMock = mock(() => Promise.resolve());

mock.module('../../../src/core/git.js', () => ({
  repoExists: repoExistsMock,
  cloneToTemp: cloneToTempMock,
  cleanupTempDir: cleanupTempDirMock,
  gitHubUrl: (owner: string, repo: string) => `https://github.com/${owner}/${repo}.git`,
  GitCloneError: class GitCloneError extends Error {
    url: string;
    isTimeout: boolean;
    isAuthError: boolean;
    constructor(message: string, url: string, isTimeout = false, isAuthError = false) {
      super(message);
      this.name = 'GitCloneError';
      this.url = url;
      this.isTimeout = isTimeout;
      this.isAuthError = isAuthError;
    }
  },
}));

const {
  isGitHubUrl,
  parseGitHubUrl,
  normalizePluginPath,
  parsePluginSource,
  getPluginCachePath,
  validatePluginSource,
  verifyGitHubUrlExists,
  formatPluginSource,
  getPluginDisplayName,
  isFilesystemRoot,
} = await import('../../../src/utils/plugin-path.js');

describe('isGitHubUrl', () => {
  it('should detect standard GitHub HTTPS URLs', () => {
    expect(isGitHubUrl('https://github.com/owner/repo')).toBe(true);
    expect(isGitHubUrl('https://www.github.com/owner/repo')).toBe(true);
    expect(isGitHubUrl('http://github.com/owner/repo')).toBe(true);
  });

  it('should detect GitHub URLs without protocol', () => {
    expect(isGitHubUrl('github.com/owner/repo')).toBe(true);
  });

  it('should detect gh: prefix URLs', () => {
    expect(isGitHubUrl('gh:owner/repo')).toBe(true);
  });

  it('should detect shorthand owner/repo format', () => {
    expect(isGitHubUrl('anthropics/claude-plugins-official')).toBe(true);
    expect(isGitHubUrl('owner/repo')).toBe(true);
  });

  it('should detect shorthand owner/repo/subpath format', () => {
    expect(isGitHubUrl('anthropics/claude-plugins-official/plugins/code-review')).toBe(true);
    expect(isGitHubUrl('owner/repo/deep/nested/path')).toBe(true);
  });

  it('should detect repo names with dots', () => {
    expect(isGitHubUrl('WiseTechGlobal/WTG.AI.Prompts')).toBe(true);
    expect(isGitHubUrl('WiseTechGlobal/WTG.AI.Prompts/plugins/cargowise')).toBe(true);
  });

  it('should reject non-GitHub URLs', () => {
    expect(isGitHubUrl('https://gitlab.com/owner/repo')).toBe(false);
    expect(isGitHubUrl('git@github.com:owner/repo.git')).toBe(false);
    expect(isGitHubUrl('ssh://git@github.com/owner/repo.git')).toBe(false);
    expect(isGitHubUrl('/local/path')).toBe(false);
    expect(isGitHubUrl('./relative/path')).toBe(false);
    expect(isGitHubUrl('../relative/path')).toBe(false);
    expect(isGitHubUrl('not-a-url')).toBe(false);
    expect(isGitHubUrl('C:/windows/path')).toBe(false);
  });
});

describe('parseGitHubUrl', () => {
  it('should parse standard GitHub URLs', () => {
    const result = parseGitHubUrl('https://github.com/allagentsdev/allagents');
    expect(result).toEqual({ owner: 'allagentsdev', repo: 'allagents' });
  });

  it('should parse URLs with .git extension', () => {
    const result = parseGitHubUrl('https://github.com/owner/repo.git');
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('should parse gh: prefix URLs', () => {
    const result = parseGitHubUrl('gh:owner/repo');
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('should parse github.com URLs without protocol', () => {
    const result = parseGitHubUrl('github.com/owner/repo');
    expect(result).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('should parse URLs with tree/branch paths', () => {
    const result = parseGitHubUrl(
      'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/code-review'
    );
    expect(result).toEqual({
      owner: 'anthropics',
      repo: 'claude-plugins-official',
      branch: 'main',
      subpath: 'plugins/code-review',
    });
  });

  it('should parse shorthand owner/repo format', () => {
    const result = parseGitHubUrl('anthropics/claude-plugins-official');
    expect(result).toEqual({ owner: 'anthropics', repo: 'claude-plugins-official' });
  });

  it('should parse shorthand owner/repo/subpath format', () => {
    const result = parseGitHubUrl('anthropics/claude-plugins-official/plugins/code-review');
    expect(result).toEqual({
      owner: 'anthropics',
      repo: 'claude-plugins-official',
      subpath: 'plugins/code-review',
    });
  });

  it('should parse repo names with dots', () => {
    const result = parseGitHubUrl('WiseTechGlobal/WTG.AI.Prompts');
    expect(result).toEqual({ owner: 'WiseTechGlobal', repo: 'WTG.AI.Prompts' });
  });

  it('should parse repo names with dots and subpath', () => {
    const result = parseGitHubUrl('WiseTechGlobal/WTG.AI.Prompts/plugins/cargowise');
    expect(result).toEqual({
      owner: 'WiseTechGlobal',
      repo: 'WTG.AI.Prompts',
      subpath: 'plugins/cargowise',
    });
  });

  it('should parse URLs with tree/branch but no subpath', () => {
    const result = parseGitHubUrl(
      'https://github.com/anthropics/python-sdk/tree/develop'
    );
    expect(result).toEqual({
      owner: 'anthropics',
      repo: 'python-sdk',
      branch: 'develop',
    });
  });

  it('should parse URLs with tree/branch and subpath', () => {
    const result = parseGitHubUrl(
      'https://github.com/anthropics/python-sdk/tree/develop/examples/tools'
    );
    expect(result).toEqual({
      owner: 'anthropics',
      repo: 'python-sdk',
      branch: 'develop',
      subpath: 'examples/tools',
    });
  });

  it('should decode URL-encoded slashes in tree subpaths', () => {
    const result = parseGitHubUrl(
      'https://github.com/gastownhall/beads/tree/main/plugins%2Fbeads',
    );
    expect(result).toEqual({
      owner: 'gastownhall',
      repo: 'beads',
      branch: 'main',
      subpath: 'plugins/beads',
    });
  });

  it('should parse URLs with /blob/ the same as /tree/', () => {
    const result = parseGitHubUrl(
      'https://github.com/WiseTechGlobal/WTG.AI.Prompts/blob/main/scripts/allagents-setup/cargowise'
    );
    expect(result).toEqual({
      owner: 'WiseTechGlobal',
      repo: 'WTG.AI.Prompts',
      branch: 'main',
      subpath: 'scripts/allagents-setup/cargowise',
    });
  });

  it('should return null for invalid URLs', () => {
    expect(parseGitHubUrl('https://gitlab.com/owner/repo')).toBeNull();
    expect(parseGitHubUrl('not-a-url')).toBeNull();
    expect(parseGitHubUrl('')).toBeNull();
  });

  it('should parse shorthand owner/repo@ref selectors', () => {
    expect(parseGitHubUrl('owner/repo@v1.2.0')).toEqual({
      owner: 'owner',
      repo: 'repo',
      branch: 'v1.2.0',
    });
  });

  it('should parse owner/repo@ref/subpath with both ref and subpath', () => {
    expect(parseGitHubUrl('owner/repo@main/plugins/foo')).toEqual({
      owner: 'owner',
      repo: 'repo',
      branch: 'main',
      subpath: 'plugins/foo',
    });
  });
});

describe('isGitHubUrl with inline @ref', () => {
  it('accepts owner/repo@ref shorthand', () => {
    expect(isGitHubUrl('owner/repo@v1.2.0')).toBe(true);
  });

  it('still rejects plugin@marketplace (no slash before @)', () => {
    expect(isGitHubUrl('plugin@marketplace')).toBe(false);
  });
});

describe('normalizePluginPath', () => {
  it('should leave GitHub URLs unchanged', () => {
    const url = 'https://github.com/owner/repo';
    expect(normalizePluginPath(url)).toBe(url);
  });


  it('should leave absolute paths unchanged', () => {
    const path = '/absolute/path/to/plugin';
    expect(normalizePluginPath(path)).toBe(path);
  });

  it('should convert relative paths to absolute', () => {
    const baseDir = resolve('/base/dir');
    const result = normalizePluginPath('./relative/path', baseDir);
    expect(result).toBe(join(baseDir, 'relative', 'path'));
  });

  it('should handle parent directory references', () => {
    const baseDir = resolve('/base/dir');
    const result = normalizePluginPath('../parent/path', baseDir);
    expect(result).toBe(resolve(baseDir, '..', 'parent', 'path'));
  });

  it('should use current directory as default base', () => {
    const result = normalizePluginPath('./test');
    expect(result).toContain(`${sep}test`);
    expect(result).toMatch(/^([A-Z]:\\|\/)/); // Windows drive or Unix root
  });
});

describe('parsePluginSource', () => {
  it('should parse GitHub sources', () => {
    const result = parsePluginSource('https://github.com/owner/repo');
    expect(result.type).toBe('github');
    expect(result.owner).toBe('owner');
    expect(result.repo).toBe('repo');
    expect(result.branch).toBeUndefined();
    expect(result.original).toBe('https://github.com/owner/repo');
  });

  it('should preserve branch from /blob/ URLs so the cache lookup is branch-qualified', () => {
    const result = parsePluginSource(
      'https://github.com/owner/repo/blob/main/skills/research/llm-wiki',
    );
    expect(result.type).toBe('github');
    expect(result.owner).toBe('owner');
    expect(result.repo).toBe('repo');
    expect(result.branch).toBe('main');
  });

  it('should preserve branch from owner/repo@ref shorthand', () => {
    const result = parsePluginSource('owner/repo@v1.2.0');
    expect(result.type).toBe('github');
    expect(result.owner).toBe('owner');
    expect(result.repo).toBe('repo');
    expect(result.branch).toBe('v1.2.0');
  });


  it('should parse local absolute paths', () => {
    const result = parsePluginSource('/absolute/path');
    expect(result.type).toBe('local');
    expect(result.normalized).toBe('/absolute/path');
    expect(result.owner).toBeUndefined();
    expect(result.repo).toBeUndefined();
  });

  it('should parse local relative paths', () => {
    const baseDir = resolve('/base');
    const result = parsePluginSource('./relative/path', baseDir);
    expect(result.type).toBe('local');
    expect(result.normalized).toBe(join(baseDir, 'relative', 'path'));
    expect(result.original).toBe('./relative/path');
  });
});

describe('getPluginCachePath', () => {
  it('should generate cache path with owner and repo', () => {
    const result = getPluginCachePath('allagentsdev', 'allagents');
    const expectedPath = join('.allagents', 'plugins', 'marketplaces', 'allagentsdev-allagents');
    expect(result).toContain(expectedPath);
  });

  it('should use home directory', () => {
    const result = getPluginCachePath('owner', 'repo');
    const homeDir = resolve(getHomeDir());
    expect(result.startsWith(homeDir)).toBe(true);
  });
});

describe('validatePluginSource', () => {
  it('should accept valid GitHub URLs', () => {
    const result = validatePluginSource('https://github.com/owner/repo');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should accept valid local paths', () => {
    const result = validatePluginSource('/local/path');
    expect(result.valid).toBe(true);
  });

  it('should reject empty sources', () => {
    const result = validatePluginSource('');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('cannot be empty');
  });

  it('should reject whitespace-only sources', () => {
    const result = validatePluginSource('   ');
    expect(result.valid).toBe(false);
  });

  it('should reject invalid GitHub URLs', () => {
    const result = validatePluginSource('gh:invalid');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid GitHub URL');
  });
});

describe('isFilesystemRoot', () => {
  it('treats a bare path separator as a filesystem root', () => {
    expect(isFilesystemRoot(sep)).toBe(true);
  });

  it('treats the resolved root path itself as a filesystem root', () => {
    const root = resolve('.').split(sep)[0] + sep;
    expect(isFilesystemRoot(root)).toBe(true);
  });

  it('does not treat a normal plugin directory as a filesystem root', () => {
    expect(isFilesystemRoot(join(tmpdir(), 'some-plugin'))).toBe(false);
  });

  it('does not treat a relative path to a subdirectory as a filesystem root', () => {
    expect(isFilesystemRoot('./some-plugin')).toBe(false);
  });
});

describe('formatPluginSource', () => {
  it('shortens a bare GitHub HTTPS URL to owner/repo', () => {
    expect(formatPluginSource('https://github.com/anthropics/claude-plugins-official')).toBe(
      'anthropics/claude-plugins-official',
    );
  });

  it('strips /blob/main and /tree/main while preserving subpath', () => {
    expect(formatPluginSource('https://github.com/NousResearch/hermes-agent/blob/main/skills/research/llm-wiki')).toBe(
      'NousResearch/hermes-agent/skills/research/llm-wiki',
    );
    expect(formatPluginSource('https://github.com/owner/repo/tree/master/plugins/foo')).toBe(
      'owner/repo/plugins/foo',
    );
  });

  it('keeps non-default branches with @<branch>/subpath', () => {
    expect(formatPluginSource('https://github.com/owner/repo/blob/develop/skills/foo')).toBe(
      'owner/repo@develop/skills/foo',
    );
  });

  it('shortens gh: prefix to owner/repo', () => {
    expect(formatPluginSource('gh:anthropics/claude-plugins-official')).toBe(
      'anthropics/claude-plugins-official',
    );
  });

  it('passes owner/repo shorthand through unchanged', () => {
    expect(formatPluginSource('NousResearch/hermes-agent')).toBe('NousResearch/hermes-agent');
  });

  it('preserves @ref on shorthand sources', () => {
    expect(formatPluginSource('owner/repo@v1.2.0/sub')).toBe('owner/repo@v1.2.0/sub');
  });

  it('leaves plugin@marketplace specs untouched', () => {
    expect(formatPluginSource('superpowers@official')).toBe('superpowers@official');
  });

  it('leaves local paths untouched', () => {
    expect(formatPluginSource('./local-plugin')).toBe('./local-plugin');
    expect(formatPluginSource('/abs/path/to/plugin')).toBe('/abs/path/to/plugin');
  });

  it('passes empty input through', () => {
    expect(formatPluginSource('')).toBe('');
  });
});

describe('getPluginDisplayName', () => {
  it('uses npm package names without losing scoped identities', () => {
    expect(getPluginDisplayName('npm:pi-compound-engineering@3.19.2')).toBe('pi-compound-engineering');
    expect(getPluginDisplayName('npm:pi-tools')).toBe('pi-tools');
    expect(getPluginDisplayName('npm:@acme/pi-tools@1.2.3')).toBe('@acme/pi-tools');
    expect(getPluginDisplayName('npm:@acme/pi-tools')).toBe('@acme/pi-tools');
  });

  it('keeps explicit Git package transport and ref visible', () => {
    expect(getPluginDisplayName('git:github.com/acme/pi-tools@v1')).toBe('git:github.com/acme/pi-tools@v1');
  });

  it('keeps marketplace specs unchanged', () => {
    expect(getPluginDisplayName('superpowers@official')).toBe(
      'superpowers@official',
    );
    expect(getPluginDisplayName('demo@acme/official')).toBe(
      'demo@acme/official',
    );
    expect(getPluginDisplayName('demo@acme/official/plugins')).toBe(
      'demo@acme/official/plugins',
    );
  });

  it('uses the final segment for a GitHub subpath', () => {
    expect(
      getPluginDisplayName(
        'https://github.com/acme/toolbox/tree/main/plugins/research',
      ),
    ).toBe('research');
    expect(getPluginDisplayName('acme/toolbox/plugins/review')).toBe('review');
  });

  it('uses the repository name for a GitHub repository root', () => {
    expect(getPluginDisplayName('https://github.com/acme/toolbox')).toBe(
      'toolbox',
    );
    expect(getPluginDisplayName('acme/toolbox')).toBe('toolbox');
  });

  it('uses the basename for a local path', () => {
    expect(getPluginDisplayName('./plugins/local-tool')).toBe('local-tool');
    expect(getPluginDisplayName('/opt/plugins/absolute-tool')).toBe(
      'absolute-tool',
    );
  });
});

describe('verifyGitHubUrlExists', () => {
  beforeEach(() => {
    repoExistsMock.mockClear();
    cloneToTempMock.mockClear();
    cleanupTempDirMock.mockClear();
  });

  it('should return exists=true for valid repo', async () => {
    repoExistsMock.mockResolvedValueOnce(true);

    const result = await verifyGitHubUrlExists('owner/repo');
    expect(result.exists).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('should return exists=true for valid repo with subpath', async () => {
    repoExistsMock.mockResolvedValueOnce(true);

    // Create temp dir with the subpath
    const tempDir = join(tmpdir(), `test-verify-${Date.now()}`);
    mkdirSync(join(tempDir, 'plugins', 'myplugin'), { recursive: true });
    cloneToTempMock.mockResolvedValueOnce(tempDir);

    const result = await verifyGitHubUrlExists('owner/repo/plugins/myplugin');
    expect(result.exists).toBe(true);
    expect(result.error).toBeUndefined();

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return error for invalid URL format', async () => {
    const result = await verifyGitHubUrlExists('invalid');
    expect(result.exists).toBe(false);
    expect(result.error).toContain('Invalid GitHub URL format');
  });

  it('should return error when repository not found', async () => {
    repoExistsMock.mockResolvedValueOnce(false);

    const result = await verifyGitHubUrlExists('owner/nonexistent-repo');
    expect(result.exists).toBe(false);
    expect(result.error).toContain('not found or not accessible');
  });

  it('should return error when path not found in repo', async () => {
    repoExistsMock.mockResolvedValueOnce(true);

    // Create temp dir WITHOUT the subpath
    const tempDir = join(tmpdir(), `test-verify-nopath-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    cloneToTempMock.mockResolvedValueOnce(tempDir);

    const result = await verifyGitHubUrlExists('owner/repo/nonexistent/path');
    expect(result.exists).toBe(false);
    expect(result.error).toContain('Path not found in repository');

    rmSync(tempDir, { recursive: true, force: true });
  });
});
