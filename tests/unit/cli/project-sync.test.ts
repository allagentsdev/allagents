import { afterEach, expect, test } from 'bun:test';
import { createLegacyVscodeImportConfirmation } from '../../../src/cli/project-sync.js';
import { setJsonMode } from '../../../src/cli/json-output.js';

const preview = {
  workspacePath: '/tmp/project',
  added: [{ path: './new' }],
  removed: [],
  renamed: [{ path: './repo', beforeName: 'YAML name', afterName: 'Editor name' }],
};
afterEach(() => setJsonMode(false));

test('--yes approves legacy imports without terminal interaction, including JSON', async () => {
  setJsonMode(true);
  expect(await createLegacyVscodeImportConfirmation({ yes: true })(preview)).toBe(true);
});

test('redirected legacy imports explain how to approve without attempting a prompt', () => {
  const worker = Bun.spawnSync([process.execPath, new URL('./project-sync-prompt.worker.ts', import.meta.url).pathname, '--redirected'], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  expect(worker.exitCode).toBe(0);
  const result = JSON.parse(worker.stdout.toString());
  expect(result.error).toContain('--yes');
  expect(result.events).toEqual([]);
});

test('JSON legacy imports require explicit approval and keep stdout machine readable', async () => {
  setJsonMode(true);
  await expect(createLegacyVscodeImportConfirmation()(preview)).rejects.toThrow('--yes');
});

test('interactive confirmation defaults to No, sanitizes affected values, and resumes progress after accept, decline or cancel', () => {
  const worker = Bun.spawnSync([process.execPath, new URL('./project-sync-prompt.worker.ts', import.meta.url).pathname]);
  expect(worker.exitCode).toBe(0);
  const { results, events } = JSON.parse(worker.stdout.toString());
  expect(results).toEqual([false, true, false]);
  for (let offset = 0; offset < events.length; offset += 4) {
    expect(events[offset]).toEqual({ stop: 'Repository confirmation needed' });
    expect(events[offset + 1].message).toContain('Add: ../new ("New")');
    expect(events[offset + 1].message).toContain('Remove: ../gone');
    expect(events[offset + 1].message).toContain('Add: ../empty ("")');
    expect(events[offset + 1].message).toContain('Name: ../unnamed: (default name) → ""');
    expect(events[offset + 1].message).toContain('→ "VS Code"');
    expect(events[offset + 1].message).not.toContain('\u001b');
    expect(events[offset + 2].initialValue).toBe(false);
    expect(events[offset + 3]).toEqual({ start: 'Updating...' });
  }
});
