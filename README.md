# Interactive skill labels

Built commit: `505c4d9` (`fix/tui-skill-labels`), based on `9d9af09`.

[Walkthrough](skill-labels.mp4) · [Before](before.mp4) · [Selected skill](skill-selected.png)

The H.264/yuv420p walkthrough uses actual `agent-tui` screenshot grids at 120 columns by 40 rows. Captions sit outside the terminal. Screens have assigned readable durations; terminal content was not fabricated. Both videos decoded successfully from start to finish; final frames were inspected.

## Fixture and commands

The fixture used `/tmp/allagents-skill-labels-e2e/{home,workspace}`. Both scopes configured the `codex` file client. Project sources were:

```text
https://github.com/allagentsdev/agent-plugins/tree/main/plugins/productivity/skills/write-naturally
https://github.com/allagentsdev/agent-plugins/tree/main/plugins/alternate/skills/write-naturally
```

Each had a valid root `SKILL.md` in the isolated `home/.allagents/plugins/marketplaces/allagentsdev-agent-plugins@main` cache. The user source was a local root skill at `/tmp/allagents-skill-labels-e2e/other/write-naturally`.

```bash
bun run build
# Run from the isolated workspace, repeating for --scope user:
env HOME=/tmp/allagents-skill-labels-e2e/home \
  ALLAGENTS_TEST_HOME=/tmp/allagents-skill-labels-e2e/home \
  bun /absolute/worktree/dist/index.js update --scope project --offline
# agent-tui 1.1.0, using a dedicated foreground daemon/socket:
agent-tui run --format json --cwd /tmp/allagents-skill-labels-e2e/workspace \
  --env HOME=/tmp/allagents-skill-labels-e2e/home \
  --env ALLAGENTS_TEST_HOME=/tmp/allagents-skill-labels-e2e/home \
  --cols 120 --rows 40 bun -- /absolute/worktree/dist/index.js
agent-tui -s SESSION screenshot --format json
agent-tui -s SESSION press ArrowDown
agent-tui -s SESSION wait --stable
agent-tui -s SESSION kill --yes
```

The single-skill scenario removed the alternate fixture declaration and the user installation, then ran the project offline update again. The video presents that simpler scenario first, followed by duplicate-name and removal coverage.

## Observed behavior

- Plugins and Workspace status show `write-naturally` with the `skill` kind and compact repository. Duplicate names show distinct source paths/refs; project/user scope stays visible.
- Details show the full configured URL; Browse skills uses the short name.
- Back works from detail, resource list and Workspace status. Ctrl+C works from Browse skills, detail, resource list and Workspace status without changing declarations.
- Removing the user skill removes only its declaration and `home/.codex/skills/write-naturally/SKILL.md`. The project configuration remains byte-identical and the project skill remains installed.
- Temporarily moving the cached source away while its detail is open produces the existing “No skills found” result and returns to details. Restoring it makes browsing work again. No retry implementation changed.
- All terminal sessions were killed. Temporary source fixtures and daemon were removed after artifact publication. The feature worktree remains for the open PR.

## Verification

`bun test`: 2,693 passed, 7 skipped, 0 failed (2,700 tests across 214 files). The focused display/native/MCP suite passed again after the final Browse skills title change: 17 passed, 54 assertions.

`bun run typecheck`, `bun run lint`, `bun run build`, `bun run package:check`, and `bun run package:smoke` passed. Lint retained existing schema-version information and four unrelated non-null-assertion warnings. The packed artifact passed isolated Node smoke for 55 help nodes without runtime dependencies.

Independent code review completed with no findings; receipt is in `review.json`. Full test output is in `tests.log`. Raw captures and rendering manifest are included; render with `python3 render.py manifest.json skill-labels.mp4` from this directory.
