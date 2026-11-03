import { isAbsolute, join, resolve } from 'node:path';
import {
  CopilotProfileSettingsSchema,
  ProfileMcpServerConfigSchema,
  ProfileNameSchema,
} from '../../../models/workspace-config.js';
import {
  CopilotNativeClient,
  type NativeSourceResolution,
} from '../../native/index.js';
import { isGitHubUrl, parseGitHubUrl } from '../../../utils/plugin-path.js';
import { resolveCopilotProfileMetadata } from '../native-metadata.js';
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

const COPILOT_MINIMUM_VERSION = [1, 0, 74] as const;
const FILE_MAPPING = Object.freeze({
  skillsPath: 'skills/',
  agentsPath: 'agents/',
  hooksPath: 'hooks/',
  agentFile: 'copilot-instructions.md',
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

function assertCopilotContext(context: ProfileClientContext): void {
  const clientRoot = resolve(context.root, '..');
  const expectedCache = join(clientRoot, 'cache');
  if (
    context.client !== 'copilot' ||
    context.operationContext.client !== 'copilot' ||
    context.operationContext.nativeScope !== `profile:${context.profileName}` ||
    resolve(context.root) !== context.root ||
    context.operationContext.roots?.config !== clientRoot ||
    context.operationContext.roots?.cache !== expectedCache ||
    context.operationContext.env?.COPILOT_HOME !== context.root ||
    context.operationContext.env?.COPILOT_CACHE_HOME !== expectedCache
  ) {
    throw new Error(
      'Copilot profile adapter received a mismatched or non-absolute context',
    );
  }
}

function serializeCopilotMcp(
  input: ProfileSerializationInput,
  profile: string,
): Readonly<Record<string, unknown>> | null {
  const selected = serializeProfileMcpServers(input, 'copilot', profile);
  if (selected === null) return null;
  const mcpServers: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(selected)) {
    const server = ProfileMcpServerConfigSchema.parse(value);
    mcpServers[name] =
      'url' in server
        ? {
            type: 'http',
            url: server.url,
            ...(server.headers && { headers: server.headers }),
            tools: ['*'],
          }
        : {
            type: 'stdio',
            command: server.command,
            args: server.args ?? [],
            ...(server.env && { env: server.env }),
            tools: ['*'],
          };
  }
  return Object.freeze(mcpServers);
}

function copilotMarketplaceSetting(
  source: string,
): Readonly<Record<string, unknown>> {
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
        ...(parsed.branch && { ref: parsed.branch }),
        ...(parsed.subpath && { path: parsed.subpath }),
      },
    };
  }
  try {
    const url = new URL(source);
    return {
      source: {
        source: 'git',
        url: url.toString(),
      },
    };
  } catch {
    throw new Error(
      `Copilot marketplace registration source '${source}' cannot be serialized safely`,
    );
  }
}

export class CopilotProfileAdapter implements NativeProfileAdapter {
  readonly client = 'copilot' as const;
  readonly capabilities = CAPABILITIES;
  readonly nativeClient = new CopilotNativeClient({
    minimumVersion: COPILOT_MINIMUM_VERSION,
  });
  stepOrder(kind: ProfileStepKind, operation: ProfileOperationKind): number {
    const rank: Record<ProfileStepKind, number> =
      operation === 'remove'
        ? {
            launcher: 0,
            file: 1,
            settings: 1,
            mcp: 1,
            native: 2,
            marketplace: 3,
            root: 4,
          }
        : {
            root: 0,
            file: 1,
            settings: 2,
            mcp: 2,
            native: 3,
            marketplace: 4,
            launcher: 5,
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
    const clientRoot = join(
      homeDir,
      '.allagents',
      'profiles',
      profileName,
      'clients',
      'copilot',
    );
    const root = join(clientRoot, 'home');
    const cacheRoot = join(clientRoot, 'cache');
    const selectedEnvironment = Object.freeze({
      COPILOT_HOME: root,
      COPILOT_CACHE_HOME: cacheRoot,
      COPILOT_PROVIDERS_CONFIG: undefined,
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
        config: clientRoot,
        agent: root,
        cache: cacheRoot,
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
        command: 'copilot',
        args: Object.freeze([] as string[]),
        env: selectedEnvironment,
      }),
    });
  }

  async isRuntimeAvailable(context: ProfileClientContext): Promise<boolean> {
    assertCopilotContext(context);
    return this.nativeClient.isAvailable(context.operationContext);
  }

  resolveNativeMetadata(
    plugin: ProfileResolvedPlugin,
    context: ProfileClientContext,
    options: ProfileNativeMetadataOptions,
  ): Promise<ProfileResolvedPlugin> {
    assertCopilotContext(context);
    return resolveCopilotProfileMetadata(
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
    assertCopilotContext(context);
    if (plugin.install !== 'native') {
      return {
        success: false,
        error:
          'Copilot profile native source resolution requires install mode native',
      };
    }
    if (plugin.skills !== undefined) {
      return {
        success: false,
        error: 'Copilot native profile skill filtering is unsupported',
      };
    }
    if (plugin.requestedRef || plugin.resolvedRef) {
      return {
        success: false,
        error: `Copilot native marketplace installation cannot enforce ref '${plugin.requestedRef ?? plugin.resolvedRef}'`,
      };
    }
    if (!plugin.marketplace || !plugin.pluginName) {
      return {
        success: false,
        error: `Copilot marketplace source '${plugin.source}' requires authoritative marketplace and plugin metadata`,
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
    assertCopilotContext(context);
    if (!['create', 'update', 'remove'].includes(request.action)) return [];
    if (request.kind === 'marketplace') {
      const verb =
        request.action === 'create'
          ? 'add'
          : request.action === 'remove'
            ? 'remove'
            : 'update';
      return [
        {
          command: 'copilot',
          args: [
            'plugin',
            'marketplace',
            verb,
            request.action === 'create'
              ? request.registration.source
              : request.registration.name,
          ],
        },
      ];
    }
    const verb =
      request.action === 'create'
        ? 'install'
        : request.action === 'remove'
          ? 'uninstall'
          : 'update';
    return [
      {
        command: 'copilot',
        args: ['plugin', verb, request.resource.resolvedIdentity],
      },
    ];
  }

  inspectMarketplaceRegistration(
    marketplaceName: string,
    context: ProfileClientContext,
  ) {
    assertCopilotContext(context);
    return this.nativeClient.inspectMarketplaceRegistration(
      marketplaceName,
      context.operationContext,
    );
  }

  removeMarketplaceRegistration(
    marketplaceName: string,
    context: ProfileClientContext,
  ) {
    assertCopilotContext(context);
    return this.nativeClient.removeMarketplaceRegistration(
      marketplaceName,
      context.operationContext,
    );
  }

  serializeSettings(
    context: ProfileClientContext,
    input: ProfileSerializationInput,
  ): ProfilePlannedFile | null {
    assertCopilotContext(context);
    const settings = CopilotProfileSettingsSchema.parse(input.settings ?? {});
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
          copilotMarketplaceSetting(plugin.marketplaceSource),
        ]),
    );
    if (Object.keys(settings).length === 0 && nativePlugins.length === 0) {
      return null;
    }
    return Object.freeze({
      key: 'copilot:settings',
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
  ): ProfilePlannedFile | null {
    assertCopilotContext(context);
    const mcpServers = serializeCopilotMcp(input, context.profileName);
    if (mcpServers === null) return null;
    return Object.freeze({
      key: 'copilot:mcp',
      client: this.client,
      kind: 'mcp' as const,
      path: join(context.root, 'mcp-config.json'),
      content: `${JSON.stringify({ mcpServers }, null, 2)}\n`,
      mode: 0o600,
    });
  }
}

export const copilotProfileAdapter: NativeProfileAdapter = Object.freeze(
  new CopilotProfileAdapter(),
);
