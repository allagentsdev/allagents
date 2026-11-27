import {
  confirm as confirmPrompt,
  isCancel,
  select as selectPrompt,
} from '@clack/prompts';
import { command, flag, optional, positional, string } from 'cmd-ts';
import {
  applyProfilePlan,
  getProfileStatus,
  getProfileStatuses,
  planProfileOperation,
} from '../../core/profile/index.js';
import type {
  ProfileApplyResult,
  ProfileOperationKind,
  ProfilePlan,
  ProfileRuntimeOptions,
  ProfileStatusResult,
} from '../../core/profile/index.js';
import {
  buildProfileData,
  buildProfileListData,
  buildProfilePlanData,
  formatProfileList,
  formatProfilePlan,
  formatProfileResult,
} from '../format-profile.js';
import { buildDescription, conciseSubcommands } from '../help.js';
import { isJsonMode, jsonOutput } from '../json-output.js';
import type { JsonEnvelope } from '../json-output.js';
import {
  profileInstallMeta,
  profileListMeta,
  profileRemoveMeta,
  profileRenameMeta,
  profileStatusMeta,
} from '../metadata/profile.js';
import { terminalSafe } from '../terminal-output.js';
import { applyProfileRename, planProfileRename } from '../../core/profile/rename.js';

export interface ProfileCommandDependencies {
  readonly planProfileOperation: (
    profile: string,
    operation: ProfileOperationKind,
    options: ProfileRuntimeOptions,
  ) => Promise<ProfilePlan>;
  readonly applyProfilePlan: (
    plan: ProfilePlan,
    options: ProfileRuntimeOptions,
  ) => Promise<ProfileApplyResult>;
  readonly getProfileStatus: (
    profile: string,
    options: ProfileRuntimeOptions,
  ) => Promise<ProfileStatusResult>;
  readonly getProfileStatuses: (
    options: ProfileRuntimeOptions,
  ) => Promise<readonly ProfileStatusResult[]>;
}

interface ProfileSelectionOption {
  readonly value: string;
  readonly label: string;
}

export interface ProfileCommandRuntime {
  readonly isInteractive: () => boolean;
  readonly isJson: () => boolean;
  readonly print: (line: string) => void;
  readonly printError: (line: string) => void;
  readonly printJson: (envelope: JsonEnvelope) => void;
  readonly selectProfile: (input: {
    readonly message: string;
    readonly options: readonly ProfileSelectionOption[];
  }) => Promise<string | undefined>;
  readonly confirm: (input: {
    readonly message: string;
  }) => Promise<boolean | undefined>;
  readonly exit: (code: number) => never;
}

const defaultDependencies: ProfileCommandDependencies = {
  planProfileOperation,
  applyProfilePlan,
  getProfileStatus,
  getProfileStatuses,
};

const defaultRuntime: ProfileCommandRuntime = {
  isInteractive: () =>
    Boolean(process.stdin.isTTY && process.stdout.isTTY) && !isJsonMode(),
  isJson: isJsonMode,
  print: (line) => console.log(line),
  printError: (line) => console.error(line),
  printJson: jsonOutput,
  selectProfile: async ({ message, options }) => {
    const selected = await selectPrompt({
      message,
      options: options.map((entry) => ({ ...entry })),
    });
    return isCancel(selected) ? undefined : (selected as string);
  },
  confirm: async ({ message }) => {
    const confirmed = await confirmPrompt({ message, initialValue: false });
    return isCancel(confirmed) ? undefined : confirmed;
  },
  exit: (code): never => process.exit(code),
};

class ProfileCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

type ProfileSelectionKind = 'install' | 'status' | 'remove';

function runtimeOptions(flags: {
  readonly offline?: boolean;
  readonly dryRun?: boolean;
  readonly purgeSessionData?: boolean;
}): ProfileRuntimeOptions {
  return {
    ...(flags.offline ? { offline: true } : {}),
    ...(flags.dryRun ? { dryRun: true } : {}),
    ...(flags.purgeSessionData ? { purgeSessionData: true } : {}),
  };
}

function selectionMessage(operation: ProfileSelectionKind): string {
  switch (operation) {
    case 'install':
      return 'Select a declared profile to install';
    case 'remove':
      return 'Select an installed profile to remove';
    case 'status':
      return 'Select a profile to inspect';
  }
}

function selectionCandidates(
  operation: ProfileSelectionKind,
  statuses: readonly ProfileStatusResult[],
): ProfileStatusResult[] {
  return statuses
    .filter((result) => {
      switch (operation) {
        case 'install':
          return result.declared;
        case 'remove':
          return result.installed;
        case 'status':
          return result.declared || result.installed;
      }
      return false;
    })
    .sort((left, right) => left.profile.localeCompare(right.profile));
}

async function resolveProfileName(
  operation: ProfileSelectionKind,
  suppliedName: string | undefined,
  dependencies: ProfileCommandDependencies,
  runtime: ProfileCommandRuntime,
  options: ProfileRuntimeOptions,
): Promise<string | undefined> {
  if (suppliedName) return suppliedName;
  if (!runtime.isInteractive() || runtime.isJson()) {
    throw new ProfileCommandError(
      `profile name is required in non-interactive and JSON modes; pass a name to profile ${operation}`,
      2,
    );
  }

  const candidates = selectionCandidates(
    operation,
    await dependencies.getProfileStatuses(options),
  );
  if (candidates.length === 0) {
    const adjective = operation === 'remove' ? 'installed' : 'declared or installed';
    throw new ProfileCommandError(
      operation === 'install'
        ? 'No declared profiles are available to install'
        : `No ${adjective} profiles are available`,
      2,
    );
  }

  return runtime.selectProfile({
    message: selectionMessage(operation),
    options: candidates.map((result) => ({
      value: result.profile,
      label: `${result.profile} (${result.status})`,
    })),
  });
}

function emitPlan(plan: ProfilePlan, runtime: ProfileCommandRuntime): void {
  for (const line of formatProfilePlan(plan)) runtime.print(line);
}

function emitResult(
  commandName: string,
  result: ProfileApplyResult | ProfileStatusResult,
  runtime: ProfileCommandRuntime,
  success: boolean,
  plan?: ProfilePlan,
): void {
  if (runtime.isJson()) {
    runtime.printJson({
      success,
      command: commandName,
      data: {
        ...buildProfileData(result),
        ...(plan ? { plan: buildProfilePlanData(plan) } : {}),
      },
      ...(!success && {
        error: result.error ?? `Profile ${result.profile} ${result.status}`,
      }),
    });
    return;
  }
  for (const line of formatProfileResult(result)) runtime.print(line);
}

function failedProfileData(plan: ProfilePlan): Record<string, unknown> {
  return {
    profile: plan.profile,
    operation: plan.operation,
    status: 'failed',
    steps: [],
    warnings: plan.warnings,
    plan: buildProfilePlanData(plan),
  };
}

async function executeMutation(
  operation: 'install' | 'remove',
  args: {
    readonly name: string | undefined;
    readonly yes: boolean;
    readonly dryRun: boolean;
    readonly offline: boolean;
    readonly purgeSessionData?: boolean;
  },
  dependencies: ProfileCommandDependencies,
  runtime: ProfileCommandRuntime,
): Promise<number> {
  const options = runtimeOptions(args);
  const name = await resolveProfileName(
    operation,
    args.name,
    dependencies,
    runtime,
    options,
  );
  if (!name) {
    if (!runtime.isJson()) runtime.print(`Profile ${operation} cancelled.`);
    return 0;
  }

  const plan = await dependencies.planProfileOperation(name, operation, options);
  if (args.dryRun) {
    if (runtime.isJson()) {
      runtime.printJson({
        success: true,
        command: `profile ${operation}`,
        data: buildProfilePlanData(plan),
      });
    } else {
      emitPlan(plan, runtime);
      runtime.print('Dry run; no changes applied.');
    }
    return 0;
  }

  if (!runtime.isJson()) emitPlan(plan, runtime);
  if (!args.yes) {
    if (!runtime.isInteractive() || runtime.isJson()) {
      throw new ProfileCommandError(
        `profile ${operation} requires confirmation; rerun with --yes in non-interactive and JSON modes`,
        2,
        failedProfileData(plan),
      );
    }
    const confirmed = await runtime.confirm({
      message: `${operation === 'install' ? 'Install' : 'Remove'} profile '${name}' using this plan?`,
    });
    if (confirmed !== true) {
      runtime.print(`Profile ${operation} cancelled.`);
      return 0;
    }
  }

  let result: ProfileApplyResult;
  try {
    result = await dependencies.applyProfilePlan(plan, options);
  } catch (error) {
    throw new ProfileCommandError(
      error instanceof Error ? error.message : String(error),
      1,
      failedProfileData(plan),
    );
  }
  emitResult(`profile ${operation}`, result, runtime, result.success, plan);
  return result.success ? 0 : 1;
}

async function executeList(
  dependencies: ProfileCommandDependencies,
  runtime: ProfileCommandRuntime,
): Promise<number> {
  const results = await dependencies.getProfileStatuses({});
  const failedProfiles = results
    .filter((result) => result.error !== undefined)
    .map((result) => result.profile)
    .sort((left, right) => left.localeCompare(right));
  const success = failedProfiles.length === 0;
  const error = success
    ? undefined
    : `Failed to inspect profiles: ${failedProfiles.join(', ')}`;
  if (runtime.isJson()) {
    runtime.printJson({
      success,
      command: 'profile list',
      data: buildProfileListData(results),
      ...(error && { error }),
    });
    return success ? 0 : 1;
  }
  for (const line of formatProfileList(results)) runtime.print(line);
  if (error) runtime.printError(`Error: ${terminalSafe(error)}`);
  return success ? 0 : 1;
}

async function executeRename(
  args: { profile: string; newProfile: string; yes: boolean; dryRun: boolean },
  runtime: ProfileCommandRuntime,
): Promise<number> {
  const plan = await planProfileRename(args.profile, args.newProfile, runtimeOptions(args));
  const command = 'profile rename';
  if (!runtime.isJson()) {
    const action = plan.recovering ? 'Resume renaming' : 'Rename';
    runtime.print(`${action} profile '${plan.profile}' to '${plan.newProfile}'`);
    const labels = {
      root: 'Move profile data',
      settings: 'Move client settings',
      launcher: 'Retarget launcher',
      state: 'Transfer installation state',
      workspace: 'Update workspace declaration',
    };
    for (const { kind, from, to } of plan.steps) {
      runtime.print(`  ${labels[kind]}: ${terminalSafe(from)}`);
      if (from !== to) runtime.print(`    → ${terminalSafe(to)}`);
    }
    for (const warning of plan.warnings) runtime.print(warning);
  }
  if (args.dryRun) {
    if (runtime.isJson()) runtime.printJson({ success: true, command, data: { ...plan } });
    else runtime.print('Dry run; no changes applied.');
    return 0;
  }
  if (!args.yes) {
    if (!runtime.isInteractive() || runtime.isJson()) {
      throw new ProfileCommandError(
        'profile rename requires confirmation; rerun with --yes in non-interactive and JSON modes',
        2,
        { ...plan, status: 'failed', plan },
      );
    }
    const confirmed = await runtime.confirm({
      message: `Rename profile '${plan.profile}' to '${plan.newProfile}' using this plan?`,
    });
    if (confirmed !== true) {
      runtime.print('Profile rename cancelled.');
      return 0;
    }
  }
  try {
    await applyProfileRename(plan);
  } catch (error) {
    throw new ProfileCommandError(
      error instanceof Error ? error.message : String(error),
      1,
      { ...plan, status: 'failed', plan },
    );
  }
  if (runtime.isJson()) {
    runtime.printJson({ success: true, command, data: { ...plan, status: 'renamed', plan } });
  } else {
    runtime.print(`Renamed profile '${plan.profile}' to '${plan.newProfile}'.`);
  }
  return 0;
}

async function executeStatus(
  name: string | undefined,
  dependencies: ProfileCommandDependencies,
  runtime: ProfileCommandRuntime,
): Promise<number> {
  const options: ProfileRuntimeOptions = {};
  const selectedName = await resolveProfileName(
    'status',
    name,
    dependencies,
    runtime,
    options,
  );
  if (!selectedName) {
    if (!runtime.isJson()) runtime.print('Profile status cancelled.');
    return 0;
  }

  const result = await dependencies.getProfileStatus(selectedName, options);
  const success = result.error === undefined;
  emitResult('profile status', result, runtime, success);
  return success ? 0 : 1;
}

async function handleCommand(
  commandName: string,
  runtime: ProfileCommandRuntime,
  action: () => Promise<number>,
): Promise<void> {
  let exitCode = 0;
  try {
    exitCode = await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    exitCode = error instanceof ProfileCommandError ? error.exitCode : 1;
    if (runtime.isJson()) {
      runtime.printJson({
        success: false,
        command: commandName,
        ...(error instanceof ProfileCommandError && error.data
          ? { data: { ...error.data, error: message } }
          : {}),
        error: message,
      });
    } else {
      runtime.printError(`Error: ${terminalSafe(message)}`);
    }
  }
  if (exitCode !== 0) runtime.exit(exitCode);
}

export function createProfileCommand(
  dependencies: ProfileCommandDependencies = defaultDependencies,
  runtime: ProfileCommandRuntime = defaultRuntime,
) {
  const installCmd = command({
    name: 'install',
    description: buildDescription(profileInstallMeta),
    args: {
      name: positional({ type: optional(string), displayName: 'name' }),
      yes: flag({
        long: 'yes',
        short: 'y',
        description: 'Apply without asking for confirmation',
      }),
      dryRun: flag({
        long: 'dry-run',
        description: 'Display the plan without making changes',
      }),
      offline: flag({
        long: 'offline',
        description: 'Use only locally available sources',
      }),
    },
    handler: (args) =>
      handleCommand('profile install', runtime, () =>
        executeMutation('install', args, dependencies, runtime),
      ),
  });

  const listCmd = command({
    name: 'list',
    description: buildDescription(profileListMeta),
    args: {},
    handler: () =>
      handleCommand('profile list', runtime, () =>
        executeList(dependencies, runtime),
      ),
  });

  const statusCmd = command({
    name: 'status',
    description: buildDescription(profileStatusMeta),
    args: {
      name: positional({ type: optional(string), displayName: 'name' }),
    },
    handler: ({ name }) =>
      handleCommand('profile status', runtime, () =>
        executeStatus(name, dependencies, runtime),
      ),
  });

  const removeCmd = command({
    name: 'remove',
    description: buildDescription(profileRemoveMeta),
    args: {
      name: positional({ type: optional(string), displayName: 'name' }),
      yes: flag({
        long: 'yes',
        short: 'y',
        description: 'Apply without asking for confirmation',
      }),
      purgeSessionData: flag({
        long: 'purge-session-data',
        description: 'Also delete session data in owned profile runtime roots',
      }),
      dryRun: flag({
        long: 'dry-run',
        description: 'Display the plan without making changes',
      }),
      offline: flag({
        long: 'offline',
        description: 'Use only locally available sources',
      }),
    },
    handler: (args) =>
      handleCommand('profile remove', runtime, () =>
        executeMutation('remove', args, dependencies, runtime),
      ),
  });

  const renameCmd = command({
    name: 'rename',
    description: buildDescription(profileRenameMeta),
    args: {
      profile: positional({ type: string, displayName: 'old' }),
      newProfile: positional({ type: string, displayName: 'new' }),
      yes: flag({
        long: 'yes',
        short: 'y',
        description: 'Apply without asking for confirmation',
      }),
      dryRun: flag({
        long: 'dry-run',
        description: 'Display the plan without making changes',
      }),
    },
    handler: (args) =>
      handleCommand('profile rename', runtime, () => executeRename(args, runtime)),
  });

  return conciseSubcommands({
    name: 'profile',
    description: 'Manage global agent profiles',
    cmds: {
      install: installCmd,
      list: listCmd,
      status: statusCmd,
      remove: removeCmd,
      rename: renameCmd,
    },
  });
}

export const profileCmd = createProfileCommand();
