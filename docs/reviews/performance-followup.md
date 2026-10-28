# CLI performance follow-up

Baseline: `e331f44` (1.21.4), including #594. Candidate: the cleanup change
in `src/core/sync.ts` on `perf/remaining-cli-performance`. #594's unchanged
remote checks and avoided pulls are baseline behavior, not improvements from
this change. No TUI labels, progress, command contracts, or refresh decisions change.

## Finding and change

An initial built-CLI probe measured about 230 ms for help/version, 250 ms for
empty updates, and 1.4–1.5 seconds for repeated 1,000-skill updates. Existing
`ALLAGENTS_DEBUG=timing` output attributed 913 ms (57.5%) of a separate
1.59-second sync to selective purge and 505 ms to copying. A syscall trace
showed 3,001 `rmdir`, 27,031 `statx`, and 25,021 `readlink` calls. Tracing adds
substantial overhead; these counts and phase attribution are diagnostic,
not the final timing comparison.

`selectivePurgeWorkspace` previously called `cleanupEmptyParents` after every
tracked deletion. Siblings repeatedly inspected and attempted to remove the
same nonempty parent. The candidate defers cleanup until that client's deletions
finish, then cleans each distinct parent once. Every deletion and cleanup retains
its existing path and symlink guards. Overlapping tracked file/directory entries
keep immediate cleanup to preserve deletion reporting. No persistent cache or
new dependency is introduced.

Measured bundle SHA-256 values (also emitted by the harness):

- Baseline: `47bf4f9e46fe11eab93cc4b43d95c079720192ccc59eade86dfd8716ea27f71a`
- Candidate: `250ecc1005058e56080ab2b62602d6593ce8a72c8d2adc71b0cf7ec58ec253c9`

A CPU profile of `--help` showed time in bundle parsing and module initialization.
Startup remains unchanged; splitting/lazily loading the command graph was not
attempted in this bounded investigation. Copying and actual tracked deletion also
remain substantial costs.

## Paired measurements

Each scenario uses 3 interleaved warmups per version, then
15 interleaved timed baseline/candidate pairs, alternating order. Values are
whole-process wall time; p95 uses the nearest-rank sample. Fixtures have isolated
HOME/project directories, one Codex file-install client, 0/100/1,000 skills, and
user-owned sentinel files. Remote cases use a local bare Git remote redirected
through an isolated Git config. There is no injected latency or real-network
performance claim. Filesystem caches are warm; cold install is setup, not timed.
Runtime: Node v26.7.0, Bun 1.4.3, Linux 7.0.0-38-generic, Intel i7-6700T.
With 15 samples, nearest-rank p95 is the maximum observed sample, not a stable
estimate of production tail latency.

| Scenario | Skills | Baseline p50 / p95 (ms) | Candidate p50 / p95 (ms) |
| --- | ---: | ---: | ---: |
| version | 0 | 221 / 238 | 213 / 239 |
| help | 0 | 218 / 235 | 219 / 270 |
| local-project | 0 | 247 / 292 | 243 / 291 |
| local-user | 0 | 246 / 275 | 238 / 254 |
| local-project | 100 | 410 / 451 | 386 / 406 |
| local-user | 100 | 412 / 507 | 387 / 442 |
| local-project | 1000 | 1490 / 1647 | 1269 / 1377 |
| local-user | 1000 | 1448 / 1548 | 1268 / 1388 |
| remote-project | 1000 | 1609 / 1706 | 1373 / 1476 |
| remote-user | 1000 | 1620 / 1818 | 1352 / 1462 |
| offline-project | 1000 | 1493 / 1558 | 1294 / 1349 |
| offline-user | 1000 | 1506 / 1634 | 1288 / 1361 |

The 1,000-skill median reductions were 12.5–16.5%. Startup and
empty-update differences are treated as noise; no startup speedup is claimed.
All 360 timed invocations matched output, destination/state and Git work. All
450 invocations (including initial materialization, warmups and separate traces)
passed protected-source/config/sentinel guards. [Raw final samples and traces](performance-followup.samples.json)
include bundle hashes and
individual samples for reproduction.

| Local 1,000-skill project syscall | Baseline | Candidate |
| --- | ---: | ---: |
| rmdir | 3000 | 2001 |
| readlink | 31018 | 21028 |
| statx | 28032 | 26071 |
| access | 4020 | 3021 |

Git work was identical in both builds: local sources started no Git processes;
unchanged online remote updates started 7 Git processes (one `ls-remote`, two
`rev-parse`, one each `config`, `status`, `symbolic-ref`, plus the local
transport), with zero clone/pull/fetch/merge/checkout/reset. Offline cached
updates performed one `rev-parse` and no remote operation. These existing remote
skips belong to #594 and earlier work.

Each timed sample must match baseline/candidate stdout, stderr, normalized
sync state (only `lastSync` removed), config bytes, `.codex` and canonical
`.agents` file contents/modes, root `AGENTS.md` when present, and Git operation counts.
The snapshot walks existing directories and records symlink targets using
`lstat`, including dangling links; it does not follow links outside those roots.
The benchmark fixture does not introduce dangling links or generate root
`AGENTS.md`; containment/symlink behavior is checked separately. Git work comes
from `GIT_TRACE2_EVENT`. Optional
`strace -f -c -e trace=%file` runs separately from the timed samples.

Before materialization, the harness captures expected source resource bytes and
modes, both workspace-config bytes/modes, and both explicit user sentinel
bytes/modes. Every initial, warmup, timed, and trace invocation rechecks these
immutable expectations after the timing interval. Cached remote resources must
also match the original source's resource bytes/modes. These guards prevent an
early candidate mutation from becoming the shared fixture's new baseline.

A one-shot wrapper that deletes the HOME sentinel on its first invocation was
rejected during the first warmup with
`Protected source/config/sentinel bytes or modes changed` (exit 1). The normal
protected local/remote/offline smoke passed. Final measurements use these guards;
earlier exploratory matrices are not used for the reported performance comparison.

## Reproduction and validation

The baseline bundle for this run was copied outside mutable `dist` before
editing. To recreate it from the candidate checkout without changing branches:

```sh
baseline_source=$(mktemp -d /tmp/allagents-perf-base-XXXXXX)
baseline_artifacts=$(mktemp -d /tmp/allagents-perf-bundle-XXXXXX)
git clone --shared --no-checkout . "$baseline_source"
git -C "$baseline_source" checkout --detach e331f44
(cd "$baseline_source" && bun install --frozen-lockfile && bun run build)
cp -a "$baseline_source/dist" "$baseline_artifacts/baseline"
bun run build
bun scripts/benchmark-cli-sync.ts \
  "$baseline_artifacts/baseline/index.js" dist/index.js \
  --samples=15 --warmups=3 --sizes=0,100,1000 --trace \
  > /tmp/allagents-perf-final.json
rm -rf "$baseline_source" "$baseline_artifacts"
```

The harness deletes its temporary fixtures on completion. `--trace` requires
Linux `strace`; omit it for timing/output/state/Git checks on other systems.

To reproduce the first-warmup contamination check, wrap the candidate with:

```sh
#!/bin/sh
if [ ! -f "$ALLAGENTS_TEST_HOME/.perf-fault-fired" ]; then
  rm "$ALLAGENTS_TEST_HOME/.codex/skills/user-owned/keep.txt"
  touch "$ALLAGENTS_TEST_HOME/.perf-fault-fired"
fi
exec "$ALLAGENTS_PERF_REAL_CLI" "$@"
```

Make the wrapper executable and run the benchmark with that candidate,
`ALLAGENTS_PERF_REAL_CLI="$PWD/dist/index.js"`, and
`--samples=1 --warmups=1 --sizes=0`. Expected: exit 1 with the protected-state
error above, before any timed result is emitted.

Focused checks:

```sh
bun test tests/unit/core/sync-dedup.test.ts tests/unit/core/sync.test.ts \
  tests/unit/core/sync-user.test.ts tests/unit/core/client-context.test.ts \
  tests/unit/core/sync-symlink.test.ts tests/unit/core/omp-artifacts.test.ts
bun run typecheck
bun run lint
bun run build
```

Result: 95 focused tests passed (803 assertions); source typecheck, explicit
benchmark-script typecheck, lint, and build passed. Lint reports the existing
17 warnings. The benchmark typecheck command was:

```sh
bunx tsc --ignoreConfig --noEmit --strict --noUncheckedIndexedAccess \
  --target es2022 --module esnext --moduleResolution bundler --types bun \
  --skipLibCheck scripts/benchmark-cli-sync.ts
```

Built manual checks used the same isolated baseline and candidate to install,
repeat-sync, edit a skill, remove a source skill, and remove the plugin for both
project and user scope. JSON and redirected human output matched across all
eight normalized outputs. User-owned sentinel bytes survived each stage; source
edits reached the destination, deleted skills disappeared, and final sync state
released owned files. Regression coverage includes nested parent cleanup,
user files, write-root preservation, tracked final symlinks, rejected symlink
parent traversal, external Pi roots, and overlapping state entries. The overlap
test failed on the first candidate and passes with the conservative fallback.

A separate built-candidate check ran JSON `update --scope project --offline
--dry-run` and `status` after materialization in an isolated HOME/project. A
whole-fixture fingerprint confirmed unchanged paths, bytes, modes, mtimes, and
symlink targets after each read-only invocation.

Final inline and independent peer reviews found no actionable issue in the
production change. Measurement-review findings were resolved by adding canonical
resource snapshots, immutable fixture guards on every invocation, and first-warmup
fault injection.

Limits: these measurements do not establish live-network, cold-disk-cache,
failed-remote, cancellation-latency, or multi-profile improvements. Existing
remote health/no-op decisions and refresh failure handling are unchanged.
