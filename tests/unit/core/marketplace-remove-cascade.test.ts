import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  lstat,
  mkdtemp,
  rm,
  mkdir,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as dump, parse as load } from 'yaml';
import { removeMarketplace, saveRegistry } from '../../../src/core/marketplace.js';
import type { MarketplaceRegistry } from '../../../src/core/marketplace.js';
import { WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';
import type { WorkspaceConfig } from '../../../src/models/workspace-config.js';
import { stubHomeDir } from '../../helpers/env.js';

describe('removeMarketplace cascade', () => {
  let testDir: string;
  let restoreHomeDir: () => void;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-cascade-test-'));
    restoreHomeDir = stubHomeDir(testDir);
  });

  afterEach(async () => {
    restoreHomeDir();
    await rm(testDir, { recursive: true, force: true });
  });

  async function writeRegistry(marketplaces: MarketplaceRegistry['marketplaces']): Promise<void> {
    const allagentsDir = join(testDir, '.allagents');
    await mkdir(allagentsDir, { recursive: true });
    await saveRegistry({ version: 1, marketplaces });
  }

  async function writeUserConfig(config: WorkspaceConfig): Promise<void> {
    const allagentsDir = join(testDir, '.allagents');
    await mkdir(allagentsDir, { recursive: true });
    await writeFile(
      join(allagentsDir, WORKSPACE_CONFIG_FILE),
      dump(config, { lineWidth: -1 }),
      'utf-8',
    );
  }

  async function readUserConfig(): Promise<WorkspaceConfig> {
    const content = await readFile(
      join(testDir, '.allagents', WORKSPACE_CONFIG_FILE),
      'utf-8',
    );
    return load(content) as WorkspaceConfig;
  }

  it('should NOT remove user plugins by default (no cascade)', async () => {
    await writeRegistry({
      'my-marketplace': {
        name: 'my-marketplace',
        source: { type: 'local', location: '/tmp/mp' },
        path: '/tmp/mp',
      },
    });

    await writeUserConfig({
      repositories: [],
      plugins: [
        'pluginA@my-marketplace',
        'pluginB@my-marketplace',
        'pluginC@other-marketplace',
      ],
      clients: ['claude'],
    });

    const result = await removeMarketplace('my-marketplace');
    expect(result.success).toBe(true);

    // Plugins should still be in the config — not removed
    const config = await readUserConfig();
    expect(config.plugins).toEqual([
      'pluginA@my-marketplace',
      'pluginB@my-marketplace',
      'pluginC@other-marketplace',
    ]);

    // removedUserPlugins should be undefined (no cascade happened)
    expect(result.removedUserPlugins).toBeUndefined();
    // retainedUserPlugins should list the marketplace's plugins
    expect(result.retainedUserPlugins).toEqual([
      'pluginA@my-marketplace',
      'pluginB@my-marketplace',
    ]);
  });

  it('should return retainedUserPlugins listing marketplace plugins', async () => {
    await writeRegistry({
      'my-marketplace': {
        name: 'my-marketplace',
        source: { type: 'local', location: '/tmp/mp' },
        path: '/tmp/mp',
      },
    });

    await writeUserConfig({
      repositories: [],
      plugins: ['pluginA@my-marketplace'],
      clients: ['claude'],
    });

    const result = await removeMarketplace('my-marketplace');
    expect(result.success).toBe(true);
    expect(result.retainedUserPlugins).toEqual(['pluginA@my-marketplace']);
    expect(result.removedUserPlugins).toBeUndefined();
  });

  it('should succeed even when no user config exists', async () => {
    await writeRegistry({
      'my-marketplace': {
        name: 'my-marketplace',
        source: { type: 'local', location: '/tmp/mp' },
        path: '/tmp/mp',
      },
    });

    const result = await removeMarketplace('my-marketplace');
    expect(result.success).toBe(true);
    expect(result.retainedUserPlugins).toEqual([]);
    expect(result.removedUserPlugins).toBeUndefined();
  });

  it('should distinguish own registry aliases from Object prototype names', async () => {
    const localPath = join(testDir, 'local-marketplace');
    await mkdir(localPath, { recursive: true });
    const marketplaces = JSON.parse(JSON.stringify({
      ['__proto__']: {
        name: '__proto__',
        source: { type: 'local', location: localPath },
        path: localPath,
      },
    })) as MarketplaceRegistry['marketplaces'];
    await writeRegistry(marketplaces);

    const missingResult = await removeMarketplace('toString');
    expect(missingResult.success).toBe(false);
    expect(missingResult.error).toContain("Marketplace 'toString' not found");

    const result = await removeMarketplace('__proto__');
    expect(result.success).toBe(true);
    expect(await lstat(localPath)).toBeDefined();
    const registryContent = JSON.parse(
      await readFile(join(testDir, '.allagents', 'marketplaces.json'), 'utf-8'),
    );
    expect(Object.hasOwn(registryContent.marketplaces, '__proto__')).toBe(false);
  });

  it('should succeed when no user plugins reference the marketplace', async () => {
    await writeRegistry({
      'my-marketplace': {
        name: 'my-marketplace',
        source: { type: 'local', location: '/tmp/mp' },
        path: '/tmp/mp',
      },
    });

    await writeUserConfig({
      repositories: [],
      plugins: ['pluginC@other-marketplace'],
      clients: ['claude'],
    });

    const result = await removeMarketplace('my-marketplace');
    expect(result.success).toBe(true);
    expect(result.retainedUserPlugins).toEqual([]);
  });

  it('should remove user plugins when cascade is explicitly enabled', async () => {
    await writeRegistry({
      'my-marketplace': {
        name: 'my-marketplace',
        source: { type: 'local', location: '/tmp/mp' },
        path: '/tmp/mp',
      },
    });

    await writeUserConfig({
      repositories: [],
      plugins: [
        'pluginA@my-marketplace',
        'pluginB@my-marketplace',
        'pluginC@other-marketplace',
      ],
      clients: ['claude'],
    });

    const result = await removeMarketplace('my-marketplace', { cascade: true });
    expect(result.success).toBe(true);

    const config = await readUserConfig();
    expect(config.plugins).toEqual(['pluginC@other-marketplace']);
    expect(result.removedUserPlugins).toEqual([
      'pluginA@my-marketplace',
      'pluginB@my-marketplace',
    ]);
    expect(result.retainedUserPlugins).toBeUndefined();
  });

  it('should delete the marketplace directory when it exists', async () => {
    const marketplacePath = join(testDir, '.allagents', 'plugins', 'marketplaces', 'my-marketplace');
    await mkdir(marketplacePath, { recursive: true });
    await writeFile(join(marketplacePath, 'manifest.yaml'), 'name: my-marketplace', 'utf-8');

    await writeRegistry({
      'my-marketplace': {
        name: 'my-marketplace',
        source: { type: 'github', location: 'owner/repo' },
        path: marketplacePath,
      },
    });

    const { existsSync } = await import('node:fs');
    expect(existsSync(marketplacePath)).toBe(true);

    const result = await removeMarketplace('my-marketplace');
    expect(result.success).toBe(true);
    expect(existsSync(marketplacePath)).toBe(false);
  });

  it('should not delete the source directory for local marketplaces', async () => {
    const localSourceDir = join(testDir, 'external-marketplace');
    await mkdir(localSourceDir, { recursive: true });
    await writeFile(join(localSourceDir, 'README.md'), '# My Marketplace', 'utf-8');

    await writeRegistry({
      'local-mp': {
        name: 'local-mp',
        source: { type: 'local', location: localSourceDir },
        path: localSourceDir,
      },
    });

    const { existsSync } = await import('node:fs');
    expect(existsSync(localSourceDir)).toBe(true);

    const result = await removeMarketplace('local-mp');
    expect(result.success).toBe(true);
    // Local source directory must NOT be deleted
    expect(existsSync(localSourceDir)).toBe(true);
  });

  it('should remove an unsafe remote entry without deleting its referenced path', async () => {
    const markerPath = join(testDir, 'home-marker.txt');
    await writeFile(markerPath, 'keep', 'utf-8');
    await writeRegistry({
      unsafe: {
        name: 'unsafe',
        source: { type: 'github', location: 'owner/unsafe' },
        path: testDir,
      },
      unrelated: {
        name: 'unrelated',
        source: { type: 'local', location: '/tmp/unrelated' },
        path: '/tmp/unrelated',
      },
    });

    const result = await removeMarketplace('unsafe');

    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([
      `Refused to delete unmanaged marketplace path: ${testDir}`,
    ]);
    expect(await readFile(markerPath, 'utf-8')).toBe('keep');
    const registry = JSON.parse(
      await readFile(join(testDir, '.allagents', 'marketplaces.json'), 'utf-8'),
    ) as MarketplaceRegistry;
    expect(registry.marketplaces.unsafe).toBeUndefined();
    expect(registry.marketplaces.unrelated).toBeDefined();
  });

  it('should warn without deleting a dangling remote cache symlink', async () => {
    const cachePath = join(
      testDir,
      '.allagents',
      'plugins',
      'marketplaces',
      'dangling',
    );
    await mkdir(join(cachePath, '..'), { recursive: true });
    await symlink(join(testDir, 'missing-target'), cachePath, 'dir');
    await writeRegistry({
      dangling: {
        name: 'dangling',
        source: { type: 'github', location: 'owner/dangling' },
        path: cachePath,
      },
    });

    const result = await removeMarketplace('dangling');

    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([
      `Refused to delete unmanaged marketplace path: ${cachePath}`,
    ]);
    expect((await lstat(cachePath)).isSymbolicLink()).toBe(true);
  });
});
