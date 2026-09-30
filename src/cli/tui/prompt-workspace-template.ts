import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as p from '@clack/prompts';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../constants.js';
import {
  fetchWorkspaceFromGitHub,
  readFileFromClone,
  type FetchWorkspaceResult,
} from '../../core/github-fetch.js';
import { cleanupTempDir } from '../../core/git.js';
import { findWorkspaceTemplatesInDirectory } from '../../core/workspace-templates.js';
import { isGitHubUrl, parseGitHubUrl } from '../../utils/plugin-path.js';
import { isJsonMode } from '../json-output.js';
import { isInteractive } from './prompt-clients.js';

interface TemplateChoice {
  label: string;
  value: string;
}

export interface WorkspaceTemplateSelection {
  source: string;
  prefetchedGitHub?: FetchWorkspaceResult;
}

/** Resolve a repository or directory to one workspace template source. */
export async function chooseWorkspaceTemplateSource(
  source: string,
): Promise<WorkspaceTemplateSelection | null> {
  let choices: TemplateChoice[];
  let fetched: FetchWorkspaceResult | undefined;
  const interactive = isInteractive() && !isJsonMode();

  if (isGitHubUrl(source)) {
    const spinner = interactive ? p.spinner() : null;
    spinner?.start('Finding workspace templates...');
    const result = await fetchWorkspaceFromGitHub(source);
    spinner?.stop(
      result.success || result.availableTemplates
        ? 'Workspace templates found'
        : 'No workspace templates found',
    );

    if (result.success) {
      return { source, prefetchedGitHub: result };
    }
    if (!result.availableTemplates?.length) {
      throw new Error(result.error ?? 'Failed to find workspace templates');
    }

    const parsed = parseGitHubUrl(source);
    if (!parsed) {
      if (result.tempDir) await cleanupTempDir(result.tempDir);
      throw new Error(`Invalid GitHub source: ${source}`);
    }
    fetched = result;
    const branch = result.resolvedBranch ?? parsed.branch;
    choices = result.availableTemplates.map((path) => ({
      label: path,
      value: branch
        ? `https://github.com/${parsed.owner}/${parsed.repo}/tree/${branch}/${path}`
        : `${parsed.owner}/${parsed.repo}/${path}`,
    }));
  } else {
    const absoluteSource = resolve(source);
    let sourceStat: Awaited<ReturnType<typeof stat>>;
    try {
      sourceStat = await stat(absoluteSource);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { source };
      throw error;
    }
    if (!sourceStat.isDirectory()) return { source };
    if (
      existsSync(join(absoluteSource, CONFIG_DIR, WORKSPACE_CONFIG_FILE)) ||
      existsSync(join(absoluteSource, WORKSPACE_CONFIG_FILE))
    ) {
      return { source };
    }
    choices = (await findWorkspaceTemplatesInDirectory(absoluteSource))
      .filter(Boolean)
      .map((path) => ({ label: path, value: join(absoluteSource, path) }));
  }

  if (choices.length === 0) return { source };

  try {
    let choice = choices.length === 1 ? choices[0] : undefined;
    if (!choice) {
      if (!interactive) {
        throw new Error(
          `Multiple workspace templates found in ${source}:\n${choices.map((candidate) => `  ${candidate.value}`).join('\n')}\nChoose one with --from <template path>.`,
        );
      }
      const selected = await p.autocomplete({
        message: 'Select a workspace template',
        options: choices,
        placeholder: 'Type to search paths...',
      });
      if (p.isCancel(selected)) {
        if (fetched?.tempDir) await cleanupTempDir(fetched.tempDir);
        return null;
      }
      choice = choices.find((candidate) => candidate.value === selected);
    }
    if (!choice) throw new Error('No workspace template selected');
    if (!fetched) return { source: choice.value };

    const tempDir = fetched.tempDir;
    if (!tempDir) throw new Error('GitHub checkout was not created');
    const content = readFileFromClone(
      tempDir,
      `${choice.label}/${CONFIG_DIR}/${WORKSPACE_CONFIG_FILE}`,
    );
    if (!content)
      throw new Error(`Workspace template not found: ${choice.label}`);
    return {
      source: choice.value,
      prefetchedGitHub: {
        success: true,
        content,
        tempDir,
        resolvedSubpath: choice.label,
        ...(fetched.resolvedBranch && {
          resolvedBranch: fetched.resolvedBranch,
        }),
      },
    };
  } catch (error) {
    if (fetched?.tempDir) await cleanupTempDir(fetched.tempDir).catch(() => {});
    throw error;
  }
}
