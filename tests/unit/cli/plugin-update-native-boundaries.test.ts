import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('CLI plugin updates preserve native and file declaration boundaries', () => {
  const result = Bun.spawnSync([process.execPath, 'test', join(import.meta.dir, 'plugin-update-native-boundaries.worker.ts')], {
    env: process.env, stdout: 'pipe', stderr: 'pipe',
  });
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
}, 30_000);
