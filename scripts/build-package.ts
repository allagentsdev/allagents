#!/usr/bin/env bun

import {
  chmod,
  cp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

const LICENSE_FILE_PATTERN = /^(?:licen[cs]e|copying|notice)(?:\.|-|$)/i;

export type BundledPackage = {
  name: string;
  packageRoot: string;
};

function bundledPackageFromInput(
  inputPath: string,
): BundledPackage | undefined {
  const normalized = inputPath.replaceAll('\\', '/');
  const marker = 'node_modules/';
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex === -1) return undefined;

  const packagePath = normalized.slice(markerIndex + marker.length);
  const segments = packagePath.split('/');
  const segmentCount = segments[0]?.startsWith('@') ? 2 : 1;
  if (segments.length < segmentCount || !segments[0]) return undefined;

  const name = segments.slice(0, segmentCount).join('/');
  const packageRootEnd =
    markerIndex + marker.length + name.length;
  return {
    name,
    packageRoot: normalized.slice(0, packageRootEnd),
  };
}

export function bundledPackages(metafile: Bun.BuildMetafile): BundledPackage[] {
  const packagesByRoot = new Map<string, BundledPackage>();

  for (const output of Object.values(metafile.outputs)) {
    for (const [inputPath, contribution] of Object.entries(output.inputs)) {
      if (contribution.bytesInOutput <= 0) continue;
      const bundledPackage = bundledPackageFromInput(inputPath);
      if (bundledPackage) {
        packagesByRoot.set(bundledPackage.packageRoot, bundledPackage);
      }
    }
  }

  return [...packagesByRoot.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name, 'en') ||
      left.packageRoot.localeCompare(right.packageRoot, 'en'),
  );
}

function formatDeclaredLicense(license: unknown): string {
  if (typeof license === 'string' && license.trim()) return license.trim();
  if (license !== undefined) return JSON.stringify(license);
  return 'Not declared';
}

export async function createThirdPartyNotices(
  metafile: Bun.BuildMetafile,
  projectRoot: string,
): Promise<string> {
  const sections = await Promise.all(
    bundledPackages(metafile).map(async ({ name, packageRoot }) => {
      const resolvedPackageRoot = resolve(projectRoot, packageRoot);
      const packageJson = JSON.parse(
        await readFile(join(resolvedPackageRoot, 'package.json'), 'utf8'),
      ) as { name?: string; version?: string; license?: unknown };
      const licenseFiles = (await readdir(resolvedPackageRoot))
        .filter((fileName) => LICENSE_FILE_PATTERN.test(fileName))
        .sort((left, right) => left.localeCompare(right, 'en'));
      const licenseTexts = await Promise.all(
        licenseFiles.map(async (fileName) => {
          const contents = (
            await readFile(join(resolvedPackageRoot, fileName), 'utf8')
          ).trim();
          return `--- ${fileName} ---\n${contents}`;
        }),
      );

      return [
        '===============================================================================',
        `${packageJson.name ?? name}@${packageJson.version ?? 'unknown'}`,
        `Bundled from: ${packageRoot}`,
        `License: ${formatDeclaredLicense(packageJson.license)}`,
        licenseTexts.length > 0
          ? licenseTexts.join('\n\n')
          : 'No license or notice file was included in this package.',
      ].join('\n');
    }),
  );

  return [
    'AllAgents Third-Party Notices',
    '',
    'This file is generated from the packages embedded in dist/index.js.',
    'Do not edit it by hand.',
    '',
    ...sections,
    '',
  ].join('\n');
}

async function buildPackage() {
  const projectRoot = resolve(import.meta.dir, '..');
  const distPath = join(projectRoot, 'dist');
  await rm(distPath, { recursive: true, force: true });

  const result = await Bun.build({
    entrypoints: [join(projectRoot, 'src', 'cli', 'index.ts')],
    outdir: distPath,
    target: 'node',
    packages: 'bundle',
    minify: true,
    metafile: true,
  });
  if (!result.success || !result.metafile) {
    throw new Error('Production bundle build failed');
  }

  const metafile = result.metafile;
  const externalImports = Object.values(metafile.outputs).flatMap((output) =>
    output.imports.map((entry) => entry.path),
  );
  if (externalImports.length > 0) {
    throw new Error(
      `Production bundle is not self-contained; external imports remain: ${externalImports.join(', ')}`,
    );
  }

  await cp(join(projectRoot, 'src', 'templates'), join(distPath, 'templates'), {
    recursive: true,
  });
  const notices = await createThirdPartyNotices(metafile, projectRoot);
  await writeFile(join(distPath, 'THIRD_PARTY_NOTICES.txt'), notices, 'utf8');

  const entrypoint = join(distPath, 'index.js');
  await chmod(entrypoint, 0o755);
  const entrypointOutput = result.outputs.find(
    (output) => resolve(output.path) === entrypoint,
  );
  console.log(
    `Built self-contained production bundle (${entrypointOutput?.size ?? 'unknown'} bytes, ${bundledPackages(metafile).length} third-party package instances).`,
  );
}

if (import.meta.main) {
  await buildPackage();
}
