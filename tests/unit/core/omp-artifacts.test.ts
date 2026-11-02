import { afterEach, describe, expect, it } from 'bun:test';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  collectSyncedPaths,
  selectivePurgeWorkspace,
} from '../../../src/core/sync.js';
import { copyHooks } from '../../../src/core/transform.js';
import type { SyncState } from '../../../src/models/sync-state.js';

describe('OMP hook sync', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('copies plugin hook factories into the project discovery path', async () => {
    root = await mkdtemp(join(tmpdir(), 'allagents-omp-hooks-'));
    const plugin = join(root, 'plugin');
    const workspace = join(root, 'workspace');
    const source = join(plugin, 'hooks', 'pre', 'guard.ts');
    await mkdir(join(plugin, 'hooks', 'pre'), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(source, 'export default function guard() {}\n');

    await copyHooks(plugin, workspace, 'omp');
    expect(
      await readFile(join(workspace, '.omp', 'hooks', 'pre', 'guard.ts'), 'utf8'),
    ).toBe('export default function guard() {}\n');
  });

  it('purges removed factories without deleting user-owned hooks', async () => {
    root = await mkdtemp(join(tmpdir(), 'allagents-omp-hooks-'));
    const plugin = join(root, 'plugin');
    const workspace = join(root, 'workspace');
    const sourceDir = join(plugin, 'hooks', 'pre');
    const destinationDir = join(workspace, '.omp', 'hooks', 'pre');
    const guard = join(sourceDir, 'guard.ts');
    const stale = join(sourceDir, 'stale.ts');
    await mkdir(sourceDir, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(guard, 'export default function guard() {}\n');
    await writeFile(stale, 'export default function stale() {}\n');

    const initialResults = await copyHooks(plugin, workspace, 'omp');
    const state: SyncState = {
      version: 1,
      lastSync: new Date(0).toISOString(),
      files: {
        omp: collectSyncedPaths(initialResults, workspace, ['omp']).omp ?? [],
      },
    };
    await writeFile(join(destinationDir, 'local.ts'), 'export default function local() {}\n');
    await rm(stale);

    await selectivePurgeWorkspace(workspace, state, ['omp']);
    await copyHooks(plugin, workspace, 'omp');

    await expect(readFile(join(destinationDir, 'stale.ts'), 'utf8')).rejects.toThrow();
    expect(await readFile(join(destinationDir, 'guard.ts'), 'utf8')).toContain('guard');
    expect(await readFile(join(destinationDir, 'local.ts'), 'utf8')).toContain('local');
  });

  it('rejects an invalid hook source before changing user-owned hooks', async () => {
    root = await mkdtemp(join(tmpdir(), 'allagents-omp-hooks-'));
    const plugin = join(root, 'plugin');
    const workspace = join(root, 'workspace');
    await mkdir(plugin, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(plugin, 'hooks'), 'not a directory\n');

    const personal = join(workspace, '.omp', 'hooks', 'personal.ts');
    await mkdir(join(workspace, '.omp', 'hooks'), { recursive: true });
    await writeFile(personal, 'export default function personal() {}\n');
    await expect(copyHooks(plugin, workspace, 'omp')).rejects.toThrow();
    expect(await readFile(personal, 'utf8')).toBe('export default function personal() {}\n');
  });

  it('rejects a hook destination beneath a symlinked client root', async () => {
    root = await mkdtemp(join(tmpdir(), 'allagents-omp-hooks-'));
    const plugin = join(root, 'plugin');
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    const source = join(plugin, 'hooks', 'pre', 'guard.ts');
    await mkdir(join(plugin, 'hooks', 'pre'), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(source, 'export default function guard() {}\n');
    await symlink(outside, join(workspace, '.omp'), 'dir');

    const results = await copyHooks(plugin, workspace, 'omp');

    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe('failed');
    await expect(readFile(join(outside, 'hooks', 'pre', 'guard.ts'), 'utf8')).rejects.toThrow();
  });
});
