import { describe, expect, test } from 'bun:test';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildPathPlaceholderMap,
  computeWorkspaceHash,
  generateVscodeWorkspace,
  getWorkspaceOutputPath,
  reconcileVscodeWorkspaceFolders,
  substitutePathPlaceholders,
} from '../../../src/core/vscode-workspace.js';

// Use tmpdir for cross-platform test paths
const testBase = join(tmpdir(), 'allagents-test');

describe('generateVscodeWorkspace', () => {
  test('generates workspace with repository folders preserving relative paths from workspace.yaml', () => {
    const workspacePath = join(testBase, 'myapp');
    const result = generateVscodeWorkspace({
      workspacePath,
      repositories: [
        { path: '../backend' },
        { path: '../frontend' },
      ],
      template: undefined,
    });

    expect(result.folders).toEqual([
      { path: '.' },
      { path: '../backend' },
      { path: '../frontend' },
    ]);
  });

  test('includes name in folder entry when repository has name', () => {
    const workspacePath = join(testBase, 'myapp');
    const result = generateVscodeWorkspace({
      workspacePath,
      repositories: [
        { path: '../backend', name: 'API Server' },
        { path: '../frontend' },
      ],
      template: undefined,
    });

    expect(result.folders).toEqual([
      { path: '.' },
      { path: '../backend', name: 'API Server' },
      { path: '../frontend' },
    ]);
  });

  test('applies default settings when no template', () => {
    const result = generateVscodeWorkspace({
      workspacePath: join(testBase, 'myapp'),
      repositories: [],
      template: undefined,
    });

    expect(result.settings).toEqual({
      'chat.agent.maxRequests': 999,
    });
  });

  test('merges template folders after repo folders, deduplicating by path', () => {
    const workspacePath = join(testBase, 'myapp');
    const sharedPath = resolve(workspacePath, '../shared').replace(/\\/g, '/');
    const extraPath = join(testBase, 'extra').replace(/\\/g, '/');

    const result = generateVscodeWorkspace({
      workspacePath,
      repositories: [
        { path: '../backend' },
        { path: '../shared' },
      ],
      template: {
        folders: [
          { path: sharedPath, name: 'SharedLib' }, // duplicate of ../shared
          { path: extraPath, name: 'ExtraLib' },
        ],
      },
    });

    // ../shared resolves to sharedPath — template duplicate removed
    // extra is not a duplicate, so it's kept with its name
    expect(result.folders).toEqual([
      { path: '.' },
      { path: '../backend' },
      { path: '../shared' },
      { path: extraPath, name: 'ExtraLib' },
    ]);
  });

  test('uses template settings verbatim, no defaults injected', () => {
    const result = generateVscodeWorkspace({
      workspacePath: join(testBase, 'myapp'),
      repositories: [],
      template: {
        settings: {
          'chat.agent.maxRequests': 50,
          'cSpell.words': ['foo'],
        },
      },
    });

    expect(result.settings).toEqual({
      'chat.agent.maxRequests': 50,
      'cSpell.words': ['foo'],
    });
  });

  test('passes through template launch/extensions verbatim', () => {
    const template = {
      settings: { 'chat.agent.maxRequests': 999 },
      launch: {
        configurations: [
          { type: 'node', name: 'dev', runtimeExecutable: 'npm' },
        ],
      },
      extensions: {
        recommendations: ['dbaeumer.vscode-eslint'],
      },
    };

    const result = generateVscodeWorkspace({
      workspacePath: join(testBase, 'myapp'),
      repositories: [],
      template,
    });

    expect(result.launch).toEqual(template.launch);
    expect(result.extensions).toEqual(template.extensions);
  });
});

describe('substitutePathPlaceholders', () => {
  // Use resolved paths for the map values (with forward slashes for consistency)
  const glowPath = resolve(testBase, 'Glow').replace(/\\/g, '/');
  const glowSharedPath = resolve(testBase, 'Glow.Shared').replace(/\\/g, '/');
  const pathMap = new Map<string, string>([
    ['../Glow', glowPath],
    ['../Glow.Shared', glowSharedPath],
  ]);

  test('substitutes {path:..} in string values', () => {
    const input = { cwd: '{path:../Glow}/DotNet/Client' };
    const result = substitutePathPlaceholders(input, pathMap);
    expect(result.cwd).toBe(`${glowPath}/DotNet/Client`);
  });

  test('substitutes in nested objects', () => {
    const input = {
      launch: {
        configurations: [
          { cwd: '{path:../Glow}/src', name: 'dev' },
        ],
      },
    };
    const result = substitutePathPlaceholders(input, pathMap);
    expect(result.launch.configurations[0].cwd).toBe(`${glowPath}/src`);
    expect(result.launch.configurations[0].name).toBe('dev');
  });

  test('substitutes in folder path entries', () => {
    const input = {
      folders: [
        { path: '{path:../Glow.Shared}', name: 'Shared' },
      ],
    };
    const result = substitutePathPlaceholders(input, pathMap);
    expect(result.folders[0].path).toBe(glowSharedPath);
  });

  test('leaves strings without placeholders unchanged', () => {
    const input = { name: 'no placeholders here' };
    const result = substitutePathPlaceholders(input, pathMap);
    expect(result.name).toBe('no placeholders here');
  });

  test('leaves non-string values unchanged', () => {
    const input = { count: 999, enabled: true, items: [1, 2, 3] };
    const result = substitutePathPlaceholders(input, pathMap);
    expect(result).toEqual(input);
  });
});

describe('buildPathPlaceholderMap', () => {
  test('registers repositories by relative path', () => {
    const workspacePath = join(testBase, 'workspace');
    const map = buildPathPlaceholderMap(
      [{ path: '../Glow' }, { path: '../Glow.Shared' }],
      workspacePath,
    );

    expect(map.get('../Glow')).toBe(resolve(workspacePath, '../Glow'));
    expect(map.get('../Glow.Shared')).toBe(resolve(workspacePath, '../Glow.Shared'));
  });

  test('resolves paths to absolute paths', () => {
    const workspacePath = join(testBase, 'workspace');
    const map = buildPathPlaceholderMap(
      [{ path: '../Glow', repo: 'WiseTechGlobal/Glow' }],
      workspacePath,
    );

    // Path should be absolute (not relative)
    const resolved = map.get('../Glow');
    expect(resolved).toBeDefined();
    expect(resolved).not.toContain('..');
  });
});

describe('getWorkspaceOutputPath', () => {
  test('uses vscode.output from config', () => {
    const workspacePath = join(testBase, 'myapp');
    const result = getWorkspaceOutputPath(workspacePath, { output: 'glow' });
    expect(result).toBe(join(workspacePath, 'glow.code-workspace'));
  });

  test('defaults to dirname when no config', () => {
    const workspacePath = join(testBase, 'myapp');
    const result = getWorkspaceOutputPath(workspacePath, undefined);
    expect(result).toBe(join(workspacePath, 'myapp.code-workspace'));
  });

  test('does not double-add .code-workspace extension', () => {
    const workspacePath = join(testBase, 'myapp');
    const result = getWorkspaceOutputPath(workspacePath, { output: 'test.code-workspace' });
    expect(result).toBe(join(workspacePath, 'test.code-workspace'));
  });
});

describe('computeWorkspaceHash', () => {
  test('returns consistent SHA-256 hex for same content', () => {
    const content = '{"folders":[{"path":"."}]}';
    const hash1 = computeWorkspaceHash(content);
    const hash2 = computeWorkspaceHash(content);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex = 64 chars
  });

  test('returns different hash for different content', () => {
    const hash1 = computeWorkspaceHash('{"folders":[{"path":"."}]}');
    const hash2 = computeWorkspaceHash('{"folders":[{"path":"./src"}]}');
    expect(hash1).not.toBe(hash2);
  });
});

describe('reconcileVscodeWorkspaceFolders', () => {
  const workspacePath = join(testBase, 'myapp');
  const absPath = (rel: string) => resolve(workspacePath, rel).replace(/\\/g, '/');

  test('no changes when all three sources agree', () => {
    const lastSyncedRepos = [absPath('../backend'), absPath('../frontend')];
    const codeWorkspaceFolders = [
      { path: '.' },
      { path: absPath('../backend') },
      { path: absPath('../frontend') },
    ];
    const currentRepos = [{ path: '../backend' }, { path: '../frontend' }];

    const result = reconcileVscodeWorkspaceFolders(
      workspacePath, codeWorkspaceFolders, lastSyncedRepos.map(path => ({ path })), lastSyncedRepos, currentRepos,
    );

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.updatedRepos).toEqual(currentRepos);
  });

  test('removes repo that was deleted from .code-workspace', () => {
    const lastSyncedRepos = [absPath('../backend'), absPath('../frontend')];
    const codeWorkspaceFolders = [
      { path: '.' },
      { path: absPath('../backend') },
      // ../frontend removed by user in VS Code
    ];
    const currentRepos = [{ path: '../backend' }, { path: '../frontend' }];

    const result = reconcileVscodeWorkspaceFolders(
      workspacePath, codeWorkspaceFolders, lastSyncedRepos.map(path => ({ path })), lastSyncedRepos, currentRepos,
    );

    expect(result.removed).toEqual(['../frontend']);
    expect(result.added).toEqual([]);
    expect(result.updatedRepos).toEqual([{ path: '../backend' }]);
  });

  test('adds repo that was added to .code-workspace', () => {
    const lastSyncedRepos = [absPath('../backend')];
    const codeWorkspaceFolders = [
      { path: '.' },
      { path: absPath('../backend') },
      { path: absPath('../new-service') }, // added by user in VS Code
    ];
    const currentRepos = [{ path: '../backend' }];

    const result = reconcileVscodeWorkspaceFolders(
      workspacePath, codeWorkspaceFolders, lastSyncedRepos.map(path => ({ path })), lastSyncedRepos, currentRepos,
    );

    expect(result.added.length).toBe(1);
    expect(result.added[0]).toContain('new-service');
    expect(result.removed).toEqual([]);
    expect(result.updatedRepos.length).toBe(2);
    expect(result.updatedRepos[0]).toEqual({ path: '../backend' });
    expect(result.updatedRepos[1].path).toContain('new-service');
  });

  test('handles simultaneous add in .code-workspace and add in workspace.yaml', () => {
    const lastSyncedRepos = [absPath('../backend')];
    const codeWorkspaceFolders = [
      { path: '.' },
      { path: absPath('../backend') },
      { path: absPath('../from-vscode') }, // added in VS Code
    ];
    const currentRepos = [
      { path: '../backend' },
      { path: '../from-yaml' }, // added in workspace.yaml
    ];

    const result = reconcileVscodeWorkspaceFolders(
      workspacePath, codeWorkspaceFolders, lastSyncedRepos.map(path => ({ path })), lastSyncedRepos, currentRepos,
    );

    expect(result.added.length).toBe(1);
    expect(result.added[0]).toContain('from-vscode');
    expect(result.removed).toEqual([]);
    // Should have backend + from-yaml (kept) + from-vscode (added)
    expect(result.updatedRepos.length).toBe(3);
  });

  test('handles simultaneous remove in .code-workspace and add in workspace.yaml', () => {
    const lastSyncedRepos = [absPath('../backend'), absPath('../frontend')];
    const codeWorkspaceFolders = [
      { path: '.' },
      { path: absPath('../backend') },
      // ../frontend removed in VS Code
    ];
    const currentRepos = [
      { path: '../backend' },
      { path: '../frontend' },
      { path: '../new-cli' }, // added in workspace.yaml
    ];

    const result = reconcileVscodeWorkspaceFolders(
      workspacePath, codeWorkspaceFolders, lastSyncedRepos.map(path => ({ path })), lastSyncedRepos, currentRepos,
    );

    expect(result.removed).toEqual(['../frontend']);
    expect(result.added).toEqual([]);
    expect(result.updatedRepos).toEqual([
      { path: '../backend' },
      { path: '../new-cli' },
    ]);
  });

  test('skips workspace root folder (.) during reconciliation', () => {
    const lastSyncedRepos = [absPath('../backend')];
    const codeWorkspaceFolders = [
      { path: '.' },
      { path: absPath('../backend') },
    ];
    const currentRepos = [{ path: '../backend' }];

    const result = reconcileVscodeWorkspaceFolders(
      workspacePath, codeWorkspaceFolders, lastSyncedRepos.map(path => ({ path })), lastSyncedRepos, currentRepos,
    );

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
  });

  test('preserves name from .code-workspace folder when adding new repo', () => {
    const lastSyncedRepos = [absPath('../backend')];
    const codeWorkspaceFolders = [
      { path: '.' },
      { path: absPath('../backend') },
      { path: absPath('../designs/GLOW'), name: 'ModernPlatform.Designs.GLOW' },
    ];
    const currentRepos = [{ path: '../backend' }];

    const result = reconcileVscodeWorkspaceFolders(
      workspacePath, codeWorkspaceFolders, lastSyncedRepos.map(path => ({ path })), lastSyncedRepos, currentRepos,
    );

    expect(result.added.length).toBe(1);
    const addedRepo = result.updatedRepos.find(r => r.path.includes('GLOW'));
    expect(addedRepo).toBeDefined();
    expect(addedRepo!.name).toBe('ModernPlatform.Designs.GLOW');
  });

  test('preserves name edits from .code-workspace for an existing repo', () => {
    const lastSyncedRepos = [absPath('../backend')];
    const codeWorkspaceFolders = [
      { path: '.' },
      { path: absPath('../backend'), name: 'API Server' },
    ];
    const currentRepos = [{ path: '../backend' }];

    const result = reconcileVscodeWorkspaceFolders(
      workspacePath, codeWorkspaceFolders, lastSyncedRepos.map(path => ({ path })), lastSyncedRepos, currentRepos,
    );

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.renamed).toEqual(['../backend']);
    expect(result.updatedRepos).toEqual([{ path: '../backend', name: 'API Server' }]);
  });

  test('removes repo name when folder name is removed from .code-workspace', () => {
    const lastSyncedRepos = [absPath('../backend')];
    const codeWorkspaceFolders = [
      { path: '.' },
      { path: absPath('../backend') },
    ];
    const currentRepos = [{ path: '../backend', name: 'API Server' }];

    const result = reconcileVscodeWorkspaceFolders(
      workspacePath, codeWorkspaceFolders, lastSyncedRepos.map(path => ({ path, name: 'API Server' })), lastSyncedRepos, currentRepos,
    );

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.renamed).toEqual(['../backend']);
    expect(result.updatedRepos).toEqual([{ path: '../backend' }]);
  });

  test('preserves existing repo properties (description, source) on unchanged repos', () => {
    const lastSyncedRepos = [absPath('../backend'), absPath('../frontend')];
    const codeWorkspaceFolders = [
      { path: '.' },
      { path: absPath('../backend') },
      // ../frontend removed
    ];
    const currentRepos = [
      { path: '../backend', description: 'API server', repo: 'org/backend' },
      { path: '../frontend', description: 'Web app' },
    ];

    const result = reconcileVscodeWorkspaceFolders(
      workspacePath, codeWorkspaceFolders, lastSyncedRepos.map(path => ({ path })), lastSyncedRepos, currentRepos,
    );

    expect(result.updatedRepos).toEqual([
      { path: '../backend', description: 'API server', repo: 'org/backend' },
    ]);
    expect(result.renamed).toEqual([]);
  });
  test('normalized absolute workspace-root spellings cannot become repositories', () => {
    const current = [{ path: '../backend' }];
    const baseline = [{ path: absPath('.') }, { path: absPath('../backend') }];
    const result = reconcileVscodeWorkspaceFolders(workspacePath,
      [{ path: `${workspacePath}/child/..` }, { path: '../backend' }],
      baseline, [absPath('../backend')], current);
    expect(result.updatedRepos).toEqual(current);
    expect(result.added).toEqual([]);
  });

});
