import * as p from '@clack/prompts';
import { getClientTypes, type ClientType } from '../../../models/workspace-config.js';
import { setClients } from '../../../core/workspace-modify.js';
import { setUserClients, getUserWorkspaceConfig } from '../../../core/user-workspace.js';
import { syncWorkspace, syncUserWorkspace } from '../../../core/sync.js';
import type { TuiContext } from '../context.js';
import type { TuiCache } from '../cache.js';
import { getWorkspaceStatus } from '../../../core/status.js';
import { buildClientOptions } from '../prompt-clients.js';

const { select, autocompleteMultiselect } = p;

/**
 * Manage clients - lets user select scope then toggle AI clients.
 * Auto-creates workspace.yaml if it doesn't exist.
 */
export async function runManageClients(context: TuiContext, cache?: TuiCache): Promise<void> {
  try {
    // Determine scope
    let scope: 'project' | 'user' = 'user';
    if (context.hasWorkspace) {
      const scopeChoice = await select({
        message: 'Installation scope',
        options: [
          { label: 'Project (install in current directory, committed with your project)', value: 'project' as const },
          { label: 'User (global)', value: 'user' as const },
        ],
      });

      if (p.isCancel(scopeChoice)) {
        return;
      }

      scope = scopeChoice;
    }

    // Get current clients for the selected scope
    let currentClients: string[] = [];
    if (scope === 'project') {
      let status = cache?.getStatus();
      if (!status) {
        status = await getWorkspaceStatus(context.workspacePath ?? undefined);
        cache?.setStatus(status);
      }
      currentClients = status.clients ?? [];
    } else {
      const userConfig = await getUserWorkspaceConfig();
      currentClients = userConfig?.clients ? getClientTypes(userConfig.clients) : [];
    }

    const options = buildClientOptions(scope);
    const allClients = options.map((option) => option.value);

    const selected = await autocompleteMultiselect<string>({
      message: `Select AI clients [${scope}]`,
      options,
      initialValues: currentClients.filter((client) =>
        (allClients as readonly string[]).includes(client),
      ),
      required: false,
    });

    if (p.isCancel(selected)) {
      return;
    }
    const selectedClients = selected as ClientType[];

    // Check if anything changed
    const sortedCurrent = [...currentClients].sort();
    const sortedSelected = [...selectedClients].sort();
    if (JSON.stringify(sortedCurrent) === JSON.stringify(sortedSelected)) {
      p.note('No changes made.', 'Clients');
      return;
    }

    const s = p.spinner();
    s.start('Updating clients...');

    if (scope === 'project') {
      const workspacePath = context.workspacePath ?? process.cwd();
      const result = await setClients(selectedClients, workspacePath);
      if (!result.success) {
        s.stop('Failed to update clients');
        p.note(result.error ?? 'Unknown error', 'Error');
        return;
      }
      await syncWorkspace(workspacePath);
    } else {
      const result = await setUserClients(selectedClients);
      if (!result.success) {
        s.stop('Failed to update clients');
        p.note(result.error ?? 'Unknown error', 'Error');
        return;
      }
      await syncUserWorkspace();
    }

    s.stop('Clients updated');
    cache?.invalidate();

    p.note(`Clients [${scope}]: ${selectedClients.length > 0 ? selectedClients.join(', ') : 'none'}`, 'Updated');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.note(message, 'Error');
  }
}
