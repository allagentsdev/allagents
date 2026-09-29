import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { runMcpServers, type McpTuiPrompts } from '../../../src/cli/tui/actions/mcp.js';
import { getTuiContext } from '../../../src/cli/tui/context.js';
import { resolveMcpDestination } from '../../../src/core/mcp-servers.js';
import { getUserWorkspaceConfig } from '../../../src/core/user-workspace.js';
import {
  addManagedMcpServer,
  listManagedMcpServers,
  reauthenticateManagedMcpServer,
  removeManagedMcpServer,
  updateManagedMcpServers,
} from '../../../src/core/mcp-management.js';

const originalHome = process.env.HOME;
const originalTestHome = process.env.ALLAGENTS_TEST_HOME;
const originalCwd = process.cwd();
let root: string;
let home: string;
let project: string;
let userConfig: string;

function scriptedPrompts(selections: string[]) {
  const menus: Array<{ message: string; labels: string[] }> = [];
  const texts = ['deepwiki', 'echo', '', ''];
  const prompts: McpTuiPrompts = {
    async select<T extends string>(request: {
      message: string;
      options: Array<{ label: string; value: T }>;
    }): Promise<T> {
      menus.push({
        message: request.message,
        labels: request.options.map((option) => option.label),
      });
      const selected = selections.shift();
      if (!selected || !request.options.some((option) => option.value === selected)) {
        throw new Error(`Unexpected selection ${selected} for ${request.message}`);
      }
      return selected as T;
    },
    async text() {
      const value = texts.shift();
      if (value === undefined) throw new Error('Unexpected text prompt');
      return value;
    },
    async password() {
      throw new Error('Unexpected authorization prompt');
    },
    async multiselect() {
      return [];
    },
    async confirm() {
      return true;
    },
    isCancel(value: unknown): value is symbol {
      return typeof value === 'symbol';
    },
    note() {},
  };
  return { prompts, menus };
}

async function runWithMenus(selections: string[]) {
  const { prompts, menus } = scriptedPrompts(selections);
  await runMcpServers(await getTuiContext(), undefined, {
    prompts,
    management: {
      addManagedMcpServer,
      listManagedMcpServers,
      reauthenticateManagedMcpServer,
      removeManagedMcpServer,
      updateManagedMcpServers,
    },
    getUserConfig: getUserWorkspaceConfig,
    resolveDestination: resolveMcpDestination,
  });
  expect(selections).toEqual([]);
  return menus;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'allagents-tui-mcp-destination-'));
  home = join(root, 'home');
  project = join(root, 'project');
  userConfig = join(home, '.allagents', 'workspace.yaml');
  await mkdir(join(home, '.allagents'), { recursive: true });
  await mkdir(project);
  await writeFile(userConfig, `repositories: []
plugins: []
clients: [claude, copilot]
profiles:
  compound-engineering:
    clients:
      - name: claude
`);
  process.env.HOME = home;
  process.env.ALLAGENTS_TEST_HOME = home;
  process.chdir(project);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalTestHome === undefined) delete process.env.ALLAGENTS_TEST_HOME;
  else process.env.ALLAGENTS_TEST_HOME = originalTestHome;
  await rm(root, { recursive: true, force: true });
});

describe('MCP destination chooser', () => {
  test('offers Project beside User and profiles before a workspace exists, and creates only the project declaration', async () => {
    expect((await getTuiContext()).hasWorkspace).toBe(false);
    const before = await readFile(userConfig, 'utf8');
    const menus = await runWithMenus([
      'project', '__add__', 'stdio', '__back__', '__back__',
    ]);

    expect(menus[0]?.labels).toEqual([
      'Project', 'User', 'Profile: compound-engineering', 'Back',
    ]);
    const workspace = load(
      await readFile(join(project, '.allagents', 'workspace.yaml'), 'utf8'),
    ) as { clients: string[]; mcpServers: Record<string, unknown> };
    expect(workspace.mcpServers.deepwiki).toEqual({ type: 'stdio', command: 'echo' });
    expect(workspace.clients).toEqual(['universal']);
    expect(await readFile(userConfig, 'utf8')).toBe(before);
  });

  test('syncs a project server to Claude and Copilot when both project clients are configured', async () => {
    await mkdir(join(project, '.allagents'));
    await writeFile(join(project, '.allagents', 'workspace.yaml'),
      'repositories: []\nplugins: []\nclients: [claude, copilot]\n');
    await runWithMenus(['project', '__add__', 'stdio', '__back__', '__back__']);

    for (const path of ['.mcp.json', join('.github', 'mcp.json')]) {
      const config = JSON.parse(await readFile(join(project, path), 'utf8')) as {
        mcpServers: Record<string, unknown>;
      };
      expect(config.mcpServers.deepwiki).toEqual({ type: 'stdio', command: 'echo' });
    }
  });

  test('does not offer Project when the working directory aliases the user workspace', async () => {
    process.chdir(home);
    const menus = await runWithMenus(['__back__']);
    expect(menus[0]?.labels).toEqual([
      'User', 'Profile: compound-engineering', 'Back',
    ]);
    expect(existsSync(join(home, '.mcp.json'))).toBe(false);
  });
});
