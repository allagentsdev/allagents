import { afterEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import {
  buildSkillUpdateInventory,
  inspectSkillUpdateUnit,
  moveSkillUpdateCheckout,
  normalizeSkillUpdateScopes,
  prepareSkillUpdate,
  resolveNonInteractiveSkillUpdateDecisions,
  skillUpdateExitCode,
  skillUpdateSummary,
} from '../../../src/cli/skill-update.js';
import {
  executeSkillUpdatePlan,
  type SkillUpdatePreflight,
} from '../../../src/core/skill-update.js';
import { getPluginCachePath, parseRemotePluginSource } from '../../../src/utils/plugin-path.js';

const originalTestHome = process.env.ALLAGENTS_TEST_HOME;

afterEach(() => {
  if (originalTestHome === undefined) delete process.env.ALLAGENTS_TEST_HOME;
  else process.env.ALLAGENTS_TEST_HOME = originalTestHome;
});

function runGit(path: string, args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', path, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed in ${path}: ${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout.toString().trim();
}

async function initCheckout(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  runGit(path, ['init']);
  runGit(path, ['config', '--local', 'user.name', 'Skill Update Test']);
  runGit(path, [
    'config',
    '--local',
    'user.email',
    'skill-update@example.test',
  ]);
  runGit(path, ['add', '.']);
  runGit(path, ['commit', '-m', 'fixture']);
}

describe('skill update command adapters', () => {
  test('creates git fixtures without depending on the simple-git module', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allagents-skill-update-git-'));
    try {
      await writeFile(join(root, 'fixture.txt'), 'fixture');
      await initCheckout(root);

      expect(runGit(root, ['rev-parse', '--is-inside-work-tree'])).toBe('true');
      expect(runGit(root, ['log', '-1', '--format=%s'])).toBe('fixture');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('inventories a generic object ref without sharing its default checkout or native declaration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allagents-generic-inventory-'));
    process.env.ALLAGENTS_TEST_HOME = join(root, 'home');
    const workspace = join(root, 'workspace');
    const source = 'alice@forgejo.example:team/collection.git#subdir=selected';
    const remote = parseRemotePluginSource(`${source}&ref=feature%2Fdemo`)!;
    try {
      await mkdir(join(remote.cachePath, 'selected', 'skills', 'keep'), { recursive: true });
      await writeFile(join(remote.cachePath, 'selected', 'skills', 'keep', 'SKILL.md'), '# Keep');
      await initCheckout(remote.cachePath);
      await mkdir(join(workspace, '.allagents'), { recursive: true });
      await writeFile(join(workspace, '.allagents', 'workspace.yaml'), dump({ version: 2, repositories: [], clients: ['codex', 'pi'], plugins: [{ source, ref: 'feature/demo', install: 'file', clients: ['codex'] }, { source, install: 'native', clients: ['pi'] }] }));
      const inventory = await buildSkillUpdateInventory(workspace, ['project']);
      expect(inventory.failures).toEqual([]);
      expect(inventory.installations).toHaveLength(1);
      expect(inventory.installations[0]).toMatchObject({ rawSource: source, pluginName: 'selected', rootSubpath: 'selected', skills: [{ name: 'keep', enabled: true }] });
      expect(inventory.installations[0]?.nodes[0]).toMatchObject({ cachePath: remote.cachePath, remoteUrl: 'alice@forgejo.example:team/collection.git', ref: 'feature/demo' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test('normalizes project, user, and all scopes', () => {
    expect(normalizeSkillUpdateScopes('project')).toEqual(['project']);
    expect(normalizeSkillUpdateScopes('user')).toEqual(['user']);
    expect(normalizeSkillUpdateScopes('all')).toEqual([
      'project',
      'user',
    ]);
    expect(normalizeSkillUpdateScopes(undefined)).toEqual(['project']);
  });

  test('prechecks each healthy equal inventory node without exact inspection', async () => {
    const node = {
      id: '/cache/acme-skills',
      cachePath: '/cache/acme-skills',
      remoteUrl: 'https://github.com/acme/skills.git',
      role: 'root' as const,
      currentSha: 'old-sha',
    };
    const inspectUnit = mock(async () => {
      throw new Error('exact inspection should not run');
    });
    const resolveRemoteRevision = mock(async () => ({
      status: 'resolved' as const,
      commit: node.currentSha,
      ref: 'main',
    }));
    const checkRepositoryHealth = mock(async () => ({
      status: 'healthy' as const,
      head: node.currentSha,
      ref: 'main',
    }));
    const domainRootsReadable = mock(async () => true);

    const prepared = await prepareSkillUpdate(
      { workspacePath: '/workspace', scopes: ['project'] },
      {
        buildInventory: async () => ({
          installations: [
            {
              id: 'project:0',
              scope: 'project',
              configIndex: 0,
              rawSource: 'acme/skills',
              effectiveSource: 'acme/skills',
              pluginName: 'skills',
              rootNodeId: node.id,
              rootSubpath: '',
              nodes: [node],
              skills: [{ name: 'keep', subpath: 'keep', enabled: true }],
            },
          ],
          skippedLocalSources: [],
          failures: [],
          directRemoteConsumers: [],
        }),
        inspectUnit,
        resolveRemoteRevision,
        checkRepositoryHealth,
        domainRootsReadable,
      },
    );

    expect(resolveRemoteRevision).toHaveBeenCalledTimes(1);
    expect(checkRepositoryHealth).toHaveBeenCalledTimes(1);
    expect(domainRootsReadable).toHaveBeenCalledTimes(1);
    expect(inspectUnit).not.toHaveBeenCalled();
    expect(prepared.plan.units[0]).toMatchObject({
      outcome: 'resolved',
      safeToBypassTransaction: true,
      deleted: [],
    });
  });

  test('falls back to exact inspection when an inventory-represented root is unreadable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allagents-skill-precheck-'));
    const node = {
      id: root,
      cachePath: root,
      remoteUrl: 'https://github.com/acme/skills.git',
      role: 'root' as const,
      currentSha: 'old-sha',
    };
    const inspectUnit = mock(async () => ({
      outcome: 'resolved' as const,
      nodes: [{ nodeId: node.id, sha: node.currentSha }],
      installations: [
        {
          installationId: 'project:0',
          outcome: 'resolved' as const,
          skills: [{ name: 'keep', subpath: 'keep' }],
        },
      ],
    }));
    try {
      const prepared = await prepareSkillUpdate(
        { workspacePath: '/workspace', scopes: ['project'] },
        {
          buildInventory: async () => ({
            installations: [
              {
                id: 'project:0',
                scope: 'project',
                configIndex: 0,
                rawSource: 'acme/skills',
                effectiveSource: 'acme/skills',
                pluginName: 'skills',
                rootNodeId: node.id,
                rootSubpath: 'missing',
                nodes: [node],
                skills: [{ name: 'keep', subpath: 'keep', enabled: true }],
              },
            ],
            skippedLocalSources: [],
            failures: [],
            directRemoteConsumers: [],
          }),
          inspectUnit,
          resolveRemoteRevision: async () => ({
            status: 'resolved',
            commit: node.currentSha,
            ref: 'main',
          }),
          checkRepositoryHealth: async () => ({
            status: 'healthy',
            head: node.currentSha,
            ref: 'main',
          }),
        },
      );

      expect(inspectUnit).toHaveBeenCalledTimes(1);
      expect(prepared.plan.units[0]?.safeToBypassTransaction).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('retains deletion units in every non-interactive mode, including --yes', () => {
    const plan = {
      selectedScopes: ['project'],
      units: [
        {
          id: 'deleted-cache',
          nodes: [],
          installations: [],
          outcome: 'resolved',
          inspectedNodes: [],
          deleted: [
            {
              name: 'gone',
              subpath: 'gone',
              enabled: true,
              installationId: 'project:0',
              scope: 'project',
              pluginName: 'skills',
              source: 'acme/skills',
            },
          ],
          survivors: [],
          removedInstallationIds: [],
          blockedByOutOfScope: false,
        },
        {
          id: 'healthy-cache',
          nodes: [],
          installations: [],
          outcome: 'resolved',
          inspectedNodes: [],
          deleted: [],
          survivors: [],
          removedInstallationIds: [],
          blockedByOutOfScope: false,
        },
      ],
    } satisfies SkillUpdatePreflight;

    expect(resolveNonInteractiveSkillUpdateDecisions(plan)).toEqual({
      'deleted-cache': 'retain',
    });
    expect(resolveNonInteractiveSkillUpdateDecisions(plan)).toEqual({
      'deleted-cache': 'retain',
    });
  });

  test('summarizes skill impacts while retaining physical-unit status details', async () => {
    const skills = Array.from({ length: 7 }, (_, index) => ({
      name: `skill-${index + 1}`,
      subpath: `skill-${index + 1}`,
      enabled: true,
    }));
    const plan = {
      selectedScopes: ['project'],
      units: [
        {
          id: 'seven-skill-cache',
          nodes: [],
          installations: [],
          outcome: 'resolved',
          inspectedNodes: [],
          deleted: skills.slice(5).map((skill) => ({
            ...skill,
            installationId: 'project:0',
            scope: 'project',
            pluginName: 'skills',
            source: 'acme/skills',
          })),
          survivors: skills.slice(0, 5).map((skill) => ({
            ...skill,
            installationId: 'project:0',
            scope: 'project',
            pluginName: 'skills',
            source: 'acme/skills',
          })),
          removedInstallationIds: [],
          blockedByOutOfScope: false,
        },
      ],
    } satisfies SkillUpdatePreflight;
    const result = await executeSkillUpdatePlan(
      plan,
      { 'seven-skill-cache': 'remove' },
      {
        advanceNode: async () => {},
        restoreNode: async () => {},
        reconcileUnit: async () => ({
          commit: async () => {},
          rollback: async () => {},
        }),
        syncScope: async () => ({ success: true }),
      },
    );

    expect(result.units).toEqual([
      {
        id: 'seven-skill-cache',
        status: 'removed',
        skillCounts: { updated: 5, removed: 2, retained: 0 },
      },
    ]);
    expect(skillUpdateSummary(result)).toEqual({
      updated: 5,
      removed: 2,
      retained: 0,
      skipped: 0,
      failed: 0,
      cancelled: 0,
    });
  });

  test('reports retained skill and skipped-source totals for non-interactive deletion safety', async () => {
    const plan = {
      selectedScopes: ['project'],
      units: [
        {
          id: 'deleted-cache',
          nodes: [],
          installations: [],
          outcome: 'resolved',
          inspectedNodes: [],
          deleted: ['gone-a', 'gone-b'].map((subpath) => ({
            name: subpath,
            subpath,
            enabled: true,
            installationId: 'project:0',
            scope: 'project',
            pluginName: 'skills',
            source: 'acme/skills',
          })),
          survivors: [],
          removedInstallationIds: [],
          blockedByOutOfScope: false,
        },
      ],
    } satisfies SkillUpdatePreflight;
    const result = await executeSkillUpdatePlan(
      plan,
      resolveNonInteractiveSkillUpdateDecisions(plan),
      {
        advanceNode: async () => {
          throw new Error('retained sources must not advance');
        },
        restoreNode: async () => {},
        reconcileUnit: async () => {
          throw new Error('retained sources must not reconcile');
        },
        syncScope: async () => ({ success: true }),
      },
    );

    expect(skillUpdateSummary(result)).toMatchObject({
      retained: 2,
      skipped: 1,
    });
  });

  test('maps cancellation to success false with exit zero', () => {
    expect(
      skillUpdateExitCode({
        success: false,
        cancelled: true,
        units: [],
        syncedScopes: [],
      }),
    ).toBe(0);
    expect(
      skillUpdateExitCode({
        success: false,
        cancelled: false,
        units: [],
        syncedScopes: [],
      }),
    ).toBe(1);
  });

  test('builds one connected marketplace graph for embedded and external plugins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allagents-skill-update-inventory-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    const marketplace = join(home, '.allagents/plugins/marketplaces/catalog');
    process.env.ALLAGENTS_TEST_HOME = home;

    try {
      const external = getPluginCachePath('acme', 'external-skills');
      await mkdir(join(workspace, '.allagents'), { recursive: true });
      await mkdir(join(home, '.allagents'), { recursive: true });
      await mkdir(join(marketplace, '.claude-plugin'), { recursive: true });
      await mkdir(join(marketplace, 'plugins/embedded/skills/inside'), {
        recursive: true,
      });
      await mkdir(join(external, 'skills/outside'), { recursive: true });
      await writeFile(
        join(marketplace, 'plugins/embedded/skills/inside/SKILL.md'),
        '---\nname: inside\ndescription: embedded\n---\n',
      );
      await writeFile(
        join(external, 'skills/outside/SKILL.md'),
        '---\nname: outside\ndescription: external\n---\n',
      );
      await writeFile(
        join(marketplace, '.claude-plugin/marketplace.json'),
        JSON.stringify({
          name: 'catalog',
          description: 'test catalog',
          plugins: [
            {
              name: 'embedded',
              description: 'embedded plugin',
              source: './plugins/embedded',
            },
            {
              name: 'external',
              description: 'external plugin',
              source: {
                source: 'url',
                url: 'https://github.com/acme/external-skills',
              },
            },
          ],
        }),
      );
      await initCheckout(marketplace);
      await initCheckout(external);
      await writeFile(
        join(home, '.allagents/marketplaces.json'),
        JSON.stringify({
          version: 1,
          marketplaces: {
            catalog: {
              name: 'catalog',
              source: { type: 'github', location: 'acme/catalog' },
              path: marketplace,
            },
          },
        }),
      );
      await writeFile(
        join(workspace, '.allagents/workspace.yaml'),
        dump({
          version: 2,
          repositories: [],
          clients: ['copilot'],
          plugins: ['embedded@catalog', 'external@catalog'],
        }),
      );

      const inventory = await buildSkillUpdateInventory(workspace);

      expect(inventory.installations).toHaveLength(2);
      const embedded = inventory.installations.find(
        (entry) => entry.pluginName === 'embedded',
      );
      const externalEntry = inventory.installations.find(
        (entry) => entry.pluginName === 'external',
      );
      expect(embedded?.nodes.map((node) => node.id)).toEqual([marketplace]);
      expect(externalEntry?.nodes.map((node) => node.id)).toEqual([
        external,
        marketplace,
      ]);
      expect(externalEntry?.nodes[0]?.role).toBe('dependency');
      expect(embedded?.marketplace?.nodeId).toBe(marketplace);
      expect(externalEntry?.marketplace?.nodeId).toBe(marketplace);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('classifies a plugin absent from a valid inspected marketplace as removed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allagents-skill-update-removed-'));
    try {
      await mkdir(join(root, '.claude-plugin'), { recursive: true });
      await writeFile(
        join(root, '.claude-plugin/marketplace.json'),
        JSON.stringify({
          name: 'catalog',
          description: 'test catalog',
          plugins: [],
        }),
      );
      await initCheckout(root);
      const sha = runGit(root, ['rev-parse', 'HEAD']);
      const result = await inspectSkillUpdateUnit({
        id: root,
        nodes: [
          {
            id: root,
            cachePath: root,
            remoteUrl: root,
            role: 'root',
            currentSha: sha,
          },
        ],
        installations: [
          {
            id: 'project:0',
            scope: 'project',
            configIndex: 0,
            rawSource: 'gone@catalog',
            effectiveSource: 'gone@catalog',
            pluginName: 'gone',
            rootNodeId: root,
            rootSubpath: 'plugins/gone',
            nodes: [],
            skills: [{ name: 'gone', subpath: 'gone', enabled: true }],
            marketplace: { nodeId: root, pluginName: 'gone' },
          },
        ],
      });

      expect(result.outcome).toBe('resolved');
      expect(result.installations).toEqual([
        { installationId: 'project:0', outcome: 'plugin-removed' },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not fetch an obsolete external dependency after its marketplace entry is removed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allagents-skill-update-obsolete-'));
    try {
      await mkdir(join(root, '.claude-plugin'), { recursive: true });
      await writeFile(
        join(root, '.claude-plugin/marketplace.json'),
        JSON.stringify({ name: 'catalog', description: 'test', plugins: [] }),
      );
      await initCheckout(root);
      const sha = runGit(root, ['rev-parse', 'HEAD']);
      const missing = join(root, 'missing-dependency.git');
      const result = await inspectSkillUpdateUnit({
        id: root,
        nodes: [
          {
            id: missing,
            cachePath: missing,
            remoteUrl: missing,
            role: 'dependency',
            currentSha: 'old',
          },
          {
            id: root,
            cachePath: root,
            remoteUrl: root,
            role: 'root',
            currentSha: sha,
          },
        ],
        installations: [
          {
            id: 'project:0',
            scope: 'project',
            configIndex: 0,
            rawSource: 'gone@catalog',
            effectiveSource: 'gone@catalog',
            pluginName: 'gone',
            rootNodeId: missing,
            rootSubpath: '',
            nodes: [],
            skills: [{ name: 'gone', subpath: 'gone', enabled: true }],
            marketplace: { nodeId: root, pluginName: 'gone' },
          },
        ],
      });

      expect(result.outcome).toBe('resolved');
      expect(result.nodes).toEqual([{ nodeId: root, sha }]);
      expect(result.installations[0]?.outcome).toBe('plugin-removed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('records a selected inventory failure while preserving healthy independent units', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allagents-skill-update-failures-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    process.env.ALLAGENTS_TEST_HOME = home;
    try {
      const healthy = getPluginCachePath('acme', 'healthy-skills');
      await mkdir(join(healthy, 'skills/keep'), { recursive: true });
      await writeFile(
        join(healthy, 'skills/keep/SKILL.md'),
        '---\nname: keep\ndescription: keep\n---\n',
      );
      await initCheckout(healthy);
      await mkdir(join(workspace, '.allagents'), { recursive: true });
      await writeFile(
        join(workspace, '.allagents/workspace.yaml'),
        dump({
          version: 2,
          repositories: [],
          clients: ['copilot'],
          plugins: ['acme/healthy-skills', 'acme/missing-skills'],
        }),
      );

      const inventory = await buildSkillUpdateInventory(workspace, ['project']);

      expect(inventory.installations.map((entry) => entry.rawSource)).toEqual([
        'acme/healthy-skills',
      ]);
      expect(inventory.failures).toHaveLength(1);
      expect(inventory.failures[0]).toMatchObject({
        scope: 'project',
        source: 'acme/missing-skills',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rejects a remote marketplace registry path outside the managed cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allagents-skill-update-registry-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside-marketplace');
    process.env.ALLAGENTS_TEST_HOME = home;
    try {
      await mkdir(join(outside, '.claude-plugin'), { recursive: true });
      await writeFile(
        join(outside, '.claude-plugin/marketplace.json'),
        JSON.stringify({ name: 'catalog', description: 'test', plugins: [] }),
      );
      await initCheckout(outside);
      await mkdir(join(home, '.allagents'), { recursive: true });
      await mkdir(join(workspace, '.allagents'), { recursive: true });
      await writeFile(
        join(home, '.allagents/marketplaces.json'),
        JSON.stringify({
          version: 1,
          marketplaces: {
            catalog: {
              name: 'catalog',
              source: { type: 'github', location: 'acme/catalog' },
              path: outside,
            },
          },
        }),
      );
      await writeFile(
        join(workspace, '.allagents/workspace.yaml'),
        dump({
          version: 2,
          repositories: [],
          clients: ['copilot'],
          plugins: ['gone@catalog'],
        }),
      );

      const inventory = await buildSkillUpdateInventory(workspace, ['project']);

      expect(inventory.installations).toEqual([]);
      expect(inventory.failures[0]?.error).toContain('managed cache');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('verifies origin before resetting and falls back to the inspected SHA when the ref is gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allagents-skill-update-move-'));
    const remote = join(root, 'remote.git');
    const work = join(root, 'work');
    const cache = join(root, 'cache');
    try {
      await mkdir(remote, { recursive: true });
      runGit(remote, ['init', '--bare', '--initial-branch=main']);
      runGit(root, ['clone', remote, work]);
      runGit(work, ['config', '--local', 'user.name', 'Skill Update Test']);
      runGit(work, [
        'config',
        '--local',
        'user.email',
        'skill-update@example.test',
      ]);
      await writeFile(join(work, 'SKILL.md'), 'first');
      runGit(work, ['add', '.']);
      runGit(work, ['commit', '-m', 'first']);
      runGit(work, ['push', 'origin', 'main']);
      const sha = runGit(work, ['rev-parse', 'HEAD']);
      runGit(root, ['clone', remote, cache]);

      await expect(
        moveSkillUpdateCheckout(
          {
            id: cache,
            cachePath: cache,
            remoteUrl: join(root, 'different.git'),
            ref: 'deleted-ref',
            role: 'root',
            currentSha: sha,
          },
          sha,
        ),
      ).rejects.toThrow('origin');

      await moveSkillUpdateCheckout(
        {
          id: cache,
          cachePath: cache,
          remoteUrl: remote,
          ref: 'deleted-ref',
          role: 'root',
          currentSha: sha,
        },
        sha,
      );
      expect(runGit(cache, ['rev-parse', 'HEAD'])).toBe(sha);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('ignores an unrelated broken user cache during a project-only inventory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allagents-skill-update-scope-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    process.env.ALLAGENTS_TEST_HOME = home;
    try {
      const projectCache = getPluginCachePath('acme', 'project-skills');
      await mkdir(join(projectCache, 'skills/keep'), { recursive: true });
      await writeFile(
        join(projectCache, 'skills/keep/SKILL.md'),
        '---\nname: keep\ndescription: keep\n---\n',
      );
      await initCheckout(projectCache);
      await mkdir(join(workspace, '.allagents'), { recursive: true });
      await mkdir(join(home, '.allagents'), { recursive: true });
      await writeFile(
        join(workspace, '.allagents/workspace.yaml'),
        dump({
          version: 2,
          repositories: [],
          clients: ['copilot'],
          plugins: ['acme/project-skills'],
        }),
      );
      await writeFile(
        join(home, '.allagents/workspace.yaml'),
        dump({
          version: 2,
          repositories: [],
          clients: ['codex'],
          plugins: ['unrelated/missing-skills'],
        }),
      );

      const inventory = await buildSkillUpdateInventory(workspace, [
        'project',
      ]);

      expect(inventory.installations).toHaveLength(1);
      expect(inventory.installations[0]?.scope).toBe('project');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('inventories a direct GitHub source with an inline ref instead of treating it as a marketplace spec', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allagents-skill-update-ref-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    process.env.ALLAGENTS_TEST_HOME = home;
    try {
      const cache = getPluginCachePath('acme', 'ref-skills', 'v2');
      await mkdir(join(cache, 'skills/keep'), { recursive: true });
      await writeFile(
        join(cache, 'skills/keep/SKILL.md'),
        '---\nname: keep\ndescription: keep\n---\n',
      );
      await initCheckout(cache);
      await mkdir(join(workspace, '.allagents'), { recursive: true });
      await writeFile(
        join(workspace, '.allagents/workspace.yaml'),
        dump({
          version: 2,
          repositories: [],
          clients: ['copilot'],
          plugins: ['acme/ref-skills@v2'],
        }),
      );

      const inventory = await buildSkillUpdateInventory(workspace, [
        'project',
      ]);

      expect(inventory.installations).toHaveLength(1);
      expect(inventory.installations[0]?.rawSource).toBe(
        'acme/ref-skills@v2',
      );
      expect(inventory.installations[0]?.nodes[0]?.ref).toBe('v2');
      expect(inventory.installations[0]?.marketplace).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
