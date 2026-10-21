import { mock } from 'bun:test';

const events: unknown[] = [];
const cancelled = Symbol('cancelled');
let response: boolean | symbol = false;
mock.module('@clack/prompts', () => ({
  note: (message: string, title: string) => events.push({ message, title }),
  confirm: async (options: { initialValue: boolean }) => {
    events.push(options);
    return response;
  },
  isCancel: (value: unknown) => value === cancelled,
}));
const redirected = process.argv.includes('--redirected');
if (!redirected) {
  Object.defineProperty(process.stdin, 'isTTY', { value: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: true });
}
const { createLegacyVscodeImportConfirmation } = await import('../../../src/cli/project-sync.js');
const callback = createLegacyVscodeImportConfirmation({
  spinner: {
    stop: (message?: string) => events.push({ stop: message }),
    start: (message?: string) => events.push({ start: message }),
  },
});
const preview = {
  workspacePath: '/tmp/workspace\u001b[2J',
  added: [{ path: '../new', name: 'New' }, { path: '../empty', name: '' }],
  removed: [{ path: '../gone' }],
  renamed: [
    { path: '../repo', beforeName: 'YAML\u001b[2J', afterName: 'VS Code' },
    { path: '../unnamed', beforeName: undefined, afterName: '' },
  ],
};
if (redirected) {
  let error: string | undefined;
  try { await callback(preview); } catch (caught) { error = (caught as Error).message; }
  console.log(JSON.stringify({ error, events }));
} else {
  const results: boolean[] = [];
  for (response of [false, true, cancelled]) results.push(await callback(preview));
  console.log(JSON.stringify({ results, events }));
}
