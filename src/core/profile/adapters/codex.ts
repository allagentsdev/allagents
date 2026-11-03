import { isAbsolute, join, resolve } from 'node:path';
import {
  CodexProfileSettingsSchema,
  ProfileMcpServerConfigSchema,
  ProfileNameSchema,
} from '../../../models/workspace-config.js';
import {
  CodexNativeClient,
  type NativeSourceResolution,
} from '../../native/index.js';
import { resolveCodexProfileMetadata } from '../native-metadata.js';
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

const CODEX_MINIMUM_VERSION = [0, 149, 0] as const;
const FILE_MAPPING = Object.freeze({
  skillsPath: 'skills/',
  agentFile: 'AGENTS.md',
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
const SECRET_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const POSSIBLE_REFERENCE = /\$\{[^}]+\}/;
const BARE_TOML_KEY = /^[A-Za-z0-9_-]+$/;

type TomlValue = string | number | boolean | readonly string[] | TomlTable;
interface TomlTable {
  readonly [key: string]: TomlValue;
}

function assertCodexContext(context: ProfileClientContext): void {
  if (
    context.client !== 'codex' ||
    context.operationContext.client !== 'codex' ||
    context.operationContext.nativeScope !== `profile:${context.profileName}` ||
    resolve(context.root) !== context.root ||
    context.operationContext.env?.CODEX_HOME !== context.root
  ) {
    throw new Error(
      'Codex profile adapter received a mismatched or non-absolute context',
    );
  }
}

function tomlKey(value: string): string {
  return BARE_TOML_KEY.test(value) ? value : JSON.stringify(value);
}

function tomlScalar(value: Exclude<TomlValue, TomlTable>): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return `[${value.map((entry) => JSON.stringify(entry)).join(', ')}]`;
}

function isTomlTable(value: TomlValue): value is TomlTable {
  return typeof value === 'object' && !Array.isArray(value);
}

function renderTomlTable(
  table: TomlTable,
  path: readonly string[] = [],
): string[] {
  const lines: string[] = [];
  const entries = Object.entries(table).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const scalars = entries.filter(([, value]) => !isTomlTable(value));
  const children = entries.filter(([, value]) => isTomlTable(value));

  if (path.length > 0 && (scalars.length > 0 || children.length === 0)) {
    lines.push(`[${path.map(tomlKey).join('.')}]`);
  }
  for (const [key, value] of scalars) {
    lines.push(
      `${tomlKey(key)} = ${tomlScalar(value as Exclude<TomlValue, TomlTable>)}`,
    );
  }
  for (const [key, value] of children) {
    const childLines = renderTomlTable(value as TomlTable, [...path, key]);
    if (childLines.length === 0) continue;
    if (lines.length > 0) lines.push('');
    lines.push(...childLines);
  }
  return lines;
}

function referenceName(value: string): string | null {
  return SECRET_REFERENCE.exec(value)?.[1] ?? null;
}

function rejectUnsupportedReference(value: string, field: string): void {
  if (POSSIBLE_REFERENCE.test(value)) {
    throw new Error(
      `Codex profile ${field} cannot interpolate portable secret references`,
    );
  }
}

function serializeCodexMcp(
  input: ProfileSerializationInput,
  profile: string,
): Readonly<Record<string, TomlTable>> | null {
  const selected = serializeProfileMcpServers(input, 'codex', profile);
  if (selected === null) return null;
  const servers: Record<string, TomlTable> = {};
  for (const [name, value] of Object.entries(selected)) {
    const server = ProfileMcpServerConfigSchema.parse(value);
    if ('url' in server) {
      rejectUnsupportedReference(server.url, `MCP server '${name}' URL`);
      const envHttpHeaders: Record<string, string> = {};
      for (const [header, headerValue] of Object.entries(
        server.headers ?? {},
      )) {
        const environmentName = referenceName(headerValue);
        if (!environmentName) {
          throw new Error(
            `Codex profile MCP server '${name}' header '${header}' requires an exact portable secret reference`,
          );
        }
        envHttpHeaders[header] = environmentName;
      }
      servers[name] = {
        url: server.url,
        ...(Object.keys(envHttpHeaders).length > 0 && {
          env_http_headers: envHttpHeaders,
        }),
      };
      continue;
    }

    rejectUnsupportedReference(server.command, `MCP server '${name}' command`);
    for (const argument of server.args ?? []) {
      rejectUnsupportedReference(argument, `MCP server '${name}' arguments`);
    }
    const forwardedEnvironment: string[] = [];
    for (const [key, envValue] of Object.entries(server.env ?? {})) {
      const environmentName = referenceName(envValue);
      if (!environmentName) {
        throw new Error(
          `Codex profile MCP server '${name}' environment '${key}' requires an exact portable secret reference`,
        );
      }
      if (environmentName !== key) {
        throw new Error(
          `Codex profile MCP server '${name}' cannot remap \${${environmentName}} to '${key}'`,
        );
      }
      forwardedEnvironment.push(environmentName);
    }
    servers[name] = {
      command: server.command,
      ...(server.args && { args: server.args }),
      ...(forwardedEnvironment.length > 0 && {
        env_vars: forwardedEnvironment.sort(),
      }),
    };
  }
  return Object.freeze(servers);
}

export class CodexProfileAdapter implements NativeProfileAdapter {
  readonly client = 'codex' as const;
  readonly capabilities = CAPABILITIES;
  readonly nativeClient = new CodexNativeClient({
    minimumVersion: CODEX_MINIMUM_VERSION,
  });

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
      'codex',
      'home',
    );
    const selectedEnvironment = Object.freeze({ CODEX_HOME: root });
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
      roots: Object.freeze({ config: root, agent: root, data: root }),
    });
    return Object.freeze({
      profileName,
      client: this.client,
      mechanism: 'isolated-home-named-profile',
      root,
      operationContext,
      fileMapping: FILE_MAPPING,
      launcher: Object.freeze({
        command: 'codex',
        args: Object.freeze(['--profile', profileName]),
        env: selectedEnvironment,
        requiredFiles: Object.freeze([
          join(root, `${profileName}.config.toml`),
        ]),
      }),
    });
  }

  async isRuntimeAvailable(context: ProfileClientContext): Promise<boolean> {
    assertCodexContext(context);
    return this.nativeClient.isAvailable(context.operationContext);
  }

  resolveNativeMetadata(
    plugin: ProfileResolvedPlugin,
    context: ProfileClientContext,
    options: ProfileNativeMetadataOptions,
  ): Promise<ProfileResolvedPlugin> {
    assertCodexContext(context);
    return resolveCodexProfileMetadata(
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
    assertCodexContext(context);
    if (plugin.install !== 'native') {
      return {
        success: false,
        error:
          'Codex profile native source resolution requires install mode native',
      };
    }
    if (plugin.skills !== undefined) {
      return {
        success: false,
        error:
          'Codex native profile skill filtering cannot be enforced exactly',
      };
    }
    if (!plugin.marketplace || !plugin.pluginName) {
      return {
        success: false,
        error:
          'Codex native profile installation requires authoritative marketplace metadata',
      };
    }
    return this.nativeClient.resolveSource(
      `${plugin.pluginName}@${plugin.marketplace}`,
      context.operationContext,
      {
        declarationIndex: String(plugin.declarationIndex),
        marketplaceName: plugin.marketplace,
        ...(plugin.marketplaceSource && {
          marketplaceSource: plugin.marketplaceSource,
        }),
        ...(plugin.marketplaceSparsePath && {
          marketplaceSparsePath: plugin.marketplaceSparsePath,
        }),
        ...(plugin.marketplaceRegistrationManaged !== undefined && {
          managedMarketplaceRegistration: String(
            plugin.marketplaceRegistrationManaged,
          ),
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
    assertCodexContext(context);
    if (!['create', 'update', 'remove'].includes(request.action)) return [];
    if (request.kind === 'marketplace') {
      if (request.action === 'remove') {
        return [
          {
            command: 'codex',
            args: [
              'plugin',
              'marketplace',
              'remove',
              request.registration.name,
              '--json',
            ],
          },
        ];
      }
      const verb = request.action === 'create' ? 'add' : 'upgrade';
      return [
        {
          command: 'codex',
          args: [
            'plugin',
            'marketplace',
            verb,
            request.action === 'create'
              ? request.registration.source
              : request.registration.name,
            '--json',
          ],
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
      const args = ['plugin', 'marketplace', 'add', marketplaceSource];
      if (request.resource.provenance.resolvedRef) {
        args.push('--ref', request.resource.provenance.resolvedRef);
      }
      if (request.resource.provenance.marketplaceSparsePath) {
        args.push(
          '--sparse',
          request.resource.provenance.marketplaceSparsePath,
        );
      }
      args.push('--json');
      commands.push({ command: 'codex', args });
    } else if (
      request.action === 'update' &&
      marketplaceName &&
      marketplaceSource &&
      !isAbsolute(marketplaceSource)
    ) {
      commands.push({
        command: 'codex',
        args: ['plugin', 'marketplace', 'upgrade', marketplaceName, '--json'],
      });
    }

    const verb = request.action === 'remove' ? 'remove' : 'add';
    commands.push({
      command: 'codex',
      args: ['plugin', verb, request.resource.resolvedIdentity, '--json'],
    });
    return commands;
  }

  inspectMarketplaceRegistration(
    marketplaceName: string,
    context: ProfileClientContext,
  ) {
    assertCodexContext(context);
    return this.nativeClient.inspectMarketplaceRegistration(
      marketplaceName,
      context.operationContext,
    );
  }

  removeMarketplaceRegistration(
    marketplaceName: string,
    context: ProfileClientContext,
  ) {
    assertCodexContext(context);
    return this.nativeClient.removeMarketplaceRegistration(
      marketplaceName,
      context.operationContext,
    );
  }

  serializeSettings(
    context: ProfileClientContext,
    input: ProfileSerializationInput,
  ): ProfilePlannedFile | null {
    assertCodexContext(context);
    const settings = CodexProfileSettingsSchema.parse(input.settings ?? {});
    const mcpServers = serializeCodexMcp(input, context.profileName);
    const document: TomlTable = {
      ...(settings as TomlTable),
      ...(mcpServers && { mcp_servers: mcpServers }),
    };
    return Object.freeze({
      key: 'codex:profile-config',
      client: this.client,
      kind: 'settings' as const,
      path: join(context.root, `${context.profileName}.config.toml`),
      content: `${renderTomlTable(document).join('\n')}\n`,
      mode: 0o600,
    });
  }

  serializeMcp(
    context: ProfileClientContext,
    _input: ProfileSerializationInput,
  ): ProfilePlannedFile | null {
    assertCodexContext(context);
    // Codex stores settings and MCP declarations in one named profile file.
    return null;
  }
}

export const codexProfileAdapter: NativeProfileAdapter = Object.freeze(
  new CodexProfileAdapter(),
);
