#!/usr/bin/env bun
/**
 * Build a standalone AllAgents executable for one platform.
 *
 * The binary embeds the production bundle, the workspace templates, and the
 * CLI version, so the archive it produces is self-contained.
 *
 * Usage:
 *   bun run scripts/build-binary.ts --list
 *   bun run scripts/build-binary.ts <target> [outputDir]
 *
 * Targets: linux-x64, linux-arm64, darwin-x64, darwin-arm64, windows-x64
 */

import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { $ } from 'bun';
import { createThirdPartyNotices } from './build-package';

const PROJECT_ROOT = resolve(import.meta.dir, '..');
const DEFAULT_OUTPUT_DIR = join(PROJECT_ROOT, 'dist-binaries');
const NOTICES_FILE = 'THIRD_PARTY_NOTICES.txt';

type TargetName =
  | 'linux-x64'
  | 'linux-arm64'
  | 'darwin-x64'
  | 'darwin-arm64'
  | 'windows-x64';

const TARGETS: Record<TargetName, { bunTarget: string; executable: string }> = {
  'linux-x64': { bunTarget: 'bun-linux-x64', executable: 'allagents' },
  'linux-arm64': { bunTarget: 'bun-linux-arm64', executable: 'allagents' },
  'darwin-x64': { bunTarget: 'bun-darwin-x64', executable: 'allagents' },
  'darwin-arm64': { bunTarget: 'bun-darwin-arm64', executable: 'allagents' },
  'windows-x64': { bunTarget: 'bun-windows-x64', executable: 'allagents.exe' },
};

const TARGET_NAMES = Object.keys(TARGETS) as TargetName[];

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseTarget(value: string | undefined): TargetName {
  if (!value || !TARGET_NAMES.includes(value as TargetName)) {
    fail(
      `Error: unknown target '${value ?? ''}'\nUsage: bun run scripts/build-binary.ts <${TARGET_NAMES.join('|')}> [outputDir]`,
    );
  }
  return value as TargetName;
}

async function packageVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(PROJECT_ROOT, 'package.json'), 'utf8'),
  ) as { version: string };
  return manifest.version;
}

async function buildBinary(target: TargetName, outputDir: string) {
  const { bunTarget, executable } = TARGETS[target];
  const version = await packageVersion();
  const stagingDir = join(outputDir, `.staging-${target}`);
  const executablePath = join(stagingDir, executable);
  const metafilePath = join(stagingDir, 'metafile.json');
  const archivePath = join(
    outputDir,
    `allagents-${version}-${target}.tar.gz`,
  );

  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  console.log(`Building ${target} (${bunTarget})...`);
  await $`bun build --compile --target=${bunTarget} --minify --asset src/templates --metafile=${metafilePath} src/cli/index.ts --outfile=${executablePath}`
    .cwd(PROJECT_ROOT)
    .quiet();

  await chmod(executablePath, 0o755).catch(() => undefined);

  const metafile = JSON.parse(
    await readFile(metafilePath, 'utf8'),
  ) as Bun.BuildMetafile;
  await writeFile(
    join(stagingDir, NOTICES_FILE),
    await createThirdPartyNotices(metafile, PROJECT_ROOT),
    'utf8',
  );
  await rm(metafilePath, { force: true });

  await rm(archivePath, { force: true });
  await $`tar -czf ${archivePath} -C ${stagingDir} ${executable} ${NOTICES_FILE}`.quiet();
  await rm(stagingDir, { recursive: true, force: true });

  console.log(`Wrote ${archivePath}`);
}

const args = process.argv.slice(2);

if (args[0] === '--list') {
  console.log(JSON.stringify(TARGET_NAMES));
} else {
  const target = parseTarget(args[0]);
  const outputDir = resolve(args[1] ?? DEFAULT_OUTPUT_DIR);
  await mkdir(outputDir, { recursive: true });
  await buildBinary(target, outputDir);
}
