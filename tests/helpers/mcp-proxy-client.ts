import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AUTH_URL_LOG_PREFIX } from '../../src/core/mcp-http-stdio-proxy.ts';

/**
 * Connects an SDK Client to `allagents mcp proxy <serverUrl>` over stdio, the same
 * way a real MCP host (Claude Code, Copilot, Cursor) would. Used by both the
 * interactive OAuth smoke test and the dummy-server e2e tests so both exercise the
 * exact production code path.
 */
export interface ConnectMcpProxyOptions {
  serverUrl: string;
  headers?: string[];
  env?: Record<string, string>;
  clientName?: string;
  /** Actual generated `mcp proxy` arguments, including URL and scoped options. */
  proxyArgs?: string[];
  /** Called once with the authorization URL the proxy prints when OAuth is required. */
  onAuthorizationUrl?: (url: string) => void;
}

export interface McpProxyConnection {
  client: Client;
  transport: StdioClientTransport;
  close(): Promise<void>;
}

const CLI_ENTRY = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');

export async function connectToMcpProxy(
  options: ConnectMcpProxyOptions,
): Promise<McpProxyConnection> {
  const args = ['run', CLI_ENTRY, ...(options.proxyArgs ?? ['mcp', 'proxy', options.serverUrl])];
  for (const header of options.headers ?? []) {
    args.push('--header', header);
  }

  const transport = new StdioClientTransport({
    command: 'bun',
    args,
    env: { ...process.env, ...(options.env ?? {}) } as Record<string, string>,
    stderr: 'pipe',
  });

  let authUrlFired = false;
  let stderrBuffer = '';
  transport.stderr?.setEncoding('utf-8');
  transport.stderr?.on('data', (chunk: string) => {
    stderrBuffer += chunk;
    if (authUrlFired || !options.onAuthorizationUrl) return;
    const prefixIndex = stderrBuffer.indexOf(AUTH_URL_LOG_PREFIX);
    if (prefixIndex === -1) return;
    const rest = stderrBuffer.slice(prefixIndex + AUTH_URL_LOG_PREFIX.length);
    const newlineIndex = rest.indexOf('\n');
    if (newlineIndex === -1) return; // wait for the full line before parsing
    const url = rest.slice(0, newlineIndex).trim();
    if (!url) return;
    authUrlFired = true;
    options.onAuthorizationUrl(url);
  });

  const client = new Client(
    { name: options.clientName ?? 'allagents-test-client', version: '0.0.0' },
    { capabilities: {} },
  );

  try {
    await client.connect(transport);
  } catch (error) {
    await transport.close();
    throw error;
  }

  return {
    client,
    transport,
    close: () => transport.close(),
  };
}
