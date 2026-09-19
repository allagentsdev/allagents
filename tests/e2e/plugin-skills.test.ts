import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump } from 'js-yaml';
import { readFile } from 'node:fs/promises';
import { load } from 'js-yaml';
import { syncWorkspace } from '../../src/core/sync.js';
import { getAllSkillsFromPlugins, findSkillByName } from '../../src/core/skills.js';
import {
  addDisabledSkill,
  removeDisabledSkill,
  setPluginSkillsMode,
  addEnabledSkill,
  upsertGitHubPluginSourceAllowlist,
} from '../../src/core/workspace-modify.js';
import { resetFetchCache } from '../../src/core/plugin.js';
import type { WorkspaceConfig } from '../../src/models/workspace-config.js';

describe('plugin skills e2e', () => {
  let tmpDir: string;
  let pluginDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'allagents-e2e-skills-'));
    pluginDir = join(tmpDir, 'test-plugin');

    // Create mock plugin with valid skills
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

    // Create workspace
    await mkdir(join(tmpDir, '.allagents'), { recursive: true });
    const config = {
      repositories: [],
      plugins: [pluginDir],
      clients: ['claude'],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('lists skills from installed plugins', async () => {
    const skills = await getAllSkillsFromPlugins(tmpDir);
    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.name)).toContain('skill-a');
    expect(skills.map((s) => s.name)).toContain('skill-b');
    expect(skills.every((s) => s.disabled === false)).toBe(true);
  });

  it('finds skill by name', async () => {
    const matches = await findSkillByName('skill-a', tmpDir);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe('skill-a');
    expect(matches[0]?.pluginName).toBe('test-plugin');
  });

  it('disables and enables a skill', async () => {
    // Initial sync
    await syncWorkspace(tmpDir);
    expect(existsSync(join(tmpDir, '.claude/skills/skill-a'))).toBe(true);
    expect(existsSync(join(tmpDir, '.claude/skills/skill-b'))).toBe(true);

    // Disable skill-a
    const disableResult = await addDisabledSkill('test-plugin:skill-a', tmpDir);
    expect(disableResult.success).toBe(true);

    // Sync again - skill-a should be removed
    await syncWorkspace(tmpDir);
    expect(existsSync(join(tmpDir, '.claude/skills/skill-a'))).toBe(false);
    expect(existsSync(join(tmpDir, '.claude/skills/skill-b'))).toBe(true);

    // Verify skill-a shows as disabled in listing
    const skillsAfterDisable = await getAllSkillsFromPlugins(tmpDir);
    const skillA = skillsAfterDisable.find((s) => s.name === 'skill-a');
    expect(skillA?.disabled).toBe(true);

    // Re-enable skill-a
    const enableResult = await removeDisabledSkill('test-plugin:skill-a', tmpDir);
    expect(enableResult.success).toBe(true);

    // Sync again - skill-a should be restored
    await syncWorkspace(tmpDir);
    expect(existsSync(join(tmpDir, '.claude/skills/skill-a'))).toBe(true);
    expect(existsSync(join(tmpDir, '.claude/skills/skill-b'))).toBe(true);

    // Verify skill-a shows as enabled in listing
    const skillsAfterEnable = await getAllSkillsFromPlugins(tmpDir);
    const skillAEnabled = skillsAfterEnable.find((s) => s.name === 'skill-a');
    expect(skillAEnabled?.disabled).toBe(false);
  });

  it('handles non-existent skill gracefully', async () => {
    const matches = await findSkillByName('non-existent-skill', tmpDir);
    expect(matches).toHaveLength(0);
  });

  it('allowlist mode enables only the listed skill', async () => {
    // Set plugin to allowlist mode with only skill-a
    const result = await setPluginSkillsMode('test-plugin', 'allowlist', ['skill-a'], tmpDir);
    expect(result.success).toBe(true);

    // Sync — only skill-a should be synced
    await syncWorkspace(tmpDir);
    expect(existsSync(join(tmpDir, '.claude/skills/skill-a'))).toBe(true);
    expect(existsSync(join(tmpDir, '.claude/skills/skill-b'))).toBe(false);

    // Verify skill listing reflects the allowlist
    const skills = await getAllSkillsFromPlugins(tmpDir);
    const skillA = skills.find((s) => s.name === 'skill-a');
    const skillB = skills.find((s) => s.name === 'skill-b');
    expect(skillA?.disabled).toBe(false);
    expect(skillB?.disabled).toBe(true);
    expect(skillA?.pluginSkillsMode).toBe('allowlist');
  });

  it('skill operations work when plugin source is a GitHub URL', async () => {
    // Simulate: workspace.yaml has a GitHub URL as plugin source
    // The cache directory name (owner-repo) differs from the URL-derived name (repo)
    const urlPluginDir = join(tmpDir, 'github-owner-repo');
    await mkdir(join(urlPluginDir, 'skills/my-skill'), { recursive: true });
    await writeFile(join(urlPluginDir, 'skills/my-skill/SKILL.md'), `---
name: my-skill
description: Test skill
---
# My Skill
`);

    // Write config with a plugin source that looks like a GitHub URL would resolve to
    const config: WorkspaceConfig = {
      repositories: [],
      plugins: [urlPluginDir],
      clients: ['claude'],
      version: 2,
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config));

    // The skill's pluginName will be 'github-owner-repo' (from directory basename)
    const skills = await getAllSkillsFromPlugins(tmpDir);
    const skill = skills.find((s) => s.name === 'my-skill');
    expect(skill).toBeDefined();
    expect(skill?.pluginName).toBe('github-owner-repo');

    // Disable using the cache-derived name should work
    const disableResult = await addDisabledSkill('github-owner-repo:my-skill', tmpDir);
    expect(disableResult.success).toBe(true);

    // Re-enable should also work
    const enableResult = await removeDisabledSkill('github-owner-repo:my-skill', tmpDir);
    expect(enableResult.success).toBe(true);
  });

  it('adding a second skill to an allowlisted plugin extends the allowlist', async () => {
    // Start with allowlist containing only skill-a
    await setPluginSkillsMode('test-plugin', 'allowlist', ['skill-a'], tmpDir);

    // Add skill-b to the allowlist
    const addResult = await addEnabledSkill('test-plugin:skill-b', tmpDir);
    expect(addResult.success).toBe(true);

    // Sync — both skills should now be synced
    await syncWorkspace(tmpDir);
    expect(existsSync(join(tmpDir, '.claude/skills/skill-a'))).toBe(true);
    expect(existsSync(join(tmpDir, '.claude/skills/skill-b'))).toBe(true);

    // Verify the config has both skills in the allowlist
    const content = await readFile(join(tmpDir, '.allagents/workspace.yaml'), 'utf-8');
    const config = load(content) as WorkspaceConfig;
    const pluginEntry = config.plugins.find((p) => typeof p !== 'string' && Array.isArray(p.skills));
    expect(pluginEntry).toBeDefined();
    if (typeof pluginEntry !== 'string' && pluginEntry) {
      expect(pluginEntry.skills).toEqual(['skill-a', 'skill-b']);
    }
  });

  it('promoted GitHub skill sources stay coherent for listing and sync', async () => {
    const originalTestHome = process.env.ALLAGENTS_TEST_HOME;
    const fakeHome = join(tmpDir, 'home');
    const cacheDir = join(
      fakeHome,
      '.allagents/plugins/marketplaces/NousResearch-hermes-agent@main/skills/research',
    );

    process.env.ALLAGENTS_TEST_HOME = fakeHome;
    resetFetchCache();

    try {
      await mkdir(join(cacheDir, 'llm-wiki'), { recursive: true });
      await mkdir(join(cacheDir, 'blogwatcher'), { recursive: true });
      await writeFile(join(cacheDir, 'llm-wiki/SKILL.md'), `---
name: llm-wiki
description: Wiki skill
---
# llm-wiki
`);
      await writeFile(join(cacheDir, 'blogwatcher/SKILL.md'), `---
name: blogwatcher
description: Blog watcher
---
# blogwatcher
`);

      const config: WorkspaceConfig = {
        repositories: [],
        plugins: [{
          source: 'https://github.com/NousResearch/hermes-agent/tree/main/skills/research/llm-wiki',
          skills: ['llm-wiki'],
        }],
        clients: ['claude'],
        version: 2,
      };
      await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config), 'utf-8');

      const updateResult = await upsertGitHubPluginSourceAllowlist(
        'https://github.com/NousResearch/hermes-agent/tree/main/skills/research/blogwatcher',
        ['llm-wiki', 'blogwatcher'],
        tmpDir,
      );
      expect(updateResult.success).toBe(true);

      const skills = await getAllSkillsFromPlugins(tmpDir);
      expect(skills.filter((skill) => !skill.disabled).map((skill) => skill.name).sort()).toEqual([
        'blogwatcher',
        'llm-wiki',
      ]);
      expect(skills.every((skill) => skill.pluginSource === 'https://github.com/NousResearch/hermes-agent/tree/main/skills/research')).toBe(true);

      await syncWorkspace(tmpDir);
      expect(existsSync(join(tmpDir, '.claude/skills/llm-wiki'))).toBe(true);
      expect(existsSync(join(tmpDir, '.claude/skills/blogwatcher'))).toBe(true);
    } finally {
      resetFetchCache();
      if (originalTestHome === undefined) {
        delete process.env.ALLAGENTS_TEST_HOME;
      } else {
        process.env.ALLAGENTS_TEST_HOME = originalTestHome;
      }
    }
  });

  it('honors skills-only Copilot marketplace entries without copying repository config', async () => {
    const originalTestHome = process.env.ALLAGENTS_TEST_HOME;
    const fakeHome = join(tmpDir, 'home');
    const marketplaceDir = join(tmpDir, 'ediprod-marketplace');

    process.env.ALLAGENTS_TEST_HOME = fakeHome;
    try {
      await mkdir(join(marketplaceDir, '.github', 'plugin'), {
        recursive: true,
      });
      await mkdir(join(marketplaceDir, '.github', 'hooks'), {
        recursive: true,
      });
      await mkdir(join(marketplaceDir, 'hooks'), { recursive: true });
      await mkdir(join(marketplaceDir, 'skills', 'ediprod'), {
        recursive: true,
      });
      await writeFile(
        join(marketplaceDir, '.github', 'plugin', 'marketplace.json'),
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
      await writeFile(
        join(marketplaceDir, 'skills', 'ediprod', 'SKILL.md'),
        '---\nname: ediprod\ndescription: ediProd\n---\n',
      );
      await writeFile(
        join(marketplaceDir, 'hooks', 'portable.json'),
        '{"hooks":{}}',
      );
      await writeFile(
        join(marketplaceDir, '.github', 'hooks', 'repository.json'),
        '{"hooks":{}}',
      );
      await writeFile(
        join(marketplaceDir, '.mcp.json'),
        JSON.stringify({
          mcpServers: {
            undeclared: {
              type: 'http',
              url: 'https://undeclared.test',
            },
          },
        }),
      );

      const config: WorkspaceConfig = {
        repositories: [],
        // Direct repository sources should honor their embedded marketplace
        // boundary instead of treating repository configuration as plugin data.
        plugins: [marketplaceDir],
        clients: ['copilot'],
        syncMode: 'copy',
        version: 2,
      };
      await writeFile(
        join(tmpDir, '.allagents/workspace.yaml'),
        dump(config),
        'utf-8',
      );

      const result = await syncWorkspace(tmpDir);

      expect(result.success).toBe(true);
      expect(
        existsSync(join(tmpDir, '.github', 'skills', 'ediprod', 'SKILL.md')),
      ).toBe(true);
      expect(existsSync(join(tmpDir, '.github', 'hooks'))).toBe(false);
      expect(existsSync(join(tmpDir, '.github', 'mcp.json'))).toBe(false);
    } finally {
      if (originalTestHome === undefined) {
        delete process.env.ALLAGENTS_TEST_HOME;
      } else {
        process.env.ALLAGENTS_TEST_HOME = originalTestHome;
      }
    }
  });
});
