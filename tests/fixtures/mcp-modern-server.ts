import type { JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';

const version = '2026-07-28';
const prefix = 'io.modelcontextprotocol/';
const state = '  opaque\\n\u0000東京==  ';
const capabilities = { tools: { listChanged: true }, resources: { subscribe: true } };
const text = (value: string) => ({ type: 'text', text: value });
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A stateless modern-only server: it rejects missing metadata and legacy initialization. */
export function createModernMcpFixture() {
  const requests: Array<{ message: JSONRPCRequest; header: string | null }> = [];
  const streams = new Map<string | number, ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const enqueue = (controller: ReadableStreamDefaultController<Uint8Array>, message: JSONRPCMessage) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      if (request.method === 'GET') return new Response(null, { status: 405 });
      if (request.method === 'DELETE') return new Response(null, { status: 204 });
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const message: unknown = await request.json();
      if (!object(message) || typeof message.method !== 'string') return new Response(null, { status: 400 });
      if (!('id' in message)) {
        if (message.method === 'notifications/cancelled' && object(message.params)) {
          const requestId = message.params.requestId;
          const controller = typeof requestId === 'string' || typeof requestId === 'number' ? streams.get(requestId) : undefined;
          if (controller && (typeof requestId === 'string' || typeof requestId === 'number')) { controller.close(); streams.delete(requestId); }
        }
        return new Response(null, { status: 202 });
      }
      if (typeof message.id !== 'string' && typeof message.id !== 'number') return new Response(null, { status: 400 });
      const wire: JSONRPCRequest = { jsonrpc: '2.0', id: message.id, method: message.method, ...(object(message.params) ? { params: message.params } : {}) };
      const header = request.headers.get('mcp-protocol-version');
      requests.push({ message: wire, header });
      const meta = wire.params?._meta;
      const json = (result: Record<string, unknown>) => Response.json({ jsonrpc: '2.0', id: wire.id, result: { resultType: 'complete', ...result } });
      const error = (code: number, message: string) => Response.json({ jsonrpc: '2.0', id: wire.id, error: { code, message } });
      if (meta?.[`${prefix}protocolVersion`] !== version || header !== version || !object(meta?.[`${prefix}clientCapabilities`])) return new Response('Modern protocol envelope and matching HTTP header required', { status: 400 });
      if (wire.method === 'server/discover') return json({ supportedVersions: [version], capabilities, instructions: 'Modern fixture instructions', _meta: { [`${prefix}serverInfo`]: { name: 'Modern fixture', version: '1.0.0' } } });
      if (wire.method === 'initialize') return error(-32601, 'Modern servers do not initialize');
      if (wire.method === 'subscriptions/listen') {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streams.set(wire.id, controller);
            enqueue(controller, { jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged', params: { notifications: wire.params?.notifications, _meta: { [`${prefix}subscriptionId`]: wire.id } } });
          },
          cancel() { streams.delete(wire.id); },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      }
      if (wire.method === 'tools/list') return json({ tools: ['echo', 'assisted', 'notify'].map((name) => ({ name, inputSchema: { type: 'object' } })) });
      if (wire.method === 'tools/call') {
        if (wire.params?.name === 'notify') {
          for (const [requestId, controller] of streams) enqueue(controller, { jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: { _meta: { [`${prefix}subscriptionId`]: requestId } } });
          return json({ content: [text('notified')] });
        }
        if (wire.params?.name === 'assisted') {
          if (wire.params.requestState === undefined) return json({ resultType: 'input_required', requestState: state, inputRequests: { roots: { method: 'roots/list' } } });
          if (wire.params.requestState !== state || !object(wire.params.inputResponses) || !object(wire.params.inputResponses.roots)) return error(-32602, 'Continuation was not echoed exactly');
          return json({ content: [text(JSON.stringify(wire.params.inputResponses.roots))] });
        }
        return json({ content: [text(JSON.stringify(wire.params?.arguments ?? {}))] });
      }
      return error(-32601, 'Unknown modern method');
    },
  });
  return {
    url: new URL(`http://127.0.0.1:${server.port}/mcp`), requests,
    stop() { for (const controller of streams.values()) controller.close(); streams.clear(); server.stop(true); },
  };
}

if (import.meta.main) {
  const fixture = createModernMcpFixture();
  process.stdout.write(`${JSON.stringify({ url: fixture.url.href })}\n`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { fixture.stop(); process.exit(0); });
}
