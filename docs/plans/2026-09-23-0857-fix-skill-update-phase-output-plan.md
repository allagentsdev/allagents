---
title: Skill Update Phase Output - Plan
type: fix
date: 2026-09-23
artifact_contract: ce-unified-plan/v1
product_contract_source: ce-plan-bootstrap
execution: code
---

# Skill Update Phase Output - Plan

## Goal Capsule

- **Objective:** A person running `skill update` can tell whether AllAgents is checking sources or applying discovered updates, including during slow Git work.
- **Means:** Restore separate check and apply progress boundaries, report the discovered skill count between them, and render apply progress with installed skill names rather than source names (KTD1, KTD2).
- **Authority:** Typed update plans and execution results remain authoritative for decisions, mutation, totals, JSON, and exit codes.
- **Stop conditions:** No update-semantic changes, new statuses, concurrency, spinner framework, plugin-update redesign, or JSON schema changes.

## Product Contract

### Summary

Make the interactive `skill update` transcript follow the operation lifecycle: check each source, report what was found, then announce and settle each skill update.

### Problem Frame

The progressive-output change in PR #504 emits `Updating <source>...` from the preflight callback even though that callback runs before read-only remote inspection. This makes checking look like mutation and hides the useful distinction between sources checked and skills updated. The original plan and the supplied `npx skills update` transcript both specify separate check and apply phases.

### Requirements

- R1. A human TTY run prints `Checking skills from source: <source>` immediately before each selected remote source preflight.
- R2. After preflight and before persistent update work, the command reports the number of installed skills eligible for update.
- R3. Persistent apply work announces installed skill names, not backing source names, and successful results settle those same names.
- R4. Preflight failures, deletion retention, cancellation, local-source skips, and apply failures remain explicit without implying an update started when no mutation was attempted.
- R5. JSON and redirected human output retain their current schemas, batching, wording, and exit behavior.
- R6. Existing safety, ordering, rollback, offline sync, and filter behavior remain unchanged.
- R7. The built CLI is exercised against an isolated delayed Git fixture, and an H.264 MP4 records the visible check-to-apply transition and settled result.

### Acceptance Examples

- AE1. Given one changed project skill with a delayed source check, the terminal shows `Checking skills from source: <source>` before the delay releases, then a found count, then `Updating <skill>...`, then `✓ Updated <skill>`.
- AE2. Given an unmatched skill filter, the command exits before any source check or update lifecycle line.
- AE3. Given JSON or redirected stdout, the command emits no TTY lifecycle lines and preserves its current output contract.

### Scope Boundaries

- Included: the direct `skill update` command and aliases that reach the same handler, its behavioral coverage, CLI reference, changelog, and recorded dogfood evidence.
- Excluded: generic `plugin update`, Plugins → Update all TUI messaging, update detection semantics, per-file change attribution, and new machine-readable result fields.

### Sources

- `src/cli/commands/skill-update.ts` currently labels preflight starts as updates and renders execution outcomes by source.
- `src/core/skill-update.ts` owns the sequential preflight and execution boundaries.
- `tests/e2e/skill-update.test.ts` already provides a pseudo-TTY and block/release Git fixture that proves progress arrives before slow work completes.
- `docs/plans/2026-09-21-1130-feat-progressive-update-status-plan.md` requires `Checking skills from source: <source>` during preflight.
- `docs/plans/2026-09-16-plugin-skill-update-performance-research.md` records the supplied comparator transcript and distinguishes sources checked from skills successfully applied.

## Planning Contract

### Key Technical Decisions

- KTD1. **Use the existing observer seams.** Rename the preflight observer around what it actually observes and add one narrow execution-start observer at the existing sequential mutation boundary; do not introduce a reporter abstraction.
- KTD2. **Derive display names from the prepared plan.** The command maps physical-unit IDs back to survivor and deletion impacts so presentation can name installed skills while core results remain unchanged.
- KTD3. **Keep progressive output TTY-only.** The command retains the existing `stdout.isTTY && !jsonMode` gate and its batched fallback per R5.
- KTD4. **Prove timing and phase order at the real CLI boundary.** Extend the existing blocked-Git E2E so a future implementation cannot pass by printing a correct-looking transcript only after work completes.

## Implementation Units

### U1. Separate skill check and apply progress

- **Goal:** Render truthful lifecycle phases without changing update decisions or mutations.
- **Requirements:** R1-R6; AE1-AE3.
- **Dependencies:** None.
- **Files:**
  - Modify `src/core/skill-update.ts`.
  - Modify `src/cli/skill-update.ts`.
  - Modify `src/cli/commands/skill-update.ts`.
  - Modify `tests/unit/core/skill-update-progress.test.ts` where observer ordering needs direct coverage.
  - Modify `tests/e2e/skill-update.test.ts` for the observable transcript.
- **Approach:**
  1. Give the preflight callback check-phase naming throughout its callers.
  2. Notify a new optional execution-start observer only when a unit enters persistent apply work, after cancellation, retention, blocked-scope, local, and preflight-failure exits.
  3. Render check progress by source, print the prepared skill count once, then render apply starts and successful settlements by sanitized installed skill name.
  4. Keep source-level rows for outcomes that cannot truthfully be represented as successful per-skill application.
  5. Preserve the existing batched and JSON renderers unchanged.
- **Patterns to follow:** Existing failure-isolated observers in `src/core/skill-update.ts`; terminal sanitization and progressive-output gate in `src/cli/commands/skill-update.ts`.
- **Test scenarios:**
  - Covers AE1. Block the first remote check and assert its `Checking` line is visible before release; after release, assert found-count → skill apply start → skill success → aggregate summary ordering.
  - Covers AE2. Select a missing skill and assert no check or apply observer fires before the usage error.
  - Covers AE3. Run pseudo-TTY JSON and redirected human output and assert no progressive check/apply lines leak.
  - Retain a deleted upstream skill and assert no apply-start line appears for the skipped unit while the retention result remains visible.
  - Throw from progress observers and assert domain execution and rollback behavior remain unaffected.
- **Verification:** The built command exposes the delayed check phase before release, then applies and reports the expected skill while producing the same filesystem result and exit code.

### U2. Document and record the corrected journey

- **Goal:** Make the user-facing contract and review evidence reproduce the implemented behavior.
- **Requirements:** R7.
- **Dependencies:** U1.
- **Files:**
  - Modify `docs/src/content/docs/docs/reference/cli.mdx`.
  - Modify `CHANGELOG.md`.
  - Create one durable H.264 MP4 evidence asset in the repository's established PR evidence location only if required for a persistent PR link.
- **Approach:**
  1. Update the CLI reference and Unreleased changelog entry to distinguish checking sources from applying skills.
  2. Build the CLI and seed an isolated project, HOME, local remote, and deliberate Git delay.
  3. Drive the real command with `agent-tui`, capture the intermediate check phase and settled apply phase, and record the same session.
  4. Verify the video decodes end to end, inspect its final frame, publish it durably, and link it from the PR description with exact reproduction steps.
- **Test scenarios:** Test expectation: none — U1 owns the behavior; this unit records documentation and runtime evidence.
- **Verification:** A reviewer can watch the MP4 and see the real built command transition from source checking to named skill application without relying on narration.

## Verification Contract

- `bun test tests/unit/core/skill-update-progress.test.ts`
- `bun test tests/e2e/skill-update.test.ts`
- `bun run build`
- `bun run typecheck`
- `bun run lint`
- `bun test`
- Run the built `skill update` command through `agent-tui` in the isolated delayed fixture and verify the cache and installed skill content advance to the expected revision.
- Decode the H.264 MP4 from start to finish, inspect the final frame, verify the published asset byte size, and include its persistent link in the PR description.

## Definition of Done

- TTY output distinguishes source checking from skill application in real time.
- Found counts and named skill results are derived from the prepared plan and typed execution results, not synthetic outcomes.
- Units that never enter apply work never print an apply-start line.
- JSON, redirected output, safety semantics, filesystem results, and exit codes remain unchanged.
- Focused coverage, full tests, build, typecheck, and lint pass.
- The built CLI is dogfooded with `agent-tui`; the verified MP4 and reproduction steps are attached to the PR.
- Documentation and changelog match the shipped transcript.
- Dead-end code, temporary fixture data, and local recording intermediates are removed before delivery.
