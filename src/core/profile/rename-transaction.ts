import { randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  open,
  readFile,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { z } from 'zod';
import { ProfileSha256Schema } from '../../models/profile-state.js';
import { ProfileNameSchema } from '../../models/workspace-config.js';
import {
  assertSafeProfilePath,
  fingerprintProfileFile,
  sha256Fingerprint,
} from './files.js';
import { getProfileStatePath } from './state.js';

const RelativePath = z
  .string()
  .refine(
    (path) =>
      !isAbsolute(path) &&
      path
        .split(sep)
        .every((part) => part !== '' && part !== '.' && part !== '..'),
  );
const Replacement = z.object({
  before: ProfileSha256Schema,
  content: z.string(),
});
export const RenameRecordSchema = z.object({
  version: z.literal(1),
  id: z.uuid(),
  profile: ProfileNameSchema,
  newProfile: ProfileNameSchema,
  workspaceBefore: ProfileSha256Schema,
  workspaceAfter: ProfileSha256Schema,
  root: z
    .object({
      device: z.string(),
      inode: z.string(),
      namedFiles: z.array(
        z.object({
          from: RelativePath,
          to: RelativePath,
          fingerprint: ProfileSha256Schema,
        }),
      ),
      state: Replacement.optional(),
    })
    .optional(),
  launchers: z.array(
    Replacement.extend({
      name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,67}$/),
      mode: z.number().int().min(0).max(0o777),
    }),
  ),
});

export type RenameRecord = z.infer<typeof RenameRecordSchema>;

export function profileRenameRecordPath(workspacePath: string): string {
  return `${workspacePath}.profile-rename.json`;
}

export async function profileRenameStats(path: string) {
  return lstat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
}

export async function assertNoPendingProfileRename(
  workspacePath: string,
): Promise<void> {
  if (await profileRenameStats(profileRenameRecordPath(workspacePath))) {
    throw new Error(
      'A profile rename is incomplete. Rerun the same profile rename with --yes before changing profiles.',
    );
  }
}

export async function readProfileRenameRecord(
  path: string,
): Promise<RenameRecord | null> {
  await assertSafeProfilePath(dirname(path), path);
  const stats = await profileRenameStats(path);
  if (!stats) return null;
  if (!stats.isFile())
    throw new Error(
      `Profile rename recovery record is not a regular file: ${path}`,
    );
  const text = await readFile(path, 'utf8');
  const result = RenameRecordSchema.safeParse(JSON.parse(text));
  if (!result.success) {
    throw new Error(`Invalid profile rename recovery record at ${path}`);
  }
  return result.data;
}

/** Publish one replacement atomically. The recovery record tracks either version. */
export async function publishRenameFile(
  path: string,
  content: string,
  previous: string | null,
  mode: number,
  transactionId?: string,
): Promise<void> {
  const parent = dirname(path);
  await assertSafeProfilePath(parent, path);
  const temporary = join(
    parent,
    `.${basename(path)}.profile-rename-${transactionId ?? randomUUID()}.tmp`,
  );
  if (transactionId) {
    // A previous process may have exited while staging this transaction's file.
    await assertSafeProfilePath(parent, temporary);
    await rm(temporary, { force: true });
  }
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    await assertSafeProfilePath(parent, path);
    if (previous === null) {
      await link(temporary, path);
    } else {
      const current = await fingerprintProfileFile(path);
      if (current === sha256Fingerprint(content)) return;
      if (current !== previous) throw changed(path);
      await rename(temporary, path);
    }
  } finally {
    await handle.close();
    await rm(temporary, { force: true });
  }
}

function changed(path: string): Error {
  return new Error(`Profile rename found a missing or changed file at ${path}`);
}

export async function getRenameRootIdentity(path: string) {
  return lstat(path, { bigint: true }).then(
    (stats) => {
      if (!stats.isDirectory())
        throw new Error(`Profile root is not a directory: ${path}`);
      return { device: String(stats.dev), inode: String(stats.ino) };
    },
    (error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    },
  );
}

export function relativeRenamePath(root: string, path: string): string {
  return RelativePath.parse(relative(root, path));
}

/**
 * Validate the complete current layout before touching it. Every checkpoint can
 * be recognized by file hash or inode, including a stop between link and unlink.
 */
export async function inspectRenameProgress(
  record: RenameRecord,
  oldRoot: string,
  newRoot: string,
  binDir: string,
) {
  await assertSafeProfilePath(dirname(oldRoot), oldRoot);
  await assertSafeProfilePath(dirname(newRoot), newRoot);
  const oldIdentity = await getRenameRootIdentity(oldRoot);
  const newIdentity = await getRenameRootIdentity(newRoot);
  const identity = oldIdentity ?? newIdentity;
  if (newIdentity && (!record.root || oldIdentity)) {
    throw new Error(`Profile destination already exists: ${newRoot}`);
  }
  if (
    identity?.inode !== record.root?.inode ||
    identity?.device !== record.root?.device
  ) {
    throw new Error(`Profile directory changed during rename: ${oldRoot}`);
  }
  const currentRoot = newIdentity ? newRoot : oldRoot;
  const moves = [];
  for (const move of record.root?.namedFiles ?? []) {
    const from = join(currentRoot, move.from);
    const to = join(currentRoot, move.to);
    await assertSafeProfilePath(currentRoot, from);
    await assertSafeProfilePath(currentRoot, to);
    const source = await fingerprintProfileFile(from);
    const destination = await fingerprintProfileFile(to);
    if (destination !== null) {
      const sourceStats = await profileRenameStats(from);
      const targetStats = await profileRenameStats(to);
      if (
        oldIdentity ||
        destination !== move.fingerprint ||
        (sourceStats &&
          (sourceStats.ino !== targetStats?.ino ||
            sourceStats.dev !== targetStats.dev))
      ) {
        throw new Error(`Profile file destination already exists: ${to}`);
      }
    }
    if (source !== null ? source !== move.fingerprint : destination === null) {
      throw changed(from);
    }
    moves.push({ ...move, source, destination });
  }
  const replacements = record.launchers.map(({ name, ...entry }) => ({
    ...entry,
    path: join(binDir, name),
  }));
  if (record.root?.state) {
    replacements.push({
      ...record.root.state,
      mode: 0o600,
      path: getProfileStatePath(currentRoot),
    });
  }
  for (const entry of replacements) {
    await assertSafeProfilePath(dirname(entry.path), entry.path);
    const fingerprint = await fingerprintProfileFile(entry.path);
    if (
      fingerprint !== entry.before &&
      fingerprint !== sha256Fingerprint(entry.content)
    ) {
      throw changed(entry.path);
    }
  }
  return { moveRoot: oldIdentity !== null, moves };
}

export async function moveNamedProfileFile(
  root: string,
  move: Awaited<ReturnType<typeof inspectRenameProgress>>['moves'][number],
): Promise<void> {
  if (move.source === null) return;
  const from = join(root, move.from);
  const to = join(root, move.to);
  await assertSafeProfilePath(root, from);
  await assertSafeProfilePath(root, to);
  if ((await fingerprintProfileFile(from)) !== move.fingerprint)
    throw changed(from);
  if (move.destination === null) await link(from, to);
  const source = await lstat(from, { bigint: true });
  const destination = await lstat(to, { bigint: true });
  if (source.ino !== destination.ino || source.dev !== destination.dev)
    throw changed(to);
  await unlink(from);
}
