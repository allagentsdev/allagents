import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rm, rmdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type {
  ProfileResourceRelationship,
  ProfileState,
} from '../../models/profile-state.js';
import {
  type ClientType,
  type ProfileDeclaration,
  ProfileNameSchema,
} from '../../models/workspace-config.js';
import { getProfileAdapter } from './adapters/registry.js';
import {
  assertSafeProfilePath,
  fingerprintProfileFile,
  materializeManagedFile,
  removeManagedFile,
  sha256Fingerprint,
} from './files.js';
import type {
  ProfileApplyResult,
  ProfileApplyStep,
  ProfileApplyStepStatus,
  ProfilePlan,
  ProfilePlanAction,
  ProfileRuntimeOptions,
  ProfileStatusResult,
} from './index.js';
import { diagnoseLauncherPath, renderProfileLaunchers } from './launcher.js';
import {
  getInternalProfilePlan,
  getProfileRoot,
  type InternalProfilePlan,
  type InternalProfilePlanStep,
  type ProfilePlanDependencies,
  planProfileOperation,
  type ResolvedProfileRuntime,
  readOptionalProfileWorkspace,
  readProfileWorkspace,
  resolveProfileRuntimeOptions,
} from './plan.js';
import {
  checkpointProfileResource,
  createProfileState,
  getProfileStatePath,
  hashProfileDeclaration,
  loadProfileState,
  sanitizeProfileError,
  saveProfileState,
} from './state.js';
import { isNativeProfileAdapter, type ProfileAdapter } from './types.js';

export interface ProfileManagerDependencies extends ProfilePlanDependencies {
  readonly now?: () => Date;
}

function safeError(error: unknown): string {
  return (
    sanitizeProfileError(
      error instanceof Error ? error.message : String(error),
    ) ?? 'Profile operation failed'
  );
}

function resultStatus(action: ProfilePlanAction): ProfileApplyStepStatus {
  switch (action) {
    case 'create':
      return 'created';
    case 'update':
      return 'updated';
    case 'remove':
      return 'removed';
    case 'reference':
      return 'referenced';
    case 'retain':
      return 'retained';
    default:
      return 'unchanged';
  }
}

function appliedStep(
  step: InternalProfilePlanStep,
  status: ProfileApplyStepStatus,
  error?: string,
): ProfileApplyStep {
  return {
    client: step.public.client,
    kind: step.public.kind,
    identity: step.public.identity,
    status,
    ...(error && { error }),
  };
}

function operationTimestamp(dependencies: ProfileManagerDependencies): string {
  return (dependencies.now?.() ?? new Date()).toISOString();
}

function prepareExistingState(
  internal: InternalProfilePlan,
  startedAt: string,
): ProfileState {
  if (!internal.priorState) {
    if (!internal.declaration)
      throw new Error('Cannot create profile state without a declaration');
    return createProfileState({
      profile: internal.public.profile,
      clients: internal.clients,
      declaration: internal.declaration,
      operation: {
        id: randomUUID(),
        kind: internal.public.operation,
        startedAt,
      },
    });
  }
  const clients = [...internal.priorState.clients];
  for (const client of internal.clients)
    if (!clients.includes(client)) clients.push(client);
  return {
    ...internal.priorState,
    clients,
    declarationDigest: internal.public.declarationDigest,
    status: 'partial',
    clientStatuses: clients.map((client) => ({
      client,
      status: 'partial' as const,
    })),
    operation: {
      id: randomUUID(),
      kind: internal.public.operation,
      startedAt,
      updatedAt: startedAt,
    },
  };
}

function transitioned(
  relationship: ProfileResourceRelationship,
  transition: ProfileResourceRelationship['transition'],
  error?: string,
): ProfileResourceRelationship {
  return {
    ...relationship,
    transition,
    ...(error ? { error } : { error: undefined }),
  };
}

async function checkpoint(
  internal: InternalProfilePlan,
  state: ProfileState,
  relationship: ProfileResourceRelationship,
  dependencies: ProfileManagerDependencies,
  error?: string,
): Promise<ProfileState> {
  return checkpointProfileResource(
    getProfileRoot(internal.runtime, internal.public.profile),
    state,
    relationship,
    {
      clientStatus: 'partial',
      ...(error && { clientError: error }),
      operation: { kind: internal.public.operation },
      now: operationTimestamp(dependencies),
    },
  );
}
async function removeEmptyManagedRoot(root: string): Promise<boolean> {
  await assertSafeProfilePath(root, root);
  const stats = await lstat(root).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!stats) return true;
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Managed profile root is not a real directory: ${root}`);
  }
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    await removeEmptyManagedRoot(join(root, entry.name));
  }
  try {
    await rmdir(root);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') return false;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

async function removeProfileOAuthProxyRoot(profileRoot: string): Promise<void> {
  const oauthProxyRoot = join(profileRoot, 'oauth-proxy');
  await assertSafeProfilePath(profileRoot, oauthProxyRoot);
  const stats = await lstat(oauthProxyRoot).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!stats) return;
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(
      `Profile OAuth proxy root is not a real directory: ${oauthProxyRoot}`,
    );
  }
  await assertSafeProfilePath(profileRoot, oauthProxyRoot);
  await rm(oauthProxyRoot, { recursive: true, force: true });
}

async function removeOwnedManagedRoot(
  root: string,
  expectedRoot: string,
): Promise<void> {
  if (resolve(root) !== resolve(expectedRoot)) {
    throw new Error(
      `Refusing to remove managed profile root outside the selected client root: ${root}`,
    );
  }
  await assertSafeProfilePath(expectedRoot, root);
  const stats = await lstat(root).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!stats) return;
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Managed profile root is not a real directory: ${root}`);
  }
  await rm(root, { recursive: true, force: true });
}

async function applyOneStep(
  internal: InternalProfilePlan,
  step: InternalProfilePlanStep,
  state: ProfileState,
): Promise<{
  status: ProfileApplyStepStatus;
  registrations?: readonly string[];
  error?: string;
}> {
  const action = step.public.action;
  if (action === 'reference') return { status: 'referenced' };
  if (action === 'retain') return { status: 'retained' };
  if (action === 'unchanged') return { status: 'unchanged' };

  if (step.public.kind === 'root') {
    if (!step.path || !step.root)
      throw new Error('Profile root plan is incomplete');
    if (action === 'remove') {
      const unresolvedResource = state.resources.some(
        (resource) =>
          resource.key !== step.relationship.key &&
          resource.client === step.public.client &&
          resource.transition !== 'removed',
      );
      if (unresolvedResource) return { status: 'retained' };
      if (!step.context)
        throw new Error('Profile root plan has no selected client context');
      const expectedRoot =
        step.context.operationContext.roots?.config ?? step.context.root;
      const adapter = internal.adapters.get(step.public.client);
      if (!adapter)
        throw new Error(
          `Profile root plan has no adapter for ${step.public.client}`,
        );
      if (adapter.capabilities.recursiveRootCleanup) {
        await removeOwnedManagedRoot(step.path, expectedRoot);
        return { status: 'removed' };
      }
      await assertSafeProfilePath(expectedRoot, step.path);
      await adapter.prepareRootCleanup?.(step.context);
      return {
        status: (await removeEmptyManagedRoot(step.path))
          ? 'removed'
          : 'retained',
      };
    }
    await assertSafeProfilePath(step.root, step.path);
    await mkdir(step.path, { recursive: true, mode: 0o700 });
    return { status: 'created' };
  }

  if (step.requiresMcpPrerequisite) {
    if (!step.context) {
      throw new Error('MCP plan has no selected client context');
    }
    const client = step.public.client;
    const prerequisite = internal.adapters.get(client)?.mcpPrerequisite;
    if (!prerequisite) {
      throw new Error(
        `${client} profile adapter cannot verify the MCP prerequisite`,
      );
    }
    const inspection = await prerequisite.inspect(step.context);
    if (inspection.classification !== 'usable') {
      throw new Error(
        `${client} profile MCP requires a usable native prerequisite after package installation; found ${inspection.classification}`,
      );
    }
  }

  if (['file', 'settings', 'mcp', 'launcher'].includes(step.public.kind)) {
    if (!step.path)
      throw new Error(`Profile ${step.public.kind} plan has no path`);
    const root =
      step.public.kind === 'launcher'
        ? internal.runtime.binDir
        : (step.context?.root ?? step.root);
    if (!root)
      throw new Error(`Profile ${step.public.kind} plan has no write root`);
    if (action === 'remove') {
      const removal = await removeManagedFile({
        root,
        path: step.path,
        ownership: step.relationship.ownership,
        ...(step.relationship.fingerprint && {
          expectedFingerprint: step.relationship.fingerprint,
        }),
      });
      if (
        removal.status === 'retained-modified' ||
        removal.status === 'retained-referenced'
      ) {
        return { status: 'retained' };
      }
      return { status: removal.status === 'removed' ? 'removed' : 'unchanged' };
    }
    if (step.content === undefined || step.mode === undefined) {
      throw new Error(
        `Profile ${step.public.kind} materialization plan is incomplete`,
      );
    }
    const materialized = await materializeManagedFile({
      root,
      path: step.path,
      content: step.content,
      mode: step.mode,
      ...(step.previousFingerprint && {
        previousFingerprint: step.previousFingerprint,
      }),
    });
    return { status: materialized.status };
  }

  if (step.public.kind === 'native') {
    if (!step.context || !step.nativeResource) {
      if (action === 'remove' && !step.nativeResource) {
        return { status: 'unchanged' };
      }
      throw new Error('Native profile plan is incomplete');
    }
    const adapter = internal.adapters.get(step.public.client);
    if (!adapter || !isNativeProfileAdapter(adapter)) {
      throw new Error(
        `Profile adapter disappeared or has no native lifecycle for ${step.public.client}`,
      );
    }
    const result =
      action === 'remove'
        ? await adapter.nativeClient.remove(
            step.nativeResource,
            step.context.operationContext,
          )
        : action === 'update' && step.currentNativeResource
          ? await adapter.nativeClient.update(
              step.nativeResource,
              step.currentNativeResource,
              step.context.operationContext,
            )
          : await adapter.nativeClient.install(
              step.nativeResource,
              step.context.operationContext,
            );
    if (!result.success) {
      return {
        status: 'failed',
        ...(result.registrations && { registrations: result.registrations }),
        error: result.error ?? `${step.public.client} native ${action} failed`,
      };
    }
    return {
      status:
        action === 'remove'
          ? 'removed'
          : action === 'update'
            ? 'updated'
            : 'created',
      ...(result.registrations && { registrations: result.registrations }),
    };
  }

  if (step.public.kind === 'marketplace') {
    if (!step.context) throw new Error('Marketplace plan has no context');
    const adapter = internal.adapters.get(step.public.client);
    if (!adapter || !isNativeProfileAdapter(adapter)) {
      throw new Error(
        `${step.public.client} profile adapter has no native marketplace lifecycle`,
      );
    }
    if (action === 'create') {
      if (
        !step.marketplaceRegistration ||
        !adapter.applyMarketplaceRegistration
      ) {
        throw new Error(
          `${step.public.client} profile adapter cannot register marketplaces`,
        );
      }
      const result = await adapter.applyMarketplaceRegistration(
        step.marketplaceRegistration,
        step.context,
      );
      if (!result.success) {
        throw new Error(
          result.error ??
            `Could not register marketplace '${step.marketplaceRegistration.name}'`,
        );
      }
      return { status: 'created' };
    }
    if (action !== 'remove') return { status: resultStatus(action) };
    if (!adapter.removeMarketplaceRegistration) {
      throw new Error(
        `${step.public.client} profile adapter cannot remove marketplace registrations`,
      );
    }
    const marketplaceName =
      step.relationship.provenance?.marketplaceName ??
      step.relationship.identity;
    const result = await adapter.removeMarketplaceRegistration(
      marketplaceName,
      step.context,
    );
    if (!result.success) {
      throw new Error(
        result.error ?? `Could not remove marketplace '${marketplaceName}'`,
      );
    }
    return { status: 'removed' };
  }

  return { status: resultStatus(action) };
}

function completedRelationship(
  step: InternalProfilePlanStep,
  status: ProfileApplyStepStatus,
  removing: boolean,
): ProfileResourceRelationship {
  const transition: ProfileResourceRelationship['transition'] =
    status === 'removed' || (status === 'unchanged' && removing)
      ? 'removed'
      : status === 'retained'
        ? 'retained'
        : status === 'referenced'
          ? 'referenced'
          : status === 'updated'
            ? 'updated'
            : 'installed';
  const released =
    status === 'retained'
      ? {
          ...step.relationship,
          ownership: 'referenced' as const,
          cleanup: 'none' as const,
        }
      : step.relationship;
  return transitioned(released, transition);
}

function pendingTransition(
  step: InternalProfilePlanStep,
): ProfileResourceRelationship['transition'] {
  if (step.public.action === 'remove') return 'pending-remove';
  if (step.public.action === 'update') return 'pending-update';
  return 'pending-install';
}

function checkpointRelationship(
  step: InternalProfilePlanStep,
  transition: ProfileResourceRelationship['transition'],
  error?: string,
): ProfileResourceRelationship {
  const relationship =
    step.public.action === 'update' && step.previousFingerprint
      ? { ...step.relationship, fingerprint: step.previousFingerprint }
      : step.relationship;
  return transitioned(relationship, transition, error);
}

function dryRunResult(internal: InternalProfilePlan): ProfileApplyResult {
  return {
    profile: internal.public.profile,
    operation: internal.public.operation,
    status: internal.public.operation === 'remove' ? 'removed' : 'installed',
    success: true,
    steps: internal.steps.map((step) =>
      appliedStep(step, resultStatus(step.public.action)),
    ),
    warnings: internal.public.warnings,
  };
}

export async function applyProfilePlan(
  plan: ProfilePlan,
  options: ProfileRuntimeOptions = {},
  dependencies: ProfileManagerDependencies = {},
): Promise<ProfileApplyResult> {
  const internal = getInternalProfilePlan(plan);
  if (options.dryRun || internal.runtime.dryRun) return dryRunResult(internal);
  const profileRoot = getProfileRoot(internal.runtime, plan.profile);
  let state: ProfileState;
  try {
    state = prepareExistingState(internal, operationTimestamp(dependencies));
    state = await saveProfileState(profileRoot, state);
  } catch (error) {
    const message = safeError(error);
    return {
      profile: plan.profile,
      operation: plan.operation,
      status: 'failed',
      success: false,
      steps: [],
      warnings: plan.warnings,
      error: message,
    };
  }

  const results: ProfileApplyStep[] = [];
  for (const step of internal.steps) {
    try {
      if (!['reference', 'retain', 'unchanged'].includes(step.public.action)) {
        state = await checkpoint(
          internal,
          state,
          checkpointRelationship(step, pendingTransition(step)),
          dependencies,
        );
      }
      const applied = await applyOneStep(internal, step, state);
      for (const registration of applied.registrations ?? []) {
        const marketplaceName =
          step.nativeResource?.provenance.marketplaceName ?? registration;
        const marketplace: ProfileResourceRelationship = {
          key: `marketplace:${step.public.client}:${sha256Fingerprint(marketplaceName)}`,
          client: step.public.client,
          kind: 'marketplace',
          identity: marketplaceName,
          ownership: 'managed',
          transition: 'installed',
          cleanup: 'marketplace',
          provenance: {
            marketplaceName,
            registrationIdentity: registration,
          },
        };
        state = await checkpoint(internal, state, marketplace, dependencies);
      }
      if (applied.status === 'failed') {
        throw new Error(
          applied.error ?? `${step.public.client} profile mutation failed`,
        );
      }
      const completed = completedRelationship(
        step,
        applied.status,
        internal.public.operation === 'remove',
      );
      state = await checkpoint(internal, state, completed, dependencies);
      results.push(appliedStep(step, applied.status));
    } catch (error) {
      const message = safeError(error);
      const failureTransition =
        step.public.action === 'remove' ? 'cleanup-failed' : 'failed';
      try {
        state = await checkpoint(
          internal,
          state,
          checkpointRelationship(step, failureTransition, message),
          dependencies,
          message,
        );
      } catch (checkpointError) {
        const checkpointMessage = safeError(checkpointError);
        results.push(
          appliedStep(
            step,
            'failed',
            `${message}; state checkpoint failed: ${checkpointMessage}`,
          ),
        );
        return {
          profile: plan.profile,
          operation: plan.operation,
          status: 'failed',
          success: false,
          steps: results,
          warnings: plan.warnings,
          error: `${message}; state checkpoint failed: ${checkpointMessage}`,
        };
      }
      results.push(appliedStep(step, 'failed', message));
      return {
        profile: plan.profile,
        operation: plan.operation,
        status: 'partial',
        success: false,
        steps: results,
        warnings: plan.warnings,
        error: message,
      };
    }
  }

  const completedAt = operationTimestamp(dependencies);
  const retainedManaged = state.resources.some(
    (resource) =>
      resource.ownership === 'managed' &&
      (resource.transition === 'retained' ||
        resource.transition === 'cleanup-failed'),
  );
  if (plan.operation === 'remove') {
    if (!retainedManaged) {
      try {
        await removeProfileOAuthProxyRoot(profileRoot);
        const statePath = getProfileStatePath(profileRoot);
        await assertSafeProfilePath(profileRoot, statePath);
        await rm(statePath, { force: true });
      } catch (error) {
        const message = safeError(error);
        return {
          profile: plan.profile,
          operation: plan.operation,
          status: 'partial',
          success: false,
          steps: results,
          warnings: plan.warnings,
          error: message,
        };
      }
      const warnings = [...plan.warnings];
      try {
        await removeEmptyManagedRoot(profileRoot);
      } catch (error) {
        warnings.push(
          `Profile resources were removed, but the empty profile directory could not be pruned: ${safeError(error)}`,
        );
      }
      return {
        profile: plan.profile,
        operation: plan.operation,
        status: 'removed',
        success: true,
        steps: results,
        warnings,
      };
    }
    state = await saveProfileState(profileRoot, {
      ...state,
      status: 'partial',
      clientStatuses: state.clients.map((client) => ({
        client,
        status: 'partial' as const,
      })),
      operation: { ...state.operation, updatedAt: completedAt, completedAt },
    });
    return {
      profile: plan.profile,
      operation: plan.operation,
      status: 'partial',
      success: false,
      steps: results,
      warnings: plan.warnings,
      error: 'Managed profile resources could not be fully removed',
    };
  }

  const activeResources = state.resources.filter(
    (resource) => resource.transition !== 'removed',
  );
  const desiredKeys = new Set(
    internal.steps
      .filter(
        (step) =>
          step.public.action !== 'remove' && step.public.action !== 'retain',
      )
      .map((step) => step.relationship.key),
  );
  for (const resource of activeResources) {
    if (
      resource.kind === 'marketplace' &&
      internal.steps.some(
        (step) =>
          step.public.kind === 'native' &&
          step.public.client === resource.client &&
          step.public.action !== 'remove' &&
          step.public.action !== 'retain' &&
          step.nativeResource?.provenance.marketplaceName === resource.identity,
      )
    ) {
      desiredKeys.add(resource.key);
    }
  }
  const releasedKeys = new Set(
    activeResources
      .filter((resource) => resource.transition === 'retained')
      .map((resource) => resource.key),
  );
  const hasManagedResidue = activeResources.some(
    (resource) =>
      resource.ownership === 'managed' &&
      !desiredKeys.has(resource.key) &&
      resource.kind !== 'root',
  );
  const finalClients = [...internal.clients];
  const finalResources = activeResources.filter(
    (resource) =>
      finalClients.includes(resource.client) && !releasedKeys.has(resource.key),
  );
  const finalStatus = hasManagedResidue ? 'partial' : 'installed';
  state = await saveProfileState(profileRoot, {
    ...state,
    clients: finalClients,
    resources: finalResources,
    status: finalStatus,
    clientStatuses: finalClients.map((client) => ({
      client,
      status: finalStatus,
    })),
    operation: { ...state.operation, updatedAt: completedAt, completedAt },
  });
  const success = finalStatus === 'installed';
  return {
    profile: plan.profile,
    operation: plan.operation,
    status: finalStatus,
    success,
    steps: results,
    warnings: plan.warnings,
    ...(!success && {
      error: 'Managed profile resources could not be fully reconciled',
    }),
  };
}

function declarationUsesNative(
  declaration: ProfileDeclaration | undefined,
  client: ClientType,
): boolean {
  const declaredClient = declaration?.clients.find(
    (entry) => entry.name === client,
  );
  if (!declaredClient) return false;
  return (
    declaration?.plugins.some((plugin) => {
      if (
        typeof plugin === 'object' &&
        plugin.clients &&
        !plugin.clients.includes(client)
      )
        return false;
      return (
        (typeof plugin === 'object' && plugin.install
          ? plugin.install
          : declaredClient.install) === 'native'
      );
    }) ?? false
  );
}

async function launcherStatuses(
  profile: string,
  declaration: ProfileDeclaration | undefined,
  state: ProfileState | null,
  runtime: ResolvedProfileRuntime,
  adapters: ReadonlyMap<ClientType, ProfileAdapter>,
) {
  const values: Array<{
    client: ClientType;
    name: string;
    path: string;
    onPath: boolean;
  }> = [];
  const seen = new Set<string>();
  if (declaration) {
    for (const client of declaration.clients) {
      if (!client.launcher) continue;
      const adapter = adapters.get(client.name);
      if (!adapter) continue;
      const context = adapter.resolveContext(profile, runtime);
      for (const rendered of renderProfileLaunchers(
        client.launcher,
        context.launcher,
      ).filter((entry) =>
        runtime.platform === 'win32'
          ? entry.companion !== 'posix'
          : entry.companion === 'posix',
      )) {
        const path = join(runtime.binDir, rendered.fileName);
        const key = `${client.name}:${path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        values.push({
          client: client.name,
          name: client.launcher,
          path,
          onPath: diagnoseLauncherPath(
            runtime.binDir,
            runtime.environment.PATH ?? process.env.PATH,
            runtime.platform,
          ).onPath,
        });
      }
    }
  }
  for (const resource of state?.resources ?? []) {
    if (resource.kind !== 'launcher' || !resource.path) continue;
    const key = `${resource.client}:${resource.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    values.push({
      client: resource.client,
      name:
        resource.provenance?.launcherName ??
        basename(resource.path).replace(/\.(?:cmd|ps1)$/i, ''),
      path: resource.path,
      onPath: diagnoseLauncherPath(
        dirname(resource.path),
        runtime.environment.PATH ?? process.env.PATH,
        runtime.platform,
      ).onPath,
    });
  }
  return values;
}

export async function getProfileStatus(
  profile: string,
  options: ProfileRuntimeOptions = {},
  dependencies: ProfileManagerDependencies = {},
): Promise<ProfileStatusResult> {
  const runtime = resolveProfileRuntimeOptions(options);
  const workspace = await readOptionalProfileWorkspace(runtime, dependencies);
  const declaration = workspace.profiles?.[profile];
  const loaded = await loadProfileState(getProfileRoot(runtime, profile));
  if (loaded.status === 'malformed') {
    return {
      profile,
      operation: 'status',
      status: 'partial',
      declared: Boolean(declaration),
      installed: true,
      ...(declaration && {
        declarationDigest: hashProfileDeclaration(declaration),
      }),
      clients: declaration?.clients.map((client) => client.name) ?? [],
      steps: [],
      launchers: [],
      warnings: [],
      error: loaded.error,
    };
  }
  const state = loaded.status === 'loaded' ? loaded.state : null;
  const clients = [
    ...new Set<ClientType>([
      ...(declaration?.clients.map((client) => client.name) ?? []),
      ...(state?.clients ?? []),
      ...(state?.resources.map((resource) => resource.client) ?? []),
    ]),
  ];
  const adapters = new Map<ClientType, ProfileAdapter>();
  let unsupported: string | undefined;
  for (const client of clients) {
    const adapter = (dependencies.getAdapter ?? getProfileAdapter)(client);
    if (!adapter?.capabilities.status) {
      unsupported = `Profile client '${client}' is unsupported`;
      continue;
    }
    adapters.set(client, adapter);
    const context = adapter.resolveContext(profile, runtime);
    const runtimeAvailable = adapter.isRuntimeAvailable
      ? await adapter.isRuntimeAvailable(context)
      : !declarationUsesNative(declaration, client) ||
        (isNativeProfileAdapter(adapter) &&
          (await adapter.nativeClient.isAvailable(context.operationContext)));
    if (!runtimeAvailable) {
      unsupported = `${client} CLI is unavailable or unsupported`;
    }
  }
  const launchers = await launcherStatuses(
    profile,
    declaration,
    state,
    runtime,
    adapters,
  );
  if (!state) {
    return {
      profile,
      operation: 'status',
      status: unsupported ? 'unsupported' : 'missing',
      declared: Boolean(declaration),
      installed: false,
      ...(declaration && {
        declarationDigest: hashProfileDeclaration(declaration),
      }),
      clients,
      steps: [],
      launchers,
      warnings: [],
      ...(unsupported && { error: unsupported }),
    };
  }
  const steps: ProfileApplyStep[] = [];
  let drifted = false;
  const marketplaceInspections = new Map<
    string,
    { success: boolean; present: boolean; error?: string }
  >();
  for (const resource of state.resources) {
    if (resource.transition === 'removed') continue;
    if (
      resource.path &&
      ['file', 'settings', 'mcp', 'launcher'].includes(resource.kind)
    ) {
      try {
        const fingerprint = await fingerprintProfileFile(resource.path);
        const matches = Boolean(
          resource.fingerprint && fingerprint === resource.fingerprint,
        );
        steps.push({
          client: resource.client,
          kind: resource.kind,
          identity: resource.identity,
          status: matches
            ? resource.ownership === 'referenced'
              ? 'referenced'
              : 'unchanged'
            : 'failed',
          ...(!matches && {
            error:
              fingerprint === null
                ? 'resource is missing'
                : 'resource fingerprint drifted',
          }),
        });
        if (!matches) drifted = true;
      } catch (error) {
        drifted = true;
        steps.push({
          client: resource.client,
          kind: resource.kind,
          identity: resource.identity,
          status: 'failed',
          error: safeError(error),
        });
      }
      continue;
    }
    if (resource.kind === 'native') {
      const adapter = adapters.get(resource.client);
      if (!adapter || !isNativeProfileAdapter(adapter)) {
        drifted = true;
        steps.push({
          client: resource.client,
          kind: 'native',
          identity: resource.identity,
          status: 'failed',
          error: 'native adapter unsupported',
        });
        continue;
      }
      const context = adapter.resolveContext(profile, runtime);
      const inspection = await adapter.nativeClient.inspect(
        context.operationContext,
      );
      const present =
        inspection.success &&
        inspection.resources.some(
          (candidate) => candidate.resolvedIdentity === resource.identity,
        );
      steps.push({
        client: resource.client,
        kind: 'native',
        identity: resource.identity,
        status: present
          ? resource.ownership === 'referenced'
            ? 'referenced'
            : 'unchanged'
          : 'failed',
        ...(!present && {
          error: inspection.error ?? 'native resource is missing',
        }),
      });
      if (!present) drifted = true;
      continue;
    }
    if (resource.kind === 'root') {
      const path = resource.path ?? resource.identity;
      try {
        const metadata = await lstat(path);
        const present = metadata.isDirectory() && !metadata.isSymbolicLink();
        steps.push({
          client: resource.client,
          kind: 'root',
          identity: resource.identity,
          status: present
            ? resource.ownership === 'referenced'
              ? 'referenced'
              : 'unchanged'
            : 'failed',
          ...(!present && {
            error: 'managed profile root is not a real directory',
          }),
        });
        if (!present) drifted = true;
      } catch (error) {
        drifted = true;
        steps.push({
          client: resource.client,
          kind: 'root',
          identity: resource.identity,
          status: 'failed',
          error:
            (error as NodeJS.ErrnoException).code === 'ENOENT'
              ? 'managed profile root is missing'
              : safeError(error),
        });
      }
      continue;
    }
    if (resource.kind === 'marketplace') {
      const adapter = adapters.get(resource.client);
      if (!adapter) {
        drifted = true;
        steps.push({
          client: resource.client,
          kind: 'marketplace',
          identity: resource.identity,
          status: 'failed',
          error: 'marketplace registry inspection is unsupported',
        });
        continue;
      }
      const marketplaceName =
        resource.provenance?.marketplaceName ?? resource.identity;
      const inspectionKey = `${resource.client}:${marketplaceName}`;
      let inspection = marketplaceInspections.get(inspectionKey);
      if (!inspection) {
        const context = adapter.resolveContext(profile, runtime);
        inspection =
          isNativeProfileAdapter(adapter) &&
          adapter.inspectMarketplaceRegistration
            ? await adapter.inspectMarketplaceRegistration(
                marketplaceName,
                context,
              )
            : {
                success: false,
                present: false,
                error: 'marketplace registry inspection is unsupported',
              };
        marketplaceInspections.set(inspectionKey, inspection);
      }
      const present = inspection.success && inspection.present;
      steps.push({
        client: resource.client,
        kind: 'marketplace',
        identity: resource.identity,
        status: present
          ? resource.ownership === 'referenced'
            ? 'referenced'
            : 'unchanged'
          : 'failed',
        ...(!present && {
          error:
            inspection.error ??
            `${resource.client} marketplace '${marketplaceName}' is missing`,
        }),
      });
      if (!present) drifted = true;
      continue;
    }
    steps.push({
      client: resource.client,
      kind: resource.kind,
      identity: resource.identity,
      status: resource.ownership === 'referenced' ? 'referenced' : 'unchanged',
    });
  }
  const declarationDigest = declaration
    ? hashProfileDeclaration(declaration)
    : undefined;
  if (declarationDigest && declarationDigest !== state.declarationDigest)
    drifted = true;
  const status = !declaration
    ? 'declaration-missing'
    : unsupported
      ? 'unsupported'
      : state.status === 'partial'
        ? 'partial'
        : drifted
          ? 'drifted'
          : 'installed';
  return {
    profile,
    operation: 'status',
    status,
    declared: Boolean(declaration),
    installed: true,
    ...(declarationDigest && { declarationDigest }),
    stateDigest: state.declarationDigest,
    clients,
    steps,
    launchers,
    warnings: [],
    ...(unsupported && { error: unsupported }),
  };
}

export async function getProfileStatuses(
  options: ProfileRuntimeOptions = {},
  dependencies: ProfileManagerDependencies = {},
): Promise<readonly ProfileStatusResult[]> {
  const runtime = resolveProfileRuntimeOptions(options);
  const workspace = await readOptionalProfileWorkspace(runtime, dependencies);
  const names = new Set(Object.keys(workspace.profiles ?? {}));
  const profilesRoot = join(runtime.homeDir, '.allagents', 'profiles');
  try {
    for (const entry of await readdir(profilesRoot, { withFileTypes: true })) {
      if (
        entry.isDirectory() &&
        ProfileNameSchema.safeParse(entry.name).success
      ) {
        names.add(entry.name);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const results: ProfileStatusResult[] = [];
  for (const name of names) {
    const result = await getProfileStatus(name, options, dependencies);
    if (result.declared || result.installed) results.push(result);
  }
  return results;
}

export async function getProfilesForUpdate(
  requestedNames: readonly string[] | undefined,
  options: ProfileRuntimeOptions = {},
  dependencies: ProfileManagerDependencies = {},
): Promise<readonly string[]> {
  const runtime = resolveProfileRuntimeOptions(options);
  const workspace = await readProfileWorkspace(runtime, dependencies);
  const declaredNames = Object.keys(workspace.profiles ?? {});
  const requested = requestedNames?.length
    ? [...new Set(requestedNames)]
    : declaredNames;
  const selected: string[] = [];
  for (const name of requested) {
    if (!workspace.profiles?.[name]) {
      throw new Error(`Profile '${name}' is not declared`);
    }
    const loaded = await loadProfileState(getProfileRoot(runtime, name));
    if (loaded.status === 'malformed') {
      if (requestedNames?.length) {
        throw new Error(
          `Refusing profile update because '${name}' state is malformed: ${loaded.error}`,
        );
      }
      selected.push(name);
      continue;
    }
    const retryableUpdate =
      loaded.status === 'loaded' &&
      loaded.state.status === 'partial' &&
      loaded.state.operation.kind === 'update';
    if (
      loaded.status !== 'loaded' ||
      (loaded.state.status !== 'installed' && !retryableUpdate)
    ) {
      if (requestedNames?.length) {
        throw new Error(`Profile '${name}' is not installed`);
      }
      continue;
    }
    selected.push(name);
  }
  return selected;
}

async function applyProfileUpdatePlan(
  plan: ProfilePlan,
  options: ProfileRuntimeOptions,
  dependencies: ProfileManagerDependencies,
): Promise<ProfileApplyResult> {
  try {
    return await applyProfilePlan(plan, options, dependencies);
  } catch (error) {
    return {
      profile: plan.profile,
      operation: 'update',
      status: 'failed',
      success: false,
      steps: [],
      warnings: plan.warnings,
      error: safeError(error),
    };
  }
}

function failedProfileUpdate(
  profile: string,
  error: unknown,
): ProfileApplyResult {
  return {
    profile,
    operation: 'update',
    status: 'failed',
    success: false,
    steps: [],
    warnings: [],
    error: safeError(error),
  };
}

export async function updateInstalledProfiles(
  requestedNames: readonly string[] | undefined,
  options: ProfileRuntimeOptions = {},
  dependencies: ProfileManagerDependencies = {},
): Promise<readonly ProfileApplyResult[]> {
  const selected = await getProfilesForUpdate(
    requestedNames,
    options,
    dependencies,
  );
  const results: ProfileApplyResult[] = [];
  if (requestedNames?.length) {
    const plans: ProfilePlan[] = [];
    for (const profile of selected) {
      plans.push(
        await planProfileOperation(profile, 'update', options, dependencies),
      );
    }
    for (const plan of plans) {
      results.push(await applyProfileUpdatePlan(plan, options, dependencies));
    }
    return results;
  }

  for (const profile of selected) {
    try {
      const plan = await planProfileOperation(
        profile,
        'update',
        options,
        dependencies,
      );
      results.push(await applyProfileUpdatePlan(plan, options, dependencies));
    } catch (error) {
      results.push(failedProfileUpdate(profile, error));
    }
  }
  return results;
}
