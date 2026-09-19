import { isCancel, password } from '@clack/prompts';
import {
  array,
  command,
  flag,
  multioption,
  option,
  optional,
  positional,
  string,
} from 'cmd-ts';
import { dump } from 'js-yaml';
import {
  runHttpMcpStdioProxy,
  validateOAuthCallbackUrl,
} from '../../core/mcp-http-stdio-proxy.js';
import {
  addManagedMcpServer,
  listManagedMcpServers,
  type McpAuthorizationInteraction,
  type McpDestinationSync,
  reauthenticateManagedMcpServer,
  removeManagedMcpServer,
  updateManagedMcpServers,
} from '../../core/mcp-management.js';
import {
  buildMcpServerConfigFromFlags,
  getMcpServer,
  type McpDestination,
  parseKeyValuePairs,
  resolveMcpDestination,
} from '../../core/mcp-servers.js';
import {
  type ClientType,
  ClientTypeSchema,
  type McpServerConfig,
} from '../../models/workspace-config.js';
import { buildProfileData, formatProfileResult } from '../format-profile.js';
import { formatMcpResult } from '../format-sync.js';
import { buildDescription, conciseSubcommands } from '../help.js';
import { isJsonMode, jsonOutput } from '../json-output.js';
import {
  mcpAddMeta,
  mcpGetMeta,
  mcpListMeta,
  mcpReauthMeta,
  mcpRemoveMeta,
  mcpUpdateMeta,
} from '../metadata/mcp.js';
import { terminalSafe } from '../terminal-output.js';

// =============================================================================
// Helpers
// =============================================================================

const destinationArgs = {
  scope: option({
    type: optional(string),
    long: 'scope',
    description: "Declaration scope: 'project' (default) or 'user'",
  }),
  profile: option({
    type: optional(string),
    long: 'profile',
    description: 'Named profile declaration destination',
  }),
};

interface DestinationFlags {
  scope?: string | undefined;
  profile?: string | undefined;
}

function resolveCommandDestination(
  commandName: string,
  flags: DestinationFlags,
): McpDestination {
  try {
    return resolveMcpDestination({
      cwd: process.cwd(),
      ...(flags.scope === undefined ? {} : { scope: flags.scope }),
      ...(flags.profile === undefined ? {} : { profile: flags.profile }),
    });
  } catch (error) {
    exitWithError(
      commandName,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function serializeDestination(
  destination: McpDestination,
): { kind: 'project' | 'user' } | { kind: 'profile'; name: string } {
  return destination.kind === 'profile'
    ? { kind: 'profile', name: destination.name }
    : { kind: destination.kind };
}

function destinationDisplay(destination: McpDestination): string {
  switch (destination.kind) {
    case 'project':
      return 'workspace.yaml';
    case 'user':
      return 'the user workspace';
    case 'profile':
      return `profile '${terminalSafe(destination.name)}'`;
  }
}

function parseClientFilter(inputs: string[]): ClientType[] | undefined {
  if (inputs.length === 0) return undefined;

  const result: ClientType[] = [];
  const seen = new Set<ClientType>();
  for (const input of inputs) {
    for (const segment of input.split(',')) {
      const item = segment.trim();
      if (!item) {
        throw new Error('--client values cannot contain empty segments');
      }
      const parsed = ClientTypeSchema.safeParse(item);
      if (!parsed.success) {
        throw new Error(
          `Invalid client '${item}'. Valid clients: ${ClientTypeSchema.options.join(', ')}`,
        );
      }
      if (!seen.has(parsed.data)) {
        seen.add(parsed.data);
        result.push(parsed.data);
      }
    }
  }
  return result;
}

const REDACTED_VALUE = '[REDACTED]';
function isSensitiveCredentialName(value: string): boolean {
  const normalized = value.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return (
    normalized === 'key' ||
    /(?:authorization|auth|credentials?|password|passwd|secrets?|signature|tokens?|accesstoken|refreshtoken|apikey|accesskey|privatekey)$/.test(
      normalized,
    )
  );
}

function redactUrlCredentials(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = REDACTED_VALUE;
    if (url.password) url.password = REDACTED_VALUE;
    for (const key of url.searchParams.keys()) {
      if (isSensitiveCredentialName(key)) {
        url.searchParams.set(key, REDACTED_VALUE);
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

function redactMcpArguments(args: string[]): string[] {
  let redactNext = false;
  return args.map((argument) => {
    if (redactNext) {
      redactNext = false;
      return REDACTED_VALUE;
    }
    const assignment = /^([^=]+)=(.*)$/.exec(argument);
    if (assignment && isSensitiveCredentialName(assignment[1] as string)) {
      return `${assignment[1]}=${REDACTED_VALUE}`;
    }
    if (/^Bearer\s+\S+/i.test(argument)) {
      return `Bearer ${REDACTED_VALUE}`;
    }
    if (/^https?:\/\//i.test(argument)) {
      return redactUrlCredentials(argument);
    }
    if (
      argument.startsWith('-') &&
      isSensitiveCredentialName(argument.replace(/^-+/, ''))
    ) {
      redactNext = true;
    }
    return argument;
  });
}

function redactMcpServerConfig(config: McpServerConfig): McpServerConfig {
  if ('url' in config) {
    return {
      ...config,
      url: redactUrlCredentials(config.url),
      ...(config.headers && {
        headers: Object.fromEntries(
          Object.keys(config.headers).map((key) => [key, REDACTED_VALUE]),
        ),
      }),
    };
  }
  return {
    ...config,
    ...(config.args && { args: redactMcpArguments(config.args) }),
    ...(config.env && {
      env: Object.fromEntries(
        Object.keys(config.env).map((key) => [key, REDACTED_VALUE]),
      ),
    }),
  };
}

function exitWithError(command: string, error: string): never {
  if (isJsonMode()) {
    jsonOutput({ success: false, command, error });
  } else {
    console.error(`Error: ${terminalSafe(error)}`);
  }
  process.exit(1);
}

/**
 * Parse and validate flags shared by MCP server declarations.
 */
function buildConfigFromAddFlags(
  commandName: string,
  commandOrUrl: string,
  transport: string | undefined,
  args: string[],
  env: string[],
  header: string[],
  client: string[],
): McpServerConfig {
  if (transport && transport !== 'http' && transport !== 'stdio') {
    exitWithError(
      commandName,
      `Invalid transport '${transport}'. Expected 'http' or 'stdio'.`,
    );
  }

  const envResult = parseKeyValuePairs(env, '-e/--env');
  if ('error' in envResult) exitWithError(commandName, envResult.error);

  const headerResult = parseKeyValuePairs(header, '--header');
  if ('error' in headerResult) exitWithError(commandName, headerResult.error);

  let clients: ClientType[] | undefined;
  try {
    clients = parseClientFilter(client);
  } catch (e) {
    exitWithError(commandName, e instanceof Error ? e.message : String(e));
  }

  const buildOpts: Parameters<typeof buildMcpServerConfigFromFlags>[0] = {
    commandOrUrl,
    args,
    env: envResult.values,
    headers: headerResult.values,
  };
  if (transport) buildOpts.transport = transport as 'http' | 'stdio';
  if (clients) buildOpts.clients = clients;

  const built = buildMcpServerConfigFromFlags(buildOpts);
  if ('error' in built) exitWithError(commandName, built.error);
  return built.config;
}

function createAuthorizationInteraction(): McpAuthorizationInteraction {
  return {
    output: console.log,
    readCallback: async ({ redirectUrl, state, signal }) => {
      const callbackUrl = await password({
        message: 'Paste the OAuth callback URL if using another browser',
        signal,
        validate: (value) => {
          if (!value) {
            return 'OAuth callback URL is required';
          }
          try {
            validateOAuthCallbackUrl(value, redirectUrl, state);
            return undefined;
          } catch (error) {
            return error instanceof Error
              ? error.message
              : 'Invalid OAuth callback URL';
          }
        },
      });
      if (isCancel(callbackUrl)) {
        throw new Error('OAuth authorization cancelled');
      }
      return callbackUrl;
    },
  };
}

async function runManagedMcpOperation<T>(
  commandName: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    exitWithError(
      commandName,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function getConfiguredMcpServer(
  commandName: string,
  destination: McpDestination,
  name: string,
): Promise<McpServerConfig | null> {
  try {
    return await getMcpServer(destination, name);
  } catch (error) {
    exitWithError(
      commandName,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function profileSyncData(
  sync: Extract<McpDestinationSync, { kind: 'profile' }>,
): { status: 'not-installed' } | Record<string, unknown> {
  return sync.result
    ? buildProfileData(sync.result)
    : { status: 'not-installed' };
}

function printMcpSyncResult(
  result: Extract<McpDestinationSync, { kind: 'mcp' }>['result'],
): void {
  for (const [scope, scopeResult] of Object.entries(result.mcpResults)) {
    if (!scopeResult) continue;
    const lines = formatMcpResult(scopeResult, scope);
    if (lines.length > 0) {
      console.log('');
      for (const line of lines) console.log(line);
    }
  }
  for (const warning of result.warnings) {
    console.log(`  \u26A0 ${warning}`);
  }
}

function printProfileSyncResult(
  destination: Extract<McpDestination, { kind: 'profile' }>,
  sync: Extract<McpDestinationSync, { kind: 'profile' }>,
): void {
  if (!sync.result) {
    console.log(
      `Profile '${terminalSafe(destination.name)}' is not installed; skipped client reconciliation.`,
    );
    return;
  }
  console.log('');
  for (const line of formatProfileResult(sync.result)) console.log(line);
}

/**
 * Render the completed reconciliation for a declaration mutation.
 */
function renderPostMutationSync(
  commandName: string,
  destination: McpDestination,
  sync: McpDestinationSync,
  successMessage: string,
  jsonExtra: Record<string, unknown>,
): void {
  if (isJsonMode()) {
    jsonOutput({
      success: true,
      command: commandName,
      data: {
        ...jsonExtra,
        destination: serializeDestination(destination),
        ...(sync.kind === 'mcp'
          ? { mcpResults: sync.result.mcpResults }
          : { sync: profileSyncData(sync) }),
      },
    });
    return;
  }

  console.log(successMessage);
  if (sync.kind === 'mcp') {
    printMcpSyncResult(sync.result);
  } else if (destination.kind === 'profile') {
    printProfileSyncResult(destination, sync);
  }
}

function serverToDisplay(name: string, config: McpServerConfig): string[] {
  const lines: string[] = [`${name}:`];
  const isHttp = 'url' in config;
  lines.push(`  transport: ${isHttp ? 'http' : 'stdio'}`);
  if (isHttp) {
    lines.push(`  url: ${config.url}`);
    if (config.headers && Object.keys(config.headers).length > 0) {
      lines.push('  headers:');
      for (const [k, v] of Object.entries(config.headers)) {
        lines.push(`    ${k}: ${v}`);
      }
    }
  } else {
    lines.push(`  command: ${config.command}`);
    if (config.args && config.args.length > 0) {
      lines.push(`  args: ${JSON.stringify(config.args)}`);
    }
    if (config.env && Object.keys(config.env).length > 0) {
      lines.push('  env:');
      for (const [k, v] of Object.entries(config.env)) {
        lines.push(`    ${k}: ${v}`);
      }
    }
  }
  if (config.clients && config.clients.length > 0) {
    lines.push(`  clients: [${config.clients.join(', ')}]`);
  }
  return lines;
}

// =============================================================================
// mcp add
// =============================================================================

const addArgs = {
  name: positional({ type: string, displayName: 'name' }),
  commandOrUrl: positional({ type: string, displayName: 'commandOrUrl' }),
  transport: option({
    type: optional(string),
    long: 'transport',
    description:
      "Transport: 'http' or 'stdio' (auto-detected from URL if omitted)",
  }),
  args: multioption({
    type: array(string),
    long: 'arg',
    description: 'Argument for stdio command (repeatable)',
  }),
  env: multioption({
    type: array(string),
    long: 'env',
    short: 'e',
    description: 'Environment variable KEY=VALUE (repeatable)',
  }),
  header: multioption({
    type: array(string),
    long: 'header',
    description: 'HTTP header KEY=VALUE (repeatable)',
  }),
  client: multioption({
    type: array(string),
    long: 'client',
    description: 'Client filter (repeatable; comma-separated values accepted)',
  }),
};

const mcpAddCmd = command({
  name: 'add',
  description: buildDescription(mcpAddMeta),
  args: {
    ...addArgs,
    ...destinationArgs,
    force: flag({
      long: 'force',
      short: 'f',
      description: 'Replace an existing server with the same name',
    }),
  },
  handler: async ({
    name,
    commandOrUrl,
    transport,
    args,
    env,
    header,
    client,
    force,
    scope,
    profile,
  }) => {
    const destination = resolveCommandDestination('mcp add', {
      scope,
      profile,
    });
    const config = buildConfigFromAddFlags(
      'mcp add',
      commandOrUrl,
      transport,
      args,
      env,
      header,
      client,
    );
    const authorization =
      !isJsonMode() && process.stdin.isTTY
        ? createAuthorizationInteraction()
        : undefined;
    const result = await runManagedMcpOperation('mcp add', () =>
      addManagedMcpServer({
        destination,
        name,
        config,
        force,
        ...(authorization ? { authorization } : {}),
      }),
    );

    renderPostMutationSync(
      'mcp add',
      destination,
      result.sync,
      `\u2713 Added MCP server '${terminalSafe(name)}' to ${destinationDisplay(destination)}`,
      {
        name,
        config: redactMcpServerConfig(result.config),
      },
    );
  },
});

// =============================================================================
// mcp remove
// =============================================================================

const mcpRemoveCmd = command({
  name: 'remove',
  description: buildDescription(mcpRemoveMeta),
  args: {
    name: positional({ type: string, displayName: 'name' }),
    ...destinationArgs,
  },
  handler: async ({ name, scope, profile }) => {
    const destination = resolveCommandDestination('mcp remove', {
      scope,
      profile,
    });
    const sync = await runManagedMcpOperation('mcp remove', () =>
      removeManagedMcpServer(destination, name),
    );
    renderPostMutationSync(
      'mcp remove',
      destination,
      sync,
      `\u2713 Removed MCP server '${terminalSafe(name)}' from ${destinationDisplay(destination)}`,
      { name },
    );
  },
});

// =============================================================================
// mcp reauth
// =============================================================================

const mcpReauthCmd = command({
  name: 'reauth',
  description: buildDescription(mcpReauthMeta),
  args: {
    name: positional({ type: string, displayName: 'name' }),
    ...destinationArgs,
  },
  handler: async ({ name, scope, profile }) => {
    const destination = resolveCommandDestination('mcp reauth', {
      scope,
      profile,
    });
    if (isJsonMode() || !process.stdin.isTTY) {
      exitWithError(
        'mcp reauth',
        'OAuth login requires an interactive terminal',
      );
    }

    await runManagedMcpOperation('mcp reauth', () =>
      reauthenticateManagedMcpServer(
        destination,
        name,
        createAuthorizationInteraction(),
      ),
    );
    console.log(
      `\u2713 Reauthenticated MCP server '${terminalSafe(name)}' in ${destinationDisplay(destination)}`,
    );
  },
});

// =============================================================================
// mcp proxy
// =============================================================================

const mcpProxyCmd = command({
  name: 'proxy',
  description: 'Expose a remote HTTP MCP server locally over stdio',
  args: {
    serverUrl: positional({ type: string, displayName: 'serverUrl' }),
    header: multioption({
      type: array(string),
      long: 'header',
      description: 'HTTP header KEY=VALUE (repeatable)',
    }),
    headerEnv: multioption({
      type: array(string),
      long: 'header-env',
      description: 'HTTP header KEY=ENV_VAR reference (repeatable)',
    }),
    profile: option({
      type: optional(string),
      long: 'profile',
      description: 'Profile-owned OAuth credential scope',
    }),
  },
  handler: async ({ serverUrl, header, headerEnv, profile }) => {
    const headerResult = parseKeyValuePairs(header, '--header');
    if ('error' in headerResult) {
      exitWithError('mcp proxy', headerResult.error);
    }
    const headerEnvResult = parseKeyValuePairs(headerEnv, '--header-env');
    if ('error' in headerEnvResult) {
      exitWithError('mcp proxy', headerEnvResult.error);
    }
    const environmentHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(headerEnvResult.values)) {
      const reference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
      const variable = reference?.[1] ?? value;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
        exitWithError(
          'mcp proxy',
          `Invalid environment variable '${value}' for header '${key}'`,
        );
      }
      environmentHeaders[key] = `\${${variable}}`;
    }
    const destination =
      profile === undefined
        ? undefined
        : resolveCommandDestination('mcp proxy', { profile });
    await runHttpMcpStdioProxy(
      serverUrl,
      { ...headerResult.values, ...environmentHeaders },
      {
        ...(destination?.kind === 'profile'
          ? { profile: destination.name }
          : {}),
      },
    );
  },
});

// =============================================================================
// mcp list
// =============================================================================

const mcpListCmd = command({
  name: 'list',
  description: buildDescription(mcpListMeta),
  args: destinationArgs,
  handler: async ({ scope, profile }) => {
    const destination = resolveCommandDestination('mcp list', {
      scope,
      profile,
    });
    const servers = await runManagedMcpOperation('mcp list', () =>
      listManagedMcpServers(destination),
    );
    const names = Object.keys(servers);
    const redactedServers = Object.fromEntries(
      Object.entries(servers).map(([name, config]) => [
        name,
        redactMcpServerConfig(config),
      ]),
    );

    if (isJsonMode()) {
      jsonOutput({
        success: true,
        command: 'mcp list',
        data: {
          destination: serializeDestination(destination),
          servers: redactedServers,
          total: names.length,
        },
      });
      return;
    }

    if (names.length === 0) {
      console.log(
        `No MCP servers defined in ${destinationDisplay(destination)}.`,
      );
      console.log('');
      console.log('Add one with:');
      console.log('  allagents mcp add <name> <commandOrUrl>');
      return;
    }

    console.log(
      `MCP servers in ${destinationDisplay(destination)} (${names.length}):`,
    );
    console.log('');
    for (const name of names) {
      const config = redactedServers[name];
      if (!config) continue;
      for (const line of serverToDisplay(name, config)) {
        console.log(`  ${line}`);
      }
      console.log('');
    }
  },
});

// =============================================================================
// mcp get
// =============================================================================

const mcpGetCmd = command({
  name: 'get',
  description: buildDescription(mcpGetMeta),
  args: {
    name: positional({ type: string, displayName: 'name' }),
    ...destinationArgs,
  },
  handler: async ({ name, scope, profile }) => {
    const destination = resolveCommandDestination('mcp get', {
      scope,
      profile,
    });
    const config = await getConfiguredMcpServer('mcp get', destination, name);
    if (!config) {
      exitWithError(
        'mcp get',
        `MCP server '${name}' not found in ${destinationDisplay(destination)}`,
      );
    }
    const redactedConfig = redactMcpServerConfig(config);

    if (isJsonMode()) {
      jsonOutput({
        success: true,
        command: 'mcp get',
        data: {
          destination: serializeDestination(destination),
          name,
          config: redactedConfig,
        },
      });
      return;
    }

    console.log(dump({ [name]: redactedConfig }, { lineWidth: -1 }).trimEnd());
  },
});

// =============================================================================
// mcp update
// =============================================================================

const mcpUpdateCmd = command({
  name: 'update',
  description: buildDescription(mcpUpdateMeta),
  args: {
    offline: flag({
      long: 'offline',
      description: 'Use cached plugins without fetching from remote',
    }),
    ...destinationArgs,
  },
  handler: async ({ offline, scope, profile }) => {
    const destination = resolveCommandDestination('mcp update', {
      scope,
      profile,
    });
    const sync = await runManagedMcpOperation('mcp update', () =>
      updateManagedMcpServers(destination, { offline }),
    );

    if (isJsonMode()) {
      jsonOutput({
        success: true,
        command: 'mcp update',
        data: {
          destination: serializeDestination(destination),
          ...(sync.kind === 'mcp'
            ? {
                mcpResults: sync.result.mcpResults,
                warnings: sync.result.warnings,
              }
            : { sync: profileSyncData(sync) }),
        },
      });
      return;
    }

    if (sync.kind === 'profile') {
      if (destination.kind === 'profile') {
        printProfileSyncResult(destination, sync);
      }
      return;
    }

    const hasAnyChanges = Object.values(sync.result.mcpResults).some(
      (result) =>
        result &&
        (result.added > 0 ||
          result.overwritten > 0 ||
          result.removed > 0 ||
          result.skipped > 0),
    );

    if (!hasAnyChanges) {
      console.log('No MCP server changes.');
    } else {
      for (const [resultScope, mcpResult] of Object.entries(
        sync.result.mcpResults,
      )) {
        if (!mcpResult) continue;
        const lines = formatMcpResult(mcpResult, resultScope);
        if (lines.length > 0) {
          for (const line of lines) console.log(line);
          console.log('');
        }
      }
    }

    if (sync.result.warnings.length > 0) {
      console.log('Warnings:');
      for (const warning of sync.result.warnings) {
        console.log(`  \u26A0 ${warning}`);
      }
    }
  },
});

// =============================================================================
// mcp group
// =============================================================================

export const mcpCmd = conciseSubcommands(
  {
    name: 'mcp',
    description: 'Manage MCP servers for AI clients',
    cmds: {
      add: mcpAddCmd,
      reauth: mcpReauthCmd,
      proxy: mcpProxyCmd,
      remove: mcpRemoveCmd,
      list: mcpListCmd,
      get: mcpGetCmd,
      update: mcpUpdateCmd,
    },
  },
  ['proxy'],
);
