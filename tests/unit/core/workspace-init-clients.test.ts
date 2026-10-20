import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { load } from 'js-yaml';
import { initWorkspace } from '../../../src/core/workspace.js';
import type { WorkspaceConfig } from '../../../src/models/workspace-config.js';

describe('initWorkspace with clients option', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `allagents-test-init-clients-${Date.now()}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should use provided clients instead of template defaults', async () => {
    await initWorkspace(testDir, { clients: ['cursor', 'gemini'] });

    const content = readFileSync(join(testDir, '.allagents', 'workspace.yaml'), 'utf-8');
    const config = load(content) as WorkspaceConfig;
    expect(config.clients).toEqual(['cursor', 'gemini']);
  });

  it('preserves local template comments while rewriting its source and overriding clients', async () => {
    const templateDir = join(testDir, 'template');
    const targetDir = join(testDir, 'project');
    mkdirSync(join(templateDir, '.allagents'), { recursive: true });
    writeFileSync(join(templateDir, '.allagents', 'workspace.yaml'), `# Team template
workspace:
  source: . # Resolve relative to this template
  files: []

# Repositories are optional
repositories: []
plugins: []

clients:
  - claude # Keep client preferences
`);

    await initWorkspace(targetDir, { from: templateDir, clients: ['claude', 'copilot'] });

    const content = readFileSync(join(targetDir, '.allagents', 'workspace.yaml'), 'utf-8');
    const config = load(content) as WorkspaceConfig;
    expect(config.workspace?.source).toBe(templateDir);
    expect(config.clients).toEqual(['claude', 'copilot']);
    expect(content).toStartWith('# Team template\n');
    expect(content).toContain('# Resolve relative to this template');
    expect(content).toContain('files: []\n\n# Repositories are optional\nrepositories: []');
    expect(content).toContain('plugins: []\n\nclients:');
    expect(content).toContain('- claude # Keep client preferences');
  });

  it('should write client entry objects with install mode to workspace.yaml', async () => {
    await initWorkspace(testDir, {
      clients: [{ name: 'claude', install: 'native' }, 'copilot'],
    });

    const content = readFileSync(join(testDir, '.allagents', 'workspace.yaml'), 'utf-8');
    const config = load(content) as WorkspaceConfig;
    expect(config.clients).toEqual([
      { name: 'claude', install: 'native' },
      'copilot',
    ]);
  });

  it('should use template default clients when no clients option provided', async () => {
    await initWorkspace(testDir);

    const content = readFileSync(join(testDir, '.allagents', 'workspace.yaml'), 'utf-8');
    const config = load(content) as WorkspaceConfig;
    // Default template has: universal
    expect(config.clients).toContain('universal');
  });
});
