import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('GitHub workspace fetching preserves module isolation', () => {
  // Git module replacements and error constructors must not cross suite boundaries.
  const result = Bun.spawnSync([
    process.execPath,
    'test',
    join(import.meta.dir, 'github-fetch.worker.ts'),
  ], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
}, 30_000);
