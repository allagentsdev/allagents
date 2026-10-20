import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as dump } from 'yaml';
import { stubHomeDir } from '../../helpers/env.js';

describe('user-scope disabledSkills helpers', () => {
  let tmpDir: string;
  let restoreHomeDir: () => void;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'allagents-user-test-'));
    restoreHomeDir = stubHomeDir(tmpDir);
    await mkdir(join(tmpDir, '.allagents'), { recursive: true });
  });

  afterEach(async () => {
    restoreHomeDir();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('adds and removes disabled skills in user config', async () => {
    const config = { repositories: [], plugins: ['superpowers'], clients: ['copilot'] };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    // Import after setting HOME
    const { addUserDisabledSkill, removeUserDisabledSkill, getUserDisabledSkills } = await import('../../../src/core/user-workspace.js');

    const addResult = await addUserDisabledSkill('superpowers:brainstorming');
    expect(addResult.success).toBe(true);

    let skills = await getUserDisabledSkills();
    expect(skills).toContain('superpowers:brainstorming');

    const removeResult = await removeUserDisabledSkill('superpowers:brainstorming');
    expect(removeResult.success).toBe(true);

    skills = await getUserDisabledSkills();
    expect(skills).not.toContain('superpowers:brainstorming');
  });

  it('adds and removes enabled skills in user config', async () => {
    const config = { repositories: [], plugins: ['superpowers'], clients: ['copilot'] };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    // Import after setting HOME
    const { addUserEnabledSkill, removeUserEnabledSkill, getUserEnabledSkills } = await import('../../../src/core/user-workspace.js');

    const addResult = await addUserEnabledSkill('superpowers:brainstorming');
    expect(addResult.success).toBe(true);

    let skills = await getUserEnabledSkills();
    expect(skills).toContain('superpowers:brainstorming');

    const removeResult = await removeUserEnabledSkill('superpowers:brainstorming');
    expect(removeResult.success).toBe(true);

    skills = await getUserEnabledSkills();
    expect(skills).not.toContain('superpowers:brainstorming');
  });
});

describe('setUserPluginSkillsMode', () => {
  let tmpDir: string;
  let restoreHomeDir: () => void;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'allagents-user-test-'));
    restoreHomeDir = stubHomeDir(tmpDir);
    await mkdir(join(tmpDir, '.allagents'), { recursive: true });
  });

  afterEach(async () => {
    restoreHomeDir();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('converts blocklist to allowlist with enabled skill names', async () => {
    const config = {
      repositories: [],
      plugins: [{ source: 'superpowers', skills: { exclude: ['brainstorming'] } }],
      clients: ['copilot'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    const { setUserPluginSkillsMode, getUserEnabledSkills, getUserDisabledSkills } = await import('../../../src/core/user-workspace.js');

    const result = await setUserPluginSkillsMode('superpowers', 'allowlist', ['debugging', 'tdd']);
    expect(result.success).toBe(true);

    const enabled = await getUserEnabledSkills();
    expect(enabled).toContain('superpowers:debugging');
    expect(enabled).toContain('superpowers:tdd');

    const disabled = await getUserDisabledSkills();
    expect(disabled).toEqual([]);
  });

  it('converts allowlist to blocklist with disabled skill names', async () => {
    const config = {
      repositories: [],
      plugins: [{ source: 'superpowers', skills: ['debugging', 'tdd'] }],
      clients: ['copilot'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    const { setUserPluginSkillsMode, getUserDisabledSkills } = await import('../../../src/core/user-workspace.js');

    const result = await setUserPluginSkillsMode('superpowers', 'blocklist', ['brainstorming']);
    expect(result.success).toBe(true);

    const disabled = await getUserDisabledSkills();
    expect(disabled).toContain('superpowers:brainstorming');
  });

  it('converts allowlist to blocklist with empty list clears skills field', async () => {
    const config = {
      repositories: [],
      plugins: [{ source: 'superpowers', skills: ['debugging'] }],
      clients: ['copilot'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    const { setUserPluginSkillsMode, getUserDisabledSkills, getUserEnabledSkills } = await import('../../../src/core/user-workspace.js');

    const result = await setUserPluginSkillsMode('superpowers', 'blocklist', []);
    expect(result.success).toBe(true);

    const disabled = await getUserDisabledSkills();
    expect(disabled).toEqual([]);
    const enabled = await getUserEnabledSkills();
    expect(enabled).toEqual([]);
  });

  it('returns error for unknown plugin', async () => {
    const config = {
      repositories: [],
      plugins: ['superpowers'],
      clients: ['copilot'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    const { setUserPluginSkillsMode } = await import('../../../src/core/user-workspace.js');

    const result = await setUserPluginSkillsMode('nonexistent', 'allowlist', ['skill']);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});
