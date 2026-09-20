import { createHash, randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type IncomingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * A local, CI-safe stand-in for a real OAuth-protected remote MCP server: a fake
 * identity provider that auto-approves authorization requests (no human login step)
 * plus a fake MCP endpoint that requires a bearer token. Used to exercise the OAuth
 * client in src/core/mcp-http-stdio-proxy.ts end-to-end without a human or the real
 * private server.
 */
export const FIXTURE_TOOL_NAME = 'ask_question';
export const FIXTURE_ANSWER =
  'To rename a company branch, go to Settings > Branches > Rename. (fixture response)';

export const RUNTIME_PRIMITIVE_TOOL_NAME = 'primitive_echo';
export const RUNTIME_COMPLEX_TOOL_NAME = 'complex_echo';
export const RUNTIME_FAILURE_TOOL_NAME = 'structured_failure';

export const RUNTIME_PRIMITIVE_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    text: { type: 'string' },
    number: { type: 'number' },
    integer: { type: 'integer' },
    enabled: { type: 'boolean' },
    mode: { type: 'string', enum: ['fast', 'safe'] },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['text', 'number', 'integer', 'enabled', 'mode', 'tags'],
};

export const RUNTIME_COMPLEX_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    payload: {
      type: 'object',
      properties: {
        nested: { type: 'array', items: { type: ['string', 'null'] } },
      },
      required: ['nested'],
    },
    'unusual key': { type: ['string', 'null'] },
  },
  required: ['payload'],
};

export const RUNTIME_FAILURE_RESULT = {
  content: [
    { type: 'text' as const, text: 'first diagnostic' },
    {
      type: 'image' as const,
      data: 'aW1hZ2U=',
      mimeType: 'image/png',
      _meta: { sequence: 2 },
    },
    { type: 'text' as const, text: 'last diagnostic' },
  ],
  structuredContent: {
    code: 'E_FIXTURE',
    details: { retryable: false, values: [1, null, 'λ'] },
  },
  isError: true,
  _meta: { retryable: false, source: 'runtime-fixture' },
  fixtureExtension: { preserved: true },
};

export interface CapturedMcpToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export function createRuntimeToolPages(): Tool[][] {
  return [
    [
      {
        name: FIXTURE_TOOL_NAME,
        description: 'Fixture tool for OAuth e2e tests',
        inputSchema: {
          type: 'object',
          properties: { question: { type: 'string' } },
          required: ['question'],
        },
      },
      {
        name: RUNTIME_PRIMITIVE_TOOL_NAME,
        title: 'Primitive Echo',
        description: 'Current primitive fixture description',
        inputSchema: RUNTIME_PRIMITIVE_INPUT_SCHEMA,
        outputSchema: {
          type: 'object',
          properties: { received: { type: 'object' } },
          required: ['received'],
        },
        annotations: {
          title: 'Primitive Echo Annotation',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        execution: { taskSupport: 'forbidden' },
        icons: [
          {
            src: 'data:image/png;base64,aWNvbg==',
            mimeType: 'image/png',
            sizes: ['16x16'],
            theme: 'light',
          },
        ],
        _meta: {
          fixture: { page: 1, unicode: 'λ' },
        },
      },
    ],
    [
      {
        name: RUNTIME_COMPLEX_TOOL_NAME,
        title: 'Complex Echo',
        description: 'Exact JSON input with nested and unusual values',
        inputSchema: RUNTIME_COMPLEX_INPUT_SCHEMA,
        _meta: { fixture: { page: 2 } },
      },
      {
        name: RUNTIME_FAILURE_TOOL_NAME,
        description: 'Returns an MCP tool-level structured failure',
        inputSchema: { type: 'object' },
        _meta: { fixture: { page: 2 } },
      },
    ],
  ];
}

interface AuthCodeRecord {
  redirectUri: string;
  codeChallenge: string;
}

interface TokenRecord {
  refreshToken: string;
  expiresAt: number;
}

export interface StartDummyMcpOAuthServerOptions {
  /** Access token lifetime in ms. Short values let tests exercise the refresh path. */
  accessTokenTtlMs?: number;
  /** Disable authentication when a test only needs a reachable HTTP MCP server. */
  requireAuth?: boolean;
  /** Expose the richer paginated catalog used by runtime CLI tests. */
  runtimeTools?: boolean;
}

export interface DummyMcpOAuthServer {
  mcpUrl: string;
  idpIssuer: string;
  readonly authorizeCallCount: number;
  readonly tokenCallCounts: { authorization_code: number; refresh_token: number };
  readonly idpRequestHeaders: ReadonlyArray<IncomingHttpHeaders>;
  readonly mcpRequestHeaders: ReadonlyArray<IncomingHttpHeaders>;
  readonly activeSessionCount: number;
  readonly listCallCount: number;
  readonly callToolCount: number;
  readonly capturedCalls: ReadonlyArray<CapturedMcpToolCall>;
  setToolPages(pages: ReadonlyArray<ReadonlyArray<Tool>>): void;
  updateTool(name: string, updates: Partial<Tool>): void;
  expireAccessTokens(): void;
  stop(): Promise<void>;
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const hash = createHash('sha256').update(codeVerifier).digest();
  return base64UrlEncode(hash) === codeChallenge;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

function parseBody(
  contentType: string | undefined,
  raw: string,
): Record<string, string> {
  if (contentType?.includes('application/json')) {
    return JSON.parse(raw) as Record<string, string>;
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function listen(server: HttpServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address) {
        resolve(address.port);
      } else {
        reject(new Error('Failed to determine listening port'));
      }
    });
  });
}

function close(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function startDummyMcpOAuthServer(
  options: StartDummyMcpOAuthServerOptions = {},
): Promise<DummyMcpOAuthServer> {
  const accessTokenTtlMs = options.accessTokenTtlMs ?? 60_000;
  const requireAuth = options.requireAuth ?? true;
  let toolPages: Tool[][] = options.runtimeTools
    ? createRuntimeToolPages()
    : [
        [
          {
            name: FIXTURE_TOOL_NAME,
            description: 'Fixture tool for OAuth e2e tests',
            inputSchema: {
              type: 'object',
              properties: { question: { type: 'string' } },
              required: ['question'],
            },
          },
        ],
      ];

  const registeredClientIds = new Set<string>();
  const authCodes = new Map<string, AuthCodeRecord>();
  const accessTokens = new Map<string, TokenRecord>();
  const refreshTokens = new Map<string, TokenRecord>();

  const counters = {
    authorizeCallCount: 0,
    tokenCallCounts: { authorization_code: 0, refresh_token: 0 },
    listCallCount: 0,
    callToolCount: 0,
  };
  const capturedCalls: CapturedMcpToolCall[] = [];
  const idpRequestHeaders: IncomingHttpHeaders[] = [];
  const mcpRequestHeaders: IncomingHttpHeaders[] = [];

  let idpIssuer = '';
  let mcpUrl = '';

  const idpServer = createServer((req, res) => {
    void handleIdpRequest(req, res);
  });

  async function handleIdpRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    idpRequestHeaders.push({ ...req.headers });
    const url = new URL(req.url ?? '/', idpIssuer);

    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-authorization-server') {
      sendJson(res, 200, {
        issuer: idpIssuer,
        authorization_endpoint: `${idpIssuer}/authorize`,
        token_endpoint: `${idpIssuer}/token`,
        registration_endpoint: `${idpIssuer}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/register') {
      const raw = await readBody(req);
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const clientId = randomUUID();
      registeredClientIds.add(clientId);
      sendJson(res, 201, {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: body.redirect_uris ?? [],
        grant_types: body.grant_types ?? ['authorization_code', 'refresh_token'],
        response_types: body.response_types ?? ['code'],
        token_endpoint_auth_method: body.token_endpoint_auth_method ?? 'none',
        client_name: body.client_name,
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/authorize') {
      counters.authorizeCallCount++;
      const clientId = url.searchParams.get('client_id');
      const redirectUri = url.searchParams.get('redirect_uri');
      const codeChallenge = url.searchParams.get('code_challenge');
      const state = url.searchParams.get('state');

      if (!clientId || !registeredClientIds.has(clientId) || !redirectUri || !codeChallenge) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end('invalid_request');
        return;
      }

      const code = randomUUID();
      authCodes.set(code, { redirectUri, codeChallenge });

      // Auto-approve immediately — this is what makes the dummy IdP CI-safe: there is
      // no human login step, so a plain fetch() of this URL completes the flow exactly
      // like a real browser with an active session would.
      const redirectUrl = new URL(redirectUri);
      redirectUrl.searchParams.set('code', code);
      if (state) redirectUrl.searchParams.set('state', state);
      res.writeHead(302, { location: redirectUrl.toString() });
      res.end();
      return;
    }

    if (req.method === 'POST' && url.pathname === '/token') {
      const raw = await readBody(req);
      const params = parseBody(req.headers['content-type'], raw);

      if (params.grant_type === 'authorization_code') {
        counters.tokenCallCounts.authorization_code++;
        const record = params.code ? authCodes.get(params.code) : undefined;
        if (!record) {
          sendJson(res, 400, { error: 'invalid_grant' });
          return;
        }
        authCodes.delete(params.code);
        if (!verifyPkce(params.code_verifier ?? '', record.codeChallenge)) {
          sendJson(res, 400, {
            error: 'invalid_grant',
            error_description: 'PKCE verification failed',
          });
          return;
        }
        const accessToken = randomUUID();
        const refreshToken = randomUUID();
        const tokenRecord: TokenRecord = {
          refreshToken,
          expiresAt: Date.now() + accessTokenTtlMs,
        };
        accessTokens.set(accessToken, tokenRecord);
        refreshTokens.set(refreshToken, tokenRecord);
        sendJson(res, 200, {
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: Math.floor(accessTokenTtlMs / 1000),
          refresh_token: refreshToken,
          scope: 'profile email',
        });
        return;
      }

      if (params.grant_type === 'refresh_token') {
        counters.tokenCallCounts.refresh_token++;
        const existing = params.refresh_token
          ? refreshTokens.get(params.refresh_token)
          : undefined;
        if (!existing) {
          sendJson(res, 400, { error: 'invalid_grant' });
          return;
        }
        const accessToken = randomUUID();
        const tokenRecord: TokenRecord = {
          refreshToken: existing.refreshToken,
          expiresAt: Date.now() + accessTokenTtlMs,
        };
        accessTokens.set(accessToken, tokenRecord);
        refreshTokens.set(existing.refreshToken, tokenRecord);
        sendJson(res, 200, {
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: Math.floor(accessTokenTtlMs / 1000),
          refresh_token: existing.refreshToken,
          scope: 'profile email',
        });
        return;
      }

      sendJson(res, 400, { error: 'unsupported_grant_type' });
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }

  // Each spawned `mcp proxy` process opens its own independent MCP session against
  // this same long-lived dummy server, so sessions are tracked by Mcp-Session-Id
  // rather than sharing one Server/transport pair (which only supports one session).
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  function createSession(): StreamableHTTPServerTransport {
    const server = new Server(
      { name: 'dummy-mcp-server', version: '0.0.1' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      counters.listCallCount++;
      const cursor = request.params?.cursor;
      const pageIndex =
        cursor === undefined
          ? 0
          : Number.parseInt(cursor.replace(/^fixture-page-/, ''), 10);
      const tools =
        Number.isSafeInteger(pageIndex) && pageIndex >= 0
          ? (toolPages[pageIndex] ?? [])
          : [];
      return {
        tools,
        ...(pageIndex + 1 < toolPages.length
          ? { nextCursor: `fixture-page-${pageIndex + 1}` }
          : {}),
      };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      counters.callToolCount++;
      const args = structuredClone(request.params.arguments ?? {});
      capturedCalls.push({ name: request.params.name, arguments: args });
      if (request.params.name === FIXTURE_TOOL_NAME) {
        return { content: [{ type: 'text', text: FIXTURE_ANSWER }] };
      }
      if (request.params.name === RUNTIME_FAILURE_TOOL_NAME) {
        return RUNTIME_FAILURE_RESULT;
      }
      return {
        content: [
          { type: 'text', text: `received ${request.params.name}` },
          {
            type: 'resource_link',
            uri: 'file:///runtime-fixture/result.json',
            name: 'captured arguments',
            mimeType: 'application/json',
          },
        ],
        structuredContent: { received: args },
        _meta: { fixture: true, explicitFalse: false },
        fixtureExtension: { preserved: true },
      };
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, transport);
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId);
      },
    });
    transport.onerror = (error) => {
      console.error('[dummy-mcp-server] transport error:', error);
    };
    void server.connect(transport);
    return transport;
  }

  const mcpHttpServer = createServer((req, res) => {
    void handleMcpRequest(req, res);
  });

  async function handleMcpRequest(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    mcpRequestHeaders.push({ ...req.headers });
    const url = new URL(req.url ?? '/', mcpUrl);

    if (req.method === 'GET' && url.pathname === '/.well-known/oauth-protected-resource') {
      sendJson(res, 200, {
        resource: mcpUrl,
        authorization_servers: [idpIssuer],
        scopes_supported: ['profile', 'email'],
      });
      return;
    }

    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length)
      : undefined;
    const record = token ? accessTokens.get(token) : undefined;
    const isValid = record !== undefined && record.expiresAt > Date.now();

    if (requireAuth && !isValid) {
      res.writeHead(401, {
        'content-type': 'text/plain',
        'www-authenticate': `Bearer resource_metadata="${mcpUrl}/.well-known/oauth-protected-resource"`,
      });
      res.end('Unauthorized');
      return;
    }

    const sessionIdHeader = req.headers['mcp-session-id'];
    const existing = typeof sessionIdHeader === 'string' ? sessions.get(sessionIdHeader) : undefined;
    const transport = existing ?? createSession();

    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('[dummy-mcp-server] handleRequest error:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('Internal Server Error');
      }
    }
  }

  const [idpPort, mcpPort] = await Promise.all([listen(idpServer), listen(mcpHttpServer)]);
  idpIssuer = `http://127.0.0.1:${idpPort}`;
  mcpUrl = `http://127.0.0.1:${mcpPort}`;

  return {
    mcpUrl,
    idpIssuer,
    get authorizeCallCount() {
      return counters.authorizeCallCount;
    },
    get tokenCallCounts() {
      return counters.tokenCallCounts;
    },
    get idpRequestHeaders() {
      return idpRequestHeaders;
    },
    get mcpRequestHeaders() {
      return mcpRequestHeaders;
    },
    get activeSessionCount() {
      return sessions.size;
    },
    get listCallCount() {
      return counters.listCallCount;
    },
    get callToolCount() {
      return counters.callToolCount;
    },
    get capturedCalls() {
      return capturedCalls;
    },
    setToolPages(pages) {
      toolPages = pages.map((page) => page.map((tool) => structuredClone(tool)));
    },
    updateTool(name, updates) {
      for (const page of toolPages) {
        const index = page.findIndex((tool) => tool.name === name);
        if (index !== -1) {
          page[index] = { ...page[index], ...structuredClone(updates) } as Tool;
          return;
        }
      }
      throw new Error(`Fixture tool '${name}' is not configured`);
    },
    expireAccessTokens() {
      for (const record of accessTokens.values()) {
        record.expiresAt = 0;
      }
    },
    async stop() {
      await Promise.all([...sessions.values()].map((transport) => transport.close()));
      await Promise.all([close(idpServer), close(mcpHttpServer)]);
    },
  };
}
