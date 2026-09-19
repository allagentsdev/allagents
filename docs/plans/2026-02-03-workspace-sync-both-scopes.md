# Workspace Sync Both Scopes Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `workspace sync` automatically sync both user and project workspaces without requiring `--scope`.

**Architecture:** Remove the `--scope` flag from the sync command. The handler calls `syncUserWorkspace()` if `~/.allagents/workspace.yaml` exists, then calls `syncWorkspace()` if `.allagents/workspace.yaml` exists in cwd. If neither exists, auto-create user config and show guidance.

**Tech Stack:** TypeScript, cmd-ts, bun:test

---

### Task 1: Add `mergeSyncResults` helper

**Files:**
- Modify: `src/core/sync.ts` (after line 57, after `SyncResult` interface)
- Test: `tests/unit/core/sync-merge.test.ts`

**Step 1: Write the failing test**

Create `tests/unit/core/sync-merge.test.ts`:

```typescript
import { describe, expect, test } from 'bun:test';
import { mergeSyncResults } from '../../src/core/sync.js';
import type { SyncResult } from '../../src/core/sync.js';

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
```

**Step 2: Run test to verify it fails**

Run: `bun test tests/unit/core/sync-merge.test.ts`
Expected: FAIL — `mergeSyncResults` is not exported

**Step 3: Write minimal implementation**

Add to `src/core/sync.ts` after the `SyncResult` interface (after line 57):

```typescript
/**
 * Merge two SyncResult objects into one combined result.
 */
export function mergeSyncResults(a: SyncResult, b: SyncResult): SyncResult {
  const warnings = [...(a.warnings || []), ...(b.warnings || [])];
  const purgedPaths = [...(a.purgedPaths || []), ...(b.purgedPaths || [])];
  return {
    success: a.success && b.success,
    pluginResults: [...a.pluginResults, ...b.pluginResults],
    totalCopied: a.totalCopied + b.totalCopied,
    totalFailed: a.totalFailed + b.totalFailed,
    totalSkipped: a.totalSkipped + b.totalSkipped,
    totalGenerated: a.totalGenerated + b.totalGenerated,
    ...(warnings.length > 0 && { warnings }),
    ...(purgedPaths.length > 0 && { purgedPaths }),
  };
}
```

**Step 4: Run test to verify it passes**

Run: `bun test tests/unit/core/sync-merge.test.ts`
Expected: PASS — all 4 tests pass

**Step 5: Commit**

```bash
git add src/core/sync.ts tests/unit/core/sync-merge.test.ts
git commit -m "feat(sync): add mergeSyncResults helper"
```

---

### Task 2: Rewrite sync command handler to sync both scopes

**Files:**
- Modify: `src/cli/commands/workspace.ts:96-241` — rewrite `syncCmd`
- Modify: `src/core/user-workspace.ts` — import `ensureUserWorkspace` (already exported)

**Step 1: Write the failing test**

Create `tests/unit/cli/workspace-sync-both.test.ts`:

```typescript
import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initWorkspace } from '../../src/core/workspace.js';
import { addUserPlugin } from '../../src/core/user-workspace.js';
import { syncUserWorkspace, syncWorkspace } from '../../src/core/sync.js';

describe('workspace sync both scopes', () => {
  let tempHome: string;
  let tempProject: string;
  let originalHome: string;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'allagents-both-home-'));
    tempProject = await mkdtemp(join(tmpdir(), 'allagents-both-proj-'));
    originalHome = process.env.HOME || '';
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(tempHome, { recursive: true, force: true });
    await rm(tempProject, { recursive: true, force: true });
  });

  test('syncs user workspace when only user config exists', async () => {
    // Create a local plugin
    const pluginDir = join(tempHome, 'test-plugin');
    const skillDir = join(pluginDir, 'skills', 'test-skill');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: test-skill\ndescription: A test\n---\nContent');
    await addUserPlugin(pluginDir);

    // Sync user — should work
    const result = await syncUserWorkspace();
    expect(result.success).toBe(true);
    expect(result.totalCopied).toBeGreaterThan(0);
    expect(existsSync(join(tempHome, '.claude', 'skills', 'test-skill'))).toBe(true);

    // No project config — syncWorkspace should fail gracefully
    const projResult = await syncWorkspace(tempProject);
    expect(projResult.success).toBe(false);
  });

  test('syncs both when both configs exist', async () => {
    // User plugin
    const userPluginDir = join(tempHome, 'user-plugin');
    const userSkillDir = join(userPluginDir, 'skills', 'user-skill');
    await mkdir(userSkillDir, { recursive: true });
    await writeFile(join(userSkillDir, 'SKILL.md'), '---\nname: user-skill\ndescription: User skill\n---\nContent');
    await addUserPlugin(userPluginDir);

    // Project plugin
    await initWorkspace(tempProject);
    const projPluginDir = join(tempHome, 'proj-plugin');
    const projSkillDir = join(projPluginDir, 'skills', 'proj-skill');
    await mkdir(projSkillDir, { recursive: true });
    await writeFile(join(projSkillDir, 'SKILL.md'), '---\nname: proj-skill\ndescription: Project skill\n---\nContent');
    const { addPlugin } = await import('../../src/core/workspace-modify.js');
    await addPlugin(projPluginDir, tempProject);

    // Sync both
    const userResult = await syncUserWorkspace();
    expect(userResult.success).toBe(true);
    const projResult = await syncWorkspace(tempProject);
    expect(projResult.success).toBe(true);

    // Both skills should exist in their respective locations
    expect(existsSync(join(tempHome, '.claude', 'skills', 'user-skill'))).toBe(true);
    expect(existsSync(join(tempProject, '.claude', 'skills', 'proj-skill'))).toBe(true);
  });
});
```

**Step 2: Run test to verify it passes (baseline — these test the sync functions directly)**

Run: `bun test tests/unit/cli/workspace-sync-both.test.ts`
Expected: PASS — confirms the underlying sync functions work correctly for both scopes

**Step 3: Rewrite the sync command handler**

Replace the `syncCmd` definition in `src/cli/commands/workspace.ts` (lines 96-241):

```typescript
const syncCmd = command({
  name: 'sync',
  description: buildDescription(syncMeta),
  args: {
    offline: flag({ long: 'offline', description: 'Use cached plugins without fetching latest from remote' }),
    dryRun: flag({ long: 'dry-run', short: 'n', description: 'Simulate sync without making changes' }),
    client: option({ type: optional(string), long: 'client', short: 'c', description: 'Sync only the specified client (e.g., opencode, claude)' }),
  },
  handler: async ({ offline, dryRun, client }) => {
    try {
      if (!isJsonMode() && dryRun) {
        console.log('Dry run mode - no changes will be made\n');
      }
      if (!isJsonMode() && client) {
        console.log(`Syncing client: ${client}\n`);
      }

      const { getUserWorkspaceConfig, ensureUserWorkspace } = await import('../../core/user-workspace.js');
      const { mergeSyncResults } = await import('../../core/sync.js');

      const userConfigExists = !!(await getUserWorkspaceConfig());
      const projectConfigPath = join(process.cwd(), '.allagents', 'workspace.yaml');
      const projectConfigExists = existsSync(projectConfigPath);

      // If neither config exists, auto-create user config and show guidance
      if (!userConfigExists && !projectConfigExists) {
        await ensureUserWorkspace();
        if (isJsonMode()) {
          jsonOutput({ success: true, command: 'workspace sync', data: { message: 'No plugins configured' } });
        } else {
          console.log('No plugins configured. Run `allagents plugin install <plugin>` to get started.');
        }
        return;
      }

      let combined: SyncResult | null = null;

      // Sync user workspace if config exists
      if (userConfigExists) {
        if (!isJsonMode()) {
          console.log('Syncing user workspace...\n');
        }
        const userResult = await syncUserWorkspace({ offline, dryRun });
        combined = userResult;
      }

      // Sync project workspace if config exists
      if (projectConfigExists) {
        if (!isJsonMode()) {
          console.log('Syncing project workspace...\n');
        }
        const projectResult = await syncWorkspace(process.cwd(), {
          offline,
          dryRun,
          ...(client && { clients: [client] }),
        });
        combined = combined ? mergeSyncResults(combined, projectResult) : projectResult;
      }

      const result = combined!;

      if (isJsonMode()) {
        const syncData = buildSyncData(result);
        const success = result.success && result.totalFailed === 0;
        jsonOutput({
          success,
          command: 'workspace sync',
          data: syncData,
          ...(!success && { error: 'Sync completed with failures' }),
        });
        if (!success) {
          process.exit(1);
        }
        return;
      }

      // Show purge plan in dry-run mode
      if (dryRun && result.purgedPaths && result.purgedPaths.length > 0) {
        console.log('Would purge managed directories:');
        for (const purgePath of result.purgedPaths) {
          console.log(`  ${purgePath.client}:`);
          for (const path of purgePath.paths) {
            console.log(`    - ${path}`);
          }
        }
        console.log('');
      }

      // Print plugin results
      for (const pluginResult of result.pluginResults) {
        const status = pluginResult.success ? '\u2713' : '\u2717';
        console.log(`${status} Plugin: ${pluginResult.plugin}`);

        if (pluginResult.error) {
          console.log(`  Error: ${pluginResult.error}`);
        }

        const copied = pluginResult.copyResults.filter((r) => r.action === 'copied').length;
        const generated = pluginResult.copyResults.filter((r) => r.action === 'generated').length;
        const failed = pluginResult.copyResults.filter((r) => r.action === 'failed').length;

        if (copied > 0) console.log(`  Copied: ${copied} files`);
        if (generated > 0) console.log(`  Generated: ${generated} files`);
        if (failed > 0) {
          console.log(`  Failed: ${failed} files`);
          for (const failedResult of pluginResult.copyResults.filter((r) => r.action === 'failed')) {
            console.log(`    - ${failedResult.destination}: ${failedResult.error}`);
          }
        }
      }

      // Show warnings
      if (result.warnings && result.warnings.length > 0) {
        console.log('\nWarnings:');
        for (const warning of result.warnings) {
          console.log(`  \u26A0 ${warning}`);
        }
      }

      // Print summary
      console.log(`\nSync complete${dryRun ? ' (dry run)' : ''}:`);
      console.log(`  Total ${dryRun ? 'would copy' : 'copied'}: ${result.totalCopied}`);
      if (result.totalGenerated > 0) console.log(`  Total generated: ${result.totalGenerated}`);
      if (result.totalFailed > 0) console.log(`  Total failed: ${result.totalFailed}`);
      if (result.totalSkipped > 0) console.log(`  Total skipped: ${result.totalSkipped}`);

      if (!result.success || result.totalFailed > 0) {
        process.exit(1);
      }
    } catch (error) {
      if (error instanceof Error) {
        if (isJsonMode()) {
          jsonOutput({ success: false, command: 'workspace sync', error: error.message });
          process.exit(1);
        }
        console.error(`Error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  },
});
```

Note: Add these imports at the top of the file:
```typescript
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SyncResult } from '../../core/sync.js';
```

**Step 4: Run all tests to verify nothing breaks**

Run: `bun test`
Expected: All existing tests pass

**Step 5: Commit**

```bash
git add src/cli/commands/workspace.ts tests/unit/cli/workspace-sync-both.test.ts
git commit -m "feat(sync): sync both user and project workspaces automatically"
```

---

### Task 3: Update metadata and help text

**Files:**
- Modify: `src/cli/metadata/workspace.ts:32-58` — remove `--scope` from `syncMeta`

**Step 1: Update syncMeta**

In `src/cli/metadata/workspace.ts`, remove the `--scope` example and option:

- Remove `'allagents workspace sync --scope user'` from examples array
- Remove `{ flag: '--scope', short: '-s', type: 'string', description: '...' }` from options array

**Step 2: Run help text tests**

Run: `bun test tests/e2e/cli-help.test.ts tests/e2e/cli-enriched-help.test.ts tests/unit/cli/structured-help.test.ts`
Expected: PASS (help tests should not hardcode --scope for sync)

**Step 3: Commit**

```bash
git add src/cli/metadata/workspace.ts
git commit -m "docs(sync): remove --scope from sync help text and metadata"
```

---

### Task 4: Update allagents:workspace skill if it references --scope sync

**Files:**
- Check and modify: the allagents:workspace skill file (if it exists and references `--scope` for sync)

**Step 1: Search for --scope references in skills**

Search for `--scope` in any skill or command file that mentions `workspace sync`.

**Step 2: Update references**

Remove any `--scope user` references from `workspace sync` examples. Keep `--scope` references for `plugin install` unchanged.

**Step 3: Commit**

```bash
git add <changed-files>
git commit -m "docs(skill): update workspace skill to reflect sync both scopes"
```

---

### Task 5: Run full test suite and verify

**Step 1: Run full test suite**

Run: `bun test`
Expected: All 472+ tests pass, 0 failures

**Step 2: Manual smoke test**

Run: `bun run src/cli/index.ts workspace sync --help`
Expected: No `--scope` flag shown

**Step 3: Final commit if any fixups needed**
