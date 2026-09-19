import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpCredentialGuard } from '../../../src/core/mcp-http-client.js';
import {
  connectManagedMcpServer,
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
