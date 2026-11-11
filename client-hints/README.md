# Client names in plugin hints

Built commit: `98ec96f` on `fix/tui-skill-labels` (follow-up to `505c4d9`).

[Updated walkthrough](client-hints.mp4) · [Selected skill](skill-selected.png)

Plugins now shows `skill · allagentsdev/agent-plugins · project · Codex`. The detail title retains `file codex`, so installation methods remain available after opening the entry. Client names come from the shared client registry; automated coverage also checks the native Pi label and retained native-method details.

## Built verification

Used the actual bundled `dist/index.js`, agent-tui 1.1.0, and an isolated `/tmp/allagents-client-hints-e2e/{home,workspace}`. The project configured `clients: [codex]` and the original `https://github.com/allagentsdev/agent-plugins/tree/main/plugins/productivity/skills/write-naturally` source. A valid root `SKILL.md` was seeded in `home/.allagents/plugins/marketplaces/allagentsdev-agent-plugins@main/plugins/productivity/skills/write-naturally`.

From the isolated workspace:

```bash
env HOME=/tmp/allagents-client-hints-e2e/home \
  ALLAGENTS_TEST_HOME=/tmp/allagents-client-hints-e2e/home \
  bun /absolute/worktree/dist/index.js update --scope project --offline
agent-tui run --format json --cwd /tmp/allagents-client-hints-e2e/workspace \
  --env HOME=/tmp/allagents-client-hints-e2e/home \
  --env ALLAGENTS_TEST_HOME=/tmp/allagents-client-hints-e2e/home \
  --cols 120 --rows 40 bun -- /absolute/worktree/dist/index.js
```

Verified main menu → Plugins → selected skill → details. Back and Ctrl+C return to the expected containing screens; read-only navigation leaves configuration bytes unchanged. A temporarily unavailable cached source reports the existing “No skills found” message and returns to details; restoring it permits browsing again. Removal deletes the exact configured declaration and `.codex/skills/write-naturally/SKILL.md`, then returns to the Plugins list and main menu. No recovery behavior changed.

The MP4 contains actual terminal grids with captions outside the terminal and readable frame durations. Encoded as H.264/yuv420p, decoded completely, and selected/final frames inspected. Sessions and dedicated daemon were stopped, and fixtures were removed after publication. Raw captures and a rendering manifest are included; run `python3 ../render.py manifest.json client-hints.mp4` from this directory to render them again.

The existing native/file display regression failed before implementation and passed afterward. The 17 focused display/native/MCP tests, typecheck, lint and build pass. Lint retains four existing warnings. Independent review completed with no findings; `review.json` records its coverage. The full local run reported 2,692 passed, 7 skipped and one 5-second timeout in the unrelated MCP HTTP cleanup test (`tests.log`). Rerunning its complete 26-test file passed, including that test (`mcp-rerun.log`); no MCP code or timeout was changed.
