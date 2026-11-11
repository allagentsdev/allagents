import { afterEach, beforeEach, expect, test, type Mock } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import {
  CLACK_CANCEL,
  resetUpdatePromptMocks,
  updateNoteMock,
  updateSelectMock,
  updateSelectResponses,
} from '../../helpers/clack-prompts-mock.js';
import { stubHomeDir } from '../../helpers/env.js';
import { parseRemotePluginSource } from '../../../src/utils/plugin-path.js';
import type { TuiContext } from '../../../src/cli/tui/context.js';
import type { PluginEntry } from '../../../src/models/workspace-config.js';

const { runPlugins } = await import('../../../src/cli/tui/actions/plugins.js');
const { runStatus } = await import('../../../src/cli/tui/actions/status.js');
const prompts = await import('@clack/prompts');

const source = 'https://github.com/allagentsdev/agent-plugins/tree/main/plugins/productivity/skills/write-naturally';
let root: string;
let home: string;
let workspace: string;
let restoreHome: () => void;

beforeEach(async () => {
  resetUpdatePromptMocks();
  root = await mkdtemp(join(tmpdir(), 'allagents-tui-display-'));
  home = join(root, 'home');
  workspace = join(root, 'workspace');
  restoreHome = stubHomeDir(home);
  await mkdir(join(home, '.allagents'), { recursive: true });
  await mkdir(join(workspace, '.allagents'), { recursive: true });
});

afterEach(async () => {
  restoreHome();
  resetUpdatePromptMocks();
  await rm(root, { recursive: true, force: true });
});

function context(): TuiContext {
  return {
    hasWorkspace: true, workspacePath: workspace, projectPluginCount: 1,
    userPluginCount: 1, hasUserConfig: true, needsSync: false, marketplaceCount: 0,
  };
}

async function configure(scope: 'project' | 'user', plugins: PluginEntry[]): Promise<string> {
  const path = join(scope === 'project' ? workspace : home, '.allagents', 'workspace.yaml');
  await writeFile(path, stringify({ repositories: [], clients: ['codex'], plugins }));
  return path;
}

async function cachedSkill(spec: string): Promise<void> {
  const remote = parseRemotePluginSource(spec);
  if (!remote) throw new Error('Expected a remote fixture');
  const path = join(remote.cachePath, remote.subpath ?? '');
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'SKILL.md'), '---\nname: write-naturally\ndescription: Write clearly\n---\nWrite clearly.\n');
}

function firstList() {
  return updateSelectMock.mock.calls.find(([options]) => options.message === 'Plugins')?.[0].options ?? [];
}

test('a URL-installed skill shows its name and origin while details retain the exact source', async () => {
  await cachedSkill(source);
  const path = await configure('project', [source]);
  const before = await readFile(path, 'utf8');
  updateSelectResponses.push(`project:${source}`, 'back', '__back__');

  await runPlugins(context());

  const item = firstList().find((option) => option.value === `project:${source}`);
  expect(item?.label).toBe('write-naturally');
  expect(item?.hint).toContain('skill · allagentsdev/agent-plugins');
  expect(item?.hint).toContain('project');
  expect(item?.hint).not.toContain('https://');
  expect(updateSelectMock.mock.calls.some(([options]) => options.message.startsWith('Skill: write-naturally [project]'))).toBe(true);
  expect(updateNoteMock.mock.calls).toContainEqual([source, 'Source']);
  expect(updateSelectMock.mock.calls.filter(([options]) => options.message === 'Plugins')).toHaveLength(2);
  expect(await readFile(path, 'utf8')).toBe(before);
});

test('workspace status uses the same compact skill display in project and user scopes', async () => {
  await cachedSkill(source);
  await configure('project', [source]);
  await configure('user', [source]);
  updateSelectResponses.push('back');

  await runStatus(context());

  const status = updateNoteMock.mock.calls.find(([, title]) => title === 'Status')?.[0] ?? '';
  expect(status).toContain('Project plugins:');
  expect(status).toContain('User plugins:');
  expect(status.match(/write-naturally/g)).toHaveLength(2);
  expect(status.match(/skill/g)).toHaveLength(2);
  expect(status.match(/allagentsdev\/agent-plugins/g)).toHaveLength(2);
  expect(status).not.toContain('https://');
  expect(status).not.toContain('plugins/productivity/skills');
});

test('same-name skills expose their path and ref and open the selected source', async () => {
  const other = 'https://github.com/allagentsdev/agent-plugins/tree/develop/plugins/review/skills/write-naturally';
  await cachedSkill(source);
  await cachedSkill(other);
  const path = await configure('project', [source, other]);
  const before = await readFile(path, 'utf8');
  updateSelectResponses.push(`project:${other}`, 'back', '__back__');

  await runPlugins(context());

  const first = firstList().find((option) => option.value === `project:${source}`);
  const second = firstList().find((option) => option.value === `project:${other}`);
  expect(first?.label).toBe('write-naturally');
  expect(second?.label).toBe('write-naturally');
  expect(first?.hint).toContain('plugins/productivity/skills/write-naturally');
  expect(second?.hint).toContain('@develop/plugins/review/skills/write-naturally');
  expect(first?.hint).not.toBe(second?.hint);
  expect(updateNoteMock.mock.calls).toContainEqual([other, 'Source']);
  expect(await readFile(path, 'utf8')).toBe(before);
});

test('removing a duplicate local skill declaration retains the other entry and user scope', async () => {
  const local = join(root, 'skills', 'write-naturally');
  await mkdir(local, { recursive: true });
  await writeFile(join(local, 'SKILL.md'), '---\nname: write-naturally\ndescription: Write clearly\n---\n');
  const first = { source: local, skills: ['write-naturally'] };
  const second = { source: local, skills: { exclude: ['write-naturally'] } };
  const projectPath = await configure('project', [first, second]);
  const userPath = await configure('user', [local]);
  const userBefore = await readFile(userPath, 'utf8');
  (prompts.confirm as Mock<typeof prompts.confirm>).mockResolvedValueOnce(true);
  updateSelectResponses.push(`project:${local}\0${1}`, 'remove', '__back__');

  await runPlugins(context());

  const list = firstList();
  expect(list.find((option) => option.value === `project:${local}\0${1}`)?.label).toBe('write-naturally');
  expect(list.find((option) => option.value === `project:${local}\0${1}`)?.hint).toContain(local);
  expect(list.some((option) => option.value === `user:${local}`)).toBe(true);
  const confirmation = (prompts.confirm as Mock<typeof prompts.confirm>).mock.calls.at(-1)?.[0].message;
  expect(confirmation).toContain('skill');
  expect(confirmation).toContain('write-naturally');
  expect(confirmation).toContain('[project]');
  expect(confirmation).not.toContain(root);
  expect(parse(await readFile(projectPath, 'utf8')).plugins).toEqual([first]);
  expect(await readFile(userPath, 'utf8')).toBe(userBefore);
});

test('cancelling a skill detail returns to the list without changing its declaration', async () => {
  await cachedSkill(source);
  const path = await configure('project', [source]);
  const before = await readFile(path, 'utf8');
  updateSelectMock
    .mockImplementationOnce(async () => `project:${source}`)
    .mockImplementationOnce(async () => CLACK_CANCEL as unknown as string);
  updateSelectResponses.push('__back__');

  await runPlugins(context());

  expect(updateSelectMock.mock.calls.map(([options]) => options.message)).toContain('Plugins');
  expect(updateSelectMock.mock.calls.filter(([options]) => options.message === 'Plugins')).toHaveLength(2);
  expect(await readFile(path, 'utf8')).toBe(before);
});
