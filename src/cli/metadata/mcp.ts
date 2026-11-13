import type { AgentCommandMeta } from '../help.js';

const destinationOptions: NonNullable<AgentCommandMeta['options']> = [
  {
    flag: '--scope',
    type: 'string',
    choices: ['project', 'user'],
    description:
      "Declaration destination: 'project' (default) or ordinary 'user' configuration; cannot be combined with --profile",
  },
  {
    flag: '--profile',
    type: 'string',
    description:
      'Named profile declaration destination; cannot be combined with --scope',
  },
];

const runtimeDestinationOptions = destinationOptions.map((option) =>
  option.flag === '--scope'
    ? {
        ...option,
        description:
          "Restrict lookup to 'project' or 'user'; without --scope or --profile, check the project first, then ordinary user configuration",
      }
    : option,
);

const destinationOutput = {
  kind: 'project | user | profile',
  name: 'string?',
};

const reconciliationOutput = {
  mcpResults: 'object?',
  sync: 'object?',
};

export const mcpAddMeta: AgentCommandMeta = {
  command: 'mcp add',
  description: 'Add an MCP server, authenticate, and sync it to clients',
  whenToUse:
    'When adding or replacing an MCP server in the current project, ordinary user configuration, or a declared profile. Agent and non-interactive use works for public servers or valid cached credentials; fresh OAuth consent requires a human rerun.',
  examples: [
    'allagents mcp add deepwiki https://mcp.deepwiki.com/mcp',
    'allagents mcp add design https://example.com/mcp --oauth-client-name Codex',
    'allagents mcp add my-server npx --arg=-y --arg=@my/mcp-server',
    'allagents mcp add gh-api npx -e GH_TOKEN=abc123 --arg=-y --arg=@modelcontextprotocol/server-github',
    'allagents mcp add deepwiki https://mcp.deepwiki.com/mcp --client claude,copilot --client codex',
    'allagents mcp add personal npx --scope user',
    'allagents mcp add trading https://example.com/mcp --profile markets',
    'allagents --json mcp add trading https://example.com/mcp --profile markets',
  ],
  expectedOutput:
    'Validates and adds the declaration to the selected project, user, or profile destination, authenticates HTTP servers when needed, records proxy routing atomically, and reconciles installed clients. JSON output redacts credential values. Declared-only profiles are not implicitly installed. Exit 0 on success, 1 on failure.',
  interaction: 'conditional',
  positionals: [
    {
      name: 'name',
      type: 'string',
      required: true,
      description: 'Server name (unique within the selected destination)',
    },
    {
      name: 'commandOrUrl',
      type: 'string',
      required: true,
      description:
        'HTTP URL (http://, https://) for http transport, or a command for stdio transport',
    },
  ],
  options: [
    {
      flag: '--oauth-config',
      type: 'string',
      description:
        'OAuth settings as JSON or @path/to/file.json; supports registered clients, scopes, grants and callback settings',
    },
    {
      flag: '--connection-config',
      type: 'string',
      description:
        'Transport, protocol, filtering and network settings as JSON or @path/to/file.json',
    },
    {
      flag: '--header-file',
      type: 'string',
      description:
        'HTTP headers from a file, one Name: value per line (repeatable)',
    },
    {
      flag: '--transport',
      type: 'string',
      description:
        "Transport type: 'http' or 'stdio' (auto-detected from URL by default)",
    },
    {
      flag: '--arg',
      type: 'string',
      description: 'Argument to pass to the stdio command (repeatable)',
    },
    {
      flag: '--env',
      short: '-e',
      type: 'string',
      description:
        'Environment variable KEY=VALUE for stdio transport (repeatable)',
    },
    {
      flag: '--header',
      type: 'string',
      description: 'HTTP header KEY=VALUE for http transport (repeatable)',
    },
    {
      flag: '--oauth-client-name',
      type: 'string',
      description:
        'OAuth registration client name for HTTP transport (default: AllAgents); requires a nonempty value and is not supported for stdio',
    },
    {
      flag: '--client',
      type: 'string',
      description:
        'Client filter (repeatable; each value may be comma-separated; duplicates are removed in first-seen order)',
    },
    {
      flag: '--force',
      short: '-f',
      type: 'boolean',
      description: 'Replace an existing server with the same name',
    },
    ...destinationOptions,
  ],
  outputSchema: {
    destination: destinationOutput,
    name: 'string',
    config: 'object',
    ...reconciliationOutput,
  },
};

export const mcpRemoveMeta: AgentCommandMeta = {
  command: 'mcp remove',
  description:
    'Remove an MCP server from a project, user, or profile destination',
  whenToUse:
    'When you no longer need an MCP server declaration in the selected destination',
  examples: [
    'allagents mcp remove deepwiki',
    'allagents mcp remove deepwiki --scope user',
    'allagents mcp remove trading --profile markets',
    'allagents --json mcp remove trading --profile markets',
  ],
  expectedOutput:
    'Removes the server declaration and proxy intent from the selected destination, then reconciles that destination. Declared-only profiles remain uninstalled. Exit 0 on success, 1 if the server is not defined.',
  positionals: [
    {
      name: 'name',
      type: 'string',
      required: true,
      description: 'Server name to remove from the selected destination',
    },
  ],
  options: [...destinationOptions],
  outputSchema: {
    destination: destinationOutput,
    name: 'string',
    ...reconciliationOutput,
  },
};

export const mcpListMeta: AgentCommandMeta = {
  command: 'mcp list',
  description:
    'List MCP servers declared in a project, user, or profile destination',
  whenToUse:
    'To inspect ordinary user and current-project inline MCP declarations together, or exactly one explicit scope or named profile, without merging plugin-provided servers',
  examples: [
    'allagents mcp list',
    'allagents mcp list --scope project',
    'allagents mcp list --scope user',
    'allagents mcp list --profile markets',
    'allagents --json mcp list --scope user',
    'allagents --json mcp list',
  ],
  expectedOutput:
    'By default lists ordinary user then current-project inline declarations, with deterministic server order within each scope and duplicate names retained separately. Missing configurations are empty; the HOME alias is listed once as user scope. Named profiles and plugin-provided declarations are excluded from the aggregate. --scope or --profile selects exactly one destination. Default JSON has destinations (an object keyed by scope, each with destination, servers, total) and total; explicit-selector JSON retains destination, servers, total. Header, environment, argument, OAuth, URL credential, and sensitive query values are redacted in human and JSON output. Exit 0 on success.',
  options: destinationOptions.map((option) =>
    option.flag === '--scope'
      ? {
          ...option,
          description:
            "List only 'project' or ordinary 'user' declarations (default: both scopes); cannot be combined with --profile",
        }
      : option,
  ),
  outputSchema: {
    destination: destinationOutput,
    servers: 'record<string, redacted MCP server config>',
    destinations: {
      user: {
        destination: { kind: 'user' },
        servers: 'record<string, redacted MCP server config>',
        total: 'number',
      },
      project: {
        destination: { kind: 'project' },
        servers: 'record<string, redacted MCP server config>',
        total: 'number',
      },
    },
    total: 'number',
  },
};

export const mcpGetMeta: AgentCommandMeta = {
  command: 'mcp get',
  description:
    'Show one MCP declaration from a project, user, or profile destination',
  whenToUse:
    'To inspect how one MCP server is declared in exactly one selected destination',
  examples: [
    'allagents mcp get deepwiki',
    'allagents mcp get deepwiki --scope user',
    'allagents mcp get trading --profile markets',
    'allagents --json mcp get trading --profile markets',
  ],
  expectedOutput:
    'Prints the selected server declaration as YAML or structured JSON with header, environment, URL credential, and sensitive query values redacted. Exit 0 on success, 1 if it is not found in that destination.',
  positionals: [
    {
      name: 'name',
      type: 'string',
      required: true,
      description: 'Server name in the selected destination',
    },
  ],
  options: [...destinationOptions],
  outputSchema: {
    destination: destinationOutput,
    name: 'string',
    config: 'redacted MCP server config',
  },
};

export const mcpReauthMeta: AgentCommandMeta = {
  command: 'mcp reauth',
  description: 'Reauthenticate a configured HTTP MCP server',
  whenToUse:
    'Human-operated only: use when an HTTP MCP server in a project, ordinary user, or named profile destination needs a fresh OAuth login. JSON and non-interactive execution are rejected.',
  examples: [
    'allagents mcp reauth tradingview',
    'allagents mcp reauth secure-api --scope user',
    'allagents mcp reauth tradingview --profile markets',
  ],
  expectedOutput:
    'Clears cached OAuth credentials owned by the selected destination, opens a browser for login, accepts a pasted callback URL when the browser is remote, and verifies the connection. Profile credentials remain isolated. Exit 0 on success, 1 on cancellation or failure.',
  positionals: [
    {
      name: 'name',
      type: 'string',
      required: true,
      description: 'HTTP MCP server name in the selected destination',
    },
  ],
  options: [...destinationOptions],
  interaction: 'required',
};

export const mcpUpdateMeta: AgentCommandMeta = {
  command: 'mcp update',
  description:
    'Reconcile MCP servers for one project, user, or profile destination',
  whenToUse:
    "After editing MCP declarations for a project, ordinary user configuration, or named profile. Project and user destinations run MCP-only reconciliation; installed profiles use the full profile ownership planner. To modify a server definition use 'mcp add --force'.",
  examples: [
    'allagents mcp update',
    'allagents mcp update --scope user',
    'allagents mcp update --profile markets',
    'allagents mcp update --offline',
    'allagents --json mcp update --profile markets',
  ],
  expectedOutput:
    'Reconciles the selected destination and prints client results. A declared-only profile is reported as not installed and is not implicitly installed. Exit 0 on success, 1 on failure.',
  options: [
    {
      flag: '--offline',
      type: 'boolean',
      description: 'Use cached plugins without fetching from remote',
    },
    ...destinationOptions,
  ],
  outputSchema: {
    destination: destinationOutput,
    ...reconciliationOutput,
  },
};

export const mcpToolsMeta: AgentCommandMeta = {
  command: 'mcp tools',
  description: 'List tools exposed by an MCP server',
  whenToUse:
    'To discover the complete live tool catalog from one configured MCP server using project declarations before ordinary user configuration unless --scope or --profile selects one destination',
  examples: [
    'allagents mcp tools deepwiki',
    'allagents mcp tools deepwiki --search docs',
    'allagents --json mcp tools deepwiki --scope user',
    'allagents --json mcp tools trading --profile markets',
    'allagents mcp tools -- --option-looking-server',
  ],
  expectedOutput:
    'Connects directly to the selected configured server, lists every tool page, then closes the connection before rendering. Human output prints one block per matching tool. JSON output preserves complete parsed tool records. Exit 0 for a catalog or empty result, 1 for an operational or cleanup failure, and 2 for invalid usage.',
  positionals: [
    {
      name: 'server',
      type: 'string',
      required: true,
      description: 'Configured MCP server name in the selected destination',
    },
  ],
  options: [
    {
      flag: '--search',
      type: 'string',
      description:
        'Case-insensitive substring filter over tool name, title, and description',
    },
    ...runtimeDestinationOptions,
  ],
  outputSchema: {
    destination: destinationOutput,
    server: 'string',
    search: 'string?',
    tools: 'complete parsed MCP tool[]',
    total: 'number',
  },
  jsonFields: [
    'name',
    'title',
    'description',
    'inputSchema',
    'outputSchema',
    'annotations',
    'execution',
    'icons',
    '_meta',
  ],
  skipUpdateCheck: true,
};

export const mcpCallMeta: AgentCommandMeta = {
  command: 'mcp call',
  description: 'Call a tool exposed by an MCP server',
  whenToUse:
    'To inspect live help for, or synchronously invoke, one exact tool on one configured MCP server using project declarations before ordinary user configuration unless --scope or --profile selects one destination',
  examples: [
    'allagents mcp call deepwiki ask_question --help',
    'allagents mcp call deepwiki ask_question --input \'{"question":"How?"}\'',
    'allagents mcp call catalog search --query docs --limit 5',
    'allagents --json mcp call trading quote --profile markets --symbol AAPL',
    'allagents mcp call --help -- --option-looking-server --option-looking-tool',
  ],
  expectedOutput:
    'Discovers the current tool descriptor on the same direct connection used for an invocation. Fully qualified --help reports the live input contract without invoking. Calls preserve content order and complete parsed JSON results. Exit 0 on success, 1 for tool, operational, or cleanup failure, and 2 for invalid usage.',
  positionals: [
    {
      name: 'server',
      type: 'string',
      required: true,
      description: 'Configured MCP server name in the selected destination',
    },
    {
      name: 'tool',
      type: 'string',
      required: true,
      description: 'Exact case-sensitive live tool name',
    },
  ],
  options: [
    {
      flag: '--input',
      type: 'string',
      description:
        'Exact JSON object input; mutually exclusive with live generated tool options',
    },
    ...runtimeDestinationOptions,
  ],
  outputSchema: {
    destination: destinationOutput,
    server: 'string',
    tool: 'string',
    result: 'complete parsed MCP call result (invocation only)?',
    descriptor: 'complete parsed MCP tool descriptor (live help only)?',
    input: {
      mode: 'generated | input-only',
      required: 'string[]',
      options: 'generated tool option[]?',
      reason: 'string?',
    },
  },
  skipUpdateCheck: true,
};

export const mcpProbeMeta: AgentCommandMeta = {
  command: 'mcp probe',
  description:
    'Check a configured MCP connection and inspect its tools and resources',
  whenToUse:
    'To diagnose a configured MCP server using cached or refreshable credentials without starting fresh human consent; check the project first, then ordinary user configuration unless --scope or --profile is explicit',
  examples: [
    'allagents mcp probe notion',
    'allagents --json mcp probe notion --profile work',
  ],
  expectedOutput:
    'Connects to the selected server, lists tools and advertised resources, then closes the session before printing. Missing consent prints the matching mcp reauth command. Exit 0 on success, 1 on failure and 130 when interrupted.',
  positionals: [
    {
      name: 'server',
      type: 'string',
      required: true,
      description: 'Configured server name in the selected destination',
    },
  ],
  options: [...runtimeDestinationOptions],
  outputSchema: {
    destination: destinationOutput,
    server: 'string',
    serverInfo: 'object',
    capabilities: 'object',
    tools: 'MCP tool[]',
    resources: 'MCP resource[]',
  },
  skipUpdateCheck: true,
};
