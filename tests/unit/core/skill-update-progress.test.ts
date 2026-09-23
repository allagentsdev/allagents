import { describe, expect, it, mock } from 'bun:test';
import {
  buildSkillUpdatePreflight,
  executeSkillUpdatePlan,
  type CheckoutNode,
  type SkillUpdateInstallation,
  type SkillUpdatePreflight,
  type SkillUpdateScope,
  type UnitInspection,
} from '../../../src/core/skill-update.js';

const nodes: CheckoutNode[] = [
  {
    id: '/cache/acme-skills',
    cachePath: '/cache/acme-skills',
    remoteUrl: 'https://github.com/acme/skills.git',
    role: 'root',
    currentSha: 'skills-old-sha',
  },
  {
    id: '/cache/acme-tools',
    cachePath: '/cache/acme-tools',
    remoteUrl: 'https://github.com/acme/tools.git',
    role: 'root',
    currentSha: 'tools-old-sha',
  },
];

function installations(
  scopes: SkillUpdateScope[] = ['project', 'project'],
): SkillUpdateInstallation[] {
  return nodes.map((node, index) => ({
    id: `${scopes[index]}:${index}`,
    scope: scopes[index]!,
    configIndex: index,
    rawSource: index === 0 ? 'acme/skills' : 'acme/tools',
    effectiveSource: index === 0 ? 'acme/skills' : 'acme/tools',
    pluginName: index === 0 ? 'skills' : 'tools',
    rootNodeId: node.id,
    rootSubpath: '',
    nodes: [node],
    skills: [
      {
        name: index === 0 ? 'skill' : 'tool',
        subpath: index === 0 ? 'skill' : 'tool',
        enabled: true,
      },
    ],
  }));
}

function inspectionFor(unit: {
  nodes: CheckoutNode[];
  installations: SkillUpdateInstallation[];
}): UnitInspection {
  const node = unit.nodes[0]!;
  const installation = unit.installations[0]!;
  return {
    outcome: 'resolved',
    nodes: [{ nodeId: node.id, sha: `${node.id}-new` }],
    installations: [
      {
        installationId: installation.id,
        outcome: 'resolved',
        skills: installation.skills.map(({ name, subpath }) => ({
          name,
          subpath,
        })),
      },
    ],
  };
}

async function twoUnitPlan(
  scopes?: SkillUpdateScope[],
): Promise<SkillUpdatePreflight> {
  const entries = installations(scopes);
  return buildSkillUpdatePreflight(
    {
      installations: entries,
      selectedScopes: [...new Set(scopes ?? ['project'])],
    },
    { inspectUnit: async (unit) => inspectionFor(unit) },
  );
}

describe('skill update progress observers', () => {
  it('reports check, apply, and result observers in sequential unit order', async () => {
    const entries = installations();
    const events: string[] = [];
    const firstInspection = Promise.withResolvers<UnitInspection>();
    const secondInspection = Promise.withResolvers<UnitInspection>();
    const secondCheckStarted = Promise.withResolvers<void>();
    const preflight = buildSkillUpdatePreflight(
      { installations: entries, selectedScopes: ['project'] },
      {
        onUnitCheckStart: (unit) => {
          events.push(`check:${unit.id}`);
          if (unit.id === nodes[1]!.id) secondCheckStarted.resolve();
        },
        inspectUnit: (unit) => {
          events.push(`inspect:${unit.id}`);
          return unit.id === nodes[0]!.id
            ? firstInspection.promise
            : secondInspection.promise;
        },
      },
    );

    expect(events).toEqual([
      `check:${nodes[0]!.id}`,
      `inspect:${nodes[0]!.id}`,
    ]);
    firstInspection.resolve(
      inspectionFor({ nodes: [nodes[0]!], installations: [entries[0]!] }),
    );
    await secondCheckStarted.promise;
    expect(events).toEqual([
      `check:${nodes[0]!.id}`,
      `inspect:${nodes[0]!.id}`,
      `check:${nodes[1]!.id}`,
      `inspect:${nodes[1]!.id}`,
    ]);
    secondInspection.resolve(
      inspectionFor({ nodes: [nodes[1]!], installations: [entries[1]!] }),
    );
    const plan = await preflight;

    const firstExecutionStarted = Promise.withResolvers<void>();
    const secondExecutionStarted = Promise.withResolvers<void>();
    const releaseFirstExecution = Promise.withResolvers<void>();
    const releaseSecondExecution = Promise.withResolvers<void>();
    const execution = executeSkillUpdatePlan(plan, {}, {
      reconcileUnit: async (unit) => {
        events.push(`execute:${unit.id}`);
        const first = unit.id === nodes[0]!.id;
        (first ? firstExecutionStarted : secondExecutionStarted).resolve();
        await (first
          ? releaseFirstExecution.promise
          : releaseSecondExecution.promise);
        return { commit: async () => {}, rollback: async () => {} };
      },
      advanceNode: async () => {},
      restoreNode: async () => {},
      syncScope: async () => ({ success: true }),
      onUnitApplyStart: (unit) => events.push(`apply:${unit.id}`),
      onUnitResult: (result) =>
        events.push(`result:${result.id}:${result.status}`),
    });

    await firstExecutionStarted.promise;
    expect(events.slice(4)).toEqual([
      `apply:${nodes[0]!.id}`,
      `execute:${nodes[0]!.id}`,
    ]);
    releaseFirstExecution.resolve();
    await secondExecutionStarted.promise;
    expect(events.slice(4)).toEqual([
      `apply:${nodes[0]!.id}`,
      `execute:${nodes[0]!.id}`,
      `result:${nodes[0]!.id}:updated`,
      `apply:${nodes[1]!.id}`,
      `execute:${nodes[1]!.id}`,
    ]);
    releaseSecondExecution.resolve();
    await execution;
    expect(events.slice(4)).toEqual([
      `apply:${nodes[0]!.id}`,
      `execute:${nodes[0]!.id}`,
      `result:${nodes[0]!.id}:updated`,
      `apply:${nodes[1]!.id}`,
      `execute:${nodes[1]!.id}`,
      `result:${nodes[1]!.id}:updated`,
    ]);
  });

  it('does not check or inspect remote preflight for unmatched filters', async () => {
    const onUnitCheckStart = mock(() => {});
    const inspectUnit = mock(async (unit) => inspectionFor(unit));

    const result = await buildSkillUpdatePreflight(
      {
        installations: installations().slice(0, 1),
        selectedScopes: ['project'],
        filters: ['missing'],
      },
      { inspectUnit, onUnitCheckStart },
    );

    expect(result.units).toEqual([]);
    expect(onUnitCheckStart).not.toHaveBeenCalled();
    expect(inspectUnit).not.toHaveBeenCalled();
  });

  it('continues preflight when a check observer throws', async () => {
    const inspected: string[] = [];

    const result = await buildSkillUpdatePreflight(
      { installations: installations(), selectedScopes: ['project'] },
      {
        onUnitCheckStart: () => {
          throw new Error('observer failed');
        },
        inspectUnit: async (unit) => {
          inspected.push(unit.id);
          return inspectionFor(unit);
        },
      },
    );

    expect(inspected).toEqual(nodes.map((node) => node.id));
    expect(result.units.map((unit) => unit.id)).toEqual(
      nodes.map((node) => node.id),
    );
    expect(result.units.every((unit) => unit.outcome === 'resolved')).toBe(true);
  });

  it('does not announce apply work for a retained deletion', async () => {
    const entry = installations().slice(0, 1);
    const plan = await buildSkillUpdatePreflight(
      { installations: entry, selectedScopes: ['project'] },
      {
        inspectUnit: async (unit) => ({
          outcome: 'resolved',
          nodes: [{ nodeId: unit.nodes[0]!.id, sha: 'new-sha' }],
          installations: [
            {
              installationId: unit.installations[0]!.id,
              outcome: 'resolved',
              skills: [],
            },
          ],
        }),
      },
    );
    const onUnitApplyStart = mock(() => {});

    const result = await executeSkillUpdatePlan(
      plan,
      { [plan.units[0]!.id]: 'retain' },
      {
        reconcileUnit: async () => ({
          commit: async () => {},
          rollback: async () => {},
        }),
        advanceNode: async () => {},
        restoreNode: async () => {},
        syncScope: async () => ({ success: true }),
        onUnitApplyStart,
      },
    );

    expect(onUnitApplyStart).not.toHaveBeenCalled();
    expect(result.units[0]?.status).toBe('retained');
  });

  it('does not roll back a committed unit or stop later units when a result observer throws', async () => {
    const plan = await twoUnitPlan();
    const commits: string[] = [];
    const rollbacks: string[] = [];

    const result = await executeSkillUpdatePlan(plan, {}, {
      reconcileUnit: async (unit) => ({
        commit: async () => {
          commits.push(unit.id);
        },
        rollback: async () => {
          rollbacks.push(unit.id);
        },
      }),
      advanceNode: async () => {},
      restoreNode: async () => {},
      syncScope: async () => ({ success: true }),
      onUnitResult: () => {
        throw new Error('observer failed');
      },
    });

    expect(commits).toEqual(nodes.map((node) => node.id));
    expect(rollbacks).toEqual([]);
    expect(result.units.map(({ id, status }) => ({ id, status }))).toEqual(
      nodes.map((node) => ({ id: node.id, status: 'updated' })),
    );
  });

  it('preserves sync failures and continues later scopes when a result observer throws', async () => {
    const plan = await twoUnitPlan(['project', 'user']);
    const synced: SkillUpdateScope[] = [];

    const result = await executeSkillUpdatePlan(plan, {}, {
      reconcileUnit: async () => ({
        commit: async () => {},
        rollback: async () => {},
      }),
      advanceNode: async () => {},
      restoreNode: async () => {},
      syncScope: async (scope) => {
        synced.push(scope);
        return scope === 'project'
          ? { success: false, error: 'project sync failed' }
          : { success: true };
      },
      onUnitResult: () => {
        throw new Error('observer failed');
      },
    });

    expect(synced).toEqual(['project', 'user']);
    expect(result.syncedScopes).toEqual(['user']);
    expect(result.units).toEqual([
      {
        id: nodes[0]!.id,
        status: 'updated',
        skillCounts: { updated: 1, removed: 0, retained: 0 },
      },
      {
        id: nodes[1]!.id,
        status: 'updated',
        skillCounts: { updated: 1, removed: 0, retained: 0 },
      },
      {
        id: 'sync:project',
        status: 'failed',
        skillCounts: { updated: 0, removed: 0, retained: 0 },
        error: 'project sync failed',
      },
    ]);
  });
});
