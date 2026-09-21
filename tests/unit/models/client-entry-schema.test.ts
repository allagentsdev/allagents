import { describe, it, expect } from 'bun:test';
import {
  ClientEntrySchema,
  UserClientTypeSchema,
  UserWorkspaceConfigSchema,
  WorkspaceConfigSchema,
  getClientTypes,
  normalizeClientEntry,
} from '../../../src/models/workspace-config.js';

describe('ClientEntrySchema', () => {
  describe('existing behavior', () => {
    it('parses bare client string', () => {
      expect(ClientEntrySchema.parse('claude')).toBe('claude');
    });

    it('parses object form with install mode', () => {
      expect(ClientEntrySchema.parse({ name: 'claude', install: 'native' })).toEqual({
        name: 'claude',
        install: 'native',
      });
    });

    it('defaults install to file in object form', () => {
      expect(ClientEntrySchema.parse({ name: 'claude' })).toEqual({
        name: 'claude',
        install: 'file',
      });
    });

    it('rejects invalid client name string', () => {
      expect(() => ClientEntrySchema.parse('fakeclient')).toThrow();
    });

    it('rejects invalid client name in object', () => {
      expect(() => ClientEntrySchema.parse({ name: 'fakeclient', install: 'file' })).toThrow();
    });
  });

  it('parses Pi and OMP in bare, colon, and object forms', () => {
    for (const client of ['pi', 'omp'] as const) {
      expect(ClientEntrySchema.parse(client)).toBe(client);
      expect(ClientEntrySchema.parse(`${client}:native`)).toEqual({
        name: client,
        install: 'native',
      });
      expect(ClientEntrySchema.parse({ name: client })).toEqual({
        name: client,
        install: 'file',
      });
    }
  });

  describe('normalizeClientEntry', () => {
    it('normalizes bare string to object', () => {
      expect(normalizeClientEntry('claude')).toEqual({ name: 'claude', install: 'file' });
    });

    it('normalizes object entry', () => {
      expect(normalizeClientEntry({ name: 'claude', install: 'native' })).toEqual({
        name: 'claude',
        install: 'native',
      });
    });
  });

  it('canonicalizes every public alias in bare, shorthand, and object forms', () => {
    const aliases = {
      'claude-code': 'claude',
      'github-copilot': 'copilot',
      'gemini-cli': 'gemini',
      droid: 'factory',
      amp: 'ampcode',
      'kiro-cli': 'kiro',
      'kimi-code-cli': 'kimi',
    } as const;

    for (const [alias, canonical] of Object.entries(aliases)) {
      expect(ClientEntrySchema.parse(alias)).toBe(canonical);
      expect(ClientEntrySchema.parse(`${alias}:file`)).toEqual({
        name: canonical,
        install: 'file',
      });
      expect(ClientEntrySchema.parse({ name: alias })).toEqual({
        name: canonical,
        install: 'file',
      });
    }
  });

  it('deduplicates aliases and canonical IDs before sync consumers see them', () => {
    const config = WorkspaceConfigSchema.parse({
      repositories: [],
      plugins: [
        {
          source: 'owner/plugin',
          clients: ['claude-code', 'claude', 'droid', 'factory'],
        },
      ],
      clients: ['claude-code', 'claude', 'droid', 'factory'],
      mcpServers: {
        example: {
          command: 'example-mcp',
          clients: ['github-copilot', 'copilot'],
        },
      },
    });

    expect(getClientTypes(config.clients)).toEqual(['claude', 'factory']);
    expect(config.plugins[0]).toMatchObject({
      clients: ['claude', 'factory'],
    });
    expect(config.mcpServers?.example?.clients).toEqual(['copilot']);
  });

  it('distinguishes project-only clients from unknown user-scope inputs', () => {
    expect(() =>
      UserWorkspaceConfigSchema.parse({
        repositories: [],
        plugins: [],
        clients: ['eve'],
      }),
    ).toThrow("Client 'eve' does not support user scope");
    expect(() => UserClientTypeSchema.parse('missing-client')).toThrow(
      "Unknown client 'missing-client'",
    );
  });

  it('applies user scope and alias normalization to nested selectors', () => {
    expect(
      UserWorkspaceConfigSchema.safeParse({
        plugins: [{ source: 'owner/plugin', clients: ['eve'] }],
      }).success,
    ).toBe(false);
    expect(
      UserWorkspaceConfigSchema.safeParse({
        mcpServers: {
          example: { command: 'example-mcp', clients: ['eve'] },
        },
      }).success,
    ).toBe(false);

    const config = UserWorkspaceConfigSchema.parse({
      plugins: [
        {
          source: 'owner/plugin',
          clients: ['github-copilot', 'copilot'],
        },
      ],
      mcpServers: {
        example: {
          command: 'example-mcp',
          clients: ['claude-code', 'claude'],
        },
      },
    });
    expect(config.plugins[0]).toMatchObject({ clients: ['copilot'] });
    expect(config.mcpServers?.example?.clients).toEqual(['claude']);
  });

  describe('colon shorthand', () => {
    it('parses claude:native to object', () => {
      expect(ClientEntrySchema.parse('claude:native')).toEqual({
        name: 'claude',
        install: 'native',
      });
    });

    it('parses claude:file to object', () => {
      expect(ClientEntrySchema.parse('claude:file')).toEqual({
        name: 'claude',
        install: 'file',
      });
    });

    it('rejects empty client name', () => {
      expect(() => ClientEntrySchema.parse(':native')).toThrow();
    });

    it('rejects empty install mode', () => {
      expect(() => ClientEntrySchema.parse('claude:')).toThrow();
    });

    it('rejects extra colons', () => {
      expect(() => ClientEntrySchema.parse('claude:native:extra')).toThrow();
    });

    it('rejects invalid install mode', () => {
      expect(() => ClientEntrySchema.parse('claude:bogus')).toThrow();
    });

    it('rejects invalid client with valid mode', () => {
      expect(() => ClientEntrySchema.parse('fakeclient:native')).toThrow();
    });

    it('rejects uppercase (case-sensitive)', () => {
      expect(() => ClientEntrySchema.parse('CLAUDE:NATIVE')).toThrow();
    });
  });

  describe('full WorkspaceConfigSchema with mixed client formats', () => {
    it('parses config with bare, shorthand, and object clients', () => {
      const config = WorkspaceConfigSchema.parse({
        repositories: [],
        plugins: [],
        clients: [
          'copilot',
          'claude:native',
          { name: 'cursor', install: 'file' },
        ],
      });
      expect(config.clients).toEqual([
        'copilot',
        { name: 'claude', install: 'native' },
        { name: 'cursor', install: 'file' },
      ]);
    });
  });
});
