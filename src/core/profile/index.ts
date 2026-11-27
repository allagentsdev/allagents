import type { ClientType } from '../../models/workspace-config.js';

export type ProfileOperationKind = 'install' | 'update' | 'remove';

export interface ProfileRuntimeOptions {
  readonly userConfigPath?: string;
  readonly workspaceDirectory?: string;
  readonly homeDir?: string;
  readonly binDir?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly offline?: boolean;
  readonly dryRun?: boolean;
  readonly purgeSessionData?: boolean;
}

export type ProfileStepKind =
  | 'root'
  | 'file'
  | 'settings'
  | 'mcp'
  | 'native'
  | 'marketplace'
  | 'launcher';

export type ProfilePlanAction =
  | 'create'
  | 'update'
  | 'remove'
  | 'unchanged'
  | 'reference'
  | 'retain';
export interface ProfilePlanCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface ProfilePlanMcpServer {
  readonly name: string;
  readonly transport: 'http' | 'stdio';
  readonly endpoint?: string;
  readonly command?: ProfilePlanCommand;
  /** Environment variable names requested through exact ${ENV_VAR} references. */
  readonly requestedSecrets: readonly string[];
}

export interface ProfilePlanStepDetail {
  readonly source?: string;
  readonly skills?: readonly string[];
  readonly commands?: readonly ProfilePlanCommand[];
  readonly mcpServers?: readonly ProfilePlanMcpServer[];
}

export interface ProfilePlanClient {
  readonly client: ClientType;
  readonly mechanism: string;
  /** Runtime configuration root selected by the adapter. */
  readonly root: string;
  /** Agent/file root when distinct from the configuration root. */
  readonly agentRoot: string;
  readonly launcher?: {
    readonly name: string;
    readonly command: ProfilePlanCommand;
    readonly destinations: readonly string[];
  };
}


export interface ProfilePlanStep {
  readonly client: ClientType | 'profile';
  readonly kind: ProfileStepKind;
  /** Display-safe native identity or absolute filesystem path. */
  readonly identity: string;
  readonly action: ProfilePlanAction;
  readonly requestedRef?: string;
  readonly resolvedRef?: string;
  readonly detail?: ProfilePlanStepDetail;
}

export interface ProfilePlan {
  readonly profile: string;
  readonly operation: ProfileOperationKind;
  readonly declarationDigest: string;
  /** Display-safe selected client/configuration mechanisms. */
  readonly clients: readonly ProfilePlanClient[];
  /** Fully resolved, display-safe operations in dependency order. */
  readonly steps: readonly ProfilePlanStep[];
  readonly warnings: readonly string[];
}

export type ProfileApplyStepStatus =
  | 'created'
  | 'updated'
  | 'removed'
  | 'unchanged'
  | 'referenced'
  | 'retained'
  | 'failed';

export interface ProfileApplyStep {
  readonly client: ProfilePlanStep['client'];
  readonly kind: ProfileStepKind;
  readonly identity: string;
  readonly status: ProfileApplyStepStatus;
  readonly error?: string;
}

export interface ProfileApplyResult {
  readonly profile: string;
  readonly operation: ProfileOperationKind;
  readonly status: 'installed' | 'removed' | 'partial' | 'failed';
  readonly success: boolean;
  readonly steps: readonly ProfileApplyStep[];
  readonly warnings: readonly string[];
  readonly error?: string;
}

export type ProfileStatus =
  | 'installed'
  | 'missing'
  | 'drifted'
  | 'partial'
  | 'unsupported'
  | 'declaration-missing';

export interface ProfileLauncherStatus {
  readonly client: ClientType;
  readonly name: string;
  readonly path: string;
  readonly onPath: boolean;
}

export interface ProfileStatusResult {
  readonly profile: string;
  readonly operation: 'status';
  readonly status: ProfileStatus;
  readonly declared: boolean;
  readonly installed: boolean;
  readonly declarationDigest?: string;
  readonly stateDigest?: string;
  readonly clients: readonly ClientType[];
  readonly steps: readonly ProfileApplyStep[];
  readonly launchers: readonly ProfileLauncherStatus[];
  readonly warnings: readonly string[];
  readonly error?: string;
}

export {
  planProfileOperation,
  type ProfilePlanDependencies,
} from './plan.js';
export {
  applyProfilePlan,
  getProfileStatus,
  getProfileStatuses,
  getProfilesForUpdate,
  updateInstalledProfiles,
  type ProfileManagerDependencies,
} from './manager.js';
