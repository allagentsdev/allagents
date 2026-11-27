import { randomUUID } from 'node:crypto';
import {
  readPrivateJson as readOAuthJson,
  withFilesystemLock as withOAuthLock,
  writePrivateFile as writeOAuthFile,
} from '../utils/filesystem-lock.js';

export {
  readPrivateJson as readOAuthJson,
  waitForLock as waitForOAuth,
  withFilesystemLock as withOAuthLock,
  writePrivateFile as writeOAuthFile,
} from '../utils/filesystem-lock.js';

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
