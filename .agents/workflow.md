# Workflow

This guide expands [`AGENTS.md`](../AGENTS.md) for worktree setup, planning, execution, git history, pull requests, and documentation cleanup.

## Worktree setup

Start every repository change by fetching `origin` and inspecting branch status.

For a feature, bug fix, or non-trivial change, create a dedicated worktree from the latest `origin/main`:

```bash
git fetch origin
git worktree add ../allagents.worktrees/<type>-<short-desc> \
  -b <type>/<issue-or-topic>-<short-desc> origin/main
cd ../allagents.worktrees/<type>-<short-desc>
bun install
```

Before implementation, verify the worktree `HEAD` contains the current `origin/main` commit. Stop and repair the worktree when the base is stale, the checkout is the primary repository, or another worker owns dirty paths.

Use `../allagents.worktrees/` for dedicated worktrees. Remove the worktree explicitly after its branch is merged or abandoned.

## Planning and execution

- Use an explicit plan or task list for work with five or more steps or architectural decisions.
- Resolve repository-provided facts before asking the user. Ask only when materially different product tradeoffs remain.
- When evidence contradicts the approach, stop and re-plan rather than layering fixes onto a broken premise.
- Before a non-trivial implementation, ask whether a smaller or more direct design satisfies the same contract.
- Fix root causes and migrate every affected caller. Remove obsolete paths instead of maintaining unrequested compatibility shims.
- Prefer existing modules and conventions over new abstractions.
- Use independent subagents for genuinely independent research, implementation, or review slices. Define shared contracts before dispatch and run project-wide validation once after integration.
- Report status at natural milestones and update the task list when scope changes.

Temporary implementation plans may live under `.claude/plans/`. Delete stale plans after implementation and move durable behavior into public docs or `.agents/` guidance.

## Commits and pull requests

Use conventional titles such as `fix(cli): simplify update status` or `docs(workflow): document TUI evidence`.

- Use the most relevant scope: `cli`, `sync`, `plugin`, `workspace`, `docs`, or `mcp`.
- Do not prefix PR titles with `[codex]` unless requested.
- Do not add `Co-Authored-By` attribution unless requested.
- Stage explicit paths and keep unrelated user changes out of commits.
- Push completed work to its feature branch and open or update the pull request.
- Reference issues with `Closes #<issue-number>` in the PR body.
- Record exact E2E commands, fixture setup, observed behavior, and evidence links in the PR description.
- Ensure CI passes, review findings are resolved, and the branch can merge cleanly.

Always squash-merge pull requests to `main`:

```bash
gh pr merge <PR_NUMBER> --squash --delete-branch --admin
```

After a squash merge, start follow-up work from fresh `main` on a new branch. Do not continue pushing the merged branch.
