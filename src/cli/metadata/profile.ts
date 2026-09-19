import type { AgentCommandMeta } from '../help.js';

const profileMutationJsonFields = [
  'profile',
  'operation',
  'status',
  'declarationDigest',
  'clients',
  'plan',
  'steps',
  'warnings',
  'error',
] as const;

const profileStatusJsonFields = [
  'profile',
  'operation',
  'status',
  'declared',
  'installed',
  'declarationDigest',
  'stateDigest',
  'clients',
  'steps',
  'launchers',
  'warnings',
  'error',
] as const;

const profileNamePositional = [
  {
    name: 'name',
    type: 'string' as const,
    required: false,
    description:
      'Profile name. In an interactive terminal, omit to choose from the available profiles.',
  },
];

const mutationOptions = [
  {
    flag: '--yes',
    short: '-y',
    type: 'boolean' as const,
    description: 'Apply the displayed plan without asking for confirmation.',
  },
  {
    flag: '--dry-run',
    type: 'boolean' as const,
    description: 'Display the plan without prompting or changing any files.',
  },
  {
    flag: '--offline',
    type: 'boolean' as const,
    description: 'Plan and apply using only locally available sources.',
  },
];

const profilePlanClientsOutput = [
  {
    client: 'string',
    mechanism: 'string',
    root: 'string',
    agentRoot: 'string',
    launcher: {
      name: 'string',
      command: { command: 'string', args: ['string'] },
      destinations: ['string'],
    },
  },
];

const profileMutationStepsOutput = [
  {
    status:
      'created | updated | removed | unchanged | referenced | retained | failed',
    client: 'string',
    kind: 'string',
    identity: 'string',
    requestedRef: 'string?',
    resolvedRef: 'string?',
    detail: {
      source: 'string?',
      skills: ['string'],
      commands: [{ command: 'string', args: ['string'] }],
      mcpServers: [
        {
          name: 'string',
          transport: 'http | stdio',
          endpoint: 'string?',
          command: { command: 'string', args: ['string'] },
          requestedSecrets: ['string'],
        },
      ],
    },
    error: 'string?',
  },
];

const profilePlanOutput = {
  profile: 'string',
  operation: 'install | remove',
  status: 'planned',
  declarationDigest: 'string',
  clients: profilePlanClientsOutput,
  steps: profileMutationStepsOutput,
  warnings: ['string'],
};

export const profileInstallMeta: AgentCommandMeta = {
  command: 'profile install',
  description: 'Install a declared global agent profile',
  whenToUse:
    'When you want AllAgents to materialize one user profile, its client resources, and its launchers from the user workspace declaration',
  examples: [
    'allagents profile install work',
    'allagents profile install work --dry-run',
    'allagents profile install work --yes --offline',
    'allagents --json profile install work --yes',
  ],
  expectedOutput:
    'Displays a redacted deterministic plan, asks before applying unless --yes is supplied, and reports each created, updated, unchanged, referenced, retained, or failed step.',
  positionals: profileNamePositional,
  options: mutationOptions,
  outputSchema: {
    profile: 'string',
    operation: 'install',
    status: 'string',
    declarationDigest: 'string?',
    clients: profilePlanClientsOutput,
    steps: profileMutationStepsOutput,
    plan: profilePlanOutput,
    warnings: ['string'],
    error: 'string?',
  },
  jsonFields: profileMutationJsonFields,
};

const profileStatusOutput = {
  profile: 'string',
  operation: 'status',
  status: 'string',
  declared: 'boolean',
  installed: 'boolean',
  declarationDigest: 'string?',
  stateDigest: 'string?',
  clients: ['string'],
  steps: [
    {
      status:
        'created | updated | removed | unchanged | referenced | retained | failed',
      client: 'string?',
      kind: 'string?',
      identity: 'string?',
      error: 'string?',
    },
  ],
  launchers: [
    {
      client: 'string',
      name: 'string',
      path: 'string',
      onPath: 'boolean',
    },
  ],
  warnings: ['string'],
  error: 'string?',
};

export const profileListMeta: AgentCommandMeta = {
  command: 'profile list',
  description: 'List declared and installed global profiles',
  whenToUse:
    'When you need a read-only inventory of every declared or installed profile, its clients, and launcher PATH status',
  examples: ['allagents profile list', 'allagents --json profile list'],
  expectedOutput:
    'Lists every declared and declaration-missing installed profile with overall state, clients, and launcher paths without changing user files.',
  outputSchema: {
    profiles: [profileStatusOutput],
    total: 'number',
  },
  jsonFields: profileStatusJsonFields,
  skipUpdateCheck: true,
};

export const profileStatusMeta: AgentCommandMeta = {
  command: 'profile status',
  description: 'Inspect declared and installed global profiles',
  whenToUse:
    'When you need detailed read-only profile state, per-resource status, or launcher PATH diagnostics',
  examples: [
    'allagents profile status work',
    'allagents profile status',
    'allagents --json profile status work',
  ],
  expectedOutput:
    'Reports declared and installed state, detailed resource statuses, warnings, and whether the profile launcher directory is available on PATH without changing user files.',
  positionals: profileNamePositional,
  outputSchema: profileStatusOutput,
  jsonFields: profileStatusJsonFields,
};

export const profileRemoveMeta: AgentCommandMeta = {
  command: 'profile remove',
  description: 'Remove an installed or declared global profile safely',
  whenToUse:
    'When you want AllAgents to remove resources and profile-owned OAuth credentials for one installed or declared user profile while retaining referenced resources',
  examples: [
    'allagents profile remove work',
    'allagents profile remove work --dry-run',
    'allagents profile remove work --yes',
    'allagents --json profile remove work --yes',
  ],
  expectedOutput:
    'Displays a redacted deterministic removal plan, asks before applying unless --yes is supplied, removes profile-owned OAuth credentials even for a declared-only profile, and reports removed, retained, unchanged, or failed resources.',
  positionals: profileNamePositional,
  options: mutationOptions,
  outputSchema: {
    profile: 'string',
    operation: 'remove',
    status: 'string',
    declarationDigest: 'string?',
    clients: profilePlanClientsOutput,
    steps: profileMutationStepsOutput,
    plan: profilePlanOutput,
    warnings: ['string'],
    error: 'string?',
  },
  jsonFields: profileMutationJsonFields,
};
