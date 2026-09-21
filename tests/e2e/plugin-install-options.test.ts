import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, load } from 'js-yaml';

const cliEntry = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');
let root: string;
let home: string;
let workspace: string;
let plugin: string;

async function runInstall(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const process = Bun.spawn(
    ['bun', 'run', cliEntry, '--json', 'plugin', 'install', plugin, ...args],
    {
      cwd: workspace,
      env: {
        ...globalThis.process.env,
        ALLAGENTS_TEST_HOME: home,
        HOME: home,
        USERPROFILE: home,
        NO_COLOR: '1',
        CI: '1',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function runInteractiveInstall(
  input: string,
  args: string[] = [
    '--scope',
    'project',
    '--client',
    'codex',
  ],
  waitFor = 'Install with this target?',
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const shellQuote = (value: string): string =>
    `'${value.replaceAll("'", `'\\''`)}'`;
  const bun = Bun.which('bun') ?? 'bun';
  const command = `stty cols 160 rows 40; exec ${[bun, 'run', cliEntry, 'plugin', 'install', plugin, ...args].map(shellQuote).join(' ')}`;
  const child = Bun.spawn(['script', '-qefc', command, '/dev/null'], {
    cwd: workspace,
    env: {
      ...process.env,
      ALLAGENTS_TEST_HOME: home,
      HOME: home,
      USERPROFILE: home,
      NO_COLOR: '1',
      CI: '',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let stdout = '';
  let sent = false;
  const consumeStdout = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      stdout += decoder.decode(value, { stream: true });
      if (!sent && stdout.includes(waitFor)) {
        sent = true;
        child.stdin.write(input);
        child.stdin.end();
      }
    }
    stdout += decoder.decode();
  })();
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    consumeStdout,
  ]).then(([code, error]) => [code, error] as const);
  return { exitCode, stdout, stderr };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'allagents-plugin-install-options-'));
  home = join(root, 'home');
  workspace = join(root, 'workspace');
  plugin = join(root, 'plugin');
  await mkdir(join(plugin, 'skills', 'demo'), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(
    join(plugin, 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: Demo\n---\n# Demo\n',
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('plugin install target options', () => {
  test('persists an explicit client subset without changing scope defaults', async () => {
    await mkdir(join(workspace, '.allagents'), { recursive: true });
    await writeFile(
      join(workspace, '.allagents', 'workspace.yaml'),
      dump({
        repositories: [],
        plugins: [],
        clients: ['claude', 'codex', 'cursor'],
      }),
    );

    const result = await runInstall([
      '--scope',
      'project',
      '--client',
      'codex,cursor',
      '--yes',
    ]);

    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout) as {
      success: boolean;
      data: { scope: string };
    };
    expect(output.success).toBe(true);
    expect(output.data.scope).toBe('project');
    const config = load(
      await readFile(join(workspace, '.allagents', 'workspace.yaml'), 'utf8'),
    ) as {
      clients: string[];
      plugins: Array<{ source: string; clients: string[] }>;
    };
    expect(config.clients).toEqual(['claude', 'codex', 'cursor']);
    expect(config.plugins).toEqual([
      { source: plugin, clients: ['codex', 'cursor'] },
    ]);
    expect(
      existsSync(join(workspace, '.codex', 'skills', 'demo', 'SKILL.md')),
    ).toBe(true);
    expect(
      existsSync(join(workspace, '.cursor', 'skills', 'demo', 'SKILL.md')),
    ).toBe(true);
    expect(
      existsSync(join(workspace, '.claude', 'skills', 'demo', 'SKILL.md')),
    ).toBe(false);
  });

  test(
    'declining confirmation leaves config and client artifacts unchanged',
    async () => {
      await mkdir(join(workspace, '.allagents'), { recursive: true });
      const configPath = join(workspace, '.allagents', 'workspace.yaml');
      const original = dump({
        repositories: [],
        plugins: [],
        clients: ['claude', 'codex'],
      });
      await writeFile(configPath, original);

      const result = await runInteractiveInstall('n\n');

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Install cancelled. No changes made.');
      expect(await readFile(configPath, 'utf8')).toBe(original);
      expect(existsSync(join(workspace, '.codex', 'skills', 'demo'))).toBe(
        false,
      );
      expect(existsSync(join(workspace, '.claude', 'skills', 'demo'))).toBe(
        false,
      );
    },
    15_000,
  );

  test(
    'accepts the install when Enter confirms the affirmative default',
    async () => {
      const result = await runInteractiveInstall('\r');

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Successfully installed plugin');
      const config = load(
        await readFile(join(workspace, '.allagents', 'workspace.yaml'), 'utf8'),
      ) as {
        clients: string[];
        plugins: string[];
      };
      expect(config.plugins).toEqual([plugin]);
      expect(
        existsSync(join(workspace, '.codex', 'skills', 'demo', 'SKILL.md')),
      ).toBe(true);
    },
    15_000,
  );

  test('suppresses prompts and retains first-project defaults in JSON mode', async () => {
    const result = await runInstall([]);

    expect(result.exitCode).toBe(0);
    const config = load(
      await readFile(join(workspace, '.allagents', 'workspace.yaml'), 'utf8'),
    ) as { clients: string[]; plugins: string[] };
    expect(config.clients).toEqual(['universal']);
    expect(config.plugins).toEqual([plugin]);
  });

  test(
    '--yes uses project defaults without opening prompts',
    async () => {
      const result = await runInteractiveInstall(
        '\x03',
        ['--scope', 'project', '--yes'],
        'Clients for project scope',
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).not.toContain('Clients for project scope');
      expect(result.stdout).not.toContain('Install with this target?');
      const config = load(
        await readFile(join(workspace, '.allagents', 'workspace.yaml'), 'utf8'),
      ) as { clients: string[]; plugins: string[] };
      expect(config.clients).toEqual(['universal']);
      expect(config.plugins).toEqual([plugin]);
    },
    15_000,
  );

  test('--yes uses configured clients and preserves object fields on reinstall', async () => {
    await mkdir(join(workspace, '.allagents'), { recursive: true });
    await writeFile(
      join(workspace, '.allagents', 'workspace.yaml'),
      dump({
        repositories: [],
        clients: ['claude', 'codex'],
        plugins: [
          {
            source: plugin,
            clients: ['claude'],
            skills: ['demo'],
            exclude: ['private/**'],
            ref: 'stable',
          },
        ],
      }),
    );

    const result = await runInstall(['--scope', 'project', '--yes']);

    expect(result.exitCode).toBe(0);
    const config = load(
      await readFile(join(workspace, '.allagents', 'workspace.yaml'), 'utf8'),
    ) as { plugins: Array<Record<string, unknown>> };
    expect(config.plugins).toEqual([
      {
        source: plugin,
        skills: ['demo'],
        exclude: ['private/**'],
        ref: 'stable',
      },
    ]);
  });

  test('rejects invalid client names before creating a config', async () => {
    const result = await runInstall([
      '--scope',
      'project',
      '--client',
      'not-a-client',
      '--yes',
    ]);

    expect(result.exitCode).not.toBe(0);
    const output = JSON.parse(result.stdout) as {
      success: boolean;
      error: string;
    };
    expect(output.success).toBe(false);
    expect(output.error).toContain("Invalid client 'not-a-client'");
    await expect(
      readFile(join(workspace, '.allagents', 'workspace.yaml'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
