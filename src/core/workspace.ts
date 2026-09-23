import { cp, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump } from 'js-yaml';
import { syncWorkspace, type SyncResult } from './sync.js';
import { ensureWorkspaceRules } from './transform.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE, AGENT_FILES, type WorkspaceRepository } from '../constants.js';
import { getClientTypes, type ClientEntry } from '../models/workspace-config.js';
import { isGitHubUrl, parseGitHubUrl, getPluginCachePath } from '../utils/plugin-path.js';
import { validateProjectWorkspaceConfig } from '../utils/workspace-parser.js';
import { loadYaml } from '../utils/yaml.js';
import { fetchWorkspaceFromGitHub, readFileFromClone } from './github-fetch.js';
import { cleanupTempDir } from './git.js';
import { getMarketplacesDir } from './marketplace.js';
import { ensureConfigGitignore } from './config-gitignore.js';

/**
 * Options for workspace initialization
 */
export interface InitOptions {
  /** Path to existing workspace.yaml or directory containing one to copy from */
  from?: string;
  /** Override which clients to include in workspace.yaml */
  clients?: ClientEntry[];
  /** Overwrite existing workspace.yaml if present */
  force?: boolean;
}

/**
 * Result of workspace initialization
 */
export interface InitResult {
  /** Path where workspace was created */
  path: string;
  /** Result of plugin sync (if plugins were configured) */
  syncResult?: SyncResult;
}

/**
 * Initialize a new workspace from template
 * @param targetPath - Path where workspace should be created (default: current directory)
 * @param options - Initialization options
 * @throws Error if path already exists or initialization fails
 */
export async function initWorkspace(
  targetPath = '.',
  options: InitOptions = {},
): Promise<InitResult> {
  const absoluteTarget = resolve(targetPath);
  const configDir = join(absoluteTarget, CONFIG_DIR);
  const configPath = join(configDir, WORKSPACE_CONFIG_FILE);

  // Check if workspace already exists (has .allagents/workspace.yaml)
  if (existsSync(configPath) && !options.force) {
    throw new Error(
      `Workspace already exists: ${absoluteTarget}\n  Found existing ${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE}`,
    );
  }

  // Get template path for default template
  const currentFilePath = fileURLToPath(import.meta.url);
  const currentFileDir = dirname(currentFilePath);
  const isProduction = currentFilePath.includes(`${sep}dist${sep}`);
  const defaultTemplatePath = isProduction
    ? join(currentFileDir, 'templates', 'default')
    : join(currentFileDir, '..', 'templates', 'default');

  // Temp dir from GitHub clone — must be cleaned up at the end
  let githubTempDir: string | undefined;
  // Parsed GitHub URL — shared across source rewriting, template copying, and agent files
  let parsedFromUrl: ReturnType<typeof parseGitHubUrl> | undefined;
  let githubBasePath = ''; // workspace directory path within the repo (e.g., "examples/multi-repo")
  let githubBranch = 'main';

  try {
    // Create target directory if it doesn't exist
    await mkdir(absoluteTarget, { recursive: true });

    // Create .allagents directory
    await mkdir(configDir, { recursive: true });
    await ensureConfigGitignore(absoluteTarget);

    // Determine workspace.yaml source and track source directory for relative path resolution
    let workspaceYamlContent: string;
    let sourceDir: string | undefined;

    if (options.from) {
      // Check if --from is a GitHub URL
      if (isGitHubUrl(options.from)) {
        const fetchResult = await fetchWorkspaceFromGitHub(options.from);
        if (!fetchResult.success || !fetchResult.content) {
          if (fetchResult.tempDir) {
            await cleanupTempDir(fetchResult.tempDir);
          }
          throw new Error(fetchResult.error || 'Failed to fetch workspace from GitHub');
        }
        githubTempDir = fetchResult.tempDir;
        workspaceYamlContent = fetchResult.content;

        // Use resolved values from fetchWorkspaceFromGitHub (already branch-resolved and .allagents-stripped)
        parsedFromUrl = parseGitHubUrl(options.from);
        githubBasePath = fetchResult.resolvedSubpath || '';
        githubBranch = fetchResult.resolvedBranch || parsedFromUrl?.branch || 'main';

        // For GitHub sources, keep workspace.source as-is (it's already a URL or relative to the repo)
        // We need to rewrite relative workspace.source to the full GitHub URL
        const parsed = loadYaml(workspaceYamlContent) as Record<string, unknown>;
        const workspace = parsed?.workspace as { source?: string } | undefined;
        if (workspace?.source) {
          const source = workspace.source;
          // If workspace.source is a relative path, convert to GitHub URL
          if (!isGitHubUrl(source) && !isAbsolute(source)) {
            // Build GitHub URL from the --from location plus the relative source
            if (parsedFromUrl) {
              const sourcePath = source === '.' ? githubBasePath : (githubBasePath ? `${githubBasePath}/${source}` : source);
              workspace.source = `https://github.com/${parsedFromUrl.owner}/${parsedFromUrl.repo}/tree/${githubBranch}/${sourcePath}`;
              workspaceYamlContent = dump(parsed, { lineWidth: -1 });
            }
          }
        }
        console.log(`✓ Using workspace.yaml from: ${options.from}`);
      } else {
        // Copy workspace.yaml from local --from path
        const fromPath = resolve(options.from);

        if (!existsSync(fromPath)) {
          throw new Error(`Template not found: ${fromPath}`);
        }

        // Check if --from is a file or directory
        const { stat } = await import('node:fs/promises');
        const fromStat = await stat(fromPath);

        let sourceYamlPath: string;
        if (fromStat.isDirectory()) {
          // Look for workspace.yaml in .allagents/ subdirectory first, then root
          const nestedPath = join(fromPath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
          const rootPath = join(fromPath, WORKSPACE_CONFIG_FILE);

          if (existsSync(nestedPath)) {
            sourceYamlPath = nestedPath;
            sourceDir = fromPath; // Source dir is the directory containing .allagents/
          } else if (existsSync(rootPath)) {
            sourceYamlPath = rootPath;
            sourceDir = fromPath; // Source dir is where workspace.yaml lives
          } else {
            throw new Error(
              `No workspace.yaml found in: ${fromPath}\n  Expected at: ${nestedPath} or ${rootPath}`,
            );
          }
        } else {
          // --from points directly to a yaml file
          sourceYamlPath = fromPath;
          // Source dir depends on whether yaml is inside .allagents/ or at workspace root
          const parentDir = dirname(fromPath);
          if (parentDir.endsWith(CONFIG_DIR)) {
            // yaml is in .allagents/, source dir is the workspace root (parent of .allagents/)
            sourceDir = dirname(parentDir);
          } else {
            // yaml is at workspace root, source dir is that directory
            sourceDir = parentDir;
          }
        }

        workspaceYamlContent = await readFile(sourceYamlPath, 'utf-8');

        // Rewrite relative workspace.source to absolute path so sync works after init
        if (sourceDir) {
          const parsed = loadYaml(workspaceYamlContent) as Record<string, unknown>;
          const workspace = parsed?.workspace as { source?: string } | undefined;
          if (workspace?.source) {
            const source = workspace.source;
            // Convert relative local paths to absolute (skip URLs and already-absolute paths)
            if (!isGitHubUrl(source) && !isAbsolute(source)) {
              workspace.source = resolve(sourceDir, source);
              workspaceYamlContent = dump(parsed, { lineWidth: -1 });
            }
          }
        }

        console.log(`✓ Using workspace.yaml from: ${sourceYamlPath}`);
      }
    } else {
      // Use default template's workspace.yaml
      const defaultYamlPath = join(defaultTemplatePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE);
      if (!existsSync(defaultYamlPath)) {
        throw new Error(`Default template not found at: ${defaultTemplatePath}`);
      }
      workspaceYamlContent = await readFile(defaultYamlPath, 'utf-8');
    }

    // Override clients if provided
    if (options.clients && options.clients.length > 0) {
      const configParsed = loadYaml(workspaceYamlContent) as Record<string, unknown>;
      configParsed.clients = options.clients;
      workspaceYamlContent = dump(configParsed, { lineWidth: -1 });
    }

    // Preserve init's historical support for sparse templates while validating
    // every supplied value and rejecting project-only forbidden fields before
    // replacing an existing workspace.
    const input = loadYaml(workspaceYamlContent);
    const inputRecord =
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : null;
    const inputWorkspace =
      inputRecord?.workspace &&
      typeof inputRecord.workspace === 'object' &&
      !Array.isArray(inputRecord.workspace)
        ? (inputRecord.workspace as Record<string, unknown>)
        : undefined;
    const parsed = validateProjectWorkspaceConfig(
      inputRecord
        ? {
            repositories: [],
            plugins: [],
            clients: [],
            ...inputRecord,
            ...(inputWorkspace && {
              workspace: { files: [], ...inputWorkspace },
            }),
          }
        : input,
      configPath,
    );
    await writeFile(configPath, workspaceYamlContent, 'utf-8');

    // Inspect the validated config for post-write template work.
    const clients = parsed.clients;
    const clientNames = getClientTypes(clients);

    // Copy template.code-workspace from source if it exists and vscode client is configured
    const VSCODE_TEMPLATE_FILE = 'template.code-workspace';
    if (clientNames.includes('vscode') && options.from) {
      const targetTemplatePath = join(configDir, VSCODE_TEMPLATE_FILE);
      if (!existsSync(targetTemplatePath)) {
        if (isGitHubUrl(options.from) && githubTempDir) {
          // Read template from cloned repo
          if (parsedFromUrl) {
            const templatePath = githubBasePath
              ? `${githubBasePath}/${CONFIG_DIR}/${VSCODE_TEMPLATE_FILE}`
              : `${CONFIG_DIR}/${VSCODE_TEMPLATE_FILE}`;
            const templateContent = readFileFromClone(githubTempDir, templatePath);
            if (templateContent) {
              await writeFile(targetTemplatePath, templateContent, 'utf-8');
            }
          }
        } else if (sourceDir) {
          // Copy template from local source
          const sourceTemplatePath = join(sourceDir, CONFIG_DIR, VSCODE_TEMPLATE_FILE);
          if (existsSync(sourceTemplatePath)) {
            await copyFile(sourceTemplatePath, targetTemplatePath);
          }
        }
      }
    }

    const repositories = (parsed?.repositories as WorkspaceRepository[]) ?? [];
    const hasRepositories = repositories.length > 0;

    // Only create agent files and inject WORKSPACE-RULES when repositories are configured.
    // When repositories is empty/absent (e.g., plugin-only workspace from addPlugin auto-init),
    // skip agent files since WORKSPACE-RULES reference repository paths that don't exist yet.
    if (hasRepositories) {
      // Auto-copy agent files (AGENTS.md, CLAUDE.md) from source if they exist
      const copiedAgentFiles: string[] = [];

      if (options.from && isGitHubUrl(options.from) && githubTempDir) {
        if (parsedFromUrl) {
          for (const agentFile of AGENT_FILES) {
            const targetFilePath = join(absoluteTarget, agentFile);
            if (existsSync(targetFilePath)) {
              copiedAgentFiles.push(agentFile);
              continue;
            }
            const filePath = githubBasePath ? `${githubBasePath}/${agentFile}` : agentFile;
            const content = readFileFromClone(githubTempDir, filePath);
            if (content) {
              await writeFile(targetFilePath, content, 'utf-8');
              copiedAgentFiles.push(agentFile);
            }
          }
        }
      } else {
        // Copy agent files from local source
        const effectiveSourceDir = sourceDir ?? defaultTemplatePath;
        for (const agentFile of AGENT_FILES) {
          const targetFilePath = join(absoluteTarget, agentFile);
          // Skip if file already exists in target - don't overwrite user content
          if (existsSync(targetFilePath)) {
            copiedAgentFiles.push(agentFile);
            continue;
          }
          const sourcePath = join(effectiveSourceDir, agentFile);
          if (existsSync(sourcePath)) {
            const content = await readFile(sourcePath, 'utf-8');
            await writeFile(targetFilePath, content, 'utf-8');
            copiedAgentFiles.push(agentFile);
          }
        }
      }

      // Inject WORKSPACE-RULES into all copied agent files
      // If no agent files were copied, create AGENTS.md with just rules
      // Repository paths are embedded directly so agents don't need to read workspace.yaml
      if (copiedAgentFiles.length === 0) {
        await ensureWorkspaceRules(join(absoluteTarget, 'AGENTS.md'), repositories);
        copiedAgentFiles.push('AGENTS.md');
      } else {
        for (const agentFile of copiedAgentFiles) {
          await ensureWorkspaceRules(join(absoluteTarget, agentFile), repositories);
        }
      }

      // If claude is a client and CLAUDE.md doesn't exist, copy AGENTS.md to CLAUDE.md
      if (
        clientNames.includes('claude') &&
        !copiedAgentFiles.includes('CLAUDE.md') &&
        copiedAgentFiles.includes('AGENTS.md')
      ) {
        const agentsPath = join(absoluteTarget, 'AGENTS.md');
        const claudePath = join(absoluteTarget, 'CLAUDE.md');
        await copyFile(agentsPath, claudePath);
      }
    }

    // Seed plugin/marketplace cache from the GitHub temp clone before cleanup.
    // This avoids re-cloning the same private repo during sync (which can fail
    // due to credential manager issues, rate limits, or transient errors).
    if (githubTempDir && parsedFromUrl) {
      await seedCacheFromClone(
        githubTempDir,
        parsedFromUrl.owner,
        parsedFromUrl.repo,
        githubBranch,
      );
    }

    // Clean up GitHub temp clone now that we've read all needed files
    if (githubTempDir) {
      await cleanupTempDir(githubTempDir);
    }

    console.log(`✓ Workspace created at: ${absoluteTarget}`);

    // Auto-sync plugins
    // Pass sourceDir so relative paths in workspace.source resolve correctly
    console.log('\nUpdating plugins...');
    const syncResult = await syncWorkspace(absoluteTarget, {
      ...(sourceDir && { workspaceSourceBase: sourceDir }),
    });

    if (!syncResult.success && syncResult.error) {
      // Don't fail init if sync fails (e.g., no plugins configured)
      // Just report it
      if (!syncResult.error.includes('Plugin validation failed')) {
        console.log(`  Note: ${syncResult.error}`);
      } else {
        console.error(`  Sync error: ${syncResult.error}`);
      }
    }

    // Show next steps
    if (targetPath !== '.') {
      console.log('\nNext steps:');
      console.log(`  cd ${relative(process.cwd(), absoluteTarget)}`);
    }

    return {
      path: absoluteTarget,
      syncResult,
    };
  } catch (error) {
    // Clean up GitHub temp clone on error
    if (githubTempDir) {
      await cleanupTempDir(githubTempDir).catch(() => {});
    }
    if (error instanceof Error) {
      throw new Error(`Failed to initialize workspace: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Seed the plugin and marketplace caches from an already-cloned GitHub repo.
 *
 * During `workspace init --from`, the repo is cloned once to read workspace.yaml.
 * Sync then tries to clone the same repo again for workspace.source validation
 * and marketplace registration. For private repos this second clone can fail.
 *
 * By copying the temp clone to the permanent cache paths before cleanup, sync
 * finds cached repos and avoids redundant network requests.
 */
export async function seedCacheFromClone(
  tempDir: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<void> {
  const cachePaths = [
    // fetchPlugin cache (used for workspace.source and direct GitHub URL plugins)
    getPluginCachePath(owner, repo, branch),
    // addMarketplace cache (used for plugin@owner/repo marketplace registration)
    join(getMarketplacesDir(), repo),
  ];

  for (const cachePath of cachePaths) {
    if (existsSync(cachePath)) continue;

    try {
      const parentDir = dirname(cachePath);
      if (!existsSync(parentDir)) {
        await mkdir(parentDir, { recursive: true });
      }
      await cp(tempDir, cachePath, { recursive: true });
    } catch {
      // Non-fatal: sync will attempt its own clone as fallback
    }
  }
}
