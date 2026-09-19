import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
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

function resolveEnvironmentReferences(
  configured: Record<string, string>,
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
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
      return [key, resolved];
    }),
  );
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
  const environment = resolveEnvironmentReferences(
    config.env ?? {},
    options.environment ?? process.env,
  );
  const credentialGuard = createMcpCredentialGuard(Object.values(environment));
  const transport = new ObservedStdioClientTransport({
    command: config.command,
    args,
    env: environment,
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
