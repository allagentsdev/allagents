import * as p from '@clack/prompts';
import {
  addManagedMcpServer,
  listManagedMcpServers,
  type McpAuthorizationInteraction,
  McpUpdateError,
  reauthenticateManagedMcpServer,
  removeManagedMcpServer,
  updateManagedMcpServers,
} from '../../../core/mcp-management.js';
import {
  type McpDestination,
  resolveMcpDestination,
} from '../../../core/mcp-servers.js';
import { getUserWorkspaceConfig } from '../../../core/user-workspace.js';
import {
  type ClientType,
  ClientTypeSchema,
  type McpServerConfig,
  type UserWorkspaceConfig,
} from '../../../models/workspace-config.js';
import { terminalSafe } from '../../terminal-output.js';
import type { TuiCache } from '../cache.js';
import type { TuiContext } from '../context.js';

interface PromptOption<T extends string> {
  label: string;
  value: T;
  hint?: string;
}

export interface McpTuiPrompts {
  select<T extends string>(request: {
    message: string;
    options: Array<PromptOption<T>>;
  }): Promise<T | symbol>;
  text(request: {
    message: string;
    placeholder?: string;
  }): Promise<string | symbol>;
  password(request: {
    message: string;
    signal: AbortSignal;
  }): Promise<string | symbol>;
  multiselect<T extends string>(request: {
    message: string;
    options: Array<PromptOption<T>>;
    required: false;
  }): Promise<T[] | symbol>;
  confirm(request: { message: string }): Promise<boolean | symbol>;
  isCancel(value: unknown): value is symbol;
  note(message: string, title?: string): void;
}

export interface McpManagementApi {
  addManagedMcpServer: typeof addManagedMcpServer;
  listManagedMcpServers: typeof listManagedMcpServers;
  reauthenticateManagedMcpServer: typeof reauthenticateManagedMcpServer;
  removeManagedMcpServer: typeof removeManagedMcpServer;
  updateManagedMcpServers: typeof updateManagedMcpServers;
}

export interface McpTuiDependencies {
  prompts: McpTuiPrompts;
  management: McpManagementApi;
  getUserConfig(): Promise<UserWorkspaceConfig | null>;
  resolveDestination(options: {
    cwd?: string;
    scope?: string;
    profile?: string;
  }): McpDestination;
}

const clackPrompts: McpTuiPrompts = {
  async select<T extends string>(request: {
    message: string;
    options: Array<PromptOption<T>>;
  }): Promise<T | symbol> {
    return p.select<T>({
      ...request,
      options: request.options as unknown as p.Option<T>[],
    });
  },
  async text(request): Promise<string | symbol> {
    return p.text(request);
  },
  async password(request): Promise<string | symbol> {
    return p.password(request);
  },
  async multiselect<T extends string>(request: {
    message: string;
    options: Array<PromptOption<T>>;
    required: false;
  }): Promise<T[] | symbol> {
    return p.multiselect<T>({
      ...request,
      options: request.options as unknown as p.Option<T>[],
    });
  },
  async confirm(request): Promise<boolean | symbol> {
    return p.confirm(request);
  },
  isCancel(value): value is symbol {
    return p.isCancel(value);
  },
  note(message, title): void {
    p.note(message, title);
  },
};

const defaultDependencies: McpTuiDependencies = {
  prompts: clackPrompts,
  management: {
    addManagedMcpServer,
    listManagedMcpServers,
    reauthenticateManagedMcpServer,
    removeManagedMcpServer,
    updateManagedMcpServers,
  },
  getUserConfig: getUserWorkspaceConfig,
  resolveDestination: resolveMcpDestination,
};

interface DestinationChoice {
  key: string;
  label: string;
  hint: string;
  destination: McpDestination;
  clients: readonly ClientType[];
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = message.replace(/https?:\/\/[^\s'"<>]+/gi, (value) => {
    try {
      return new URL(value).origin;
    } catch {
      return '[redacted URL]';
    }
  });
  return terminalSafe(redacted);
}

async function buildDestinationChoices(
  context: TuiContext,
  dependencies: McpTuiDependencies,
): Promise<DestinationChoice[]> {
  const choices: DestinationChoice[] = [];
  if (context.hasWorkspace && context.workspacePath) {
    choices.push({
      key: 'project',
      label: 'Project',
      hint: 'current workspace',
      destination: dependencies.resolveDestination({
        cwd: context.workspacePath,
        scope: 'project',
      }),
      clients: ClientTypeSchema.options,
    });
  }

  choices.push({
    key: 'user',
    label: 'User',
    hint: 'global user configuration',
    destination: dependencies.resolveDestination({ scope: 'user' }),
    clients: ClientTypeSchema.options,
  });

  const userConfig = await dependencies.getUserConfig();
  for (const name of Object.keys(userConfig?.profiles ?? {}).sort()) {
    const profile = userConfig?.profiles?.[name];
    if (!profile) continue;
    choices.push({
      key: `profile:${name}`,
      label: `Profile: ${terminalSafe(name)}`,
      hint: 'declared user profile',
      destination: dependencies.resolveDestination({ profile: name }),
      clients: profile.clients.map((client) => client.name),
    });
  }
  return choices;
}

async function selectDestination(
  context: TuiContext,
  dependencies: McpTuiDependencies,
): Promise<DestinationChoice | null> {
  const choices = await buildDestinationChoices(context, dependencies);
  const selected = await dependencies.prompts.select({
    message: 'MCP server destination',
    options: [
      ...choices.map((choice) => ({
        label: choice.label,
        value: choice.key,
        hint: choice.hint,
      })),
      { label: 'Back', value: '__back__' },
    ],
  });
  if (dependencies.prompts.isCancel(selected) || selected === '__back__') {
    return null;
  }
  return choices.find((choice) => choice.key === selected) ?? null;
}

function destinationLabel(destination: McpDestination): string {
  if (destination.kind === 'profile') {
    return `profile ${terminalSafe(destination.name)}`;
  }
  return destination.kind;
}

async function promptRequired(
  prompts: McpTuiPrompts,
  message: string,
  placeholder?: string,
  validate?: (value: string) => string | null,
): Promise<string | null> {
  while (true) {
    const value = await prompts.text({
      message,
      ...(placeholder && { placeholder }),
    });
    if (prompts.isCancel(value)) return null;
    const normalized = value.trim();
    const validationError = normalized
      ? validate?.(normalized)
      : 'A value is required.';
    if (!validationError) return normalized;
    prompts.note(validationError, 'Invalid value');
  }
}

async function promptArguments(
  prompts: McpTuiPrompts,
): Promise<string[] | null> {
  const arguments_: string[] = [];
  while (true) {
    const value = await prompts.text({
      message: 'Argument (leave blank when finished)',
    });
    if (prompts.isCancel(value)) return null;
    if (value === '') return arguments_;
    arguments_.push(value);
  }
}

async function promptKeyValues(
  prompts: McpTuiPrompts,
  label: string,
): Promise<Record<string, string> | null> {
  const entries: Record<string, string> = {};
  while (true) {
    const value = await prompts.text({
      message: `${label} (KEY=VALUE; leave blank when finished)`,
    });
    if (prompts.isCancel(value)) return null;
    if (value.trim() === '') return entries;
    const separator = value.indexOf('=');
    const key = separator < 0 ? '' : value.slice(0, separator).trim();
    if (!key) {
      prompts.note(
        'Enter a non-empty key followed by = and a value.',
        'Invalid entry',
      );
      continue;
    }
    entries[key] = value.slice(separator + 1);
  }
}

async function promptClients(
  prompts: McpTuiPrompts,
  available: readonly ClientType[],
): Promise<ClientType[] | null> {
  const selected = await prompts.multiselect<ClientType>({
    message: 'Limit to clients (leave empty for all supported clients)',
    options: available.map((client) => ({ label: client, value: client })),
    required: false,
  });
  return prompts.isCancel(selected) ? null : selected;
}

function authorizationInteraction(
  prompts: McpTuiPrompts,
): McpAuthorizationInteraction {
  return {
    output(message): void {
      prompts.note(terminalSafe(message), 'Authorization');
    },
    async readCallback(request): Promise<string> {
      const value = await prompts.password({
        message: 'Paste the OAuth callback URL',
        signal: request.signal,
      });
      if (prompts.isCancel(value)) {
        throw new Error('OAuth authorization cancelled');
      }
      const callbackUrl = value.trim();
      if (!callbackUrl) {
        throw new Error('OAuth callback URL is required');
      }
      return callbackUrl;
    },
  };
}

async function handleMutationError(
  choice: DestinationChoice,
  error: unknown,
  cache: TuiCache | undefined,
  dependencies: McpTuiDependencies,
): Promise<boolean> {
  const { prompts, management } = dependencies;
  if (!(error instanceof McpUpdateError)) {
    prompts.note(errorMessage(error), 'Error');
    return false;
  }

  cache?.invalidate();
  prompts.note(errorMessage(error), 'Update Error');
  while (true) {
    const retry = await prompts.confirm({
      message: 'Client configuration update failed. Retry update now?',
    });
    if (prompts.isCancel(retry) || !retry) return true;

    try {
      await management.updateManagedMcpServers(choice.destination);
      prompts.note('Client configuration updated.', 'MCP Servers');
      return true;
    } catch (retryError) {
      prompts.note(errorMessage(retryError), 'Update Error');
    }
  }
}

async function addServer(
  choice: DestinationChoice,
  existing: Record<string, McpServerConfig>,
  cache: TuiCache | undefined,
  dependencies: McpTuiDependencies,
): Promise<void> {
  const { prompts, management } = dependencies;
  const name = await promptRequired(prompts, 'Server name');
  if (name === null) return;

  const force = Object.hasOwn(existing, name);

  const transport = await prompts.select({
    message: 'Transport',
    options: [
      { label: 'HTTP', value: 'http' },
      { label: 'stdio', value: 'stdio' },
    ],
  });
  if (prompts.isCancel(transport)) return;

  let config: McpServerConfig;
  if (transport === 'http') {
    const url = await promptRequired(
      prompts,
      'Server URL',
      'https://example.com/mcp',
      (value) =>
        /^https?:\/\//i.test(value)
          ? null
          : 'Enter an http:// or https:// URL.',
    );
    if (url === null) return;
    const headers = await promptKeyValues(prompts, 'Header');
    if (headers === null) return;
    const clients = await promptClients(prompts, choice.clients);
    if (clients === null) return;
    config = {
      type: 'http',
      url,
      ...(Object.keys(headers).length > 0 && { headers }),
      ...(clients.length > 0 && { clients }),
    };
  } else {
    const command = await promptRequired(prompts, 'Command', 'npx');
    if (command === null) return;
    const args = await promptArguments(prompts);
    if (args === null) return;
    const env = await promptKeyValues(prompts, 'Environment variable');
    if (env === null) return;
    const clients = await promptClients(prompts, choice.clients);
    if (clients === null) return;
    config = {
      type: 'stdio',
      command,
      ...(args.length > 0 && { args }),
      ...(Object.keys(env).length > 0 && { env }),
      ...(clients.length > 0 && { clients }),
    };
  }

  prompts.note(safeServerMetadata(name, config), 'Review MCP Server');
  const confirmed = await prompts.confirm({
    message: force
      ? `Replace MCP server "${terminalSafe(name)}"?`
      : `Add MCP server "${terminalSafe(name)}"?`,
  });
  if (prompts.isCancel(confirmed) || !confirmed) return;

  try {
    await management.addManagedMcpServer({
      destination: choice.destination,
      name,
      config,
      force,
      ...('url' in config && {
        authorization: authorizationInteraction(prompts),
      }),
    });
    cache?.invalidate();
    prompts.note(
      `Added ${terminalSafe(name)} to ${destinationLabel(choice.destination)}.`,
      'MCP Servers',
    );
  } catch (error) {
    await handleMutationError(choice, error, cache, dependencies);
  }
}

function safeServerMetadata(name: string, config: McpServerConfig): string {
  const lines = [`Name: ${terminalSafe(name)}`];
  if ('url' in config) {
    let origin = 'configured endpoint';
    try {
      origin = new URL(config.url).origin;
    } catch {
      // The management layer owns config validation. Avoid echoing malformed input.
    }
    lines.push('Transport: HTTP', `Origin: ${terminalSafe(origin)}`);
    const headerNames = Object.keys(config.headers ?? {});
    lines.push(
      `Headers: ${
        headerNames.length > 0
          ? headerNames.map(terminalSafe).join(', ')
          : 'none'
      }`,
    );
  } else {
    lines.push('Transport: stdio', 'Command: configured');
    lines.push(`Arguments: ${config.args?.length ?? 0} configured`);
    const environmentNames = Object.keys(config.env ?? {});
    lines.push(
      `Environment: ${
        environmentNames.length > 0
          ? environmentNames.map(terminalSafe).join(', ')
          : 'none'
      }`,
    );
  }
  lines.push(
    `Clients: ${
      config.clients?.length
        ? config.clients.map(terminalSafe).join(', ')
        : 'all supported'
    }`,
  );
  return lines.join('\n');
}

function serverActions(config: McpServerConfig): Array<PromptOption<string>> {
  return [
    ...('url' in config
      ? [{ label: 'Reauthenticate', value: 'reauthenticate' }]
      : []),
    { label: 'Remove', value: 'remove' },
    { label: 'Back', value: 'back' },
  ];
}

async function serverDetail(
  choice: DestinationChoice,
  name: string,
  config: McpServerConfig,
  cache: TuiCache | undefined,
  dependencies: McpTuiDependencies,
): Promise<void> {
  const { prompts, management } = dependencies;
  while (true) {
    prompts.note(safeServerMetadata(name, config), 'MCP Server');
    const action = await prompts.select({
      message: `MCP server: ${terminalSafe(name)}`,
      options: serverActions(config),
    });
    if (prompts.isCancel(action) || action === 'back') return;

    if (action === 'reauthenticate' && 'url' in config) {
      try {
        await management.reauthenticateManagedMcpServer(
          choice.destination,
          name,
          authorizationInteraction(prompts),
        );
        cache?.invalidate();
        prompts.note(`Reauthenticated ${terminalSafe(name)}.`, 'MCP Servers');
      } catch (error) {
        prompts.note(errorMessage(error), 'Error');
      }
      continue;
    }

    if (action === 'remove') {
      const confirmed = await prompts.confirm({
        message: `Remove MCP server "${terminalSafe(name)}"?`,
      });
      if (prompts.isCancel(confirmed) || !confirmed) continue;
      try {
        await management.removeManagedMcpServer(choice.destination, name);
        cache?.invalidate();
        prompts.note(`Removed ${terminalSafe(name)}.`, 'MCP Servers');
        return;
      } catch (error) {
        if (await handleMutationError(choice, error, cache, dependencies))
          return;
      }
    }
  }
}

async function manageDestination(
  choice: DestinationChoice,
  cache: TuiCache | undefined,
  dependencies: McpTuiDependencies,
): Promise<'destination' | 'exit'> {
  const { prompts, management } = dependencies;
  while (true) {
    let servers: Record<string, McpServerConfig>;
    try {
      servers = await management.listManagedMcpServers(choice.destination);
    } catch (error) {
      prompts.note(errorMessage(error), 'Error');
      return 'destination';
    }

    const names = Object.keys(servers).sort();
    const selected = await prompts.select({
      message: `${choice.label} MCP Servers`,
      options: [
        ...names.map((name) => ({
          label: terminalSafe(name),
          value: `server:${name}`,
          hint: 'url' in (servers[name] as McpServerConfig) ? 'HTTP' : 'stdio',
        })),
        { label: '+ Add server', value: '__add__' },
        { label: 'Back', value: '__back__' },
      ],
    });

    if (prompts.isCancel(selected)) return 'exit';
    if (selected === '__back__') return 'destination';
    if (selected === '__add__') {
      await addServer(choice, servers, cache, dependencies);
      continue;
    }

    if (selected.startsWith('server:')) {
      const name = selected.slice('server:'.length);
      const config = servers[name];
      if (config) {
        await serverDetail(choice, name, config, cache, dependencies);
      }
    }
  }
}

/** Manage project, user, and declared-profile MCP servers without shelling out to the CLI. */
export async function runMcpServers(
  context: TuiContext,
  cache?: TuiCache,
  dependencies: McpTuiDependencies = defaultDependencies,
): Promise<void> {
  try {
    while (true) {
      const choice = await selectDestination(context, dependencies);
      if (!choice) return;
      if ((await manageDestination(choice, cache, dependencies)) === 'exit')
        return;
    }
  } catch (error) {
    dependencies.prompts.note(errorMessage(error), 'Error');
  }
}
