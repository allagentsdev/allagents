# AllAgents Repository Guidelines

This is the `allagents` CLI: a tool for managing AI coding assistant plugins, workspaces, and client synchronization across Claude Code, GitHub Copilot, Cursor, and related clients.

## High-Level Goals

AllAgents should stay predictable, scriptable, and safe for users who manage real local workspaces:
- Keep workspace and plugin operations deterministic.
- Prefer straightforward filesystem transforms over hidden state.
- Make sync/install/update behavior easy to reason about from CLI output alone.
- Preserve user-owned config where ownership boundaries matter.

## Working Style

### Worktree Setup
- For any feature, bug fix, or non-trivial repo change, work from a dedicated git worktree based on the latest `origin/main`.
- Before starting implementation, run `git fetch origin` and verify your worktree `HEAD` is based on the current `origin/main` commit.
- Do not implement from the primary checkout, from a stale local `main`, or from a branch created off an outdated base.
- Default setup:
```bash
git fetch origin
git worktree add ../allagents.worktrees/<type>-<short-desc> -b <type>/<issue-or-topic>-<short-desc> origin/main
cd ../allagents.worktrees/<type>-<short-desc>
bun install
```
- If you discover you are not on a fresh worktree from the latest `origin/main`, stop and fix that first before changing code.

### Planning
- Use plan mode for any non-trivial task (5+ steps or architectural decisions).
- If something goes sideways, STOP and re-plan immediately instead of pushing through a broken approach.
- For non-trivial changes, pause and ask: "Is there a more elegant solution?" before diving in.
- Check in with the user before starting implementation on ambiguous tasks.
- Prefer automation: execute the requested work without extra confirmation unless blocked by missing information, safety concerns, or an irreversible/destructive action the user has not approved.

### Bug Fixes
- Before writing code for a bug fix, confirm you understand the actual problem.
- Ask clarifying questions when the issue is vague, not reproducible from the description, could be user error, or suggests a solution that may not match the real failure.
- Do not assume the first plausible code path is the root cause. Verify the exact commands, environment, and expected versus actual behavior first.

### Subagent Strategy
- Use subagents aggressively to keep the main context window clean.
- Subagents are useful for research, file exploration, tests, and code review.
- For complex problems, parallelize independent investigation and validation work where possible.
- Run a final code review after implementation is complete and before the final green E2E when the task is substantial.

### Simplicity
- Every change should be as simple as possible. Reuse existing code before introducing new abstractions.
- Fix root causes directly. Avoid shotgun debugging and speculative infrastructure.
- Prefer changes that keep ownership boundaries obvious, especially around synced config and generated artifacts.

### Progress Updates
- Provide high-level status updates at natural milestones.
- When scope changes mid-task, communicate the shift and adjust the plan.
- Use parallel tool calls when applicable, especially for independent reads, checks, and validation steps.

### Plans
- Temporary plans and design notes may live under `.claude/plans/` while work is in progress.
- Once implementation is complete, delete stale plan files and update durable docs for any user-facing behavior changes.

## PR & Commit Titles
- Prefer conventional commit style for branch-facing titles: `type(scope): summary`.
- Use the repository's normal types where they fit, such as `feat`, `fix`, `docs`, `style`, `refactor`, `test`, and `chore`.
- Use the most relevant area as `scope`, such as `cli`, `sync`, `plugin`, `workspace`, `docs`, or `mcp`.
- Do not prefix PR titles with `[codex]` unless the user explicitly requests it.
- Do not add `Co-Authored-By` attribution unless explicitly requested.

## Branch & PR Workflow

### Branching
- Never implement directly on `main` for feature or bug-fix work. Use a branch and PR.
- When working from an issue, create the branch from a fresh worktree:
```bash
git worktree add ../allagents.worktrees/<type>-<short-description> -b <type>/<issue-number>-<short-description> origin/main
cd ../allagents.worktrees/<type>-<short-description>
```

### Pull Requests
- Push the branch and open a PR once the change is validated.
- When referencing an issue, include `Closes #<issue-number>` in the PR body.
- Before merging, ensure CI passes, the branch is up to date enough to merge cleanly, and any required review has happened.
- Include the exact E2E steps in the PR description so a reviewer can reproduce what was validated.

### Merge Policy
- Always use squash merge when merging PRs to `main`.
- Do not use regular merge or rebase merge unless the user explicitly asks for it.
```bash
gh pr merge <PR_NUMBER> --squash --delete-branch --admin
```

### After Squash Merge
- After a PR is squash-merged, do not continue working from the old branch.
- For follow-up fixes, start from fresh `main` on a new branch:
```bash
git checkout main
git pull origin main
git checkout -b fix/<short-description>
```

### Worktree Cleanup
- The default worktree location is `../allagents.worktrees/` (already ignored by git).
- When done, remove the worktree explicitly:
```bash
git worktree remove ../allagents.worktrees/<name>
```

## Tech Stack & Tools
- Runtime and package manager: Bun
- Language: TypeScript
- Tests: `bun:test` unit and E2E tests
- Lint/format: Biome

## Testing & Verification

### Core Commands
- Build: `bun run build`
- Unit tests: `bun test`
- E2E tests: `bun run test:e2e`
- Typecheck: `bun run typecheck`
- Lint: `bun run lint`

### Test Approach
- Prefer one test per distinct code path.
- Avoid redundant tests that exercise the same branch with cosmetic input changes.
- Test behavior rather than implementation details.
- Keep tests fast enough to stay practical in CI.
- Avoid mocks that drift from the real interface and create false confidence.
- Prefer testing actual outcomes over asserting that internal helpers were called with specific arguments.

### Manual E2E Testing
- Run a red E2E before implementation to confirm current behavior.
- Run a green E2E after implementation to verify the end-to-end fix.
- Build the CLI and test the real commands affected by the change:
```bash
bun run build
./dist/index.js update
./dist/index.js plugin update
```
- Create a temporary workspace in `/tmp/`, configure it to exercise the change, run the built CLI, and verify the filesystem result matches expectations.
- Include the E2E steps in the PR description so a reviewer can reproduce them.
- Document the exact commands you ran and what behavior you verified.

### Development Workflow Summary
1. Red E2E — build the CLI, test current behavior, confirm the problem
2. Implement — write code and unit or integration tests
3. Code review — review the implementation for correctness, DRY, and coverage
4. Green E2E — rebuild and confirm the fix works end to end
5. Push — commit, push, and let CI validate the branch

### Code Review
- Run a final review after implementation and before finalizing the PR when the task is substantial.
- Fix important review findings before treating the change as done.

### Git Config Safety
- Never run `git config` in the repo root when testing.
- If test setup needs git identity, scope it to the temp directory with `git config --local`.

## Architecture Notes

### MCP Server Sync
- MCP servers from plugins are synced into VS Code's `mcp.json`.
- Only track servers that AllAgents added.
- If a server already existed in the user's config before plugin install, do not track it and do not remove it on uninstall.
- `trackedServers` means "servers we own and are responsible for updating or removing."

### CLI Output Paths
- Sync results are surfaced from multiple entry points, including workspace sync, plugin install/uninstall/update, and TUI sync actions.
- Shared formatting should live in the common sync formatting module rather than being duplicated at call sites.
- The key call sites are:
  - `update` / `workspace sync` in `src/cli/commands/workspace.ts`
  - `plugin install|uninstall|update` in `src/cli/commands/plugin.ts`
  - TUI sync actions in `src/cli/tui/actions/sync.ts`
- Shared formatting lives in `src/cli/format-sync.ts`.

### VS Code / Copilot Alias
- `vscode` is a display alias for `copilot` for artifact counts only.
- MCP output should continue using the raw client name because VS Code and Copilot have separate MCP support.
- Internally, `vscode` and `copilot` remain distinct client types with separate path mappings.

## Publishing
- Never run `npm publish` directly.
- Use the GitHub Actions `Publish` workflow for release tagging and npm publishing.
- For recovery, dispatch `Publish` with `channel=existing` and the release tag/ref.
- `prepublishOnly` exists to prevent untested direct publishes outside the workflow.

## Interactive Testing

- TUI navigation, prompt, copy, status, or recovery changes: use the installed `agent-tui` skill for terminal automation, then apply the AllAgents-specific acceptance criteria in [`docs/agent-guides/tui-dogfooding.md`](docs/agent-guides/tui-dogfooding.md) before implementation and final verification.
