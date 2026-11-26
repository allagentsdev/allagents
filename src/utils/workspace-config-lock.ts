import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

async function readLockOwner(lockPath: string): Promise<string | null> {
  return readFile(join(lockPath, 'owner'), 'utf8').catch(() => null);
}

async function isStaleLock(
  lockPath: string,
  modifiedAt: number,
): Promise<boolean> {
  const owner = await readLockOwner(lockPath);
  const pid = Number(owner?.split(':')[0]);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return Date.now() - modifiedAt > STALE_LOCK_MS;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

export async function withWorkspaceConfigLock<T>(
  configPath: string,
  mutate: () => Promise<T>,
): Promise<T> {
  const lockPath = `${configPath}.lock`;
  const breakPath = `${lockPath}.break`;
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let acquired = false;
  while (!acquired) {
    let created = false;
    try {
      await mkdir(lockPath, { mode: 0o700 });
      created = true;
      await writeFile(join(lockPath, 'owner'), token, {
        encoding: 'utf8',
        mode: 0o600,
      });
      acquired = true;
    } catch (error) {
      if (created) {
        await rm(lockPath, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const lockStats = await lstat(lockPath).catch(() => null);
      if (lockStats && (await isStaleLock(lockPath, lockStats.mtimeMs))) {
        let breaker = false;
        try {
          await mkdir(breakPath, { mode: 0o700 });
          breaker = true;
          const currentStats = await lstat(lockPath).catch(() => null);
          if (
            currentStats &&
            (await isStaleLock(lockPath, currentStats.mtimeMs))
          ) {
            await rm(lockPath, { recursive: true, force: true });
          }
        } catch (breakError) {
          if ((breakError as NodeJS.ErrnoException).code !== 'EEXIST') {
            throw breakError;
          }
        } finally {
          if (breaker) {
            await rm(breakPath, { recursive: true, force: true }).catch(
              () => undefined,
            );
          }
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting to update ${configPath}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting to update ${configPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await mutate();
  } finally {
    if ((await readLockOwner(lockPath)) === token) {
      await rm(lockPath, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}
