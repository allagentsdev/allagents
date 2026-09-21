import { describe, expect, test } from 'bun:test';
import { CodexNativeClient } from '../../../../src/core/native/codex.js';
import { getNativeClient } from '../../../../src/core/native/registry.js';
import { AGENT_HOSTS } from '../../../../src/models/client-mapping.js';

describe('native registry', () => {
  test('matches every declared native scope capability', () => {
    for (const host of AGENT_HOSTS) {
      const client = getNativeClient(host.id);
      expect(client !== null).toBe(host.native !== undefined);
      if (!client) continue;

      expect(client.client).toBe(host.id);
      expect(client.supportsScope('project')).toBe(
        host.native?.project === true,
      );
      expect(client.supportsScope('user')).toBe(host.native?.user === true);
    }
  });

  test('registers Codex through its native implementation', () => {
    expect(getNativeClient('codex')).toBeInstanceOf(CodexNativeClient);
  });
});
