import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  type CompatibilityCallToolResult,
  CallToolRequestSchema as CallToolSchema,
  GetPromptRequestSchema as GetPromptSchema,
  ListPromptsRequestSchema as ListPromptsSchema,
  ListResourcesRequestSchema as ListResourcesSchema,
  ListResourceTemplatesRequestSchema as ListResourceTemplatesSchema,
  ListToolsRequestSchema as ListToolsSchema,
  ReadResourceRequestSchema as ReadResourceSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { connectMcpHttpClient } from './mcp-http-client.js';

export {
  AUTH_URL_LOG_PREFIX,
  connectHttpMcpServer,
  getBrowserOpenCommands,
  getMcpOAuthCacheDir,
  hashServerUrl,
  OAuthAuthorizationError,
  parseOAuthCallbackUrl,
  resolveMcpHeaderReferences,
  validateOAuthCallbackUrl,
} from './mcp-http-client.js';
export type {
  ConnectHttpMcpServerOptions,
  OAuthCallbackRequest,
  OAuthCallbackUrlReader,
} from './mcp-http-client.js';

function parseCallToolResponse(result: CompatibilityCallToolResult) {
  if (!('content' in result)) {
    throw new Error('MCP task-based tool results cannot be proxied over stdio');
  }
  return {
    content: result.content,
    ...(result.structuredContent !== undefined && {
      structuredContent: result.structuredContent,
    }),
    ...(result.isError !== undefined && { isError: result.isError }),
    ...(result._meta !== undefined && { _meta: result._meta }),
  };
}

export async function runHttpMcpStdioProxy(
  serverUrl: string,
  headers: Record<string, string> = {},
  options: { profile?: string } = {},
): Promise<void> {
  const { client: remote } = await connectMcpHttpClient(serverUrl, {
    headers,
    ...options,
  });
  const local = new Server(
    {
      name: 'AllAgents',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
    },
  );

  local.setRequestHandler(ListToolsSchema, async (request) =>
    remote.listTools(request.params),
  );
  local.setRequestHandler(CallToolSchema, async (request) =>
    parseCallToolResponse(await remote.callTool(request.params)),
  );
  local.setRequestHandler(ListResourcesSchema, async (request) =>
    remote.listResources(request.params),
  );
  local.setRequestHandler(ReadResourceSchema, async (request) =>
    remote.readResource(request.params),
  );
  local.setRequestHandler(ListResourceTemplatesSchema, async (request) =>
    remote.listResourceTemplates(request.params),
  );
  local.setRequestHandler(ListPromptsSchema, async (request) =>
    remote.listPrompts(request.params),
  );
  local.setRequestHandler(GetPromptSchema, async (request) =>
    remote.getPrompt(request.params),
  );

  const transport = new StdioServerTransport();
  transport.onerror = (error) => {
    console.error(error.message);
  };
  await local.connect(transport);
}
