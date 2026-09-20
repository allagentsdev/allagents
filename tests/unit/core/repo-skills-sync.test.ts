import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateAgentFiles } from '../../../src/core/workspace-repo.js';
import { discoverWorkspaceSkills, writeSkillsIndex, cleanupSkillsIndex, groupSkillsByRepo } from '../../../src/core/repo-skills.js';
import { generateWorkspaceRules } from '../../../src/constants.js';
import type { WorkspaceSkillEntry } from '../../../src/core/repo-skills.js';

function makeSkill(dir: string, name: string, description: string) {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
  );
}

describe('updateAgentFiles with skills', () => {
  let workspaceDir: string;
  let repoDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'skills-sync-test-'));
    repoDir = join(workspaceDir, 'my-repo');
    mkdirSync(join(workspaceDir, '.allagents'), { recursive: true });
    mkdirSync(repoDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('writes skills-index file and links from AGENTS.md', async () => {
    makeSkill(join(repoDir, '.claude', 'skills'), 'test-skill', 'A test skill');

    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      'repositories:\n  - path: ./my-repo\n    skills: true\nplugins: []\nclients:\n  - claude\n',
    );

    await updateAgentFiles(workspaceDir);

    // Skills-index file should exist
    const indexContent = readFileSync(join(workspaceDir, '.allagents', 'skills-index', 'my-repo.md'), 'utf-8');
    expect(indexContent).toContain('<available_skills>');
    expect(indexContent).toContain('<name>test-skill</name>');

    // AGENTS.md should have conditional link, not inline skills
    const agentsContent = readFileSync(join(workspaceDir, 'AGENTS.md'), 'utf-8');
    expect(agentsContent).toContain('## Repository Skills');
    expect(agentsContent).toContain('.allagents/skills-index/my-repo.md');
    expect(agentsContent).not.toContain('<available_skills>');
  });

  it('canonicalizes client aliases before skill discovery and rule injection', async () => {
    makeSkill(join(repoDir, '.claude', 'skills'), 'aliased-skill', 'Alias proof');
    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      'repositories:\n  - path: ./my-repo\n    skills: true\nplugins: []\nclients:\n  - claude-code\n',
    );

    await updateAgentFiles(workspaceDir);

    const indexContent = readFileSync(
      join(workspaceDir, '.allagents', 'skills-index', 'my-repo.md'),
      'utf-8',
    );
    expect(indexContent).toContain('<name>aliased-skill</name>');
    expect(readFileSync(join(workspaceDir, 'CLAUDE.md'), 'utf-8')).toContain(
      '.allagents/skills-index/my-repo.md',
    );
  });

  it('uses custom skill paths from workspace.yaml', async () => {
    makeSkill(join(repoDir, 'plugins', 'my-plugin', 'skills'), 'custom', 'Custom skill');

    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      'repositories:\n  - path: ./my-repo\n    skills:\n      - plugins/my-plugin/skills\nplugins: []\nclients:\n  - claude\n',
    );

    await updateAgentFiles(workspaceDir);

    const indexContent = readFileSync(join(workspaceDir, '.allagents', 'skills-index', 'my-repo.md'), 'utf-8');
    expect(indexContent).toContain('<name>custom</name>');
    expect(indexContent).toContain('./my-repo/plugins/my-plugin/skills/custom/SKILL.md');
  });

  it('skips repos with skills: false', async () => {
    makeSkill(join(repoDir, '.claude', 'skills'), 'hidden', 'Should not appear');

    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      'repositories:\n  - path: ./my-repo\n    skills: false\nplugins: []\nclients:\n  - claude\n',
    );

    await updateAgentFiles(workspaceDir);

    const agentsContent = readFileSync(join(workspaceDir, 'AGENTS.md'), 'utf-8');
    expect(agentsContent).not.toContain('## Repository Skills');
    expect(existsSync(join(workspaceDir, '.allagents', 'skills-index'))).toBe(false);
  });

  it('omits skills block when repos have no skills', async () => {
    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      'repositories:\n  - path: ./my-repo\nplugins: []\nclients:\n  - claude\n',
    );

    await updateAgentFiles(workspaceDir);

    const agentsContent = readFileSync(join(workspaceDir, 'AGENTS.md'), 'utf-8');
    expect(agentsContent).not.toContain('## Repository Skills');
  });

  it('includes skills from multiple repos', async () => {
    const repoDir2 = join(workspaceDir, 'repo2');
    mkdirSync(repoDir2, { recursive: true });

    makeSkill(join(repoDir, '.claude', 'skills'), 'skill-a', 'First skill');
    makeSkill(join(repoDir2, '.claude', 'skills'), 'skill-b', 'Second skill');

    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      'repositories:\n  - path: ./my-repo\n    skills: true\n  - path: ./repo2\n    skills: true\nplugins: []\nclients:\n  - claude\n',
    );

    await updateAgentFiles(workspaceDir);

    // Both index files should exist
    expect(existsSync(join(workspaceDir, '.allagents', 'skills-index', 'my-repo.md'))).toBe(true);
    expect(existsSync(join(workspaceDir, '.allagents', 'skills-index', 'repo2.md'))).toBe(true);

    // AGENTS.md should link to both
    const agentsContent = readFileSync(join(workspaceDir, 'AGENTS.md'), 'utf-8');
    expect(agentsContent).toContain('.allagents/skills-index/my-repo.md');
    expect(agentsContent).toContain('.allagents/skills-index/repo2.md');
    expect(agentsContent).not.toContain('<available_skills>');
  });

  it('renders section heading as Repository Skills', async () => {
    makeSkill(join(repoDir, '.claude', 'skills'), 'test-skill', 'A test skill');

    writeFileSync(
      join(workspaceDir, '.allagents', 'workspace.yaml'),
      'repositories:\n  - path: ./my-repo\n    skills: true\nplugins: []\nclients:\n  - claude\n',
    );

    await updateAgentFiles(workspaceDir);

    const agentsContent = readFileSync(join(workspaceDir, 'AGENTS.md'), 'utf-8');
    expect(agentsContent).toContain('## Repository Skills');
    expect(agentsContent).not.toContain('## Workspace Skills');
  });
});

describe('discoverWorkspaceSkills deduplication', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'skills-dedup-test-'));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('deduplicates same-name skills, preferring .agents path', async () => {
    const repo1 = join(workspaceDir, 'repo1');
    const repo2 = join(workspaceDir, 'repo2');

    // repo1 has the skill under .claude/skills
    makeSkill(join(repo1, '.claude', 'skills'), 'my-skill', 'From claude');
    // repo2 has the skill under .agents/skills
    makeSkill(join(repo2, '.agents', 'skills'), 'my-skill', 'From agents');

    const results = await discoverWorkspaceSkills(
      workspaceDir,
      [{ path: './repo1', skills: true }, { path: './repo2', skills: true }],
      ['claude', 'universal'],
    );

    expect(results).toHaveLength(1);
    expect(results[0].location).toContain('.agents/skills/my-skill');
  });

  it('deduplicates same-name skills, preferring larger file when no .agents', async () => {
    const repo1 = join(workspaceDir, 'repo1');
    const repo2 = join(workspaceDir, 'repo2');

    // repo1 has a small skill
    makeSkill(join(repo1, '.claude', 'skills'), 'my-skill', 'Small');
    // repo2 has a larger skill (more content)
    const largeSkillDir = join(repo2, '.claude', 'skills', 'my-skill');
    mkdirSync(largeSkillDir, { recursive: true });
    writeFileSync(
      join(largeSkillDir, 'SKILL.md'),
      `---\nname: my-skill\ndescription: Large\n---\n\n${'x'.repeat(500)}\n`,
    );

    const results = await discoverWorkspaceSkills(
      workspaceDir,
      [{ path: './repo1', skills: true }, { path: './repo2', skills: true }],
      ['claude'],
    );

    expect(results).toHaveLength(1);
    expect(results[0].description).toBe('Large');
    expect(results[0].location).toContain('./repo2/');
  });

  it('keeps distinct skills from different repos', async () => {
    const repo1 = join(workspaceDir, 'repo1');
    const repo2 = join(workspaceDir, 'repo2');

    makeSkill(join(repo1, '.claude', 'skills'), 'skill-a', 'First');
    makeSkill(join(repo2, '.claude', 'skills'), 'skill-b', 'Second');

    const results = await discoverWorkspaceSkills(
      workspaceDir,
      [{ path: './repo1', skills: true }, { path: './repo2', skills: true }],
      ['claude'],
    );

    expect(results).toHaveLength(2);
    const names = results.map((r) => r.name).sort();
    expect(names).toEqual(['skill-a', 'skill-b']);
  });
});

describe('writeSkillsIndex', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'skills-index-test-'));
    mkdirSync(join(workspaceDir, '.allagents'), { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('writes per-repo skills index files', () => {
    const skillsByRepo = new Map<string, { repoName: string; skills: WorkspaceSkillEntry[] }>();
    skillsByRepo.set('./my-repo', {
      repoName: 'my-repo',
      skills: [
        { repoPath: './my-repo', name: 'test-skill', description: 'A test skill', location: './my-repo/.claude/skills/test-skill/SKILL.md' },
      ],
    });

    const result = writeSkillsIndex(workspaceDir, skillsByRepo);

    expect(result.writtenFiles).toEqual(['skills-index/my-repo.md']);
    expect(result.refs).toEqual([{ repoName: 'my-repo', indexPath: '.allagents/skills-index/my-repo.md' }]);
    const content = readFileSync(join(workspaceDir, '.allagents', 'skills-index', 'my-repo.md'), 'utf-8');
    expect(content).toContain('<available_skills>');
    expect(content).toContain('<name>test-skill</name>');
    expect(content).toContain('./my-repo/.claude/skills/test-skill/SKILL.md');
  });

  it('returns empty result when no skills', () => {
    const result = writeSkillsIndex(workspaceDir, new Map());
    expect(result).toEqual({ writtenFiles: [], refs: [] });
  });
});

describe('cleanupSkillsIndex', () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'skills-cleanup-test-'));
    mkdirSync(join(workspaceDir, '.allagents', 'skills-index'), { recursive: true });
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it('removes stale index files not in current set', () => {
    writeFileSync(join(workspaceDir, '.allagents', 'skills-index', 'old-repo.md'), 'stale');
    writeFileSync(join(workspaceDir, '.allagents', 'skills-index', 'current-repo.md'), 'fresh');

    cleanupSkillsIndex(workspaceDir, ['skills-index/current-repo.md']);

    expect(existsSync(join(workspaceDir, '.allagents', 'skills-index', 'old-repo.md'))).toBe(false);
    expect(existsSync(join(workspaceDir, '.allagents', 'skills-index', 'current-repo.md'))).toBe(true);
  });

  it('removes skills-index directory when empty', () => {
    writeFileSync(join(workspaceDir, '.allagents', 'skills-index', 'old.md'), 'stale');

    cleanupSkillsIndex(workspaceDir, []);

    expect(existsSync(join(workspaceDir, '.allagents', 'skills-index'))).toBe(false);
  });
});

describe('groupSkillsByRepo', () => {
  it('groups skills by repo path using repository name', () => {
    const skills: WorkspaceSkillEntry[] = [
      { repoPath: './repo-a', name: 'skill-1', description: 'First', location: './repo-a/.claude/skills/skill-1/SKILL.md' },
      { repoPath: './repo-a', name: 'skill-2', description: 'Second', location: './repo-a/.claude/skills/skill-2/SKILL.md' },
      { repoPath: './repo-b', name: 'skill-3', description: 'Third', location: './repo-b/.claude/skills/skill-3/SKILL.md' },
    ];

    const repositories = [
      { path: './repo-a', name: 'my-frontend' },
      { path: './repo-b', name: 'my-backend' },
    ];

    const grouped = groupSkillsByRepo(skills, repositories);

    expect(grouped.size).toBe(2);
    expect(grouped.get('./repo-a')?.repoName).toBe('my-frontend');
    expect(grouped.get('./repo-a')?.skills).toHaveLength(2);
    expect(grouped.get('./repo-b')?.repoName).toBe('my-backend');
    expect(grouped.get('./repo-b')?.skills).toHaveLength(1);
  });

  it('falls back to basename when repository has no name', () => {
    const skills: WorkspaceSkillEntry[] = [
      { repoPath: './some/deep/repo-path', name: 'skill-1', description: 'First', location: './some/deep/repo-path/.claude/skills/skill-1/SKILL.md' },
    ];

    const repositories = [{ path: './some/deep/repo-path' }];

    const grouped = groupSkillsByRepo(skills, repositories);

    expect(grouped.get('./some/deep/repo-path')?.repoName).toBe('repo-path');
  });

  it('returns empty map when skills array is empty', () => {
    const grouped = groupSkillsByRepo([], []);
    expect(grouped.size).toBe(0);
  });
});

describe('generateWorkspaceRules with skills-index links', () => {
  it('emits conditional links instead of inline skills', () => {
    const skillsIndexRefs = [
      { repoName: 'my-repo', indexPath: '.allagents/skills-index/my-repo.md' },
    ];
    const result = generateWorkspaceRules(
      [{ path: './my-repo' }],
      skillsIndexRefs,
    );

    expect(result).toContain('## Repository Skills');
    expect(result).toContain('my-repo');
    expect(result).toContain('.allagents/skills-index/my-repo.md');
    expect(result).not.toContain('<available_skills>');
  });

  it('omits skills section when no index refs', () => {
    const result = generateWorkspaceRules([{ path: './my-repo' }], []);
    expect(result).not.toContain('## Repository Skills');
  });
});
