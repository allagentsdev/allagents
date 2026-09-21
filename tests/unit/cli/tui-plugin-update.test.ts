import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { dump } from 'js-yaml';
import {
  resetUpdatePromptMocks,
  spinnerErrorMock,
  spinnerMessageMock,
  spinnerStartMock,
  spinnerStopMock,
  updateNoteMock as noteMock,
  updateSelectMock as selectMock,
  updateSelectResponses as selectResponses,
} from '../../helpers/clack-prompts-mock.js';
import { getPluginCachePath } from '../../../src/utils/plugin-path.js';
import {
  addMarketplace,
  listMarketplaces,
} from '../../../src/core/marketplace.js';
import { TuiCache } from '../../../src/cli/tui/cache.js';


// The prompt module must be mocked before loading the TUI action.
const { runBrowseMarketplaces, runPlugins, runUpdateAllPlugins } = await import(
  '../../../src/cli/tui/actions/plugins.js'
);

const SOURCE =
  'https://github.com/mattpocock/skills/tree/main/skills/engineering/setup-matt-pocock-skills';
const EMPTY_SOURCE =
  'https://github.com/mattpocock/skills/tree/main/skills/empty';
const GENERIC_SOURCE = 'https://github.com/example/plugins';
const SKILL_ROOT = 'skills/engineering/setup-matt-pocock-skills';
const SKILL_PATH = `${SKILL_ROOT}/SKILL.md`;
const SKILL_AGENT_PATH = `${SKILL_ROOT}/agents/openai.yaml`;
const EMPTY_SKILL_PATH = 'skills/empty/SKILL.md';
const GENERIC_SKILL_PATH = 'skills/generic/SKILL.md';
const originalEnvironment = {
  ALLAGENTS_TEST_HOME: process.env.ALLAGENTS_TEST_HOME,
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  HOME: process.env.HOME,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  GIT_TRACE2_EVENT: process.env.GIT_TRACE2_EVENT,
};

function runGit(path: string, args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', path, ...args], {
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed in ${path}: ${result.stderr.toString().trim()}`,
    );
  }
  return result.stdout.toString().trim();
}

async function createRemote(
  root: string,
  name: string,
  files: Record<string, string>,
): Promise<{ remote: string; upstream: string }> {
  const remote = join(root, `${name}.git`);
  const upstream = join(root, `${name}-upstream`);
  await mkdir(remote, { recursive: true });
  runGit(remote, ['init', '--bare', '--initial-branch=main']);
  runGit(root, ['clone', remote, upstream]);
  runGit(upstream, ['config', '--local', 'user.name', 'TUI Update Test']);
  runGit(upstream, [
    'config',
    '--local',
    'user.email',
    'tui-update@example.test',
  ]);
  for (const [path, content] of Object.entries(files)) {
    const target = join(upstream, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  runGit(upstream, ['add', '.']);
  runGit(upstream, ['commit', '-m', 'fixture v1']);
  runGit(upstream, ['push', 'origin', 'main']);
  return { remote, upstream };
}

async function advanceRemote(
  upstream: string,
  path: string,
  content: string,
  version: string,
): Promise<string> {
  await writeFile(join(upstream, path), content);
  runGit(upstream, ['add', '--all']);
  runGit(upstream, ['commit', '-m', `fixture ${version}`]);
  runGit(upstream, ['push', 'origin', 'main']);
  return runGit(upstream, ['rev-parse', 'HEAD']);
}

async function removeRemotePath(
  upstream: string,
  path: string,
  version: string,
): Promise<void> {
  await rm(join(upstream, path), { recursive: true, force: true });
  runGit(upstream, ['add', '--all']);
  runGit(upstream, ['commit', '-m', `fixture ${version}`]);
  runGit(upstream, ['push', 'origin', 'main']);
}

async function createUpdateFixture(
  options: { includeGeneric?: boolean; includeEmptyConsumer?: boolean } = {},
) {
  const { includeGeneric = true, includeEmptyConsumer = false } = options;
  const root = await mkdtemp(join(tmpdir(), 'allagents-tui-skill-update-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const gitConfig = join(root, 'gitconfig');
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });

  const skillRepository = await createRemote(root, 'skills', {
    [SKILL_PATH]:
      '---\nname: setup-matt-pocock-skills\ndescription: test skill\n---\n# standalone v1\n',
    [SKILL_AGENT_PATH]:
      'interface:\n  display_name: Setup Matt Pocock Skills\n  short_description: Set up repository skills\n',
    [EMPTY_SKILL_PATH]:
      '---\nname: empty\ndescription: disabled skill\n---\n# empty v1\n',
  });
  const genericRepository = await createRemote(root, 'plugins', {
    [GENERIC_SKILL_PATH]:
      '---\nname: generic\ndescription: generic skill\n---\n# generic v1\n',
  });

  await writeFile(
    gitConfig,
    `[url "file://${skillRepository.remote}"]\n\tinsteadOf = https://github.com/mattpocock/skills.git\n[url "file://${genericRepository.remote}"]\n\tinsteadOf = https://github.com/example/plugins.git\n`,
  );
  process.env.ALLAGENTS_TEST_HOME = home;
  process.env.HOME = home;
  process.env.XDG_CACHE_HOME = join(home, '.cache');
  process.env.XDG_CONFIG_HOME = join(home, '.config');
  process.env.XDG_DATA_HOME = join(home, '.local/share');
  process.env.GIT_CONFIG_GLOBAL = gitConfig;

  const cache = getPluginCachePath('mattpocock', 'skills', 'main');
  const genericCache = getPluginCachePath('example', 'plugins');
  await mkdir(dirname(cache), { recursive: true });
  runGit(root, [
    'clone',
    '--branch',
    'main',
    'https://github.com/mattpocock/skills.git',
    cache,
  ]);
  runGit(root, [
    'clone',
    'https://github.com/example/plugins.git',
    genericCache,
  ]);

  const plugins: Array<string | { source: string; skills: string[] }> = [
    SOURCE,
  ];
  if (includeGeneric) plugins.push(GENERIC_SOURCE);
  if (includeEmptyConsumer) {
    plugins.push({ source: EMPTY_SOURCE, skills: [] });
  }
  await mkdir(join(workspace, '.allagents'), { recursive: true });
  await writeFile(
    join(workspace, '.allagents/workspace.yaml'),
    dump({
      version: 2,
      repositories: [],
      clients: ['claude'],
      plugins,
    }),
  );

  return {
    root,
    workspace,
    cache,
    genericCache,
    skillRepository,
    gitConfig,
    genericRepository,
    context: {
      hasWorkspace: true,
      workspacePath: workspace,
      projectPluginCount: plugins.length,
      userPluginCount: 0,
      needsSync: false,
      hasUserConfig: false,
      marketplaceCount: 0,
    },
  };
}

function restoreEnvironment(): void {
  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

beforeEach(() => {
  resetUpdatePromptMocks();
});

afterEach(() => {
  restoreEnvironment();
  resetUpdatePromptMocks();
});

async function countGitCommands(
  tracePath: string,
  command: string,
  source?: string,
): Promise<number> {
  const trace = await readFile(tracePath, 'utf-8');
  const events = trace
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event?: string; argv?: string[] });
  return events.filter((event) => {
    const invocation = event.argv?.join(' ') ?? '';
    return (
      (event.event === 'start' || event.event === 'child_start') &&
      invocation.includes(command) &&
      (!source || invocation.includes(source))
    );
  }).length;
}

describe('interactive plugin updates', () => {
  test(
    'updates a root standalone skill with support agents using its semantic name',
    async () => {
      const fixture = await createUpdateFixture();
      try {
        const skillShaV2 = await advanceRemote(
          fixture.skillRepository.upstream,
          SKILL_PATH,
          '---\nname: setup-matt-pocock-skills\ndescription: test skill\n---\n# standalone v2\n',
          'v2',
        );
        const genericShaV2 = await advanceRemote(
          fixture.genericRepository.upstream,
          GENERIC_SKILL_PATH,
          '---\nname: generic\ndescription: generic skill\n---\n# generic v2\n',
          'v2',
        );

        const tuiCache = new TuiCache();
        const invalidate = mock(tuiCache.invalidate.bind(tuiCache));
        tuiCache.invalidate = invalidate;

        await runUpdateAllPlugins(fixture.context, tuiCache);

        expect(noteMock).toHaveBeenCalledTimes(1);
        expect(noteMock).toHaveBeenCalledWith(
          `✓ ${GENERIC_SOURCE} (updated)\n✓ setup-matt-pocock-skills (updated)\n\nUpdated: 2  Skipped: 0  Failed: 0`,
          'Update Results',
        );
        expect(spinnerStartMock).toHaveBeenCalledTimes(1);
        expect(spinnerStartMock).toHaveBeenCalledWith('Gathering plugins...');
        expect(spinnerMessageMock.mock.calls).toEqual([
          ['Updating 2 plugin(s)...'],
          ['Updating setup-matt-pocock-skills...'],
          ['Updating example/plugins...'],
        ]);
        expect(spinnerStopMock).toHaveBeenCalledTimes(1);
        expect(spinnerStopMock).toHaveBeenCalledWith('Update complete');
        expect(spinnerErrorMock).not.toHaveBeenCalled();
        expect(invalidate).toHaveBeenCalledTimes(1);
        expect(noteMock.mock.calls[0]?.[0]).not.toContain(SOURCE);
        expect(runGit(fixture.cache, ['rev-parse', 'HEAD'])).toBe(
          skillShaV2,
        );
        expect(runGit(fixture.genericCache, ['rev-parse', 'HEAD'])).toBe(
          genericShaV2,
        );
        expect(
          await readFile(join(fixture.cache, SKILL_PATH), 'utf-8'),
        ).toContain('# standalone v2');
        expect(
          await readFile(
            join(fixture.genericCache, GENERIC_SKILL_PATH),
            'utf-8',
          ),
        ).toContain('# generic v2');
        expect(
          await readFile(
            join(
              fixture.workspace,
              '.claude/skills/setup-matt-pocock-skills/SKILL.md',
            ),
            'utf-8',
          ),
        ).toContain('# standalone v2');
        expect(
          await readFile(
            join(fixture.workspace, '.claude/skills/generic/SKILL.md'),
            'utf-8',
          ),
        ).toContain('# generic v2');
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    15_000,
  );


  test(
    'ends the spinner before the Plugins menu renders an unexpected error',
    async () => {
      const fixture = await createUpdateFixture({ includeGeneric: false });
      const events: string[] = [];
      spinnerErrorMock.mockImplementation((message) => {
        events.push(`spinner:${message}`);
      });
      noteMock.mockImplementation((_message, title) => {
        events.push(`note:${title}`);
      });
      selectMock.mockImplementation(async () => {
        const userConfigDirectory = join(process.env.HOME!, '.allagents');
        await mkdir(userConfigDirectory, { recursive: true });
        await writeFile(
          join(userConfigDirectory, 'workspace.yaml'),
          'plugins: [',
        );
        return '__update_all__';
      });

      try {
        await runPlugins(fixture.context);

        expect(spinnerErrorMock).toHaveBeenCalledWith('Update failed');
        expect(spinnerStopMock).not.toHaveBeenCalled();
        expect(noteMock).toHaveBeenCalledTimes(1);
        expect(noteMock.mock.calls[0]?.[1]).toBe('Error');
        expect(events).toEqual(['spinner:Update failed', 'note:Error']);
      } finally {
        spinnerErrorMock.mockImplementation(() => {});
        noteMock.mockImplementation(() => {});
        selectMock.mockImplementation(
          async () => selectResponses.shift() ?? '__back__',
        );
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  test(
    'materializes unrelated generic updates without advancing retained or failed standalone checkout',
    async () => {
      const fixture = await createUpdateFixture();
      try {
        const initialSkillSha = runGit(fixture.cache, ['rev-parse', 'HEAD']);
        await removeRemotePath(
          fixture.skillRepository.upstream,
          SKILL_PATH,
          'v2',
        );
        const genericShaV2 = await advanceRemote(
          fixture.genericRepository.upstream,
          GENERIC_SKILL_PATH,
          '---\nname: generic\ndescription: generic skill\n---\n# generic v2\n',
          'v2',
        );

        await runUpdateAllPlugins(fixture.context);

        expect(noteMock).toHaveBeenCalledWith(
          `✓ ${GENERIC_SOURCE} (updated)\n- setup-matt-pocock-skills (skipped)\n\nUpdated: 1  Skipped: 1  Failed: 0`,
          'Update Results',
        );
        expect(runGit(fixture.cache, ['rev-parse', 'HEAD'])).toBe(
          initialSkillSha,
        );
        expect(runGit(fixture.genericCache, ['rev-parse', 'HEAD'])).toBe(
          genericShaV2,
        );
        expect(
          await readFile(join(fixture.cache, SKILL_PATH), 'utf-8'),
        ).toContain('# standalone v1');
        expect(
          await readFile(
            join(
              fixture.workspace,
              '.claude/skills/setup-matt-pocock-skills/SKILL.md',
            ),
            'utf-8',
          ),
        ).toContain('# standalone v1');
        expect(
          await readFile(
            join(fixture.workspace, '.claude/skills/generic/SKILL.md'),
            'utf-8',
          ),
        ).toContain('# generic v2');

        noteMock.mockClear();
        await removeRemotePath(
          fixture.skillRepository.upstream,
          SKILL_ROOT,
          'v3',
        );
        const genericShaV3 = await advanceRemote(
          fixture.genericRepository.upstream,
          GENERIC_SKILL_PATH,
          '---\nname: generic\ndescription: generic skill\n---\n# generic v3\n',
          'v3',
        );

        await runUpdateAllPlugins(fixture.context);

        expect(noteMock).toHaveBeenCalledWith(
          `✓ ${GENERIC_SOURCE} (updated)\n✗ setup-matt-pocock-skills (failed) - Declared plugin root no longer exists for ${SOURCE}\n\nUpdated: 1  Skipped: 0  Failed: 1`,
          'Update Results',
        );
        expect(runGit(fixture.cache, ['rev-parse', 'HEAD'])).toBe(
          initialSkillSha,
        );
        expect(runGit(fixture.genericCache, ['rev-parse', 'HEAD'])).toBe(
          genericShaV3,
        );
        expect(
          await readFile(join(fixture.cache, SKILL_PATH), 'utf-8'),
        ).toContain('# standalone v1');
        expect(
          await readFile(
            join(fixture.workspace, '.claude/skills/generic/SKILL.md'),
            'utf-8',
          ),
        ).toContain('# generic v3');
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    25_000,
  );

  test(
    'does not refresh an empty direct install sharing a standalone cache',
    async () => {
      const fixture = await createUpdateFixture({
        includeGeneric: false,
        includeEmptyConsumer: true,
      });
      try {
        const initialSkillSha = runGit(fixture.cache, ['rev-parse', 'HEAD']);
        await removeRemotePath(
          fixture.skillRepository.upstream,
          SKILL_PATH,
          'v2',
        );

        await runUpdateAllPlugins(fixture.context);

        expect(noteMock).toHaveBeenCalledWith(
          '- setup-matt-pocock-skills (skipped)\n\nUpdated: 0  Skipped: 1  Failed: 0',
          'Update Results',
        );
        expect(noteMock.mock.calls[0]?.[0]).not.toContain(EMPTY_SOURCE);
        expect(runGit(fixture.cache, ['rev-parse', 'HEAD'])).toBe(
          initialSkillSha,
        );
        expect(
          await readFile(join(fixture.cache, SKILL_PATH), 'utf-8'),
        ).toContain('# standalone v1');
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    15_000,
  );

  test(
    'shares one remote check inside an action and uses a fresh context for the next action',
    async () => {
      const fixture = await createUpdateFixture({ includeGeneric: true });
      const tracePath = join(fixture.root, 'git-trace.jsonl');
      try {
        await mkdir(join(process.env.HOME!, '.allagents'), { recursive: true });
        await writeFile(
          join(process.env.HOME!, '.allagents/workspace.yaml'),
          dump({
            version: 2,
            repositories: [],
            clients: ['claude'],
            plugins: [GENERIC_SOURCE],
          }),
        );
        process.env.GIT_TRACE2_EVENT = tracePath;

        await runUpdateAllPlugins(fixture.context);

        expect(
          await countGitCommands(
            tracePath,
            'ls-remote',
            'https://github.com/example/plugins.git',
          ),
        ).toBe(1);
        noteMock.mockClear();
        const genericShaV2 = await advanceRemote(
          fixture.genericRepository.upstream,
          GENERIC_SKILL_PATH,
          '---\nname: generic\ndescription: generic skill\n---\n# generic v2\n',
          'v2',
        );

        await runUpdateAllPlugins(fixture.context);

        expect(
          await countGitCommands(
            tracePath,
            'ls-remote',
            'https://github.com/example/plugins.git',
          ),
        ).toBe(2);
        expect(runGit(fixture.genericCache, ['rev-parse', 'HEAD'])).toBe(
          genericShaV2,
        );
        expect(noteMock.mock.calls[0]?.[0]).toContain(
          `✓ ${GENERIC_SOURCE} (updated)`,
        );
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    15_000,
  );



  test(
    'bypasses exact standalone inspection when the managed node is equal and healthy',
    async () => {
      const fixture = await createUpdateFixture({ includeGeneric: false });
      const tracePath = join(fixture.root, 'standalone-precheck-trace.jsonl');
      try {
        process.env.GIT_TRACE2_EVENT = tracePath;

        await runUpdateAllPlugins(fixture.context, undefined, {
          checkRepositoryHealth: async (_path, expected) => ({
            status: 'healthy',
            head: expected.head,
            ...(expected.ref && { ref: expected.ref }),
          }),
        });

        expect(await countGitCommands(tracePath, 'ls-remote')).toBe(1);
        expect(await countGitCommands(tracePath, 'clone')).toBe(0);
        expect(noteMock).toHaveBeenCalledWith(
          '✓ setup-matt-pocock-skills (updated)\n\nUpdated: 1  Skipped: 0  Failed: 0',
          'Update Results',
        );
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    15_000,
  );
  test(
    'uses fresh contexts for sequential status-routed single-plugin actions',
    async () => {
      const fixture = await createUpdateFixture({ includeGeneric: true });
      const tracePath = join(fixture.root, 'single-git-trace.jsonl');
      try {
        process.env.GIT_TRACE2_EVENT = tracePath;
        selectResponses.push(
          `project:${GENERIC_SOURCE}`,
          'update',
          'back',
          '__back__',
        );

        await runPlugins(fixture.context);

        expect(await countGitCommands(tracePath, 'ls-remote')).toBe(1);
        const genericShaV2 = await advanceRemote(
          fixture.genericRepository.upstream,
          GENERIC_SKILL_PATH,
          '---\nname: generic\ndescription: generic skill\n---\n# generic v2\n',
          'v2',
        );
        selectResponses.push(
          `project:${GENERIC_SOURCE}`,
          'update',
          'back',
          '__back__',
        );

        await runPlugins(fixture.context);

        expect(await countGitCommands(tracePath, 'ls-remote')).toBe(2);
        expect(runGit(fixture.genericCache, ['rev-parse', 'HEAD'])).toBe(
          genericShaV2,
        );
        expect(noteMock.mock.calls.at(-1)?.[0]).toBe(
          `✓ ${GENERIC_SOURCE} (updated)`,
        );
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    15_000,
  );
  test(
    'invalidates TUI state after a successful no-op marketplace registry write',
    async () => {
      const fixture = await createUpdateFixture();
      try {
        const marketplaceRepository = await createRemote(
          fixture.root,
          'marketplace',
          {
            '.claude-plugin/marketplace.json': JSON.stringify({
              name: 'shared-marketplace',
              plugins: [
                {
                  name: 'demo',
                  source: './plugins/demo',
                },
              ],
            }),
            'plugins/demo/skills/demo/SKILL.md':
              '---\nname: demo\ndescription: demo\n---\n# demo\n',
          },
        );
        await writeFile(
          fixture.gitConfig,
          `[url "file://${fixture.skillRepository.remote}"]\n\tinsteadOf = https://github.com/mattpocock/skills.git\n[url "file://${fixture.genericRepository.remote}"]\n\tinsteadOf = https://github.com/example/plugins.git\n[url "file://${marketplaceRepository.remote}"]\n\tinsteadOf = https://github.com/example/marketplace.git\n`,
        );
        const added = await addMarketplace(
          'https://github.com/example/marketplace',
        );
        expect(added.success).toBe(true);

        const cache = new TuiCache();
        cache.setMarketplaces(await listMarketplaces());
        const invalidate = mock(cache.invalidate.bind(cache));
        cache.invalidate = invalidate;
        selectResponses.push(
          'shared-marketplace',
          'update',
          'back',
          '__back__',
        );

        await runBrowseMarketplaces(fixture.context, cache);

        expect(invalidate).toHaveBeenCalledTimes(1);
        expect(noteMock.mock.calls[0]?.[0]).toBe('✓ shared-marketplace');
        expect(noteMock.mock.calls[0]?.[0]).not.toContain('changed');
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
