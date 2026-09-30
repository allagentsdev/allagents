import * as p from '@clack/prompts';
import { initWorkspace } from '../../../core/workspace.js';
import { formatVerboseSyncLines } from '../../format-sync.js';
import type { ClientEntry } from '../../../models/workspace-config.js';
import { promptForClients } from '../prompt-clients.js';
import { chooseWorkspaceTemplateSource } from '../prompt-workspace-template.js';

const { text } = p;

/**
 * Guided workspace initialization action.
 * Prompts user for path, optional template source, and client selection, then runs initWorkspace.
 */
export async function runInit(): Promise<void> {
  try {
    const targetPath = await text({
      message: 'Where should the workspace be created?',
      placeholder: '.',
      defaultValue: '.',
    });

    if (p.isCancel(targetPath)) {
      return;
    }

    const fromSource = await text({
      message: 'Template source (leave empty for default)',
      placeholder: 'GitHub URL, path, or leave empty',
      defaultValue: '',
    });

    if (p.isCancel(fromSource)) {
      return;
    }

    const templateSelection = fromSource
      ? await chooseWorkspaceTemplateSource(fromSource)
      : undefined;
    if (templateSelection === null) return;

    // Skip client prompt when a template source is provided — the remote
    // workspace.yaml already defines the desired client configuration.
    let selectedClients: ClientEntry[] | undefined;
    if (!fromSource) {
      const prompted = await promptForClients();
      if (prompted === null) {
        return;
      }
      selectedClients = prompted;
    }

    const s = p.spinner();
    s.start('Initializing workspace...');

    let result: Awaited<ReturnType<typeof initWorkspace>>;
    try {
      const options: Parameters<typeof initWorkspace>[1] = {
        ...(templateSelection ? { from: templateSelection.source } : {}),
        ...(templateSelection?.prefetchedGitHub && { prefetchedGitHub: templateSelection.prefetchedGitHub }),
        ...(selectedClients && selectedClients.length > 0
          ? { clients: selectedClients }
          : {}),
      };
      result = await initWorkspace(targetPath, options);
    } catch (error) {
      s.stop('Failed');
      throw error;
    }

    s.stop('Workspace initialized');

    const lines = [`Path: ${result.path}`];
    if (selectedClients && selectedClients.length > 0) {
      lines.push(`Clients: ${selectedClients.join(', ')}`);
    }
    if (result.syncResult) {
      lines.push('');
      lines.push(...formatVerboseSyncLines(result.syncResult));
    }
    p.note(lines.join('\n'), 'Workspace Created');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.note(message, 'Error');
  }
}
