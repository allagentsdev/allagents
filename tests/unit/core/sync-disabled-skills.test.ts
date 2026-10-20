import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as dump } from 'yaml';
import { syncWorkspace } from '../../../src/core/sync.js';

describe('sync with disabled skills', () => {
  let tmpDir: string;
  let pluginDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'allagents-sync-skills-test-'));
    pluginDir = join(tmpDir, 'test-plugin');

    // Create a mock plugin with skills
    await mkdir(join(pluginDir, 'skills/skill-a'), { recursive: true });
    await mkdir(join(pluginDir, 'skills/skill-b'), { recursive: true });
    await writeFile(join(pluginDir, 'skills/skill-a/SKILL.md'), `---
name: skill-a
description: Test skill A
---
# Skill A
`);
    await writeFile(join(pluginDir, 'skills/skill-b/SKILL.md'), `---
name: skill-b
description: Test skill B
---
# Skill B
`);

    await mkdir(join(tmpDir, '.allagents'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('excludes disabled skills from sync', async () => {
    const config = {
      repositories: [],
      plugins: [pluginDir],
      clients: ['claude'],
      disabledSkills: ['test-plugin:skill-a'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    await syncWorkspace(tmpDir);

    // skill-a should NOT be synced (disabled)
    expect(existsSync(join(tmpDir, '.claude/skills/skill-a'))).toBe(false);
    // skill-b should be synced
    expect(existsSync(join(tmpDir, '.claude/skills/skill-b'))).toBe(true);
  });

  it('syncs all skills when none disabled', async () => {
    const config = {
      repositories: [],
      plugins: [pluginDir],
      clients: ['claude'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    await syncWorkspace(tmpDir);

    expect(existsSync(join(tmpDir, '.claude/skills/skill-a'))).toBe(true);
    expect(existsSync(join(tmpDir, '.claude/skills/skill-b'))).toBe(true);
  });

  it('syncs only enabled skills in allowlist mode', async () => {
    const config = {
      repositories: [],
      plugins: [pluginDir],
      clients: ['claude'],
      enabledSkills: ['test-plugin:skill-b'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    await syncWorkspace(tmpDir);

    // skill-a is NOT in enabledSkills -> should NOT be synced
    expect(existsSync(join(tmpDir, '.claude/skills/skill-a'))).toBe(false);
    // skill-b IS in enabledSkills -> should be synced
    expect(existsSync(join(tmpDir, '.claude/skills/skill-b'))).toBe(true);
  });

  it('enabledSkills for one plugin does not affect other plugins', async () => {
    // Create a second plugin with its own skills
    const pluginDir2 = join(tmpDir, 'other-plugin');
    await mkdir(join(pluginDir2, 'skills/skill-x'), { recursive: true });
    await mkdir(join(pluginDir2, 'skills/skill-y'), { recursive: true });
    await writeFile(join(pluginDir2, 'skills/skill-x/SKILL.md'), `---
name: skill-x
description: Test skill X
---
# Skill X
`);
    await writeFile(join(pluginDir2, 'skills/skill-y/SKILL.md'), `---
name: skill-y
description: Test skill Y
---
# Skill Y
`);

    const config = {
      repositories: [],
      plugins: [pluginDir, pluginDir2],
      clients: ['claude'],
      // Only test-plugin uses allowlist; other-plugin should sync all skills
      enabledSkills: ['test-plugin:skill-b'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    await syncWorkspace(tmpDir);

    // test-plugin: only skill-b synced (allowlist)
    expect(existsSync(join(tmpDir, '.claude/skills/skill-a'))).toBe(false);
    expect(existsSync(join(tmpDir, '.claude/skills/skill-b'))).toBe(true);
    // other-plugin: all skills synced (no enabledSkills entries for this plugin)
    expect(existsSync(join(tmpDir, '.claude/skills/skill-x'))).toBe(true);
    expect(existsSync(join(tmpDir, '.claude/skills/skill-y'))).toBe(true);
  });
});
