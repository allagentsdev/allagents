import { expect, test } from 'bun:test';
import { join } from 'node:path';

// Real Git fixtures must run apart from unit suites that mock Git modules.
test('native and file update boundaries with isolated Git modules', () => {
  const result = Bun.spawnSync([process.execPath, 'test', join(import.meta.dir, 'tui-native-update-boundaries.worker.ts')], {
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
}, 30_000);
