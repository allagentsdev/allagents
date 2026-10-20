import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, load } from 'js-yaml';
import { createSkillUpdateReconciler } from '../../../src/cli/skill-update-reconciliation.js';
import type {
  CheckoutNode,
  SkillUpdateInstallation,
  SkillUpdateUnit,
} from '../../../src/core/skill-update.js';
import { executeSkillUpdatePlan } from '../../../src/core/skill-update.js';
import type { WorkspaceConfig } from '../../../src/models/workspace-config.js';

describe('createSkillUpdateReconciler', () => {
  let tmpDir: string;
  let userConfigPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'allagents-skill-reconcile-'));
    userConfigPath = join(tmpDir, 'home/.allagents/workspace.yaml');
    await mkdir(join(tmpDir, '.allagents'), { recursive: true });
    await mkdir(join(tmpDir, 'home/.allagents'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function installation(
    overrides: Partial<SkillUpdateInstallation> &
      Pick<SkillUpdateInstallation, 'id' | 'scope' | 'configIndex' | 'rawSource'>,
  ): SkillUpdateInstallation {
    return {
      effectiveSource: overrides.rawSource,
      pluginName: 'skills',
      rootNodeId: 'cache',
      rootSubpath: '',
      nodes: [],
      skills: [],
      ...overrides,
    };
  }

  function unit(
    installations: SkillUpdateInstallation[],
    deletedByInstallation: Record<
      string,
      Array<{ name: string; subpath: string; selector?: string }>
    >,
    removedInstallationIds: string[] = [],
    survivorsByInstallation: Record<
      string,
      Array<{ name: string; subpath: string; selector?: string }>
    > = {},
  ): SkillUpdateUnit {
    return {
      id: 'cache',
      nodes: [],
      installations,
      outcome: removedInstallationIds.length > 0 ? 'plugin-removed' : 'resolved',
      inspectedNodes: [],
      deleted: installations.flatMap((entry) =>
        (deletedByInstallation[entry.id] ?? []).map((skill) => ({
          ...skill,
          enabled: true,
          installationId: entry.id,
          scope: entry.scope,
          pluginName: entry.pluginName,
          source: entry.rawSource,
        })),
      ),
      survivors: installations.flatMap((entry) =>
        (survivorsByInstallation[entry.id] ?? []).map((skill) => ({
          ...skill,
          enabled: true,
          installationId: entry.id,
          scope: entry.scope,
          pluginName: entry.pluginName,
          source: entry.rawSource,
        })),
      ),
      blockedByOutOfScope: false,
      removedInstallationIds,
    };
  }

  it('batch-prunes exact qualified selectors and preserves object fields', async () => {
    const source = 'https://github.com/acme/skills';
    const config: WorkspaceConfig = {
      version: 2,
      repositories: [],
      clients: ['copilot'],
      plugins: [
        {
          source,
          clients: ['copilot'],
          install: 'file',
          exclude: ['commands/**'],
          ref: 'v2',
          skills: ['nested/one/review', 'nested/two/review', 'keep'],
        },
      ],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config), 'utf-8');

    const entry = installation({
      id: 'project:0',
      scope: 'project',
      configIndex: 0,
      rawSource: source,
    });
    const prepared = await createSkillUpdateReconciler({
      workspacePath: tmpDir,
      userConfigPath,
    })(
      unit([entry], {
        [entry.id]: [
          { name: 'review', subpath: 'nested/one/review', selector: 'nested/one/review' },
          { name: 'keep', subpath: 'keep', selector: 'keep' },
        ],
      }),
    );

    // Preparing the transaction must not alter the live config.
    expect(load(await readFile(join(tmpDir, '.allagents/workspace.yaml'), 'utf-8'))).toEqual(config);
    await prepared.commit();

    const updated = load(
      await readFile(join(tmpDir, '.allagents/workspace.yaml'), 'utf-8'),
    ) as WorkspaceConfig;
    expect(updated.plugins).toEqual([
      {
        source,
        clients: ['copilot'],
        install: 'file',
        exclude: ['commands/**'],
        ref: 'v2',
        skills: ['nested/two/review'],
      },
    ]);
  });

  it('preserves comments while committing a deleted skill selector', async () => {
    const source = 'https://github.com/acme/skills';
    const configPath = join(tmpDir, '.allagents/workspace.yaml');
    const original = `# Shared skill configuration
version: 2
repositories: []
clients:
  - copilot

# Selected skills
plugins:
  - source: ${source} # Reviewed catalogue
    skills:
      - removed # Obsolete skill
      - keep # Keep this skill
`;
    await writeFile(configPath, original, 'utf-8');
    const entry = installation({
      id: 'project:0',
      scope: 'project',
      configIndex: 0,
      rawSource: source,
    });
    const prepared = await createSkillUpdateReconciler({
      workspacePath: tmpDir,
      userConfigPath,
    })(unit([entry], {
      [entry.id]: [{ name: 'removed', subpath: 'removed', selector: 'removed' }],
    }));

    expect(await readFile(configPath, 'utf-8')).toBe(original);
    await prepared.commit();

    const content = await readFile(configPath, 'utf-8');
    expect((load(content) as WorkspaceConfig).plugins).toEqual([{ source, skills: ['keep'] }]);
    expect(content).toStartWith('# Shared skill configuration\n');
    expect(content).toContain('- copilot\n\n# Selected skills\nplugins:');
    expect(content).toContain(`source: ${source} # Reviewed catalogue`);
    expect(content).toContain('- keep # Keep this skill');
    expect(content).not.toContain('Obsolete skill');
  });

  it('expands a shared bare allowlist selector to surviving qualified paths', async () => {
    const source = 'https://github.com/acme/skills';
    const config: WorkspaceConfig = {
      version: 2,
      repositories: [],
      clients: ['copilot'],
      plugins: [
        {
          source,
          clients: ['copilot'],
          skills: ['before', 'review', 'nested/two/review', 'after'],
        },
      ],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config), 'utf-8');
    const entry = installation({
      id: 'project:0',
      scope: 'project',
      configIndex: 0,
      rawSource: source,
    });

    const prepared = await createSkillUpdateReconciler({
      workspacePath: tmpDir,
      userConfigPath,
    })(
      unit(
        [entry],
        {
          [entry.id]: [
            { name: 'review', subpath: 'nested/one/review', selector: 'review' },
          ],
        },
        [],
        {
          [entry.id]: [
            { name: 'review', subpath: 'nested/two/review', selector: 'review' },
            { name: 'review', subpath: 'nested/three/review', selector: 'review' },
          ],
        },
      ),
    );
    expect(
      load(
        await readFile(join(tmpDir, '.allagents/workspace.yaml'), 'utf-8'),
      ),
    ).toEqual(config);
    await prepared.commit();

    const updated = load(
      await readFile(join(tmpDir, '.allagents/workspace.yaml'), 'utf-8'),
    ) as WorkspaceConfig;
    expect(updated.plugins).toEqual([
      {
        source,
        clients: ['copilot'],
        skills: [
          'before',
          'nested/two/review',
          'nested/three/review',
          'after',
        ],
      },
    ]);
  });

  it('reconciles legacy top-level selectors for confirmed deletions', async () => {
    const source = 'https://github.com/acme/skills';
    const config: WorkspaceConfig = {
      version: 1,
      repositories: [],
      clients: ['copilot'],
      plugins: [{ source, clients: ['copilot'] }],
      enabledSkills: [
        'skills:before',
        'skills:review',
        'skills:nested/two/review',
        'skills:gone',
        'other:gone',
      ],
      disabledSkills: [
        'skills:review',
        'skills:nested/two/review',
        'skills:gone',
        'other:gone',
      ],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config), 'utf-8');
    const entry = installation({
      id: 'project:0',
      scope: 'project',
      configIndex: 0,
      rawSource: source,
      pluginName: 'skills',
    });

    const prepared = await createSkillUpdateReconciler({
      workspacePath: tmpDir,
      userConfigPath,
    })(
      unit(
        [entry],
        {
          [entry.id]: [
            { name: 'review', subpath: 'nested/one/review', selector: 'review' },
            { name: 'gone', subpath: 'gone', selector: 'gone' },
          ],
        },
        [],
        {
          [entry.id]: [
            { name: 'review', subpath: 'nested/two/review', selector: 'review' },
            { name: 'review', subpath: 'nested/three/review', selector: 'review' },
          ],
        },
      ),
    );
    expect(
      load(
        await readFile(join(tmpDir, '.allagents/workspace.yaml'), 'utf-8'),
      ),
    ).toEqual(config);
    await prepared.commit();

    const updated = load(
      await readFile(join(tmpDir, '.allagents/workspace.yaml'), 'utf-8'),
    ) as WorkspaceConfig;
    expect(updated.enabledSkills).toEqual([
      'skills:before',
      'skills:nested/two/review',
      'skills:nested/three/review',
      'other:gone',
    ]);
    expect(updated.disabledSkills).toEqual([
      'skills:nested/two/review',
      'skills:nested/three/review',
      'other:gone',
    ]);
    expect(updated.plugins).toEqual([{ source, clients: ['copilot'] }]);
  });

  it('keeps an empty allowlist for non-skill artifacts but removes a standalone source', async () => {
    const sharedSource = 'https://github.com/acme/shared';
    const standaloneSource = 'https://github.com/acme/solo/tree/main/skill';
    const config: WorkspaceConfig = {
      repositories: [],
      clients: ['copilot'],
      plugins: [
        { source: sharedSource, exclude: ['hooks/**'], skills: ['gone'] },
        { source: standaloneSource, skills: ['solo'] },
      ],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config), 'utf-8');
    const shared = installation({
      id: 'project:0',
      scope: 'project',
      configIndex: 0,
      rawSource: sharedSource,
    });
    const standalone = installation({
      id: 'project:1',
      scope: 'project',
      configIndex: 1,
      rawSource: standaloneSource,
      standaloneSkillSource: true,
    });

    const prepared = await createSkillUpdateReconciler({
      workspacePath: tmpDir,
      userConfigPath,
    })(
      unit([shared, standalone], {
        [shared.id]: [{ name: 'gone', subpath: 'gone', selector: 'gone' }],
        [standalone.id]: [{ name: 'solo', subpath: 'solo', selector: 'solo' }],
      }),
    );
    await prepared.commit();

    const updated = load(
      await readFile(join(tmpDir, '.allagents/workspace.yaml'), 'utf-8'),
    ) as WorkspaceConfig;
    expect(updated.plugins).toEqual([
      { source: sharedSource, exclude: ['hooks/**'], skills: [] },
    ]);
  });

  it('removes a standalone raw-string source before the string-entry early return', async () => {
    const standaloneSource = 'https://github.com/acme/solo/tree/main/skill';
    const config: WorkspaceConfig = {
      repositories: [],
      clients: ['copilot'],
      plugins: [standaloneSource],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config), 'utf-8');
    const standalone = installation({
      id: 'project:0',
      scope: 'project',
      configIndex: 0,
      rawSource: standaloneSource,
      standaloneSkillSource: true,
    });

    const prepared = await createSkillUpdateReconciler({
      workspacePath: tmpDir,
      userConfigPath,
    })(
      unit([standalone], {
        [standalone.id]: [
          { name: 'solo', subpath: 'solo', selector: 'solo' },
        ],
      }),
    );
    await prepared.commit();

    const updated = load(
      await readFile(join(tmpDir, '.allagents/workspace.yaml'), 'utf-8'),
    ) as WorkspaceConfig;
    expect(updated.plugins).toEqual([]);
  });

  it('does not add stale exclusions for implicit or blocklist entries', async () => {
    const implicitSource = 'https://github.com/acme/implicit';
    const blocklistSource = 'https://github.com/acme/blocklist';
    const config: WorkspaceConfig = {
      repositories: [],
      clients: ['copilot'],
      plugins: [
        implicitSource,
        { source: blocklistSource, skills: { exclude: ['already-disabled'] } },
      ],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config), 'utf-8');
    const implicit = installation({
      id: 'project:0',
      scope: 'project',
      configIndex: 0,
      rawSource: implicitSource,
    });
    const blocklist = installation({
      id: 'project:1',
      scope: 'project',
      configIndex: 1,
      rawSource: blocklistSource,
    });

    const prepared = await createSkillUpdateReconciler({
      workspacePath: tmpDir,
      userConfigPath,
    })(
      unit([implicit, blocklist], {
        [implicit.id]: [{ name: 'gone', subpath: 'gone' }],
        [blocklist.id]: [{ name: 'gone', subpath: 'gone' }],
      }),
    );
    await prepared.commit();

    expect(
      load(await readFile(join(tmpDir, '.allagents/workspace.yaml'), 'utf-8')),
    ).toEqual(config);
  });

  it('removes only installations authoritatively removed from a marketplace', async () => {
    const removedSource = 'gone@marketplace';
    const retainedSource = 'keep@marketplace';
    const config: WorkspaceConfig = {
      repositories: [],
      clients: ['copilot'],
      plugins: [
        { source: removedSource, clients: ['copilot'], skills: ['gone'] },
        { source: retainedSource, skills: ['keep'] },
      ],
      disabledSkills: ['gone:old', 'keep:old'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config), 'utf-8');
    const removed = installation({
      id: 'project:0',
      scope: 'project',
      configIndex: 0,
      rawSource: removedSource,
    });
    const retained = installation({
      id: 'project:1',
      scope: 'project',
      configIndex: 1,
      rawSource: retainedSource,
    });

    const prepared = await createSkillUpdateReconciler({
      workspacePath: tmpDir,
      userConfigPath,
    })(
      unit(
        [removed, retained],
        { [removed.id]: [{ name: 'gone', subpath: 'gone' }] },
        [removed.id],
      ),
    );
    await prepared.commit();

    const updated = load(
      await readFile(join(tmpDir, '.allagents/workspace.yaml'), 'utf-8'),
    ) as WorkspaceConfig;
    expect(updated.plugins).toEqual([{ source: retainedSource, skills: ['keep'] }]);
    expect(updated.disabledSkills).toEqual(['keep:old']);
  });

  it('restores every scope when the second config replacement fails', async () => {
    const projectSource = 'https://github.com/acme/project';
    const userSource = 'https://github.com/acme/user';
    const projectConfig: WorkspaceConfig = {
      repositories: [],
      clients: ['copilot'],
      plugins: [{ source: projectSource, skills: ['gone'] }],
    };
    const userConfig: WorkspaceConfig = {
      repositories: [],
      clients: ['codex'],
      plugins: [{ source: userSource, skills: ['gone'] }],
    };
    const projectConfigPath = join(tmpDir, '.allagents/workspace.yaml');
    await writeFile(projectConfigPath, dump(projectConfig), 'utf-8');
    await writeFile(userConfigPath, dump(userConfig), 'utf-8');
    const project = installation({
      id: 'project:0',
      scope: 'project',
      configIndex: 0,
      rawSource: projectSource,
    });
    const user = installation({
      id: 'user:0',
      scope: 'user',
      configIndex: 0,
      rawSource: userSource,
    });
    let liveReplacement = 0;

    const prepared = await createSkillUpdateReconciler({
      workspacePath: tmpDir,
      userConfigPath,
      beforeReplace: (path) => {
        if (!path.endsWith('workspace.yaml')) return;
        liveReplacement++;
        if (liveReplacement === 2) throw new Error('injected second replacement failure');
      },
    })(
      unit([project, user], {
        [project.id]: [{ name: 'gone', subpath: 'gone', selector: 'gone' }],
        [user.id]: [{ name: 'gone', subpath: 'gone', selector: 'gone' }],
      }),
    );

    await expect(prepared.commit()).rejects.toThrow('injected second replacement failure');
    await prepared.rollback();
    expect(await readFile(projectConfigPath, 'utf-8')).toBe(dump(projectConfig));
    expect(await readFile(userConfigPath, 'utf-8')).toBe(dump(userConfig));
  });

  it('integrates config failure with checkout rollback and skips sync', async () => {
    const projectSource = 'https://github.com/acme/project';
    const userSource = 'https://github.com/acme/user';
    const projectConfig: WorkspaceConfig = {
      repositories: [],
      clients: ['copilot'],
      plugins: [{ source: projectSource, skills: ['gone'] }],
    };
    const userConfig: WorkspaceConfig = {
      repositories: [],
      clients: ['codex'],
      plugins: [{ source: userSource, skills: ['gone'] }],
    };
    const projectConfigPath = join(tmpDir, '.allagents/workspace.yaml');
    await writeFile(projectConfigPath, dump(projectConfig), 'utf-8');
    await writeFile(userConfigPath, dump(userConfig), 'utf-8');
    const project = installation({
      id: 'project:0',
      scope: 'project',
      configIndex: 0,
      rawSource: projectSource,
    });
    const user = installation({
      id: 'user:0',
      scope: 'user',
      configIndex: 0,
      rawSource: userSource,
    });
    const checkout: CheckoutNode = {
      id: '/cache/acme',
      cachePath: '/cache/acme',
      remoteUrl: 'https://github.com/acme/shared.git',
      role: 'root',
      currentSha: 'old-sha',
    };
    const updateUnit = {
      ...unit([project, user], {
        [project.id]: [{ name: 'gone', subpath: 'gone', selector: 'gone' }],
        [user.id]: [{ name: 'gone', subpath: 'gone', selector: 'gone' }],
      }),
      nodes: [checkout],
      inspectedNodes: [{ nodeId: checkout.id, sha: 'new-sha' }],
    };
    let liveReplacement = 0;
    const advanced: string[] = [];
    const restored: string[] = [];
    let syncCalls = 0;

    const result = await executeSkillUpdatePlan(
      { selectedScopes: ['project', 'user'], units: [updateUnit] },
      { [updateUnit.id]: 'remove' },
      {
        advanceNode: async (node, sha) => advanced.push(`${node.id}:${sha}`),
        restoreNode: async (node, sha) => restored.push(`${node.id}:${sha}`),
        reconcileUnit: createSkillUpdateReconciler({
          workspacePath: tmpDir,
          userConfigPath,
          beforeReplace: () => {
            liveReplacement++;
            if (liveReplacement === 2) {
              throw new Error('injected second replacement failure');
            }
          },
        }),
        syncScope: async () => {
          syncCalls++;
          return { success: true };
        },
      },
    );

    expect(result.success).toBe(false);
    expect(advanced).toEqual(['/cache/acme:new-sha']);
    expect(restored).toEqual(['/cache/acme:old-sha']);
    expect(syncCalls).toBe(0);
    expect(await readFile(projectConfigPath, 'utf-8')).toBe(dump(projectConfig));
    expect(await readFile(userConfigPath, 'utf-8')).toBe(dump(userConfig));
  });
});
