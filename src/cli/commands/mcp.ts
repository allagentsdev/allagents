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
import type {
  CallToolResult,
  CompatibilityCallToolResult,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
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
  callMcpTool,
  findMcpTool,
  listAllMcpTools,
  type ManagedMcpOperation,
  type ManagedMcpOperationOptions,
  type ManagedMcpOperationResult,
  runManagedMcpOperation as runManagedMcpRuntimeOperation,
} from '../../core/mcp-runtime.js';
import {
  CLIENT_INPUT_TYPES,
  type ClientType,
  ClientTypeSchema,
  type McpServerConfig,
} from '../../models/workspace-config.js';
import { buildProfileData, formatProfileResult } from '../format-profile.js';
import { formatMcpResult } from '../format-sync.js';
import { buildDescription, conciseSubcommands } from '../help.js';
import {
  isJsonMode,
  jsonFieldAllowlist,
  jsonOutput,
  setJsonMode,
} from '../json-output.js';
import {
  classifyMcpToolInputSchema,
  type McpToolInputClassification,
  type McpToolInputOption,
  parseMcpToolArguments,
} from '../mcp-runtime-args.js';
import {
  mcpAddMeta,
  mcpCallMeta,
  mcpGetMeta,
  mcpListMeta,
  mcpReauthMeta,
  mcpRemoveMeta,
  mcpToolsMeta,
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
          `Invalid client '${item}'. Valid clients: ${CLIENT_INPUT_TYPES.join(', ')}`,
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

export type McpRuntimeCommandKind = 'tools' | 'call';
type McpRuntimeSignal = 'SIGINT' | 'SIGTERM';

interface RuntimeOutputOptions {
  json: boolean;
  jsonFields?: string[];
  jqExpr?: string;
}

interface ParsedRuntimeRequest {
  kind: McpRuntimeCommandKind;
  server?: string;
  tool?: string;
  scope?: string;
  profile?: string;
  search?: string;
  help: boolean;
  toolArguments: string[];
  output: RuntimeOutputOptions;
}

export type McpRuntimeManagedOperationRunner = <T>(
  destination: McpDestination,
  serverName: string,
  operation: ManagedMcpOperation<T>,
  options: ManagedMcpOperationOptions,
) => Promise<ManagedMcpOperationResult<T>>;

export interface McpRuntimeCliDependencies {
  runManagedOperation: McpRuntimeManagedOperationRunner;
}

class McpRuntimeUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpRuntimeUsageError';
  }
}

const defaultMcpRuntimeDependencies: McpRuntimeCliDependencies = {
  runManagedOperation: (destination, serverName, operation, options) =>
    runManagedMcpRuntimeOperation(destination, serverName, operation, options),
};

function outputFields(value: string): string[] | undefined {
  const fields = value
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean);
  return fields.length > 0 ? fields : undefined;
}

function consumeLeadingOutputOptions(args: readonly string[]): {
  index: number;
  legal: boolean;
} {
  let index = 0;
  while (index < args.length) {
    const argument = args[index];
    if (argument === '--json' || argument?.startsWith('--json=')) {
      index += 1;
      continue;
    }
    if (argument === '--jq') {
      if (args[index + 1] === undefined) return { index, legal: false };
      index += 2;
      continue;
    }
    break;
  }
  return { index, legal: true };
}

export function classifyMcpRuntimeCommand(
  args: readonly string[],
): McpRuntimeCommandKind | undefined {
  const leading = consumeLeadingOutputOptions(args);
  if (!leading.legal || args[leading.index] !== 'mcp') return undefined;
  const command = args[leading.index + 1];
  return command === 'tools' || command === 'call' ? command : undefined;
}

function takeOptionValue(
  args: readonly string[],
  index: number,
  name: string,
): string {
  const value = args[index + 1];
  if (value === undefined) {
    throw new McpRuntimeUsageError(`Missing value for ${name}`);
  }
  return value;
}

function setUniqueOption(
  request: ParsedRuntimeRequest,
  property: 'scope' | 'profile' | 'search',
  value: string,
  flag: string,
): void {
  if (request[property] !== undefined) {
    throw new McpRuntimeUsageError(`${flag} may only be specified once`);
  }
  request[property] = value;
}

function consumeRuntimeOutputOption(
  args: readonly string[],
  index: number,
  output: RuntimeOutputOptions,
): number | undefined {
  const argument = args[index];
  if (argument === '--json') {
    output.json = true;
    return index;
  }
  if (argument?.startsWith('--json=')) {
    output.json = true;
    const fields = outputFields(argument.slice('--json='.length));
    if (fields === undefined) delete output.jsonFields;
    else output.jsonFields = fields;
    return index;
  }
  if (argument === '--jq') {
    if (output.jqExpr !== undefined) {
      throw new McpRuntimeUsageError('--jq may only be specified once');
    }
    output.jqExpr = takeOptionValue(args, index, '--jq');
    return index + 1;
  }
  return undefined;
}

function newParsedRuntimeRequest(
  kind: McpRuntimeCommandKind,
): ParsedRuntimeRequest {
  return {
    kind,
    help: false,
    toolArguments: [],
    output: { json: false },
  };
}

function parseMcpRuntimeRequest(
  args: readonly string[],
  existingRequest?: ParsedRuntimeRequest,
): ParsedRuntimeRequest {
  const kind = classifyMcpRuntimeCommand(args);
  if (!kind) throw new McpRuntimeUsageError('Not an MCP runtime command');
  const leading = consumeLeadingOutputOptions(args);
  const request = existingRequest ?? newParsedRuntimeRequest(kind);

  for (let index = 0; index < leading.index; index += 1) {
    const consumed = consumeRuntimeOutputOption(args, index, request.output);
    if (consumed === undefined) {
      throw new McpRuntimeUsageError(`Unknown output option '${args[index]}'`);
    }
    index = consumed;
  }

  let opaqueIdentities = false;
  for (let index = leading.index + 2; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (!opaqueIdentities && argument === '--') {
      opaqueIdentities = true;
      continue;
    }
    if (opaqueIdentities) {
      if (request.server === undefined) {
        request.server = argument;
        continue;
      }
      if (kind === 'call' && request.tool === undefined) {
        request.tool = argument;
        continue;
      }
      throw new McpRuntimeUsageError(
        `Unexpected argument '${argument}' for mcp ${kind}`,
      );
    }

    const outputIndex = consumeRuntimeOutputOption(args, index, request.output);
    if (outputIndex !== undefined) {
      index = outputIndex;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      request.help = true;
      continue;
    }

    if (argument === '--scope' || argument.startsWith('--scope=')) {
      const attached = argument.startsWith('--scope=');
      const value = attached
        ? argument.slice('--scope='.length)
        : takeOptionValue(args, index, '--scope');
      setUniqueOption(request, 'scope', value, '--scope');
      if (!attached) index += 1;
      continue;
    }
    if (argument === '--profile' || argument.startsWith('--profile=')) {
      const attached = argument.startsWith('--profile=');
      const value = attached
        ? argument.slice('--profile='.length)
        : takeOptionValue(args, index, '--profile');
      setUniqueOption(request, 'profile', value, '--profile');
      if (!attached) index += 1;
      continue;
    }

    if (
      kind === 'tools' &&
      (argument === '--search' || argument?.startsWith('--search='))
    ) {
      const attached = argument.startsWith('--search=');
      const value = attached
        ? argument.slice('--search='.length)
        : takeOptionValue(args, index, '--search');
      setUniqueOption(request, 'search', value, '--search');
      if (!attached) index += 1;
      continue;
    }

    if (
      kind === 'call' &&
      (argument === '--input' || argument.startsWith('--input='))
    ) {
      request.toolArguments.push(argument);
      if (argument === '--input') {
        request.toolArguments.push(takeOptionValue(args, index, '--input'));
        index += 1;
      }
      continue;
    }

    if (!argument.startsWith('-')) {
      if (request.server === undefined) {
        request.server = argument;
        continue;
      }
      if (kind === 'call' && request.tool === undefined) {
        request.tool = argument;
        continue;
      }
      if (kind === 'tools') {
        throw new McpRuntimeUsageError(
          `Unexpected argument '${argument}' for mcp tools`,
        );
      }
      request.toolArguments.push(argument);
      continue;
    }

    if (kind === 'tools') {
      throw new McpRuntimeUsageError(
        `Unknown option '${argument}' for mcp tools`,
      );
    }

    request.toolArguments.push(argument);
    if (argument.startsWith('--') && !argument.includes('=')) {
      const value = args[index + 1];
      if (value !== undefined) {
        request.toolArguments.push(value);
        index += 1;
      }
    }
  }

  return request;
}

export function shouldHandleMcpRuntimeCommand(
  args: readonly string[],
): boolean {
  const kind = classifyMcpRuntimeCommand(args);
  if (!kind) return false;
  try {
    const request = parseMcpRuntimeRequest(args);
    if (!request.help) return true;
    return (
      request.kind === 'call' &&
      request.server !== undefined &&
      request.tool !== undefined
    );
  } catch {
    return true;
  }
}

function validateRuntimeOutput(request: ParsedRuntimeRequest): void {
  if (request.output.jqExpr !== undefined && !request.output.json) {
    throw new McpRuntimeUsageError('--jq requires --json');
  }
  if (request.help && request.output.jsonFields !== undefined) {
    throw new McpRuntimeUsageError(
      '--json=<fields> is not supported with --help; use --json',
    );
  }
  if (request.output.jsonFields === undefined) return;

  const meta = request.kind === 'tools' ? mcpToolsMeta : mcpCallMeta;
  const allowed = jsonFieldAllowlist(meta);
  const unknown = request.output.jsonFields.find(
    (field) => !allowed.includes(field),
  );
  if (unknown) {
    throw new McpRuntimeUsageError(
      `Unknown JSON field: "${unknown}". Available fields: ${[...allowed]
        .sort()
        .join(', ')}`,
    );
  }
}

function runtimeDestination(request: ParsedRuntimeRequest): McpDestination {
  try {
    return resolveMcpDestination({
      cwd: process.cwd(),
      ...(request.scope === undefined ? {} : { scope: request.scope }),
      ...(request.profile === undefined ? {} : { profile: request.profile }),
    });
  } catch (error) {
    throw new McpRuntimeUsageError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function signalExitCode(signal: McpRuntimeSignal): number {
  return signal === 'SIGINT' ? 130 : 143;
}

type ManagedExecution<T> =
  | {
      result: ManagedMcpOperationResult<T>;
      error?: never;
      signal?: McpRuntimeSignal;
    }
  | {
      result?: never;
      error: Error;
      signal?: McpRuntimeSignal;
    };

async function executeManagedRuntime<T>(
  destination: McpDestination,
  server: string,
  operation: ManagedMcpOperation<T>,
  dependencies: McpRuntimeCliDependencies,
): Promise<ManagedExecution<T>> {
  const controller = new AbortController();
  let receivedSignal: McpRuntimeSignal | undefined;
  const handleSignal = (signal: McpRuntimeSignal) => {
    if (receivedSignal !== undefined) {
      process.exit(signalExitCode(signal));
    }
    receivedSignal = signal;
    controller.abort();
  };
  const onSigint = () => handleSignal('SIGINT');
  const onSigterm = () => handleSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  try {
    const result = await dependencies.runManagedOperation(
      destination,
      server,
      operation,
      { signal: controller.signal },
    );
    return {
      result,
      ...(receivedSignal === undefined ? {} : { signal: receivedSignal }),
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error : new Error(String(error)),
      ...(receivedSignal === undefined ? {} : { signal: receivedSignal }),
    };
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}

function writeRuntimeEnvelope(
  success: boolean,
  command: string,
  data?: unknown,
  error?: string,
): void {
  jsonOutput({
    success,
    command,
    ...(data === undefined ? {} : { data }),
    ...(error === undefined ? {} : { error }),
  });
}

function reportRuntimeError(
  command: string,
  error: Error,
  json: boolean,
): void {
  if (json) {
    writeRuntimeEnvelope(false, command, undefined, error.message);
  } else {
    console.error(`Error: ${terminalSafe(error.message)}`);
  }
}

function cleanupErrorMessage(error: Error): string {
  return `MCP cleanup failed: ${error.message}`;
}

function applyRuntimeExit(
  exitCode: number | undefined,
  signal: McpRuntimeSignal | undefined,
): void {
  if (signal !== undefined) {
    process.exitCode = signalExitCode(signal);
  } else if (exitCode !== undefined) {
    process.exitCode = exitCode;
  }
}

function singleLineTerminalText(value: string): string {
  return terminalSafe(value.replace(/[\r\n]+/g, ' ')).trim();
}

function shellToken(value: string): string {
  const safe = terminalSafe(value);
  if (/^[A-Za-z0-9_./:@+-]+$/.test(safe)) return safe;
  return `'${safe.replaceAll("'", "'\\''")}'`;
}

function runtimeDestinationTokens(destination: McpDestination): string[] {
  if (destination.kind === 'project') return [];
  if (destination.kind === 'user') return ['--scope', 'user'];
  return ['--profile', shellToken(destination.name)];
}

function liveHelpCommand(
  destination: McpDestination,
  server: string,
  tool: string,
): string {
  const identities = [server, tool];
  const destinationTokens = runtimeDestinationTokens(destination);
  if (identities.some((identity) => identity.startsWith('-'))) {
    return [
      'allagents',
      'mcp',
      'call',
      ...destinationTokens,
      '--help',
      '--',
      ...identities.map(shellToken),
    ].join(' ');
  }
  return [
    'allagents',
    'mcp',
    'call',
    shellToken(server),
    shellToken(tool),
    '--help',
    ...destinationTokens,
  ].join(' ');
}

function liveHelpUsage(
  destination: McpDestination,
  server: string,
  tool: string,
): string {
  const identities = [server, tool];
  const destinationTokens = runtimeDestinationTokens(destination);
  if (identities.some((identity) => identity.startsWith('-'))) {
    return [
      'allagents',
      'mcp',
      'call',
      ...destinationTokens,
      '[options]',
      '--',
      ...identities.map(shellToken),
    ].join(' ');
  }
  return [
    'allagents',
    'mcp',
    'call',
    shellToken(server),
    shellToken(tool),
    '[options]',
    ...destinationTokens,
  ].join(' ');
}
function terminalJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
    .split('\n')
    .map((line) => terminalSafe(line))
    .join('\n');
}

function renderTools(
  destination: McpDestination,
  server: string,
  tools: readonly Tool[],
  search: string | undefined,
): void {
  if (tools.length === 0) {
    if (search === undefined) {
      console.log(`MCP server '${terminalSafe(server)}' exposes no tools.`);
    } else {
      console.log(
        `No MCP tools matched '${terminalSafe(search)}' on server '${terminalSafe(server)}'.`,
      );
    }
    return;
  }

  for (const [index, tool] of tools.entries()) {
    console.log(terminalSafe(tool.name));
    if (tool.title !== undefined) {
      console.log(`  Title: ${singleLineTerminalText(tool.title)}`);
    }
    if (tool.description !== undefined) {
      console.log(`  Description: ${singleLineTerminalText(tool.description)}`);
    }
    console.log(`  Help: ${liveHelpCommand(destination, server, tool.name)}`);
    if (index < tools.length - 1) console.log('');
  }
}

function requiredToolFields(tool: Tool): string[] {
  return tool.inputSchema.required ?? [];
}

function liveInputData(
  tool: Tool,
  classification: McpToolInputClassification,
): Record<string, unknown> {
  const required = requiredToolFields(tool);
  return classification.mode === 'generated'
    ? {
        mode: 'generated',
        required,
        options: classification.options,
      }
    : {
        mode: 'input-only',
        required,
        reason: classification.reason,
      };
}

function optionValueLabel(option: McpToolInputOption): string {
  const base =
    option.kind === 'enum'
      ? (option.enumValues?.map(String).join(' | ') ?? option.valueKind)
      : option.valueKind;
  return option.kind === 'array' ? `${base} (repeatable)` : base;
}

function renderLiveHelp(
  destination: McpDestination,
  server: string,
  tool: Tool,
  classification: McpToolInputClassification,
): void {
  console.log(`Usage: ${liveHelpUsage(destination, server, tool.name)}`);
  console.log('');
  console.log(`Tool: ${terminalSafe(tool.name)}`);
  if (tool.title !== undefined) {
    console.log(`Title: ${singleLineTerminalText(tool.title)}`);
  }
  if (tool.description !== undefined) {
    console.log(`Description: ${singleLineTerminalText(tool.description)}`);
  }
  const required = requiredToolFields(tool);
  console.log(
    `Required fields: ${required.length > 0 ? required.map(terminalSafe).join(', ') : 'none'}`,
  );
  console.log('Input schema:');
  console.log(terminalJson(tool.inputSchema));
  console.log('');
  console.log('Input options:');
  console.log('  --input <json>  Exact JSON object input');
  if (classification.mode === 'input-only') {
    console.log(
      `  Generated options unavailable: ${terminalSafe(classification.reason)}`,
    );
    return;
  }
  for (const option of classification.options) {
    const requirement = option.required ? 'required' : 'optional';
    const description =
      option.description === undefined
        ? ''
        : ` - ${singleLineTerminalText(option.description)}`;
    console.log(
      `  --${terminalSafe(option.name)} <${terminalSafe(optionValueLabel(option))}> (${requirement})${description}`,
    );
  }
}

function renderCallResult(result: CompatibilityCallToolResult): void {
  if (!Array.isArray(result.content)) {
    console.log(terminalJson(result.toolResult));
    return;
  }
  const callResult = result as CallToolResult;
  for (const item of callResult.content) {
    if (item.type === 'text') {
      console.log(terminalSafe(item.text));
    } else {
      console.log(terminalJson(item));
    }
  }
  if (callResult.structuredContent !== undefined) {
    console.log('Structured content:');
    console.log(terminalJson(callResult.structuredContent));
  }
}

interface CallHelpOperation {
  kind: 'help';
  tool: Tool;
  classification: McpToolInputClassification;
}

interface CallResultOperation {
  kind: 'call';
  result: CompatibilityCallToolResult;
}

type CallOperation = CallHelpOperation | CallResultOperation;

async function runToolsRuntime(
  request: ParsedRuntimeRequest,
  destination: McpDestination,
  dependencies: McpRuntimeCliDependencies,
): Promise<void> {
  const server = request.server;
  if (server === undefined) {
    throw new McpRuntimeUsageError(
      'Usage: allagents mcp tools <server> [options]',
    );
  }
  const execution = await executeManagedRuntime(
    destination,
    server,
    ({ client, signal }) => listAllMcpTools(client, { signal }),
    dependencies,
  );
  if (execution.error !== undefined) {
    reportRuntimeError('mcp tools', execution.error, request.output.json);
    applyRuntimeExit(1, execution.signal);
    return;
  }

  const managed = execution.result;
  if (managed.operation.status === 'rejected') {
    reportRuntimeError(
      'mcp tools',
      managed.operation.error,
      request.output.json,
    );
    if (managed.cleanup.status === 'rejected') {
      console.error(
        `Error: ${terminalSafe(cleanupErrorMessage(managed.cleanup.error))}`,
      );
    }
    applyRuntimeExit(
      managed.operation.error instanceof McpRuntimeUsageError &&
        managed.cleanup.status === 'fulfilled'
        ? 2
        : 1,
      execution.signal,
    );
    return;
  }

  const searchNeedle = request.search?.toLowerCase();
  const tools =
    searchNeedle === undefined
      ? managed.operation.value
      : managed.operation.value.filter(
          (tool) =>
            tool.name.toLowerCase().includes(searchNeedle) ||
            tool.title?.toLowerCase().includes(searchNeedle) === true ||
            tool.description?.toLowerCase().includes(searchNeedle) === true,
        );
  const data = {
    destination: serializeDestination(destination),
    server,
    ...(request.search === undefined ? {} : { search: request.search }),
    tools,
    total: tools.length,
  };
  const cleanupMessage =
    managed.cleanup.status === 'rejected'
      ? cleanupErrorMessage(managed.cleanup.error)
      : undefined;
  if (request.output.json) {
    writeRuntimeEnvelope(
      cleanupMessage === undefined,
      'mcp tools',
      data,
      cleanupMessage,
    );
  } else {
    renderTools(destination, server, tools, request.search);
  }
  if (cleanupMessage !== undefined) {
    console.error(`Error: ${terminalSafe(cleanupMessage)}`);
  }
  applyRuntimeExit(
    cleanupMessage === undefined ? undefined : 1,
    execution.signal,
  );
}

async function runCallRuntime(
  request: ParsedRuntimeRequest,
  destination: McpDestination,
  dependencies: McpRuntimeCliDependencies,
): Promise<void> {
  const { server, tool: toolName } = request;
  if (server === undefined || toolName === undefined) {
    throw new McpRuntimeUsageError(
      'Usage: allagents mcp call <server> <tool> [options]',
    );
  }
  const execution = await executeManagedRuntime<CallOperation>(
    destination,
    server,
    async ({ client, signal }) => {
      const catalog = await listAllMcpTools(client, { signal });
      const tool = findMcpTool(catalog, toolName);
      const classification = classifyMcpToolInputSchema(tool.inputSchema);
      if (request.help) return { kind: 'help', tool, classification };
      let parsedArguments: Record<string, unknown>;
      try {
        parsedArguments = parseMcpToolArguments(
          classification,
          request.toolArguments,
        );
      } catch (error) {
        throw new McpRuntimeUsageError(
          error instanceof Error ? error.message : String(error),
        );
      }
      const result = await callMcpTool(client, tool, parsedArguments, {
        signal,
      });
      return { kind: 'call', result };
    },
    dependencies,
  );
  if (execution.error !== undefined) {
    reportRuntimeError('mcp call', execution.error, request.output.json);
    applyRuntimeExit(1, execution.signal);
    return;
  }

  const managed = execution.result;
  if (managed.operation.status === 'rejected') {
    reportRuntimeError(
      'mcp call',
      managed.operation.error,
      request.output.json,
    );
    if (managed.cleanup.status === 'rejected') {
      console.error(
        `Error: ${terminalSafe(cleanupErrorMessage(managed.cleanup.error))}`,
      );
    }
    applyRuntimeExit(
      managed.operation.error instanceof McpRuntimeUsageError &&
        managed.cleanup.status === 'fulfilled'
        ? 2
        : 1,
      execution.signal,
    );
    return;
  }

  const operation = managed.operation.value;
  const data =
    operation.kind === 'help'
      ? {
          destination: serializeDestination(destination),
          server,
          tool: toolName,
          descriptor: operation.tool,
          input: liveInputData(operation.tool, operation.classification),
        }
      : {
          destination: serializeDestination(destination),
          server,
          tool: toolName,
          result: operation.result,
        };
  const cleanupMessage =
    managed.cleanup.status === 'rejected'
      ? cleanupErrorMessage(managed.cleanup.error)
      : undefined;
  const toolFailed =
    operation.kind === 'call' &&
    (operation.result as Record<string, unknown>).isError === true;
  if (request.output.json) {
    writeRuntimeEnvelope(
      !toolFailed && cleanupMessage === undefined,
      'mcp call',
      data,
      cleanupMessage,
    );
  } else if (operation.kind === 'help') {
    renderLiveHelp(
      destination,
      server,
      operation.tool,
      operation.classification,
    );
  } else {
    renderCallResult(operation.result);
  }
  if (cleanupMessage !== undefined) {
    console.error(`Error: ${terminalSafe(cleanupMessage)}`);
  }
  applyRuntimeExit(
    toolFailed || cleanupMessage !== undefined ? 1 : undefined,
    execution.signal,
  );
}

function applyRuntimeOutput(output: RuntimeOutputOptions): void {
  setJsonMode(output.json, {
    ...(output.jsonFields === undefined ? {} : { fields: output.jsonFields }),
    ...(output.jqExpr === undefined ? {} : { jqExpr: output.jqExpr }),
  });
}

export async function runMcpRuntimeCommand(
  args: readonly string[],
  dependencies: McpRuntimeCliDependencies = defaultMcpRuntimeDependencies,
): Promise<void> {
  let request: ParsedRuntimeRequest | undefined;
  try {
    const kind = classifyMcpRuntimeCommand(args);
    if (!kind) throw new McpRuntimeUsageError('Not an MCP runtime command');
    request = newParsedRuntimeRequest(kind);
    request = parseMcpRuntimeRequest(args, request);
    validateRuntimeOutput(request);
    applyRuntimeOutput(request.output);
    const destination = runtimeDestination(request);
    if (request.kind === 'tools') {
      await runToolsRuntime(request, destination, dependencies);
    } else {
      await runCallRuntime(request, destination, dependencies);
    }
  } catch (error) {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    const command =
      classifyMcpRuntimeCommand(args) === 'tools' ? 'mcp tools' : 'mcp call';
    const json = request?.output.json ?? false;
    if (request !== undefined) {
      applyRuntimeOutput(request.output);
    }
    reportRuntimeError(command, normalized, json);
    process.exitCode = normalized instanceof McpRuntimeUsageError ? 2 : 1;
  }
}

const mcpToolsCmd = command({
  name: 'tools',
  description: buildDescription(mcpToolsMeta),
  args: {
    server: positional({ type: string, displayName: 'server' }),
    search: option({
      type: optional(string),
      long: 'search',
      description:
        'Case-insensitive substring filter over tool name, title, and description',
    }),
    ...destinationArgs,
  },
  handler: async () => runMcpRuntimeCommand(process.argv.slice(2)),
});

const mcpCallCmd = command({
  name: 'call',
  description: buildDescription(mcpCallMeta),
  args: {
    server: positional({ type: string, displayName: 'server' }),
    tool: positional({ type: string, displayName: 'tool' }),
    input: option({
      type: optional(string),
      long: 'input',
      description:
        'Exact JSON object input; mutually exclusive with generated tool options',
    }),
    ...destinationArgs,
  },
  handler: async () => runMcpRuntimeCommand(process.argv.slice(2)),
});

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
      tools: mcpToolsCmd,
      call: mcpCallCmd,
      proxy: mcpProxyCmd,
      remove: mcpRemoveCmd,
      list: mcpListCmd,
      get: mcpGetCmd,
      update: mcpUpdateCmd,
    },
  },
  ['proxy'],
);
