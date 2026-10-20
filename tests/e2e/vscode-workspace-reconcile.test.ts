import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as load } from 'yaml';
import { syncWorkspace } from '../../src/core/sync.js';
import type { WorkspaceConfig } from '../../src/models/workspace-config.js';

describe('vscode workspace folder reconciliation e2e', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `allagents-e2e-reconcile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(join(testDir, '.allagents'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('removes repo from workspace.yaml when folder removed from .code-workspace', async () => {
    const repoBPath = '../repoB';

    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      `repositories:
  - path: ../repoA
  - path: ../repoB
plugins: []
clients:
  - vscode
`,
    );

    // First sync: generates .code-workspace and saves state
    await syncWorkspace(testDir);

    const workspaceFile = join(testDir, `${basename(testDir)}.code-workspace`);
    expect(existsSync(workspaceFile)).toBe(true);

    // Verify both repos are in .code-workspace
    const initialContent = JSON.parse(readFileSync(workspaceFile, 'utf-8'));
    expect(initialContent.folders).toHaveLength(3); // '.', repoA, repoB

    // Modify .code-workspace: remove repoB folder
    const modifiedContent = {
      ...initialContent,
      folders: initialContent.folders.filter(
        (f: { path: string }) => f.path !== repoBPath,
      ),
    };
    writeFileSync(workspaceFile, JSON.stringify(modifiedContent, null, '\t'));

    // Second sync: should reconcile and update workspace.yaml
    const result = await syncWorkspace(testDir);

    // Verify workspace.yaml was updated to remove repoB
    const updatedYaml = load(
      readFileSync(join(testDir, '.allagents', 'workspace.yaml'), 'utf-8'),
    ) as WorkspaceConfig;
    const repoPaths = updatedYaml.repositories.map((r) => r.path);
    expect(repoPaths).toContain('../repoA');
    expect(repoPaths).not.toContain('../repoB');

    // Verify sync result messages mention the removal
    expect(result.messages).toBeDefined();
    expect(result.messages!.some((m) => m.includes('removed') || m.includes('Removed'))).toBe(true);
  });

  test('adds repo to workspace.yaml when folder added to .code-workspace', async () => {
    const frontendPath = resolve(testDir, '../frontend').replace(/\\/g, '/');

    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      `repositories:
  - path: ../myrepo
plugins: []
clients:
  - vscode
`,
    );

    // First sync: generates .code-workspace and saves state
    await syncWorkspace(testDir);

    const workspaceFile = join(testDir, `${basename(testDir)}.code-workspace`);
    expect(existsSync(workspaceFile)).toBe(true);

    // Modify .code-workspace: add a new folder
    const initialContent = JSON.parse(readFileSync(workspaceFile, 'utf-8'));
    initialContent.folders.push({ path: frontendPath });
    writeFileSync(workspaceFile, JSON.stringify(initialContent, null, '\t'));

    // Second sync: should reconcile and add to workspace.yaml
    const result = await syncWorkspace(testDir);

    // Verify workspace.yaml now includes the new repo
    const updatedYaml = load(
      readFileSync(join(testDir, '.allagents', 'workspace.yaml'), 'utf-8'),
    ) as WorkspaceConfig;
    const repoPaths = updatedYaml.repositories.map((r) => r.path);
    expect(repoPaths).toContain('../myrepo');
    expect(repoPaths.some((p) => p.includes('frontend'))).toBe(true);

    // Verify sync result messages mention the addition
    expect(result.messages).toBeDefined();
    expect(result.messages!.some((m) => m.includes('added') || m.includes('Added'))).toBe(true);
  });

  test('skips reconciliation on first sync (no stored state)', async () => {
    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      `repositories:
  - path: ../myrepo
plugins: []
clients:
  - vscode
`,
    );

    // First sync: no prior state, should not reconcile
    const result = await syncWorkspace(testDir);

    // workspace.yaml should be unchanged
    const yaml = load(
      readFileSync(join(testDir, '.allagents', 'workspace.yaml'), 'utf-8'),
    ) as WorkspaceConfig;
    expect(yaml.repositories).toHaveLength(1);
    expect(yaml.repositories[0].path).toBe('../myrepo');

    // No reconciliation messages expected
    const reconcileMessages = (result.messages ?? []).filter(
      (m) => m.includes('removed') || m.includes('added') || m.includes('Removed') || m.includes('Added'),
    );
    expect(reconcileMessages).toHaveLength(0);
  });

  test('skips reconciliation when .code-workspace unchanged', async () => {
    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      `repositories:
  - path: ../myrepo
plugins: []
clients:
  - vscode
`,
    );

    // First sync
    await syncWorkspace(testDir);

    // Second sync without modifying .code-workspace
    const result = await syncWorkspace(testDir);

    // workspace.yaml should be unchanged
    const yaml = load(
      readFileSync(join(testDir, '.allagents', 'workspace.yaml'), 'utf-8'),
    ) as WorkspaceConfig;
    expect(yaml.repositories).toHaveLength(1);
    expect(yaml.repositories[0].path).toBe('../myrepo');

    // No reconciliation messages expected
    const reconcileMessages = (result.messages ?? []).filter(
      (m) => m.includes('removed') || m.includes('added') || m.includes('Removed') || m.includes('Added'),
    );
    expect(reconcileMessages).toHaveLength(0);
  });
});
