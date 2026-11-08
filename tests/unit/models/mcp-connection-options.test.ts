import { describe, expect, test } from 'bun:test';
import { McpServerConfigSchema, ProfileMcpServerConfigSchema } from '../../../src/models/workspace-config.js';

describe('managed MCP connection policy', () => {
  test('accepts a portable connection policy alongside an HTTP declaration', () => {
    const config = {
      url: 'https://mcp.example.test/mcp',
      oauth: {
        clientName: 'Codex', clientId: 'registered-client', clientSecret: '${MCP_SECRET}',
        scope: 'read write', resource: 'https://tenant.example.test/',
        authorizationParams: { audience: 'https://api.example.test/' },
        callback: { port: 9696, host: 'localhost', path: '/oauth/callback', timeoutSeconds: 90 },
      },
      connection: {
        transportStrategy: 'sse-first', protocol: 'auto', ignoreTools: ['delete*'],
        connectTimeoutSeconds: 10, headersTimeoutSeconds: 30, bodyTimeoutSeconds: 0,
        keepAliveSeconds: 30, ipv4: true, enableProxy: true, disableCookies: true,
      },
    };
    expect(McpServerConfigSchema.parse(config)).toEqual(config);
    expect(ProfileMcpServerConfigSchema.parse(config)).toEqual(config);
  });

  test('profile OAuth secrets must remain exact environment references', () => {
    expect(ProfileMcpServerConfigSchema.safeParse({
      url: 'https://mcp.example.test/mcp',
      oauth: { clientId: 'registered-client', clientSecret: 'raw-secret' },
    }).success).toBe(false);
  });

  test('rejects inconsistent grants and callback configuration', () => {
    for (const oauth of [
      { grantType: 'client_credentials' },
      { tokenEndpoint: 'https://idp.example.test/token' },
      { callback: { path: 'missing-leading-slash' } },
      { callback: { timeoutSeconds: 0 } },
    ]) {
      expect(McpServerConfigSchema.safeParse({ url: 'https://mcp.example.test/mcp', oauth }).success).toBe(false);
    }
  });

  test('connection controls remain HTTP-only and reject invalid timeouts', () => {
    expect(McpServerConfigSchema.safeParse({ command: 'local-server', connection: { protocol: 'auto' } }).success).toBe(false);
    expect(McpServerConfigSchema.safeParse({ url: 'https://mcp.example.test/mcp', connection: { bodyTimeoutSeconds: -1 } }).success).toBe(false);
  });
});
