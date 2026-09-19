import { describe, expect, it } from 'bun:test';
import {
  ProfileNameSchema,
  ProjectWorkspaceConfigSchema,
  UserWorkspaceConfigSchema,
  WorkspaceConfigSchema,
  getLauncherCollisionKey,
} from '../../../src/models/workspace-config.js';

const ordinaryConfig = {
  repositories: [{ path: '../project' }],
  plugins: ['owner/plugin'],
  clients: ['pi'],
};

function userConfigWithProfile(profile: unknown) {
  return {
    profiles: {
      research: profile,
    },
  };
}

function expectProfileMcpArgsRejected(
  args: string[],
  credentialIndex: number,
): void {
  const result = UserWorkspaceConfigSchema.safeParse(
    userConfigWithProfile({
      clients: [{ name: 'pi' }],
      mcpServers: {
        server: { command: 'local-mcp', args },
      },
    }),
  );

  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.issues).toEqual([
    {
      code: 'custom',
      path: [
        'profiles',
        'research',
        'mcpServers',
        'server',
        'args',
        credentialIndex,
      ],
      message: 'Secret arguments must be exact ${ENV_VAR} references',
    },
  ]);
}

describe('profile workspace declarations', () => {
  it('accepts profiles-only Pi and OMP declarations and applies declaration defaults', () => {
    const result = UserWorkspaceConfigSchema.parse({
      profiles: {
        'pi-research': {
          clients: [{ name: 'pi', launcher: 'pi-research' }],
          plugins: [
            {
              source: 'npm:pi-mcp-adapter',
              ref: 'latest',
              install: 'native',
              clients: ['pi'],
              skills: { exclude: ['unused'] },
            },
          ],
          mcpServers: {
            research: {
              command: 'research-mcp',
              args: ['--stdio'],
              env: { RESEARCH_TOKEN: '${RESEARCH_TOKEN}' },
              clients: ['pi'],
            },
          },
        },
        'compound-engineering': {
          clients: [
            {
              name: 'omp',
              install: 'native',
              launcher: 'omp-compound',
              settings: {},
            },
          ],
          plugins: [
            {
              source: 'EveryInc/compound-engineering-plugin',
              ref: 'main',
              install: 'native',
              skills: ['brainstorming'],
            },
          ],
        },
      },
    });

    expect(result.repositories).toEqual([]);
    expect(result.plugins).toEqual([]);
    expect(result.clients).toEqual([]);
    expect(result.profiles?.['pi-research']?.clients[0]).toEqual({
      name: 'pi',
      install: 'file',
      launcher: 'pi-research',
      settings: {},
    });
    expect(result.profiles?.['compound-engineering']?.clients[0]?.install).toBe(
      'native',
    );
  });

  it('keeps ordinary user and project configs backward compatible', () => {
    expect(UserWorkspaceConfigSchema.safeParse(ordinaryConfig).success).toBe(
      true,
    );
    expect(ProjectWorkspaceConfigSchema.safeParse(ordinaryConfig).success).toBe(
      true,
    );
    expect(WorkspaceConfigSchema.safeParse(ordinaryConfig).success).toBe(true);
  });

  it('rejects profiles in project-compatible schemas', () => {
    const config = userConfigWithProfile({ clients: [{ name: 'pi' }] });
    expect(ProjectWorkspaceConfigSchema.safeParse(config).success).toBe(false);
    expect(WorkspaceConfigSchema.safeParse(config).success).toBe(false);
  });

  it('validates portable profile and launcher names', () => {
    expect(ProfileNameSchema.safeParse('a').success).toBe(true);
    expect(ProfileNameSchema.safeParse(`a${'b'.repeat(63)}`).success).toBe(true);
    expect(ProfileNameSchema.safeParse('com0').success).toBe(true);
    expect(ProfileNameSchema.safeParse('lpt0').success).toBe(true);

    for (const name of [
      '',
      `a${'b'.repeat(64)}`,
      '.',
      '..',
      '.hidden',
      '-leading',
      '_leading',
      'Uppercase',
      'with/slash',
      'trailing.',
      'con',
      'nul.txt',
      'com9.log',
      'lpt1',
    ]) {
      expect(ProfileNameSchema.safeParse(name).success).toBe(false);
      expect(
        UserWorkspaceConfigSchema.safeParse({
          profiles: { [name]: { clients: [{ name: 'pi' }] } },
        }).success,
      ).toBe(false);
    }
  });

  it('requires unique object-form clients and at least one client', () => {
    expect(
      UserWorkspaceConfigSchema.safeParse(
        userConfigWithProfile({ clients: [] }),
      ).success,
    ).toBe(false);
    expect(
      UserWorkspaceConfigSchema.safeParse(
        userConfigWithProfile({ clients: ['pi'] }),
      ).success,
    ).toBe(false);
    expect(
      UserWorkspaceConfigSchema.safeParse(
        userConfigWithProfile({
          clients: [{ name: 'pi' }, { name: 'pi', install: 'native' }],
        }),
      ).success,
    ).toBe(false);
  });

  it('accepts unsupported client names only with strict empty settings', () => {
    expect(
      UserWorkspaceConfigSchema.safeParse(
        userConfigWithProfile({ clients: [{ name: 'cursor', settings: {} }] }),
      ).success,
    ).toBe(true);
    expect(
      UserWorkspaceConfigSchema.safeParse(
        userConfigWithProfile({
          clients: [{ name: 'pi', settings: { theme: 'dark' } }],
        }),
      ).success,
    ).toBe(false);
    expect(
      UserWorkspaceConfigSchema.safeParse(
        userConfigWithProfile({
          clients: [{ name: 'omp', settings: { configPath: '/tmp' } }],
        }),
      ).success,
    ).toBe(false);
  });

  it('accepts only conservative documented Claude profile settings', () => {
    const settings = {
      model: 'sonnet',
      effortLevel: 'xhigh',
      fallbackModel: ['haiku'],
      outputStyle: 'Explanatory',
      autoMemoryEnabled: false,
      spinnerTipsEnabled: false,
      autoUpdatesChannel: 'stable',
    };
    const result = UserWorkspaceConfigSchema.parse(
      userConfigWithProfile({
        clients: [{ name: 'claude', settings }],
      }),
    );
    expect(result.profiles?.research?.clients[0]?.settings).toEqual(settings);

    for (const invalid of [
      { unknown: true },
      { effortLevel: 'max' },
      { fallbackModel: [] },
      { fallbackModel: [''] },
      { autoUpdatesChannel: 'prerelease' },
      { autoMemoryEnabled: 'false' },
    ]) {
      expect(
        UserWorkspaceConfigSchema.safeParse(
          userConfigWithProfile({
            clients: [{ name: 'claude', settings: invalid }],
          }),
        ).success,
      ).toBe(false);
    }
  });

  it('accepts only documented OpenCode profile settings', () => {
    const result = UserWorkspaceConfigSchema.parse(
      userConfigWithProfile({
        clients: [
          {
            name: 'opencode',
            settings: {
              model: 'anthropic/claude-sonnet-4-5',
              small_model: 'anthropic/claude-haiku-4-5',
              share: 'disabled',
              autoupdate: 'notify',
              snapshot: false,
              subagent_depth: 2,
              logLevel: 'WARN',
              enabled_providers: ['anthropic'],
            },
          },
        ],
      }),
    );
    expect(result.profiles?.research?.clients[0]?.settings).toEqual({
      model: 'anthropic/claude-sonnet-4-5',
      small_model: 'anthropic/claude-haiku-4-5',
      share: 'disabled',
      autoupdate: 'notify',
      snapshot: false,
      subagent_depth: 2,
      logLevel: 'WARN',
      enabled_providers: ['anthropic'],
    });
    expect(
      UserWorkspaceConfigSchema.safeParse(
        userConfigWithProfile({
          clients: [
            { name: 'opencode', settings: { configPath: '/tmp/opencode' } },
          ],
        }),
      ).success,
    ).toBe(false);
    expect(
      UserWorkspaceConfigSchema.safeParse(
        userConfigWithProfile({
          clients: [{ name: 'opencode', settings: { share: 'always' } }],
        }),
      ).success,
    ).toBe(false);
  });

  it('accepts only documented Copilot profile settings', () => {
    const result = UserWorkspaceConfigSchema.parse(
      userConfigWithProfile({
        clients: [
          {
            name: 'copilot',
            settings: {
              model: 'claude-sonnet-4.5',
              autoUpdate: false,
              remote: 'off',
              remoteExport: false,
              'ide.autoConnect': false,
              disableAllHooks: true,
              disabledMcpServers: ['github-mcp-server'],
            },
          },
        ],
      }),
    );
    expect(result.profiles?.research?.clients[0]?.settings).toEqual({
      model: 'claude-sonnet-4.5',
      autoUpdate: false,
      remote: 'off',
      remoteExport: false,
      'ide.autoConnect': false,
      disableAllHooks: true,
      disabledMcpServers: ['github-mcp-server'],
    });
    for (const settings of [
      { configPath: '/tmp/copilot' },
      { remote: 'sometimes' },
      { commandHistoryMaxSize: 0 },
      { disabledMcpServers: [''] },
    ]) {
      expect(
        UserWorkspaceConfigSchema.safeParse(
          userConfigWithProfile({
            clients: [{ name: 'copilot', settings }],
          }),
        ).success,
      ).toBe(false);
    }
  });

  it('accepts only the conservative documented Codex profile settings', () => {
    const result = UserWorkspaceConfigSchema.parse(
      userConfigWithProfile({
        clients: [
          {
            name: 'codex',
            settings: {
              model: 'gpt-5.6-sol',
              model_reasoning_effort: 'xhigh',
              model_reasoning_summary: 'concise',
              model_verbosity: 'low',
              approval_policy: 'on-request',
              sandbox_mode: 'workspace-write',
              web_search: 'indexed',
              personality: 'pragmatic',
            },
          },
        ],
      }),
    );
    expect(result.profiles?.research?.clients[0]?.settings).toEqual({
      model: 'gpt-5.6-sol',
      model_reasoning_effort: 'xhigh',
      model_reasoning_summary: 'concise',
      model_verbosity: 'low',
      approval_policy: 'on-request',
      sandbox_mode: 'workspace-write',
      web_search: 'indexed',
      personality: 'pragmatic',
    });
    for (const settings of [
      { unknown: true },
      { approval_policy: 'untrusted' },
      { sandbox_mode: 'full' },
      { web_search: true },
      { model_reasoning_effort: 'extreme' },
    ]) {
      expect(
        UserWorkspaceConfigSchema.safeParse(
          userConfigWithProfile({
            clients: [{ name: 'codex', settings }],
          }),
        ).success,
      ).toBe(false);
    }
  });

  it('rejects unknown and machine-generated fields throughout declarations', () => {
    for (const profile of [
      { clients: [{ name: 'pi', scope: 'user' }] },
      { clients: [{ name: 'pi', root: '/tmp/pi' }] },
      { clients: [{ name: 'pi' }], instructions: 'AGENTS.md' },
      { clients: [{ name: 'pi' }], ownership: {} },
      { clients: [{ name: 'pi' }], state: {} },
      {
        clients: [{ name: 'pi' }],
        plugins: [{ source: 'owner/plugin', resolvedRef: 'abc123' }],
      },
      {
        clients: [{ name: 'pi' }],
        plugins: [
          { source: 'owner/plugin', skills: { exclude: [], generated: true } },
        ],
      },
    ]) {
      expect(
        UserWorkspaceConfigSchema.safeParse(userConfigWithProfile(profile))
          .success,
      ).toBe(false);
    }
  });

  it('requires plugin selectors to be unique members of the profile', () => {
    for (const clients of [['omp'], ['pi', 'pi']]) {
      const result = UserWorkspaceConfigSchema.safeParse(
        userConfigWithProfile({
          clients: [{ name: 'pi' }],
          plugins: [{ source: 'owner/plugin', clients }],
        }),
      );
      expect(result.success).toBe(false);
    }
  });

  it('requires MCP selectors to be unique members of the profile', () => {
    for (const clients of [['omp'], ['pi', 'pi']]) {
      const result = UserWorkspaceConfigSchema.safeParse(
        userConfigWithProfile({
          clients: [{ name: 'pi' }],
          mcpServers: {
            local: { command: 'local-mcp', clients },
          },
        }),
      );
      expect(result.success).toBe(false);
    }
  });

  it('accepts destination-local profile proxy policy', () => {
    const result = UserWorkspaceConfigSchema.parse(
      userConfigWithProfile({
        clients: [{ name: 'codex' }, { name: 'copilot' }],
        mcpServers: {
          remote: { url: 'https://mcp.example', clients: ['codex', 'copilot'] },
        },
        mcpProxy: {
          servers: {
            remote: { proxy: ['codex', 'copilot'] },
            shared: { proxy: ['*'] },
          },
        },
      }),
    );

    expect(result.profiles?.research?.mcpProxy).toEqual({
      clients: [],
      servers: {
        remote: { proxy: ['codex', 'copilot'] },
        shared: { proxy: ['*'] },
      },
    });
  });

  it('requires profile proxy selectors to be unique declared clients', () => {
    for (const mcpProxy of [
      { clients: ['omp'] },
      { clients: ['codex', 'codex'] },
      { servers: { remote: { proxy: ['omp'] } } },
      { servers: { remote: { proxy: ['codex', 'codex'] } } },
    ]) {
      const result = UserWorkspaceConfigSchema.safeParse(
        userConfigWithProfile({
          clients: [{ name: 'codex' }],
          mcpProxy,
        }),
      );
      expect(result.success).toBe(false);
    }
  });

  it('requires exact portable secret references in profile MCP credentials', () => {
    for (const server of [
      { command: 'local-mcp', env: { TOKEN: 'plaintext' } },
      { command: 'local-mcp', env: { TOKEN: '${1TOKEN}' } },
      { command: 'local-mcp', env: { TOKEN: 'prefix-${TOKEN}' } },
      { url: 'https://mcp.example', headers: { Authorization: 'Bearer token' } },
      { url: 'https://mcp.example', headers: { Authorization: '${TOKEN' } },
      { command: 'local-mcp', args: ['${BAD-NAME}'] },
    ]) {
      const result = UserWorkspaceConfigSchema.safeParse(
        userConfigWithProfile({
          clients: [{ name: 'pi' }],
          mcpServers: { server },
        }),
      );
      expect(result.success).toBe(false);
    }

    expect(
      UserWorkspaceConfigSchema.safeParse(
        userConfigWithProfile({
          clients: [{ name: 'pi' }],
          mcpServers: {
            remote: {
              url: 'https://mcp.example',
              headers: { Authorization: '${MCP_TOKEN}' },
            },
          },
        }),
      ).success,
    ).toBe(true);
  });

  it('rejects inline plaintext secret assignments in profile MCP arguments', () => {
    expectProfileMcpArgsRejected(['--token=plaintext'], 0);
  });

  it('rejects plaintext values following sensitive profile MCP options', () => {
    expectProfileMcpArgsRejected(['--password', 'plaintext'], 1);
  });

  it('rejects plaintext bearer credentials in profile MCP arguments', () => {
    expectProfileMcpArgsRejected(
      ['--header', 'Authorization: Bearer plaintext'],
      1,
    );
  });

  it('accepts exact references at profile MCP credential positions', () => {
    const result = UserWorkspaceConfigSchema.safeParse(
      userConfigWithProfile({
        clients: [{ name: 'pi' }],
        mcpServers: {
          server: {
            command: 'local-mcp',
            args: [
              '--token=${MCP_TOKEN}',
              '--password',
              '${MCP_PASSWORD}',
              '--header',
              'Authorization: Bearer ${MCP_BEARER}',
              '--port',
              '3000',
              '--verbose',
            ],
          },
        },
      }),
    );

    expect(result.success).toBe(true);
  });

  it('rejects duplicate and platform-equivalent launcher identities', () => {
    for (const launchers of [
      ['agent', 'agent'],
      ['agent', 'agent.cmd'],
      ['agent.ps1', 'agent.cmd'],
    ]) {
      const result = UserWorkspaceConfigSchema.safeParse({
        profiles: {
          first: { clients: [{ name: 'pi', launcher: launchers[0] }] },
          second: { clients: [{ name: 'omp', launcher: launchers[1] }] },
        },
      });
      expect(result.success).toBe(false);
    }

    expect(getLauncherCollisionKey('Agent.PS1')).toBe('agent');
    expect(getLauncherCollisionKey('AGENT.cmd')).toBe('agent');
    expect(
      UserWorkspaceConfigSchema.safeParse({
        profiles: {
          first: { clients: [{ name: 'pi', launcher: 'pi-research' }] },
          second: { clients: [{ name: 'omp', launcher: 'omp-research' }] },
        },
      }).success,
    ).toBe(true);
  });
});
