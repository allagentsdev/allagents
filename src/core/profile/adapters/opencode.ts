import { join, resolve } from 'node:path';
import {
  OpenCodeProfileSettingsSchema,
  ProfileMcpServerConfigSchema,
  ProfileNameSchema,
} from '../../../models/workspace-config.js';
import type { FileOnlyProfileAdapter } from '../types.js';
import { removeManagedFile, sha256Fingerprint } from '../files.js';
import type {
  ProfileClientContext,
  ProfileContextOptions,
  ProfilePlannedFile,
  ProfileSerializationInput,
} from '../types.js';
import { serializeProfileMcpServers } from './mcp.js';

const OPENCODE_SCHEMA_URL = 'https://opencode.ai/config.json';
const FILE_MAPPING = Object.freeze({
  commandsPath: 'commands/',
  skillsPath: 'skills/',
  agentFile: 'AGENTS.md',
});
const GENERATED_GITIGNORE =
  'node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore';
const CAPABILITIES = Object.freeze({
  nativeInstall: false,
  fileInstall: true,
  launchers: true,
  skillFilters: true,
  mcp: true,
  settings: true,
  status: true,
  cleanup: true,
  recursiveRootCleanup: false,
});
const SECRET_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function assertOpenCodeContext(context: ProfileClientContext): void {
  const expectedConfig = join(context.root, 'opencode.json');
  if (
    context.client !== 'opencode' ||
    context.operationContext.client !== 'opencode' ||
    context.operationContext.nativeScope !== `profile:${context.profileName}` ||
    resolve(context.root) !== context.root ||
    context.operationContext.env?.OPENCODE_CONFIG !== expectedConfig ||
    context.operationContext.env?.OPENCODE_CONFIG_DIR !== context.root
  ) {
    throw new Error(
      'OpenCode profile adapter received a mismatched or non-absolute context',
    );
  }
}

function openCodeReference(value: string): string {
  return value.replace(SECRET_REFERENCE, '{env:$1}');
}

function serializeOpenCodeMcp(
  input: ProfileSerializationInput,
  profile: string,
): Readonly<Record<string, unknown>> | undefined {
  const selected = serializeProfileMcpServers(input, 'opencode', profile);
  if (selected === null) return undefined;
  const mcp: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(selected)) {
    const server = ProfileMcpServerConfigSchema.parse(value);
    if ('url' in server) {
      mcp[name] = {
        type: 'remote',
        url: openCodeReference(server.url),
        ...(server.headers && {
          headers: Object.fromEntries(
            Object.entries(server.headers).map(([key, value]) => [
              key,
              openCodeReference(value),
            ]),
          ),
        }),
      };
      continue;
    }
    mcp[name] = {
      type: 'local',
      command: [server.command, ...(server.args ?? []).map(openCodeReference)],
      ...(server.env && {
        environment: Object.fromEntries(
          Object.entries(server.env).map(([key, value]) => [
            key,
            openCodeReference(value),
          ]),
        ),
      }),
    };
  }
  return Object.freeze(mcp);
}

export class OpenCodeProfileAdapter implements FileOnlyProfileAdapter {
  readonly client = 'opencode' as const;
  readonly capabilities = CAPABILITIES;

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
      'opencode',
      'config',
    );
    const configPath = join(root, 'opencode.json');
    const selectedEnvironment = Object.freeze({
      OPENCODE_CONFIG: configPath,
      OPENCODE_CONFIG_DIR: root,
      OPENCODE_CONFIG_CONTENT: undefined,
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
      roots: Object.freeze({ config: root }),
    });
    return Object.freeze({
      profileName,
      client: this.client,
      mechanism: 'configuration-override',
      root,
      operationContext,
      fileMapping: FILE_MAPPING,
      launcher: Object.freeze({
        command: 'opencode',
        args: Object.freeze([] as string[]),
        env: selectedEnvironment,
      }),
    });
  }

  serializeSettings(
    context: ProfileClientContext,
    input: ProfileSerializationInput,
  ): ProfilePlannedFile | null {
    assertOpenCodeContext(context);
    const settings = OpenCodeProfileSettingsSchema.parse(input.settings ?? {});
    const mcp = serializeOpenCodeMcp(input, context.profileName);
    if (Object.keys(settings).length === 0 && mcp === undefined) return null;
    return Object.freeze({
      key: 'opencode:config',
      client: this.client,
      kind: 'settings' as const,
      path: join(context.root, 'opencode.json'),
      content: `${JSON.stringify(
        {
          $schema: OPENCODE_SCHEMA_URL,
          ...settings,
          ...(mcp && { mcp }),
        },
        null,
        2,
      )}\n`,
      mode: 0o600,
    });
  }

  serializeMcp(
    context: ProfileClientContext,
    _input: ProfileSerializationInput,
  ): ProfilePlannedFile | null {
    assertOpenCodeContext(context);
    // OpenCode stores settings and MCP declarations in one configuration file.
    return null;
  }

  async prepareRootCleanup(context: ProfileClientContext): Promise<void> {
    assertOpenCodeContext(context);
    await removeManagedFile({
      root: context.root,
      path: join(context.root, '.gitignore'),
      ownership: 'managed',
      expectedFingerprint: sha256Fingerprint(GENERATED_GITIGNORE),
    });
  }
}

export const openCodeProfileAdapter: FileOnlyProfileAdapter = Object.freeze(
  new OpenCodeProfileAdapter(),
);
