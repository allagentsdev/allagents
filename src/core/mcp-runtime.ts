import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  ErrorCode,
  McpError,
  type CompatibilityCallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { McpServerConfig } from '../models/workspace-config.js';
import {
  connectMcpHttpClient,
  createMcpCredentialGuard,
  isMcpAuthorizationFailure,
  type McpCredentialGuard,
} from './mcp-http-client.js';
import { LinearStdioClientTransport } from './mcp-stdio-client-transport.js';
import {
  formatMcpDestination,
  getMcpServer,
  type McpDestination,
} from './mcp-servers.js';

const ENVIRONMENT_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const DEFAULT_HTTP_CLEANUP_TIMEOUT_MS = 2_000;
const DEFAULT_STDIO_EXIT_TIMEOUT_MS = 1_000;
const MAX_MCP_TOOL_PAGES = 100;
const MAX_MCP_TOOLS = 10_000;
const MAX_MCP_PROTOCOL_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_MCP_PROTOCOL_WIRE_BYTES = MAX_MCP_PROTOCOL_MESSAGE_BYTES + 64 * 1024;
const MAX_MCP_TOOL_METADATA_BYTES = MAX_MCP_PROTOCOL_MESSAGE_BYTES;
const MAX_MCP_SCHEMA_DEPTH = 64;
const MAX_MCP_SCHEMA_NODES = 100_000;
const MCP_JSON_SCHEMA_VALIDATOR = new AjvJsonSchemaValidator();

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
  signal?: AbortSignal;
}

export interface ManagedMcpOperationOptions
  extends ManagedMcpConnectionOptions {
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

function assertBoundedMcpProtocolValue(value: unknown, label: string): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error(`MCP ${label} could not be serialized`);
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_MCP_PROTOCOL_MESSAGE_BYTES) {
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
  const cursorHashes = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  let metadataBytes = 2;
  let hasMore = true;

  while (hasMore) {
    if (pages >= MAX_MCP_TOOL_PAGES) {
      throw new Error(`MCP tool catalog exceeds ${MAX_MCP_TOOL_PAGES} pages`);
    }
    const page = await client.listTools(
      cursor === undefined ? undefined : { cursor },
      options,
    );
    assertBoundedMcpProtocolValue(page, 'tools/list page');
    pages += 1;
    for (const tool of page.tools) {
      if (names.has(tool.name)) {
        throw new Error(
          `MCP tool catalog contains duplicate tool '${tool.name}'`,
        );
      }
      if (tools.length >= MAX_MCP_TOOLS) {
        throw new Error(`MCP tool catalog exceeds ${MAX_MCP_TOOLS} tools`);
      }
      assertBoundedMcpSchema(tool.inputSchema, tool.name);
      if (tool.outputSchema)
        assertBoundedMcpSchema(tool.outputSchema, tool.name);
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
    const cursorHash = createHash('sha256').update(nextCursor).digest('hex');
    if (cursorHashes.has(cursorHash)) {
      throw new Error('MCP tool catalog repeated a pagination cursor');
    }
    const candidateBytes =
      metadataBytes + Buffer.byteLength(nextCursor, 'utf8');
    if (candidateBytes > MAX_MCP_TOOL_METADATA_BYTES) {
      throw new Error(
        `MCP tool catalog exceeds ${MAX_MCP_TOOL_METADATA_BYTES} serialized bytes`,
      );
    }
    metadataBytes = candidateBytes;
    cursorHashes.add(cursorHash);
    cursor = nextCursor;
  }

  return tools;
}

export function findMcpTool(catalog: McpToolCatalog, toolName: string): Tool {
  const tool = catalog.find((candidate) => candidate.name === toolName);
  if (!tool) throw new Error(`MCP tool '${toolName}' was not found`);
  return tool;
}

export async function callMcpTool(
  client: Client,
  tool: Tool,
  args: Record<string, unknown>,
  options: McpRuntimeRequestOptions = {},
): Promise<CompatibilityCallToolResult> {
  if (tool.execution?.taskSupport === 'required') {
    throw new Error(
      `MCP tool '${tool.name}' requires task-based execution and cannot be called synchronously`,
    );
  }
  const result = await client.callTool(
    { name: tool.name, arguments: args },
    undefined,
    options,
  );
  assertBoundedMcpProtocolValue(result, 'tools/call result');
  if (tool.outputSchema) {
    const structuredContent =
      'structuredContent' in result ? result.structuredContent : undefined;
    const isError = 'isError' in result && result.isError === true;
    if (structuredContent === undefined && !isError) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Tool ${tool.name} has an output schema but did not return structured content`,
      );
    }
    if (structuredContent !== undefined) {
      try {
        const validation = MCP_JSON_SCHEMA_VALIDATOR.getValidator(
          tool.outputSchema as JsonSchemaType,
        )(structuredContent);
        if (!validation.valid) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Structured content does not match the tool's output schema: ${validation.errorMessage}`,
          );
        }
      } catch (error) {
        if (error instanceof McpError) throw error;
        throw new McpError(
          ErrorCode.InvalidParams,
          `Failed to validate structured content: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return result;
}

function shellQuoteIdentity(value: string): string {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function reauthorizationCommand(
  destination: McpDestination,
  serverName: string,
): string {
  const args = ['allagents', 'mcp', 'reauth'];
  if (destination.kind === 'user') {
    args.push('--scope', 'user');
  } else if (destination.kind === 'profile') {
    args.push('--profile', shellQuoteIdentity(destination.name));
  }
  if (serverName.startsWith('-')) args.push('--');
  args.push(shellQuoteIdentity(serverName));
  return args.join(' ');
}

function runtimeCredentialGuard(
  credentialGuard: McpCredentialGuard,
  destination: McpDestination,
  serverName: string,
): McpCredentialGuard {
  return {
    assertSafe(value) {
      credentialGuard.assertSafe(value);
    },
    sanitizeError(error) {
      const authorizationFailure = isMcpAuthorizationFailure(error);
      const sanitized = credentialGuard.sanitizeError(error);
      return authorizationFailure
        ? new McpRuntimeAuthorizationError(
            reauthorizationCommand(destination, serverName),
          )
        : sanitized;
    },
  };
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
  const transport = new LinearStdioClientTransport({
    command: config.command,
    args,
    env: resolvedEnvironment.values,
    stderr: 'pipe',
    maxBufferSize: MAX_MCP_PROTOCOL_WIRE_BYTES,
  });
  // Keep child diagnostics from reaching the parent and retain no unbounded copy.
  transport.stderr?.on('data', () => undefined);

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
      if (transport.started) {
        const timeoutMs =
          options.stdioExitTimeoutMs ?? DEFAULT_STDIO_EXIT_TIMEOUT_MS;
        if (!(await waitForExit(transport.exited, timeoutMs))) {
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
    await client.connect(
      transport,
      options.signal === undefined ? undefined : { signal: options.signal },
    );
  } catch (error) {
    const startupError = options.signal?.aborted
      ? new McpRuntimeCancelledError()
      : credentialGuard.sanitizeError(error);
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, credentialGuard.sanitizeError(cleanupError)],
        'MCP stdio connection failed and its child could not be closed',
      );
    }
    throw startupError;
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
      `MCP server '${serverName}' is not defined in ${formatMcpDestination(destination)}`,
    );
  }
  return config;
}

export async function connectManagedMcpServer(
  destination: McpDestination,
  serverName: string,
  options: ManagedMcpConnectionOptions = {},
): Promise<ManagedMcpSession> {
  if (options.signal?.aborted) throw new McpRuntimeCancelledError();
  const config = await resolveConfiguredMcpServer(destination, serverName);
  if (options.signal?.aborted) throw new McpRuntimeCancelledError();
  if ('command' in config) return connectStdioSession(config, options);

  try {
    const connection = await connectMcpHttpClient(config.url, {
      headers: config.headers ?? {},
      allowAuthorization: false,
      maxResponseBytes: MAX_MCP_PROTOCOL_WIRE_BYTES,
      ...(destination.kind === 'profile' ? { profile: destination.name } : {}),
      ...(options.environment === undefined
        ? {}
        : { environment: options.environment }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const credentialGuard = runtimeCredentialGuard(
      connection.credentialGuard,
      destination,
      serverName,
    );
    let closePromise: Promise<void> | undefined;
    return {
      client: connection.client,
      credentialGuard,
      close() {
        closePromise ??= (async () => {
          const timeoutMs =
            options.httpCleanupTimeoutMs ?? DEFAULT_HTTP_CLEANUP_TIMEOUT_MS;
          const termination = connection.transport
            .terminateSession()
            .then<Error | undefined>(() => undefined)
            .catch((error) => credentialGuard.sanitizeError(error));
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
          const terminationError = await Promise.race([termination, deadline]);
          clearTimeout(timeout);
          let closeError: Error | undefined;
          try {
            await connection.close();
          } catch (error) {
            closeError = credentialGuard.sanitizeError(error);
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
    if (options.signal?.aborted) throw new McpRuntimeCancelledError();
    if (isMcpAuthorizationFailure(error)) {
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
