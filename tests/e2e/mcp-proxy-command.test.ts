import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

function runCli(args: string[], env: Record<string, string> = {}) {
  const cliEntry = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');
  const proc = Bun.spawnSync(['bun', 'run', cliEntry, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stderr: 'pipe',
    stdout: 'pipe',
  });

  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

describe('mcp public command help', () => {
  test('lists setup and reauthentication without exposing the proxy helper', () => {
    const result = runCli(['mcp', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('- add - Add an MCP server');
    expect(result.stdout).toContain('- reauth - Reauthenticate a configured HTTP MCP server');
    expect(result.stdout).toContain('- tools - List tools exposed by an MCP server');
    expect(result.stdout).toContain('- call - Call a tool exposed by an MCP server');
    expect(result.stdout).not.toContain('- auth -');
    expect(result.stdout).not.toContain('- proxy -');
    expect(result.stdout).not.toContain('- proxy-stdio -');
  });

  test('keeps proxy hidden when help uses ANSI color', () => {
    const result = runCli(['mcp', '--help'], { FORCE_COLOR: '1' });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('Expose a remote HTTP MCP server locally over stdio');
  });

  test('exposes runtime commands in structured group help while proxy stays hidden', () => {
    const result = runCli(['mcp', '--help', '--json']);

    expect(result.exitCode).toBe(0);
    const commands = JSON.parse(result.stdout).commands as Array<{
      command: string;
    }>;
    expect(commands.map(({ command }) => command)).toContain('mcp tools');
    expect(commands.map(({ command }) => command)).toContain('mcp call');
    expect(commands.map(({ command }) => command)).not.toContain('mcp proxy');
  });

  test('keeps generic runtime help offline and structured', () => {
    const bareCall = runCli(['mcp', 'call', '--help', '--json']);
    const partialCall = runCli([
      'mcp',
      'call',
      'not-configured',
      '--help',
      '--json',
    ]);
    const tools = runCli(['mcp', 'tools', '--help', '--json']);

    for (const result of [bareCall, partialCall, tools]) {
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
    }
    expect(JSON.parse(bareCall.stdout)).toMatchObject({
      command: 'mcp call',
      description: 'Call a tool exposed by an MCP server',
    });
    expect(JSON.parse(partialCall.stdout).command).toBe('mcp call');
    expect(JSON.parse(tools.stdout).command).toBe('mcp tools');
  });

  test('exposes complete leaf context for add and reauth', () => {
    const addResult = runCli(['mcp', 'add', '--help', '--json']);
    const reauthResult = runCli(['--json', 'mcp', 'reauth', '-h']);

    expect(addResult.exitCode).toBe(0);
    expect(JSON.parse(addResult.stdout)).toMatchObject({
      command: 'mcp add',
      description: expect.any(String),
      when_to_use: expect.any(String),
      expected_output: expect.stringContaining('reconciles installed clients'),
      interaction: 'conditional',
      positionals: expect.arrayContaining([
        expect.objectContaining({ name: 'name', required: true }),
        expect.objectContaining({ name: 'commandOrUrl', required: true }),
      ]),
      options: expect.arrayContaining([
        expect.objectContaining({ flag: '--scope' }),
        expect.objectContaining({ flag: '--profile' }),
      ]),
      examples: expect.arrayContaining([
        expect.stringContaining('allagents mcp add'),
      ]),
      output_schema: expect.objectContaining({
        destination: expect.any(Object),
        name: 'string',
      }),
      json_fields: ['destination', 'name', 'config', 'mcpResults', 'sync'],
    });
    expect(reauthResult.exitCode).toBe(0);
    expect(JSON.parse(reauthResult.stdout)).toMatchObject({
      command: 'mcp reauth',
      interaction: 'required',
      expected_output: expect.stringContaining('Clears cached OAuth credentials'),
      json_fields: [],
    });
  });

  test('keeps exact bare command help human-readable', () => {
    const result = runCli(['mcp', 'add', '--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Add an MCP server');
    expect(result.stdout).toContain('--arg');
    expect(result.stdout).not.toContain('"when_to_use"');
  });

  test('resolves structured help from the longest command prefix', () => {
    const positionalResult = runCli([
      'skill',
      'search',
      'terraform',
      '--help',
      '--json',
    ]);
    const optionResult = runCli([
      'mcp',
      'list',
      '--scope',
      'user',
      '--help',
      '--json',
    ]);

    expect(positionalResult.exitCode).toBe(0);
    expect(JSON.parse(positionalResult.stdout)).toMatchObject({
      command: 'skill search',
      positionals: [{ name: 'query', required: true }],
      output_schema: { total: 'number' },
    });
    expect(optionResult.exitCode).toBe(0);
    expect(JSON.parse(optionResult.stdout).command).toBe('mcp list');
  });

  test('applies jq to the existing bare structured-help value', () => {
    const result = runCli(['--help', '--json', '--jq', '.name']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('"allagents"');
  });

  test('progressively discloses workspace commands and nested repo commands', () => {
    const groupResult = runCli(['workspace', '--help', '--json']);
    const repoGroupResult = runCli([
      'workspace',
      'repo',
      '--help',
      '--json',
    ]);
    const repoResult = runCli([
      'workspace',
      'repo',
      'add',
      '../project',
      '--help',
      '--json',
    ]);

    expect(groupResult.exitCode).toBe(0);
    const group = JSON.parse(groupResult.stdout) as {
      commands: Array<{
        command: string;
        kind: 'command' | 'group';
        help_command: string;
      }>;
    };
    expect(group.commands).toEqual([
      expect.objectContaining({ command: 'workspace init', kind: 'command' }),
      expect.objectContaining({ command: 'workspace setup', kind: 'command' }),
      expect.objectContaining({ command: 'workspace sync', kind: 'command' }),
      expect.objectContaining({ command: 'workspace status', kind: 'command' }),
      expect.objectContaining({ command: 'workspace prune', kind: 'command' }),
      expect.objectContaining({
        command: 'workspace repo',
        kind: 'group',
        help_command: 'allagents workspace repo --help --json',
      }),
    ]);
    for (const command of group.commands) {
      expect(command.help_command).toBe(
        `allagents ${command.command} --help --json`,
      );
    }
    expect(repoGroupResult.exitCode).toBe(0);
    const repoGroup = JSON.parse(repoGroupResult.stdout) as {
      commands: Array<{ command: string; help_command: string }>;
    };
    expect(repoGroup.commands.map(({ command }) => command)).toEqual([
      'workspace repo add',
      'workspace repo remove',
      'workspace repo list',
    ]);
    for (const command of repoGroup.commands) {
      expect(command.help_command).toBe(
        `allagents ${command.command} --help --json`,
      );
    }
    expect(repoResult.exitCode).toBe(0);
    expect(JSON.parse(repoResult.stdout)).toMatchObject({
      command: 'workspace repo add',
      positionals: [{ name: 'path', required: true }],
      output_schema: { repo: 'string | null' },
      expected_output: expect.any(String),
      interaction: 'none',
    });
  });

  test('covers canonical and compatibility skill command paths', () => {
    const pluginGroupResult = runCli([
      'plugin',
      'skills',
      '--help',
      '--json',
    ]);
    const pluginLeafResult = runCli([
      'plugin',
      'skills',
      'list',
      '--help',
      '--json',
    ]);
    const pluralAliasResult = runCli(['skills', 'list', '--help', '--json']);

    expect(pluginGroupResult.exitCode).toBe(0);
    const pluginGroup = JSON.parse(pluginGroupResult.stdout) as {
      commands: Array<{ command: string }>;
    };
    expect(pluginGroup.commands.map(({ command }) => command)).toEqual([
      'plugin skills list',
      'plugin skills add',
      'plugin skills remove',
      'plugin skills search',
      'plugin skills update',
    ]);
    expect(pluginLeafResult.exitCode).toBe(0);
    expect(JSON.parse(pluginLeafResult.stdout).command).toBe(
      'plugin skills list',
    );
    expect(pluralAliasResult.exitCode).toBe(0);
    expect(JSON.parse(pluralAliasResult.stdout).command).toBe('skill list');
  });

  test('does not treat a registered string option value as structured help', () => {
    const result = runCli(['mcp', 'add', '--arg', '--help', '--json']);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('"when_to_use"');
  });

  test('does not treat positional help after -- as structured help', () => {
    const result = runCli(['--json', 'mcp', 'add', '--', '--help']);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('"when_to_use"');
  });

  test('exposes a concise root index before group and leaf details', () => {
    const result = runCli(['--help', '--json']);

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      name: string;
      commands: Array<{
        command: string;
        kind: 'command' | 'group';
        help_command: string;
        options?: unknown;
        output_schema?: unknown;
      }>;
    };
    expect(parsed.name).toBe('allagents');
    expect(parsed.commands.map(({ command }) => command)).toEqual([
      'init',
      'update',
      'status',
      'workspace',
      'mcp',
      'plugin',
      'skill',
      'self',
      'profile',
    ]);
    expect(parsed.commands).toContainEqual(
      expect.objectContaining({
        command: 'mcp',
        kind: 'group',
        help_command: 'allagents mcp --help --json',
      }),
    );
    for (const command of parsed.commands) {
      expect(command.help_command).toBe(
        `allagents ${command.command} --help --json`,
      );
      expect(command.options).toBeUndefined();
      expect(command.output_schema).toBeUndefined();
    }
  });

  test('rejects field selection for structured JSON help', () => {
    const result = runCli(['mcp', 'add', '--help', '--json=command']);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(
      '--json=<fields> is not supported with --help; use --json',
    );
  });

  test('rejects proxy-stdio after the rename', () => {
    const result = runCli(['mcp', 'proxy-stdio']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Not a valid subcommand name');
  });
});
