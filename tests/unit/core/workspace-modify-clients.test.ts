import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { load } from 'js-yaml';
import { setClients } from '../../../src/core/workspace-modify.js';
import type { WorkspaceConfig } from '../../../src/models/workspace-config.js';

describe('setClients', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `allagents-test-clients-${Date.now()}`);
    mkdirSync(join(testDir, '.allagents'), { recursive: true });
    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      'repositories: []\nplugins: []\nclients:\n  - claude\n  - copilot\n',
    );
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should replace clients list in workspace.yaml', async () => {
    const result = await setClients(['cursor', 'gemini'], testDir);
    expect(result.success).toBe(true);

    const content = readFileSync(join(testDir, '.allagents', 'workspace.yaml'), 'utf-8');
    const config = load(content) as WorkspaceConfig;
    expect(config.clients).toEqual(['cursor', 'gemini']);
  });

  it('preserves comments and section spacing when clients are reordered and removed', async () => {
    const configPath = join(testDir, '.allagents', 'workspace.yaml');
    writeFileSync(configPath, `# Shared team configuration
repositories: [] # No linked repositories

# Portable plugins
plugins: []

clients:
  - claude # Remove this client
  - copilot # Keep this client
  - cursor # Move this client first
`);

    expect((await setClients(['cursor', 'copilot'], testDir)).success).toBe(true);

    const content = readFileSync(configPath, 'utf-8');
    expect((load(content) as WorkspaceConfig).clients).toEqual(['cursor', 'copilot']);
    expect(content).toStartWith('# Shared team configuration\n');
    expect(content).toContain('repositories: [] # No linked repositories\n\n# Portable plugins\nplugins: []\n\nclients:');
    expect(content).toContain('- cursor # Move this client first');
    expect(content).toContain('- copilot # Keep this client');
    expect(content).not.toContain('Remove this client');
  });

  it('should auto-create workspace.yaml when it does not exist', async () => {
    const emptyDir = join(tmpdir(), `allagents-test-empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    const result = await setClients(['claude'], emptyDir);
    expect(result.success).toBe(true);

    const content = readFileSync(join(emptyDir, '.allagents', 'workspace.yaml'), 'utf-8');
    const config = load(content) as WorkspaceConfig;
    expect(config.clients).toEqual(['claude']);
    rmSync(emptyDir, { recursive: true, force: true });
  });

  it('rejects project profiles before changing clients', async () => {
    const configPath = join(testDir, '.allagents', 'workspace.yaml');
    const invalid =
      'repositories: []\nplugins: []\nclients:\n  - claude\nprofiles:\n  research:\n    clients:\n      - name: pi\n';
    writeFileSync(configPath, invalid);

    const result = await setClients(['omp'], testDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('profiles');
    expect(readFileSync(configPath, 'utf-8')).toBe(invalid);
  });
});
