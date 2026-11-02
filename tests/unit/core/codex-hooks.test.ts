import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncCodexProjectHooks } from '../../../src/core/codex-hooks.js';
import { syncWorkspace } from '../../../src/core/sync.js';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';
import type { SyncState } from '../../../src/models/sync-state.js';
import type { ValidatedPlugin } from '../../../src/core/sync.js';
import { resolvePluginComponents } from '../../../src/core/plugin-components.js';

function validatedCodexPlugin(path: string, plugin: string): ValidatedPlugin {
  return {
    plugin,
    resolved: path,
    success: true,
    clients: ['codex'],
    nativeClients: [],
  };
}

async function writeSkill(pluginDir: string, name: string): Promise<void> {
  await mkdir(join(pluginDir, 'skills', name), { recursive: true });
  await writeFile(
    join(pluginDir, 'skills', name, 'SKILL.md'),
    `---
name: ${name}
description: ${name} description
---
`,
    'utf-8',
  );
}

async function readHooks(workspaceDir: string): Promise<Record<string, unknown[]>> {
  const content = await readFile(join(workspaceDir, '.codex', 'hooks.json'), 'utf-8');
  return (JSON.parse(content) as { hooks: Record<string, unknown[]> }).hooks;
}

function commandFrom(group: unknown): string | undefined {
  const hooks = (group as { hooks?: Array<{ command?: string }> }).hooks;
  return hooks?.[0]?.command;
}

describe('syncCodexProjectHooks', () => {
  let testDir: string;
  let workspaceDir: string;
  let pluginA: string;
  let pluginB: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-codex-hooks-'));
    workspaceDir = join(testDir, 'workspace');
    pluginA = join(testDir, 'plugin-a');
    pluginB = join(testDir, 'plugin-b');
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(join(pluginA, '.codex-plugin', 'hooks'), { recursive: true });
    await mkdir(join(pluginB, 'hooks'), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('merges multiple plugin hooks into existing project hooks without duplicating on update', async () => {
    await mkdir(join(workspaceDir, '.codex'), { recursive: true });
    await writeFile(
      join(workspaceDir, '.codex', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'echo user' }] }],
        },
      }),
      'utf-8',
    );

    await writeFile(
      join(pluginA, '.codex-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'plugin-a',
        hooks: './.codex-plugin/hooks/hooks.json',
      }),
      'utf-8',
    );
    await writeFile(
      join(pluginA, '.codex-plugin', 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: 'command',
                  command: '"${PLUGIN_ROOT}/hooks/run-hook.cmd" session-start',
                },
              ],
            },
          ],
        },
      }),
      'utf-8',
    );
    await writeFile(
      join(pluginB, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo b' }] }],
        },
      }),
      'utf-8',
    );

    const plugins = [
      validatedCodexPlugin(pluginA, './plugin-a'),
      validatedCodexPlugin(pluginB, './plugin-b'),
    ];
    const first = syncCodexProjectHooks(plugins, workspaceDir, undefined);
    expect(first.warnings).toEqual([]);

    let hooks = await readHooks(workspaceDir);
    expect(hooks.SessionStart).toHaveLength(2);
    expect(commandFrom(hooks.SessionStart![0])).toBe('echo user');
    expect(commandFrom(hooks.SessionStart![1])).toContain(`${pluginA}/hooks/run-hook.cmd`);
    expect(hooks.UserPromptSubmit).toHaveLength(1);

    const withoutState = syncCodexProjectHooks(plugins, workspaceDir, undefined);
    expect(withoutState.warnings).toEqual([]);

    hooks = await readHooks(workspaceDir);
    expect(hooks.SessionStart).toHaveLength(2);
    expect(commandFrom(hooks.SessionStart![0])).toBe('echo user');
    expect(commandFrom(hooks.SessionStart![1])).toContain(`${pluginA}/hooks/run-hook.cmd`);
    expect(hooks.UserPromptSubmit).toHaveLength(1);

    const second = syncCodexProjectHooks(plugins, workspaceDir, first.managedHooks);
    expect(second.warnings).toEqual([]);

    hooks = await readHooks(workspaceDir);
    expect(hooks.SessionStart).toHaveLength(2);
    expect(commandFrom(hooks.SessionStart![0])).toBe('echo user');
    expect(commandFrom(hooks.SessionStart![1])).toContain(`${pluginA}/hooks/run-hook.cmd`);
    expect(hooks.UserPromptSubmit).toHaveLength(1);
  });

  it('removes only the previously managed hooks when plugins stop providing hooks', async () => {
    await mkdir(join(workspaceDir, '.codex'), { recursive: true });
    await writeFile(
      join(workspaceDir, '.codex', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: 'command', command: 'echo user' }] },
            { hooks: [{ type: 'command', command: 'echo managed' }] },
          ],
        },
      }),
      'utf-8',
    );
    const previousManaged: NonNullable<SyncState['codexHooks']> = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo managed' }] }],
      },
    };

    syncCodexProjectHooks([], workspaceDir, previousManaged);

    const hooks = await readHooks(workspaceDir);
    expect(hooks.SessionStart).toHaveLength(1);
    expect(commandFrom(hooks.SessionStart![0])).toBe('echo user');
  });

  it('deletes hooks.json when the only hooks were previously managed', async () => {
    await mkdir(join(workspaceDir, '.codex'), { recursive: true });
    await writeFile(
      join(workspaceDir, '.codex', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'echo managed' }] }],
        },
      }),
      'utf-8',
    );
    const previousManaged: NonNullable<SyncState['codexHooks']> = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo managed' }] }],
      },
    };

    syncCodexProjectHooks([], workspaceDir, previousManaged);

    expect(existsSync(join(workspaceDir, '.codex', 'hooks.json'))).toBe(false);
  });

  it('does not overwrite an existing project hooks file with invalid hook arrays', async () => {
    await mkdir(join(workspaceDir, '.codex'), { recursive: true });
    const hooksPath = join(workspaceDir, '.codex', 'hooks.json');
    const originalContent = JSON.stringify({
      hooks: {
        SessionStart: { hooks: [{ type: 'command', command: 'echo invalid' }] },
      },
    });
    await writeFile(hooksPath, originalContent, 'utf-8');
    await writeFile(
      join(pluginB, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo b' }] }],
        },
      }),
      'utf-8',
    );

    const result = syncCodexProjectHooks(
      [validatedCodexPlugin(pluginB, './plugin-b')],
      workspaceDir,
      undefined,
    );

    expect(result.copyResults).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes('not updating'))).toBe(true);
    expect(await readFile(hooksPath, 'utf-8')).toBe(originalContent);
  });

  it('imports conventional hooks when a plugin omits component declarations', async () => {
    await writeFile(join(pluginB, 'hooks', 'hooks.json'), JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo conventional' }] }] },
    }));
    const result = syncCodexProjectHooks([validatedCodexPlugin(pluginB, './plugin-b')], workspaceDir, undefined);
    expect(result.warnings).toEqual([]);
    expect(commandFrom((await readHooks(workspaceDir)).UserPromptSubmit![0])).toBe('echo conventional');
  });

  it('loads a custom legacy declaration instead of conventional hooks', async () => {
    await mkdir(join(pluginB, '.claude-plugin'));
    await mkdir(join(pluginB, 'custom'));
    await writeFile(join(pluginB, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'legacy', hooks: './custom/hooks.json' }));
    await writeFile(join(pluginB, 'custom', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: 'echo custom' }] }] } }));
    await writeFile(join(pluginB, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: 'echo default' }] }] } }));
    const result = syncCodexProjectHooks([validatedCodexPlugin(pluginB, './plugin-b')], workspaceDir, undefined);
    expect(result.warnings).toEqual([]);
    const hooks = await readHooks(workspaceDir);
    expect(hooks.SessionStart).toHaveLength(1);
    expect(commandFrom(hooks.SessionStart![0])).toBe('echo custom');
  });

  it('reconciles direct inline legacy hooks while preserving user entries and filtering unsupported events', async () => {
    await mkdir(join(pluginB, '.claude-plugin'));
    await mkdir(join(workspaceDir, '.codex'));
    await writeFile(join(workspaceDir, '.codex', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: 'echo user' }] }] } }));
    const manifest = join(pluginB, '.claude-plugin', 'plugin.json');
    await writeFile(manifest, JSON.stringify({ name: 'inline', hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'echo first ${PLUGIN_ROOT}' }] }],
      Unsupported: [{ hooks: [{ command: 'echo unsupported' }] }],
    } }));
    const plugin = validatedCodexPlugin(pluginB, './plugin-b');
    const first = syncCodexProjectHooks([plugin], workspaceDir, undefined);
    expect(first.warnings.some((warning) => warning.includes('unsupported event'))).toBe(true);
    expect((await readHooks(workspaceDir)).Unsupported).toBeUndefined();
    expect(commandFrom((await readHooks(workspaceDir)).SessionStart![1])).toBe(`echo first ${pluginB}`);
    await writeFile(manifest, JSON.stringify({ name: 'inline', hooks: { SessionStart: [{ hooks: [{ command: 'echo updated' }] }] } }));
    const updated = syncCodexProjectHooks([plugin], workspaceDir, first.managedHooks);
    expect((await readHooks(workspaceDir)).SessionStart).toHaveLength(2);
    expect(commandFrom((await readHooks(workspaceDir)).SessionStart![1])).toBe('echo updated');
    syncCodexProjectHooks([], workspaceDir, updated.managedHooks);
    const remaining = await readHooks(workspaceDir);
    expect(remaining.SessionStart).toHaveLength(1);
    expect(commandFrom(remaining.SessionStart![0])).toBe('echo user');
  });

  it('keeps Codex-specific inline declarations without also loading shared defaults', async () => {
    await writeFile(join(pluginA, '.codex-plugin', 'plugin.json'), JSON.stringify({ hooks: { hooks: { SessionStart: [{ hooks: [{ command: 'echo codex' }] }] } } }));
    await writeFile(join(pluginA, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: 'echo shared' }] }] } }));
    const result = syncCodexProjectHooks([validatedCodexPlugin(pluginA, './plugin-a')], workspaceDir, undefined);
    expect(result.warnings).toEqual([]);
    const hooks = await readHooks(workspaceDir);
    expect(hooks.SessionStart).toHaveLength(1);
    expect(commandFrom(hooks.SessionStart![0])).toBe('echo codex');
  });

  it.each(['custom/hooks.json', 'hooks/run.sh'])('does not activate excluded custom hook source or known payload %s', async (exclude) => {
    await mkdir(join(pluginB, '.claude-plugin'));
    await mkdir(join(pluginB, 'custom'));
    await writeFile(join(pluginB, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'custom', hooks: './custom/hooks.json' }));
    await writeFile(join(pluginB, 'custom', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: 'bash ${PLUGIN_ROOT}/hooks/run.sh' }] }] } }));
    await writeFile(join(pluginB, 'hooks', 'run.sh'), '#!/bin/sh\n');
    const plugin = validatedCodexPlugin(pluginB, './plugin-b');
    plugin.exclude = [exclude];
    expect(syncCodexProjectHooks([plugin], workspaceDir, undefined).managedHooks).toBeUndefined();
    expect(existsSync(join(workspaceDir, '.codex', 'hooks.json'))).toBe(false);
  });

  it('does not suppress custom hooks for unrelated exclusions in the declaration directory', async () => {
    await mkdir(join(pluginB, '.claude-plugin'));
    await mkdir(join(pluginB, 'custom', 'excluded'), { recursive: true });
    await writeFile(join(pluginB, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'custom', hooks: './custom/hooks.json' }));
    await writeFile(join(pluginB, 'custom', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: 'echo custom' }] }] } }));
    await writeFile(join(pluginB, 'custom', 'excluded', 'SKILL.md'), '# Unrelated excluded skill\n');
    const plugin = validatedCodexPlugin(pluginB, './plugin-b');
    plugin.exclude = ['custom/excluded/**'];
    const result = syncCodexProjectHooks([plugin], workspaceDir, undefined);
    expect(result.managedHooks?.hooks.SessionStart).toHaveLength(1);
    expect(commandFrom((await readHooks(workspaceDir)).SessionStart![0])).toBe('echo custom');
  });

  it('excludes direct inline hooks via the originating manifest', async () => {
    await mkdir(join(pluginB, '.claude-plugin'));
    await writeFile(join(pluginB, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'inline', hooks: { SessionStart: [{ hooks: [{ command: 'echo inline' }] }] } }));
    const plugin = validatedCodexPlugin(pluginB, './plugin-b');
    plugin.exclude = ['.claude-plugin/plugin.json'];
    expect(syncCodexProjectHooks([plugin], workspaceDir, undefined).managedHooks).toBeUndefined();
  });

  it('does not fall back to defaults from an invalid Codex manifest', async () => {
    await writeFile(join(pluginA, '.codex-plugin', 'plugin.json'), '{invalid');
    await writeFile(join(pluginA, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: 'echo fallback' }] }] } }));
    expect(() => syncCodexProjectHooks([validatedCodexPlugin(pluginA, './plugin-a')], workspaceDir, undefined)).toThrow();
  });

  it('rechecks hook config containment after source resolution', async () => {
    const path = join(pluginB, 'hooks', 'hooks.json');
    await writeFile(path, JSON.stringify({ hooks: { SessionStart: [] } }));
    const plugin = validatedCodexPlugin(pluginB, './plugin-b');
    plugin.components = resolvePluginComponents(pluginB);
    const outside = join(testDir, 'outside-hooks.json');
    await writeFile(outside, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: 'echo outside' }] }] } }));
    await rm(path);
    await symlink(outside, path);
    expect(() => syncCodexProjectHooks([plugin], workspaceDir, undefined)).toThrow();
    expect(existsSync(join(workspaceDir, '.codex', 'hooks.json'))).toBe(false);
  });

  it('honors hooks:false even when a Codex-specific manifest declares hooks', async () => {
    await writeFile(join(pluginA, '.codex-plugin', 'plugin.json'), JSON.stringify({ hooks: { hooks: { SessionStart: [{ hooks: [{ command: 'echo disabled' }] }] } } }));
    const plugin = validatedCodexPlugin(pluginA, './plugin-a');
    plugin.hooks = false;
    expect(syncCodexProjectHooks([plugin], workspaceDir, undefined).managedHooks).toBeUndefined();
    expect(existsSync(join(workspaceDir, '.codex', 'hooks.json'))).toBe(false);
  });

  it('does not infer conventional declarations when components explicitly have no hooks', async () => {
    await writeFile(join(pluginB, 'hooks', 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: 'echo default' }] }] } }));
    const plugin = validatedCodexPlugin(pluginB, './plugin-b');
    plugin.components = resolvePluginComponents(pluginB);
    plugin.components.hooks = [];
    expect(syncCodexProjectHooks([plugin], workspaceDir, undefined).managedHooks).toBeUndefined();
    expect(existsSync(join(workspaceDir, '.codex', 'hooks.json'))).toBe(false);
  });
});

describe('syncWorkspace Codex hooks', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-sync-codex-hooks-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('syncs project-scoped Codex skills and multiple hooks while preserving existing hooks', async () => {
    const pluginA = join(testDir, 'plugin-a');
    const pluginB = join(testDir, 'plugin-b');
    await writeSkill(pluginA, 'a');
    await writeSkill(pluginB, 'b');
    await mkdir(join(pluginA, '.codex-plugin', 'hooks'), { recursive: true });
    await mkdir(join(pluginB, 'hooks'), { recursive: true });
    await writeFile(
      join(pluginA, '.codex-plugin', 'plugin.json'),
      JSON.stringify({ name: 'plugin-a', hooks: './.codex-plugin/hooks/hooks.json' }),
      'utf-8',
    );
    await writeFile(
      join(pluginA, '.codex-plugin', 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'echo a' }] }],
        },
      }),
      'utf-8',
    );
    await writeFile(
      join(pluginB, 'hooks', 'hooks.json'),
      JSON.stringify({
        hooks: {
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo b' }] }],
        },
      }),
      'utf-8',
    );
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await mkdir(join(testDir, '.codex'), { recursive: true });
    await writeFile(
      join(testDir, '.codex', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: 'echo user' }] }],
        },
      }),
      'utf-8',
    );
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ./plugin-a
  - ./plugin-b
clients:
  - codex
syncMode: copy
`,
      'utf-8',
    );

    const first = await syncWorkspace(testDir);
    expect(first.success).toBe(true);
    expect(first.totalGenerated).toBe(1);
    expect(existsSync(join(testDir, '.codex', 'skills', 'a'))).toBe(true);
    expect(existsSync(join(testDir, '.codex', 'skills', 'b'))).toBe(true);

    let hooks = await readHooks(testDir);
    expect(hooks.SessionStart).toHaveLength(2);
    expect(hooks.UserPromptSubmit).toHaveLength(1);

    const stateContent = await readFile(join(testDir, CONFIG_DIR, 'sync-state.json'), 'utf-8');
    const state = JSON.parse(stateContent) as SyncState;
    expect(state.codexHooks?.hooks.SessionStart).toHaveLength(1);
    expect(state.codexHooks?.hooks.UserPromptSubmit).toHaveLength(1);

    const second = await syncWorkspace(testDir);
    expect(second.success).toBe(true);
    expect(second.totalGenerated).toBe(1);

    hooks = await readHooks(testDir);
    expect(hooks.SessionStart).toHaveLength(2);
    expect(hooks.UserPromptSubmit).toHaveLength(1);
  });
});
