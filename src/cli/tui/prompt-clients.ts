import * as p from '@clack/prompts';
import {
  getClientInstallMode,
  type ClientEntry,
  type ClientType,
} from '../../models/workspace-config.js';
import {
  clientIdsForScope,
  getMapping,
} from '../../models/client-mapping.js';
import type { InstallScope } from '../install-target.js';

const { autocompleteMultiselect } = p;

/**
 * Build a flat options list for searchable client selection.
 * Hints reflect the selected scope and configured native install modes.
 */
export function buildClientOptions(
  scope: InstallScope = 'project',
  clientEntries: readonly ClientEntry[] = [],
): {
  value: ClientType;
  label: string;
  hint: string;
}[] {
  return clientIdsForScope(scope).map((client) => ({
    value: client,
    label: client,
    hint:
      getClientInstallMode(clientEntries, client) === 'native'
        ? 'Native install'
        : getMapping(client, scope).skillsPath,
  }));
}

/**
 * Check if the current environment supports interactive prompts.
 */
export function isInteractive(): boolean {
  if (p.isCI()) return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export interface PromptForClientsOptions {
  readonly scope?: InstallScope;
  readonly initialValues?: readonly ClientType[];
  readonly clientEntries?: readonly ClientEntry[];
}

/**
 * Prompt the user to select AI clients using a searchable multiselect.
 * Returns selected clients, or null if cancelled.
 * In non-interactive mode, retains the legacy universal default.
 */
export async function promptForClients(
  options: PromptForClientsOptions = {},
): Promise<ClientEntry[] | null> {
  if (!isInteractive()) {
    return ['universal'];
  }

  const clientEntries = options.clientEntries ?? [];
  const promptOptions = buildClientOptions(options.scope, clientEntries);
  const selected = await autocompleteMultiselect<string>({
    message: 'Which AI clients do you use?',
    options: promptOptions,
    initialValues: [
      ...(options.initialValues ?? ['universal', 'copilot', 'vscode']),
    ],
    required: true,
  });

  if (p.isCancel(selected)) {
    return null;
  }

  return selected as ClientEntry[];
}
