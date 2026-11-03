import { isAbsolute, join, resolve } from 'node:path';
import {
  ClaudeProfileSettingsSchema,
  ProfileMcpServerConfigSchema,
  ProfileNameSchema,
} from '../../../models/workspace-config.js';
import {
  ClaudeNativeClient,
  type NativeSourceResolution,
} from '../../native/index.js';
import { isGitHubUrl, parseGitHubUrl } from '../../../utils/plugin-path.js';
import { resolveClaudeProfileMetadata } from '../native-metadata.js';
import type { ProfileOperationKind, ProfileStepKind } from '../index.js';
import type {
  NativeProfileAdapter,
  ProfileClientContext,
  ProfileContextOptions,
  ProfileNativeCommandRequest,
  ProfileNativeMetadataOptions,
  ProfilePlannedFile,
  ProfileResolvedPlugin,
  ProfileSerializationInput,
} from '../types.js';
import { serializeProfileMcpServers } from './mcp.js';

const CLAUDE_MINIMUM_VERSION = [2, 1, 268] as const;
const FILE_MAPPING = Object.freeze({
  commandsPath: 'commands/',
  skillsPath: 'skills/',
  agentsPath: 'agents/',
  hooksPath: 'hooks/',
  agentFile: 'CLAUDE.md',
});
const CAPABILITIES = Object.freeze({
  nativeInstall: true,
  fileInstall: true,
  launchers: true,
  skillFilters: true,
  mcp: true,
  settings: true,
  status: true,
  cleanup: true,
  recursiveRootCleanup: true,
});

function assertClaudeContext(context: ProfileClientContext): void {
  const pluginRoot = join(context.root, 'plugins');
  if (
    context.client !== 'claude' ||
    context.operationContext.client !== 'claude' ||
    context.operationContext.nativeScope !== `profile:${context.profileName}` ||
    resolve(context.root) !== context.root ||
    context.operationContext.env?.CLAUDE_CONFIG_DIR !== context.root ||
    context.operationContext.env?.CLAUDE_CODE_PLUGIN_CACHE_DIR !== pluginRoot ||
    context.operationContext.env?.CLAUDE_CODE_PLUGIN_SEED_DIR !== undefined ||
    context.operationContext.env?.CLAUDE_CODE_PROJECT_DIR_NAME !== undefined
  ) {
    throw new Error(
      'Claude profile adapter received a mismatched or non-absolute context',
    );
  }
}

function claudeMarketplaceSetting(
  plugin: ProfileResolvedPlugin,
): Readonly<Record<string, unknown>> {
  const source = plugin.marketplaceSource;
  if (!source) {
    throw new Error(
      `Claude marketplace '${plugin.marketplace ?? 'unknown'}' has no source`,
    );
  }
  if (isAbsolute(source)) {
    return {
      source: {
        source: 'directory',
        path: source,
      },
    };
  }
  const parsed = isGitHubUrl(source) ? parseGitHubUrl(source) : null;
  if (parsed) {
    return {
      source: {
        source: 'github',
        repo: `${parsed.owner}/${parsed.repo}`,
        ...((plugin.resolvedRef ?? parsed.branch) && {
          ref: plugin.resolvedRef ?? parsed.branch,
        }),
      },
    };
  }
  try {
    const url = new URL(source);
    return {
      source: {
        source: 'url',
        url: url.toString(),
        ...(plugin.resolvedRef && { ref: plugin.resolvedRef }),
      },
    };
  } catch {
    throw new Error(
      `Claude marketplace registration source '${source}' cannot be serialized safely`,
    );
  }
}

function serializeClaudeMcp(
  input: ProfileSerializationInput,
  profile: string,
): Readonly<Record<string, unknown>> {
  const selected = serializeProfileMcpServers(input, 'claude', profile) ?? {};
  const servers: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(selected)) {
    const server = ProfileMcpServerConfigSchema.parse(value);
    servers[name] =
      'url' in server
        ? {
            type: 'http',
            url: server.url,
            ...(server.headers && { headers: server.headers }),
          }
        : {
            type: 'stdio',
            command: server.command,
            ...(server.args && { args: server.args }),
            ...(server.env && { env: server.env }),
          };
  }
  return Object.freeze(servers);
}

export class ClaudeProfileAdapter implements NativeProfileAdapter {
  readonly client = 'claude' as const;
  readonly capabilities = CAPABILITIES;
  readonly nativeClient = new ClaudeNativeClient({
    minimumVersion: CLAUDE_MINIMUM_VERSION,
  });
  stepOrder(kind: ProfileStepKind, operation: ProfileOperationKind): number {
    const rank: Record<ProfileStepKind, number> =
      operation === 'remove'
        ? {
            launcher: 0,
            native: 1,
            marketplace: 2,
            file: 3,
            settings: 3,
            mcp: 3,
            root: 4,
          }
        : {
            root: 0,
            file: 1,
            native: 2,
            marketplace: 3,
            settings: 4,
            mcp: 5,
            launcher: 6,
          };
    return rank[kind];
  }

  resolveContext(
    profileName: string,
    options: ProfileContextOptions,
  ): ProfileClientContext {
    ProfileNameSchema.parse(profileName);
    const homeDir = resolve(options.homeDir);
    const workspaceDirectory = resolve(options.workspaceDirectory);
    const root = join(
      homeDir,
      '.allagents',
      'profiles',
      profileName,
      'clients',
      'claude',
      'config',
    );
    const pluginRoot = join(root, 'plugins');
    const settingsPath = join(root, 'settings.json');
    const mcpPath = join(root, 'allagents.mcp.json');
    const selectedEnvironment = Object.freeze({
      CLAUDE_CONFIG_DIR: root,
      CLAUDE_CODE_PLUGIN_CACHE_DIR: pluginRoot,
      CLAUDE_CODE_PLUGIN_SEED_DIR: undefined,
      CLAUDE_CODE_PROJECT_DIR_NAME: undefined,
    });
    const operationContext = Object.freeze({
      client: this.client,
      scope: 'user' as const,
      nativeScope: `profile:${profileName}`,
      root,
      cwd: workspaceDirectory,
      env: Object.freeze({
        ...options.environment,
        ...selectedEnvironment,
      }),
      roots: Object.freeze({
        config: root,
        agent: root,
        data: root,
        plugins: pluginRoot,
      }),
    });
    return Object.freeze({
      profileName,
      client: this.client,
      mechanism: 'configuration-root',
      root,
      operationContext,
      fileMapping: FILE_MAPPING,
      launcher: Object.freeze({
        command: 'claude',
        args: Object.freeze(['--mcp-config', mcpPath]),
        env: selectedEnvironment,
        requiredFiles: Object.freeze([settingsPath, mcpPath]),
      }),
    });
  }

  async isRuntimeAvailable(context: ProfileClientContext): Promise<boolean> {
    assertClaudeContext(context);
    return this.nativeClient.isAvailable(context.operationContext);
  }

  resolveNativeMetadata(
    plugin: ProfileResolvedPlugin,
    context: ProfileClientContext,
    options: ProfileNativeMetadataOptions,
  ): Promise<ProfileResolvedPlugin> {
    assertClaudeContext(context);
    return resolveClaudeProfileMetadata(
      plugin,
      context,
      options,
      this.nativeClient,
    );
  }

  resolveNativeSource(
    plugin: ProfileResolvedPlugin,
    context: ProfileClientContext,
  ): NativeSourceResolution {
    assertClaudeContext(context);
    if (plugin.install !== 'native') {
      return {
        success: false,
        error:
          'Claude profile native source resolution requires install mode native',
      };
    }
    if (plugin.skills !== undefined) {
      return {
        success: false,
        error: 'Claude native profile skill filtering is unsupported',
      };
    }
    if (plugin.marketplaceSparsePath) {
      return {
        success: false,
        error:
          'Claude native profile marketplaces cannot declaratively preserve sparse paths; use file install',
      };
    }
    if (!plugin.marketplace || !plugin.pluginName) {
      return {
        success: false,
        error:
          'Claude native profile installation requires authoritative marketplace metadata',
      };
    }
    const resolved = this.nativeClient.resolveSource(
      `${plugin.pluginName}@${plugin.marketplace}`,
      context.operationContext,
      {
        declarationIndex: String(plugin.declarationIndex),
        marketplaceName: plugin.marketplace,
        ...(plugin.marketplaceSource && {
          marketplaceSource: plugin.marketplaceSource,
        }),
        ...(plugin.marketplaceRegistrationManaged && {
          managedMarketplaceRegistration: 'true',
        }),
        ...(plugin.requestedRef && { requestedRef: plugin.requestedRef }),
        ...(plugin.resolvedRef && { resolvedRef: plugin.resolvedRef }),
        ...(plugin.resolvedSha && { resolvedSha: plugin.resolvedSha }),
      },
    );
    if (!resolved.resource) return resolved;
    return {
      ...resolved,
      resource: {
        ...resolved.resource,
        requestedIdentity: plugin.source,
      },
    };
  }

  discloseNativeCommands(
    request: ProfileNativeCommandRequest,
    context: ProfileClientContext,
  ) {
    assertClaudeContext(context);
    if (!['create', 'update', 'remove'].includes(request.action)) return [];
    if (request.kind === 'marketplace') {
      if (request.action === 'create') {
        return [
          {
            command: 'claude',
            args: [
              'plugin',
              'marketplace',
              'add',
              request.registration.source,
              '--scope',
              'user',
            ],
          },
        ];
      }
      if (request.action === 'remove') {
        return [
          {
            command: 'claude',
            args: [
              'plugin',
              'marketplace',
              'remove',
              request.registration.name,
              '--scope',
              'user',
            ],
          },
        ];
      }
      return [
        {
          command: 'claude',
          args: ['plugin', 'marketplace', 'update', request.registration.name],
        },
      ];
    }

    const commands = [];
    const marketplaceName = request.resource.provenance.marketplaceName;
    const marketplaceSource = request.resource.provenance.marketplaceSource;
    if (
      request.action === 'create' &&
      marketplaceSource &&
      request.resource.provenance.managedMarketplaceRegistration === 'true'
    ) {
      const sourceArgument =
        request.resource.provenance.resolvedRef &&
        /^[^/:]+\/[^/]+$/.test(marketplaceSource)
          ? `${marketplaceSource}@${request.resource.provenance.resolvedRef}`
          : marketplaceSource;
      commands.push({
        command: 'claude',
        args: [
          'plugin',
          'marketplace',
          'add',
          sourceArgument,
          '--scope',
          'user',
        ],
      });
    } else if (
      request.action === 'update' &&
      marketplaceSource &&
      marketplaceName
    ) {
      commands.push({
        command: 'claude',
        args: ['plugin', 'marketplace', 'update', marketplaceName],
      });
    }

    const verb =
      request.action === 'create'
        ? 'install'
        : request.action === 'remove'
          ? 'uninstall'
          : 'update';
    commands.push({
      command: 'claude',
      args: [
        'plugin',
        verb,
        request.resource.resolvedIdentity,
        '--scope',
        'user',
        '--yes',
        '--json',
      ],
    });
    return commands;
  }

  inspectMarketplaceRegistration(
    marketplaceName: string,
    context: ProfileClientContext,
  ) {
    assertClaudeContext(context);
    return this.nativeClient.inspectMarketplaceRegistration(
      marketplaceName,
      context.operationContext,
    );
  }

  removeMarketplaceRegistration(
    marketplaceName: string,
    context: ProfileClientContext,
  ) {
    assertClaudeContext(context);
    return this.nativeClient.removeMarketplaceRegistration(
      marketplaceName,
      context.operationContext,
    );
  }

  serializeSettings(
    context: ProfileClientContext,
    input: ProfileSerializationInput,
  ): ProfilePlannedFile {
    assertClaudeContext(context);
    const settings = ClaudeProfileSettingsSchema.parse(input.settings ?? {});
    const nativePlugins = input.plugins
      .filter(
        (plugin) =>
          plugin.install === 'native' &&
          plugin.marketplace !== undefined &&
          plugin.pluginName !== undefined,
      )
      .sort((left, right) =>
        `${left.pluginName}@${left.marketplace}`.localeCompare(
          `${right.pluginName}@${right.marketplace}`,
        ),
      );
    const enabledPlugins = Object.fromEntries(
      nativePlugins.map((plugin) => [
        `${plugin.pluginName}@${plugin.marketplace}`,
        true,
      ]),
    );
    const extraKnownMarketplaces = Object.fromEntries(
      nativePlugins
        .filter(
          (
            plugin,
          ): plugin is ProfileResolvedPlugin & { marketplaceSource: string } =>
            plugin.marketplaceSource !== undefined,
        )
        .map((plugin) => [
          plugin.marketplace,
          claudeMarketplaceSetting(plugin),
        ]),
    );
    return Object.freeze({
      key: 'claude:settings',
      client: this.client,
      kind: 'settings' as const,
      path: join(context.root, 'settings.json'),
      content: `${JSON.stringify(
        {
          ...settings,
          ...(Object.keys(extraKnownMarketplaces).length > 0 && {
            extraKnownMarketplaces,
          }),
          ...(Object.keys(enabledPlugins).length > 0 && { enabledPlugins }),
        },
        null,
        2,
      )}\n`,
      mode: 0o600,
    });
  }

  serializeMcp(
    context: ProfileClientContext,
    input: ProfileSerializationInput,
  ): ProfilePlannedFile {
    assertClaudeContext(context);
    const mcpServers = serializeClaudeMcp(input, context.profileName);
    return Object.freeze({
      key: 'claude:mcp',
      client: this.client,
      kind: 'mcp' as const,
      path: join(context.root, 'allagents.mcp.json'),
      content: `${JSON.stringify({ mcpServers }, null, 2)}\n`,
      mode: 0o600,
    });
  }
}

export const claudeProfileAdapter = Object.freeze(new ClaudeProfileAdapter());
