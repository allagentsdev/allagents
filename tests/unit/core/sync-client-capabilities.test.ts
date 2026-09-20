import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyPluginToWorkspace } from '../../../src/core/transform.js';

async function createPluginFixture(pluginDir: string): Promise<void> {
  await Promise.all([
    mkdir(join(pluginDir, 'skills', 'review'), { recursive: true }),
    mkdir(join(pluginDir, 'commands'), { recursive: true }),
    mkdir(join(pluginDir, 'agents'), { recursive: true }),
    mkdir(join(pluginDir, 'hooks'), { recursive: true }),
    mkdir(join(pluginDir, '.github', 'prompts'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(pluginDir, 'skills', 'review', 'SKILL.md'), '# Review'),
    writeFile(join(pluginDir, 'commands', 'review.md'), '# Command'),
    writeFile(join(pluginDir, 'agents', 'review.md'), '# Agent'),
    writeFile(join(pluginDir, 'hooks', 'review.js'), 'export default {}'),
    writeFile(join(pluginDir, '.github', 'prompts', 'review.prompt.md'), '# Prompt'),
  ]);
}

describe('client capability-aware file sync', () => {
  let testDir: string;
  let pluginDir: string;
  let workspaceDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'allagents-client-capabilities-'));
    pluginDir = join(testDir, 'plugin');
    workspaceDir = join(testDir, 'workspace');
    await Promise.all([
      mkdir(pluginDir, { recursive: true }),
      mkdir(workspaceDir, { recursive: true }),
    ]);
    await createPluginFixture(pluginDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('keeps every rich Claude artifact destination', async () => {
    await copyPluginToWorkspace(pluginDir, workspaceDir, 'claude');

    expect(existsSync(join(workspaceDir, '.claude', 'skills', 'review', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(workspaceDir, '.claude', 'commands', 'review.md'))).toBe(true);
    expect(existsSync(join(workspaceDir, '.claude', 'agents', 'review.md'))).toBe(true);
    expect(existsSync(join(workspaceDir, '.claude', 'hooks', 'review.js'))).toBe(true);
  });

  it('syncs a new universal-path client without fabricating other artifacts', async () => {
    await copyPluginToWorkspace(pluginDir, workspaceDir, 'warp');

    expect(existsSync(join(workspaceDir, '.agents', 'skills', 'review', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(workspaceDir, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(workspaceDir, 'commands'))).toBe(false);
    expect(existsSync(join(workspaceDir, 'agents'))).toBe(false);
    expect(existsSync(join(workspaceDir, 'hooks'))).toBe(false);
    expect(existsSync(join(workspaceDir, '.github'))).toBe(false);
  });

  it('syncs a provider-specific client only to its evidenced skill path', async () => {
    await copyPluginToWorkspace(pluginDir, workspaceDir, 'aider-desk');

    expect(existsSync(join(workspaceDir, '.aider-desk', 'skills', 'review', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(workspaceDir, 'AGENTS.md'))).toBe(false);
  });
});
