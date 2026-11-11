import { expect, test } from 'bun:test';
import { join } from 'node:path';

test('installed resource display and selection preserve source identities', () => {
  const result = Bun.spawnSync([process.execPath, 'test', join(import.meta.dir, 'tui-plugin-display.worker.ts')], {
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
}, 30_000);
