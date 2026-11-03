import { join, resolve } from 'node:path';
import { ProfileNameSchema } from '../../../models/workspace-config.js';
import {
  PiNativeClient,
  inspectPiMcpAdapter,
  type PiMcpAdapterInspection,
} from '../../native/index.js';
import type {
  NativeResource,
  NativeSourceResolution,
} from '../../native/types.js';
import type {
  NativeProfileAdapter,
  ProfileClientContext,
  ProfileContextOptions,
  ProfileNativeCommandRequest,
  ProfilePlannedFile,
  ProfileResolvedPlugin,
  ProfileSerializationInput,
} from '../types.js';
import { serializeProfileMcpServers } from './mcp.js';

const FILE_MAPPING = Object.freeze({
  skillsPath: 'skills/',
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

function assertPiContext(context: ProfileClientContext): void {
  if (
    context.client !== 'pi' ||
    context.operationContext.client !== 'pi' ||
    context.operationContext.nativeScope !== `profile:${context.profileName}` ||
    resolve(context.root) !== context.root ||
    resolve(context.operationContext.root) !== context.root
  ) {
    throw new Error(
      'Pi profile adapter received a mismatched or non-absolute context',
    );
  }
}

export class PiProfileAdapter implements NativeProfileAdapter {
  readonly client = 'pi' as const;
  readonly capabilities = CAPABILITIES;
  readonly nativeClient = new PiNativeClient();
  readonly mcpPrerequisite = Object.freeze({
    matches(resource: NativeResource): boolean {
      return (
        resource.provenance.packageIdentity === 'npm:pi-mcp-adapter' ||
        resource.resolvedIdentity === 'npm:pi-mcp-adapter'
      );
    },
    inspect: (context: ProfileClientContext) => this.inspectMcpAdapter(context),
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
      'pi',
      'agent',
    );
    const environment = Object.freeze({
      ...options.environment,
      PI_CODING_AGENT_DIR: root,
    });
    const launcherEnv = Object.freeze({ PI_CODING_AGENT_DIR: root });
    const operationContext = Object.freeze({
      client: 'pi',
      scope: 'user' as const,
      nativeScope: `profile:${profileName}`,
      root,
      cwd: workspaceDirectory,
      env: environment,
      roots: Object.freeze({ agent: root }),
    });
    const launcher = Object.freeze({
      command: 'pi',
      args: Object.freeze([] as string[]),
      env: launcherEnv,
    });
    return Object.freeze({
      profileName,
      client: this.client,
      mechanism: 'agent-directory',
      root,
      operationContext,
      fileMapping: FILE_MAPPING,
      launcher,
    });
  }

  resolveNativeSource(
    plugin: ProfileResolvedPlugin,
    context: ProfileClientContext,
  ): NativeSourceResolution {
    assertPiContext(context);
    if (plugin.install !== 'native') {
      return {
        success: false,
        error:
          'Pi profile native source resolution requires install mode native',
      };
    }
    if (plugin.skills !== undefined) {
      return {
        success: false,
        error: 'Pi native profile skill filtering cannot be enforced exactly',
      };
    }
    const resolved = this.nativeClient.resolveSource(
      plugin.source,
      context.operationContext,
      {
        declarationIndex: String(plugin.declarationIndex),
        ...(plugin.resolvedSha && { resolvedSha: plugin.resolvedSha }),
      },
    );
    if (
      !resolved.success &&
      /:\/\//.test(plugin.source) &&
      /@/.test(plugin.source)
    ) {
      return {
        success: false,
        error: 'Pi native source is invalid or credential-bearing',
      };
    }
    return resolved;
  }

  discloseNativeCommands(
    request: ProfileNativeCommandRequest,
    context: ProfileClientContext,
  ) {
    assertPiContext(context);
    if (
      request.kind !== 'native' ||
      !['create', 'update', 'remove'].includes(request.action)
    ) {
      return [];
    }
    const verb =
      request.action === 'create'
        ? 'install'
        : request.action === 'remove'
          ? 'remove'
          : 'update';
    return [
      {
        command: 'pi',
        args: [
          verb,
          request.resource.provenance.commandSource ??
            request.resource.requestedIdentity,
          '--no-approve',
        ],
      },
    ];
  }

  serializeSettings(
    context: ProfileClientContext,
    input: ProfileSerializationInput,
  ): ProfilePlannedFile | null {
    assertPiContext(context);
    if (input.settings && Object.keys(input.settings).length > 0) {
      throw new Error('Pi profile adapter does not support settings');
    }
    return null;
  }

  serializeMcp(
    context: ProfileClientContext,
    input: ProfileSerializationInput,
  ): ProfilePlannedFile | null {
    assertPiContext(context);
    const mcpServers = serializeProfileMcpServers(input, this.client, context.profileName);
    if (mcpServers === null) return null;
    return Object.freeze({
      key: 'pi:mcp',
      client: this.client,
      kind: 'mcp' as const,
      path: join(context.root, 'mcp.json'),
      content: `${JSON.stringify({ mcpServers }, null, 2)}\n`,
      mode: 0o600,
    });
  }

  inspectMcpAdapter(
    context: ProfileClientContext,
  ): Promise<PiMcpAdapterInspection> {
    assertPiContext(context);
    return inspectPiMcpAdapter(context.root);
  }
}

export const piProfileAdapter: NativeProfileAdapter = Object.freeze(
  new PiProfileAdapter(),
);
