# TUI Dogfooding

This guide expands [`AGENTS.md`](../AGENTS.md) for interactive CLI navigation, prompts, labels, progress, failure recovery, and visual evidence.

## Tooling boundary

Use the installed `agent-tui` skill for terminal automation. The skill owns installation checks, session lifecycle, snapshots, actions, waits, assertions, and cleanup. This guide owns AllAgents-specific UX coverage and evidence.

## Goal

Prove that the built TUI is understandable to a first-time user and that its underlying mutation changes the expected filesystem state.

## Setup

1. Build the CLI.
2. Create isolated temporary project and HOME directories.
3. Seed the smallest realistic local fixture that exposes every changed state.
4. Add a deliberate, bounded delay when an intermediate progress state would otherwise be too brief to inspect.
5. Launch the built CLI with `agent-tui` and capture each changed decision or progress screen before interacting with it.

Use local Git repositories and URL rewriting for network-shaped flows when practical. Never dogfood against a real user workspace when an isolated fixture can exercise the behavior.

## Confusion pass

For every changed screen, identify:

- the object the user is managing;
- the single decision the screen asks them to make;
- where Back and Ctrl+C land;
- whether scope and destination remain visible and intact.

Apply one screen, one decision:

- A resource list contains resources plus Add and Back.
- A resource detail contains actions for that resource plus Back.
- Scope or destination changes happen by returning to the chooser.
- Maintenance mechanics stay automatic. Show retry only when automatic recovery fails.

If a menu mixes resource selection, navigation, and maintenance operations, simplify it before continuing.

## Language pass

Use the established public term in labels, progress, results, errors, and docs. Internal implementation terms do not belong in user-facing copy. For example, use **Update** rather than sync or reconcile.

Read the complete screen. Adjacent hints, summaries, success messages, and errors must use the same vocabulary.

## Interaction pass

Exercise every changed path that applies:

1. Enter from the main menu.
2. Move forward through each chooser and detail screen.
3. Use Back from every changed level.
4. Use Ctrl+C from every changed level.
5. Complete a successful mutation and verify the next screen and filesystem result.
6. Trigger a realistic failure and verify the recovery path.
7. Exercise retry, repeated failure, cancellation, and eventual success when retry behavior changed.

A transition passes only when it lands on the screen a user would predict without losing or silently changing scope.

## MP4 evidence

Record an MP4 for every visible TUI change, including navigation, prompts, labels, progress, timing, and recovery. The recording is evidence of the built product, not a synthetic mockup.

1. Use the same isolated green-E2E fixture and built CLI used for manual verification.
2. Start from the containing menu so reviewers can see how the changed flow is reached.
3. Drive the real TUI with `agent-tui`; include the changed intermediate state and its authoritative settled result.
4. Use a deliberate fixture delay to keep transient progress readable. Do not alter production timing solely for the recording.
5. Render at a legible terminal size. Cropping and explanatory captions are acceptable; the terminal body must come from the real session.
6. Encode an H.264 MP4 with a broadly compatible pixel format. A GIF and final-frame PNG are optional companions, not substitutes for the MP4.
7. Verify the local MP4 decodes from start to finish and inspect its final frame.
8. Publish the media as a PR attachment or in a persistent evidence location. A branch-hosted asset is durable only when that branch will remain available or the media is merged into a persistent branch before source-branch deletion. Never link `/tmp/` output.
9. Verify the remote asset exists and its byte size matches the local file, then link it from the PR description.

The recording passes only if a reviewer can see the route into the flow, every changed visible state, the relevant in-progress and settled states, and the next stable screen without relying on narration.

## Durable coverage and completion evidence

Keep regression tests for navigation state, scope preservation, cancellation, mutation boundaries, and recovery. Assert exact copy only when wording is a product contract.

Record in the PR description:

- built command and commit;
- temporary workspace and HOME setup;
- selections and transitions exercised;
- filesystem result;
- failure and retry behavior checked;
- MP4 link for visible TUI changes;
- cleanup performed.

Dogfooding is complete only when the changed journey passes the confusion, language, interaction, filesystem, and evidence gates.
