import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { resolvePortablePlugin } from '../../../src/core/portable-plugin.js';
import { resolveMcpOAuthServerUrl } from '../../../src/core/mcp-oauth-url.js';
import { resolveMcpHeaderReferences } from '../../../src/core/mcp-http-client.js';

const MANIFEST_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
let directory: string;
let root: string;
let previousHome: string | undefined;

function file(path: string, value: string | object): void {
  const target = join(root, path);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value));
}

function manifest(extra: Record<string, unknown> = {}): void {
  file('plugin.json', { $schema: MANIFEST_SCHEMA, name: 'portable.example', ...extra });
}

function skill(name: string, metadata = `name: ${name}\ndescription: Useful skill`): void {
  file(`skills/${name}/SKILL.md`, `---\n${metadata}\n---\n# Skill\n`);
}

function mcp(mcpServers: Record<string, unknown>): void {
  file('mcp.json', { $schema: MCP_SCHEMA, mcpServers });
}

type Launcher = { command: string; args: string[]; env: Record<string, string> };

function launcher(name = 'probe'): Launcher {
  const servers = resolvePortablePlugin(root).mcpServers[0]?.inline;
  return servers?.[name] as Launcher;
}

function run(config: Launcher, environment: Record<string, string> = {}) {
  return spawnSync(config.command, config.args, {
    env: { ...process.env, ...config.env, ...environment },
    encoding: 'utf8',
    timeout: 10000,
  });
}

function probe(): string {
  const name = process.platform === 'win32' ? 'bin/probe.exe' : 'bin/probe';
  const node = spawnSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).stdout.trim();
  mkdirSync(join(root, 'bin'));
  try { linkSync(node, join(root, name)); }
  catch { copyFileSync(node, join(root, name)); }
  file('probe.cjs', `
const fs = require('node:fs');
const path = require('node:path');
const data = process.env.PLUGIN_DATA;
const sentinel = path.join(data, 'sentinel');
const existed = fs.existsSync(sentinel);
fs.writeFileSync(sentinel, 'persisted');
console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),root:process.env.PLUGIN_ROOT,data,existed,env:process.env.LITERAL}));
`);
  return `./${name}`;
}

function fakeNpx(): string {
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const source = "console.log(JSON.stringify({args:process.argv.slice(2),env:process.env}));\n";
  if (process.platform === 'win32') {
    const scripts = join(bin, 'node_modules/npm/bin');
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, 'npx-cli.js'), source);
    writeFileSync(join(bin, 'npx.cmd'), '@echo off\r\n');
  } else {
    writeFileSync(join(bin, 'npx'), `#!/usr/bin/env node\n${source}`);
    chmodSync(join(bin, 'npx'), 0o755);
  }
  return bin;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'portable-plugin-'));
  root = join(directory, 'plugin');
  mkdirSync(root);
  previousHome = process.env.ALLAGENTS_TEST_HOME;
  process.env.ALLAGENTS_TEST_HOME = join(directory, 'home');
  manifest();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.ALLAGENTS_TEST_HOME;
  else process.env.ALLAGENTS_TEST_HOME = previousHome;
  rmSync(directory, { recursive: true, force: true });
});

describe('portable manifest and component boundaries', () => {
  test('accepts schema metadata types without imposing semver, URL or SPDX rules', () => {
    manifest({ version: 'next build', homepage: 'not a URL', repository: 'source', license: 'custom', author: { email: 'local' }, keywords: ['a'] });
    expect(resolvePortablePlugin(root)).toMatchObject({ format: 'portable', skills: [], commands: [], agents: [], hooks: [], github: false, legacyRepository: false });
  });

  test.each([{ $schema: undefined }, { $schema: 'https://agent-plugins.org/schemas/2/plugin.schema.json' }, { name: 'bad--name' }, { name: 'Uppercase' }, { version: 1 }, { author: { unexpected: 'x' } }, { keywords: [false] }])('rejects invalid known manifest fields: %j', (extra) => {
    manifest(extra);
    expect(() => resolvePortablePlugin(root)).toThrow();
  });

  test('warns and ignores unknown fields and nonobject extensions; unknown namespaces are opaque', () => {
    manifest({ mystery: { skills: 'elsewhere' }, extensions: false });
    expect(resolvePortablePlugin(root).warnings).toHaveLength(2);
    manifest({ extensions: { 'example.unimplemented': false } });
    expect(resolvePortablePlugin(root).warnings ?? []).toEqual([]);
  });

  test('loads immediate valid child skills and resources without native or recursive discovery', () => {
    skill('good');
    skill('bad', 'name: mismatch\ndescription: invalid');
    skill('broken-yaml', 'name: [');
    file('skills/good/scripts/example.txt', 'support');
    file('skills/nested/deeper/SKILL.md', '---\nname: deeper\ndescription: nested\n---');
    file('SKILL.md', 'root');
    file('commands/run.md', 'native');
    file('.github/skills/native/SKILL.md', 'native');
    const result = resolvePortablePlugin(root);
    expect(result.skills).toEqual([join(root, 'skills/good')]);
    expect(readFileSync(join(result.skills[0]!, 'scripts/example.txt'), 'utf8')).toBe('support');
    expect(result.commands).toEqual([]);
    expect(result.warnings?.join(' ')).toContain('bad');
  });

  test('isolates a wrong skills directory kind from MCP', () => {
    file('skills', 'wrong kind');
    mcp({ valid: { type: 'stdio', command: 'node' } });
    const result = resolvePortablePlugin(root);
    expect(result.skills).toEqual([]);
    expect(Object.keys(result.mcpServers[0]!.inline!)).toEqual(['valid']);
    expect(result.warnings?.join(' ')).toContain('skills');
  });

  test('honors plugin-relative exclusions before reading excluded symlinks and resources', () => {
    skill('kept');
    skill('excluded');
    symlinkSync(directory, join(root, 'skills/kept/excluded-resource'));
    mcp({ valid: { type: 'stdio', command: 'node' } });
    const result = resolvePortablePlugin(root, { exclude: ['skills/excluded', 'skills/kept/excluded-resource', 'mcp.json'] });
    expect(result.skills).toEqual([join(root, 'skills/kept')]);
    expect(result.mcpServers).toEqual([]);
  });

  test('rejects escaping manifest, skips escaping skill trees and accepts contained symlinks', () => {
    skill('good');
    file('actual.md', '---\nname: linked\ndescription: contained\n---');
    mkdirSync(join(root, 'skills/linked'));
    symlinkSync(join(root, 'actual.md'), join(root, 'skills/linked/SKILL.md'));
    mkdirSync(join(root, 'skills/escaped'));
    symlinkSync(join(directory, 'outside.md'), join(root, 'skills/escaped/SKILL.md'));
    writeFileSync(join(directory, 'outside.md'), 'outside');
    symlinkSync(directory, join(root, 'skills/good/unsafe'));
    expect(resolvePortablePlugin(root).skills).toEqual([join(root, 'skills/linked')]);
    rmSync(join(root, 'plugin.json'));
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ $schema: MANIFEST_SCHEMA, name: 'outside' }));
    symlinkSync(join(directory, 'manifest.json'), join(root, 'plugin.json'));
    expect(() => resolvePortablePlugin(root)).toThrow(/outside/);
  });

  test('retains lexical component paths when the plugin root is a contained source alias', () => {
    skill('good');
    const alias = join(directory, 'alias');
    symlinkSync(root, alias);
    expect(resolvePortablePlugin(alias).skills).toEqual([join(alias, 'skills/good')]);
  });

  test.each(['compatibility: []', 'metadata: { count: 2 }', 'license: []', 'allowed-tools: []'])('skips invalid optional skill metadata: %s', (metadata) => {
    skill('bad', `name: bad\ndescription: useful\n${metadata}`);
    expect(resolvePortablePlugin(root).skills).toEqual([]);
    expect(resolvePortablePlugin(root).warnings?.join(' ')).toContain('bad');
  });
});

describe('portable MCP isolation and validation', () => {
  test.each(['{bad', JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: {}, unknown: true }), JSON.stringify({ $schema: MANIFEST_SCHEMA, mcpServers: {} }), JSON.stringify({ $schema: MCP_SCHEMA, mcpServers: [] })])('disables invalid MCP documents while retaining skills: %s', (document) => {
    skill('good');
    file('mcp.json', document);
    const result = resolvePortablePlugin(root);
    expect(result.skills).toEqual([join(root, 'skills/good')]);
    expect(result.mcpServers).toEqual([]);
    expect(result.warnings?.join(' ')).toContain('MCP');
    expect(result.mcpError).toContain('MCP');
  });

  test('accepts an empty server map and retains root MCP provenance', () => {
    mcp({});
    expect(resolvePortablePlugin(root).mcpServers).toEqual([{ inline: {}, declaredIn: join(root, 'mcp.json') }]);
  });

  test('skips invalid entries and native MCP while preserving valid siblings', () => {
    mcp({ valid: { type: 'stdio', command: 'node' }, unknown: { type: 'other', command: 'node' }, mixed: { type: 'stdio', command: 'node', url: 'https://example.com' }, badargs: { type: 'stdio', command: 'node', args: [1] }, reserved: { type: 'stdio', command: 'node', env: { PLUGIN_ROOT: 'override' } }, nullish: null });
    file('.mcp.json', { mcpServers: { native: { command: 'native' } } });
    expect(Object.keys(resolvePortablePlugin(root).mcpServers[0]!.inline!)).toEqual(['valid']);
  });

  test('rejects package path escapes per server while keeping args opaque', () => {
    symlinkSync(directory, join(root, 'escape'));
    mcp({ valid: { type: 'stdio', command: 'node', args: ['../opaque'] }, command: { type: 'stdio', command: './escape/tool' }, cwd: { type: 'stdio', command: 'node', cwd: './escape' }, parent: { type: 'stdio', command: '../tool' }, absolute: { type: 'stdio', command: '/bin/node' }, confused: { type: 'stdio', command: 'node', cwd: '${PLUGIN_ROOT}suffix' }, parentCwd: { type: 'stdio', command: 'node', cwd: './..' } });
    expect(Object.keys(resolvePortablePlugin(root).mcpServers[0]!.inline!)).toEqual(['valid']);
  });

  test('validates remote URL and HTTP header semantics per server', () => {
    mcp({ http: { type: 'streamable-http', url: 'http://127.0.0.1:3000/mcp' }, ipv6: { type: 'sse', url: 'http://[::1]:3000/sse' }, tls: { type: 'streamable-http', url: 'https://example.com/mcp', headers: { Authorization: '${LITERAL}' } }, insecure: { type: 'sse', url: 'http://example.com/mcp' }, userinfo: { type: 'sse', url: 'https://user:pass@example.com/' }, fragment: { type: 'sse', url: 'https://example.com/#x' }, duplicate: { type: 'sse', url: 'https://example.com/', headers: { Accept: 'a', accept: 'b' } }, control: { type: 'sse', url: 'https://example.com/', headers: { A: 'a\nb' } }, name: { type: 'sse', url: 'https://example.com/', headers: { 'invalid name': 'x' } } });
    expect(Object.keys(resolvePortablePlugin(root).mcpServers[0]!.inline!)).toEqual(['http', 'ipv6', 'tls']);
  });
});

describe('portable MCP launcher', () => {
  test('runs a bundled executable from its root with exact argv and single-pass expansion', () => {
    const command = probe();
    mcp({ probe: { type: 'stdio', command, args: ['${PLUGIN_ROOT}/probe.cjs', 'one argument', '${PLUGIN_ROOT}/${PLUGIN_ROOT}', '${UNRESOLVED}'], env: { LITERAL: '${PLUGIN_ROOT}|${PLUGIN_DATA}|${UNRESOLVED}' } } });
    const config = launcher();
    expect(existsSync(join(directory, 'home'))).toBe(false);
    const result = run(config, { UNRESOLVED: 'must remain literal', PLUGIN_ROOT: 'wrong', PLUGIN_DATA: 'wrong' });
    expect(result.status).toBe(0);
    const observed = JSON.parse(result.stdout);
    expect(observed.args).toEqual(['one argument', `${root}/${root}`, '${UNRESOLVED}']);
    expect(observed.cwd).toBe(root);
    expect(observed.root).toBe(root);
    expect(observed.data.startsWith(join(directory, 'home/.allagents/plugins/data/'))).toBe(true);
    expect(observed.env).toBe(`${root}|${observed.data}|\${UNRESOLVED}`);
    expect(config.args.join(' ')).not.toContain(root);
  });

  test('uses explicit data cwd and persistent writable data across plugin updates', () => {
    const command = probe();
    mcp({ probe: { type: 'stdio', command, args: ['${PLUGIN_ROOT}/probe.cjs'], cwd: '${PLUGIN_DATA}' } });
    const first = JSON.parse(run(launcher()).stdout);
    expect(first.cwd).toBe(first.data);
    expect(first.existed).toBe(false);
    manifest({ version: 'replacement' });
    const second = JSON.parse(run(launcher()).stdout);
    expect(second.data).toBe(first.data);
    expect(second.existed).toBe(true);
  });

  test('rechecks containment if a bundled executable changes to an escaping symlink after resolution', () => {
    const command = probe();
    mcp({ probe: { type: 'stdio', command } });
    const config = launcher();
    rmSync(join(root, command));
    symlinkSync(process.execPath, join(root, command));
    const result = run(config);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('outside');
  });

  test('preserves literal URL/headers and declared remote transport through the shared proxy', () => {
    const bin = fakeNpx();
    mcp({ probe: { type: 'streamable-http', url: 'https://example.com/${URL_LITERAL}?token=private', headers: { Authorization: '${HEADER_LITERAL}' } } });
    const config = launcher();
    expect(config.args.join(' ')).not.toContain('private');
    expect(config.args.join(' ')).not.toContain('HEADER_LITERAL');
    const result = run(config, { PATH: `${bin}${delimiter}${process.env.PATH}`, URL_LITERAL: 'wrong', HEADER_LITERAL: 'wrong' });
    expect(result.status).toBe(0);
    const observed = JSON.parse(result.stdout);
    expect(observed.args.slice(2, 5)).toEqual(['mcp', 'proxy', '${ALLAGENTS_PORTABLE_URL}']);
    expect(JSON.parse(observed.args[observed.args.indexOf('--connection-config') + 1])).toEqual({ transportStrategy: 'http-only', protocol: 'auto' });
    expect(observed.args).toContain('Authorization=ALLAGENTS_PORTABLE_HEADER_0');
    expect(observed.env.ALLAGENTS_PORTABLE_URL).toBe('https://example.com/${URL_LITERAL}?token=private');
    expect(observed.env.ALLAGENTS_PORTABLE_HEADER_0).toBe('${HEADER_LITERAL}');
    expect(existsSync(join(directory, 'home'))).toBe(false);
    mcp({ probe: { type: 'sse', url: 'https://example.com/sse' } });
    const legacy = JSON.parse(run(launcher(), { PATH: `${bin}${delimiter}${process.env.PATH}` }).stdout);
    expect(JSON.parse(legacy.args[legacy.args.indexOf('--connection-config') + 1]).transportStrategy).toBe('sse-only');
  });

  test('keeps query references literal across the actual shared URL resolver, including generated binding collisions', () => {
    const bin = fakeNpx();
    mcp({ probe: { type: 'streamable-http', url: 'https://example.com/mcp?literal=${URL_LITERAL}&collision=${ALLAGENTS_PORTABLE_URL}&header=${ALLAGENTS_PORTABLE_HEADER_0}&path=${PATH}&options=${NODE_OPTIONS}', headers: { Authorization: '${HEADER_LITERAL}' } } });
    const result = run(launcher(), { PATH: `${bin}${delimiter}${process.env.PATH}`, URL_LITERAL: 'wrong', HEADER_LITERAL: 'wrong' });
    expect(result.status).toBe(0);
    const observed = JSON.parse(result.stdout);
    const url = new URL(resolveMcpOAuthServerUrl(observed.args[4], observed.env));
    expect(url.searchParams.get('literal')).toBe('${URL_LITERAL}');
    expect(url.searchParams.get('collision')).toBe('${ALLAGENTS_PORTABLE_URL}');
    expect(url.searchParams.get('header')).toBe('${ALLAGENTS_PORTABLE_HEADER_0}');
    expect(url.searchParams.get('path')).toBe('${PATH}');
    expect(url.searchParams.get('options')).toBe('${NODE_OPTIONS}');
    const binding = observed.args[observed.args.indexOf('--header-env') + 1].split('=')[1];
    expect(resolveMcpHeaderReferences({ Authorization: `\${${binding}}` }, observed.env).Authorization).toBe('${HEADER_LITERAL}');
  });

  test.skipIf(process.platform !== 'win32')('uses the npm JavaScript entry point for Windows remote launch without invoking a batch shell', () => {
    const bin = fakeNpx();
    mcp({ probe: { type: 'sse', url: 'https://example.com/mcp' } });
    const result = run(launcher(), { PATH: `${bin}${delimiter}${process.env.PATH}` });
    expect(result.status).toBe(0);
    const observed = JSON.parse(result.stdout);
    expect(observed.args.slice(2, 5)).toEqual(['mcp', 'proxy', '${ALLAGENTS_PORTABLE_URL}']);
  });
});
