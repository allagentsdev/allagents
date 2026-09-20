import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  InstallTargetValidationError,
  resolveInstallTarget,
  type InstallTargetPromptPort,
  type ResolveInstallTargetOptions,
} from '../../../src/cli/install-target.js';

const originalTestHome = process.env.ALLAGENTS_TEST_HOME;
const workspacePath = '/tmp/allagents-install-target/project';

type PromptCalls = {
  scopes: Parameters<InstallTargetPromptPort['selectScope']>[0][];
  clients: Parameters<InstallTargetPromptPort['selectClients']>[0][];
  summaries: Parameters<InstallTargetPromptPort['showSummary']>[0][];
  confirmations: Parameters<InstallTargetPromptPort['confirm']>[0][];
};

function promptPort(
  calls: PromptCalls,
  selections: { scope?: 'project' | 'user' | null; clients?: readonly (readonly string[] | null)[] } = {},
): InstallTargetPromptPort {
  let clientSelection = 0;
  return {
    async selectScope(request) {
      calls.scopes.push(request);
      return selections.scope === undefined ? 'project' : selections.scope;
    },
    async selectClients(request) {
      calls.clients.push(request);
      return selections.clients?.[clientSelection++] ?? ['universal'];
    },
    showSummary(summary) {
      calls.summaries.push(summary);
    },
    async confirm(request) {
      calls.confirmations.push(request);
      return true;
    },
  };
}

function makeCalls(): PromptCalls {
  return { scopes: [], clients: [], summaries: [], confirmations: [] };
}

function options(
  overrides: Partial<ResolveInstallTargetOptions> = {},
): ResolveInstallTargetOptions {
  return {
    workspacePath,
    declaration: 'acme/plugin',
    action: 'Install plugin',
    payload: 'acme/plugin',
    scopeStates: {
      project: { clients: ['universal', 'claude'] },
      user: { clients: ['copilot', 'codex'] },
    },
    environment: {
      json: false,
      ci: false,
      stdinIsTTY: true,
      stdoutIsTTY: true,
    },
    ...overrides,
  };
}

beforeEach(() => {
  process.env.ALLAGENTS_TEST_HOME = '/tmp/allagents-install-target/home';
});

afterEach(() => {
  if (originalTestHome === undefined) delete process.env.ALLAGENTS_TEST_HOME;
  else process.env.ALLAGENTS_TEST_HOME = originalTestHome;
});

describe('resolveInstallTarget', () => {
  test('explicit scope and clients win and clients are deduplicated in canonical order', async () => {
    const calls = makeCalls();
    const result = await resolveInstallTarget(
      options({
        scope: 'user',
        clients: 'codex,copilot,codex',
        yes: true,
        prompts: promptPort(calls),
      }),
    );

    expect(result).not.toBeNull();
    expect(result?.scope).toBe('user');
    expect(result?.clients).toEqual(['copilot', 'codex']);
    expect(result?.configPath).toBe(
      '/tmp/allagents-install-target/home/.allagents/workspace.yaml',
    );
    expect(calls.scopes).toHaveLength(0);
    expect(calls.clients).toHaveLength(0);
    expect(calls.summaries).toHaveLength(1);
    expect(calls.confirmations).toHaveLength(0);
  });

  test('canonicalizes aliases and rejects project-only clients at user scope', async () => {
    const aliased = await resolveInstallTarget(
      options({
        scope: 'project',
        clients: 'claude-code,claude,droid',
        yes: true,
        prompts: promptPort(makeCalls()),
      }),
    );
    expect(aliased?.clients).toEqual(['claude', 'factory']);

    await expect(
      resolveInstallTarget(
        options({
          scope: 'user',
          clients: 'eve',
          yes: true,
          prompts: promptPort(makeCalls()),
        }),
      ),
    ).rejects.toThrow('User scope is unavailable for: eve');
  });

  test('loads only the explicitly selected scope state', async () => {
    let projectLoads = 0;
    let userLoads = 0;
    const project = await resolveInstallTarget(
      options({
        scope: 'project',
        clients: ['universal'],
        yes: true,
        environment: {
          json: true,
          ci: false,
          stdinIsTTY: true,
          stdoutIsTTY: true,
        },
        scopeStates: {
          project: async () => {
            projectLoads += 1;
            return { clients: ['universal'], plugins: [] };
          },
          user: async () => {
            userLoads += 1;
            throw new Error('user config must not be loaded');
          },
        },
      }),
    );

    expect(project?.scope).toBe('project');
    expect(projectLoads).toBe(1);
    expect(userLoads).toBe(0);

    const user = await resolveInstallTarget(
      options({
        scope: 'user',
        clients: ['codex'],
        yes: true,
        environment: {
          json: true,
          ci: false,
          stdinIsTTY: true,
          stdoutIsTTY: true,
        },
        scopeStates: {
          project: async () => {
            projectLoads += 1;
            throw new Error('project config must not be loaded');
          },
          user: async () => {
            userLoads += 1;
            return { clients: ['codex'], plugins: [] };
          },
        },
      }),
    );

    expect(user?.scope).toBe('user');
    expect(projectLoads).toBe(1);
    expect(userLoads).toBe(1);
  });

  test('uses interactive selections before configured defaults', async () => {
    const calls = makeCalls();
    const result = await resolveInstallTarget(
      options({
        yes: true,
        prompts: promptPort(calls, { scope: 'user', clients: [['cursor']] }),
      }),
    );

    expect(result?.scope).toBe('user');
    expect(result?.clients).toEqual(['cursor']);
    expect(calls.clients[0]?.initialValues).toEqual(['copilot', 'codex']);
  });

  test('uses the selected scope first-config defaults as initial values', async () => {
    const calls = makeCalls();
    await resolveInstallTarget(
      options({
        scopeStates: { project: null, user: null },
        yes: true,
        prompts: promptPort(calls, { scope: 'user', clients: [['vscode']] }),
      }),
    );

    expect(calls.clients[0]?.initialValues).toEqual([
      'copilot',
      'codex',
      'cursor',
      'opencode',
      'gemini',
      'vscode',
    ]);
  });

  test('asks again after an empty interactive client selection', async () => {
    const calls = makeCalls();
    const result = await resolveInstallTarget(
      options({
        yes: true,
        prompts: promptPort(calls, {
          scope: 'project',
          clients: [[], ['claude']],
        }),
      }),
    );

    expect(calls.clients).toHaveLength(2);
    expect(result?.clients).toEqual(['claude']);
  });

  test('rejects invalid and empty explicit clients', async () => {
    await expect(
      resolveInstallTarget(options({ clients: 'unknown', yes: true })),
    ).rejects.toBeInstanceOf(InstallTargetValidationError);
    await expect(
      resolveInstallTarget(options({ clients: '', yes: true })),
    ).rejects.toBeInstanceOf(InstallTargetValidationError);
  });

  test('reports initialize, inherit, and override declarations without mutation', async () => {
    const environment = {
      json: true,
      ci: false,
      stdinIsTTY: true,
      stdoutIsTTY: true,
    };
    const initialize = await resolveInstallTarget(
      options({
        environment,
        scopeStates: { project: null, user: null },
        scope: 'project',
        clients: ['universal'],
        declaration: { source: 'acme/plugin', clients: ['claude'], skills: ['one'] },
        yes: true,
      }),
    );
    const inherit = await resolveInstallTarget(
      options({ environment, scope: 'project', clients: ['claude', 'universal'], yes: true }),
    );
    const override = await resolveInstallTarget(
      options({ environment, scope: 'project', clients: ['claude'], yes: true }),
    );

    expect(initialize?.disposition).toBe('initialize');
    expect(initialize?.prospectiveDeclaration).toEqual({
      source: 'acme/plugin',
      skills: ['one'],
    });
    expect(inherit?.disposition).toBe('inherit');
    expect(inherit?.prospectiveDeclaration).toBe('acme/plugin');
    expect(override?.disposition).toBe('override');
    expect(override?.prospectiveDeclaration).toEqual({
      source: 'acme/plugin',
      clients: ['claude'],
    });
    expect(override?.summary.effectiveMethods).toEqual([{ client: 'claude', method: 'file' }]);
  });

  test('preflights the merged semantic reinstall declaration', async () => {
    const result = await resolveInstallTarget(
      options({
        environment: {
          json: true,
          ci: false,
          stdinIsTTY: true,
          stdoutIsTTY: true,
        },
        scope: 'project',
        clients: ['claude'],
        declaration: 'acme/plugin',
        scopeStates: {
          project: {
            clients: ['claude'],
            plugins: [
              {
                source: 'https://github.com/acme/plugin',
                install: 'native',
                exclude: ['generated'],
              },
            ],
          },
          user: null,
        },
        yes: true,
      }),
    );

    expect(result?.prospectiveDeclaration).toEqual({
      source: 'acme/plugin',
      install: 'native',
      exclude: ['generated'],
    });
    expect(result?.summary.effectiveMethods).toEqual([]);
  });

  test('treats the home project path as user scope and rejects explicit project scope', async () => {
    const home = '/tmp/allagents-install-target/home';
    const calls = makeCalls();
    const result = await resolveInstallTarget(
      options({
        workspacePath: home,
        scopeStates: { project: null, user: { clients: ['codex'] } },
        clients: ['codex'],
        yes: true,
        prompts: promptPort(calls, { scope: 'user' }),
      }),
    );

    expect(result?.scope).toBe('user');
    expect(calls.scopes[0]?.options.map((entry) => entry.scope)).toEqual(['user']);
    expect(calls.scopes[0]?.aliasNotice).toContain('same config');
    await expect(
      resolveInstallTarget(
        options({ workspacePath: home, scope: 'project', clients: ['codex'], yes: true }),
      ),
    ).rejects.toBeInstanceOf(InstallTargetValidationError);
  });

  test('yes skips only confirmation', async () => {
    const calls = makeCalls();
    await resolveInstallTarget(options({ yes: true, prompts: promptPort(calls) }));
    expect(calls.scopes).toHaveLength(1);
    expect(calls.clients).toHaveLength(1);
    expect(calls.summaries).toHaveLength(1);
    expect(calls.confirmations).toHaveLength(0);

    const confirmationCalls = makeCalls();
    await resolveInstallTarget(options({ prompts: promptPort(confirmationCalls) }));
    expect(confirmationCalls.confirmations[0]?.initialValue).toBe(true);
  });

  test.each([
    { json: true, ci: false, stdinIsTTY: true, stdoutIsTTY: true },
    { json: false, ci: true, stdinIsTTY: true, stdoutIsTTY: true },
    { json: false, ci: false, stdinIsTTY: false, stdoutIsTTY: true },
    { json: false, ci: false, stdinIsTTY: true, stdoutIsTTY: false },
  ])('does not call prompt ports in non-interactive mode %#', async (environment) => {
    const calls = makeCalls();
    const result = await resolveInstallTarget(
      options({ environment, prompts: promptPort(calls), defaultScope: 'user' }),
    );

    expect(result?.scope).toBe('user');
    expect(result?.clients).toEqual(['copilot', 'codex']);
    expect(calls).toEqual(makeCalls());
  });

  test('returns the exact project config path', async () => {
    const result = await resolveInstallTarget(
      options({
        scope: 'project',
        clients: ['universal'],
        yes: true,
        environment: {
          json: true,
          ci: false,
          stdinIsTTY: true,
          stdoutIsTTY: true,
        },
      }),
    );
    expect(result?.configPath).toBe(
      join(workspacePath, '.allagents', 'workspace.yaml'),
    );
  });
});
