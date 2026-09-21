import { describe, expect, it, mock } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildPhysicalRefreshUnits,
  buildSkillUpdatePreflight,
  createGitHubSkillUpdateInstallation,
  executeSkillUpdatePlan,
  inspectRemoteSkillUpdateUnit,
  resolveCheckoutSubpath,
  type CheckoutNode,
  type SkillUpdateInstallation,
  type UnitInspection,
} from '../../../src/core/skill-update.js';
import { getEffectivePluginSource } from '../../../src/models/workspace-config.js';

const projectNode: CheckoutNode = {
  id: '/cache/acme-skills',
  cachePath: '/cache/acme-skills',
  remoteUrl: 'https://github.com/acme/skills.git',
  role: 'root',
  currentSha: 'old-sha',
};

function installation(
  overrides: Partial<SkillUpdateInstallation> = {},
): SkillUpdateInstallation {
  return {
    id: 'project:0',
    scope: 'project',
    configIndex: 0,
    rawSource: 'acme/skills',
    effectiveSource: 'acme/skills',
    pluginName: 'skills',
    rootNodeId: projectNode.id,
    rootSubpath: '',
    nodes: [projectNode],
    skills: [
      { name: 'keep', subpath: 'keep', enabled: true },
      { name: 'deleted', subpath: 'deleted', enabled: true },
    ],
    ...overrides,
  };
}

function resolved(
  installationId: string,
  subpaths: string[],
): UnitInspection {
  return {
    outcome: 'resolved',
    nodes: [{ nodeId: projectNode.id, sha: 'new-sha' }],
    installations: [
      {
        installationId,
        outcome: 'resolved',
        skills: subpaths.map((subpath) => ({
          name: subpath.split('/').at(-1) ?? subpath,
          subpath,
        })),
      },
    ],
  };
}

describe('getEffectivePluginSource', () => {
  it('applies object refs while preserving inline refs', () => {
    expect(
      getEffectivePluginSource({ source: 'acme/skills', ref: 'v2' }),
    ).toBe('acme/skills@v2');
    expect(
      getEffectivePluginSource({ source: 'acme/skills@v1', ref: 'v2' }),
    ).toBe('acme/skills@v1');
    expect(
      getEffectivePluginSource({
        source: 'https://github.com/acme/skills',
        ref: 'v2',
      }),
    ).toBe('acme/skills@v2');
    expect(
      getEffectivePluginSource({ source: './local/plugin', ref: 'v2' }),
    ).toBe('./local/plugin');
    expect(
      getEffectivePluginSource({
        source: 'plugin@acme/marketplace',
        ref: 'v2',
      }),
    ).toBe('plugin@acme/marketplace');
  });
});

describe('createGitHubSkillUpdateInstallation', () => {
  it('canonicalizes aliases to one cache node and separates requested refs', () => {
    const shorthand = createGitHubSkillUpdateInstallation({
      scope: 'project',
      configIndex: 0,
      plugin: 'acme/skills',
      pluginName: 'skills',
      currentSha: 'old',
      skills: [{ name: 'keep', subpath: 'keep', enabled: true }],
    });
    const url = createGitHubSkillUpdateInstallation({
      scope: 'user',
      configIndex: 0,
      plugin: 'https://github.com/acme/skills',
      pluginName: 'skills',
      currentSha: 'old',
      skills: [{ name: 'keep', subpath: 'keep', enabled: true }],
    });
    const requestedRef = createGitHubSkillUpdateInstallation({
      scope: 'project',
      configIndex: 1,
      plugin: { source: 'acme/skills', ref: 'v2' },
      pluginName: 'skills',
      currentSha: 'v2-old',
      skills: [{ name: 'keep', subpath: 'keep', enabled: true }],
    });

    expect(shorthand?.nodes[0]?.id).toBe(url?.nodes[0]?.id);
    expect(shorthand?.rootSubpath).toBe('');
    expect(requestedRef?.nodes[0]?.ref).toBe('v2');
    expect(requestedRef?.nodes[0]?.id).not.toBe(shorthand?.nodes[0]?.id);
  });

  it('groups direct-source siblings by physical checkout while keeping refs separate', () => {
    const sibling = installation({
      id: 'project:1',
      configIndex: 1,
      rawSource: 'acme/skills/plugins/sibling',
      effectiveSource: 'acme/skills/plugins/sibling',
      rootSubpath: 'plugins/sibling',
    });
    const refNode: CheckoutNode = {
      ...projectNode,
      id: '/cache/acme-skills-v2',
      cachePath: '/cache/acme-skills-v2',
      ref: 'v2',
    };
    const refSpecific = installation({
      id: 'project:2',
      configIndex: 2,
      rawSource: 'acme/skills@v2',
      effectiveSource: 'acme/skills@v2',
      rootNodeId: refNode.id,
      nodes: [refNode],
    });

    const units = buildPhysicalRefreshUnits([
      installation(),
      sibling,
      refSpecific,
    ]);

    expect(units).toHaveLength(2);
    expect(
      units.find((unit) => unit.id === projectNode.id)?.installations.map(
        (entry) => entry.rawSource,
      ),
    ).toEqual(['acme/skills', 'acme/skills/plugins/sibling']);
  });
});

describe('buildSkillUpdatePreflight', () => {
  it('preflights every sibling in a touched cache and compares qualified paths', async () => {
    const inspectUnit = mock(async () =>
      resolved('project:0', ['keep', 'group-b/shared']),
    );
    const result = await buildSkillUpdatePreflight(
      {
        installations: [
          installation({
            skills: [
              { name: 'keep', subpath: 'keep', enabled: true },
              { name: 'shared', subpath: 'group-a/shared', enabled: true },
              { name: 'shared', subpath: 'group-b/shared', enabled: true },
            ],
          }),
        ],
        selectedScopes: ['project'],
        filters: ['keep'],
      },
      { inspectUnit },
    );

    expect(inspectUnit).toHaveBeenCalledTimes(1);
    expect(result.units).toHaveLength(1);
    expect(result.units[0]?.deleted.map((skill) => skill.subpath)).toEqual([
      'group-a/shared',
    ]);
    expect(result.units[0]?.survivors.map((skill) => skill.subpath)).toEqual([
      'keep',
      'group-b/shared',
    ]);
  });

  it('skips exact inspection only when every physical node is equal and healthy', async () => {
    const dependency: CheckoutNode = {
      id: '/cache/dependency',
      cachePath: '/cache/dependency',
      remoteUrl: 'https://github.com/acme/dependency.git',
      role: 'dependency',
      currentSha: 'dependency-sha',
    };
    const inspectUnit = mock(async () => resolved('project:0', ['keep']));
    const precheckNode = mock(async () => ({
      remoteEqual: true,
      repositoryHealthy: true,
      domainRootsHealthy: true,
    }));

    const result = await buildSkillUpdatePreflight(
      {
        installations: [
          installation({
            nodes: [dependency, projectNode],
            skills: [{ name: 'keep', subpath: 'keep', enabled: true }],
          }),
        ],
        selectedScopes: ['project'],
      },
      { inspectUnit, precheckNode },
    );

    expect(precheckNode).toHaveBeenCalledTimes(2);
    expect(inspectUnit).not.toHaveBeenCalled();
    expect(result.units[0]).toMatchObject({
      outcome: 'resolved',
      safeToBypassTransaction: true,
      inspectedNodes: [
        { nodeId: dependency.id, sha: dependency.currentSha },
        { nodeId: projectNode.id, sha: projectNode.currentSha },
      ],
      deleted: [],
    });
    expect(result.units[0]?.survivors.map((skill) => skill.subpath)).toEqual([
      'keep',
    ]);
  });

  for (const [name, badFact] of [
    [
      'changed',
      {
        remoteEqual: false,
        repositoryHealthy: true,
        domainRootsHealthy: true,
      },
    ],
    [
      'unresolved',
      {
        remoteEqual: false,
        repositoryHealthy: false,
        domainRootsHealthy: true,
      },
    ],
    [
      'repository-unhealthy',
      {
        remoteEqual: true,
        repositoryHealthy: false,
        domainRootsHealthy: true,
      },
    ],
    [
      'domain-root-unhealthy',
      {
        remoteEqual: true,
        repositoryHealthy: true,
        domainRootsHealthy: false,
      },
    ],
  ] as const) {
    it(`falls the whole connected unit back to exact inspection for one ${name} node`, async () => {
      const dependency: CheckoutNode = {
        id: '/cache/dependency',
        cachePath: '/cache/dependency',
        remoteUrl: 'https://github.com/acme/dependency.git',
        role: 'dependency',
        currentSha: 'dependency-sha',
      };
      const inspectUnit = mock(
        async (): Promise<UnitInspection> => ({
          outcome: 'resolved',
          nodes: [
            { nodeId: dependency.id, sha: dependency.currentSha },
            { nodeId: projectNode.id, sha: projectNode.currentSha },
          ],
          installations: [
            {
              installationId: 'project:0',
              outcome: 'resolved',
              skills: [{ name: 'keep', subpath: 'keep' }],
            },
          ],
        }),
      );
      const precheckNode = mock(async (node: CheckoutNode) =>
        node.id === dependency.id
          ? badFact
          : {
              remoteEqual: true,
              repositoryHealthy: true,
              domainRootsHealthy: true,
            },
      );

      const result = await buildSkillUpdatePreflight(
        {
          installations: [
            installation({
              nodes: [dependency, projectNode],
              skills: [{ name: 'keep', subpath: 'keep', enabled: true }],
            }),
          ],
          selectedScopes: ['project'],
        },
        { inspectUnit, precheckNode },
      );

      expect(precheckNode).toHaveBeenCalledTimes(2);
      expect(inspectUnit).toHaveBeenCalledTimes(1);
      expect(result.units[0]?.safeToBypassTransaction).toBe(
        badFact.repositoryHealthy && badFact.domainRootsHealthy
          ? true
          : undefined,
      );
    });
  }

  it('fails closed when discovery fails', async () => {
    const result = await buildSkillUpdatePreflight(
      {
        installations: [installation()],
        selectedScopes: ['project'],
      },
      {
        inspectUnit: async () => ({
          outcome: 'failed',
          nodes: [],
          installations: [],
          error: 'manifest is malformed',
        }),
      },
    );

    expect(result.units[0]?.outcome).toBe('failed');
    expect(result.units[0]?.deleted).toEqual([]);
    expect(result.units[0]?.error).toContain('malformed');
  });

  it('types inventory failures while continuing healthy independent units', async () => {
    const inspectUnit = mock(async () => resolved('project:0', ['keep', 'deleted']));
    const result = await buildSkillUpdatePreflight(
      {
        installations: [installation()],
        selectedScopes: ['project'],
        failures: [
          {
            id: 'inventory:project:1',
            scope: 'project',
            source: 'acme/broken',
            nodeIds: ['/cache/broken'],
            error: 'checkout is unreadable',
          },
        ],
      },
      { inspectUnit },
    );

    expect(inspectUnit).toHaveBeenCalledTimes(1);
    expect(result.units.map((unit) => [unit.id, unit.outcome])).toEqual([
      [projectNode.id, 'resolved'],
      ['inventory:project:1', 'failed'],
    ]);
  });

  it('fails a shared component closed without inspecting or mutating it', async () => {
    const inspectUnit = mock(async () => resolved('project:0', ['keep']));
    const precheckNode = mock(async () => ({
      remoteEqual: true,
      repositoryHealthy: true,
      domainRootsHealthy: true,
    }));
    const result = await buildSkillUpdatePreflight(
      {
        installations: [installation()],
        selectedScopes: ['project'],
        failures: [
          {
            id: 'inventory:user:0',
            scope: 'user',
            source: 'acme/shared-broken',
            nodeIds: [projectNode.id],
            error: 'shared checkout inventory failed',
          },
        ],
      },
      { inspectUnit, precheckNode },
    );

    expect(inspectUnit).not.toHaveBeenCalled();
    expect(precheckNode).not.toHaveBeenCalled();
    expect(result.units).toHaveLength(1);
    expect(result.units[0]).toMatchObject({
      id: projectNode.id,
      outcome: 'failed',
      error: expect.stringContaining('shared checkout inventory failed'),
    });
  });

  it('blocks a selected-scope update when a shared-cache deletion affects another scope', async () => {
    const user = installation({
      id: 'user:0',
      scope: 'user',
      configIndex: 0,
    });
    const inspectUnit = async (): Promise<UnitInspection> => ({
      outcome: 'resolved',
      nodes: [{ nodeId: projectNode.id, sha: 'new-sha' }],
      installations: [
        { installationId: 'project:0', outcome: 'resolved', skills: [{ name: 'keep', subpath: 'keep' }] },
        { installationId: 'user:0', outcome: 'resolved', skills: [{ name: 'keep', subpath: 'keep' }] },
      ],
    });

    const result = await buildSkillUpdatePreflight(
      {
        installations: [installation(), user],
        selectedScopes: ['project'],
      },
      { inspectUnit },
    );

    expect(result.units[0]?.blockedByOutOfScope).toBe(true);
    expect(result.units[0]?.deleted).toHaveLength(2);
  });

  it('blocks every update when the physical checkout has any out-of-scope consumer', async () => {
    const user = installation({
      id: 'user:0',
      scope: 'user',
      configIndex: 0,
      skills: [{ name: 'keep', subpath: 'keep', enabled: true }],
    });
    const result = await buildSkillUpdatePreflight(
      {
        installations: [
          installation({
            skills: [{ name: 'keep', subpath: 'keep', enabled: true }],
          }),
          user,
        ],
        selectedScopes: ['project'],
      },
      {
        inspectUnit: async () => ({
          outcome: 'resolved',
          nodes: [{ nodeId: projectNode.id, sha: 'new-sha' }],
          installations: [
            {
              installationId: 'project:0',
              outcome: 'resolved',
              skills: [{ name: 'keep', subpath: 'keep' }],
            },
            {
              installationId: 'user:0',
              outcome: 'resolved',
              skills: [{ name: 'keep', subpath: 'keep' }],
            },
          ],
        }),
      },
    );

    expect(result.units[0]?.deleted).toEqual([]);
    expect(result.units[0]?.blockedByOutOfScope).toBe(true);

    const advanceNode = mock(async () => {});
    const executionResult = await executeSkillUpdatePlan(result, {}, {
      advanceNode,
      restoreNode: async () => {},
      reconcileUnit: async () => ({ commit: async () => {}, rollback: async () => {} }),
      syncScope: async () => ({ success: true }),
    });
    expect(advanceNode).not.toHaveBeenCalled();
    expect(executionResult.units[0]?.status).toBe('skipped');
  });

  it('retains the exact installation IDs authoritatively removed by a marketplace', async () => {
    const retained = installation({
      id: 'project:1',
      configIndex: 1,
      rawSource: 'keep@marketplace',
      effectiveSource: 'keep@marketplace',
      skills: [{ name: 'keep', subpath: 'keep', enabled: true }],
    });
    const result = await buildSkillUpdatePreflight(
      {
        installations: [installation(), retained],
        selectedScopes: ['project'],
      },
      {
        inspectUnit: async () => ({
          outcome: 'resolved',
          nodes: [{ nodeId: projectNode.id, sha: 'new-sha' }],
          installations: [
            { installationId: 'project:0', outcome: 'plugin-removed' },
            {
              installationId: 'project:1',
              outcome: 'resolved',
              skills: [{ name: 'keep', subpath: 'keep' }],
            },
          ],
        }),
      },
    );

    expect(result.units[0]?.removedInstallationIds).toEqual(['project:0']);
    expect(result.units[0]?.deleted.map((skill) => skill.installationId)).toEqual([
      'project:0',
      'project:0',
    ]);
    expect(result.units[0]?.survivors.map((skill) => skill.installationId)).toEqual([
      'project:1',
    ]);
  });
});

describe('inspectRemoteSkillUpdateUnit', () => {
  it('treats a valid empty plugin root as authoritative and always cleans up', async () => {
    const cleanup = mock(async () => {});
    const result = await inspectRemoteSkillUpdateUnit(
      {
        id: projectNode.id,
        nodes: [projectNode],
        installations: [installation()],
      },
      {
        cloneNode: async () => '/tmp/inspected',
        getRevision: async () => 'inspected-sha',
        pathExists: () => true,
        discoverPluginSkills: async () => [],
        cleanup,
      },
    );

    expect(result).toEqual({
      outcome: 'resolved',
      nodes: [{ nodeId: projectNode.id, sha: 'inspected-sha' }],
      installations: [
        { installationId: 'project:0', outcome: 'resolved', skills: [] },
      ],
    });
    expect(cleanup).toHaveBeenCalledWith('/tmp/inspected');
  });

  it('rejects parent, absolute, and symlink subpaths outside the checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allagents-skill-path-'));
    const checkout = join(root, 'checkout');
    const outside = join(root, 'outside');
    await mkdir(checkout);
    await mkdir(outside);
    await symlink(outside, join(checkout, 'escaped-link'));
    try {
      expect(() => resolveCheckoutSubpath(checkout, '../outside')).toThrow(
        'outside its checkout',
      );
      expect(() => resolveCheckoutSubpath(checkout, outside)).toThrow(
        'absolute',
      );
      expect(() => resolveCheckoutSubpath(checkout, 'escaped-link')).toThrow(
        'outside its checkout',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('classifies a missing declared root as failure, never deletion', async () => {
    const cleanup = mock(async () => {});
    const result = await inspectRemoteSkillUpdateUnit(
      {
        id: projectNode.id,
        nodes: [projectNode],
        installations: [installation({ rootSubpath: 'plugins/missing' })],
      },
      {
        cloneNode: async () => '/tmp/inspected',
        getRevision: async () => 'inspected-sha',
        pathExists: () => false,
        discoverPluginSkills: async () => [],
        cleanup,
      },
    );

    expect(result.outcome).toBe('failed');
    expect(result.installations).toEqual([]);
    expect(result.error).toContain('declared root');
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe('executeSkillUpdatePlan', () => {
  it('bypasses mutation but preserves action-driven sync for a healthy exact-inspection no-op', async () => {
    const plan = await buildSkillUpdatePreflight(
      {
        installations: [
          installation({
            skills: [{ name: 'keep', subpath: 'keep', enabled: true }],
          }),
        ],
        selectedScopes: ['project'],
      },
      {
        precheckNode: async () => ({
          remoteEqual: false,
          repositoryHealthy: true,
          domainRootsHealthy: true,
        }),
        inspectUnit: async () => ({
          outcome: 'resolved',
          nodes: [{ nodeId: projectNode.id, sha: projectNode.currentSha }],
          installations: [
            {
              installationId: 'project:0',
              outcome: 'resolved',
              skills: [{ name: 'keep', subpath: 'keep' }],
            },
          ],
        }),
      },
    );
    const reconcileUnit = mock(async () => ({
      commit: mock(async () => {}),
      rollback: mock(async () => {}),
    }));
    const advanceNode = mock(async () => {});
    const restoreNode = mock(async () => {});
    const syncScope = mock(async () => ({ success: true }));

    const result = await executeSkillUpdatePlan(plan, {}, {
      reconcileUnit,
      advanceNode,
      restoreNode,
      syncScope,
    });

    expect(reconcileUnit).not.toHaveBeenCalled();
    expect(advanceNode).not.toHaveBeenCalled();
    expect(restoreNode).not.toHaveBeenCalled();
    expect(syncScope).toHaveBeenCalledWith('project', { offline: true });
    expect(result.units[0]).toMatchObject({
      status: 'updated',
      skillCounts: { updated: 1, removed: 0, retained: 0 },
    });
    expect(result.syncedScopes).toEqual(['project']);
  });

  it('runs the established transaction for an equal SHA without positive health', async () => {
    const plan = await buildSkillUpdatePreflight(
      {
        installations: [
          installation({
            skills: [{ name: 'keep', subpath: 'keep', enabled: true }],
          }),
        ],
        selectedScopes: ['project'],
      },
      {
        inspectUnit: async () => ({
          outcome: 'resolved',
          nodes: [{ nodeId: projectNode.id, sha: projectNode.currentSha }],
          installations: [
            {
              installationId: 'project:0',
              outcome: 'resolved',
              skills: [{ name: 'keep', subpath: 'keep' }],
            },
          ],
        }),
      },
    );
    const calls: string[] = [];

    const result = await executeSkillUpdatePlan(plan, {}, {
      reconcileUnit: async () => {
        calls.push('reconcile');
        return {
          commit: async () => {
            calls.push('commit');
          },
          rollback: async () => {},
        };
      },
      advanceNode: async () => {
        calls.push('advance');
      },
      restoreNode: async () => {},
      syncScope: async () => {
        calls.push('sync');
        return { success: true };
      },
    });

    expect(calls).toEqual(['reconcile', 'advance', 'commit', 'sync']);
    expect(result.units[0]?.status).toBe('updated');
  });

  it('does not bypass an approved deletion at an equal inspected SHA', async () => {
    const plan = await buildSkillUpdatePreflight(
      { installations: [installation()], selectedScopes: ['project'] },
      {
        precheckNode: async () => ({
          remoteEqual: false,
          repositoryHealthy: true,
          domainRootsHealthy: true,
        }),
        inspectUnit: async () => ({
          outcome: 'resolved',
          nodes: [{ nodeId: projectNode.id, sha: projectNode.currentSha }],
          installations: [
            {
              installationId: 'project:0',
              outcome: 'resolved',
              skills: [{ name: 'keep', subpath: 'keep' }],
            },
          ],
        }),
      },
    );
    const reconcileUnit = mock(async () => ({
      commit: mock(async () => {}),
      rollback: mock(async () => {}),
    }));

    const result = await executeSkillUpdatePlan(
      plan,
      { [projectNode.id]: 'remove' },
      {
        reconcileUnit,
        advanceNode: async () => {},
        restoreNode: async () => {},
        syncScope: async () => ({ success: true }),
      },
    );

    expect(reconcileUnit).toHaveBeenCalledTimes(1);
    expect(result.units[0]?.status).toBe('removed');
  });

  it('does not bypass authoritative installation removal with no deleted skills', async () => {
    const plan: Parameters<typeof executeSkillUpdatePlan>[0] = {
      selectedScopes: ['project'],
      units: [
        {
          id: projectNode.id,
          nodes: [projectNode],
          installations: [
            installation({
              skills: [],
            }),
          ],
          outcome: 'resolved',
          inspectedNodes: [
            { nodeId: projectNode.id, sha: projectNode.currentSha },
          ],
          deleted: [],
          survivors: [],
          removedInstallationIds: ['project:0'],
          blockedByOutOfScope: false,
          safeToBypassTransaction: true,
        },
      ],
    };
    const reconcileUnit = mock(async () => ({
      commit: mock(async () => {}),
      rollback: mock(async () => {}),
    }));

    await executeSkillUpdatePlan(plan, {}, {
      reconcileUnit,
      advanceNode: async () => {},
      restoreNode: async () => {},
      syncScope: async () => ({ success: true }),
    });

    expect(reconcileUnit).toHaveBeenCalledTimes(1);
  });

  it('collects decisions before mutation, leaves retained units untouched, and syncs offline once', async () => {
    const secondNode: CheckoutNode = {
      id: '/cache/healthy',
      cachePath: '/cache/healthy',
      remoteUrl: 'https://github.com/acme/healthy.git',
      role: 'root',
      currentSha: 'healthy-old',
    };
    const plan = await buildSkillUpdatePreflight(
      {
        installations: [
          installation(),
          installation({
            id: 'project:1',
            configIndex: 1,
            rawSource: 'acme/healthy',
            effectiveSource: 'acme/healthy',
            nodes: [secondNode],
            rootNodeId: secondNode.id,
            skills: [{ name: 'healthy', subpath: 'healthy', enabled: true }],
          }),
        ],
        selectedScopes: ['project'],
      },
      {
        inspectUnit: async (unit) => {
          if (unit.nodes[0]?.id === projectNode.id) {
            return resolved('project:0', ['keep']);
          }
          return {
            outcome: 'resolved',
            nodes: [{ nodeId: secondNode.id, sha: 'healthy-new' }],
            installations: [
              {
                installationId: 'project:1',
                outcome: 'resolved',
                skills: [{ name: 'healthy', subpath: 'healthy' }],
              },
            ],
          };
        },
      },
    );
    const advanced: string[] = [];
    const syncScope = mock(async () => ({ success: true }));

    const result = await executeSkillUpdatePlan(
      plan,
      { [projectNode.id]: 'retain' },
      {
        advanceNode: async (node, sha) => advanced.push(`${node.id}:${sha}`),
        restoreNode: async () => {},
        reconcileUnit: async () => ({ commit: async () => {}, rollback: async () => {} }),
        syncScope,
      },
    );

    expect(advanced).toEqual(['/cache/healthy:healthy-new']);
    expect(syncScope).toHaveBeenCalledTimes(1);
    expect(syncScope).toHaveBeenCalledWith('project', { offline: true });
    expect(result.units.find((unit) => unit.id === projectNode.id)?.status).toBe(
      'retained',
    );
  });

  it('cancels before any mutation when a decision is cancelled', async () => {
    const plan = await buildSkillUpdatePreflight(
      { installations: [installation()], selectedScopes: ['project'] },
      { inspectUnit: async () => resolved('project:0', ['keep']) },
    );
    const advanceNode = mock(async () => {});
    const reconcileUnit = mock(async () => ({
      commit: async () => {},
      rollback: async () => {},
    }));

    const result = await executeSkillUpdatePlan(
      plan,
      { [projectNode.id]: 'cancel' },
      {
        advanceNode,
        restoreNode: async () => {},
        reconcileUnit,
        syncScope: async () => ({ success: true }),
      },
    );

    expect(result.cancelled).toBe(true);
    expect(result.success).toBe(false);
    expect(result.units.every((unit) => unit.status === 'cancelled')).toBe(true);
    expect(advanceNode).not.toHaveBeenCalled();
    expect(reconcileUnit).not.toHaveBeenCalled();
  });

  it('restores already advanced dependency nodes when a later node fails', async () => {
    const dependency: CheckoutNode = {
      id: '/cache/dependency',
      cachePath: '/cache/dependency',
      remoteUrl: 'https://github.com/acme/dependency.git',
      role: 'dependency',
      currentSha: 'dependency-old',
    };
    const root: CheckoutNode = {
      ...projectNode,
      currentSha: 'root-old',
    };
    const plan = await buildSkillUpdatePreflight(
      {
        installations: [installation({ nodes: [root, dependency] })],
        selectedScopes: ['project'],
      },
      {
        inspectUnit: async () => ({
          outcome: 'resolved',
          nodes: [
            { nodeId: dependency.id, sha: 'dependency-new' },
            { nodeId: root.id, sha: 'root-new' },
          ],
          installations: [
            {
              installationId: 'project:0',
              outcome: 'resolved',
              skills: [
                { name: 'keep', subpath: 'keep' },
                { name: 'deleted', subpath: 'deleted' },
              ],
            },
          ],
        }),
      },
    );
    const advanced: string[] = [];
    const restored: string[] = [];
    const rollback = mock(async () => {});
    const syncScope = mock(async () => ({ success: true }));

    const result = await executeSkillUpdatePlan(plan, {}, {
      advanceNode: async (node) => {
        advanced.push(node.id);
        if (node.role === 'root') throw new Error('root checkout failed');
      },
      restoreNode: async (node, sha) => restored.push(`${node.id}:${sha}`),
      reconcileUnit: async () => ({ commit: async () => {}, rollback }),
      syncScope,
    });

    expect(advanced).toEqual([dependency.id, root.id]);
    expect(restored).toEqual([
      `${root.id}:root-old`,
      `${dependency.id}:dependency-old`,
    ]);
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(syncScope).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it('reports reconciliation and checkout rollback failures', async () => {
    const plan = await buildSkillUpdatePreflight(
      { installations: [installation()], selectedScopes: ['project'] },
      { inspectUnit: async () => resolved('project:0', ['keep', 'deleted']) },
    );
    const result = await executeSkillUpdatePlan(plan, {}, {
      advanceNode: async () => {
        throw new Error('advance failed after reset');
      },
      restoreNode: async () => {
        throw new Error('restore failed');
      },
      reconcileUnit: async () => ({
        commit: async () => {},
        rollback: async () => {
          throw new Error('config rollback failed');
        },
      }),
      syncScope: async () => ({ success: true }),
    });

    expect(result.units[0]?.error).toContain('advance failed after reset');
    expect(result.units[0]?.error).toContain('config rollback failed');
    expect(result.units[0]?.error).toContain('restore failed');
  });

  it('turns a rejected scope sync into a failed partial result', async () => {
    const plan = await buildSkillUpdatePreflight(
      { installations: [installation()], selectedScopes: ['project'] },
      { inspectUnit: async () => resolved('project:0', ['keep', 'deleted']) },
    );
    const result = await executeSkillUpdatePlan(plan, {}, {
      advanceNode: async () => {},
      restoreNode: async () => {},
      reconcileUnit: async () => ({ commit: async () => {}, rollback: async () => {} }),
      syncScope: async () => {
        throw new Error('sync exploded');
      },
    });

    expect(result.success).toBe(false);
    expect(result.units.at(-1)).toMatchObject({
      id: 'sync:project',
      status: 'failed',
      error: 'sync exploded',
    });
  });
});
