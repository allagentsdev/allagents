import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cliEntry = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');
let root: string;
let home: string;
let workspace: string;
let marketplace: string;

async function runMarketplaceAdd(args: string[] = []): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const process = Bun.spawn(
    [
      'bun',
      'run',
      cliEntry,
      '--json',
      'plugin',
      'marketplace',
      'add',
      marketplace,
      ...args,
    ],
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

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'allagents-marketplace-add-options-'));
  home = join(root, 'home');
  workspace = join(root, 'workspace');
  marketplace = join(root, 'marketplace');
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(join(marketplace, '.claude-plugin'), { recursive: true });
  await writeFile(
    join(marketplace, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name: 'marketplace', owner: { name: 'Test' }, plugins: [] }),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('plugin marketplace add options', () => {
  test('rejects the removed --force flag', async () => {
    const result = await runMarketplaceAdd(['--force']);

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('--force');
  });

  test('re-registering a marketplace replaces the existing registration', async () => {
    const first = await runMarketplaceAdd();
    expect(first.exitCode).toBe(0);

    const second = await runMarketplaceAdd();
    expect(second.exitCode).toBe(0);

    const output = JSON.parse(second.stdout) as {
      success: boolean;
      data: { marketplace: { name: string; path: string; replaced?: boolean } };
    };
    expect(output.success).toBe(true);
    expect(output.data.marketplace.name).toBe('marketplace');
    expect(output.data.marketplace.path).toBe(marketplace);
    expect(output.data.marketplace.replaced).toBe(true);
  });
});
