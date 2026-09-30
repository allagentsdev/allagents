import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { GitCloneError } from '../../../src/core/git.js';

// Create a temp dir with workspace files for testing
function createTempRepo(files: Record<string, string>): string {
  const dir = join(tmpdir(), `test-github-fetch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = join(dir, filePath);
    mkdirSync(join(fullPath, '..'), { recursive: true });
    writeFileSync(fullPath, content, 'utf-8');
  }
  return dir;
}

// Mock the git module
const cloneToTempMock = mock(() => Promise.resolve(''));
const cloneGitHubWithGhToTempMock = mock(() => Promise.resolve(''));
const listGitHubBranchesWithGhMock = mock(() => Promise.resolve([] as string[]));
const cleanupTempDirMock = mock(() => Promise.resolve());
const refExistsMock = mock(() => Promise.resolve(false));

mock.module('../../../src/core/git.js', () => ({
  cloneToTemp: cloneToTempMock,
  cloneGitHubWithGhToTemp: cloneGitHubWithGhToTempMock,
  listGitHubBranchesWithGh: listGitHubBranchesWithGhMock,
  cleanupTempDir: cleanupTempDirMock,
  gitHubUrl: (owner: string, repo: string) => `https://github.com/${owner}/${repo}.git`,
  refExists: refExistsMock,
  GitCloneError,
}));

const { fetchWorkspaceFromGitHub } = await import('../../../src/core/github-fetch.js');

beforeEach(() => {
  cloneToTempMock.mockClear();
  cloneGitHubWithGhToTempMock.mockClear();
  listGitHubBranchesWithGhMock.mockClear();
  cleanupTempDirMock.mockClear();
  refExistsMock.mockClear();
});

describe('fetchWorkspaceFromGitHub', () => {
  it('should validate GitHub URL format', async () => {
    const result = await fetchWorkspaceFromGitHub('not-a-github-url');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid GitHub URL');
  });

  it('should handle clone auth errors', async () => {
    cloneToTempMock.mockRejectedValueOnce(
      new GitCloneError('Authentication failed', 'https://github.com/owner/repo.git', false, true),
    );
    cloneGitHubWithGhToTempMock.mockRejectedValueOnce(new Error('GitHub CLI unavailable'));

    const result = await fetchWorkspaceFromGitHub('https://github.com/owner/repo');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Authentication failed');
  });

  it('uses GitHub CLI credentials when Git authentication fails', async () => {
    const tempDir = createTempRepo({
      'scripts/allagents-setup/aim/.allagents/workspace.yaml': 'clients: []',
    });
    cloneToTempMock.mockRejectedValueOnce(
      new GitCloneError('Authentication failed', 'https://github.com/owner/repo.git', false, true),
    );
    cloneGitHubWithGhToTempMock.mockResolvedValueOnce(tempDir);

    const result = await fetchWorkspaceFromGitHub('owner/repo');

    expect(result.availableTemplates).toEqual(['scripts/allagents-setup/aim']);
    expect(cloneGitHubWithGhToTempMock).toHaveBeenCalledWith('owner', 'repo', undefined);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('resolves a private slash-containing branch with GitHub CLI credentials', async () => {
    const tempDir = createTempRepo({
      'templates/aim/.allagents/workspace.yaml': 'clients: []',
    });
    listGitHubBranchesWithGhMock.mockResolvedValueOnce(['feat', 'feat/aim']);
    cloneToTempMock.mockRejectedValueOnce(
      new GitCloneError('Authentication failed', 'https://github.com/owner/repo.git', false, true),
    );
    cloneGitHubWithGhToTempMock.mockResolvedValueOnce(tempDir);

    const result = await fetchWorkspaceFromGitHub('https://github.com/owner/repo/tree/feat/aim/templates/aim');

    expect(result.success).toBe(true);
    expect(result.resolvedBranch).toBe('feat/aim');
    expect(result.resolvedSubpath).toBe('templates/aim');
    expect(cloneGitHubWithGhToTempMock).toHaveBeenCalledWith('owner', 'repo', 'feat/aim');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reports a missing workspace for an existing file subpath', async () => {
    const tempDir = createTempRepo({ 'README.md': '# Example' });
    cloneToTempMock.mockResolvedValueOnce(tempDir);

    const result = await fetchWorkspaceFromGitHub('owner/repo/README.md');

    expect(result.success).toBe(false);
    expect(result.error).toContain('No workspace.yaml found');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should handle clone timeout errors', async () => {
    cloneToTempMock.mockRejectedValueOnce(
      new GitCloneError('Clone timed out', 'https://github.com/owner/repo.git', true, false),
    );

    const result = await fetchWorkspaceFromGitHub('https://github.com/owner/repo');
    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  it('should fetch workspace.yaml from .allagents directory', async () => {
    const yamlContent = 'plugins:\n  - code-review@official';
    const tempDir = createTempRepo({
      '.allagents/workspace.yaml': yamlContent,
    });

    cloneToTempMock.mockResolvedValueOnce(tempDir);

    const result = await fetchWorkspaceFromGitHub('https://github.com/owner/repo');
    expect(result.success).toBe(true);
    expect(result.content).toBe(yamlContent);
    expect(result.tempDir).toBe(tempDir);

    // Clean up
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should fallback to root workspace.yaml if .allagents not found', async () => {
    const yamlContent = 'plugins:\n  - my-plugin@marketplace';
    const tempDir = createTempRepo({
      'workspace.yaml': yamlContent,
    });

    cloneToTempMock.mockResolvedValueOnce(tempDir);

    const result = await fetchWorkspaceFromGitHub('https://github.com/owner/repo');
    expect(result.success).toBe(true);
    expect(result.content).toBe(yamlContent);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should handle subpath in GitHub URL', async () => {
    const yamlContent = 'clients:\n  - claude';
    const tempDir = createTempRepo({
      'templates/nodejs/.allagents/workspace.yaml': yamlContent,
    });

    cloneToTempMock.mockResolvedValueOnce(tempDir);

    const result = await fetchWorkspaceFromGitHub(
      'https://github.com/owner/repo/tree/main/templates/nodejs',
    );
    expect(result.success).toBe(true);
    expect(result.content).toBe(yamlContent);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should parse different GitHub URL formats', async () => {
    const urls = [
      'https://github.com/owner/repo',
      'github.com/owner/repo',
      'gh:owner/repo',
      'owner/repo',
    ];

    for (const url of urls) {
      cloneToTempMock.mockClear();
      cleanupTempDirMock.mockClear();

      const yamlContent = 'plugins: []';
      const tempDir = createTempRepo({
        '.allagents/workspace.yaml': yamlContent,
      });

      cloneToTempMock.mockResolvedValueOnce(tempDir);

      const result = await fetchWorkspaceFromGitHub(url);
      expect(result.success).toBe(true);
      expect(result.content).toBe(yamlContent);

      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should return error when no workspace.yaml found', async () => {
    const tempDir = createTempRepo({});

    cloneToTempMock.mockResolvedValueOnce(tempDir);

    const result = await fetchWorkspaceFromGitHub('https://github.com/owner/repo');
    expect(result.success).toBe(false);
    expect(result.error).toContain('No workspace.yaml found');

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('finds nested workspace templates when the source has no workspace.yaml', async () => {
    const tempDir = createTempRepo({
      'scripts/allagents-setup/aim/.allagents/workspace.yaml': 'clients: []',
      'scripts/allagents-setup/neo/.allagents/workspace.yaml': 'clients: []',
      'evals/neo/.workspace-template/.allagents/workspace.yaml': 'clients: []',
    });
    cloneToTempMock.mockResolvedValueOnce(tempDir);

    const result = await fetchWorkspaceFromGitHub('owner/repo');

    expect(result.success).toBe(false);
    expect(result.availableTemplates).toEqual([
      'evals/neo/.workspace-template',
      'scripts/allagents-setup/aim',
      'scripts/allagents-setup/neo',
    ]);
    expect(result.tempDir).toBe(tempDir);
    expect(cleanupTempDirMock).not.toHaveBeenCalled();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('limits discovery to the supplied repository subpath', async () => {
    const tempDir = createTempRepo({
      'scripts/allagents-setup/aim/.allagents/workspace.yaml': 'clients: []',
      'evals/neo/.workspace-template/.allagents/workspace.yaml': 'clients: []',
    });
    cloneToTempMock.mockResolvedValueOnce(tempDir);

    const result = await fetchWorkspaceFromGitHub(
      'https://github.com/owner/repo/tree/main/scripts/allagents-setup',
    );

    expect(result.availableTemplates).toEqual(['scripts/allagents-setup/aim']);
    expect(result.resolvedBranch).toBe('main');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should handle URL pointing directly to .allagents folder', async () => {
    const yamlContent = 'clients:\n  - claude';
    const tempDir = createTempRepo({
      'templates/nodejs/.allagents/workspace.yaml': yamlContent,
    });

    // resolveBranchAndSubpath tries longest branch first:
    // "main/templates/nodejs" (false), "main/templates" (false), "main" (true)
    refExistsMock.mockResolvedValueOnce(false);
    refExistsMock.mockResolvedValueOnce(false);
    refExistsMock.mockResolvedValueOnce(true);
    cloneToTempMock.mockResolvedValueOnce(tempDir);

    const result = await fetchWorkspaceFromGitHub(
      'https://github.com/owner/repo/tree/main/templates/nodejs/.allagents',
    );
    expect(result.success).toBe(true);
    expect(result.content).toBe(yamlContent);

    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should handle URL pointing to .allagents at repo root', async () => {
    const yamlContent = 'plugins:\n  - test@marketplace';
    const tempDir = createTempRepo({
      '.allagents/workspace.yaml': yamlContent,
    });

    cloneToTempMock.mockResolvedValueOnce(tempDir);

    const result = await fetchWorkspaceFromGitHub(
      'https://github.com/owner/repo/tree/main/.allagents',
    );
    expect(result.success).toBe(true);
    expect(result.content).toBe(yamlContent);

    rmSync(tempDir, { recursive: true, force: true });
  });
});
