import { afterEach, describe, expect, jest, test } from 'bun:test';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createModernMcpFixture } from '../../fixtures/mcp-modern-server.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpProtocolAdapter } from '../../../src/core/mcp-protocol-era.js';

const version = '2026-07-28';
const protocolKey = 'io.modelcontextprotocol/protocolVersion';
const capsKey = 'io.modelcontextprotocol/clientCapabilities';
const infoKey = 'io.modelcontextprotocol/clientInfo';
const subscriptionKey = 'io.modelcontextprotocol/subscriptionId';
const init: JSONRPCRequest = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: { roots: {} }, clientInfo: { name: 'Host', version: '7' } },
};
const discover = {
  resultType: 'complete', supportedVersions: [version],
  capabilities: { tools: { listChanged: true }, resources: { subscribe: true, listChanged: true } },
  instructions: 'Remote instructions',
  _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'Remote', version: '2', title: 'Server' } },
};

class Wire implements Transport {
  sent: JSONRPCMessage[] = [];
  versions: string[] = [];
  onmessage?: Transport['onmessage'];
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  async start() {}
  async send(message: JSONRPCMessage) { this.sent.push(structuredClone(message)); }
  async close() { this.onclose?.(); }
  setProtocolVersion(value: string) { this.versions.push(value); }
  receive(message: JSONRPCMessage) { this.onmessage?.(message); }
  request(method: string) {
    const request = this.sent.findLast((message): message is JSONRPCRequest => 'method' in message && 'id' in message && message.method === method);
    if (!request || !('id' in request)) throw new Error(`No request for ${method}`);
    return request;
  }
  reply(request: { id?: string | number }, result: Record<string, unknown>) {
    if (request.id === undefined) throw new Error('Request has no ID');
    this.receive({ jsonrpc: '2.0', id: request.id, result });
  }
}
const active: Transport[] = [];
afterEach(async () => { for (const adapter of active.splice(0)) await adapter.close(); jest.useRealTimers(); });
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
async function connect(capabilities: Record<string, unknown> = { roots: {} }, server = discover) {
  const wire = new Wire();
  const adapter = createMcpProtocolAdapter(wire, { mode: 'auto' });
  active.push(adapter);
  const received: JSONRPCMessage[] = [];
  adapter.onmessage = (message) => received.push(structuredClone(message));
  await adapter.start();
  await adapter.send({ ...init, params: { ...('params' in init ? init.params : {}), capabilities } });
  wire.reply(wire.request('server/discover'), server);
  await flush();
  return { wire, adapter, received };
}
function response(messages: JSONRPCMessage[], id: number) {
  return messages.filter((message) => 'id' in message && message.id === id && !('method' in message));
}

describe('MCP protocol era adapter wire behavior', () => {
  test('official HTTP transport bridges a modern-only server and a real host roots response', async () => {
    const fixture = createModernMcpFixture();
    const adapter = createMcpProtocolAdapter(new StreamableHTTPClientTransport(fixture.url), { mode: 'auto' });
    const received: JSONRPCMessage[] = [];
    let settled: (() => void) | undefined;
    const complete = new Promise<void>((resolve) => { settled = resolve; });
    adapter.onmessage = (message) => {
      received.push(message);
      if ('method' in message && message.method === 'roots/list' && 'id' in message) {
        void adapter.send({ jsonrpc: '2.0', id: message.id, result: { roots: [{ uri: 'file:///real-host' }] } });
      }
      if ('id' in message && message.id === 2 && !('method' in message)) settled?.();
    };
    try {
      await adapter.start();
      await adapter.send(init);
      await adapter.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'assisted' } });
      await Promise.race([complete, Bun.sleep(2_000).then(() => { throw new Error('Modern HTTP fixture timed out'); })]);
      expect(response(received, 2)).toEqual([{ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: JSON.stringify({ roots: [{ uri: 'file:///real-host' }] }) }] } }]);
      expect(fixture.requests.some(({ message }) => message.method === 'initialize')).toBe(false);
      expect(fixture.requests.every(({ message, header }) => header === version && message.params?._meta?.[protocolKey] === version)).toBe(true);
      expect(fixture.requests.filter(({ message }) => message.method === 'tools/call')).toHaveLength(2);
    } finally { await adapter.close(); fixture.stop(); }
  });

  test('cancelling discovery ends the handshake once without waiting or falling back', async () => {
    const wire = new Wire();
    const adapter = createMcpProtocolAdapter(wire, { mode: 'auto' });
    active.push(adapter);
    const received: JSONRPCMessage[] = [];
    adapter.onmessage = (message) => received.push(message);
    await adapter.start();
    await adapter.send(init);
    const probe = wire.request('server/discover');
    const cancellation = adapter.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
    await flush();
    expect(response(received, 1)).toHaveLength(1);
    expect(response(received, 1)[0]).toHaveProperty('error');
    wire.reply(probe, discover);
    await cancellation;
    await flush();
    expect(response(received, 1)).toHaveLength(1);
    expect(wire.sent.some((message) => 'method' in message && message.method === 'initialize')).toBe(false);
  });

  test('URL-only elicitation capabilities cannot authorize a form question', async () => {
    const { wire, adapter, received } = await connect({ elicitation: { url: {} } });
    await adapter.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'form' } });
    wire.reply(wire.request('tools/call'), { resultType: 'input_required', inputRequests: { form: { method: 'elicitation/create', params: { mode: 'form', requestedSchema: { type: 'object' } } } } });
    await flush();
    expect(response(received, 2)[0]).toHaveProperty('error');
    expect(received.some((message) => 'method' in message && message.method === 'elicitation/create')).toBe(false);
  });

  test('abort closes the adapter and fails an active host question exactly once', async () => {
    const wire = new Wire();
    const controller = new AbortController();
    const adapter = createMcpProtocolAdapter(wire, { mode: 'auto', signal: controller.signal });
    active.push(adapter);
    const received: JSONRPCMessage[] = [];
    let closes = 0;
    adapter.onmessage = (message) => received.push(message);
    adapter.onclose = () => { closes++; };
    await adapter.start();
    await adapter.send(init);
    wire.reply(wire.request('server/discover'), discover);
    await flush();
    await adapter.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'question' } });
    wire.reply(wire.request('tools/call'), { resultType: 'input_required', inputRequests: { roots: { method: 'roots/list' } } });
    await flush();
    controller.abort();
    await flush();
    expect(closes).toBe(1);
    expect(response(received, 2)).toHaveLength(1);
    expect(response(received, 2)[0]).toHaveProperty('error');
  });

  test('default legacy mode preserves messages and performs no discovery', async () => {
    const wire = new Wire();
    const adapter = createMcpProtocolAdapter(wire);
    active.push(adapter);
    const received: JSONRPCMessage[] = [];
    adapter.onmessage = (message) => received.push(message);
    await adapter.start();
    await adapter.send(init);
    expect(wire.sent).toEqual([init]);
    const answer: JSONRPCMessage = { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', capabilities: {}, serverInfo: { name: 'Legacy', version: '1' } } };
    wire.receive(answer);
    expect(received).toEqual([answer]);
  });

  test.each([{ error: { code: -32601, message: 'Unknown method' } }, { result: { tools: [] } }])('nonmodern discovery falls back to the exact host handshake: %j', async (reply) => {
    const wire = new Wire();
    const adapter = createMcpProtocolAdapter(wire, { mode: 'auto' });
    active.push(adapter);
    await adapter.start();
    await adapter.send(init);
    const probe = wire.request('server/discover');
    wire.receive({ jsonrpc: '2.0', id: probe.id, ...reply } as JSONRPCMessage);
    await flush();
    expect(wire.sent.filter((message) => 'method' in message && message.method === 'initialize')).toEqual([init]);
    expect(wire.versions.at(-1)).toBe('2025-11-25');
    await adapter.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(wire.sent.at(-1)).toEqual({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  });

  test('modern discovery preserves server metadata and host version while matching the transport header', async () => {
    const { wire, adapter, received } = await connect();
    expect(response(received, 1)).toEqual([{ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-11-25', capabilities: discover.capabilities, serverInfo: discover._meta['io.modelcontextprotocol/serverInfo'], instructions: discover.instructions } }]);
    expect(wire.versions.at(-1)).toBe(version);
    adapter.setProtocolVersion?.('2025-11-25');
    expect(wire.versions.at(-1)).toBe(version);
    await adapter.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await adapter.send({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' });
    expect(wire.sent.some((message) => 'method' in message && message.method.startsWith('notifications/'))).toBe(false);
    await adapter.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: { custom: 'retained' } } });
    expect(wire.request('tools/list').params?._meta).toEqual({ custom: 'retained', [protocolKey]: version, [capsKey]: { roots: {} }, [infoKey]: { name: 'Host', version: '7' } });
    wire.reply(wire.request('tools/list'), { resultType: 'complete', tools: [], _meta: { custom: 42 } });
    await flush();
    expect(response(received, 2)).toEqual([{ jsonrpc: '2.0', id: 2, result: { tools: [], _meta: { custom: 42 } } }]);
  });

  test('incompatible modern-only versions fail once instead of sending initialize', async () => {
    const { wire, received } = await connect({}, { ...discover, supportedVersions: ['2027-01-01'] });
    expect(response(received, 1)).toHaveLength(1);
    expect(response(received, 1)[0]).toHaveProperty('error');
    expect(wire.sent.some((message) => 'method' in message && message.method === 'initialize')).toBe(false);
  });

  test('discovery timeout falls back and discards a late probe reply', async () => {
    jest.useFakeTimers();
    const wire = new Wire();
    const adapter = createMcpProtocolAdapter(wire, { mode: 'auto' });
    active.push(adapter);
    const received: JSONRPCMessage[] = [];
    adapter.onmessage = (message) => received.push(message);
    await adapter.start();
    await adapter.send(init);
    const probe = wire.request('server/discover');
    jest.advanceTimersByTime(10_001);
    await flush();
    expect(wire.sent.at(-1)).toEqual(init);
    wire.reply(probe, discover);
    expect(received).toEqual([]);
  });

  test('local ping and log level use legacy results and per-request logging metadata', async () => {
    const { wire, adapter, received } = await connect();
    await adapter.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    await adapter.send({ jsonrpc: '2.0', id: 3, method: 'logging/setLevel', params: { level: 'debug' } });
    await adapter.send({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
    expect(response(received, 2)).toEqual([{ jsonrpc: '2.0', id: 2, result: {} }]);
    expect(response(received, 3)).toEqual([{ jsonrpc: '2.0', id: 3, result: {} }]);
    expect(wire.request('tools/list').params?._meta?.['io.modelcontextprotocol/logLevel']).toBe('debug');
    expect(wire.sent.some((message) => 'method' in message && ['ping', 'logging/setLevel'].includes(message.method))).toBe(false);
  });

  test('change subscriptions relay legacy notifications and reopen on resource changes', async () => {
    jest.useFakeTimers();
    const { wire, adapter, received } = await connect();
    const initialStream = wire.request('subscriptions/listen');
    expect(initialStream.params?.notifications).toEqual({ toolsListChanged: true, resourcesListChanged: true });
    wire.receive({ jsonrpc: '2.0', method: 'notifications/subscriptions/acknowledged', params: { notifications: { toolsListChanged: true } } });
    wire.receive({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: { _meta: { [subscriptionKey]: initialStream.id, custom: 1 } } });
    expect(received.at(-1)).toEqual({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: { _meta: { custom: 1 } } });
    expect(received.some((message) => 'method' in message && message.method === 'notifications/subscriptions/acknowledged')).toBe(false);
    await adapter.send({ jsonrpc: '2.0', id: 2, method: 'resources/subscribe', params: { uri: 'file:///one' } });
    jest.advanceTimersByTime(2_001);
    await flush();
    expect(wire.request('subscriptions/listen').params?.notifications).toEqual({ toolsListChanged: true, resourcesListChanged: true, resourceSubscriptions: ['file:///one'] });
    expect(wire.sent).toContainEqual({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: initialStream.id } });
    await adapter.send({ jsonrpc: '2.0', id: 3, method: 'resources/unsubscribe', params: { uri: 'file:///one' } });
    jest.advanceTimersByTime(2_001);
    await flush();
    expect(wire.request('subscriptions/listen').params?.notifications).toEqual({ toolsListChanged: true, resourcesListChanged: true });
  });

  test('notifications from a cancelled subscription cannot leak into its replacement', async () => {
    jest.useFakeTimers();
    const { wire, adapter, received } = await connect();
    const oldStream = wire.request('subscriptions/listen');
    await adapter.send({ jsonrpc: '2.0', id: 2, method: 'resources/subscribe', params: { uri: 'file:///one' } });
    jest.advanceTimersByTime(2_001);
    await flush();
    const newStream = wire.request('subscriptions/listen');
    wire.receive({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: 'file:///old', _meta: { [subscriptionKey]: oldStream.id } } });
    wire.receive({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: 'file:///one', _meta: { [subscriptionKey]: newStream.id } } });
    expect(received.filter((message) => 'method' in message && message.method === 'notifications/resources/updated')).toEqual([{ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: 'file:///one' } }]);
  });

  test('multiple input-required rounds ask the real host and echo opaque state and keyed answers', async () => {
    const { wire, adapter, received } = await connect({ roots: {}, sampling: {}, elicitation: { form: {} } });
    await adapter.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'assisted', arguments: { exact: 'value' } } });
    const first = wire.request('tools/call');
    const state = '  encrypted\\n\u0000東京==  ';
    wire.reply(first, { resultType: 'input_required', requestState: state, inputRequests: { roots: { method: 'roots/list' } } });
    await flush();
    const question = received.findLast((message) => 'method' in message && message.method === 'roots/list');
    expect(question).toBeDefined();
    if (!question || !('method' in question) || !('id' in question)) throw new Error('Missing host question');
    const roots = { roots: [{ uri: 'file:///workspace', name: 'Workspace' }], _meta: { answer: true } };
    await adapter.send({ jsonrpc: '2.0', id: question.id, result: roots });
    await flush();
    const retry = wire.request('tools/call');
    expect(retry.id).not.toBe(first.id);
    expect(retry.params).toMatchObject({ name: 'assisted', arguments: { exact: 'value' }, requestState: state, inputResponses: { roots } });
    wire.reply(retry, { resultType: 'input_required', inputRequests: { sample: { method: 'sampling/createMessage', params: { maxTokens: 10, messages: [] } }, form: { method: 'elicitation/create', params: { mode: 'form', message: 'Name?', requestedSchema: { type: 'object' } } } } });
    await flush();
    for (const [method, result] of [['sampling/createMessage', { role: 'assistant', model: 'host', content: { type: 'text', text: 'answer' } }], ['elicitation/create', { action: 'accept', content: { name: 'Person' } }]] as const) {
      const request = received.findLast((message) => 'method' in message && message.method === method);
      if (!request || !('method' in request) || !('id' in request)) throw new Error(`Missing host ${method}`);
      await adapter.send({ jsonrpc: '2.0', id: request.id, result });
      await flush();
    }
    const last = wire.request('tools/call');
    expect(last.params).not.toHaveProperty('requestState');
    expect(last.params?.inputResponses).toEqual({ sample: { role: 'assistant', model: 'host', content: { type: 'text', text: 'answer' } }, form: { action: 'accept', content: { name: 'Person' } } });
    wire.reply(last, { resultType: 'complete', content: [{ type: 'text', text: 'Finished' }] });
    await flush();
    expect(response(received, 2)).toEqual([{ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'Finished' }] } }]);
  });

  test.each([
    { method: 'unknown/question', params: {} },
    { method: 'elicitation/create', params: { mode: 'url', url: 'https://example.com' } },
    { method: 'sampling/createMessage', params: {} },
  ])('unsupported or undeclared input is an error: %j', async (question) => {
    const { wire, adapter, received } = await connect({ elicitation: {} });
    await adapter.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'assisted' } });
    wire.reply(wire.request('tools/call'), { resultType: 'input_required', inputRequests: { question } });
    await flush();
    expect(response(received, 2)).toHaveLength(1);
    expect(response(received, 2)[0]).toHaveProperty('error');
    expect(received.some((message) => 'method' in message)).toBe(false);
  });

  test('input questions use capabilities declared on that request', async () => {
    const { wire, adapter, received } = await connect({ roots: {} });
    await adapter.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'assisted', _meta: { [capsKey]: {} } } });
    wire.reply(wire.request('tools/call'), { resultType: 'input_required', inputRequests: { question: { method: 'roots/list' } } });
    await flush();
    expect(response(received, 2)[0]).toHaveProperty('error');
    expect(received.some((message) => 'method' in message && message.method === 'roots/list')).toBe(false);
  });

  test('cancellation addresses the active retry and suppresses late results', async () => {
    const { wire, adapter, received } = await connect();
    await adapter.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'stateful' } });
    wire.reply(wire.request('tools/call'), { resultType: 'input_required', requestState: 'opaque' });
    await flush();
    const retry = wire.request('tools/call');
    await adapter.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
    expect(wire.sent).toContainEqual({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: retry.id } });
    wire.reply(retry, { resultType: 'complete', content: [{ type: 'text', text: 'late' }] });
    await flush();
    expect(response(received, 2)).toHaveLength(1);
    expect(response(received, 2)[0]).toHaveProperty('error');
  });

  test('unknown result types return one error, server errors remain intact', async () => {
    const { wire, adapter, received } = await connect();
    await adapter.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    wire.reply(wire.request('tools/list'), { resultType: 'future', tools: [] });
    await adapter.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    wire.receive({ jsonrpc: '2.0', id: 3, error: { code: -32055, message: 'Remote denied', data: { reason: 42 } } });
    await flush();
    expect(response(received, 2)[0]).toHaveProperty('error');
    expect(response(received, 3)).toEqual([{ jsonrpc: '2.0', id: 3, error: { code: -32055, message: 'Remote denied', data: { reason: 42 } } }]);
  });

  test('round and per-round question limits terminate hostile exchanges', async () => {
    const { wire, adapter, received } = await connect();
    await adapter.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'endless' } });
    for (let round = 0; round < 11; round++) {
      wire.reply(wire.request('tools/call'), { resultType: 'input_required', requestState: `round ${round}` });
      await flush();
    }
    expect(response(received, 2)).toHaveLength(1);
    expect(response(received, 2)[0]).toHaveProperty('error');
    await adapter.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'many' } });
    wire.reply(wire.request('tools/call'), { resultType: 'input_required', inputRequests: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i), { method: 'roots/list' }])) });
    await flush();
    expect(response(received, 3)[0]).toHaveProperty('error');
    expect(received.some((message) => 'method' in message)).toBe(false);
  });

  test('timeout cancels the waiting host question and ignores orphan responses', async () => {
    jest.useFakeTimers();
    const { wire, adapter, received } = await connect();
    await adapter.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'question' } });
    wire.reply(wire.request('tools/call'), { resultType: 'input_required', inputRequests: { roots: { method: 'roots/list' } } });
    await flush();
    const question = received.findLast((message) => 'method' in message && message.method === 'roots/list');
    if (!question || !('method' in question) || !('id' in question)) throw new Error('No host question');
    jest.advanceTimersByTime(600_001);
    await flush();
    expect(response(received, 2)).toHaveLength(1);
    expect(response(received, 2)[0]).toHaveProperty('error');
    await adapter.send({ jsonrpc: '2.0', id: question.id, result: { roots: [] } });
    expect(wire.sent.some((message) => 'id' in message && message.id === question.id)).toBe(false);
  });

  test('parallel continuations preserve each request metadata, state and results', async () => {
    const { wire, adapter, received } = await connect();
    for (const requestId of [2, 3]) await adapter.send({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name: String(requestId), _meta: { [infoKey]: { name: `Host ${requestId}`, version: '1' }, custom: requestId } } });
    const originals = wire.sent.filter((message): message is JSONRPCRequest => 'method' in message && 'id' in message && message.method === 'tools/call');
    for (const original of originals) wire.reply(original, { resultType: 'input_required', requestState: `state ${original.id}` });
    await flush();
    const retries = wire.sent.filter((message): message is JSONRPCRequest => 'method' in message && 'id' in message && message.method === 'tools/call' && typeof message.params?.requestState === 'string');
    expect(retries).toHaveLength(2);
    for (const retry of retries.reverse()) {
      expect(retry.params?.requestState).toBe(`state ${retry.params?.name}`);
      expect(retry.params?._meta?.[infoKey]).toEqual({ name: `Host ${retry.params?.name}`, version: '1' });
      wire.reply(retry, { resultType: 'complete', content: [{ type: 'text', text: retry.params?.name }] });
    }
    await flush();
    expect(response(received, 2)).toEqual([{ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: '2' }] } }]);
    expect(response(received, 3)).toEqual([{ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: '3' }] } }]);
  });

  test('failed sends produce one terminal response and discard late remote answers', async () => {
    const { wire, adapter, received } = await connect();
    wire.send = async (message) => { wire.sent.push(message); throw new Error('Resource transport unavailable'); };
    await adapter.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await flush();
    wire.reply(wire.request('tools/list'), { resultType: 'complete', tools: [] });
    await flush();
    expect(response(received, 2)).toHaveLength(1);
    expect(response(received, 2)[0]).toHaveProperty('error');
  });

  test('rapidly ending subscriptions stop reopening after a bounded number of attempts', async () => {
    jest.useFakeTimers();
    const { wire } = await connect();
    for (let attempt = 0; attempt < 5; attempt++) {
      wire.reply(wire.request('subscriptions/listen'), { resultType: 'complete' });
      await flush();
      jest.advanceTimersByTime(2_001);
      await flush();
    }
    const count = wire.sent.filter((message) => 'method' in message && message.method === 'subscriptions/listen').length;
    expect(count).toBe(5);
    jest.advanceTimersByTime(100_000);
    await flush();
    expect(wire.sent.filter((message) => 'method' in message && message.method === 'subscriptions/listen')).toHaveLength(count);
  });

  test('reserved IDs cannot collide with internal requests and closing settles pending work once', async () => {
    const { wire, adapter, received } = await connect();
    const stream = wire.request('subscriptions/listen');
    await adapter.send({ jsonrpc: '2.0', id: stream.id, method: 'tools/list' });
    expect(received.find((message) => 'id' in message && message.id === stream.id)).toHaveProperty('error');
    await adapter.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'waiting' } });
    await adapter.close();
    wire.reply(wire.request('tools/call'), { resultType: 'complete', content: [] });
    await flush();
    expect(response(received, 2)).toHaveLength(1);
    expect(response(received, 2)[0]).toHaveProperty('error');
  });
});
