import { describe, it, expect } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveFetchedSourcePath,
  classifySkillAddPositional,
  resolveSkillFromUrl,
  resolveSkillNameFromRepo,
} from '../../../src/cli/commands/plugin-skills.js';
import type { FetchResult } from '../../../src/core/plugin.js';

describe('resolveSkillFromUrl', () => {
  it('returns null for non-URL skill names', () => {
    expect(resolveSkillFromUrl('my-skill')).toBeNull();
  });

  it('extracts skill name from URL with subpath', () => {
    const result = resolveSkillFromUrl(
      'https://github.com/anthropics/skills/tree/main/skills/skill-creator',
    );
    expect(result).toEqual({
      skill: 'skill-creator',
      from: 'https://github.com/anthropics/skills/tree/main/skills/skill-creator',
      parsed: expect.objectContaining({ owner: 'anthropics', repo: 'skills', subpath: 'skills/skill-creator' }),
    });
  });

  it('resolves a SKILL.md blob URL to its containing skill directory', () => {
    const result = resolveSkillFromUrl(
      'https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md',
    );
    expect(result).toEqual({
      skill: 'pdf',
      from: 'https://github.com/anthropics/skills/blob/main/skills/pdf',
      parsed: expect.objectContaining({
        owner: 'anthropics',
        repo: 'skills',
        branch: 'main',
        subpath: 'skills/pdf',
      }),
    });
  });

  it('resolves a root SKILL.md blob URL to the repository root', () => {
    const result = resolveSkillFromUrl(
      'https://github.com/owner/root-skill/blob/main/SKILL.md',
    );
    expect(result).toEqual({
      skill: 'root-skill',
      from: 'https://github.com/owner/root-skill/blob/main',
      parsed: {
        owner: 'owner',
        repo: 'root-skill',
        branch: 'main',
      },
    });
  });

  it('extracts skill name from URL with deep subpath', () => {
    const result = resolveSkillFromUrl(
      'https://github.com/org/repo/tree/main/plugins/my-plugin/skills/cool-skill',
    );
    expect(result?.skill).toBe('cool-skill');
  });

  it('falls back to repo name for URL without subpath', () => {
    const result = resolveSkillFromUrl('https://github.com/owner/my-skill-repo');
    expect(result).toEqual({
      skill: 'my-skill-repo',
      from: 'https://github.com/owner/my-skill-repo',
      parsed: expect.objectContaining({ owner: 'owner', repo: 'my-skill-repo' }),
    });
  });

  it('works with owner/repo/subpath shorthand', () => {
    const result = resolveSkillFromUrl('anthropics/skills/skills/skill-creator');
    expect(result?.skill).toBe('skill-creator');
    expect(result?.from).toBe('anthropics/skills/skills/skill-creator');
  });

  it('falls back to repo name for gh: shorthand without tree path', () => {
    const result = resolveSkillFromUrl('gh:owner/my-skill-repo');
    expect(result?.skill).toBe('my-skill-repo');
    expect(result?.from).toBe('gh:owner/my-skill-repo');
  });
});

describe('resolveSkillNameFromRepo', () => {
  const fakeFetch = (result: FetchResult) =>
    (async () => result) as unknown as typeof import('../../../src/core/plugin.js').fetchPlugin;

  it('returns frontmatter name when SKILL.md exists with name', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'skill-test-'));
    try {
      await writeFile(
        join(tmpDir, 'SKILL.md'),
        '---\nname: my-awesome-skill\ndescription: A test skill\n---\n# Skill\n',
      );

      const result = await resolveSkillNameFromRepo(
        'https://github.com/owner/repo',
        { owner: 'owner', repo: 'repo' },
        'fallback-name',
        fakeFetch({ success: true, action: 'fetched', cachePath: tmpDir }),
      );
      expect(result).toBe('my-awesome-skill');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns fallback name when SKILL.md does not exist', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'skill-test-'));
    try {
      const result = await resolveSkillNameFromRepo(
        'https://github.com/owner/repo',
        { owner: 'owner', repo: 'repo' },
        'fallback-name',
        fakeFetch({ success: true, action: 'fetched', cachePath: tmpDir }),
      );
      expect(result).toBe('fallback-name');
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns fallback name when fetchPlugin fails', async () => {
    const result = await resolveSkillNameFromRepo(
      'https://github.com/owner/repo',
      { owner: 'owner', repo: 'repo' },
      'fallback-name',
      fakeFetch({ success: false, action: 'skipped', cachePath: '', error: 'network error' }),
    );
    expect(result).toBe('fallback-name');
  });
});

describe('resolveFetchedSourcePath', () => {
  it('appends the GitHub subpath to the fetched repo root once', () => {
    expect(
      resolveFetchedSourcePath(
        'https://github.com/NousResearch/hermes-agent/tree/main/skills/research/llm-wiki',
        '/tmp/hermes-agent-cache',
      ),
    ).toBe('/tmp/hermes-agent-cache/skills/research/llm-wiki');
  });

  it('leaves non-GitHub sources unchanged', () => {
    expect(resolveFetchedSourcePath('/tmp/local-skill', '/tmp/local-skill')).toBe('/tmp/local-skill');
  });
});

describe('arbitrary Git skill source commands', () => {
  it('classifies SCP transport usernames as a source with skill selection', () => {
    expect(classifySkillAddPositional('alice@forgejo.example:team/skills.git', 'fixture', false, false)).toEqual({ shape: 'source', skills: ['fixture'] });
  });
  it('auto-discovers a generic selected repository directory', () => {
    expect(classifySkillAddPositional('ssh://alice@git.example:2222/team/skills.git#ref=feature%2Fdemo&subdir=selected', undefined, false, false)).toEqual({ shape: 'source-auto' });
  });
  it('resolves encoded generic subdirectories at the fetched checkout', async () => {
    const cache = await mkdtemp(join(tmpdir(), 'allagents-git-skill-path-'));
    try {
      expect(resolveFetchedSourcePath('https://git.example/team/skills.git#subdir=selected%2Fnested', cache)).toBe(join(cache, 'selected', 'nested'));
    } finally { await rm(cache, { recursive: true, force: true }); }
  });
});
