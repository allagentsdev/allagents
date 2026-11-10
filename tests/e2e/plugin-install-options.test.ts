import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as dump, parse as load } from 'yaml';

const cliEntry = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');
let root: string;
let home: string;
let workspace: string;
let plugin: string;

async function runCli(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const process = Bun.spawn(
    ['bun', 'run', cliEntry, '--json', ...args],
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

async function runInstall(args: string[]) {
  return runCli(['plugin', 'install', plugin, ...args]);
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
  test.each(['project', 'user'] as const)(
    '--skill preserves unselected skill directories at %s scope',
    async (scope) => {
      await mkdir(join(plugin, 'skills', 'other'), { recursive: true });
      await writeFile(
        join(plugin, 'skills', 'other', 'SKILL.md'),
        '---\nname: other\ndescription: Other\n---\n# Upstream other\n',
      );
      const destination = scope === 'user' ? home : workspace;
      const privateSkill = '---\nname: other\ndescription: Private\n---\n# Private other\n';
      for (const client of ['.codex', '.cursor']) {
        const directory = join(destination, client, 'skills', 'other');
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'SKILL.md'), privateSkill);
        await writeFile(join(directory, 'personal.txt'), 'keep this file\n');
      }

      const result = await runInstall([
        '--scope', scope, '--client', 'codex,cursor', '--skill', 'demo', '--yes',
      ]);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout).data.enabledSkills).toEqual(['demo']);
      for (const client of ['.codex', '.cursor']) {
        const directory = join(destination, client, 'skills');
        expect(await readFile(join(directory, 'other', 'SKILL.md'), 'utf8')).toBe(privateSkill);
        expect(await readFile(join(directory, 'other', 'personal.txt'), 'utf8')).toBe('keep this file\n');
        expect(existsSync(join(directory, 'demo', 'SKILL.md'))).toBe(true);
      }
      const config = load(await readFile(join(destination, '.allagents', 'workspace.yaml'), 'utf8')) as {
        plugins: Array<{ source: string; skills: string[] }>;
      };
      expect(config.plugins).toEqual([{ source: plugin, skills: ['demo'] }]);
      const state = JSON.parse(await readFile(join(destination, '.allagents', 'sync-state.json'), 'utf8'));
      expect(Object.values(state.files).flat().some((path) => String(path).includes('/other/'))).toBe(false);
    },
    20_000,
  );

  test('rejects unknown --skill names before changing configuration or client files', async () => {
    const configPath = join(workspace, '.allagents', 'workspace.yaml');
    await mkdir(join(workspace, '.allagents'), { recursive: true });
    const original = dump({ version: 2, repositories: [], plugins: [], clients: ['codex'] });
    await writeFile(configPath, original);
    const directory = join(workspace, '.codex', 'skills', 'demo');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), 'private demo\n');

    const result = await runInstall([
      '--scope', 'project', '--client', 'codex', '--skill', 'missing', '--yes',
    ]);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain('Unknown skills: missing');
    expect(await readFile(configPath, 'utf8')).toBe(original);
    expect(await readFile(join(directory, 'SKILL.md'), 'utf8')).toBe('private demo\n');
    expect(existsSync(join(workspace, '.allagents', 'sync-state.json'))).toBe(false);
  }, 20_000);

  test('--skill extends an existing allowlist while preserving plugin fields', async () => {
    await mkdir(join(plugin, 'skills', 'other'), { recursive: true });
    await writeFile(join(plugin, 'skills', 'other', 'SKILL.md'), '---\nname: other\ndescription: Other\n---\n');
    await mkdir(join(workspace, '.allagents'), { recursive: true });
    await writeFile(join(workspace, '.allagents', 'workspace.yaml'), dump({
      version: 2,
      repositories: [],
      clients: ['codex'],
      plugins: [{ source: plugin, skills: ['demo'], exclude: ['private/**'], hooks: false }],
    }));

    const result = await runInstall([
      '--scope', 'project', '--client', 'codex', '--skill', 'other', '--skill', 'demo', '--yes',
    ]);

    expect(result.exitCode).toBe(0);
    const config = load(await readFile(join(workspace, '.allagents', 'workspace.yaml'), 'utf8')) as { plugins: unknown[] };
    expect(config.plugins).toEqual([{ source: plugin, skills: ['demo', 'other'], exclude: ['private/**'], hooks: false }]);
    for (const name of ['demo', 'other']) {
      expect(existsSync(join(workspace, '.codex', 'skills', name, 'SKILL.md'))).toBe(true);
    }
  }, 20_000);

  test.each(['project', 'user'] as const)(
    '--skill respects marketplace component declarations at %s scope',
    async (scope) => {
      await mkdir(join(root, '.claude-plugin'), { recursive: true });
      await mkdir(join(plugin, '.claude-plugin'), { recursive: true });
      await mkdir(join(plugin, 'custom-skills', 'selected'), { recursive: true });
      await writeFile(join(plugin, 'custom-skills', 'selected', 'SKILL.md'), '---\nname: selected\ndescription: Selected\n---\n');
      await writeFile(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'bundle', skills: './custom-skills/' }));
      await writeFile(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({
        name: 'selection-market',
        plugins: [{ name: 'bundle', source: './plugin' }],
      }));
      if (scope === 'project') {
        await mkdir(join(workspace, '.allagents'), { recursive: true });
        await writeFile(join(workspace, '.allagents', 'workspace.yaml'), dump({ version: 2, repositories: [], plugins: [], clients: ['codex'] }));
      }
      const registration = await runCli(['plugin', 'marketplace', 'add', root, '--scope', scope]);
      expect(registration).toMatchObject({ exitCode: 0 });
      plugin = 'bundle@selection-market';
      const destination = scope === 'user' ? home : workspace;

      const invalid = await runInstall(['--scope', scope, '--client', 'codex', '--skill', 'demo', '--yes']);
      expect(invalid.exitCode).toBe(1);
      expect(JSON.parse(invalid.stdout).error).toContain('Unknown skills: demo');
      expect(existsSync(join(destination, '.codex', 'skills', 'demo'))).toBe(false);

      const result = await runInstall(['--scope', scope, '--client', 'codex', '--skill', 'selected', '--yes']);
      expect(result.exitCode).toBe(0);
      expect(existsSync(join(destination, '.codex', 'skills', 'selected', 'SKILL.md'))).toBe(true);
      const config = load(await readFile(join(destination, '.allagents', 'workspace.yaml'), 'utf8')) as { plugins: unknown[] };
      expect(config.plugins).toEqual([{ source: plugin, skills: ['selected'] }]);
    },
    30_000,
  );

  test('--skill rejects blocklist mode before changing its declaration or copying files', async () => {
    await mkdir(join(workspace, '.allagents'), { recursive: true });
    const configPath = join(workspace, '.allagents', 'workspace.yaml');
    const original = dump({ version: 2, repositories: [], clients: ['codex'], plugins: [{ source: plugin, skills: { exclude: ['demo'] } }] });
    await writeFile(configPath, original);

    const result = await runInstall(['--scope', 'project', '--client', 'codex', '--skill', 'demo', '--yes']);

    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout).error).toContain('blocklist mode');
    expect(await readFile(configPath, 'utf8')).toBe(original);
    expect(existsSync(join(workspace, '.codex', 'skills', 'demo'))).toBe(false);
  }, 20_000);

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
