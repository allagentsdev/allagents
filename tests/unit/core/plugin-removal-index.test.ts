import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, load } from 'js-yaml';
import { removePlugin } from '../../../src/core/workspace-modify.js';
import { removeUserPlugin } from '../../../src/core/user-workspace.js';
import { stubHomeDir } from '../../helpers/env.js';
import type { WorkspaceConfig } from '../../../src/models/workspace-config.js';

let root: string;
let home: string;
let project: string;
let restore: () => void;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'allagents-remove-index-'));
  home = join(root, 'home');
  project = join(root, 'project');
  restore = stubHomeDir(home);
});
afterEach(async () => {
  restore();
  await rm(root, { recursive: true, force: true });
});

for (const scope of ['user', 'project'] as const) {
  async function fixture() {
    const directory = scope === 'user' ? home : project;
    const path = join(directory, '.allagents', 'workspace.yaml');
    const source = join(root, 'compound-engineering');
    await mkdir(join(directory, '.allagents'), { recursive: true });
    await mkdir(source);
    const entries = [{ source, clients: ['pi'] }, { source, clients: ['codex'] }];
    await writeFile(path, dump({
      version: 2, repositories: [], clients: ['pi:native', 'codex'], plugins: entries,
      disabledSkills: ['compound-engineering:ce-work'],
    }));
    return { path, source, entries };
  }
  const remove = (source: string, index: number) => scope === 'user'
    ? removeUserPlugin(source, index)
    : removePlugin(source, project, index);

  test(`${scope} removal selects the second same-source declaration without pruning its sibling`, async () => {
    const { path, source, entries } = await fixture();
    const result = await remove(source, 1);
    expect(result.success).toBe(true);
    const config = load(await readFile(path, 'utf8')) as WorkspaceConfig;
    expect(config.plugins).toEqual([entries[0]]);
    expect(config.disabledSkills).toEqual(['compound-engineering:ce-work']);
    expect(config.clients).toEqual(['pi:native', 'codex']);
  });

  test(`${scope} indexed removal refuses drift rather than falling back to a matching source`, async () => {
    const { path, source } = await fixture();
    const before = await readFile(path, 'utf8');
    const result = await remove(source, 5);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Selected plugin declaration changed');
    expect(await readFile(path, 'utf8')).toBe(before);
  });
}
