import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as load } from 'yaml';
import { initWorkspace } from '../../../src/core/workspace.js';
import type { WorkspaceConfig } from '../../../src/models/workspace-config.js';

describe('initWorkspace with force option', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `allagents-test-init-force-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should overwrite existing workspace.yaml when force is true', async () => {
    // Create an existing workspace.yaml
    const configDir = join(testDir, '.allagents');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'workspace.yaml'),
      'clients:\n  - cursor\nplugins: []\nrepositories: []\n',
    );

    // Init with force should succeed and overwrite
    await initWorkspace(testDir, { force: true, clients: ['claude'] });

    const content = readFileSync(join(configDir, 'workspace.yaml'), 'utf-8');
    const config = load(content) as WorkspaceConfig;
    expect(config.clients).toEqual(['claude']);
  });

  it('should still throw without force when workspace.yaml exists', async () => {
    const configDir = join(testDir, '.allagents');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'workspace.yaml'),
      'clients:\n  - cursor\nplugins: []\nrepositories: []\n',
    );

    await expect(initWorkspace(testDir)).rejects.toThrow('Workspace already exists');
  });
});
