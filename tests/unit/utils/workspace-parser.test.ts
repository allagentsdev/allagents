import { describe, it, expect } from 'bun:test';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseUserWorkspaceConfig,
  parseWorkspaceConfig,
} from '../../../src/utils/workspace-parser.js';

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'allagents-parser-'));
}

describe('parseWorkspaceConfig', () => {
  it('should parse valid workspace config', async () => {
    const testDir = createTestDir();
    try {
      const configPath = join(testDir, 'workspace.yaml');
      const validConfig = `
repositories:
  - path: ../allagents
    source: github
    repo: allagentsdev/allagents
    description: primary project

plugins:
  - ./plugins/example

clients:
  - claude
`;
      writeFileSync(configPath, validConfig);

      const result = await parseWorkspaceConfig(configPath);

      expect(result.repositories).toHaveLength(1);
      expect(result.repositories[0]?.path).toBe('../allagents');
      expect(result.plugins).toHaveLength(1);
      expect(result.clients).toContain('claude');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should preserve YAML merge keys', async () => {
    const testDir = createTestDir();
    try {
      const configPath = join(testDir, 'workspace.yaml');
      writeFileSync(
        configPath,
        `
defaults: &defaults
  repositories: []
  plugins: []
  clients:
    - claude

<<: *defaults
`,
      );

      const result = await parseWorkspaceConfig(configPath);

      expect(result.repositories).toEqual([]);
      expect(result.plugins).toEqual([]);
      expect(result.clients).toEqual(['claude']);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should reject invalid client type', async () => {
    const testDir = createTestDir();
    try {
      const configPath = join(testDir, 'workspace.yaml');
      const invalidConfig = `
repositories: []
plugins: []
clients:
  - invalid-client
`;
      writeFileSync(configPath, invalidConfig);

      await expect(parseWorkspaceConfig(configPath)).rejects.toThrow('validation failed');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should throw error for missing file', async () => {
    await expect(parseWorkspaceConfig('/nonexistent/workspace.yaml')).rejects.toThrow(
      '.allagents/workspace.yaml not found'
    );
  });

  it('should throw error for empty file', async () => {
    const testDir = createTestDir();
    try {
      const configPath = join(testDir, 'workspace.yaml');
      writeFileSync(configPath, '');

      await expect(parseWorkspaceConfig(configPath)).rejects.toThrow('.allagents/workspace.yaml is empty');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('should throw error for missing required fields', async () => {
    const testDir = createTestDir();
    try {
      const configPath = join(testDir, 'workspace.yaml');
      const invalidConfig = `
repositories:
  - source: github
    # missing path (required)
plugins: []
clients: []
`;
      writeFileSync(configPath, invalidConfig);

      await expect(parseWorkspaceConfig(configPath)).rejects.toThrow('validation failed');
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

describe('scoped workspace parsing', () => {
  it('parses profiles only from a user workspace', async () => {
    const testDir = createTestDir();
    try {
      const configPath = join(testDir, 'workspace.yaml');
      writeFileSync(
        configPath,
        `
profiles:
  research:
    clients:
      - name: pi
        launcher: pi-research
`,
      );

      const result = await parseUserWorkspaceConfig(configPath);
      expect(result.repositories).toEqual([]);
      expect(result.plugins).toEqual([]);
      expect(result.clients).toEqual([]);
      expect(result.profiles?.research?.clients[0]?.settings).toEqual({});

      await expect(parseWorkspaceConfig(configPath)).rejects.toThrow(
        'profiles',
      );
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('surfaces nested user profile validation paths', async () => {
    const testDir = createTestDir();
    try {
      const configPath = join(testDir, 'workspace.yaml');
      writeFileSync(
        configPath,
        `
profiles:
  research:
    clients:
      - name: pi
        settings:
          generatedPath: /tmp/pi
`,
      );

      await expect(parseUserWorkspaceConfig(configPath)).rejects.toThrow(
        'profiles.research.clients.0.settings',
      );
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it('propagates malformed user YAML instead of treating it as absent', async () => {
    const testDir = createTestDir();
    try {
      const configPath = join(testDir, 'workspace.yaml');
      writeFileSync(configPath, 'profiles: [');
      await expect(parseUserWorkspaceConfig(configPath)).rejects.toThrow();
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

it('keeps workspace YAML diagnostics for syntax, tags, keys and comment-only input', async () => {
  const testDir = createTestDir();
  try {
    const configPath = join(testDir, 'workspace.yaml');
    for (const source of ['plugins: [', 'plugins: !unknown []', '[a,b]: value', '# Comment only\n']) {
      writeFileSync(configPath, source);
      await expect(parseWorkspaceConfig(configPath)).rejects.toThrow('Invalid YAML in .allagents/workspace.yaml:');
    }
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});
