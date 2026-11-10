import { describe, expect, test } from 'bun:test';
import {
  McpServerConfigSchema,
  ProfileMcpServerConfigSchema,
} from '../../../src/models/workspace-config.js';

describe('managed MCP connection policy', () => {
  test('accepts a portable connection policy alongside an HTTP declaration', () => {
    const config = {
      url: 'https://mcp.example.test/mcp',
      oauth: {
        clientName: 'Codex',
        clientId: 'registered-client',
        clientSecret: '${MCP_SECRET}',
        scope: 'read write',
        resource: 'https://tenant.example.test/',
        authorizationParams: { audience: 'https://api.example.test/' },
        callback: {
          port: 9696,
          host: 'localhost',
          path: '/oauth/callback',
          timeoutSeconds: 90,
        },
      },
      connection: {
        transportStrategy: 'sse-first',
        protocol: 'auto',
        ignoreTools: ['delete*'],
        connectTimeoutSeconds: 10,
        headersTimeoutSeconds: 30,
        bodyTimeoutSeconds: 0,
        keepAliveSeconds: 30,
        ipv4: true,
        enableProxy: true,
        disableCookies: true,
      },
    };
    expect(McpServerConfigSchema.parse(config)).toEqual(config);
    expect(ProfileMcpServerConfigSchema.parse(config)).toEqual(config);
  });

  test('profile OAuth secrets must remain exact environment references', () => {
    expect(
      ProfileMcpServerConfigSchema.safeParse({
        url: 'https://mcp.example.test/mcp',
        oauth: { clientId: 'registered-client', clientSecret: 'raw-secret' },
      }).success,
    ).toBe(false);
  });

  test('rejects inconsistent grants and callback configuration', () => {
    for (const oauth of [
      { grantType: 'client_credentials' },
      { tokenEndpoint: 'https://idp.example.test/token' },
      { callback: { path: 'missing-leading-slash' } },
      { callback: { timeoutSeconds: 0 } },
    ]) {
      expect(
        McpServerConfigSchema.safeParse({
          url: 'https://mcp.example.test/mcp',
          oauth,
        }).success,
      ).toBe(false);
    }
  });

  test('connection controls remain HTTP-only and reject invalid timeouts', () => {
    expect(
      McpServerConfigSchema.safeParse({
        command: 'local-server',
        connection: { protocol: 'auto' },
      }).success,
    ).toBe(false);
    expect(
      McpServerConfigSchema.safeParse({
        url: 'https://mcp.example.test/mcp',
        connection: { bodyTimeoutSeconds: -1 },
      }).success,
    ).toBe(false);
  });

  test('authorization URL parameters cannot replace flow credentials', () => {
    for (const key of [
      'state',
      'code',
      'client_secret',
      'access_token',
      'refresh_token',
      'id_token',
      'token',
    ]) {
      expect(
        McpServerConfigSchema.safeParse({
          url: 'https://mcp.example.test/mcp',
          oauth: { authorizationParams: { [key]: 'private-value' } },
        }).success,
      ).toBe(false);
    }
  });
});

test('profile bridge OAuth JSON preserves portable secret references and rejects embedded secrets', () => {
  const profile = (oauth: unknown) => ({
    command: 'npx',
    args: [
      '-y',
      'allagents@1.23.0',
      'mcp',
      'proxy',
      'https://mcp.example.test/mcp',
      '--oauth-config',
      JSON.stringify(oauth),
    ],
  });
  expect(
    ProfileMcpServerConfigSchema.safeParse(
      profile({ clientId: 'registered', clientSecret: '${MCP_SECRET}' }),
    ).success,
  ).toBe(true);
  expect(
    ProfileMcpServerConfigSchema.safeParse(
      profile({ clientId: 'registered', clientSecret: 'raw-secret' }),
    ).success,
  ).toBe(false);
  expect(
    ProfileMcpServerConfigSchema.safeParse(
      profile({ clientId: 'registered', clientSecret: 'prefix-${MCP_SECRET}' }),
    ).success,
  ).toBe(false);
});

test('profile credential authorization parameters require exact environment references in HTTP and bridge declarations', () => {
  for (const key of [
    'api_key',
    'api-key',
    'password',
    'credential',
    'x-auth-token',
  ]) {
    for (const value of ['raw-secret', 'prefix-${PARAM_SECRET}']) {
      const oauth = {
        clientId: 'registered',
        authorizationParams: { [key]: value },
      };
      expect(
        McpServerConfigSchema.safeParse({
          url: 'https://example.test/mcp',
          oauth,
        }).success,
      ).toBe(true);
      expect(
        ProfileMcpServerConfigSchema.safeParse({
          url: 'https://example.test/mcp',
          oauth,
        }).success,
      ).toBe(false);
      expect(
        ProfileMcpServerConfigSchema.safeParse({
          command: 'npx',
          args: [
            '-y',
            'allagents@1.23.0',
            'mcp',
            'proxy',
            'https://example.test/mcp',
            '--oauth-config',
            JSON.stringify(oauth),
          ],
        }).success,
      ).toBe(false);
    }
    expect(
      ProfileMcpServerConfigSchema.safeParse({
        url: 'https://example.test/mcp',
        oauth: { authorizationParams: { [key]: '${PARAM_SECRET}' } },
      }).success,
    ).toBe(true);
  }
});
