import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** Local protocol peer with a real separate OAuth exchange and controllable streams. */
export function startProtocolAuthServer(mode: 'http-background' | 'sse' | 'protected-initialize') {
  let origin = '';
  let token = '';
  let exchanges = 0;
  let streamAttempts = 0;
  let successfulStreams = 0;
  let calls = 0;
  let activeStreams = 0;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  const send = (message: unknown) => stream?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(message)}\n\n`));
  const unauthorized = () => new Response(null, { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` } });
  const initialized = { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'protocol-auth-fixture', version: '1' } };
  const server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith('/.well-known/oauth-protected-resource')) return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    if (path.startsWith('/.well-known/oauth-authorization-server')) return Response.json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, response_types_supported: ['code'], grant_types_supported: ['authorization_code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'] });
    if (path === '/token') {
      exchanges++;
      token = `protocol-private-token-${exchanges}`;
      return Response.json({ access_token: token, token_type: 'Bearer', expires_in: 3600 });
    }
    if (request.method === 'GET') {
      streamAttempts++;
      if (mode === 'http-background' && (!token || request.headers.get('authorization') !== `Bearer ${token}`)) return unauthorized();
      successfulStreams++;
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller;
        activeStreams++;
        if (mode === 'sse') controller.enqueue(new TextEncoder().encode('event: endpoint\ndata: /messages\n\n'));
        else { controller.enqueue(new TextEncoder().encode('retry: 5\n\n')); send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: { _meta: { stream: successfulStreams } } }); }
      }, cancel() { activeStreams--; } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    const message = await request.json() as JSONRPCMessage;
    if ('method' in message && message.method === 'initialize' && 'id' in message) {
      if (mode === 'protected-initialize') return unauthorized();
      const response = { jsonrpc: '2.0', id: message.id, result: initialized };
      if (mode === 'sse') { send(response); return new Response(null, { status: 202 }); }
      return Response.json(response);
    }
    if ('method' in message && message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if ('method' in message && 'id' in message) {
      if (!token || request.headers.get('authorization') !== `Bearer ${token}`) return unauthorized();
      calls++;
      const response = { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'authenticated' }] } };
      if (mode === 'sse') { send(response); return new Response(null, { status: 202 }); }
      return Response.json(response);
    }
    return new Response(null, { status: 202 });
  } });
  origin = server.url.origin;
  return {
    url: `${origin}/mcp`,
    get exchanges() { return exchanges; },
    get streamAttempts() { return streamAttempts; },
    get successfulStreams() { return successfulStreams; },
    get activeStreams() { return activeStreams; },
    get calls() { return calls; },
    revoke() { token = ''; },
    closeStream() { stream?.close(); activeStreams--; },
    stop() { server.stop(true); },
  };
}
