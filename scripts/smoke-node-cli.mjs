#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'allagents-node-smoke-'));
const repositoryPath = join(root, 'repository');
const workspacePath = join(root, 'workspace');
const homePath = join(root, 'home');
const cliPath = resolve('dist/index.js');
const stdioFixturePath = resolve('tests/helpers/mcp-runtime-stdio-server.mjs');
const stdioStatePath = join(root, 'stdio-state');
const stdioCapturePath = join(stdioStatePath, 'requests.ndjson');
const stdioEnvironmentPath = join(stdioStatePath, 'environment.ndjson');
const stdioExitPath = join(stdioStatePath, 'exits.ndjson');
const stdioSecretSentinel =
  'MCP_STDIO_RAW_SECRET_SENTINEL=fixture-secret-that-must-not-leak';
const env = {
  ...process.env,
  HOME: homePath,
  XDG_CONFIG_HOME: join(homePath, '.config'),
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
};

try {
  await mkdir(repositoryPath);
  await mkdir(homePath);
  await execFileAsync('git', ['init', repositoryPath], { env });
  await execFileAsync(
    'git',
    ['-C', repositoryPath, 'remote', 'add', 'origin', 'https://github.com/allagentsdev/allagents.git'],
    { env },
  );
  await execFileAsync(process.execPath, [cliPath, 'workspace', 'init', workspacePath], { env });

  const { stdout } = await execFileAsync(
    process.execPath,
    [cliPath, '--json', 'workspace', 'repo', 'add', '../repository'],
    { cwd: workspacePath, env },
  );
  const result = JSON.parse(stdout);

  assert.equal(result.success, true);
  assert.deepEqual(result.data, {
    path: '../repository',
    source: 'github',
    repo: 'allagentsdev/allagents',
    description: null,
  });

  await mkdir(stdioStatePath);
  await writeFile(
    join(workspacePath, '.allagents', 'workspace.yaml'),
    `${JSON.stringify(
      {
        repositories: [],
        plugins: [],
        clients: [],
        mcpServers: {
          'smoke-stdio': {
            command: process.execPath,
            args: [stdioFixturePath],
            env: {
              MCP_STDIO_CAPTURE_PATH: stdioCapturePath,
              MCP_STDIO_ENVIRONMENT_PATH: stdioEnvironmentPath,
              MCP_STDIO_EXIT_PATH: stdioExitPath,
              MCP_STDIO_ENVIRONMENT_KEYS: 'SMOKE_RESOLVED_VALUE',
              SMOKE_RESOLVED_VALUE: '${SMOKE_SOURCE_VALUE}',
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const stdioEnv = { ...env, SMOKE_SOURCE_VALUE: 'node-smoke-resolved' };
  const discovery = await execFileAsync(
    process.execPath,
    [cliPath, '--json', 'mcp', 'tools', 'smoke-stdio'],
    { cwd: workspacePath, env: stdioEnv },
  );
  assert.equal(discovery.stderr.includes(stdioSecretSentinel), false);
  const discoveryResult = JSON.parse(discovery.stdout);
  assert.equal(discoveryResult.success, true);
  assert.deepEqual(
    discoveryResult.data.tools.map(({ name }) => name),
    ['primitive_echo', 'complex_echo', 'structured_failure'],
  );

  const call = await execFileAsync(
    process.execPath,
    [
      cliPath,
      '--json',
      'mcp',
      'call',
      'smoke-stdio',
      'primitive_echo',
      '--text=node-smoke',
      '--ratio=2.5',
      '--count=3',
      '--enabled=false',
      '--mode=slow',
      '--tags=first',
      '--tags=second',
    ],
    { cwd: workspacePath, env: stdioEnv },
  );
  assert.equal(call.stderr.includes(stdioSecretSentinel), false);
  const callResult = JSON.parse(call.stdout);
  const expectedArguments = {
    text: 'node-smoke',
    ratio: 2.5,
    count: 3,
    enabled: false,
    mode: 'slow',
    tags: ['first', 'second'],
  };
  assert.equal(callResult.success, true);
  assert.deepEqual(callResult.data.result.structuredContent.received, expectedArguments);

  const captures = (await readFile(stdioCapturePath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    captures.filter(({ kind }) => kind === 'call'),
    [{ kind: 'call', name: 'primitive_echo', arguments: expectedArguments }],
  );
  const exits = (await readFile(stdioExitPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(exits.length, 2);
  assert.deepEqual(
    exits.map(({ code }) => code),
    [0, 0],
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
