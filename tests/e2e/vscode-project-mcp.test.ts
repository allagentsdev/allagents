import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncWorkspace } from '../../src/core/sync.js';
import { syncMcpOnly } from '../../src/core/mcp-sync.js';

describe('vscode project-scoped MCP sync e2e', () => {
  let testDir: string;
  let pluginDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `allagents-e2e-mcp-${Date.now()}`);
    pluginDir = join(testDir, 'test-plugin');
    mkdirSync(join(testDir, '.allagents'), { recursive: true });
    mkdirSync(pluginDir, { recursive: true });

    // Create a plugin with an MCP server
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({ name: 'test-plugin', version: '1.0.0' }),
    );
    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' },
        },
      }),
    );
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('sync writes MCP servers to project .vscode/mcp.json when vscode client is configured', async () => {
    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      `repositories:
  - path: ../myrepo
plugins:
  - ${pluginDir}
clients:
  - vscode
`,
    );

    const result = await syncWorkspace(testDir);

    expect(result.success).toBe(true);

    // MCP servers should be synced to project-scoped .vscode/mcp.json
    const mcpConfigPath = join(testDir, '.vscode', 'mcp.json');
    expect(existsSync(mcpConfigPath)).toBe(true);

    const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
    expect(mcpConfig.servers).toBeDefined();
    expect(mcpConfig.servers.deepwiki).toEqual({
      type: 'http',
      url: 'https://mcp.deepwiki.com/mcp',
    });

    // mcpResults should be returned
    expect(result.mcpResults).toBeDefined();
    expect(result.mcpResults!.vscode).toBeDefined();
    expect(result.mcpResults!.vscode!.added).toBe(1);
    expect(result.mcpResults!.vscode!.addedServers).toContain('deepwiki');
  });

  test('sync does not write MCP config when vscode client is absent', async () => {
    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      `repositories:
  - path: ../myrepo
plugins:
  - ${pluginDir}
clients:
  - claude
`,
    );

    const result = await syncWorkspace(testDir);

    expect(result.success).toBe(true);

    const mcpConfigPath = join(testDir, '.vscode', 'mcp.json');
    expect(existsSync(mcpConfigPath)).toBe(false);
    // No vscode MCP results, but claude MCP results write to .mcp.json
    expect(result.mcpResults?.vscode).toBeUndefined();
    expect(result.mcpResults?.claude).toBeDefined();
    expect(result.mcpResults!.claude!.added).toBe(1);
    const claudeMcpPath = join(testDir, '.mcp.json');
    expect(existsSync(claudeMcpPath)).toBe(true);
  });

  test('sync tracks MCP servers in project sync state', async () => {
    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      `repositories:
  - path: ../myrepo
plugins:
  - ${pluginDir}
clients:
  - vscode
`,
    );

    // First sync - adds the server
    const result1 = await syncWorkspace(testDir);
    expect(result1.mcpResults?.vscode?.added).toBe(1);

    // Second sync - server already exists, no changes
    const result2 = await syncWorkspace(testDir);
    expect(result2.mcpResults?.vscode?.added).toBe(0);

    // Remove plugin and sync again - server should be removed
    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      `repositories:
  - path: ../myrepo
plugins: []
clients:
  - vscode
`,
    );
    const result3 = await syncWorkspace(testDir);
    expect(result3.mcpResults?.vscode?.removed).toBe(1);
    expect(result3.mcpResults?.vscode?.removedServers).toContain('deepwiki');

    // Verify the server was removed from the file
    const mcpConfigPath = join(testDir, '.vscode', 'mcp.json');
    const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
    expect(mcpConfig.servers.deepwiki).toBeUndefined();
  });
  test('removes newly excluded tracked servers while preserving user-owned servers', async () => {
    const workspacePath = join(testDir, '.allagents', 'workspace.yaml');
    const configPath = join(testDir, '.vscode', 'mcp.json');
    writeFileSync(
      join(pluginDir, '.mcp.json'),
      JSON.stringify({ mcpServers: {
        deepwiki: { command: 'plugin-deepwiki' },
        retained: { command: 'plugin-retained' },
        personal: { command: 'plugin-personal' },
      } }),
    );
    writeFileSync(workspacePath, `repositories: []
plugins:
  - source: ${pluginDir}
clients:
  - vscode
`);
    mkdirSync(join(testDir, '.vscode'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({
      servers: { personal: { command: 'user-personal' } },
    }));

    const initial = await syncWorkspace(testDir);
    expect(initial.success).toBe(true);
    expect(initial.mcpResults?.vscode?.trackedServers).toEqual(['deepwiki', 'retained']);
    writeFileSync(workspacePath, `repositories: []
plugins:
  - source: ${pluginDir}
    mcpServers:
      exclude: [deepwiki, personal]
clients:
  - vscode
`);

    const updated = await syncMcpOnly(testDir, { offline: true });
    expect(updated.success).toBe(true);
    expect(updated.mcpResults.vscode?.removedServers).toEqual(['deepwiki']);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).servers).toEqual({
      retained: { command: 'plugin-retained' },
      personal: { command: 'user-personal' },
    });
    const state = JSON.parse(readFileSync(join(testDir, '.allagents', 'sync-state.json'), 'utf8'));
    expect(state.mcpServers.vscode).toEqual(['retained']);
  });

});
