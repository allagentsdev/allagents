import { writeWorkspaceConfig } from '../utils/workspace-writer.js';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';
import { ensureWorkspace, type ModifyResult } from './workspace-modify.js';
import { ensureWorkspaceRules } from './transform.js';
import { CLIENT_MAPPINGS } from '../models/client-mapping.js';
import {
  ClientEntryListSchema,
  getClientTypes,
  normalizeClientEntry,
  type Repository,
} from '../models/workspace-config.js';
import { discoverWorkspaceSkills, writeSkillsIndex, cleanupSkillsIndex, groupSkillsByRepo } from './repo-skills.js';
import { parseWorkspaceConfigForEdit } from '../utils/workspace-parser.js';

const execFileAsync = promisify(execFile);

/**
 * Detect source platform and owner/repo from a git remote at the given path.
 * Returns { source, repo } or undefined if not detectable.
 */
export async function detectRemote(repoPath: string): Promise<{ source: string; repo: string } | undefined> {
  try {
    // Unset GIT_DIR/GIT_WORK_TREE so we read the target repo's config,
    // not the caller's (important when run from git hooks or worktrees).
    const env = { ...process.env };
    env.GIT_DIR = undefined;
    env.GIT_WORK_TREE = undefined;

    const { stdout } = await execFileAsync(
      'git',
      ['-C', repoPath, 'remote', 'get-url', 'origin'],
      { env, encoding: 'utf8' },
    );
    const url = stdout.trim();

    // Convert scp-style SSH remotes before parsing host and path separately.
    const scp = /^(?:[^/@:]+@)?([^/:]+):(.+)$/.exec(url);
    const remote = new URL(!url.includes('://') && scp
      ? `ssh://${scp[1]}/${scp[2]}`
      : url);
    const path = remote.pathname.replace(/^\//, '').replace(/\.git$/, '');
    const parts = path.split('/');
    if (parts.some((part) => !part)) return undefined;

    const platforms: Record<string, string> = {
      'github.com': 'github',
      'gitlab.com': 'gitlab',
      'bitbucket.org': 'bitbucket',
    };
    const source = Object.hasOwn(platforms, remote.hostname)
      ? platforms[remote.hostname]
      : undefined;
    if (source && (parts.length === 2 || (source === 'gitlab' && parts.length > 2))) {
      return { source, repo: path };
    }
    if (remote.hostname === 'dev.azure.com' && parts.length === 4 && parts[2] === '_git') {
      return { source: 'azure-devops', repo: `${parts[0]}/${parts[1]}/${parts[3]}` };
    }
    if (remote.hostname === 'vs-ssh.visualstudio.com' && parts.length === 4 && parts[0] === 'v3') {
      return { source: 'azure-devops', repo: parts.slice(1).join('/') };
    }

    return undefined;
  } catch {
    return undefined;
  }
}

interface AddRepoOptions {
  source?: string | undefined;
  repo?: string | undefined;
  description?: string | undefined;
}

/**
 * Normalize a repository path for consistent comparison and storage.
 * Strips trailing slashes (preserving bare "/" or ".").
 */
function normalizePath(p: string): string {
  const stripped = p.replace(/\/+$/, '');
  return stripped || p;
}

/**
 * Add a repository to .allagents/workspace.yaml
 */
export async function addRepository(
  path: string,
  options: AddRepoOptions = {},
  workspacePath: string = process.cwd(),
): Promise<ModifyResult> {
  const normalizedPath = normalizePath(path);
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  await ensureWorkspace(workspacePath);

  try {
    const config = await parseWorkspaceConfigForEdit(configPath);

    // Check for duplicate path
    if (config.repositories.some((r) => normalizePath(r.path) === normalizedPath)) {
      return { success: false, error: `Repository already exists: ${normalizedPath}` };
    }

    const entry: Repository = { path: normalizedPath };
    if (options.source) entry.source = options.source;
    if (options.repo) entry.repo = options.repo;
    if (options.description) entry.description = options.description;

    config.repositories.push(entry);
    await writeWorkspaceConfig(configPath, config);

    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Remove a repository from .allagents/workspace.yaml by path
 */
export async function removeRepository(
  path: string,
  workspacePath: string = process.cwd(),
): Promise<ModifyResult> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);

  if (!existsSync(configPath)) {
    return {
      success: false,
      error: `${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE} not found in ${workspacePath}\n  Run 'allagents workspace init' to create a workspace`,
    };
  }

  try {
    const config = await parseWorkspaceConfigForEdit(configPath);

    const normalizedPath = normalizePath(path);
    const index = config.repositories.findIndex((r) => normalizePath(r.path) === normalizedPath);
    if (index === -1) {
      return { success: false, error: `Repository not found: ${path}` };
    }

    config.repositories.splice(index, 1);
    await writeWorkspaceConfig(configPath, config);

    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * List repositories from .allagents/workspace.yaml
 */
export async function listRepositories(
  workspacePath: string = process.cwd(),
): Promise<Repository[]> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  if (!existsSync(configPath)) return [];

  try {
    const config = await parseWorkspaceConfigForEdit(configPath);
    return config.repositories ?? [];
  } catch {
    return [];
  }
}


/**
 * Ensure WORKSPACE-RULES are injected into agent files for all configured clients.
 * Lightweight alternative to full syncWorkspace() — only touches agent files.
 * Repository paths are embedded directly in the rules.
 * Discovers skills from workspace repositories and includes them in the rules.
 */
export async function updateAgentFiles(
  workspacePath: string = process.cwd(),
): Promise<void> {
  const configPath = join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
  if (!existsSync(configPath)) return;

  const config = await parseWorkspaceConfigForEdit(configPath);

  if (config.repositories.length === 0) return;

  const clients = ClientEntryListSchema.parse(config.clients ?? []);
  const clientNames = getClientTypes(clients);

  // Discover skills from all repositories
  const allSkills = await discoverWorkspaceSkills(workspacePath, config.repositories, clientNames);

  // Write per-repo skills-index files
  const grouped = groupSkillsByRepo(allSkills, config.repositories);
  const { writtenFiles, refs: skillsIndexRefs } = writeSkillsIndex(workspacePath, grouped);
  cleanupSkillsIndex(workspacePath, writtenFiles);

  // Only clients with evidenced instruction destinations receive rules.
  const agentFiles = new Set<string>();
  for (const client of clients) {
    const clientName = normalizeClientEntry(client).name;
    const mapping = CLIENT_MAPPINGS[clientName];
    if (mapping?.agentFile) agentFiles.add(mapping.agentFile);
    if (mapping?.agentFileFallback) {
      agentFiles.add(mapping.agentFileFallback);
    }
  }

  for (const agentFile of agentFiles) {
    await ensureWorkspaceRules(join(workspacePath, agentFile), config.repositories, skillsIndexRefs);
  }
}
