import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseMarketplaceManifest,
  resolvePluginSourcePath,
} from '../../../src/utils/marketplace-manifest-parser.js';

describe('parseMarketplaceManifest', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `marketplace-test-${Date.now()}`);
    mkdirSync(join(testDir, '.claude-plugin'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should parse a valid marketplace.json with no warnings', async () => {
    const manifest = {
      name: 'test-marketplace',
      description: 'Test marketplace',
      plugins: [
        { name: 'plugin-a', description: 'Plugin A', source: './plugins/plugin-a' },
      ],
    };
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(manifest),
    );

    const result = await parseMarketplaceManifest(testDir);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('test-marketplace');
      expect(result.data.plugins).toHaveLength(1);
      expect(result.warnings).toEqual([]);
    }
  });

  it('should fall back to the GitHub Copilot marketplace location', async () => {
    rmSync(join(testDir, '.claude-plugin'), { recursive: true, force: true });
    mkdirSync(join(testDir, '.github', 'plugin'), { recursive: true });
    writeFileSync(
      join(testDir, '.github', 'plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'copilot-marketplace',
        description: 'Copilot marketplace',
        plugins: [
          {
            name: 'skills-only',
            description: 'Skills only',
            source: './',
            strict: false,
            skills: './skills/',
          },
        ],
      }),
    );

    const result = await parseMarketplaceManifest(testDir);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('copilot-marketplace');
      expect(result.data.plugins[0].strict).toBe(false);
      expect(result.data.plugins[0].skills).toBe('./skills/');
    }
  });

  it('should prefer the GitHub Copilot marketplace location', async () => {
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'claude-marketplace',
        description: 'Claude marketplace',
        plugins: [],
      }),
    );
    mkdirSync(join(testDir, '.github', 'plugin'), { recursive: true });
    writeFileSync(
      join(testDir, '.github', 'plugin', 'marketplace.json'),
      JSON.stringify({
        name: 'copilot-marketplace',
        description: 'Copilot marketplace',
        plugins: [],
      }),
    );

    const result = await parseMarketplaceManifest(testDir);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.name).toBe('copilot-marketplace');
    }
  });

  it('does not fall back when the preferred Copilot marketplace is invalid', async () => {
    writeFileSync(join(testDir, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'legacy', description: 'Legacy', plugins: [] }));
    mkdirSync(join(testDir, '.github', 'plugin'), { recursive: true });
    writeFileSync(join(testDir, '.github', 'plugin', 'marketplace.json'), '{invalid');
    const result = await parseMarketplaceManifest(testDir);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('invalid syntax');
  });

  for (const strict of [false, undefined, true]) {
    it(`rejects invalid selected component declarations without defaulting (strict=${strict})`, async () => {
      writeFileSync(join(testDir, '.claude-plugin', 'marketplace.json'), JSON.stringify({
        name: 'test', description: 'Test', plugins: [
          { name: 'invalid', description: 'Invalid', source: './plugins/invalid', skills: 42, ...(strict !== undefined && { strict }) },
          { name: 'valid', description: 'Valid', source: './plugins/valid' },
        ],
      }));
      expect((await parseMarketplaceManifest(testDir, 'invalid')).success).toBe(false);
      expect((await parseMarketplaceManifest(testDir, 'valid')).success).toBe(true);
    });
  }

  it('should return error when marketplace.json does not exist', async () => {
    rmSync(join(testDir, '.claude-plugin'), { recursive: true, force: true });
    const result = await parseMarketplaceManifest(testDir);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('not found');
    }
  });

  it('should return error for invalid JSON', async () => {
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      'not valid json{{{',
    );
    const result = await parseMarketplaceManifest(testDir);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('parse');
    }
  });

  it('should return error when no plugins array exists', async () => {
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ invalid: true }),
    );
    const result = await parseMarketplaceManifest(testDir);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('plugins');
    }
  });

  // Lenient parsing tests

  it('should leniently parse manifest missing top-level description', async () => {
    const manifest = {
      name: 'test-marketplace',
      plugins: [
        { name: 'plugin-a', description: 'Plugin A', source: './plugins/plugin-a' },
      ],
    };
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(manifest),
    );

    const result = await parseMarketplaceManifest(testDir);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.plugins).toHaveLength(1);
      expect(result.data.plugins[0].name).toBe('plugin-a');
      expect(result.warnings).toEqual([]);
    }
  });

  it('should leniently parse manifest missing top-level name and description', async () => {
    const manifest = {
      plugins: [
        { name: 'plugin-a', description: 'Plugin A', source: './plugins/plugin-a' },
      ],
    };
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(manifest),
    );

    const result = await parseMarketplaceManifest(testDir);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.plugins).toHaveLength(1);
      expect(result.warnings).toEqual([]);
    }
  });

  it('should extract plugin entries with description in metadata', async () => {
    const manifest = {
      name: 'test-marketplace',
      plugins: [
        {
          name: 'plugin-a',
          metadata: { description: 'Description from metadata' },
          source: './plugins/plugin-a',
        },
      ],
    };
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(manifest),
    );

    const result = await parseMarketplaceManifest(testDir);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.plugins).toHaveLength(1);
      expect(result.data.plugins[0].description).toBe('Description from metadata');
      expect(result.warnings.some(w => w.includes('metadata instead of top level'))).toBe(true);
    }
  });

  it('should skip plugin entries without a name', async () => {
    const manifest = {
      name: 'test-marketplace',
      description: 'Test',
      plugins: [
        { description: 'No name plugin', source: './plugins/noname' },
        { name: 'valid-plugin', description: 'Valid', source: './plugins/valid' },
      ],
    };
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(manifest),
    );

    const result = await parseMarketplaceManifest(testDir);
    expect(result.success).toBe(true);
    if (result.success) {
      // Only the valid plugin is included
      expect(result.data.plugins).toHaveLength(1);
      expect(result.data.plugins[0].name).toBe('valid-plugin');
      expect(result.warnings.some(w => w.includes('missing "name"'))).toBe(true);
    }
  });

  it('should skip non-object plugin entries', async () => {
    const manifest = {
      name: 'test-marketplace',
      plugins: [
        'not-an-object',
        { name: 'valid-plugin', description: 'Valid', source: './plugins/valid' },
      ],
    };
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(manifest),
    );

    const result = await parseMarketplaceManifest(testDir);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.plugins).toHaveLength(1);
      expect(result.data.plugins[0].name).toBe('valid-plugin');
      expect(result.warnings.some(w => w.includes('not an object'))).toBe(true);
    }
  });

  it('should warn about missing source field', async () => {
    const manifest = {
      name: 'test-marketplace',
      plugins: [
        { name: 'no-source', description: 'No source' },
      ],
    };
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(manifest),
    );

    const result = await parseMarketplaceManifest(testDir);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.plugins).toHaveLength(1);
      expect(result.data.plugins[0].name).toBe('no-source');
      expect(result.data.plugins[0].source).toBe('');
      expect(result.warnings.some(w => w.includes('missing or invalid "source"'))).toBe(true);
    }
  });

  it('should include valid and best-effort entries together', async () => {
    const manifest = {
      name: 'mixed-marketplace',
      plugins: [
        { name: 'strict-valid', description: 'Fully valid', source: './plugins/valid' },
        { name: 'missing-desc', source: './plugins/missing-desc' },
        { name: 'missing-source', description: 'Has desc' },
        'garbage',
        { description: 'no name' },
      ],
    };
    writeFileSync(
      join(testDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify(manifest),
    );

    const result = await parseMarketplaceManifest(testDir);
    expect(result.success).toBe(true);
    if (result.success) {
      // strict-valid passes strict per-entry check
      // missing-desc and missing-source extracted with best-effort
      // 'garbage' and {description:'no name'} skipped
      expect(result.data.plugins).toHaveLength(3);
      expect(result.data.plugins.map(p => p.name)).toEqual([
        'strict-valid', 'missing-desc', 'missing-source',
      ]);
      expect(result.warnings.length).toBeGreaterThan(0);
    }
  });

  it('should leniently parse GitHub source and normalize to URL source', async () => {
    // This mimics the real WTG marketplace.json where ediprod uses github source
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

    const result = await parseMarketplaceManifest(testDir);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.plugins).toHaveLength(2);

      // cargowise should be a local path string
      expect(result.data.plugins[0].name).toBe('cargowise');
      expect(result.data.plugins[0].source).toBe('./plugins/cargowise');

      // ediprod should be normalized from github to url source
      const ediprod = result.data.plugins[1];
      expect(ediprod.name).toBe('ediprod');
      expect(typeof ediprod.source).toBe('object');
      if (typeof ediprod.source === 'object') {
        expect(ediprod.source.source).toBe('url');
        expect(ediprod.source.url).toBe('https://github.com/WiseTechGlobal/mcp-ediprod');
      }

      // Should have a warning about missing description on ediprod
      expect(result.warnings.some(w => w.includes('ediprod') && w.includes('description'))).toBe(true);
    }
  });
});

describe('resolvePluginSourcePath', () => {
  it('should resolve relative path source', () => {
    const result = resolvePluginSourcePath('./plugins/my-plugin', '/home/user/marketplace');
    expect(result).toBe(resolve('/home/user/marketplace', './plugins/my-plugin'));
  });

  it('should resolve plain relative path', () => {
    const result = resolvePluginSourcePath('plugins/my-plugin', '/home/user/marketplace');
    expect(result).toBe(resolve('/home/user/marketplace', 'plugins/my-plugin'));
  });

  it('should return url for URL source objects', () => {
    const source = { source: 'url' as const, url: 'https://github.com/org/repo.git' };
    const result = resolvePluginSourcePath(source, '/home/user/marketplace');
    expect(result).toBe('https://github.com/org/repo.git');
  });
});
