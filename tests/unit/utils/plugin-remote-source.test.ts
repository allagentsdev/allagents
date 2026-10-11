import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as paths from '../../../src/utils/plugin-path.js';
import { getEffectivePluginSource } from '../../../src/models/workspace-config.js';

const remote = 'ssh://deploy@git.example.test:2222/team/skills.git';
const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('ordinary remote plugin sources', () => {
  it('classifies Git transports before local paths and retains the exact clone URL', () => {
    for (const source of [remote, 'deploy@git.example.test:team/skills.git', 'git.example.test:team/skills', 'https://git.example.test/group/team/skills.git']) {
      expect(paths.parsePluginSource(source).type).toBe('git');
      expect(paths.normalizePluginPath(source)).toBe(source);
      const parsed = paths.parseRemotePluginSource(source);
      expect(parsed?.url).toBe(source);
      expect(parsed?.repo).toBe('skills');
    }
    for (const source of ['./team/skills', '/team/skills', 'C:/team/skills', 'C:\\team\\skills', 'plugin@marketplace', 'npm:package', 'git:owner/repo']) {
      expect(paths.isRemotePluginSource(source)).toBe(false);
    }
  });

  it('retains legacy GitHub ref, subpath and cache behavior', () => {
    const parsed = paths.parseRemotePluginSource('owner/repo@main/skills/example');
    expect(parsed).toMatchObject({ type: 'github', owner: 'owner', repo: 'repo', branch: 'main', subpath: 'skills/example', url: 'https://github.com/owner/repo.git', provenanceKey: 'owner/repo/skills/example' });
    expect(parsed?.cachePath).toBe(paths.getPluginCachePath('owner', 'repo', 'main'));
    expect(paths.parseRemotePluginSource('https://github.com/owner/repo/tree/main/skills/example')?.subpath).toBe('skills/example');
  });

  it('preserves explicit GitHub SSH transports with the legacy cache identity', () => {
    for (const source of ['git@github.com:owner/repo.git', 'ssh://git@github.com/owner/repo.git']) {
      expect(paths.parseRemotePluginSource(`${source}#ref=main`)).toMatchObject({
        type: 'github', url: source, branch: 'main',
        cachePath: paths.getPluginCachePath('owner', 'repo', 'main'),
      });
    }
  });

  it('decodes metadata and applies object refs only when an inline ref is absent', () => {
    const source = `${remote}#ref=feature%2Fdemo&subdir=collections%2Fteam`;
    expect(paths.parseRemotePluginSource(source)).toMatchObject({ url: remote, branch: 'feature/demo', subpath: 'collections/team' });
    expect(getEffectivePluginSource({ source, ref: 'other' })).toBe(source);
    const effective = getEffectivePluginSource({ source: `${remote}#subdir=collections%2Fteam`, ref: 'release/demo' });
    expect(paths.parseRemotePluginSource(effective)).toMatchObject({ branch: 'release/demo', subpath: 'collections/team' });
    expect(getEffectivePluginSource({ source: 'owner/repo/sub', ref: 'release' })).toBe('owner/repo@release/sub');
    expect(getEffectivePluginSource({ source: './local', ref: 'release' })).toBe('./local');
  });

  it('isolates remote/ref identities while sharing clones between subdirectories', () => {
    const variants = [remote, remote.replace(':2222', ':2223'), remote.replace('example.test', 'other.test'), remote.replace('/team/', '/other/'), `${remote}#ref=feature%2Fdemo`, `${remote}#ref=feature_demo`];
    const parsed = variants.map((source) => paths.parseRemotePluginSource(source));
    expect(new Set(parsed.map((source) => source?.cachePath)).size).toBe(variants.length);
    expect(new Set(parsed.map((source) => source?.provenanceKey)).size).toBe(variants.length);
    const one = paths.parseRemotePluginSource(`${remote}#ref=main&subdir=one`);
    const two = paths.parseRemotePluginSource(`${remote}#ref=main&subdir=two`);
    expect(one?.cachePath).toBe(two?.cachePath);
    expect(one?.provenanceKey).not.toBe(two?.provenanceKey);
    expect(paths.getPluginDisplayName(remote)).toBe('skills');
    expect(paths.getPluginDisplayName(`${remote}#subdir=collections%2Fteam`)).toBe('team');
  });

  it('rejects invalid metadata and checkout escaping subdirectories', () => {
    for (const fragment of ['ref=', 'unknown=main', 'ref=main&ref=other', 'ref=%ZZ', 'ref=%00', 'subdir=', 'subdir=%2Ftmp', 'subdir=..%2Foutside', 'subdir=C%3A%2Foutside', 'subdir=one%5C..%5Coutside']) {
      expect(paths.validatePluginSource(`${remote}#${fragment}`).valid).toBe(false);
    }
    const fixture = mkdtempSync(join(tmpdir(), 'allagents-remote-path-'));
    temporary.push(fixture);
    const checkout = join(fixture, 'checkout');
    mkdirSync(checkout);
    mkdirSync(join(fixture, 'outside'));
    symlinkSync(join(fixture, 'outside'), join(checkout, 'escaped'));
    expect(() => paths.resolveRemotePluginPath(`${remote}#subdir=escaped`, checkout)).toThrow('outside');
    expect(() => paths.resolveRemotePluginPath(`${remote}#subdir=escaped/missing`, checkout)).toThrow('outside');
    mkdirSync(join(checkout, 'inside'));
    expect(paths.resolveRemotePluginPath(`${remote}#subdir=inside`, checkout)).toBe(join(checkout, 'inside'));
  });
});
