import { spawn, type ChildProcess } from 'node:child_process';
import process from 'node:process';
import { PassThrough, type Stream } from 'node:stream';
import {
  getDefaultEnvironment,
  type StdioServerParameters,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';

const INITIAL_READ_BUFFER_BYTES = 8 * 1024;
const CLOSE_GRACE_PERIOD_MS = 2_000;

class LinearJsonLineBuffer {
  private buffer: Buffer;
  private length = 0;

  constructor(private readonly maxFrameBytes: number) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
      throw new Error(
        'MCP stdio frame byte limit must be a positive safe integer',
      );
    }
    this.buffer = Buffer.allocUnsafe(
      Math.min(INITIAL_READ_BUFFER_BYTES, maxFrameBytes),
    );
  }

  consume(chunk: Buffer, emit: (message: JSONRPCMessage) => void): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline + 1;
      this.append(chunk.subarray(offset, end));
      offset = end;

      if (newline !== -1) {
        let frameEnd = this.length - 1;
        if (frameEnd > 0 && this.buffer[frameEnd - 1] === 0x0d) {
          frameEnd -= 1;
        }
        const value: unknown = JSON.parse(
          this.buffer.subarray(0, frameEnd).toString('utf8'),
        );
        const message = JSONRPCMessageSchema.parse(value);
        this.length = 0;
        emit(message);
      }
    }
  }

  clear(): void {
    this.length = 0;
  }

  private append(chunk: Buffer): void {
    const requiredBytes = this.length + chunk.length;
    if (requiredBytes > this.maxFrameBytes) {
      this.clear();
      throw new Error(`MCP stdio frame exceeds ${this.maxFrameBytes} bytes`);
    }
    this.ensureCapacity(requiredBytes);
    chunk.copy(this.buffer, this.length);
    this.length = requiredBytes;
  }

  private ensureCapacity(requiredBytes: number): void {
    if (requiredBytes <= this.buffer.length) return;
    const nextBytes = Math.min(
      this.maxFrameBytes,
      Math.max(requiredBytes, this.buffer.length * 2),
    );
    const next = Buffer.allocUnsafe(nextBytes);
    this.buffer.copy(next, 0, 0, this.length);
    this.buffer = next;
  }
}

function waitForExit(
  exited: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  let settled = false;
  const finish = (observed: boolean): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    resolve(observed);
  };
  const timeout = setTimeout(() => finish(false), timeoutMs);
  timeout.unref();
  void exited.then(() => finish(true));
  return promise;
}

/**
 * Protocol-generic stdio transport with a bounded, amortized-linear read buffer.
 */
export class LinearStdioClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  readonly exited: Promise<void>;
  started = false;

  private child: ChildProcess | undefined;
  private readonly readBuffer: LinearJsonLineBuffer;
  private readonly stderrStream: PassThrough | null;
  private readonly resolveExited: () => void;
  private exitObserved = false;
  private startAttempted = false;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly server: StdioServerParameters) {
    this.readBuffer = new LinearJsonLineBuffer(
      server.maxBufferSize ?? 10 * 1024 * 1024,
    );
    this.stderrStream =
      server.stderr === 'pipe' || server.stderr === 'overlapped'
        ? new PassThrough()
        : null;
    const exit = Promise.withResolvers<void>();
    this.exited = exit.promise;
    this.resolveExited = exit.resolve;
  }

  get stderr(): Stream | null {
    return this.stderrStream ?? this.child?.stderr ?? null;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  async start(): Promise<void> {
    if (this.startAttempted) {
      throw new Error('MCP stdio transport has already been started');
    }
    this.startAttempted = true;

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    let startSettled = false;
    let child: ChildProcess;
    try {
      child = spawn(this.server.command, this.server.args ?? [], {
        env: { ...getDefaultEnvironment(), ...this.server.env },
        stdio: ['pipe', 'pipe', this.server.stderr ?? 'inherit'],
        shell: false,
        windowsHide: process.platform === 'win32',
        ...(this.server.cwd === undefined ? {} : { cwd: this.server.cwd }),
      });
    } catch (error) {
      this.observeExit();
      reject(error);
      return promise;
    }
    this.child = child;

    child.once('spawn', () => {
      this.started = true;
      if (startSettled) return;
      startSettled = true;
      resolve();
    });
    child.on('error', (error) => {
      if (!startSettled) {
        startSettled = true;
        reject(error);
      }
      this.onerror?.(error);
    });
    child.once('close', () => {
      if (this.child === child) this.child = undefined;
      this.observeExit();
    });
    child.stdin?.on('error', (error) => this.onerror?.(error));
    child.stdout?.on('data', (chunk: Buffer) => {
      try {
        this.readBuffer.consume(chunk, (message) => this.onmessage?.(message));
      } catch (error) {
        this.onerror?.(
          error instanceof Error ? error : new Error(String(error)),
        );
        void this.close().catch((closeError: unknown) => {
          this.onerror?.(
            closeError instanceof Error
              ? closeError
              : new Error(String(closeError)),
          );
        });
      }
    });
    child.stdout?.on('error', (error) => this.onerror?.(error));
    if (this.stderrStream && child.stderr) {
      child.stderr.pipe(this.stderrStream);
    }
    return promise;
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  async send(
    message: JSONRPCMessage,
    _options?: TransportSendOptions,
  ): Promise<void> {
    const input = this.child?.stdin;
    if (!input) throw new Error('Not connected');
    const frame = `${JSON.stringify(message)}\n`;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    input.write(frame, (error) => {
      if (error) reject(error);
      else resolve();
    });
    return promise;
  }

  private async closeOnce(): Promise<void> {
    const child = this.child;
    if (!child) {
      this.readBuffer.clear();
      this.observeExit();
      return;
    }

    try {
      child.stdin?.end();
    } catch {
      // Continue through process-level shutdown escalation.
    }
    if (await waitForExit(this.exited, CLOSE_GRACE_PERIOD_MS)) {
      this.readBuffer.clear();
      return;
    }

    try {
      child.kill('SIGTERM');
    } catch {
      // The process may have exited between the deadline and the signal.
    }
    if (await waitForExit(this.exited, CLOSE_GRACE_PERIOD_MS)) {
      this.readBuffer.clear();
      return;
    }

    try {
      child.kill('SIGKILL');
    } catch {
      // The process may have exited between the deadline and the signal.
    }
    this.readBuffer.clear();
  }

  private observeExit(): void {
    if (this.exitObserved) return;
    this.exitObserved = true;
    this.resolveExited();
    this.onclose?.();
  }
}
