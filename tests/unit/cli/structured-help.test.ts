import { describe, test, expect } from 'bun:test';
import { findMetaByCommand } from '../../../src/cli/structured-help.js';
import {
  initMeta,
  setupMeta,
  syncMeta,
  statusMeta,
} from '../../../src/cli/metadata/workspace.js';
import {
  marketplaceListMeta,
  marketplaceAddMeta,
  marketplaceRemoveMeta,
  marketplaceUpdateMeta,
  marketplaceBrowseMeta,
  pluginListMeta,
  pluginValidateMeta,
  pluginInstallMeta,
  pluginUninstallMeta,
  pluginUpdateMeta,
} from '../../../src/cli/metadata/plugin.js';
import { updateMeta } from '../../../src/cli/metadata/self.js';
import {
  skillsListMeta,
  skillsAddMeta,
  skillsRemoveMeta,
  skillsSearchMeta,
  skillsUpdateMeta,
} from '../../../src/cli/metadata/plugin-skills.js';
import type { AgentCommandMeta } from '../../../src/cli/help.js';

const allCommands: AgentCommandMeta[] = [
  initMeta,
  setupMeta,
  syncMeta,
  statusMeta,
  pluginInstallMeta,
  pluginUninstallMeta,
  pluginUpdateMeta,
  marketplaceListMeta,
  marketplaceAddMeta,
  marketplaceRemoveMeta,
  marketplaceUpdateMeta,
  marketplaceBrowseMeta,
  pluginListMeta,
  pluginValidateMeta,
  skillsListMeta,
  skillsAddMeta,
  skillsRemoveMeta,
  skillsSearchMeta,
  skillsUpdateMeta,
  updateMeta,
];

describe('agent command metadata', () => {
  test('contains exactly 20 commands', () => {
    expect(allCommands.length).toBe(20);
  });

  test('all expected commands are present', () => {
    const names = allCommands.map((c) => c.command).sort();
    expect(names).toEqual([
      'init',
      'plugin install',
      'plugin list',
      'plugin marketplace add',
      'plugin marketplace browse',
      'plugin marketplace list',
      'plugin marketplace remove',
      'plugin marketplace update',
      'plugin uninstall',
      'plugin update',
      'plugin validate',
      'self update',
      'skill add',
      'skill list',
      'skill remove',
      'skill search',
      'skill update',
      'status',
      'update',
      'workspace setup',
    ]);
  });

  test('every command has required fields', () => {
    for (const cmd of allCommands) {
      expect(typeof cmd.command).toBe('string');
      expect(typeof cmd.description).toBe('string');
      expect(typeof cmd.whenToUse).toBe('string');
      expect(cmd.examples.length).toBeGreaterThan(0);
    }
  });

  test('update has expected options', () => {
    const syncCmd = allCommands.find((c) => c.command === 'update')!;
    expect(syncCmd.options).toBeInstanceOf(Array);
    expect(syncCmd.options!.length).toBe(4);

    const dryRun = syncCmd.options!.find((o) => o.flag === '--dry-run');
    expect(dryRun).toBeDefined();
    expect(dryRun!.type).toBe('boolean');
    expect(dryRun!.short).toBe('-n');

    const client = syncCmd.options!.find((o) => o.flag === '--client');
    expect(client).toBeUndefined();

    const verbose = syncCmd.options!.find((o) => o.flag === '--verbose');
    expect(verbose).toBeDefined();
    expect(verbose!.type).toBe('boolean');
    expect(verbose!.short).toBe('-v');

    const profile = syncCmd.options!.find((o) => o.flag === '--profile');
    expect(profile).toBeDefined();
    expect(profile!.type).toBe('string');
    expect(profile!.description).toContain('repeatable');
  });

  test('plugin install has required positional', () => {
    const installCmd = allCommands.find((c) => c.command === 'plugin install')!;
    expect(installCmd.positionals).toBeInstanceOf(Array);
    expect(installCmd.positionals!.length).toBe(1);
    expect(installCmd.positionals![0].name).toBe('plugin');
    expect(installCmd.positionals![0].required).toBe(true);
  });

  test('plugin install metadata exposes only supported target options', () => {
    const installCmd = allCommands.find((c) => c.command === 'plugin install')!;
    expect(installCmd.options).toEqual([
      expect.objectContaining({ flag: '--scope', short: '-s', type: 'string' }),
      expect.objectContaining({ flag: '--client', short: '-c', type: 'string' }),
      expect.objectContaining({ flag: '--yes', short: '-y', type: 'boolean' }),
      expect.objectContaining({ flag: '--skill', type: 'string' }),
    ]);
    expect(installCmd.options?.some((option) => option.flag === '--force')).toBe(
      false,
    );
  });

  test('plugin marketplace add metadata exposes only supported options', () => {
    const addCmd = allCommands.find(
      (command) => command.command === 'plugin marketplace add',
    )!;
    expect(addCmd.options).toEqual([
      expect.objectContaining({ flag: '--name', short: '-n', type: 'string' }),
      expect.objectContaining({ flag: '--branch', short: '-b', type: 'string' }),
      expect.objectContaining({ flag: '--scope', short: '-s', type: 'string' }),
    ]);
    expect(addCmd.options?.some((option) => option.flag === '--force')).toBe(
      false,
    );
  });

  test('skill add metadata exposes install target options', () => {
    const addCmd = allCommands.find((command) => command.command === 'skill add')!;
    expect(addCmd.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ flag: '--scope', short: '-s', type: 'string' }),
        expect.objectContaining({ flag: '--client', short: '-c', type: 'string' }),
        expect.objectContaining({ flag: '--yes', short: '-y', type: 'boolean' }),
      ]),
    );
  });

  test('status has no positionals or options', () => {
    const statusCmd = allCommands.find((c) => c.command === 'status')!;
    expect(statusCmd.positionals).toBeUndefined();
    expect(statusCmd.options).toBeUndefined();
  });

  test('keeps ordinary Pi and OMP metadata distinct from profile-aware update', () => {
    const ordinaryMetadata = [
      statusMeta,
      pluginListMeta,
      pluginInstallMeta,
      pluginUninstallMeta,
      pluginUpdateMeta,
    ];
    const text = JSON.stringify(ordinaryMetadata);
    expect(text).toContain('Pi');
    expect(text).toContain('OMP');
    expect(text.toLowerCase()).not.toContain('profile');
    expect(JSON.stringify(syncMeta).toLowerCase()).toContain('--profile');
  });
});

describe('findMetaByCommand', () => {
  test('resolves canonical "status" path', () => {
    const meta = findMetaByCommand('status');
    expect(meta).toBeDefined();
    expect(meta!.command).toBe('status');
  });

  test('resolves the public MCP setup commands', () => {
    const addMeta = findMetaByCommand('mcp add tradingview https://mcp.tradingview.com/mcp');
    const reauthMeta = findMetaByCommand('mcp reauth tradingview');
    expect(addMeta?.command).toBe('mcp add');
    expect(reauthMeta?.command).toBe('mcp reauth');
    expect(addMeta?.interaction).toBe('conditional');
    expect(addMeta?.outputSchema).toBeDefined();
    expect(reauthMeta?.interaction).toBe('required');
    expect(findMetaByCommand('mcp list')?.outputSchema).toMatchObject({
      total: 'number',
    });
    expect(findMetaByCommand('mcp get')?.outputSchema).toMatchObject({
      name: 'string',
    });
    expect(findMetaByCommand('mcp update')?.outputSchema).toBeDefined();
  });

  test('resolves public workspace aliases to their shared metadata', () => {
    expect(findMetaByCommand('workspace init ./project')?.command).toBe('init');
    expect(findMetaByCommand('workspace sync --profile work')?.command).toBe(
      'update',
    );
    expect(findMetaByCommand('workspace status')?.command).toBe('status');
  });

  test('resolves command metadata when rest-positionals follow the command', () => {
    const meta = findMetaByCommand('skill update code-review glow-api');
    expect(meta?.command).toBe('skill update');
  });

  test('resolves workspace-only commands exposed by the human command tree', () => {
    expect(findMetaByCommand('workspace prune')?.command).toBe(
      'workspace prune',
    );
    expect(findMetaByCommand('workspace repo add ../project')?.command).toBe(
      'workspace repo add',
    );
    expect(findMetaByCommand('workspace repo list')?.outputSchema).toMatchObject(
      { total: 'number' },
    );
  });

  test('returns undefined for unknown command', () => {
    expect(findMetaByCommand('workspace frobnicate')).toBeUndefined();
  });

  test('returns undefined for empty string', () => {
    expect(findMetaByCommand('')).toBeUndefined();
  });
});
