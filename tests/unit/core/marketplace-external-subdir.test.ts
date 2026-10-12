import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addMarketplace, resolvePluginSpec } from '../../../src/core/marketplace.js';
import { addPluginDeclaration, resolveGitHubIdentity } from '../../../src/core/workspace-modify.js';
import { getEmbeddedMarketplaceFileArtifacts, parseMarketplaceManifest } from '../../../src/utils/marketplace-manifest-parser.js';
import { parseRemotePluginSource } from '../../../src/utils/plugin-path.js';

let root: string;
let previousHome: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'allagents-external-subdir-'));
  previousHome = process.env.ALLAGENTS_TEST_HOME;
  process.env.ALLAGENTS_TEST_HOME = join(root, 'user');
  mkdirSync(join(root, '.claude-plugin'));
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.ALLAGENTS_TEST_HOME;
  else process.env.ALLAGENTS_TEST_HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
});
function manifest(source: unknown) {
  writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'legacy', description: 'Legacy catalogue',
    plugins: [{ name: 'finance', description: 'Finance', source }],
  }));
}
function checkout(path: string) {
  mkdirSync(join(path, 'plugins', 'finance', 'skills', 'financial-modeling'), { recursive: true });
  writeFileSync(join(path, 'plugins', 'finance', 'skills', 'financial-modeling', 'SKILL.md'), '---\nname: financial-modeling\n---\nModel');
  mkdirSync(join(path, 'plugins', 'engineering', 'skills', 'review'), { recursive: true });
}

describe('external marketplace subdirectories', () => {
  for (const source of [
    { source: 'github', repo: 'example/agent-plugins', path: 'plugins/finance', ref: 'review' },
    { source: 'git-subdir', url: 'https://github.com/example/agent-plugins.git', path: 'plugins/finance', ref: 'review' },
    { source: 'url', url: 'https://github.com/example/agent-plugins.git', path: 'plugins/finance', ref: 'review' },
  ]) {
    it(`resolves only the selected ${source.source} plugin online`, async () => {
      manifest(source);
      const cache = join(root, 'checkout');
      checkout(cache);
      const result = await resolvePluginSpec('finance@legacy', {
        marketplacePathOverride: root,
        fetchFn: async () => ({ success: true, action: 'fetched', cachePath: cache }),
      });
      expect(result?.path).toBe(join(cache, 'plugins', 'finance'));
    });
  }

  it('uses the requested ref cache and selected plugin when offline', async () => {
    manifest({ source: 'github', repo: 'example/agent-plugins', path: 'plugins/finance', ref: 'review' });
    const remote = parseRemotePluginSource('https://github.com/example/agent-plugins#ref=review&subdir=plugins%2Ffinance')!;
    checkout(remote.cachePath);
    const result = await resolvePluginSpec('finance@legacy', { marketplacePathOverride: root, offline: true });
    expect(result?.path).toBe(join(remote.cachePath, 'plugins', 'finance'));
  });

  it('does not substitute a default-branch cache for a missing requested ref', async () => {
    manifest({ source: 'github', repo: 'example/agent-plugins', path: 'plugins/finance', ref: 'missing' });
    checkout(parseRemotePluginSource('https://github.com/example/agent-plugins')!.cachePath);
    checkout(root);
    expect(await resolvePluginSpec('finance@legacy', { marketplacePathOverride: root, offline: true })).toBeNull();
  });


  it('does not substitute a same-name local plugin when external fetching fails', async () => {
    manifest({ source: 'github', repo: 'example/agent-plugins', path: 'plugins/finance' });
    checkout(root);
    expect(await resolvePluginSpec('finance@legacy', {
      marketplacePathOverride: root,
      fetchFn: async () => ({ success: false, action: 'skipped', cachePath: '', error: 'offline' }),
    })).toBeNull();
  });

  it('matches direct and forwarded plugin identities without merging sibling plugins', async () => {
    manifest({ source: 'github', repo: 'example/agent-plugins', path: 'plugins/finance', ref: 'review' });
    expect((await addMarketplace(root)).success).toBe(true);
    const forwarded = await resolveGitHubIdentity('finance@legacy');
    expect(forwarded).toBe('example/agent-plugins/plugins/finance');
    expect(await resolveGitHubIdentity('https://github.com/example/agent-plugins/tree/main/plugins/finance')).toBe(forwarded);
    expect(await resolveGitHubIdentity('https://github.com/example/agent-plugins#subdir=plugins%2Ffinance&ref=other')).toBe(forwarded);
    expect(await resolveGitHubIdentity('https://github.com/example/agent-plugins/plugins/engineering')).not.toBe(forwarded);
    expect(await resolveGitHubIdentity('https://github.com/EXAMPLE/AGENT-PLUGINS/plugins/Finance')).not.toBe(forwarded);
    expect(await resolveGitHubIdentity('https://github.com/EXAMPLE/AGENT-PLUGINS#subdir=.%2Fplugins%2Ffinance')).toBe(forwarded);
    const workspace = join(root, 'workspace');
    mkdirSync(join(workspace, '.allagents'), { recursive: true });
    writeFileSync(join(workspace, '.allagents', 'workspace.yaml'), 'version: 2\nrepositories: []\nplugins:\n  - finance@legacy\nclients: [universal]\n');
    expect((await addPluginDeclaration('https://github.com/example/agent-plugins/tree/main/plugins/finance', workspace)).success).toBe(false);
    expect((await addPluginDeclaration('https://github.com/example/agent-plugins/tree/main/plugins/engineering', workspace)).success).toBe(true);
  });

  it('preserves root resolution for legacy URL sources', async () => {
    manifest({ source: 'url', url: 'https://github.com/example/finance.git' });
    const cache = join(root, 'legacy-checkout');
    mkdirSync(cache);
    expect((await resolvePluginSpec('finance@legacy', {
      marketplacePathOverride: root,
      fetchFn: async () => ({ success: true, action: 'fetched', cachePath: cache }),
    }))?.path).toBe(cache);
  });

  it('rejects a symlink that points outside the external checkout', async () => {
    manifest({ source: 'git-subdir', url: 'example/agent-plugins', path: 'plugins/finance' });
    const cache = join(root, 'checkout');
    mkdirSync(join(cache, 'plugins'), { recursive: true });
    mkdirSync(join(root, 'outside'));
    symlinkSync(join(root, 'outside'), join(cache, 'plugins', 'finance'));
    await expect(resolvePluginSpec('finance@legacy', {
      marketplacePathOverride: root,
      fetchFn: async () => ({ success: true, action: 'fetched', cachePath: cache }),
    })).rejects.toThrow('outside the repository');
  });

  for (const path of ['../finance', '/finance', 'plugins/../../finance', 'C:/finance', 'plugins\\finance']) {
    it(`rejects unsafe external path ${path}`, async () => {
      manifest({ source: 'github', repo: 'example/agent-plugins', path });
      expect((await parseMarketplaceManifest(root, 'finance')).success).toBe(false);
    });
  }

  it('lists a mixed catalogue and resolves valid plugins without bypassing a rejected sibling', async () => {
    checkout(root);
    mkdirSync(join(root, 'plugins', 'unsupported'), { recursive: true });
    writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      name: 'legacy', description: 'Mixed catalogue', plugins: [
        { name: 'finance', description: 'Finance', source: './plugins/finance' },
        { name: 'unsupported', description: 'Pinned plugin', source: { source: 'github', repo: 'example/catalogue', sha: 'a'.repeat(40) } },
      ],
    }));
    const listed = await parseMarketplaceManifest(root);
    expect(listed.success).toBe(true);
    if (listed.success) {
      expect(listed.data.plugins.map((entry) => entry.name)).toEqual(['finance', 'unsupported']);
      expect(listed.warnings.length).toBeGreaterThan(0);
    }
    const selected = await parseMarketplaceManifest(root, 'finance');
    expect(selected.success).toBe(true);
    if (selected.success) expect(selected.warnings).toEqual([]);
    expect((await resolvePluginSpec('finance@legacy', { marketplacePathOverride: root, offline: true }))?.path).toBe(join(root, 'plugins', 'finance'));
    expect(await resolvePluginSpec('unsupported@legacy', { marketplacePathOverride: root, offline: true })).toBeNull();
  });

  it('retains unknown empty-name warnings for a selected missing plugin', async () => {
    writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      name: 'legacy', description: 'Malformed catalogue', plugins: [
        { name: '', description: 'Unknown plugin', source: './plugins/finance' },
      ],
    }));
    const selected = await parseMarketplaceManifest(root, 'finance');
    expect(selected.success).toBe(true);
    if (selected.success) expect(selected.warnings.some((warning) => warning.includes('missing "name"'))).toBe(true);
  });

  it('does not infer repository-root artifacts from an unsupported remote entry', async () => {
    writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      name: 'legacy', description: 'Mixed catalogue', plugins: [
        { name: 'unsupported', description: 'Unsupported source', source: { source: 'npm', package: 'example' }, strict: false, skills: ['./skills'] },
      ],
    }));
    expect(await getEmbeddedMarketplaceFileArtifacts(root, 'unsupported')).toBeUndefined();
  });

  it('rejects an unsupported SHA instead of silently dropping the pin', async () => {
    manifest({ source: 'github', repo: 'example/agent-plugins', sha: 'a'.repeat(40) });
    const result = await parseMarketplaceManifest(root, 'finance');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain('SHA pins');
    checkout(root);
    expect(await resolvePluginSpec('finance@legacy', { marketplacePathOverride: root, offline: true })).toBeNull();
  });
});
