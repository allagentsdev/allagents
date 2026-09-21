import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createThirdPartyNotices } from '../../../scripts/build-package';
import {
  assertPackageSizeBudgets,
  parsePackument,
} from '../../../scripts/check-package-size';

const metafile = {
  inputs: {},
  outputs: {
    './index.js': {
      bytes: 100,
      inputs: {
        'src/index.ts': { bytesInOutput: 20 },
        'node_modules/z-package/index.js': { bytesInOutput: 40 },
        'node_modules/@scope/a-package/index.js': { bytesInOutput: 30 },
        'node_modules/shared-package/index.js': { bytesInOutput: 10 },
        'node_modules/z-package/node_modules/shared-package/index.js': {
          bytesInOutput: 10,
        },
        'node_modules/tree-shaken/index.js': { bytesInOutput: 0 },
      },
      imports: [],
      exports: [],
      entryPoint: 'src/index.ts',
    },
  },
};

describe('packed artifact contracts', () => {
  test('derives third-party notices from packages embedded in build output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'allagents-notices-'));

    try {
      await mkdir(join(root, 'node_modules', 'z-package'), { recursive: true });
      await mkdir(join(root, 'node_modules', '@scope', 'a-package'), {
        recursive: true,
      });
      await mkdir(join(root, 'node_modules', 'shared-package'), {
        recursive: true,
      });
      await mkdir(
        join(
          root,
          'node_modules',
          'z-package',
          'node_modules',
          'shared-package',
        ),
        { recursive: true },
      );
      await writeFile(
        join(root, 'node_modules', 'z-package', 'package.json'),
        JSON.stringify({ name: 'z-package', version: '2.0.0', license: 'MIT' }),
      );
      await writeFile(
        join(root, 'node_modules', 'z-package', 'LICENSE'),
        'Z package license text\n',
      );
      await writeFile(
        join(root, 'node_modules', '@scope', 'a-package', 'package.json'),
        JSON.stringify({
          name: '@scope/a-package',
          version: '1.0.0',
          license: 'Apache-2.0',
        }),
      );
      await writeFile(
        join(root, 'node_modules', '@scope', 'a-package', 'NOTICE.txt'),
        'A package notice text\n',
      );
      await writeFile(
        join(root, 'node_modules', 'shared-package', 'package.json'),
        JSON.stringify({
          name: 'shared-package',
          version: '2.0.0',
          license: 'MIT',
        }),
      );
      await writeFile(
        join(root, 'node_modules', 'shared-package', 'LICENSE'),
        'Shared package version 2 license\n',
      );
      await writeFile(
        join(
          root,
          'node_modules',
          'z-package',
          'node_modules',
          'shared-package',
          'package.json',
        ),
        JSON.stringify({
          name: 'shared-package',
          version: '1.0.0',
          license: 'ISC',
        }),
      );
      await writeFile(
        join(
          root,
          'node_modules',
          'z-package',
          'node_modules',
          'shared-package',
          'LICENSE',
        ),
        'Shared package version 1 license\n',
      );

      const notices = await createThirdPartyNotices(metafile, root);
      expect(notices).toContain('@scope/a-package@1.0.0');
      expect(notices).toContain('License: Apache-2.0');
      expect(notices).toContain('A package notice text');
      expect(notices).toContain('z-package@2.0.0');
      expect(notices).toContain('Z package license text');
      expect(notices).toContain('shared-package@1.0.0');
      expect(notices).toContain('Shared package version 1 license');
      expect(notices).toContain('shared-package@2.0.0');
      expect(notices).toContain('Shared package version 2 license');
      expect(notices.match(/shared-package@/g)).toHaveLength(2);
      expect(notices).toContain(
        'Bundled from: node_modules/z-package/node_modules/shared-package',
      );
      expect(notices).not.toContain('tree-shaken');
      expect(notices.indexOf('@scope/a-package')).toBeLessThan(
        notices.indexOf('z-package'),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('parses npm pack JSON after prepare-script output', () => {
    const artifact = {
      filename: 'allagents-1.16.0.tgz',
      size: 123,
      unpackedSize: 456,
      files: [{ path: 'dist/index.js' }],
    };

    expect(
      parsePackument(
        `Built self-contained production bundle.\n${JSON.stringify([artifact])}`,
      ),
    ).toEqual(artifact);
  });

  test('reports every exceeded package-size budget with actual and limit bytes', () => {
    expect(() =>
      assertPackageSizeBudgets(
        { emittedJavaScript: 101, unpackedPackage: 202, compressedTarball: 303 },
        { emittedJavaScript: 100, unpackedPackage: 200, compressedTarball: 300 },
      ),
    ).toThrow(
      [
        'Package size budget exceeded:',
        'emitted JavaScript: 101 bytes (budget: 100 bytes, over by 1 byte)',
        'unpacked package: 202 bytes (budget: 200 bytes, over by 2 bytes)',
        'compressed tarball: 303 bytes (budget: 300 bytes, over by 3 bytes)',
      ].join('\n'),
    );
  });

  test('accepts artifacts at their package-size ceilings', () => {
    const sizes = {
      emittedJavaScript: 100,
      unpackedPackage: 200,
      compressedTarball: 300,
    };

    expect(() => assertPackageSizeBudgets(sizes, sizes)).not.toThrow();
  });
});
