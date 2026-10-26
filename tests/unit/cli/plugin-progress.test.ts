import { expect, test } from 'bun:test';

const modulePath = new URL('../../../src/cli/plugin-progress.ts', import.meta.url).pathname;
const jsonModule = new URL('../../../src/cli/json-output.ts', import.meta.url).pathname;

function probe(mode: 'tty' | 'redirected' | 'json', body: string) {
  const result = Bun.spawnSync([process.execPath, '-e', `
    import {mock} from 'bun:test';
    import {setJsonMode} from ${JSON.stringify(jsonModule)};
    Object.defineProperty(process.stdout,'isTTY',{value:${mode !== 'redirected'}});
    setJsonMode(${mode === 'json'});
    const messages=[]; const forwarded=[];
    const spinner={start:m=>messages.push(m),stop:m=>messages.push(m),message:m=>messages.push(m)};
    mock.module('@clack/prompts',()=>({spinner:()=>spinner}));
    const {withPluginProgress}=await import(${JSON.stringify(modulePath)});
    const event=(cachePath,phase,source='owner/repo')=>({cachePath,phase,source,ref:'main'});
    ${body}
    console.log(JSON.stringify({messages,forwarded}));
  `], { stdout: 'pipe', stderr: 'pipe' });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stderr.toString()).toBe('');
  return JSON.parse(result.stdout.toString());
}

test('terminal progress identifies the operation and retains other pending sources', () => {
  const { messages, forwarded } = probe('tty', `
    await withPluginProgress(async report=>{
      report(event('one','checking','owner/one\u001b[2J'));
      report(event('two','downloading','owner/two'));
      report(event('two','ready','owner/two'));
      report(event('one','updating','owner/one'));
      report(event('one','cached','owner/one'));
    },{spinner,onPluginProgress:e=>forwarded.push(e.phase)});
  `);
  expect(messages[0]).toContain('Checking upstream: owner/one (main)');
  expect(messages[1]).toContain('(+1 more)');
  expect(messages[2]).toContain('Checking upstream: owner/one');
  expect(messages[3]).toContain('Updating plugin source: owner/one');
  expect(messages[4]).toContain('Using cached content (remote refresh failed)');
  expect(messages.at(-2)).toContain('using cached content for 1 source(s)');
  expect(messages.at(-1)).toBe('Updating workspace...');
  expect(messages.join('')).not.toContain('\u001b');
  expect(forwarded).toEqual(['checking', 'downloading', 'ready', 'updating', 'cached']);
});

for (const mode of ['redirected', 'json'] as const) {
  test(`${mode} output stays silent while caller callbacks still receive stages`, () => {
    const { messages, forwarded } = probe(mode, `
      await withPluginProgress(async report=>report(event('one','checking')),
        {spinner,onPluginProgress:e=>forwarded.push(e.phase)});
    `);
    expect(messages).toEqual([]);
    expect(forwarded).toEqual(['checking']);
  });
}

test('an interrupted refresh settles the progress display and preserves the failure', () => {
  const { messages } = probe('tty', `
    try {
      await withPluginProgress(async report=>{report(event('one','checking'));throw Error('interrupted');},{spinner});
      throw Error('unexpected success');
    } catch(error) { if(error.message!=='interrupted') throw error; }
  `);
  expect(messages.at(-1)).toBe('Plugin source refresh failed');
});

test('owned progress stops after remote work before subsequent confirmation prompts', () => {
  const { messages } = probe('tty', `
    await withPluginProgress(async report=>{
      report(event('one','checking'));
      report(event('one','current'));
      messages.push('confirmation prompt');
    });
  `);
  expect(messages.at(-1)).toBe('confirmation prompt');
  expect(messages.at(-2)).toBe('Plugin sources ready');
});
