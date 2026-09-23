import type { AgentCommandMeta } from '../help.js';

export const marketplaceListMeta: AgentCommandMeta = {
  command: 'plugin marketplace list',
  description: 'List registered marketplaces',
  whenToUse: 'To see which plugin marketplaces are currently registered on your system',
  examples: [
    'allagents plugin marketplace list',
  ],
  expectedOutput:
    'Shows each marketplace with source, path, and last updated date. If none registered, shows well-known marketplace suggestions.',
  outputSchema: {
    marketplaces: [{ name: 'string', source: { type: 'string', location: 'string' }, path: 'string', lastUpdated: 'string | null' }],
  },
};

export const marketplaceAddMeta: AgentCommandMeta = {
  command: 'plugin marketplace add',
  description: 'Add a marketplace from GitHub URL, owner/repo, local path, or well-known name',
  whenToUse: 'To register a new marketplace so its plugins become available for installation',
  examples: [
    'allagents plugin marketplace add official',
    'allagents plugin marketplace add https://github.com/user/marketplace',
    'allagents plugin marketplace add user/marketplace --name custom',
    'allagents plugin marketplace add ../local-marketplace',
    'allagents plugin marketplace add owner/repo --branch feat/v2 --name custom',
    'allagents plugin marketplace add owner/repo --scope project',
  ],
  expectedOutput:
    'Confirms the marketplace was added with its name and local path. Re-registering an existing marketplace replaces its source. Exit 1 if the source is invalid or unreachable.',
  positionals: [
    { name: 'source', type: 'string', required: true, description: 'GitHub URL, owner/repo, local path, or well-known marketplace name' },
  ],
  options: [
    { flag: '--name', short: '-n', type: 'string', description: 'Custom name for the marketplace' },
    { flag: '--branch', short: '-b', type: 'string', description: 'Branch to checkout after cloning (requires --name)' },
    { flag: '--scope', short: '-s', type: 'string', description: 'Scope: user (default) or project' },
  ],
  outputSchema: {
    marketplace: { name: 'string', path: 'string', replaced: 'boolean | undefined' },
  },
};

export const marketplaceRemoveMeta: AgentCommandMeta = {
  command: 'plugin marketplace remove',
  description: 'Remove a marketplace from registry (does not delete files)',
  whenToUse: 'To unregister a marketplace you no longer need, without deleting its cached files',
  examples: [
    'allagents plugin marketplace remove official',
    'allagents plugin marketplace remove custom',
  ],
  expectedOutput:
    'Confirms removal from registry and notes that files were not deleted. Exit 1 if marketplace not found.',
  positionals: [
    { name: 'name', type: 'string', required: true, description: 'Name of the marketplace to remove' },
  ],
  outputSchema: {
    name: 'string',
    path: 'string',
  },
};

export const marketplaceUpdateMeta: AgentCommandMeta = {
  command: 'plugin marketplace update',
  description: 'Update marketplace(s) from remote',
  whenToUse: 'To pull the latest plugin definitions from remote marketplace repositories',
  examples: [
    'allagents plugin marketplace update',
    'allagents plugin marketplace update official',
  ],
  expectedOutput:
    'Shows update status per marketplace. Exit 0 if all succeed, exit 1 if any fail.',
  positionals: [
    { name: 'name', type: 'string', required: false, description: 'Specific marketplace to update (updates all if omitted)' },
  ],
  outputSchema: {
    results: [{ name: 'string', success: 'boolean', error: 'string | undefined' }],
    succeeded: 'number',
    failed: 'number',
  },
};

export const marketplaceBrowseMeta: AgentCommandMeta = {
  command: 'plugin marketplace browse',
  description: 'Browse available plugins in a marketplace',
  whenToUse: 'To discover and browse available plugins in a specific marketplace before installing',
  examples: [
    'allagents plugin marketplace browse official',
    'allagents plugin marketplace browse superpowers',
  ],
  expectedOutput:
    'Lists all plugins in the marketplace with descriptions and install status. Shows total count.',
  positionals: [
    { name: 'name', type: 'string', required: true, description: 'Name of the marketplace to browse' },
  ],
  outputSchema: {
    marketplace: 'string',
    plugins: [{ name: 'string', description: 'string | null', installed: 'boolean', scope: 'string | null' }],
    total: 'number',
    installed: 'number',
  },
};

export const pluginListMeta: AgentCommandMeta = {
  command: 'plugin list',
  description: 'List declared plugins with durable ownership and live state',
  whenToUse:
    'To distinguish configured files and Pi/OMP native resources from what is installed, disabled, missing, retained, or uncertain in each scope',
  examples: [
    'allagents plugin list',
  ],
  expectedOutput:
    'Merges declarations, AllAgents ownership/provenance, and exact live native observation. Native inspection failures retain partial results and exit 1.',
  outputSchema: {
    plugins: [{
      name: 'string',
      spec: 'string',
      marketplace: 'string',
      scope: 'string',
      kind: 'string',
      clients: 'string[] | undefined',
      nativeClients: 'string[] | undefined',
      nativeResources: [{
        client: 'string',
        scope: 'user | project',
        kind: 'plugin | package',
        requestedIdentity: 'string',
        resolvedIdentity: 'string',
        root: 'string',
        action: 'string',
        phase: 'inspection',
        changed: 'boolean',
        declared: 'boolean',
        ownership: 'managed | referenced | uncertain | none',
        error: 'string | undefined',
      }],
    }],
    total: 'number',
  },
};

export const pluginValidateMeta: AgentCommandMeta = {
  command: 'plugin validate',
  description: 'Validate plugin structure at the given path',
  whenToUse: 'When developing a plugin, to check that its structure conforms to the expected format',
  examples: [
    'allagents plugin validate ./my-plugin',
    'allagents plugin validate ../shared-plugins/eslint-config',
  ],
  expectedOutput:
    'Reports validation results. Exit 0 if valid, exit 1 if structure errors are found.',
  positionals: [
    { name: 'path', type: 'string', required: true, description: 'Path to the plugin directory to validate' },
  ],
  outputSchema: {
    path: 'string',
    valid: 'boolean',
    message: 'string',
  },
};

export const pluginInstallMeta: AgentCommandMeta = {
  command: 'plugin install',
  description: 'Install a file plugin or ordinary Pi/OMP native resource with an explicit scope and client target.',
  whenToUse:
    'To review or explicitly select a plugin installation target before native preflight, declaration write, and sync',
  examples: [
    'allagents plugin install my-plugin@official',
    'allagents plugin install npm:pi-extension --scope user --client pi --yes',
    'allagents plugin install my-plugin@official --scope project --client claude,codex',
  ],
  expectedOutput:
    'Interactive human installs summarize and confirm the target; automation preserves the existing JSON and success output.',
  positionals: [
    { name: 'plugin', type: 'string', required: true, description: 'Plugin identifier (plugin@marketplace, GitHub URL, or local path)' },
  ],
  options: [
    { flag: '--scope', short: '-s', type: 'string', description: 'Installation scope: "project" (default) or "user"' },
    { flag: '--client', short: '-c', type: 'string', description: 'Comma-separated clients for this plugin' },
    { flag: '--yes', short: '-y', type: 'boolean', description: 'Run without prompts using configured or default scope and clients' },
    { flag: '--skill', type: 'string', description: 'Only enable a specific skill (repeatable)' },
  ],
  outputSchema: {
    plugin: 'string',
    scope: 'string',
    autoRegistered: 'string | null',
    replaced: 'boolean | undefined',
    syncResult: {
      copied: 'number',
      generated: 'number',
      failed: 'number',
      skipped: 'number',
      plugins: [{ plugin: 'string', success: 'boolean', copied: 'number', generated: 'number', failed: 'number' }],
    },
  },
};

export const pluginUninstallMeta: AgentCommandMeta = {
  command: 'plugin uninstall',
  description: 'Remove a declaration and safely reconcile its scoped resources',
  whenToUse:
    'To remove a project/user declaration or retry retained native cleanup after the declaration is already absent',
  examples: [
    'allagents plugin uninstall my-plugin@official',
    'allagents plugin uninstall npm:pi-extension --scope user',
    'allagents plugin uninstall my-plugin@official --scope user',
  ],
  expectedOutput:
    'Reports declaration removal separately, removes only corroborated AllAgents-managed native resources in the selected scope, retains referenced/uncertain resources, and exits 1 on failed or unknown cleanup.',
  positionals: [
    { name: 'plugin', type: 'string', required: true, description: 'Plugin identifier to uninstall' },
  ],
  options: [
    { flag: '--scope', short: '-s', type: 'string', description: 'Installation scope: "project" (default) or "user"' },
  ],
  outputSchema: {
    plugin: 'string',
    scopes: ['user | project'],
    declarations: [{
      scope: 'user | project',
      action: 'removed | absent | failed',
      error: 'string | undefined',
    }],
    syncResults: {
      project: 'sync result | undefined',
      user: 'sync result | undefined',
    },
  },
};

export const pluginUpdateMeta: AgentCommandMeta = {
  command: 'plugin update',
  description: 'Update only selected file and ordinary native resources',
  whenToUse:
    'To update one declared plugin or all selected-scope plugins while targeting each Pi/OMP adapter by exact identity and scope',
  examples: [
    'allagents plugin update',
    'allagents plugin update my-plugin@official',
    'allagents plugin update npm:pi-extension --scope user',
    'allagents plugin update --scope all',
  ],
  expectedOutput:
    'On a TTY, checks each source without mutating it, reports the found update count, then prints a persistent source line before each applied update and its result as it settles; a source already current is reported as skipped. JSON and redirected output remain one-shot and batched. Reports per-scope sync/native outcomes and exits 1 if any pass fails.',
  positionals: [
    { name: 'plugin', type: 'string', required: false, description: 'Specific plugin to update (updates all if omitted)' },
  ],
  options: [
    { flag: '--scope', short: '-s', type: 'string', description: 'Installation scope: "project" (default), "user", or "all"' },
  ],
  outputSchema: {
    results: [{ plugin: 'string', success: 'boolean', action: 'string', error: 'string | undefined' }],
    updated: 'number',
    skipped: 'number',
    failed: 'number',
    syncResults: {
      project: 'sync result | undefined',
      user: 'sync result | undefined',
    },
  },
};
