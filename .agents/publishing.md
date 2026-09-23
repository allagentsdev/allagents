# Publishing

This guide expands [`AGENTS.md`](../AGENTS.md) for package releases and recovery.

Releases are automated with [Release Please](https://github.com/googleapis/release-please):

- Conventional commits on `main` feed a release pull request that Release Please keeps up to date. The pull request carries the version computed from the commits (`feat` → minor, `fix`/`perf` → patch, `!` or `BREAKING CHANGE:` → major), the `package.json` bump, and the `CHANGELOG.md` entry.
- Merging that pull request is the finalize step. The `Release Please` workflow then publishes the new tag to npm through the `Publish` workflow and attaches standalone binaries plus `SHA256SUMS` to the GitHub release.
- There is no manual next-tag, bump, or promote step. Never bump `package.json`, edit the version manifest, or create a release tag by hand.
- Never run `npm publish` directly. Keep `prepublishOnly` intact; it prevents untested direct publication outside the workflow.
- Write conventional commit subjects: the release pull request's changelog section is generated from them, and hidden types (`chore`, `docs`, `refactor`, `test`, `ci`, `build`, `style`) do not appear.
- For npm recovery, dispatch `Publish` with the release tag (`ref`). It validates that the tag matches `package.json` at that commit, ensures the GitHub release exists, and publishes idempotently.
- To preview the pending release on the npm `next` dist-tag, dispatch `Release Next`. It reads the pending version from the open release pull request, tags `vX.Y.Z-next.N` on a commit that carries that prerelease version, and publishes through the same `Publish` workflow. Stable releases stay owned by the release pull request, so previewing never moves the stable version.
- To rebuild binaries for an existing release, dispatch `Release Please` with `tag` set to the release tag.
- Before dispatch, verify the target commit, version, and tag agree.
- After dispatch, verify the workflow result, GitHub release assets, and npm package version before reporting success.
