#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const capturePath = process.env.MCP_STDIO_CAPTURE_PATH;
const environmentPath = process.env.MCP_STDIO_ENVIRONMENT_PATH;
const exitPath = process.env.MCP_STDIO_EXIT_PATH;
const environmentKeys = (process.env.MCP_STDIO_ENVIRONMENT_KEYS ?? '')
  .split(',')
  .filter(Boolean);

function appendJson(path, value) {
  if (path) appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

appendJson(environmentPath, {
  pid: process.pid,
  values: Object.fromEntries(
    environmentKeys.map((key) => [key, process.env[key] ?? null]),
  ),
});

process.once('exit', (code) => {
  appendJson(exitPath, { pid: process.pid, code });
});

process.stderr.write(
  'MCP_STDIO_RAW_SECRET_SENTINEL=fixture-secret-that-must-not-leak\n',
);

const primitiveInputSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Text to echo' },
    ratio: { type: 'number', description: 'A finite ratio' },
    count: { type: 'integer', description: 'A safe integer count' },
    enabled: { type: 'boolean', description: 'Explicit true or false' },
    mode: { type: 'string', enum: ['fast', 'slow'] },
    tags: { type: 'array', items: { type: 'string' } },
    optional: { type: 'string' },
  },
  required: ['text', 'ratio', 'count', 'enabled', 'mode', 'tags'],
};

const complexInputSchema = {
  type: 'object',
  properties: {
    nested: {
      type: 'object',
      properties: {
        empty: { type: 'string' },
        unicode: { type: 'string' },
        nil: { type: ['string', 'null'] },
      },
    },
    values: { type: 'array', items: {} },
    'odd-name': {},
  },
  required: ['nested'],
};

const toolPages = [
  [
    {
      name: 'primitive_echo',
      title: 'Primitive Echo',
      description:
        process.env.MCP_STDIO_REFLECT_SECRET === '1'
          ? `Reflected credential: ${process.env.RESOLVED_SECRET}`
          : process.env.MCP_STDIO_TOOL_DESCRIPTION ??
            'Current primitive stdio fixture description',
      inputSchema: primitiveInputSchema,
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
      _meta: { fixture: { page: 1, transport: 'stdio' } },
    },
  ],
  [
    {
      name: 'complex_echo',
      title: 'Complex Echo',
      description: 'Exact nested JSON input only',
      inputSchema: complexInputSchema,
      _meta: { fixture: { page: 2, transport: 'stdio' } },
    },
    {
      name: 'structured_failure',
      description: 'Returns a tool-level structured failure',
      inputSchema: { type: 'object' },
      _meta: { fixture: { page: 2, transport: 'stdio' } },
    },
  ],
];

const server = new Server(
  { name: 'allagents-runtime-stdio-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  const cursor = request.params?.cursor;
  appendJson(capturePath, { kind: 'list', cursor: cursor ?? null });
  if (process.env.MCP_STDIO_HANG_LIST === '1') {
    await Promise.withResolvers().promise;
  }
  const pageIndex =
    cursor === undefined
      ? 0
      : Number.parseInt(cursor.replace(/^stdio-page-/, ''), 10);
  const tools =
    Number.isSafeInteger(pageIndex) && pageIndex >= 0
      ? (toolPages[pageIndex] ?? [])
      : [];
  return {
    tools,
    ...(pageIndex + 1 < toolPages.length
      ? { nextCursor: `stdio-page-${pageIndex + 1}` }
      : {}),
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = structuredClone(request.params.arguments ?? {});
  appendJson(capturePath, {
    kind: 'call',
    name: request.params.name,
    arguments: args,
  });

  if (request.params.name === 'structured_failure') {
    return {
      content: [
        { type: 'text', text: 'fixture tool failure' },
        {
          type: 'resource_link',
          uri: 'file:///stdio-fixture/failure.json',
          name: 'failure details',
          mimeType: 'application/json',
        },
      ],
      structuredContent: { reason: 'requested', explicitFalse: false },
      isError: true,
      _meta: { fixture: true, failure: true },
    };
  }

  if (
    request.params.name !== 'primitive_echo' &&
    request.params.name !== 'complex_echo'
  ) {
    return {
      content: [{ type: 'text', text: 'unknown fixture tool' }],
      isError: true,
    };
  }

  return {
    content: [
      { type: 'text', text: 'first fixture item' },
      {
        type: 'resource_link',
        uri: 'file:///stdio-fixture/result.json',
        name: 'captured arguments',
        mimeType: 'application/json',
      },
      { type: 'text', text: 'third fixture item' },
    ],
    structuredContent: { received: args, explicitFalse: false },
    isError: false,
    _meta: { fixture: true, explicitFalse: false },
  };
});

await server.connect(new StdioServerTransport());
