import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export async function readOAuthJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function writeOAuthFile(
  path: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function waitForOAuth(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

interface LockRecord {
  pid: number;
  nonce: string;
  choosing: boolean;
  ticket: number;
}

interface LocalLease {
  active: boolean;
  children: number;
  waiters: Set<() => void>;
}

async function drainLease(lease: LocalLease): Promise<void> {
  while (lease.children > 0)
    await new Promise<void>((resolve) => lease.waiters.add(resolve));
  lease.active = false;
}

async function waitForLeaseDrain(
  drain: Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void drain
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}
const localLeases = new AsyncLocalStorage<ReadonlyMap<string, LocalLease>>();

function ownerIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * A filesystem bakery lock: each contender publishes its own choosing flag and
 * ticket, then waits for lower tickets (UUID breaks ties). Records are atomic;
 * release and dead-owner recovery only unlink that owner's unique filename.
 * The shared directory stays put, so a stale follower cannot retire a new lock.
 */
export async function withOAuthLock<T>(
  path: string,
  signal: AbortSignal,
  timeoutMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  signal.throwIfAborted();
  const lockPath = resolve(path);
  const parentLease = localLeases.getStore()?.get(lockPath);
  if (parentLease?.active) {
    parentLease.children++;
    try {
      return await operation();
    } finally {
      parentLease.children--;
      if (parentLease.children === 0) {
        for (const resolve of parentLease.waiters) resolve();
        parentLease.waiters.clear();
      }
    }
  }
  await mkdir(lockPath, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + timeoutMs;
  const owner: LockRecord = {
    pid: process.pid,
    nonce: randomUUID(),
    choosing: true,
    ticket: 0,
  };
  const filename = `${owner.pid}-${owner.nonce}.json`;
  const ownerPath = join(lockPath, filename);
  let lease: LocalLease | undefined;
  const records = async (): Promise<
    Array<{ filename: string; owner: LockRecord }>
  > => {
    const result: Array<{ filename: string; owner: LockRecord }> = [];
    for (const name of await readdir(lockPath)) {
      if (!/^\d+-[a-f0-9-]+\.json$/.test(name)) continue;
      const recordPath = join(lockPath, name);
      const record = await readOAuthJson<LockRecord>(recordPath);
      if (!record) continue;
      if (
        name !== `${record.pid}-${record.nonce}.json` ||
        !Number.isSafeInteger(record.pid) ||
        record.pid <= 0 ||
        !Number.isSafeInteger(record.ticket) ||
        record.ticket < 0 ||
        typeof record.choosing !== 'boolean'
      )
        throw new Error('Invalid OAuth lock owner record');
      if (!ownerIsAlive(record.pid)) {
        await rm(recordPath, { force: true });
        continue;
      }
      result.push({ filename: name, owner: record });
    }
    return result;
  };
  let outcome: { value: T } | { error: unknown };
  try {
    await writeOAuthFile(ownerPath, JSON.stringify(owner));
    const contenders = await records();
    owner.ticket =
      1 + Math.max(0, ...contenders.map((record) => record.owner.ticket));
    owner.choosing = false;
    await writeOAuthFile(ownerPath, JSON.stringify(owner));
    while (true) {
      signal.throwIfAborted();
      const blocked = (await records()).some(
        (record) =>
          record.filename !== filename &&
          (record.owner.choosing ||
            record.owner.ticket < owner.ticket ||
            (record.owner.ticket === owner.ticket &&
              record.filename < filename)),
      );
      if (!blocked) break;
      if (Date.now() >= deadline)
        throw new Error(
          'Timed out waiting for another OAuth authorization operation',
        );
      await waitForOAuth(Math.min(25, deadline - Date.now()), signal);
    }
    signal.throwIfAborted();
    lease = { active: true, children: 0, waiters: new Set() };
    const inherited = new Map(localLeases.getStore());
    inherited.set(lockPath, lease);
    outcome = { value: await localLeases.run(inherited, operation) };
  } catch (error) {
    outcome = { error };
  }
  const release = async () => {
    const current = await readOAuthJson<LockRecord>(ownerPath);
    if (current?.nonce === owner.nonce) await rm(ownerPath, { force: true });
  };
  if (lease) {
    const drain = drainLease(lease);
    try {
      await waitForLeaseDrain(drain, signal);
    } catch (error) {
      // Cancellation returns promptly, but an already running child retains
      // ownership until it finishes. Releasing early would permit cache races.
      void drain.then(release).catch(() => {});
      throw error;
    }
  }
  await release();
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}

export function oauthAuthorizationLockPath(cacheDir: string): string {
  return `${cacheDir}.authorization.lock`;
}
export function oauthTokenLockPath(cacheDir: string): string {
  return `${cacheDir}.token.lock`;
}
export async function readOAuthGeneration(cacheDir: string): Promise<string> {
  return (
    (await readOAuthJson<{ generation: string }>(`${cacheDir}.generation.json`))
      ?.generation ?? ''
  );
}

export async function runWithMcpOAuthReset<T>(
  cacheDir: string,
  operation: () => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const signal = options.signal ?? new AbortController().signal;
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  return withOAuthLock(
    oauthAuthorizationLockPath(cacheDir),
    signal,
    timeoutMs,
    () =>
      withOAuthLock(
        oauthTokenLockPath(cacheDir),
        signal,
        timeoutMs,
        async () => {
          // This marker stays outside the directory moved during backup/rollback.
          // A late SDK save can then recognize a response from before the reset.
          await writeOAuthFile(
            `${cacheDir}.generation.json`,
            JSON.stringify({ generation: randomUUID() }),
          );
          return operation();
        },
      ),
  );
}
