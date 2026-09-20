import { existsSync, mkdirSync, readFileSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MCP_STDIO_SECRET_SENTINEL =
  'MCP_STDIO_RAW_SECRET_SENTINEL=fixture-secret-that-must-not-leak';
export const MCP_STDIO_PRIMITIVE_TOOL = 'primitive_echo';
export const MCP_STDIO_COMPLEX_TOOL = 'complex_echo';
export const MCP_STDIO_FAILURE_TOOL = 'structured_failure';

export interface McpStdioCaptureRecord {
  kind: 'list' | 'call';
  cursor?: string | null;
  name?: string;
  arguments?: Record<string, unknown>;
}

export interface McpStdioEnvironmentRecord {
  pid: number;
  values: Record<string, string | null>;
}

export interface McpStdioExitRecord {
  pid: number;
  code: number;
}

export interface McpRuntimeStdioFixture {
  serverPath: string;
  capturePath: string;
  environmentPath: string;
  exitPath: string;
  parentEnvironment: Record<string, string>;
  serverConfig(options?: {
    args?: string[];
  }): {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
  captures(): McpStdioCaptureRecord[];
  environments(): McpStdioEnvironmentRecord[];
  exits(): McpStdioExitRecord[];
  waitForCaptures(count: number): Promise<McpStdioCaptureRecord[]>;
  waitForExits(count: number): Promise<McpStdioExitRecord[]>;
}

function readJsonLines<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function waitForJsonLines<T>(path: string, count: number): Promise<T[]> {
  const current = readJsonLines<T>(path);
  if (current.length >= count) return Promise.resolve(current);

  const { promise, resolve } = Promise.withResolvers<T[]>();
  let settled = false;
  const watcher = watch(dirname(path), { persistent: false }, () => {
    const records = readJsonLines<T>(path);
    if (records.length < count || settled) return;
    settled = true;
    watcher.close();
    resolve(records);
  });
  const records = readJsonLines<T>(path);
  if (records.length >= count && !settled) {
    settled = true;
    watcher.close();
    resolve(records);
  }
  return promise;
}

export function createMcpRuntimeStdioFixture(
  root: string,
): McpRuntimeStdioFixture {
  mkdirSync(root, { recursive: true });
  const serverPath = fileURLToPath(
    new URL('./mcp-runtime-stdio-server.mjs', import.meta.url),
  );
  const capturePath = join(root, 'requests.ndjson');
  const environmentPath = join(root, 'environment.ndjson');
  const exitPath = join(root, 'exits.ndjson');

  return {
    serverPath,
    capturePath,
    environmentPath,
    exitPath,
    parentEnvironment: {
      MCP_FIXTURE_CAPTURE_PATH: capturePath,
      MCP_FIXTURE_ENVIRONMENT_PATH: environmentPath,
      MCP_FIXTURE_EXIT_PATH: exitPath,
      MCP_FIXTURE_ENVIRONMENT_KEYS:
        'RESOLVED_SECRET,LITERAL_VALUE,UNSAFE_PARENT',
      MCP_RUNTIME_SOURCE_SECRET: 'resolved-secret',
      MCP_FIXTURE_LITERAL_VALUE: 'fixture-literal',
    },
    serverConfig(options = {}) {
      return {
        command: Bun.which('node') ?? 'node',
        args: options.args ?? [serverPath],
        env: {
          MCP_STDIO_CAPTURE_PATH: '${MCP_FIXTURE_CAPTURE_PATH}',
          MCP_STDIO_ENVIRONMENT_PATH: '${MCP_FIXTURE_ENVIRONMENT_PATH}',
          MCP_STDIO_EXIT_PATH: '${MCP_FIXTURE_EXIT_PATH}',
          MCP_STDIO_ENVIRONMENT_KEYS: '${MCP_FIXTURE_ENVIRONMENT_KEYS}',
          RESOLVED_SECRET: '${MCP_RUNTIME_SOURCE_SECRET}',
          LITERAL_VALUE: '${MCP_FIXTURE_LITERAL_VALUE}',
        },
      };
    },
    captures: () => readJsonLines<McpStdioCaptureRecord>(capturePath),
    environments: () =>
      readJsonLines<McpStdioEnvironmentRecord>(environmentPath),
    exits: () => readJsonLines<McpStdioExitRecord>(exitPath),
    waitForCaptures: (count) =>
      waitForJsonLines<McpStdioCaptureRecord>(capturePath, count),
    waitForExits: (count) =>
      waitForJsonLines<McpStdioExitRecord>(exitPath, count),
  };
}
