---
title: Plugin Update UX Parity - Plan
type: fix
date: 2026-09-23
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Plugin Update UX Parity - Plan

## Goal Capsule

- **Objective:** `allagents plugin update` on a TTY reports the operation it performs: non-mutating source checking, the number of found plugin updates, per-source apply start, and settled results, matching the `skill update` flow from PR #515.
- **Means:** Add a real non-mutating `checkPluginUpdate` boundary in `src/core/plugin.ts`, gate the applying `updatePlugin` on it, and render the existing typed results at the new CLI boundaries.
- **Authority:** Existing typed results remain authoritative for statuses, totals, JSON, exit codes, and update semantics.
- **Stop conditions:** No spinner, cursor rewriting, concurrency, synthetic outcomes, new JSON schema fields, or shared progress framework.

---

## Problem Frame

The skill flow (`b4af16b`) shows checking, a found count, apply starts, and settled results. The plugin flow labeled its mutation as progress without a discovery boundary: `updatePlugin` fetched, checked, and applied in one call, so a plugin whose checkout already matched its remote was still counted and applied as `updated`.

## Requirements

- R1. On a TTY, name each source while it is checked, then report the number of plugins with an available update.
- R2. Name each source again as its update starts, and keep the settled typed result visible.
- R3. The check boundary must not clone, pull, or write the marketplace registry.
- R4. A plugin whose checkout matches its remote is `skipped`: not counted as a found update, not applied, and not re-synchronized.
- R5. Failures (check, apply, native preflight) remain visible and exit 1.
- R6. JSON and redirected human output keep their one-shot shape; skill update and TUI behavior do not regress.

## Key Technical Decisions

- KTD1. Classification lives in core (`checkPluginUpdate`) so the CLI, the TUI wrapper, and future callers share one boundary.
- KTD2. The check reuses `resolveRemoteRevision` and `checkRepositoryHealth` through `UpdateContext`, so applying reuses the same remote/health facts instead of re-fetching.
- KTD3. A local (non-Git) marketplace has no remote revision to compare, so it stays `available` and is re-applied; only a proven match becomes `up-to-date`.
- KTD4. Progress text stays append-only `console` output gated on non-JSON TTY stdout; results remain the only source for counts, JSON, and exit status.

---

## Implementation Units

### U1. Non-mutating check boundary

- **Files:** `src/core/plugin.ts`, `src/utils/plugin-path.ts`, `src/core/marketplace.ts`, `src/cli/skill-update.ts`.
- **Approach:** Move the marketplace location parser to `src/utils/plugin-path.ts` so core plugin code can classify `plugin@marketplace` sources without an import cycle. Add `checkPluginUpdate` and split `updatePlugin` into check plus `applyPluginUpdate`; make `updatePlugin` classify first and report `up-to-date` as skipped.
- **Verification:** Unit tests for healthy-equal, behind-remote, local marketplace, external-plugin precedence, and unresolvable marketplace.

### U2. CLI phases

- **Files:** `src/cli/commands/plugin.ts`.
- **Approach:** Check every declaration before applying, print `Checking plugin source: <label>` per declaration and `Found N plugin updates.` when any exist, then apply only available declarations, printing the existing `Updating <label>...` start line and settled row.
- **Verification:** E2E pseudo-TTY coverage for ordering, no-op non-mutation, failure preservation, native-only provisional settlement, and unchanged JSON/redirected contracts.

### U3. Documentation

- **Files:** `docs/src/content/docs/docs/reference/cli.mdx`, `src/cli/metadata/plugin.ts`, `CHANGELOG.md`.
- **Approach:** Document the check/found/apply phases and the skipped classification.

---

## Verification Contract

- `bun run build`, `bun run typecheck`, `bun run lint`
- `bun test tests/unit/core/plugin.test.ts tests/unit/cli/tui-plugin-update.test.ts`
- `bun test tests/e2e/plugin-update.test.ts`
- `bun test tests/e2e/skill-update.test.ts`
- `bun test`
- Focused `agent-tui` dogfood of the built `plugin update` with two marketplaces and a failing declaration.
