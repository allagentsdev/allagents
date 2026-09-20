import { describe, expect, it } from 'bun:test';
import {
  AGENT_HOSTS,
  CLIENT_ALIASES,
  CLIENT_MAPPINGS,
  CLIENT_TYPES,
  USER_CLIENT_MAPPINGS,
  canonicalizeClientId,
  clientIdsForScope,
  findHostById,
  getDisplayName,
  getMapping,
  mcpClientIdsForScope,
  resolveClientMappings,
  uniqueProjectSkillsPaths,
} from '../../../src/models/client-mapping.js';
import { ClientTypeSchema } from '../../../src/models/workspace-config.js';

const SKILLS_1_7_DESTINATION_IDS = [
  'aider-desk',
  'amp',
  'antigravity',
  'antigravity-cli',
  'astrbot',
  'autohand-code',
  'augment',
  'bob',
  'claude-code',
  'openclaw',
  'cline',
  'codearts-agent',
  'codebuddy',
  'codemaker',
  'codestudio',
  'codex',
  'command-code',
  'continue',
  'cortex',
  'crush',
  'cursor',
  'deepagents',
  'devin',
  'dexto',
  'droid',
  'eve',
  'firebender',
  'forgecode',
  'fx',
  'gemini-cli',
  'github-copilot',
  'goose',
  'grok',
  'hermes-agent',
  'inference-sh',
  'iflow-cli',
  'jazz',
  'junie',
  'kilo',
  'kimchi',
  'kimi-code-cli',
  'kiro-cli',
  'kode',
  'lingma',
  'loaf',
  'mcpjam',
  'minimax-code',
  'mistral-vibe',
  'moxby',
  'mux',
  'neovate',
  'opencode',
  'openhands',
  'ona',
  'pi',
  'posit-assistant',
  'qoder',
  'qoder-cn',
  'qwen-code',
  'replit',
  'reasonix',
  'roo',
  'rovodev',
  'sarvam-code',
  'tabnine-cli',
  'terramind',
  'tinycloud',
  'trae',
  'trae-cn',
  'warp',
  'windsurf',
  'zed',
  'zcode',
  'zencoder',
  'zenflow',
  'pochi',
  'promptscript',
  'adal',
  'universal',
] as const;

describe('canonical client registry', () => {
  it('defines every canonical identity exactly once and derives the input schema', () => {
    const hostIds = AGENT_HOSTS.map((host) => host.id);
    expect(new Set(hostIds).size).toBe(AGENT_HOSTS.length);
    expect(hostIds).toEqual(CLIENT_TYPES);
    expect(CLIENT_TYPES).toHaveLength(81);

    for (const client of CLIENT_TYPES) {
      expect(ClientTypeSchema.parse(client)).toBe(client);
      expect(CLIENT_MAPPINGS[client]).toBe(AGENT_HOSTS.find((host) => host.id === client)?.project);
    }
  });

  it('accepts all 79 skills@1.7.0 IDs directly or through one of seven aliases', () => {
    expect(SKILLS_1_7_DESTINATION_IDS).toHaveLength(79);
    expect(CLIENT_ALIASES).toEqual({
      'claude-code': 'claude',
      'github-copilot': 'copilot',
      'gemini-cli': 'gemini',
      droid: 'factory',
      amp: 'ampcode',
      'kiro-cli': 'kiro',
      'kimi-code-cli': 'kimi',
    });

    for (const id of SKILLS_1_7_DESTINATION_IDS) {
      const canonical = canonicalizeClientId(id);
      expect(canonical).toBeDefined();
      expect(CLIENT_TYPES).toContain(canonical);
      expect(ClientTypeSchema.parse(id)).toBe(canonical);
    }
  });

  it('keeps aliases out of canonical product counts and resolves host lookups', () => {
    for (const [alias, canonical] of Object.entries(CLIENT_ALIASES)) {
      expect(CLIENT_TYPES).not.toContain(alias);
      expect(findHostById(alias)?.id).toBe(canonical);
    }
    expect(findHostById('not-a-client')).toBeUndefined();
  });
});

describe('capability-aware mappings', () => {
  it('preserves Claude Code rich destinations and runtime capabilities', () => {
    const claude = findHostById('claude');
    expect(claude?.project).toEqual({
      commandsPath: '.claude/commands/',
      skillsPath: '.claude/skills/',
      agentsPath: '.claude/agents/',
      agentFile: 'CLAUDE.md',
      agentFileFallback: 'AGENTS.md',
      hooksPath: '.claude/hooks/',
    });
    expect(claude?.user).toEqual(claude?.project);
    expect(claude?.mcp).toEqual({ project: true, user: true });
  });

  it('preserves every pre-existing AllAgents name and skill destination', () => {
    const expected = [
      ['claude', 'Claude Code', '.claude/skills/', '.claude/skills/'],
      ['copilot', 'GitHub Copilot', '.github/skills/', '.copilot/skills/'],
      ['codex', 'Codex', '.codex/skills/', '.codex/skills/'],
      ['pi', 'Pi', '.pi/skills/', '.pi/agent/skills/'],
      ['omp', 'OMP', '.omp/skills/', '.omp/agent/skills/'],
      ['cursor', 'Cursor', '.cursor/skills/', '.cursor/skills/'],
      ['opencode', 'OpenCode', '.opencode/skills/', '.opencode/skills/'],
      ['gemini', 'Gemini', '.gemini/skills/', '.gemini/skills/'],
      ['factory', 'Factory', '.factory/skills/', '.factory/skills/'],
      ['ampcode', 'AmpCode', '.ampcode/skills/', '.ampcode/skills/'],
      ['vscode', 'VS Code', '.agents/skills/', '.agents/skills/'],
      ['openclaw', 'OpenClaw', 'skills/', 'skills/'],
      ['windsurf', 'Windsurf', '.windsurf/skills/', '.codeium/windsurf/skills/'],
      ['cline', 'Cline', '.cline/skills/', '.cline/skills/'],
      ['continue', 'Continue', '.continue/skills/', '.continue/skills/'],
      ['roo', 'Roo Code', '.roo/skills/', '.roo/skills/'],
      ['kilo', 'Kilo Code', '.kilocode/skills/', '.kilocode/skills/'],
      ['trae', 'Trae', '.trae/skills/', '.trae/skills/'],
      ['augment', 'Augment', '.augment/skills/', '.augment/skills/'],
      ['zencoder', 'Zencoder', '.zencoder/skills/', '.zencoder/skills/'],
      ['junie', 'Junie', '.junie/skills/', '.junie/skills/'],
      ['openhands', 'OpenHands', '.openhands/skills/', '.openhands/skills/'],
      ['kiro', 'Kiro', '.kiro/skills/', '.kiro/skills/'],
      ['replit', 'Replit', '.replit/skills/', '.replit/skills/'],
      ['kimi', 'Kimi', '.kimi/skills/', '.kimi/skills/'],
      ['universal', 'Universal', '.agents/skills/', '.agents/skills/'],
    ] as const;

    for (const [id, name, projectSkillsPath, userSkillsPath] of expected) {
      const host = findHostById(id);
      expect(host?.name).toBe(name);
      expect(host?.project.skillsPath).toBe(projectSkillsPath);
      expect(host?.user?.skillsPath).toBe(userSkillsPath);
    }

    expect(CLIENT_MAPPINGS.copilot.githubPath).toBe('.github/');
    expect(CLIENT_MAPPINGS.copilot.agentsPath).toBe('.github/agents/');
    expect(CLIENT_MAPPINGS.factory.hooksPath).toBe('.factory/hooks/');
    expect(CLIENT_MAPPINGS.opencode.commandsPath).toBe('.opencode/commands/');
  });

  it('represents new universal and provider-specific clients as skills-only', () => {
    expect(getMapping('warp', 'project')).toEqual({ skillsPath: '.agents/skills/' });
    expect(getMapping('aider-desk', 'project')).toEqual({
      skillsPath: '.aider-desk/skills/',
    });
    expect(getMapping('aider-desk', 'user')).toEqual({
      skillsPath: '.aider-desk/skills/',
    });

    for (const client of ['warp', 'aider-desk'] as const) {
      const host = findHostById(client);
      expect(host?.project.agentFile).toBeUndefined();
      expect(host?.project.commandsPath).toBeUndefined();
      expect(host?.project.agentsPath).toBeUndefined();
      expect(host?.project.hooksPath).toBeUndefined();
      expect(host?.project.githubPath).toBeUndefined();
      expect(host?.mcp).toBeUndefined();
    }
    expect(mcpClientIdsForScope('project')).toEqual([
      'claude',
      'copilot',
      'codex',
      'vscode',
      'universal',
    ]);
    expect(mcpClientIdsForScope('user')).toEqual([
      'claude',
      'copilot',
      'codex',
      'vscode',
      'universal',
    ]);
  });

  it('rejects user scope for project-only clients', () => {
    expect(clientIdsForScope('project')).toContain('eve');
    expect(clientIdsForScope('project')).toContain('promptscript');
    expect(clientIdsForScope('user')).not.toContain('eve');
    expect(clientIdsForScope('user')).not.toContain('promptscript');

    for (const client of ['eve', 'promptscript'] as const) {
      expect(findHostById(client)?.user).toBeUndefined();
      expect(USER_CLIENT_MAPPINGS[client]).toBeUndefined();
      expect(() => getMapping(client, 'user')).toThrow(
        `Client '${client}' does not support user scope`,
      );
    }
  });

  it('keeps every mapping relative to its selected root', () => {
    for (const mapping of [
      ...Object.values(CLIENT_MAPPINGS),
      ...Object.values(USER_CLIENT_MAPPINGS),
    ]) {
      expect(mapping.skillsPath).not.toMatch(/^\//);
      if (mapping.commandsPath) expect(mapping.commandsPath).not.toMatch(/^\//);
      if (mapping.agentFile) expect(mapping.agentFile).not.toMatch(/^\//);
    }
  });
});

describe('mapping helpers', () => {
  it('routes VS Code through Copilot artifacts and legacy skill destination', () => {
    const project = resolveClientMappings(['copilot', 'vscode'], CLIENT_MAPPINGS);
    expect(project.vscode.skillsPath).toBe('.github/skills/');
    expect(project.vscode.githubPath).toBe('.github/');

    const user = resolveClientMappings(['copilot', 'vscode'], USER_CLIENT_MAPPINGS);
    expect(user.vscode?.skillsPath).toBe('.copilot/skills/');
    expect(user.vscode?.githubPath).toBe('.copilot/');
  });

  it('leaves mappings unchanged when VS Code and Copilot are not both selected', () => {
    expect(resolveClientMappings(['vscode'], CLIENT_MAPPINGS)).toBe(CLIENT_MAPPINGS);
    expect(resolveClientMappings(['copilot'], CLIENT_MAPPINGS)).toBe(CLIENT_MAPPINGS);
  });

  it('deduplicates shared project paths and groups VS Code display output with Copilot', () => {
    expect(uniqueProjectSkillsPaths()).toContain('.agents/skills/');
    expect(uniqueProjectSkillsPaths().length).toBeLessThan(AGENT_HOSTS.length);
    expect(getDisplayName('vscode')).toBe('copilot');
    expect(getDisplayName('claude-code')).toBe('claude');
    expect(getDisplayName('warp')).toBe('warp');
  });
});
