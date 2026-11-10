import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createServer, type Server as HttpServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, ListResourcesRequestSchema } from '@modelcontextprotocol/sdk/types.js';

let root: string;
let http: HttpServer;
let url: string;
let transports: Map<string, StreamableHTTPServerTransport>;
let resourceMode: 'single' | 'pages' | 'loop';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'allagents-mcp-policy-'));
  await mkdir(join(root, 'home'), { recursive: true });
  await mkdir(join(root, '.allagents'));
  await writeFile(join(root, '.allagents/workspace.yaml'), 'repositories: []\nplugins: []\nclients: [codex, copilot]\n');
  transports = new Map();
  resourceMode = 'single';
  http = createServer(async (request, response) => {
    let transport = transports.get(String(request.headers['mcp-session-id']));
    if (!transport) {
      const server = new Server({ name: 'Inspection fixture', version: '1' }, { capabilities: { tools: {}, resources: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
        { name: 'read_record', inputSchema: { type: 'object' } },
        { name: 'delete_record', inputSchema: { type: 'object' } },
      ] }));
      server.setRequestHandler(ListResourcesRequestSchema, async ({ params }) => {
        if (resourceMode === 'single') return { resources: [{ uri: 'fixture:///guide', name: 'Guide' }] };
        if (!params?.cursor || resourceMode === 'loop') return { resources: [{ uri: 'fixture:///guide', name: 'Guide' }], nextCursor: 'private-page-cursor' };
        return { resources: [{ uri: 'fixture:///second', name: 'Second guide' }] };
      });
      const next = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID(), onsessioninitialized(id) { transports.set(id, next); } });
      transport = next;
      await server.connect(transport);
    }
    await transport.handleRequest(request, response);
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
afterEach(async () => {
  await Promise.all([...transports.values()].map(t => t.close()));
  await new Promise<void>((resolve, reject) => { http.close(error => error ? reject(error) : resolve()); http.closeAllConnections(); });
  await rm(root, { recursive: true, force: true });
});

async function cli(args: string[]) {
  const child = Bun.spawn(['bun', join(import.meta.dir, '../../src/cli/index.ts'), '--json', ...args], {
    cwd: root, env: { ...process.env, HOME: join(root, 'home'), ALLAGENTS_TEST_HOME: join(root, 'home') }, stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill(), 10000);
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  clearTimeout(timer);
  return { code, stdout, stderr };
}

test('add, inspect and probe share the authored connection policy without exposing its secret', async () => {
  await writeFile(join(root, 'oauth.json'), JSON.stringify({ clientId: 'registered', clientSecret: 'private-fixture-secret' }));
  await writeFile(join(root, 'headers.txt'), '# custom MCP header\nX-Resource: private-header-sentinel-9273\n');
  const added = await cli(['mcp', 'add', 'inspection', url, '--oauth-config', '@oauth.json', '--connection-config', '{"transportStrategy":"http-only","ignoreTools":["delete*"]}', '--header-file', 'headers.txt']);
  expect(added.code, added.stdout + added.stderr).toBe(0);
  expect(added.stdout).not.toContain('private-fixture-secret');
  const config = await readFile(join(root, '.codex/config.toml'), 'utf8');
  expect(config).toContain('--connection-config');
  expect(config).toContain('ALLAGENTS_MCP_OAUTH_CLIENT_SECRET');
  expect(config.split('args = ')[1]?.split('\n')[0]).not.toContain('private-fixture-secret');
  const got = await cli(['mcp', 'get', 'inspection']);
  expect(JSON.parse(got.stdout).data.config.oauth.clientSecret).toBe('[REDACTED]');
  const probe = await cli(['mcp', 'probe', 'inspection']);
  expect(probe.code).toBe(0);
  const data = JSON.parse(probe.stdout).data;
  expect(data.serverInfo.name).toBe('Inspection fixture');
  expect(data.tools.map((tool: { name: string }) => tool.name)).toEqual(['read_record']);
  expect(data.resources).toEqual([{ uri: 'fixture:///guide', name: 'Guide' }]);
});

test('invalid advanced JSON and unreadable header files fail before mutation without echoing values', async () => {
  const before = await readFile(join(root, '.allagents/workspace.yaml'), 'utf8');
  const invalid = await cli(['mcp', 'add', 'bad', url, '--oauth-config', '{"clientSecret":"private-fixture-secret",']);
  expect(invalid.code).toBe(1);
  expect(invalid.stdout).not.toContain('private-fixture-secret');
  expect(invalid.stderr).not.toContain('private-fixture-secret');
  const missing = await cli(['mcp', 'add', 'bad', url, '--header-file', 'missing.txt']);
  expect(missing.code).toBe(1);
  expect(await readFile(join(root, '.allagents/workspace.yaml'), 'utf8')).toBe(before);
});


test('probe follows resource pages and rejects repeated opaque cursors', async () => {
  expect((await cli(['mcp', 'add', 'pages', url])).code).toBe(0);
  resourceMode = 'pages';
  const complete = await cli(['mcp', 'probe', 'pages']);
  expect(complete.code, complete.stdout + complete.stderr).toBe(0);
  expect(JSON.parse(complete.stdout).data.resources.map((resource: { name: string }) => resource.name)).toEqual(['Guide', 'Second guide']);
  resourceMode = 'loop';
  const loop = await cli(['mcp', 'probe', 'pages']);
  expect(loop.code).toBe(1);
  expect(JSON.parse(loop.stdout).error).toContain('repeated a pagination cursor');
  expect(loop.stdout + loop.stderr).not.toContain('private-page-cursor');
}, 15000);
