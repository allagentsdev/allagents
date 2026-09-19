import { describe, expect, test } from 'bun:test';
import { WorkspaceConfigSchema } from '../../../src/models/workspace-config.js';

describe('mcpProxy workspace config', () => {
  const baseConfig = {
    repositories: [{ path: './repo' }],
    plugins: ['my-plugin'],
    clients: ['claude'],
  };

  test('accepts config without mcpProxy', () => {
    const result = WorkspaceConfigSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
  });

  test('accepts mcpProxy with clients only', () => {
    const result = WorkspaceConfigSchema.safeParse({
      ...baseConfig,
      mcpProxy: { clients: ['claude', 'copilot'] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpProxy!.clients).toEqual(['claude', 'copilot']);
    }
  });

  test('accepts mcpProxy with clients and server overrides', () => {
    const result = WorkspaceConfigSchema.safeParse({
      ...baseConfig,
      mcpProxy: {
        clients: ['claude'],
        servers: {
          'my-api': { proxy: ['codex'] },
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpProxy!.servers!['my-api'].proxy).toEqual(['codex']);
    }
  });

  test('accepts mcpProxy with empty servers', () => {
    const result = WorkspaceConfigSchema.safeParse({
      ...baseConfig,
      mcpProxy: { clients: ['copilot'], servers: {} },
    });
    expect(result.success).toBe(true);
  });

  test('defaults clients to empty for server-only proxy policy', () => {
    const result = WorkspaceConfigSchema.safeParse({
      ...baseConfig,
      mcpProxy: { servers: { 'my-api': { proxy: ['codex'] } } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcpProxy).toEqual({
        clients: [],
        servers: { 'my-api': { proxy: ['codex'] } },
      });
    }
  });
});
