import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';
import { syncWorkspace } from '../../../src/core/sync.js';
import type { ValidatedPlugin } from '../../../src/core/sync.js';
import { syncCopilotProjectHooks } from '../../../src/core/copilot-hooks.js';
import { resolvePluginComponents } from '../../../src/core/plugin-components.js';

describe('syncWorkspace Copilot hooks', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-sync-copilot-hooks-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writeWorkspace(plugins: string[]): Promise<void> {
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
${plugins.length > 0 ? `plugins:\n${plugins.map((plugin) => `  - ./${plugin}`).join('\n')}` : 'plugins: []'}
clients:
  - copilot
syncMode: copy
`,
    );
  }

  async function writePlugin(
    name: string,
    event: string,
    options: { nestedDeclaration?: boolean } = {},
  ): Promise<string> {
    const pluginDir = join(testDir, name);
    await mkdir(join(pluginDir, 'hooks'), { recursive: true });
    await writeFile(join(pluginDir, 'hooks', `${name}.sh`), '#!/bin/sh\n');
    const declarationPath = options.nestedDeclaration
      ? join(pluginDir, 'hooks', 'hooks.json')
      : join(pluginDir, 'hooks.json');
    await writeFile(
      declarationPath,
      JSON.stringify({
        version: 1,
        hooks: {
          [event]: [
            {
              type: 'command',
              bash: `bash "\${COPILOT_PLUGIN_ROOT}/hooks/${name}.sh"`,
            },
          ],
        },
      }),
    );
    return pluginDir;
  }

  it('accepts native hook files without an input version and emits project hook schema', async () => {
    const pluginDir = join(testDir, 'org');
    await mkdir(join(pluginDir, 'hooks'), { recursive: true });
    await writeFile(join(pluginDir, 'hooks', 'session-start.sh'), '#!/bin/sh\n');
    await writeFile(
      join(pluginDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              type: 'command',
              bash: 'bash "${COPILOT_PLUGIN_ROOT}/hooks/session-start.sh"',
            },
          ],
        },
      }),
    );
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - ./org
clients:
  - copilot
syncMode: copy
`,
    );

    const result = await syncWorkspace(testDir);

    expect(result.success).toBe(true);
    const hooks = JSON.parse(
      await readFile(join(testDir, '.github', 'hooks', 'allagents.json'), 'utf-8'),
    ) as {
      version: number;
      hooks: Record<string, Array<{ env?: Record<string, string> }>>;
    };
    expect(hooks.version).toBe(1);
    expect(hooks.hooks.SessionStart?.[0]?.env?.COPILOT_PLUGIN_ROOT).toBe(pluginDir);
  });

  it('syncs a direct manifest-less plugin that has no hook declaration', async () => {
    await mkdir(join(testDir, 'direct-plugin', 'skills', 'direct-skill'), {
      recursive: true,
    });
    await writeFile(
      join(testDir, 'direct-plugin', 'skills', 'direct-skill', 'SKILL.md'),
      '---\nname: direct-skill\ndescription: Direct plugin skill\n---\n# Direct skill\n',
    );
    await writeWorkspace(['direct-plugin']);

    const result = await syncWorkspace(testDir);

    expect(result.success).toBe(true);
    expect(
      existsSync(join(testDir, '.github', 'skills', 'direct-skill', 'SKILL.md')),
    ).toBe(true);
    expect(existsSync(join(testDir, '.github', 'hooks', 'allagents.json'))).toBe(
      false,
    );
    expect(
      (result.warnings ?? []).some((warning) => warning.startsWith('Copilot hooks:')),
    ).toBe(false);
  });

  it('merges multiple plugins and reconciles only the AllAgents-owned hook file', async () => {
    const pluginA = await writePlugin('plugin-a', 'SessionStart');
    const pluginB = await writePlugin('plugin-b', 'PostToolUse');
    await writeWorkspace(['plugin-a', 'plugin-b']);
    await mkdir(join(testDir, '.github', 'hooks'), { recursive: true });
    await writeFile(
      join(testDir, '.github', 'hooks', 'user.json'),
      '{"version":1,"hooks":{}}',
    );

    const first = await syncWorkspace(testDir);

    expect(first.success).toBe(true);
    let hooks = JSON.parse(
      await readFile(join(testDir, '.github', 'hooks', 'allagents.json'), 'utf-8'),
    ) as {
      hooks: Record<string, Array<{ env: Record<string, string> }>>;
    };
    expect(hooks.hooks.SessionStart?.[0]?.env.COPILOT_PLUGIN_ROOT).toBe(pluginA);
    expect(hooks.hooks.PostToolUse?.[0]?.env.COPILOT_PLUGIN_ROOT).toBe(pluginB);
    expect(existsSync(join(testDir, '.github', 'hooks', 'user.json'))).toBe(true);

    await writeWorkspace(['plugin-b']);
    const second = await syncWorkspace(testDir);

    expect(second.success).toBe(true);
    hooks = JSON.parse(
      await readFile(join(testDir, '.github', 'hooks', 'allagents.json'), 'utf-8'),
    ) as typeof hooks;
    expect(hooks.hooks.SessionStart).toBeUndefined();
    expect(hooks.hooks.PostToolUse).toHaveLength(1);
    expect(existsSync(join(testDir, '.github', 'hooks', 'user.json'))).toBe(true);

    await writeWorkspace([]);
    const third = await syncWorkspace(testDir);

    expect(third.success).toBe(true);
    expect(existsSync(join(testDir, '.github', 'hooks', 'allagents.json'))).toBe(
      false,
    );
    expect(existsSync(join(testDir, '.github', 'hooks', 'user.json'))).toBe(true);
  });

  it('retains installed hooks and skills when a selected hook event map is invalid', async () => {
    const invalidPlugin = await writePlugin('invalid-plugin', 'SessionStart');
    await writePlugin('valid-plugin', 'PostToolUse');
    await mkdir(join(invalidPlugin, 'skills', 'invalid-plugin-skill'), {
      recursive: true,
    });
    await writeFile(
      join(invalidPlugin, 'skills', 'invalid-plugin-skill', 'SKILL.md'),
      '---\nname: invalid-plugin-skill\ndescription: Still syncs\n---\n# Skill\n',
    );
    await writeWorkspace(['invalid-plugin', 'valid-plugin']);
    expect((await syncWorkspace(testDir)).success).toBe(true);
    const hooksPath = join(testDir, '.github', 'hooks', 'allagents.json');
    const statePath = join(testDir, CONFIG_DIR, 'sync-state.json');
    const previousHooks = await readFile(hooksPath, 'utf-8');
    const previousState = await readFile(statePath, 'utf-8');
    await writeFile(
      join(invalidPlugin, 'hooks.json'),
      JSON.stringify({
        version: 1,
        hooks: {
          SessionStart: [
            {
              type: 'command',
              bash: 'bash "${COPILOT_PLUGIN_ROOT}/hooks/invalid-plugin.sh"',
            },
          ],
          UserPromptSubmit: { type: 'command', bash: 'echo invalid' },
        },
      }),
    );

    const result = await syncWorkspace(testDir);

    expect(result.success).toBe(false);
    expect(await readFile(hooksPath, 'utf-8')).toBe(previousHooks);
    expect(await readFile(statePath, 'utf-8')).toBe(previousState);
    expect(
      existsSync(
        join(testDir, '.github', 'skills', 'invalid-plugin-skill', 'SKILL.md'),
      ),
    ).toBe(true);
  });

  it('does not overwrite an existing unowned allagents hook file', async () => {
    await writePlugin('plugin-a', 'SessionStart');
    await writeWorkspace(['plugin-a']);
    await mkdir(join(testDir, '.github', 'hooks'), { recursive: true });
    const original = '{"version":1,"hooks":{"SessionStart":[]}}';
    await writeFile(join(testDir, '.github', 'hooks', 'allagents.json'), original);

    const result = await syncWorkspace(testDir);

    expect(result.success).toBe(true);
    expect(result.warnings).toContain(
      'Copilot hooks: not updating .github/hooks/allagents.json because the existing file is not owned by AllAgents',
    );
    expect(
      await readFile(join(testDir, '.github', 'hooks', 'allagents.json'), 'utf-8'),
    ).toBe(original);
  });

  it('materializes hooks/hooks.json once instead of copying an unresolved duplicate', async () => {
    await writePlugin('plugin-a', 'SessionStart', { nestedDeclaration: true });
    await writeWorkspace(['plugin-a']);

    const result = await syncWorkspace(testDir);

    expect(result.success).toBe(true);
    expect(existsSync(join(testDir, '.github', 'hooks', 'allagents.json'))).toBe(
      true,
    );
    expect(existsSync(join(testDir, '.github', 'hooks', 'hooks.json'))).toBe(
      false,
    );
  });

  it('does not activate a root declaration when its hook payload is excluded', async () => {
    await writePlugin('plugin-a', 'SessionStart');
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - source: ./plugin-a
    exclude:
      - hooks/plugin-a.sh
clients:
  - copilot
syncMode: copy
`,
    );

    const result = await syncWorkspace(testDir);

    expect(result.success).toBe(true);
    expect(existsSync(join(testDir, '.github', 'hooks', 'allagents.json'))).toBe(
      false,
    );
    expect(existsSync(join(testDir, '.github', 'hooks', 'plugin-a.sh'))).toBe(
      false,
    );
  });

  it('does not activate an excluded nested declaration', async () => {
    await writePlugin('plugin-a', 'SessionStart', { nestedDeclaration: true });
    await mkdir(join(testDir, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(testDir, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      `
repositories: []
plugins:
  - source: ./plugin-a
    exclude:
      - hooks/hooks.json
clients:
  - copilot
syncMode: copy
`,
    );

    const result = await syncWorkspace(testDir);

    expect(result.success).toBe(true);
    expect(existsSync(join(testDir, '.github', 'hooks', 'allagents.json'))).toBe(
      false,
    );
  });

  it('materializes a custom declaration instead of conventional hooks without copying a duplicate', async () => {
    const pluginDir = await writePlugin('plugin-a', 'sessionStart');
    await mkdir(join(pluginDir, '.claude-plugin'));
    await mkdir(join(pluginDir, 'custom'));
    await writeFile(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'custom', hooks: './custom/hooks.json' }));
    await writeFile(join(pluginDir, 'custom', 'hooks.json'), JSON.stringify({ version: 1, hooks: { preToolUse: [{ type: 'command', bash: 'echo custom' }] } }));
    await writeWorkspace(['plugin-a']);
    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(true);
    const generated = JSON.parse(await readFile(join(testDir, '.github', 'hooks', 'allagents.json'), 'utf-8'));
    expect(Object.keys(generated.hooks)).toEqual(['preToolUse']);
    expect(generated.hooks.preToolUse).toHaveLength(1);
    expect(generated.hooks.preToolUse[0].env.COPILOT_PLUGIN_ROOT).toBe(pluginDir);
    expect(existsSync(join(testDir, '.github', 'hooks', 'hooks.json'))).toBe(false);
  });

  it('materializes direct inline native event maps and excludes their manifest origin', async () => {
    const pluginDir = await writePlugin('plugin-a', 'defaultEvent');
    await mkdir(join(pluginDir, '.claude-plugin'));
    await writeFile(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'inline', hooks: { sessionStart: [{ type: 'command', bash: 'echo inline' }] } }));
    const plugin: ValidatedPlugin = { plugin: './plugin-a', resolved: pluginDir, success: true, clients: ['copilot'], nativeClients: [] };
    const first = await syncCopilotProjectHooks([plugin], testDir);
    expect(first.warnings).toEqual([]);
    const generated = JSON.parse(await readFile(join(testDir, '.github', 'hooks', 'allagents.json'), 'utf-8'));
    expect(Object.keys(generated.hooks)).toEqual(['sessionStart']);
    expect(generated.hooks.sessionStart[0].bash).toBe('echo inline');
    expect(generated.hooks.sessionStart[0].env.COPILOT_PLUGIN_ROOT).toBe(pluginDir);
    plugin.exclude = ['.claude-plugin/plugin.json'];
    expect((await syncCopilotProjectHooks([plugin], testDir, { previouslyManaged: true })).copyResults).toEqual([]);
  });

  it.each(['custom/hooks.json', 'hooks/run.sh'])('does not activate excluded custom declaration or known hook payload %s', async (exclude) => {
    const pluginDir = await writePlugin('plugin-a', 'defaultEvent');
    await mkdir(join(pluginDir, '.claude-plugin'));
    await mkdir(join(pluginDir, 'custom'));
    await writeFile(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'custom', hooks: './custom/hooks.json' }));
    await writeFile(join(pluginDir, 'custom', 'hooks.json'), JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: 'command', bash: 'bash ${COPILOT_PLUGIN_ROOT}/hooks/run.sh' }] } }));
    await writeFile(join(pluginDir, 'hooks', 'run.sh'), '#!/bin/sh\n');
    const plugin: ValidatedPlugin = { plugin: './plugin-a', resolved: pluginDir, success: true, clients: ['copilot'], nativeClients: [], exclude: [exclude] };
    expect((await syncCopilotProjectHooks([plugin], testDir)).copyResults).toEqual([]);
    expect(existsSync(join(testDir, '.github', 'hooks', 'allagents.json'))).toBe(false);
  });

  it('does not suppress custom hooks for unrelated exclusions in the declaration directory', async () => {
    const pluginDir = await writePlugin('plugin-a', 'defaultEvent');
    await mkdir(join(pluginDir, '.claude-plugin'));
    await mkdir(join(pluginDir, 'custom', 'excluded'), { recursive: true });
    await writeFile(join(pluginDir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'custom', hooks: './custom/hooks.json' }));
    await writeFile(join(pluginDir, 'custom', 'hooks.json'), JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: 'command', bash: 'echo custom' }] } }));
    await writeFile(join(pluginDir, 'custom', 'excluded', 'SKILL.md'), '# Unrelated excluded skill\n');
    const plugin: ValidatedPlugin = { plugin: './plugin-a', resolved: pluginDir, success: true, clients: ['copilot'], nativeClients: [], exclude: ['custom/excluded/**'] };
    expect((await syncCopilotProjectHooks([plugin], testDir)).copyResults).toHaveLength(1);
    const generated = JSON.parse(await readFile(join(testDir, '.github', 'hooks', 'allagents.json'), 'utf-8'));
    expect(generated.hooks.sessionStart[0].bash).toBe('echo custom');
  });

  it('does not infer hooks when resolved components explicitly have no declarations', async () => {
    const pluginDir = await writePlugin('plugin-a', 'sessionStart');
    const components = resolvePluginComponents(pluginDir);
    components.hooks = [];
    const plugin: ValidatedPlugin = { plugin: './plugin-a', resolved: pluginDir, success: true, clients: ['copilot'], nativeClients: [], components };
    expect((await syncCopilotProjectHooks([plugin], testDir)).copyResults).toEqual([]);
  });

  it('rechecks hook source containment before reading a changed symlink', async () => {
    const pluginDir = await writePlugin('plugin-a', 'sessionStart');
    const components = resolvePluginComponents(pluginDir);
    const outside = join(testDir, 'outside-hooks.json');
    await writeFile(outside, JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: 'command', bash: 'echo outside' }] } }));
    await rm(join(pluginDir, 'hooks.json'));
    await symlink(outside, join(pluginDir, 'hooks.json'));
    const plugin: ValidatedPlugin = { plugin: './plugin-a', resolved: pluginDir, success: true, clients: ['copilot'], nativeClients: [], components };
    await expect(syncCopilotProjectHooks([plugin], testDir)).rejects.toThrow();
    expect(existsSync(join(testDir, '.github', 'hooks', 'allagents.json'))).toBe(false);
  });

  it('honors hooks:false for direct consumers without disabling other plugin components', async () => {
    const pluginDir = await writePlugin('plugin-a', 'sessionStart');
    const plugin: ValidatedPlugin = { plugin: './plugin-a', resolved: pluginDir, success: true, clients: ['copilot'], nativeClients: [], hooks: false };
    expect((await syncCopilotProjectHooks([plugin], testDir)).copyResults).toEqual([]);
    expect(existsSync(join(testDir, '.github', 'hooks', 'allagents.json'))).toBe(false);
  });
});
