import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const repoRoot = join(import.meta.dir, '../..');
const cli = join(repoRoot, 'dist/index.js');
const skill = '---\nname: Display Name_with spaces\ndescription: A supported skill\n---\n# Instructions\n';

describe('plugin validate', () => {
  let root: string;
  let project: string;
  let home: string;

  beforeAll(() => {
    const build = Bun.spawnSync(['bun', 'run', 'build'], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
    });
    if (build.exitCode !== 0) throw new Error(`CLI build failed: ${build.stderr.toString()}`);
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'allagents-plugin-validate-'));
    project = join(root, 'project');
    home = join(root, 'home');
    mkdirSync(project);
    mkdirSync(home);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function file(path: string, contents: string) {
    const target = join(project, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }

  function run(path: string, flag = '--json') {
    const proc = Bun.spawnSync(['node', cli, 'plugin', 'validate', path, ...(flag ? [flag] : [])], {
      cwd: project,
      env: { ...process.env, HOME: home, ALLAGENTS_TEST_HOME: home, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' },
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    return { status: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  }

  test.each(['skills/group/example', 'collection/group/example', '.'])('accepts supported skill layout %s', (directory) => {
    file(`plugin/${directory}/SKILL.md`, skill);
    file(`plugin/${directory}/scripts/unused.sh`, 'exit 99\n');
    const result = run('./plugin');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: true, command: 'plugin validate', data: { path: './plugin', valid: true },
    });
  });

  test.each(['commands/example.md', 'agents/example.md', 'hooks/example.sh', '.github/instructions/example.md', '.mcp.json'])('accepts conventional non-skill resource %s without requiring a manifest', (resource) => {
    file(`plugin/${resource}`, resource.endsWith('.json') ? '{}' : 'Plugin resource\n');
    expect(run('./plugin').status).toBe(0);
  });

  test.each(['.mcp.json', 'hooks.json', 'hooks/hooks.json', '.codex/hooks.json'])('rejects malformed declaration %s', (declaration) => {
    file(`plugin/${declaration}`, '{broken');
    for (const flag of ['--json', '']) {
      const result = run('./plugin', flag);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe('');
      if (flag) expect(JSON.parse(result.stdout).data.validation.diagnostics).toContainEqual(expect.objectContaining({ severity: 'error', path: declaration }));
      else expect(result.stdout).toContain(`Error: ${declaration}:`);
    }
  });

  test.each(['.mcp.json', 'hooks.json', 'hooks/hooks.json', '.codex/hooks.json'])('requires an object container in declaration %s', (declaration) => {
    file(`plugin/${declaration}`, '[]');
    expect(run('./plugin').status).toBe(1);
  });

  test('accepts comments and trailing commas in MCP JSON5 declarations', () => {
    file('plugin/.mcp.json', '{\n// User comments are supported\nmcpServers: { example: { command: "not-executed", }, },\n}');
    const result = run('./plugin');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).data.valid).toBe(true);
  });

  test('rejects an unreadable linked declaration even when other plugin resources are valid', () => {
    file('plugin/SKILL.md', skill);
    symlinkSync(join(project, 'missing.json'), join(project, 'plugin/.mcp.json'));
    const result = run('./plugin');
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).data.validation.diagnostics).toContainEqual(expect.objectContaining({ severity: 'error', path: '.mcp.json' }));
  });

  test.each(['hooks.json', 'hooks/hooks.json'])('requires strict JSON in hook declaration %s', (declaration) => {
    file(`plugin/${declaration}`, '{ "hooks": {}, }');
    expect(run('./plugin').status).toBe(1);
  });

  test.each(['hooks.json', 'hooks/hooks.json'])('accepts hook declaration %s without executing commands', (declaration) => {
    file(`plugin/${declaration}`, '{"version":1,"hooks":{"sessionStart":[{"command":"touch executed"}]}}');
    expect(run('./plugin').status).toBe(0);
    expect(readdirSync(project)).toEqual(['plugin']);
  });

  test('accepts an explicitly marked Pi package without executing its extension', () => {
    file('plugin/package.json', '{"name":"example","pi":{"extensions":["./index.ts"]}}');
    file('plugin/index.ts', 'throw new Error("must not execute");\n');
    expect(run('./plugin').status).toBe(0);
  });

  test.each(['extensions', 'prompts', 'themes'])('accepts manifestless Pi %s resources', (resource) => {
    mkdirSync(join(project, 'plugin', resource), { recursive: true });
    expect(run('./plugin').status).toBe(0);
    file(`plugin/${resource}/example.txt`, 'Native resource\n');
    expect(run('./plugin').status).toBe(0);
  });

  test('does not treat an ordinary Node package as a plugin', () => {
    file('plugin/package.json', '{"name":"ordinary-node-project","main":"./index.js"}');
    file('plugin/index.js', 'export default {};\n');
    expect(run('./plugin').status).toBe(1);
  });

  test('preserves a root skill with supporting prompts and an unnamed sidecar package', () => {
    file('plugin/SKILL.md', skill);
    file('plugin/package.json', '{"private":true,"scripts":{"prepare":"touch executed"}}');
    file('plugin/prompts/review.md', '# Supporting prompt\n');
    const result = run('./plugin');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({ valid: true, validation: { skills: 1, diagnostics: [] } });
    expect(readdirSync(project)).toEqual(['plugin']);
  });

  test('requires a named JSON manifest when Pi resources have package metadata', () => {
    file('plugin/extensions/example.ts', 'throw new Error("must not execute");\n');
    for (const contents of ['{broken', '[]', '{"pi":{}}']) {
      file('plugin/package.json', contents);
      const result = run('./plugin');
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout).data.validation.diagnostics).toContainEqual(expect.objectContaining({ severity: 'error', path: 'package.json' }));
    }
  });

  test('accepts linked command files without traversing linked directories', () => {
    file('external/review.md', '# Review instructions\n');
    mkdirSync(join(project, 'plugin/commands'), { recursive: true });
    symlinkSync(join(project, 'external/review.md'), join(project, 'plugin/commands/review.md'));
    expect(run('./plugin').status).toBe(0);
    rmSync(join(project, 'plugin/commands/review.md'));
    symlinkSync(join(project, 'external'), join(project, 'plugin/commands/linked-directory'));
    symlinkSync(join(project, 'plugin/commands'), join(project, 'plugin/commands/loop'));
    expect(run('./plugin').status).toBe(1);
  });

  test.each(['---\nname: missing-description\n---\n', '---\nname: [broken\n---\n', '# Missing metadata\n'])('rejects malformed recognized skills with relative locations', (contents) => {
    file('plugin/skills/group/broken/SKILL.md', contents);
    const result = run('./plugin');
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      success: false, command: 'plugin validate', data: {
        path: './plugin', valid: false,
        validation: { diagnostics: [expect.objectContaining({ severity: 'error', path: 'skills/group/broken/SKILL.md' })] },
      },
    });
    expect(result.stdout).not.toContain(project);
  });

  test.each(['.claude-plugin/plugin.json', '.github/plugin/plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/marketplace.json', '.github/plugin/marketplace.json'])('rejects malformed manifest %s', (manifest) => {
    file(`plugin/${manifest}`, '{bad json');
    expect(run('./plugin').status).toBe(1);
  });

  test.each(['[]', 'null'])('rejects non-object plugin manifests %s', (contents) => {
    file('plugin/.claude-plugin/plugin.json', contents);
    const result = run('./plugin');
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).data.validation.diagnostics).toEqual([
      { severity: 'error', path: '.claude-plugin/plugin.json', message: 'Plugin manifest must be a JSON object' },
    ]);
  });

  test('accepts a standalone plugin manifest without imposing client-specific fields', () => {
    file('plugin/.claude-plugin/plugin.json', JSON.stringify({ name: 'example', custom: true }));
    expect(run('./plugin').status).toBe(0);
  });

  test('rejects a marketplace manifest without a plugins array', () => {
    file('plugin/.claude-plugin/marketplace.json', '{"name":"example"}');
    const result = run('./plugin');
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).data.validation.diagnostics).toEqual([
      { severity: 'error', path: '.claude-plugin/marketplace.json', message: 'Marketplace manifest must contain a "plugins" array' },
    ]);
  });

  test('uses installation skill and marketplace precedence', () => {
    file('plugin/skills/example/SKILL.md', skill);
    file('plugin/SKILL.md', '# Ignored when skills/ exists');
    file('plugin/.github/plugin/marketplace.json', JSON.stringify({ name: 'example', description: 'Example', plugins: [] }));
    file('plugin/.claude-plugin/marketplace.json', '{ignored malformed fallback');
    const result = run('./plugin');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).data.validation).toEqual({ skills: 1, diagnostics: [] });
  });

  test('uses marketplace parser warnings without rejecting supported lenient manifests', () => {
    file('plugin/.claude-plugin/marketplace.json', JSON.stringify({ plugins: [{ name: 'example', source: './' }] }));
    const result = run('./plugin');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).data.validation.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'warning', path: '.claude-plugin/marketplace.json', message: expect.stringContaining('description'),
    }));
  });

  test.each(['missing', 'empty', 'unsupported', 'regular-file'])('rejects %s paths in JSON and redirected human output', (path) => {
    mkdirSync(join(project, 'empty'));
    file('unsupported/README.md', '# Not a plugin\n');
    file('regular-file', 'not a directory');
    for (const flag of ['--json', '']) {
      const result = run(`./${path}`, flag);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe('');
      if (flag) expect(JSON.parse(result.stdout)).toMatchObject({ success: false, data: { path: `./${path}`, valid: false } });
      else expect(result.stdout).toContain('Validation failed');
    }
  });

  test('preserves top-level JSON field selection with and without diagnostics', () => {
    file('plugin/SKILL.md', skill);
    for (const [path, valid] of [['./plugin', true], ['./missing', false]] as const) {
      const result = run(path, '--json=path,valid');
      expect(JSON.parse(result.stdout)).toEqual({ success: valid, command: 'plugin validate', data: { path, valid } });
    }
  });

  test('validates without running scripts or modifying plugin, project, or HOME', () => {
    file('plugin/SKILL.md', skill);
    file('plugin/package.json', JSON.stringify({ scripts: { prepare: 'touch executed' } }));
    file('plugin/hooks/example.sh', 'touch executed\n');
    const snapshot = (directory: string): unknown => readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => [
      entry.name, entry.isDirectory() ? snapshot(join(directory, entry.name)) : readFileSync(join(directory, entry.name)).toString('base64'),
    ]);
    const before = snapshot(root);
    for (const flag of ['', '--json']) {
      const result = run('./plugin', flag);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(snapshot(root)).toEqual(before);
    }
  });
});
