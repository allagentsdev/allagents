import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as dump } from 'yaml';
import { syncUserWorkspace } from '../../../src/core/sync.js';
import { WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';
import type { WorkspaceConfig } from '../../../src/models/workspace-config.js';
import { stubHomeDir } from '../../helpers/env.js';

describe('syncUserWorkspace', () => {
  let testDir: string;
  let restoreHomeDir: () => void;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-sync-user-test-'));
    restoreHomeDir = stubHomeDir(testDir);
  });

  afterEach(async () => {
    restoreHomeDir();
    await rm(testDir, { recursive: true, force: true });
  });

  /**
   * Helper: create ~/.allagents/workspace.yaml with given config
   */
  async function writeUserConfig(config: WorkspaceConfig): Promise<void> {
    const allagentsDir = join(testDir, '.allagents');
    await mkdir(allagentsDir, { recursive: true });
    await writeFile(
      join(allagentsDir, WORKSPACE_CONFIG_FILE),
      dump(config, { lineWidth: -1 }),
      'utf-8',
    );
  }

  /**
   * Helper: create a local plugin directory with a skill
   */
  async function createLocalPlugin(
    name: string,
    skillName: string,
  ): Promise<string> {
    const pluginDir = join(testDir, 'plugins', name);
    const skillDir = join(pluginDir, 'skills', skillName);
    await mkdir(skillDir, { recursive: true });
    const skillContent = [
      '---',
      `name: ${skillName}`,
      `description: A test skill called ${skillName}`,
      '---',
      '',
      `# ${skillName} skill`,
    ].join('\n');
    await writeFile(join(skillDir, 'SKILL.md'), skillContent);
    return pluginDir;
  }

  it('returns success with empty results when no user workspace config exists', async () => {
    // No ~/.allagents/workspace.yaml exists
    const result = await syncUserWorkspace();

    expect(result.success).toBe(true);
    expect(result.pluginResults).toEqual([]);
    expect(result.totalCopied).toBe(0);
    expect(result.totalFailed).toBe(0);
    expect(result.totalSkipped).toBe(0);
    expect(result.totalGenerated).toBe(0);
  });

  it('returns success with empty results when config has no plugins', async () => {
    await writeUserConfig({
      repositories: [],
      plugins: [],
      clients: ['claude'],
    });

    const result = await syncUserWorkspace();

    expect(result.success).toBe(true);
    expect(result.pluginResults).toEqual([]);
    expect(result.totalCopied).toBe(0);
  });

  it('syncs local plugin skills to user home directories', async () => {
    const pluginDir = await createLocalPlugin('my-plugin', 'my-skill');

    await writeUserConfig({
      repositories: [],
      plugins: [pluginDir],
      clients: ['claude'],
      syncMode: 'copy', // Use copy mode for predictable counts
    });

    const result = await syncUserWorkspace();

    expect(result.success).toBe(true);
    expect(result.totalCopied).toBe(1);
    expect(result.totalFailed).toBe(0);

    // Skill should be copied to ~/.claude/skills/my-skill/
    const skillDest = join(testDir, '.claude', 'skills', 'my-skill', 'SKILL.md');
    expect(existsSync(skillDest)).toBe(true);
    const content = await readFile(skillDest, 'utf-8');
    expect(content).toContain('# my-skill skill');
  });

  it('syncs to multiple clients using USER_CLIENT_MAPPINGS', async () => {
    const pluginDir = await createLocalPlugin('my-plugin', 'my-skill');

    await writeUserConfig({
      repositories: [],
      plugins: [pluginDir],
      clients: ['claude', 'cursor'],
      syncMode: 'copy', // Use copy mode for predictable counts
    });

    const result = await syncUserWorkspace();

    expect(result.success).toBe(true);
    expect(result.totalCopied).toBe(2); // One skill to each client

    // Claude: ~/.claude/skills/my-skill/SKILL.md
    expect(existsSync(join(testDir, '.claude', 'skills', 'my-skill', 'SKILL.md'))).toBe(true);

    // Cursor: ~/.cursor/skills/my-skill/SKILL.md
    expect(existsSync(join(testDir, '.cursor', 'skills', 'my-skill', 'SKILL.md'))).toBe(true);
  });

  it('purges previously synced files on re-sync when plugin is removed', async () => {
    const pluginDir = await createLocalPlugin('my-plugin', 'my-skill');

    // First sync with plugin
    await writeUserConfig({
      repositories: [],
      plugins: [pluginDir],
      clients: ['claude'],
      syncMode: 'copy', // Use copy mode for predictable counts
    });

    const result1 = await syncUserWorkspace();
    expect(result1.success).toBe(true);
    expect(result1.totalCopied).toBe(1);

    // Verify file exists
    const skillDest = join(testDir, '.claude', 'skills', 'my-skill', 'SKILL.md');
    expect(existsSync(skillDest)).toBe(true);

    // Second sync without plugin (removed from config)
    await writeUserConfig({
      repositories: [],
      plugins: [],
      clients: ['claude'],
      syncMode: 'copy', // Use copy mode for predictable counts
    });

    const result2 = await syncUserWorkspace();
    expect(result2.success).toBe(true);
    expect(result2.totalCopied).toBe(0);

    // Previously synced skill should be purged
    expect(existsSync(skillDest)).toBe(false);
  });

  it('saves sync state to ~/.allagents/sync-state.json', async () => {
    const pluginDir = await createLocalPlugin('my-plugin', 'my-skill');

    await writeUserConfig({
      repositories: [],
      plugins: [pluginDir],
      clients: ['claude'],
    });

    await syncUserWorkspace();

    // Sync state should exist
    const statePath = join(testDir, '.allagents', 'sync-state.json');
    expect(existsSync(statePath)).toBe(true);

    const stateContent = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(stateContent.version).toBe(1);
    expect(stateContent.files.claude).toBeDefined();
    expect(stateContent.files.claude.length).toBeGreaterThan(0);
  });

  it('does not write files in dry-run mode', async () => {
    const pluginDir = await createLocalPlugin('my-plugin', 'my-skill');

    await writeUserConfig({
      repositories: [],
      plugins: [pluginDir],
      clients: ['claude'],
      syncMode: 'copy', // Use copy mode for predictable counts
    });

    const result = await syncUserWorkspace({ dryRun: true });

    expect(result.success).toBe(true);
    expect(result.totalCopied).toBe(1); // Reports as copied but doesn't actually write

    // Skill should NOT be on disk
    const skillDest = join(testDir, '.claude', 'skills', 'my-skill', 'SKILL.md');
    expect(existsSync(skillDest)).toBe(false);
  });

  it('returns failure when plugin validation fails', async () => {
    await writeUserConfig({
      repositories: [],
      plugins: ['/nonexistent/path/to/plugin'],
      clients: ['claude'],
    });

    const result = await syncUserWorkspace();

    expect(result.success).toBe(false);
    expect(result.totalFailed).toBeGreaterThan(0);
    expect(result.error).toBeDefined();
  });

  it('copies to each provider-specific path when clients have unique paths', async () => {
    // copilot, codex, opencode now each have unique user-level paths
    const pluginDir = await createLocalPlugin('my-plugin', 'my-skill');

    await writeUserConfig({
      repositories: [],
      plugins: [pluginDir],
      clients: ['copilot', 'codex', 'opencode'],
    });

    const result = await syncUserWorkspace();

    expect(result.success).toBe(true);
    // Should copy 3 times since all have different paths
    expect(result.totalCopied).toBe(3);

    // Skills should exist in each provider-specific path
    expect(existsSync(join(testDir, '.copilot', 'skills', 'my-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(testDir, '.codex', 'skills', 'my-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(testDir, '.opencode', 'skills', 'my-skill', 'SKILL.md'))).toBe(true);

    // Verify sync state tracks the skill for all clients
    const statePath = join(testDir, '.allagents', 'sync-state.json');
    const stateContent = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(stateContent.files.copilot).toContain('.copilot/skills/my-skill/');
    expect(stateContent.files.codex).toContain('.codex/skills/my-skill/');
    expect(stateContent.files.opencode).toContain('.opencode/skills/my-skill/');
  });

  it('syncs to different paths for mixed clients', async () => {
    // claude uses ~/.claude/skills/, copilot uses ~/.copilot/skills/, codex uses ~/.codex/skills/
    const pluginDir = await createLocalPlugin('my-plugin', 'my-skill');

    await writeUserConfig({
      repositories: [],
      plugins: [pluginDir],
      clients: ['claude', 'copilot', 'codex'],
    });

    const result = await syncUserWorkspace();

    expect(result.success).toBe(true);
    // Should copy three times: each client has a unique path
    expect(result.totalCopied).toBe(3);

    // Skill should exist in all locations
    expect(existsSync(join(testDir, '.claude', 'skills', 'my-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(testDir, '.copilot', 'skills', 'my-skill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(testDir, '.codex', 'skills', 'my-skill', 'SKILL.md'))).toBe(true);

    // Verify sync state tracks correctly
    const statePath = join(testDir, '.allagents', 'sync-state.json');
    const stateContent = JSON.parse(await readFile(statePath, 'utf-8'));
    expect(stateContent.files.claude).toContain('.claude/skills/my-skill/');
    expect(stateContent.files.copilot).toContain('.copilot/skills/my-skill/');
    expect(stateContent.files.codex).toContain('.codex/skills/my-skill/');
  });

  it('keeps repository hooks project-scoped during user Copilot sync', async () => {
    const pluginDir = join(testDir, 'plugins', 'copilot-hooks');
    await mkdir(join(pluginDir, 'hooks'), { recursive: true });
    await mkdir(join(pluginDir, '.github', 'hooks', 'scripts'), {
      recursive: true,
    });
    await mkdir(join(pluginDir, '.github', 'prompts'), { recursive: true });
    await writeFile(
      join(pluginDir, 'hooks', 'global.json'),
      '{"hooks":{}}',
    );
    await writeFile(
      join(pluginDir, '.github', 'hooks', 'repository.json'),
      '{"hooks":{}}',
    );
    await writeFile(
      join(pluginDir, '.github', 'hooks', 'scripts', 'repository.mjs'),
      'console.log("repository hook")',
    );
    await writeFile(
      join(pluginDir, '.github', 'prompts', 'review.prompt.md'),
      '# Review',
    );

    await writeUserConfig({
      repositories: [],
      plugins: [pluginDir],
      clients: ['copilot'],
      syncMode: 'copy',
    });

    // Simulate an upgrade from a version that promoted .github/hooks into
    // the user-global Copilot directory. Ownership was not tracked, so the
    // next sync must leave the files in place and warn instead of deleting
    // potentially user-owned hooks.
    const globalHooksDir = join(testDir, '.copilot', 'hooks');
    await mkdir(join(globalHooksDir, 'scripts'), { recursive: true });
    await writeFile(
      join(globalHooksDir, 'repository.json'),
      '{"hooks":{}}',
    );
    await writeFile(
      join(globalHooksDir, 'scripts', 'repository.mjs'),
      'console.log("repository hook")',
    );
    await writeFile(
      join(globalHooksDir, 'user-owned.json'),
      '{"hooks":{"UserPromptSubmit":[]}}',
    );
    await writeFile(
      join(testDir, '.allagents', 'sync-state.json'),
      JSON.stringify({
        version: 1,
        lastSync: new Date().toISOString(),
        files: { copilot: [] },
      }),
    );

    const result = await syncUserWorkspace();

    expect(result.success).toBe(true);
    expect(existsSync(join(globalHooksDir, 'global.json'))).toBe(true);
    expect(existsSync(join(globalHooksDir, 'repository.json'))).toBe(true);
    expect(
      existsSync(join(globalHooksDir, 'scripts', 'repository.mjs')),
    ).toBe(true);
    expect(existsSync(join(globalHooksDir, 'user-owned.json'))).toBe(true);
    expect(
      existsSync(
        join(testDir, '.copilot', 'prompts', 'review.prompt.md'),
      ),
    ).toBe(true);
    expect(result.warnings).toContain(
      "Copilot user hook '.copilot/hooks/repository.json' shares a path with a repository .github/hooks artifact. Repository hooks are no longer synced at user scope; review this file manually if an older AllAgents version installed it. A root hooks/ artifact may still manage the same path.",
    );
    expect(result.warnings).toContain(
      "Copilot user hook '.copilot/hooks/scripts/repository.mjs' shares a path with a repository .github/hooks artifact. Repository hooks are no longer synced at user scope; review this file manually if an older AllAgents version installed it. A root hooks/ artifact may still manage the same path.",
    );
  });

  it('reports a legacy path accurately when a root hook overwrites it', async () => {
    const pluginDir = join(testDir, 'plugins', 'copilot-hooks');
    await mkdir(join(pluginDir, 'hooks'), { recursive: true });
    await mkdir(join(pluginDir, '.github', 'hooks'), { recursive: true });
    await writeFile(
      join(pluginDir, 'hooks', 'repository.json'),
      '{"hooks":{"global":true}}',
    );
    await writeFile(
      join(pluginDir, '.github', 'hooks', 'repository.json'),
      '{"hooks":{"source":true}}',
    );
    await writeUserConfig({
      repositories: [],
      plugins: [pluginDir],
      clients: ['copilot'],
      syncMode: 'copy',
    });

    const legacyHookPath = join(
      testDir,
      '.copilot',
      'hooks',
      'repository.json',
    );
    await mkdir(join(testDir, '.copilot', 'hooks'), { recursive: true });
    await writeFile(legacyHookPath, '{"hooks":{"userModified":true}}');

    const result = await syncUserWorkspace();

    expect(await readFile(legacyHookPath, 'utf-8')).toBe(
      '{"hooks":{"global":true}}',
    );
    expect(result.warnings).toContain(
      "Copilot user hook '.copilot/hooks/repository.json' shares a path with a repository .github/hooks artifact. Repository hooks are no longer synced at user scope; review this file manually if an older AllAgents version installed it. A root hooks/ artifact may still manage the same path.",
    );
  });

  it('writes and purges Pi skills in an external selected agent root', async () => {
    const externalRoot = await mkdtemp(
      join(tmpdir(), 'allagents-pi-agent-test-'),
    );
    const priorAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = externalRoot;

    try {
      const pluginDir = await createLocalPlugin('pi-plugin', 'pi-skill');
      await writeUserConfig({
        repositories: [],
        plugins: [pluginDir],
        clients: ['pi'],
        syncMode: 'copy',
      });

      const first = await syncUserWorkspace();
      const skillPath = join(externalRoot, 'skills', 'pi-skill');
      expect(first.success).toBe(true);
      expect(existsSync(join(skillPath, 'SKILL.md'))).toBe(true);

      const state = JSON.parse(
        await readFile(join(testDir, '.allagents', 'sync-state.json'), 'utf-8'),
      );
      expect(state.files.pi).toContain(
        `${skillPath.replaceAll('\\', '/')}/`,
      );
      expect(state.files.pi.every((path: string) => !path.includes('../'))).toBe(
        true,
      );

      await writeUserConfig({
        repositories: [],
        plugins: [],
        clients: ['pi'],
        syncMode: 'copy',
      });
      const second = await syncUserWorkspace();
      expect(second.success).toBe(true);
      expect(existsSync(skillPath)).toBe(false);
    } finally {
      if (priorAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = priorAgentDir;
      }
      await rm(externalRoot, { recursive: true, force: true });
    }
  });
});
