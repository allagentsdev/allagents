#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createCheckedPackageTarball } from './check-package-size.ts';

const execFileAsync = promisify(execFile);
const nodeExecutable = 'node';
const projectRoot = resolve(import.meta.dirname, '..');
const root = await mkdtemp(join(tmpdir(), 'allagents-packed-smoke-'));
const consumerRoot = join(root, 'consumer');

async function runCli(cliPath, args, options = {}) {
  return execFileAsync(nodeExecutable, [cliPath, ...args], {
    cwd: options.cwd ?? consumerRoot,
    env: options.env ?? process.env,
  });
}

async function exerciseHelpTree(cliPath) {
  const visitedPaths = new Set();

  async function visit(commandPath) {
    const pathKey = commandPath.join(' ');
    assert.ok(
      !visitedPaths.has(pathKey),
      `command tree contains a cycle at ${pathKey || '<root>'}`,
    );
    visitedPaths.add(pathKey);

    const { stdout } = await runCli(cliPath, [
      ...commandPath,
      '--help',
      '--json',
    ]);
    const help = JSON.parse(stdout);
    for (const child of help.commands ?? []) {
      await visit(child.command.split(/\s+/));
    }
  }

  await visit([]);
  assert.ok(
    visitedPaths.size > 20,
    `expected a complete command tree, visited ${visitedPaths.size} nodes`,
  );
  return visitedPaths.size;
}

let packedPackage;

try {
  packedPackage = await createCheckedPackageTarball(projectRoot);
  const { artifact } = packedPackage;
  assert.ok(
    artifact.files.some(
      (file) => file.path === 'dist/THIRD_PARTY_NOTICES.txt',
    ),
    'packed artifact is missing dist/THIRD_PARTY_NOTICES.txt',
  );

  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ private: true, name: 'allagents-packed-smoke' }),
  );
  await execFileAsync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      packedPackage.tarballPath,
    ],
    { cwd: root },
  );

  const installedPackageRoot = join(root, 'node_modules', 'allagents');
  const installedManifest = JSON.parse(
    await readFile(join(installedPackageRoot, 'package.json'), 'utf8'),
  );
  assert.deepEqual(
    installedManifest.dependencies ?? {},
    {},
    'packed allagents must not install a duplicate runtime dependency graph',
  );
  const installedEntries = (await readdir(join(root, 'node_modules'))).filter(
    (entry) => !['.bin', '.package-lock.json', 'allagents'].includes(entry),
  );
  assert.deepEqual(
    installedEntries,
    [],
    `isolated install added unexpected runtime packages: ${installedEntries.join(', ')}`,
  );

  await mkdir(consumerRoot);
  await writeFile(
    join(consumerRoot, 'package.json'),
    JSON.stringify({ private: true, name: 'allagents-packed-consumer' }),
  );

  const cliPath = join(installedPackageRoot, 'dist', 'index.js');
  const visited = await exerciseHelpTree(cliPath);
  await execFileAsync(
    nodeExecutable,
    ['scripts/smoke-node-cli.mjs', cliPath],
    { cwd: projectRoot },
  );

  console.log(
    `Packed npm artifact passed isolated Node smoke (${visited} help nodes; no runtime dependencies installed).`,
  );
} finally {
  await Promise.all([
    rm(root, { recursive: true, force: true }),
    packedPackage?.cleanup(),
  ]);
}
