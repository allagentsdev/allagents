import {
  describe,
  expect,
  test,
  beforeEach,
  afterEach,
  spyOn,
} from 'bun:test';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dump, load } from 'js-yaml';
import type { WorkspaceConfig } from '../../../src/models/workspace-config.js';
import {
  addUserPlugin,
  addUserPluginForTarget,
  removeUserPlugin,
  getUserWorkspaceConfig,
  ensureUserWorkspace,
  getUserWorkspaceConfigPath,
  getInstalledUserPlugins,
  getInstalledProjectPlugins,
  setUserClients,
} from '../../../src/core/user-workspace.js';
import * as git from '../../../src/core/git.js';
import { stubHomeDir } from '../../helpers/env.js';

describe('user-workspace', () => {
  let tempHome: string;
  let restoreHomeDir: () => void;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'allagents-test-'));
    restoreHomeDir = stubHomeDir(tempHome);
  });

  afterEach(async () => {
    restoreHomeDir();
    await rm(tempHome, { recursive: true, force: true });
  });

  describe('getUserWorkspaceConfigPath', () => {
    test('returns path under ~/.allagents', () => {
      const configPath = getUserWorkspaceConfigPath();
      expect(configPath).toContain('.allagents');
      expect(configPath).toEndWith('workspace.yaml');
    });
  });

  describe('ensureUserWorkspace', () => {
    test('creates ~/.allagents/workspace.yaml if missing', async () => {
      await ensureUserWorkspace();
      const config = await getUserWorkspaceConfig();
      expect(config).toBeTruthy();
      expect(config!.plugins).toEqual([]);
      // User-scope should NOT include claude (only project-scope does)
      expect(config!.clients).not.toContain('claude');
      expect(config!.clients).toContain('copilot');
    });

    test('does not overwrite existing config', async () => {
      await ensureUserWorkspace();
      // Create a real temp plugin directory so path validation passes
      const pluginDir = join(tempHome, 'fake-plugin-dir');
      await mkdir(pluginDir, { recursive: true });

      // Use a local path plugin (no @, so won't trigger marketplace resolution)
      await addUserPlugin(pluginDir);
      await ensureUserWorkspace(); // call again
      const config = await getUserWorkspaceConfig();
      expect(config!.plugins).toContain(pluginDir);
    });

    test('creates default config with user-scope clients (excludes claude)', async () => {
      await ensureUserWorkspace();
      const config = await getUserWorkspaceConfig();
      // User-scope excludes claude (only project-scope includes it)
      expect(config!.clients).not.toContain('claude');
      expect(config!.clients).toContain('copilot');
      expect(config!.clients).toContain('codex');
      expect(config!.clients).toContain('cursor');
      expect(config!.clients).toContain('opencode');
      expect(config!.clients).toContain('gemini');
      expect(config!.clients).not.toContain('factory');
      expect(config!.clients).not.toContain('ampcode');
      expect(config!.clients).toContain('vscode');
    });
  });

  describe('getUserWorkspaceConfig', () => {
    test('returns null when config does not exist', async () => {
      const config = await getUserWorkspaceConfig();
      expect(config).toBeNull();
    });

    test('reads existing config', async () => {
      await ensureUserWorkspace();
      const config = await getUserWorkspaceConfig();
      expect(config).toBeTruthy();
      expect(config!.plugins).toBeInstanceOf(Array);
      expect(config!.clients).toBeInstanceOf(Array);
    });

    test('returns canonical deduplicated clients from alias declarations', async () => {
      const configPath = getUserWorkspaceConfigPath();
      await mkdir(join(tempHome, '.allagents'), { recursive: true });
      await writeFile(
        configPath,
        'clients:\n  - claude-code\n  - claude\n  - droid\n',
        'utf-8',
      );

      const config = await getUserWorkspaceConfig();

      expect(config?.clients).toEqual(['claude', 'factory']);
    });

    test('canonicalizes aliases in install shorthands and object entries', async () => {
      const configPath = getUserWorkspaceConfigPath();
      await mkdir(join(tempHome, '.allagents'), { recursive: true });
      await writeFile(
        configPath,
        'clients:\n  - claude-code:native\n  - name: droid\n',
        'utf-8',
      );

      const config = await getUserWorkspaceConfig();

      expect(config?.clients).toEqual([
        { name: 'claude', install: 'native' },
        { name: 'factory', install: 'file' },
      ]);
    });

    test('accepts profiles-only config and defaults ordinary arrays', async () => {
      const configPath = getUserWorkspaceConfigPath();
      await mkdir(join(tempHome, '.allagents'), { recursive: true });
      await writeFile(
        configPath,
        'profiles:\n  research:\n    clients:\n      - name: pi\n',
        'utf-8',
      );

      const config = await getUserWorkspaceConfig();
      expect(config?.repositories).toEqual([]);
      expect(config?.plugins).toEqual([]);
      expect(config?.clients).toEqual([]);
      expect(config?.profiles?.research?.clients[0]?.settings).toEqual({});

      const editResult = await setUserClients(['omp']);
      expect(editResult.success).toBe(true);
      const edited = await readFile(configPath, 'utf-8');
      expect(edited).toContain('profiles:');
      expect(edited).not.toContain('settings:');
      expect(edited).not.toContain('install:');
    });

    test('propagates invalid user config and refuses an unrelated edit', async () => {
      const configPath = getUserWorkspaceConfigPath();
      await mkdir(join(tempHome, '.allagents'), { recursive: true });
      const invalid =
        'repositories: []\nplugins: []\nclients: []\nprofiles:\n  bad:\n    clients:\n      - name: pi\n        settings:\n          root: /tmp/pi\n';
      await writeFile(configPath, invalid, 'utf-8');

      await expect(getUserWorkspaceConfig()).rejects.toThrow(
        'profiles.bad.clients.0.settings',
      );
      const result = await setUserClients(['omp']);
      expect(result.success).toBe(false);
      expect(await readFile(configPath, 'utf-8')).toBe(invalid);
    });
  });

  describe('addUserPlugin', () => {
    test('adds local path plugin to user workspace.yaml', async () => {
      // Create a real temp plugin directory so path validation passes
      const pluginDir = join(tempHome, 'my-plugin');
      await mkdir(pluginDir, { recursive: true });

      const result = await addUserPlugin(pluginDir);
      expect(result.success).toBe(true);
      const config = await getUserWorkspaceConfig();
      expect(config!.plugins).toContain(pluginDir);
    });

    test('rejects duplicate plugin', async () => {
      const pluginDir = join(tempHome, 'my-plugin');
      await mkdir(pluginDir, { recursive: true });

      await addUserPlugin(pluginDir);
      const result = await addUserPlugin(pluginDir);
      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });

    test('creates config if it does not exist yet', async () => {
      const pluginDir = join(tempHome, 'my-plugin');
      await mkdir(pluginDir, { recursive: true });

      // Config doesn't exist yet
      expect(await getUserWorkspaceConfig()).toBeNull();

      const result = await addUserPlugin(pluginDir);
      expect(result.success).toBe(true);

      // Config was auto-created
      const config = await getUserWorkspaceConfig();
      expect(config).toBeTruthy();
      expect(config!.plugins).toContain(pluginDir);
    });

    test('rejects non-existent local path', async () => {
      const nonExistentPath = join(tempHome, 'nonexistent-plugin');
      const result = await addUserPlugin(nonExistentPath);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Plugin not found at');
      expect(result.error).toContain(nonExistentPath);
    });

    test('rejects a bare path separator as a local plugin source', async () => {
      const { sep } = await import('node:path');
      const result = await addUserPlugin(sep);
      expect(result.success).toBe(false);
      expect(result.error).toContain('filesystem root');

      const config = await getUserWorkspaceConfig();
      expect(config?.plugins ?? []).toEqual([]);
    });
  });

  describe('addUserPluginForTarget', () => {
    test('initializes a first config with selected clients and inherited string declaration', async () => {
      const pluginDir = join(tempHome, 'target-plugin');
      await mkdir(pluginDir, { recursive: true });

      const result = await addUserPluginForTarget({
        declaration: pluginDir,
        clients: ['codex', 'cursor'],
      });

      expect(result.success).toBe(true);
      const config = await getUserWorkspaceConfig();
      expect(config?.clients).toEqual(['codex', 'cursor']);
      expect(config?.plugins).toEqual([pluginDir]);
    });

    test('does not publish a first config when atomic staging fails', async () => {
      const pluginDir = join(tempHome, 'target-plugin');
      await mkdir(pluginDir, { recursive: true });
      const configPath = getUserWorkspaceConfigPath();

      const result = await addUserPluginForTarget(
        { declaration: pluginDir, clients: ['codex', 'cursor'] },
        {
          beforeRename() {
            throw new Error('injected first user write failure');
          },
        },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('injected first user write failure');
      expect(existsSync(configPath)).toBe(false);
      expect(await readdir(join(tempHome, '.allagents'))).toEqual([]);
    });

    test('persists a native-only declaration without treating its source as a local path', async () => {
      const result = await addUserPluginForTarget({
        declaration: { source: 'npm:pi-extension', install: 'native' },
        clients: ['pi'],
        sourceValidation: 'declaration',
      });

      expect(result.success).toBe(true);
      const config = await getUserWorkspaceConfig();
      expect(config?.clients).toEqual(['pi']);
      expect(config?.plugins).toEqual([
        { source: 'npm:pi-extension', install: 'native' },
      ]);
    });

    test('stores an override without changing top-level clients or unrelated declarations', async () => {
      const pluginDir = join(tempHome, 'target-plugin');
      await mkdir(pluginDir, { recursive: true });
      const configPath = getUserWorkspaceConfigPath();
      await mkdir(join(tempHome, '.allagents'), { recursive: true });
      const initial = {
        repositories: [],
        clients: ['codex'],
        plugins: ['../keep'],
      };
      await writeFile(configPath, dump(initial, { lineWidth: -1 }), 'utf-8');

      const result = await addUserPluginForTarget({
        declaration: { source: pluginDir, clients: ['cursor'] },
        clients: ['cursor'],
      });

      expect(result.success).toBe(true);
      const config = load(
        await readFile(configPath, 'utf-8'),
      ) as WorkspaceConfig;
      expect(config.clients).toEqual(initial.clients);
      expect(config.plugins).toEqual([
        '../keep',
        { source: pluginDir, clients: ['cursor'] },
      ]);
    });

    test('preserves object fields and clears clients on inherited reinstall', async () => {
      const pluginDir = join(tempHome, 'target-plugin');
      await mkdir(pluginDir, { recursive: true });
      const configPath = getUserWorkspaceConfigPath();
      await mkdir(join(tempHome, '.allagents'), { recursive: true });
      await writeFile(
        configPath,
        dump({
          repositories: [],
          clients: ['codex'],
          plugins: [
            {
              source: pluginDir,
              clients: ['cursor'],
              skills: ['public'],
              install: 'native',
              exclude: ['fixtures/**'],
              ref: 'stable',
            },
            '../keep',
          ],
        }),
        'utf-8',
      );

      const result = await addUserPluginForTarget({
        declaration: pluginDir,
        clients: ['codex'],
      });

      expect(result.success).toBe(true);
      const config = load(
        await readFile(configPath, 'utf-8'),
      ) as WorkspaceConfig;
      expect(config.clients).toEqual(['codex']);
      expect(config.plugins).toEqual([
        {
          source: pluginDir,
          skills: ['public'],
          install: 'native',
          exclude: ['fixtures/**'],
          ref: 'stable',
        },
        '../keep',
      ]);
    });

    test('replaces a semantic match in place and preserves object fields', async () => {
      const repoExists = spyOn(git, 'repoExists').mockResolvedValue(true);
      try {
        const configPath = getUserWorkspaceConfigPath();
        await mkdir(join(tempHome, '.allagents'), { recursive: true });
        await writeFile(
          configPath,
          dump({
            repositories: [],
            clients: ['codex'],
            plugins: [
              {
                source: 'https://github.com/owner/repo',
                skills: { exclude: ['private'] },
                install: 'native',
                ref: 'stable',
              },
              'https://github.com/other/keep',
            ],
          }),
          'utf-8',
        );

        const result = await addUserPluginForTarget({
          declaration: {
            source: 'https://github.com/owner/repo.git',
            clients: ['cursor'],
          },
          clients: ['cursor'],
        });

        expect(result.success).toBe(true);
        expect(result.replaced).toBe(true);
        const config = load(
          await readFile(configPath, 'utf-8'),
        ) as WorkspaceConfig;
        expect(config.clients).toEqual(['codex']);
        expect(config.plugins).toEqual([
          {
            source: 'https://github.com/owner/repo.git',
            skills: { exclude: ['private'] },
            install: 'native',
            ref: 'stable',
            clients: ['cursor'],
          },
          'https://github.com/other/keep',
        ]);
      } finally {
        repoExists.mockRestore();
      }
    });

    test('leaves original bytes and mode intact and removes the temp file on pre-rename failure', async () => {
      const pluginDir = join(tempHome, 'target-plugin');
      await mkdir(pluginDir, { recursive: true });
      const configPath = getUserWorkspaceConfigPath();
      await mkdir(join(tempHome, '.allagents'), { recursive: true });
      const original =
        'repositories: []\nplugins:\n  - ../keep\nclients:\n  - codex\n';
      await writeFile(configPath, original, 'utf-8');
      await chmod(configPath, 0o640);

      const result = await addUserPluginForTarget(
        { declaration: pluginDir, clients: ['codex'] },
        {
          beforeRename() {
            throw new Error('injected user pre-rename failure');
          },
        },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('injected user pre-rename failure');
      expect(await readFile(configPath, 'utf-8')).toBe(original);
      expect((await stat(configPath)).mode & 0o777).toBe(0o640);
      expect(await readdir(join(tempHome, '.allagents'))).toEqual([
        'workspace.yaml',
      ]);
    });
  });

  describe('removeUserPlugin', () => {
    test('removes plugin from user workspace.yaml', async () => {
      const pluginDir = join(tempHome, 'my-plugin');
      await mkdir(pluginDir, { recursive: true });

      await addUserPlugin(pluginDir);
      const result = await removeUserPlugin(pluginDir);
      expect(result.success).toBe(true);
      const config = await getUserWorkspaceConfig();
      expect(config!.plugins).not.toContain(pluginDir);
    });

    test('returns error for non-existent plugin', async () => {
      await ensureUserWorkspace();
      const result = await removeUserPlugin('/nonexistent/plugin');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    test('creates config if it does not exist yet', async () => {
      const result = await removeUserPlugin('/nonexistent/plugin');
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
      // Config was auto-created as a side effect
      const config = await getUserWorkspaceConfig();
      expect(config).toBeTruthy();
    });

    test('removes plugin using partial match (e.g., "code-review" matches "code-review@marketplace")', async () => {
      await ensureUserWorkspace();

      // Manually add a plugin with marketplace suffix
      const configPath = getUserWorkspaceConfigPath();
      const content = await readFile(configPath, 'utf-8');
      const { load: yamlLoad } = await import('js-yaml');
      const config = yamlLoad(content) as any;
      config.plugins.push('code-review@marketplace');

      const { dump: yamlDump } = await import('js-yaml');
      const { writeFile: fsWriteFile } = await import('node:fs/promises');
      await fsWriteFile(configPath, yamlDump(config, { lineWidth: -1 }), 'utf-8');

      // Now remove using partial match
      const result = await removeUserPlugin('code-review');
      expect(result.success).toBe(true);

      const updatedConfig = await getUserWorkspaceConfig();
      expect(updatedConfig!.plugins).not.toContain('code-review@marketplace');
    });

    test('cleans up disabled skills when removing plugin spec', async () => {
      await ensureUserWorkspace();

      const configPath = getUserWorkspaceConfigPath();
      const { load: yamlLoad } = await import('js-yaml');
      const { dump: yamlDump } = await import('js-yaml');
      const { writeFile: fsWriteFile } = await import('node:fs/promises');

      const content = await readFile(configPath, 'utf-8');
      const config = yamlLoad(content) as any;
      config.plugins.push('cargowise@wtg-ai-prompts');
      config.disabledSkills = ['cargowise:cw-document-macro', 'other:skill'];
      await fsWriteFile(configPath, yamlDump(config, { lineWidth: -1 }), 'utf-8');

      const result = await removeUserPlugin('cargowise@wtg-ai-prompts');
      expect(result.success).toBe(true);

      const updatedConfig = await getUserWorkspaceConfig();
      expect(updatedConfig!.plugins).not.toContain('cargowise@wtg-ai-prompts');
      expect(updatedConfig!.disabledSkills ?? []).not.toContain('cargowise:cw-document-macro');
      expect(updatedConfig!.disabledSkills).toContain('other:skill');
    });

    test('clears disabledSkills entirely when all belong to removed plugin', async () => {
      await ensureUserWorkspace();

      const configPath = getUserWorkspaceConfigPath();
      const { load: yamlLoad } = await import('js-yaml');
      const { dump: yamlDump } = await import('js-yaml');
      const { writeFile: fsWriteFile } = await import('node:fs/promises');

      const content = await readFile(configPath, 'utf-8');
      const config = yamlLoad(content) as any;
      config.plugins.push('cargowise@wtg-ai-prompts');
      config.disabledSkills = ['cargowise:cw-document-macro', 'cargowise:cw-coding'];
      await fsWriteFile(configPath, yamlDump(config, { lineWidth: -1 }), 'utf-8');

      const result = await removeUserPlugin('cargowise@wtg-ai-prompts');
      expect(result.success).toBe(true);

      const updatedConfig = await getUserWorkspaceConfig();
      expect(updatedConfig!.disabledSkills).toBeUndefined();
    });
  });

  describe('getInstalledUserPlugins', () => {
    test('returns local path plugin', async () => {
      const pluginDir = join(tempHome, 'my-plugin');
      await mkdir(pluginDir, { recursive: true });
      await addUserPlugin(pluginDir);

      const plugins = await getInstalledUserPlugins();
      expect(plugins).toHaveLength(1);
      expect(plugins[0].spec).toBe(pluginDir);
      expect(plugins[0].name).toBe('my-plugin');
      expect(plugins[0].scope).toBe('user');
    });

    test('returns marketplace plugin', async () => {
      await ensureUserWorkspace();
      const configPath = getUserWorkspaceConfigPath();
      const { load: yamlLoad, dump: yamlDump } = await import('js-yaml');
      const content = await readFile(configPath, 'utf-8');
      const config = yamlLoad(content) as any;
      config.plugins.push('code-review@my-marketplace');
      await writeFile(configPath, yamlDump(config, { lineWidth: -1 }), 'utf-8');

      const plugins = await getInstalledUserPlugins();
      expect(plugins).toHaveLength(1);
      expect(plugins[0].name).toBe('code-review');
      expect(plugins[0].marketplace).toBe('my-marketplace');
    });

    test('returns GitHub URL plugin', async () => {
      await ensureUserWorkspace();
      const configPath = getUserWorkspaceConfigPath();
      const { load: yamlLoad, dump: yamlDump } = await import('js-yaml');
      const content = await readFile(configPath, 'utf-8');
      const config = yamlLoad(content) as any;
      config.plugins.push('https://github.com/owner/my-repo');
      await writeFile(configPath, yamlDump(config, { lineWidth: -1 }), 'utf-8');

      const plugins = await getInstalledUserPlugins();
      expect(plugins).toHaveLength(1);
      expect(plugins[0].spec).toBe('https://github.com/owner/my-repo');
      expect(plugins[0].name).toBe('my-repo');
      expect(plugins[0].scope).toBe('user');
    });
  });

  describe('getInstalledProjectPlugins', () => {
    test('returns local path plugin from project config', async () => {
      const workspaceDir = join(tempHome, 'project');
      const configDir = join(workspaceDir, '.allagents');
      await mkdir(configDir, { recursive: true });
      const { dump: yamlDump } = await import('js-yaml');
      await writeFile(
        join(configDir, 'workspace.yaml'),
        yamlDump({
          plugins: ['/tmp/my-plugin'],
          clients: ['claude'],
        }, { lineWidth: -1 }),
        'utf-8',
      );

      const plugins = await getInstalledProjectPlugins(workspaceDir);
      expect(plugins).toHaveLength(1);
      expect(plugins[0].spec).toBe('/tmp/my-plugin');
      expect(plugins[0].name).toBe('my-plugin');
      expect(plugins[0].scope).toBe('project');
    });

    test('returns all plugin formats from project config', async () => {
      const workspaceDir = join(tempHome, 'project');
      const configDir = join(workspaceDir, '.allagents');
      await mkdir(configDir, { recursive: true });
      const { dump: yamlDump } = await import('js-yaml');
      await writeFile(
        join(configDir, 'workspace.yaml'),
        yamlDump({
          plugins: [
            'code-review@my-marketplace',
            'https://github.com/owner/my-repo',
            '/tmp/local-plugin',
          ],
          clients: ['claude'],
        }, { lineWidth: -1 }),
        'utf-8',
      );

      const plugins = await getInstalledProjectPlugins(workspaceDir);
      expect(plugins).toHaveLength(3);
      expect(plugins[0].name).toBe('code-review');
      expect(plugins[0].marketplace).toBe('my-marketplace');
      expect(plugins[1].name).toBe('my-repo');
      expect(plugins[1].marketplace).toBe('');
      expect(plugins[2].name).toBe('local-plugin');
      expect(plugins[2].marketplace).toBe('');
    });

    test('preserves raw sources while deriving names and effective refs', async () => {
      const workspaceDir = join(tempHome, 'project');
      const configDir = join(workspaceDir, '.allagents');
      await mkdir(configDir, { recursive: true });
      await writeFile(
        join(configDir, 'workspace.yaml'),
        `plugins:
  - source: acme/toolbox/plugins/research
    ref: v1
  - source: acme/toolbox/plugins/research
    ref: v2
clients:
  - codex
`,
        'utf-8',
      );

      const plugins = await getInstalledProjectPlugins(workspaceDir);
      expect(plugins).toEqual([
        {
          spec: 'acme/toolbox/plugins/research',
          effectiveSpec: 'acme/toolbox@v1/plugins/research',
          name: 'research',
          marketplace: '',
          scope: 'project',
        },
        {
          spec: 'acme/toolbox/plugins/research',
          effectiveSpec: 'acme/toolbox@v2/plugins/research',
          name: 'research',
          marketplace: '',
          scope: 'project',
        },
      ]);
    });

    test('returns empty when workspace path is home directory', async () => {
      // Write a config directly to ~/.allagents/workspace.yaml (the user config)
      const configDir = join(tempHome, '.allagents');
      await mkdir(configDir, { recursive: true });
      const { dump: yamlDump } = await import('js-yaml');
      await writeFile(
        join(configDir, 'workspace.yaml'),
        yamlDump({
          plugins: ['code-review@my-marketplace'],
          clients: ['claude'],
        }, { lineWidth: -1 }),
        'utf-8',
      );

      // When workspace path is the home directory, project config resolves to
      // the same file as user config — should return empty to avoid duplicates
      const plugins = await getInstalledProjectPlugins(tempHome);
      expect(plugins).toHaveLength(0);
    });
  });
});
