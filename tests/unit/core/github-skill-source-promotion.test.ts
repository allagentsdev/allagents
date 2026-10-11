import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, load } from 'js-yaml';
import {
  canonicalizeGitHubPluginSource,
  upsertGitHubPluginSourceAllowlist,
} from '../../../src/core/workspace-modify.js';
import type { WorkspaceConfig } from '../../../src/models/workspace-config.js';

describe('canonicalizeGitHubPluginSource', () => {
  it('promotes sibling standalone skills to their shared subtree', () => {
    const current =
      'https://github.com/NousResearch/hermes-agent/tree/main/skills/research/llm-wiki';
    const next =
      'https://github.com/NousResearch/hermes-agent/tree/main/skills/research/blogwatcher';

    expect(canonicalizeGitHubPluginSource(current, next)).toBe(
      'https://github.com/NousResearch/hermes-agent/tree/main/skills/research',
    );
  });

  it('promotes different subtrees to the next shared container', () => {
    const current =
      'https://github.com/NousResearch/hermes-agent/tree/main/skills/research';
    const next =
      'https://github.com/NousResearch/hermes-agent/tree/main/skills/productivity/task-planner';

    expect(canonicalizeGitHubPluginSource(current, next)).toBe(
      'https://github.com/NousResearch/hermes-agent/tree/main/skills',
    );
  });
});

describe('upsertGitHubPluginSourceAllowlist', () => {
  it('updates the exact generic object-ref declaration while preserving its source and another ref', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'allagents-generic-allowlist-'));
    const source = 'ssh://alice@forgejo.example:2222/team/skills.git#subdir=selected';
    try {
      await mkdir(join(tmpDir, '.allagents'), { recursive: true });
      await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump({ version: 2, repositories: [], clients: ['codex'], plugins: [{ source, ref: 'feature/demo', install: 'file', skills: ['keep'] }, { source, ref: 'other', install: 'file', skills: ['unrelated'] }] }));
      const result = await upsertGitHubPluginSourceAllowlist(`${source}&ref=feature%2Fdemo`, ['keep', 'new'], tmpDir);
      expect(result.success).toBe(true);
      const updated = load(await readFile(join(tmpDir, '.allagents/workspace.yaml'), 'utf-8')) as WorkspaceConfig;
      expect(updated.plugins).toEqual([{ source, ref: 'feature/demo', install: 'file', skills: ['keep', 'new'] }, { source, ref: 'other', install: 'file', skills: ['unrelated'] }]);
    } finally { await rm(tmpDir, { recursive: true, force: true }); }
  });

  it('rewrites the stored source instead of creating a duplicate entry', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'allagents-skill-source-'));

    try {
      await mkdir(join(tmpDir, '.allagents'), { recursive: true });
      const config: WorkspaceConfig = {
        repositories: [],
        plugins: [{
          source: 'https://github.com/NousResearch/hermes-agent/tree/main/skills/research/llm-wiki',
          skills: ['llm-wiki'],
        }],
        clients: ['claude'],
        version: 2,
      };
      await writeFile(join(tmpDir, '.allagents/workspace.yaml'), dump(config), 'utf-8');

      const result = await upsertGitHubPluginSourceAllowlist(
        'https://github.com/NousResearch/hermes-agent/tree/main/skills/research/blogwatcher',
        ['llm-wiki', 'blogwatcher'],
        tmpDir,
      );

      expect(result.success).toBe(true);
      expect(result.normalizedPlugin).toBe(
        'https://github.com/NousResearch/hermes-agent/tree/main/skills/research',
      );

      const content = await readFile(join(tmpDir, '.allagents/workspace.yaml'), 'utf-8');
      const updated = load(content) as WorkspaceConfig;
      expect(updated.plugins).toHaveLength(1);

      const plugin = updated.plugins[0];
      expect(typeof plugin).toBe('object');
      if (typeof plugin !== 'string') {
        expect(plugin.source).toBe(
          'https://github.com/NousResearch/hermes-agent/tree/main/skills/research',
        );
        expect(plugin.skills).toEqual(['llm-wiki', 'blogwatcher']);
      }
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
