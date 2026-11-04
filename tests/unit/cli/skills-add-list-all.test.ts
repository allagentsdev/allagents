import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from 'cmd-ts';
import { parse as load, stringify as dump } from 'yaml';
import { discoverSkillsWithMetadata, skillsCmd } from '../../../src/cli/commands/plugin-skills.js';
import { pluginCmd } from '../../../src/cli/commands/plugin.js';
import { addMarketplace } from '../../../src/core/marketplace.js';
import { resetFetchCache, seedFetchCache } from '../../../src/core/plugin.js';
import { setJsonMode } from '../../../src/cli/json-output.js';

describe('discoverSkillsWithMetadata', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'allagents-discover-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns skills with descriptions from standard skills/ layout', async () => {
    await mkdir(join(tmpDir, 'skills/alpha'), { recursive: true });
    await mkdir(join(tmpDir, 'skills/beta'), { recursive: true });
    await writeFile(
      join(tmpDir, 'skills/alpha/SKILL.md'),
      '---\nname: alpha\ndescription: First skill\n---\n# Alpha\n',
    );
    await writeFile(
      join(tmpDir, 'skills/beta/SKILL.md'),
      '---\nname: beta\ndescription: Second skill\n---\n# Beta\n',
    );

    const result = await discoverSkillsWithMetadata(tmpDir);
    expect(result).toHaveLength(2);
    const alpha = result.find((s) => s.name === 'alpha');
    const beta = result.find((s) => s.name === 'beta');
    expect(alpha?.description).toBe('First skill');
    expect(beta?.description).toBe('Second skill');
  });

  it('returns skills from flat layout (no skills/ dir)', async () => {
    await mkdir(join(tmpDir, 'gamma'), { recursive: true });
    await writeFile(
      join(tmpDir, 'gamma/SKILL.md'),
      '---\nname: gamma\ndescription: Flat skill\n---\n',
    );

    const result = await discoverSkillsWithMetadata(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('gamma');
    expect(result[0]?.description).toBe('Flat skill');
  });

  it('returns empty description when SKILL.md frontmatter is missing description', async () => {
    await mkdir(join(tmpDir, 'skills/delta'), { recursive: true });
    await writeFile(join(tmpDir, 'skills/delta/SKILL.md'), '# Just a heading, no frontmatter\n');

    const result = await discoverSkillsWithMetadata(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('delta');
    expect(result[0]?.description).toBe('');
  });

  it('attaches pluginName when provided', async () => {
    await mkdir(join(tmpDir, 'skills/epsilon'), { recursive: true });
    await writeFile(
      join(tmpDir, 'skills/epsilon/SKILL.md'),
      '---\nname: epsilon\ndescription: Skill in plugin\n---\n',
    );

    const result = await discoverSkillsWithMetadata(tmpDir, 'my-plugin');
    expect(result[0]?.pluginName).toBe('my-plugin');
  });

  it('returns an empty array for an empty directory', async () => {
    const result = await discoverSkillsWithMetadata(tmpDir);
    expect(result).toEqual([]);
  });

  it('falls back to root SKILL.md when skill has no skills/ or flat-layout dir', async () => {
    // Root-layout: the repo itself is a single skill, no skills/ subdir
    await writeFile(
      join(tmpDir, 'SKILL.md'),
      '---\nname: root-skill\ndescription: Root layout skill\n---\n# Root Skill\n',
    );

    const result = await discoverSkillsWithMetadata(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('root-skill');
    expect(result[0]?.description).toBe('Root layout skill');
  });

  it('omits directories that lack a SKILL.md', async () => {
    // A directory under skills/ with no SKILL.md is not a skill; recursive
    // discovery walks past it instead of listing it as an empty entry.
    await mkdir(join(tmpDir, 'skills/eta'), { recursive: true });

    const result = await discoverSkillsWithMetadata(tmpDir);
    expect(result).toEqual([]);
  });

  it('discovers nested skills below skills/<category>/', async () => {
    await mkdir(join(tmpDir, 'skills/research/llm-wiki'), { recursive: true });
    await writeFile(
      join(tmpDir, 'skills/research/llm-wiki/SKILL.md'),
      '---\nname: llm-wiki\ndescription: Wiki of LLMs\n---\n',
    );

    const result = await discoverSkillsWithMetadata(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('llm-wiki');
    expect(result[0]?.subpath).toBe('research/llm-wiki');
    expect(result[0]?.description).toBe('Wiki of LLMs');
  });

  it('returns pluginName: undefined when not provided', async () => {
    await mkdir(join(tmpDir, 'skills/theta'), { recursive: true });
    await writeFile(
      join(tmpDir, 'skills/theta/SKILL.md'),
      '---\nname: theta\ndescription: No plugin context\n---\n',
    );

    const result = await discoverSkillsWithMetadata(tmpDir);
    expect(result[0]?.pluginName).toBeUndefined();
  });
});

describe('marketplace skill CLI consumers', () => {
  const source = 'https://github.com/fixtures/inventory-fixture';
  let root: string;
  let home: string;
  let workspace: string;
  let marketplace: string;
  let output: string[];
  let restore: () => void;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'allagents-marketplace-inventory-'));
    home = join(root, 'home');
    workspace = join(root, 'workspace');
    marketplace = join(root, 'marketplace');
    const previousHome = process.env.ALLAGENTS_TEST_HOME;
    const previousCwd = process.cwd();
    await mkdir(home, { recursive: true });
    await mkdir(join(workspace, '.allagents'), { recursive: true });
    await mkdir(join(marketplace, '.claude-plugin'), { recursive: true });
    await writeFile(join(workspace, '.allagents', 'workspace.yaml'), dump({ version: 2, repositories: [], plugins: [], clients: ['codex'], syncMode: 'copy' }));
    process.env.ALLAGENTS_TEST_HOME = home;
    process.chdir(workspace);
    output = [];
    const consoleLog = spyOn(console, 'log').mockImplementation((value) => { output.push(String(value)); });
    const processExit = spyOn(process, 'exit').mockImplementation((code) => { throw new Error(`Unexpected CLI exit ${code}: ${output.join('\n')}`); });
    restore = () => {
      consoleLog.mockRestore();
      processExit.mockRestore();
      process.chdir(previousCwd);
      if (previousHome === undefined) delete process.env.ALLAGENTS_TEST_HOME;
      else process.env.ALLAGENTS_TEST_HOME = previousHome;
    };
    const skill = async (path: string, name: string) => {
      await mkdir(join(marketplace, path), { recursive: true });
      await writeFile(join(marketplace, path, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} description\n---\n# ${name}\n`);
    };
    await skill('plugins/default/skills/actual', 'actual');
    await skill('plugins/default/skills/other', 'other');
    await skill('plugins/custom/skills/stale', 'stale');
    await skill('plugins/custom/library/selected', 'selected');
    await skill('plugins/custom/library/unselected', 'unselected');
    await skill('plugins/empty/skills/hidden', 'hidden');
    await skill('plugins/flat/rogue', 'rogue');
    await writeFile(join(marketplace, 'plugins/custom/plugin.json'), JSON.stringify({ name: 'custom', skills: './library/' }));
    await writeFile(join(marketplace, 'plugins/empty/plugin.json'), JSON.stringify({ name: 'empty', skills: [] }));
    await writeFile(join(marketplace, '.claude-plugin', 'marketplace.json'), JSON.stringify({
      name: 'inventory-fixture', description: 'Inventory fixture', plugins: [
        { name: 'default', description: 'Default skills', source: './plugins/default', skills: './skills/' },
        { name: 'custom', description: 'Custom skills', source: './plugins/custom', skills: './skills/' },
        { name: 'empty', description: 'Empty skills', source: './plugins/empty', skills: './skills/' },
        { name: 'flat', description: 'Native boundary', source: './plugins/flat', skills: './rogue/' },
      ],
    }));
    expect((await addMarketplace(marketplace, 'inventory-fixture', undefined, { scope: 'project', workspacePath: workspace })).success).toBe(true);
    resetFetchCache();
    seedFetchCache(source, marketplace);
    setJsonMode(true);
  });

  afterEach(async () => {
    setJsonMode(false);
    resetFetchCache();
    restore();
    await rm(root, { recursive: true, force: true });
  });

  it('lists manifest-selected/default names without raw declared paths or internal metadata', async () => {
    const manifestPath = join(marketplace, '.claude-plugin', 'marketplace.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.plugins.push({ name: 'uncached', description: 'Unknown inventory', source: { source: 'github', repo: 'fixtures/uncached-inventory' }, skills: './phantom/' });
    await writeFile(manifestPath, JSON.stringify(manifest));
    await run(skillsCmd, ['add', '--from', source, '--list']);
    const result = JSON.parse(output.at(-1)!);
    expect(result).toEqual({ success: true, command: 'skill add', data: { source, isMarketplace: true, skills: [
      { name: 'actual', description: 'actual description', plugin: 'default' },
      { name: 'other', description: 'other description', plugin: 'default' },
      { name: 'selected', description: 'selected description', plugin: 'custom' },
      { name: 'unselected', description: 'unselected description', plugin: 'custom' },
    ] } });
  });

  it('keeps marketplace browse JSON explicitly limited to its public fields', async () => {
    await run(pluginCmd, ['marketplace', 'browse', 'inventory-fixture']);
    expect(JSON.parse(output.at(-1)!)).toEqual({ success: true, command: 'plugin marketplace browse', data: {
      marketplace: 'inventory-fixture', total: 4, installed: 0, plugins: [
        { name: 'default', description: 'Default skills', installed: false, scope: null },
        { name: 'custom', description: 'Custom skills', installed: false, scope: null },
        { name: 'empty', description: 'Empty skills', installed: false, scope: null },
        { name: 'flat', description: 'Native boundary', installed: false, scope: null },
      ],
    } });
  });


  it('installs an actual custom name and keeps its allowlist selective', async () => {
    await run(skillsCmd, ['add', 'selected', '--from', source, '--scope', 'project', '--client', 'codex', '--yes']);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ success: true });
    const config = load(await readFile(join(workspace, '.allagents', 'workspace.yaml'), 'utf8')) as { plugins: Array<{ source: string; skills: string[] }> };
    expect(config.plugins).toHaveLength(1);
    expect(config.plugins[0]).toMatchObject({ source: 'custom@inventory-fixture', skills: ['selected'] });
    expect(await readdir(join(workspace, '.codex', 'skills'))).toEqual(['selected']);
    expect(await readFile(join(workspace, '.codex', 'skills', 'selected', 'SKILL.md'), 'utf8')).toContain('selected description');
  });

  it('installs all discovered names rather than basenames of trailing-slash declarations', async () => {
    await run(skillsCmd, ['add', '--from', source, '--all', '--scope', 'project', '--client', 'codex', '--yes']);
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ success: true });
    expect((await readdir(join(workspace, '.codex', 'skills'))).sort()).toEqual(['actual', 'other', 'selected', 'unselected']);
    const config = load(await readFile(join(workspace, '.allagents', 'workspace.yaml'), 'utf8')) as { plugins: Array<{ source: string; skills: string[] }> };
    expect(config.plugins).toHaveLength(2);
    expect(config.plugins.find((plugin) => plugin.source === 'default@inventory-fixture')?.skills).toEqual(['actual', 'other']);
    expect(config.plugins.find((plugin) => plugin.source === 'custom@inventory-fixture')?.skills).toEqual(['selected', 'unselected']);
  });
});
