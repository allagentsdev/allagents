import type { ClientMapping } from '../../models/client-mapping.js';
import type { PluginComponents } from '../../models/plugin-components.js';
import type {
  ClientType,
  InstallMode,
  McpServerConfig,
  PluginSkillsConfig,
} from '../../models/workspace-config.js';
import type {
  ProfileOperationKind,
  ProfilePlanAction,
  ProfilePlanCommand,
  ProfileStepKind,
} from './index.js';
import type {
  NativeClient,
  NativeMutationResult,
  NativeOperationContext,
  NativeResource,
  NativeSourceResolution,
} from '../native/types.js';

export interface ProfileAdapterCapabilities {
  readonly nativeInstall: boolean;
  readonly fileInstall: boolean;
  readonly launchers: boolean;
  readonly skillFilters: boolean;
  readonly mcp: boolean;
  readonly settings: boolean;
  readonly status: boolean;
  readonly cleanup: boolean;
  /** Recursively remove client-created artifacts only when the selected root is wholly disposable. */
  readonly recursiveRootCleanup: boolean;
}

export interface ProfileLauncherInvocation {
  readonly command: string;
  readonly args: readonly string[];
  /** Undefined explicitly removes an inherited ambient selector. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Absolute files which must exist before the client can safely launch. */
  readonly requiredFiles?: readonly string[];
}

export interface ProfileContextOptions {
  readonly homeDir: string;
  /** Relative native sources are resolved from this user-selected workspace. */
  readonly workspaceDirectory: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
}

export interface ProfileClientContext {
  readonly profileName: string;
  readonly client: ClientType;
  readonly mechanism: string;
  /** Absolute agent/config root which bounds all profile file materialization. */
  readonly root: string;
  readonly operationContext: NativeOperationContext;
  /** Paths are relative to root; absolute profile mappings are invalid. */
  readonly fileMapping: Readonly<ClientMapping>;
  readonly launcher: ProfileLauncherInvocation;
}

export interface ProfileResolvedPlugin {
  readonly declarationIndex: number;
  readonly source: string;
  readonly requestedRef?: string;
  readonly resolvedRef?: string;
  readonly resolvedSha?: string;
  readonly path?: string;
  readonly components?: PluginComponents;
  readonly marketplace?: string;
  readonly pluginName?: string;
  readonly marketplaceSource?: string;
  readonly marketplaceRegistrationManaged?: boolean;
  readonly marketplaceSparsePath?: string;
  readonly install: InstallMode;
  readonly skills?: PluginSkillsConfig;
  readonly clients?: readonly ClientType[];
}

export interface ProfilePlannedFile {
  readonly key: string;
  readonly client: ClientType;
  readonly kind: 'settings' | 'mcp';
  readonly path: string;
  readonly content: string;
  readonly mode: number;
}

export interface ProfileSerializationInput {
  readonly plugins: readonly ProfileResolvedPlugin[];
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
}

export interface ProfileMcpPrerequisite {
  matches(resource: NativeResource): boolean;
  inspect(context: ProfileClientContext): Promise<{
    readonly classification: string;
    readonly packageSource?: string;
  }>;
}

export interface ProfileNativeMetadataOptions {
  readonly homeDir: string;
  readonly workspaceDirectory: string;
  readonly offline: boolean;
  readonly dryRun: boolean;
}

export interface ProfileMarketplaceRegistration {
  readonly name: string;
  readonly source: string;
}
export interface ProfileMarketplaceRegistrationInspection {
  readonly success: boolean;
  readonly present: boolean;
  readonly error?: string;
}

export type ProfileNativeCommandRequest =
  | {
      readonly kind: 'native';
      readonly action: ProfilePlanAction;
      readonly resource: NativeResource;
    }
  | {
      readonly kind: 'marketplace';
      readonly action: ProfilePlanAction;
      readonly registration: ProfileMarketplaceRegistration;
    };

/**
 * Shared profile seam. Runtime-specific roots, selectors, and serialization
 * remain inside every adapter. Native adapters additionally own metadata,
 * lifecycle, and truthful command disclosure.
 */
interface ProfileAdapterBase {
  readonly client: ClientType;
  readonly capabilities: ProfileAdapterCapabilities;

  resolveContext(
    profileName: string,
    options: ProfileContextOptions,
  ): ProfileClientContext;
  /** Validate that the selected client runtime supports this profile mechanism. */
  isRuntimeAvailable?(context: ProfileClientContext): Promise<boolean>;
  /** Optional provider ordering without exposing provider names to orchestration. */
  stepOrder?(kind: ProfileStepKind, operation: ProfileOperationKind): number;
  readonly mcpPrerequisite?: ProfileMcpPrerequisite;

  serializeSettings(
    context: ProfileClientContext,
    input: ProfileSerializationInput,
  ): ProfilePlannedFile | null;

  serializeMcp(
    context: ProfileClientContext,
    input: ProfileSerializationInput,
  ): ProfilePlannedFile | null;

  /** Remove adapter-known generated files before generic empty-directory cleanup. */
  prepareRootCleanup?(context: ProfileClientContext): Promise<void>;
}

export interface NativeProfileAdapter extends ProfileAdapterBase {
  readonly capabilities: ProfileAdapterCapabilities & {
    readonly nativeInstall: true;
  };
  readonly nativeClient: NativeClient;

  resolveNativeMetadata?(
    plugin: ProfileResolvedPlugin,
    context: ProfileClientContext,
    options: ProfileNativeMetadataOptions,
  ): Promise<ProfileResolvedPlugin>;

  resolveNativeSource(
    plugin: ProfileResolvedPlugin,
    context: ProfileClientContext,
  ): NativeSourceResolution;

  discloseNativeCommands(
    request: ProfileNativeCommandRequest,
    context: ProfileClientContext,
  ): readonly ProfilePlanCommand[];

  applyMarketplaceRegistration?(
    registration: ProfileMarketplaceRegistration,
    context: ProfileClientContext,
  ): Promise<NativeMutationResult>;

  inspectMarketplaceRegistration?(
    marketplaceName: string,
    context: ProfileClientContext,
  ): Promise<ProfileMarketplaceRegistrationInspection>;

  removeMarketplaceRegistration?(
    marketplaceName: string,
    context: ProfileClientContext,
  ): Promise<NativeMutationResult>;
}

export interface FileOnlyProfileAdapter extends ProfileAdapterBase {
  readonly capabilities: ProfileAdapterCapabilities & {
    readonly nativeInstall: false;
  };
  readonly nativeClient?: never;
  readonly resolveNativeMetadata?: never;
  readonly resolveNativeSource?: never;
  readonly discloseNativeCommands?: never;
  readonly applyMarketplaceRegistration?: never;
  readonly removeMarketplaceRegistration?: never;
}

export type ProfileAdapter = NativeProfileAdapter | FileOnlyProfileAdapter;

export function isNativeProfileAdapter(
  adapter: ProfileAdapter,
): adapter is NativeProfileAdapter {
  return adapter.capabilities.nativeInstall;
}
