# Publishing

This guide expands [`AGENTS.md`](../AGENTS.md) for package releases and recovery.

Releases are automated with [Release Please](https://github.com/googleapis/release-please):

- Conventional commits on `main` feed a release pull request that Release Please keeps up to date. The pull request carries the version computed from the commits (`feat` → minor, `fix`/`perf` → patch, `!` or `BREAKING CHANGE:` → major), the `package.json` bump, and the `CHANGELOG.md` entry.
- Merging that pull request is the finalize step. The `Release Please` workflow then publishes the new tag to npm through the `Publish` workflow.
- There is no manual next-tag, bump, or promote step. Never bump `package.json`, edit the version manifest, or create a release tag by hand.
- Never run `npm publish` directly. Keep `prepublishOnly` intact; it prevents untested direct publication outside the workflow.
- Write conventional commit subjects: the release pull request's changelog section is generated from them, and hidden types (`chore`, `docs`, `refactor`, `test`, `ci`, `build`, `style`) do not appear.
- The npm `latest` dist-tag is the latest stable release and only moves when a release pull request is merged.
- The npm `next` dist-tag tracks `main`: every push that has an open release pull request publishes the pending version as `<pending>-next.<run>` to `next`, and tags that commit as `v<pending>-next.<run>` with a GitHub prerelease. Nothing to preview means `main` already matches the last release.
- `bun scripts/tag-channel.ts next|latest [version]` moves a dist-tag by hand; it needs a locally authenticated npm session, because trusted publishing covers only `npm publish`.
- For npm recovery, dispatch `Publish` with the release tag (`ref`). It validates that the tag matches `package.json` at that commit, ensures the GitHub release exists, and publishes idempotently.
- Before dispatch, verify the target commit, version, and tag agree.
- After dispatch, verify the workflow result, GitHub release, and npm package version before reporting success.

## Trusted publisher configuration

Both publishing jobs use the GitHub Actions `npm` environment and npm OIDC.
In the npm `allagents` package settings, authorize `allagentsdev/allagents`
with environment name `npm` and direct `npm publish` allowed for both
`publish.yml` and `release-please.yml`. Stable publication calls the reusable
`publish.yml` workflow; preview publication runs in `release-please.yml`.
See [npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

Before merging an environment migration, add matching environment-bound npm
publishers alongside the existing publishers, if npm permits it. Keep the
existing publishers until in-flight runs finish and a publication using the
new environment succeeds, then remove the superseded entries. If duplicate
workflow entries are unavailable, coordinate the settings update and merge
while no publishing run is active. Record the npm settings verification in
the migration PR before merging.

The `npm` environment follows `oh-my-promptfoo` without required reviewers or
branch restrictions, so automated previews continue to run. Add protections
only after checking both automatic releases and manual recovery: the workflow
run ref can differ from the release tag checked out through the `ref` input.
