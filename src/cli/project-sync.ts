import * as p from '@clack/prompts';
import {
  syncWorkspace,
  type LegacyVscodeImportPreview,
  type SyncOptions,
} from '../core/sync.js';
import { isJsonMode } from './json-output.js';
import { terminalSafe } from './terminal-output.js';

export interface CliSyncOptions extends SyncOptions {
  yes?: boolean | undefined;
  /** Pass only a currently running spinner; prompts pause and resume it. */
  spinner?: Pick<ReturnType<typeof p.spinner>, 'start' | 'stop'> | undefined;
}

export function createLegacyVscodeImportConfirmation(
  options: Pick<CliSyncOptions, 'yes' | 'spinner'> = {},
): (preview: LegacyVscodeImportPreview) => Promise<boolean> {
  return async (preview) => {
    if (options.yes) return true;
    if (isJsonMode() || !process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        'Older VS Code state cannot distinguish pending editor changes from repository changes in workspace.yaml. Review both files, then rerun with --yes to apply VS Code folders and names to YAML repositories.',
      );
    }

    options.spinner?.stop('Repository confirmation needed');
    try {
      const name = (value: string | undefined) =>
        value === undefined
          ? '(default name)'
          : terminalSafe(JSON.stringify(value));
      const lines = [
        `Workspace: ${terminalSafe(preview.workspacePath)}`,
        'Older update state cannot prove which repository folders or names changed.',
        'Applying these VS Code values will replace the affected YAML repository values:',
        ...preview.added.map(
          (folder) =>
            `Add: ${terminalSafe(folder.path)}${folder.name !== undefined ? ` (${name(folder.name)})` : ''}`,
        ),
        ...preview.removed.map(
          (folder) => `Remove: ${terminalSafe(folder.path)}`,
        ),
        ...preview.renamed.map(
          (folder) =>
            `Name: ${terminalSafe(folder.path)}: ${name(folder.beforeName)} → ${name(folder.afterName)}`,
        ),
        'Plugins, skills and other YAML sections are preserved.',
      ];
      p.note(lines.join('\n'), 'Review VS Code repository changes');
      const answer = await p.confirm({
        message: 'Apply these VS Code repository values to workspace.yaml?',
        initialValue: false,
      });
      return !p.isCancel(answer) && answer;
    } finally {
      options.spinner?.start('Updating...');
    }
  };
}

/** Keep project synchronization consent at the CLI boundary for every entry point. */
export function syncProjectWorkspace(
  workspacePath: string,
  options: CliSyncOptions = {},
) {
  const { yes, spinner, ...syncOptions } = options;
  return syncWorkspace(workspacePath, {
    ...syncOptions,
    confirmLegacyVscodeImport: createLegacyVscodeImportConfirmation({
      yes,
      spinner,
    }),
  });
}
