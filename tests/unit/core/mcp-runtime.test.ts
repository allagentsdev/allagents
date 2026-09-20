import { afterEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
} from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InvalidGrantError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createMcpCredentialGuard } from '../../../src/core/mcp-http-client.js';
import {
  callMcpTool,
  connectManagedMcpServer,
  findMcpTool,
  listAllMcpTools,
  McpRuntimeAuthorizationError,
  McpRuntimeCancelledError,
  resolveConfiguredMcpServer,
  runManagedMcpSession,
  type ManagedMcpSession,
} from '../../../src/core/mcp-runtime.js';
import type { McpDestination } from '../../../src/core/mcp-servers.js';

const directories: string[] = [];
const servers: HttpServer[] = [];

function makeProjectDestination(mcpYaml: string): McpDestination {
  const workspacePath = join(
    tmpdir(),
    `mcp-runtime-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const configPath = join(workspacePath, '.allagents', 'workspace.yaml');
  mkdirSync(join(workspacePath, '.allagents'), { recursive: true });
  writeFileSync(
    configPath,
    `repositories: []\nplugins: []\nclients:\n  - claude\nmcpServers:\n${mcpYaml}`,
    'utf8',
  );
  directories.push(workspacePath);
  return { kind: 'project', workspacePath, configPath };
}

function makeUserDestination(mcpYaml: string): McpDestination {
  const homePath = join(
    tmpdir(),
    `mcp-runtime-user-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const configPath = join(homePath, '.allagents', 'workspace.yaml');
  mkdirSync(join(homePath, '.allagents'), { recursive: true });
  writeFileSync(
    configPath,
    `repositories: []\nplugins: []\nclients: []\nmcpServers:\n${mcpYaml}`,
    'utf8',
  );
  directories.push(homePath);
  return { kind: 'user', configPath };
}

function makeInlineStdioDestination(script: string): McpDestination {
  const indentedScript = script
    .split('\n')
    .map((line) => `        ${line}`)
    .join('\n');
  return makeProjectDestination(
    `  local:\n    command: ${JSON.stringify(process.execPath)}\n    args:\n      - -e\n      - |\n${indentedScript}\n`,
  );
}

async function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return;
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const watcher = watch(dirname(path), { persistent: false }, () => {
    if (!existsSync(path)) return;
    watcher.close();
    resolve();
  });
  watcher.once('error', (error) => {
    watcher.close();
    reject(error);
  });
  if (existsSync(path)) {
    watcher.close();
    resolve();
  }
  return promise;
}

function createStatelessRuntimeServer(): HttpServer {
  const server = createServer(async (request, response) => {
    if (request.method === 'GET') {
      response.statusCode = 405;
      response.end();
      return;
    }
    if (request.method === 'DELETE') {
      response.statusCode = 200;
      response.end();
      return;
    }
    const message = JSON.parse(await readRequestBody(request)) as {
      id?: string | number;
      method: string;
      params?: { protocolVersion?: string };
    };
    if (message.method === 'initialize') {
      response.writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': 'runtime-auth-session',
      });
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: {
            protocolVersion: message.params?.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'runtime-test', version: '0.0.0' },
          },
        }),
      );
      return;
    }
    response.statusCode = 202;
    response.end();
  });
  servers.push(server);
  return server;
}

function readRequestBody(request: IncomingMessage): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const chunks: Buffer[] = [];
  request.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  request.on('error', reject);
  return promise;
}

async function listen(server: HttpServer): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      reject(new Error('HTTP fixture did not expose a TCP port'));
      return;
    }
    resolve(address.port);
  });
  return promise;
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('configured MCP resolution', () => {
  test('reads only the named inline declaration from the selected destination', async () => {
    const destination = makeProjectDestination(
      `  direct:\n    url: https://mcp.example/rpc\n    headers:\n      X-Token: \${TOKEN}\n`,
    );

    expect(await resolveConfiguredMcpServer(destination, 'direct')).toEqual({
      url: 'https://mcp.example/rpc',
      headers: { 'X-Token': '${TOKEN}' },
    });
    await expect(
      resolveConfiguredMcpServer(destination, 'missing'),
    ).rejects.toThrow("MCP server 'missing' is not defined in workspace.yaml");
  });

  test('rejects exact argument references before resolving environment or spawning', async () => {
    const destination = makeProjectDestination(
      `  local:\n    command: definitely-not-an-installed-command\n    args:\n      - \${ARG_SECRET}\n    env:\n      CHILD_SECRET: \${MISSING_SECRET}\n`,
    );

    await expect(
      connectManagedMcpServer(destination, 'local', { environment: {} }),
    ).rejects.toThrow(
      'MCP argument 1 is an environment reference; pass credentials through the server environment instead',
    );
  });

  test('fails a missing environment reference before spawning the child', async () => {
    const destination = makeProjectDestination(
      `  local:\n    command: definitely-not-an-installed-command\n    args:\n      - literal\n    env:\n      CHILD_SECRET: \${MISSING_SECRET}\n`,
    );

    await expect(
      connectManagedMcpServer(destination, 'local', { environment: {} }),
    ).rejects.toThrow(
      "MCP environment 'CHILD_SECRET' references missing environment variable 'MISSING_SECRET'",
    );
  });
  test('spawns stdio directly with resolved env and only the safe inherited baseline', async () => {
    const script = `
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
const server = new Server(
  {
    name: JSON.stringify({
      configured: process.env.CHILD_SECRET,
      unsafe: process.env.ALLAGENTS_UNSAFE_PARENT,
      inheritedHome: process.env.HOME,
    }),
    version: '0.0.0',
  },
  { capabilities: {} },
);
await server.connect(new StdioServerTransport());
`.trim();
    const indentedScript = script
      .split('\n')
      .map((line) => `        ${line}`)
      .join('\n');
    const destination = makeProjectDestination(
      `  local:\n    command: ${JSON.stringify(process.execPath)}\n    args:\n      - -e\n      - |\n${indentedScript}\n    env:\n      CHILD_SECRET: \${SOURCE_SECRET}\n`,
    );
    const originalUnsafe = process.env.ALLAGENTS_UNSAFE_PARENT;
    process.env.ALLAGENTS_UNSAFE_PARENT = 'must-not-be-inherited';
    let session: ManagedMcpSession | undefined;
    try {
      session = await connectManagedMcpServer(destination, 'local', {
        environment: { SOURCE_SECRET: 'resolved-secret' },
      });
      const serverInfo = session.client.getServerVersion();
      expect(serverInfo).toBeDefined();
      expect(JSON.parse(serverInfo?.name ?? '{}')).toEqual({
        configured: 'resolved-secret',
        inheritedHome: process.env.HOME,
      });
    } finally {
      await session?.close();
      if (originalUnsafe === undefined) {
        delete process.env.ALLAGENTS_UNSAFE_PARENT;
      } else {
        process.env.ALLAGENTS_UNSAFE_PARENT = originalUnsafe;
      }
    }
  });

  test('accepts a 16 MiB parsed result through the bounded stdio wire frame', async () => {
    const script = `
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server(
  { name: 'large-result', version: '0.0.0' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'large', inputSchema: { type: 'object' } }],
}));
server.setRequestHandler(CallToolRequestSchema, async () => {
  const base = { content: [], padding: '' };
  const budget = 16 * 1024 * 1024;
  return {
    ...base,
    padding: 'x'.repeat(budget - Buffer.byteLength(JSON.stringify(base), 'utf8')),
  };
});
await server.connect(new StdioServerTransport());
`.trim();
    const destination = makeInlineStdioDestination(script);
    const session = await connectManagedMcpServer(destination, 'local');

    try {
      const catalog = await listAllMcpTools(session.client);
      const result = await callMcpTool(
        session.client,
        findMcpTool(catalog, 'large'),
        {},
      );
      expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBe(
        16 * 1024 * 1024,
      );
    } finally {
      await session.close();
    }
  }, 15_000);


  test('accepts a 16 MiB parsed result through the bounded HTTP wire response', async () => {
    const baseResult = { content: [], padding: '' };
    const largeResult = {
      ...baseResult,
      padding: 'x'.repeat(
        16 * 1024 * 1024 -
          Buffer.byteLength(JSON.stringify(baseResult), 'utf8'),
      ),
    };
    const server = createServer(async (request, response) => {
      if (request.method === 'GET') {
        response.statusCode = 405;
        response.end();
        return;
      }
      if (request.method === 'DELETE') {
        response.statusCode = 200;
        response.end();
        return;
      }
      const message = JSON.parse(await readRequestBody(request)) as {
        id?: string | number;
        method: string;
        params?: { protocolVersion?: string };
      };
      if (message.id === undefined) {
        response.statusCode = 202;
        response.end();
        return;
      }
      const result =
        message.method === 'initialize'
          ? {
              protocolVersion: message.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: 'runtime-test', version: '0.0.0' },
            }
          : message.method === 'tools/list'
            ? {
                tools: [
                  { name: 'large', inputSchema: { type: 'object' as const } },
                ],
              }
            : largeResult;
      response.writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': 'runtime-large-session',
      });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
    servers.push(server);
    const port = await listen(server);
    const destination = makeProjectDestination(
      `  direct:\n    url: http://127.0.0.1:${port}/mcp\n`,
    );
    const session = await connectManagedMcpServer(destination, 'direct');

    try {
      const catalog = await listAllMcpTools(session.client);
      const result = await callMcpTool(
        session.client,
        findMcpTool(catalog, 'large'),
        {},
      );
      expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBe(
        16 * 1024 * 1024,
      );
    } finally {
      await session.close();
    }
  }, 15_000);
  test('cancels stdio initialization and observes the spawned child exit', async () => {
    const markerRoot = join(
      tmpdir(),
      `mcp-runtime-cancel-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(markerRoot, { recursive: true });
    directories.push(markerRoot);
    const startedPath = join(markerRoot, 'started');
    const exitedPath = join(markerRoot, 'exited');
    const script = `
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
writeFileSync(${JSON.stringify(startedPath)}, String(process.pid));
createServer().listen(0, '127.0.0.1');
process.once('SIGTERM', () => {
  writeFileSync(${JSON.stringify(exitedPath)}, 'observed');
  process.exit(0);
});
`.trim();
    const destination = makeInlineStdioDestination(script);
    const controller = new AbortController();
    const connection = connectManagedMcpServer(destination, 'local', {
      signal: controller.signal,
    });
    await waitForFile(startedPath);

    controller.abort();

    await expect(connection).rejects.toBeInstanceOf(McpRuntimeCancelledError);
    expect(readFileSync(exitedPath, 'utf8')).toBe('observed');
    const childPid = Number.parseInt(readFileSync(startedPath, 'utf8'), 10);
    expect(() => process.kill(childPid, 0)).toThrow();
  }, 10_000);

  test('normalizes HTTP initialization cancellation and closes the request', async () => {
    const sawInitialize = Promise.withResolvers<void>();
    const sawRequestClose = Promise.withResolvers<void>();
    const server = createServer(async (request, response) => {
      if (request.method === 'GET') {
        response.statusCode = 405;
        response.end();
        return;
      }
      const message = JSON.parse(await readRequestBody(request)) as {
        method: string;
      };
      if (message.method !== 'initialize') {
        response.statusCode = 202;
        response.end();
        return;
      }
      response.once('close', () => sawRequestClose.resolve());
      sawInitialize.resolve();
    });
    servers.push(server);
    const port = await listen(server);
    const destination = makeProjectDestination(
      `  direct:\n    url: http://127.0.0.1:${port}/mcp\n`,
    );
    const controller = new AbortController();
    const connection = connectManagedMcpServer(destination, 'direct', {
      signal: controller.signal,
    });
    await sawInitialize.promise;

    controller.abort();

    await expect(connection).rejects.toBeInstanceOf(McpRuntimeCancelledError);
    await sawRequestClose.promise;
  });
});


describe('finite managed lifecycle', () => {
  test('retains a successful operation when cleanup fails and closes exactly once', async () => {
    let closeCalls = 0;
    const session: ManagedMcpSession = {
      client: new Client(
        { name: 'runtime-test', version: '0.0.0' },
        { capabilities: {} },
      ),
      credentialGuard: createMcpCredentialGuard([]),
      async close() {
        closeCalls += 1;
        throw new Error('cleanup failed');
      },
    };

    const result = await runManagedMcpSession(session, async () => ({ ok: true }));

    expect(result.operation).toEqual({
      status: 'fulfilled',
      value: { ok: true },
    });
    expect(result.cleanup.status).toBe('rejected');
    if (result.cleanup.status === 'rejected') {
      expect(result.cleanup.error.message).toBe('cleanup failed');
    }
    expect(closeCalls).toBe(1);
  });

  test('retains operation failure separately from successful cleanup', async () => {
    let closeCalls = 0;
    const session: ManagedMcpSession = {
      client: new Client(
        { name: 'runtime-test', version: '0.0.0' },
        { capabilities: {} },
      ),
      credentialGuard: createMcpCredentialGuard([]),
      async close() {
        closeCalls += 1;
      },
    };

    const result = await runManagedMcpSession(session, async () => {
      throw new Error('operation failed');
    });

    expect(result.operation.status).toBe('rejected');
    if (result.operation.status === 'rejected') {
      expect(result.operation.error.message).toBe('operation failed');
    }
    expect(result.cleanup).toEqual({ status: 'fulfilled' });
    expect(closeCalls).toBe(1);
  });

  test('cancels before invocation and still cleans up exactly once', async () => {
    let invoked = false;
    let closeCalls = 0;
    const controller = new AbortController();
    controller.abort();
    const session: ManagedMcpSession = {
      client: new Client(
        { name: 'runtime-test', version: '0.0.0' },
        { capabilities: {} },
      ),
      credentialGuard: createMcpCredentialGuard([]),
      async close() {
        closeCalls += 1;
      },
    };

    const result = await runManagedMcpSession(
      session,
      async () => {
        invoked = true;
        return 'unreachable';
      },
      { signal: controller.signal },
    );

    expect(result.operation.status).toBe('rejected');
    if (result.operation.status === 'rejected') {
      expect(result.operation.error.message).toBe('MCP operation was cancelled');
    }
    expect(result.cleanup).toEqual({ status: 'fulfilled' });
    expect(invoked).toBe(false);
    expect(closeCalls).toBe(1);
  });

  test('fails closed without exposing reflected configured credentials', async () => {
    const session: ManagedMcpSession = {
      client: new Client(
        { name: 'runtime-test', version: '0.0.0' },
        { capabilities: {} },
      ),
      credentialGuard: createMcpCredentialGuard(['private-value']),
      async close() {},
    };

    const result = await runManagedMcpSession(session, async () => ({
      content: 'server reflected private-value',
    }));

    expect(result.operation.status).toBe('rejected');
    if (result.operation.status === 'rejected') {
      expect(result.operation.error.message).toBe(
        'MCP output contained a configured credential value',
      );
      expect(result.operation.error.message).not.toContain('private-value');
    }
    expect(result.cleanup).toEqual({ status: 'fulfilled' });
  });


  test('normalizes call-time invalid grants to an exact destination reauth command', async () => {
    const server = createStatelessRuntimeServer();
    const port = await listen(server);
    const serverName = '-server name';
    const destination = makeUserDestination(
      `  ${JSON.stringify(serverName)}:\n    url: http://127.0.0.1:${port}/mcp\n`,
    );
    const session = await connectManagedMcpServer(destination, serverName);
    const failingClient = {
      async callTool() {
        throw new InvalidGrantError('refresh token expired');
      },
    } as unknown as Client;
    const tool: Tool = {
      name: 'protected',
      inputSchema: { type: 'object' },
    };

    const result = await runManagedMcpSession(session, ({ signal }) =>
      callMcpTool(failingClient, tool, {}, { signal }),
    );

    expect(result.operation.status).toBe('rejected');
    if (result.operation.status === 'rejected') {
      expect(result.operation.error).toBeInstanceOf(
        McpRuntimeAuthorizationError,
      );
      expect(result.operation.error.message).toContain(
        "allagents mcp reauth --scope user -- '-server name'",
      );
    }
    expect(result.cleanup).toEqual({ status: 'fulfilled' });
  });
  test('bounds HTTP termination, aborts the hanging DELETE, and keeps the result', async () => {
    let deleteRequests = 0;
    let deleteClosed = false;
    const { promise: sawDeleteClose, resolve: resolveDeleteClose } =
      Promise.withResolvers<void>();
    const server = createServer(async (request, response) => {
      if (request.method === 'GET') {
        response.statusCode = 405;
        response.end();
        return;
      }
      if (request.method === 'DELETE') {
        deleteRequests += 1;
        response.once('close', () => {
          deleteClosed = true;
          resolveDeleteClose();
        });
        return;
      }

      const message = JSON.parse(await readRequestBody(request)) as {
        id?: string | number;
        method: string;
        params?: { protocolVersion?: string };
      };
      if (message.method === 'initialize') {
        response.writeHead(200, {
          'content-type': 'application/json',
          'mcp-session-id': 'runtime-test-session',
        });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: message.params?.protocolVersion,
              capabilities: {},
              serverInfo: { name: 'runtime-test', version: '0.0.0' },
            },
          }),
        );
        return;
      }
      response.statusCode = 202;
      response.end();
    });
    servers.push(server);
    const port = await listen(server);
    const destination = makeProjectDestination(
      `  direct:\n    url: http://127.0.0.1:${port}/mcp\n`,
    );
    const session = await connectManagedMcpServer(destination, 'direct', {
      httpCleanupTimeoutMs: 20,
    });

    const result = await runManagedMcpSession(session, async () => 'received');
    await sawDeleteClose;
    expect(result.operation).toEqual({
      status: 'fulfilled',
      value: 'received',
    });
    expect(result.cleanup.status).toBe('rejected');
    if (result.cleanup.status === 'rejected') {
      expect(result.cleanup.error.message).toContain(
        'Timed out terminating MCP HTTP session',
      );
    }
    await expect(session.close()).rejects.toThrow(
      'Timed out terminating MCP HTTP session',
    );
    expect(deleteRequests).toBe(1);
    expect(deleteClosed).toBe(true);
  });
});

describe('bounded MCP tool catalog', () => {
  test('aggregates empty and non-empty pages in order and forwards opaque cursors', async () => {
    const cursors: (string | undefined)[] = [];
    const pages = [
      { tools: [], nextCursor: ' opaque cursor ' },
      {
        tools: [
          { name: 'first', inputSchema: { type: 'object' as const } },
          { name: 'Second', inputSchema: { type: 'object' as const } },
        ],
        nextCursor: '',
      },
      {
        tools: [{ name: 'last', inputSchema: { type: 'object' as const } }],
      },
    ];
    const client = {
      async listTools(params?: { cursor?: string }) {
        cursors.push(params?.cursor);
        const page = pages[cursors.length - 1];
        if (!page) throw new Error('unexpected page');
        return page;
      },
    } as unknown as Client;

    const catalog = await listAllMcpTools(client);

    expect(catalog.map(({ name }) => name)).toEqual(['first', 'Second', 'last']);
    expect(cursors).toEqual([undefined, ' opaque cursor ', '']);
    expect(findMcpTool(catalog, 'Second').name).toBe('Second');
    expect(() => findMcpTool(catalog, 'second')).toThrow(
      "MCP tool 'second' was not found",
    );
  });

  test('rejects repeated cursors and duplicate names across pages', async () => {
    let repeatedPage = 0;
    const repeatedCursorClient = {
      async listTools() {
        repeatedPage += 1;
        return { tools: [], nextCursor: 'same' };
      },
    } as unknown as Client;
    await expect(listAllMcpTools(repeatedCursorClient)).rejects.toThrow(
      'repeated a pagination cursor',
    );
    expect(repeatedPage).toBe(2);

    let duplicatePage = 0;
    const duplicateClient = {
      async listTools() {
        duplicatePage += 1;
        return {
          tools: [{ name: 'duplicate', inputSchema: { type: 'object' as const } }],
          ...(duplicatePage === 1 ? { nextCursor: 'next' } : {}),
        };
      },
    } as unknown as Client;
    await expect(listAllMcpTools(duplicateClient)).rejects.toThrow(
      "duplicate tool 'duplicate'",
    );
  });

  test('accepts exactly 100 pages and rejects a page beyond the limit', async () => {
    let exactCalls = 0;
    const exactClient = {
      async listTools() {
        exactCalls += 1;
        return {
          tools: [],
          ...(exactCalls < 100 ? { nextCursor: String(exactCalls) } : {}),
        };
      },
    } as unknown as Client;
    await expect(listAllMcpTools(exactClient)).resolves.toEqual([]);
    expect(exactCalls).toBe(100);

    let overflowCalls = 0;
    const overflowClient = {
      async listTools() {
        overflowCalls += 1;
        return { tools: [], nextCursor: String(overflowCalls) };
      },
    } as unknown as Client;
    await expect(listAllMcpTools(overflowClient)).rejects.toThrow(
      'exceeds 100 pages',
    );
    expect(overflowCalls).toBe(100);
  });

  test('accepts exactly 10,000 tools and rejects the first tool above the limit', async () => {
    const makeTools = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        name: `tool-${index}`,
        inputSchema: { type: 'object' as const },
      }));
    const exactClient = {
      async listTools() {
        return { tools: makeTools(10_000) };
      },
    } as unknown as Client;
    await expect(listAllMcpTools(exactClient)).resolves.toHaveLength(10_000);

    const overflowClient = {
      async listTools() {
        return { tools: makeTools(10_001) };
      },
    } as unknown as Client;
    await expect(listAllMcpTools(overflowClient)).rejects.toThrow(
      'exceeds 10000 tools',
    );
  });

  test('accepts the exact aggregate byte budget and rejects one byte above it', async () => {
    const budget = 16 * 1024 * 1024;
    const baseTools = [
      {
        name: 'sized-first',
        description: '',
        inputSchema: { type: 'object' as const },
      },
      {
        name: 'sized-second',
        description: '',
        inputSchema: { type: 'object' as const },
      },
    ];
    const fixedBytes = Buffer.byteLength(JSON.stringify(baseTools), 'utf8');
    const paddingBytes =
      budget - fixedBytes - Buffer.byteLength('second', 'utf8');
    const exactTools = [
      { ...baseTools[0], description: 'x'.repeat(Math.floor(paddingBytes / 2)) },
      { ...baseTools[1], description: 'x'.repeat(Math.ceil(paddingBytes / 2)) },
    ];
    const clientForTools = (tools: typeof exactTools) =>
      ({
        async listTools(params?: { cursor?: string }) {
          return params?.cursor === undefined
            ? { tools: [tools[0]], nextCursor: 'second' }
            : { tools: [tools[1]] };
        },
      }) as unknown as Client;

    await expect(
      listAllMcpTools(clientForTools(exactTools)),
    ).resolves.toHaveLength(2);

    const overflowTools = [
      exactTools[0],
      { ...exactTools[1], description: `${exactTools[1]?.description}x` },
    ];
    await expect(
      listAllMcpTools(clientForTools(overflowTools)),
    ).rejects.toThrow('exceeds 16777216 serialized bytes');
  });


  test('counts cumulative opaque cursor bytes against the catalog budget', async () => {
    const cursorBytes = 9 * 1024 * 1024;
    const cursors = ['a'.repeat(cursorBytes), 'b'.repeat(cursorBytes)];
    let calls = 0;
    const client = {
      async listTools() {
        const nextCursor = cursors[calls];
        calls += 1;
        return { tools: [], ...(nextCursor === undefined ? {} : { nextCursor }) };
      },
    } as unknown as Client;

    await expect(listAllMcpTools(client)).rejects.toThrow(
      'MCP tool catalog exceeds 16777216 serialized bytes',
    );
    expect(calls).toBe(2);
  });

  test('accepts an exact tools page byte budget and rejects one byte above it', async () => {
    const budget = 16 * 1024 * 1024;
    const basePage = { tools: [], _meta: { padding: '' } };
    const fixedBytes = Buffer.byteLength(JSON.stringify(basePage), 'utf8');
    const exactPage = {
      tools: [],
      _meta: { padding: 'x'.repeat(budget - fixedBytes) },
    };
    const exactClient = {
      async listTools() {
        return exactPage;
      },
    } as unknown as Client;
    await expect(listAllMcpTools(exactClient)).resolves.toEqual([]);

    const overflowClient = {
      async listTools() {
        return {
          ...exactPage,
          _meta: { padding: `${exactPage._meta.padding}x` },
        };
      },
    } as unknown as Client;
    await expect(listAllMcpTools(overflowClient)).rejects.toThrow(
      'MCP tools/list page exceeds 16777216 serialized bytes',
    );
  });

  test('accepts exact schema depth and node limits and rejects the first value above each', async () => {
    const schemaAtDepth = (depth: number) => {
      const root: Record<string, unknown> = {};
      let current = root;
      for (let index = 1; index < depth; index += 1) {
        const child: Record<string, unknown> = {};
        current.child = child;
        current = child;
      }
      return root;
    };
    const clientForSchema = (schema: Record<string, unknown>) =>
      ({
        async listTools() {
          return {
            tools: [
              {
                name: 'bounded',
                inputSchema: schema as { type: 'object' },
              },
            ],
          };
        },
      }) as unknown as Client;

    await expect(
      listAllMcpTools(clientForSchema(schemaAtDepth(64))),
    ).resolves.toHaveLength(1);
    await expect(
      listAllMcpTools(clientForSchema(schemaAtDepth(65))),
    ).rejects.toThrow('exceeds depth 64');

    const exactNodes = {
      type: 'object',
      nodes: Array.from({ length: 99_997 }, () => null),
    };
    await expect(
      listAllMcpTools(clientForSchema(exactNodes)),
    ).resolves.toHaveLength(1);
    await expect(
      listAllMcpTools(
        clientForSchema({
          type: 'object',
          nodes: Array.from({ length: 99_998 }, () => null),
        }),
      ),
    ).rejects.toThrow('exceeds 100000 nodes');
  });

  test('rejects required-task tools before calling and invokes ordinary tools from the aggregate', async () => {
    const calls: unknown[] = [];
    const client = {
      async callTool(params: unknown) {
        calls.push(params);
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      },
    } as unknown as Client;
    const catalog: Tool[] = [
      {
        name: 'required-task',
        inputSchema: { type: 'object' as const },
        execution: { taskSupport: 'required' as const },
      },
      { name: 'ordinary', inputSchema: { type: 'object' as const } },
    ];

    await expect(
      callMcpTool(client, catalog[0] as Tool, {}),
    ).rejects.toThrow('requires task-based execution');
    expect(calls).toEqual([]);

    await expect(
      callMcpTool(client, catalog[1] as Tool, { exact: true }),
    ).resolves.toEqual({ content: [{ type: 'text', text: 'ok' }] });
    expect(calls).toEqual([
      { name: 'ordinary', arguments: { exact: true } },
    ]);
  });


  test('preserves complete structured results that match the selected aggregate tool schema', async () => {
    const tool: Tool = {
      name: 'earlier-page-tool',
      inputSchema: { type: 'object' },
      outputSchema: {
        type: 'object',
        properties: { received: { type: 'string' } },
        required: ['received'],
      },
    };
    const completeResult = {
      content: [{ type: 'text' as const, text: 'complete' }],
      structuredContent: { received: 'exact', retained: false },
      isError: false,
      _meta: { page: 1, retained: true },
    };
    const client = {
      async callTool() {
        return completeResult;
      },
    } as unknown as Client;

    await expect(callMcpTool(client, tool, {})).resolves.toEqual(
      completeResult,
    );
  });

  test('rejects structured results that violate an earlier aggregate page schema', async () => {
    const tool: Tool = {
      name: 'earlier-page-tool',
      inputSchema: { type: 'object' },
      outputSchema: {
        type: 'object',
        properties: { count: { type: 'integer' } },
        required: ['count'],
      },
    };
    const client = {
      async callTool() {
        return {
          content: [],
          structuredContent: { count: 'not-an-integer' },
        };
      },
    } as unknown as Client;

    await expect(callMcpTool(client, tool, {})).rejects.toThrow(
      "Structured content does not match the tool's output schema",
    );
  });

  test('accepts an exact call result byte budget and rejects one byte above it', async () => {
    const budget = 16 * 1024 * 1024;
    const catalog: Tool[] = [
      { name: 'bounded', inputSchema: { type: 'object' as const } },
    ];
    const baseResult = { content: [], padding: '' };
    const fixedBytes = Buffer.byteLength(JSON.stringify(baseResult), 'utf8');
    const exactResult = {
      content: [],
      padding: 'x'.repeat(budget - fixedBytes),
    };
    const exactClient = {
      async callTool() {
        return exactResult;
      },
    } as unknown as Client;
    await expect(
      callMcpTool(exactClient, catalog[0] as Tool, {}),
    ).resolves.toEqual(exactResult);

    const overflowClient = {
      async callTool() {
        return {
          ...exactResult,
          padding: `${exactResult.padding}x`,
        };
      },
    } as unknown as Client;
    await expect(
      callMcpTool(overflowClient, catalog[0] as Tool, {}),
    ).rejects.toThrow(
      'MCP tools/call result exceeds 16777216 serialized bytes',
    );
  });
});
