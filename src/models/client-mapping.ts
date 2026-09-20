/**
 * Filesystem destinations supported by one client at one scope.
 *
 * A skill destination is the only required capability. Every other artifact
 * destination is independent so skill-only clients never imply instructions,
 * commands, agents, hooks, or GitHub overlays.
 */
export interface ClientMapping {
  skillsPath: string;
  commandsPath?: string;
  agentsPath?: string;
  agentFile?: string;
  agentFileFallback?: string;
  hooksPath?: string;
  githubPath?: string;
}

export interface ScopeCapability {
  project?: true;
  user?: true;
}

/** A canonical product identity and its independently evidenced capabilities. */
export interface AgentHost {
  id: string;
  name: string;
  project: ClientMapping;
  user?: ClientMapping;
  mcp?: ScopeCapability;
}

function skillsOnlyHost<const Id extends string>(
  id: Id,
  name: string,
  projectSkillsPath: string,
  userSkillsPath?: string,
): AgentHost & { readonly id: Id } {
  return {
    id,
    name,
    project: { skillsPath: projectSkillsPath },
    ...(userSkillsPath ? { user: { skillsPath: userSkillsPath } } : {}),
  };
}

/**
 * Canonical client capability registry.
 *
 * Skill destinations match the declared registry in `skills@1.7.0`. Existing
 * AllAgents clients retain their richer artifact destinations and runtime
 * capabilities. `omp` is an AllAgents-only product identity and `vscode` is an
 * explicit target with Copilot-aware routing; neither is a Skills alias.
 */
const AGENT_HOST_DEFINITIONS = [
  {
    id: 'claude',
    name: 'Claude Code',
    project: {
      commandsPath: '.claude/commands/',
      skillsPath: '.claude/skills/',
      agentsPath: '.claude/agents/',
      agentFile: 'CLAUDE.md',
      agentFileFallback: 'AGENTS.md',
      hooksPath: '.claude/hooks/',
    },
    user: {
      commandsPath: '.claude/commands/',
      skillsPath: '.claude/skills/',
      agentsPath: '.claude/agents/',
      agentFile: 'CLAUDE.md',
      agentFileFallback: 'AGENTS.md',
      hooksPath: '.claude/hooks/',
    },
    mcp: { project: true, user: true },
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    project: {
      skillsPath: '.github/skills/',
      agentsPath: '.github/agents/',
      hooksPath: '.github/hooks/',
      agentFile: 'AGENTS.md',
      githubPath: '.github/',
    },
    user: {
      skillsPath: '.copilot/skills/',
      agentsPath: '.copilot/agents/',
      hooksPath: '.copilot/hooks/',
      agentFile: 'AGENTS.md',
      githubPath: '.copilot/',
    },
    mcp: { project: true, user: true },
  },
  {
    id: 'codex',
    name: 'Codex',
    project: { skillsPath: '.codex/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.codex/skills/', agentFile: 'AGENTS.md' },
    mcp: { project: true, user: true },
  },
  {
    id: 'pi',
    name: 'Pi',
    project: { skillsPath: '.pi/skills/', agentFile: 'AGENTS.md' },
    user: {
      skillsPath: '.pi/agent/skills/',
      agentFile: '.pi/agent/AGENTS.md',
    },
  },
  {
    id: 'omp',
    name: 'OMP',
    project: {
      skillsPath: '.omp/skills/',
      hooksPath: '.omp/hooks/',
      agentFile: 'AGENTS.md',
    },
    user: {
      skillsPath: '.omp/agent/skills/',
      hooksPath: '.omp/agent/hooks/',
      agentFile: '.omp/agent/AGENTS.md',
    },
  },
  {
    id: 'cursor',
    name: 'Cursor',
    project: { skillsPath: '.cursor/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.cursor/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    project: {
      commandsPath: '.opencode/commands/',
      skillsPath: '.opencode/skills/',
      agentFile: 'AGENTS.md',
    },
    user: {
      commandsPath: '.opencode/commands/',
      skillsPath: '.opencode/skills/',
      agentFile: 'AGENTS.md',
    },
  },
  {
    id: 'gemini',
    name: 'Gemini',
    project: {
      skillsPath: '.gemini/skills/',
      agentFile: 'GEMINI.md',
      agentFileFallback: 'AGENTS.md',
    },
    user: {
      skillsPath: '.gemini/skills/',
      agentFile: 'GEMINI.md',
      agentFileFallback: 'AGENTS.md',
    },
  },
  {
    id: 'factory',
    name: 'Factory',
    project: {
      skillsPath: '.factory/skills/',
      agentFile: 'AGENTS.md',
      hooksPath: '.factory/hooks/',
    },
    user: {
      skillsPath: '.factory/skills/',
      agentFile: 'AGENTS.md',
      hooksPath: '.factory/hooks/',
    },
  },
  {
    id: 'ampcode',
    name: 'AmpCode',
    project: { skillsPath: '.ampcode/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.ampcode/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'vscode',
    name: 'VS Code',
    project: { skillsPath: '.agents/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.agents/skills/', agentFile: 'AGENTS.md' },
    mcp: { project: true, user: true },
  },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    project: { skillsPath: 'skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: 'skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    project: { skillsPath: '.windsurf/skills/', agentFile: 'AGENTS.md' },
    user: {
      skillsPath: '.codeium/windsurf/skills/',
      agentFile: 'AGENTS.md',
    },
  },
  {
    id: 'cline',
    name: 'Cline',
    project: { skillsPath: '.cline/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.cline/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'continue',
    name: 'Continue',
    project: { skillsPath: '.continue/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.continue/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'roo',
    name: 'Roo Code',
    project: { skillsPath: '.roo/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.roo/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'kilo',
    name: 'Kilo Code',
    project: { skillsPath: '.kilocode/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.kilocode/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'trae',
    name: 'Trae',
    project: { skillsPath: '.trae/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.trae/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'augment',
    name: 'Augment',
    project: { skillsPath: '.augment/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.augment/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'zencoder',
    name: 'Zencoder',
    project: { skillsPath: '.zencoder/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.zencoder/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'junie',
    name: 'Junie',
    project: { skillsPath: '.junie/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.junie/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'openhands',
    name: 'OpenHands',
    project: { skillsPath: '.openhands/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.openhands/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'kiro',
    name: 'Kiro',
    project: { skillsPath: '.kiro/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.kiro/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'replit',
    name: 'Replit',
    project: { skillsPath: '.replit/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.replit/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'kimi',
    name: 'Kimi',
    project: { skillsPath: '.kimi/skills/', agentFile: 'AGENTS.md' },
    user: { skillsPath: '.kimi/skills/', agentFile: 'AGENTS.md' },
  },
  {
    id: 'universal',
    name: 'Universal',
    project: { skillsPath: '.agents/skills/', agentFile: 'AGENTS.md' },
    user: {
      skillsPath: '.agents/skills/',
      agentFile: 'AGENTS.md',
    },
    mcp: { project: true, user: true },
  },

  // Skill-destination parity with skills@1.7.0. These entries intentionally do
  // not claim instruction or non-skill artifact support.
  skillsOnlyHost('aider-desk', 'AiderDesk', '.aider-desk/skills/', '.aider-desk/skills/'),
  skillsOnlyHost('antigravity', 'Antigravity', '.agents/skills/', '.gemini/antigravity/skills/'),
  skillsOnlyHost(
    'antigravity-cli',
    'Antigravity CLI',
    '.agents/skills/',
    '.gemini/antigravity-cli/skills/',
  ),
  skillsOnlyHost('astrbot', 'AstrBot', 'data/skills/', '.astrbot/data/skills/'),
  skillsOnlyHost('autohand-code', 'Autohand Code CLI', '.autohand/skills/', '.autohand/skills/'),
  skillsOnlyHost('bob', 'IBM Bob', '.bob/skills/', '.bob/skills/'),
  skillsOnlyHost(
    'codearts-agent',
    'CodeArts Agent',
    '.codeartsdoer/skills/',
    '.codeartsdoer/skills/',
  ),
  skillsOnlyHost('codebuddy', 'CodeBuddy', '.codebuddy/skills/', '.codebuddy/skills/'),
  skillsOnlyHost('codemaker', 'Codemaker', '.codemaker/skills/', '.codemaker/skills/'),
  skillsOnlyHost('codestudio', 'Code Studio', '.codestudio/skills/', '.codestudio/skills/'),
  skillsOnlyHost('command-code', 'Command Code', '.commandcode/skills/', '.commandcode/skills/'),
  skillsOnlyHost('cortex', 'Cortex Code', '.cortex/skills/', '.snowflake/cortex/skills/'),
  skillsOnlyHost('crush', 'Crush', '.crush/skills/', '.config/crush/skills/'),
  skillsOnlyHost('deepagents', 'Deep Agents', '.agents/skills/', '.deepagents/agent/skills/'),
  skillsOnlyHost('devin', 'Devin for Terminal', '.devin/skills/', '.config/devin/skills/'),
  skillsOnlyHost('dexto', 'Dexto', '.agents/skills/', '.agents/skills/'),
  skillsOnlyHost('eve', 'Eve', 'agent/skills/'),
  skillsOnlyHost('firebender', 'Firebender', '.agents/skills/', '.firebender/skills/'),
  skillsOnlyHost('forgecode', 'ForgeCode', '.forge/skills/', '.forge/skills/'),
  skillsOnlyHost('fx', 'fx', '.fx/skills/', '.fx/skills/'),
  skillsOnlyHost('goose', 'Goose', '.goose/skills/', '.config/goose/skills/'),
  skillsOnlyHost('grok', 'Grok Build', '.grok/skills/', '.grok/skills/'),
  skillsOnlyHost('hermes-agent', 'Hermes Agent', '.hermes/skills/', '.hermes/skills/'),
  skillsOnlyHost('inference-sh', 'inference.sh', '.inferencesh/skills/', '.inferencesh/skills/'),
  skillsOnlyHost('iflow-cli', 'iFlow CLI', '.iflow/skills/', '.iflow/skills/'),
  skillsOnlyHost('jazz', 'Jazz', '.jazz/skills/', '.jazz/skills/'),
  skillsOnlyHost('kimchi', 'Kimchi', '.kimchi/skills/', '.config/kimchi/harness/skills/'),
  skillsOnlyHost('kode', 'Kode', '.kode/skills/', '.kode/skills/'),
  skillsOnlyHost('lingma', 'Lingma', '.lingma/skills/', '.lingma/skills/'),
  skillsOnlyHost('loaf', 'Loaf', '.agents/skills/', '.agents/skills/'),
  skillsOnlyHost('mcpjam', 'MCPJam', '.mcpjam/skills/', '.mcpjam/skills/'),
  skillsOnlyHost('minimax-code', 'MiniMax Code', '.minimax/skills/', '.minimax/skills/'),
  skillsOnlyHost('mistral-vibe', 'Mistral Vibe', '.vibe/skills/', '.vibe/skills/'),
  skillsOnlyHost('moxby', 'Moxby', '.moxby/skills/', '.moxby/skills/'),
  skillsOnlyHost('mux', 'Mux', '.mux/skills/', '.mux/skills/'),
  skillsOnlyHost('neovate', 'Neovate', '.neovate/skills/', '.neovate/skills/'),
  skillsOnlyHost('ona', 'Ona', '.ona/skills/', '.ona/skills/'),
  skillsOnlyHost(
    'posit-assistant',
    'Posit Assistant',
    '.posit/assistant/skills/',
    '.posit/assistant/skills/',
  ),
  skillsOnlyHost('qoder', 'Qoder', '.qoder/skills/', '.qoder/skills/'),
  skillsOnlyHost('qoder-cn', 'Qoder CN', '.qoder/skills/', '.qoder-cn/skills/'),
  skillsOnlyHost('qwen-code', 'Qwen Code', '.qwen/skills/', '.qwen/skills/'),
  skillsOnlyHost('reasonix', 'Reasonix', '.reasonix/skills/', '.reasonix/skills/'),
  skillsOnlyHost('rovodev', 'Rovo Dev', '.rovodev/skills/', '.rovodev/skills/'),
  skillsOnlyHost('sarvam-code', 'Sarvam Code', '.agents/skills/', '.agents/skills/'),
  skillsOnlyHost(
    'tabnine-cli',
    'Tabnine CLI',
    '.tabnine/agent/skills/',
    '.tabnine/agent/skills/',
  ),
  skillsOnlyHost('terramind', 'Terramind', '.terramind/skills/', '.terramind/skills/'),
  skillsOnlyHost('tinycloud', 'Tinycloud', '.tinycloud/skills/', '.tinycloud/skills/'),
  skillsOnlyHost('trae-cn', 'Trae CN', '.trae/skills/', '.trae-cn/skills/'),
  skillsOnlyHost('warp', 'Warp', '.agents/skills/', '.agents/skills/'),
  skillsOnlyHost('zed', 'Zed', '.agents/skills/', '.agents/skills/'),
  skillsOnlyHost('zcode', 'ZCode', '.zcode/skills/', '.zcode/skills/'),
  skillsOnlyHost('zenflow', 'Zenflow', '.zencoder/skills/', '.zencoder/skills/'),
  skillsOnlyHost('pochi', 'Pochi', '.pochi/skills/', '.pochi/skills/'),
  skillsOnlyHost('promptscript', 'PromptScript', '.agents/skills/'),
  skillsOnlyHost('adal', 'AdaL', '.adal/skills/', '.adal/skills/'),
] as const satisfies readonly AgentHost[];

export type CanonicalClientId = (typeof AGENT_HOST_DEFINITIONS)[number]['id'];

export type CanonicalAgentHost = AgentHost & {
  readonly id: CanonicalClientId;
};

export const AGENT_HOSTS: readonly CanonicalAgentHost[] =
  AGENT_HOST_DEFINITIONS;

export const CLIENT_TYPES = AGENT_HOSTS.map(
  (host) => host.id,
) as [CanonicalClientId, ...CanonicalClientId[]];

export const USER_CLIENT_TYPES = AGENT_HOSTS
  .filter((host) => host.user !== undefined)
  .map((host) => host.id) as [CanonicalClientId, ...CanonicalClientId[]];

/** Skills-compatible names that map to an existing AllAgents product identity. */
export const CLIENT_ALIASES = Object.freeze({
  'claude-code': 'claude',
  'github-copilot': 'copilot',
  'gemini-cli': 'gemini',
  droid: 'factory',
  amp: 'ampcode',
  'kiro-cli': 'kiro',
  'kimi-code-cli': 'kimi',
} as const satisfies Record<string, CanonicalClientId>);

export type ClientAlias = keyof typeof CLIENT_ALIASES;

const CANONICAL_CLIENT_LOOKUP: Readonly<Record<string, CanonicalClientId>> =
  Object.freeze(Object.fromEntries(CLIENT_TYPES.map((id) => [id, id])));

export function canonicalizeClientId(
  id: string,
): CanonicalClientId | undefined {
  return CANONICAL_CLIENT_LOOKUP[id] ?? CLIENT_ALIASES[id as ClientAlias];
}

export function findHostById(id: string): AgentHost | undefined {
  const canonical = canonicalizeClientId(id);
  return canonical === undefined
    ? undefined
    : AGENT_HOSTS.find((host) => host.id === canonical);
}

export function getMapping(
  id: CanonicalClientId,
  scope: 'project' | 'user',
): ClientMapping {
  const host = findHostById(id);
  if (!host) {
    throw new Error(`Unknown agent host: ${id} (no entry in AGENT_HOSTS)`);
  }
  if (scope === 'project') return host.project;
  const user = host.user;
  if (!user) {
    throw new Error(`Client '${id}' does not support user scope`);
  }
  return user;
}

export function supportsClientScope(
  id: CanonicalClientId,
  scope: 'project' | 'user',
): boolean {
  const host = findHostById(id);
  return scope === 'project' ? host !== undefined : host?.user !== undefined;
}

export function clientIdsForScope(
  scope: 'project' | 'user',
): CanonicalClientId[] {
  return [...(scope === 'project' ? CLIENT_TYPES : USER_CLIENT_TYPES)];
}

export function mcpClientIdsForScope(
  scope: 'project' | 'user',
): CanonicalClientId[] {
  return AGENT_HOSTS.filter((host) => host.mcp?.[scope]).map(
    (host) => host.id,
  );
}

export function uniqueProjectSkillsPaths(): string[] {
  return Array.from(new Set(AGENT_HOSTS.map((host) => host.project.skillsPath)));
}

export function agentHelpList(): string {
  return [...AGENT_HOSTS]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((host) => `${host.id} — ${host.name}`)
    .join('\n');
}

export type ClientMappings = Partial<
  Record<CanonicalClientId, ClientMapping>
>;

export const CLIENT_MAPPINGS: Record<CanonicalClientId, ClientMapping> =
  Object.freeze(
    Object.fromEntries(AGENT_HOSTS.map((host) => [host.id, host.project])),
  ) as Record<CanonicalClientId, ClientMapping>;

export const USER_CLIENT_MAPPINGS: ClientMappings = Object.freeze(
  Object.fromEntries(
    AGENT_HOSTS.flatMap((host) =>
      host.user ? [[host.id, host.user] as const] : [],
    ),
  ),
) as ClientMappings;

export const CANONICAL_SKILLS_PATH = '.agents/skills/';

export function isUniversalClient(client: CanonicalClientId): boolean {
  return client === 'universal';
}

export function resolveClientMappings(
  clients: readonly CanonicalClientId[],
  baseMappings: Record<CanonicalClientId, ClientMapping>,
): Record<CanonicalClientId, ClientMapping>;
export function resolveClientMappings(
  clients: readonly CanonicalClientId[],
  baseMappings: ClientMappings,
): ClientMappings;
export function resolveClientMappings(
  clients: readonly CanonicalClientId[],
  baseMappings: ClientMappings,
): ClientMappings {
  if (!clients.includes('vscode') || !clients.includes('copilot')) {
    return baseMappings;
  }
  const copilot = baseMappings.copilot;
  if (!copilot) return baseMappings;
  return {
    ...baseMappings,
    vscode: { ...copilot },
  };
}

/** Display grouping is distinct from accepted input aliases. */
export const CLIENT_DISPLAY_ALIASES: Partial<
  Record<CanonicalClientId, CanonicalClientId>
> = {
  vscode: 'copilot',
};

export function getDisplayName(client: string): string {
  const canonical = canonicalizeClientId(client);
  if (!canonical) return client;
  return CLIENT_DISPLAY_ALIASES[canonical] ?? canonical;
}
