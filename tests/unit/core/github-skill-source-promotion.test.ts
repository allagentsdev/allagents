import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dump, load } from 'js-yaml';
import {
  canonicalizeGitHubPluginSource,
  upsertGitHubPluginSourceAllowlist,
  upsertGitHubPluginSourceAllowlistInConfig,
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
  it('keeps skill selections from sibling monorepo plugins distinct', async () => {
    const finance = 'https://github.com/example/catalogue/tree/main/plugins/finance/skills/modeling';
    const engineering = 'https://github.com/example/catalogue/tree/main/plugins/engineering/skills/review';
    const config: WorkspaceConfig = {
      version: 2, repositories: [], clients: ['universal'],
      plugins: [{ source: finance, skills: ['modeling'] }],
    };
    expect((await upsertGitHubPluginSourceAllowlistInConfig(config, engineering, ['review'])).success).toBe(true);
    expect(config.plugins).toEqual([
      { source: finance, skills: ['modeling'] },
      { source: engineering, skills: ['review'] },
    ]);
  });

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

  for (const inherited of [false, true]) {
    it(`preserves native-first generic declarations when file mode is ${inherited ? 'inherited' : 'explicit'}`, async () => {
      const source = 'ssh://alice@forgejo.example:2222/team/skills.git';
      const native = { source, clients: ['pi' as const], ...(inherited ? {} : { install: 'native' as const }) };
      const file = { source, clients: ['codex' as const], ...(inherited ? {} : { install: 'file' as const }), skills: ['keep'] };
      const config: WorkspaceConfig = { version: 2, repositories: [], clients: [{ name: 'pi', install: 'native' }, 'codex'], plugins: [native, file] };
      expect((await upsertGitHubPluginSourceAllowlistInConfig(config, source, ['keep', 'new'])).success).toBe(true);
      expect(config.plugins).toEqual([native, { ...file, skills: ['keep', 'new'] }]);
      expect(native).not.toHaveProperty('skills');
    });
  }

  it('keeps an inherited mixed file/native declaration indivisible when selecting skills', async () => {
    const source = 'ssh://alice@forgejo.example:2222/team/skills.git';
    const mixed = { source, clients: ['pi' as const, 'codex' as const] };
    const config: WorkspaceConfig = { version: 2, repositories: [], clients: [{ name: 'pi', install: 'native' }, 'codex'], plugins: [mixed] };
    expect((await upsertGitHubPluginSourceAllowlistInConfig(config, source, ['keep'])).success).toBe(true);
    expect(config.plugins).toEqual([mixed, { source, install: 'file', skills: ['keep'] }]);
    expect(mixed).not.toHaveProperty('skills');
  });

  it('creates an explicit file declaration when only a native generic source exists', async () => {
    const source = 'ssh://alice@forgejo.example:2222/team/skills.git';
    const native = { source, install: 'native' as const, clients: ['pi' as const] };
    const config: WorkspaceConfig = { version: 2, repositories: [], clients: [{ name: 'pi', install: 'native' }], plugins: [native] };
    expect((await upsertGitHubPluginSourceAllowlistInConfig(config, source, ['keep'])).success).toBe(true);
    expect(config.plugins).toEqual([native, { source, install: 'file', skills: ['keep'] }]);
    expect(native).not.toHaveProperty('skills');
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
