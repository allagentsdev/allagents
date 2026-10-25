import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncClaudeMcpConfig } from '../../../src/core/claude-mcp.js';
import { syncVscodeMcpConfig } from '../../../src/core/vscode-mcp.js';

describe.each([
  ['Claude', 'mcpServers', syncClaudeMcpConfig],
  ['VS Code', 'servers', syncVscodeMcpConfig],
] as const)('%s JSON MCP configuration ownership', (_client, key, sync) => {
  let directory: string;
  let configPath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'allagents-json-mcp-'));
    configPath = join(directory, 'mcp.json');
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  test.each([
    '{"pending-edit": true,',
    'null',
    '[]',
    '"personal configuration"',
    `{ "${key}": null }`,
    `{ "${key}": [] }`,
    `{ "${key}": "personal-server" }`,
  ])('preserves invalid configuration and tracking: %s', (original) => {
    writeFileSync(configPath, original);
    for (const dryRun of [false, true]) {
      const result = sync([], {
        configPath,
        dryRun,
        force: true,
        trackedServers: ['old-server'],
        serverOverrides: new Map([['new-server', { command: 'new-command' }]]),
      });
      expect(result.authoritative).toBe(false);
      expect(result.trackedServers).toEqual(['old-server']);
      expect([result.added, result.overwritten, result.removed]).toEqual([0, 0, 0]);
      expect(result.warnings.join(' ')).toContain('Refusing to overwrite');
      expect(result.configPath).toBeUndefined();
      expect(readFileSync(configPath, 'utf8')).toBe(original);
    }
  });

  test('recovers after repair and removes only previously owned servers', () => {
    const original = `// user comment\n{ unrelated: { keep: true }, ${key}: {
      personal: { command: 'keep-me' }, old: { command: 'remove-me' },
    } }`;
    writeFileSync(configPath, original);
    const result = sync([], { configPath, trackedServers: ['old'] });
    expect(result.removedServers).toEqual(['old']);
    expect(result.trackedServers).toEqual([]);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      unrelated: { keep: true }, [key]: { personal: { command: 'keep-me' } },
    });
    const settled = readFileSync(configPath, 'utf8');
    expect(sync([], { configPath, trackedServers: [] }).configPath).toBeUndefined();
    expect(readFileSync(configPath, 'utf8')).toBe(settled);
  });
});
