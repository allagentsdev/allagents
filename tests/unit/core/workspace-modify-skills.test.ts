import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as dump } from 'yaml';
import {
  addDisabledSkill,
  removeDisabledSkill,
  getDisabledSkills,
  addEnabledSkill,
  removeEnabledSkill,
  getEnabledSkills,
  removePlugin,
  setPluginSkillsMode,
} from '../../../src/core/workspace-modify.js';

describe('disabledSkills helpers', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'allagents-test-'));
    await mkdir(join(tmpDir, '.allagents'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('addDisabledSkill', () => {
    it('adds skill to empty disabledSkills', async () => {
      const config = { repositories: [], plugins: ['superpowers'], clients: ['claude'] };
      await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

      const result = await addDisabledSkill('superpowers:brainstorming', tmpDir);
      expect(result.success).toBe(true);

      const skills = await getDisabledSkills(tmpDir);
      expect(skills).toContain('superpowers:brainstorming');
    });

    it('returns error if skill already disabled', async () => {
      const config = {
        repositories: [],
        plugins: [{ source: 'superpowers', skills: { exclude: ['brainstorming'] } }],
        clients: ['claude'],
      };
      await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

      const result = await addDisabledSkill('superpowers:brainstorming', tmpDir);
      expect(result.success).toBe(false);
      expect(result.error).toContain('already disabled');
    });
  });

  describe('removeDisabledSkill', () => {
    it('removes skill from disabledSkills', async () => {
      const config = {
        repositories: [],
        plugins: [
          { source: 'superpowers', skills: { exclude: ['brainstorming'] } },
          { source: 'other', skills: { exclude: ['skill'] } },
        ],
        clients: ['claude'],
      };
      await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

      const result = await removeDisabledSkill('superpowers:brainstorming', tmpDir);
      expect(result.success).toBe(true);

      const skills = await getDisabledSkills(tmpDir);
      expect(skills).not.toContain('superpowers:brainstorming');
      expect(skills).toContain('other:skill');
    });

    it('returns error if skill not in disabledSkills', async () => {
      const config = { repositories: [], plugins: ['superpowers'], clients: ['claude'] };
      await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

      const result = await removeDisabledSkill('superpowers:brainstorming', tmpDir);
      expect(result.success).toBe(false);
      expect(result.error).toContain('already enabled');
    });
  });

  describe('getDisabledSkills', () => {
    it('returns empty array when no disabledSkills', async () => {
      const config = { repositories: [], plugins: [], clients: ['claude'] };
      await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

      const skills = await getDisabledSkills(tmpDir);
      expect(skills).toEqual([]);
    });
  });

  describe('removePlugin cleans up disabledSkills', () => {
    it('removes disabled skills for a plugin@marketplace spec', async () => {
      const config = {
        repositories: [],
        plugins: ['cargowise@wtg-ai-prompts'],
        clients: ['claude'],
        disabledSkills: ['cargowise:cw-document-macro', 'other-plugin:some-skill'],
      };
      await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

      const result = await removePlugin('cargowise@wtg-ai-prompts', tmpDir);
      expect(result.success).toBe(true);

      const skills = await getDisabledSkills(tmpDir);
      expect(skills).not.toContain('cargowise:cw-document-macro');
      expect(skills).toContain('other-plugin:some-skill');
    });

    it('removes all disabled skills for the removed plugin', async () => {
      const config = {
        repositories: [],
        plugins: ['superpowers@official'],
        clients: ['claude'],
        disabledSkills: [
          'superpowers:brainstorming',
          'superpowers:code-review',
          'other:skill',
        ],
      };
      await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

      const result = await removePlugin('superpowers@official', tmpDir);
      expect(result.success).toBe(true);

      const skills = await getDisabledSkills(tmpDir);
      expect(skills).toEqual(['other:skill']);
    });

    it('clears disabledSkills entirely when all entries belong to removed plugin', async () => {
      const config = {
        repositories: [],
        plugins: ['superpowers@official'],
        clients: ['claude'],
        disabledSkills: ['superpowers:brainstorming'],
      };
      await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

      const result = await removePlugin('superpowers@official', tmpDir);
      expect(result.success).toBe(true);

      const skills = await getDisabledSkills(tmpDir);
      expect(skills).toEqual([]);
    });

    it('removes disabled skills when using partial match (bare name)', async () => {
      const config = {
        repositories: [],
        plugins: ['code-review@marketplace'],
        clients: ['claude'],
        disabledSkills: ['code-review:strict-mode'],
      };
      await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

      const result = await removePlugin('code-review', tmpDir);
      expect(result.success).toBe(true);

      const skills = await getDisabledSkills(tmpDir);
      expect(skills).toEqual([]);
    });

    it('leaves disabledSkills unchanged when plugin has no disabled skills', async () => {
      const config = {
        repositories: [],
        plugins: ['superpowers@official'],
        clients: ['claude'],
        disabledSkills: ['other:skill'],
      };
      await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

      const result = await removePlugin('superpowers@official', tmpDir);
      expect(result.success).toBe(true);

      const skills = await getDisabledSkills(tmpDir);
      expect(skills).toEqual(['other:skill']);
    });
  });
});

describe('enabledSkills helpers', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'allagents-test-'));
    await mkdir(join(tmpDir, '.allagents'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe('addEnabledSkill', () => {
    it('adds skill to empty enabledSkills', async () => {
      const config = { repositories: [], plugins: ['superpowers'], clients: ['claude'] };
      await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));
      const result = await addEnabledSkill('superpowers:brainstorming', tmpDir);
      expect(result.success).toBe(true);
      const skills = await getEnabledSkills(tmpDir);
      expect(skills).toContain('superpowers:brainstorming');
    });

    it('returns error if skill already enabled', async () => {
      const config = {
        repositories: [],
        plugins: [{ source: 'superpowers', skills: ['brainstorming'] }],
        clients: ['claude'],
      };
      await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));
      const result = await addEnabledSkill('superpowers:brainstorming', tmpDir);
      expect(result.success).toBe(false);
      expect(result.error).toContain('already enabled');
    });
  });

  describe('removeEnabledSkill', () => {
    it('removes skill from enabledSkills', async () => {
      const config = {
        repositories: [],
        plugins: [
          { source: 'superpowers', skills: ['brainstorming'] },
          { source: 'other', skills: ['skill'] },
        ],
        clients: ['claude'],
      };
      await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));
      const result = await removeEnabledSkill('superpowers:brainstorming', tmpDir);
      expect(result.success).toBe(true);
      const skills = await getEnabledSkills(tmpDir);
      expect(skills).not.toContain('superpowers:brainstorming');
      expect(skills).toContain('other:skill');
    });

    it('returns error if skill not in enabledSkills', async () => {
      const config = { repositories: [], plugins: ['superpowers'], clients: ['claude'] };
      await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));
      const result = await removeEnabledSkill('superpowers:brainstorming', tmpDir);
      expect(result.success).toBe(false);
      expect(result.error).toContain('already disabled');
    });
  });

  describe('getEnabledSkills', () => {
    it('returns empty array when no enabledSkills', async () => {
      const config = { repositories: [], plugins: [], clients: ['claude'] };
      await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));
      const skills = await getEnabledSkills(tmpDir);
      expect(skills).toEqual([]);
    });
  });

  describe('removePlugin cleans up enabledSkills', () => {
    it('removes enabled skills for a plugin@marketplace spec', async () => {
      const config = {
        repositories: [], plugins: ['superpowers@official'], clients: ['claude'],
        enabledSkills: ['superpowers:brainstorming', 'other:skill'],
      };
      await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));
      const result = await removePlugin('superpowers@official', tmpDir);
      expect(result.success).toBe(true);
      const skills = await getEnabledSkills(tmpDir);
      expect(skills).not.toContain('superpowers:brainstorming');
      expect(skills).toContain('other:skill');
    });

    it('clears enabledSkills entirely when all entries belong to removed plugin', async () => {
      const config = {
        repositories: [], plugins: ['superpowers@official'], clients: ['claude'],
        enabledSkills: ['superpowers:brainstorming'],
      };
      await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));
      const result = await removePlugin('superpowers@official', tmpDir);
      expect(result.success).toBe(true);
      const skills = await getEnabledSkills(tmpDir);
      expect(skills).toEqual([]);
    });
  });
});

describe('setPluginSkillsMode', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'allagents-test-'));
    await mkdir(join(tmpDir, '.allagents'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('converts blocklist to allowlist with enabled skill names', async () => {
    const config = {
      repositories: [],
      plugins: [{ source: 'superpowers', skills: { exclude: ['brainstorming'] } }],
      clients: ['claude'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    const result = await setPluginSkillsMode('superpowers', 'allowlist', ['debugging', 'tdd'], tmpDir);
    expect(result.success).toBe(true);

    const enabled = await getEnabledSkills(tmpDir);
    expect(enabled).toContain('superpowers:debugging');
    expect(enabled).toContain('superpowers:tdd');
    expect(enabled).not.toContain('superpowers:brainstorming');

    const disabled = await getDisabledSkills(tmpDir);
    expect(disabled).toEqual([]);
  });

  it('converts allowlist to blocklist with disabled skill names', async () => {
    const config = {
      repositories: [],
      plugins: [{ source: 'superpowers', skills: ['debugging', 'tdd'] }],
      clients: ['claude'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    const result = await setPluginSkillsMode('superpowers', 'blocklist', ['brainstorming'], tmpDir);
    expect(result.success).toBe(true);

    const disabled = await getDisabledSkills(tmpDir);
    expect(disabled).toContain('superpowers:brainstorming');

    const enabled = await getEnabledSkills(tmpDir);
    expect(enabled).toEqual([]);
  });

  it('converts no-config to allowlist', async () => {
    const config = {
      repositories: [],
      plugins: ['superpowers'],
      clients: ['claude'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    const result = await setPluginSkillsMode('superpowers', 'allowlist', ['debugging'], tmpDir);
    expect(result.success).toBe(true);

    const enabled = await getEnabledSkills(tmpDir);
    expect(enabled).toContain('superpowers:debugging');
  });

  it('converts allowlist to blocklist with empty disabled list clears skills field', async () => {
    const config = {
      repositories: [],
      plugins: [{ source: 'superpowers', skills: ['debugging', 'tdd'] }],
      clients: ['claude'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    const result = await setPluginSkillsMode('superpowers', 'blocklist', [], tmpDir);
    expect(result.success).toBe(true);

    const disabled = await getDisabledSkills(tmpDir);
    expect(disabled).toEqual([]);
    const enabled = await getEnabledSkills(tmpDir);
    expect(enabled).toEqual([]);
  });

  it('preserves allowlist mode with empty skill list', async () => {
    const config = {
      repositories: [],
      plugins: [{ source: 'superpowers', skills: ['debugging'] }],
      clients: ['claude'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    const result = await setPluginSkillsMode('superpowers', 'allowlist', [], tmpDir);
    expect(result.success).toBe(true);

    const enabled = await getEnabledSkills(tmpDir);
    expect(enabled).toEqual([]);

    const addResult = await addEnabledSkill('superpowers:debugging', tmpDir);
    expect(addResult.success).toBe(true);
  });

  it('returns error for unknown plugin', async () => {
    const config = {
      repositories: [],
      plugins: ['superpowers'],
      clients: ['claude'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    const result = await setPluginSkillsMode('nonexistent', 'allowlist', ['skill'], tmpDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});
