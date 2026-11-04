import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../../../src/constants.js';
import { syncWorkspace } from '../../../src/core/sync.js';
import type { SyncState } from '../../../src/models/sync-state.js';

const agent = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: ${name}\n---\n\n${body}\n`;

describe('syncWorkspace agent deduplication', () => {
  let workspacePath: string;

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), 'allagents-agent-sync-'));
  });

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true });
  });

  async function writePluginAgent(
    pluginPath: string,
    sourcePath: string,
    name: string,
    body: string,
  ): Promise<void> {
    const path = join(pluginPath, sourcePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, agent(name, body));
  }

  async function writeWorkspace(
    plugins: string[],
    clients: string[] = ['copilot'],
  ): Promise<void> {
    await mkdir(join(workspacePath, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      [
        'version: 2',
        'repositories: []',
        ...(plugins.length === 0
          ? ['plugins: []']
          : ['plugins:', ...plugins.map((plugin) => `  - ${plugin}`)]),
        'clients:',
        ...clients.map((client) => `  - ${client}`),
        '',
      ].join('\n'),
    );
  }

  async function readState(): Promise<SyncState> {
    return JSON.parse(
      await readFile(join(workspacePath, CONFIG_DIR, 'sync-state.json'), 'utf-8'),
    ) as SyncState;
  }

  it('dedupes Copilot without removing the Claude agent', async () => {
    const pluginPath = join(workspacePath, 'plugin');
    await writePluginAgent(
      pluginPath,
      'agents/reviewer.md',
      'reviewer',
      'Portable reviewer',
    );
    await writePluginAgent(
      pluginPath,
      '.github/agents/reviewer.agent.md',
      'reviewer',
      'GitHub reviewer',
    );
    await writeWorkspace([pluginPath], ['claude', 'copilot']);

    const result = await syncWorkspace(workspacePath);

    expect(result.success).toBe(true);
    expect(result.totalCopied).toBe(2);
    expect(existsSync(join(workspacePath, '.claude/agents/reviewer.md'))).toBe(
      true,
    );
    expect(
      existsSync(join(workspacePath, '.claude/agents/reviewer.agent.md')),
    ).toBe(false);
    expect(existsSync(join(workspacePath, '.github/agents/reviewer.md'))).toBe(
      false,
    );
    expect(
      existsSync(join(workspacePath, '.github/agents/reviewer.agent.md')),
    ).toBe(true);

    const state = await readState();
    expect(state.files.claude).toEqual(['.claude/agents/reviewer.md']);
    expect(state.files.copilot).toEqual([
      '.github/agents/reviewer.agent.md',
    ]);
    expect(result.messages).toEqual([
      "Deduped agent 'reviewer': removed .github/agents/reviewer.md (kept .github/agents/reviewer.agent.md)",
    ]);
  });

  it('requires a GitHub-format .agent.md file before deduping', async () => {
    const pluginPath = join(workspacePath, 'plugin');
    await writePluginAgent(
      pluginPath,
      'agents/portable.md',
      'reviewer',
      'Portable reviewer',
    );
    await writePluginAgent(
      pluginPath,
      '.github/agents/github.md',
      'reviewer',
      'Plain GitHub markdown',
    );
    await writeWorkspace([pluginPath]);

    const result = await syncWorkspace(workspacePath);

    expect(result.success).toBe(true);
    expect(existsSync(join(workspacePath, '.github/agents/portable.md'))).toBe(
      true,
    );
    expect(existsSync(join(workspacePath, '.github/agents/github.md'))).toBe(
      true,
    );
    expect(result.messages).toBeUndefined();
  });

  it('reports a fresh dry-run dedupe without writing files or state', async () => {
    const pluginPath = join(workspacePath, 'plugin');
    await writePluginAgent(
      pluginPath,
      'agents/reviewer.md',
      'reviewer',
      'Portable reviewer',
    );
    await writePluginAgent(
      pluginPath,
      '.github/agents/reviewer.agent.md',
      'reviewer',
      'GitHub reviewer',
    );
    await writeWorkspace([pluginPath]);

    const result = await syncWorkspace(workspacePath, { dryRun: true });

    expect(result.success).toBe(true);
    expect(result.totalCopied).toBe(1);
    expect(result.messages).toEqual([
      "Would dedupe agent 'reviewer': removed .github/agents/reviewer.md (kept .github/agents/reviewer.agent.md)",
    ]);
    expect(existsSync(join(workspacePath, '.github'))).toBe(false);
    expect(
      existsSync(join(workspacePath, CONFIG_DIR, 'sync-state.json')),
    ).toBe(false);
  });

  it('keeps the portable agent when the GitHub-format copy fails', async () => {
    const pluginPath = join(workspacePath, 'plugin');
    await writePluginAgent(
      pluginPath,
      'agents/reviewer.md',
      'reviewer',
      'Portable reviewer',
    );
    await writePluginAgent(
      pluginPath,
      '.github/agents/reviewer.agent.md',
      'reviewer',
      'GitHub reviewer',
    );
    await writePluginAgent(
      pluginPath,
      '.github/agents/healthy.agent.md',
      'healthy',
      'Healthy GitHub agent',
    );
    await writeWorkspace([pluginPath]);
    await mkdir(join(workspacePath, '.github/agents/reviewer.agent.md'), {
      recursive: true,
    });

    const result = await syncWorkspace(workspacePath);

    expect(result.success).toBe(false);
    expect(existsSync(join(workspacePath, '.github/agents/reviewer.md'))).toBe(
      true,
    );
    expect(
      existsSync(join(workspacePath, '.github/agents/healthy.agent.md')),
    ).toBe(true);
    expect(result.messages).toBeUndefined();
    const state = await readState();
    expect(state.files.copilot).toContain('.github/agents/reviewer.md');
    expect(state.files.copilot).toContain('.github/agents/healthy.agent.md');
    expect(state.files.copilot).not.toContain(
      '.github/agents/reviewer.agent.md',
    );
  });

  it('keeps tracking a GitHub-format agent after the portable source is removed', async () => {
    const pluginPath = join(workspacePath, 'plugin');
    const portableSource = join(pluginPath, 'agents/reviewer.md');
    await writePluginAgent(
      pluginPath,
      'agents/reviewer.md',
      'reviewer',
      'Portable reviewer',
    );
    await writePluginAgent(
      pluginPath,
      '.github/agents/reviewer.agent.md',
      'reviewer',
      'GitHub reviewer',
    );
    await writeWorkspace([pluginPath]);

    await syncWorkspace(workspacePath);
    await rm(portableSource);
    const updateResult = await syncWorkspace(workspacePath);

    expect(updateResult.success).toBe(true);
    expect(updateResult.deletedArtifacts).toBeUndefined();
    expect((await readState()).files.copilot).toEqual([
      '.github/agents/reviewer.agent.md',
    ]);

    await writeWorkspace([]);
    const removalResult = await syncWorkspace(workspacePath);

    expect(
      existsSync(join(workspacePath, '.github/agents/reviewer.agent.md')),
    ).toBe(false);
    expect(removalResult.deletedArtifacts).toEqual([
      { client: 'copilot', type: 'agent', name: 'reviewer' },
    ]);
  });

  it('does not report an existing portable agent as deleted when dedupe replaces its path', async () => {
    const pluginPath = join(workspacePath, 'plugin');
    await writePluginAgent(
      pluginPath,
      'agents/reviewer.md',
      'reviewer',
      'Portable reviewer',
    );
    await writePluginAgent(
      pluginPath,
      '.github/agents/reviewer.agent.md',
      'reviewer',
      'GitHub reviewer',
    );
    await writeWorkspace([pluginPath]);
    const previousState: SyncState = {
      version: 1,
      lastSync: new Date(0).toISOString(),
      files: { copilot: ['.github/agents/reviewer.md'] },
    };
    await writeFile(
      join(workspacePath, CONFIG_DIR, 'sync-state.json'),
      JSON.stringify(previousState),
    );

    const result = await syncWorkspace(workspacePath);

    expect(result.success).toBe(true);
    expect(result.deletedArtifacts).toBeUndefined();
  });

  it('resolves VS Code agent paths from each plugin client set', async () => {
    const copilotPlugin = join(workspacePath, 'copilot-plugin');
    const vscodePlugin = join(workspacePath, 'vscode-plugin');
    await mkdir(copilotPlugin, { recursive: true });
    await writePluginAgent(
      vscodePlugin,
      'agents/reviewer.md',
      'reviewer',
      'Portable reviewer',
    );
    await writePluginAgent(
      vscodePlugin,
      '.github/agents/reviewer.agent.md',
      'reviewer',
      'GitHub reviewer',
    );
    await mkdir(join(workspacePath, CONFIG_DIR), { recursive: true });
    await writeFile(
      join(workspacePath, CONFIG_DIR, WORKSPACE_CONFIG_FILE),
      [
        'version: 2',
        'repositories: []',
        'plugins:',
        `  - source: ${copilotPlugin}`,
        '    clients: [copilot]',
        `  - source: ${vscodePlugin}`,
        '    clients: [vscode]',
        'clients: []',
        '',
      ].join('\n'),
    );

    const result = await syncWorkspace(workspacePath);

    expect(result.success).toBe(true);
    expect(existsSync(join(workspacePath, '.github/agents/reviewer.md'))).toBe(
      false,
    );
    expect(
      existsSync(join(workspacePath, '.github/agents/reviewer.agent.md')),
    ).toBe(false);
  });



  it('uses first-configured-plugin ownership for agent filename conflicts', async () => {
    const pluginA = join(workspacePath, 'plugin-a');
    const pluginB = join(workspacePath, 'plugin-b');
    await writePluginAgent(
      pluginA,
      'agents/shared.md',
      'alpha',
      'Plugin A portable agent',
    );
    await writePluginAgent(
      pluginB,
      'agents/shared.md',
      'beta',
      'Plugin B portable agent',
    );
    await writePluginAgent(
      pluginB,
      '.github/agents/beta.agent.md',
      'beta',
      'Plugin B GitHub agent',
    );

    await writeWorkspace([pluginA, pluginB]);
    const firstResult = await syncWorkspace(workspacePath);

    expect(
      await readFile(join(workspacePath, '.github/agents/shared.md'), 'utf-8'),
    ).toContain('Plugin A portable agent');
    expect(
      existsSync(join(workspacePath, '.github/agents/beta.agent.md')),
    ).toBe(true);
    expect(firstResult.messages).toBeUndefined();
    expect(
      firstResult.warnings?.some(
        (warning) => warning.includes('plugin-b') && warning.includes('shared.md'),
      ),
    ).toBe(true);

    await writeWorkspace([pluginB, pluginA]);
    const reversedResult = await syncWorkspace(workspacePath);

    expect(existsSync(join(workspacePath, '.github/agents/shared.md'))).toBe(
      false,
    );
    expect(
      await readFile(
        join(workspacePath, '.github/agents/beta.agent.md'),
        'utf-8',
      ),
    ).toContain('Plugin B GitHub agent');
    expect(reversedResult.messages).toEqual([
      "Deduped agent 'beta': removed .github/agents/shared.md (kept .github/agents/beta.agent.md)",
    ]);
    expect(
      reversedResult.warnings?.some(
        (warning) => warning.includes('plugin-a') && warning.includes('shared.md'),
      ),
    ).toBe(true);
  });
});
