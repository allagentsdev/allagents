import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { watch } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CliOptions {
  gitConfig?: string;
  json?: boolean;
  gitWrapperDir?: string;
  tracePath?: string;
  extraEnv?: Record<string, string>;
}

const decoder = new TextDecoder();
const cliEntry = join(import.meta.dir, '..', '..', 'dist', 'index.js');

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function withDeadline<T>(source: Promise<T>, message: string): Promise<T> {
  const signal = AbortSignal.timeout(5_000);
  const deadline = Promise.withResolvers<T>();
  const rejectOnTimeout = () => deadline.reject(new Error(message));
  signal.addEventListener('abort', rejectOnTimeout, { once: true });
  source.then(
    (value) => {
      signal.removeEventListener('abort', rejectOnTimeout);
      deadline.resolve(value);
    },
    (error) => {
      signal.removeEventListener('abort', rejectOnTimeout);
      deadline.reject(error);
    },
  );
  return deadline.promise;
}

async function waitForFile(path: string): Promise<void> {
  if (existsSync(path)) return;
  const signal = AbortSignal.timeout(5_000);
  const changes = watch(dirname(path), { signal });
  if (existsSync(path)) return;
  try {
    for await (const _change of changes) {
      if (existsSync(path)) return;
    }
  } catch (error) {
    if (existsSync(path)) return;
    throw error;
  }
}

function cliEnv(
  homeDir: string,
  options: CliOptions = {},
): Record<string, string> {
  return {
    ...process.env,
    ALLAGENTS_TEST_HOME: homeDir,
    HOME: homeDir,
    USERPROFILE: homeDir,
    XDG_CONFIG_HOME: join(homeDir, '.config'),
    GIT_TERMINAL_PROMPT: '0',
    NO_COLOR: '1',
    ...(options.gitConfig && { GIT_CONFIG_GLOBAL: options.gitConfig }),
    ...(options.gitWrapperDir && {
      ALLAGENTS_TEST_REAL_GIT: Bun.which('git') ?? 'git',
      PATH: `${options.gitWrapperDir}:${process.env.PATH ?? ''}`,
    }),
    ...(options.tracePath && { GIT_TRACE2_EVENT: options.tracePath }),
    ...options.extraEnv,
  } as Record<string, string>;
}

beforeAll(() => {
  const build = Bun.spawnSync(['bun', 'run', 'build'], {
    cwd: join(import.meta.dir, '..', '..'),
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (build.exitCode !== 0) {
    throw new Error(
      `CLI build failed:\n${decoder.decode(build.stdout)}${decoder.decode(build.stderr)}`,
    );
  }
  if (!existsSync(cliEntry)) {
    throw new Error(`Built CLI not found at ${cliEntry}`);
  }
});

function runCli(
  workdir: string,
  homeDir: string,
  args: string[],
  options: CliOptions = {},
): CliResult {
  const proc = Bun.spawnSync(
    [cliEntry, ...(options.json === false ? [] : ['--json']), ...args],
    {
      cwd: workdir,
      env: cliEnv(homeDir, options),
      stderr: 'pipe',
      stdout: 'pipe',
    },
  );

  return {
    exitCode: proc.exitCode,
    stdout: decoder.decode(proc.stdout),
    stderr: decoder.decode(proc.stderr),
  };
}

async function runInteractiveCli(
  workdir: string,
  homeDir: string,
  args: string[],
  options: CliOptions = {},
): Promise<CliResult> {
  const command = `stty cols 160 rows 40; exec ${[cliEntry, ...args].map(shellQuote).join(' ')}`;
  const proc = Bun.spawn(['script', '-qefc', command, '/dev/null'], {
    cwd: workdir,
    env: cliEnv(homeDir, options),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  proc.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function runBlockedInteractiveCli(
  workdir: string,
  homeDir: string,
  args: string[],
  sourceLine: string,
  enteredPath: string,
  releasePath: string,
  options: CliOptions = {},
  nextBoundary?: {
    enteredPath: string;
    releasePath: string;
    sourceOccurrences: number;
  },
): Promise<{
  beforeRelease: string;
  beforeNextRelease?: string;
  result: CliResult;
}> {
  const command = `stty cols 160 rows 40; exec ${[cliEntry, ...args].map(shellQuote).join(' ')}`;
  const proc = Bun.spawn(['script', '-qefc', command, '/dev/null'], {
    cwd: workdir,
    env: cliEnv(homeDir, options),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  proc.stdin.end();
  const stdoutReader = proc.stdout.getReader();
  const streamDecoder = new TextDecoder();
  let stdout = '';
  const sourceSeen = Promise.withResolvers<void>();
  const nextSourceSeen = Promise.withResolvers<void>();
  const readStdout = (async () => {
    while (true) {
      const { done, value } = await stdoutReader.read();
      if (done) break;
      stdout += streamDecoder.decode(value, { stream: true });
      if (stdout.includes(sourceLine)) sourceSeen.resolve();
      if (
        nextBoundary &&
        stdout.split(sourceLine).length - 1 >= nextBoundary.sourceOccurrences
      ) {
        nextSourceSeen.resolve();
      }
    }
    stdout += streamDecoder.decode();
  })();

  let beforeRelease = '';
  let observationError: unknown;
  try {
    await Promise.all([
      withDeadline(
        sourceSeen.promise,
        `Timed out waiting for streamed plugin output. Output: ${stdout}`,
      ),
      waitForFile(enteredPath),
    ]);
    beforeRelease = stdout;
  } catch (error) {
    observationError = error;
  } finally {
    writeFileSync(releasePath, '');
  }
  let beforeNextRelease: string | undefined;
  if (nextBoundary) {
    try {
      if (!observationError) {
        await Promise.all([
          withDeadline(
            nextSourceSeen.promise,
            `Timed out waiting for repeated plugin output. Output: ${stdout}`,
          ),
          waitForFile(nextBoundary.enteredPath),
        ]);
        beforeNextRelease = stdout;
      }
    } catch (error) {
      observationError ??= error;
    } finally {
      writeFileSync(nextBoundary.releasePath, '');
    }
  }

  const [exitCode, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
    readStdout,
  ]).then(([code, error]) => [code, error] as const);
  if (observationError) throw observationError;
  return {
    beforeRelease,
    ...(beforeNextRelease !== undefined && { beforeNextRelease }),
    result: { exitCode, stdout, stderr },
  };
}

function runGit(path: string, args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', path, ...args], {
    stderr: 'pipe',
    stdout: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed in ${path}: ${decoder.decode(result.stderr)}`,
    );
  }
  return decoder.decode(result.stdout).trim();
}

function countGitCommands(
  tracePath: string,
  command: string,
  source?: string,
): number {
  const events = readFileSync(tracePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event?: string; argv?: string[] });
  return events.filter((event) => {
    const invocation = event.argv?.join(' ') ?? '';
    return (
      (event.event === 'start' || event.event === 'child_start') &&
      event.argv?.some((argument) => argument === command) &&
      (!source || invocation.includes(source))
    );
  }).length;
}

function createRemoteMarketplace(rootDir: string): {
  gitConfig: string;
  gitWrapperDir: string;
  source: string;
} {
  const worktree = join(rootDir, 'remote-marketplace-work');
  const remote = join(rootDir, 'remote-marketplace.git');
  const gitConfig = join(rootDir, 'gitconfig');
  mkdirSync(worktree, { recursive: true });
  runGit(worktree, ['init']);
  runGit(worktree, ['checkout', '-b', 'main']);
  runGit(worktree, ['config', '--local', 'user.name', 'AllAgents E2E']);
  runGit(worktree, [
    'config',
    '--local',
    'user.email',
    'allagents@example.test',
  ]);
  mkdirSync(join(worktree, '.claude-plugin'), { recursive: true });
  mkdirSync(join(worktree, 'plugins', 'demo', 'skills', 'demo'), {
    recursive: true,
  });
  writeFileSync(
    join(worktree, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'remote-marketplace',
      plugins: [{ name: 'demo', source: './plugins/demo' }],
    }),
  );
  writeFileSync(
    join(worktree, 'plugins', 'demo', 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: Demo skill\n---\n# Remote demo\n',
  );
  runGit(worktree, ['add', '.']);
  runGit(worktree, ['commit', '-m', 'fixture v1']);
  runGit(rootDir, ['init', '--bare', remote]);
  runGit(worktree, ['remote', 'add', 'origin', remote]);
  runGit(worktree, ['push', '-u', 'origin', 'main']);
  runGit(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  writeFileSync(
    gitConfig,
    `[protocol "file"]\n\tallow = always\n[url "file://${remote}"]\n\tinsteadOf = https://github.com/uat/plugin-marketplace.git\n`,
  );
  const gitWrapperDir = join(rootDir, 'bin');
  mkdirSync(gitWrapperDir, { recursive: true });
  const gitWrapper = join(gitWrapperDir, 'git');
  writeFileSync(
    gitWrapper,
    `#!/bin/sh\ncase " $* " in\n  *" ls-remote "*)\n    if [ -n "$ALLAGENTS_TEST_GIT_BLOCK_ENTERED" ]; then\n      : > "$ALLAGENTS_TEST_GIT_BLOCK_ENTERED"\n      while [ ! -f "$ALLAGENTS_TEST_GIT_BLOCK_RELEASE" ]; do sleep 0.02; done\n    fi\n    exec "$ALLAGENTS_TEST_REAL_GIT" -c "url.file://${remote}.insteadOf=https://github.com/uat/plugin-marketplace.git" "$@"\n    ;;\nesac\nexec "$ALLAGENTS_TEST_REAL_GIT" "$@"\n`,
  );
  chmodSync(gitWrapper, 0o755);
  return {
    gitConfig,
    gitWrapperDir,
    source: 'https://github.com/uat/plugin-marketplace',
  };
}

function createBlockingClaudeWrapper(
  rootDir: string,
  pluginIdentity = 'demo@project-marketplace',
): string {
  const wrapperDir = join(rootDir, 'claude-bin');
  mkdirSync(wrapperDir, { recursive: true });
  const wrapper = join(wrapperDir, 'claude');
  writeFileSync(
    wrapper,
    [
      '#!/bin/sh',
      'case " $* " in',
      '  *" --version "*)',
      '    : > "$ALLAGENTS_TEST_NATIVE_BLOCK_ENTERED"',
      '    while [ ! -f "$ALLAGENTS_TEST_NATIVE_BLOCK_RELEASE" ]; do sleep 0.02; done',
      '    printf "%s\\n" "claude 1.0.0"',
      '    exit 0',
      '    ;;',
      `  *" plugin list --json "*) printf "%s\\n" '{"installed":[{"id":"${pluginIdentity}","scope":"project","enabled":true}]}'; exit 0 ;;`,
      `  *" plugin install ${pluginIdentity} "*) mkdir -p .claude; exit 0 ;;`,
      'esac',
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(wrapper, 0o755);
  return wrapperDir;
}
describe('plugin update e2e', () => {
  let rootDir: string;
  let workspaceDir: string;
  let marketplaceDir: string;
  let homeDir: string;

  beforeEach(() => {
    rootDir = join(
      tmpdir(),
      `allagents-e2e-plugin-update-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    workspaceDir = join(rootDir, 'workspace');
    marketplaceDir = join(rootDir, 'marketplace');
    homeDir = join(rootDir, 'home');

    mkdirSync(join(workspaceDir, '.allagents'), { recursive: true });
    mkdirSync(join(marketplaceDir, '.claude-plugin'), { recursive: true });
    mkdirSync(join(marketplaceDir, 'plugins', 'demo', 'skills', 'demo'), { recursive: true });
    mkdirSync(homeDir, { recursive: true });

    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      'repositories: []\nplugins: []\nclients:\n  - claude\nversion: 2\n',
      'utf-8',
    );
    writeFileSync(
      join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'project-marketplace',
        description: 'Project marketplace update fixture',
        plugins: [
          {
            name: 'demo',
            description: 'Demo plugin',
            source: './plugins/demo',
          },
        ],
      }),
      'utf-8',
    );
    writeFileSync(
      join(marketplaceDir, 'plugins', 'demo', 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: Demo skill\n---\n# Demo\n',
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  test('updates a plugin from a project-scoped marketplace', () => {
    const addResult = runCli(workspaceDir, homeDir, [
      'plugin',
      'marketplace',
      'add',
      marketplaceDir,
      '--scope',
      'project',
    ]);
    expect(addResult.exitCode).toBe(0);

    const installResult = runCli(workspaceDir, homeDir, [
      'plugin',
      'install',
      'demo@project-marketplace',
      '--scope',
      'project',
    ]);
    expect(installResult.exitCode).toBe(0);

    const updateResult = runCli(workspaceDir, homeDir, [
      'plugin',
      'update',
      'demo@project-marketplace',
      '--scope',
      'project',
    ]);

    expect(updateResult.exitCode).toBe(0);
    expect(updateResult.stdout).not.toContain(
      'Updating demo@project-marketplace...',
    );
    const payload = JSON.parse(updateResult.stdout);
    expect(payload.success).toBe(true);
    expect(payload.data.results).toEqual([
      {
        plugin: 'demo@project-marketplace',
        success: true,
        action: 'updated',
      },
    ]);

    const redirectedResult = runCli(
      workspaceDir,
      homeDir,
      ['plugin', 'update', '--scope', 'project'],
      { json: false },
    );
    expect(redirectedResult.exitCode).toBe(0);
    expect(redirectedResult.stderr).toBe('');
    expect(redirectedResult.stdout).toStartWith('Updating plugins...\n\n');
    expect(redirectedResult.stdout).not.toContain(
      'Updating demo@project-marketplace...',
    );
    expect(redirectedResult.stdout.indexOf('✓ demo@project-marketplace')).toBeGreaterThan(
      redirectedResult.stdout.indexOf('Updating workspace...'),
    );
    const redirectedSpecificResult = runCli(
      workspaceDir,
      homeDir,
      [
        'plugin',
        'update',
        'demo@project-marketplace',
        '--scope',
        'project',
      ],
      { json: false },
    );
    expect(redirectedSpecificResult.stdout).toStartWith(
      'Updating plugin: demo@project-marketplace...\n\n',
    );
  }, 15_000);

  test('keeps pseudo-TTY JSON output to one document without lifecycle text', async () => {
    const result = await runInteractiveCli(workspaceDir, homeDir, [
      '--json',
      'plugin',
      'update',
      '--scope',
      'project',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('Updating plugin');
    expect(result.stdout).not.toContain('Update complete:');
    expect(JSON.parse(result.stdout)).toEqual({
      success: true,
      command: 'plugin update',
      data: { results: [], updated: 0, skipped: 0, failed: 0 },
    });
  });

  test('scopes equivalent formatted identities in progressive output', async () => {
    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      [
        'repositories: []',
        'plugins:',
        "  - 'gh:uat/plugin-marketplace'",
        'clients:',
        '  - codex',
        'version: 2',
        '',
      ].join('\n'),
    );
    mkdirSync(join(homeDir, '.allagents'), { recursive: true });
    writeFileSync(
      join(homeDir, '.allagents', 'workspace.yaml'),
      [
        'repositories: []',
        'plugins:',
        '  - uat/plugin-marketplace',
        'clients:',
        '  - codex',
        'version: 2',
        '',
      ].join('\n'),
    );

    const result = await runInteractiveCli(workspaceDir, homeDir, [
      'plugin',
      'update',
      '--scope',
      'all',
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(
      result.stdout
        .replaceAll('\r', '')
        .split('\n')
        .filter((line) => line.startsWith('Updating uat/plugin-marketplace')),
    ).toEqual([
      'Updating uat/plugin-marketplace (project)...',
      'Updating uat/plugin-marketplace (user)...',
    ]);
  });

  test('keeps direct marketplace update JSON free of internal fields', () => {
    const addResult = runCli(workspaceDir, homeDir, [
      'plugin',
      'marketplace',
      'add',
      marketplaceDir,
      '--scope',
      'project',
    ]);
    expect(addResult.exitCode).toBe(0);

    const updateResult = runCli(workspaceDir, homeDir, [
      'plugin',
      'marketplace',
      'update',
      'project-marketplace',
    ]);

    expect(updateResult.exitCode).toBe(0);
    expect(JSON.parse(updateResult.stdout)).toEqual({
      success: true,
      command: 'plugin marketplace update',
      data: {
        results: [
          {
            name: 'project-marketplace',
            success: true,
          },
        ],
        succeeded: 1,
        failed: 0,
      },
    });
  }, 10_000);
  test('keeps user-scoped marketplace updates isolated from the workspace', () => {
    const addResult = runCli(workspaceDir, homeDir, [
      'plugin',
      'marketplace',
      'add',
      marketplaceDir,
      '--scope',
      'user',
    ]);
    expect(addResult.exitCode).toBe(0);

    const installResult = runCli(workspaceDir, homeDir, [
      'plugin',
      'install',
      'demo@project-marketplace',
      '--scope',
      'user',
    ]);
    expect(installResult.exitCode).toBe(0);

    const updateResult = runCli(workspaceDir, homeDir, [
      'plugin',
      'update',
      'demo@project-marketplace',
      '--scope',
      'user',
    ]);

    expect(updateResult.exitCode).toBe(0);
    const payload = JSON.parse(updateResult.stdout);
    expect(payload.success).toBe(true);
    expect(payload.data.results[0]).toEqual({
      plugin: 'demo@project-marketplace',
      success: true,
      action: 'updated',
    });
  }, 15_000);

  test(
    'updates the same plugin independently when installed in both scopes',
    () => {
      for (const scope of ['user', 'project']) {
        const addResult = runCli(workspaceDir, homeDir, [
          'plugin',
          'marketplace',
          'add',
          marketplaceDir,
          '--scope',
          scope,
        ]);
        expect(addResult.exitCode).toBe(0);

        const installResult = runCli(workspaceDir, homeDir, [
          'plugin',
          'install',
          'demo@project-marketplace',
          '--scope',
          scope,
        ]);
        expect(installResult.exitCode).toBe(0);
      }

      const updateResult = runCli(workspaceDir, homeDir, [
        'plugin',
        'update',
        'demo@project-marketplace',
        '--scope',
        'all',
      ]);

      expect(updateResult.exitCode).toBe(0);
      const payload = JSON.parse(updateResult.stdout);
      expect(payload.success).toBe(true);
      expect(payload.data.results).toHaveLength(2);
      expect(payload.data.results).toEqual([
        {
          plugin: 'demo@project-marketplace',
          success: true,
          action: 'updated',
        },
        {
          plugin: 'demo@project-marketplace',
          success: true,
          action: 'updated',
        },
      ]);
    },
    20_000,
  );

  test(
    'deduplicates embedded marketplace checks across plugin update scopes',
    () => {
      const remote = createRemoteMarketplace(rootDir);
      const addResult = runCli(
        workspaceDir,
        homeDir,
        [
          'plugin',
          'marketplace',
          'add',
          remote.source,
          '--scope',
          'user',
        ],
        { gitConfig: remote.gitConfig },
      );
      expect(addResult.exitCode).toBe(0);
      for (const scope of ['user', 'project']) {
        const installResult = runCli(
          workspaceDir,
          homeDir,
          [
            'plugin',
            'install',
            'demo@remote-marketplace',
            '--scope',
            scope,
          ],
          { gitConfig: remote.gitConfig },
        );
        expect(installResult.exitCode).toBe(0);
      }

      const registryPath = join(
        homeDir,
        '.allagents',
        'marketplaces.json',
      );
      const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
      const entry = registry.marketplaces['remote-marketplace'];
      entry.lastUpdated = '2000-01-01T00:00:00.000Z';
      writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
      runGit(entry.path, [
        'remote',
        'set-url',
        'origin',
        'https://github.com/uat/plugin-marketplace.git',
      ]);
      const cacheHead = runGit(entry.path, ['rev-parse', 'HEAD']);
      const tracePath = join(rootDir, 'plugin-update-all-noop-trace.jsonl');

      const updateResult = runCli(
        workspaceDir,
        homeDir,
        ['plugin', 'update', 'demo@remote-marketplace', '--scope', 'all'],
        {
          gitWrapperDir: remote.gitWrapperDir,
          tracePath,
        },
      );

      expect(updateResult).toMatchObject({ exitCode: 0 });
      expect(updateResult.stderr).toBe('');
      expect(JSON.parse(updateResult.stdout)).toMatchObject({
        success: true,
        command: 'plugin update',
        data: {
          results: [
            {
              plugin: 'demo@remote-marketplace',
              success: true,
              action: 'updated',
            },
            {
              plugin: 'demo@remote-marketplace',
              success: true,
              action: 'updated',
            },
          ],
          updated: 2,
          skipped: 0,
          failed: 0,
          syncResults: {
            project: { failed: 0 },
            user: { failed: 0 },
          },
        },
      });
      expect(
        countGitCommands(
          tracePath,
          'ls-remote',
          'https://github.com/uat/plugin-marketplace.git',
        ),
      ).toBe(1);
      expect(countGitCommands(tracePath, 'pull')).toBe(2);
      expect(countGitCommands(tracePath, 'fetch')).toBe(4);
      expect(countGitCommands(tracePath, 'clone')).toBe(0);

      const updatedRegistry = JSON.parse(readFileSync(registryPath, 'utf8'));
      const updatedEntry =
        updatedRegistry.marketplaces['remote-marketplace'];
      expect(updatedEntry.lastUpdated).not.toBe(
        '2000-01-01T00:00:00.000Z',
      );
      expect(runGit(updatedEntry.path, ['rev-parse', 'HEAD'])).toBe(
        cacheHead,
      );
    },
    15_000,
  );

  test(
    'streams scoped ordinary declarations in start/result order before blocked Git completes',
    async () => {
      const remote = createRemoteMarketplace(rootDir);
      const addResult = runCli(
        workspaceDir,
        homeDir,
        [
          'plugin',
          'marketplace',
          'add',
          remote.source,
          '--scope',
          'user',
        ],
        { gitConfig: remote.gitConfig },
      );
      expect(addResult.exitCode).toBe(0);
      for (const pluginScope of ['project', 'user']) {
        const installResult = runCli(
          workspaceDir,
          homeDir,
          [
            'plugin',
            'install',
            'demo@remote-marketplace',
            '--scope',
            pluginScope,
          ],
          { gitConfig: remote.gitConfig },
        );
        expect(installResult.exitCode).toBe(0);
      }

      const registryPath = join(homeDir, '.allagents', 'marketplaces.json');
      const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
      const entry = registry.marketplaces['remote-marketplace'];
      entry.lastUpdated = '2000-01-01T00:00:00.000Z';
      writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
      runGit(entry.path, [
        'remote',
        'set-url',
        'origin',
        'https://github.com/uat/plugin-marketplace.git',
      ]);
      const enteredPath = join(rootDir, 'plugin-update-entered');
      const releasePath = join(rootDir, 'plugin-update-release');
      const sourceLine = 'Updating demo@remote-marketplace (project)...';

      const { beforeRelease, result } = await runBlockedInteractiveCli(
        workspaceDir,
        homeDir,
        ['plugin', 'update', '--scope', 'all'],
        sourceLine,
        enteredPath,
        releasePath,
        {
          gitConfig: remote.gitConfig,
          gitWrapperDir: remote.gitWrapperDir,
          extraEnv: {
            ALLAGENTS_TEST_GIT_BLOCK_ENTERED: enteredPath,
            ALLAGENTS_TEST_GIT_BLOCK_RELEASE: releasePath,
          },
        },
      );

      expect(beforeRelease).toContain(sourceLine);
      expect(beforeRelease).not.toContain(
        '✓ demo@remote-marketplace (updated)',
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toContain('Updating workspace...');
      expect(result.stdout).not.toContain(
        'Plugin: demo@remote-marketplace',
      );
      const lifecycleLines = result.stdout
        .replaceAll('\r', '')
        .split('\n')
        .filter(
          (line) =>
            line.startsWith('Updating demo@remote-marketplace') ||
            line === '✓ demo@remote-marketplace (updated)',
        );
      expect(lifecycleLines).toEqual([
        'Updating demo@remote-marketplace (project)...',
        '✓ demo@remote-marketplace (updated)',
        'Updating demo@remote-marketplace (user)...',
        '✓ demo@remote-marketplace (updated)',
      ]);
      expect(result.stdout.lastIndexOf('Update complete:')).toBeGreaterThan(
        result.stdout.lastIndexOf('✓ demo@remote-marketplace (updated)'),
      );
    },
    20_000,
  );

  test(
    'keeps one source status across mixed native and ordinary boundaries',
    async () => {
      const remote = createRemoteMarketplace(rootDir);
      const addResult = runCli(
        workspaceDir,
        homeDir,
        [
          'plugin',
          'marketplace',
          'add',
          remote.source,
          '--scope',
          'user',
        ],
        { gitConfig: remote.gitConfig },
      );
      expect(addResult.exitCode).toBe(0);
      const installResult = runCli(
        workspaceDir,
        homeDir,
        [
          'plugin',
          'install',
          'demo@remote-marketplace',
          '--scope',
          'project',
        ],
        { gitConfig: remote.gitConfig },
      );
      expect(installResult.exitCode).toBe(0);
      writeFileSync(
        join(workspaceDir, '.allagents', 'workspace.yaml'),
        [
          'repositories: []',
          'plugins:',
          '  - demo@remote-marketplace',
          'clients:',
          '  - codex',
          '  - name: claude',
          '    install: native',
          'version: 2',
          '',
        ].join('\n'),
      );

      const registryPath = join(homeDir, '.allagents', 'marketplaces.json');
      const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
      const entry = registry.marketplaces['remote-marketplace'];
      entry.lastUpdated = '2000-01-01T00:00:00.000Z';
      writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
      runGit(entry.path, [
        'remote',
        'set-url',
        'origin',
        'https://github.com/uat/plugin-marketplace.git',
      ]);

      const nativeWrapper = createBlockingClaudeWrapper(
        rootDir,
        'demo@remote-marketplace',
      );
      const nativeEntered = join(rootDir, 'mixed-native-entered');
      const nativeRelease = join(rootDir, 'mixed-native-release');
      const gitEntered = join(rootDir, 'mixed-git-entered');
      const gitRelease = join(rootDir, 'mixed-git-release');
      const sourceLine = 'Updating demo@remote-marketplace...';
      const { beforeRelease, beforeNextRelease, result } =
        await runBlockedInteractiveCli(
          workspaceDir,
          homeDir,
          [
            'plugin',
            'update',
            'demo@remote-marketplace',
            '--scope',
            'project',
          ],
          sourceLine,
          nativeEntered,
          nativeRelease,
          {
            gitConfig: remote.gitConfig,
            gitWrapperDir: remote.gitWrapperDir,
            extraEnv: {
              PATH: `${nativeWrapper}:${remote.gitWrapperDir}:${process.env.PATH ?? ''}`,
              ALLAGENTS_TEST_NATIVE_BLOCK_ENTERED: nativeEntered,
              ALLAGENTS_TEST_NATIVE_BLOCK_RELEASE: nativeRelease,
              ALLAGENTS_TEST_GIT_BLOCK_ENTERED: gitEntered,
              ALLAGENTS_TEST_GIT_BLOCK_RELEASE: gitRelease,
            },
          },
          {
            enteredPath: gitEntered,
            releasePath: gitRelease,
            sourceOccurrences: 1,
          },
        );

      expect(beforeRelease.split(sourceLine)).toHaveLength(2);
      expect(beforeNextRelease?.split(sourceLine)).toHaveLength(2);
      expect(beforeNextRelease).not.toContain(
        '✓ demo@remote-marketplace (updated)',
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(
        result.stdout
          .replaceAll('\r', '')
          .split('\n')
          .filter(
            (line) =>
              line === sourceLine ||
              line === '✓ demo@remote-marketplace (updated)',
          ),
      ).toEqual([
        sourceLine,
        '✓ demo@remote-marketplace (updated)',
      ]);
    },
    20_000,
  );

  test(
    'keeps a native-only result provisional until native reconciliation settles',
    async () => {
      const addResult = runCli(workspaceDir, homeDir, [
        'plugin',
        'marketplace',
        'add',
        marketplaceDir,
        '--scope',
        'project',
      ]);
      expect(addResult.exitCode).toBe(0);
      writeFileSync(
        join(workspaceDir, '.allagents', 'workspace.yaml'),
        [
          'repositories: []',
          'plugins:',
          '  - source: demo@project-marketplace',
          '    install: native',
          'clients:',
          '  - name: claude',
          '    install: native',
          'version: 2',
          '',
        ].join('\n'),
      );
      const wrapperDir = createBlockingClaudeWrapper(rootDir);
      const enteredPath = join(rootDir, 'native-update-entered');
      const releasePath = join(rootDir, 'native-update-release');
      const sourceLine = 'Updating demo@project-marketplace...';

      const { beforeRelease, result } = await runBlockedInteractiveCli(
        workspaceDir,
        homeDir,
        [
          'plugin',
          'update',
          'demo@project-marketplace',
          '--scope',
          'project',
        ],
        sourceLine,
        enteredPath,
        releasePath,
        {
          gitWrapperDir: wrapperDir,
          extraEnv: {
            ALLAGENTS_TEST_NATIVE_BLOCK_ENTERED: enteredPath,
            ALLAGENTS_TEST_NATIVE_BLOCK_RELEASE: releasePath,
          },
        },
      );

      expect(beforeRelease).toContain(sourceLine);
      expect(beforeRelease).not.toContain(
        '✓ demo@project-marketplace (updated)',
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout.split(sourceLine)).toHaveLength(2);
      expect(result.stdout).not.toContain('phase=update');
      expect(result.stdout).toContain(
        '✓ demo@project-marketplace (updated)',
      );
    },
    15_000,
  );

  test('keeps an ordinary typed result settled when later scope sync fails', async () => {
    const addResult = runCli(workspaceDir, homeDir, [
      'plugin',
      'marketplace',
      'add',
      marketplaceDir,
      '--scope',
      'project',
    ]);
    expect(addResult.exitCode).toBe(0);
    const installResult = runCli(workspaceDir, homeDir, [
      'plugin',
      'install',
      'demo@project-marketplace',
      '--scope',
      'project',
    ]);
    expect(installResult.exitCode).toBe(0);
    rmSync(join(marketplaceDir, 'plugins', 'demo'), {
      recursive: true,
      force: true,
    });

    const result = await runInteractiveCli(
      workspaceDir,
      homeDir,
      [
        'plugin',
        'update',
        'demo@project-marketplace',
        '--scope',
        'project',
      ],
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('Sync error:');
    const typedResult = '✓ demo@project-marketplace (updated)';
    expect(result.stdout.split(typedResult)).toHaveLength(2);
    expect(result.stdout).toContain(
      'Update complete: 1 updated, 0 skipped, 0 failed',
    );
  }, 15_000);

  test(
    'deduplicates no-op remote marketplace checks across registry consumers',
    () => {
      const remote = createRemoteMarketplace(rootDir);
      const addResult = runCli(
        workspaceDir,
        homeDir,
        [
          'plugin',
          'marketplace',
          'add',
          remote.source,
          '--scope',
          'user',
        ],
        { gitConfig: remote.gitConfig },
      );
      expect(addResult.exitCode).toBe(0);

      const registryPath = join(homeDir, '.allagents', 'marketplaces.json');
      const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
      const entry = registry.marketplaces['remote-marketplace'];
      registry.marketplaces['remote-marketplace-alias'] = {
        ...entry,
        lastUpdated: '2000-01-01T00:00:00.000Z',
      };
      entry.lastUpdated = '2000-01-01T00:00:00.000Z';
      writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
      const cachePath = entry.path as string;
      runGit(cachePath, [
        'remote',
        'set-url',
        'origin',
        'https://github.com/uat/plugin-marketplace.git',
      ]);
      const cacheHead = runGit(cachePath, ['rev-parse', 'HEAD']);
      const cacheSkillPath = join(
        cachePath,
        'plugins',
        'demo',
        'skills',
        'demo',
        'SKILL.md',
      );
      const cacheSkill = readFileSync(cacheSkillPath, 'utf8');
      const tracePath = join(rootDir, 'marketplace-noop-trace.jsonl');

      const updateResult = runCli(
        workspaceDir,
        homeDir,
        ['plugin', 'marketplace', 'update'],
        {
          gitWrapperDir: remote.gitWrapperDir,
          tracePath,
        },
      );

      expect(updateResult.exitCode).toBe(0);
      expect(updateResult.stderr).toBe('');
      expect(JSON.parse(updateResult.stdout)).toEqual({
        success: true,
        command: 'plugin marketplace update',
        data: {
          results: [
            { name: 'remote-marketplace', success: true },
            { name: 'remote-marketplace', success: true },
          ],
          succeeded: 2,
          failed: 0,
        },
      });
      expect(
        countGitCommands(
          tracePath,
          'ls-remote',
          'https://github.com/uat/plugin-marketplace.git',
        ),
      ).toBe(1);
      expect(countGitCommands(tracePath, 'pull')).toBe(0);
      expect(countGitCommands(tracePath, 'fetch')).toBe(0);
      expect(countGitCommands(tracePath, 'clone')).toBe(0);

      const updatedRegistry = JSON.parse(readFileSync(registryPath, 'utf8'));
      expect(
        updatedRegistry.marketplaces['remote-marketplace'].lastUpdated,
      ).not.toBe('2000-01-01T00:00:00.000Z');
      expect(
        updatedRegistry.marketplaces['remote-marketplace-alias'].lastUpdated,
      ).not.toBe('2000-01-01T00:00:00.000Z');
      expect(runGit(cachePath, ['rev-parse', 'HEAD'])).toBe(cacheHead);
      expect(runGit(cachePath, ['status', '--porcelain'])).toBe('');
      expect(readFileSync(cacheSkillPath, 'utf8')).toBe(cacheSkill);

      const humanResult = runCli(
        workspaceDir,
        homeDir,
        ['plugin', 'marketplace', 'update'],
        {
          gitWrapperDir: remote.gitWrapperDir,
          json: false,
        },
      );
      expect(humanResult.exitCode).toBe(0);
      expect(humanResult.stderr).toBe('');
      expect(humanResult.stdout).toBe(
        'Updating all marketplaces...\n\n' +
          '✓ remote-marketplace\n' +
          '✓ remote-marketplace\n\n' +
          'Updated: 2, Failed: 0\n',
      );
    },
    20_000,
  );
});
