import {
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import type { Mock } from 'bun:test';
import { parse } from 'cmd-ts';
import {
  executeWorkspaceSyncCommand,
  syncCmd,
} from '../../../src/cli/commands/workspace.js';
import type {
  WorkspaceSyncCommandDependencies,
  WorkspaceSyncCommandOptions,
} from '../../../src/cli/commands/workspace.js';
import { setJsonMode } from '../../../src/cli/json-output.js';
import type {
  ProfileApplyResult,
  ProfileRuntimeOptions,
} from '../../../src/core/profile/index.js';
import type { SyncOptions, SyncResult } from '../../../src/core/sync.js';

const defaultOptions: WorkspaceSyncCommandOptions = {
  offline: false,
  dryRun: false,
  force: false,
  verbose: false,
  noManaged: false,
  profile: [],
};

function successfulSyncResult(): SyncResult {
  return {
    success: true,
    pluginResults: [],
    totalCopied: 0,
    totalFailed: 0,
    totalSkipped: 0,
    totalGenerated: 0,
  };
}

function profileResult(
  profile: string,
  success = true,
): ProfileApplyResult {
  return {
    profile,
    operation: 'update',
    status: success ? 'installed' : 'failed',
    success,
    steps: [
      {
        client: 'pi',
        kind: 'launcher',
        identity: `/bin/${profile}`,
        status: success ? 'updated' : 'failed',
        ...(!success && { error: 'launcher failed' }),
      },
    ],
    warnings: [],
    ...(!success && { error: 'profile failed' }),
  };
}

function commandDependencies(
  overrides: Partial<WorkspaceSyncCommandDependencies> = {},
): WorkspaceSyncCommandDependencies {
  return {
    userConfigExists: () => true,
    projectConfigExists: () => true,
    ensureUserWorkspace: async () => {},
    resetFetchCache: () => {},
    syncUserWorkspace: async () => successfulSyncResult(),
    syncWorkspace: async () => successfulSyncResult(),
    updateInstalledProfiles: async () => [],
    exit: () => {},
    ...overrides,
  };
}

describe('workspace update command', () => {
  let consoleLog: Mock<typeof console.log>;
  let consoleError: Mock<typeof console.error>;

  beforeEach(() => {
    setJsonMode(false);
    consoleLog = spyOn(console, 'log').mockImplementation(() => {});
    consoleError = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    setJsonMode(false);
    consoleLog.mockRestore();
    consoleError.mockRestore();
  });

  test('deduplicates repeatable profile selectors and skips both ordinary scopes', async () => {
    const calls: string[] = [];
    let receivedNames: readonly string[] | undefined;
    let receivedOptions: { offline?: boolean; dryRun?: boolean } | undefined;

    await executeWorkspaceSyncCommand(
      {
        ...defaultOptions,
        offline: true,
        dryRun: true,
        force: true,
        noManaged: true,
        profile: ['work', 'review', 'work'],
      },
      commandDependencies({
        userConfigExists: () => {
          calls.push('inspect-user');
          return false;
        },
        projectConfigExists: () => {
          calls.push('inspect-project');
          return true;
        },
        ensureUserWorkspace: async () => {
          calls.push('ensure-user');
        },
        resetFetchCache: () => {
          calls.push('reset');
        },
        syncUserWorkspace: async () => {
          calls.push('user');
          return successfulSyncResult();
        },
        updateInstalledProfiles: async (names, options) => {
          calls.push('profiles');
          receivedNames = names;
          receivedOptions = options;
          return [profileResult('work'), profileResult('review')];
        },
        syncWorkspace: async () => {
          calls.push('project');
          return successfulSyncResult();
        },
      }),
    );

    expect(calls).toEqual(['reset', 'profiles']);
    expect(receivedNames).toEqual(['work', 'review']);
    expect(receivedOptions).toEqual({ offline: true, dryRun: true });
    expect(consoleLog.mock.calls.flat().join('\n')).toContain(
      'Profile work: installed',
    );
  });

  test('runs user, declared profiles, and project in exact order with scoped options', async () => {
    const calls: string[] = [];
    let userOptions: SyncOptions | undefined;
    let profileNames: readonly string[] | undefined = ['unexpected'];
    let profileOptions: ProfileRuntimeOptions | undefined;
    let projectOptions: SyncOptions | undefined;

    await executeWorkspaceSyncCommand(
      {
        ...defaultOptions,
        offline: true,
        dryRun: true,
        force: true,
        noManaged: true,
      },
      commandDependencies({
        resetFetchCache: () => {
          calls.push('reset');
        },
        syncUserWorkspace: async (options) => {
          calls.push('user');
          userOptions = options;
          return successfulSyncResult();
        },
        updateInstalledProfiles: async (names, options) => {
          calls.push('profile:alpha');
          calls.push('profile:beta');
          profileNames = names;
          profileOptions = options;
          return [profileResult('alpha'), profileResult('beta')];
        },
        syncWorkspace: async (_cwd, options) => {
          calls.push('project');
          projectOptions = options;
          return successfulSyncResult();
        },
      }),
    );

    expect(calls).toEqual([
      'reset',
      'user',
      'profile:alpha',
      'profile:beta',
      'project',
    ]);
    expect(profileNames).toBeUndefined();
    expect(userOptions).toEqual({ offline: true, dryRun: true, force: true });
    expect(profileOptions).toEqual({ offline: true, dryRun: true });
    expect(projectOptions).toEqual({
      offline: true,
      dryRun: true,
      skipManaged: true,
    });
    const output = consoleLog.mock.calls.flat().join('\n');
    expect(output.indexOf('Profile alpha: installed')).toBeLessThan(
      output.indexOf('Profile beta: installed'),
    );
  });

  test('skips profile reconciliation when no user workspace exists', async () => {
    const calls: string[] = [];

    await executeWorkspaceSyncCommand(
      defaultOptions,
      commandDependencies({
        userConfigExists: () => false,
        projectConfigExists: () => true,
        resetFetchCache: () => {
          calls.push('reset');
        },
        syncUserWorkspace: async () => {
          calls.push('user');
          return successfulSyncResult();
        },
        updateInstalledProfiles: async () => {
          calls.push('profiles');
          return [];
        },
        syncWorkspace: async () => {
          calls.push('project');
          return successfulSyncResult();
        },
      }),
    );

    expect(calls).toEqual(['reset', 'project']);
  });

  test('continues through profile and project passes after failures, then exits once', async () => {
    const calls: string[] = [];
    const exitCodes: number[] = [];

    await executeWorkspaceSyncCommand(
      defaultOptions,
      commandDependencies({
        resetFetchCache: () => {
          calls.push('reset');
        },
        syncUserWorkspace: async () => {
          calls.push('user');
          throw new Error('user failed');
        },
        updateInstalledProfiles: async () => {
          calls.push('profiles');
          return [profileResult('broken', false)];
        },
        syncWorkspace: async () => {
          calls.push('project');
          return successfulSyncResult();
        },
        exit: (code) => {
          exitCodes.push(code);
        },
      }),
    );

    expect(calls).toEqual(['reset', 'user', 'profiles', 'project']);
    expect(exitCodes).toEqual([1]);
    expect(consoleError.mock.calls.flat().join('\n')).toContain(
      'Error: User workspace: user failed',
    );
    expect(consoleLog.mock.calls.flat().join('\n')).toContain(
      'Profile broken: failed',
    );
  });

  test('adds formatted profile results to JSON while retaining ordinary sync data', async () => {
    setJsonMode(true);

    await executeWorkspaceSyncCommand(
      defaultOptions,
      commandDependencies({
        updateInstalledProfiles: async () => [profileResult('work')],
      }),
    );

    expect(consoleLog).toHaveBeenCalledTimes(1);
    const envelope = JSON.parse(String(consoleLog.mock.calls[0]?.[0]));
    expect(envelope).toMatchObject({
      success: true,
      command: 'workspace sync',
      data: {
        copied: 0,
        generated: 0,
        failed: 0,
        skipped: 0,
        plugins: [],
        profiles: [
          {
            profile: 'work',
            operation: 'update',
            status: 'installed',
            steps: [
              {
                client: 'pi',
                kind: 'launcher',
                identity: '/bin/work',
                status: 'updated',
              },
            ],
            warnings: [],
          },
        ],
      },
    });
  });

  test('parses every repeated profile selector in first-seen order', async () => {
    const result = await parse(syncCmd, [
      '--profile',
      'work',
      '--profile',
      'review',
      '--profile',
      'work',
    ]);

    expect(result).toEqual({
      _tag: 'ok',
      value: {
        ...defaultOptions,
        profile: ['work', 'review', 'work'],
      },
    });
  });

  test('rejects unsupported scope and client selectors during parsing', async () => {
    for (const args of [
      ['--scope', 'user'],
      ['--client', 'pi'],
      ['--profile', 'work', '--scope', 'user'],
      ['--profile', 'work', '--client', 'pi'],
    ]) {
      const result = await parse(syncCmd, args);
      expect(result._tag).toBe('error');
    }
  });

  test('reports the reason from a pass that returned a failure instead of throwing', async () => {
    const exitCodes: number[] = [];

    await executeWorkspaceSyncCommand(
      defaultOptions,
      commandDependencies({
        // User pass succeeds, project pass aborts early the way `syncWorkspace`
        // does for an unreadable or invalid workspace config.
        syncWorkspace: async () => ({
          ...successfulSyncResult(),
          success: false,
          error:
            '.allagents/workspace.yaml validation failed:\n  - repositories.0.path: Invalid input: expected string, received undefined',
        }),
        exit: (code) => {
          exitCodes.push(code);
        },
      }),
    );

    expect(exitCodes).toEqual([1]);
    const stderr = consoleError.mock.calls.flat().join('\n');
    expect(stderr).toContain(
      'repositories.0.path: Invalid input: expected string, received undefined',
    );
    expect(stderr).not.toContain('Sync completed with failures');
  });

  test('surfaces a returned failure reason in the JSON error field', async () => {
    setJsonMode(true);

    await executeWorkspaceSyncCommand(
      defaultOptions,
      commandDependencies({
        syncWorkspace: async () => ({
          ...successfulSyncResult(),
          success: false,
          error: 'project config is invalid',
        }),
      }),
    );

    const envelope = JSON.parse(String(consoleLog.mock.calls[0]?.[0]));
    expect(envelope.success).toBe(false);
    expect(envelope.error).toBe('project config is invalid');
  });
});
