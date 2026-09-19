import { readFile } from 'node:fs/promises';

import {
  type ProjectWorkspaceConfig,
  ProjectWorkspaceConfigSchema,
  type UserWorkspaceConfig,
  UserWorkspaceConfigSchema,
  type WorkspaceConfig,
} from '../models/workspace-config.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import { loadYaml } from './yaml.js';

const configName = `${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE}`;

export type WorkspaceConfigScope = 'project' | 'user';

export type EditableUserWorkspaceConfig = Omit<
  UserWorkspaceConfig,
  'repositories' | 'plugins' | 'clients'
> &
  Partial<Pick<UserWorkspaceConfig, 'repositories' | 'plugins' | 'clients'>>;

function formatValidationError(
  path: string,
  scope: WorkspaceConfigScope,
  input: unknown,
): ProjectWorkspaceConfig | UserWorkspaceConfig {
  const schema =
    scope === 'user' ? UserWorkspaceConfigSchema : ProjectWorkspaceConfigSchema;
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const errors = result.error.issues.map(
    (error) => `  - ${error.path.join('.')}: ${error.message}`,
  );
  throw new Error(`${path} validation failed:\n${errors.join('\n')}`);
}

export function validateProjectWorkspaceConfig(
  input: unknown,
  path: string = configName,
): ProjectWorkspaceConfig {
  return formatValidationError(
    path,
    'project',
    input,
  ) as ProjectWorkspaceConfig;
}

export function validateUserWorkspaceConfig(
  input: unknown,
  path: string = configName,
): UserWorkspaceConfig {
  return formatValidationError(path, 'user', input) as UserWorkspaceConfig;
}

async function loadConfigFile(path: string): Promise<unknown> {
  try {
    const content = await readFile(path, 'utf-8');
    if (!content.trim()) throw new Error(`${configName} is empty`);

    const parsed = loadYaml(content);
    if (!parsed) throw new Error(`${configName} is empty`);
    return parsed;
  } catch (error) {
    if (error instanceof Error) {
      if ('code' in error && error.code === 'ENOENT') {
        throw new Error(
          `${configName} not found at ${path}\n  Run 'allagents workspace init <path>' to create a new workspace`,
        );
      }
      if (error.name === 'YAMLException') {
        throw new Error(`Invalid YAML in ${configName}: ${error.message}`);
      }
      throw error;
    }
    throw new Error(`Unknown error parsing ${configName}: ${String(error)}`);
  }
}

async function parseConfigFile(
  path: string,
  scope: WorkspaceConfigScope,
): Promise<ProjectWorkspaceConfig | UserWorkspaceConfig> {
  return formatValidationError(configName, scope, await loadConfigFile(path));
}

/**
 * Parse a project workspace. This remains the project-compatible parser used
 * by existing project synchronization call sites.
 */
export async function parseWorkspaceConfig(
  path: string,
): Promise<ProjectWorkspaceConfig> {
  return parseConfigFile(path, 'project') as Promise<ProjectWorkspaceConfig>;
}

/**
 * Parse the user workspace, including optional global profile declarations.
 */
export async function parseUserWorkspaceConfig(
  path: string,
): Promise<UserWorkspaceConfig> {
  return parseConfigFile(path, 'user') as Promise<UserWorkspaceConfig>;
}

/**
 * Validate a project workspace before mutating it while retaining its original
 * YAML object representation.
 */
export async function parseWorkspaceConfigForEdit(
  path: string,
): Promise<WorkspaceConfig> {
  const input = await loadConfigFile(path);
  validateProjectWorkspaceConfig(input);
  return input as WorkspaceConfig;
}

async function loadUserWorkspaceConfigForEdit(path: string): Promise<{
  input: EditableUserWorkspaceConfig;
  validated: UserWorkspaceConfig;
}> {
  const input = await loadConfigFile(path);
  const validated = validateUserWorkspaceConfig(input, path);
  return {
    input: input as EditableUserWorkspaceConfig,
    validated,
  };
}

/**
 * Validate a user workspace for mutation while preserving its raw field
 * omissions. Callers must validate the whole document again before writing.
 */
export async function parseUserWorkspaceConfigDocumentForEdit(
  path: string,
): Promise<EditableUserWorkspaceConfig> {
  return (await loadUserWorkspaceConfigForEdit(path)).input;
}

/**
 * Validate a user workspace before mutation without materializing profile
 * defaults or dropping unrelated top-level fields. Profiles-only workspaces
 * receive the ordinary empty arrays required by existing mutation code.
 */
export async function parseUserWorkspaceConfigForEdit(
  path: string,
): Promise<UserWorkspaceConfig> {
  const { input, validated } = await loadUserWorkspaceConfigForEdit(path);
  input.repositories ??= validated.repositories;
  input.plugins ??= validated.plugins;
  input.clients ??= validated.clients;
  return input as UserWorkspaceConfig;
}
