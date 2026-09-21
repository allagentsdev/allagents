import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { CodexProfileAdapter } from '../../../../src/core/profile/adapters/codex.js';
import packageJson from '../../../../package.json';

describe('Codex profile adapter', () => {
  it('isolates CODEX_HOME, selects an exact named config, and preserves cwd', () => {
    const adapter = new CodexProfileAdapter();
    const context = adapter.resolveContext('review', {
      homeDir: '/home/test',
      workspaceDirectory: '/work/project',
      environment: { CODEX_HOME: '/ambient/codex' },
    });
    const root = '/home/test/.allagents/profiles/review/clients/codex/home';

    expect(context).toEqual({
      profileName: 'review',
      client: 'codex',
      mechanism: 'isolated-home-named-profile',
      root,
      operationContext: {
        client: 'codex',
        scope: 'user',
        nativeScope: 'profile:review',
        root,
        cwd: '/work/project',
        env: { CODEX_HOME: root },
        roots: { config: root, agent: root, data: root },
      },
      fileMapping: { skillsPath: 'skills/', agentFile: 'AGENTS.md' },
      launcher: {
        command: 'codex',
        args: ['--profile', 'review'],
        env: { CODEX_HOME: root },
        requiredFiles: [join(root, 'review.config.toml')],
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

  it('requires authoritative native identities and rejects native skill filters', () => {
    const adapter = new CodexProfileAdapter();
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
          marketplaceSparsePath: 'catalog',
          requestedRef: 'main',
          resolvedRef: 'main',
          resolvedSha: 'a'.repeat(40),
          install: 'native',
        },
        context,
      ).resource,
    ).toMatchObject({
      requestedIdentity: 'demo@tools',
      resolvedIdentity: 'demo@tools',
      provenance: {
        marketplaceName: 'tools',
        marketplaceSource: 'owner/tools',
        marketplaceSparsePath: 'catalog',
        managedMarketplaceRegistration: 'true',
        requestedRef: 'main',
        resolvedRef: 'main',
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
    ).toMatchObject({ success: false, error: expect.stringContaining('authoritative') });
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
    ).toMatchObject({ success: false, error: expect.stringContaining('filtering') });
  });

  it('serializes deterministic strict settings and native MCP secret references', () => {
    const adapter = new CodexProfileAdapter();
    const context = adapter.resolveContext('review', {
      homeDir: '/home/test',
      workspaceDirectory: '/work/project',
    });
    const planned = adapter.serializeSettings(context, {
      plugins: [],
      settings: {
        personality: 'pragmatic',
        web_search: 'cached',
        model: 'gpt-5.6-sol',
        approval_policy: 'never',
        sandbox_mode: 'workspace-write',
        model_reasoning_effort: 'high',
      },
      mcpServers: {
        local: {
          command: 'node',
          args: ['server.js'],
          env: { LOCAL_TOKEN: '${LOCAL_TOKEN}' },
        },
        bridge: {
          command: 'npx',
          args: [
            '-y',
            `allagents@${packageJson.version}`,
            'mcp',
            'proxy',
            'https://mcp.example.test',
            '--profile',
            'review',
            '--header-env',
            'Authorization=REMOTE_TOKEN',
          ],
          env: { REMOTE_TOKEN: '${REMOTE_TOKEN}' },
        },
        remote: {
          url: 'https://mcp.example.test',
          headers: {
            Authorization: '${REMOTE_TOKEN}',
          },
        },
        ignored: { command: 'ignored', clients: ['pi'] },
      },
    });

    expect(planned?.path).toBe(join(context.root, 'review.config.toml'));
    expect(planned?.mode).toBe(0o600);
    expect(planned?.content).toBe(
      'approval_policy = "never"\n' +
        'model = "gpt-5.6-sol"\n' +
        'model_reasoning_effort = "high"\n' +
        'personality = "pragmatic"\n' +
        'sandbox_mode = "workspace-write"\n' +
        'web_search = "cached"\n\n' +
        '[mcp_servers.bridge]\n' +
        `args = ["-y", "allagents@${packageJson.version}", "mcp", "proxy", "https://mcp.example.test", "--profile", "review", "--header-env", "Authorization=REMOTE_TOKEN"]\n` +
        'command = "npx"\n' +
        'env_vars = ["REMOTE_TOKEN"]\n\n' +
        '[mcp_servers.local]\n' +
        'args = ["server.js"]\n' +
        'command = "node"\n' +
        'env_vars = ["LOCAL_TOKEN"]\n\n' +
        '[mcp_servers.remote]\n' +
        'url = "https://mcp.example.test"\n\n' +
        '[mcp_servers.remote.env_http_headers]\n' +
        'Authorization = "REMOTE_TOKEN"\n',
    );
    expect(planned?.content).not.toContain('${LOCAL_TOKEN}');
    expect(planned?.content).not.toContain('${REMOTE_TOKEN}');
    expect(adapter.serializeSettings(context, { plugins: [] })?.content).toBe(
      '\n',
    );
    expect(adapter.serializeMcp(context, { plugins: [] })).toBeNull();
  });

  it('fails closed when a portable MCP reference cannot be represented natively', () => {
    const adapter = new CodexProfileAdapter();
    const context = adapter.resolveContext('review', {
      homeDir: '/home/test',
      workspaceDirectory: '/work/project',
    });
    expect(() =>
      adapter.serializeSettings(context, {
        plugins: [],
        mcpServers: {
          remapped: {
            command: 'server',
            env: { DESTINATION: '${SOURCE_TOKEN}' },
          },
        },
      }),
    ).toThrow("cannot remap ${SOURCE_TOKEN} to 'DESTINATION'");
    expect(() =>
      adapter.serializeSettings(context, {
        plugins: [],
        mcpServers: {
          argument: {
            command: 'server',
            args: ['--token', '${TOKEN}'],
          },
        },
      }),
    ).toThrow('cannot interpolate portable secret references');
  });
});
