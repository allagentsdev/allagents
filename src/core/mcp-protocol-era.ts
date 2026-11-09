import { randomUUID } from 'node:crypto';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  type JSONRPCErrorResponse,
  type JSONRPCMessage,
  type JSONRPCNotification,
  type JSONRPCRequest,
  type JSONRPCResultResponse,
  LATEST_PROTOCOL_VERSION,
  type MessageExtraInfo,
  type RequestId,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/sdk/types.js';

const MODERN_VERSION = '2026-07-28';
const META_PREFIX = 'io.modelcontextprotocol/';
const VERSION_META = `${META_PREFIX}protocolVersion`;
const CAPABILITIES_META = `${META_PREFIX}clientCapabilities`;
const CLIENT_INFO_META = `${META_PREFIX}clientInfo`;
const SERVER_INFO_META = `${META_PREFIX}serverInfo`;
const SUBSCRIPTION_META = `${META_PREFIX}subscriptionId`;
const LOG_META = `${META_PREFIX}logLevel`;
const DISCOVER_TIMEOUT = 10_000;
const LEG_TIMEOUT = 10 * 60_000;
const SUBSCRIPTION_LIFETIME = 24 * 60 * 60_000;
const SUBSCRIPTION_REOPEN_DELAY = 2_000;
const MAX_INPUT_ROUNDS = 10;
const MAX_INPUT_QUESTIONS = 8;

type ObjectValue = Record<string, unknown>;
type Reply = JSONRPCResultResponse | JSONRPCErrorResponse;
type Era = 'pending' | 'discovering' | 'legacy' | 'modern' | 'incompatible';
interface Discovery {
  supportedVersions: string[];
  capabilities: ObjectValue;
  instructions?: string;
  _meta?: ObjectValue;
}
interface Exchange {
  original: JSONRPCRequest;
  options: TransportSendOptions | undefined;
  capabilities: ObjectValue;
  active: boolean;
}
interface Waiting {
  owner: Exchange | undefined;
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function request(message: JSONRPCMessage): message is JSONRPCRequest {
  return 'method' in message && 'id' in message;
}
function response(message: JSONRPCMessage): message is Reply {
  return !('method' in message);
}
function id(value: unknown): value is RequestId {
  return typeof value === 'string' || typeof value === 'number';
}
function errorReply(
  requestId: RequestId,
  message: string,
  code = -32001,
): JSONRPCErrorResponse {
  return { jsonrpc: '2.0', id: requestId, error: { code, message } };
}
function readDiscovery(result: unknown): Discovery | undefined {
  if (
    !object(result) ||
    !Array.isArray(result.supportedVersions) ||
    !result.supportedVersions.every(
      (value): value is string => typeof value === 'string',
    ) ||
    !object(result.capabilities) ||
    (result.instructions !== undefined &&
      typeof result.instructions !== 'string') ||
    (result.resultType !== undefined && result.resultType !== 'complete')
  )
    return;
  return {
    supportedVersions: result.supportedVersions,
    capabilities: result.capabilities,
    ...(typeof result.instructions === 'string'
      ? { instructions: result.instructions }
      : {}),
    ...(object(result._meta) ? { _meta: result._meta } : {}),
  };
}

/**
 * Adapts a legacy host to the stateless MCP 2026-07-28 wire protocol.
 * Transport owns HTTP/authentication; this boundary handles JSON-RPC messages only.
 * Modern discovery is opt-in, so legacy connections incur no probe.
 */
export function createMcpProtocolAdapter(
  transport: Transport,
  options: { mode?: 'legacy' | 'auto'; signal?: AbortSignal } = {},
): Transport {
  return new McpProtocolAdapter(transport, options);
}

class McpProtocolAdapter implements Transport {
  onmessage: Transport['onmessage'];
  onclose: Transport['onclose'];
  onerror: Transport['onerror'];
  private era: Era;
  private readonly prefix = `allagents-mcp-${randomUUID()}-`;
  private sequence = 0;
  private closed = false;
  private negotiation: Promise<void> | undefined;
  private initialize: JSONRPCRequest | undefined;
  private discovery: Discovery | undefined;
  private capabilities: ObjectValue = {};
  private clientInfo: ObjectValue | undefined;
  private logLevel: string | undefined;
  private readonly remote = new Map<RequestId, Waiting>();
  private readonly host = new Map<RequestId, Waiting>();
  private readonly exchanges = new Map<RequestId, Exchange>();
  private readonly resources = new Set<string>();
  private subscriptionId: RequestId | undefined;
  private subscriptionGeneration = 0;
  private subscriptionFailures = 0;
  private subscriptionTimer: ReturnType<typeof setTimeout> | undefined;
  private dropResourceSubscriptions = false;
  private readonly abort = () => {
    void this.close().catch((error: unknown) => this.report(error));
  };

  constructor(
    private readonly transport: Transport,
    private readonly options: {
      mode?: 'legacy' | 'auto';
      signal?: AbortSignal;
    },
  ) {
    this.era = options.mode === 'auto' ? 'pending' : 'legacy';
  }

  get sessionId(): string | undefined {
    return this.transport.sessionId;
  }

  async start(): Promise<void> {
    this.transport.onmessage = (message, extra) => this.receive(message, extra);
    this.transport.onerror = (error) => this.onerror?.(error);
    this.transport.onclose = () =>
      this.terminate('The remote connection closed before answering');
    if (this.options.signal?.aborted) {
      await this.close();
      throw new Error('MCP connection was aborted');
    }
    this.options.signal?.addEventListener('abort', this.abort, { once: true });
    await this.transport.start();
  }

  setProtocolVersion(version: string): void {
    this.transport.setProtocolVersion?.(
      this.era === 'modern' ? MODERN_VERSION : version,
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.terminate('The connection closed before answering');
    await this.transport.close();
  }

  async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    if (this.closed) throw new Error('MCP connection is closed');
    if (this.isLegacy()) return this.transport.send(message, options);
    if ('id' in message && this.ownId(message.id)) {
      if (request(message)) {
        this.emit(
          errorReply(
            message.id,
            'This request ID is reserved by the AllAgents MCP adapter',
            -32600,
          ),
        );
      } else if (response(message)) {
        this.resolve(this.host, message);
      }
      return;
    }
    if (
      request(message) &&
      message.method === 'initialize' &&
      this.era === 'pending'
    ) {
      this.initialize = message;
      this.readIdentity(message);
      this.era = 'discovering';
      this.negotiation = this.negotiate(message, options);
      return;
    }
    if (
      this.era === 'discovering' &&
      'method' in message &&
      message.method === 'notifications/cancelled' &&
      message.params?.requestId === this.initialize?.id
    ) {
      const initialize = this.initialize;
      this.initialize = undefined;
      this.era = 'incompatible';
      if (initialize)
        this.emit(
          errorReply(initialize.id, 'Initialization cancelled', -32800),
        );
      for (const [requestId, waiting] of this.remote) {
        this.remote.delete(requestId);
        clearTimeout(waiting.timer);
        this.notifyCancellation(this.remote, requestId);
        waiting.reject(new Error('Initialization cancelled'));
      }
      return;
    }
    if (this.era === 'discovering') await this.negotiation;
    if (this.closed) return;
    if (this.isLegacy()) return this.transport.send(message, options);
    if (this.era === 'incompatible') {
      if (request(message))
        this.emit(
          errorReply(
            message.id,
            'No compatible modern MCP protocol version',
            -32603,
          ),
        );
      return;
    }
    if (this.era !== 'modern') return this.transport.send(message, options);
    if ('method' in message) {
      if (
        message.method === 'notifications/initialized' ||
        message.method === 'notifications/roots/list_changed'
      )
        return;
      if (
        message.method === 'notifications/cancelled' &&
        id(message.params?.requestId)
      ) {
        const exchange = this.exchanges.get(message.params.requestId);
        if (exchange) {
          this.cancelExchange(exchange, 'Request cancelled', -32800);
          return;
        }
      }
      if (message.method === 'initialize' && request(message)) {
        this.readIdentity(message);
        this.answerInitialize(message);
        return;
      }
      if (
        [
          'ping',
          'resources/subscribe',
          'resources/unsubscribe',
          'logging/setLevel',
        ].includes(message.method)
      ) {
        this.localMethod(message);
        return;
      }
    }
    if (!request(message)) return this.transport.send(message, options);
    if (this.exchanges.has(message.id)) {
      // The first request still owns this ID. A second final response would be ambiguous.
      this.report(new Error('A host reused an in-flight MCP request ID'));
      return;
    }
    const stamped = this.stamp(message);
    const declared = stamped.params?._meta?.[CAPABILITIES_META];
    const exchange: Exchange = {
      original: stamped,
      options,
      capabilities: object(declared) ? declared : {},
      active: true,
    };
    this.exchanges.set(message.id, exchange);
    void this.runExchange(exchange).catch((error: unknown) => {
      this.cancelExchange(
        exchange,
        error instanceof Error ? error.message : 'Modern MCP request failed',
      );
    });
  }

  private isLegacy(): boolean {
    return this.era === 'legacy';
  }

  private ownId(value: unknown): value is string {
    return typeof value === 'string' && value.startsWith(this.prefix);
  }
  private nextId(): string {
    return `${this.prefix}${++this.sequence}`;
  }
  private emit(message: JSONRPCMessage, extra?: MessageExtraInfo): void {
    this.onmessage?.(message, extra);
  }
  private report(error: unknown): void {
    this.onerror?.(
      error instanceof Error ? error : new Error('MCP protocol adapter failed'),
    );
  }

  private readIdentity(message: JSONRPCRequest): void {
    this.capabilities = object(message.params?.capabilities)
      ? message.params.capabilities
      : {};
    this.clientInfo = object(message.params?.clientInfo)
      ? message.params.clientInfo
      : undefined;
  }

  private stamp(message: JSONRPCRequest): JSONRPCRequest {
    const existing = message.params?._meta ?? {};
    return {
      ...message,
      params: {
        ...message.params,
        _meta: {
          ...existing,
          [VERSION_META]: existing[VERSION_META] ?? MODERN_VERSION,
          [CAPABILITIES_META]: existing[CAPABILITIES_META] ?? this.capabilities,
          ...(this.clientInfo
            ? {
                [CLIENT_INFO_META]:
                  existing[CLIENT_INFO_META] ?? this.clientInfo,
              }
            : {}),
          ...(this.logLevel ? { [LOG_META]: this.logLevel } : {}),
        },
      },
    };
  }

  private async sendRemote(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    if (request(message)) {
      const version = message.params?._meta?.[VERSION_META];
      if (typeof version === 'string')
        this.transport.setProtocolVersion?.(version);
    }
    await this.transport.send(message, options);
  }

  private wait(
    pending: Map<RequestId, Waiting>,
    requestId: RequestId,
    timeout: number,
    send: () => void | Promise<void>,
    owner?: Exchange,
  ): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        this.notifyCancellation(pending, requestId);
        reject(new Error('Timed out waiting for an MCP reply'));
      }, timeout);
      timer.unref?.();
      const waiting: Waiting = { owner, timer, resolve, reject };
      pending.set(requestId, waiting);
      try {
        Promise.resolve(send()).catch((error: unknown) => {
          if (pending.get(requestId) !== waiting) return;
          pending.delete(requestId);
          clearTimeout(timer);
          reject(error);
        });
      } catch (error) {
        pending.delete(requestId);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  private resolve(pending: Map<RequestId, Waiting>, reply: Reply): boolean {
    if (!id(reply.id)) return false;
    const waiting = pending.get(reply.id);
    if (!waiting) return false;
    pending.delete(reply.id);
    clearTimeout(waiting.timer);
    waiting.resolve(reply);
    return true;
  }

  private async negotiate(
    initialize: JSONRPCRequest,
    options?: TransportSendOptions,
  ): Promise<void> {
    let reply: Reply;
    try {
      const probeId = this.nextId();
      const probe = this.stamp({
        jsonrpc: '2.0',
        id: probeId,
        method: 'server/discover',
        params: {},
      });
      reply = await this.wait(this.remote, probeId, DISCOVER_TIMEOUT, () =>
        this.sendRemote(probe),
      );
    } catch {
      if (this.closed || this.initialize !== initialize) return;
      this.era = 'legacy';
      this.initialize = undefined;
      await this.forwardLegacyInitialize(initialize, options);
      return;
    }
    if (this.closed || this.initialize !== initialize) return;
    this.initialize = undefined;
    const discovery =
      'result' in reply ? readDiscovery(reply.result) : undefined;
    if (discovery?.supportedVersions.includes(MODERN_VERSION)) {
      this.discovery = discovery;
      this.era = 'modern';
      this.transport.setProtocolVersion?.(MODERN_VERSION);
      this.answerInitialize(initialize);
      this.openSubscription();
      return;
    }
    let incompatible = Boolean(discovery);
    if (
      'error' in reply &&
      reply.error.code === -32022 &&
      object(reply.error.data)
    ) {
      const supported = reply.error.data.supported;
      if (
        Array.isArray(supported) &&
        supported.length > 0 &&
        supported.every((value) => typeof value === 'string')
      ) {
        incompatible =
          supported.includes(MODERN_VERSION) ||
          supported.every((value) => value >= MODERN_VERSION);
      }
    }
    if (incompatible) {
      this.era = 'incompatible';
      this.emit(
        errorReply(
          initialize.id,
          'The remote server offers no compatible modern MCP protocol version',
          -32603,
        ),
      );
      return;
    }
    this.era = 'legacy';
    await this.forwardLegacyInitialize(initialize, options);
  }

  private forwardLegacyInitialize(
    initialize: JSONRPCRequest,
    options?: TransportSendOptions,
  ): Promise<void> {
    this.transport.setProtocolVersion?.(
      typeof initialize.params?.protocolVersion === 'string'
        ? initialize.params.protocolVersion
        : LATEST_PROTOCOL_VERSION,
    );
    return this.transport.send(initialize, options).catch((error: unknown) => {
      this.emit(
        errorReply(
          initialize.id,
          error instanceof Error
            ? error.message
            : 'Legacy MCP initialization failed',
        ),
      );
    });
  }

  private answerInitialize(initialize: JSONRPCRequest): void {
    const advertised = this.discovery?._meta?.[SERVER_INFO_META];
    const serverInfo =
      object(advertised) &&
      typeof advertised.name === 'string' &&
      typeof advertised.version === 'string'
        ? advertised
        : { name: 'remote MCP server', version: MODERN_VERSION };
    const requested = initialize.params?.protocolVersion;
    this.emit({
      jsonrpc: '2.0',
      id: initialize.id,
      result: {
        protocolVersion:
          typeof requested === 'string' &&
          SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : LATEST_PROTOCOL_VERSION,
        capabilities: this.discovery?.capabilities ?? {},
        serverInfo,
        ...(this.discovery?.instructions !== undefined
          ? { instructions: this.discovery.instructions }
          : {}),
      },
    });
  }

  private receive(message: JSONRPCMessage, extra?: MessageExtraInfo): void {
    if (this.closed) return;
    if (this.era !== 'legacy' && request(message) && this.ownId(message.id)) {
      void this.transport
        .send(
          errorReply(
            message.id,
            'This request ID is reserved by the AllAgents MCP adapter',
            -32600,
          ),
        )
        .catch((error: unknown) => this.report(error));
      return;
    }
    if (response(message)) {
      if (this.resolve(this.remote, message) || this.ownId(message.id)) return;
      if (this.era === 'modern') return;
    }
    if (this.era === 'modern' && 'method' in message && !('id' in message)) {
      if (message.method === 'notifications/subscriptions/acknowledged') return;
      const meta = message.params?._meta;
      if (meta && SUBSCRIPTION_META in meta) {
        if (meta[SUBSCRIPTION_META] !== this.subscriptionId) return;
        const { [SUBSCRIPTION_META]: _subscriptionId, ...remaining } = meta;
        const params = { ...message.params };
        if (Object.keys(remaining).length) params._meta = remaining;
        else delete params._meta;
        this.emit({ ...message, params }, extra);
        return;
      }
    }
    this.emit(message, extra);
  }

  private async runExchange(exchange: Exchange): Promise<void> {
    let outgoing = exchange.original;
    for (let round = 0; ; round++) {
      if (!exchange.active) return;
      const reply = await this.wait(
        this.remote,
        outgoing.id,
        LEG_TIMEOUT,
        () => this.sendRemote(outgoing, exchange.options),
        exchange,
      );
      if (!exchange.active) return;
      if ('error' in reply) {
        this.finish(exchange, { ...reply, id: exchange.original.id });
        return;
      }
      const result = reply.result;
      if (result.resultType !== 'input_required') {
        if (
          result.resultType !== undefined &&
          result.resultType !== 'complete'
        ) {
          this.finish(
            exchange,
            errorReply(
              exchange.original.id,
              `Unrecognized modern MCP result type: ${String(result.resultType)}`,
              -32603,
            ),
          );
        } else {
          const { resultType: _resultType, ...legacy } = result;
          this.finish(exchange, {
            jsonrpc: '2.0',
            id: exchange.original.id,
            result: legacy,
          });
        }
        return;
      }
      if (round >= MAX_INPUT_ROUNDS)
        throw new Error(
          'The remote server asked for input 10 times without completing',
        );
      if (result.inputRequests !== undefined && !object(result.inputRequests))
        throw new Error('Invalid modern MCP inputRequests');
      if (
        result.requestState !== undefined &&
        typeof result.requestState !== 'string'
      )
        throw new Error('Invalid modern MCP requestState');
      const questions = object(result.inputRequests)
        ? Object.entries(result.inputRequests)
        : [];
      if (questions.length === 0 && result.requestState === undefined)
        throw new Error(
          'The remote server asked for input without questions or continuation state',
        );
      if (questions.length > MAX_INPUT_QUESTIONS)
        throw new Error(
          'The remote server embedded more than 8 input questions',
        );
      const answers: ObjectValue = Object.create(null);
      for (const [key, question] of questions) {
        if (
          !object(question) ||
          typeof question.method !== 'string' ||
          (question.params !== undefined && !object(question.params))
        )
          throw new Error('Invalid modern MCP input question');
        const capability = this.inputCapability(
          question.method,
          question.params,
        );
        if (!capability)
          throw new Error(`Cannot put ${question.method} to a legacy MCP host`);
        const declared = exchange.capabilities[capability];
        if (
          !object(declared) ||
          (capability === 'elicitation' &&
            'url' in declared &&
            !object(declared.form))
        )
          throw new Error(
            `The host did not declare support for ${question.method}`,
          );
        const questionId = this.nextId();
        const hostQuestion: JSONRPCRequest = {
          jsonrpc: '2.0',
          id: questionId,
          method: question.method,
          ...(object(question.params) ? { params: question.params } : {}),
        };
        const answer = await this.wait(
          this.host,
          questionId,
          LEG_TIMEOUT,
          () => this.emit(hostQuestion),
          exchange,
        );
        if (!exchange.active) return;
        if ('error' in answer)
          throw new Error(
            `The host refused ${question.method}: ${answer.error.message}`,
          );
        answers[key] = answer.result;
      }
      // Continuation fields belong only to the latest response, never a previous round.
      const {
        inputResponses: _oldAnswers,
        requestState: _oldState,
        ...originalParams
      } = exchange.original.params ?? {};
      outgoing = {
        ...exchange.original,
        id: this.nextId(),
        params: {
          ...originalParams,
          ...(questions.length ? { inputResponses: answers } : {}),
          ...(result.requestState !== undefined
            ? { requestState: result.requestState }
            : {}),
        },
      };
      outgoing = this.stamp(outgoing);
    }
  }

  private inputCapability(method: string, params: unknown): string | undefined {
    if (method === 'sampling/createMessage') return 'sampling';
    if (method === 'roots/list') return 'roots';
    if (
      method === 'elicitation/create' &&
      (!object(params) || params.mode === undefined || params.mode === 'form')
    )
      return 'elicitation';
    return;
  }

  private finish(exchange: Exchange, reply: Reply): void {
    if (!exchange.active) return;
    exchange.active = false;
    this.exchanges.delete(exchange.original.id);
    this.emit(reply);
  }

  private cancelExchange(
    exchange: Exchange,
    reason: string,
    code = -32001,
  ): void {
    if (!exchange.active) return;
    this.finish(exchange, errorReply(exchange.original.id, reason, code));
    for (const pending of [this.remote, this.host]) {
      for (const [requestId, waiting] of pending) {
        if (waiting.owner !== exchange) continue;
        pending.delete(requestId);
        clearTimeout(waiting.timer);
        this.notifyCancellation(pending, requestId);
        waiting.reject(new Error(reason));
      }
    }
  }

  private notifyCancellation(
    pending: Map<RequestId, Waiting>,
    requestId: RequestId,
  ): void {
    const notification: JSONRPCMessage = {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId },
    };
    if (pending === this.host) this.emit(notification);
    else
      void this.transport
        .send(notification)
        .catch((error: unknown) => this.report(error));
  }

  private localMethod(message: JSONRPCRequest | JSONRPCNotification): void {
    let changed = false;
    const uri = message.params?.uri;
    if (
      message.method === 'resources/subscribe' ||
      message.method === 'resources/unsubscribe'
    ) {
      if (typeof uri !== 'string') {
        if (request(message))
          this.emit(
            errorReply(
              message.id,
              'A resource subscription requires a URI',
              -32602,
            ),
          );
        return;
      }
      changed =
        message.method === 'resources/subscribe'
          ? !this.resources.has(uri)
          : this.resources.has(uri);
      if (message.method === 'resources/subscribe') this.resources.add(uri);
      else this.resources.delete(uri);
      this.dropResourceSubscriptions = false;
    } else if (message.method === 'logging/setLevel') {
      const level = message.params?.level;
      if (
        typeof level !== 'string' ||
        ![
          'debug',
          'info',
          'notice',
          'warning',
          'error',
          'critical',
          'alert',
          'emergency',
        ].includes(level)
      ) {
        if (request(message))
          this.emit(errorReply(message.id, 'Invalid MCP log level', -32602));
        return;
      }
      this.logLevel = level;
    }
    if (changed) this.refreshSubscription();
    if (request(message))
      this.emit({ jsonrpc: '2.0', id: message.id, result: {} });
  }

  private subscriptionFilter(): ObjectValue | undefined {
    const capabilities = this.discovery?.capabilities;
    const filter: ObjectValue = {};
    for (const [capability, key] of [
      ['tools', 'toolsListChanged'],
      ['prompts', 'promptsListChanged'],
      ['resources', 'resourcesListChanged'],
    ] as const) {
      const value = capabilities?.[capability];
      if (object(value) && value.listChanged === true) filter[key] = true;
    }
    if (!this.dropResourceSubscriptions && this.resources.size)
      filter.resourceSubscriptions = [...this.resources];
    return Object.keys(filter).length ? filter : undefined;
  }

  private refreshSubscription(): void {
    this.subscriptionGeneration++;
    this.subscriptionFailures = 0;
    if (this.subscriptionTimer) clearTimeout(this.subscriptionTimer);
    if (this.subscriptionId !== undefined) {
      const waiting = this.remote.get(this.subscriptionId);
      this.remote.delete(this.subscriptionId);
      if (waiting) {
        clearTimeout(waiting.timer);
        this.notifyCancellation(this.remote, this.subscriptionId);
        waiting.reject(new Error('Subscription filter changed'));
      }
      this.subscriptionId = undefined;
    }
    this.scheduleSubscription();
  }

  private scheduleSubscription(): void {
    if (this.closed) return;
    this.subscriptionTimer = setTimeout(() => {
      this.subscriptionTimer = undefined;
      this.openSubscription();
    }, SUBSCRIPTION_REOPEN_DELAY);
    this.subscriptionTimer.unref?.();
  }

  private openSubscription(): void {
    if (
      this.closed ||
      this.era !== 'modern' ||
      this.subscriptionId !== undefined
    )
      return;
    const notifications = this.subscriptionFilter();
    if (!notifications) return;
    const generation = this.subscriptionGeneration;
    const openedAt = Date.now();
    const requestId = this.nextId();
    this.subscriptionId = requestId;
    const listen = this.stamp({
      jsonrpc: '2.0',
      id: requestId,
      method: 'subscriptions/listen',
      params: { notifications },
    });
    let reopen = true;
    void this.wait(this.remote, requestId, SUBSCRIPTION_LIFETIME, () =>
      this.sendRemote(listen),
    )
      .then((reply) => {
        if ('error' in reply) {
          if (!this.dropResourceSubscriptions && this.resources.size) {
            this.dropResourceSubscriptions = true;
          } else {
            reopen = false;
            this.report(
              new Error(
                `Remote notification subscription refused: ${reply.error.message}`,
              ),
            );
          }
        }
      })
      .catch((error: unknown) => {
        if (!this.closed && generation === this.subscriptionGeneration)
          this.report(error);
      })
      .finally(() => {
        if (this.closed || generation !== this.subscriptionGeneration) return;
        this.subscriptionId = undefined;
        if (!reopen) return;
        if (Date.now() - openedAt >= 30_000) this.subscriptionFailures = 0;
        else this.subscriptionFailures++;
        if (this.subscriptionFailures < 5) this.scheduleSubscription();
      });
  }

  private terminate(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.options.signal?.removeEventListener('abort', this.abort);
    if (this.subscriptionTimer) clearTimeout(this.subscriptionTimer);
    if (this.initialize) {
      const initialize = this.initialize;
      this.initialize = undefined;
      this.emit(errorReply(initialize.id, reason));
    }
    for (const exchange of this.exchanges.values())
      this.cancelExchange(exchange, reason);
    for (const pending of [this.remote, this.host]) {
      for (const waiting of pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error(reason));
      }
      pending.clear();
    }
    this.onclose?.();
  }
}
