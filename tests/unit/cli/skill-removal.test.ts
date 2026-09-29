import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, load } from 'js-yaml';
import { removeInstalledSkill } from '../../../src/cli/skill-removal.js';
import type { WorkspaceConfig } from '../../../src/models/workspace-config.js';
import {
  getAllSkillsFromPlugins,
  type SkillInfo,
} from '../../../src/core/skills.js';
import { resetFetchCache } from '../../../src/core/plugin.js';
import { stubHomeDir } from '../../helpers/env.js';

describe('removeInstalledSkill', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'allagents-skill-removal-'));
    await mkdir(join(tmpDir, '.allagents'), { recursive: true });
  });

  afterEach(async () => {
    resetFetchCache();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('removes the plugin when removing its only installed skill', async () => {
    const pluginDir = join(tmpDir, 'solo-plugin');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, 'SKILL.md'),
      '---\nname: solo-skill\ndescription: Solo skill\n---\n# Solo skill\n',
    );

    const config: WorkspaceConfig = {
      version: 2,
      repositories: [],
      clients: ['copilot'],
      plugins: [{ source: pluginDir, skills: ['solo-skill'] }],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config), 'utf-8');

    const result = await removeInstalledSkill({
      targetSkill: {
        name: 'solo-skill',
        pluginName: 'solo-plugin',
        pluginSource: pluginDir,
        pluginSkillsMode: 'allowlist',
      },
      isUser: false,
      workspacePath: tmpDir,
    });

    expect(result).toEqual({ success: true, action: 'removed-plugin' });

    const content = await readFile(join(tmpDir, '.allagents/workspace.yaml'), 'utf-8');
    const updated = load(content) as WorkspaceConfig;
    expect(updated.plugins).toEqual([]);
  });

  it('does not remove a native plugin when asked to remove its only skill', async () => {
    const pluginDir = join(tmpDir, 'native-plugin');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, 'SKILL.md'),
      '---\nname: native-skill\ndescription: Native\n---\n',
    );
    const config: WorkspaceConfig = {
      version: 2,
      repositories: [],
      clients: [{ name: 'claude', install: 'native' }],
      plugins: [{ source: pluginDir }],
    };
    const path = join(tmpDir, '.allagents/workspace.yaml');
    const original = dump(config);
    await writeFile(path, original);

    const [targetSkill] = await getAllSkillsFromPlugins(tmpDir);
    expect(targetSkill).toBeDefined();
    const result = await removeInstalledSkill({
      targetSkill: targetSkill!,
      isUser: false,
      workspacePath: tmpDir,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Native plugins install all skills together');
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it('removes only the selected skill when the plugin exposes multiple skills', async () => {
    const pluginDir = join(tmpDir, 'multi-plugin');
    await mkdir(join(pluginDir, 'skills/skill-a'), { recursive: true });
    await mkdir(join(pluginDir, 'skills/skill-b'), { recursive: true });
    await writeFile(
      join(pluginDir, 'skills/skill-a/SKILL.md'),
      '---\nname: skill-a\ndescription: Skill A\n---\n# Skill A\n',
    );
    await writeFile(
      join(pluginDir, 'skills/skill-b/SKILL.md'),
      '---\nname: skill-b\ndescription: Skill B\n---\n# Skill B\n',
    );

    const config: WorkspaceConfig = {
      version: 2,
      repositories: [],
      clients: ['copilot'],
      plugins: [{ source: pluginDir, skills: ['skill-a', 'skill-b'] }],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config), 'utf-8');

    const allSkills: SkillInfo[] = [
      {
        name: 'skill-a',
        pluginName: 'multi-plugin',
        pluginSource: pluginDir,
        path: join(pluginDir, 'skills/skill-a'),
        disabled: false,
        pluginSkillsMode: 'allowlist',
      },
      {
        name: 'skill-b',
        pluginName: 'multi-plugin',
        pluginSource: pluginDir,
        path: join(pluginDir, 'skills/skill-b'),
        disabled: false,
        pluginSkillsMode: 'allowlist',
      },
    ];

    const result = await removeInstalledSkill({
      targetSkill: allSkills[0]!,
      isUser: false,
      workspacePath: tmpDir,
      allSkills,
    });

    expect(result).toEqual({ success: true, action: 'removed-skill' });

    const content = await readFile(join(tmpDir, '.allagents/workspace.yaml'), 'utf-8');
    const updated = load(content) as WorkspaceConfig;
    expect(updated.plugins).toEqual([{ source: pluginDir, skills: ['skill-b'] }]);
  });

  it('removes the plugin when removing the last enabled skill from a multi-skill plugin', async () => {
    const pluginDir = join(tmpDir, 'mixed-plugin');
    await mkdir(join(pluginDir, 'skills/skill-a'), { recursive: true });
    await mkdir(join(pluginDir, 'skills/skill-b'), { recursive: true });
    await writeFile(
      join(pluginDir, 'skills/skill-a/SKILL.md'),
      '---\nname: skill-a\ndescription: Skill A\n---\n# Skill A\n',
    );
    await writeFile(
      join(pluginDir, 'skills/skill-b/SKILL.md'),
      '---\nname: skill-b\ndescription: Skill B\n---\n# Skill B\n',
    );

    const config: WorkspaceConfig = {
      version: 2,
      repositories: [],
      clients: ['copilot'],
      plugins: [{ source: pluginDir, skills: ['skill-a'] }],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config), 'utf-8');

    const allSkills: SkillInfo[] = [
      {
        name: 'skill-a',
        pluginName: 'mixed-plugin',
        pluginSource: pluginDir,
        path: join(pluginDir, 'skills/skill-a'),
        disabled: false,
        pluginSkillsMode: 'allowlist',
      },
      {
        name: 'skill-b',
        pluginName: 'mixed-plugin',
        pluginSource: pluginDir,
        path: join(pluginDir, 'skills/skill-b'),
        disabled: true,
        pluginSkillsMode: 'allowlist',
      },
    ];

    const result = await removeInstalledSkill({
      targetSkill: allSkills[0]!,
      isUser: false,
      workspacePath: tmpDir,
      allSkills,
    });

    expect(result).toEqual({ success: true, action: 'removed-plugin' });

    const content = await readFile(join(tmpDir, '.allagents/workspace.yaml'), 'utf-8');
    const updated = load(content) as WorkspaceConfig;
    expect(updated.plugins).toEqual([]);
  });

  it('removes a single-skill GitHub source instead of leaving an empty allowlist', async () => {
    const fakeHome = join(tmpDir, 'home');
    const restoreHomeDir = stubHomeDir(fakeHome);
    const pluginDir = join(
      fakeHome,
      '.allagents/plugins/marketplaces/NousResearch-hermes-agent@main/skills/research/llm-wiki',
    );
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, 'SKILL.md'),
      '---\nname: llm-wiki\ndescription: Wiki skill\n---\n# llm-wiki\n',
    );

    const source = 'https://github.com/NousResearch/hermes-agent/tree/main/skills/research/llm-wiki';
    const config: WorkspaceConfig = {
      version: 2,
      repositories: [],
      clients: ['copilot'],
      plugins: [{ source, skills: ['llm-wiki'] }],
    };
    await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config), 'utf-8');

    resetFetchCache();

    try {
      const discoveredSkills = await getAllSkillsFromPlugins(tmpDir);
      expect(
        discoveredSkills.map(({ name, pluginSource, path }) => ({ name, pluginSource, path })),
      ).toEqual([
        { name: 'llm-wiki', pluginSource: source, path: pluginDir },
      ]);

      const result = await removeInstalledSkill({
        targetSkill: {
          name: 'llm-wiki',
          pluginName: 'llm-wiki',
          pluginSource: source,
          pluginSkillsMode: 'allowlist',
        },
        isUser: false,
        workspacePath: tmpDir,
      });

      expect(result).toEqual({ success: true, action: 'removed-plugin' });

      const content = await readFile(join(tmpDir, '.allagents/workspace.yaml'), 'utf-8');
      const updated = load(content) as WorkspaceConfig;
      expect(updated.plugins).toEqual([]);
    } finally {
      restoreHomeDir();
      resetFetchCache();
    }
  });
});
