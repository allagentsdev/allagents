import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { ClaudeProfileAdapter } from '../../../../src/core/profile/adapters/claude.js';
import { serializeProfileMcpServers } from '../../../../src/core/profile/adapters/mcp.js';

describe('Claude profile adapter', () => {
  it('isolates the Claude config and plugin roots while preserving cwd', () => {
    const adapter = new ClaudeProfileAdapter();
    const context = adapter.resolveContext('review', {
      homeDir: '/home/test',
      workspaceDirectory: '/work/project',
      environment: {
        CLAUDE_CONFIG_DIR: '/ambient/claude',
        CLAUDE_CODE_PLUGIN_CACHE_DIR: '/ambient/plugins',
        CLAUDE_CODE_PLUGIN_SEED_DIR: '/ambient/seed',
        CLAUDE_CODE_PROJECT_DIR_NAME: 'ambient-project',
        KEEP_ME: 'yes',
      },
    });
    const root = '/home/test/.allagents/profiles/review/clients/claude/config';
    const plugins = join(root, 'plugins');
    const selectedEnvironment = {
      CLAUDE_CONFIG_DIR: root,
      CLAUDE_CODE_PLUGIN_CACHE_DIR: plugins,
      CLAUDE_CODE_PLUGIN_SEED_DIR: undefined,
      CLAUDE_CODE_PROJECT_DIR_NAME: undefined,
    };

    expect(context).toEqual({
      profileName: 'review',
      client: 'claude',
      mechanism: 'configuration-root',
      root,
      operationContext: {
        client: 'claude',
        scope: 'user',
        nativeScope: 'profile:review',
        root,
        cwd: '/work/project',
        env: { KEEP_ME: 'yes', ...selectedEnvironment },
        roots: {
          config: root,
          agent: root,
          data: root,
          plugins,
        },
      },
      fileMapping: {
        commandsPath: 'commands/',
        skillsPath: 'skills/',
        agentsPath: 'agents/',
        hooksPath: 'hooks/',
        agentFile: 'CLAUDE.md',
      },
      launcher: {
        command: 'claude',
        args: ['--mcp-config', join(root, 'allagents.mcp.json')],
        env: selectedEnvironment,
        requiredFiles: [
          join(root, 'settings.json'),
          join(root, 'allagents.mcp.json'),
        ],
      },
    });
    expect(adapter.capabilities).toEqual({
      nativeInstall: true,
      fileInstall: true,
      launchers: true,
      skillFilters: true,
      mcp: true,
      settings: true,
      status: true,
      cleanup: true,
      recursiveRootCleanup: true,
    });
  });

  it('requires authoritative native identities and rejects unsupported filtering', () => {
    const adapter = new ClaudeProfileAdapter();
    const context = adapter.resolveContext('review', {
      homeDir: '/home/test',
      workspaceDirectory: '/work/project',
    });
    expect(
      adapter.resolveNativeSource(
        {
          declarationIndex: 0,
          source: 'owner/tools',
          marketplace: 'tools',
          pluginName: 'demo',
          marketplaceSource: 'owner/tools',
          marketplaceRegistrationManaged: true,
          requestedRef: 'stable',
          resolvedRef: 'stable',
          resolvedSha: 'a'.repeat(40),
          install: 'native',
        },
        context,
      ).resource,
    ).toMatchObject({
      requestedIdentity: 'owner/tools',
      resolvedIdentity: 'demo@tools',
      provenance: {
        marketplaceName: 'tools',
        marketplaceSource: 'owner/tools',
        managedMarketplaceRegistration: 'true',
        requestedRef: 'stable',
        resolvedRef: 'stable',
        resolvedSha: 'a'.repeat(40),
      },
    });
    expect(
      adapter.resolveNativeSource(
        {
          declarationIndex: 0,
          source: 'owner/tools',
          install: 'native',
        },
        context,
      ),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining('authoritative'),
    });
    expect(
      adapter.resolveNativeSource(
        {
          declarationIndex: 0,
          source: 'owner/tools',
          marketplace: 'tools',
          pluginName: 'demo',
          install: 'native',
          skills: ['one'],
        },
        context,
      ),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining('filtering'),
    });
    expect(
      adapter.resolveNativeSource(
        {
          declarationIndex: 0,
          source: 'owner/tools',
          marketplace: 'tools',
          pluginName: 'demo',
          marketplaceSparsePath: 'catalog',
          install: 'native',
        },
        context,
      ),
    ).toMatchObject({
      success: false,
      error: expect.stringContaining('sparse'),
    });
  });

  it('serializes strict settings with declarative native plugin state', () => {
    const adapter = new ClaudeProfileAdapter();
    const context = adapter.resolveContext('review', {
      homeDir: '/home/test',
      workspaceDirectory: '/work/project',
    });
    const planned = adapter.serializeSettings(context, {
      plugins: [
        {
          declarationIndex: 0,
          source: '/market',
          marketplace: 'tools',
          pluginName: 'demo',
          marketplaceSource: '/market',
          install: 'native',
        },
      ],
      settings: {
        model: 'sonnet',
        effortLevel: 'high',
        fallbackModel: ['haiku'],
        outputStyle: 'Explanatory',
        autoMemoryEnabled: false,
        spinnerTipsEnabled: false,
        autoUpdatesChannel: 'stable',
      },
    });

    expect(planned.path).toBe(join(context.root, 'settings.json'));
    expect(planned.mode).toBe(0o600);
    expect(JSON.parse(planned.content)).toEqual({
      model: 'sonnet',
      effortLevel: 'high',
      fallbackModel: ['haiku'],
      outputStyle: 'Explanatory',
      autoMemoryEnabled: false,
      spinnerTipsEnabled: false,
      autoUpdatesChannel: 'stable',
      extraKnownMarketplaces: {
        tools: {
          source: {
            source: 'directory',
            path: '/market',
          },
        },
      },
      enabledPlugins: {
        'demo@tools': true,
      },
    });
    expect(planned.content.endsWith('\n')).toBe(true);
    expect(
      adapter.serializeSettings(context, { plugins: [] }).content,
    ).toBe('{}\n');
  });

  it('serializes additive MCP with unresolved portable secrets', () => {
    const adapter = new ClaudeProfileAdapter();
    const context = adapter.resolveContext('review', {
      homeDir: '/home/test',
      workspaceDirectory: '/work/project',
    });
    const planned = adapter.serializeMcp(context, {
      plugins: [],
      mcpServers: {
        local: {
          command: 'node',
          args: ['server.js'],
          env: { LOCAL_TOKEN: '${LOCAL_TOKEN}' },
        },
        remote: {
          url: 'https://mcp.example.test',
          headers: { Authorization: '${REMOTE_TOKEN}' },
        },
        ignored: { command: 'ignored', clients: ['pi'] },
      },
    });

    expect(planned.path).toBe(join(context.root, 'allagents.mcp.json'));
    expect(planned.mode).toBe(0o600);
    expect(JSON.parse(planned.content)).toEqual({
      mcpServers: {
        local: {
          type: 'stdio',
          command: 'node',
          args: ['server.js'],
          env: { LOCAL_TOKEN: '${LOCAL_TOKEN}' },
        },
        remote: {
          type: 'http',
          url: 'https://mcp.example.test',
          headers: { Authorization: '${REMOTE_TOKEN}' },
        },
      },
    });
    expect(planned.content).not.toContain('resolved-secret');
    expect(
      adapter.serializeMcp(context, { plugins: [] }).content,
    ).toBe('{\n  "mcpServers": {}\n}\n');
  });

  it('round-trips an OAuth bridge without resolving exact URL query references', () => {
    const adapter = new ClaudeProfileAdapter();
    const context = adapter.resolveContext('markets', {
      homeDir: '/home/test',
      workspaceDirectory: '/work/project',
    });
    const url =
      'https://example.invalid/mcp?token=${FIXTURE_TOKEN}&tag=one&tag=two';
    const previousToken = process.env.FIXTURE_TOKEN;
    process.env.FIXTURE_TOKEN = 'fixture-secret-never-serialize';
    try {
      const bridged = serializeProfileMcpServers(
        {
          plugins: [],
          mcpServers: {
            fixture: { url, oauth: { clientName: 'Codex' } },
          },
        },
        'claude',
        'markets',
      );
      expect(bridged).not.toBeNull();
      const planned = adapter.serializeMcp(context, {
        plugins: [],
        mcpServers: bridged ?? {},
      });
      const fixture = JSON.parse(planned.content).mcpServers.fixture;
      expect(fixture.command).toBe('npx');
      expect(fixture.args).toEqual([
        '-y',
        expect.stringMatching(/^allagents@\d+\.\d+\.\d+/),
        'mcp',
        'proxy',
        url,
        '--profile',
        'markets',
        '--oauth-client-name',
        'Codex',
      ]);
      expect(planned.content).not.toContain('fixture-secret-never-serialize');
    } finally {
      if (previousToken === undefined) delete process.env.FIXTURE_TOKEN;
      else process.env.FIXTURE_TOKEN = previousToken;
    }
  });
});
