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
  classifyMcpRuntimeCommand,
  runMcpRuntimeCommand,
  shouldHandleMcpRuntimeCommand,
  type McpRuntimeCliDependencies,
} from '../../src/cli/commands/mcp.js';
import { setJsonMode } from '../../src/cli/json-output.js';

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
        'tools',
        'server',
        '--search',
        '--help',
      ]),
    ).toBe(true);
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
