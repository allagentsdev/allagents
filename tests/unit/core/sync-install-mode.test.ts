import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildPluginSyncPlans,
  nativeContextIdentity,
  nativeIdentityMatches,
  syncWorkspace,
} from '../../../src/core/sync.js';
import { UserWorkspaceConfigSchema } from '../../../src/models/workspace-config.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';

async function createPlugin(baseDir: string, name: string, skillName: string): Promise<string> {
  const pluginDir = join(baseDir, name);
  const skillDir = join(pluginDir, 'skills', skillName);
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), `---\nname: ${skillName}\ndescription: test\n---\n`);
  return pluginDir;
}

describe('syncWorkspace — install mode', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-sync-install-mode-'));
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('file-only clients work as before with string shorthand', async () => {
    await createPlugin(testDir, 'test-plugin', 'test-skill');
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      'repositories: []\nplugins:\n  - ./test-plugin\nclients:\n  - claude\n  - copilot\n',
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);
    expect(existsSync(join(testDir, '.claude', 'skills', 'test-skill'))).toBe(true);
    expect(existsSync(join(testDir, '.github', 'skills', 'test-skill'))).toBe(true);
  });

  it('rejects unsupported explicit native sources without file fallback', async () => {
    await createPlugin(testDir, 'test-plugin', 'test-skill');
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      'repositories: []\nplugins:\n  - ./test-plugin\nclients:\n  - name: claude\n    install: native\n  - copilot\n',
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(false);
    expect(existsSync(join(testDir, '.claude', 'skills', 'test-skill'))).toBe(false);
    expect(existsSync(join(testDir, '.github', 'skills', 'test-skill'))).toBe(false);
  });

  it('plugin-level install:file overrides client native', async () => {
    await createPlugin(testDir, 'test-plugin', 'test-skill');
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      'repositories: []\nplugins:\n  - source: ./test-plugin\n    install: file\nclients:\n  - name: claude\n    install: native\n',
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);
    // Plugin forces file mode even for native client
    expect(existsSync(join(testDir, '.claude', 'skills', 'test-skill'))).toBe(true);
  });

  it('does not silently copy a local source requested as native', async () => {
    await createPlugin(testDir, 'local-plugin', 'local-skill');
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      'repositories: []\nplugins:\n  - ./local-plugin\nclients:\n  - name: claude\n    install: native\n',
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(false);
    expect(existsSync(join(testDir, '.claude', 'skills', 'local-skill'))).toBe(false);
  });

  it('rejects an unsupported native scope before copying', async () => {
    await createPlugin(testDir, 'test-plugin', 'test-skill');
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      'repositories: []\nplugins:\n  - ./test-plugin\nclients:\n  - name: copilot\n    install: native\n',
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(false);
    expect(existsSync(join(testDir, '.github', 'skills', 'test-skill'))).toBe(false);
  });

  it('colon shorthand native rejects an unsupported source before file mutation', async () => {
    await createPlugin(testDir, 'test-plugin', 'test-skill');
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      'repositories: []\nplugins:\n  - ./test-plugin\nclients:\n  - copilot\n  - claude:native\n',
    );

    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(false);
    expect(existsSync(join(testDir, '.claude', 'skills', 'test-skill'))).toBe(false);
    expect(existsSync(join(testDir, '.github', 'skills', 'test-skill'))).toBe(false);
  });

  it('plans Codex native installation through the ordinary user sync path', () => {
    const config = UserWorkspaceConfigSchema.parse({
      repositories: [],
      plugins: [],
      clients: ['codex:native'],
    });
    const result = buildPluginSyncPlans(
      [{ source: 'demo@tools' }],
      config.clients,
      'user',
    );

    expect(result.errors).toEqual([]);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]).toMatchObject({
      clients: [],
      nativeClients: ['codex'],
    });
  });
});

describe('native lifecycle identity', () => {
  it('matches qualified marketplace declarations exactly', () => {
    expect(
      nativeIdentityMatches(
        'review@market-b',
        'review@market-a',
        'review@market-a',
      ),
    ).toBe(false);
    expect(
      nativeIdentityMatches(
        'review@market-a',
        'review@market-a',
        'review@market-a',
      ),
    ).toBe(true);
  });

  it('matches Pi npm declarations by exact package identity', () => {
    expect(
      nativeIdentityMatches(
        '@scope/review',
        '@scope/review',
        'npm:@scope/review@2.0.0',
      ),
    ).toBe(true);
    expect(
      nativeIdentityMatches(
        '@other/review',
        '@scope/review',
        'npm:@scope/review@2.0.0',
      ),
    ).toBe(false);
  });

  it('includes every authoritative OMP root in durable context identity', () => {
    const base = {
      client: 'omp' as const,
      scope: 'user' as const,
      nativeScope: 'user' as const,
      root: '/tmp/omp',
      roots: { agent: '/tmp/omp', data: '/tmp/data-a' },
    };
    expect(nativeContextIdentity(base)).not.toBe(
      nativeContextIdentity({
        ...base,
        roots: { agent: '/tmp/omp', data: '/tmp/data-b' },
      }),
    );
  });
});
