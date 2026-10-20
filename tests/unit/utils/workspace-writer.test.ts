import { describe, expect, test } from 'bun:test';
import { serializeWorkspaceConfig } from '../../../src/utils/workspace-writer.js';
import { loadYaml } from '../../../src/utils/yaml.js';

describe('workspace YAML edits', () => {
  test('leaves a no-op document byte-for-byte intact', () => {
    const original = '# Header\nplugins: ["./one"] # inline\n\n\nclients: []\n';
    expect(serializeWorkspaceConfig(loadYaml(original), original)).toBe(original);
  });

  test('keeps comments on surviving entries when removing and reordering plugins', () => {
    const original = '# Header\nplugins:\n  - ./removed # obsolete\n\n  # Infra\n  - "./infra" # Terraform\n\n  # General\n  - ./general # Review\nclients: []\n';
    const result = serializeWorkspaceConfig(
      { plugins: ['./general', './infra'], clients: [] }, original,
    );
    expect(result).toContain('# Header');
    expect(result).toContain('\n  # General\n  - ./general # Review');
    expect(result).toContain('\n\n  # Infra\n  - "./infra" # Terraform');
    expect(result).not.toContain('obsolete');
    expect(loadYaml(result)).toEqual({ plugins: ['./general', './infra'], clients: [] });
  });

  test('keeps nested comments and scalar comments when expanding a plugin', () => {
    const original = 'plugins:\n  - ./plugin # Local tools\nmcpServers:\n  test:\n    command: node # Runtime\n    args: ["server.js"] # Keep flow style\n';
    const config = loadYaml(original) as any;
    config.plugins[0] = { source: './plugin', skills: ['review'] };
    config.mcpServers.test.env = { MODE: 'dev' };
    const result = serializeWorkspaceConfig(config, original);
    expect(result).toContain('source: ./plugin # Local tools');
    expect(result).toContain('command: node # Runtime');
    expect(result).toContain('args: [ "server.js" ] # Keep flow style');
    expect(loadYaml(result)).toEqual(config);
  });

  test('keeps merge keys and overrides an inherited field without editing its anchor', () => {
    const original = '# Shared defaults\ndefaults: &defaults\n  clients: [claude] # Inherited\n  plugins: []\n  repositories: []\n<<: *defaults\n';
    const config = loadYaml(original) as any;
    config.clients = ['cursor'];
    const result = serializeWorkspaceConfig(config, original);
    expect(result).toContain('&defaults');
    expect(result).toContain('<<: *defaults');
    expect(result).toContain('# Inherited');
    expect(loadYaml(result)).toEqual(config);
  });

  test('detaches surviving aliases when removing or changing their anchor', () => {
    for (const config of [{ copy: ['./one'] }, { defaults: ['./changed'], copy: ['./one'] }]) {
      const original = 'defaults: &defaults [./one]\ncopy: *defaults # Keep this value\n';
      const result = serializeWorkspaceConfig(config, original);
      expect(loadYaml(result)).toEqual(config);
      expect(result).toContain('# Keep this value');
    }
  });

  test('removes inherited fields without silently restoring them from a merge', () => {
    const original = 'defaults: &defaults\n  disabledSkills: [old] # Shared policy\n  clients: []\n<<: *defaults\nplugins: []\n';
    const config = loadYaml(original) as any;
    delete config.disabledSkills;
    const result = serializeWorkspaceConfig(config, original);
    expect(loadYaml(result)).toEqual(config);
    expect(result).toContain('# Shared policy');
  });

  test('removes the selected identical plugin rather than transferring its comment', () => {
    const original = 'plugins:\n  - ./same # First installation\n  - ./same # Second installation\n';
    const result = serializeWorkspaceConfig({ plugins: ['./same'] }, original, {
      removedPluginIndexes: [0],
    });
    expect(result).not.toContain('First installation');
    expect(result).toContain('# Second installation');
    expect(loadYaml(result)).toEqual({ plugins: ['./same'] });
  });

  test('keeps identical plugin comments on their original entries during indexed edits', () => {
    const original = 'plugins:\n  - ./same # First installation\n  - ./same # Second installation\n';
    const config = { plugins: [{ source: './same', mcpServers: { exclude: ['test'] } }, './same'] };
    const result = serializeWorkspaceConfig(config, original);
    expect(result).toContain('source: ./same # First installation');
    expect(result).toContain('- ./same # Second installation');
    expect(loadYaml(result)).toEqual(config);
  });

  test('keeps nested notes when replacing a plugin source declaration', () => {
    const original = 'plugins:\n  - source: https://github.com/owner/repo # Repository note\n    clients:\n      - codex # Client note\n    skills:\n      - review # Skill note\n  - ./other # Other note\n';
    const config = loadYaml(original) as any;
    config.plugins[0].source += '.git';
    const result = serializeWorkspaceConfig(config, original);
    expect(result).toContain('source: https://github.com/owner/repo.git # Repository note');
    expect(result).toContain('- codex # Client note');
    expect(result).toContain('- review # Skill note');
    expect(result).toContain('- ./other # Other note');
    expect(loadYaml(result)).toEqual(config);
  });

  test('keeps comment ownership when a transaction removes an entry and edits a duplicate survivor', () => {
    const original = 'plugins:\n  - ./remove\n  - ./same # First installation\n  - ./same # Second installation\n';
    const config = { plugins: [{ source: './same', skills: [] }, './same'] };
    const result = serializeWorkspaceConfig(config, original, { removedPluginIndexes: [0] });
    expect(result).toContain('source: ./same # First installation');
    expect(result).toContain('- ./same # Second installation');
    expect(loadYaml(result)).toEqual(config);
  });

  test('updates and removes numeric mapping keys using their JavaScript string identity', () => {
    const original = 'mcpServers:\n  123:\n    command: node # Numeric server\n  other:\n    command: node # Other server\n';
    const config = loadYaml(original) as any;
    config.mcpServers['123'].command = 'bun';
    const updated = serializeWorkspaceConfig(config, original);
    expect(updated).toContain('command: bun # Numeric server');
    expect(loadYaml(updated)).toEqual(config);
    delete config.mcpServers['123'];
    const removed = serializeWorkspaceConfig(config, original);
    expect(removed).toContain('# Other server');
    expect(loadYaml(removed)).toEqual(config);
  });

  test('removes an indexed plugin through an alias without restoring its old value', () => {
    const original = 'defaults: &defaults\n  - ./one # Removed\n  - ./two # Retained\nplugins: *defaults\n';
    const config = loadYaml(original) as any;
    config.plugins.splice(0, 1);
    const result = serializeWorkspaceConfig(config, original, { removedPluginIndexes: [0] });
    expect(result).toContain('# Retained');
    expect(loadYaml(result)).toEqual(config);
  });

  test('retains supported YAML tags and core string semantics in untouched fields', () => {
    const original = 'plugins: []\nclients: []\nmetadata:\n  date: !!timestamp 2024-01-01\n  data: !!binary SGVsbG8=\n  set: !!set { a: null }\n  ordered: !!omap [a: one]\n  pairs: !!pairs [a: one]\n  switch: on\n';
    const config = loadYaml(original) as any;
    config.clients = ['cursor'];
    const result = serializeWorkspaceConfig(config, original);
    expect(result).toContain('!!timestamp');
    expect(result).toContain('!!binary');
    expect(loadYaml(result)).toEqual(config);
  });
});
