import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMcpRuntimeStdioFixture,
  MCP_STDIO_COMPLEX_TOOL,
  MCP_STDIO_FAILURE_TOOL,
  MCP_STDIO_PRIMITIVE_TOOL,
  MCP_STDIO_SECRET_SENTINEL,
  type McpStdioCaptureRecord,
  type McpRuntimeStdioFixture,
} from '../helpers/mcp-runtime-stdio-fixture.js';

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const projectServer = 'project-stdio';
const userServer = 'user-stdio';
const profileServer = 'profile-stdio';
const rejectedServer = 'rejected-argv';
const hangingServer = 'hanging-stdio';

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function callArguments() {
  return [
    '--text=hello',
    '--ratio=1.5',
    '--count=7',
    '--enabled=false',
    '--mode=fast',
    '--tags=first',
    '--tags=second',
  ];
}

describe('MCP runtime direct stdio CLI e2e', () => {
  let rootDir: string;
  let workspaceDir: string;
  let homeDir: string;
  let fixture: McpRuntimeStdioFixture;

  beforeEach(() => {
    rootDir = join(
      tmpdir(),
      `allagents-mcp-stdio-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    workspaceDir = join(rootDir, 'workspace');
    homeDir = join(rootDir, 'home');
    mkdirSync(join(workspaceDir, '.allagents'), { recursive: true });
    mkdirSync(join(homeDir, '.allagents'), { recursive: true });
    fixture = createMcpRuntimeStdioFixture(join(rootDir, 'fixture-state'));
    const hangingConfig = fixture.serverConfig();
    hangingConfig.env.MCP_STDIO_HANG_LIST = '1';

    writeJson(join(workspaceDir, '.allagents', 'workspace.yaml'), {
      repositories: [],
      plugins: [],
      clients: [],
      mcpServers: {
        [projectServer]: fixture.serverConfig(),
        [rejectedServer]: fixture.serverConfig({
          args: [fixture.serverPath, '${ARGV_SECRET}'],
        }),
        [hangingServer]: hangingConfig,
      },
    });
    writeJson(join(homeDir, '.allagents', 'workspace.yaml'), {
      repositories: [],
      plugins: [],
      clients: [],
      mcpServers: { [userServer]: fixture.serverConfig() },
      profiles: {
        work: {
          clients: [{ name: 'claude' }],
          plugins: [],
          mcpServers: { [profileServer]: fixture.serverConfig() },
        },
      },
    });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  async function runCli(args: string[]): Promise<CliResult> {
    const cliEntry = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');
    const proc = Bun.spawn(['bun', 'run', cliEntry, ...args], {
      cwd: workspaceDir,
      env: {
        ...process.env,
        ...fixture.parentEnvironment,
        HOME: homeDir,
        USERPROFILE: homeDir,
        ALLAGENTS_TEST_HOME: homeDir,
        XDG_CONFIG_HOME: join(homeDir, '.config'),
        XDG_CACHE_HOME: join(homeDir, '.cache'),
        UNSAFE_PARENT: 'must-not-be-inherited',
        ARGV_SECRET: 'must-not-enter-process-list',
        CI: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  }

  function expectNoSecretLeak(result: CliResult): void {
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).not.toContain(MCP_STDIO_SECRET_SENTINEL);
    expect(output).not.toContain('resolved-secret');
    expect(output).not.toContain('must-not-enter-process-list');
  }

  async function runSpawned(
    args: string[],
    expectedExitCode = 0,
  ): Promise<CliResult> {
    const previousExitCount = fixture.exits().length;
    const result = await runCli(args);
    expect(result.exitCode).toBe(expectedExitCode);
    expectNoSecretLeak(result);
    const exits = await fixture.waitForExits(previousExitCount + 1);
    expect(exits).toHaveLength(previousExitCount + 1);
    expect(exits.at(-1)?.code).toBe(0);
    return result;
  }

  test('discovers every page in order across project, user, and profile destinations', async () => {
    const project = await runSpawned([
      '--json',
      'mcp',
      'tools',
      projectServer,
    ]);
    const projectPayload = JSON.parse(project.stdout);
    expect(projectPayload).toMatchObject({
      success: true,
      command: 'mcp tools',
      data: {
        destination: { kind: 'project' },
        server: projectServer,
        total: 3,
      },
    });
    expect(
      projectPayload.data.tools.map((tool: { name: string }) => tool.name),
    ).toEqual([
      MCP_STDIO_PRIMITIVE_TOOL,
      MCP_STDIO_COMPLEX_TOOL,
      MCP_STDIO_FAILURE_TOOL,
    ]);
    expect(projectPayload.data.tools[0]).toMatchObject({
      title: 'Primitive Echo',
      annotations: { destructiveHint: false },
      _meta: { fixture: { page: 1, transport: 'stdio' } },
    });

    const searched = await runSpawned([
      '--json',
      'mcp',
      'tools',
      projectServer,
      '--search',
      'COMPLEX',
    ]);
    expect(
      JSON.parse(searched.stdout).data.tools.map(
        (tool: { name: string }) => tool.name,
      ),
    ).toEqual([MCP_STDIO_COMPLEX_TOOL]);

    const user = await runSpawned([
      '--json',
      'mcp',
      'tools',
      userServer,
      '--scope',
      'user',
    ]);
    expect(JSON.parse(user.stdout).data.destination).toEqual({ kind: 'user' });

    const profile = await runSpawned([
      '--json',
      'mcp',
      'tools',
      profileServer,
      '--profile',
      'work',
    ]);
    expect(JSON.parse(profile.stdout).data.destination).toEqual({
      kind: 'profile',
      name: 'work',
    });

    const expectedCaptures = Array.from(
      { length: 4 },
      (): McpStdioCaptureRecord[] => [
        { kind: 'list', cursor: null },
        { kind: 'list', cursor: 'stdio-page-1' },
      ],
    ).flat();
    expect(fixture.captures()).toEqual(expectedCaptures);
    expect(fixture.environments()).toHaveLength(4);
    for (const environment of fixture.environments()) {
      expect(environment.values).toEqual({
        RESOLVED_SECRET: 'resolved-secret',
        LITERAL_VALUE: 'fixture-literal',
        UNSAFE_PARENT: null,
      });
    }
  }, 30_000);

  test('uses live help without calling and preserves generated and exact JSON arguments', async () => {
    const help = await runSpawned([
      'mcp',
      'call',
      projectServer,
      MCP_STDIO_PRIMITIVE_TOOL,
      '--help',
      '--json',
    ]);
    expect(JSON.parse(help.stdout)).toMatchObject({
      success: true,
      command: 'mcp call',
      data: {
        tool: MCP_STDIO_PRIMITIVE_TOOL,
        descriptor: {
          description: 'Current primitive stdio fixture description',
        },
        input: {
          mode: 'generated',
          required: ['text', 'ratio', 'count', 'enabled', 'mode', 'tags'],
        },
      },
    });
    expect(fixture.captures().filter(({ kind }) => kind === 'call')).toEqual([]);

    const primitive = await runSpawned([
      '--json',
      'mcp',
      'call',
      projectServer,
      MCP_STDIO_PRIMITIVE_TOOL,
      ...callArguments(),
    ]);
    const primitiveResult = JSON.parse(primitive.stdout);
    expect(primitiveResult).toMatchObject({
      success: true,
      data: {
        result: {
          content: [
            { type: 'text', text: 'first fixture item' },
            { type: 'resource_link', name: 'captured arguments' },
            { type: 'text', text: 'third fixture item' },
          ],
          structuredContent: {
            received: {
              text: 'hello',
              ratio: 1.5,
              count: 7,
              enabled: false,
              mode: 'fast',
              tags: ['first', 'second'],
            },
            explicitFalse: false,
          },
          isError: false,
          _meta: { fixture: true, explicitFalse: false },
        },
      },
    });

    const nestedInput = {
      nested: { empty: '', unicode: 'λ', nil: null },
      values: [1, true, null, { deep: ['x'] }],
      'odd-name': { untouched: true },
    };
    const nested = await runSpawned([
      '--json',
      '--jq',
      '.data.result',
      'mcp',
      'call',
      projectServer,
      MCP_STDIO_COMPLEX_TOOL,
      '--input',
      JSON.stringify(nestedInput),
    ]);
    expect(JSON.parse(nested.stdout)).toMatchObject({
      structuredContent: {
        received: nestedInput,
        explicitFalse: false,
      },
      isError: false,
      _meta: { fixture: true, explicitFalse: false },
    });

    const callsBeforeMixedInput = fixture
      .captures()
      .filter(({ kind }) => kind === 'call');
    const mixed = await runSpawned(
      [
        'mcp',
        'call',
        projectServer,
        MCP_STDIO_COMPLEX_TOOL,
        '--input',
        JSON.stringify(nestedInput),
        '--text=must-not-call',
      ],
      2,
    );
    expect(mixed.stderr).toContain('cannot be combined');
    expect(fixture.captures().filter(({ kind }) => kind === 'call')).toEqual(
      callsBeforeMixedInput,
    );

    expect(
      fixture
        .captures()
        .filter(({ kind }) => kind === 'call')
        .map(({ name, arguments: args }) => ({ name, arguments: args })),
    ).toEqual([
      {
        name: MCP_STDIO_PRIMITIVE_TOOL,
        arguments: {
          text: 'hello',
          ratio: 1.5,
          count: 7,
          enabled: false,
          mode: 'fast',
          tags: ['first', 'second'],
        },
      },
      { name: MCP_STDIO_COMPLEX_TOOL, arguments: nestedInput },
    ]);
  }, 30_000);

  test('preserves tool-level failures and rejects argv references before spawn', async () => {
    const failure = await runSpawned(
      [
        '--json',
        'mcp',
        'call',
        projectServer,
        MCP_STDIO_FAILURE_TOOL,
      ],
      1,
    );
    expect(JSON.parse(failure.stdout)).toEqual({
      success: false,
      command: 'mcp call',
      data: {
        destination: { kind: 'project' },
        server: projectServer,
        tool: MCP_STDIO_FAILURE_TOOL,
        result: {
          content: [
            { type: 'text', text: 'fixture tool failure' },
            {
              type: 'resource_link',
              uri: 'file:///stdio-fixture/failure.json',
              name: 'failure details',
              mimeType: 'application/json',
            },
          ],
          structuredContent: { reason: 'requested', explicitFalse: false },
          isError: true,
          _meta: { fixture: true, failure: true },
        },
      },
    });

    const exitCount = fixture.exits().length;
    const environmentCount = fixture.environments().length;
    const captureCount = fixture.captures().length;
    const rejected = await runCli([
      '--json',
      'mcp',
      'tools',
      rejectedServer,
    ]);
    expect(rejected.exitCode).toBe(1);
    expectNoSecretLeak(rejected);
    expect(JSON.parse(rejected.stdout)).toMatchObject({
      success: false,
      command: 'mcp tools',
      error: expect.stringContaining(
        'MCP argument 2 is an environment reference',
      ),
    });
    expect(fixture.exits()).toHaveLength(exitCount);
    expect(fixture.environments()).toHaveLength(environmentCount);
    expect(fixture.captures()).toHaveLength(captureCount);
  }, 30_000);

  test('waits for stdio cleanup after the first interrupt', async () => {
    const cliEntry = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');
    const previousCaptureCount = fixture.captures().length;
    const previousExitCount = fixture.exits().length;
    const proc = Bun.spawn(
      ['bun', 'run', cliEntry, '--json', 'mcp', 'tools', hangingServer],
      {
        cwd: workspaceDir,
        env: {
          ...process.env,
          ...fixture.parentEnvironment,
          HOME: homeDir,
          USERPROFILE: homeDir,
          ALLAGENTS_TEST_HOME: homeDir,
          XDG_CONFIG_HOME: join(homeDir, '.config'),
          XDG_CACHE_HOME: join(homeDir, '.cache'),
          CI: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    await fixture.waitForCaptures(previousCaptureCount + 1);

    proc.kill('SIGINT');
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    expect(exitCode).toBe(130);
    expectNoSecretLeak({ exitCode, stdout, stderr });
    expect(JSON.parse(stdout)).toMatchObject({
      success: false,
      command: 'mcp tools',
      error: 'MCP operation was cancelled',
    });
    const exits = await fixture.waitForExits(previousExitCount + 1);
    expect(exits).toHaveLength(previousExitCount + 1);
  }, 15_000);
});
