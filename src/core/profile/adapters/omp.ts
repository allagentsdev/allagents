import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ProfileNameSchema } from '../../../models/workspace-config.js';
import {
  OmpNativeClient,
  inspectOmpMarketplaceRegistry,
  ompProfileNativeScope,
  parseOmpPluginId,
  resolveOmpMarketplacePluginSource,
} from '../../native/index.js';
import { resolveOmpProfileMetadata } from '../native-metadata.js';
import type { NativeSourceResolution } from '../../native/types.js';
import type {
  NativeProfileAdapter,
  ProfileClientContext,
  ProfileContextOptions,
  ProfileMarketplaceRegistration,
  ProfileNativeCommandRequest,
  ProfileNativeMetadataOptions,
  ProfilePlannedFile,
  ProfileResolvedPlugin,
  ProfileSerializationInput,
} from '../types.js';
import { serializeProfileMcpServers } from './mcp.js';

const FILE_MAPPING = Object.freeze({
  skillsPath: 'skills/',
  hooksPath: 'hooks/',
  agentFile: 'AGENTS.md',
});
const CAPABILITIES = Object.freeze({
  nativeInstall: true,
  fileInstall: true,
  launchers: true,
  skillFilters: false,
  mcp: true,
  settings: false,
  status: true,
  cleanup: true,
  recursiveRootCleanup: true,
});
const MCP_SCHEMA_URL =
  'https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json';

function assertOmpContext(context: ProfileClientContext): void {
  if (
    context.client !== 'omp' ||
    context.operationContext.client !== 'omp' ||
    context.operationContext.nativeScope !== `profile:${context.profileName}` ||
    resolve(context.root) !== context.root ||
    resolve(context.operationContext.root) !== context.root
  ) {
    throw new Error(
      'OMP profile adapter received a mismatched or non-absolute context',
    );
  }
}

export class OmpProfileAdapter implements NativeProfileAdapter {
  readonly client = 'omp' as const;
  readonly capabilities = CAPABILITIES;
  readonly nativeClient = new OmpNativeClient();

  resolveContext(
    profileName: string,
    options: ProfileContextOptions,
  ): ProfileClientContext {
    ProfileNameSchema.parse(profileName);
    ompProfileNativeScope(profileName);
    const homeDir = resolve(options.homeDir);
    const workspaceDirectory = resolve(options.workspaceDirectory);
    const environmentInput = { ...options.environment };
    const configDir = environmentInput.PI_CONFIG_DIR || '.omp';
    const configRoot = join(homeDir, configDir);
    const profileRoot = join(configRoot, 'profiles', profileName);
    const root = join(profileRoot, 'agent');
    const platform = options.platform ?? process.platform;
    const xdgEnabled = platform === 'linux' || platform === 'darwin';
    const xdgProfileRoot = (
      category: 'DATA' | 'STATE' | 'CACHE',
    ): string | undefined => {
      if (!xdgEnabled) return undefined;
      const configured = environmentInput[`XDG_${category}_HOME`];
      if (!configured || !isAbsolute(configured)) return undefined;
      const candidate = join(configured, 'omp', 'profiles', profileName);
      return existsSync(candidate) ? candidate : undefined;
    };
    const data = xdgProfileRoot('DATA');
    const state = xdgProfileRoot('STATE');
    const cache = xdgProfileRoot('CACHE');
    const roots = Object.freeze({
      config: profileRoot,
      agent: root,
      data: data ?? profileRoot,
      state: state ?? profileRoot,
      cache: cache ?? profileRoot,
      dataAgent: data ?? root,
      stateAgent: state ?? root,
      cacheAgent: cache ?? root,
    });
    const selectedEnvironment = {
      HOME: homeDir,
      USERPROFILE: homeDir,
      PI_CONFIG_DIR: configDir,
      XDG_DATA_HOME: data ? environmentInput.XDG_DATA_HOME : undefined,
      XDG_STATE_HOME: state ? environmentInput.XDG_STATE_HOME : undefined,
      XDG_CACHE_HOME: cache ? environmentInput.XDG_CACHE_HOME : undefined,
      OMP_PROFILE: undefined,
      PI_PROFILE: undefined,
      PI_CODING_AGENT_DIR: undefined,
      PI_CONFIG_FILES: undefined,
    };
    const environment = Object.freeze({
      ...environmentInput,
      ...selectedEnvironment,
    });
    const launcherEnv = Object.freeze(selectedEnvironment);
    const operationContext = Object.freeze({
      client: 'omp',
      scope: 'user' as const,
      nativeScope: ompProfileNativeScope(profileName),
      root,
      cwd: workspaceDirectory,
      env: environment,
      roots,
    });
    const launcher = Object.freeze({
      command: 'omp',
      args: Object.freeze(['--profile', profileName]),
      env: launcherEnv,
    });
    return Object.freeze({
      profileName,
      client: this.client,
      mechanism: 'named-profile',
      root,
      operationContext,
      fileMapping: FILE_MAPPING,
      launcher,
    });
  }

  resolveNativeMetadata(
    plugin: ProfileResolvedPlugin,
    context: ProfileClientContext,
    options: ProfileNativeMetadataOptions,
  ): Promise<ProfileResolvedPlugin> {
    assertOmpContext(context);
    return resolveOmpProfileMetadata(plugin, context, options);
  }

  resolveNativeSource(
    plugin: ProfileResolvedPlugin,
    context: ProfileClientContext,
  ): NativeSourceResolution {
    assertOmpContext(context);
    if (plugin.install !== 'native') {
      return {
        success: false,
        error:
          'OMP profile native source resolution requires install mode native',
      };
    }
    if (plugin.skills !== undefined) {
      return {
        success: false,
        error: 'OMP native profile skill filtering is unsupported',
      };
    }
    if (parseOmpPluginId(plugin.source)) {
      if (plugin.requestedRef || plugin.resolvedRef) {
        return {
          success: false,
          error: `OMP plugin identity '${plugin.source}' cannot enforce a marketplace ref`,
        };
      }
      return this.nativeClient.resolveSource(
        plugin.source,
        context.operationContext,
        {
          declarationIndex: String(plugin.declarationIndex),
          ...(plugin.marketplace && { marketplaceName: plugin.marketplace }),
          ...(plugin.marketplaceSource && {
            marketplaceSource: plugin.marketplaceSource,
          }),
          ...(plugin.marketplaceRegistrationManaged && {
            managedMarketplaceRegistration: 'true',
          }),
        },
      );
    }
    if (plugin.requestedRef && plugin.resolvedRef !== plugin.requestedRef) {
      return {
        success: false,
        error: `OMP marketplace requested ref '${plugin.requestedRef}' resolved as '${plugin.resolvedRef ?? 'unknown'}'`,
      };
    }
    const resolvedRef = plugin.resolvedRef ?? plugin.requestedRef;
    if (resolvedRef && resolvedRef !== 'main') {
      return {
        success: false,
        error: `OMP CLI cannot enforce marketplace ref '${resolvedRef}'; only the canonical GitHub ref 'main' is supported`,
      };
    }
    if (resolvedRef && !plugin.resolvedSha) {
      return {
        success: false,
        error: `OMP marketplace ref '${resolvedRef}' has no authoritative resolved revision`,
      };
    }
    if (!plugin.marketplace || !plugin.pluginName) {
      return {
        success: false,
        error: `OMP marketplace source '${plugin.source}' requires authoritative marketplace and plugin metadata`,
      };
    }
    const cacheRoot = join(
      context.operationContext.env?.HOME ?? '',
      '.allagents',
      'plugins',
      'marketplaces',
    );
    const candidate = plugin.path ? resolve(plugin.path) : undefined;
    const cacheRelative = candidate
      ? relative(cacheRoot, candidate)
      : undefined;
    const stableCachedSource =
      candidate &&
      cacheRelative !== undefined &&
      cacheRelative !== '..' &&
      !cacheRelative.startsWith(`..${sep}`) &&
      !isAbsolute(cacheRelative)
        ? candidate
        : undefined;
    return resolveOmpMarketplacePluginSource(
      stableCachedSource ?? plugin.source,
      {
        name: plugin.marketplace,
        owner: { name: 'resolved' },
        plugins: [{ name: plugin.pluginName, source: './resolved-plugin' }],
      },
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
  }

  discloseNativeCommands(
    request: ProfileNativeCommandRequest,
    context: ProfileClientContext,
  ) {
    assertOmpContext(context);
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
          command: 'omp',
          args: [
            '--profile',
            context.profileName,
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
          : 'upgrade';
    return [
      {
        command: 'omp',
        args: [
          '--profile',
          context.profileName,
          'plugin',
          verb,
          '--scope',
          'user',
          request.resource.resolvedIdentity,
        ],
      },
    ];
  }

  applyMarketplaceRegistration(
    registration: ProfileMarketplaceRegistration,
    context: ProfileClientContext,
  ) {
    assertOmpContext(context);
    return this.nativeClient.registerMarketplace(
      registration,
      context.operationContext,
    );
  }

  async inspectMarketplaceRegistration(
    marketplaceName: string,
    context: ProfileClientContext,
  ) {
    assertOmpContext(context);
    const inspection = await inspectOmpMarketplaceRegistry(
      context.operationContext,
      { allowMissing: true },
    );
    return {
      success: inspection.success,
      present:
        inspection.success &&
        inspection.marketplaces.some(({ name }) => name === marketplaceName),
      ...(inspection.error && { error: inspection.error }),
    };
  }

  removeMarketplaceRegistration(
    marketplaceName: string,
    context: ProfileClientContext,
  ) {
    assertOmpContext(context);
    return this.nativeClient.removeMarketplaceRegistration(
      marketplaceName,
      context.operationContext,
    );
  }

  serializeSettings(
    context: ProfileClientContext,
    input: ProfileSerializationInput,
  ): ProfilePlannedFile | null {
    assertOmpContext(context);
    if (input.settings && Object.keys(input.settings).length > 0) {
      throw new Error('OMP profile adapter does not support settings');
    }
    return null;
  }

  serializeMcp(
    context: ProfileClientContext,
    input: ProfileSerializationInput,
  ): ProfilePlannedFile | null {
    assertOmpContext(context);
    const mcpServers = serializeProfileMcpServers(input, this.client, context.profileName);
    if (mcpServers === null) return null;
    return Object.freeze({
      key: 'omp:mcp',
      client: this.client,
      kind: 'mcp' as const,
      path: join(context.root, 'mcp.json'),
      content: `${JSON.stringify({ $schema: MCP_SCHEMA_URL, mcpServers }, null, 2)}\n`,
      mode: 0o600,
    });
  }
}

export const ompProfileAdapter: NativeProfileAdapter = Object.freeze(
  new OmpProfileAdapter(),
);
