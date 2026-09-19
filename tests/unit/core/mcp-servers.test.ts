import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import {
  addMcpServer,
  buildMcpServerConfigFromFlags,
  getMcpServer,
  listMcpServers,
  parseKeyValuePairs,
  removeMcpServer,
  resolveMcpDestination,
  type McpDestination,
} from '../../../src/core/mcp-servers.js';

function makeTempWorkspace(): string {
  const dir = join(
    tmpdir(),
    `mcp-servers-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(dir, '.allagents'), { recursive: true });
  writeFileSync(
    join(dir, '.allagents', 'workspace.yaml'),
    'repositories: []\nplugins: []\nclients:\n  - claude\n',
    'utf-8',
  );
  return dir;
}

function readWorkspace(dir: string): Record<string, unknown> {
  return load(readFileSync(join(dir, '.allagents', 'workspace.yaml'), 'utf-8')) as Record<
    string,
    unknown
  >;
}


describe('destination-aware MCP declarations', () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = makeTempWorkspace();
    configPath = join(dir, '.allagents', 'workspace.yaml');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('rejects simultaneous scope and profile selectors', () => {
    expect(() =>
      resolveMcpDestination({
        cwd: dir,
        scope: 'user',
        profile: 'research',
      }),
    ).toThrow('--scope and --profile cannot be used together');
  });

  test('resolves an unflagged command from HOME to the user destination', () => {
    const originalHome = process.env.ALLAGENTS_TEST_HOME;
    process.env.ALLAGENTS_TEST_HOME = dir;
    try {
      expect(resolveMcpDestination({ cwd: dir })).toEqual({
        kind: 'user',
        configPath: join(dir, '.allagents', 'workspace.yaml'),
      });
    } finally {
      if (originalHome === undefined) {
        delete process.env.ALLAGENTS_TEST_HOME;
      } else {
        process.env.ALLAGENTS_TEST_HOME = originalHome;
      }
    }
  });

  test('rejects explicit project scope from HOME instead of aliasing user state', () => {
    const originalHome = process.env.ALLAGENTS_TEST_HOME;
    process.env.ALLAGENTS_TEST_HOME = dir;
    try {
      expect(() =>
        resolveMcpDestination({ cwd: dir, scope: 'project' }),
      ).toThrow('--scope project cannot be used from the home directory');
    } finally {
      if (originalHome === undefined) {
        delete process.env.ALLAGENTS_TEST_HOME;
      } else {
        process.env.ALLAGENTS_TEST_HOME = originalHome;
      }
    }
  });

  test('mutates ordinary user declarations without changing profiles', async () => {
    writeFileSync(
      configPath,
      `repositories: []
plugins: []
clients:
  - codex
profiles:
  research:
    clients:
      - name: copilot
`,
      'utf-8',
    );
    const destination: McpDestination = {
      kind: 'user',
      configPath,
    };

    const result = await addMcpServer(
      destination,
      'remote',
      { type: 'http', url: 'https://mcp.example' },
      { proxy: { clients: ['codex'] } },
    );

    expect(result.success).toBe(true);
    expect(await getMcpServer(destination, 'remote')).toEqual({
      type: 'http',
      url: 'https://mcp.example',
    });
    expect(await listMcpServers(destination)).toEqual({
      remote: { type: 'http', url: 'https://mcp.example' },
    });
    expect(readWorkspace(dir)).toMatchObject({
      profiles: {
        research: {
          clients: [{ name: 'copilot' }],
        },
      },
      mcpProxy: {
        servers: {
          remote: { proxy: ['codex'] },
        },
      },
    });
  });

  test('serializes concurrent declaration updates without losing either server', async () => {
    const destination: McpDestination = {
      kind: 'project',
      workspacePath: dir,
      configPath,
    };

    const [first, second] = await Promise.all([
      addMcpServer(destination, 'first', { command: 'first-mcp' }),
      addMcpServer(destination, 'second', { command: 'second-mcp' }),
    ]);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(await listMcpServers(destination)).toEqual({
      first: { command: 'first-mcp' },
      second: { command: 'second-mcp' },
    });
  });

  test('rejects a symbolic-link workspace config without replacing its target', async () => {
    const targetPath = join(dir, 'workspace-target.yaml');
    const original = readFileSync(configPath, 'utf8');
    writeFileSync(targetPath, original, 'utf8');
    rmSync(configPath);
    symlinkSync(targetPath, configPath);
    const destination: McpDestination = {
      kind: 'project',
      workspacePath: dir,
      configPath,
    };

    const result = await addMcpServer(destination, 'blocked', {
      command: 'blocked-mcp',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('symbolic-link workspace config');
    expect(readFileSync(targetPath, 'utf8')).toBe(original);
  });

  test('atomically writes profile server and proxy policy', async () => {
    writeFileSync(
      configPath,
      `repositories: []
plugins: []
clients: []
profiles:
  markets:
    clients:
      - name: codex
      - name: copilot
`,
      'utf-8',
    );
    const destination: McpDestination = {
      kind: 'profile',
      name: 'markets',
      configPath,
    };

    const result = await addMcpServer(
      destination,
      'tradingview',
      {
        type: 'http',
        url: 'https://mcp.tradingview.com/mcp',
        clients: ['codex', 'copilot'],
      },
      { proxy: { clients: ['codex', 'copilot'] } },
    );

    expect(result.success).toBe(true);
    expect(readWorkspace(dir)).toMatchObject({
      profiles: {
        markets: {
          mcpServers: {
            tradingview: {
              type: 'http',
              url: 'https://mcp.tradingview.com/mcp',
              clients: ['codex', 'copilot'],
            },
          },
          mcpProxy: {
            servers: {
              tradingview: { proxy: ['codex', 'copilot'] },
            },
          },
        },
      },
    });
  });

  test('rejects invalid profile selectors without partially writing', async () => {
    writeFileSync(
      configPath,
      `profiles:
  markets:
    clients:
      - name: codex
`,
      'utf-8',
    );
    const before = readFileSync(configPath, 'utf-8');
    const destination: McpDestination = {
      kind: 'profile',
      name: 'markets',
      configPath,
    };

    const result = await addMcpServer(
      destination,
      'remote',
      {
        type: 'http',
        url: 'https://mcp.example',
        clients: ['copilot'],
      },
      { proxy: { clients: ['copilot'] } },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not declared by this profile');
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  test('rejects an invalid profile server name before writing', async () => {
    writeFileSync(
      configPath,
      `profiles:
  markets:
    clients:
      - name: codex
`,
      'utf-8',
    );
    const before = readFileSync(configPath, 'utf-8');
    const result = await addMcpServer(
      { kind: 'profile', name: 'markets', configPath },
      'invalid/name',
      { command: 'local-mcp' },
      { proxy: false },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('Expected 1-100 ASCII');
    expect(readFileSync(configPath, 'utf-8')).toBe(before);
  });

  test('rejects an undeclared profile destination', async () => {
    const result = await addMcpServer(
      { kind: 'profile', name: 'missing', configPath },
      'remote',
      { command: 'local-mcp' },
      { proxy: false },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("Profile 'missing' is not declared");
  });

  test('removes only the selected profile declaration and proxy policy', async () => {
    writeFileSync(
      configPath,
      `profiles:
  markets:
    clients:
      - name: codex
    mcpServers:
      remote:
        url: https://mcp.example
    mcpProxy:
      servers:
        remote:
          proxy:
            - codex
  research:
    clients:
      - name: copilot
    mcpServers:
      keep:
        command: keep-mcp
`,
      'utf-8',
    );
    const destination: McpDestination = {
      kind: 'profile',
      name: 'markets',
      configPath,
    };

    const result = await removeMcpServer(destination, 'remote');

    expect(result.success).toBe(true);
    expect(readWorkspace(dir)).toMatchObject({
      profiles: {
        markets: {
          clients: [{ name: 'codex' }],
        },
        research: {
          mcpServers: {
            keep: { command: 'keep-mcp' },
          },
        },
      },
    });
    expect(
      (
        (readWorkspace(dir).profiles as Record<string, Record<string, unknown>>)
          .markets
      ).mcpServers,
    ).toBeUndefined();
    expect(
      (
        (readWorkspace(dir).profiles as Record<string, Record<string, unknown>>)
          .markets
      ).mcpProxy,
    ).toBeUndefined();
  });
});

describe('buildMcpServerConfigFromFlags', () => {
  test('auto-detects http transport from URL', () => {
    const result = buildMcpServerConfigFromFlags({
      commandOrUrl: 'https://mcp.example.com',
    });
    expect('config' in result).toBe(true);
    if ('config' in result) {
      expect(result.config).toEqual({ type: 'http', url: 'https://mcp.example.com' });
    }
  });

  test('builds stdio config with args and env', () => {
    const result = buildMcpServerConfigFromFlags({
      commandOrUrl: 'npx',
      args: ['-y', 'mcp-server'],
      env: { KEY: 'value' },
    });
    expect('config' in result).toBe(true);
    if ('config' in result) {
      expect(result.config).toEqual({
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'mcp-server'],
        env: { KEY: 'value' },
      });
    }
  });

  test('rejects args for http transport', () => {
    const result = buildMcpServerConfigFromFlags({
      commandOrUrl: 'https://mcp.example.com',
      args: ['foo'],
    });
    expect('error' in result).toBe(true);
  });

  test('rejects explicit http transport for non-URL', () => {
    const result = buildMcpServerConfigFromFlags({
      commandOrUrl: 'npx',
      transport: 'http',
    });
    expect('error' in result).toBe(true);
  });

  test('rejects explicit stdio transport for URL', () => {
    const result = buildMcpServerConfigFromFlags({
      commandOrUrl: 'https://mcp.example.com',
      transport: 'stdio',
    });
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('stdio transport requires a command');
    }
  });

  test('applies client filter', () => {
    const result = buildMcpServerConfigFromFlags({
      commandOrUrl: 'npx',
      clients: ['claude'],
    });
    expect('config' in result).toBe(true);
    if ('config' in result) {
      expect(result.config.clients).toEqual(['claude']);
    }
  });
});

describe('parseKeyValuePairs', () => {
  test('parses KEY=VALUE pairs', () => {
    const result = parseKeyValuePairs(['A=1', 'B=two'], '-e');
    expect('values' in result).toBe(true);
    if ('values' in result) {
      expect(result.values).toEqual({ A: '1', B: 'two' });
    }
  });

  test('rejects pair missing =', () => {
    const result = parseKeyValuePairs(['bad'], '-e');
    expect('error' in result).toBe(true);
  });

  test('preserves = in value', () => {
    const result = parseKeyValuePairs(['URL=http://x?a=1'], '-e');
    if ('values' in result) {
      expect(result.values.URL).toBe('http://x?a=1');
    }
  });
});
