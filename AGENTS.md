# AllAgents Agent Guide

This file is the root index for repository-facing agent instructions. It carries the rules that apply to every change and routes task-specific work into `.agents/*.md`. A matching route is required reading before implementation; linked guides are authoritative for their area.

AllAgents is a CLI for managing AI coding-assistant plugins, workspaces, and client synchronization across Claude Code, GitHub Copilot, Cursor, and related clients.

## Product goals

- Keep workspace and plugin operations deterministic.
- Prefer explicit filesystem transforms over hidden state.
- Make install, update, and synchronization behavior understandable from CLI output.
- Preserve user-owned configuration where ownership boundaries matter.

## Always-read rules

- For every feature, bug fix, or non-trivial repository change, work from a dedicated worktree based on the latest `origin/main`. Read [`.agents/workflow.md`](.agents/workflow.md) before changing files.
- Use Bun for package, build, and test operations.
- Use an explicit task list for work with five or more steps or architectural decisions. If the approach stops matching observed behavior, stop and re-plan.
- Prefer the smallest root-cause fix. Reuse existing code and keep ownership boundaries visible.
- Verify the changed behavior through the real built surface. A passing unit test is not a substitute for manual E2E when users interact with the changed path.
- Preserve JSON and redirected-output contracts when changing interactive CLI output unless the request explicitly changes them.
- Keep user-owned configuration intact. Track, update, or remove only artifacts AllAgents owns.
- Update user documentation and durable agent guidance when behavior or the development workflow changes.
- Push feature work through a branch and pull request. Never implement or push directly on `main`.
- Use conventional commit and PR titles, omit automated co-author attribution unless requested, and squash-merge to `main`.
- Use the GitHub Actions `Publish` workflow for releases. Never run `npm publish` directly.

## Repository map

- `src/cli/`: commands, shared output formatting, and TUI actions.
- `src/core/`: workspace, plugin, marketplace, synchronization, and profile behavior.
- `src/models/`: configuration and client models.
- `tests/unit/`: focused behavioral contracts.
- `tests/e2e/`: built CLI and filesystem workflows.
- `docs/src/content/docs/`: public documentation.
- `plugins/`: first-party plugin content.
- `.agents/`: task-specific repository guidance reached through the routing table below.

## Routing

Read every guide whose trigger matches the task before implementation.

| If the change… | Read first |
| --- | --- |
| involves worktrees, planning, subagents, branches, commits, PRs, merge policy, or documentation cleanup | [`.agents/workflow.md`](.agents/workflow.md) |
| changes runtime behavior, tests, CLI output, filesystem effects, or requires build/E2E evidence | [`.agents/verification.md`](.agents/verification.md) |
| changes TUI navigation, prompts, labels, progress, recovery, or needs screenshot/video evidence | [`.agents/tui-dogfooding.md`](.agents/tui-dogfooding.md) |
| changes MCP ownership, synchronization output, client aliases, or related architecture boundaries | [`.agents/architecture.md`](.agents/architecture.md) |
| changes package versions, release tags, npm publication, or publish recovery | [`.agents/publishing.md`](.agents/publishing.md) |

Before marking a branch ready, complete the checklist in [`.agents/verification.md`](.agents/verification.md). TUI changes additionally require the acceptance and evidence gates in [`.agents/tui-dogfooding.md`](.agents/tui-dogfooding.md).
