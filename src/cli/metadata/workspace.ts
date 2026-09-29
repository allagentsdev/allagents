import type { AgentCommandMeta } from '../help.js';

export const initMeta: AgentCommandMeta = {
  command: 'init',
  description: 'Create new workspace and sync plugins',
  whenToUse:
    'When starting a new project or adding allagents to an existing repo for the first time',
  examples: [
    'allagents init',
    'allagents init ./my-project',
    'allagents init --from ../template-workspace/.allagents/workspace.yaml',
    'allagents init --client claude,copilot,cursor',
  ],
  expectedOutput:
    'Creates .allagents/workspace.yaml and syncs plugins. Shows sync results per plugin. Exit 0 on success, exit 1 on failure.',
  positionals: [
    {
      name: 'path',
      type: 'string',
      required: false,
      description:
        'Target directory for the workspace (defaults to current directory)',
    },
  ],
  options: [
    {
      flag: '--from',
      type: 'string',
      description: 'Copy workspace.yaml from existing template/workspace',
    },
    {
      flag: '--client',
      type: 'string',
      description:
        'Comma-separated list of clients (e.g., claude,copilot,cursor)',
    },
  ],
  outputSchema: {
    path: 'string',
    syncResult: {
      copied: 'number',
      generated: 'number',
      failed: 'number',
      skipped: 'number',
      plugins: [
        {
          plugin: 'string',
          success: 'boolean',
          copied: 'number',
          generated: 'number',
          failed: 'number',
        },
      ],
    },
  },
};

export const setupMeta: AgentCommandMeta = {
  command: 'workspace setup',
  description: 'Run workspace setup commands for this platform',
  whenToUse:
    'After reviewing the setup commands in workspace.yaml and explicitly deciding to run commands matching this platform and architecture',
  examples: ['allagents workspace setup'],
  expectedOutput:
    'Shows matching and skipped setup commands in declaration order. Exit 0 when every matching command succeeds, exit 1 on the first nonzero exit or signal.',
  outputSchema: {
    commands: [
      {
        command: 'string',
        status: 'succeeded | failed | skipped',
        exitCode: 'number | null',
        signal: 'string | null',
        reason: 'string | null',
      },
    ],
  },
};

export const syncMeta: AgentCommandMeta = {
  command: 'update',
  description: 'Reconcile ordinary resources and installed global profiles',
  whenToUse:
    'After modifying workspace.yaml, pulling shared config changes, or changing an installed global profile declaration',
  examples: [
    'allagents update',
    'allagents update --dry-run',
    'allagents update --offline',
    'allagents update --verbose',
    'allagents update --profile work --profile review',
    'allagents workspace update --profile work',
  ],
  expectedOutput:
    'Attempts user workspace, installed declared profiles, and project workspace in order without stopping later passes after a failure. With --profile, validates and updates only selected profiles that are both installed and declared. Exit 1 after all applicable passes if any pass fails.',
  options: [
    {
      flag: '--offline',
      type: 'boolean',
      description: 'Use cached plugins without fetching latest from remote',
    },
    {
      flag: '--dry-run',
      short: '-n',
      type: 'boolean',
      description: 'Simulate sync without making changes',
    },
    {
      flag: '--verbose',
      short: '-v',
      type: 'boolean',
      description: 'Show informational sync messages',
    },
    {
      flag: '--profile',
      type: 'string',
      description: 'Update only this installed profile (repeatable)',
    },
  ],
  outputSchema: {
    copied: 'number',
    generated: 'number',
    failed: 'number',
    skipped: 'number',
    plugins: [
      {
        plugin: 'string',
        success: 'boolean',
        copied: 'number',
        generated: 'number',
        failed: 'number',
      },
    ],
    nativeResources: {
      success: 'boolean',
      effects: [{
        client: 'string',
        scope: 'user | project',
        nativeScope: 'string',
        kind: 'plugin | package',
        requestedIdentity: 'string',
        resolvedIdentity: 'string',
        root: 'string',
        action: 'string',
        phase: 'string',
        changed: 'boolean',
        error: 'string | undefined',
      }],
    },
    profiles: [
      {
        profile: 'string',
        operation: 'update',
        status: 'installed | removed | partial | failed',
        steps: [
          {
            client: 'string',
            kind: 'root | file | settings | mcp | native | marketplace | launcher',
            identity: 'string',
            status:
              'created | updated | removed | unchanged | referenced | retained | failed',
            error: 'string | undefined',
          },
        ],
        warnings: ['string'],
        error: 'string | undefined',
      },
    ],
  },
};

export const pruneMeta: AgentCommandMeta = {
  command: 'workspace prune',
  description: 'Remove orphaned plugin references',
  whenToUse:
    'After removing a marketplace to clean up stale plugin references in workspace configs',
  examples: ['allagents workspace prune'],
  expectedOutput:
    'Lists removed orphaned plugins from both project and user scopes. Exit 0 on success, exit 1 on error.',
  outputSchema: {
    project: { removed: ['string'], kept: ['string'] },
    user: { removed: ['string'], kept: ['string'] },
  },
};

export const statusMeta: AgentCommandMeta = {
  command: 'status',
  description: 'Show declared, managed, and live plugin status',
  whenToUse:
    'To compare workspace declarations and AllAgents ownership with exact live Pi/OMP and file-resource state',
  examples: ['allagents status', 'allagents workspace status'],
  expectedOutput:
    'Lists configured files plus native client/scope identities as installed, configured-missing, disabled, unusable, or unknown. Native inspection failures exit 1 without hiding other scope outcomes.',
  outputSchema: {
    plugins: [
      {
        source: 'string',
        type: 'string',
        kind: 'string',
        available: 'boolean',
      },
    ],
    clients: ['string'],
    nativeResources: [{
      client: 'string',
      scope: 'user | project',
      kind: 'plugin | package',
      requestedIdentity: 'string',
      resolvedIdentity: 'string',
      root: 'string',
      action: 'installed | configured-missing | disabled | unusable | unknown',
      phase: 'inspection',
      changed: 'boolean',
      declared: 'boolean',
      ownership: 'managed | referenced | uncertain | none',
      transition: 'string | undefined',
      error: 'string | undefined',
    }],
  },
};
