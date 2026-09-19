import { lstat, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type {
  ProfileResourceRelationship,
  ProfileState,
} from '../../models/profile-state.js';
import {
  type ClientType,
  getPluginRef,
  getPluginSource,
  type InstallMode,
  type McpServerConfig,
  type ProfileDeclaration,
  ProfileNameSchema,
  type ProfilePluginEntry,
  type UserWorkspaceConfig,
} from '../../models/workspace-config.js';
import { parseUserWorkspaceConfig } from '../../utils/workspace-parser.js';
import { applyMcpProxy } from '../mcp-proxy.js';
import type {
  NativeInspectionResult,
  NativeResource,
} from '../native/types.js';
import { sanitizeNativeProvenance } from '../native/types.js';
import { collectPluginSkills, copyPluginToWorkspace } from '../transform.js';
import { serializeProfileMcpServers } from './adapters/mcp.js';
import { getProfileAdapter } from './adapters/registry.js';
import {
  assertSafeProfilePath,
  fingerprintProfileFile,
  sha256Fingerprint,
} from './files.js';
import type {
  ProfileOperationKind,
  ProfilePlan,
  ProfilePlanAction,
  ProfilePlanClient,
  ProfilePlanMcpServer,
  ProfilePlanStep,
  ProfilePlanStepDetail,
  ProfileRuntimeOptions,
  ProfileStepKind,
} from './index.js';
import { renderProfileLaunchers } from './launcher.js';
import { resolveProfileFileSource } from './source.js';
import {
  hashProfileDeclaration,
  loadProfileState,
  sanitizeProfileError,
} from './state.js';
import {
  isNativeProfileAdapter,
  type NativeProfileAdapter,
  type ProfileAdapter,
  type ProfileClientContext,
  type ProfileMarketplaceRegistration,
  type ProfileResolvedPlugin,
} from './types.js';

export interface ResolvedProfileRuntime {
  readonly userConfigPath: string;
  readonly workspaceDirectory: string;
  readonly homeDir: string;
  readonly binDir: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly offline: boolean;
  readonly dryRun: boolean;
}

export interface ProfilePlanDependencies {
  readonly getAdapter?: (client: ClientType) => ProfileAdapter | null;
  readonly parseWorkspace?: typeof parseUserWorkspaceConfig;
}

export interface InternalProfilePlanStep {
  readonly public: ProfilePlanStep;
  readonly relationship: ProfileResourceRelationship;
  readonly root?: string;
  readonly path?: string;
  readonly content?: string | Uint8Array;
  readonly mode?: number;
  readonly previousFingerprint?: string;
  readonly nativeResource?: NativeResource;
  readonly currentNativeResource?: NativeResource;
  readonly context?: ProfileClientContext;
  /** Revalidate a provider prerequisite immediately before MCP materialization. */
  readonly requiresMcpPrerequisite?: boolean;
  readonly marketplaceRegistration?: ProfileMarketplaceRegistration;
}

export interface InternalProfilePlan {
  readonly public: ProfilePlan;
  readonly runtime: ResolvedProfileRuntime;
  readonly declaration?: ProfileDeclaration;
  readonly clients: readonly ClientType[];
  readonly contexts: ReadonlyMap<ClientType, ProfileClientContext>;
  readonly adapters: ReadonlyMap<ClientType, ProfileAdapter>;
  readonly priorState: ProfileState | null;
  readonly steps: readonly InternalProfilePlanStep[];
}

const INTERNAL_PLANS = new WeakMap<ProfilePlan, InternalProfilePlan>();
const SENSITIVE_FIELD =
  /(?:^|[-_.])(auth|credential|key|password|secret|signature|token)(?:$|[-_.])/i;

export function resolveProfileRuntimeOptions(
  options: ProfileRuntimeOptions = {},
): ResolvedProfileRuntime {
  const home = resolve(options.homeDir ?? homedir());
  return Object.freeze({
    userConfigPath: resolve(
      options.userConfigPath ?? join(home, '.allagents', 'workspace.yaml'),
    ),
    workspaceDirectory: resolve(options.workspaceDirectory ?? home),
    homeDir: home,
    binDir: resolve(options.binDir ?? join(home, '.local', 'bin')),
    environment: Object.freeze({ ...options.environment }),
    platform: options.platform ?? process.platform,
    offline: options.offline ?? false,
    dryRun: options.dryRun ?? false,
  });
}

export function getProfileRoot(
  runtime: ResolvedProfileRuntime,
  profile: string,
): string {
  return join(runtime.homeDir, '.allagents', 'profiles', profile);
}

export async function readProfileWorkspace(
  runtime: ResolvedProfileRuntime,
  dependencies: ProfilePlanDependencies = {},
): Promise<UserWorkspaceConfig> {
  return (dependencies.parseWorkspace ?? parseUserWorkspaceConfig)(
    runtime.userConfigPath,
  );
}

export async function readOptionalProfileWorkspace(
  runtime: ResolvedProfileRuntime,
  dependencies: ProfilePlanDependencies = {},
): Promise<UserWorkspaceConfig> {
  try {
    return await readProfileWorkspace(runtime, dependencies);
  } catch (error) {
    const missing =
      (error as NodeJS.ErrnoException).code === 'ENOENT' ||
      (error instanceof Error &&
        error.message.includes('workspace.yaml not found at'));
    if (!missing) throw error;
    return {
      repositories: [],
      plugins: [],
      clients: [],
    };
  }
}

export function getInternalProfilePlan(plan: ProfilePlan): InternalProfilePlan {
  const internal = INTERNAL_PLANS.get(plan);
  if (!internal)
    throw new Error(
      'Profile plan was not created by this process or has expired',
    );
  return internal;
}

function validateDisplaySafe(value: string, label: string): string {
  let containsControl = false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      containsControl = true;
      break;
    }
  }
  if (!value || containsControl) {
    throw new Error(`${label} is empty or contains control characters`);
  }
  if (
    /\bbearer\s+\S+/i.test(value) ||
    /\b(?:authorization|credential|password|secret|token|api[-_]?key)\s*[:=]\s*\S+/i.test(
      value,
    )
  ) {
    throw new Error(`${label} contains credential-bearing text`);
  }
  try {
    const url = new URL(value);
    if (url.username || url.password)
      throw new Error(`${label} contains URL credentials`);
    for (const [key, queryValue] of url.searchParams) {
      if (queryValue && SENSITIVE_FIELD.test(key)) {
        throw new Error(`${label} contains a secret query parameter`);
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error;
  }
  return value;
}

function normalizedPlugin(
  entry: ProfilePluginEntry,
  declarationIndex: number,
  install: InstallMode,
): ProfileResolvedPlugin {
  const source = getPluginSource(entry);
  validateDisplaySafe(source, `Profile plugin ${declarationIndex} source`);
  const requestedRef = getPluginRef(entry);
  if (requestedRef)
    validateDisplaySafe(requestedRef, `Profile plugin ${declarationIndex} ref`);
  return Object.freeze({
    declarationIndex,
    source,
    ...(requestedRef && { requestedRef }),
    install,
    ...(typeof entry === 'object' &&
      entry.skills !== undefined && { skills: entry.skills }),
    ...(typeof entry === 'object' &&
      entry.clients !== undefined && { clients: entry.clients }),
  });
}

function selectedForClient(
  entry: ProfilePluginEntry,
  client: ClientType,
): boolean {
  return (
    typeof entry === 'string' ||
    !entry.clients ||
    entry.clients.includes(client)
  );
}

function keyFor(
  kind: ProfileStepKind,
  client: ClientType,
  identity: string,
): string {
  return `${kind}:${client}:${sha256Fingerprint(identity)}`;
}

function relationship(input: {
  kind: ProfileStepKind;
  client: ClientType;
  identity: string;
  path?: string;
  ownership: 'managed' | 'referenced';
  transition?: ProfileResourceRelationship['transition'];
  fingerprint?: string;
  cleanup: ProfileResourceRelationship['cleanup'];
  requestedRef?: string;
  resolvedRef?: string;
  provenance?: Readonly<Record<string, string>>;
}): ProfileResourceRelationship {
  return {
    key: keyFor(input.kind, input.client, input.identity),
    client: input.client,
    kind: input.kind,
    identity: validateDisplaySafe(input.identity, 'Profile resource identity'),
    ...(input.path && { path: input.path }),
    ownership: input.ownership,
    transition: input.transition ?? 'planned',
    ...(input.fingerprint && { fingerprint: input.fingerprint }),
    cleanup: input.cleanup,
    ...(input.requestedRef && { requestedRef: input.requestedRef }),
    ...(input.resolvedRef && { resolvedRef: input.resolvedRef }),
    ...(input.provenance &&
      Object.keys(input.provenance).length > 0 && {
        provenance: sanitizeNativeProvenance(input.provenance),
      }),
  };
}

function publicStep(
  client: ClientType,
  kind: ProfileStepKind,
  identity: string,
  action: ProfilePlanAction,
  refs: { requestedRef?: string; resolvedRef?: string } = {},
  detail?: ProfilePlanStepDetail,
): ProfilePlanStep {
  return Object.freeze({
    client,
    kind,
    identity,
    action,
    ...refs,
    ...(detail && { detail }),
  });
}
function previousResource(
  state: ProfileState | null,
  kind: ProfileStepKind,
  client: ClientType,
  identity: string,
): ProfileResourceRelationship | undefined {
  return state?.resources.find(
    (entry) =>
      entry.kind === kind &&
      entry.client === client &&
      entry.identity === identity &&
      entry.transition !== 'removed',
  );
}

async function expandCopyResult(
  source: string,
  destination: string,
): Promise<
  Array<{
    source: string;
    destination: string;
    content: Uint8Array;
    mode: number;
  }>
> {
  const stats = await lstat(source);
  if (stats.isSymbolicLink())
    throw new Error(`Profile plugin contains a symbolic link: ${source}`);
  if (stats.isFile()) {
    return [
      {
        source,
        destination,
        content: await readFile(source),
        mode: stats.mode & 0o777,
      },
    ];
  }
  if (!stats.isDirectory())
    throw new Error(`Profile plugin contains a non-file resource: ${source}`);
  const files: Array<{
    source: string;
    destination: string;
    content: Uint8Array;
    mode: number;
  }> = [];
  for (const entry of (await readdir(source, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Profile plugin contains a symbolic link: ${sourcePath}`);
    if (entry.isDirectory())
      files.push(...(await expandCopyResult(sourcePath, destinationPath)));
    else if (entry.isFile()) {
      const fileStats = await lstat(sourcePath);
      files.push({
        source: sourcePath,
        destination: destinationPath,
        content: await readFile(sourcePath),
        mode: fileStats.mode & 0o777,
      });
    } else
      throw new Error(
        `Profile plugin contains a non-file resource: ${sourcePath}`,
      );
  }
  return files;
}

function nativeAdapterFor(
  adapter: ProfileAdapter,
  client: ClientType,
): NativeProfileAdapter {
  if (!isNativeProfileAdapter(adapter)) {
    throw new Error(
      `Profile client '${client}' does not support native plugins`,
    );
  }
  return adapter;
}
async function inspectClient(
  adapter: NativeProfileAdapter,
  context: ProfileClientContext,
): Promise<NativeInspectionResult> {
  if (!(await adapter.nativeClient.isAvailable(context.operationContext))) {
    throw new Error(`${context.client} CLI is unavailable or unsupported`);
  }
  const inspection = await adapter.nativeClient.inspect(
    context.operationContext,
  );
  if (!inspection.success)
    throw new Error(
      inspection.error ?? `Could not inspect ${context.client} profile state`,
    );
  return inspection;
}

function sameNativeIdentity(
  left: NativeResource,
  right: NativeResource,
): boolean {
  return (
    left.kind === right.kind && left.resolvedIdentity === right.resolvedIdentity
  );
}

function findInstalledNativeResource(
  inspection: NativeInspectionResult,
  matches: (resource: NativeResource) => boolean,
): NativeResource | undefined {
  return (
    inspection.resources.find(matches) ??
    inspection.observations?.find(
      (observation) =>
        observation.status === 'disabled' && matches(observation.resource),
    )?.resource
  );
}

function findDisabledNativeResource(
  inspection: NativeInspectionResult,
  matches: (resource: NativeResource) => boolean,
): NativeResource | undefined {
  return inspection.observations?.find(
    (observation) =>
      observation.status === 'disabled' && matches(observation.resource),
  )?.resource;
}

async function planManagedFile(input: {
  client: ClientType;
  kind: 'file' | 'settings' | 'mcp' | 'launcher';
  root: string;
  path: string;
  content: string | Uint8Array;
  mode: number;
  priorState: ProfileState | null;
  provenance?: Readonly<Record<string, string>>;
  requestedRef?: string;
  resolvedRef?: string;
}): Promise<InternalProfilePlanStep> {
  await assertSafeProfilePath(input.root, input.path);
  const desiredFingerprint = sha256Fingerprint(input.content);
  const currentFingerprint = await fingerprintProfileFile(input.path);
  const prior = previousResource(
    input.priorState,
    input.kind,
    input.client,
    input.path,
  );
  let ownership: 'managed' | 'referenced' = prior?.ownership ?? 'managed';
  let action: ProfilePlanAction;
  if (currentFingerprint === null) {
    if (prior?.ownership === 'referenced') {
      throw new Error(`Referenced profile file is missing: ${input.path}`);
    }
    action = 'create';
    ownership = 'managed';
  } else if (!prior) {
    if (currentFingerprint !== desiredFingerprint) {
      throw new Error(
        `Profile ${input.kind} collides with an unowned file: ${input.path}`,
      );
    }
    action = 'reference';
    ownership = 'referenced';
  } else if (prior.ownership === 'referenced') {
    if (currentFingerprint !== desiredFingerprint) {
      throw new Error(
        `Referenced profile file conflicts with the declaration: ${input.path}`,
      );
    }
    action = 'reference';
  } else {
    if (!prior.fingerprint || currentFingerprint !== prior.fingerprint) {
      throw new Error(
        `Managed profile file was modified outside AllAgents: ${input.path}`,
      );
    }
    action = currentFingerprint === desiredFingerprint ? 'unchanged' : 'update';
  }
  const next = relationship({
    kind: input.kind,
    client: input.client,
    identity: input.path,
    path: input.path,
    ownership,
    fingerprint: desiredFingerprint,
    cleanup: input.kind === 'launcher' ? 'launcher' : 'file',
    ...(input.requestedRef && { requestedRef: input.requestedRef }),
    ...(input.resolvedRef && { resolvedRef: input.resolvedRef }),
    ...(input.provenance && { provenance: input.provenance }),
  });
  return {
    public: publicStep(input.client, input.kind, input.path, action, {
      ...(input.requestedRef && { requestedRef: input.requestedRef }),
      ...(input.resolvedRef && { resolvedRef: input.resolvedRef }),
    }),
    relationship: next,
    root: input.root,
    path: input.path,
    content: input.content,
    mode: input.mode,
    ...(prior?.fingerprint && { previousFingerprint: prior.fingerprint }),
  };
}

function managedContextRoot(context: ProfileClientContext): string {
  return context.operationContext.roots?.config ?? context.root;
}
const SECRET_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function requestedSecretNames(value: unknown): string[] {
  const names = new Set<string>();
  const visit = (entry: unknown): void => {
    if (typeof entry === 'string') {
      for (const match of entry.matchAll(SECRET_REFERENCE)) {
        if (match[1]) names.add(match[1]);
      }
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
      return;
    }
    if (entry && typeof entry === 'object') {
      for (const item of Object.values(entry as Record<string, unknown>)) {
        visit(item);
      }
    }
  };
  visit(value);
  return [...names].sort();
}

function mcpDisclosures(
  mcpServers: Readonly<Record<string, McpServerConfig>>,
): readonly ProfilePlanMcpServer[] {
  const servers: ProfilePlanMcpServer[] = [];
  for (const [name, server] of Object.entries(mcpServers)) {
    if ('url' in server) {
      servers.push({
        name,
        transport: 'http',
        endpoint: server.url,
        requestedSecrets: requestedSecretNames(server),
      });
    } else {
      servers.push({
        name,
        transport: 'stdio',
        command: {
          command: server.command,
          args: Object.freeze(
            (server.args ?? []).map((argument) =>
              argument.replace(SECRET_REFERENCE, '[REDACTED]'),
            ),
          ),
        },
        requestedSecrets: requestedSecretNames(server),
      });
    }
  }
  return Object.freeze(servers);
}

async function planRoot(
  client: ClientType,
  context: ProfileClientContext,
  priorState: ProfileState | null,
): Promise<InternalProfilePlanStep> {
  const selectedRoot = managedContextRoot(context);
  await assertSafeProfilePath(selectedRoot, selectedRoot);
  const prior = previousResource(priorState, 'root', client, selectedRoot);
  const stats = await lstat(selectedRoot).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (stats?.isSymbolicLink()) {
    throw new Error(
      `Profile client root cannot be a symbolic link: ${selectedRoot}`,
    );
  }
  const ownership = prior?.ownership ?? (stats ? 'referenced' : 'managed');
  const action: ProfilePlanAction = prior
    ? 'unchanged'
    : stats
      ? 'reference'
      : 'create';
  return {
    public: publicStep(client, 'root', selectedRoot, action),
    relationship: relationship({
      kind: 'root',
      client,
      identity: selectedRoot,
      path: selectedRoot,
      ownership,
      cleanup: ownership === 'managed' ? 'file' : 'none',
    }),
    root: selectedRoot,
    path: selectedRoot,
    context,
  };
}

function staleFileStep(
  resource: ProfileResourceRelationship,
  currentFingerprint: string | null,
  root: string,
  context?: ProfileClientContext,
): InternalProfilePlanStep {
  let action: ProfilePlanAction = 'retain';
  if (resource.ownership === 'managed') {
    if (currentFingerprint === null) action = 'unchanged';
    else if (
      resource.fingerprint &&
      currentFingerprint === resource.fingerprint
    ) {
      action = 'remove';
    }
  }
  return {
    public: publicStep(
      resource.client,
      resource.kind,
      resource.identity,
      action,
    ),
    relationship: resource,
    ...(resource.path && { path: resource.path }),
    root,
    ...(context && { context }),
  };
}

function orderProfileSteps(
  steps: readonly InternalProfilePlanStep[],
  operation: ProfileOperationKind,
  adapters: ReadonlyMap<ClientType, ProfileAdapter>,
): InternalProfilePlanStep[] {
  let orderedSteps = [...steps];
  for (const [client, adapter] of adapters) {
    const stepOrder = adapter.stepOrder;
    if (!stepOrder) continue;
    const providerSteps = orderedSteps
      .filter((step) => step.public.client === client)
      .sort(
        (left, right) =>
          stepOrder(left.public.kind, operation) -
          stepOrder(right.public.kind, operation),
      );
    let providerIndex = 0;
    orderedSteps = orderedSteps.map((step) =>
      step.public.client === client
        ? (providerSteps[providerIndex++] ?? step)
        : step,
    );
  }
  return orderedSteps;
}

export async function planProfileOperation(
  profile: string,
  operation: ProfileOperationKind,
  options: ProfileRuntimeOptions = {},
  dependencies: ProfilePlanDependencies = {},
): Promise<ProfilePlan> {
  ProfileNameSchema.parse(profile);
  const runtime = resolveProfileRuntimeOptions(options);
  const workspace =
    operation === 'remove'
      ? await readOptionalProfileWorkspace(runtime, dependencies)
      : await readProfileWorkspace(runtime, dependencies);
  const declaration = workspace.profiles?.[profile];
  const profileRoot = getProfileRoot(runtime, profile);
  const loadedState = await loadProfileState(profileRoot);
  if (loadedState.status === 'malformed') {
    throw new Error(
      `Refusing profile ${operation} because state is malformed: ${loadedState.error}`,
    );
  }
  const priorState = loadedState.status === 'loaded' ? loadedState.state : null;
  if (operation !== 'remove' && !declaration)
    throw new Error(`Profile '${profile}' is not declared`);
  if (operation === 'remove' && !priorState && !declaration)
    throw new Error(`Profile '${profile}' is not installed or declared`);

  const desiredClients = declaration
    ? declaration.clients.map((client) => client.name)
    : [...(priorState?.clients ?? [])];
  const resolutionClients = [...desiredClients];
  for (const client of priorState?.clients ?? []) {
    if (!resolutionClients.includes(client)) resolutionClients.push(client);
  }
  const getAdapter = dependencies.getAdapter ?? getProfileAdapter;
  const adapters = new Map<ClientType, ProfileAdapter>();
  const contexts = new Map<ClientType, ProfileClientContext>();
  for (const client of resolutionClients) {
    const adapter = getAdapter(client);
    if (!adapter) throw new Error(`Profile client '${client}' is unsupported`);
    if (
      !adapter.capabilities.status ||
      !adapter.capabilities.cleanup ||
      !adapter.capabilities.launchers
    ) {
      throw new Error(
        `Profile client '${client}' lacks required profile lifecycle capabilities`,
      );
    }
    const context = adapter.resolveContext(profile, runtime);
    adapters.set(client, adapter);
    contexts.set(client, context);
  }

  const warnings: string[] = [];
  const steps: InternalProfilePlanStep[] = [];
  const desiredKeys = new Set<string>();
  const inspections = new Map<ClientType, NativeInspectionResult>();
  const inspectionFor = async (client: ClientType) => {
    const existing = inspections.get(client);
    if (existing) return existing;
    const adapter = adapters.get(client);
    const context = contexts.get(client);
    if (!adapter || !context)
      throw new Error(`Missing resolved context for ${client}`);
    const inspection = await inspectClient(
      nativeAdapterFor(adapter, client),
      context,
    );
    inspections.set(client, inspection);
    return inspection;
  };

  if (operation === 'remove') {
    const removalOrder: Record<ProfileStepKind, number> = {
      launcher: 0,
      mcp: 1,
      settings: 1,
      file: 1,
      native: 2,
      marketplace: 3,
      root: 4,
    };
    const resources = [...(priorState?.resources ?? [])].sort(
      (left, right) => removalOrder[left.kind] - removalOrder[right.kind],
    );
    for (const resource of resources) {
      if (resource.transition === 'removed') continue;
      const context = contexts.get(resource.client);
      const adapter = adapters.get(resource.client);
      if (!context || !adapter) {
        throw new Error(
          `Cannot resolve cleanup adapter for ${resource.client}`,
        );
      }
      if (resource.kind === 'native') {
        const inspection = await inspectionFor(resource.client);
        const live = findInstalledNativeResource(
          inspection,
          (candidate) => candidate.resolvedIdentity === resource.identity,
        );
        const action: ProfilePlanAction =
          resource.ownership === 'managed'
            ? live
              ? 'remove'
              : 'unchanged'
            : 'retain';
        const commands = live
          ? nativeAdapterFor(adapter, resource.client).discloseNativeCommands(
              { kind: 'native', action, resource: live },
              context,
            )
          : [];
        steps.push({
          public: publicStep(
            resource.client,
            'native',
            resource.identity,
            action,
            {},
            commands.length > 0
              ? {
                  ...(live?.requestedIdentity && {
                    source: live.requestedIdentity,
                  }),
                  commands,
                }
              : undefined,
          ),
          relationship: resource,
          ...(live && { nativeResource: live }),
          context,
        });
      } else if (
        resource.path &&
        ['file', 'settings', 'mcp', 'launcher'].includes(resource.kind)
      ) {
        const writeRoot =
          resource.kind === 'launcher' ? runtime.binDir : context.root;
        steps.push(
          staleFileStep(
            resource,
            await fingerprintProfileFile(resource.path),
            writeRoot,
            context,
          ),
        );
      } else if (resource.kind === 'marketplace') {
        const action: ProfilePlanAction =
          resource.ownership === 'managed' ? 'remove' : 'retain';
        const marketplaceName =
          resource.provenance?.marketplaceName ?? resource.identity;
        const registration = {
          name: marketplaceName,
          source: resource.provenance?.registrationIdentity ?? marketplaceName,
        };
        const commands =
          action === 'remove' && isNativeProfileAdapter(adapter)
            ? adapter.discloseNativeCommands(
                { kind: 'marketplace', action, registration },
                context,
              )
            : [];
        steps.push({
          public: publicStep(
            resource.client,
            'marketplace',
            resource.identity,
            action,
            {},
            commands.length > 0 ? { commands } : undefined,
          ),
          relationship: resource,
          marketplaceRegistration: registration,
          context,
        });
      } else if (resource.kind === 'root') {
        const action: ProfilePlanAction =
          resource.ownership === 'managed' ? 'remove' : 'retain';
        steps.push({
          public: publicStep(
            resource.client,
            'root',
            resource.identity,
            action,
          ),
          relationship: resource,
          root: resource.path ?? managedContextRoot(context),
          path: resource.path ?? resource.identity,
          context,
        });
      } else {
        steps.push({
          public: publicStep(
            resource.client,
            resource.kind,
            resource.identity,
            'retain',
          ),
          relationship: resource,
          context,
        });
      }
    }
  } else if (declaration) {
    for (const declaredClient of declaration.clients) {
      const client = declaredClient.name;
      const adapter = adapters.get(client);
      const context = contexts.get(client);
      if (!adapter || !context)
        throw new Error(`Missing resolved context for ${client}`);
      if (
        adapter.isRuntimeAvailable &&
        !(await adapter.isRuntimeAvailable(context))
      ) {
        throw new Error(`${client} CLI is unavailable or unsupported`);
      }
      const root = await planRoot(client, context, priorState);
      steps.push(root);
      desiredKeys.add(root.relationship.key);

      const nativePlugins: Array<{
        plugin: ProfileResolvedPlugin;
        resource: NativeResource;
        current?: NativeResource;
        disabled?: boolean;
      }> = [];
      const filePlugins: ProfileResolvedPlugin[] = [];
      for (let index = 0; index < declaration.plugins.length; index++) {
        const entry = declaration.plugins[index];
        if (!entry || !selectedForClient(entry, client)) continue;
        const install =
          typeof entry === 'object' && entry.install
            ? entry.install
            : declaredClient.install;
        let plugin = normalizedPlugin(entry, index, install);
        if (plugin.skills !== undefined && !adapter.capabilities.skillFilters) {
          throw new Error(
            `Profile client '${client}' does not support plugin skill filters`,
          );
        }
        if (install === 'native') {
          const nativeAdapter = nativeAdapterFor(adapter, client);
          if (nativeAdapter.resolveNativeMetadata) {
            plugin = await nativeAdapter.resolveNativeMetadata(
              plugin,
              context,
              runtime,
            );
          }
          const resolved = nativeAdapter.resolveNativeSource(plugin, context);
          if (!resolved.success || !resolved.resource) {
            throw new Error(
              resolved.error ??
                `Could not resolve native profile plugin '${plugin.source}'`,
            );
          }
          const inspection = await inspectionFor(client);
          const desiredResource = resolved.resource;
          const matchesDesired = (candidate: NativeResource) =>
            sameNativeIdentity(candidate, desiredResource);
          const disabled = findDisabledNativeResource(
            inspection,
            matchesDesired,
          );
          const current = inspection.resources.find(matchesDesired) ?? disabled;
          nativePlugins.push({
            plugin,
            resource: desiredResource,
            ...(current && { current }),
            ...(disabled && { disabled: true }),
          });
        } else {
          if (!adapter.capabilities.fileInstall)
            throw new Error(
              `Profile client '${client}' does not support file plugins`,
            );
          filePlugins.push(plugin);
        }
      }

      const selectedMcpServers = serializeProfileMcpServers(
        {
          plugins: [],
          ...(declaration.mcpServers && {
            mcpServers: declaration.mcpServers,
          }),
        },
        client,
      );
      const effectiveMcpServers =
        selectedMcpServers === null
          ? undefined
          : declaration.mcpProxy
            ? Object.fromEntries(
                applyMcpProxy(
                  new Map(Object.entries(selectedMcpServers)),
                  client,
                  declaration.mcpProxy,
                  { profile },
                ),
              )
            : selectedMcpServers;
      const hasMcp = Object.keys(effectiveMcpServers ?? {}).length > 0;

      const requiresMcpPrerequisite =
        hasMcp && adapter.mcpPrerequisite !== undefined;
      const plannedMcpPrerequisite = adapter.mcpPrerequisite
        ? nativePlugins.find(({ resource }) =>
            adapter.mcpPrerequisite?.matches(resource),
          )
        : undefined;
      let referencedMcpPrerequisite: NativeResource | undefined;
      if (requiresMcpPrerequisite && !plannedMcpPrerequisite) {
        const prerequisite = await adapter.mcpPrerequisite?.inspect(context);
        if (!prerequisite?.packageSource) {
          throw new Error(
            `${client} profile MCP requires a usable native prerequisite in ${context.root}; found ${prerequisite?.classification ?? 'unknown'}`,
          );
        }
        const resolved = nativeAdapterFor(adapter, client).resolveNativeSource(
          {
            declarationIndex: -1,
            source: prerequisite.packageSource,
            install: 'native',
          },
          context,
        );
        if (!resolved.success || !resolved.resource) {
          throw new Error(
            resolved.error ??
              `Could not resolve referenced ${client} MCP prerequisite`,
          );
        }
        referencedMcpPrerequisite = resolved.resource;
      }

      const orderedNative = plannedMcpPrerequisite
        ? [
            plannedMcpPrerequisite,
            ...nativePlugins.filter(
              (entry) => entry !== plannedMcpPrerequisite,
            ),
          ]
        : nativePlugins;
      if (referencedMcpPrerequisite) {
        const rel = relationship({
          kind: 'native',
          client,
          identity: referencedMcpPrerequisite.resolvedIdentity,
          ownership: 'referenced',
          transition: 'referenced',
          cleanup: 'none',
          provenance: referencedMcpPrerequisite.provenance,
        });
        steps.push({
          public: publicStep(client, 'native', rel.identity, 'reference'),
          relationship: rel,
          nativeResource: referencedMcpPrerequisite,
          context,
        });
        desiredKeys.add(rel.key);
      }
      for (const entry of orderedNative) {
        const prior = previousResource(
          priorState,
          'native',
          client,
          entry.resource.resolvedIdentity,
        );
        if (prior?.ownership !== 'managed' && entry.disabled) {
          throw new Error(
            `Native profile plugin '${entry.resource.resolvedIdentity}' is disabled and is not owned by AllAgents`,
          );
        }
        const ownership =
          prior?.ownership ?? (entry.current ? 'referenced' : 'managed');
        const action: ProfilePlanAction =
          ownership === 'referenced'
            ? 'reference'
            : entry.current
              ? operation === 'update'
                ? 'update'
                : 'unchanged'
              : 'create';
        const rel = relationship({
          kind: 'native',
          client,
          identity: entry.resource.resolvedIdentity,
          ownership,
          cleanup: ownership === 'managed' ? 'native' : 'none',
          ...(entry.plugin.requestedRef && {
            requestedRef: entry.plugin.requestedRef,
          }),
          ...(entry.plugin.resolvedRef && {
            resolvedRef: entry.plugin.resolvedRef,
          }),
          provenance: entry.resource.provenance,
        });
        const nativeAdapter = nativeAdapterFor(adapter, client);
        const commands = nativeAdapter.discloseNativeCommands(
          { kind: 'native', action, resource: entry.resource },
          context,
        );
        const skills =
          entry.plugin.skills === undefined
            ? undefined
            : Array.isArray(entry.plugin.skills)
              ? entry.plugin.skills
              : entry.plugin.skills.exclude.map((name) => `!${name}`);
        const marketplaceName = entry.resource.provenance.marketplaceName;
        const marketplaceSource = entry.resource.provenance.marketplaceSource;
        const priorMarketplace = marketplaceName
          ? previousResource(priorState, 'marketplace', client, marketplaceName)
          : undefined;
        if (
          nativeAdapter.applyMarketplaceRegistration &&
          marketplaceName &&
          marketplaceSource &&
          (entry.resource.provenance.managedMarketplaceRegistration ===
            'true' ||
            priorMarketplace?.ownership === 'managed')
        ) {
          const registration = {
            name: marketplaceName,
            source: marketplaceSource,
          };
          const marketplaceAction: ProfilePlanAction =
            entry.resource.provenance.managedMarketplaceRegistration === 'true'
              ? 'create'
              : 'unchanged';
          const marketplaceRel = relationship({
            kind: 'marketplace',
            client,
            identity: marketplaceName,
            ownership: 'managed',
            cleanup: 'marketplace',
            provenance: {
              marketplaceName,
              registrationIdentity: marketplaceSource,
            },
          });
          const duplicate = steps.find(
            ({ relationship: candidate }) =>
              candidate.key === marketplaceRel.key,
          );
          if (duplicate) {
            if (
              duplicate.marketplaceRegistration?.source !== marketplaceSource
            ) {
              throw new Error(
                `Profile marketplace '${marketplaceName}' is requested from conflicting sources`,
              );
            }
          } else {
            const marketplaceCommands = nativeAdapter.discloseNativeCommands(
              {
                kind: 'marketplace',
                action: marketplaceAction,
                registration,
              },
              context,
            );
            steps.push({
              public: publicStep(
                client,
                'marketplace',
                marketplaceName,
                marketplaceAction,
                {},
                marketplaceCommands.length > 0
                  ? { commands: marketplaceCommands }
                  : undefined,
              ),
              relationship: marketplaceRel,
              marketplaceRegistration: registration,
              context,
            });
          }
          desiredKeys.add(marketplaceRel.key);
        }
        const nativeStep: InternalProfilePlanStep = {
          public: publicStep(
            client,
            'native',
            rel.identity,
            action,
            {
              ...(entry.plugin.requestedRef && {
                requestedRef: entry.plugin.requestedRef,
              }),
              ...(entry.plugin.resolvedRef && {
                resolvedRef: entry.plugin.resolvedRef,
              }),
            },
            {
              source: entry.resource.requestedIdentity,
              ...(skills && { skills }),
              ...(commands.length > 0 && { commands }),
            },
          ),
          relationship: rel,
          nativeResource: entry.resource,
          ...(entry.current && { currentNativeResource: entry.current }),
          context,
        };
        steps.push(nativeStep);
        desiredKeys.add(rel.key);
        const trackedMarketplaceName =
          entry.resource.provenance.marketplaceName;
        if (trackedMarketplaceName) {
          const marketplace = previousResource(
            priorState,
            'marketplace',
            client,
            trackedMarketplaceName,
          );
          if (marketplace) desiredKeys.add(marketplace.key);
        }
      }

      for (const plugin of filePlugins) {
        const resolvedSource = await resolveProfileFileSource(plugin, runtime);
        try {
          const skillWarnings: string[] = [];
          const collected = await collectPluginSkills(
            resolvedSource.path,
            plugin.source,
            undefined,
            basename(resolvedSource.path),
            undefined,
            plugin.skills,
            skillWarnings,
          );
          warnings.push(...skillWarnings);
          const skillNameMap =
            plugin.skills !== undefined
              ? new Map(
                  collected.map((skill) => [
                    skill.folderName,
                    skill.folderName,
                  ]),
                )
              : undefined;
          const copyResults = await copyPluginToWorkspace(
            resolvedSource.path,
            context.root,
            client,
            {
              dryRun: true,
              clientMappings: { [client]: context.fileMapping },
              writeRoot: context.root,
              syncMode: 'copy',
              ...(skillNameMap && { skillNameMap }),
            },
          );
          const failed = copyResults.find(
            (result) => result.action === 'failed',
          );
          if (failed)
            throw new Error(
              failed.error ??
                `Could not plan profile file ${failed.destination}`,
            );
          for (const copy of copyResults) {
            for (const file of await expandCopyResult(
              copy.source,
              copy.destination,
            )) {
              const planned = await planManagedFile({
                client,
                kind: 'file',
                root: context.root,
                path: file.destination,
                content: file.content,
                mode: file.mode,
                priorState,
                provenance: {
                  source: plugin.source,
                  declarationIndex: String(plugin.declarationIndex),
                  ...(resolvedSource.resolvedSha && {
                    resolvedSha: resolvedSource.resolvedSha,
                  }),
                },
                ...(resolvedSource.requestedRef && {
                  requestedRef: resolvedSource.requestedRef,
                }),
                ...(resolvedSource.resolvedRef && {
                  resolvedRef: resolvedSource.resolvedRef,
                }),
              });
              const duplicate = steps.find(
                (step) => step.relationship.key === planned.relationship.key,
              );
              if (duplicate) {
                if (
                  duplicate.relationship.fingerprint !==
                  planned.relationship.fingerprint
                )
                  throw new Error(
                    `Profile plugins collide at ${file.destination}`,
                  );
                continue;
              }
              steps.push(planned);
              desiredKeys.add(planned.relationship.key);
            }
          }
        } finally {
          await resolvedSource.cleanup?.();
        }
      }

      const serializationInput = {
        plugins: [
          ...orderedNative.map((entry) => entry.plugin),
          ...filePlugins,
        ],
        settings: declaredClient.settings,
        ...(effectiveMcpServers && { mcpServers: effectiveMcpServers }),
      };
      if (
        Object.keys(declaredClient.settings).length > 0 &&
        !adapter.capabilities.settings
      )
        throw new Error(`Profile client '${client}' does not support settings`);
      if (hasMcp && !adapter.capabilities.mcp)
        throw new Error(
          `Profile client '${client}' does not support MCP configuration`,
        );
      const settings = adapter.serializeSettings(context, serializationInput);
      const mcp = adapter.serializeMcp(context, serializationInput);
      if (hasMcp && !settings && !mcp)
        throw new Error(
          `Profile client '${client}' did not serialize its MCP configuration`,
        );
      if (settings) {
        const planned = await planManagedFile({
          client,
          kind: 'settings',
          root: context.root,
          path: settings.path,
          content: settings.content,
          mode: settings.mode,
          priorState,
        });
        steps.push(
          hasMcp && !mcp
            ? {
                ...planned,
                public: {
                  ...planned.public,
                  detail: {
                    mcpServers: mcpDisclosures(effectiveMcpServers ?? {}),
                  },
                },
                context,
              }
            : planned,
        );
        desiredKeys.add(planned.relationship.key);
      }
      if (mcp) {
        const planned = await planManagedFile({
          client,
          kind: 'mcp',
          root: context.root,
          path: mcp.path,
          content: mcp.content,
          mode: mcp.mode,
          priorState,
        });
        steps.push({
          ...planned,
          public: {
            ...planned.public,
            detail: {
              mcpServers: mcpDisclosures(effectiveMcpServers ?? {}),
            },
          },
          ...(requiresMcpPrerequisite && {
            requiresMcpPrerequisite: true,
          }),
          context,
        });
        desiredKeys.add(planned.relationship.key);
      }

      if (declaredClient.launcher) {
        const rendered = renderProfileLaunchers(
          declaredClient.launcher,
          context.launcher,
        ).filter((launcher) =>
          runtime.platform === 'win32'
            ? launcher.companion !== 'posix'
            : launcher.companion === 'posix',
        );
        for (const launcher of rendered) {
          const path = join(runtime.binDir, launcher.fileName);
          const planned = await planManagedFile({
            client,
            kind: 'launcher',
            root: runtime.binDir,
            path,
            content: launcher.content,
            mode: launcher.mode,
            priorState,
            provenance: {
              launcherName: declaredClient.launcher,
              companion: launcher.companion,
            },
          });
          steps.push(planned);
          desiredKeys.add(planned.relationship.key);
        }
      }
    }

    if (operation === 'update' && priorState) {
      const removalOrder: Record<ProfileStepKind, number> = {
        launcher: 0,
        mcp: 1,
        settings: 1,
        file: 1,
        native: 2,
        marketplace: 3,
        root: 4,
      };
      const staleResources = [...priorState.resources].sort(
        (left, right) => removalOrder[left.kind] - removalOrder[right.kind],
      );
      for (const resource of staleResources) {
        if (
          desiredKeys.has(resource.key) ||
          resource.transition === 'removed'
        ) {
          continue;
        }
        const context = contexts.get(resource.client);
        if (!context) {
          throw new Error(
            `Missing stale cleanup context for ${resource.client}`,
          );
        }
        if (resource.kind === 'native') {
          const inspection = await inspectionFor(resource.client);
          const live = inspection.resources.find(
            (candidate) => candidate.resolvedIdentity === resource.identity,
          );
          const action: ProfilePlanAction =
            resource.ownership === 'managed'
              ? live
                ? 'remove'
                : 'unchanged'
              : 'retain';
          const adapter = adapters.get(resource.client);
          if (!adapter) {
            throw new Error(
              `Missing stale cleanup adapter for ${resource.client}`,
            );
          }
          const commands = live
            ? nativeAdapterFor(adapter, resource.client).discloseNativeCommands(
                { kind: 'native', action, resource: live },
                context,
              )
            : [];
          steps.push({
            public: publicStep(
              resource.client,
              'native',
              resource.identity,
              action,
              {},
              commands.length > 0
                ? {
                    ...(live?.requestedIdentity && {
                      source: live.requestedIdentity,
                    }),
                    commands,
                  }
                : undefined,
            ),
            relationship: resource,
            ...(live && { nativeResource: live }),
            context,
          });
        } else if (
          resource.path &&
          ['file', 'settings', 'mcp', 'launcher'].includes(resource.kind)
        ) {
          steps.push(
            staleFileStep(
              resource,
              await fingerprintProfileFile(resource.path),
              resource.kind === 'launcher' ? runtime.binDir : context.root,
              context,
            ),
          );
        } else if (resource.kind === 'marketplace') {
          const action: ProfilePlanAction =
            resource.ownership === 'managed' ? 'remove' : 'retain';
          const marketplaceName =
            resource.provenance?.marketplaceName ?? resource.identity;
          const registration = {
            name: marketplaceName,
            source:
              resource.provenance?.registrationIdentity ?? marketplaceName,
          };
          const adapter = adapters.get(resource.client);
          const commands =
            action === 'remove' && adapter && isNativeProfileAdapter(adapter)
              ? adapter.discloseNativeCommands(
                  { kind: 'marketplace', action, registration },
                  context,
                )
              : [];
          steps.push({
            public: publicStep(
              resource.client,
              'marketplace',
              resource.identity,
              action,
              {},
              commands.length > 0 ? { commands } : undefined,
            ),
            relationship: resource,
            marketplaceRegistration: registration,
            context,
          });
        } else if (resource.kind === 'root') {
          const action: ProfilePlanAction =
            resource.ownership === 'managed' ? 'remove' : 'retain';
          steps.push({
            public: publicStep(
              resource.client,
              'root',
              resource.identity,
              action,
            ),
            relationship: resource,
            root: resource.path ?? managedContextRoot(context),
            path: resource.path ?? resource.identity,
            context,
          });
        }
      }
    }
  }

  const digest = declaration
    ? hashProfileDeclaration(declaration)
    : priorState?.declarationDigest;
  if (!digest)
    throw new Error(`Profile '${profile}' has no declaration digest`);
  const orderedSteps = orderProfileSteps(steps, operation, adapters);
  const plannedClients: ProfilePlanClient[] = [];
  for (const client of resolutionClients) {
    const context = contexts.get(client);
    if (!context) continue;
    const declared = declaration?.clients.find(
      (entry) => entry.name === client,
    );
    const rendered = declared?.launcher
      ? renderProfileLaunchers(declared.launcher, context.launcher).filter(
          (launcher) =>
            runtime.platform === 'win32'
              ? launcher.companion !== 'posix'
              : launcher.companion === 'posix',
        )
      : [];
    plannedClients.push({
      client,
      mechanism: context.mechanism,
      root: managedContextRoot(context),
      agentRoot: context.root,
      ...(declared?.launcher && {
        launcher: {
          name: declared.launcher,
          command: {
            command: context.launcher.command,
            args: context.launcher.args,
          },
          destinations: rendered.map((launcher) =>
            join(runtime.binDir, launcher.fileName),
          ),
        },
      }),
    });
  }
  const result: ProfilePlan = Object.freeze({
    profile,
    operation,
    declarationDigest: digest,
    clients: Object.freeze(plannedClients),
    steps: Object.freeze(orderedSteps.map((step) => step.public)),
    warnings: Object.freeze(
      warnings.map(
        (warning) =>
          sanitizeProfileError(warning) ?? 'Profile planning warning',
      ),
    ),
  });
  const internal: InternalProfilePlan = Object.freeze({
    public: result,
    runtime,
    ...(declaration && { declaration }),
    clients: Object.freeze(desiredClients),
    contexts,
    adapters,
    priorState,
    steps: Object.freeze(orderedSteps),
  });
  INTERNAL_PLANS.set(result, internal);
  return result;
}
