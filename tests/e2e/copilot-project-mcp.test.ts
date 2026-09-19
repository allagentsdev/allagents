import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncWorkspace } from '../../src/core/sync.js';

describe('copilot project-scoped MCP sync e2e', () => {
  let testDir: string;
  let pluginDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `allagents-e2e-copilot-mcp-${Date.now()}`);
    pluginDir = join(testDir, 'test-plugin');
    mkdirSync(join(testDir, '.allagents'), { recursive: true });
    mkdirSync(pluginDir, { recursive: true });

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

  test('sync writes MCP servers to project .github/mcp.json when copilot client is configured', async () => {
    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      `repositories:
  - path: ../myrepo
plugins:
  - ${pluginDir}
clients:
  - copilot
`,
    );

    const result = await syncWorkspace(testDir);

    expect(result.success).toBe(true);

    const mcpConfigPath = join(testDir, '.github', 'mcp.json');
    expect(existsSync(mcpConfigPath)).toBe(true);

    const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'));
    expect(mcpConfig.mcpServers).toBeDefined();
    expect(mcpConfig.mcpServers.deepwiki).toEqual({
      type: 'http',
      url: 'https://mcp.deepwiki.com/mcp',
    });

    expect(result.mcpResults).toBeDefined();
    expect(result.mcpResults!.copilot).toBeDefined();
    expect(result.mcpResults!.copilot!.added).toBe(1);
    expect(result.mcpResults!.copilot!.addedServers).toContain('deepwiki');
  });

  test('sync does not write copilot MCP config when copilot client is absent', async () => {
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
    expect(result.mcpResults?.copilot).toBeUndefined();
    const mcpConfigPath = join(testDir, '.github', 'mcp.json');
    expect(existsSync(mcpConfigPath)).toBe(false);
  });

  test('sync tracks and removes copilot MCP servers across syncs', async () => {
    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      `repositories:
  - path: ../myrepo
plugins:
  - ${pluginDir}
clients:
  - copilot
`,
    );

    // First sync - adds the server
    const result1 = await syncWorkspace(testDir);
    expect(result1.mcpResults?.copilot?.added).toBe(1);

    // Second sync - no changes
    const result2 = await syncWorkspace(testDir);
    expect(result2.mcpResults?.copilot?.added).toBe(0);

    // Remove plugin and sync - server should be removed
    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      `repositories:
  - path: ../myrepo
plugins: []
clients:
  - copilot
`,
    );
    const result3 = await syncWorkspace(testDir);
    expect(result3.mcpResults?.copilot?.removed).toBe(1);
    expect(result3.mcpResults?.copilot?.removedServers).toContain('deepwiki');

    const mcpConfig = JSON.parse(readFileSync(join(testDir, '.github', 'mcp.json'), 'utf-8'));
    expect(mcpConfig.mcpServers.deepwiki).toBeUndefined();
  });
});
