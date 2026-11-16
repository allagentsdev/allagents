import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('portable profile installation uses real Git independently of other suites', () => {
  const result = Bun.spawnSync([
    process.execPath,
    'test',
    join(import.meta.dir, 'portable-source.worker.ts'),
  ], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
}, 30_000);
