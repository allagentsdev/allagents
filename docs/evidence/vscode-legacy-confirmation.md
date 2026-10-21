# Legacy VS Code repository confirmation

[Watch the built TUI recording](vscode-legacy-confirmation.mp4).

The recording starts in the main menu and selects Update in an isolated project with one local skill plugin. Its older sync state has repository membership but no folder-name snapshot. YAML says `name: YAML name`; the corresponding editor folder says `Editor name`.

The recording covers default **No**, Ctrl+C, retry, explicit **Yes**, and the next stable main menu. The preview identifies the project and repository, quotes both names, and states the repository-only scope. The active update spinner stops before the decision. Decline and cancellation preserve `workspace.yaml`, the editor workspace, and sync state byte for byte. Approval changes only the expected YAML repository name, preserves the plugin declaration and comment exactly, retains the editor name, and upgrades the saved folder baseline.

The terminal body consists of actual `agent-tui screenshot --format json` grids from the real built CLI, rendered with a monospace font and explanatory captions. Screens were captured after every action; readable frame durations were assigned during encoding. This is a 44-second H.264/yuv420p MP4 at 1240×960, verified to decode completely. No production timing or terminal content was fabricated.

Reproduction: create isolated HOME/project directories and a local plugin containing `skills/demo/SKILL.md`; configure the `vscode` client and one named repository; run `bun dist/index.js update --scope project --offline`; delete `vscodeWorkspaceFolders` and clear `files` in `.allagents/sync-state.json`; change the YAML and editor folder names independently. Launch `bun dist/index.js` with `agent-tui` at 120 columns × 40 rows, select Update, accept default No, retry with Ctrl+C, then retry and select Yes. The automation session was explicitly terminated afterward. Temporary fixtures are removed after evidence publication.

Recorded bundle SHA-256: `fb782341871ea4a5e26c076d8bb1a37310f9e331699d02c4fe58c82e6354a8ef`.
