import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  copyPluginToWorkspace,
  dedupeAgentFilesByName,
  planAgentOutputs,
  type AgentOutputPlan,
} from '../../../src/core/transform.js';
import { CLIENT_MAPPINGS } from '../../../src/models/client-mapping.js';

const agent = (name: string, body: string) =>
  `---\nname: ${name}\n---\n\n${body}\n`;

describe('planned agent output dedupe', () => {
  let testDir: string;
  let pluginDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-agent-dedupe-'));
    pluginDir = join(testDir, 'plugin');
    workspaceDir = join(testDir, 'workspace');
    await mkdir(pluginDir, { recursive: true });
    await mkdir(workspaceDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writeAgent(
    pluginPath: string,
    sourcePath: string,
    name: string,
    body: string,
  ): Promise<void> {
    const path = join(pluginPath, sourcePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, agent(name, body));
  }

  async function plan(pluginPath = pluginDir): Promise<AgentOutputPlan> {
    return planAgentOutputs(
      [
        {
          configurationIndex: 0,
          plugin: pluginPath,
          pluginPath,
          clients: ['copilot'],
        },
      ],
      workspaceDir,
      CLIENT_MAPPINGS,
    );
  }

  it('removes a portable representation only after both exact planned copies succeed', async () => {
    await writeAgent(
      pluginDir,
      'agents/reviewer.md',
      'reviewer',
      'Portable',
    );
    await writeAgent(
      pluginDir,
      '.github/agents/reviewer.agent.md',
      'reviewer',
      'GitHub',
    );
    const outputPlan = await plan();

    const results = await copyPluginToWorkspace(
      pluginDir,
      workspaceDir,
      'copilot',
      { agentOutputs: outputPlan.outputs },
    );
    const records = await dedupeAgentFilesByName(outputPlan, results);

    expect(records).toEqual([
      {
        name: 'reviewer',
        removedPath: '.github/agents/reviewer.md',
        keptPath: '.github/agents/reviewer.agent.md',
      },
    ]);
    expect(existsSync(join(workspaceDir, '.github/agents/reviewer.md'))).toBe(
      false,
    );
    expect(
      await readFile(
        join(workspaceDir, '.github/agents/reviewer.agent.md'),
        'utf-8',
      ),
    ).toContain('GitHub');
  });

  it('preserves the portable representation when the preferred copy fails', async () => {
    await writeAgent(
      pluginDir,
      'agents/reviewer.md',
      'reviewer',
      'Portable',
    );
    await writeAgent(
      pluginDir,
      '.github/agents/reviewer.agent.md',
      'reviewer',
      'GitHub',
    );
    await mkdir(join(workspaceDir, '.github/agents/reviewer.agent.md'), {
      recursive: true,
    });
    const outputPlan = await plan();

    const results = await copyPluginToWorkspace(
      pluginDir,
      workspaceDir,
      'copilot',
      { agentOutputs: outputPlan.outputs },
    );
    const records = await dedupeAgentFilesByName(outputPlan, results);

    expect(
      results.some(
        (result) =>
          result.destination.endsWith('reviewer.agent.md') &&
          result.action === 'failed',
      ),
    ).toBe(true);
    expect(records).toEqual([]);
    expect(existsSync(join(workspaceDir, '.github/agents/reviewer.md'))).toBe(
      true,
    );
  });

  it('does not claim removal when unlinking the portable representation fails', async () => {
    await writeAgent(
      pluginDir,
      'agents/reviewer.md',
      'reviewer',
      'Portable',
    );
    await writeAgent(
      pluginDir,
      '.github/agents/reviewer.agent.md',
      'reviewer',
      'GitHub',
    );
    const outputPlan = await plan();
    const results = await copyPluginToWorkspace(
      pluginDir,
      workspaceDir,
      'copilot',
      { agentOutputs: outputPlan.outputs },
    );
    const portablePath = join(workspaceDir, '.github/agents/reviewer.md');
    await rm(portablePath);
    await mkdir(portablePath);
    const warnings: string[] = [];

    const records = await dedupeAgentFilesByName(outputPlan, results, {
      onWarning: (warning) => warnings.push(warning),
    });

    expect(records).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('failed to remove');
    expect(existsSync(portablePath)).toBe(true);
  });

  it('gives an earlier configured plugin destination ownership without hiding a later distinct GitHub agent', async () => {
    const pluginA = join(testDir, 'plugin-a');
    const pluginB = join(testDir, 'plugin-b');
    await writeAgent(pluginA, 'agents/shared.md', 'alpha', 'A');
    await writeAgent(pluginB, 'agents/shared.md', 'beta', 'B portable');
    await writeAgent(
      pluginB,
      '.github/agents/beta.agent.md',
      'beta',
      'B GitHub',
    );

    const outputPlan = await planAgentOutputs(
      [
        {
          configurationIndex: 0,
          plugin: 'plugin-a',
          pluginPath: pluginA,
          clients: ['copilot'],
        },
        {
          configurationIndex: 1,
          plugin: 'plugin-b',
          pluginPath: pluginB,
          clients: ['copilot'],
        },
      ],
      workspaceDir,
      CLIENT_MAPPINGS,
    );

    expect(
      outputPlan.outputs.map((output) => [
        output.plugin,
        output.workspaceRelativeDestination,
      ]),
    ).toEqual([
      ['plugin-a', '.github/agents/shared.md'],
      ['plugin-b', '.github/agents/beta.agent.md'],
    ]);
    expect(outputPlan.conflicts).toHaveLength(1);
    expect(outputPlan.conflicts[0]?.winner.plugin).toBe('plugin-a');
    expect(outputPlan.conflicts[0]?.loser.plugin).toBe('plugin-b');
  });

  it('uses logical names to prevent a later plugin from owning a second destination', async () => {
    const pluginA = join(testDir, 'plugin-a');
    const pluginB = join(testDir, 'plugin-b');
    await writeAgent(pluginA, 'agents/first.md', 'shared-agent', 'A');
    await writeAgent(
      pluginB,
      '.github/agents/second.agent.md',
      'shared-agent',
      'B',
    );

    const outputPlan = await planAgentOutputs(
      [
        {
          configurationIndex: 0,
          plugin: 'plugin-a',
          pluginPath: pluginA,
          clients: ['copilot'],
        },
        {
          configurationIndex: 1,
          plugin: 'plugin-b',
          pluginPath: pluginB,
          clients: ['copilot'],
        },
      ],
      workspaceDir,
      CLIENT_MAPPINGS,
    );

    expect(outputPlan.outputs).toHaveLength(1);
    expect(outputPlan.outputs[0]?.plugin).toBe('plugin-a');
    expect(outputPlan.conflicts[0]?.reason).toBe('logical-name');
  });

  it('applies plugin-relative excludes and disables development overlays while planning', async () => {
    await writeAgent(pluginDir, 'agents/keep.md', 'keep', 'Keep');
    await writeAgent(pluginDir, 'agents/drop.md', 'drop', 'Drop');
    await writeAgent(
      pluginDir,
      '.github/agents/github.agent.md',
      'github',
      'GitHub',
    );

    const outputPlan = await planAgentOutputs(
      [
        {
          configurationIndex: 0,
          plugin: 'plugin',
          pluginPath: pluginDir,
          clients: ['copilot'],
          exclude: ['agents/drop.md'],
          components: {
            agents: [join(pluginDir, 'agents')],
            commands: [],
            github: false,
            hooks: [],
            mcpServers: [],
            skills: [],
          },
        },
      ],
      workspaceDir,
      CLIENT_MAPPINGS,
    );

    expect(
      outputPlan.outputs.map((output) => output.workspaceRelativeDestination),
    ).toEqual(['.github/agents/keep.md']);
  });

  it('retains first-provider ownership for individually declared custom agents', async () => {
    const pluginA = join(testDir, 'plugin-a');
    const pluginB = join(testDir, 'plugin-b');
    for (const pluginPath of [pluginA, pluginB]) {
      await writeAgent(pluginPath, 'custom/reviewer.agent.md', 'reviewer', pluginPath);
      await writeAgent(pluginPath, 'agents/ignored.md', 'ignored', 'Default');
      await mkdir(join(pluginPath, '.claude-plugin'), { recursive: true });
      await writeFile(join(pluginPath, '.claude-plugin/plugin.json'), JSON.stringify({
        name: 'custom-plugin', agents: './custom/reviewer.agent.md',
      }));
    }
    const outputPlan = await planAgentOutputs([
      { configurationIndex: 0, plugin: 'plugin-a', pluginPath: pluginA, clients: ['copilot'] },
      { configurationIndex: 1, plugin: 'plugin-b', pluginPath: pluginB, clients: ['copilot'] },
    ], workspaceDir);
    expect(outputPlan.outputs).toHaveLength(1);
    expect(outputPlan.outputs[0]?.source).toBe(join(pluginA, 'custom/reviewer.agent.md'));
    expect(outputPlan.conflicts).toHaveLength(1);
    await copyPluginToWorkspace(pluginA, workspaceDir, 'copilot', { agentOutputs: outputPlan.outputs });
    await copyPluginToWorkspace(pluginB, workspaceDir, 'copilot', { agentOutputs: [] });
    expect(await readFile(join(workspaceDir, '.github/agents/reviewer.agent.md'), 'utf-8'))
      .toBe(agent('reviewer', pluginA));
    expect(existsSync(join(workspaceDir, '.github/agents/ignored.md'))).toBe(false);
  });

  it('uses the same ownership and dedupe decisions in dry-run without writing', async () => {
    await writeAgent(
      pluginDir,
      'agents/reviewer.md',
      'reviewer',
      'Portable',
    );
    await writeAgent(
      pluginDir,
      '.github/agents/reviewer.agent.md',
      'reviewer',
      'GitHub',
    );
    const outputPlan = await plan();

    const results = await copyPluginToWorkspace(
      pluginDir,
      workspaceDir,
      'copilot',
      { dryRun: true, agentOutputs: outputPlan.outputs },
    );
    const records = await dedupeAgentFilesByName(outputPlan, results, {
      dryRun: true,
    });

    expect(records).toHaveLength(1);
    expect(existsSync(join(workspaceDir, '.github'))).toBe(false);
  });
});
