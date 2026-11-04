/** Repository metadata omitted when the repository itself is a skill. */
export const ROOT_SKILL_EXCLUDED_ENTRIES = [
  '.git',
  '.github',
  '.allagents',
] as const;

/** Assistant configuration and supporting resources, never GitHub Actions metadata. */
export const GITHUB_ASSISTANT_ENTRIES = [
  'agents',
  'instructions',
  'prompts',
  'skills',
  'hooks',
  'scripts',
  'tools',
  'copilot-instructions.md',
] as const;

/** A contained plugin configuration file or an inline manifest value. */
export type PluginConfigSource =
  | { path: string; inline?: never; declaredIn?: string }
  | { inline: Record<string, unknown>; path?: never; declaredIn?: string };

/** AllAgents file-install selection applied before source content is read. */
export interface PluginComponentPolicy {
  exclude?: string[] | undefined;
  hooks?: false | undefined;
}

/** Resolved distribution sources. Validation modes never define membership. */
export interface PluginComponents {
  skills: string[];
  commands: string[];
  agents: string[];
  hooks: PluginConfigSource[];
  /** Portable hook payload directories, separate from hook configuration. */
  hookResources?: string[];
  mcpServers: PluginConfigSource[];
  /** Supported GitHub assistant artifacts, independent of native manifest membership. */
  github: boolean;
  /** Manifest-free repository skill layout, independent of assistant overlays. */
  legacyRepository: boolean;
  /** Native-compatible relaxed component errors, surfaced by lifecycle callers. */
  warnings?: string[];
}
