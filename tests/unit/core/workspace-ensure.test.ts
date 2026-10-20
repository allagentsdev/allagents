import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as load } from 'yaml';
import { ensureWorkspace } from '../../../src/core/workspace-modify.js';
import type { WorkspaceConfig } from '../../../src/models/workspace-config.js';

describe('ensureWorkspace with clients param', () => {
  let testDir: string;
  const configPath = () => join(testDir, '.allagents', 'workspace.yaml');

  beforeEach(() => {
    testDir = join(tmpdir(), `allagents-test-ensure-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('uses provided clients when given', async () => {
    await ensureWorkspace(testDir, ['claude', 'copilot']);
    const config = load(readFileSync(configPath(), 'utf-8')) as WorkspaceConfig;
    expect(config.clients).toEqual(['claude', 'copilot']);
  });

  it('defaults to universal when no clients provided', async () => {
    await ensureWorkspace(testDir);
    const config = load(readFileSync(configPath(), 'utf-8')) as WorkspaceConfig;
    expect(config.clients).toEqual(['universal']);
  });

  it('does not overwrite existing workspace', async () => {
    mkdirSync(join(testDir, '.allagents'), { recursive: true });
    writeFileSync(configPath(), 'repositories: []\nplugins: []\nclients:\n  - cursor\n');

    await ensureWorkspace(testDir, ['claude']);
    const config = load(readFileSync(configPath(), 'utf-8')) as WorkspaceConfig;
    expect(config.clients).toEqual(['cursor']);
  });
});
