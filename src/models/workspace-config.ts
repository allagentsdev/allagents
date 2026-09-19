import { z } from 'zod';

/**
 * Managed mode for repositories:
 * - false (default): user manages the repo, allagents does not clone or pull
 * - 'clone': clone if path doesn't exist, never pull
 * - true | 'sync': clone if path doesn't exist, pull latest on every sync
 */
export const ManagedModeSchema = z.union([
  z.boolean(),
  z.enum(['clone', 'sync']),
]);

export type ManagedMode = z.infer<typeof ManagedModeSchema>;

/**
 * Repository definition in workspace.yaml
 */
export const RepositorySchema = z.object({
  path: z.string(),
  name: z.string().optional(),
  source: z.string().optional(),
  repo: z.string().optional(),
  description: z.string().optional(),
  skills: z.union([z.boolean(), z.array(z.string())]).optional(),
  managed: ManagedModeSchema.optional(),
  branch: z.string().optional(),
});

export type Repository = z.infer<typeof RepositorySchema>;

/**
 * Workspace file entry - can be string shorthand or explicit source/dest mapping
 *
 * String shorthand: "CLAUDE.md" (source and dest are the same, resolved from workspace.source)
 * Object form:
 *   - source: optional, can be local path, GitHub URL, or shorthand (owner/repo/path)
 *   - dest: optional, defaults to basename of source
 *
 * Valid combinations:
 * 1. { source: "path/file.md" } → dest defaults to "file.md"
 * 2. { source: "path/file.md", dest: "renamed.md" } → explicit mapping
 * 3. { dest: "file.md", source: "owner/repo/path/file.md" } → GitHub source
 * 4. { dest: "file.md" } → uses dest as source path relative to workspace.source
 *
 * At least one of source or dest must be provided.
 */
export const WorkspaceFileSchema = z.union([
  z.string(), // shorthand: "CLAUDE.md" (source and dest are the same)
  z.object({
    source: z.string().optional(), // local path, GitHub URL, or shorthand
    dest: z.string().optional(), // destination filename in workspace root (defaults to basename of source)
  }),
]);

export type WorkspaceFile = z.infer<typeof WorkspaceFileSchema>;

/**
 * Workspace configuration for copying files to workspace root
 *
 * source: optional default base for resolving file entries without explicit source
 * files: array of file entries to sync
 *
 * If workspace.source is not provided, all file entries must have explicit source.
 */
export const WorkspaceSchema = z.object({
  source: z.string().optional(), // optional default base for file resolution
  files: z.array(WorkspaceFileSchema),
});

export type Workspace = z.infer<typeof WorkspaceSchema>;

/**
 * Plugin source - can be local path or GitHub URL
 */
export const PluginSourceSchema = z.string();

export type PluginSource = z.infer<typeof PluginSourceSchema>;

/**
 * Supported AI client types
 */
export const ClientTypeSchema = z.enum([
  'universal',
  'claude',
  'copilot',
  'codex',
  'pi',
  'omp',
  'cursor',
  'opencode',
  'gemini',
  'factory',
  'ampcode',
  'vscode',
  'openclaw',
  'windsurf',
  'cline',
  'continue',
  'roo',
  'kilo',
  'trae',
  'augment',
  'zencoder',
  'junie',
  'openhands',
  'kiro',
  'replit',
  'kimi',
]);

export type ClientType = z.infer<typeof ClientTypeSchema>;

/**
 * Installation mode for plugins
 * - 'file': Copy plugin files to client directories (default)
 * - 'native': Use client's native CLI to install (e.g., `claude plugin install`)
 */
export const InstallModeSchema = z.enum(['file', 'native']);
export type InstallMode = z.infer<typeof InstallModeSchema>;

/**
 * Client entry — string shorthand, colon shorthand, or object with install mode.
 *
 * "claude"        → bare client, install defaults to "file"
 * "claude:native" → colon shorthand, parsed to { name: "claude", install: "native" }
 * { name, install } → explicit object form
 */
const CLIENT_INSTALL_SHORTHAND_PATTERN = new RegExp(
  `^(?:${ClientTypeSchema.options.join('|')}):(?:${InstallModeSchema.options.join('|')})$`,
);

const ClientInstallShorthandSchema = z
  .string()
  .regex(
    CLIENT_INSTALL_SHORTHAND_PATTERN,
    `Expected CLIENT:INSTALL with a known client and one of: ${InstallModeSchema.options.join(', ')}`,
  )
  .transform((value) => {
    const [name, install] = value.split(':') as [ClientType, InstallMode];
    return { name, install };
  });

export const ClientEntrySchema = z.union([
  ClientTypeSchema,
  ClientInstallShorthandSchema,
  z.object({
    name: ClientTypeSchema,
    install: InstallModeSchema.default('file'),
  }),
]);
export type ClientEntry = z.infer<typeof ClientEntrySchema>;

/**
 * Skill selection config for a plugin entry.
 * - Array: allowlist — only these skills are enabled.
 * - Object with `exclude`: blocklist — all skills except these are enabled.
 */
export const PluginSkillsConfigSchema = z.union([
  z.array(z.string()),
  z.object({ exclude: z.array(z.string()) }),
]);

export type PluginSkillsConfig = z.infer<typeof PluginSkillsConfigSchema>;

/**
 * Plugin entry in workspace.yaml
 * Supports string shorthand and object form with optional client override.
 */
export const PluginEntrySchema = z.union([
  PluginSourceSchema,
  z
    .object({
      source: PluginSourceSchema,
      clients: z.array(ClientTypeSchema).optional(),
      install: InstallModeSchema.optional(),
      exclude: z.array(z.string()).optional(),
      skills: PluginSkillsConfigSchema.optional(),
      /**
       * Optional Git ref (tag or branch). Equivalent to passing the
       * `owner/repo@<ref>` shorthand on install. When set, every sync resolves
       * the plugin at this ref instead of the default branch.
       */
      ref: z.string().optional(),
    })
    .strict(),
]);

export type PluginEntry = z.infer<typeof PluginEntrySchema>;

/**
 * Resolve plugin source from plugin entry (string or object form)
 */
export function getPluginSource(plugin: PluginEntry): string {
  return typeof plugin === 'string' ? plugin : plugin.source;
}

/**
 * Resolve the source exactly as sync will fetch it, including object-form refs.
 * An inline ref remains authoritative when both forms are present.
 */
export function getEffectivePluginSource(plugin: PluginEntry): string {
  const source = getPluginSource(plugin);
  const ref = getPluginRef(plugin);
  if (!ref) return source;
  if (
    source.startsWith('.') ||
    source.startsWith('/') ||
    source.includes('\\') ||
    /^[a-zA-Z]:/.test(source) ||
    (/^[a-z]+:\/\//i.test(source) &&
      !/^https?:\/\/(?:www\.)?github\.com\//i.test(source)) ||
    source.slice(0, source.indexOf('/')).includes('@')
  ) {
    return source;
  }

  if (/\/tree\/|\/blob\//.test(source)) return source;
  const shorthand = source
    .replace(/^https?:\/\/(?:www\.)?github\.com\//, '')
    .replace(/^github\.com\//, '')
    .replace(/^gh:/, '');
  const parts = shorthand.split('/');
  const repoSegment = parts[1];
  if (!repoSegment || repoSegment.includes('@')) return source;

  parts[1] = `${repoSegment}@${ref}`;
  return parts.join('/');
}

/**
 * Resolve optional plugin-level clients from plugin entry
 */
export function getPluginClients(
  plugin: PluginEntry,
): ClientType[] | undefined {
  return typeof plugin === 'string' ? undefined : plugin.clients;
}

/**
 * Get plugin-level install mode override (if any)
 */
export function getPluginInstallMode(
  plugin: PluginEntry,
): InstallMode | undefined {
  return typeof plugin === 'string' ? undefined : plugin.install;
}

/**
 * Get plugin-level file exclusion patterns (if any).
 * Glob patterns are relative to the plugin root.
 */
export function getPluginExclude(plugin: PluginEntry): string[] | undefined {
  return typeof plugin === 'string' ? undefined : plugin.exclude;
}

/**
 * Get the requested Git ref for a plugin entry (if any). Returns undefined for
 * both the string-shorthand form and object entries without `ref:`.
 */
export function getPluginRef(plugin: PluginEntry): string | undefined {
  return typeof plugin === 'string' ? undefined : plugin.ref;
}

/**
 * Normalize a client entry to { name, install } form.
 */
export function normalizeClientEntry(entry: ClientEntry): {
  name: ClientType;
  install: InstallMode;
} {
  if (typeof entry === 'string') {
    return { name: entry, install: 'file' };
  }
  return { name: entry.name, install: entry.install ?? 'file' };
}

/**
 * Extract ClientType values from client entries.
 */
export function getClientTypes(entries: ClientEntry[]): ClientType[] {
  return entries.map((e) => (typeof e === 'string' ? e : e.name));
}

/**
 * Get install mode for a specific client from entries.
 * Returns 'file' if client not found.
 */
export function getClientInstallMode(
  entries: ClientEntry[],
  client: ClientType,
): InstallMode {
  for (const entry of entries) {
    const normalized = normalizeClientEntry(entry);
    if (normalized.name === client) return normalized.install;
  }
  return 'file';
}

/**
 * Resolve effective install mode for a (plugin, client) pair.
 * Priority: plugin-level > client-level > 'file' default.
 */
export function resolveInstallMode(
  pluginEntry: PluginEntry,
  clientEntry: { name: ClientType; install: InstallMode },
): InstallMode {
  const pluginMode = getPluginInstallMode(pluginEntry);
  if (pluginMode) return pluginMode;
  return clientEntry.install;
}

/**
 * VSCode workspace generation configuration
 */
export const VscodeConfigSchema = z.object({
  output: z.string().optional(),
});

export type VscodeConfig = z.infer<typeof VscodeConfigSchema>;

/**
 * Sync mode for skills
 * - 'symlink': Copy to canonical .agents/skills/, symlink from client paths (default)
 * - 'copy': Copy directly to each client path (fallback for environments without symlink support)
 */
export const SyncModeSchema = z.enum(['symlink', 'copy']);

export type SyncMode = z.infer<typeof SyncModeSchema>;

/**
 * Per-server MCP proxy override
 */
export const McpProxyServerSchema = z.object({
  proxy: z.array(z.string()),
});

/**
 * MCP proxy configuration — rewrites HTTP MCP servers to stdio via the
 * built-in AllAgents HTTP proxy helper
 */
export const McpProxyConfigSchema = z.object({
  clients: z.array(z.string()).default([]),
  servers: z.record(McpProxyServerSchema).optional(),
});

export type McpProxyConfig = z.infer<typeof McpProxyConfigSchema>;

/**
 * Workspace-level MCP server definition (top-level `mcpServers:` field in
 * workspace.yaml). Allows declaring ad-hoc MCP servers without authoring a
 * plugin. Supports both HTTP (url) and stdio (command) transports.
 *
 * Optional `clients:` filter restricts which client scopes receive the server.
 * When absent, the server is synced to every configured client that supports
 * project-scoped MCP (claude, codex, vscode, copilot).
 */
export const McpServerConfigSchema = z.union([
  // HTTP transport
  z
    .object({
      type: z.enum(['http']).optional(),
      url: z.string(),
      headers: z.record(z.string()).optional(),
      clients: z.array(ClientTypeSchema).optional(),
    })
    .strict(),
  // stdio transport
  z
    .object({
      type: z.enum(['stdio']).optional(),
      command: z.string(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string()).optional(),
      clients: z.array(ClientTypeSchema).optional(),
    })
    .strict(),
]);

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

/**
 * Portable secret references are preserved verbatim until the selected client
 * resolves them at runtime. Profile declarations never accept resolved values.
 */
const PROFILE_SECRET_REFERENCE_PATTERN = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

export const ProfileSecretReferenceSchema = z
  .string()
  .regex(
    PROFILE_SECRET_REFERENCE_PATTERN,
    `Expected an exact \${ENV_VAR} reference`,
  );

/**
 * Profile and launcher names are also used as filesystem and command
 * basenames, so they intentionally use a portable subset on every platform.
 */
export const ProfileNameSchema = z
  .string()
  .regex(
    /^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$))(?!.*\.$)[a-z0-9][a-z0-9._-]{0,63}$/,
    'Expected 1-64 portable lowercase ASCII characters starting with a letter or number',
  );

export type ProfileName = z.infer<typeof ProfileNameSchema>;

export const ProfileMcpServerNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_.-]{1,100}$/,
    'Expected 1-100 ASCII letters, numbers, dots, underscores, or hyphens',
  );

/**
 * Normalize a declared launcher to the command identity which can exist on
 * every supported platform. Windows companion extensions share one identity.
 */
export function getLauncherCollisionKey(name: string): string {
  return name.toLowerCase().replace(/\.(?:cmd|ps1)$/i, '');
}

const EmptyProfileSettingsSchema = z.object({}).strict();

export const ClaudeProfileSettingsSchema = z
  .object({
    model: z.string().min(1).optional(),
    effortLevel: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
    fallbackModel: z.array(z.string().min(1)).min(1).optional(),
    outputStyle: z.string().min(1).optional(),
    autoMemoryEnabled: z.boolean().optional(),
    spinnerTipsEnabled: z.boolean().optional(),
    autoUpdatesChannel: z.enum(['stable', 'latest']).optional(),
  })
  .strict();

export type ClaudeProfileSettings = z.infer<typeof ClaudeProfileSettingsSchema>;

export const OpenCodeProfileSettingsSchema = z
  .object({
    model: z.string().min(1).optional(),
    small_model: z.string().min(1).optional(),
    default_agent: z.string().min(1).optional(),
    username: z.string().min(1).optional(),
    share: z.enum(['manual', 'auto', 'disabled']).optional(),
    autoupdate: z.union([z.boolean(), z.literal('notify')]).optional(),
    snapshot: z.boolean().optional(),
    subagent_depth: z.number().int().nonnegative().optional(),
    logLevel: z.enum(['DEBUG', 'INFO', 'WARN', 'ERROR']).optional(),
    disabled_providers: z.array(z.string().min(1)).optional(),
    enabled_providers: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type OpenCodeProfileSettings = z.infer<
  typeof OpenCodeProfileSettingsSchema
>;

export const CopilotProfileSettingsSchema = z
  .object({
    model: z.string().min(1).optional(),
    theme: z
      .enum(['default', 'github', 'dim', 'high-contrast', 'colorblind'])
      .optional(),
    autoUpdate: z.boolean().optional(),
    autoUpdatesChannel: z.enum(['stable', 'prerelease']).optional(),
    banner: z.enum(['always', 'once', 'never']).optional(),
    askUser: z.boolean().optional(),
    includeCoAuthoredBy: z.boolean().optional(),
    stream: z.boolean().optional(),
    streamerMode: z.boolean().optional(),
    toolSearch: z.boolean().optional(),
    updateTerminalTitle: z.boolean().optional(),
    respectGitignore: z.boolean().optional(),
    disableAllHooks: z.boolean().optional(),
    experimental: z.boolean().optional(),
    bashEnv: z.boolean().optional(),
    keepAlive: z.enum(['on', 'off', 'busy']).optional(),
    commandHistoryMaxSize: z.number().int().min(1).max(1000).optional(),
    compactPaste: z.boolean().optional(),
    mouse: z.boolean().optional(),
    terminalProgress: z.boolean().optional(),
    remote: z.enum(['on', 'off']).optional(),
    remoteExport: z.boolean().optional(),
    'ide.autoConnect': z.boolean().optional(),
    shellShortcut: z.boolean().optional(),
    'customAgents.defaultLocalOnly': z.boolean().optional(),
    storeTokenPlaintext: z.boolean().optional(),
    disabledMcpServers: z.array(z.string().min(1)).optional(),
    enabledMcpServers: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type CopilotProfileSettings = z.infer<
  typeof CopilotProfileSettingsSchema
>;

export const CodexProfileSettingsSchema = z
  .object({
    model: z.string().min(1).optional(),
    model_reasoning_effort: z
      .enum(['minimal', 'low', 'medium', 'high', 'xhigh'])
      .optional(),
    model_reasoning_summary: z
      .enum(['auto', 'concise', 'detailed', 'none'])
      .optional(),
    model_verbosity: z.enum(['low', 'medium', 'high']).optional(),
    approval_policy: z.enum(['on-request', 'never']).optional(),
    sandbox_mode: z
      .enum(['read-only', 'workspace-write', 'danger-full-access'])
      .optional(),
    web_search: z.enum(['disabled', 'cached', 'indexed', 'live']).optional(),
    personality: z.enum(['none', 'friendly', 'pragmatic']).optional(),
  })
  .strict();

export type CodexProfileSettings = z.infer<typeof CodexProfileSettingsSchema>;

/**
 * Profile clients deliberately use object form only. Each adapter owns a
 * structural settings schema so runtime validation and generated JSON Schema
 * expose the same input contract. Clients without an adapter accept only an
 * empty settings object, allowing orchestration to report capability errors.
 */
const ProfileClientCommonShape = {
  install: InstallModeSchema.default('file'),
  launcher: ProfileNameSchema.optional(),
} as const;

export const ProfileClientSchema = z.union([
  z
    .object({
      name: z.literal('claude'),
      ...ProfileClientCommonShape,
      settings: ClaudeProfileSettingsSchema.default({}),
    })
    .strict(),
  z
    .object({
      name: z.literal('opencode'),
      ...ProfileClientCommonShape,
      settings: OpenCodeProfileSettingsSchema.default({}),
    })
    .strict(),
  z
    .object({
      name: z.literal('copilot'),
      ...ProfileClientCommonShape,
      settings: CopilotProfileSettingsSchema.default({}),
    })
    .strict(),
  z
    .object({
      name: z.literal('codex'),
      ...ProfileClientCommonShape,
      settings: CodexProfileSettingsSchema.default({}),
    })
    .strict(),
  z
    .object({
      name: z.enum(['pi', 'omp']),
      ...ProfileClientCommonShape,
      settings: EmptyProfileSettingsSchema.default({}),
    })
    .strict(),
  z
    .object({
      name: z.enum([
        'universal',
        'cursor',
        'gemini',
        'factory',
        'ampcode',
        'vscode',
        'openclaw',
        'windsurf',
        'cline',
        'continue',
        'roo',
        'kilo',
        'trae',
        'augment',
        'zencoder',
        'junie',
        'openhands',
        'kiro',
        'replit',
        'kimi',
      ]),
      ...ProfileClientCommonShape,
      settings: EmptyProfileSettingsSchema.default({}),
    })
    .strict(),
]);

export type ProfileClient = z.infer<typeof ProfileClientSchema>;

const ProfilePluginSkillsConfigSchema = z.union([
  z.array(z.string()),
  z.object({ exclude: z.array(z.string()) }).strict(),
]);

/**
 * Profile plugins reuse the ordinary plugin vocabulary while excluding
 * project-only file exclusion rules.
 */
export const ProfilePluginEntrySchema = z.union([
  PluginSourceSchema,
  z
    .object({
      source: PluginSourceSchema,
      ref: z.string().optional(),
      install: InstallModeSchema.optional(),
      clients: z.array(ClientTypeSchema).optional(),
      skills: ProfilePluginSkillsConfigSchema.optional(),
    })
    .strict(),
]);

export type ProfilePluginEntry = z.infer<typeof ProfilePluginEntrySchema>;

/**
 * Profile MCP declarations retain the existing transport vocabulary, but
 * credential-bearing values must be portable references rather than secrets.
 */
const PROFILE_SENSITIVE_MCP_FIELD_PATTERN =
  /(?:^|[-_.])(?:api[-_]?key|auth|authorization|credential|key|password|secret|signature|token)(?:$|[-_.])/i;

function isProfileSecretReference(value: string | undefined): boolean {
  return value !== undefined && PROFILE_SECRET_REFERENCE_PATTERN.test(value);
}

const ProfileMcpArgumentsSchema = z
  .array(z.string())
  .superRefine((arguments_, ctx) => {
    const invalidIndexes = new Set<number>();
    const reject = (index: number) => {
      if (invalidIndexes.has(index)) return;
      invalidIndexes.add(index);
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index],
        message: `Secret arguments must be exact \${ENV_VAR} references`,
      });
    };

    for (const [index, argument] of arguments_.entries()) {
      if (arguments_[index - 1] === '--header-env') {
        if (!/^[^=:\s]+=[A-Za-z_][A-Za-z0-9_]*$/.test(argument)) {
          reject(index);
        }
        continue;
      }
      const separateOption = argument.match(/^(?:--?|\/)([^=:\s]+)$/);
      const separateOptionName = separateOption?.[1];
      if (
        separateOptionName &&
        PROFILE_SENSITIVE_MCP_FIELD_PATTERN.test(separateOptionName)
      ) {
        const credentialIndex = index + 1;
        if (!isProfileSecretReference(arguments_[credentialIndex])) {
          reject(credentialIndex < arguments_.length ? credentialIndex : index);
        }
        continue;
      }

      if (/^bearer$/i.test(argument)) {
        const credentialIndex = index + 1;
        if (!isProfileSecretReference(arguments_[credentialIndex])) {
          reject(credentialIndex < arguments_.length ? credentialIndex : index);
        }
        continue;
      }

      const assignment = argument.match(/^(?:--?|\/)?([^=:\s]+)[=:]\s*(.*)$/);
      const assignmentName = assignment?.[1];
      const inlineCredential =
        assignmentName &&
        PROFILE_SENSITIVE_MCP_FIELD_PATTERN.test(assignmentName)
          ? assignment[2]
          : undefined;
      const bearerCredential = argument.match(/\bbearer\s+(.+)$/i)?.[1];

      if (
        inlineCredential !== undefined &&
        !isProfileSecretReference(inlineCredential) &&
        !isProfileSecretReference(bearerCredential)
      ) {
        reject(index);
        continue;
      }

      if (
        bearerCredential !== undefined &&
        !isProfileSecretReference(bearerCredential)
      ) {
        reject(index);
        continue;
      }

      if (
        argument.includes('${') &&
        !isProfileSecretReference(argument) &&
        !isProfileSecretReference(inlineCredential) &&
        !isProfileSecretReference(bearerCredential)
      ) {
        reject(index);
      }
    }
  });

export const ProfileMcpServerConfigSchema = z.union([
  z
    .object({
      type: z.enum(['http']).optional(),
      url: z.string(),
      headers: z.record(ProfileSecretReferenceSchema).optional(),
      clients: z.array(ClientTypeSchema).optional(),
    })
    .strict(),
  z
    .object({
      type: z.enum(['stdio']).optional(),
      command: z.string(),
      args: ProfileMcpArgumentsSchema.optional(),
      env: z.record(ProfileSecretReferenceSchema).optional(),
      clients: z.array(ClientTypeSchema).optional(),
    })
    .strict(),
]);

export type ProfileMcpServerConfig = z.infer<
  typeof ProfileMcpServerConfigSchema
>;

export const ProfileDeclarationSchema = z
  .object({
    clients: z.array(ProfileClientSchema).min(1),
    plugins: z.array(ProfilePluginEntrySchema).default([]),
    mcpServers: z
      .record(ProfileMcpServerNameSchema, ProfileMcpServerConfigSchema)
      .optional(),
    mcpProxy: McpProxyConfigSchema.optional(),
  })
  .strict()
  .superRefine((profile, ctx) => {
    const declaredClients = new Set<ClientType>();

    profile.clients.forEach((client, index) => {
      if (declaredClients.has(client.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['clients', index, 'name'],
          message: `Client '${client.name}' is declared more than once`,
        });
      }
      declaredClients.add(client.name);
    });

    const validateSelector = (
      clients: readonly string[] | undefined,
      path: (string | number)[],
      allowWildcard = false,
    ): void => {
      if (!clients) return;
      const selected = new Set<string>();
      clients.forEach((client, index) => {
        if (selected.has(client)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, index],
            message: `Client selector '${client}' is duplicated`,
          });
        } else if (
          !(allowWildcard && client === '*') &&
          !declaredClients.has(client as ClientType)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, index],
            message: `Client selector '${client}' is not declared by this profile`,
          });
        }
        selected.add(client);
      });
    };

    profile.plugins.forEach((plugin, index) => {
      if (typeof plugin !== 'string') {
        validateSelector(plugin.clients, ['plugins', index, 'clients']);
      }
    });

    if (profile.mcpServers) {
      for (const [serverName, server] of Object.entries(profile.mcpServers)) {
        validateSelector(server.clients, ['mcpServers', serverName, 'clients']);
      }
    }

    if (profile.mcpProxy) {
      validateSelector(profile.mcpProxy.clients, ['mcpProxy', 'clients']);
      if (profile.mcpProxy.servers) {
        for (const [serverName, server] of Object.entries(
          profile.mcpProxy.servers,
        )) {
          validateSelector(
            server.proxy,
            ['mcpProxy', 'servers', serverName, 'proxy'],
            true,
          );
        }
      }
    }
  });

export type ProfileDeclaration = z.infer<typeof ProfileDeclarationSchema>;

export const ProfilesSchema = z
  .record(ProfileNameSchema, ProfileDeclarationSchema)
  .superRefine((profiles, ctx) => {
    const launchers = new Map<string, string>();

    for (const [profileName, profile] of Object.entries(profiles)) {
      profile.clients.forEach((client, index) => {
        if (!client.launcher) return;

        const collisionKey = getLauncherCollisionKey(client.launcher);
        const previous = launchers.get(collisionKey);
        if (previous) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [profileName, 'clients', index, 'launcher'],
            message: `Launcher '${client.launcher}' collides with '${previous}' on a supported platform`,
          });
          return;
        }
        launchers.set(collisionKey, client.launcher);
      });
    }
  });

export type Profiles = z.infer<typeof ProfilesSchema>;

const SetupCommandTextSchema = z
  .string()
  .refine(
    (command) => command.trim().length > 0,
    'Setup command cannot be blank',
  );

export const SetupPlatformSchema = z.enum([
  'aix',
  'android',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'openbsd',
  'sunos',
  'win32',
  'cygwin',
  'netbsd',
]);

export const SetupArchitectureSchema = z.enum([
  'arm',
  'arm64',
  'ia32',
  'loong64',
  'mips',
  'mipsel',
  'ppc',
  'ppc64',
  'riscv64',
  's390',
  's390x',
  'x64',
]);

export const SetupCommandSchema = z.union([
  SetupCommandTextSchema,
  z
    .object({
      run: SetupCommandTextSchema,
      platforms: z.array(SetupPlatformSchema).min(1).optional(),
      architectures: z.array(SetupArchitectureSchema).min(1).optional(),
    })
    .strict(),
]);

export type SetupCommand = z.infer<typeof SetupCommandSchema>;

/**
 * Ordinary workspace configuration shared by user and project scopes.
 */
const WorkspaceConfigBaseSchema = z.object({
  version: z.number().optional(),
  /**
   * Shell commands run only by the explicit `allagents workspace setup` action.
   * String entries run everywhere; object entries can select Node platforms and
   * architectures. Sync and init must never run these commands automatically.
   */
  setup: z.array(SetupCommandSchema).optional(),
  workspace: WorkspaceSchema.optional(),
  repositories: z.array(RepositorySchema),
  plugins: z.array(PluginEntrySchema),
  clients: z.array(ClientEntrySchema),
  vscode: VscodeConfigSchema.optional(),
  syncMode: SyncModeSchema.optional(),
  mcpProxy: McpProxyConfigSchema.optional(),
  /**
   * Inline MCP server definitions. Merged with plugin-provided .mcp.json
   * servers during sync. Workspace-defined servers take precedence over
   * plugin-defined servers on name conflicts.
   */
  mcpServers: z.record(McpServerConfigSchema).optional(),
  /** @deprecated Use inline skills field on plugin entry instead. Will be removed in v3. */
  disabledSkills: z.array(z.string()).optional(),
  /** @deprecated Use inline skills field on plugin entry instead. Will be removed in v3. */
  enabledSkills: z.array(z.string()).optional(),
});

/**
 * Project workspaces never contain global profile declarations.
 */
export const ProjectWorkspaceConfigSchema = WorkspaceConfigBaseSchema.extend({
  profiles: z.never().optional(),
});

export type ProjectWorkspaceConfig = z.infer<typeof WorkspaceConfigBaseSchema>;

/**
 * User workspaces may consist only of profile declarations. Ordinary arrays
 * default empty so existing consumers retain their array-based contract.
 */
export const UserWorkspaceConfigSchema = WorkspaceConfigBaseSchema.extend({
  repositories: z.array(RepositorySchema).default([]),
  plugins: z.array(PluginEntrySchema).default([]),
  clients: z.array(ClientEntrySchema).default([]),
  profiles: ProfilesSchema.optional(),
});

export type UserWorkspaceConfig = z.infer<typeof UserWorkspaceConfigSchema>;

/**
 * Backward-compatible public alias for project workspace validation.
 */
export const WorkspaceConfigSchema = ProjectWorkspaceConfigSchema;
export type WorkspaceConfig = ProjectWorkspaceConfig;
