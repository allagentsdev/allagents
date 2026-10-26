# Plugin refresh efficiency and progress

Implementation branch: `perf/plugin-refresh-progress`, based on `2dca7ee`.
No Scout launcher, other checkout, or live plugin cache was modified. The work
was first completed locally; the user subsequently authorized a pull request
and squash merge after validation.

## Behavior

Install reconciliation reuses the revision/checkout-health check from explicit
plugin updates. The skip requires the declared origin, ref, commit, and clean
tracked/untracked working tree to match. Per-session physical cache deduplication
still applies to shared subpaths. Changed or unverifiable sources retain the
previous pull and usable-cache fallback. Offline makes no remote check; cold
caches still use depth-one clones. Deep URLs retain their ref-qualified caches.
No cache cleanup, reset, or migration was added.

The shared health check reads the configured origin identity without expanding
user `insteadOf` transport rules. It accepts a detached tag when Git returns
empty symbolic-ref output, while rejecting that state for an explicit branch.

TTY progress identifies the source/ref and check, download, or update stage,
with elapsed time during slow Git work. Concurrent sources keep pending work
visible. Cached fallback stays visible after successful reconciliation. Owned
progress stops before later prompts; existing TUI spinners are reused. Terminal
controls are sanitized; progress omits transport URLs and Git error text.
JSON and redirected output retain their existing contracts.

## Measurements

[Raw samples and Git operation counts](plugin-refresh-progress.timings.json).

Both binaries are self-contained built CLI bundles: baseline `2dca7ee` and the
candidate change. Each used a fresh temporary HOME/project, a small bare Git
remote, a deep GitHub `main` skill URL rewritten to that remote, and a local
plugin installed into a workspace already declaring the remote skill. Clients
were Codex and Pi. Every command ran in a new process.

```sh
<built-cli> --json plugin install ./local --scope project --client codex,pi --yes
```

Wall time surrounds `Bun.spawnSync`. `GIT_TRACE2_EVENT` counts real Git
`cmd_name` events, including pull's child fetch. Five unchanged samples were
measured after a cold install. Baseline and candidate ran sequentially after
the full test suite finished.

| Scenario | Baseline | Candidate | Result |
| --- | ---: | ---: | --- |
| Unchanged local remote, median of 5 | 340.78 ms | 411.99 ms | Health checks add 71.21 ms on this small fixture |
| Unchanged controlled latency, median of 5 | 995.43 ms | 571.79 ms | 423.64 ms / 42.6% faster |
| Cold cache, one sample | 348.46 ms | 338.70 ms | One shallow clone in both |
| Advanced upstream, one sample | 351.29 ms | 363.24 ms | Both clients receive new content |
| Offline, one sample | 300.00 ms | 349.84 ms | No remote commands |
| Failed remote with cache, one sample | 336.04 ms | 402.41 ms | Both clients retain last content |

The controlled profile injects 600 ms before pull and 100 ms before ls-remote;
it models operation cost, not real-network fidelity. Conservative health checks
cost more than a tiny local no-op pull. The reliable improvement is eliminating
unchanged fetch, merge, and maintenance work. Online checks still need a round trip.

| Unchanged operation per command | Baseline | Candidate |
| --- | ---: | ---: |
| ls-remote | 0 | 1 |
| pull | 1 | 0 |
| fetch | 1 | 0 |
| merge | 1 | 0 |
| maintenance | 1 | 0 |
| pack/index/unpack work | 0 | 0 |

Changed and failed sources add one revision probe before the established pull.
The original reported 69.836-second startup has no per-stage trace; these
fixtures do not establish how much of that run this change would save. No
version regression was inferred.

Cold clones already limit history. An isolated `git pull --depth=1 --ff-only`
experiment failed on ordinary linear advancement because the new shallow
boundary hid ancestry. Changed refreshes retain plain pull and may transfer
intervening history. Restricting a shared cache to one skill or rewriting its
history needs a separate design that preserves other subpaths and user edits.

## Validation

```sh
bun install --frozen-lockfile
bun run build
bun test
bun run typecheck
bun run lint
bun run package:check
bun run package:smoke
```

Integrated suite: **2,363 pass, 7 skip, 0 fail**, 199 files. Build, typecheck,
lint, package-size checks, and isolated packed-package Node smoke passed.
Lint reports 17 existing warnings in `src/utils/workspace-source-editor.ts`.

Regressions cover real Git unchanged/changed caches, URL rewriting, detached
tags versus explicit branches, dirty tracked/untracked preservation, failed
remotes, offline command counts, and built local-plugin installation reconciling
an existing deep-URL skill. Progress tests cover concurrent pending sources,
sanitization, JSON, redirected output, interruptions, fallback and prompt ordering.

On the same isolated project/source/cache, baseline and candidate redirected
human output and JSON matched exactly. Candidate JSON on a pseudo-TTY remained
one parseable document. Stderr was empty.

## Terminal evidence

[Built TUI recording](plugin-refresh-progress.mp4).
[Captured terminal grids](plugin-refresh-progress.frames.json).

Real `agent-tui` sessions start from the main menu at 120 columns with isolated
HOME/project and a local Git URL rewrite. The fixture adds four seconds before
clone, ls-remote and pull to make transient states readable. Production timing
is unchanged. The recording covers cold download, Ctrl+C during a check, retry,
unchanged refresh, upstream advancement, remote loss with persistent cached
fallback, and recovery to newer content. Successful flows verify bytes in both
`.codex/skills/selected` and `.pi/skills/selected`; cancellation verifies unchanged
cache HEAD and no new sync state. Progress adds no Back or decision screens.

The terminal body is rendered directly from captured grids, with captions and
assigned readable frame durations. The H.264/yuv420p MP4 is 1240×1000 and 77
seconds; it was decoded completely and its final frame inspected. Sessions are
explicitly terminated. Temporary projects, remotes, and HOME directories are
removed after evidence is retained locally.

The recording also covers initial project/user direct Git installs and GitHub
source verification before configuration is written. User-scope artifacts were
checked at `.codex/skills/selected` and `.pi/agent/skills/selected`. The original
built direct-install path was observed silent during its delayed validation
clone; the corrected built path reports that first clone.

## Review and provenance

`ce-code-review` completed run `20261026-152551-df1f5bb3` with nine local
review lenses. It found two actionable issues: initial pre-write validation
bypassed progress, and selecting only the last configured origin URL could
misclassify a cache. Both were fixed, independently rechecked, and covered by
five real-Git regressions observed failing before the fixes and passing after.
No actionable findings remain. Claude cross-model review could not authenticate;
the required independent adversarial review ran locally instead.

Final verified CLI bundle SHA-256: `329b157bb46d09c30005d5e7defdb556070056b02e53dc22b15cdb48200b61d0`.
MP4 SHA-256: `e3870508c22d8b5c19e749853e6ab7f2394ce5de37591f82142bb586f0983615`.

The recording, terminal captures, timing data, and this report live only on the
persistent orphan branch `evidence/plugin-refresh-progress`. They are excluded
from the feature branch and `main`; the pull request links to this branch. Keep
the evidence branch after merge so those links remain available.

## CI follow-up

[PR #594](https://github.com/allagentsdev/allagents/pull/594) initially exposed
two order-dependent GitHub credential-fallback test failures. An earlier
marketplace fixture replaces the shared `GitCloneError` constructor with a bare
error class. The GitHub-fetch fixture then imports that replacement, so its
authentication errors lack `isAuthError` and skip the intended GitHub CLI fallback.
The exact two failures were reproduced with CI's Bun 1.4.0.

Commit `fe4deede3699880be969e4aa87cb1b34ff91da90` moves all 15 existing cases
unchanged into an isolated worker and keeps the normal test entry point as its
launcher. Both ordered reproductions pass after the fix. The complete CI-pinned
Bun 1.4.0 suite passes 2,349 parent-suite tests plus all 15 preserved worker cases,
with 7 skipped and no failures. Production source, packages and lockfile are
unchanged, so the existing built-terminal recording still covers the final
product behavior. The PR carries the subsequent hosted CI result.
