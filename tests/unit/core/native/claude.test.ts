import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClaudeNativeClient,
  parseClaudeMarketplaceInventory,
  parseClaudePluginId,
  parseClaudePluginInventory,
} from '../../../../src/core/native/claude.js';
import type {
  NativeCommandOptions,
  NativeCommandResult,
  NativeOperationContext,
} from '../../../../src/core/native/types.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<NativeOperationContext> {
  const parent = await mkdtemp(join(tmpdir(), 'allagents-claude-native-'));
  roots.push(parent);
  return {
    client: 'claude',
    scope: 'user',
    nativeScope: 'profile:work',
    root: join(parent, 'config'),
    cwd: join(parent, 'project'),
    env: {
      CLAUDE_CONFIG_DIR: join(parent, 'config'),
      CLAUDE_CODE_PLUGIN_CACHE_DIR: join(parent, 'config', 'plugins'),
      CLAUDE_CODE_PLUGIN_SEED_DIR: undefined,
    },
  };
}

function result(
  output: string,
  success = true,
): NativeCommandResult {
  return { success, output, exitCode: success ? 0 : 1 };
}

describe('native/claude', () => {
  test('parses exact plugin and marketplace inventories', () => {
    expect(parseClaudePluginId('tool@catalog')).toEqual({
      plugin: 'tool',
      marketplace: 'catalog',
    });
    expect(parseClaudePluginId('tool@owner/catalog')).toBeNull();
    expect(
      parseClaudePluginInventory(
        JSON.stringify([
          {
            id: 'tool@catalog',
            scope: 'user',
            enabled: true,
          },
          {
            id: 'disabled@catalog',
            scope: 'user',
            enabled: false,
          },
        ]),
      ),
    ).toEqual({
      installed: [
        { id: 'tool@catalog', scope: 'user', enabled: true },
        { id: 'disabled@catalog', scope: 'user', enabled: false },
      ],
      available: [],
    });
    expect(
      parseClaudePluginInventory(
        JSON.stringify({
          installed: [],
          available: [
            {
              pluginId: 'tool@catalog',
              name: 'tool',
              marketplaceName: 'catalog',
            },
          ],
        }),
      )?.available,
    ).toEqual([{ id: 'tool@catalog', enabled: false }]);
    for (const key of [
      'plugins',
      'installedPlugins',
      'installed_plugins',
    ]) {
      expect(
        parseClaudePluginInventory(
          JSON.stringify({ [key]: [{ name: 'legacy@catalog' }] }),
        ),
      ).toEqual({
        installed: [{ id: 'legacy@catalog', enabled: true }],
        available: [],
      });
    }
    expect(
      parseClaudeMarketplaceInventory(
        JSON.stringify([
          {
            name: 'catalog',
            source: 'github',
            repo: 'owner/repo',
            ref: 'stable',
            installLocation: '/cache/catalog',
          },
        ]),
      ),
    ).toEqual([
      {
        name: 'catalog',
        sourceType: 'github',
        source: 'owner/repo',
        ref: 'stable',
      },
    ]);
    expect(
      parseClaudePluginInventory(
        JSON.stringify([
          {
            id: 'tool@catalog',
            scope: 'project',
            enabled: true,
            projectPath: '/work/a',
          },
        ]),
      ),
    ).toEqual({
      installed: [
        {
          id: 'tool@catalog',
          scope: 'project',
          projectPath: '/work/a',
          enabled: true,
        },
      ],
      available: [],
    });
    expect(parseClaudePluginInventory('{')).toBeNull();
    expect(
      parseClaudePluginInventory(
        JSON.stringify([{ id: 'unexpected@catalog', scope: 'unknown' }]),
      ),
    ).toBeNull();
    expect(parseClaudeMarketplaceInventory('{}')).toBeNull();
  });

  test('preserves legacy marketplace source conversion for ordinary sync', () => {
    const client = new ClaudeNativeClient();
    expect(
      client.toPluginSpec('superpowers@obra/superpowers-marketplace'),
    ).toBe('superpowers@superpowers-marketplace');
    expect(client.toPluginSpec('superpowers@superpowers-marketplace')).toBe(
      'superpowers@superpowers-marketplace',
    );
    expect(
      client.toPluginSpec('vercel-labs/agent-browser/skills/agent-browser'),
    ).toBeNull();
    expect(client.toPluginSpec('plugin@owner/')).toBeNull();
    expect(
      client.resolveSource(
        'superpowers@obra/superpowers-marketplace',
        {
          client: 'claude',
          scope: 'project',
          nativeScope: 'project',
          root: '/project',
        },
        { marketplaceSource: 'obra/superpowers-marketplace' },
      ).resource?.provenance,
    ).toEqual({
      marketplaceName: 'superpowers-marketplace',
      marketplaceSource: 'obra/superpowers-marketplace',
    });
    expect(
      client.extractMarketplaceSource(
        'superpowers@obra/superpowers-marketplace',
      ),
    ).toBe('obra/superpowers-marketplace');
    expect(
      client.extractMarketplaceSource('superpowers@superpowers-marketplace'),
    ).toBeNull();
    expect(client.supportsScope('user')).toBe(true);
    expect(client.supportsScope('project')).toBe(true);
  });

  test('checks the supported version in a disposable config root', async () => {
    const calls: Array<{
      args: string[];
      options?: NativeCommandOptions;
    }> = [];
    const client = new ClaudeNativeClient({
      minimumVersion: [2, 1, 268],
      execute: async (_binary, args, options) => {
        calls.push({ args, options });
        return args[0] === '--version'
          ? result('2.1.270 (Claude Code)')
          : result('install list marketplace uninstall update');
      },
    });
    expect(await client.isAvailable()).toBe(true);
    expect(calls).toHaveLength(2);
    const root = calls[0]?.options?.env?.CLAUDE_CONFIG_DIR;
    expect(root).toStartWith(join(tmpdir(), 'allagents-claude-inspection-'));
    expect(calls[0]?.options?.env?.CLAUDE_CODE_PLUGIN_CACHE_DIR).toBe(
      join(root as string, 'plugins'),
    );
    expect(calls[0]?.options?.env?.CLAUDE_CODE_PLUGIN_SEED_DIR).toBeUndefined();

    const old = new ClaudeNativeClient({
      minimumVersion: [2, 1, 268],
      execute: async () => result('2.1.267 (Claude Code)'),
    });
    expect(await old.isAvailable()).toBe(false);
  });

  test('does not invoke Claude when an inspected profile root is absent', async () => {
    const context = await fixture();
    let calls = 0;
    const client = new ClaudeNativeClient({
      execute: async () => {
        calls++;
        return result('[]');
      },
    });
    expect(await client.inspect(context)).toEqual({
      success: true,
      resources: [],
    });
    expect(calls).toBe(0);
  });

  test('reports selected user plugins and disabled observations', async () => {
    const context = await fixture();
    await mkdir(context.root, { recursive: true });
    const client = new ClaudeNativeClient({
      execute: async () =>
        result(
          JSON.stringify([
            { id: 'active@catalog', scope: 'user', enabled: true },
            { id: 'disabled@catalog', scope: 'user', enabled: false },
            { id: 'project@catalog', scope: 'project', enabled: true },
            { id: 'canva@synced', scope: 'synced', enabled: true },
          ]),
        ),
    });
    const inspection = await client.inspect(context);
    expect(
      inspection.resources.map((resource) => resource.resolvedIdentity),
    ).toEqual(['active@catalog']);
    expect(inspection.observations).toEqual([
      expect.objectContaining({
        status: 'disabled',
        resource: expect.objectContaining({
          resolvedIdentity: 'disabled@catalog',
        }),
      }),
    ]);
  });

  test('ignores project scope installs from other projects', async () => {
    const context = await fixture();
    const projectContext: NativeOperationContext = {
      ...context,
      scope: 'project',
      nativeScope: 'project',
    };
    await mkdir(projectContext.root, { recursive: true });
    const otherProject = join(tmpdir(), 'allagents-other-project');
    const client = new ClaudeNativeClient({
      execute: async () =>
        result(
          JSON.stringify([
            {
              id: 'installed@catalog',
              scope: 'project',
              enabled: true,
              projectPath: projectContext.root,
            },
            {
              id: 'blocked@catalog',
              scope: 'project',
              enabled: false,
              projectPath: otherProject,
            },
            {
              id: 'skipped@catalog',
              scope: 'project',
              enabled: true,
              projectPath: otherProject,
            },
            { id: 'skipped@catalog', scope: 'user', enabled: true },
          ]),
        ),
    });
    const inspection = await client.inspect(projectContext);
    expect(
      inspection.resources.map((resource) => resource.resolvedIdentity),
    ).toEqual(['installed@catalog']);
    expect(inspection.observations ?? []).toEqual([]);
  });

  test('registers, installs, updates, and removes in isolated user scope', async () => {
    const context = await fixture();
    await mkdir(context.root, { recursive: true });
    const calls: string[][] = [];
    let marketplacePresent = false;
    const client = new ClaudeNativeClient({
      execute: async (_binary, args) => {
        calls.push(args);
        if (args.join(' ') === 'plugin marketplace list --json') {
          return result(
            JSON.stringify(
              marketplacePresent
                ? [
                    {
                      name: 'catalog',
                      source: 'directory',
                      path: '/market',
                      installLocation: '/market',
                    },
                  ]
                : [],
            ),
          );
        }
        if (args[2] === 'add') {
          marketplacePresent = true;
          return result('Successfully added');
        }
        if (args[1] === 'install') {
          return result(
            JSON.stringify({
              command: 'install',
              outcome: 'ok',
              pluginId: 'tool@catalog',
              scope: 'user',
            }),
          );
        }
        if (args[1] === 'update' && args[0] === 'plugin') {
          return result(
            `notice\n${JSON.stringify({
              command: 'update',
              outcome: 'ok',
              pluginId: 'tool@catalog',
              scope: 'user',
            })}`,
          );
        }
        if (args[1] === 'uninstall') {
          return result(
            JSON.stringify({
              command: 'uninstall',
              outcome: 'ok',
              pluginId: 'tool@catalog',
              scope: 'user',
            }),
          );
        }
        return result('updated marketplace');
      },
    });
    const resource = client.resolveSource(
      'tool@catalog',
      context,
      {
        marketplaceName: 'catalog',
        marketplaceSource: '/market',
        managedMarketplaceRegistration: 'true',
      },
    ).resource;
    expect(resource).toBeDefined();

    expect(await client.install(resource!, context)).toEqual({
      success: true,
      registrations: ['catalog'],
    });
    expect(calls).toContainEqual([
      'plugin',
      'marketplace',
      'add',
      '/market',
      '--scope',
      'user',
    ]);
    expect(calls).toContainEqual([
      'plugin',
      'install',
      'tool@catalog',
      '--scope',
      'user',
      '--yes',
      '--json',
    ]);

    expect(await client.update(resource!, resource!, context)).toEqual({
      success: true,
    });
    expect(calls).toContainEqual([
      'plugin',
      'marketplace',
      'update',
      'catalog',
    ]);
    expect(await client.remove(resource!, context)).toEqual({ success: true });
    expect(calls).toContainEqual([
      'plugin',
      'uninstall',
      'tool@catalog',
      '--scope',
      'user',
      '--yes',
      '--json',
    ]);
  });

  test('reports a newly added marketplace when verification fails', async () => {
    const context = await fixture();
    await mkdir(context.root, { recursive: true });
    let inspections = 0;
    const client = new ClaudeNativeClient({
      execute: async (_binary, args) => {
        if (args.join(' ') === 'plugin marketplace list --json') {
          inspections++;
          return inspections === 1
            ? result('[]')
            : result('', false);
        }
        return result('Successfully added');
      },
    });
    const resource = client.resolveSource('tool@catalog', context, {
      marketplaceSource: '/market',
      managedMarketplaceRegistration: 'true',
    }).resource;

    expect(await client.install(resource!, context)).toEqual({
      success: false,
      error: 'Claude CLI exited with code 1',
      registrations: ['catalog'],
    });
  });

  test('preserves ordinary project scope outside profiles', async () => {
    const context = await fixture();
    const projectContext = { ...context, nativeScope: 'project' };
    await mkdir(projectContext.root, { recursive: true });
    const calls: string[][] = [];
    const client = new ClaudeNativeClient({
      execute: async (_binary, args) => {
        calls.push(args);
        return result('ok');
      },
    });
    const resource = client.resolveSource('tool@catalog', projectContext, {
      marketplaceSource: '/market',
    }).resource;

    expect(await client.install(resource!, projectContext)).toEqual({
      success: true,
      registrations: ['/market'],
    });
    expect(await client.update(resource!, resource!, projectContext)).toEqual({
      success: true,
    });
    expect(await client.remove(resource!, projectContext)).toEqual({
      success: true,
    });
    expect(calls).toContainEqual([
      'plugin',
      'marketplace',
      'add',
      '/market',
    ]);
    expect(calls).toContainEqual([
      'plugin',
      'install',
      'tool@catalog',
      '--scope',
      'project',
    ]);
    expect(calls).toContainEqual([
      'plugin',
      'update',
      'tool@catalog',
      '--scope',
      'project',
    ]);
    expect(calls).toContainEqual([
      'plugin',
      'uninstall',
      'tool@catalog',
      '--scope',
      'project',
    ]);
  });

  test('preserves declarative profile settings across Claude mutations', async () => {
    const context = await fixture();
    await mkdir(context.root, { recursive: true });
    const settingsPath = join(context.root, 'settings.json');
    const declarativeSettings =
      '{\n  "enabledPlugins": {\n    "tool@catalog": true\n  }\n}\n';
    await writeFile(settingsPath, declarativeSettings, { mode: 0o600 });
    const client = new ClaudeNativeClient({
      execute: async (_binary, args) => {
        if (args.join(' ') === 'plugin marketplace list --json') {
          return result(
            JSON.stringify([
              {
                name: 'catalog',
                source: 'directory',
                path: '/market',
                installLocation: '/market',
              },
            ]),
          );
        }
        if (args[1] === 'install') {
          await writeFile(
            settingsPath,
            '{"enabledPlugins":{"tool@catalog":true}}\n',
          );
          return result(
            JSON.stringify({
              command: 'install',
              outcome: 'ok',
              pluginId: 'tool@catalog',
              scope: 'user',
            }),
          );
        }
        return result('');
      },
    });
    const resource = client.resolveSource('tool@catalog', context, {
      marketplaceName: 'catalog',
      marketplaceSource: '/market',
    }).resource;

    expect(await client.install(resource!, context)).toEqual({ success: true });
    expect(await readFile(settingsPath, 'utf8')).toBe(declarativeSettings);
  });

  test('refuses to remove a marketplace with another installed plugin', async () => {
    const context = await fixture();
    await mkdir(context.root, { recursive: true });
    const client = new ClaudeNativeClient({
      execute: async (_binary, args) => {
        if (args[1] === 'marketplace') {
          return result(
            JSON.stringify([
              {
                name: 'catalog',
                source: 'directory',
                path: '/market',
                installLocation: '/market',
              },
            ]),
          );
        }
        return result(
          JSON.stringify([
            { id: 'other@catalog', scope: 'user', enabled: false },
          ]),
        );
      },
    });
    expect(
      await client.removeMarketplaceRegistration('catalog', context),
    ).toEqual({
      success: false,
      error: "Claude marketplace 'catalog' is still used by installed plugins",
    });
  });
});
