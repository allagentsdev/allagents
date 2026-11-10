import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real stdio and HTTP peers expose deadlocks that handler-level mocks conceal.
test('transparent relay retains handshake, notifications, server requests and task results', async () => {
  const received: Record<string, any>[] = [];
  let emit: ReadableStreamDefaultController<Uint8Array> | undefined;
  const sendEvent = (message: unknown) => emit?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(message)}\n\n`));
  const initialization = {
    jsonrpc: '2.0', id: 'host-init', method: 'initialize', params: {
      protocolVersion: '2025-03-26', capabilities: { roots: { listChanged: true }, sampling: {} },
      clientInfo: { name: 'Actual Host', version: '7' }, _meta: { extension: 'host' },
    },
  };
  const initializationResult = { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: true }, experimental: { example: {} } }, serverInfo: { name: 'Actual Remote', version: '9' }, instructions: 'Preserve me', _meta: { extension: 'remote' } };
  const taskResult = { task: { taskId: 'task-1', status: 'working', ttl: 1000, createdAt: '2026-11-09T00:00:00Z', lastUpdatedAt: '2026-11-09T00:00:00Z' }, _meta: { untouched: true } };
  const server = Bun.serve({ port: 0, async fetch(request) {
    if (request.method === 'GET') return new Response(null, { status: 405 });
    if (request.method === 'DELETE') return new Response(null, { status: 200 });
    const message = await request.json() as Record<string, any>;
    received.push(message);
    if (message.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: message.id, result: initializationResult });
    if (message.method === 'tools/call') {
      expect(request.headers.get('mcp-protocol-version')).toBe('2025-03-26');
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        emit = controller;
        sendEvent({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: { _meta: { custom: 'unchanged' } } });
        sendEvent({ jsonrpc: '2.0', id: 'server-roots', method: 'roots/list', params: { _meta: { marker: 3 } } });
      } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (message.id === 'server-roots') {
      sendEvent({ jsonrpc: '2.0', id: 'tool-call', result: taskResult });
      emit?.close();
    }
    return new Response(null, { status: 202 });
  } });
  const home = await mkdtemp(join(tmpdir(), 'mcp-protocol-relay-'));
  const child = Bun.spawn(['bun', join(import.meta.dir, '../fixtures/mcp-protocol-relay.ts'), server.url.toString()], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, HOME: home } });
  const reader = child.stdout.getReader();
  const messages: any[] = [];
  let pending = '';
  const write = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const next = async () => {
    while (!messages.length) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Relay closed before expected protocol message: ${await new Response(child.stderr).text()}`);
      pending += new TextDecoder().decode(chunk.value);
      const lines = pending.split('\n'); pending = lines.pop() ?? '';
      messages.push(...lines.filter(Boolean).map((line) => JSON.parse(line)));
    }
    return messages.shift();
  };
  try {
    write(initialization);
    expect(await next()).toEqual({ jsonrpc: '2.0', id: 'host-init', result: initializationResult });
    expect(received[0]).toEqual(initialization);
    write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    write({ jsonrpc: '2.0', id: 'tool-call', method: 'tools/call', params: { name: 'long_task', arguments: {}, task: { ttl: 1000 } } });
    expect(await next()).toEqual({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: { _meta: { custom: 'unchanged' } } });
    expect(await next()).toEqual({ jsonrpc: '2.0', id: 'server-roots', method: 'roots/list', params: { _meta: { marker: 3 } } });
    write({ jsonrpc: '2.0', id: 'server-roots', result: { roots: [{ uri: 'file:///workspace' }] } });
    expect(await next()).toEqual({ jsonrpc: '2.0', id: 'tool-call', result: taskResult });
    expect(received.find((message) => message.id === 'server-roots')?.result.roots).toEqual([{ uri: 'file:///workspace' }]);
    child.stdin.end();
    expect(await child.exited).toBe(0);
  } finally { child.kill(); server.stop(true); await rm(home, { recursive: true, force: true }); }
}, 10000);

test('stdin EOF during consent closes the callback listener and exits without protocol output', async () => {
  const { createConnection } = await import('node:net');
  const { readdir } = await import('node:fs/promises');
  const { startProtocolAuthServer } = await import('../fixtures/mcp-protocol-auth-server.js');
  const server = startProtocolAuthServer('protected-initialize');
  const home = await mkdtemp(join(tmpdir(), 'mcp-protocol-consent-'));
  const child = Bun.spawn(['bun', join(import.meta.dir, '../fixtures/mcp-protocol-consent-relay.ts'), server.url], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, HOME: home, ALLAGENTS_TEST_HOME: home },
  });
  const reachable = (url: URL) => new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'waiting-for-consent', method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'host', version: '1' } } })}\n`);
    const stderr = child.stderr.getReader();
    let output = '';
    const callback = await Promise.race([
      (async () => {
        while (!/CALLBACK_READY (\S+)/.test(output)) {
          const next = await stderr.read();
          if (next.done) throw new Error(`Relay closed before consent: ${output}`);
          output += new TextDecoder().decode(next.value);
        }
        return new URL(/CALLBACK_READY (\S+)/.exec(output)?.[1] as string);
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Consent did not start')), 2000); }),
    ]);
    if (timer) clearTimeout(timer);
    expect(await reachable(callback)).toBe(true);
    child.stdin.end();
    const exitCode = await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Relay did not close pending consent after EOF')), 2000); }),
    ]);
    expect(exitCode).toBe(0);
    expect(await new Response(child.stdout).text()).toBe('');
    expect(await reachable(callback)).toBe(false);
    expect(server.exchanges).toBe(0);
    expect(server.calls).toBe(0);
    const remaining = await readdir(home, { recursive: true });
    for (const path of remaining.filter((path) => path.endsWith('authorization.lock'))) {
      expect(await readdir(join(home, path))).toEqual([]);
    }
    await stderr.cancel();
  } finally {
    if (timer) clearTimeout(timer);
    child.kill(); server.stop(); await rm(home, { recursive: true, force: true });
  }
}, 10000);

for (const failure of ['disconnect', 'idle-timeout', 'unterminated-response', 'non-message-event', 'incomplete-id'] as const) {
  test(`raw relay settles an unprimed POST stream ${failure} and exits on EOF`, async () => {
    let calls = 0;
    let disconnect: ReturnType<typeof setTimeout> | undefined;
    const server = Bun.serve({ port: 0, async fetch(request) {
      if (request.method === 'GET') return new Response(null, { status: 405 });
      const message = await request.json() as any;
      if (message.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'stream-fixture', version: '1' } } });
      calls++;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(': waiting\n\n'));
        const response = JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [] } });
        if (failure === 'unterminated-response') { controller.enqueue(new TextEncoder().encode(`data: ${response}`)); controller.close(); }
        if (failure === 'non-message-event') { controller.enqueue(new TextEncoder().encode(`event: ignored\ndata: ${response}\n\n`)); controller.close(); }
        if (failure === 'incomplete-id') { controller.enqueue(new TextEncoder().encode('id: incomplete\n')); controller.close(); }
        if (failure === 'disconnect') disconnect = setTimeout(() => controller.close(), 20);
      } }), { headers: { 'content-type': 'text/event-stream' } });
    } });
    const home = await mkdtemp(join(tmpdir(), 'mcp-protocol-stream-'));
    const child = Bun.spawn(['bun', join(import.meta.dir, '../fixtures/mcp-protocol-relay.ts'), server.url.toString(), JSON.stringify({ connection: { bodyTimeoutSeconds: 0.03 } })], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, HOME: home, ALLAGENTS_TEST_HOME: home } });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const reader = child.stdout.getReader();
    let buffered = '';
    const next = async (): Promise<any> => {
      while (!buffered.includes('\n')) {
        const chunk = await reader.read(); if (chunk.done) throw new Error('Relay closed without settling the accepted request');
        buffered += new TextDecoder().decode(chunk.value);
      }
      const boundary = buffered.indexOf('\n'); const line = buffered.slice(0, boundary); buffered = buffered.slice(boundary + 1); return JSON.parse(line);
    };
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'host', version: '1' } } })}\n`);
      expect((await next()).id).toBe('init');
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'accepted', method: 'tools/call', params: { name: 'long' } })}\n`);
      const response = await Promise.race([next(), new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Accepted stream request remained unanswered')), 750); })]);
      expect(response).toMatchObject({ id: 'accepted', error: { code: -32603 } });
      expect(calls).toBe(1);
      if (deadline) clearTimeout(deadline);
      child.stdin.end();
      expect(await Promise.race([child.exited, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Relay did not exit after EOF')), 1000); })])).toBe(0);
    } finally { if (deadline) clearTimeout(deadline); if (disconnect) clearTimeout(disconnect); child.kill(); server.stop(true); await rm(home, { recursive: true, force: true }); }
  });
}
