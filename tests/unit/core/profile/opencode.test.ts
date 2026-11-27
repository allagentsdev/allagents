import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeProfileAdapter } from '../../../../src/core/profile/adapters/opencode.js';
import {
  applyProfilePlan,
  planProfileOperation,
} from '../../../../src/core/profile/index.js';
import { isNativeProfileAdapter } from '../../../../src/core/profile/types.js';

describe('OpenCode profile adapter', () => {
  it('selects additive configuration overrides without changing the workspace', () => {
    const adapter = new OpenCodeProfileAdapter();
    const context = adapter.resolveContext('review', {
      homeDir: '/home/test',
      workspaceDirectory: '/work/project',
      environment: {
        OPENCODE_CONFIG: '/ambient/opencode.json',
        OPENCODE_CONFIG_CONTENT: '{"share":"auto"}',
      },
    });
    const root = join(
      '/home/test',
      '.allagents',
      'profiles',
      'review',
      'clients',
      'opencode',
      'config',
    );

    expect(context).toMatchObject({
      client: 'opencode',
      mechanism: 'configuration-override',
      root,
      operationContext: {
        root,
        cwd: '/work/project',
        nativeScope: 'profile:review',
        env: {
          OPENCODE_CONFIG: join(root, 'opencode.json'),
          OPENCODE_CONFIG_DIR: root,
          OPENCODE_CONFIG_CONTENT: undefined,
        },
      },
      fileMapping: {
        commandsPath: 'commands/',
        skillsPath: 'skills/',
        agentFile: 'AGENTS.md',
      },
      launcher: {
        command: 'opencode',
        args: [],
        env: {
          OPENCODE_CONFIG: join(root, 'opencode.json'),
          OPENCODE_CONFIG_DIR: root,
          OPENCODE_CONFIG_CONTENT: undefined,
        },
      },
    });
  });

  it('serializes strict settings and selected MCP servers into one owned config', () => {
    const adapter = new OpenCodeProfileAdapter();
    const context = adapter.resolveContext('review', {
      homeDir: '/home/test',
      workspaceDirectory: '/work/project',
    });
    const planned = adapter.serializeSettings(context, {
      plugins: [],
      settings: {
        model: 'anthropic/claude-sonnet-4-5',
        share: 'disabled',
      },
      mcpServers: {
        local: {
          command: 'local-mcp',
          args: ['--token', '${LOCAL_TOKEN}'],
          env: { LOCAL_TOKEN: '${LOCAL_TOKEN}' },
          clients: ['opencode'],
        },
        remote: {
          type: 'http',
          url: 'https://mcp.example.test',
          headers: { Authorization: '${REMOTE_TOKEN}' },
        },
        ignored: {
          command: 'other-mcp',
          clients: ['pi'],
        },
      },
    });

    expect(planned?.path).toBe(join(context.root, 'opencode.json'));
    expect(JSON.parse(planned?.content ?? '{}')).toEqual({
      $schema: 'https://opencode.ai/config.json',
      model: 'anthropic/claude-sonnet-4-5',
      share: 'disabled',
      mcp: {
        local: {
          type: 'local',
          command: ['local-mcp', '--token', '{env:LOCAL_TOKEN}'],
          environment: { LOCAL_TOKEN: '{env:LOCAL_TOKEN}' },
        },
        remote: {
          type: 'remote',
          url: 'https://mcp.example.test',
          headers: { Authorization: '{env:REMOTE_TOKEN}' },
        },
      },
    });
    expect(adapter.serializeMcp(context, { plugins: [] })).toBeNull();
  });

  it('is structurally file-only without a fake native lifecycle', () => {
    const adapter = new OpenCodeProfileAdapter();
    expect(adapter.capabilities.nativeInstall).toBe(false);
    expect(isNativeProfileAdapter(adapter)).toBe(false);
    expect('nativeClient' in adapter).toBe(false);
    expect('resolveNativeSource' in adapter).toBe(false);
    expect('resolveNativeMetadata' in adapter).toBe(false);
    expect('discloseNativeCommands' in adapter).toBe(false);
  });

  it.each([
    {
      mode: 'default removal',
      purgeSessionData: false,
      modifyAfterPlan: false,
    },
    { mode: 'explicit purge', purgeSessionData: true, modifyAfterPlan: false },
    {
      mode: 'file edited after planning',
      purgeSessionData: true,
      modifyAfterPlan: true,
    },
  ])(
    'protects runtime directories and checks the generated gitignore in $mode',
    async ({ purgeSessionData, modifyAfterPlan }) => {
      const home = await mkdtemp(join(tmpdir(), 'allagents-opencode-profile-'));
      try {
        const adapter = new OpenCodeProfileAdapter();
        const options = {
          homeDir: home,
          workspaceDirectory: home,
          purgeSessionData,
        };
        const workspace = join(home, '.allagents');
        await mkdir(workspace, { recursive: true });
        await writeFile(
          join(workspace, 'workspace.yaml'),
          [
            'profiles:',
            '  review:',
            '    clients:',
            '      - name: opencode',
            '        settings:',
            '          model: demo/model',
            '',
          ].join('\n'),
        );
        const install = await planProfileOperation(
          'review',
          'install',
          options,
        );
        expect((await applyProfilePlan(install, options)).success).toBe(true);
        const { root } = adapter.resolveContext('review', options);
        const generatedPath = join(root, '.gitignore');
        const sessions = join(root, 'unknown-runtime', 'empty');
        await mkdir(sessions, { recursive: true });
        const generated =
          'node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore';

        const modified = `${generated}\nuser-entry`;
        await writeFile(generatedPath, modified, 'utf8');
        const modifiedPlan = await planProfileOperation(
          'review',
          'remove',
          options,
        );
        expect(
          modifiedPlan.steps.find((step) => step.identity === generatedPath)
            ?.action,
        ).toBe('retain');

        await writeFile(generatedPath, generated, 'utf8');
        const removal = await planProfileOperation('review', 'remove', options);
        expect(
          removal.steps.find((step) => step.identity === generatedPath)?.action,
        ).toBe('remove');
        expect(
          removal.steps.find((step) => step.identity === root)?.action,
        ).toBe('retain');

        if (modifyAfterPlan) await writeFile(generatedPath, modified, 'utf8');
        const result = await applyProfilePlan(removal, options);
        expect(result.status).toBe('removed');
        if (modifyAfterPlan) {
          expect(await readFile(generatedPath, 'utf8')).toBe(modified);
        } else {
          await expect(stat(generatedPath)).rejects.toThrow();
        }
        await expect(stat(join(root, 'opencode.json'))).rejects.toThrow();
        expect((await stat(sessions)).isDirectory()).toBe(true);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});
