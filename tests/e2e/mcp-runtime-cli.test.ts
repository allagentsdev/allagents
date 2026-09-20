import {
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import type { Mock } from 'bun:test';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyMcpRuntimeCommand,
  runMcpRuntimeCommand,
  shouldHandleMcpRuntimeCommand,
  type McpRuntimeCliDependencies,
} from '../../src/cli/commands/mcp.js';
import { setJsonMode } from '../../src/cli/json-output.js';
import { connectHttpMcpServer } from '../../src/core/mcp-http-client.js';
import {
  createRuntimeToolPages,
  FIXTURE_TOOL_NAME,
  type DummyMcpOAuthServer,
  RUNTIME_COMPLEX_TOOL_NAME,
  RUNTIME_FAILURE_RESULT,
  RUNTIME_FAILURE_TOOL_NAME,
  RUNTIME_PRIMITIVE_INPUT_SCHEMA,
  RUNTIME_PRIMITIVE_TOOL_NAME,
  startDummyMcpOAuthServer,
} from '../helpers/dummy-mcp-oauth-server.js';

function fakeClient(
  tools: Tool[],
  callResult: Record<string, unknown> = { content: [] },
  calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [],
): Client {
  return {
    listTools: async () => ({ tools }),
    callTool: async (request: {
      name: string;
      arguments?: Record<string, unknown>;
    }) => {
      calls.push(request);
      return callResult;
    },
  } as unknown as Client;
}

function dependencies(
  client: Client,
  cleanupError?: Error,
): McpRuntimeCliDependencies {
  return {
    runManagedOperation: async (_destination, _server, operation, options) => {
      try {
        const value = await operation({
          client,
          signal: options.signal ?? new AbortController().signal,
        });
        return {
          operation: { status: 'fulfilled' as const, value },
          cleanup: cleanupError
            ? { status: 'rejected' as const, error: cleanupError }
            : { status: 'fulfilled' as const },
        };
      } catch (error) {
        return {
          operation: {
            status: 'rejected' as const,
            error: error instanceof Error ? error : new Error(String(error)),
          },
          cleanup: cleanupError
            ? { status: 'rejected' as const, error: cleanupError }
            : { status: 'fulfilled' as const },
        };
      }
    },
  };
}

describe('MCP runtime CLI source seam', () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let logSpy: Mock<typeof console.log>;
  let errorSpy: Mock<typeof console.error>;

  beforeEach(() => {
    stdout.length = 0;
    stderr.length = 0;
    process.exitCode = 0;
    setJsonMode(false);
    logSpy = spyOn(console, 'log').mockImplementation((...args) => {
      stdout.push(args.join(' '));
    });
    errorSpy = spyOn(console, 'error').mockImplementation((...args) => {
      stderr.push(args.join(' '));
    });
  });

  afterEach(() => {
    process.exitCode = 0;
    setJsonMode(false);
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('preclassifies only runtime commands after value-aware leading output flags', () => {
    expect(
      classifyMcpRuntimeCommand([
        '--json',
        '--jq',
        '.data',
        'mcp',
        'tools',
        'server',
      ]),
    ).toBe('tools');
    expect(
      classifyMcpRuntimeCommand(['--jq', 'mcp', 'tools', 'server']),
    ).toBeUndefined();
    expect(
      classifyMcpRuntimeCommand(['mcp', 'add', 'server', '--json']),
    ).toBeUndefined();
    expect(shouldHandleMcpRuntimeCommand(['mcp', 'call', '--help'])).toBe(false);
    expect(
      shouldHandleMcpRuntimeCommand([
        'mcp',
        'call',
        'server',
        'tool',
        '--help',
      ]),
    ).toBe(true);
    expect(
      shouldHandleMcpRuntimeCommand([
        'mcp',
        'call',
        '--help',
        '--',
        '--server',
        '--tool',
      ]),
    ).toBe(true);
    expect(
      shouldHandleMcpRuntimeCommand([
        'mcp',
        'tools',
        'server',
        '--search',
        '--help',
      ]),
    ).toBe(true);
  });

  test('treats identities after -- as opaque and rejects extra positionals', async () => {
    const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
    const tool = {
      name: '--echo',
      inputSchema: {
        type: 'object' as const,
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
    };

    await runMcpRuntimeCommand(
      ['mcp', 'tools', '--', '--catalog'],
      dependencies(fakeClient([tool], { content: [] }, calls)),
    );
    expect(stdout).toContain('--echo');

    stdout.length = 0;
    await runMcpRuntimeCommand(
      ['mcp', 'call', '--help', '--', '--catalog', '--echo'],
      dependencies(fakeClient([tool], { content: [] }, calls)),
    );
    expect(calls).toEqual([]);
    expect(stdout[0]).toBe(
      'Usage: allagents mcp call [options] -- --catalog --echo',
    );

    stdout.length = 0;
    await runMcpRuntimeCommand(
      [
        'mcp',
        'call',
        '--value=opaque',
        '--',
        '--catalog',
        '--echo',
      ],
      dependencies(fakeClient([tool], { content: [] }, calls)),
    );
    expect(calls).toEqual([
      { name: '--echo', arguments: { value: 'opaque' } },
    ]);

    await runMcpRuntimeCommand(
      ['mcp', 'tools', '--', '--catalog', 'extra'],
      dependencies(fakeClient([tool])),
    );
    expect(stderr).toContain(
      "Error: Unexpected argument 'extra' for mcp tools",
    );

    stderr.length = 0;
    await runMcpRuntimeCommand(
      ['mcp', 'call', '--', '--catalog', '--echo', 'extra'],
      dependencies(fakeClient([tool])),
    );
    expect(stderr).toContain(
      "Error: Unexpected argument 'extra' for mcp call",
    );
    expect(process.exitCode).toBe(2);
  });

  test('renders shell-safe live-help commands for the selected destination', async () => {
    const tool = {
      name: 'echo tool',
      inputSchema: { type: 'object' as const },
    };
    await runMcpRuntimeCommand(
      ['mcp', 'tools', 'catalog', '--scope', 'user'],
      dependencies(fakeClient([tool])),
    );
    expect(stdout).toContain(
      "  Help: allagents mcp call catalog 'echo tool' --help --scope user",
    );

    stdout.length = 0;
    await runMcpRuntimeCommand(
      ['mcp', 'tools', '--profile', 'market-desk', '--', '-catalog'],
      dependencies(
        fakeClient([
          {
            name: '-echo tool',
            inputSchema: { type: 'object' as const },
          },
        ]),
      ),
    );
    expect(stdout).toContain(
      "  Help: allagents mcp call --profile market-desk --help -- -catalog '-echo tool'",
    );
  });

  test('renders filtered discovery in order and preserves complete JSON records', async () => {
    const tools = [
      {
        name: 'first',
        title: 'First',
        description: 'hostile\n\u001b[31mred',
        inputSchema: { type: 'object' as const },
        _meta: { exact: true },
      },
      {
        name: 'second',
        description: 'MATCH me',
        inputSchema: { type: 'object' as const },
        outputSchema: { type: 'object' as const },
      },
    ];

    await runMcpRuntimeCommand(
      ['--json', 'mcp', 'tools', 'catalog', '--search', 'match'],
      dependencies(fakeClient(tools)),
    );

    expect(process.exitCode).toBe(0);
    expect(JSON.parse(stdout.join('\n'))).toEqual({
      success: true,
      command: 'mcp tools',
      data: {
        destination: { kind: 'project' },
        server: 'catalog',
        search: 'match',
        tools: [tools[1]],
        total: 1,
      },
    });
  });

  test('uses one live classifier for help without invoking the tool', async () => {
    const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
    const tool = {
      name: 'greet',
      description: 'Current description',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Who to greet' },
        },
        required: ['name'],
      },
    };

    await runMcpRuntimeCommand(
      ['mcp', 'call', 'catalog', 'greet', '--help', '--json'],
      dependencies(fakeClient([tool], { content: [] }, calls)),
    );

    expect(calls).toEqual([]);
    expect(JSON.parse(stdout.join('\n'))).toMatchObject({
      success: true,
      command: 'mcp call',
      data: {
        destination: { kind: 'project' },
        server: 'catalog',
        tool: 'greet',
        descriptor: tool,
        input: {
          mode: 'generated',
          required: ['name'],
          options: [
            expect.objectContaining({
              name: 'name',
              kind: 'string',
              required: true,
            }),
          ],
        },
      },
    });
  });

  test('keeps attached flag-looking generated values and renders call content in order', async () => {
    const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
    const tool = {
      name: 'echo',
      inputSchema: {
        type: 'object' as const,
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
    };
    const result = {
      content: [
        { type: 'text', text: 'first\u001b[31m' },
        { type: 'image', data: 'abc', mimeType: 'image/png' },
        { type: 'text', text: 'third' },
      ],
      structuredContent: { answer: 42 },
    };

    await runMcpRuntimeCommand(
      ['mcp', 'call', 'catalog', 'echo', '--value=--json'],
      dependencies(fakeClient([tool], result, calls)),
    );

    expect(calls).toEqual([
      { name: 'echo', arguments: { value: '--json' } },
    ]);
    expect(stdout).toEqual([
      'first',
      JSON.stringify(result.content[1], null, 2),
      'third',
      'Structured content:',
      JSON.stringify(result.structuredContent, null, 2),
    ]);
    expect(process.exitCode).toBe(0);
  });

  test('does not reinterpret detached flag-looking generated values as output flags', async () => {
    const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
    const tool = {
      name: 'echo',
      inputSchema: {
        type: 'object' as const,
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
    };

    await runMcpRuntimeCommand(
      ['mcp', 'call', 'catalog', 'echo', '--value', '--json'],
      dependencies(fakeClient([tool], { content: [] }, calls)),
    );

    expect(calls).toEqual([]);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual([
      'Error: Flag-looking values for --value require --value=value syntax',
    ]);
    expect(process.exitCode).toBe(2);
  });

  test('distinguishes an empty catalog from an empty search result', async () => {
    await runMcpRuntimeCommand(
      ['mcp', 'tools', 'empty'],
      dependencies(fakeClient([])),
    );
    expect(stdout).toEqual(['MCP server \'empty\' exposes no tools.']);

    stdout.length = 0;
    await runMcpRuntimeCommand(
      ['mcp', 'tools', 'catalog', '--search', 'missing'],
      dependencies(
        fakeClient([
          {
            name: 'present',
            inputSchema: { type: 'object' as const },
          },
        ]),
      ),
    );
    expect(stdout).toEqual([
      'No MCP tools matched \'missing\' on server \'catalog\'.',
    ]);
  });

  test('preserves failed tool results and reports cleanup failure independently', async () => {
    const tool = {
      name: 'fail',
      inputSchema: { type: 'object' as const },
    };
    const result = {
      content: [{ type: 'text', text: 'diagnostic' }],
      structuredContent: { code: 'E_TOOL' },
      isError: true,
      _meta: { retryable: false },
    };

    await runMcpRuntimeCommand(
      ['--json', 'mcp', 'call', 'catalog', 'fail'],
      dependencies(fakeClient([tool], result), new Error('close failed')),
    );

    expect(JSON.parse(stdout.join('\n'))).toEqual({
      success: false,
      command: 'mcp call',
      data: {
        destination: { kind: 'project' },
        server: 'catalog',
        tool: 'fail',
        result,
      },
      error: 'MCP cleanup failed: close failed',
    });
    expect(stderr).toEqual(['Error: MCP cleanup failed: close failed']);
    expect(process.exitCode).toBe(1);
  });
});

interface RealCliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const runtimeCliEntry = join(
  import.meta.dir,
  '..',
  '..',
  'src',
  'cli',
  'index.ts',
);

async function runRealCli(
  workspaceDir: string,
  homeDir: string,
  args: string[],
): Promise<RealCliResult> {
  const child = Bun.spawn(['bun', 'run', runtimeCliEntry, ...args], {
    cwd: workspaceDir,
    env: {
      ...process.env,
      ALLAGENTS_TEST_HOME: homeDir,
      HOME: homeDir,
      USERPROFILE: homeDir,
      XDG_CACHE_HOME: join(homeDir, '.cache'),
      XDG_CONFIG_HOME: join(homeDir, '.config'),
      XDG_DATA_HOME: join(homeDir, '.local', 'share'),
      XDG_STATE_HOME: join(homeDir, '.local', 'state'),
      ALLAGENTS_MCP_OAUTH_NO_BROWSER: '1',
      NO_COLOR: '1',
      CI: '1',
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function writeRuntimeDestinations(
  workspaceDir: string,
  homeDir: string,
  projectServers: Record<string, unknown>,
  userServers: Record<string, unknown> = {},
  profiles: Record<string, unknown> = {},
): void {
  mkdirSync(join(workspaceDir, '.allagents'), { recursive: true });
  writeFileSync(
    join(workspaceDir, '.allagents', 'workspace.yaml'),
    `${JSON.stringify({
      repositories: [],
      plugins: [],
      clients: [],
      mcpServers: projectServers,
    }, null, 2)}\n`,
  );
  mkdirSync(join(homeDir, '.allagents'), { recursive: true });
  writeFileSync(
    join(homeDir, '.allagents', 'workspace.yaml'),
    `${JSON.stringify({
      clients: [],
      mcpServers: userServers,
      profiles,
    }, null, 2)}\n`,
  );
}

async function authorizeRuntimeFixture(
  serverUrl: string,
  homeDir: string,
  profile?: string,
): Promise<void> {
  const previousHome = process.env.ALLAGENTS_TEST_HOME;
  const previousNoBrowser = process.env.ALLAGENTS_MCP_OAUTH_NO_BROWSER;
  process.env.ALLAGENTS_TEST_HOME = homeDir;
  process.env.ALLAGENTS_MCP_OAUTH_NO_BROWSER = '1';
  try {
    await connectHttpMcpServer(serverUrl, {
      ...(profile === undefined ? {} : { profile }),
      authorizationOutput: () => {},
      callbackUrlReader: async ({ authorizationUrl }) => {
        const response = await fetch(authorizationUrl, {
          redirect: 'manual',
        });
        const location = response.headers.get('location');
        if (!location) {
          throw new Error('Fixture authorization did not return a callback');
        }
        return new URL(location, authorizationUrl).toString();
      },
    });
  } finally {
    if (previousHome === undefined) delete process.env.ALLAGENTS_TEST_HOME;
    else process.env.ALLAGENTS_TEST_HOME = previousHome;
    if (previousNoBrowser === undefined) {
      delete process.env.ALLAGENTS_MCP_OAUTH_NO_BROWSER;
    } else {
      process.env.ALLAGENTS_MCP_OAUTH_NO_BROWSER = previousNoBrowser;
    }
  }
}

describe('MCP runtime CLI real HTTP transport', () => {
  let rootDir: string;
  let workspaceDir: string;
  let homeDir: string;
  let dummy: DummyMcpOAuthServer | undefined;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'allagents-mcp-runtime-http-'));
    workspaceDir = join(rootDir, 'workspace');
    homeDir = join(rootDir, 'home');
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
  });

  afterEach(async () => {
    await dummy?.stop();
    dummy = undefined;
    rmSync(rootDir, { recursive: true, force: true });
  });

  test('discovers paginated complete records, filters, and renders both empty states', async () => {
    dummy = await startDummyMcpOAuthServer({
      requireAuth: false,
      runtimeTools: true,
    });
    writeRuntimeDestinations(workspaceDir, homeDir, {
      remote: { type: 'http', url: dummy.mcpUrl },
    });

    const discovery = await runRealCli(workspaceDir, homeDir, [
      '--json',
      'mcp',
      'tools',
      'remote',
    ]);
    expect(discovery.exitCode).toBe(0);
    expect(discovery.stderr).toBe('');
    const payload = JSON.parse(discovery.stdout);
    expect(payload.data.tools.map((tool: Tool) => tool.name)).toEqual([
      'ask_question',
      RUNTIME_PRIMITIVE_TOOL_NAME,
      RUNTIME_COMPLEX_TOOL_NAME,
      RUNTIME_FAILURE_TOOL_NAME,
    ]);
    expect(payload.data.tools[1]).toMatchObject({
      title: 'Primitive Echo',
      inputSchema: RUNTIME_PRIMITIVE_INPUT_SCHEMA,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
      },
      execution: { taskSupport: 'forbidden' },
      _meta: { fixture: { page: 1, unicode: 'λ' } },
    });
    expect(payload.data.tools[1].icons).toHaveLength(1);
    expect(dummy.listCallCount).toBe(2);
    expect(dummy.activeSessionCount).toBe(0);

    const search = await runRealCli(workspaceDir, homeDir, [
      'mcp',
      'tools',
      'remote',
      '--search',
      'nested and unusual',
    ]);
    expect(search.exitCode).toBe(0);
    expect(search.stdout).toContain(RUNTIME_COMPLEX_TOOL_NAME);
    expect(search.stdout).not.toContain(RUNTIME_PRIMITIVE_TOOL_NAME);

    const noMatch = await runRealCli(workspaceDir, homeDir, [
      'mcp',
      'tools',
      'remote',
      '--search',
      'not-present',
    ]);
    expect(noMatch.stdout.trim()).toBe(
      "No MCP tools matched 'not-present' on server 'remote'.",
    );

    dummy.setToolPages([]);
    const empty = await runRealCli(workspaceDir, homeDir, [
      'mcp',
      'tools',
      'remote',
    ]);
    expect(empty.stdout.trim()).toBe(
      "MCP server 'remote' exposes no tools.",
    );
    expect(dummy.activeSessionCount).toBe(0);
  }, 20_000);

  test('uses -- to discover, inspect, and call option-looking configured identities', async () => {
    dummy = await startDummyMcpOAuthServer({
      requireAuth: false,
      runtimeTools: true,
    });
    dummy.updateTool(FIXTURE_TOOL_NAME, { name: '--ask' });
    writeRuntimeDestinations(workspaceDir, homeDir, {
      '--remote': { type: 'http', url: dummy.mcpUrl },
    });

    const discovery = await runRealCli(workspaceDir, homeDir, [
      '--json',
      'mcp',
      'tools',
      '--',
      '--remote',
    ]);
    expect(discovery.exitCode).toBe(0);
    expect(
      JSON.parse(discovery.stdout).data.tools.map((tool: Tool) => tool.name),
    ).toContain('--ask');
    expect(dummy.activeSessionCount).toBe(0);

    const help = await runRealCli(workspaceDir, homeDir, [
      '--json',
      'mcp',
      'call',
      '--help',
      '--',
      '--remote',
      '--ask',
    ]);
    expect(help.exitCode).toBe(0);
    expect(JSON.parse(help.stdout).data.descriptor.name).toBe('--ask');
    expect(dummy.callToolCount).toBe(0);
    expect(dummy.activeSessionCount).toBe(0);

    const call = await runRealCli(workspaceDir, homeDir, [
      '--json',
      'mcp',
      'call',
      '--input',
      '{"question":"exact"}',
      '--',
      '--remote',
      '--ask',
    ]);
    expect(call.exitCode).toBe(0);
    expect(dummy.capturedCalls.at(-1)).toEqual({
      name: '--ask',
      arguments: { question: 'exact' },
    });
    expect(dummy.activeSessionCount).toBe(0);
  }, 20_000);

  test('uses live help without calls and forwards generated and exact JSON arguments', async () => {
    dummy = await startDummyMcpOAuthServer({
      requireAuth: false,
      runtimeTools: true,
    });
    writeRuntimeDestinations(workspaceDir, homeDir, {
      remote: { type: 'http', url: dummy.mcpUrl },
    });

    const firstHelp = await runRealCli(workspaceDir, homeDir, [
      'mcp',
      'call',
      'remote',
      RUNTIME_PRIMITIVE_TOOL_NAME,
      '--help',
      '--json',
    ]);
    expect(firstHelp.exitCode).toBe(0);
    expect(JSON.parse(firstHelp.stdout).data).toMatchObject({
      descriptor: {
        description: 'Current primitive fixture description',
        inputSchema: RUNTIME_PRIMITIVE_INPUT_SCHEMA,
      },
      input: {
        mode: 'generated',
        required: RUNTIME_PRIMITIVE_INPUT_SCHEMA.required,
      },
    });
    expect(dummy.callToolCount).toBe(0);

    const liveSchema = {
      type: 'object' as const,
      properties: { fresh: { type: 'string' } },
      required: ['fresh'],
    };
    dummy.updateTool(RUNTIME_PRIMITIVE_TOOL_NAME, {
      description: 'Updated live fixture description',
      inputSchema: liveSchema,
    });
    const secondHelp = await runRealCli(workspaceDir, homeDir, [
      '--json',
      'mcp',
      'call',
      'remote',
      RUNTIME_PRIMITIVE_TOOL_NAME,
      '--help',
    ]);
    expect(JSON.parse(secondHelp.stdout).data.descriptor).toMatchObject({
      description: 'Updated live fixture description',
      inputSchema: liveSchema,
    });
    expect(dummy.callToolCount).toBe(0);

    dummy.setToolPages(createRuntimeToolPages());
    const primitive = await runRealCli(workspaceDir, homeDir, [
      '--json',
      'mcp',
      'call',
      'remote',
      RUNTIME_PRIMITIVE_TOOL_NAME,
      '--text',
      'hello',
      '--number',
      '1.25',
      '--integer',
      '7',
      '--enabled=false',
      '--mode',
      'safe',
      '--tags',
      'first',
      '--tags',
      'second',
    ]);
    expect(primitive.exitCode).toBe(0);
    expect(dummy.capturedCalls.at(-1)).toEqual({
      name: RUNTIME_PRIMITIVE_TOOL_NAME,
      arguments: {
        text: 'hello',
        number: 1.25,
        integer: 7,
        enabled: false,
        mode: 'safe',
        tags: ['first', 'second'],
      },
    });

    const exactInput = {
      payload: {
        nested: ['λ', null, '', { deeper: [1, false] }],
      },
      'unusual key': null,
      empty: '',
    };
    const exact = await runRealCli(workspaceDir, homeDir, [
      '--json',
      'mcp',
      'call',
      'remote',
      RUNTIME_COMPLEX_TOOL_NAME,
      '--input',
      JSON.stringify(exactInput),
    ]);
    expect(exact.exitCode).toBe(0);
    expect(dummy.capturedCalls.at(-1)).toEqual({
      name: RUNTIME_COMPLEX_TOOL_NAME,
      arguments: exactInput,
    });

    const callsBeforeMixedInput = dummy.callToolCount;
    const mixedInput = await runRealCli(workspaceDir, homeDir, [
      '--json',
      'mcp',
      'call',
      'remote',
      RUNTIME_PRIMITIVE_TOOL_NAME,
      '--input',
      '{"text":"exact"}',
      '--text',
      'generated',
    ]);
    expect(mixedInput.exitCode).toBe(2);
    expect(JSON.parse(mixedInput.stdout).error).toContain(
      '--input cannot be combined with generated tool options',
    );
    expect(dummy.callToolCount).toBe(callsBeforeMixedInput);
    expect(dummy.activeSessionCount).toBe(0);
  }, 20_000);

  test('preserves complete JSON, jq output, ordered human content, and tool failures', async () => {
    dummy = await startDummyMcpOAuthServer({
      requireAuth: false,
      runtimeTools: true,
    });
    writeRuntimeDestinations(workspaceDir, homeDir, {
      remote: { type: 'http', url: dummy.mcpUrl },
    });

    const input = {
      payload: { nested: ['one', null, 'λ'] },
      'unusual key': '',
    };
    const json = await runRealCli(workspaceDir, homeDir, [
      '--json',
      'mcp',
      'call',
      'remote',
      RUNTIME_COMPLEX_TOOL_NAME,
      '--input',
      JSON.stringify(input),
    ]);
    expect(json.exitCode).toBe(0);
    expect(JSON.parse(json.stdout).data.result).toEqual({
      content: [
        { type: 'text', text: `received ${RUNTIME_COMPLEX_TOOL_NAME}` },
        {
          type: 'resource_link',
          uri: 'file:///runtime-fixture/result.json',
          name: 'captured arguments',
          mimeType: 'application/json',
        },
      ],
      structuredContent: { received: input },
      _meta: { fixture: true, explicitFalse: false },
      fixtureExtension: { preserved: true },
    });

    const jq = await runRealCli(workspaceDir, homeDir, [
      '--json',
      '--jq',
      '.data.result.structuredContent.received',
      'mcp',
      'call',
      'remote',
      RUNTIME_COMPLEX_TOOL_NAME,
      '--input',
      JSON.stringify(input),
    ]);
    expect(jq.exitCode).toBe(0);
    expect(JSON.parse(jq.stdout)).toEqual(input);

    const failedJson = await runRealCli(workspaceDir, homeDir, [
      '--json',
      'mcp',
      'call',
      'remote',
      RUNTIME_FAILURE_TOOL_NAME,
    ]);
    expect(failedJson.exitCode).toBe(1);
    expect(failedJson.stderr).toBe('');
    expect(JSON.parse(failedJson.stdout)).toMatchObject({
      success: false,
      data: {
        result: RUNTIME_FAILURE_RESULT,
      },
    });

    const failedHuman = await runRealCli(workspaceDir, homeDir, [
      'mcp',
      'call',
      'remote',
      RUNTIME_FAILURE_TOOL_NAME,
    ]);
    expect(failedHuman.exitCode).toBe(1);
    expect(failedHuman.stdout.indexOf('first diagnostic')).toBeLessThan(
      failedHuman.stdout.indexOf('"type": "image"'),
    );
    expect(failedHuman.stdout.indexOf('"type": "image"')).toBeLessThan(
      failedHuman.stdout.indexOf('last diagnostic'),
    );
    expect(failedHuman.stdout).toContain('Structured content:');
    expect(failedHuman.stdout).toContain('"retryable": false');
    expect(dummy.activeSessionCount).toBe(0);
  }, 20_000);

  test('fails closed when HTTP tool output reflects a configured header credential', async () => {
    dummy = await startDummyMcpOAuthServer({
      requireAuth: false,
      runtimeTools: true,
    });
    const credential = 'runtime-reflection-secret-4c21f08d';
    writeRuntimeDestinations(workspaceDir, homeDir, {
      remote: {
        type: 'http',
        url: dummy.mcpUrl,
        headers: { 'X-Reflect-Credential': credential },
      },
    });

    const human = await runRealCli(workspaceDir, homeDir, [
      'mcp',
      'call',
      'remote',
      RUNTIME_FAILURE_TOOL_NAME,
    ]);
    expect(human.exitCode).toBe(1);
    expect(human.stderr).toContain(
      'MCP output contained a configured credential value',
    );
    expect(`${human.stdout}\n${human.stderr}`).not.toContain(credential);
    expect(dummy.activeSessionCount).toBe(0);

    const json = await runRealCli(workspaceDir, homeDir, [
      '--json',
      'mcp',
      'call',
      'remote',
      RUNTIME_FAILURE_TOOL_NAME,
    ]);
    expect(json.exitCode).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual({
      success: false,
      command: 'mcp call',
      error: 'MCP output contained a configured credential value',
    });
    expect(`${json.stdout}\n${json.stderr}`).not.toContain(credential);
    expect(dummy.activeSessionCount).toBe(0);
  }, 20_000);

  test('reuses and refreshes destination-owned OAuth caches without fresh consent', async () => {
    dummy = await startDummyMcpOAuthServer({
      accessTokenTtlMs: 1_500,
      runtimeTools: true,
    });
    const remote = { type: 'http', url: dummy.mcpUrl };
    writeRuntimeDestinations(
      workspaceDir,
      homeDir,
      { project: remote },
      { user: remote },
      {
        markets: {
          clients: [{ name: 'codex' }],
          mcpServers: { profile: remote },
        },
        research: {
          clients: [{ name: 'codex' }],
          mcpServers: { profile: remote },
        },
      },
    );

    const missingCases = [
      {
        args: ['--json', 'mcp', 'tools', 'project'],
        command: 'allagents mcp reauth project',
      },
      {
        args: ['--json', 'mcp', 'tools', 'user', '--scope', 'user'],
        command: 'allagents mcp reauth --scope user user',
      },
      {
        args: [
          '--json',
          'mcp',
          'tools',
          'profile',
          '--profile',
          'markets',
        ],
        command: 'allagents mcp reauth --profile markets profile',
      },
    ];
    for (const missing of missingCases) {
      const result = await runRealCli(workspaceDir, homeDir, missing.args);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error).toBe(
        `MCP authorization is required. Run \`${missing.command}\` and try again.`,
      );
    }
    expect(dummy.authorizeCallCount).toBe(0);

    const projectDoesNotMergeUser = await runRealCli(
      workspaceDir,
      homeDir,
      ['--json', 'mcp', 'tools', 'user'],
    );
    expect(JSON.parse(projectDoesNotMergeUser.stdout).error).toContain(
      "MCP server 'user' is not defined in workspace.yaml",
    );

    await authorizeRuntimeFixture(dummy.mcpUrl, homeDir);
    expect(dummy.authorizeCallCount).toBe(1);
    const project = await runRealCli(workspaceDir, homeDir, [
      '--json',
      'mcp',
      'tools',
      'project',
    ]);
    const user = await runRealCli(workspaceDir, homeDir, [
      '--json',
      'mcp',
      'tools',
      'user',
      '--scope',
      'user',
    ]);
    expect(project.exitCode).toBe(0);
    expect(JSON.parse(project.stdout).data.destination).toEqual({
      kind: 'project',
    });
    expect(user.exitCode).toBe(0);
    expect(JSON.parse(user.stdout).data.destination).toEqual({ kind: 'user' });
    expect(dummy.authorizeCallCount).toBe(1);

    await authorizeRuntimeFixture(dummy.mcpUrl, homeDir, 'markets');
    const profile = await runRealCli(workspaceDir, homeDir, [
      '--json',
      'mcp',
      'tools',
      'profile',
      '--profile',
      'markets',
    ]);
    expect(profile.exitCode).toBe(0);
    expect(JSON.parse(profile.stdout).data.destination).toEqual({
      kind: 'profile',
      name: 'markets',
    });
    expect(dummy.authorizeCallCount).toBe(2);

    const isolatedProfile = await runRealCli(workspaceDir, homeDir, [
      '--json',
      'mcp',
      'tools',
      'profile',
      '--profile',
      'research',
    ]);
    expect(isolatedProfile.exitCode).toBe(1);
    expect(JSON.parse(isolatedProfile.stdout).error).toContain(
      'allagents mcp reauth --profile research profile',
    );
    expect(dummy.authorizeCallCount).toBe(2);

    dummy.expireAccessTokens();
    const refreshed = await runRealCli(workspaceDir, homeDir, [
      '--json',
      'mcp',
      'tools',
      'project',
    ]);
    expect(refreshed.exitCode).toBe(0);
    expect(dummy.authorizeCallCount).toBe(2);
    expect(dummy.tokenCallCounts.refresh_token).toBeGreaterThanOrEqual(1);
    expect(dummy.activeSessionCount).toBe(0);
  }, 30_000);
});
