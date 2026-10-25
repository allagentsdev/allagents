import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('native marketplace registration preserves module isolation', () => {
  // Module mocks persist across test files; keep this integration fixture isolated.
  const result = Bun.spawnSync([
    process.execPath,
    'test',
    join(import.meta.dir, 'native-marketplace-registration.worker.ts'),
  ], { env: process.env, stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
}, 30_000);
