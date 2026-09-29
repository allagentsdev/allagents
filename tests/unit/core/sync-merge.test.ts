import { describe, expect, test } from 'bun:test';
import { mergeSyncResults } from '../../../src/core/sync.js';
import type { SyncResult } from '../../../src/core/sync.js';

describe('mergeSyncResults', () => {
  test('merges two successful results', () => {
    const a: SyncResult = {
      success: true,
      pluginResults: [{ plugin: 'a', resolved: '/a', success: true, copyResults: [] }],
      totalCopied: 2,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 1,
    };
    const b: SyncResult = {
      success: true,
      pluginResults: [{ plugin: 'b', resolved: '/b', success: true, copyResults: [] }],
      totalCopied: 3,
      totalFailed: 0,
      totalSkipped: 1,
      totalGenerated: 0,
    };
    const merged = mergeSyncResults(a, b);
    expect(merged.success).toBe(true);
    expect(merged.pluginResults).toHaveLength(2);
    expect(merged.totalCopied).toBe(5);
    expect(merged.totalFailed).toBe(0);
    expect(merged.totalSkipped).toBe(1);
    expect(merged.totalGenerated).toBe(1);
  });

  test('merges when one has failures', () => {
    const a: SyncResult = {
      success: true,
      pluginResults: [],
      totalCopied: 1,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
    };
    const b: SyncResult = {
      success: false,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 1,
      totalSkipped: 0,
      totalGenerated: 0,
      error: 'plugin failed',
    };
    const merged = mergeSyncResults(a, b);
    expect(merged.success).toBe(false);
    expect(merged.totalCopied).toBe(1);
    expect(merged.totalFailed).toBe(1);
  });

  test('merges warnings from both results', () => {
    const a: SyncResult = {
      success: true,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
      warnings: ['warn1'],
    };
    const b: SyncResult = {
      success: true,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
      warnings: ['warn2'],
    };
    const merged = mergeSyncResults(a, b);
    expect(merged.warnings).toEqual(['warn1', 'warn2']);
  });

  test('merges messages from both results', () => {
    const a: SyncResult = {
      success: true,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
      messages: ['msg1'],
    };
    const b: SyncResult = {
      success: true,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
      messages: ['msg2'],
    };
    const merged = mergeSyncResults(a, b);
    expect(merged.messages).toEqual(['msg1', 'msg2']);
  });

  test('merges ordered native lifecycle effects from both scopes', () => {
    const resource = {
      kind: 'plugin' as const,
      requestedIdentity: 'plugin@repo',
      resolvedIdentity: 'plugin@repo',
      context: {
        client: 'claude',
        scope: 'user' as const,
        nativeScope: 'user',
        root: '/home/test',
      },
      provenance: {},
    };
    const a: SyncResult = {
      success: true,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
      nativeResult: {
        success: true,
        effects: [{ action: 'installed', resource }],
      },
    };
    const b: SyncResult = {
      success: false,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 1,
      totalSkipped: 0,
      totalGenerated: 0,
      nativeResult: {
        success: false,
        effects: [{ action: 'failed', resource, error: 'not found' }],
      },
    };
    const merged = mergeSyncResults(a, b);
    expect(merged.nativeResult).toEqual({
      success: false,
      effects: [
        { action: 'installed', resource },
        { action: 'failed', resource, error: 'not found' },
      ],
    });
  });

  test('uses single nativeResult when only one side has it', () => {
    const a: SyncResult = {
      success: true,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
      nativeResult: { success: true, effects: [] },
    };
    const b: SyncResult = {
      success: true,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
    };
    expect(mergeSyncResults(a, b).nativeResult).toEqual(a.nativeResult);
  });

  test('merges purgedPaths from both results', () => {
    const a: SyncResult = {
      success: true,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
      purgedPaths: [{ client: 'claude', paths: ['/a'] }],
    };
    const b: SyncResult = {
      success: true,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
      purgedPaths: [{ client: 'copilot', paths: ['/b'] }],
    };
    const merged = mergeSyncResults(a, b);
    expect(merged.purgedPaths).toEqual([
      { client: 'claude', paths: ['/a'] },
      { client: 'copilot', paths: ['/b'] },
    ]);
  });
});

describe('mergeSyncResults error propagation', () => {
  // A pass that aborts early (unreadable config, invalid plan) returns a failed
  // result instead of throwing, so the merge is the only thing that can keep its
  // reason alive.
  function result(overrides: Partial<SyncResult> = {}): SyncResult {
    return {
      success: true,
      pluginResults: [],
      totalCopied: 0,
      totalFailed: 0,
      totalSkipped: 0,
      totalGenerated: 0,
      ...overrides,
    };
  }

  test('carries the first result error forward', () => {
    const merged = mergeSyncResults(
      result({ success: false, error: 'user pass failed' }),
      result(),
    );
    expect(merged.error).toBe('user pass failed');
    expect(merged.success).toBe(false);
  });

  test('carries the second result error forward', () => {
    const merged = mergeSyncResults(
      result(),
      result({ success: false, error: '.allagents/workspace.yaml validation failed' }),
    );
    expect(merged.error).toBe('.allagents/workspace.yaml validation failed');
    expect(merged.success).toBe(false);
  });

  test('joins distinct errors in order', () => {
    const merged = mergeSyncResults(
      result({ success: false, error: 'user pass failed' }),
      result({ success: false, error: 'project pass failed' }),
    );
    expect(merged.error).toBe('user pass failed; project pass failed');
  });

  test('does not repeat an identical error', () => {
    const merged = mergeSyncResults(
      result({ success: false, error: 'same failure' }),
      result({ success: false, error: 'same failure' }),
    );
    expect(merged.error).toBe('same failure');
  });

  test('omits the error field when neither result failed', () => {
    const merged = mergeSyncResults(result(), result());
    expect(merged.error).toBeUndefined();
    expect('error' in merged).toBe(false);
  });
});
