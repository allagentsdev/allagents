import { z } from 'zod';

/**
 * URL source object for plugins hosted externally
 * e.g. { source: "url", url: "https://github.com/figma/mcp-server-guide.git" }
 */
export const UrlSourceSchema = z.object({
  source: z.literal('url'),
  url: z.string().url(),
});

export type UrlSource = z.infer<typeof UrlSourceSchema>;

/**
 * GitHub source object for plugins hosted on GitHub
 * e.g. { source: "github", repo: "WiseTechGlobal/mcp-ediprod" }
 * Normalized to UrlSource at parse time.
 */
export const GitHubSourceSchema = z.object({
  source: z.literal('github'),
  repo: z.string().min(1),
}).transform((val) => ({
  source: 'url' as const,
  url: `https://github.com/${val.repo}`,
}));

/**
 * Plugin source: a relative path string, a URL source object, or a GitHub source object.
 * GitHub sources are normalized to URL sources during parsing.
 */
export const PluginSourceRefSchema = z.union([z.string(), UrlSourceSchema, GitHubSourceSchema]);

export type PluginSourceRef = z.infer<typeof PluginSourceRefSchema>;

/** A plugin component may be declared as one path or several paths. */
export const ComponentPathSchema = z.union([
  z.string(),
  z.array(z.string()),
]);

/**
 * Author/owner contact info
 */
export const ContactSchema = z.object({
  name: z.string(),
  email: z.string().optional(),
});

export type Contact = z.infer<typeof ContactSchema>;

/**
 * LSP server configuration within a plugin
 */
export const LspServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  extensionToLanguage: z.record(z.string(), z.string()).optional(),
  startupTimeout: z.number().optional(),
});

export type LspServer = z.infer<typeof LspServerSchema>;

/**
 * A plugin entry in marketplace.json
 */
export const MarketplacePluginEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  source: PluginSourceRefSchema,
  version: z.string().optional(),
  author: ContactSchema.optional(),
  category: z.string().optional(),
  homepage: z.string().optional(),
  strict: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  skills: ComponentPathSchema.optional(),
  commands: ComponentPathSchema.optional(),
  agents: ComponentPathSchema.optional(),
  hooks: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  mcpServers: z
    .union([z.string(), z.record(z.string(), z.unknown())])
    .optional(),
  lspServers: z.record(z.string(), LspServerSchema).optional(),
});

export type MarketplacePluginEntry = z.infer<typeof MarketplacePluginEntrySchema>;

/** File artifact kinds AllAgents can copy from a plugin source. */
export interface MarketplaceFileArtifacts {
  commands: boolean;
  skills: boolean;
  hooks: boolean;
  agents: boolean;
  mcpServers: boolean;
  github: boolean;
}

/**
 * In non-strict mode the marketplace entry is the complete component
 * definition. Omitted components must not be inferred from repository files.
 */
export function getMarketplaceFileArtifacts(
  entry: MarketplacePluginEntry,
): MarketplaceFileArtifacts | undefined {
  if (entry.strict !== false) return undefined;

  return {
    commands: entry.commands !== undefined,
    skills: entry.skills !== undefined,
    hooks: entry.hooks !== undefined,
    agents: entry.agents !== undefined,
    mcpServers: entry.mcpServers !== undefined,
    // .github is repository configuration, not a marketplace component kind.
    github: false,
  };
}

/**
 * Top-level marketplace.json schema
 */
export const MarketplaceManifestSchema = z.object({
  $schema: z.string().optional(),
  name: z.string().min(1),
  version: z.string().optional(),
  description: z.string().min(1),
  owner: ContactSchema.optional(),
  plugins: z.array(MarketplacePluginEntrySchema),
});

export type MarketplaceManifest = z.infer<typeof MarketplaceManifestSchema>;

/**
 * Lenient marketplace manifest schema for best-effort parsing.
 * Only requires a plugins array (of unknown entries) so we can
 * validate each entry individually.
 */
export const MarketplaceManifestLenientSchema = z.object({
  name: z.string().optional(),
  plugins: z.array(z.unknown()),
}).passthrough();
