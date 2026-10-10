import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parsePluginSpec,
  isPluginSpec,
  getMarketplacePluginsFromManifest,
  resolvePluginSpec,
  addMarketplace,
  loadRegistry,
  saveRegistry,
  getRegistryPath,
  getAllagentsDir,
} from '../../../src/core/marketplace.js';

describe('parsePluginSpec', () => {
  it('should parse simple marketplace name', () => {
    const result = parsePluginSpec('my-plugin@claude-plugins-official');
    expect(result).toEqual({
      plugin: 'my-plugin',
      marketplaceName: 'claude-plugins-official',
    });
  });

  it('should parse owner/repo format', () => {
    const result = parsePluginSpec('my-plugin@anthropics/claude-plugins-official');
    expect(result).toEqual({
      plugin: 'my-plugin',
      marketplaceName: 'claude-plugins-official',
      owner: 'anthropics',
      repo: 'claude-plugins-official',
    });
  });

  it('should parse owner/repo/subpath format', () => {
    const result = parsePluginSpec('feature-dev@anthropics/claude-plugins-official/plugins');
    expect(result).toEqual({
      plugin: 'feature-dev',
      marketplaceName: 'claude-plugins-official',
      owner: 'anthropics',
      repo: 'claude-plugins-official',
      subpath: 'plugins',
    });
  });

  it('should parse owner/repo with nested subpath', () => {
    const result = parsePluginSpec('addon@owner/repo/src/addons');
    expect(result).toEqual({
      plugin: 'addon',
      marketplaceName: 'repo',
      owner: 'owner',
      repo: 'repo',
      subpath: 'src/addons',
    });
  });

  it('should return null for invalid specs', () => {
    expect(parsePluginSpec('no-at-sign')).toBeNull();
    expect(parsePluginSpec('@missing-plugin')).toBeNull();
    expect(parsePluginSpec('missing-marketplace@')).toBeNull();
    expect(parsePluginSpec('')).toBeNull();
  });

  it('does not interpret package versions or Git transports as marketplaces', () => {
    for (const source of [
      'npm:pi-compound-engineering@3.19.2',
      'npm:@acme/pi-tools@1.2.3',
      'npm:@acme/pi-tools',
      'git:github.com/acme/pi-tools@v1',
      'git:git@github.com:acme/pi-tools',
      'git@github.com:acme/pi-tools',
      'ssh://git@github.com/acme/pi-tools@v1',
      'acme/pi-tools@v1',
    ]) {
      expect(isPluginSpec(source)).toBe(false);
      expect(parsePluginSpec(source)).toBeNull();
    }
  });

  it('should not confuse URL with owner/repo', () => {
    // URLs with :// should not be treated as owner/repo
    const result = parsePluginSpec('plugin@https://github.com/owner/repo');
    expect(result).toEqual({
      plugin: 'plugin',
      marketplaceName: 'https://github.com/owner/repo',
    });
  });
});

describe('isPluginSpec', () => {
  it('should return true for valid specs', () => {
    expect(isPluginSpec('plugin@marketplace')).toBe(true);
    expect(isPluginSpec('plugin@owner/repo')).toBe(true);
    expect(isPluginSpec('plugin@owner/repo/subpath')).toBe(true);
  });

  it('should return false for invalid specs', () => {
    expect(isPluginSpec('no-at-sign')).toBe(false);
    expect(isPluginSpec('@missing-plugin')).toBe(false);
    expect(isPluginSpec('missing-marketplace@')).toBe(false);
    expect(isPluginSpec('')).toBe(false);
  });
});

describe('getMarketplacePluginsFromManifest', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `marketplace-manifest-test-${Date.now()}`);
    mkdirSync(join(testDir, '.claude-plugin'), { recursive: true });
    mkdirSync(join(testDir, 'plugins', 'plugin-a'), { recursive: true });
    mkdirSync(join(testDir, 'plugins', 'plugin-b'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return plugins from manifest with metadata and no warnings', async () => {
    const manifest = {
      name: 'test',
      description: 'Test',
      plugins: [
        {
          name: 'plugin-a',
          description: 'Plugin A desc',
          source: './plugins/plugin-a',
          category: 'development',
        },
        {
          name: 'plugin-b',
          description: 'Plugin B desc',
          source: './plugins/plugin-b',
        },
      ],
    };
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(manifest),
    );

    const result = await getMarketplacePluginsFromManifest(testDir);
    expect(result.plugins).toHaveLength(2);
    expect(result.plugins[0].name).toBe('plugin-a');
    expect(result.plugins[0].description).toBe('Plugin A desc');
    expect(result.plugins[0].category).toBe('development');
    expect(result.plugins[0].path).toBe(join(testDir, 'plugins', 'plugin-a'));
    expect(result.plugins[1].name).toBe('plugin-b');
    expect(result.plugins[1].description).toBe('Plugin B desc');
    expect(result.plugins[1].category).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  it('should return empty plugins and warnings when no manifest exists', async () => {
    rmSync(join(testDir, '.claude-plugin'), { recursive: true, force: true });
    const result = await getMarketplacePluginsFromManifest(testDir);
    expect(result.plugins).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('should handle URL source plugins', async () => {
    const manifest = {
      name: 'test',
      description: 'Test',
      plugins: [
        {
          name: 'external',
          description: 'External plugin',
          source: { source: 'url', url: 'https://github.com/org/repo.git' },
        },
      ],
    };
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(manifest),
    );

    const result = await getMarketplacePluginsFromManifest(testDir);
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].name).toBe('external');
    expect(result.plugins[0].source).toBe('https://github.com/org/repo.git');
  });

  it('should handle URL source plugins with resolved cache path', async () => {
    // Create a fake cached plugin directory (simulating what fetchPlugin would produce)
    const cachedPluginDir = join(testDir, 'cached-external');
    mkdirSync(cachedPluginDir, { recursive: true });

    const manifest = {
      name: 'test',
      description: 'Test',
      plugins: [
        {
          name: 'external',
          description: 'External plugin',
          source: { source: 'url', url: 'https://github.com/org/repo.git' },
        },
      ],
    };
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(manifest),
    );

    // resolvePluginSpec should resolve URL-source plugins by fetching them
    // We pass a mock fetchFn that returns the cached path
    const result = await resolvePluginSpec('external@test-marketplace', {
      marketplacePathOverride: testDir,
      fetchFn: async () => ({
        success: true,
        action: 'fetched' as const,
        cachePath: cachedPluginDir,
      }),
    });

    expect(result).not.toBeNull();
    expect(result!.path).toBe(cachedPluginDir);
    expect(result!.plugin).toBe('external');
  });

  it('should expose only declared artifacts for a strict-false skills-only plugin', async () => {
    mkdirSync(join(testDir, 'skills', 'skill-a'), { recursive: true });
    mkdirSync(join(testDir, '.github', 'hooks'), { recursive: true });
    writeFileSync(
      join(testDir, 'skills', 'skill-a', 'SKILL.md'),
      '---\nname: skill-a\n---\n',
    );
    writeFileSync(
      join(testDir, '.github', 'hooks', 'post-edit.json'),
      '{}',
    );
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'test',
        description: 'Test',
        plugins: [
          {
            name: 'skills-only',
            description: 'Skills only',
            source: './',
            strict: false,
            skills: ['./skills/'],
          },
        ],
      }),
    );

    const result = await resolvePluginSpec('skills-only@test-marketplace', {
      marketplacePathOverride: testDir,
    });

    expect(result).not.toBeNull();
    expect(result!.path).toBe(testDir);
    expect(result!.fileArtifacts).toEqual({
      agents: false,
      commands: false,
      github: false,
      hooks: false,
      mcpServers: false,
      skills: true,
    });
  });

  it('should keep the plugin root when strict mode can merge other components', async () => {
    mkdirSync(join(testDir, 'skills', 'skill-a'), { recursive: true });
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'test',
        description: 'Test',
        plugins: [
          {
            name: 'full-plugin',
            description: 'Full plugin',
            source: './',
            skills: ['./skills/'],
          },
        ],
      }),
    );

    const result = await resolvePluginSpec('full-plugin@test-marketplace', {
      marketplacePathOverride: testDir,
    });

    expect(result).not.toBeNull();
    expect(result!.path).toBe(testDir);
    expect(result!.fileArtifacts).toBeUndefined();
  });

  it('should return null for URL source plugins when fetch fails', async () => {
    const manifest = {
      name: 'test',
      description: 'Test',
      plugins: [
        {
          name: 'external',
          description: 'External plugin',
          source: { source: 'url', url: 'https://github.com/org/repo.git' },
        },
      ],
    };
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(manifest),
    );

    const result = await resolvePluginSpec('external@test-marketplace', {
      marketplacePathOverride: testDir,
      fetchFn: async () => ({
        success: false,
        action: 'skipped' as const,
        cachePath: '',
        error: 'Network error',
      }),
    });

    expect(result).toBeNull();
  });

  it('should resolve GitHub source plugin via fetch (normalized to URL)', async () => {
    // Simulates the WTG marketplace.json where ediprod has a github source
    const cachedPluginDir = join(testDir, 'cached-ediprod');
    mkdirSync(cachedPluginDir, { recursive: true });

    const manifest = {
      name: 'wtg-ai-prompts',
      description: 'WiseTech Global plugins',
      plugins: [
        {
          name: 'cargowise',
          description: 'CargoWise coding guidelines',
          source: './plugins/cargowise',
        },
        {
          name: 'ediprod',
          source: { source: 'github', repo: 'WiseTechGlobal/mcp-ediprod' },
        },
      ],
    };
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(manifest),
    );

    // Create local plugin dir for cargowise
    mkdirSync(join(testDir, 'plugins', 'cargowise'), { recursive: true });

    let fetchedUrl = '';
    const result = await resolvePluginSpec('ediprod@wtg-ai-prompts', {
      marketplacePathOverride: testDir,
      fetchFn: async (url: string) => {
        fetchedUrl = url;
        return {
          success: true,
          action: 'fetched' as const,
          cachePath: cachedPluginDir,
        };
      },
    });

    expect(result).not.toBeNull();
    expect(result!.path).toBe(cachedPluginDir);
    expect(result!.plugin).toBe('ediprod');
    // Verify the github source was normalized to a full URL
    expect(fetchedUrl).toBe('https://github.com/WiseTechGlobal/mcp-ediprod');
  });

  it('should honor an external plugin repository embedded marketplace boundary', async () => {
    const cachedPluginDir = join(testDir, 'cached-ediprod');
    mkdirSync(join(cachedPluginDir, '.github', 'plugin'), {
      recursive: true,
    });
    writeFileSync(
      join(cachedPluginDir, '.github', 'plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'ediprod-plugins',
        description: 'ediProd plugins',
        plugins: [
          {
            name: 'ediprod',
            description: 'ediProd skills',
            source: './',
            strict: false,
            skills: ['./skills/'],
          },
        ],
      }),
    );
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'wtg-ai-prompts',
        description: 'WTG plugins',
        plugins: [
          {
            name: 'ediprod',
            description: 'ediProd',
            source: {
              source: 'github',
              repo: 'WiseTechGlobal/mcp-ediprod',
            },
          },
        ],
      }),
    );

    const result = await resolvePluginSpec('ediprod@test-marketplace', {
      marketplacePathOverride: testDir,
      fetchFn: async () => ({
        success: true,
        action: 'cloned' as const,
        cachePath: cachedPluginDir,
      }),
    });

    expect(result).not.toBeNull();
    expect(result!.path).toBe(cachedPluginDir);
    expect(result!.fileArtifacts).toEqual({
      agents: false,
      commands: false,
      github: false,
      hooks: false,
      mcpServers: false,
      skills: true,
    });
  });

  it('should handle GitHub source plugins in plugin listing', async () => {
    const manifest = {
      name: 'test',
      description: 'Test',
      plugins: [
        {
          name: 'local-plugin',
          description: 'Local plugin',
          source: './plugins/local-plugin',
        },
        {
          name: 'github-plugin',
          description: 'GitHub plugin',
          source: { source: 'github', repo: 'org/repo' },
        },
      ],
    };
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(manifest),
    );

    const result = await getMarketplacePluginsFromManifest(testDir);
    expect(result.plugins).toHaveLength(2);
    expect(result.plugins[1].name).toBe('github-plugin');
    expect(result.plugins[1].source).toBe('https://github.com/org/repo');
  });

  it('should return plugins without warnings when manifest is missing description', async () => {
    const manifest = {
      name: 'test',
      plugins: [
        {
          name: 'plugin-a',
          description: 'Plugin A desc',
          source: './plugins/plugin-a',
        },
      ],
    };
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(manifest),
    );

    const result = await getMarketplacePluginsFromManifest(testDir);
    expect(result.plugins).toHaveLength(1);
    expect(result.plugins[0].name).toBe('plugin-a');
    expect(result.warnings).toEqual([]);
  });
});

describe('resolvePluginSpec offline mode', () => {
  it('does not call fetchFn when offline is true', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'mp-offline-'));
    const manifestDir = join(testDir, '.claude-plugin');
    mkdirSync(manifestDir, { recursive: true });

    const manifest = {
      name: 'test-marketplace',
      plugins: [
        {
          name: 'remote-plugin',
          description: 'A remote plugin',
          source: { source: 'url', url: 'https://github.com/owner/repo' },
        },
      ],
    };

    writeFileSync(
      join(manifestDir, 'marketplace.json'),
      JSON.stringify(manifest),
    );

    let fetchCalled = false;
    const result = await resolvePluginSpec('remote-plugin@test-marketplace', {
      marketplacePathOverride: testDir,
      offline: true,
      fetchFn: async () => {
        fetchCalled = true;
        return { success: true, action: 'fetched' as const, cachePath: '/fake' };
      },
    });

    expect(fetchCalled).toBe(false);
    expect(result).toBeNull();

    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns cached path when offline and plugin is already cached', async () => {
    const testDir = mkdtempSync(join(tmpdir(), 'mp-offline-cached-'));
    const manifestDir = join(testDir, '.claude-plugin');
    mkdirSync(manifestDir, { recursive: true });

    // Create a fake cache directory that matches what getPluginCachePath returns
    const { getPluginCachePath: getCachePath } = await import('../../../src/utils/plugin-path.js');
    const cachePath = getCachePath('someowner', 'somerepo');
    mkdirSync(cachePath, { recursive: true });

    const manifest = {
      name: 'test-marketplace',
      plugins: [
        {
          name: 'cached-plugin',
          description: 'A cached remote plugin',
          source: { source: 'url', url: 'https://github.com/someowner/somerepo' },
        },
      ],
    };

    writeFileSync(
      join(manifestDir, 'marketplace.json'),
      JSON.stringify(manifest),
    );

    const result = await resolvePluginSpec('cached-plugin@test-marketplace', {
      marketplacePathOverride: testDir,
      offline: true,
    });

    expect(result).not.toBeNull();
    expect(result!.path).toBe(cachePath);

    // Cleanup
    rmSync(cachePath, { recursive: true, force: true });
    rmSync(testDir, { recursive: true, force: true });
  });
});

describe('addMarketplace with force parameter', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'mp-addmarketplace-'));
    // Create a local test marketplace directory with manifest
    const marketplacePath = join(testDir, 'local-marketplace');
    mkdirSync(join(marketplacePath, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(marketplacePath, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'test-marketplace',
        description: 'Test Marketplace',
        plugins: [],
      }),
    );

    // Clean up any existing test-marketplace from registry
    const registry = await loadRegistry();
    if (registry.marketplaces['test-marketplace']) {
      delete registry.marketplaces['test-marketplace'];
      await saveRegistry(registry);
    }
  });

  afterEach(async () => {
    rmSync(testDir, { recursive: true, force: true });
    // Clean up registry entry to prevent test pollution
    const registry = await loadRegistry();
    if (registry.marketplaces['test-marketplace']) {
      delete registry.marketplaces['test-marketplace'];
      await saveRegistry(registry);
    }
  });

  it('should add a local marketplace and not set replaced flag on first add', async () => {
    const marketplacePath = join(testDir, 'local-marketplace');

    const result = await addMarketplace(marketplacePath);
    expect(result.success).toBe(true);
    expect(result.marketplace).not.toBeNull();
    expect(result.replaced).toBeUndefined();
  });

  it('should replace existing marketplace when adding same source twice', async () => {
    const marketplacePath = join(testDir, 'local-marketplace');

    // First add should succeed
    const result1 = await addMarketplace(marketplacePath);
    expect(result1.success).toBe(true);
    expect(result1.replaced).toBeUndefined();

    // Second add with same source should replace and return replaced=true
    const result2 = await addMarketplace(marketplacePath);
    expect(result2.success).toBe(true);
    expect(result2.replaced).toBe(true);
  });

  it('should replace existing marketplace by name when adding different source', async () => {
    const marketplacePath1 = join(testDir, 'local-marketplace');
    const marketplacePath2 = join(testDir, 'local-marketplace-2');

    // Setup second marketplace with same manifest name
    mkdirSync(join(marketplacePath2, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(marketplacePath2, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'test-marketplace',
        description: 'Test Marketplace 2',
        plugins: [],
      }),
    );

    // First add should succeed
    const result1 = await addMarketplace(marketplacePath1);
    expect(result1.success).toBe(true);

    // Second add with different source but same manifest name replaces by default
    const result2 = await addMarketplace(marketplacePath2);
    expect(result2.success).toBe(true);
    expect(result2.replaced).toBe(true);
    expect(result2.marketplace).not.toBeNull();
  });

  it('should keep replaced=undefined when adding new marketplace', async () => {
    const marketplacePath = join(testDir, 'local-marketplace');

    // First add should not have replaced flag
    const result = await addMarketplace(marketplacePath);
    expect(result.success).toBe(true);
    expect(result.replaced).toBeUndefined();
  });

  it('addMarketplace replaces existing marketplace by different source', async () => {
    const marketplacePath1 = join(testDir, 'local-marketplace');
    const marketplacePath2 = join(testDir, 'local-marketplace-alt');

    // Setup second marketplace with same manifest name
    mkdirSync(join(marketplacePath2, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(marketplacePath2, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'test-marketplace',
        description: 'Test Marketplace Alternative',
        plugins: [],
      }),
    );

    // Setup: add initial marketplace with name 'test-marketplace'
    const result1 = await addMarketplace(marketplacePath1);
    expect(result1.success).toBe(true);

    // Action: add same name with different source — replaces by default
    const result2 = await addMarketplace(marketplacePath2);

    // Assert: second add succeeds with replaced=true
    expect(result2.success).toBe(true);
    expect(result2.replaced).toBe(true);

    // Verify: only one marketplace with that name exists
    const registry = await loadRegistry();
    expect(registry.marketplaces['test-marketplace']).toBeDefined();
    expect(Object.keys(registry.marketplaces).filter((k) => k === 'test-marketplace').length).toBe(1);
    // Verify the path was updated to the new marketplace
    expect(registry.marketplaces['test-marketplace'].path).toBe(marketplacePath2);
  });

  it('addMarketplace replaces when adding same manifest name from different sources', async () => {
    const marketplacePath1 = join(testDir, 'local-marketplace');
    const marketplacePath2 = join(testDir, 'local-marketplace-diff');

    // Setup second marketplace with same manifest name
    mkdirSync(join(marketplacePath2, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(marketplacePath2, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'test-marketplace',
        description: 'Test Marketplace Different',
        plugins: [],
      }),
    );

    // Setup: add initial marketplace
    await addMarketplace(marketplacePath1);

    // Action: add different source with same name — replaces by default
    const result = await addMarketplace(marketplacePath2);

    // Assert: replaces the existing entry
    expect(result.success).toBe(true);
    expect(result.replaced).toBe(true);
  });
});
