import { describe, it, expect, beforeEach, afterEach, test } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import { stubHomeDir } from '../../helpers/env.js';
import {
  getAllSkillsFromPlugins,
  discoverNestedSkillEntries,
  type SkillInfo,
} from '../../../src/core/skills.js';
import { resetFetchCache } from '../../../src/core/plugin.js';
import { getPluginCachePath } from '../../../src/utils/plugin-path.js';

describe('getAllSkillsFromPlugins', () => {
  let tmpDir: string;
  let pluginDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'allagents-skills-test-'));
    pluginDir = join(tmpDir, 'test-plugin');

    // Create a mock plugin with skills
    await mkdir(join(pluginDir, 'skills/skill-a'), { recursive: true });
    await mkdir(join(pluginDir, 'skills/skill-b'), { recursive: true });
    await writeFile(join(pluginDir, 'skills/skill-a/SKILL.md'), '# Skill A');
    await writeFile(join(pluginDir, 'skills/skill-b/SKILL.md'), '# Skill B');

    // Create workspace config
    await mkdir(join(tmpDir, '.allagents'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('lists all skills from installed plugins', async () => {
    const config = {
      repositories: [],
      plugins: [pluginDir],
      clients: ['claude'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    const skills = await getAllSkillsFromPlugins(tmpDir);
    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.name)).toContain('skill-a');
    expect(skills.map((s) => s.name)).toContain('skill-b');
    expect(skills.every((s) => s.pluginName === 'test-plugin')).toBe(true);
    expect(skills.every((s) => s.disabled === false)).toBe(true);
  });

  it('treats a config without a plugins key as declaring no plugins', async () => {
    // Hand-written and profile-only workspace configs omit `plugins`. The
    // schema defaults it to [], but this reader consumes the raw YAML, so the
    // absent key must not crash enumeration.
    await writeFile(
      join(tmpDir, '.allagents/workspace.yaml'),
      dump({ repositories: [], clients: ['claude'] }),
    );

    expect(await getAllSkillsFromPlugins(tmpDir)).toEqual([]);
  });

  it('marks disabled skills correctly', async () => {
    const config = {
      repositories: [],
      plugins: [pluginDir],
      clients: ['claude'],
      disabledSkills: ['test-plugin:skill-a'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    const skills = await getAllSkillsFromPlugins(tmpDir);
    const skillA = skills.find((s) => s.name === 'skill-a');
    const skillB = skills.find((s) => s.name === 'skill-b');

    expect(skillA?.disabled).toBe(true);
    expect(skillB?.disabled).toBe(false);
  });

  it('marks skills correctly in enabledSkills (allowlist) mode', async () => {
    const config = {
      repositories: [],
      plugins: [pluginDir],
      clients: ['claude'],
      enabledSkills: ['test-plugin:skill-a'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    const skills = await getAllSkillsFromPlugins(tmpDir);
    const skillA = skills.find((s) => s.name === 'skill-a');
    const skillB = skills.find((s) => s.name === 'skill-b');

    // skill-a is in the allowlist -> enabled (disabled: false)
    expect(skillA?.disabled).toBe(false);
    // skill-b is NOT in the allowlist -> disabled (disabled: true)
    expect(skillB?.disabled).toBe(true);
  });

  it('discovers root-level SKILL.md with frontmatter name', async () => {
    const rootSkillPlugin = join(tmpDir, 'root-skill-plugin');
    await mkdir(rootSkillPlugin, { recursive: true });
    await writeFile(
      join(rootSkillPlugin, 'SKILL.md'),
      '---\nname: my-skill\ndescription: A test skill\n---\n# My Skill',
    );

    const config = {
      repositories: [],
      plugins: [rootSkillPlugin],
      clients: ['claude'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    const skills = await getAllSkillsFromPlugins(tmpDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe('my-skill');
    expect(skills[0]!.pluginName).toBe('root-skill-plugin');
    expect(skills[0]!.path).toBe(rootSkillPlugin);
  });

  it('falls back to directory name when root SKILL.md has no frontmatter name', async () => {
    const rootSkillPlugin = join(tmpDir, 'fallback-name-plugin');
    await mkdir(rootSkillPlugin, { recursive: true });
    await writeFile(join(rootSkillPlugin, 'SKILL.md'), '# Just content, no frontmatter');

    const config = {
      repositories: [],
      plugins: [rootSkillPlugin],
      clients: ['claude'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    const skills = await getAllSkillsFromPlugins(tmpDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe('fallback-name-plugin');
  });

  it('prefers flat layout over root-level SKILL.md', async () => {
    const mixedPlugin = join(tmpDir, 'mixed-plugin');
    await mkdir(join(mixedPlugin, 'sub-skill'), { recursive: true });
    await writeFile(join(mixedPlugin, 'SKILL.md'), '---\nname: root\ndescription: root\n---\n');
    await writeFile(join(mixedPlugin, 'sub-skill/SKILL.md'), '# Sub skill');

    const config = {
      repositories: [],
      plugins: [mixedPlugin],
      clients: ['claude'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    const skills = await getAllSkillsFromPlugins(tmpDir);
    expect(skills).toHaveLength(1);
    expect(skills[0]!.name).toBe('sub-skill');
  });

  it('discovers nested skills from a promoted container path', async () => {
    const containerPlugin = join(tmpDir, 'container-plugin');
    await mkdir(join(containerPlugin, 'research', 'llm-wiki'), { recursive: true });
    await mkdir(join(containerPlugin, 'productivity', 'nano-pdf'), { recursive: true });
    await writeFile(join(containerPlugin, 'research', 'llm-wiki', 'SKILL.md'), '# llm-wiki');
    await writeFile(join(containerPlugin, 'productivity', 'nano-pdf', 'SKILL.md'), '# nano-pdf');

    const config = {
      repositories: [],
      plugins: [{ source: containerPlugin, skills: ['llm-wiki', 'nano-pdf'] }],
      clients: ['claude'],
      version: 2,
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    const skills = await getAllSkillsFromPlugins(tmpDir);
    expect(skills.map((s) => s.name).sort()).toEqual(['llm-wiki', 'nano-pdf']);
    expect(skills.every((s) => s.disabled === false)).toBe(true);
  });

  it('discovers nested skills under skills/<category>/<skill>/', async () => {
    const hermesPlugin = join(tmpDir, 'hermes-style-plugin');
    await mkdir(join(hermesPlugin, 'skills/research/llm-wiki'), { recursive: true });
    await mkdir(join(hermesPlugin, 'skills/dogfood'), { recursive: true });
    await writeFile(join(hermesPlugin, 'skills/research/llm-wiki/SKILL.md'), '# llm-wiki');
    await writeFile(join(hermesPlugin, 'skills/dogfood/SKILL.md'), '# dogfood');

    const config = {
      repositories: [],
      plugins: [hermesPlugin],
      clients: ['claude'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    const skills = await getAllSkillsFromPlugins(tmpDir);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(['dogfood', 'llm-wiki']);
    const llmWiki = skills.find((s) => s.name === 'llm-wiki');
    expect(llmWiki?.skillSubpath).toBe('research/llm-wiki');
    const dogfood = skills.find((s) => s.name === 'dogfood');
    expect(dogfood?.skillSubpath).toBe('dogfood');
  });

  it('respects allowlist that uses a qualified subpath for a nested skill', async () => {
    const hermesPlugin = join(tmpDir, 'hermes-style-plugin-2');
    await mkdir(join(hermesPlugin, 'skills/research/llm-wiki'), { recursive: true });
    await mkdir(join(hermesPlugin, 'skills/games/llm-wiki'), { recursive: true });
    await writeFile(join(hermesPlugin, 'skills/research/llm-wiki/SKILL.md'), '# research');
    await writeFile(join(hermesPlugin, 'skills/games/llm-wiki/SKILL.md'), '# games');

    const config = {
      repositories: [],
      plugins: [{ source: hermesPlugin, skills: ['research/llm-wiki'] }],
      clients: ['claude'],
      version: 2,
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    const skills = await getAllSkillsFromPlugins(tmpDir);
    const research = skills.find((s) => s.skillSubpath === 'research/llm-wiki');
    const games = skills.find((s) => s.skillSubpath === 'games/llm-wiki');
    expect(research?.disabled).toBe(false);
    expect(games?.disabled).toBe(true);
  });

  it('omits directories under skills/ that lack a SKILL.md', async () => {
    const plugin = join(tmpDir, 'fluff-plugin');
    await mkdir(join(plugin, 'skills/empty-category'), { recursive: true });
    await mkdir(join(plugin, 'skills/real-skill'), { recursive: true });
    await writeFile(join(plugin, 'skills/real-skill/SKILL.md'), '# real');

    const config = {
      repositories: [],
      plugins: [plugin],
      clients: ['claude'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    const skills = await getAllSkillsFromPlugins(tmpDir);
    expect(skills.map((s) => s.name)).toEqual(['real-skill']);
  });

  it('skips GitHub URL entries whose subpath no longer exists in cache', async () => {
    const restoreHomeDir = stubHomeDir(tmpDir);
    resetFetchCache();
    try {
      const cachePath = getPluginCachePath('owner', 'repo', 'main');
      const siblingPath = join(cachePath, 'available');
      await mkdir(siblingPath, { recursive: true });
      await writeFile(join(siblingPath, 'SKILL.md'), '# Cached sibling');

      const missingSource = 'https://github.com/owner/repo/tree/main/missing/path';
      const siblingSource = 'https://github.com/owner/repo/tree/main/available';

      const config = {
        repositories: [],
        plugins: [missingSource, siblingSource],
        clients: ['claude'],
      };
      await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

      const skills = await getAllSkillsFromPlugins(tmpDir);
      expect(
        skills.map(({ name, pluginSource, path }) => ({ name, pluginSource, path })),
      ).toEqual([
        { name: 'available', pluginSource: siblingSource, path: siblingPath },
      ]);
    } finally {
      restoreHomeDir();
      resetFetchCache();
    }
  });
});

describe('discoverNestedSkillEntries error handling', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'allagents-skills-walk-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('records a warning instead of throwing when the scan root cannot be read', async () => {
    // A file (not a directory) makes readdir() throw ENOTDIR, exercising the
    // same catch path a real EPERM/EACCES on a restricted directory would.
    const notADir = join(tmpDir, 'not-a-directory');
    await writeFile(notADir, 'not a directory');

    const warnings: string[] = [];
    const entries = await discoverNestedSkillEntries(notADir, warnings);

    expect(entries).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(notADir);
    expect(warnings[0]).toContain('workspace.yaml');
  });

  it('still discovers sibling skills when one plugin path cannot be read', async () => {
    const goodPlugin = join(tmpDir, 'good-plugin');
    await mkdir(join(goodPlugin, 'skills', 'good-skill'), { recursive: true });
    await writeFile(join(goodPlugin, 'skills', 'good-skill', 'SKILL.md'), '# good');

    const badPlugin = join(tmpDir, 'bad-plugin-is-a-file');
    await writeFile(badPlugin, 'not a directory');

    const warnings: string[] = [];
    const goodEntries = await discoverNestedSkillEntries(
      join(goodPlugin, 'skills'),
      warnings,
    );
    const badEntries = await discoverNestedSkillEntries(badPlugin, warnings);

    expect(goodEntries.map((e) => e.name)).toEqual(['good-skill']);
    expect(badEntries).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  test.skipIf(process.platform === 'win32')(
    'skips symlinked directories instead of following loops',
    async () => {
      const pluginDir = join(tmpDir, 'symlink-plugin');
      await mkdir(join(pluginDir, 'real-skill'), { recursive: true });
      await writeFile(join(pluginDir, 'real-skill', 'SKILL.md'), '# real');

      // A symlink back to the plugin root would recurse forever if followed.
      await symlink(pluginDir, join(pluginDir, 'loop'), 'dir');

      const entries = await discoverNestedSkillEntries(pluginDir);
      expect(entries.map((e) => e.name)).toEqual(['real-skill']);
    },
  );
});
