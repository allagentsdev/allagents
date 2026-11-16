import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { isIP } from 'node:net';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import packageJson from '../../package.json';
import { getHomeDir } from '../constants.js';
import type {
  PluginComponentPolicy,
  PluginComponents,
} from '../models/plugin-components.js';
import { assertPluginComponentPath } from './plugin-components.js';
import { excluded, exists, isRecord } from './plugin-component-utils.js';

const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const CONFIG_ENV = 'ALLAGENTS_PORTABLE_MCP';

type StdioServer = {
  type: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};
type RemoteServer = {
  type: 'streamable-http' | 'sse';
  url: string;
  headers?: Record<string, string>;
};

function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === '' ||
    (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
  );
}

function existingAncestor(path: string): string {
  let ancestor = path;
  while (!exists(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor)
      throw new Error('MCP path cannot be resolved safely');
    ancestor = parent;
  }
  return ancestor;
}

/** Resolve nonexistent tails without requiring runtime data creation during discovery. */
function canonicalPath(path: string): string {
  const ancestor = existingAncestor(path);
  return resolve(realpathSync(ancestor), relative(ancestor, path));
}

function assertContained(root: string, path: string): void {
  if (
    !within(root, path) ||
    !within(canonicalPath(root), canonicalPath(path))
  ) {
    throw new Error('MCP path is outside its permitted root');
  }
}

function expand(value: string, root: string, data: string): string {
  return value.replace(
    /\$\{PLUGIN_(ROOT|DATA)\}/g,
    (_match, variable: string) => (variable === 'ROOT' ? root : data),
  );
}

function hasControls(value: string, spaces = false): boolean {
  return [...value].some(
    (character) =>
      character.charCodeAt(0) <= (spaces ? 32 : 31) ||
      character.charCodeAt(0) === 127,
  );
}

function commandPath(root: string, command: string): string {
  if (!command || hasControls(command) || command.includes('\\'))
    throw new Error('MCP command must be one executable token');
  if (command.startsWith('./')) {
    const path = resolve(root, command);
    assertContained(root, path);
    return path;
  }
  if (command.includes('/') || /^[A-Za-z]:/.test(command))
    throw new Error('Bundled MCP command must start with ./');
  return command;
}

function workingDirectory(
  root: string,
  data: string,
  cwd: string | undefined,
): string {
  if (cwd === undefined) return root;
  if (
    hasControls(cwd) ||
    cwd.includes('\\') ||
    !/^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/.test(cwd)
  ) {
    throw new Error('MCP cwd must be relative to PLUGIN_ROOT or PLUGIN_DATA');
  }
  const target = resolve(root, expand(cwd, root, data));
  assertContained(cwd.startsWith(`\${PLUGIN_DATA}`) ? data : root, target);
  return target;
}

function stringMap(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  );
}

function validateServer(
  value: unknown,
  root: string,
  data: string,
): StdioServer | RemoteServer {
  if (!isRecord(value)) throw new Error('server must be an object');
  if (value.type === 'stdio') {
    if (
      Object.keys(value).some(
        (key) => !['type', 'command', 'args', 'env', 'cwd'].includes(key),
      ) ||
      typeof value.command !== 'string'
    ) {
      throw new Error('stdio server has invalid fields');
    }
    if (
      Object.hasOwn(value, 'args') &&
      (!Array.isArray(value.args) ||
        value.args.some((argument) => typeof argument !== 'string'))
    ) {
      throw new Error('stdio args must be an array of strings');
    }
    if (Object.hasOwn(value, 'env') && !stringMap(value.env))
      throw new Error('stdio env must map strings to strings');
    if (Object.hasOwn(value, 'cwd') && typeof value.cwd !== 'string')
      throw new Error('stdio cwd must be a string');
    const server = value as StdioServer;
    if (
      Object.keys(server.env ?? {}).some(
        (key) =>
          (process.platform === 'win32' ? key.toUpperCase() : key) ===
            'PLUGIN_ROOT' ||
          (process.platform === 'win32' ? key.toUpperCase() : key) ===
            'PLUGIN_DATA',
      )
    ) {
      throw new Error(
        'stdio env cannot override reserved PLUGIN_ROOT or PLUGIN_DATA',
      );
    }
    commandPath(root, server.command);
    workingDirectory(root, data, server.cwd);
    return server;
  }
  if (value.type !== 'streamable-http' && value.type !== 'sse')
    throw new Error('server type is unsupported');
  if (
    Object.keys(value).some(
      (key) => !['type', 'url', 'headers'].includes(key),
    ) ||
    typeof value.url !== 'string' ||
    !value.url
  ) {
    throw new Error('remote server has invalid fields');
  }
  if (Object.hasOwn(value, 'headers') && !stringMap(value.headers))
    throw new Error('remote headers must map strings to strings');
  let url: URL;
  try {
    if (hasControls(value.url, true) || !/^https?:\/\//i.test(value.url))
      throw new Error('invalid URL characters');
    url = new URL(value.url);
  } catch {
    throw new Error('remote URL must be an absolute HTTP(S) URL');
  }
  const authority =
    value.url.slice(value.url.indexOf('//') + 2).split(/[/?#]/)[0] ?? '';
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    authority.includes('@') ||
    url.username ||
    url.password ||
    url.hash ||
    value.url.includes('#')
  ) {
    throw new Error(
      'remote URL must use HTTP(S) without userinfo or a fragment',
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback =
    host === 'localhost' ||
    (isIP(host) === 4 && host.split('.')[0] === '127') ||
    (isIP(host) === 6 && host === '::1');
  if (url.protocol === 'http:' && !loopback)
    throw new Error('HTTP is supported only for loopback hosts');
  const seen = new Set<string>();
  for (const [name, header] of Object.entries(value.headers ?? {})) {
    if (seen.has(name.toLowerCase()))
      throw new Error('remote headers contain duplicate names');
    seen.add(name.toLowerCase());
    try {
      validateHeaderName(name);
      validateHeaderValue(name, header);
    } catch {
      throw new Error('remote headers contain an invalid HTTP field');
    }
  }
  return value as RemoteServer;
}

// A static, dependency-free launcher keeps portable values opaque to host-specific
// interpolation and serializers. Only the base64 configuration travels in env.
const PORTABLE_MCP_LAUNCHER = `
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
function within(root, candidate) {
  const suffix = path.relative(root, candidate);
  return suffix === '' || (!path.isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + path.sep));
}
function canonical(candidate) {
  let ancestor = candidate;
  function exists(value) {
    try { fs.lstatSync(value); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  while (!exists(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('MCP path cannot be resolved safely');
    ancestor = parent;
  }
  return path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, candidate));
}
function contained(root, candidate) {
  if (!within(root, candidate) || !within(canonical(root), canonical(candidate))) throw new Error('MCP path is outside its permitted root');
}
function expand(value, root, data) {
  return value.replace(/[$][{]PLUGIN_(ROOT|DATA)[}]/g, (_, variable) => variable === 'ROOT' ? root : data);
}
try {
  const config = JSON.parse(Buffer.from(process.env.ALLAGENTS_PORTABLE_MCP, 'base64').toString('utf8'));
  const server = config.server;
  const env = Object.assign(Object.create(null), process.env);
  delete env.ALLAGENTS_PORTABLE_MCP;
  let command, args, cwd;
  if (server.type === 'stdio') {
    const root = config.root, data = config.data;
    if (fs.realpathSync(root) !== root) throw new Error('Plugin root changed outside its resolved location');
    command = server.command.startsWith('./') ? path.resolve(root, server.command) : server.command;
    if (server.command.startsWith('./')) contained(root, command);
    cwd = server.cwd === undefined ? root : path.resolve(root, expand(server.cwd, root, data));
    const cwdRoot = server.cwd && server.cwd.startsWith('$' + '{PLUGIN_DATA}') ? data : root;
    contained(cwdRoot, cwd);
    fs.mkdirSync(data, {recursive: true});
    if (!fs.statSync(data).isDirectory()) throw new Error('PLUGIN_DATA must be a directory');
    fs.accessSync(data, fs.constants.W_OK);
    contained(cwdRoot, cwd);
    args = (server.args || []).map(value => expand(value, root, data));
    for (const [name, value] of Object.entries(server.env || {})) env[name] = expand(value, root, data);
    for (const name of Object.keys(env)) {
      const identity = process.platform === 'win32' ? name.toUpperCase() : name;
      if (identity === 'PLUGIN_ROOT' || identity === 'PLUGIN_DATA') delete env[name];
    }
    env.PLUGIN_ROOT = root;
    env.PLUGIN_DATA = data;
  } else {
    command = 'npx';
    const reserved = new Set();
    for (const match of JSON.stringify(server).matchAll(/[$][{]([A-Za-z_][A-Za-z0-9_]*)[}]/g)) reserved.add(match[1]);
    function bind(value, preferred) {
      let name = preferred, suffix = 2;
      while (reserved.has(name)) name = preferred + '_' + suffix++;
      reserved.add(name);
      env[name] = value;
      return name;
    }
    const urlVariable = bind(server.url, 'ALLAGENTS_PORTABLE_URL');
    env.ALLAGENTS_PORTABLE_LITERAL_URL = urlVariable;
    args = ['-y', 'allagents@' + config.version, 'mcp', 'proxy', '$' + '{' + urlVariable + '}', '--connection-config', JSON.stringify({transportStrategy: server.type === 'sse' ? 'sse-only' : 'http-only', protocol: 'auto'})];
    let index = 0;
    for (const [name, value] of Object.entries(server.headers || {})) {
      const variable = bind(value, 'ALLAGENTS_PORTABLE_HEADER_' + index++);
      args.push('--header-env', name + '=' + variable);
    }
    if (process.platform === 'win32') {
      const pathKey = Object.keys(env).find(name => name.toUpperCase() === 'PATH');
      const directories = [...(env[pathKey] || '').split(path.delimiter), path.dirname(process.execPath)];
      const cli = directories.filter(Boolean).map(directory => {
        const shim = path.join(directory, 'npx.cmd');
        const candidate = path.join(directory, 'node_modules', 'npm', 'bin', 'npx-cli.js');
        return fs.existsSync(shim) && fs.existsSync(candidate) && fs.statSync(candidate).isFile() ? candidate : undefined;
      }).find(Boolean);
      if (!cli) throw new Error('Portable remote MCP requires npm with node_modules/npm/bin/npx-cli.js on PATH');
      command = process.execPath;
      args.unshift(cli);
    }
  }
  const child = spawn(command, args, {env, cwd, shell: false, stdio: 'inherit'});
  const handlers = new Map();
  let shutdown;
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const handler = () => {
      child.kill(signal);
      shutdown ??= setTimeout(() => child.kill('SIGKILL'), 1000);
      shutdown.unref();
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  child.on('error', error => { console.error('Portable MCP startup failed: ' + error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    clearTimeout(shutdown);
    for (const [name, handler] of handlers) process.removeListener(name, handler);
    if (signal) { try { process.kill(process.pid, signal); } catch { process.exitCode = 1; } }
    else process.exitCode = code === null ? 1 : code;
  });
} catch (error) {
  console.error('Portable MCP startup failed: ' + error.message);
  process.exitCode = 1;
}
`;

type McpComponents = Pick<PluginComponents, 'mcpServers' | 'mcpError'>;

export function resolvePortableMcp(
  root: string,
  name: string,
  policy: PluginComponentPolicy,
  warnings: string[],
): McpComponents {
  const path = join(root, 'mcp.json');
  if (excluded(root, path, policy.exclude)) return { mcpServers: [] };
  let value: unknown;
  try {
    assertPluginComponentPath(root, path, policy.exclude);
    if (!exists(path)) return { mcpServers: [] };
    if (!statSync(path).isFile())
      throw new Error('mcp.json must be a regular file');
    value = JSON.parse(readFileSync(path, 'utf8'));
    if (
      !isRecord(value) ||
      value.$schema !== MCP_SCHEMA ||
      !isRecord(value.mcpServers) ||
      Object.keys(value).some((key) => !['$schema', 'mcpServers'].includes(key))
    ) {
      throw new Error(
        'mcp.json requires the supported Agent Plugins 1.0.0 schema and an mcpServers object',
      );
    }
  } catch {
    const mcpError =
      'Portable MCP configuration was disabled because mcp.json is unreadable, unsafe or invalid';
    warnings.push(mcpError);
    return { mcpServers: [], mcpError };
  }
  const canonicalRoot = realpathSync(root);
  const digest = createHash('sha256')
    .update(canonicalRoot)
    .digest('hex')
    .slice(0, 20);
  const data = resolve(
    getHomeDir(),
    '.allagents',
    'plugins',
    'data',
    `${name}-${digest}`,
  );
  const servers: Record<string, unknown> = Object.create(null);
  for (const [serverName, candidate] of Object.entries(
    (value as { mcpServers: Record<string, unknown> }).mcpServers,
  )) {
    try {
      const server = validateServer(candidate, canonicalRoot, data);
      const encoded = Buffer.from(
        JSON.stringify({
          root: canonicalRoot,
          data,
          server,
          version: packageJson.version,
        }),
      ).toString('base64');
      servers[serverName] = {
        command: 'node',
        args: ['-e', PORTABLE_MCP_LAUNCHER],
        env: { [CONFIG_ENV]: encoded },
      };
    } catch (error) {
      warnings.push(
        `Portable MCP server '${serverName}' was skipped: ${error instanceof Error ? error.message : 'invalid server'}`,
      );
    }
  }
  return { mcpServers: [{ inline: servers, declaredIn: path }] };
}
