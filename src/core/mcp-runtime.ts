import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type {
  CompatibilityCallToolResult,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpServerConfig } from '../models/workspace-config.js';
import {
  connectMcpHttpClient,
  createMcpCredentialGuard,
  type McpCredentialGuard,
} from './mcp-http-client.js';
import {
  getMcpServer,
  type McpDestination,
} from './mcp-servers.js';

const ENVIRONMENT_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const DEFAULT_HTTP_CLEANUP_TIMEOUT_MS = 2_000;
const DEFAULT_STDIO_EXIT_TIMEOUT_MS = 1_000;
const MAX_MCP_TOOL_PAGES = 100;
const MAX_MCP_TOOLS = 10_000;
const MAX_MCP_PROTOCOL_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_MCP_TOOL_METADATA_BYTES = MAX_MCP_PROTOCOL_MESSAGE_BYTES;
const MAX_MCP_SCHEMA_DEPTH = 64;
const MAX_MCP_SCHEMA_NODES = 100_000;

export type McpToolCatalog = readonly Tool[];

export interface McpRuntimeRequestOptions {
  signal?: AbortSignal;
}

export type ManagedMcpOperationOutcome<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; error: Error };

export type ManagedMcpCleanupOutcome =
  | { status: 'fulfilled' }
  | { status: 'rejected'; error: Error };

export interface ManagedMcpOperationResult<T> {
  operation: ManagedMcpOperationOutcome<T>;
  cleanup: ManagedMcpCleanupOutcome;
}

export interface ManagedMcpOperationContext {
  client: Client;
  signal: AbortSignal;
}

export interface ManagedMcpSession {
  client: Client;
  credentialGuard: McpCredentialGuard;
  close(): Promise<void>;
}

export interface ManagedMcpConnectionOptions {
  environment?: NodeJS.ProcessEnv;
  httpCleanupTimeoutMs?: number;
  stdioExitTimeoutMs?: number;
}

export interface ManagedMcpOperationOptions
  extends ManagedMcpConnectionOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type ManagedMcpOperation<T> = (
  context: ManagedMcpOperationContext,
) => Promise<T>;

export class McpRuntimeAuthorizationError extends Error {
  constructor(command: string) {
    super(`MCP authorization is required. Run \`${command}\` and try again.`);
    this.name = 'McpRuntimeAuthorizationError';
  }
}

export class McpRuntimeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`MCP operation timed out after ${timeoutMs}ms`);
    this.name = 'McpRuntimeTimeoutError';
  }
}

export class McpRuntimeCancelledError extends Error {
  constructor() {
    super('MCP operation was cancelled');
    this.name = 'McpRuntimeCancelledError';
  }
}

function assertBoundedMcpProtocolValue(
  value: unknown,
  label: string,
): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error(`MCP ${label} could not be serialized`);
  }
  if (
    Buffer.byteLength(serialized, 'utf8') > MAX_MCP_PROTOCOL_MESSAGE_BYTES
  ) {
    throw new Error(
      `MCP ${label} exceeds ${MAX_MCP_PROTOCOL_MESSAGE_BYTES} serialized bytes`,
    );
  }
}

function assertBoundedMcpSchema(schema: object, toolName: string): void {
  const stack: { value: unknown; depth: number }[] = [
    { value: schema, depth: 1 },
  ];
  const visited = new Set<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    nodes += 1;
    if (nodes > MAX_MCP_SCHEMA_NODES) {
      throw new Error(
        `MCP tool '${toolName}' schema exceeds ${MAX_MCP_SCHEMA_NODES} nodes`,
      );
    }
    if (current.depth > MAX_MCP_SCHEMA_DEPTH) {
      throw new Error(
        `MCP tool '${toolName}' schema exceeds depth ${MAX_MCP_SCHEMA_DEPTH}`,
      );
    }
    if (typeof current.value !== 'object' || current.value === null) continue;
    if (visited.has(current.value)) {
      throw new Error(`MCP tool '${toolName}' schema contains a cycle`);
    }
    visited.add(current.value);
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ value: children[index], depth: current.depth + 1 });
    }
  }
}

export async function listAllMcpTools(
  client: Client,
  options: McpRuntimeRequestOptions = {},
): Promise<McpToolCatalog> {
  const tools: Tool[] = [];
  const names = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  let metadataBytes = 2;
  let hasMore = true;

  while (hasMore) {
    if (pages >= MAX_MCP_TOOL_PAGES) {
      throw new Error(
        `MCP tool catalog exceeds ${MAX_MCP_TOOL_PAGES} pages`,
      );
    }
    const page = await client.listTools(
      cursor === undefined ? undefined : { cursor },
      options,
    );
    assertBoundedMcpProtocolValue(page, 'tools/list page');
    pages += 1;
    for (const tool of page.tools) {
      if (names.has(tool.name)) {
        throw new Error(`MCP tool catalog contains duplicate tool '${tool.name}'`);
      }
      if (tools.length >= MAX_MCP_TOOLS) {
        throw new Error(
          `MCP tool catalog exceeds ${MAX_MCP_TOOLS} tools`,
        );
      }
      assertBoundedMcpSchema(tool.inputSchema, tool.name);
      if (tool.outputSchema) assertBoundedMcpSchema(tool.outputSchema, tool.name);
      const serialized = JSON.stringify(tool);
      const candidateBytes =
        metadataBytes +
        (tools.length === 0 ? 0 : 1) +
        Buffer.byteLength(serialized, 'utf8');
      if (candidateBytes > MAX_MCP_TOOL_METADATA_BYTES) {
        throw new Error(
          `MCP tool catalog exceeds ${MAX_MCP_TOOL_METADATA_BYTES} serialized bytes`,
        );
      }
      metadataBytes = candidateBytes;
      names.add(tool.name);
      tools.push(tool);
    }

    const nextCursor = page.nextCursor;
    if (nextCursor === undefined) {
      hasMore = false;
      continue;
    }
    if (cursors.has(nextCursor)) {
      throw new Error(`MCP tool catalog repeated cursor '${nextCursor}'`);
    }
    cursors.add(nextCursor);
    cursor = nextCursor;
  }

  return tools;
}

export function findMcpTool(
  catalog: McpToolCatalog,
  toolName: string,
): Tool {
  const tool = catalog.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`MCP tool '${toolName}' was not found`);
  return tool;
}

export async function callMcpTool(
  client: Client,
  catalog: McpToolCatalog,
  toolName: string,
  args: Record<string, unknown>,
  options: McpRuntimeRequestOptions = {},
): Promise<CompatibilityCallToolResult> {
  const tool = findMcpTool(catalog, toolName);
  if (tool.execution?.taskSupport === 'required') {
    throw new Error(
      `MCP tool '${toolName}' requires task-based execution and cannot be called synchronously`,
    );
  }
  const result = await client.callTool(
    { name: tool.name, arguments: args },
    undefined,
    options,
  );
  assertBoundedMcpProtocolValue(result, 'tools/call result');
  return result;
}

class ObservedStdioClientTransport extends StdioClientTransport {
  started = false;

  override async start(): Promise<void> {
    await super.start();
    this.started = true;
  }
}

function destinationDisplay(destination: McpDestination): string {
  if (destination.kind === 'project') return 'workspace.yaml';
  if (destination.kind === 'user') return 'the user workspace';
  return `profile '${destination.name}'`;
}

function reauthorizationCommand(
  destination: McpDestination,
  serverName: string,
): string {
  if (destination.kind === 'user') {
    return `allagents mcp reauth ${serverName} --scope user`;
  }
  if (destination.kind === 'profile') {
    return `allagents mcp reauth ${serverName} --profile ${destination.name}`;
  }
  return `allagents mcp reauth ${serverName}`;
}

interface ResolvedMcpEnvironment {
  values: Record<string, string>;
  credentialValues: Set<string>;
}

function resolveEnvironmentReferences(
  configured: Record<string, string>,
  environment: NodeJS.ProcessEnv,
): ResolvedMcpEnvironment {
  const credentialValues = new Set<string>();
  const values = Object.fromEntries(
    Object.entries(configured).map(([key, value]) => {
      const reference = ENVIRONMENT_REFERENCE.exec(value);
      if (!reference) return [key, value];
      const variable = reference[1] as string;
      const resolved = environment[variable];
      if (resolved === undefined) {
        throw new Error(
          `MCP environment '${key}' references missing environment variable '${variable}'`,
        );
      }
      credentialValues.add(resolved);
      return [key, resolved];
    }),
  );
  return { values, credentialValues };
}

function rejectArgumentReferences(args: readonly string[]): void {
  for (const [index, argument] of args.entries()) {
    const reference = ENVIRONMENT_REFERENCE.exec(argument);
    if (reference) {
      throw new Error(
        `MCP argument ${index + 1} is an environment reference; pass credentials through the server environment instead`,
      );
    }
  }
}

async function waitForExit(
  exited: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  let settled = false;
  const finish = (observed: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    resolve(observed);
  };
  const timeout = setTimeout(() => finish(false), timeoutMs);
  void exited.then(() => finish(true));
  return promise;
}


async function connectStdioSession(
  config: Extract<McpServerConfig, { command: string }>,
  options: ManagedMcpConnectionOptions,
): Promise<ManagedMcpSession> {
  const args = config.args ?? [];
  rejectArgumentReferences(args);
  const resolvedEnvironment = resolveEnvironmentReferences(
    config.env ?? {},
    options.environment ?? process.env,
  );
  const credentialGuard = createMcpCredentialGuard(
    resolvedEnvironment.credentialValues,
  );
  const transport = new ObservedStdioClientTransport({
    command: config.command,
    args,
    env: resolvedEnvironment.values,
    stderr: 'pipe',
  });
  // Keep child diagnostics from reaching the parent and retain no unbounded copy.
  transport.stderr?.on('data', () => undefined);

  const { promise: exited, resolve: resolveExited } =
    Promise.withResolvers<void>();
  let exitObserved = false;
  transport.onclose = () => {
    exitObserved = true;
    resolveExited();
  };
  const client = new Client(
    { name: 'AllAgents', version: '1.0.0' },
    { capabilities: {} },
  );
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      let closeError: Error | undefined;
      try {
        await client.close();
      } catch (error) {
        closeError = credentialGuard.sanitizeError(error);
      }
      if (transport.started && !exitObserved) {
        const timeoutMs =
          options.stdioExitTimeoutMs ?? DEFAULT_STDIO_EXIT_TIMEOUT_MS;
        if (!(await waitForExit(exited, timeoutMs))) {
          const exitError = new Error(
            `MCP stdio child did not exit within ${timeoutMs}ms after close`,
          );
          if (closeError) {
            throw new AggregateError(
              [closeError, exitError],
              'MCP stdio close failed and child exit was not observed',
            );
          }
          throw exitError;
        }
      }
      if (closeError) throw closeError;
    })();
    return closePromise;
  };

  try {
    await client.connect(transport);
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [
          credentialGuard.sanitizeError(error),
          credentialGuard.sanitizeError(cleanupError),
        ],
        'MCP stdio connection failed and its child could not be closed',
      );
    }
    throw credentialGuard.sanitizeError(error);
  }
  return { client, credentialGuard, close };
}

export async function resolveConfiguredMcpServer(
  destination: McpDestination,
  serverName: string,
): Promise<McpServerConfig> {
  const config = await getMcpServer(destination, serverName);
  if (!config) {
    throw new Error(
      `MCP server '${serverName}' is not defined in ${destinationDisplay(destination)}`,
    );
  }
  return config;
}

export async function connectManagedMcpServer(
  destination: McpDestination,
  serverName: string,
  options: ManagedMcpConnectionOptions = {},
): Promise<ManagedMcpSession> {
  const config = await resolveConfiguredMcpServer(destination, serverName);
  if ('command' in config) return connectStdioSession(config, options);

  try {
    const connection = await connectMcpHttpClient(config.url, {
      headers: config.headers ?? {},
      allowAuthorization: false,
      maxResponseBytes: MAX_MCP_PROTOCOL_MESSAGE_BYTES,
      ...(destination.kind === 'profile'
        ? { profile: destination.name }
        : {}),
      ...(options.environment === undefined
        ? {}
        : { environment: options.environment }),
    });
    let closePromise: Promise<void> | undefined;
    return {
      client: connection.client,
      credentialGuard: connection.credentialGuard,
      close() {
        closePromise ??= (async () => {
          const timeoutMs =
            options.httpCleanupTimeoutMs ?? DEFAULT_HTTP_CLEANUP_TIMEOUT_MS;
          const termination = connection.transport
            .terminateSession()
            .then<Error | undefined>(() => undefined)
            .catch((error) => connection.credentialGuard.sanitizeError(error));
          const { promise: deadline, resolve: resolveDeadline } =
            Promise.withResolvers<Error>();
          const timeout = setTimeout(
            () =>
              resolveDeadline(
                new Error(
                  `Timed out terminating MCP HTTP session after ${timeoutMs}ms`,
                ),
              ),
            timeoutMs,
          );
          const terminationError = await Promise.race([
            termination,
            deadline,
          ]);
          clearTimeout(timeout);
          let closeError: Error | undefined;
          try {
            await connection.close();
          } catch (error) {
            closeError = connection.credentialGuard.sanitizeError(error);
          }
          if (terminationError && closeError) {
            throw new AggregateError(
              [terminationError, closeError],
              'MCP HTTP session termination and close both failed',
            );
          }
          if (terminationError) throw terminationError;
          if (closeError) throw closeError;
        })();
        return closePromise;
      },
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'OAuth authorization requires an interactive terminal'
    ) {
      throw new McpRuntimeAuthorizationError(
        reauthorizationCommand(destination, serverName),
      );
    }
    throw error;
  }
}

export async function runManagedMcpSession<T>(
  session: ManagedMcpSession,
  operation: ManagedMcpOperation<T>,
  options: Pick<ManagedMcpOperationOptions, 'signal' | 'timeoutMs'> = {},
): Promise<ManagedMcpOperationResult<T>> {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const { promise: cancellation, reject: rejectCancellation } =
    Promise.withResolvers<never>();
  const cancel = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    rejectCancellation(new McpRuntimeCancelledError());
  };
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener('abort', cancel, { once: true });
  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined) {
    timeout = setTimeout(() => {
      if (controller.signal.aborted) return;
      controller.abort();
      rejectCancellation(new McpRuntimeTimeoutError(timeoutMs));
    }, timeoutMs);
  }

  let operationOutcome: ManagedMcpOperationOutcome<T>;
  try {
    const pendingOperation = controller.signal.aborted
      ? cancellation
      : operation({ client: session.client, signal: controller.signal });
    const value = await Promise.race([pendingOperation, cancellation]);
    session.credentialGuard.assertSafe(value);
    operationOutcome = { status: 'fulfilled', value };
  } catch (error) {
    operationOutcome = {
      status: 'rejected',
      error: session.credentialGuard.sanitizeError(error),
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', cancel);
  }

  let cleanupOutcome: ManagedMcpCleanupOutcome;
  try {
    await session.close();
    cleanupOutcome = { status: 'fulfilled' };
  } catch (error) {
    cleanupOutcome = {
      status: 'rejected',
      error: session.credentialGuard.sanitizeError(error),
    };
  }
  return { operation: operationOutcome, cleanup: cleanupOutcome };
}

export async function runManagedMcpOperation<T>(
  destination: McpDestination,
  serverName: string,
  operation: ManagedMcpOperation<T>,
  options: ManagedMcpOperationOptions = {},
): Promise<ManagedMcpOperationResult<T>> {
  const session = await connectManagedMcpServer(
    destination,
    serverName,
    options,
  );
  return runManagedMcpSession(session, operation, options);
}
