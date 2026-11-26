import { randomUUID } from 'node:crypto';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type {
  ProfileResourceRelationship,
  ProfileState,
} from '../../models/profile-state.js';
import {
  type ProfileDeclaration,
  ProfileNameSchema,
} from '../../models/workspace-config.js';
import {
  profileRenameRecordPath,
  withWorkspaceConfigLock,
} from '../../utils/workspace-config-lock.js';
import { validateUserWorkspaceConfig } from '../../utils/workspace-parser.js';
import { serializeWorkspaceConfig } from '../../utils/workspace-writer.js';
import { loadYaml } from '../../utils/yaml.js';
import { getProfileAdapter } from './adapters/registry.js';
import {
  assertSafeProfilePath,
  fingerprintProfileFile,
  sha256Fingerprint,
} from './files.js';
import type { ProfileRuntimeOptions } from './index.js';
import { renderProfileLaunchers } from './launcher.js';
import {
  getProfileRoot,
  type ResolvedProfileRuntime,
  resolveProfileRuntimeOptions,
} from './plan.js';
import {
  capturedRenameFile,
  getRenameRootIdentity,
  inspectRenameProgress,
  inspectReplacement,
  moveNamedProfileFile,
  moveProfileRoot,
  profileRenameStats,
  publishRenameFile,
  readProfileRenameRecord,
  relativeRenamePath,
  type RenameRecord,
  writeRenameRecord,
} from './rename-transaction.js';
import {
  getProfileStatePath,
  hashProfileDeclaration,
  loadProfileState,
  sanitizeProfileError,
  sanitizeProfileState,
} from './state.js';

export interface ProfileRenamePlan {
  readonly profile: string;
  readonly newProfile: string;
  readonly operation: 'rename';
  readonly status: 'planned';
  readonly installed: boolean;
  readonly recovering: boolean;
  readonly steps: readonly {
    readonly kind: 'workspace' | 'root' | 'settings' | 'launcher' | 'state';
    readonly from: string;
    readonly to: string;
  }[];
  readonly warnings: readonly string[];
}

interface RenamePlanDetails {
  readonly runtime: ResolvedProfileRuntime;
  readonly record: RenameRecord;
  readonly workspaceContent: string;
  readonly workspaceBefore: string;
  readonly workspaceMode: number;
}

const plans = new WeakMap<ProfileRenamePlan, RenamePlanDetails>();

async function checkProfileTree(root: string): Promise<void> {
  for (const item of await readdir(root, { withFileTypes: true })) {
    const path = join(root, item.name);
    if (item.isDirectory()) await checkProfileTree(path);
    else if (!item.isFile()) throw new Error(`Unsafe profile entry: ${path}`);
  }
}

function replaceDeclaration(
  content: string,
  workspacePath: string,
  profile: string,
  newProfile: string,
) {
  const config = loadYaml(content) as { profiles?: Record<string, unknown> };
  const { profiles } = validateUserWorkspaceConfig(config, workspacePath);
  if (!profiles || !Object.hasOwn(profiles, profile)) {
    throw new Error(`Profile '${profile}' is not declared`);
  }
  if (Object.hasOwn(profiles, newProfile)) {
    throw new Error(`Profile '${newProfile}' is already declared`);
  }
  const updated = {
    ...config,
    profiles: Object.fromEntries(
      Object.entries(config.profiles ?? {}).map(([name, value]) => [
        name === profile ? newProfile : name,
        value,
      ]),
    ),
  };
  validateUserWorkspaceConfig(updated, workspacePath);
  return {
    declaration: profiles[profile] as ProfileDeclaration,
    content: serializeWorkspaceConfig(updated, content, {
      renamedProfile: { from: profile, to: newProfile },
    }),
  };
}

function relocateResource(
  resource: ProfileResourceRelationship,
  path: string,
): ProfileResourceRelationship {
  return {
    ...resource,
    path,
    identity: path,
    key: `${resource.kind}:${resource.client}:${sha256Fingerprint(path)}`,
  };
}

async function planInstalledRename(
  runtime: ResolvedProfileRuntime,
  profile: string,
  newProfile: string,
  declaration: ProfileDeclaration,
  state: ProfileState,
  stateFingerprint: string,
): Promise<
  Pick<RenameRecord, 'launchers'> &
    Pick<NonNullable<RenameRecord['root']>, 'namedFiles' | 'state'>
> {
  const oldRoot = getProfileRoot(runtime, profile);
  const newRoot = getProfileRoot(runtime, newProfile);
  if (
    JSON.stringify(declaration).includes(JSON.stringify(oldRoot).slice(1, -1))
  ) {
    throw new Error(
      'The profile declaration contains a path inside the old profile directory. Update it before renaming.',
    );
  }
  if (
    state.profile !== profile ||
    state.status !== 'installed' ||
    !state.operation.completedAt ||
    state.operation.kind === 'remove' ||
    state.declarationDigest !== hashProfileDeclaration(declaration)
  ) {
    throw new Error(
      'The profile must have a complete installation matching its current declaration before rename.',
    );
  }
  const active = state.resources.filter(
    (entry) => entry.transition !== 'removed',
  );
  if (
    active.some(
      (entry) =>
        entry.kind === 'native' ||
        entry.kind === 'marketplace' ||
        !['installed', 'updated', 'referenced'].includes(entry.transition),
    )
  ) {
    throw new Error(
      'Profile rename requires file-only resources and a complete installation.',
    );
  }
  const clientDirectory = join(oldRoot, 'clients');
  const clientEntries = await readdir(clientDirectory);
  if (
    clientEntries.some(
      (entry) => !state.clients.some((client) => client === entry),
    )
  ) {
    throw new Error(
      `Profile contains an unrecognized client directory: ${clientDirectory}`,
    );
  }

  const launchers: RenameRecord['launchers'] = [];
  const namedFiles: NonNullable<RenameRecord['root']>['namedFiles'] = [];
  const resources = new Map<string, ProfileResourceRelationship>();
  for (const { name: client, launcher } of declaration.clients) {
    const adapter = getProfileAdapter(client);
    if (!adapter?.rename) {
      throw new Error(
        `Installed profile rename is unsupported for '${client}'`,
      );
    }
    const before = adapter.resolveContext(profile, runtime);
    const after = adapter.resolveContext(newProfile, runtime);
    const beforeLocations = Object.values(before.operationContext.roots ?? {});
    const afterLocations = Object.values(after.operationContext.roots ?? {});
    for (const [index, location] of [
      before.root,
      ...beforeLocations,
    ].entries()) {
      if (
        relativeRenamePath(oldRoot, location) !==
        relativeRenamePath(
          newRoot,
          [after.root, ...afterLocations][index] ?? newRoot,
        )
      ) {
        throw new Error(
          `Profile client '${client}' has a non-relocatable directory layout`,
        );
      }
    }
    const managedRoot = before.operationContext.roots?.config ?? before.root;
    const clientResources = active.filter((entry) => entry.client === client);
    if (
      !clientResources.some(
        (entry) =>
          entry.kind === 'root' &&
          entry.path === managedRoot &&
          entry.ownership === 'managed',
      ) ||
      !(await profileRenameStats(managedRoot))?.isDirectory()
    ) {
      throw new Error(
        `Profile client directory is missing or unowned: ${managedRoot}`,
      );
    }
    await adapter.rename.assertRelocatable?.(before, runtime);
    for (const path of launcher ? (before.launcher.requiredFiles ?? []) : []) {
      await assertSafeProfilePath(before.root, path);
      if (!(await profileRenameStats(path))?.isFile()) {
        throw new Error(`Profile launcher requires a regular file at ${path}`);
      }
    }
    for (const name of adapter.rename.nativeLocations ?? []) {
      const path = join(before.root, name);
      await assertSafeProfilePath(before.root, path);
      const stats = await profileRenameStats(path);
      if (stats && (!stats.isDirectory() || (await readdir(path)).length > 0)) {
        throw new Error(
          `Profile client '${client}' has native data in ${path}`,
        );
      }
    }

    const namedChanges = new Map<string, string>();
    for (const [index, name] of (
      adapter.rename.namedFiles?.(profile) ?? []
    ).entries()) {
      const from = join(before.root, name);
      const replacement = adapter.rename.namedFiles?.(newProfile)[index];
      if (!replacement)
        throw new Error(
          `Profile client '${client}' did not resolve a settings destination`,
        );
      const to = join(before.root, replacement);
      const tracked = clientResources.find(
        (entry) => entry.kind === 'settings' && entry.path === from,
      );
      if (
        tracked?.ownership !== 'managed' ||
        !tracked.fingerprint ||
        tracked.fingerprint !== (await fingerprintProfileFile(from))
      ) {
        throw new Error(
          `Profile settings are missing, modified, or unowned: ${from}`,
        );
      }
      namedFiles.push({
        from: relativeRenamePath(oldRoot, from),
        to: relativeRenamePath(oldRoot, to),
        fingerprint: tracked.fingerprint,
      });
      namedChanges.set(from, relativeRenamePath(oldRoot, to));
    }

    const rendered = launcher
      ? renderProfileLaunchers(launcher, after.launcher).filter((entry) =>
          runtime.platform === 'win32'
            ? entry.companion !== 'posix'
            : entry.companion === 'posix',
        )
      : [];
    const launcherResources = clientResources.filter(
      (entry) => entry.kind === 'launcher',
    );
    if (rendered.length !== launcherResources.length) {
      throw new Error(
        `Profile launchers for '${client}' differ from the installed declaration`,
      );
    }
    for (const entry of rendered) {
      const path = join(runtime.binDir, entry.fileName);
      const owner = launcherResources.find(
        (resource) => resource.path === path && resource.identity === path,
      );
      await assertSafeProfilePath(runtime.binDir, path);
      const actual = await fingerprintProfileFile(path);
      if (
        !actual ||
        owner?.ownership !== 'managed' ||
        owner.fingerprint !== actual
      ) {
        throw new Error(
          `Profile launcher is missing, modified, or unowned: ${path}`,
        );
      }
      launchers.push({
        name: entry.fileName,
        before: actual,
        content: entry.content,
        mode: entry.mode,
      });
      resources.set(owner.key, {
        ...owner,
        fingerprint: sha256Fingerprint(entry.content),
      });
    }

    for (const resource of clientResources) {
      if (resource.kind === 'launcher') continue;
      if (
        !resource.path ||
        resource.path !== resource.identity ||
        (resource.kind === 'root' && resource.path !== managedRoot)
      ) {
        throw new Error(
          `Profile client '${client}' has an unexpected resource identity`,
        );
      }
      await assertSafeProfilePath(
        resource.kind === 'root' ? oldRoot : before.root,
        resource.path,
      );
      if (resource.kind === 'mcp' || resource.kind === 'settings') {
        const content = await readFile(resource.path, 'utf8').catch((error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
          throw error;
        });
        if (
          content.includes('--profile') ||
          content.includes(oldRoot) ||
          content.includes(JSON.stringify(oldRoot).slice(1, -1))
        ) {
          throw new Error(
            `Profile-bound configuration cannot be relocated safely: ${resource.path}`,
          );
        }
      }
      resources.set(
        resource.key,
        relocateResource(
          resource,
          join(
            newRoot,
            namedChanges.get(resource.path) ??
              relativeRenamePath(oldRoot, resource.path),
          ),
        ),
      );
    }
  }
  const newState = sanitizeProfileState({
    ...state,
    profile: newProfile,
    resources: active.map(({ key }) => {
      const moved = resources.get(key);
      if (!moved)
        throw new Error(
          'The installed client set differs from the declaration',
        );
      return moved;
    }),
  });
  return {
    namedFiles,
    launchers,
    state: {
      before: stateFingerprint,
      content: `${JSON.stringify(newState, null, 2)}\n`,
    },
  };
}

async function prepareRename(
  profile: string,
  newProfile: string,
  runtime: ResolvedProfileRuntime,
  id: string = randomUUID(),
): Promise<
  RenamePlanDetails & {
    readonly installed: boolean;
    readonly recovering: boolean;
  }
> {
  const workspacePath = runtime.userConfigPath;
  await assertSafeProfilePath(dirname(workspacePath), workspacePath);
  const existing = await readProfileRenameRecord(
    profileRenameRecordPath(workspacePath),
  );
  if (
    existing &&
    (existing.profile !== profile || existing.newProfile !== newProfile)
  ) {
    throw new Error(
      `Profile rename is incomplete. Rerun 'allagents profile rename ${existing.profile} ${existing.newProfile} --yes'.`,
    );
  }
  const capturedPath = existing
    ? capturedRenameFile(workspacePath, existing.id)
    : undefined;
  if (capturedPath)
    await assertSafeProfilePath(dirname(workspacePath), capturedPath);
  const workspaceStats = await profileRenameStats(workspacePath);
  const capturedStats = capturedPath
    ? await profileRenameStats(capturedPath)
    : null;
  const selected = workspaceStats ?? capturedStats;
  if (!selected?.isFile() || (capturedStats && !capturedStats.isFile())) {
    throw new Error(
      `Workspace is unavailable or is not a regular file: ${workspacePath}`,
    );
  }
  const workspaceMode = selected.mode & 0o777;
  const original = await readFile(
    workspaceStats ? workspacePath : (capturedPath ?? workspacePath),
  );
  const current = original.toString('utf8');
  const fingerprint = sha256Fingerprint(original);
  if (sha256Fingerprint(current) !== fingerprint) {
    throw new Error(`Workspace is not valid UTF-8: ${workspacePath}`);
  }
  const oldRoot = getProfileRoot(runtime, profile);
  const newRoot = getProfileRoot(runtime, newProfile);

  if (existing) {
    const { profiles } = validateUserWorkspaceConfig(
      loadYaml(current),
      workspacePath,
    );
    const oldDeclaration =
      profiles && Object.hasOwn(profiles, profile)
        ? profiles[profile]
        : undefined;
    const newDeclaration =
      profiles && Object.hasOwn(profiles, newProfile)
        ? profiles[newProfile]
        : undefined;
    let workspaceContent = current;
    let workspaceBefore = existing.workspaceBefore;
    if (
      oldDeclaration &&
      !newDeclaration &&
      hashProfileDeclaration(oldDeclaration) === existing.declarationDigest
    ) {
      workspaceContent = replaceDeclaration(
        current,
        workspacePath,
        profile,
        newProfile,
      ).content;
      if (workspaceStats && !capturedStats) workspaceBefore = fingerprint;
    } else if (
      oldDeclaration ||
      !newDeclaration ||
      hashProfileDeclaration(newDeclaration) !== existing.declarationDigest
    ) {
      throw new Error(
        'The profile declaration changed during rename. Restore it before retrying.',
      );
    }
    await inspectReplacement(
      workspacePath,
      workspaceBefore,
      sha256Fingerprint(workspaceContent),
      existing.id,
    );
    await inspectRenameProgress(existing, oldRoot, newRoot, runtime.binDir);
    return {
      runtime,
      record: existing,
      workspaceContent,
      workspaceBefore,
      workspaceMode,
      installed: !!existing.root?.state,
      recovering: true,
    };
  }

  const updated = replaceDeclaration(
    current,
    workspacePath,
    profile,
    newProfile,
  );
  await assertSafeProfilePath(dirname(oldRoot), oldRoot);
  await assertSafeProfilePath(dirname(newRoot), newRoot);
  if (await profileRenameStats(newRoot)) {
    throw new Error(`Profile destination already exists: ${newRoot}`);
  }
  const identity = await getRenameRootIdentity(oldRoot);
  const stateFingerprint = await fingerprintProfileFile(
    getProfileStatePath(oldRoot),
  );
  const loaded = await loadProfileState(oldRoot);
  if (loaded.status === 'malformed') {
    throw new Error(
      `Refusing profile rename because state is malformed: ${loaded.error}`,
    );
  }
  if (identity) await checkProfileTree(oldRoot);
  if (identity && loaded.status === 'missing') {
    const entries = await readdir(oldRoot);
    if (
      entries.some((entry) => entry !== 'oauth-proxy') ||
      (entries.length &&
        !(
          await profileRenameStats(join(oldRoot, 'oauth-proxy'))
        )?.isDirectory())
    ) {
      throw new Error(
        `Profile directory exists without installation state: ${oldRoot}`,
      );
    }
  }
  const installed = loaded.status === 'loaded';
  if (installed && !stateFingerprint)
    throw new Error('Profile state appeared during rename planning');
  const assets =
    loaded.status === 'loaded' && stateFingerprint
      ? await planInstalledRename(
          runtime,
          profile,
          newProfile,
          updated.declaration,
          loaded.state,
          stateFingerprint,
        )
      : { namedFiles: [], launchers: [], state: undefined };
  const record: RenameRecord = {
    version: 1,
    id,
    profile,
    newProfile,
    declarationDigest: hashProfileDeclaration(updated.declaration),
    workspaceBefore: fingerprint,
    ...(identity && {
      root: { ...identity, namedFiles: assets.namedFiles, state: assets.state },
    }),
    launchers: assets.launchers,
  };
  await inspectRenameProgress(record, oldRoot, newRoot, runtime.binDir);
  return {
    runtime,
    record,
    workspaceContent: updated.content,
    workspaceBefore: fingerprint,
    workspaceMode,
    installed,
    recovering: false,
  };
}

export async function planProfileRename(
  profile: string,
  newProfile: string,
  options: ProfileRuntimeOptions = {},
): Promise<ProfileRenamePlan> {
  ProfileNameSchema.parse(profile);
  ProfileNameSchema.parse(newProfile);
  if (profile === newProfile)
    throw new Error('Choose a different profile name.');
  const runtime = resolveProfileRuntimeOptions(options);
  const details = await prepareRename(profile, newProfile, runtime);
  const { record, installed, recovering } = details;
  const steps: ProfileRenamePlan['steps'][number][] = [];
  const oldRoot = getProfileRoot(runtime, profile);
  const newRoot = getProfileRoot(runtime, newProfile);
  if (record.root) {
    steps.push({ kind: 'root', from: oldRoot, to: newRoot });
    for (const file of record.root.namedFiles) {
      steps.push({
        kind: 'settings',
        from: join(oldRoot, file.from),
        to: join(newRoot, file.to),
      });
    }
  }
  for (const file of record.launchers) {
    const path = join(runtime.binDir, file.name);
    steps.push({ kind: 'launcher', from: path, to: path });
  }
  if (record.root?.state) {
    steps.push({
      kind: 'state',
      from: getProfileStatePath(oldRoot),
      to: getProfileStatePath(newRoot),
    });
  }
  steps.push({
    kind: 'workspace',
    from: runtime.userConfigPath,
    to: runtime.userConfigPath,
  });
  const plan: ProfileRenamePlan = {
    profile,
    newProfile,
    installed,
    recovering,
    steps,
    operation: 'rename',
    status: 'planned',
    warnings: installed
      ? [
          'Close clients using this profile before applying. Update external references such as T3 provider paths after the rename.',
        ]
      : [],
  };
  plans.set(plan, details);
  return plan;
}

export async function applyProfileRename(
  plan: ProfileRenamePlan,
): Promise<void> {
  const initial = plans.get(plan);
  if (!initial || initial.runtime.dryRun)
    throw new Error('A fresh apply plan is required.');
  const { runtime } = initial;
  const workspace = runtime.userConfigPath;
  const journal = profileRenameRecordPath(workspace);
  await withWorkspaceConfigLock(workspace, async () => {
    const current = await prepareRename(
      plan.profile,
      plan.newProfile,
      runtime,
      initial.record.id,
    );
    const record = {
      ...current.record,
      workspaceBefore: current.workspaceBefore,
    };
    if (
      !isDeepStrictEqual(initial.record, current.record) ||
      initial.workspaceBefore !== current.workspaceBefore ||
      initial.workspaceContent !== current.workspaceContent
    ) {
      throw new Error(
        'The profile changed after preview. Rerun the rename to see the updated plan.',
      );
    }
    const oldRoot = getProfileRoot(runtime, record.profile);
    const newRoot = getProfileRoot(runtime, record.newProfile);
    try {
      if (
        !current.recovering ||
        record.workspaceBefore !== current.record.workspaceBefore
      ) {
        await writeRenameRecord(journal, record, current.recovering);
      }
      const progress = await inspectRenameProgress(
        record,
        oldRoot,
        newRoot,
        runtime.binDir,
      );
      if (progress.moveRoot)
        await moveProfileRoot(record, journal, oldRoot, newRoot);
      for (const move of progress.moves)
        await moveNamedProfileFile(newRoot, move, record.id);
      for (const { name, content, before, mode } of record.launchers) {
        await publishRenameFile(
          join(runtime.binDir, name),
          content,
          before,
          mode,
          record.id,
        );
      }
      if (record.root?.state) {
        const { before, content } = record.root.state;
        await publishRenameFile(
          getProfileStatePath(newRoot),
          content,
          before,
          0o600,
          record.id,
        );
      }
      await publishRenameFile(
        workspace,
        current.workspaceContent,
        current.workspaceBefore,
        current.workspaceMode,
        record.id,
      );
      await unlink(journal);
    } catch (error) {
      const message = sanitizeProfileError(
        error instanceof Error ? error.message : String(error),
      );
      throw new Error(
        `${message}. Rerun 'allagents profile rename ${record.profile} ${record.newProfile} --yes' to resume.`,
        { cause: error },
      );
    }
  });
}
