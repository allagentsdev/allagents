# Publishing

This guide expands [`AGENTS.md`](../AGENTS.md) for package releases and recovery.

- Publish releases through the GitHub Actions `Publish` workflow.
- Never run `npm publish` directly.
- Keep `prepublishOnly` intact; it prevents untested direct publication outside the workflow.
- For release recovery, dispatch `Publish` with `channel=existing` and the existing release tag or ref.
- Before dispatch, verify the target commit, version, tag, and channel agree.
- After dispatch, verify the workflow result, GitHub release/tag, and npm package version before reporting success.
