import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOAuthJson, withOAuthLock, writeOAuthFile } from '../../../src/core/mcp-oauth-storage.js';

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-oauth-storage-'));
  directories.push(directory);
  return directory;
}

test('concurrent cache publication never exposes partial JSON and keeps files private', async () => {
  const directory = await fixture();
  const path = join(directory, 'cache/tokens.json');
  const payload = 'private-token'.repeat(5000);
  await writeOAuthFile(path, JSON.stringify({ version: 0, payload }));
  let finished = false;
  const writing = Promise.all(Array.from({ length: 30 }, (_, version) => writeOAuthFile(path, JSON.stringify({ version, payload })))).then(() => { finished = true; });
  let observations = 0;
  while (!finished) {
    const value = await readOAuthJson<{ version: number; payload: string }>(path);
    expect(value?.payload).toBe(payload);
    expect(Number.isInteger(value?.version)).toBe(true);
    observations++;
  }
  await writing;
  expect(observations).toBeGreaterThan(0);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await stat(join(directory, 'cache'))).mode & 0o777).toBe(0o700);
  expect(await readdir(join(directory, 'cache'))).toEqual(['tokens.json']);
});

test('an interrupted lock publication without an owner does not block the next owner', async () => {
  const directory = await fixture();
  const path = join(directory, 'authorization.lock');
  await mkdir(path);
  const result = await withOAuthLock(path, new AbortController().signal, 1000, async () => {
    await writeOAuthFile(join(directory, 'tokens.json'), JSON.stringify({ access_token: 'recovered' }));
    return 'recovered';
  });
  expect(result).toBe('recovered');
  expect(await readOAuthJson(join(directory, 'tokens.json'))).toEqual({ access_token: 'recovered' });
  expect(await readdir(path)).toEqual([]);
});

test('async work outliving a lock callback must acquire a new lease before touching its cache', async () => {
  const directory = await fixture();
  const path = join(directory, 'authorization.lock');
  const signal = new AbortController().signal;
  const resume = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let deferred: Promise<void> | undefined;
  let deferredEntered = false;
  await withOAuthLock(path, signal, 1000, async () => {
    deferred = (async () => {
      await resume.promise;
      await withOAuthLock(path, signal, 1000, async () => { deferredEntered = true; });
    })();
  });
  const current = withOAuthLock(path, signal, 1000, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  resume.resolve();
  await Bun.sleep(30);
  expect(deferredEntered).toBe(false);
  release.resolve();
  await current;
  await deferred;
  expect(deferredEntered).toBe(true);
});

test('outer lock release waits for a reentrant mutation that already started', async () => {
  const directory = await fixture();
  const path = join(directory, 'authorization.lock');
  const signal = new AbortController().signal;
  const childEntered = Promise.withResolvers<void>();
  const childRelease = Promise.withResolvers<void>();
  let child: Promise<void> | undefined;
  let challengerEntered = false;
  const outer = withOAuthLock(path, signal, 1000, async () => {
    child = withOAuthLock(path, signal, 1000, async () => { childEntered.resolve(); await childRelease.promise; });
    await childEntered.promise;
  });
  await childEntered.promise;
  const challenger = withOAuthLock(path, signal, 1000, async () => { challengerEntered = true; });
  await Bun.sleep(40);
  expect(challengerEntered).toBe(false);
  childRelease.resolve();
  await outer; await child; await challenger;
  expect(challengerEntered).toBe(true);
});

test('cancelling a draining lease returns promptly and keeps its child protected until completion', async () => {
  const directory = await fixture();
  const path = join(directory, 'authorization.lock');
  const controller = new AbortController();
  const childEntered = Promise.withResolvers<void>();
  const childRelease = Promise.withResolvers<void>();
  let child: Promise<void> | undefined;
  let challengerEntered = false;
  const outer = withOAuthLock(path, controller.signal, 1000, async () => {
    child = withOAuthLock(path, new AbortController().signal, 1000, async () => { childEntered.resolve(); await childRelease.promise; });
    await childEntered.promise;
  });
  await childEntered.promise;
  controller.abort(new Error('cancelled outer lease'));
  await expect(outer).rejects.toThrow('cancelled outer lease');
  const challenger = withOAuthLock(path, new AbortController().signal, 1000, async () => { challengerEntered = true; });
  await Bun.sleep(40);
  expect(challengerEntered).toBe(false);
  childRelease.resolve(); await child; await challenger;
  expect(challengerEntered).toBe(true);
  expect(await readdir(path)).toEqual([]);
});
