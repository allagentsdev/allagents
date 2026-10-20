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

async function runSkillAdd(
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(
    ['bun', 'run', cliEntry, '--json', 'skill', 'add', ...args],
    {
      cwd: workspace,
      env: {
        ...process.env,
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
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function runGit(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'allagents-skill-install-options-'));
  home = join(root, 'home');
  workspace = join(root, 'workspace');
  plugin = 'https://github.com/acme/skill-target';
  const pluginCache = join(
    home,
    '.allagents',
    'plugins',
    'marketplaces',
    'acme-skill-target',
  );
  await mkdir(join(pluginCache, 'skills', 'demo'), { recursive: true });
  await mkdir(join(workspace, '.allagents'), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(
    join(pluginCache, 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: Demo\n---\n# Demo\n',
  );
  await writeFile(
    join(workspace, '.allagents', 'workspace.yaml'),
    dump({
      repositories: [],
      plugins: [],
      clients: ['claude', 'codex', 'cursor'],
    }),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('skill add target options', () => {
  test('persists file mode, the complete allowlist, and selected clients for a new source', async () => {
    const result = await runSkillAdd([
      'demo',
      '--from',
      plugin,
      '--scope',
      'project',
      '--client',
      'codex,cursor',
      '--yes',
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: true,
      command: 'skill add',
      data: { skill: 'demo' },
    });
    const config = load(
      await readFile(join(workspace, '.allagents', 'workspace.yaml'), 'utf8'),
    ) as {
      clients: string[];
      plugins: Array<{
        source: string;
        install: string;
        skills: string[];
        clients: string[];
      }>;
    };
    expect(config.clients).toEqual(['claude', 'codex', 'cursor']);
    expect(config.plugins).toEqual([
      {
        source: plugin,
        install: 'file',
        skills: ['demo'],
        clients: ['codex', 'cursor'],
      },
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

  test('targets every declaration and artifact in a marketplace batch', async () => {
    const marketplaceSource = 'https://github.com/acme/target-market';
    const marketplaceSeed = join(root, 'marketplace-seed');
    const marketplaceRemote = join(root, 'marketplace-remote.git');
    const marketplaceCache = join(
      home,
      '.allagents',
      'plugins',
      'marketplaces',
      'acme-target-market',
    );
    await mkdir(marketplaceSeed, { recursive: true });
    runGit(root, ['init', '--bare', marketplaceRemote]);
    runGit(marketplaceSeed, ['init']);
    runGit(marketplaceSeed, ['config', 'user.email', 'test@example.com']);
    runGit(marketplaceSeed, ['config', 'user.name', 'Test']);
    for (const name of ['alpha', 'beta']) {
      await mkdir(
        join(marketplaceSeed, 'plugins', name, 'skills', name),
        { recursive: true },
      );
      await writeFile(
        join(
          marketplaceSeed,
          'plugins',
          name,
          'skills',
          name,
          'SKILL.md',
        ),
        `---\nname: ${name}\ndescription: ${name} skill\n---\n# ${name}\n`,
      );
    }
    await mkdir(join(marketplaceSeed, '.claude-plugin'), {
      recursive: true,
    });
    await writeFile(
      join(marketplaceSeed, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'target-market',
        description: 'Targeting fixture',
        plugins: [
          {
            name: 'alpha-plugin',
            description: 'Alpha',
            source: './plugins/alpha',
            skills: ['./skills/alpha'],
          },
          {
            name: 'beta-plugin',
            description: 'Beta',
            source: './plugins/beta',
            skills: ['./skills/beta'],
          },
        ],
      }),
    );
    runGit(marketplaceSeed, ['add', '.']);
    runGit(marketplaceSeed, ['commit', '-m', 'fixture']);
    runGit(marketplaceSeed, ['branch', '-M', 'main']);
    runGit(marketplaceSeed, ['remote', 'add', 'origin', marketplaceRemote]);
    runGit(marketplaceSeed, ['push', '-u', 'origin', 'main']);
    runGit(root, [
      '--git-dir',
      marketplaceRemote,
      'symbolic-ref',
      'HEAD',
      'refs/heads/main',
    ]);
    await mkdir(join(home, '.allagents', 'plugins', 'marketplaces'), {
      recursive: true,
    });
    runGit(root, ['clone', marketplaceRemote, marketplaceCache]);
    await writeFile(
      join(home, '.gitconfig'),
      `[url "${marketplaceRemote.slice(0, -4)}"]\n\tinsteadOf = ${marketplaceSource}\n`,
    );

    const result = await runSkillAdd([
      '--all',
      '--from',
      marketplaceSource,
      '--scope',
      'project',
      '--client',
      'codex,cursor',
      '--yes',
    ]);

    expect(result).toMatchObject({ exitCode: 0, stderr: '' });
    const config = load(
      await readFile(join(workspace, '.allagents', 'workspace.yaml'), 'utf8'),
    ) as {
      plugins: Array<{
        source: string;
        install: string;
        skills: string[];
        clients: string[];
      }>;
    };
    expect(config.plugins).toEqual([
      {
        source: 'alpha-plugin@target-market',
        install: 'file',
        skills: ['alpha'],
        clients: ['codex', 'cursor'],
      },
      {
        source: 'beta-plugin@target-market',
        install: 'file',
        skills: ['beta'],
        clients: ['codex', 'cursor'],
      },
    ]);
    for (const name of ['alpha', 'beta']) {
      expect(
        existsSync(join(workspace, '.codex', 'skills', name, 'SKILL.md')),
      ).toBe(true);
      expect(
        existsSync(join(workspace, '.cursor', 'skills', name, 'SKILL.md')),
      ).toBe(true);
      expect(
        existsSync(join(workspace, '.claude', 'skills', name, 'SKILL.md')),
      ).toBe(false);
    }
  });

  test('keeps the legacy project default when no workspace config exists', async () => {
    await rm(join(workspace, '.allagents'), { recursive: true, force: true });

    const result = await runSkillAdd(['demo', '--from', plugin]);

    expect(result.exitCode).toBe(0);
    expect(
      existsSync(join(workspace, '.allagents', 'workspace.yaml')),
    ).toBe(true);
    expect(existsSync(join(home, '.allagents', 'workspace.yaml'))).toBe(false);
  });

  test('updates an existing declaration in its current scope instead of retargeting it', async () => {
    await mkdir(join(home, '.allagents'), { recursive: true });
    await writeFile(
      join(home, '.allagents', 'workspace.yaml'),
      dump({
        repositories: [],
        plugins: [{ source: plugin, install: 'file', skills: [] }],
        clients: ['codex'],
      }),
    );

    const result = await runSkillAdd([
      'demo',
      '--from',
      plugin,
      '--scope',
      'project',
      '--client',
      'cursor',
      '--yes',
    ]);

    expect(result.exitCode).toBe(0);
    const projectConfig = load(
      await readFile(join(workspace, '.allagents', 'workspace.yaml'), 'utf8'),
    ) as { plugins: unknown[] };
    expect(projectConfig.plugins).toEqual([]);

    const userConfig = load(
      await readFile(join(home, '.allagents', 'workspace.yaml'), 'utf8'),
    ) as {
      clients: string[];
      plugins: Array<{
        source: string;
        install: string;
        skills: string[];
        clients?: string[];
      }>;
    };
    expect(userConfig.clients).toEqual(['codex']);
    expect(userConfig.plugins).toEqual([
      {
        source: plugin,
        install: 'file',
        skills: ['demo'],
      },
    ]);
  });
});
