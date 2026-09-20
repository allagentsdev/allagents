import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  syncWorkspace,
  deduplicateClientsByPath,
  collectSyncedPaths,
  selectivePurgeWorkspace,
} from '../../../src/core/sync.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';
import {
  CLIENT_MAPPINGS,
  USER_CLIENT_MAPPINGS,
  resolveClientMappings,
} from '../../../src/models/client-mapping.js';
import type { CopyResult } from '../../../src/core/transform.js';
import {
  clientMappingsFromContexts,
  resolveClientContexts,
} from '../../../src/core/client-context.js';
import type { SyncState } from '../../../src/models/sync-state.js';

describe('deduplicateClientsByPath', () => {
  it('groups clients that share a resolved project skill path', () => {
    const clients = ['copilot', 'vscode', 'codex'] as const;
    const resolvedMappings = resolveClientMappings([...clients], CLIENT_MAPPINGS);
    const result = deduplicateClientsByPath([...clients], resolvedMappings);

    expect(result.representativeClients).toEqual(['copilot', 'codex']);
    expect(result.clientGroups.get('copilot')).toEqual([
      'copilot',
      'vscode',
    ]);
    expect(result.clientGroups.get('codex')).toEqual(['codex']);
  });

  it('keeps provider-specific project skill paths separate', () => {
    const clients = ['claude', 'pi', 'roo'] as const;
    const result = deduplicateClientsByPath([...clients], CLIENT_MAPPINGS);

    expect(result.representativeClients).toEqual(['claude', 'pi', 'roo']);
    expect(result.clientGroups.get('claude')).toEqual(['claude']);
    expect(result.clientGroups.get('pi')).toEqual(['pi']);
    expect(result.clientGroups.get('roo')).toEqual(['roo']);
  });

  it('handles mixed provider-specific and shared project paths', () => {
    const clients = ['claude', 'copilot', 'vscode', 'codex'] as const;
    const resolvedMappings = resolveClientMappings([...clients], CLIENT_MAPPINGS);
    const result = deduplicateClientsByPath([...clients], resolvedMappings);

    expect(result.representativeClients).toEqual([
      'claude',
      'copilot',
      'codex',
    ]);
    expect(result.clientGroups.get('copilot')).toEqual([
      'copilot',
      'vscode',
    ]);
  });

  it('uses distinct declared user destinations', () => {
    const clients = ['copilot', 'codex', 'opencode'] as const;
    const result = deduplicateClientsByPath([...clients], USER_CLIENT_MAPPINGS);

    expect(result.representativeClients).toEqual([
      'copilot',
      'codex',
      'opencode',
    ]);
  });

  it('handles empty and single-client inputs', () => {
    expect(
      deduplicateClientsByPath([], CLIENT_MAPPINGS).representativeClients,
    ).toEqual([]);
    expect(
      deduplicateClientsByPath(['claude'], CLIENT_MAPPINGS)
        .representativeClients,
    ).toEqual(['claude']);
  });

  it('keeps Pi and OMP materialization distinct from shared discovery paths', () => {
    const clients = ['pi', 'omp', 'universal'] as const;
    const result = deduplicateClientsByPath([...clients], CLIENT_MAPPINGS);

    expect(result.representativeClients).toEqual([
      'pi',
      'omp',
      'universal',
    ]);
  });

  it('chooses universal when a shared-path client is declared first', () => {
    const result = deduplicateClientsByPath(
      ['warp', 'universal'],
      CLIENT_MAPPINGS,
    );

    expect(result.representativeClients).toEqual(['universal']);
    expect(result.clientGroups.get('universal')).toEqual([
      'warp',
      'universal',
    ]);
  });
});

describe('collectSyncedPaths with shared paths', () => {
  it('tracks one shared skill for every client using its destination', () => {
    const copyResults: CopyResult[] = [
      {
        source: '/some/plugin/skills/my-skill',
        destination: '/workspace/.github/skills/my-skill',
        action: 'copied',
      },
    ];
    const clients = ['copilot', 'vscode'] as const;
    const resolvedMappings = resolveClientMappings([...clients], CLIENT_MAPPINGS);
    const result = collectSyncedPaths(
      copyResults,
      '/workspace',
      [...clients],
      resolvedMappings,
    );

    for (const client of clients) {
      expect(result[client]).toContain('.github/skills/my-skill/');
    }
  });

  it('tracks provider-specific and shared destinations independently', () => {
    const copyResults: CopyResult[] = [
      {
        source: '/some/plugin/skills/skill1',
        destination: '/workspace/.claude/skills/skill1',
        action: 'copied',
      },
      {
        source: '/some/plugin/skills/skill2',
        destination: '/workspace/.github/skills/skill2',
        action: 'copied',
      },
    ];
    const result = collectSyncedPaths(
      copyResults,
      '/workspace',
      ['claude', 'copilot'],
      CLIENT_MAPPINGS,
    );

    expect(result.claude).toEqual(['.claude/skills/skill1/']);
    expect(result.copilot).toEqual(['.github/skills/skill2/']);
  });
});

describe('external resolved path state and purge containment', () => {
  it('tracks an external Pi root as an absolute path without traversal', () => {
    const contexts = resolveClientContexts(['pi'], 'user', {
      homeDir: '/home/tester',
      cwd: '/work/project',
      env: { PI_CODING_AGENT_DIR: '/external/pi' },
    });
    const mappings = clientMappingsFromContexts(
      contexts,
      USER_CLIENT_MAPPINGS,
    );
    const destination = '/external/pi/skills/example';

    const result = collectSyncedPaths(
      [{ source: '/plugin/skills/example', destination, action: 'copied' }],
      '/home/tester',
      ['pi'],
      mappings,
      undefined,
      contexts,
    );

    expect(result.pi).toEqual(['/external/pi/skills/example/']);
    expect(result.pi?.[0]).not.toContain('../');
  });

  it('purges only tracked paths inside the resolved external write root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allagents-purge-boundary-'));
    const homeDir = join(root, 'home');
    const externalRoot = join(root, 'selected-pi');
    const managedSkill = join(externalRoot, 'skills', 'managed');
    const outsideSkill = join(root, 'outside', 'tampered');
    await mkdir(managedSkill, { recursive: true });
    await mkdir(outsideSkill, { recursive: true });
    await writeFile(join(managedSkill, 'SKILL.md'), 'managed');
    await writeFile(join(outsideSkill, 'SKILL.md'), 'outside');

    try {
      const contexts = resolveClientContexts(['pi'], 'user', {
        homeDir,
        cwd: root,
        env: { PI_CODING_AGENT_DIR: externalRoot },
      });
      const mappings = clientMappingsFromContexts(
        contexts,
        USER_CLIENT_MAPPINGS,
      );
      const managedStatePath = `${managedSkill.replaceAll('\\', '/')}/`;
      const outsideStatePath = `${outsideSkill.replaceAll('\\', '/')}/`;
      const state = {
        version: 1,
        lastSync: new Date().toISOString(),
        files: { pi: [managedStatePath, outsideStatePath] },
      } as SyncState;

      const result = await selectivePurgeWorkspace(
        homeDir,
        state,
        ['pi'],
        mappings,
        contexts,
      );

      expect(existsSync(managedSkill)).toBe(false);
      expect(existsSync(outsideSkill)).toBe(true);
      expect(result).toEqual([
        { client: 'pi', paths: [managedStatePath] },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('syncWorkspace deduplication', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-sync-dedup-test-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  /**
   * Helper to create a plugin with a skill
   */
  async function createPluginWithSkill(name: string, skillName: string): Promise<string> {
    const pluginDir = join(testDir, name);
    const skillDir = join(pluginDir, 'skills', skillName);
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---
name: ${skillName}
description: A test skill
---

# ${skillName}`,
    );
    return pluginDir;
  }

  it('should copy a shared .github skill only once', async () => {
    const pluginDir = await createPluginWithSkill('my-plugin', 'test-skill');

    // Copilot and VS Code share Copilot's project skill destination.
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - copilot
  - vscode
`,
    );

    const result = await syncWorkspace(testDir);

    expect(result.success).toBe(true);
    // Should only copy once (not 2 times)
    expect(result.totalCopied).toBe(1);

    // Skill should exist in the shared destination.
    expect(existsSync(join(testDir, '.github', 'skills', 'test-skill', 'SKILL.md'))).toBe(true);

    // Verify sync state tracks the skill for both clients
    const statePath = join(testDir, CONFIG_DIR, 'sync-state.json');
    const state = JSON.parse(await readFile(statePath, 'utf-8'));

    expect(state.files.copilot).toContain('.github/skills/test-skill/');
    expect(state.files.vscode).toContain('.github/skills/test-skill/');
  });

  it('should copy skill to different paths for clients with unique skillsPaths', async () => {
    const pluginDir = await createPluginWithSkill('my-plugin', 'test-skill');

    // Setup workspace config with clients that have different skillsPaths
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - claude
  - pi
  - roo
`,
    );

    const result = await syncWorkspace(testDir);

    expect(result.success).toBe(true);
    // Should copy 3 times (one for each unique path)
    expect(result.totalCopied).toBe(3);

    // Skills should exist in each client's directory
    expect(existsSync(join(testDir, '.claude', 'skills', 'test-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(testDir, '.pi', 'skills', 'test-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(testDir, '.roo', 'skills', 'test-skill', 'SKILL.md'))).toBe(true);
  });

  it('materializes Pi native and universal shared skills exactly once each', async () => {
    const pluginDir = await createPluginWithSkill('my-plugin', 'test-skill');
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - pi
  - universal
syncMode: copy
`,
    );

    const result = await syncWorkspace(testDir);

    expect(result.success).toBe(true);
    expect(result.totalCopied).toBe(2);
    expect(
      existsSync(join(testDir, '.pi', 'skills', 'test-skill', 'SKILL.md')),
    ).toBe(true);
    expect(
      existsSync(join(testDir, '.agents', 'skills', 'test-skill', 'SKILL.md')),
    ).toBe(true);
  });

  it('materializes universal skills when a shared-path client comes first', async () => {
    const pluginDir = await createPluginWithSkill('my-plugin', 'test-skill');
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - warp
  - universal
`,
    );

    const result = await syncWorkspace(testDir);

    expect(result.success).toBe(true);
    expect(
      existsSync(join(testDir, '.agents', 'skills', 'test-skill', 'SKILL.md')),
    ).toBe(true);
  });

  it('should properly purge when a client sharing path is removed', async () => {
    const pluginDir = await createPluginWithSkill('my-plugin', 'test-skill');

    // First sync with Copilot and VS Code on their shared destination.
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - copilot
  - vscode
`,
    );

    const result1 = await syncWorkspace(testDir);
    expect(result1.success).toBe(true);
    expect(existsSync(join(testDir, '.github', 'skills', 'test-skill', 'SKILL.md'))).toBe(true);

    // Now remove vscode from clients
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - copilot
`,
    );

    const result2 = await syncWorkspace(testDir);
    expect(result2.success).toBe(true);

    // Skill should still exist (copilot still uses it)
    expect(existsSync(join(testDir, '.github', 'skills', 'test-skill', 'SKILL.md'))).toBe(true);

    // State should only have copilot now
    const statePath = join(testDir, CONFIG_DIR, 'sync-state.json');
    const state = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(state.files.copilot).toBeDefined();
    expect(state.files.vscode).toBeUndefined();
  });

  it('should purge shared path when all clients using it are removed', async () => {
    const pluginDir = await createPluginWithSkill('my-plugin', 'test-skill');

    // First sync with Copilot and VS Code in copy mode.
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - copilot
  - vscode
syncMode: copy
`,
    );

    await syncWorkspace(testDir);
    expect(existsSync(join(testDir, '.github', 'skills', 'test-skill'))).toBe(true);

    // Remove both clients (replace with claude)
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - claude
syncMode: copy
`,
    );

    await syncWorkspace(testDir);

    // The shared skill should be purged once no configured client owns it.
    expect(existsSync(join(testDir, '.github', 'skills', 'test-skill'))).toBe(false);

    // .claude/skills/test-skill should exist
    expect(existsSync(join(testDir, '.claude', 'skills', 'test-skill', 'SKILL.md'))).toBe(true);
  });
});

describe('syncWorkspace vscode artifact placement', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-vscode-test-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function createPluginWithSkill(name: string, skillName: string): Promise<string> {
    const pluginDir = join(testDir, name);
    const skillDir = join(pluginDir, 'skills', skillName);
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, 'SKILL.md'),
      `---\nname: ${skillName}\ndescription: A test skill\n---\n\n# ${skillName}`,
    );
    return pluginDir;
  }

  it('should place skills in .agents/ when vscode is the only client', async () => {
    const pluginDir = await createPluginWithSkill('my-plugin', 'test-skill');

    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - vscode
`,
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);
    expect(existsSync(join(testDir, '.agents', 'skills', 'test-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(testDir, '.github', 'skills', 'test-skill', 'SKILL.md'))).toBe(false);
  });

  it('should keep Copilot and VS Code skills in .github/', async () => {
    const pluginDir = await createPluginWithSkill('my-plugin', 'test-skill');

    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - copilot
  - vscode
syncMode: copy
`,
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);
    expect(existsSync(join(testDir, '.github', 'skills', 'test-skill', 'SKILL.md'))).toBe(true);
    // Should only copy once (deduped)
    expect(result.totalCopied).toBe(1);
  });

  it('should share universal content with Copilot and VS Code', async () => {
    const pluginDir = await createPluginWithSkill('my-plugin', 'test-skill');

    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - universal
  - copilot
  - vscode
`,
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);
    expect(existsSync(join(testDir, '.agents', 'skills', 'test-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(testDir, '.github', 'skills', 'test-skill', 'SKILL.md'))).toBe(true);
  });

  it('should place skills in .agents/ when universal + vscode (no copilot)', async () => {
    const pluginDir = await createPluginWithSkill('my-plugin', 'test-skill');

    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ${pluginDir}
clients:
  - universal
  - vscode
`,
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);
    expect(existsSync(join(testDir, '.agents', 'skills', 'test-skill', 'SKILL.md'))).toBe(true);
    // Should NOT create .github since no copilot
    expect(existsSync(join(testDir, '.github', 'skills'))).toBe(false);
    // Should only copy once (deduped — both map to .agents)
    expect(result.totalCopied).toBe(1);
  });
});
