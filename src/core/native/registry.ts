import type { ClientType } from '../../models/workspace-config.js';
import type { NativeClient } from './types.js';
import { ClaudeNativeClient } from './claude.js';
import { CopilotNativeClient } from './copilot.js';
import { CodexNativeClient } from './codex.js';
import { PiNativeClient } from './pi.js';
import { OmpNativeClient } from './omp.js';

export function getNativeClient(client: ClientType): NativeClient | null {
  switch (client) {
    case 'claude':
      return new ClaudeNativeClient();
    case 'copilot':
      return new CopilotNativeClient();
    case 'codex':
      return new CodexNativeClient();
    case 'pi':
      return new PiNativeClient();
    case 'omp':
      return new OmpNativeClient();
    default:
      return null;
  }
}
