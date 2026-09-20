import { describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const publishScript = join(import.meta.dir, '..', '..', '..', 'scripts', 'publish.ts');

type PublishScenario = {
  npmTag: 'next' | 'latest';
  version: string;
  publishedVersion?: string;
  distTags: Record<string, string>;
  packageSizes?: {
    unpackedPackage: number;
    compressedTarball: number;
  };
};

async function runPublish(scenario: PublishScenario) {
  const root = await mkdtemp(join(tmpdir(), 'allagents-publish-'));
  const binDir = join(root, 'bin');
  const callsPath = join(root, 'npm-calls.jsonl');
  const fakeNpmPath = join(root, 'fake-npm.ts');

  try {
    await mkdir(binDir);
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: 'allagents', version: scenario.version }),
    );
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'dist', 'index.js'), '#!/usr/bin/env node\n');
    await writeFile(
      fakeNpmPath,
      `import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
appendFileSync(process.env.NPM_CALLS!, JSON.stringify(args) + '\\n');
if (args[0] === 'pack') {
  const destination = args[args.indexOf('--pack-destination') + 1];
  const filename = 'allagents-test.tgz';
  writeFileSync(join(destination, filename), 'packed artifact');
  console.log(JSON.stringify([{
    filename,
    size: Number(process.env.FAKE_TARBALL_SIZE),
    unpackedSize: Number(process.env.FAKE_UNPACKED_SIZE),
    files: [],
  }]));
  process.exit(0);
}

if (args[0] === 'view' && args[1]?.includes('@')) {
  const publishedVersion = process.env.FAKE_PUBLISHED_VERSION;
  if (!publishedVersion) {
    console.error('E404');
    process.exit(1);
  }
  console.log(JSON.stringify(publishedVersion));
  process.exit(0);
}

if (args[0] === 'view' && args[2] === 'dist-tags') {
  console.log(process.env.FAKE_DIST_TAGS || '{}');
  process.exit(0);
}

if (args[0] === 'publish') {
  if (!args[1]?.endsWith('.tgz') || !existsSync(args[1])) {
    console.error('publish must receive the retained packed artifact');
    process.exit(93);
  }
  process.exit(0);
}
if (args[0] === 'dist-tag') {
  console.error('dist-tag mutation must not run');
  process.exit(91);
}

console.error('Unexpected npm call: ' + args.join(' '));
process.exit(92);
`,
    );

    if (process.platform === 'win32') {
      await writeFile(
        join(binDir, 'npm.cmd'),
        '@"%BUN_EXECUTABLE%" "%FAKE_NPM_SCRIPT%" %*\r\n',
      );
    } else {
      const launcher = join(binDir, 'npm');
      await writeFile(
        launcher,
        '#!/bin/sh\nexec "$BUN_EXECUTABLE" "$FAKE_NPM_SCRIPT" "$@"\n',
      );
      await chmod(launcher, 0o755);
    }

    const result = Bun.spawnSync(
      [process.execPath, 'run', publishScript, scenario.npmTag],
      {
        cwd: root,
        env: {
          ...process.env,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
          BUN_EXECUTABLE: process.execPath,
          FAKE_NPM_SCRIPT: fakeNpmPath,
          NPM_CALLS: callsPath,
          FAKE_PUBLISHED_VERSION: scenario.publishedVersion ?? '',
          FAKE_DIST_TAGS: JSON.stringify(scenario.distTags),
          FAKE_UNPACKED_SIZE: String(
            scenario.packageSizes?.unpackedPackage ?? 1,
          ),
          FAKE_TARBALL_SIZE: String(
            scenario.packageSizes?.compressedTarball ?? 1,
          ),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const calls = (await readFile(callsPath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    const publishCall = calls.find(([command]) => command === 'publish');
    const publishedTarballPath = publishCall?.[1];
    const publishedTarballExists =
      publishedTarballPath === undefined
        ? undefined
        : await Bun.file(publishedTarballPath).exists();

    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      calls,
      publishedTarballPath,
      publishedTarballExists,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('npm publishing', () => {
  for (const scenario of [
    {
      npmTag: 'next' as const,
      version: '1.14.0-next.1',
      distTags: { next: '1.13.9-next.1', latest: '1.13.9' },
    },
    {
      npmTag: 'latest' as const,
      version: '1.14.0',
      distTags: { next: '1.14.0-next.1', latest: '1.13.9' },
    },
  ]) {
    test(`publishes ${scenario.npmTag} without a redundant dist-tag mutation`, async () => {
      const result = await runPublish(scenario);

      expect(result.exitCode).toBe(0);
      const packCall = result.calls.find(([command]) => command === 'pack');
      const publishCall = result.calls.find(
        ([command]) => command === 'publish',
      );
      expect(packCall).toBeDefined();
      expect(publishCall?.[1]).toBe(
        join(packCall?.at(-1) ?? '', 'allagents-test.tgz'),
      );
      expect(publishCall?.slice(2)).toEqual(['--tag', scenario.npmTag]);
      expect(result.publishedTarballPath).toEndWith('.tgz');
      expect(result.publishedTarballExists).toBe(false);
      expect(result.calls.some(([command]) => command === 'dist-tag')).toBe(false);
    });
  }

  test('rejects a mismatched tag on retry without mutating npm', async () => {
    const result = await runPublish({
      npmTag: 'next',
      version: '1.14.0-next.1',
      publishedVersion: '1.14.0-next.1',
      distTags: { next: '1.13.9-next.1', latest: '1.13.9' },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      'allagents@1.14.0-next.1 is already published, but next points to 1.13.9-next.1',
    );
    expect(result.calls.some(([command]) => command === 'dist-tag')).toBe(false);
    expect(result.calls.some(([command]) => command === 'pack')).toBe(false);
  });

  test('blocks publishing when the packed artifact exceeds its size budget', async () => {
    const result = await runPublish({
      npmTag: 'latest',
      version: '1.14.0',
      distTags: { latest: '1.13.9' },
      packageSizes: {
        unpackedPackage: 1,
        compressedTarball: 525_001,
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Package size budget exceeded');
    expect(result.stderr).toContain(
      'compressed tarball: 525001 bytes (budget: 525000 bytes, over by 1 byte)',
    );
    expect(result.calls.some(([command]) => command === 'view')).toBe(true);
    expect(result.calls.some(([command]) => command === 'pack')).toBe(true);
    expect(result.calls.some(([command]) => command === 'publish')).toBe(false);
  });
});
