import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseWorkspaceTemplateSource } from '../../../src/cli/tui/prompt-workspace-template.js';

describe('chooseWorkspaceTemplateSource', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function makeSource(paths: string[]): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'allagents-template-choice-'));
    roots.push(root);
    for (const path of paths) {
      const configDir = join(root, path, '.allagents');
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, 'workspace.yaml'), 'clients: []\n');
    }
    return root;
  }

  it('uses the only nested template without a prompt', async () => {
    const root = await makeSource(['scripts/allagents-setup/aim']);
    expect(await chooseWorkspaceTemplateSource(root)).toEqual({
      source: join(root, 'scripts/allagents-setup/aim'),
    });
  });

  it('lists every nested template when selection is unavailable', async () => {
    const root = await makeSource([
      'scripts/allagents-setup/aim',
      'evals/neo/.workspace-template',
    ]);

    await expect(chooseWorkspaceTemplateSource(root)).rejects.toThrow(
      /evals\/neo\/\.workspace-template[\s\S]*scripts\/allagents-setup\/aim/,
    );
  });

  it('keeps an explicit template path without looking for other templates', async () => {
    const root = await makeSource(['scripts/allagents-setup/aim', 'scripts/allagents-setup/neo']);
    const direct = join(root, 'scripts/allagents-setup/aim');
    expect(await chooseWorkspaceTemplateSource(direct)).toEqual({ source: direct });
  });
});
