import { syncProjectWorkspace } from '../../project-sync.js';
import * as p from '@clack/prompts';
import { syncUserWorkspace } from '../../../core/sync.js';
import { formatVerboseSyncLines } from '../../format-sync.js';
import type { TuiContext } from '../context.js';

/**
 * Sync plugins with progress display.
 * Syncs project-scope plugins (if workspace exists) and user-scope plugins.
 * Uses a single spinner with message updates for both scopes.
 */
export async function runSync(context: TuiContext): Promise<void> {
  try {
    const s = p.spinner();
    let projectLines: string[] | undefined;
    let projectFailed = false;

    // Sync project-level plugins if workspace exists
    if (context.hasWorkspace && context.workspacePath) {
      s.start('Updating project...');
      const result = await syncProjectWorkspace(context.workspacePath, { spinner: s });

      if (!result.success) {
        projectFailed = true;
        s.stop('Update failed');
        p.note(result.error ?? 'Update failed', 'Update Error');
        if (context.userPluginCount > 0) s.start('Updating user configuration...');
      } else {
        projectLines = formatVerboseSyncLines(result);
        if (context.userPluginCount > 0) {
          s.message('Updating user configuration...');
        } else {
          s.stop('Update complete');
          p.note(projectLines.join('\n'), 'Project Update');
          return;
        }
      }
    }

    // Sync user-level plugins
    if (context.userPluginCount > 0) {
      if (!context.hasWorkspace || !context.workspacePath) {
        s.start('Updating user configuration...');
      }
      const userResult = await syncUserWorkspace();
      s.stop(userResult.success && !projectFailed ? 'Update complete' : 'Update failed');

      // Show project results first (deferred from above)
      if (projectLines) {
        p.note(projectLines.join('\n'), 'Project Update');
      }

      if (!userResult.success) {
        p.note(userResult.error ?? 'Update failed', 'User Update Error');
      } else {
        const lines = formatVerboseSyncLines(userResult);
        p.note(lines.join('\n'), 'User Update');
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.note(message, 'Error');
  }
}
