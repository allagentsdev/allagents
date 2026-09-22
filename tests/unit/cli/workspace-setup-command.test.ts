import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cliEntry = join(import.meta.dir, '..', '..', '..', 'src', 'cli', 'index.ts');

/**
 * Every test in this file spawns the CLI, which spawns one fixture process per
 * setup command. A cold CI runner (Windows especially) needs well over bun's
 * 5s default budget, which produced intermittent `exitCode: null` failures.
 */
const CLI_TIMEOUT_MS = 30_000;

type SetupFixture =
  | string
  | {
      run: string;
      platforms?: NodeJS.Platform[];
      architectures?: NodeJS.Architecture[];
    };

function normalizeLines(output: string): string {
  return output.replaceAll('\r\n', '\n');
}

function fixtureCommand(root: string, name: string, source: string): string {
  const fixtureDir = join(root, 'fixtures');
  const fixturePath = join(fixtureDir, `${name}.cjs`);
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(fixturePath, source);
  const executable = process.execPath.replaceAll('\\', '/');
  const script = fixturePath.replaceAll('\\', '/');
  return `"${executable}" "${script}"`;
}

function runCli(
  cwd: string,
  args: string[],
  testRoot: string,
  json = true,
) {
  return Bun.spawnSync(
    ['bun', 'run', cliEntry, ...(json ? ['--json'] : []), ...args],
    {
      cwd,
      env: {
        ...process.env,
        ALLAGENTS_TEST_HOME: join(testRoot, 'home'),
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
}

function writeWorkspace(root: string, setup: SetupFixture[]): void {
  mkdirSync(join(root, '.allagents'), { recursive: true });
  writeFileSync(
    join(root, '.allagents', 'workspace.yaml'),
    [
      'repositories: []',
      'plugins: []',
      'clients: []',
      'setup:',
      ...setup.map((command) => `  - ${JSON.stringify(command)}`),
      '',
    ].join('\n'),
  );
}

describe('workspace setup command', () => {
  let testDir: string;
  const testDirs: string[] = [];

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `allagents-workspace-setup-${process.pid}-${Date.now()}`,
    );
    mkdirSync(testDir, { recursive: true });
    testDirs.push(testDir);
  });

  afterAll(() => {
    for (const directory of testDirs) {
      rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  });

  test('runs commands sequentially from the workspace root', () => {
    const commands = [
      fixtureCommand(
        testDir,
        'record-cwd',
        "require('node:fs').writeFileSync('setup.cwd', process.cwd());",
      ),
      fixtureCommand(
        testDir,
        'write-first',
        "const fs = require('node:fs'); if (!fs.existsSync('setup.cwd')) process.exit(2); fs.writeFileSync('setup.log', 'first');",
      ),
      fixtureCommand(
        testDir,
        'append-second',
        "const fs = require('node:fs'); if (fs.readFileSync('setup.log', 'utf8') !== 'first') process.exit(3); fs.appendFileSync('setup.log', '-second');",
      ),
    ];
    writeWorkspace(testDir, commands);

    const proc = runCli(testDir, ['workspace', 'setup'], testDir);

    expect(proc.exitCode).toBe(0);
    expect(normalizeLines(proc.stderr.toString())).toBe(
      commands.map((command) => `$ ${command}\n`).join(''),
    );
    expect(JSON.parse(proc.stdout.toString())).toEqual({
      success: true,
      command: 'workspace setup',
      data: {
        commands: commands.map((command) => ({
          command,
          status: 'succeeded',
          exitCode: 0,
          signal: null,
          reason: null,
        })),
      },
    });
    expect(readFileSync(join(testDir, 'setup.cwd'), 'utf8')).toBe(testDir);
    expect(readFileSync(join(testDir, 'setup.log'), 'utf8')).toBe(
      'first-second',
    );
  }, CLI_TIMEOUT_MS);

  test('shows each command before execution in normal mode', () => {
    const command = fixtureCommand(
      testDir,
      'write-output',
      "process.stdout.write('command-output\\n');",
    );
    writeWorkspace(testDir, [command]);

    const proc = runCli(testDir, ['workspace', 'setup'], testDir, false);

    expect(proc.exitCode).toBe(0);
    expect(normalizeLines(proc.stdout.toString())).toBe(
      `$ ${command}\ncommand-output\nSetup complete. 1 command(s) ran; 0 skipped.\n`,
    );
  }, CLI_TIMEOUT_MS);

  test('keeps JSON stdout deterministic when a command writes output', () => {
    const command = fixtureCommand(
      testDir,
      'write-output',
      "process.stdout.write('command-output\\n');",
    );
    writeWorkspace(testDir, [command]);

    const proc = runCli(testDir, ['workspace', 'setup'], testDir);

    expect(proc.exitCode).toBe(0);
    expect(normalizeLines(proc.stderr.toString())).toBe(
      `$ ${command}\ncommand-output\n`,
    );
    expect(JSON.parse(proc.stdout.toString())).toEqual({
      success: true,
      command: 'workspace setup',
      data: {
        commands: [
          {
            command,
            status: 'succeeded',
            exitCode: 0,
            signal: null,
            reason: null,
          },
        ],
      },
    });
  }, CLI_TIMEOUT_MS);

  test('stops after the first nonzero exit', () => {
    const commands = [
      fixtureCommand(
        testDir,
        'write-first',
        "require('node:fs').writeFileSync('setup.log', 'first');",
      ),
      fixtureCommand(testDir, 'fail', 'process.exit(7);'),
      fixtureCommand(
        testDir,
        'write-third',
        "require('node:fs').appendFileSync('setup.log', '-third');",
      ),
    ];
    writeWorkspace(testDir, commands);

    const proc = runCli(testDir, ['workspace', 'setup'], testDir);

    expect(proc.exitCode).toBe(1);
    expect(JSON.parse(proc.stdout.toString())).toEqual({
      success: false,
      command: 'workspace setup',
      data: {
        commands: [
          {
            command: commands[0],
            status: 'succeeded',
            exitCode: 0,
            signal: null,
            reason: null,
          },
          {
            command: commands[1],
            status: 'failed',
            exitCode: 7,
            signal: null,
            reason: null,
          },
        ],
      },
      error: `Setup command failed with exit code 7: ${commands[1]}`,
    });
    expect(readFileSync(join(testDir, 'setup.log'), 'utf8')).toBe('first');
  }, CLI_TIMEOUT_MS);

  test.skipIf(process.platform === 'win32')(
    'preserves partial results when a command is terminated by a signal',
    () => {
      const commands = [
        fixtureCommand(
          testDir,
          'write-first',
          "require('node:fs').writeFileSync('setup.log', 'first');",
        ),
        fixtureCommand(
          testDir,
          'terminate-shell',
          "process.kill(process.ppid, 'SIGTERM');",
        ),
        fixtureCommand(
          testDir,
          'write-third',
          "require('node:fs').appendFileSync('setup.log', '-third');",
        ),
      ];
      writeWorkspace(testDir, commands);

      const proc = runCli(testDir, ['workspace', 'setup'], testDir);

      expect(proc.exitCode).toBe(1);
      expect(JSON.parse(proc.stdout.toString())).toEqual({
        success: false,
        command: 'workspace setup',
        data: {
          commands: [
            {
              command: commands[0],
              status: 'succeeded',
              exitCode: 0,
              signal: null,
              reason: null,
            },
            {
              command: commands[1],
              status: 'failed',
              exitCode: null,
              signal: 'SIGTERM',
              reason: null,
            },
          ],
        },
        error: `Setup command terminated by signal SIGTERM: ${commands[1]}`,
      });
      expect(readFileSync(join(testDir, 'setup.log'), 'utf8')).toBe('first');
    },
    CLI_TIMEOUT_MS,
  );

  test('runs only commands matching the current platform and architecture', () => {
    const otherPlatform: NodeJS.Platform =
      process.platform === 'linux' ? 'win32' : 'linux';
    const otherArchitecture: NodeJS.Architecture =
      process.arch === 'x64' ? 'arm64' : 'x64';
    const skippedPlatform = fixtureCommand(
      testDir,
      'skipped-platform',
      "require('node:fs').writeFileSync('skipped-platform', 'ran');",
    );
    const matching = fixtureCommand(
      testDir,
      'matching',
      "require('node:fs').writeFileSync('matching', 'ran');",
    );
    const skippedArchitecture = fixtureCommand(
      testDir,
      'skipped-architecture',
      "require('node:fs').writeFileSync('skipped-architecture', 'ran');",
    );
    writeWorkspace(testDir, [
      { run: skippedPlatform, platforms: [otherPlatform] },
      {
        run: matching,
        platforms: [process.platform],
        architectures: [process.arch],
      },
      { run: skippedArchitecture, architectures: [otherArchitecture] },
    ]);

    const proc = runCli(testDir, ['workspace', 'setup'], testDir);

    expect(proc.exitCode).toBe(0);
    expect(existsSync(join(testDir, 'skipped-platform'))).toBe(false);
    expect(readFileSync(join(testDir, 'matching'), 'utf8')).toBe('ran');
    expect(existsSync(join(testDir, 'skipped-architecture'))).toBe(false);
    expect(JSON.parse(proc.stdout.toString()).data.commands).toEqual([
      {
        command: skippedPlatform,
        status: 'skipped',
        exitCode: null,
        signal: null,
        reason: `platform ${process.platform} does not match ${otherPlatform}`,
      },
      {
        command: matching,
        status: 'succeeded',
        exitCode: 0,
        signal: null,
        reason: null,
      },
      {
        command: skippedArchitecture,
        status: 'skipped',
        exitCode: null,
        signal: null,
        reason: `architecture ${process.arch} does not match ${otherArchitecture}`,
      },
    ]);
  }, CLI_TIMEOUT_MS);

  test('does not run setup commands during init or update', () => {
    const templateDir = join(testDir, 'template');
    const workspaceDir = join(testDir, 'workspace');
    const markerPath = join(testDir, 'setup-ran');
    const command = fixtureCommand(
      testDir,
      'write-marker',
      `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran');`,
    );
    writeWorkspace(templateDir, [command]);

    const init = runCli(
      testDir,
      [
        'workspace',
        'init',
        workspaceDir,
        '--from',
        join(templateDir, '.allagents', 'workspace.yaml'),
      ],
      testDir,
    );
    expect(init.exitCode).toBe(0);
    expect(existsSync(markerPath)).toBe(false);

    const update = runCli(workspaceDir, ['update'], testDir);
    expect(update.exitCode).toBe(0);
    expect(existsSync(markerPath)).toBe(false);
  }, CLI_TIMEOUT_MS);
});
