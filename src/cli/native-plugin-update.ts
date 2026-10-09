import type { NativeEffectData } from '../core/native/types.js';
import type { InstalledPluginUpdateResult } from '../core/plugin.js';
import { nativeIdentityMatches } from '../core/sync.js';

/** Settle a native update from its lifecycle effects, never a Git-cache result. */
export function settleNativePluginUpdate(
  source: string,
  effects: readonly NativeEffectData[],
  clients?: readonly string[],
): InstalledPluginUpdateResult {
  const matching = effects.filter((effect) =>
    (!clients || clients.includes(effect.client)) && nativeIdentityMatches(
      source, effect.requestedIdentity, effect.resolvedIdentity,
    ),
  );
  const failure = matching.find((effect) => effect.action === 'failed' || effect.action === 'unknown');
  if (failure) {
    return {
      plugin: source, success: false, action: 'failed',
      error: failure.error ?? `Native ${failure.phase} did not establish a known result`,
    };
  }
  if (matching.length === 0) {
    return {
      plugin: source, success: false, action: 'failed',
      error: 'Native update produced no matching lifecycle effect',
    };
  }
  return {
    plugin: source, success: true,
    action: matching.some((effect) => effect.changed) ? 'updated' : 'skipped',
  };
}
