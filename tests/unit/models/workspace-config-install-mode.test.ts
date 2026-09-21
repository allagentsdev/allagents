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
