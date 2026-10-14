import { describe, it, expect } from 'bun:test';
import {
  InstallModeSchema,
  ClientEntrySchema,
  WorkspaceConfigSchema,
  normalizeClientEntry,
  getClientTypes,
  getClientInstallMode,
  getPluginInstallMode,
  resolveInstallMode,
  getPluginClients,
  pluginUsesNativeInstall,
  UserWorkspaceConfigSchema,
} from '../../../src/models/workspace-config.js';

describe('InstallModeSchema', () => {
  it('accepts file', () => {
    expect(InstallModeSchema.safeParse('file').success).toBe(true);
  });

  it('accepts native', () => {
    expect(InstallModeSchema.safeParse('native').success).toBe(true);
  });

  it('rejects invalid value', () => {
    expect(InstallModeSchema.safeParse('symlink').success).toBe(false);
  });
});

describe('per-plugin client install modes', () => {
  const config = (clients: unknown[], install?: string) => WorkspaceConfigSchema.parse({
    repositories: [],
    clients: ['pi:native', 'codex'],
    plugins: [{ source: './package', clients, ...(install && { install }) }],
  });

  it('normalizes shorthand and object selectors to equivalent canonical entries', () => {
    const shorthand = config(['pi:native', 'claude-code:file']);
    const objects = config([{ name: 'pi', install: 'native' }, { name: 'claude', install: 'file' }]);
    expect(shorthand.plugins).toEqual(objects.plugins);
    expect(getPluginClients(shorthand.plugins[0]!)).toEqual(['pi', 'claude']);
  });

  it('inherits for bare names and applies explicit per-client modes before workspace modes', () => {
    const inherited = config(['pi', 'codex']);
    expect(resolveInstallMode(inherited.plugins[0]!, { name: 'pi', install: 'native' })).toBe('native');
    const explicit = config(['pi:file', 'codex']);
    expect(resolveInstallMode(explicit.plugins[0]!, { name: 'pi', install: 'native' })).toBe('file');
    expect(pluginUsesNativeInstall(explicit.plugins[0]!, explicit.clients)).toBe(false);
    const native = config(['pi:native']);
    expect(resolveInstallMode(native.plugins[0]!, { name: 'pi', install: 'file' })).toBe('native');
    expect(pluginUsesNativeInstall(native.plugins[0]!, ['pi'])).toBe(true);
  });

  it('keeps plugin-wide install precedence over explicit client modes', () => {
    for (const install of ['file', 'native'] as const) {
      const parsed = config(['pi:native'], install);
      expect(resolveInstallMode(parsed.plugins[0]!, { name: 'pi', install: 'file' })).toBe(install);
      expect(pluginUsesNativeInstall(parsed.plugins[0]!, parsed.clients)).toBe(install === 'native');
    }
  });

  it('retains first-entry mode precedence when alias-equivalent clients repeat', () => {
    const parsed = config(['claude-code:file', 'claude:native']);
    expect(getPluginClients(parsed.plugins[0]!)).toEqual(['claude']);
    expect(resolveInstallMode(parsed.plugins[0]!, { name: 'claude', install: 'native' })).toBe('file');
  });

  it('preserves mode and scope capability validation', () => {
    for (const client of ['cursor:native', 'pi:symlink', 'copilot:native']) {
      expect(() => config([client])).toThrow();
    }
    expect(UserWorkspaceConfigSchema.safeParse({ plugins: [{ source: './package', clients: ['github-copilot:native'] }] }).success).toBe(true);
    for (const client of ['copilot', 'codex'] as const) {
      const user = UserWorkspaceConfigSchema.parse({ plugins: [{ source: 'demo@tools', clients: [`${client}:native`] }] });
      expect(getPluginClients(user.plugins[0]!)).toEqual([client]);
      expect(resolveInstallMode(user.plugins[0]!, { name: client, install: 'file' })).toBe('native');
    }
    expect(UserWorkspaceConfigSchema.safeParse({ plugins: [{ source: './package', clients: ['eve:file'] }] }).success).toBe(false);
  });
});

describe('ClientEntrySchema', () => {
  it('accepts string shorthand', () => {
    const result = ClientEntrySchema.safeParse('claude');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe('claude');
    }
  });

  it('accepts object with install mode', () => {
    const result = ClientEntrySchema.safeParse({ name: 'claude', install: 'native' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: 'claude', install: 'native' });
    }
  });

  it('defaults install to file when omitted', () => {
    const result = ClientEntrySchema.safeParse({ name: 'claude' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: 'claude', install: 'file' });
    }
  });

  it('rejects invalid client name in object', () => {
    const result = ClientEntrySchema.safeParse({ name: 'invalid', install: 'file' });
    expect(result.success).toBe(false);
  });
});

describe('normalizeClientEntry', () => {
  it('normalizes string to object with file install', () => {
    expect(normalizeClientEntry('claude')).toEqual({ name: 'claude', install: 'file' });
  });

  it('preserves object with explicit install', () => {
    expect(normalizeClientEntry({ name: 'claude', install: 'native' })).toEqual({
      name: 'claude',
      install: 'native',
    });
  });

  it('defaults install to file for object without install', () => {
    // After parsing, the default is applied so install will be 'file'
    const parsed = ClientEntrySchema.parse({ name: 'copilot' });
    expect(normalizeClientEntry(parsed)).toEqual({ name: 'copilot', install: 'file' });
  });
});

describe('getClientTypes', () => {
  it('extracts client types from mixed entries', () => {
    const entries = ['claude', { name: 'copilot' as const, install: 'native' as const }];
    expect(getClientTypes(entries)).toEqual(['claude', 'copilot']);
  });

  it('returns empty array for empty input', () => {
    expect(getClientTypes([])).toEqual([]);
  });
});

describe('getClientInstallMode', () => {
  it('returns mode for matching client', () => {
    const entries = ['claude', { name: 'copilot' as const, install: 'native' as const }];
    expect(getClientInstallMode(entries, 'copilot')).toBe('native');
  });

  it('returns file for string entry', () => {
    const entries = ['claude'];
    expect(getClientInstallMode(entries, 'claude')).toBe('file');
  });

  it('returns file when client not found', () => {
    const entries = ['claude'];
    expect(getClientInstallMode(entries, 'copilot')).toBe('file');
  });
});

describe('getPluginInstallMode', () => {
  it('returns undefined for string plugin', () => {
    expect(getPluginInstallMode('./plugin')).toBeUndefined();
  });

  it('returns install mode from object plugin', () => {
    expect(getPluginInstallMode({ source: './plugin', install: 'native' })).toBe('native');
  });

  it('returns undefined when object plugin has no install', () => {
    expect(getPluginInstallMode({ source: './plugin' })).toBeUndefined();
  });
});

describe('resolveInstallMode', () => {
  it('plugin-level overrides client-level', () => {
    const result = resolveInstallMode(
      { source: './plugin', install: 'native' },
      { name: 'claude', install: 'file' },
    );
    expect(result).toBe('native');
  });

  it('falls back to client-level when plugin has no override', () => {
    const result = resolveInstallMode('./plugin', { name: 'claude', install: 'native' });
    expect(result).toBe('native');
  });

  it('returns file when neither has override', () => {
    const result = resolveInstallMode('./plugin', { name: 'claude', install: 'file' });
    expect(result).toBe('file');
  });
});

describe('WorkspaceConfigSchema with install mode', () => {
  it('parses mixed string and object clients', () => {
    const config = {
      repositories: [],
      plugins: [],
      clients: ['claude', { name: 'pi', install: 'native' }],
    };
    const result = WorkspaceConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.clients).toEqual(['claude', { name: 'pi', install: 'native' }]);
    }
  });

  it('parses plugin with install field', () => {
    const config = {
      repositories: [],
      plugins: [{ source: './my-plugin', install: 'native' }],
      clients: ['claude'],
    };
    const result = WorkspaceConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.plugins[0]).toEqual({ source: './my-plugin', install: 'native' });
    }
  });
});
