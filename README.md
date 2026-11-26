# Profile rename terminal verification

The recording uses terminal snapshots from the built CLI captured with agent-tui. Each captured state is held for three seconds.

The Linux fixture used Node 22.22.1 and Claude Code 2.1.332 with a temporary HOME and working directory. Its workspace declared an installed Claude Code profile named `work` with launcher `work-claude`, plus a declared-only OMP profile named `spare`.

- `bun run build` built the CLI.
- `node dist/index.js --json profile install work --yes --offline` installed the Claude Code profile. The isolated client directory then received a session fixture and a file-based credential fixture.
- `node dist/index.js profile rename work office` displayed the plan. Enter on the default No choice cancelled. SHA-256 checks confirmed that workspace YAML and the launcher kept their original bytes.
- The same command ran again. Left selected Yes and Enter applied the rename. The session and credential fixtures moved, the old root and recovery record disappeared, and the unchanged launcher name targeted the new configuration directory.
- `node dist/index.js --json profile status office` reported `installed`.
- `node dist/index.js profile rename spare backup --dry-run` previewed the declaration edit. `node dist/index.js --json profile rename spare backup --yes` returned `renamed` with `installed: false` and created no client profile directory.

See [the terminal results](results.txt) and [the confirmation recording](profile-rename-confirmation.mp4).
