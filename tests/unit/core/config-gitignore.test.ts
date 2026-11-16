import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureConfigGitignore } from '../../../src/core/config-gitignore.js';

describe('ensureConfigGitignore', () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), 'allagents-gitignore-'));
    await mkdir(join(workspacePath, '.allagents'), { recursive: true });
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  it('ignores machine-local sync state and synchronized MCP configuration', async () => {
    await ensureConfigGitignore(workspacePath);

    const content = await readFile(join(workspacePath, '.allagents', '.gitignore'), 'utf-8');
    expect(content).toBe('sync-state.json\nmcp.json\n');
  });

  it('is idempotent — does not duplicate entries', async () => {
    await ensureConfigGitignore(workspacePath);
    await ensureConfigGitignore(workspacePath);

    const content = await readFile(join(workspacePath, '.allagents', '.gitignore'), 'utf-8');
    expect(content).toBe('sync-state.json\nmcp.json\n');
  });

  it('preserves existing user entries and appends missing ones', async () => {
    const gitignorePath = join(workspacePath, '.allagents', '.gitignore');
    await writeFile(gitignorePath, 'my-custom-file.txt\n', 'utf-8');

    await ensureConfigGitignore(workspacePath);

    const content = await readFile(gitignorePath, 'utf-8');
    expect(content).toBe('my-custom-file.txt\nsync-state.json\nmcp.json\n');
  });

  it('does not append when entry already present in user-managed file', async () => {
    const gitignorePath = join(workspacePath, '.allagents', '.gitignore');
    await writeFile(gitignorePath, 'sync-state.json\nmcp.json\nother-stuff\n', 'utf-8');

    await ensureConfigGitignore(workspacePath);

    const content = await readFile(gitignorePath, 'utf-8');
    expect(content).toBe('sync-state.json\nmcp.json\nother-stuff\n');
  });
});
