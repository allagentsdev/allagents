import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { run } from 'cmd-ts';
import { createProfileCommand } from '../../../src/cli/commands/profile.js';
import type {
  ProfileCommandDependencies,
  ProfileCommandRuntime,
} from '../../../src/cli/commands/profile.js';
import {
  buildProfileData,
  buildProfilePlanData,
  formatProfilePlan,
  formatProfileResult,
} from '../../../src/cli/format-profile.js';
import {
  profileInstallMeta,
  profileListMeta,
  profileRemoveMeta,
  profileStatusMeta,
} from '../../../src/cli/metadata/profile.js';
import type {
  ProfileApplyResult,
  ProfilePlan,
  ProfileRuntimeOptions,
  ProfileStatusResult,
} from '../../../src/core/profile/index.js';

const digest = 'a'.repeat(64);
const cliEntry = join(import.meta.dir, '..', '..', '..', 'src', 'cli', 'index.ts');

class ExitError extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

function plan(operation: 'install' | 'remove' = 'install'): ProfilePlan {
  return {
    profile: 'work',
    operation,
    declarationDigest: digest,
    clients: [
      {
        client: 'pi',
        mechanism: 'PI_CODING_AGENT_DIR',
        root: '/home/test/.pi/agent/profiles/work',
        agentRoot: '/home/test/.pi/agent/profiles/work',
        launcher: {
          name: 'work',
          command: {
            command: 'pi',
            args: ['--mode', 'rpc'],
          },
          destinations: ['/home/test/.local/bin/work'],
        },
      },
    ],
    steps: [
      {
        client: 'pi',
        kind: 'file',
        identity: '/home/test/.pi/agent/profiles/work/settings.json',
        action: operation === 'remove' ? 'remove' : 'create',
        requestedRef: 'main',
        resolvedRef: '0123456789abcdef',
        detail: {
          source: 'owner/repository',
          skills: ['review'],
          commands: [
            {
              command: 'pi',
              args: ['install', 'owner/repository'],
            },
          ],
          mcpServers: [
            {
              name: 'remote',
              transport: 'http',
              endpoint: 'https://example.test/mcp',
              requestedSecrets: ['API_TOKEN'],
            },
            {
              name: 'local',
              transport: 'stdio',
              command: {
                command: 'node',
                args: ['server.mjs', '--token', '[REDACTED]'],
              },
              requestedSecrets: ['LOCAL_TOKEN'],
            },
          ],
        },
      },
    ],
    warnings: [],
  };
}

function applyResult(
  operation: 'install' | 'remove' = 'install',
): ProfileApplyResult {
  return {
    profile: 'work',
    operation,
    status: operation === 'remove' ? 'removed' : 'installed',
    success: true,
    steps: [
      {
        client: 'pi',
        kind: 'file',
        identity: '/home/test/.pi/agent/profiles/work/settings.json',
        status: operation === 'remove' ? 'removed' : 'created',
      },
      {
        client: 'pi',
        kind: 'native',
        identity: 'pi',
        status: 'unchanged',
      },
      {
        client: 'pi',
        kind: 'marketplace',
        identity: 'shared-marketplace',
        status: 'referenced',
      },
      {
        client: 'pi',
        kind: 'launcher',
        identity: '/home/test/.local/bin/work',
        status: 'retained',
      },
    ],
    warnings: [],
  };
}

function statusResult(): ProfileStatusResult {
  return {
    profile: 'work',
    operation: 'status',
    status: 'installed',
    declared: true,
    installed: true,
    declarationDigest: digest,
    stateDigest: digest,
    clients: ['pi'],
    steps: [
      {
        client: 'pi',
        kind: 'file',
        identity: '/home/test/.pi/agent/profiles/work/settings.json',
        status: 'unchanged',
      },
    ],
    launchers: [
      {
        client: 'pi',
        name: 'work',
        path: '/home/test/.local/bin/work',
        onPath: false,
      },
    ],
    warnings: [],
  };
}

function orphanStatusResult(): ProfileStatusResult {
  return {
    profile: 'orphan',
    operation: 'status',
    status: 'declaration-missing',
    declared: false,
    installed: true,
    stateDigest: digest,
    clients: ['pi'],
    steps: [],
    launchers: [
      {
        client: 'pi',
        name: 'orphan',
        path: '/home/test/.local/bin/orphan',
        onPath: true,
      },
    ],
    warnings: [],
  };
}

function bareStatusResult(): ProfileStatusResult {
  return {
    profile: 'bare',
    operation: 'status',
    status: 'missing',
    declared: true,
    installed: false,
    declarationDigest: digest,
    clients: [],
    steps: [],
    launchers: [],
    warnings: [],
  };
}

function listedStatusResult(): ProfileStatusResult {
  return {
    ...statusResult(),
    clients: ['pi', 'claude'],
    launchers: [
      {
        client: 'pi',
        name: 'work',
        path: '/home/test/.local/bin/work',
        onPath: false,
      },
      {
        client: 'claude',
        name: 'review',
        path: '/home/test/.local/bin/review',
        onPath: true,
      },
    ],
  };
}

function failedStatusResult(): ProfileStatusResult {
  return {
    ...bareStatusResult(),
    profile: 'broken',
    status: 'unsupported',
    clients: ['pi'],
    error: 'pi CLI is unavailable or unsupported',
  };
}

interface Harness {
  readonly runtime: ProfileCommandRuntime;
  readonly output: string[];
  readonly errors: string[];
  readonly envelopes: unknown[];
  readonly confirmations: string[];
  readonly selections: string[];
}

function createRuntime(options: {
  interactive?: boolean;
  json?: boolean;
  confirmation?: boolean | undefined;
  selection?: string | undefined;
} = {}): Harness {
  const output: string[] = [];
  const errors: string[] = [];
  const envelopes: unknown[] = [];
  const confirmations: string[] = [];
  const selections: string[] = [];
  const runtime: ProfileCommandRuntime = {
    isInteractive: () => options.interactive ?? false,
    isJson: () => options.json ?? false,
    print: (line) => output.push(line),
    printError: (line) => errors.push(line),
    printJson: (envelope) => envelopes.push(envelope),
    selectProfile: async ({ message }) => {
      selections.push(message);
      return options.selection;
    },
    confirm: async ({ message }) => {
      confirmations.push(message);
      return options.confirmation;
    },
    exit: (code): never => {
      throw new ExitError(code);
    },
  };
  return { runtime, output, errors, envelopes, confirmations, selections };
}

function createDependencies(overrides: Partial<ProfileCommandDependencies> = {}) {
  let planCalls = 0;
  let applyCalls = 0;
  const planOptions: ProfileRuntimeOptions[] = [];
  const applyOptions: ProfileRuntimeOptions[] = [];
  const dependencies: ProfileCommandDependencies = {
    planProfileOperation: async (_profile, operation, options) => {
      planCalls += 1;
      planOptions.push(options);
      return plan(operation === 'remove' ? 'remove' : 'install');
    },
    applyProfilePlan: async (profilePlan, options) => {
      applyCalls += 1;
      applyOptions.push(options);
      return applyResult(
        profilePlan.operation === 'remove' ? 'remove' : 'install',
      );
    },
    getProfileStatus: async () => statusResult(),
    getProfileStatuses: async () => [statusResult()],
    ...overrides,
  };
  return {
    dependencies,
    planCalls: () => planCalls,
    applyCalls: () => applyCalls,
    planOptions,
    applyOptions,
  };
}

async function runProfile(
  args: string[],
  dependencies: ProfileCommandDependencies,
  runtime: ProfileCommandRuntime,
): Promise<void> {
  await run(createProfileCommand(dependencies, runtime), args);
}

describe('profile command', () => {
  test('declares complete help metadata and JSON field allowlists', () => {
    for (const meta of [
      profileInstallMeta,
      profileListMeta,
      profileStatusMeta,
      profileRemoveMeta,
    ]) {
      expect(meta.description).not.toBe('');
      expect(meta.whenToUse).not.toBe('');
      expect(meta.examples.length).toBeGreaterThan(0);
      expect(meta.outputSchema).toBeDefined();
      expect(meta.jsonFields).toContain('profile');
      expect(meta.jsonFields).toContain('operation');
      expect(meta.jsonFields).toContain('status');
      expect(meta.jsonFields).toContain('steps');
      expect(meta.jsonFields).toContain('warnings');
      expect(meta.jsonFields).toContain('error');
    }
  });

  test('rejects an omitted name outside an interactive terminal without planning', async () => {
    const core = createDependencies();
    const harness = createRuntime();

    await expect(
      runProfile(['install', '--yes'], core.dependencies, harness.runtime),
    ).rejects.toMatchObject({ code: 2 });

    expect(core.planCalls()).toBe(0);
    expect(core.applyCalls()).toBe(0);
    expect(harness.errors.join('\n')).toContain(
      'profile name is required in non-interactive and JSON modes',
    );
  });

  test('returns the JSON error envelope when a name is omitted in JSON mode', async () => {
    const core = createDependencies();
    const harness = createRuntime({ json: true });

    await expect(
      runProfile(['remove', '--yes'], core.dependencies, harness.runtime),
    ).rejects.toMatchObject({ code: 2 });

    expect(core.planCalls()).toBe(0);
    expect(harness.envelopes).toEqual([
      {
        success: false,
        command: 'profile remove',
        error:
          'profile name is required in non-interactive and JSON modes; pass a name to profile remove',
      },
    ]);
  });

  test('prints the plan and cancellation leaves it unapplied', async () => {
    const core = createDependencies();
    const harness = createRuntime({ interactive: true, confirmation: false });

    await runProfile(['install', 'work'], core.dependencies, harness.runtime);

    expect(core.planCalls()).toBe(1);
    expect(core.applyCalls()).toBe(0);
    expect(harness.confirmations).toHaveLength(1);
    expect(harness.output.join('\n')).toContain('Profile work install plan');
    expect(harness.output.join('\n')).toContain('Profile install cancelled');
  });

  test('--yes applies without confirmation and reports all resource outcomes', async () => {
    const core = createDependencies();
    const harness = createRuntime();

    await runProfile(
      ['install', 'work', '--yes', '--offline'],
      core.dependencies,
      harness.runtime,
    );

    expect(core.applyCalls()).toBe(1);
    expect(core.planOptions).toEqual([{ offline: true }]);
    expect(core.applyOptions).toEqual([{ offline: true }]);
    expect(harness.confirmations).toHaveLength(0);
    const text = harness.output.join('\n');
    expect(text).toContain('created');
    expect(text).toContain('unchanged');
    expect(text).toContain('referenced');
    expect(text).toContain('retained');
  });

  test('keeps the resolved plan in a JSON failure after apply starts', async () => {
    const core = createDependencies({
      applyProfilePlan: async () => {
        throw new Error('apply failed safely');
      },
    });
    const harness = createRuntime({ json: true });

    await expect(
      runProfile(
        ['install', 'work', '--yes'],
        core.dependencies,
        harness.runtime,
      ),
    ).rejects.toMatchObject({ code: 1 });

    expect(harness.envelopes).toEqual([
      {
        success: false,
        command: 'profile install',
        data: {
          profile: 'work',
          operation: 'install',
          status: 'failed',
          steps: [],
          warnings: [],
          plan: buildProfilePlanData(plan()),
          error: 'apply failed safely',
        },
        error: 'apply failed safely',
      },
    ]);
  });

  test('--dry-run never confirms or applies', async () => {
    const core = createDependencies();
    const harness = createRuntime({ interactive: true, confirmation: true });

    await runProfile(
      ['remove', 'work', '--dry-run'],
      core.dependencies,
      harness.runtime,
    );

    expect(core.planCalls()).toBe(1);
    expect(core.applyCalls()).toBe(0);
    expect(core.planOptions).toEqual([{ dryRun: true }]);
    expect(harness.confirmations).toHaveLength(0);
    expect(harness.output.join('\n')).toContain('Profile work remove plan');
  });

  test('emits the repository JSON envelope for mutation and status results', async () => {
    const core = createDependencies();
    const harness = createRuntime({ json: true });

    await runProfile(
      ['install', 'work', '--yes'],
      core.dependencies,
      harness.runtime,
    );
    await runProfile(
      ['status', 'work'],
      core.dependencies,
      harness.runtime,
    );

    expect(harness.envelopes).toEqual([
      {
        success: true,
        command: 'profile install',
        data: {
          ...buildProfileData(applyResult()),
          plan: buildProfilePlanData(plan()),
        },
      },
      {
        success: true,
        command: 'profile status',
        data: buildProfileData(statusResult()),
      },
    ]);
    expect(harness.output).toHaveLength(0);
  });

  test('lists declared and declaration-missing profiles deterministically without mutation or selection', async () => {
    const core = createDependencies({
      getProfileStatuses: async () => [
        listedStatusResult(),
        orphanStatusResult(),
        bareStatusResult(),
      ],
    });
    const harness = createRuntime({ interactive: true, selection: 'work' });

    await runProfile(['list'], core.dependencies, harness.runtime);

    expect(core.planCalls()).toBe(0);
    expect(core.applyCalls()).toBe(0);
    expect(harness.selections).toHaveLength(0);
    expect(harness.confirmations).toHaveLength(0);
    expect(harness.output).toEqual([
      'Profiles (3):',
      '  bare: missing',
      '    Declared: yes; Installed: no',
      '    Clients: none',
      '    Launchers: none',
      '  orphan: declaration-missing',
      '    Declared: no; Installed: yes',
      '    Clients: pi',
      '    Launchers:',
      '      pi orphan: /home/test/.local/bin/orphan (on PATH)',
      '  work: installed',
      '    Declared: yes; Installed: yes',
      '    Clients: claude, pi',
      '    Launchers:',
      '      claude review: /home/test/.local/bin/review (on PATH)',
      '      pi work: /home/test/.local/bin/work (not on PATH)',
    ]);
  });

  test('emits literal sorted profile and launcher fields in the list JSON envelope', async () => {
    const core = createDependencies({
      getProfileStatuses: async () => [
        listedStatusResult(),
        orphanStatusResult(),
        bareStatusResult(),
      ],
    });
    const harness = createRuntime({ json: true });

    await runProfile(['list'], core.dependencies, harness.runtime);

    expect(harness.envelopes).toEqual([
      {
        success: true,
        command: 'profile list',
        data: {
          profiles: [
            {
              profile: 'bare',
              operation: 'status',
              status: 'missing',
              steps: [],
              warnings: [],
              declared: true,
              installed: false,
              clients: [],
              launchers: [],
              declarationDigest: digest,
            },
            {
              profile: 'orphan',
              operation: 'status',
              status: 'declaration-missing',
              steps: [],
              warnings: [],
              declared: false,
              installed: true,
              clients: ['pi'],
              launchers: [
                {
                  client: 'pi',
                  name: 'orphan',
                  path: '/home/test/.local/bin/orphan',
                  onPath: true,
                },
              ],
              stateDigest: digest,
            },
            {
              profile: 'work',
              operation: 'status',
              status: 'installed',
              steps: [
                {
                  client: 'pi',
                  kind: 'file',
                  identity: '/home/test/.pi/agent/profiles/work/settings.json',
                  status: 'unchanged',
                },
              ],
              warnings: [],
              declared: true,
              installed: true,
              clients: ['claude', 'pi'],
              launchers: [
                {
                  client: 'claude',
                  name: 'review',
                  path: '/home/test/.local/bin/review',
                  onPath: true,
                },
                {
                  client: 'pi',
                  name: 'work',
                  path: '/home/test/.local/bin/work',
                  onPath: false,
                },
              ],
              declarationDigest: digest,
              stateDigest: digest,
            },
          ],
          total: 3,
        },
      },
    ]);
    expect(harness.output).toHaveLength(0);
  });

  test('prints the empty profile inventory', async () => {
    const core = createDependencies({
      getProfileStatuses: async () => [],
    });
    const harness = createRuntime();

    await runProfile(['list'], core.dependencies, harness.runtime);

    expect(harness.output).toEqual(['No profiles found.']);
    expect(harness.errors).toHaveLength(0);
  });

  test('returns a failed JSON envelope without dropping an incomplete inventory', async () => {
    const core = createDependencies({
      getProfileStatuses: async () => [
        listedStatusResult(),
        failedStatusResult(),
      ],
    });
    const harness = createRuntime({ json: true });

    await expect(
      runProfile(['list'], core.dependencies, harness.runtime),
    ).rejects.toMatchObject({ code: 1 });

    expect(harness.envelopes).toEqual([
      {
        success: false,
        command: 'profile list',
        data: {
          profiles: [
            {
              profile: 'broken',
              operation: 'status',
              status: 'unsupported',
              steps: [],
              warnings: [],
              declared: true,
              installed: false,
              clients: ['pi'],
              launchers: [],
              declarationDigest: digest,
              error: 'pi CLI is unavailable or unsupported',
            },
            {
              profile: 'work',
              operation: 'status',
              status: 'installed',
              steps: [
                {
                  client: 'pi',
                  kind: 'file',
                  identity: '/home/test/.pi/agent/profiles/work/settings.json',
                  status: 'unchanged',
                },
              ],
              warnings: [],
              declared: true,
              installed: true,
              clients: ['claude', 'pi'],
              launchers: [
                {
                  client: 'claude',
                  name: 'review',
                  path: '/home/test/.local/bin/review',
                  onPath: true,
                },
                {
                  client: 'pi',
                  name: 'work',
                  path: '/home/test/.local/bin/work',
                  onPath: false,
                },
              ],
              declarationDigest: digest,
              stateDigest: digest,
            },
          ],
          total: 2,
        },
        error: 'Failed to inspect profiles: broken',
      },
    ]);
  });

  test('renders the complete human inventory before reporting incomplete inspection', async () => {
    const core = createDependencies({
      getProfileStatuses: async () => [
        listedStatusResult(),
        failedStatusResult(),
      ],
    });
    const harness = createRuntime();

    await expect(
      runProfile(['list'], core.dependencies, harness.runtime),
    ).rejects.toMatchObject({ code: 1 });

    expect(harness.output).toEqual([
      'Profiles (2):',
      '  broken: unsupported',
      '    Declared: yes; Installed: no',
      '    Clients: pi',
      '    Launchers: none',
      '  work: installed',
      '    Declared: yes; Installed: yes',
      '    Clients: claude, pi',
      '    Launchers:',
      '      claude review: /home/test/.local/bin/review (on PATH)',
      '      pi work: /home/test/.local/bin/work (not on PATH)',
    ]);
    expect(harness.errors).toEqual([
      'Error: Failed to inspect profiles: broken',
    ]);
  });

  test('status is read-only and reports launcher PATH diagnostics', async () => {
    const core = createDependencies();
    const harness = createRuntime();

    await runProfile(
      ['status', 'work'],
      core.dependencies,
      harness.runtime,
    );

    expect(core.planCalls()).toBe(0);
    expect(core.applyCalls()).toBe(0);
    expect(harness.output.join('\n')).toContain('Launcher PATH:');
    expect(harness.output.join('\n')).toContain('is not on PATH');
  });

  test('status still selects a profile when an interactive name is omitted', async () => {
    const core = createDependencies();
    const harness = createRuntime({
      interactive: true,
      selection: 'work',
    });

    await runProfile(['status'], core.dependencies, harness.runtime);

    expect(harness.selections).toEqual(['Select a profile to inspect']);
    expect(core.planCalls()).toBe(0);
    expect(core.applyCalls()).toBe(0);
    expect(harness.output.join('\n')).toContain('Profile work: installed');
  });

  test('interactive missing names select declared or installed profiles', async () => {
    const core = createDependencies();
    const harness = createRuntime({
      interactive: true,
      selection: 'work',
      confirmation: false,
    });

    await runProfile(['remove'], core.dependencies, harness.runtime);

    expect(harness.selections).toEqual(['Select an installed profile to remove']);
    expect(core.planCalls()).toBe(1);
    expect(core.applyCalls()).toBe(0);
  });
});

describe('profile formatting', () => {
  test('formats only redacted plan fields and all result states deterministically', () => {
    const profilePlan = {
      ...plan(),
      environment: { API_TOKEN: 'must-not-appear' },
    } as ProfilePlan;
    expect(formatProfilePlan(profilePlan)).toEqual(formatProfilePlan(profilePlan));
    expect(formatProfilePlan(profilePlan).join('\n')).not.toContain(
      'must-not-appear',
    );
    const disclosure = formatProfilePlan(profilePlan).join('\n');
    expect(disclosure).toContain('pi: PI_CODING_AGENT_DIR');
    expect(disclosure).toContain(
      'config root: /home/test/.pi/agent/profiles/work',
    );
    expect(disclosure).toContain('launcher: work');
    expect(disclosure).toContain(
      'command argv: [\"pi\",\"--mode\",\"rpc\"]',
    );
    expect(disclosure).toContain('source: owner/repository');
    expect(disclosure).toContain('resolved=0123456789abcdef');
    expect(disclosure).toContain(
      'MCP remote (http) endpoint=https://example.test/mcp',
    );
    expect(disclosure).toContain('requested secrets: API_TOKEN');
    expect(disclosure).toContain(
      'command argv: [\"node\",\"server.mjs\",\"--token\",\"[REDACTED]\"]',
    );
    const lines = formatProfileResult({
      ...applyResult(),
      success: false,
      status: 'partial',
      steps: [
        ...applyResult().steps,
        {
          client: 'pi',
          kind: 'mcp',
          identity: 'broken-server',
          status: 'failed',
          error: 'credential=[REDACTED]',
        },
      ],
    }).join('\n');
    for (const status of [
      'created',
      'updated',
      'unchanged',
      'referenced',
      'retained',
      'failed',
    ]) {
      if (status === 'updated') {
        expect(formatProfileResult({
          ...applyResult(),
          steps: [{ ...applyResult().steps[0]!, status: 'updated' }],
        }).join('\n')).toContain(status);
      } else {
        expect(lines).toContain(status);
      }
    }
  });
});

describe('profile root registration', () => {
  test('is present in root help and structured JSON help', () => {
    const rootHelp = Bun.spawnSync(
      ['bun', 'run', cliEntry, '--help'],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    expect(rootHelp.exitCode).toBe(0);
    expect(rootHelp.stdout.toString()).toContain('profile');

    const structuredHelp = Bun.spawnSync(
      ['bun', 'run', cliEntry, 'profile', '--help', '--json'],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    expect(structuredHelp.exitCode).toBe(0);
    const parsed = JSON.parse(structuredHelp.stdout.toString()) as {
      commands: Array<{ command: string }>;
    };
    expect(parsed.commands.map((entry) => entry.command)).toEqual([
      'profile install',
      'profile list',
      'profile status',
      'profile remove',
    ]);
  });

  test('does not accept mutation flags on status', () => {
    const proc = Bun.spawnSync(
      [
        'bun',
        'run',
        cliEntry,
        '--json',
        'profile',
        'status',
        'work',
        '--dry-run',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr.toString()).toContain('Unknown arguments');
  });

  test('does not register a profile update command', () => {
    const proc = Bun.spawnSync(
      ['bun', 'run', cliEntry, '--json', 'profile', 'update'],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    expect(proc.exitCode).not.toBe(0);
    expect(`${proc.stdout.toString()}${proc.stderr.toString()}`).toContain(
      'update',
    );
  });
});
