import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

export const NODE_SMOKE_HTTP_TOOL = 'node_echo';

function base64UrlEncode(buffer) {
  return buffer
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function parseBody(contentType, raw) {
  if (contentType?.includes('application/json')) return JSON.parse(raw);
  return Object.fromEntries(new URLSearchParams(raw));
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address) resolve(address.port);
      else reject(new Error('Failed to determine fixture port'));
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function startMcpRuntimeNodeSmokeServer({
  requireAuth = true,
  accessTokenTtlMs = 60_000,
} = {}) {
  const registeredClientIds = new Set();
  const authCodes = new Map();
  const accessTokens = new Map();
  const refreshTokens = new Map();
  const sessions = new Map();
  const capturedCalls = [];
  const counters = {
    authorize: 0,
    authorizationCode: 0,
    refreshToken: 0,
    lists: 0,
    calls: 0,
  };

  let issuer = '';
  let mcpUrl = '';

  const identityServer = createServer((request, response) => {
    void handleIdentityRequest(request, response).catch((error) => {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'text/plain' });
      }
      response.end(error instanceof Error ? error.message : String(error));
    });
  });

  async function handleIdentityRequest(request, response) {
    const url = new URL(request.url ?? '/', issuer);

    if (
      request.method === 'GET' &&
      url.pathname === '/.well-known/oauth-authorization-server'
    ) {
      sendJson(response, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/register') {
      const raw = await readBody(request);
      const metadata = raw ? JSON.parse(raw) : {};
      const clientId = randomUUID();
      registeredClientIds.add(clientId);
      sendJson(response, 201, {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1_000),
        redirect_uris: metadata.redirect_uris ?? [],
        grant_types: metadata.grant_types ?? [
          'authorization_code',
          'refresh_token',
        ],
        response_types: metadata.response_types ?? ['code'],
        token_endpoint_auth_method:
          metadata.token_endpoint_auth_method ?? 'none',
        client_name: metadata.client_name,
      });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/authorize') {
      counters.authorize += 1;
      const clientId = url.searchParams.get('client_id');
      const redirectUri = url.searchParams.get('redirect_uri');
      const challenge = url.searchParams.get('code_challenge');
      const state = url.searchParams.get('state');
      if (
        !clientId ||
        !registeredClientIds.has(clientId) ||
        !redirectUri ||
        !challenge
      ) {
        response.writeHead(400, { 'content-type': 'text/plain' });
        response.end('invalid_request');
        return;
      }

      const code = randomUUID();
      authCodes.set(code, { redirectUri, challenge });
      const callback = new URL(redirectUri);
      callback.searchParams.set('code', code);
      if (state) callback.searchParams.set('state', state);
      response.writeHead(302, { location: callback.toString() });
      response.end();
      return;
    }

    if (request.method === 'POST' && url.pathname === '/token') {
      const raw = await readBody(request);
      const body = parseBody(request.headers['content-type'], raw);

      if (body.grant_type === 'authorization_code') {
        counters.authorizationCode += 1;
        const record = body.code ? authCodes.get(body.code) : undefined;
        const challenge = base64UrlEncode(
          createHash('sha256').update(body.code_verifier ?? '').digest(),
        );
        if (!record || record.redirectUri !== body.redirect_uri || record.challenge !== challenge) {
          sendJson(response, 400, { error: 'invalid_grant' });
          return;
        }
        authCodes.delete(body.code);
        const accessToken = randomUUID();
        const refreshToken = randomUUID();
        const tokenRecord = {
          refreshToken,
          expiresAt: Date.now() + accessTokenTtlMs,
        };
        accessTokens.set(accessToken, tokenRecord);
        refreshTokens.set(refreshToken, tokenRecord);
        sendJson(response, 200, {
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: Math.floor(accessTokenTtlMs / 1_000),
          refresh_token: refreshToken,
          scope: 'profile email',
        });
        return;
      }

      if (body.grant_type === 'refresh_token') {
        counters.refreshToken += 1;
        const existing = body.refresh_token
          ? refreshTokens.get(body.refresh_token)
          : undefined;
        if (!existing) {
          sendJson(response, 400, { error: 'invalid_grant' });
          return;
        }
        const accessToken = randomUUID();
        const tokenRecord = {
          refreshToken: existing.refreshToken,
          expiresAt: Date.now() + accessTokenTtlMs,
        };
        accessTokens.set(accessToken, tokenRecord);
        refreshTokens.set(existing.refreshToken, tokenRecord);
        sendJson(response, 200, {
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: Math.floor(accessTokenTtlMs / 1_000),
          refresh_token: existing.refreshToken,
          scope: 'profile email',
        });
        return;
      }

      sendJson(response, 400, { error: 'unsupported_grant_type' });
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  }

  function createSession() {
    const server = new Server(
      { name: 'allagents-node-smoke-http', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      counters.lists += 1;
      return {
        tools: [
          {
            name: NODE_SMOKE_HTTP_TOOL,
            description: 'Echo text through the Node artifact HTTP smoke fixture',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
          },
        ],
      };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      counters.calls += 1;
      const args = structuredClone(request.params.arguments ?? {});
      capturedCalls.push({ name: request.params.name, arguments: args });
      return {
        content: [{ type: 'text', text: `received ${String(args.text ?? '')}` }],
        structuredContent: { received: args },
        isError: false,
        _meta: { fixture: 'node-smoke-http' },
      };
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => sessions.set(sessionId, transport),
      onsessionclosed: (sessionId) => sessions.delete(sessionId),
    });
    void server.connect(transport);
    return transport;
  }

  const mcpServer = createServer((request, response) => {
    void handleMcpRequest(request, response).catch((error) => {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'text/plain' });
      }
      response.end(error instanceof Error ? error.message : String(error));
    });
  });

  async function handleMcpRequest(request, response) {
    const url = new URL(request.url ?? '/', mcpUrl);
    if (
      request.method === 'GET' &&
      url.pathname === '/.well-known/oauth-protected-resource'
    ) {
      sendJson(response, 200, {
        resource: mcpUrl,
        authorization_servers: [issuer],
        scopes_supported: ['profile', 'email'],
      });
      return;
    }

    const authorization = request.headers.authorization;
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length)
      : undefined;
    const tokenRecord = token ? accessTokens.get(token) : undefined;
    if (requireAuth && (!tokenRecord || tokenRecord.expiresAt <= Date.now())) {
      response.writeHead(401, {
        'content-type': 'text/plain',
        'www-authenticate': `Bearer resource_metadata="${mcpUrl}/.well-known/oauth-protected-resource"`,
      });
      response.end('Unauthorized');
      return;
    }

    const sessionHeader = request.headers['mcp-session-id'];
    const existing =
      typeof sessionHeader === 'string' ? sessions.get(sessionHeader) : undefined;
    await (existing ?? createSession()).handleRequest(request, response);
  }

  const [identityPort, mcpPort] = await Promise.all([
    listen(identityServer),
    listen(mcpServer),
  ]);
  issuer = `http://127.0.0.1:${identityPort}`;
  mcpUrl = `http://127.0.0.1:${mcpPort}`;

  return {
    mcpUrl,
    issuer,
    get activeSessionCount() {
      return sessions.size;
    },
    get authorizeCallCount() {
      return counters.authorize;
    },
    get tokenCallCounts() {
      return {
        authorization_code: counters.authorizationCode,
        refresh_token: counters.refreshToken,
      };
    },
    get listCallCount() {
      return counters.lists;
    },
    get callToolCount() {
      return counters.calls;
    },
    get capturedCalls() {
      return capturedCalls;
    },
    expireAccessTokens() {
      for (const record of accessTokens.values()) record.expiresAt = 0;
    },
    async stop() {
      await Promise.all([...sessions.values()].map((transport) => transport.close()));
      await Promise.all([close(identityServer), close(mcpServer)]);
    },
  };
}
