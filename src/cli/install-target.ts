import { join } from 'node:path';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import { buildPluginSyncPlans } from '../core/sync.js';
import {
  mergeTargetedPluginEntry,
  resolveGitHubIdentity,
} from '../core/workspace-modify.js';
import {
  getUserWorkspaceConfigPath,
  isUserConfigPath,
} from '../core/user-workspace.js';
import {
  CLIENT_INPUT_TYPES,
  CLIENT_TYPES,
  ClientTypeSchema,
  getClientTypes,
  getPluginSource,
  type ClientEntry,
  type ClientType,
  type PluginEntry,
} from '../models/workspace-config.js';
import { supportsClientScope } from '../models/client-mapping.js';

export type InstallScope = 'project' | 'user';
export type InstallTargetDisposition = 'initialize' | 'inherit' | 'override';

export interface InstallScopeState {
  readonly clients: readonly ClientEntry[];
  readonly plugins?: readonly PluginEntry[];
}

export type InstallScopeStateLoader = () => Promise<InstallScopeState | null>;
export type InstallScopeStateSource =
  | InstallScopeState
  | InstallScopeStateLoader
  | null;

export interface InstallTargetEnvironment {
  readonly json: boolean;
  readonly ci: boolean;
  readonly stdinIsTTY: boolean;
  readonly stdoutIsTTY: boolean;
}

export interface InstallScopePromptOption {
  readonly scope: InstallScope;
  readonly configPath: string;
  readonly description: 'this workspace' | 'all workspaces';
}

export interface InstallScopePromptRequest {
  readonly options: readonly InstallScopePromptOption[];
  readonly initialValue: InstallScope;
  readonly aliasNotice?: string;
}

export interface InstallClientsPromptRequest {
  readonly scope: InstallScope;
  readonly configPath: string;
  readonly initialValues: readonly ClientType[];
  readonly configuredClients: readonly ClientEntry[];
}

export interface InstallTargetEffectiveMethod {
  readonly client: ClientType;
  readonly method: 'file' | 'native';
}

export interface InstallTargetSummary {
  readonly action: string;
  readonly payload: string;
  readonly scope: InstallScope;
  readonly configPath: string;
  readonly clients: readonly ClientType[];
  readonly effectiveMethods: readonly InstallTargetEffectiveMethod[];
  readonly disposition: InstallTargetDisposition;
}

export interface InstallConfirmationPromptRequest {
  readonly summary: InstallTargetSummary;
  readonly initialValue: true;
}

/** Presentation adapters implement only the interaction needed by the resolver. */
export interface InstallTargetPromptPort {
  selectScope(request: InstallScopePromptRequest): Promise<InstallScope | null>;
  selectClients(
    request: InstallClientsPromptRequest,
  ): Promise<readonly string[] | null>;
  showSummary(summary: InstallTargetSummary): void | Promise<void>;
  confirm(request: InstallConfirmationPromptRequest): Promise<boolean | null>;
}

export interface ResolveInstallTargetOptions {
  readonly workspacePath: string;
  readonly declaration: PluginEntry;
  readonly action: string;
  readonly payload: string;
  readonly scopeStates: Readonly<Record<InstallScope, InstallScopeStateSource>>;
  readonly environment: InstallTargetEnvironment;
  readonly prompts?: InstallTargetPromptPort;
  readonly scope?: string;
  readonly clients?: string | readonly string[];
  readonly yes?: boolean;
  readonly defaultScope?: InstallScope;
  readonly defaultClients?: Partial<
    Readonly<Record<InstallScope, readonly ClientEntry[]>>
  >;
}

export interface ResolvedInstallTarget {
  readonly scope: InstallScope;
  readonly configPath: string;
  readonly clients: readonly ClientType[];
  readonly disposition: InstallTargetDisposition;
  readonly prospectiveDeclaration: PluginEntry;
  readonly selectedClientEntries: ClientEntry[];
  readonly summary: InstallTargetSummary;
}

export class InstallTargetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallTargetValidationError';
  }
}

const DEFAULT_CLIENTS: Readonly<Record<InstallScope, readonly ClientEntry[]>> =
  {
    project: ['universal'],
    user: ['copilot', 'codex', 'cursor', 'opencode', 'gemini', 'vscode'],
  };

function isInteractive(environment: InstallTargetEnvironment): boolean {
  return (
    !environment.json &&
    !environment.ci &&
    environment.stdinIsTTY &&
    environment.stdoutIsTTY
  );
}

function parseExplicitClients(value: string | readonly string[]): string[] {
  if (typeof value !== 'string') return [...value];
  const parts = value.split(',').map((client) => client.trim());
  if (parts.some((client) => client.length === 0)) {
    throw new InstallTargetValidationError(
      'Client list must contain one or more comma-separated client names.',
    );
  }
  return parts;
}

export function canonicalizeInstallClients(
  clients: readonly string[],
  source = 'Clients',
): ClientType[] {
  if (clients.length === 0) {
    throw new InstallTargetValidationError(
      `${source} must include at least one client.`,
    );
  }

  const selected = new Set<ClientType>();
  for (const client of clients) {
    const parsed = ClientTypeSchema.safeParse(client);
    if (!parsed.success) {
      throw new InstallTargetValidationError(
        `Invalid client '${client}'. Expected one of: ${CLIENT_INPUT_TYPES.join(', ')}.`,
      );
    }
    selected.add(parsed.data);
  }

  return CLIENT_TYPES.filter((client) => selected.has(client));
}

function canonicalizeEntries(
  entries: readonly ClientEntry[],
  source: string,
): ClientType[] {
  return canonicalizeInstallClients(getClientTypes([...entries]), source);
}

function sameClients(
  left: readonly ClientType[],
  right: readonly ClientType[],
): boolean {
  return (
    left.length === right.length &&
    left.every((client, index) => client === right[index])
  );
}

function declarationForDisposition(
  declaration: PluginEntry,
  clients: readonly ClientType[],
  disposition: InstallTargetDisposition,
): PluginEntry {
  if (disposition === 'override') {
    return typeof declaration === 'string'
      ? { source: declaration, clients: [...clients] }
      : { ...declaration, clients: [...clients] };
  }
  if (typeof declaration === 'string' || declaration.clients === undefined)
    return declaration;
  const { clients: _clients, ...inherited } = declaration;
  return inherited;
}

function scopeConfigPath(scope: InstallScope, workspacePath: string): string {
  return scope === 'user'
    ? getUserWorkspaceConfigPath()
    : join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
}

function validateScope(value: string): InstallScope {
  if (value !== 'project' && value !== 'user') {
    throw new InstallTargetValidationError(
      `Invalid scope '${value}'. Expected project or user.`,
    );
  }
  return value;
}

async function findExistingDeclaration(
  plugins: readonly PluginEntry[],
  declaration: PluginEntry,
): Promise<PluginEntry | undefined> {
  const source = getPluginSource(declaration);
  const exact = plugins.find((entry) => getPluginSource(entry) === source);
  if (exact !== undefined) return exact;

  const identity = await resolveGitHubIdentity(source);
  if (!identity) return undefined;
  for (const entry of plugins) {
    if ((await resolveGitHubIdentity(getPluginSource(entry))) === identity) {
      return entry;
    }
  }
  return undefined;
}

export async function resolveInstallTarget(
  options: ResolveInstallTargetOptions,
): Promise<ResolvedInstallTarget | null> {
  const interactive = isInteractive(options.environment);
  const prompts = interactive ? options.prompts : undefined;
  if (interactive && !prompts) {
    throw new InstallTargetValidationError(
      'Interactive target resolution requires prompt ports.',
    );
  }
  const aliasesUserConfig = isUserConfigPath(options.workspacePath);
  const projectPath = scopeConfigPath('project', options.workspacePath);
  const userPath = scopeConfigPath('user', options.workspacePath);
  const validScopes: InstallScope[] = aliasesUserConfig
    ? ['user']
    : ['project', 'user'];

  let scope: InstallScope;
  if (options.scope !== undefined) {
    scope = validateScope(options.scope);
    if (aliasesUserConfig && scope === 'project') {
      throw new InstallTargetValidationError(
        `Project scope is unavailable because ${projectPath} is the user config. Use user scope instead.`,
      );
    }
  } else if (prompts) {
    const preferredScope = options.defaultScope ?? 'project';
    const selected = await prompts.selectScope({
      options: validScopes.map((candidate) => ({
        scope: candidate,
        configPath: candidate === 'project' ? projectPath : userPath,
        description:
          candidate === 'project' ? 'this workspace' : 'all workspaces',
      })),
      initialValue: validScopes.includes(preferredScope)
        ? preferredScope
        : 'user',
      ...(aliasesUserConfig && {
        aliasNotice:
          'Project and user scope resolve to the same config; only user scope is available.',
      }),
    });
    if (selected === null) return null;
    scope = validateScope(selected);
    if (!validScopes.includes(scope)) {
      throw new InstallTargetValidationError(
        `Scope '${scope}' is not available here.`,
      );
    }
  } else {
    scope = aliasesUserConfig ? 'user' : (options.defaultScope ?? 'project');
  }

  const configPath = scope === 'project' ? projectPath : userPath;
  const stateSource = options.scopeStates[scope];
  const state =
    typeof stateSource === 'function' ? await stateSource() : stateSource;
  const configuredEntries = state?.clients ?? [];
  const initialEntries =
    state?.clients ?? options.defaultClients?.[scope] ?? DEFAULT_CLIENTS[scope];

  let clients: ClientType[];
  if (options.clients !== undefined) {
    clients = canonicalizeInstallClients(
      parseExplicitClients(options.clients),
      'Explicit clients',
    );
  } else {
    const initialValues =
      initialEntries.length === 0
        ? []
        : canonicalizeEntries(initialEntries, 'Initial clients');
    if (prompts) {
      while (true) {
        const selected = await prompts.selectClients({
          scope,
          configPath,
          initialValues,
          configuredClients: configuredEntries,
        });
        if (selected === null) return null;
        if (selected.length === 0) continue;
        clients = canonicalizeInstallClients(selected, 'Selected clients');
        break;
      }
    } else {
      clients = initialValues;
    }
  }

  if (scope === 'user') {
    const unsupported = clients.filter(
      (client) => !supportsClientScope(client, 'user'),
    );
    if (unsupported.length > 0) {
      throw new InstallTargetValidationError(
        `User scope is unavailable for: ${unsupported.join(', ')}`,
      );
    }
  }

  const configuredClients = state
    ? state.clients.length === 0
      ? []
      : canonicalizeEntries(state.clients, 'Configured clients')
    : null;
  const disposition: InstallTargetDisposition =
    configuredClients === null
      ? 'initialize'
      : sameClients(configuredClients, clients)
        ? 'inherit'
        : 'override';
  const targetedDeclaration = declarationForDisposition(
    options.declaration,
    clients,
    disposition,
  );
  const summaryClientEntries = state ? [...state.clients] : [...clients];
  const existingDeclaration = await findExistingDeclaration(
    state?.plugins ?? [],
    options.declaration,
  );
  const prospectiveDeclaration = mergeTargetedPluginEntry(
    existingDeclaration,
    targetedDeclaration,
    getPluginSource(options.declaration),
    summaryClientEntries,
  );
  const selectedClientEntries = clients.map(
    (client) =>
      configuredEntries.find((entry) =>
        typeof entry === 'string' ? entry === client : entry.name === client,
      ) ?? client,
  );
  const plan = buildPluginSyncPlans(
    [prospectiveDeclaration],
    summaryClientEntries,
    scope,
  ).plans[0];
  const fileClients = new Set(plan?.clients ?? []);
  const nativeClients = new Set(plan?.nativeClients ?? []);
  const effectiveMethods = clients.flatMap(
    (client): InstallTargetEffectiveMethod[] => {
      if (fileClients.has(client)) return [{ client, method: 'file' }];
      if (nativeClients.has(client)) return [{ client, method: 'native' }];
      return [];
    },
  );
  const summary: InstallTargetSummary = {
    action: options.action,
    payload: options.payload,
    scope,
    configPath,
    clients,
    effectiveMethods,
    disposition,
  };

  if (prompts) {
    await prompts.showSummary(summary);
    if (!options.yes) {
      const confirmed = await prompts.confirm({ summary, initialValue: true });
      if (confirmed !== true) return null;
    }
  }

  return {
    scope,
    configPath,
    clients,
    disposition,
    prospectiveDeclaration,
    selectedClientEntries,
    summary,
  };
}
