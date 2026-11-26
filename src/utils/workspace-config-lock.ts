import { lstat, rmdir } from 'node:fs/promises';
import { withFilesystemLock } from './filesystem-lock.js';

export function profileRenameRecordPath(workspacePath: string): string {
  return `${workspacePath}.profile-rename.json`;
}

export async function assertNoPendingProfileRename(
  workspacePath: string,
): Promise<void> {
  try {
    await lstat(profileRenameRecordPath(workspacePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new Error(
    'A profile rename is incomplete. Rerun the same profile rename with --yes before changing the workspace.',
  );
}

export async function withWorkspaceConfigLock<T>(
  configPath: string,
  mutate: () => Promise<T>,
): Promise<T> {
  const lockPath = `${configPath}.write-lock`;
  try {
    return await withFilesystemLock(lockPath, new AbortController().signal, 5000, mutate);
  } finally {
    // Non-empty directories belong to active contenders or interrupted owners.
    await rmdir(lockPath).catch(() => undefined);
  }
}

export function withWorkspaceConfigMutation<T>(
  configPath: string,
  mutate: () => Promise<T>,
): Promise<T> {
  return withWorkspaceConfigLock(configPath, async () => {
    await assertNoPendingProfileRename(configPath);
    return mutate();
  });
}
