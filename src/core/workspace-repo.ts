import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { dump } from 'js-yaml';
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

    // GitHub SSH: git@github.com:owner/repo.git
    // GitHub HTTPS: https://github.com/owner/repo.git
    const githubMatch = url.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (githubMatch) return { source: 'github', repo: `${githubMatch[1]}/${githubMatch[2]}` };

    // GitLab
    const gitlabMatch = url.match(/gitlab\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (gitlabMatch) return { source: 'gitlab', repo: `${gitlabMatch[1]}/${gitlabMatch[2]}` };

    // Bitbucket
    const bitbucketMatch = url.match(/bitbucket\.org[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (bitbucketMatch) return { source: 'bitbucket', repo: `${bitbucketMatch[1]}/${bitbucketMatch[2]}` };

    // Azure DevOps: https://dev.azure.com/org/project/_git/repo or org@vs-ssh.visualstudio.com:v3/org/project/repo
    const azureHttpsMatch = url.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/.]+?)(?:\.git)?$/);
    if (azureHttpsMatch) return { source: 'azure-devops', repo: `${azureHttpsMatch[1]}/${azureHttpsMatch[2]}/${azureHttpsMatch[3]}` };

    const azureSshMatch = url.match(/vs-ssh\.visualstudio\.com:v3\/([^/]+)\/([^/]+)\/([^/.]+?)(?:\.git)?$/);
    if (azureSshMatch) return { source: 'azure-devops', repo: `${azureSshMatch[1]}/${azureSshMatch[2]}/${azureSshMatch[3]}` };

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
    await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf-8');

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
    await writeFile(configPath, dump(config, { lineWidth: -1 }), 'utf-8');

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
