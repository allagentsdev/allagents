# Contributing to AllAgents

Thanks for contributing.

## The One Rule

**Understand your change.** If you can't explain what your code does, why it belongs in AllAgents, and how it affects existing behavior, don't submit it yet.

Using AI tools is fine. Shipping code you don't understand is not.

## Before You Build

For non-trivial features or behavior changes, open an issue first and wait for maintainer alignment.

## Development Setup

```bash
bun install
bun run build
bun test
```

Run CLI changes from source during development:

```bash
bun run dev workspace init test-ws
bun run dev update
```

## Before Submitting a PR

- PR explains what changed and why
- Tests are updated when relevant
- No unrelated refactors in the same PR
- Run focused local checks while developing and the relevant broad checks before pushing
- Manual E2E test: build the CLI (`bun run build`) and run against a temp workspace

GitHub Actions is the authoritative broad quality gate. It runs build, typecheck,
lint, and the full test suite as separate checks on pull requests and `main`.
Repository maintainers should configure the `Build`, `Typecheck`, `Lint`, and
`Test` checks as required in the `main` branch protection rules after this
workflow lands. You can run the same checks locally when needed:

```bash
bun run build
bun run typecheck
bun run lint
bun run test
```

## Dependency Maintenance

Dependabot opens weekly grouped updates for the root Bun project, the
documentation site, and GitHub Actions. GitHub does not currently provide
Dependabot security updates for Bun, so the `Dependency Audit` workflow runs
`bun audit --audit-level=moderate` against both lockfiles every day and on pull
requests that change dependency manifests, lockfiles, or audit automation.

Before submitting a manual dependency update, run frozen installs and audits
for both dependency trees:

```bash
bun install --frozen-lockfile
bun audit --audit-level=moderate
bun install --cwd docs --frozen-lockfile
bun audit --cwd docs --audit-level=moderate
```

Older clones may still have the previously generated prek pre-push hook. If a
push still invokes prek, inspect `.git/hooks/pre-push` and remove it only when
it is the generated prek hook; preserve any custom hook content.

## Workflow

- Branch from `main`
- Use conventional commits: `type(scope): description`
- Open a PR (draft is fine)
- Squash merge when approved

## Publishing

Releases are automated with [Release Please](https://github.com/googleapis/release-please).

Conventional commits drive the version: `feat` bumps the minor version, `fix` and
`perf` bump the patch version, and `!` or a `BREAKING CHANGE:` footer bumps the
major version. Release Please keeps a release pull request open with that
version, the `package.json` bump, and the `CHANGELOG.md` entry.

Merging the release pull request finalizes the release. It creates the tag and
GitHub release, publishes the package to npm, and attaches standalone CLI
binaries with a `SHA256SUMS` file to the release. There is no manual next-tag,
bump, or promote step.

- Never bump `package.json`, edit the version manifest, or create a release tag by hand.
- Never run `npm publish` directly.
- Recovery: dispatch the `Publish` workflow with the release tag, and the
  `Release Please` workflow with `tag` to rebuild the release binaries.
- npm channels: `latest` is the newest stable release, and `next` tracks `main`
  — every push with an open release pull request previews the pending version
  as `<pending>-next.<run>`, so `npx allagents@next` runs what main has now.

## Architecture

See [CLAUDE.md](./CLAUDE.md) for architecture notes, coding standards, and AI agent guidelines.
