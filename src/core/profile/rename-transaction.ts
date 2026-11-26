import { randomUUID } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
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
const DirectoryIdentity = z.object({ device: z.string(), inode: z.string() });
export const RenameRecordSchema = z.object({
  version: z.literal(1),
  id: z.uuid(),
  profile: ProfileNameSchema,
  newProfile: ProfileNameSchema,
  declarationDigest: ProfileSha256Schema,
  workspaceBefore: ProfileSha256Schema,
  root: DirectoryIdentity.extend({
    reservation: DirectoryIdentity.optional(),
    namedFiles: z.array(
      z.object({
        from: RelativePath,
        to: RelativePath,
        fingerprint: ProfileSha256Schema,
      }),
    ),
    state: Replacement.optional(),
  }).optional(),
  launchers: z.array(
    Replacement.extend({
      name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,67}$/),
      mode: z.number().int().min(0).max(0o777),
    }),
  ),
});

export type RenameRecord = z.infer<typeof RenameRecordSchema>;

export async function profileRenameStats(path: string) {
  return lstat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
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

export function capturedRenameFile(
  path: string,
  transactionId: string,
): string {
  return join(
    dirname(path),
    `.${basename(path)}.profile-rename-${transactionId}.previous`,
  );
}

async function stageRenameFile<T>(
  path: string,
  content: string,
  mode: number,
  transactionId: string | undefined,
  publish: (temporary: string) => Promise<T>,
): Promise<T> {
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
    return await publish(temporary);
  } finally {
    await handle.close();
    await rm(temporary, { force: true });
  }
}

export async function writeRenameRecord(
  path: string,
  record: RenameRecord,
  replace = false,
): Promise<void> {
  await stageRenameFile(
    path,
    JSON.stringify(record),
    0o600,
    undefined,
    (temporary) => (replace ? rename(temporary, path) : link(temporary, path)),
  );
}

export async function inspectReplacement(
  path: string,
  before: string,
  after: string,
  transactionId: string,
) {
  const capture = capturedRenameFile(path, transactionId);
  await assertSafeProfilePath(dirname(path), capture);
  const [current, previous] = await Promise.all([
    fingerprintProfileFile(path),
    fingerprintProfileFile(capture),
  ]);
  if (previous !== null && previous !== before) {
    throw new Error(
      `Profile rename found an intervening edit preserved at ${capture}`,
    );
  }
  if (
    current !== before &&
    current !== after &&
    !(current === null && previous !== null)
  ) {
    throw changed(path);
  }
  return { current, capture, captured: previous !== null };
}

/** Capture before replacing so a concurrent edit can win without losing bytes. */
export async function publishRenameFile(
  path: string,
  content: string,
  before: string,
  mode: number,
  transactionId: string,
): Promise<void> {
  const after = sha256Fingerprint(content);
  await stageRenameFile(
    path,
    content,
    mode,
    transactionId,
    async (temporary) => {
      const { current, capture, captured } = await inspectReplacement(
        path,
        before,
        after,
        transactionId,
      );
      if (current === after) {
        if (captured) await unlink(capture);
        return;
      }
      if (!captured) await rename(path, capture);
      else if (current !== null) {
        const [source, previous] = await Promise.all([
          lstat(path, { bigint: true }),
          lstat(capture, { bigint: true }),
        ]);
        if (source.ino !== previous.ino || source.dev !== previous.dev)
          throw changed(path);
        await unlink(path);
      }

      if ((await fingerprintProfileFile(capture)) !== before) {
        // Restore the captured edit only if the original pathname is still free.
        try {
          await link(capture, path);
          await unlink(capture);
        } catch (error) {
          throw new Error(
            `Profile rename preserved a concurrent edit at ${capture}`,
            { cause: error },
          );
        }
        throw changed(path);
      }
      await link(temporary, path);
      if ((await fingerprintProfileFile(capture)) !== before) {
        throw new Error(
          `Profile rename preserved a concurrent edit at ${capture}`,
        );
      }
      await unlink(capture);
    },
  );
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

function sameDirectory(
  left: z.infer<typeof DirectoryIdentity> | null | undefined,
  right: z.infer<typeof DirectoryIdentity> | null | undefined,
): boolean {
  return left?.device === right?.device && left?.inode === right?.inode;
}

export async function moveProfileRoot(
  record: RenameRecord,
  journal: string,
  oldRoot: string,
  newRoot: string,
): Promise<void> {
  if (!record.root) throw changed(oldRoot);
  if (process.platform !== 'win32') {
    // POSIX rename can replace an empty directory. Exclusively reserve our
    // destination and only replace an empty directory with the recorded inode.
    let reservation = record.root.reservation;
    if (!(await profileRenameStats(newRoot))) {
      await mkdir(newRoot, { mode: 0o700 });
      reservation = (await getRenameRootIdentity(newRoot)) ?? undefined;
      if (!reservation) throw changed(newRoot);
      await writeRenameRecord(
        journal,
        { ...record, root: { ...record.root, reservation } },
        true,
      );
    }
    if (
      !sameDirectory(reservation, await getRenameRootIdentity(newRoot)) ||
      (await readdir(newRoot)).length > 0
    ) {
      throw new Error(`Profile destination already exists: ${newRoot}`);
    }
  } else if (await profileRenameStats(newRoot)) {
    throw new Error(`Profile destination already exists: ${newRoot}`);
  }
  if (!sameDirectory(await getRenameRootIdentity(oldRoot), record.root))
    throw changed(oldRoot);
  await rename(oldRoot, newRoot);
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
  if (
    newIdentity &&
    (!record.root ||
      (oldIdentity && !sameDirectory(newIdentity, record.root.reservation)))
  ) {
    throw new Error(`Profile destination already exists: ${newRoot}`);
  }
  if (!sameDirectory(identity, record.root)) {
    throw new Error(`Profile directory changed during rename: ${oldRoot}`);
  }
  if (oldIdentity && newIdentity && (await readdir(newRoot)).length > 0) {
    throw new Error(`Profile destination already exists: ${newRoot}`);
  }
  const currentRoot = oldIdentity ? oldRoot : newRoot;
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
    await inspectReplacement(
      entry.path,
      entry.before,
      sha256Fingerprint(entry.content),
      record.id,
    );
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
