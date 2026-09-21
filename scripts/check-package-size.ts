#!/usr/bin/env bun

import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { $ } from 'bun';

export type PackageSizes = {
  emittedJavaScript: number;
  unpackedPackage: number;
  compressedTarball: number;
};

export type Packument = {
  filename: string;
  size: number;
  unpackedSize: number;
  files: Array<{ path: string }>;
};

export type CheckedPackageTarball = {
  artifact: Packument;
  sizes: PackageSizes;
  tarballPath: string;
  cleanup: () => Promise<void>;
};

export const PACKAGE_SIZE_BUDGETS: PackageSizes = {
  emittedJavaScript: 1_650_000,
  unpackedPackage: 1_800_000,
  compressedTarball: 525_000,
};

const LABELS: Record<keyof PackageSizes, string> = {
  emittedJavaScript: 'emitted JavaScript',
  unpackedPackage: 'unpacked package',
  compressedTarball: 'compressed tarball',
};

function bytesLabel(bytes: number): string {
  return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
}

export function assertPackageSizeBudgets(
  sizes: PackageSizes,
  budgets: PackageSizes,
): void {
  const failures = (Object.keys(LABELS) as Array<keyof PackageSizes>).flatMap(
    (key) => {
      const overage = sizes[key] - budgets[key];
      return overage > 0
        ? [
            `${LABELS[key]}: ${bytesLabel(sizes[key])} (budget: ${bytesLabel(budgets[key])}, over by ${bytesLabel(overage)})`,
          ]
        : [];
    },
  );

  if (failures.length > 0) {
    throw new Error(`Package size budget exceeded:\n${failures.join('\n')}`);
  }
}

export function parsePackument(stdout: string): Packument {
  // npm can prepend lifecycle output; npm 12 also changed the result from an
  // array to an object keyed by package name.
  const jsonStart =
    Math.max(stdout.lastIndexOf('\n['), stdout.lastIndexOf('\n{')) + 1;
  const parsed = JSON.parse(stdout.slice(jsonStart)) as
    | Packument[]
    | Record<string, Packument>;
  const artifact = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  if (!artifact) throw new Error('npm pack did not report a package artifact');
  return artifact;
}

async function checkedSizes(
  projectRoot: string,
  artifact: Packument,
): Promise<PackageSizes> {
  const entrypoint = join(projectRoot, 'dist', 'index.js');
  const entrypointStat = await stat(entrypoint).catch(() => {
    throw new Error(`Missing ${entrypoint}; run \`bun run build\` first`);
  });
  const sizes: PackageSizes = {
    emittedJavaScript: entrypointStat.size,
    unpackedPackage: artifact.unpackedSize,
    compressedTarball: artifact.size,
  };

  assertPackageSizeBudgets(sizes, PACKAGE_SIZE_BUDGETS);
  for (const key of Object.keys(LABELS) as Array<keyof PackageSizes>) {
    console.log(
      `✓ ${LABELS[key]}: ${bytesLabel(sizes[key])} / ${bytesLabel(PACKAGE_SIZE_BUDGETS[key])}`,
    );
  }
  return sizes;
}

export async function createCheckedPackageTarball(
  projectRoot = resolve(import.meta.dir, '..'),
): Promise<CheckedPackageTarball> {
  const packRoot = await mkdtemp(join(tmpdir(), 'allagents-package-'));

  try {
    const packed = await $`npm pack --json --ignore-scripts --pack-destination ${packRoot}`
      .cwd(projectRoot)
      .quiet();
    const artifact = parsePackument(packed.stdout.toString());
    const tarballPath = resolve(packRoot, artifact.filename);
    if (dirname(tarballPath) !== packRoot) {
      throw new Error(`npm pack returned an unsafe filename: ${artifact.filename}`);
    }
    await stat(tarballPath);
    const sizes = await checkedSizes(projectRoot, artifact);
    let cleaned = false;

    return {
      artifact,
      sizes,
      tarballPath,
      cleanup: async () => {
        if (cleaned) return;
        cleaned = true;
        await rm(packRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(packRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function checkPackageSize(
  projectRoot = resolve(import.meta.dir, '..'),
): Promise<PackageSizes> {
  const packed = await $`npm pack --dry-run --json --ignore-scripts`
    .cwd(projectRoot)
    .quiet();
  return checkedSizes(projectRoot, parsePackument(packed.stdout.toString()));
}

if (import.meta.main) {
  await checkPackageSize();
}
