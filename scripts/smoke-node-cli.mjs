#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  NODE_SMOKE_HTTP_TOOL,
  startMcpRuntimeNodeSmokeServer,
} from '../tests/helpers/mcp-runtime-node-smoke-http-oauth.mjs';

const execFileAsync = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'allagents-node-smoke-'));
const repositoryPath = join(root, 'repository');
const workspacePath = join(root, 'workspace');
const homePath = join(root, 'home');
const cliPath = resolve(process.argv[2] ?? 'dist/index.js');
const stdioFixturePath = resolve('tests/helpers/mcp-runtime-stdio-server.mjs');
const stdioStatePath = join(root, 'stdio-state');
const stdioCapturePath = join(stdioStatePath, 'requests.ndjson');
const stdioEnvironmentPath = join(stdioStatePath, 'environment.ndjson');
const stdioExitPath = join(stdioStatePath, 'exits.ndjson');
const oauthProfile = 'node-smoke';
const oauthServerName = 'smoke-oauth';
const stdioSecretSentinel =
  'MCP_STDIO_RAW_SECRET_SENTINEL=fixture-secret-that-must-not-leak';
const env = {
  ...process.env,
  HOME: homePath,
  USERPROFILE: homePath,
  ALLAGENTS_TEST_HOME: homePath,
  XDG_CACHE_HOME: join(homePath, '.cache'),
  XDG_CONFIG_HOME: join(homePath, '.config'),
  XDG_DATA_HOME: join(homePath, '.local', 'share'),
  XDG_STATE_HOME: join(homePath, '.local', 'state'),
  ALLAGENTS_MCP_OAUTH_NO_BROWSER: '1',
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
};

function base64Url(buffer) {
  return buffer
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function cacheDirectory(serverUrl, profile) {
  const hash = createHash('sha256')
    .update(serverUrl)
    .digest('hex')
    .slice(0, 16);
  return join(
    homePath,
    '.allagents',
    'profiles',
    profile,
    'oauth-proxy',
    hash,
  );
}

async function writePrivate(path, content) {
  await writeFile(path, content, { encoding: 'utf8', mode: 0o600 });
}

async function authorizeProfile(server, profile) {
  const redirectUri = 'http://127.0.0.1:37521/callback';
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(
    createHash('sha256').update(verifier).digest(),
  );
  const state = randomUUID();

  const metadataResponse = await fetch(
    `${server.issuer}/.well-known/oauth-authorization-server`,
  );
  assert.equal(metadataResponse.status, 200);
  const metadata = await metadataResponse.json();

  const clientMetadata = {
    client_name: 'AllAgents',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
  const registrationResponse = await fetch(metadata.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(clientMetadata),
  });
  assert.equal(registrationResponse.status, 201);
  const clientInformation = await registrationResponse.json();

  const authorizationUrl = new URL(metadata.authorization_endpoint);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('client_id', clientInformation.client_id);
  authorizationUrl.searchParams.set('redirect_uri', redirectUri);
  authorizationUrl.searchParams.set('code_challenge', challenge);
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  authorizationUrl.searchParams.set('state', state);
  authorizationUrl.searchParams.set('scope', 'profile email');
  authorizationUrl.searchParams.set('resource', server.mcpUrl);
  const authorizationResponse = await fetch(authorizationUrl, {
    redirect: 'manual',
  });
  assert.equal(authorizationResponse.status, 302);
  const location = authorizationResponse.headers.get('location');
  assert.ok(location);
  const callback = new URL(location, authorizationUrl);
  assert.equal(callback.searchParams.get('state'), state);
  const code = callback.searchParams.get('code');
  assert.ok(code);

  const tokenResponse = await fetch(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientInformation.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: server.mcpUrl,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();

  const directory = cacheDirectory(server.mcpUrl, profile);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await Promise.all([
    writePrivate(
      join(directory, 'client-info.json'),
      `${JSON.stringify(clientInformation, null, 2)}\n`,
    ),
    writePrivate(
      join(directory, 'tokens.json'),
      `${JSON.stringify(tokens, null, 2)}\n`,
    ),
    writePrivate(join(directory, 'code-verifier.txt'), verifier),
    writePrivate(
      join(directory, 'discovery.json'),
      `${JSON.stringify(
        {
          authorizationServerUrl: server.issuer,
          resourceMetadataUrl: `${server.mcpUrl}/.well-known/oauth-protected-resource`,
          resourceMetadata: {
            resource: server.mcpUrl,
            authorization_servers: [server.issuer],
            scopes_supported: ['profile', 'email'],
          },
          authorizationServerMetadata: metadata,
        },
        null,
        2,
      )}\n`,
    ),
  ]);
}

async function runCli(args, options = {}) {
  try {
    const result = await execFileAsync(process.execPath, [cliPath, ...args], {
      cwd: options.cwd ?? workspacePath,
      env: options.env ?? env,
    });
    return { exitCode: 0, ...result };
  } catch (error) {
    if (
      !error ||
      typeof error !== 'object' ||
      typeof error.code !== 'number'
    ) {
      throw error;
    }
    return {
      exitCode: error.code,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

async function readJsonLines(path) {
  try {
    const contents = await readFile(path, 'utf8');
    if (!contents.trim()) return [];
    return contents
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return [];
    throw error;
  }
}

async function waitForRecords(path, count, description) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const records = await readJsonLines(path);
    if (records.length >= count) return records;
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

let publicHttp;
let oauthHttp;
let hangingChild;
let hangingExit;

try {
  await mkdir(repositoryPath);
  await mkdir(homePath);
  await execFileAsync('git', ['init', repositoryPath], { env });
  await execFileAsync(
    'git',
    [
      '-C',
      repositoryPath,
      'remote',
      'add',
      'origin',
      'https://github.com/allagentsdev/allagents.git',
    ],
    { env },
  );
  await execFileAsync(
    process.execPath,
    [cliPath, 'workspace', 'init', workspacePath],
    { env },
  );

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

  publicHttp = await startMcpRuntimeNodeSmokeServer({ requireAuth: false });
  oauthHttp = await startMcpRuntimeNodeSmokeServer();
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
          'smoke-stdio-hanging': {
            command: process.execPath,
            args: [stdioFixturePath],
            env: {
              MCP_STDIO_CAPTURE_PATH: stdioCapturePath,
              MCP_STDIO_ENVIRONMENT_PATH: stdioEnvironmentPath,
              MCP_STDIO_EXIT_PATH: stdioExitPath,
              MCP_STDIO_HANG_LIST: '1',
            },
          },
          'smoke-http-public': {
            type: 'http',
            url: publicHttp.mcpUrl,
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await mkdir(join(homePath, '.allagents'), { recursive: true });
  await writeFile(
    join(homePath, '.allagents', 'workspace.yaml'),
    `${JSON.stringify(
      {
        clients: [],
        mcpServers: {},
        profiles: {
          [oauthProfile]: {
            clients: [{ name: 'codex' }],
            plugins: [],
            mcpServers: {
              [oauthServerName]: {
                type: 'http',
                url: oauthHttp.mcpUrl,
              },
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const publicDiscovery = await runCli([
    '--json',
    'mcp',
    'tools',
    'smoke-http-public',
  ]);
  assert.equal(publicDiscovery.exitCode, 0);
  assert.equal(publicDiscovery.stderr, '');
  const publicDiscoveryResult = JSON.parse(publicDiscovery.stdout);
  assert.equal(publicDiscoveryResult.success, true);
  assert.deepEqual(
    publicDiscoveryResult.data.tools.map(({ name }) => name),
    [NODE_SMOKE_HTTP_TOOL],
  );
  assert.equal(publicHttp.listCallCount, 1);
  assert.equal(publicHttp.activeSessionCount, 0);

  const unauthenticated = await runCli([
    '--json',
    'mcp',
    'tools',
    '--profile',
    oauthProfile,
    oauthServerName,
  ]);
  assert.equal(unauthenticated.exitCode, 1);
  assert.equal(unauthenticated.stderr, '');
  assert.deepEqual(JSON.parse(unauthenticated.stdout), {
    success: false,
    command: 'mcp tools',
    error:
      `MCP authorization is required. Run \`allagents mcp reauth --profile ` +
      `${oauthProfile} ${oauthServerName}\` and try again.`,
  });
  assert.equal(oauthHttp.authorizeCallCount, 0);
  assert.equal(oauthHttp.activeSessionCount, 0);

  await authorizeProfile(oauthHttp, oauthProfile);
  assert.equal(oauthHttp.authorizeCallCount, 1);
  assert.deepEqual(oauthHttp.tokenCallCounts, {
    authorization_code: 1,
    refresh_token: 0,
  });
  assert.equal(oauthHttp.activeSessionCount, 0);

  const cachedDiscovery = await runCli([
    '--json',
    'mcp',
    'tools',
    '--profile',
    oauthProfile,
    oauthServerName,
  ]);
  assert.equal(cachedDiscovery.exitCode, 0);
  assert.equal(cachedDiscovery.stderr, '');
  assert.deepEqual(
    JSON.parse(cachedDiscovery.stdout).data.tools.map(({ name }) => name),
    [NODE_SMOKE_HTTP_TOOL],
  );
  assert.equal(oauthHttp.authorizeCallCount, 1);
  assert.deepEqual(oauthHttp.tokenCallCounts, {
    authorization_code: 1,
    refresh_token: 0,
  });
  assert.equal(oauthHttp.activeSessionCount, 0);

  oauthHttp.expireAccessTokens();
  const httpCall = await runCli([
    '--json',
    'mcp',
    'call',
    '--profile',
    oauthProfile,
    oauthServerName,
    NODE_SMOKE_HTTP_TOOL,
    '--text=node-http-smoke',
  ]);
  assert.equal(httpCall.exitCode, 0);
  assert.equal(httpCall.stderr, '');
  const httpCallResult = JSON.parse(httpCall.stdout);
  assert.equal(httpCallResult.success, true);
  assert.deepEqual(httpCallResult.data.result.structuredContent, {
    received: { text: 'node-http-smoke' },
  });
  assert.equal(oauthHttp.authorizeCallCount, 1);
  assert.ok(oauthHttp.tokenCallCounts.refresh_token >= 1);
  assert.equal(oauthHttp.callToolCount, 1);
  assert.deepEqual(oauthHttp.capturedCalls, [
    {
      name: NODE_SMOKE_HTTP_TOOL,
      arguments: { text: 'node-http-smoke' },
    },
  ]);
  assert.equal(oauthHttp.activeSessionCount, 0);

  const stdioEnv = { ...env, SMOKE_SOURCE_VALUE: 'node-smoke-resolved' };
  const discovery = await runCli(
    ['--json', 'mcp', 'tools', 'smoke-stdio'],
    { env: stdioEnv },
  );
  assert.equal(discovery.exitCode, 0);
  assert.equal(discovery.stderr.includes(stdioSecretSentinel), false);
  const discoveryResult = JSON.parse(discovery.stdout);
  assert.equal(discoveryResult.success, true);
  assert.deepEqual(
    discoveryResult.data.tools.map(({ name }) => name),
    ['primitive_echo', 'complex_echo', 'structured_failure'],
  );

  const call = await runCli(
    [
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
    { env: stdioEnv },
  );
  assert.equal(call.exitCode, 0);
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
  assert.deepEqual(
    callResult.data.result.structuredContent.received,
    expectedArguments,
  );

  const captures = await readJsonLines(stdioCapturePath);
  assert.deepEqual(
    captures.filter(({ kind }) => kind === 'call'),
    [{ kind: 'call', name: 'primitive_echo', arguments: expectedArguments }],
  );
  const exits = await readJsonLines(stdioExitPath);
  assert.equal(exits.length, 2);
  assert.deepEqual(
    exits.map(({ code }) => code),
    [0, 0],
  );

  const captureCountBeforeSignal = captures.length;
  const exitCountBeforeSignal = exits.length;
  let hangingStdout = '';
  let hangingStderr = '';
  hangingChild = spawn(
    process.execPath,
    [cliPath, '--json', 'mcp', 'tools', 'smoke-stdio-hanging'],
    {
      cwd: workspacePath,
      env: stdioEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  hangingChild.stdout.setEncoding('utf8');
  hangingChild.stderr.setEncoding('utf8');
  hangingChild.stdout.on('data', (chunk) => {
    hangingStdout += chunk;
  });
  hangingChild.stderr.on('data', (chunk) => {
    hangingStderr += chunk;
  });
  hangingExit = new Promise((resolveExit, rejectExit) => {
    hangingChild.once('error', rejectExit);
    hangingChild.once('close', (code, signal) =>
      resolveExit({ code, signal }),
    );
  });

  const capturesAfterRequest = await waitForRecords(
    stdioCapturePath,
    captureCountBeforeSignal + 1,
    'the hanging stdio tools/list request',
  );
  assert.deepEqual(capturesAfterRequest.at(-1), {
    kind: 'list',
    cursor: null,
  });
  assert.equal(hangingChild.kill('SIGINT'), true);
  const interrupted = await hangingExit;
  assert.deepEqual(interrupted, { code: 130, signal: null });
  assert.equal(hangingStderr.includes(stdioSecretSentinel), false);
  assert.deepEqual(JSON.parse(hangingStdout), {
    success: false,
    command: 'mcp tools',
    error: 'MCP operation was cancelled',
  });
  const exitsAfterSignal = await waitForRecords(
    stdioExitPath,
    exitCountBeforeSignal + 1,
    'the interrupted stdio child exit',
  );
  assert.equal(exitsAfterSignal.length, exitCountBeforeSignal + 1);
} finally {
  if (
    hangingChild &&
    hangingChild.exitCode === null &&
    hangingChild.signalCode === null
  ) {
    hangingChild.kill('SIGKILL');
    await hangingExit?.catch(() => {});
  }
  try {
    await Promise.all([publicHttp?.stop(), oauthHttp?.stop()]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
