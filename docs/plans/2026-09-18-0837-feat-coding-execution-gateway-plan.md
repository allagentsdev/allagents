---
title: "HarnessRouter Workspace Composition - Implementation Plan"
date: 2026-09-18
updated: 2026-09-27
type: feat
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
---

# HarnessRouter Workspace Composition - Implementation Plan

## Stock behavior inventory

The pinned HarnessRouter baseline already owns the session workspace lifecycle.
The fork must extend that lifecycle rather than introduce another workspace
abstraction:

1. Session identity implicitly selects the session workspace; callers do not
   currently describe a source workspace.
2. Fresh hydration creates the session workspace as an empty root Git
   repository.
3. Continuation restores the session checkpoint selected by the existing
   response/session identity.
4. Attached files, `.harness` state, generated root instructions, plugins,
   skills, MCP configuration, HOME, and conversation state are materialized
   under the hydrated workspace before the harness turn starts.
5. Produced-file collection uses a cursor over the root Git repository.
6. Stock checkpointing mutates that root Git repository and archives the entire
   workspace; stock hydration clears the workspace before restoring the archive.
7. No stock UHP request field names a Git source, an OCI source, or a reusable
   immutable generation.

These are the starting facts and the integration constraints. The implementation
keeps the existing session allocation, hydrate/checkpoint cycle, file and
artifact APIs, user/sandbox isolation, cancellation, TTL, cleanup, and harness
supervision. It adds first-turn source composition at the existing hydration
boundary, stores the resulting attachment in the existing session state, and
adapts the existing produced-file cursor for nested repositories. It does not
create a second workspace, second session database, second Files API, external
materializer service, or parallel lifecycle.

## Goal

Extend `allagentsdev/harnessrouter` so a new UHP session can compose its existing
HarnessRouter workspace from either multiple Git repositories or a mandatory OCI
workspace snapshot. Bind the verified immutable generation and its access mode
to the session before the first harness turn. Continuations omit the descriptor
and recover the exact attachment through the access-specific workspace-aware
checkpoint path.

OCI workspace snapshots are a release-blocking v1 source, not a later
optimization. Large repositories are part of the minimum deliverable. The Git
path limits history transfer with a fixed shallow fetch, but it still transfers
and checks out every working-tree byte; it therefore does not replace OCI for
large workspaces.

Keep all other boundaries unchanged:

- UHP is the only northbound execution protocol.
- Requests without `metadata.workspace` take the stock path without new source,
  generation, attachment, or response semantics.
- Codex and OMP are the supported harnesses.
- Both use the existing separately operated OAuth-to-OpenAI-compatible provider
  gateway through server-owned, brokered credentials.
- `allagentsdev/harnessrouter` remains the existing GitHub fork and
  `ghcr.io/allagentsdev/harnessrouter` remains the image name.
- There is no AllAgents CLI implementation, profile import, local gateway
  command, or `workspace.yaml` change.

## Product and ownership boundary

### In scope

- A strict first-turn-only `metadata.workspace` HarnessRouter extension.
- Repository composition from one or more caller-declared repositories at
  pairwise non-overlapping workspace-relative destinations.
- Fixed depth-2 Git acquisition with exact resolved-commit provenance and useful
  recent offline history.
- Operator-cataloged OCI workspace snapshots selected by direct image-manifest
  and workspace-manifest digests.
- One immutable generation store shared by Git and OCI sources.
- Reuse of a verified immutable generation across sessions.
- Shared immutable bytes for `read_only` sessions and inode-independent private
  copies for `editable` sessions.
- Existing session continuation, checkpoint, cancellation, TTL, deletion,
  restart reconciliation, files, artifacts, and produced-file behavior adapted
  to the attachment.
- Authorized persistent retention through the existing session lifecycle.
- Exact source provenance and bounded, coded failures.
- Direct Promptfoo coverage against the built image, including a large OCI
  workspace and second-session cache reuse.
- Digest-pinned publication to GHCR with SBOM and build provenance.

### Explicit non-goals

- A separate workspace service, workspace database, scheduler, Files API, or
  task protocol.
- Caller-selected runtime/container images or benchmark environments. An OCI
  workspace snapshot is source content only.
- Caller-provided registry origins, registry credentials, headers, proxy
  settings, or source commands.
- Arbitrary materializer plugins, hook discovery, or a public generation API.
- Silent Git fallback for an OCI failure, silent OCI fallback for a Git failure,
  or silent deepening/full-clone fallback for a bounded Git failure.
- Submodule initialization, Git LFS hydration, checkout filters, or repository
  hook execution.
- Provider login, refresh, or repair in HarnessRouter; the external provider
  gateway retains that responsibility.
- A caller-selected provider route, API key, transport, or fallback chain.
- Upstream acceptance as a release condition. Upstreaming is considered only
  after downstream release evidence exists.

## Request contract

`metadata.workspace` is accepted only when the request creates a new session. It
uses snake_case and has no nested schema version:

```json
{
  "metadata": {
    "harness_id": "allagents-codex",
    "workspace": {
      "access": "editable",
      "retention": "session",
      "source": {
        "kind": "repositories",
        "repositories": [
          {
            "url": "https://github.com/example/service.git",
            "ref": "refs/heads/main",
            "destination": "service"
          },
          {
            "url": "https://github.com/example/shared.git",
            "destination": "libraries/shared"
          }
        ]
      },
      "working_directory": "service"
    }
  }
}
```

The exact shape is:

```text
metadata.workspace = {
  access: "read_only" | "editable",
  retention?: "session" | "persistent",
  source:
    | {
        kind: "repositories",
        repositories: Array<{
          url: string,
          ref?: string,
          destination: string
        }>
      }
    | {
        kind: "workspace_snapshot",
        snapshot_name: string,
        image_manifest_digest: string,
        workspace_manifest_digest: string
      },
  working_directory?: string
}
```

Rules:

1. `access` and `source` are required. `retention` defaults to `session`.
2. `persistent` is accepted only after existing caller/session authorization
   succeeds and before source resolution, network traffic, or generation claims.
3. `working_directory` and every repository `destination` are normalized
   workspace-relative POSIX paths. The effective working directory must be a real
   directory inside the final attached workspace without traversal or link
   escape.
4. Repository destinations must be unique and pairwise non-overlapping: no two
   destinations may be equal, and neither may be an ancestor of another.
5. The repository array contains 1 to 128 entries. Each URL, optional ref, and
   destination is bounded before network or filesystem work. Lower runtime
   capacity fails with the coded capacity error; it does not change schema
   validity.
6. `source` is a closed discriminated union. Unknown fields and mixed Git/OCI
   fields fail validation.
7. `snapshot_name` selects an operator-owned HarnessRouter deployment catalog
   entry. The request supplies only the two `sha256:` digests; it never supplies
   a registry, repository, credential, certificate, or mirror.
8. A continuation selected through `previous_response_id` or the existing
   session recovery mechanism omits `metadata.workspace`. Supplying it on a
   reused session fails before hydrate, source access, generation lookup, or
   provider traffic, even when it is identical to the stored value.
9. A session created without workspace metadata remains a stock session and
   cannot add workspace metadata later.
10. UHP input files are workspace mutations. Reject them on a `read_only`
    first turn before source resolution. For `editable`, apply them only after
    the private copy exists and before the initial produced-file baseline.
    Harness assets and runner control state remain outside source content.
11. Workspace fields cannot contain commands, environment variables, resource
    limits, provider settings, or harness settings.

A workspace snapshot request is therefore:

```json
{
  "metadata": {
    "harness_id": "allagents-omp",
    "workspace": {
      "access": "read_only",
      "source": {
        "kind": "workspace_snapshot",
        "snapshot_name": "monorepo-release",
        "image_manifest_digest": "sha256:...",
        "workspace_manifest_digest": "sha256:..."
      },
      "working_directory": "packages/api"
    }
  }
}
```

## Session binding and public provenance

The fork stores workspace binding fields in the existing session/checkpoint
record. The binding contains:

- the canonical effective descriptor and its digest;
- the source kind and exact resolved source identity;
- the generation key, immutable publication/epoch identity, and verified tree
  manifest digest;
- `access`, effective `retention`, and normalized `working_directory`;
- the attachment method and evidence needed to prove the restored session still
  refers to that exact generation;
- exact public provenance;
- existing session expiry/deletion state; and
- the selected harness/provider binding already owned by the session.

Public response `metadata.workspace` has exactly `access`, `retention`,
`working_directory`, `effective_descriptor_digest`, `generation_id`,
`workspace_manifest_digest`, `provenance`, and `expires_at`.
`working_directory` is always present and uses `.` for the workspace root.
`expires_at` is the effective timestamp for `session` retention and `null` only
for authorized `persistent` retention.

Repository `provenance` has `kind: "repositories"` and a request-order
`repositories` array. Each entry has normalized `url`, `destination`, exact
`resolved_commit`, effective `depth`, and `requested_ref` only when the request
supplied a ref. Snapshot `provenance` has `kind: "workspace_snapshot"`,
`snapshot_name`, exact `image_manifest_digest`, exact
`workspace_manifest_digest`, and a manifest-order `repositories` array. Each
snapshot root has `destination`; a history-bearing root also has
`resolved_commit` and `object_set_digest`, while a tree-only root has neither.

Acquisition-policy revisions, catalog origins, mirrors, credentials, host and
mount paths, attachment IDs, leases, and internal generation keys are not
public. A continuation and response replay return the same committed object;
they never report a newly resolved ref or substituted generation.

## Existing lifecycle integration

The first-turn sequence is:

1. Authenticate and validate the stock UHP envelope and establish existing
   idempotency ownership.
2. Resolve whether the request creates or reuses a session.
3. If new and workspace-backed, validate and authorize the closed workspace
   descriptor, then store a pending binding in the existing session transition.
4. Run fresh hydration only far enough to allocate the existing session
   workspace and isolation identity. Skip stock empty-root Git initialization
   for workspace-backed sessions; do not allocate another checkout root.
5. Create a per-session writable control root in that allocation but outside
   source content. Redirect `.harness` state, HOME, conversation data, plugins,
   skills, MCP/configuration, credentials, scratch, and produced/checkpoint
   bookkeeping to it.
6. Resolve the immutable source identity, claim or reuse the generation, and
   attach it at the existing workspace path with the requested access mode.
7. Reject workspace input files for `read_only`. For `editable`, apply them to
   the private copy before the initial produced-file baseline. Supply generated
   instructions through a harness-supported external instruction path or a
   non-shadowing session mount; never write, overlay, or copy up a source path.
8. Establish runner-owned outer and nested produced-file cursors, validate the
   effective working directory, and prove a `read_only` attachment has no
   writable alias.
9. Atomically mark the existing session attachment ready, then continue through
   ordinary provider selection and harness execution.
10. Collect files/artifacts and checkpoint through the access-specific path:
    `read_only` stores only session-local mutable state plus exact attachment
    evidence and excludes generation bytes; `editable` checkpoints its private
    workspace copy. Stream events, set terminal state, and schedule cleanup
    through existing HarnessRouter paths.

A continuation does not parse or resolve a source. Workspace-aware hydration
first restores and validates only the control metadata needed for attachment:
generation key/epoch, manifest, durable reference, and attachment evidence. It
then acquires and mounts that exact protected generation, and only afterward
restores the remaining session-local harness state around the source mount. A
missing, expired, corrupt, wrong-generation, or unsupported attachment fails
closed. Hydration must not reacquire Git, contact an OCI registry, use another
cached generation, archive or restore shared generation bytes, or start with an
empty workspace.

`retention: "session"` follows existing finite session TTL and deletion.
Authorized `persistent` retention pins the existing session and its generation
reference until explicit deletion or operator policy permits removal; it does
not create a second retention scheduler. Polling and response replay do not
extend retention. Cleanup makes the session unavailable before releasing its
attachment, private copy, or generation reference and remains idempotent across
restart.

## Generation and attachment design

A generation is a verified immutable source artifact, not a runnable workspace
or session. It is stored outside session allocations under runner-owned `/data`
state and can be attached only through the existing hydrate path.

### Identity

The canonical generation key includes only immutable source and layout inputs:

- source kind;
- for every repository in request order: canonical normalized URL, exact
  resolved commit, and normalized destination; or the selected OCI catalog
  identity plus both direct digests;
- the normalized source-layout/workspace-manifest schema revision;
- materializer contract revision;
- Git fetch depth (`2`) and Git acquisition-policy revision for repository
  sources;
- OCI extraction and validation-policy revision for snapshot sources; and
- any operator acquisition-policy identity that can change resulting bytes.

The key excludes session ID, response ID, harness, provider, access, retention,
working directory, and caller display data. Those values affect attachment or
execution, not generation bytes. Different request ref spellings that resolve to
the same canonical repositories, commits, destinations, depth, and policy reuse
the same generation. Exact provenance retains the original requested values even
when the immutable generation key is shared.


### Git acquisition cache

Repository sources use two server-owned cache levels inside runner-owned
`/data`; neither is a session workspace:

1. One operator-only bare shallow acquisition mirror exists per canonical
   repository URL. Only the runner's acquisition worker can write it. Every
   refresh of that repository is serialized through the same mirror, and
   concurrent refreshes of the same normalized ref request use one in-flight
   operation. Depth and acquisition-policy revisions belong to immutable commit
   snapshots and generation identity, not the mutable mirror key.
2. Verified depth-2 commit snapshots from that mirror feed immutable multi-
   repository generations keyed by canonical URLs, exact commits, destinations,
   depth, policy, and materializer contract revision. A generation is the only
   cache object that can be attached to a session.

The bare mirror stores acquired objects and shallow-boundary metadata so a
second generation needing the same commit does not clone or transfer its pack
again. Updates import a verified bounded fetch atomically; they never mutate a
published commit snapshot, silently deepen it, or make a partially refreshed
mirror eligible for generation construction. The generation builder exports a
self-contained repository with no alternates and no writable link to the mirror.
Mirror paths, file descriptors, credentials, refs, and writable internals are
never mounted into or disclosed to a session.

Resolving a mutable advertised ref may contact the origin to determine its
current exact commit. Once resolution yields an identity already present in the
mirror and generation store, there is no source pack acquisition, checkout,
tree materialization, or publication. Separate counters distinguish ref
advertisement from source-byte acquisition so cache-reuse proof cannot count a
remote pack fetch as a hit.

### Publication and reuse

- Build into a random private sibling staging directory.
- Persist one singleflight claim per bare-mirror refresh and one per generation
  key. Concurrent misses perform at most one remote pack acquisition and one
  immutable generation publication. Other requests wait independently, and one
  waiter's cancellation does not cancel work still needed by another live
  waiter.
- Stream validation and accounting during acquisition. Verify the final manifest
  before publication.
- Atomically rename verified staging into an immutable publication and record its
  complete metadata in runner state.
- Treat bare commit snapshots and published generations as immutable. Startup
  verifies recorded ownership, publication completeness, shallow boundary,
  policy revision, and manifest evidence before readiness.
- A repository generation hit may refresh mutable ref advertisement, but performs
  no clone, pack fetch, checkout, tree copy, or second publication after the
  exact normalized source identity matches. An OCI digest-keyed hit performs no
  registry manifest/blob request, extraction, tree copy, or second publication.
  Both record only a new session lease/reference.
- Every `read_only` session whose normalized source identity matches a cached
  generation attaches that same immutable generation. It cannot choose to
  reclone, re-extract, rematerialize, or copy cached source bytes.
- Failed or cancelled builds remove staging after descendants stop. A partially
  refreshed mirror, commit snapshot, or generation is quarantined and never
  attached.
- Existing leases/session references protect a generation from cleanup. Existing
  cleanup scheduling removes only complete, unreferenced generations under
  bounded operator policy. Mirror/object-cache cleanup is separately confined
  and cannot invalidate a referenced generation.

### Access-specific attachment

- `read_only`: take a lease and bind the cached immutable generation directly at
  the existing session workspace through a read-only filesystem view. A second
  matching session performs zero source-tree copy and shares the same verified
  generation inodes/bytes, while the writable control root, HOME, checkpoint,
  conversation, produced records, harness runtime, and lifecycle state remain
  isolated. Workspace input files are absent. After control-root assets and
  external instructions are ready, verify that root, nested paths, symlink
  paths, bind aliases, and alternate descriptors cannot write or copy up into
  source.
- `editable`: take a lease, then create a private, inode-independent tree from
  the verified generation inside the existing session workspace allocation.
  Reflink/copy is allowed only when it yields independent inodes and writes
  cannot alter the generation or another session. Hard-linked mutable files are
  forbidden.
- Both modes preserve nested repository administrative state allowed by the
  source manifest. The attachment never exposes the bare Git mirror or moves
  harness HOME, credentials, scratch, or checkpoint control into repository
  content.
- Continuation reuses the exact lease and attachment. An editable continuation
  sees its mutations; a read-only continuation sees the same immutable
  generation and its own session-local state.

## Implementation phases

Each phase ends with observable proof. Source inspection or mock-forwarding
assertions are not sufficient.

### Phase 1: Pin the baseline and record stock behavior

**Outcome:** the unchanged baseline is reproducible and the fork has regression
proof for the lifecycle being extended.

Work:

1. Pin the initial examined baseline to HarnessRouter `v0.25.4`, commit
   `5f82db1d1f13ea25b8ed0893c38b5b7d2e3e57e3`, and UHP `2026-09-12`. Before
   implementation, record the exact release baseline actually selected; move it
   only in a standalone synchronization change.
2. Preserve `HarnessRouter/harnessrouter` as the upstream remote and
   `allagentsdev/harnessrouter` as the existing fork.
3. Pin base image, OS packages, Git and OCI libraries/tools, Codex, OMP,
   Promptfoo, lockfiles, and CI actions. Build the unchanged image first.
4. Add focused characterization scenarios for fresh empty-root Git hydration,
   continuation checkpoint restore, attached-file/harness-asset ordering,
   root-Git produced-file cursor behavior, cancellation, TTL cleanup, restart,
   and requests with arbitrary metadata.
5. Capture stock UHP request/stream/error behavior for requests without
   `metadata.workspace`; these traces become compatibility fixtures.
6. Record the precise gateway/session/hydrate/runner/checkpoint/files call path
   in code comments or tests where the fork seam lands. Do not add a generic
   extension framework.

Exit proof:

- a clean checkout builds the unchanged pinned image;
- characterization runs demonstrate all seven inventory facts; and
- a stock request completes through each supported existing route with no
  workspace-specific state.

### Phase 2: Add request validation and immutable session binding

**Outcome:** the gateway accepts the exact first-turn descriptor and binds it to
the existing session transition without changing stock requests.

Primary surfaces are the existing UHP request handling/session resolution in
`gateway/app.py`, the existing gateway-to-runner turn envelope, existing session
persistence, focused integration tests, changelog, and extension documentation.

Work:

1. Parse only `metadata.workspace`; keep unrelated metadata behavior unchanged.
2. Apply metadata byte, nesting, list-count, and string-length bounds before
   session allocation or source work.
3. Strictly validate the closed union, snake_case names, access, retention,
   destinations, working directory, direct `sha256:` digest syntax, and the
   `read_only` input-file exclusion.
4. Authorize persistent retention before source resolution or generation lookup.
5. Canonically serialize the effective descriptor with the default
   `retention: "session"` and calculate its digest.
6. Extend the existing new-session transition with pending/ready workspace
   binding states. Do not add another response or session identity.
7. Reject the descriptor on every reused session path before hydration. On a
   workspace-bound continuation, derive source/access/retention/cwd/harness from
   stored state and reject a supplied harness mismatch through existing session
   rules.
8. Preserve idempotency: the owning initial request performs one binding; a
   duplicate receives the same response/session result and cannot claim another
   generation or attachment.
9. Map validation, authorization, reuse, and binding failures into bounded UHP
   errors without internal paths or secret/catalog details.
10. Add public provenance only after attachment is ready. Retrieval/replay uses
    stored provenance rather than resolving it again.

Proof includes valid descriptors for both source kinds; repository counts
`0`, `1`, `128`, and `129`; multiple repository entries; default retention;
authorized and unauthorized persistence; invalid unions, fields, digests,
paths, and destinations; workspace injection on both continuation mechanisms;
idempotent duplicates; harness mismatch; exact response-schema fixtures for
both provenance variants; and a byte-for-byte stock trace for requests without
the descriptor.

### Phase 3: Add the immutable generation store and existing-workspace attachment seam

**Outcome:** one generic runner seam claims, publishes, reuses, and attaches a
verified generation inside the existing hydrate lifecycle.

Primary surfaces are existing runner/session hydrate code in `runner/server.py`,
its current gateway transport, checkpoint/session persistence, startup
reconciliation, and existing cleanup scheduling.

Work:

1. Add one internal `resolve -> claim/reuse -> materialize -> verify -> publish ->
   attach` pipeline selected by the closed source union. It is not a public API or
   plugin registry.
2. Replace only the fresh empty-root initialization point for workspace-backed
   sessions. The designated path remains the existing session workspace.
3. Persist bare-mirror refresh/snapshot state, generation claims, staging,
   publication, session leases/references, and attachment-ready transitions using
   the runner's current durable state and recovery ordering.
4. Build and verify the canonical source-visible manifest: normalized relative
   path, type, mode, size/content identity, link target where applicable, declared
   repository ownership, and optional normalized Git-history declaration.
5. Implement access-specific attachment and verify read-only alias resistance or
   editable inode independence before marking the session ready.
6. Add a per-session writable control root outside source content and redirect
   every stock workspace-internal mutable path there: `.harness`, HOME,
   conversation state, plugins, skills, MCP/configuration, credentials, scratch,
   produced-file indexes, and checkpoint control. No mutable runtime path may
   resolve into an immutable generation.
7. Use harness-supported external instruction inputs or a non-shadowing
   session-only mount for generated instructions. Reject the implementation if
   either supported harness requires overwriting, overlaying, or copying up a
   source path.
8. Reject UHP input files for `read_only`; for `editable`, apply them to the
   private copy at the normal pre-turn point and establish the initial
   produced-file baseline afterward.
9. Add access-specific checkpoint/hydrate behavior. A read-only checkpoint
   excludes the generation mount and source bytes, persists only session-local
   mutable state plus exact attachment evidence, and reattaches the same
   generation before restore. An editable checkpoint carries the private
   workspace copy and never the mirror or generation backing store.
10. Reuse existing user/sandbox isolation, process groups, timeouts,
    cancellation, TTL, deletion, and cleanup. Source workers inherit
    cancellation and must stop all descendants before terminal acknowledgement.
11. Reconcile abandoned mirror refreshes, immutable commit snapshots, staging,
    incomplete publication, ready generations, pending attachments, leases,
    references, private copies, control roots, and cleanup after restart.
12. Verify continuations against the stored generation epoch/manifest, durable
    reference, and attachment evidence; never resolve or materialize source on
    continuation.
13. Expose separate bounded counters/events for ref resolution, remote pack
    acquisition, mirror singleflight, generation build/publication/hit,
    read-only zero-copy attachment/checkpoint, editable copy/checkpoint,
    reference, cancellation, quarantine, and cleanup. Do not log request
    credentials, registry locations, internal paths, or uncontrolled tool
    output.

Proof uses deterministic fake Git and OCI builders to show one mirror refresh
and one publication under concurrent misses, independent waiter cancellation,
two read-only sessions directly attaching the same verified generation with
zero second clone/fetch/materialization/copy, and two editable sessions with
independent inodes and mutations. Real Codex and OMP probes prove generated
instructions and all mutable harness assets live outside source. A read-only
checkpoint contains no generation bytes. Continuation restores and validates
minimal binding/control metadata, reattaches the same protected generation,
then restores remaining session-local harness state; checkpoint creation writes
no root Git commit. Editable checkpoint/continuation preserves its private
mutations. Restart at every persisted transition and cleanup are idempotent.
Session/runtime state remains isolated even when immutable bytes are shared. A
stock session still creates and uses its normal root Git workspace.

### Phase 4: Implement repository composition with mandatory depth-2 acquisition

**Outcome:** repository mode deterministically builds one generation from one or
more repositories while retaining bounded recent Git history.

Work:

1. Validate each caller URL under the fixed deployment egress policy. Callers may
   not supply credentials, proxy configuration, Git config, or transport
   options. Re-authorize redirects and resolved addresses; isolate Git config and
   disable interactive helpers, hooks, filters, alternate protocols, submodules,
   and LFS hydration.
2. Resolve an omitted ref through the advertised symbolic default. Resolve an
   explicit advertised branch or tag, peel annotated tags as required, and
   record the exact commit before fetch. Reject ambiguous, missing, unsupported,
   or non-commit targets.
3. Maintain one operator-only bare shallow acquisition mirror per canonical URL.
   Serialize every write for that repository through the same mirror and
   singleflight concurrent refreshes for the same normalized ref request.
4. On a mirror miss, fetch exactly depth 2 with `--depth=2` into a private
   bounded refresh area, verify it, and atomically import its pack/object and
   shallow-boundary state. Fetch only the selected advertised branch/tag path.
   Do not retry with a larger depth, `--unshallow`, full clone, arbitrary
   object-ID fetch, another ref, or another source mode.
5. Verify the fetched tip/peeled commit exactly equals the commit observed during
   resolution. A ref movement race fails the refresh rather than caching or
   binding different bytes.
6. Publish an immutable commit snapshot inside the mirror cache. A cache hit for
   the exact canonical URL, commit, depth, and policy performs no clone or remote
   pack transfer. No session can access the mirror path or a writable mirror file
   descriptor.
7. Export the selected cached commit into generation staging as a self-contained
   repository with no alternates or writable link to the mirror. Preserve
   `.git/shallow` and sufficient normalized administrative state for recent
   offline `git log`, parent inspection, and diff.
8. For a merge tip, preserve both fetched parent edges at depth 2 and validate
   the shallow boundary rather than flattening the merge.
9. Reject a server that cannot satisfy the bounded shallow fetch. Return a coded
   source error and do not deepen, full-clone, strip history, or fall back to OCI.
10. Check out the exact detached commit at each declared destination. Reject
    submodule gitlinks and LFS pointer-backed content rather than fetching them.
11. Enforce destination non-overlap before network work, then build all
    repositories into one staging tree. No repository may create paths outside
    its destination or add undeclared root files.
12. Validate each repository's `HEAD`, index/worktree equality at publication,
    shallow metadata, closed refs/config, object reachability for the retained
    depth, file modes, links, bytes, inodes, and absence of credentials/remotes
    that would cause later network use.
13. Compute exact generation identity from canonical URL identity, resolved
    commit, destination, fixed depth `2`, acquisition-policy revision, and layout
    policy. Preserve requested URL/ref separately as provenance.
14. Clean incomplete mirror refresh, repository staging, and descendants on
    error, timeout, cancellation, lost claim, or restart without invalidating a
    previously verified commit snapshot or referenced generation.

Behavior proof covers one repository at a top-level destination; several sibling/nested-path
repositories; the same URL at different refs and destinations; omitted default,
branch, lightweight tag, annotated tag, and moving-ref rejection; pairwise
non-overlap; depth exactly 2; `.git/shallow`; two-entry recent offline history;
merge-tip parents and diff semantics; detached exact commit; no network during
attached `git log`; submodule/LFS rejection; unsupported shallow server with no
fallback; cancellation; restart cleanup; and exact provenance. Concurrent cold
requests produce one advertised-ref refresh, one remote pack fetch, one verified
mirror snapshot, and one generation publication. After resolution confirms the
same exact identity, a second read-only request performs zero clone, zero pack
transfer, zero checkout/materialization, and zero tree copy, attaches the same
immutable generation bytes, and retains isolated session/runtime state.

The release notes must state plainly that depth 2 reduces transferred history,
not the checked-out working-tree bytes. Large repositories still require the OCI
snapshot source and its release gate.

### Phase 5: Implement mandatory OCI workspace snapshot materialization

**Outcome:** the same generation pipeline safely restores an operator-cataloged,
digest-pinned workspace snapshot with no Git fallback.

Deployment configuration owns a bounded snapshot catalog. Each `snapshot_name`
maps to one operator-controlled registry/repository origin, credential reference,
TLS policy, allowed media types, and resource policy. The request and public
provenance never reveal those private values. This catalog is HarnessRouter
configuration; it is not `workspace.yaml`.

Work:

1. Require a direct OCI image manifest digest. Reject tags, mutable references,
   manifest indexes/lists, caller-selected repositories, and catalog/digest
   mismatches.
2. Fetch the direct image manifest, config, workspace manifest, and referenced
   layers only from the selected catalog entry. Implement bounded registry
   authentication and exact-host redirect policy without exposing credentials to
   the harness, session workspace, logs, response, or provenance.
3. Verify every descriptor digest and size before use. Require the declared
   `workspace_manifest_digest` to identify the exact workspace manifest used to
   validate the final tree.
4. Stream decompression and extraction inside the fixed v1 envelope: at most 64
   distributable tar/gzip/zstd layers; a 4 MiB image manifest; a 128 MiB
   workspace manifest with at most 128 repository roots; 8 GiB total compressed
   layer bytes; 32 GiB expanded source bytes; 500,000 entries; 4 GiB per regular
   file; paths of at most 4096 UTF-8 bytes and 128 components; and 1 MiB per PAX
   or extended header. For each layer and the aggregate artifact,
   `expanded_bytes / max(compressed_bytes, 1)` must not exceed `100`. Enforce
   these bounds plus inode, output, and wall-time limits during streaming.
   Deployment configuration may lower but cannot raise them without a contract
   revision.
5. Apply OCI layers in order with correct file and opaque-directory whiteout
   semantics. Whiteouts are extraction instructions and must never appear in the
   published workspace. Reject malformed whiteouts and type transitions not
   representable by the workspace manifest.
6. Reject absolute paths, traversal, NULs, ambiguous separators, duplicate
   conflicting entries, devices, FIFOs, sockets, unsafe sparse files, and other
   unsupported types. Validate symlink and hardlink targets against the final
   workspace root; reject escaping, dangling-required-target, forward-link, and
   link-cycle cases outside the supported bounded model.
7. Validate final paths, types, modes, sizes, content digests, links, repository
   roots, and destination non-overlap against the workspace manifest. Extra,
   missing, or changed source-visible entries fail before publication.
8. Support tree-only repository roots and optional normalized offline Git
   history. For a history-bearing root, require detached `HEAD`, exact
   index/tree/worktree equality, closed object reachability and declared object
   digest, bounded refs/config, and no remotes, credentials, alternates, hooks,
   includes, worktrees, replace/graft state, or unsafe administrative files.
   Tree-only roots must not contain undeclared `.git` state.
9. Return the same canonical manifest/generation envelope as repository mode.
   Include direct image/workspace digests and snapshot name in identity and exact
   provenance; exclude registry origin and credentials.
10. On any resolution, registry, digest, extraction, manifest, Git-history,
    cancellation, or capacity failure, terminate descendants, remove staging,
    and return the source-specific error. Never clone Git, select a different
    digest, or use a stale generation as fallback.

Proof uses a local authenticated registry and malicious fixtures for digest/media
mismatch, indexes, redirects, authentication, truncation, compression bombs,
layer limits, whiteouts and opaque whiteouts, traversal, path/type/link attacks,
devices, sparse files, cancellation, partial cleanup, and restart. Positive
fixtures cover a tree-only workspace, multiple declared repository roots,
normalized offline Git history, offline `git log`/`git blame`/historical diff,
read-only attachment, editable copy, concurrent publication, and cache reuse
with zero second-session registry or extraction work.

OCI implementation and this proof are required before v1 release. A passing Git
path cannot waive or defer them.

### Phase 6: Adapt produced-file collection for nested and multiple repositories

**Outcome:** existing Files/artifact behavior reports turn-produced changes
across composed workspaces without inventing a second file API.

Work:

1. Preserve the existing produced-file cursor semantics but move the outer
   workspace baseline/index into the per-session control root. Never initialize,
   commit, or mutate a bookkeeping `.git` directory inside an immutable
   generation.
2. Register source-manifest repository roots and history mode when the attachment
   becomes ready. The set is immutable for the session.
3. At each turn boundary, record the external outer baseline plus a cursor for
   each declared repository root: Git `HEAD`/index/worktree state for
   history-bearing roots and manifest/file identity for tree-only roots.
4. Collect the union of outer and nested additions, modifications, deletions,
   renames, and mode changes relative to the turn baseline. Normalize to
   workspace-relative paths, assign each path to the most specific declared
   owner, deduplicate it, and preserve existing file size/count/type limits.
5. Never expose `.git` administrative files, generation-store paths, mount
   internals, control state, provider credentials, harness assets, or checkpoint
   internals as produced files.
6. Do not report immutable source baseline files merely because they arrived
   during first-turn composition. Report only changes after the established
   source/turn baseline.
7. In `read_only`, any attempted source mutation fails at the filesystem boundary
   and produces no changed source entry. Collection reads the external baseline
   without modifying source.
8. In `editable`, changes remain private to the session and are visible on
   continuation and through the existing file and artifact APIs.
9. Preserve collection-before-checkpoint ordering. Read-only checkpointing skips
   the generation mount; editable checkpointing includes only the private
   workspace and session-local state. Cancellation cannot publish a partial
   cursor or checkpoint.

Proof covers changes at workspace root and in every nested repository; two
repositories changed in one turn; same filename under different destinations;
add/modify/delete/rename; tree-only OCI roots; history-bearing OCI roots; Git
shallow roots; paths outside repository destinations; ignored files under the
existing policy; read-only denial; editable continuation; cancellation during
collection; restart; bounds; and absence of `.git`, credentials, generation
paths, or duplicate records.

### Phase 7: Wire Codex, OMP, and the existing provider gateway

**Outcome:** both supported harnesses execute in the attached existing workspace
without gaining source or long-lived provider credentials.

Work:

1. Install exact pinned Codex and OMP releases and enable only required release
   backends with `HR_BACKENDS=codex,omp`.
2. Define stable downstream custom harnesses such as `allagents-codex` and
   `allagents-omp` with explicit model allowlists.
3. Configure two logical connections to the same external OAuth-to-OpenAI-
   compatible gateway: Responses for Codex and OpenAI Chat Completions for OMP.
   Each harness has exactly its matching connection and no fallback.
4. Retain brokered sandbox credentials. The long-lived external gateway key
   remains server-side; the harness receives only the existing short-lived,
   scoped turn credential and loopback route.
5. Start each harness in the validated `working_directory` while keeping HOME,
   skills, scratch, conversation, credential projection, and checkpoint control
   in their current session-isolated locations.
6. Reject unsupported models and any attempt to place provider URL, key,
   transport, route, registry data, or source credentials in the request.
7. Remove ephemeral OMP/Codex provider configuration before checkpoint and file
   collection using existing broker lifecycle hooks.
8. Provider failure returns the existing normalized failure and does not change
   source, generation, access, attachment, harness, connection, or protocol.

Proof runs both harnesses against Git and OCI sources, at root and a nested
working directory, in read-only and editable modes where applicable. It verifies
that caller and provider credentials, registry credentials, broker tokens, and
private origins are absent from process output, session/checkpoint files,
produced files, artifacts, logs, and public metadata. An invalid provider
credential or unsupported model causes no route fallback. A stock request still
uses its original workspace path and provider behavior.

### Phase 8: Exercise lifecycle, restart, cancellation, and cleanup

**Outcome:** source generations and attachments follow the existing HarnessRouter
session lifecycle under failures and restarts.

Work and proof:

1. Cancel during Git advertisement/fetch/checkout, OCI manifest/blob transfer,
   decompression/extraction, generation wait, editable copy, harness execution,
   checkpoint, and produced-file collection. Reap descendants before terminal
   acknowledgement and remove only the cancelled request's incomplete state.
2. Cancel one waiter on a shared generation build while another continues. If no
   waiter remains, cancel the bounded builder. At most one complete publication
   can survive.
3. Restart after every durable transition: pending descriptor, source resolved,
   claim held, staging populated, generation published, session reference
   created, read-only attached, editable copy started/completed, attachment ready,
   turn active, checkpoint written, cleanup marked, and reference released.
4. Before readiness, reconcile incomplete staging and copies, publication
   evidence, references, read-only mounts, editable ownership, session binding,
   and cleanup marks. Never attach an uncertain generation or expose an editable
   copy to another session.
5. Prove a continuation after restart restores the exact generation/access/cwd;
   editable mutations persist, read-only remains immutable, and no source
   endpoint is contacted.
6. Prove session expiry and explicit deletion first make the session unavailable,
   then release the mount/private copy and generation reference exactly once.
   Persistent retention survives ordinary session-idle cleanup until authorized
   deletion.
7. A cleanup failure quarantines the path and keeps it unavailable/accounted.
   Retrying cleanup is confined, no-follow, and idempotent.
8. Generation cleanup removes only unreferenced complete publications under
   bounded operator policy. Active session references and authorized persistent
   sessions prevent removal.

### Phase 9: Add direct large-OCI Promptfoo E2E

**Outcome:** the built image proves the consumer-visible contract, mandatory
large-workspace behavior, and second-session generation reuse.

Promptfoo calls the built image directly at the existing UHP Responses endpoint
with a HarnessRouter caller API key. There is no adapter service or alternate
execution protocol.

Release-blocking scenarios:

1. **Large OCI fixture:** publish a deterministic workspace snapshot with at
   least 2 GiB of expanded source bytes and 100,000 source-visible filesystem
   entries. Falling below either floor fails the gate. Include multiple
   repository roots, a late-path sentinel, a nested working directory, and
   normalized offline history. The release record publishes actual compressed
   and expanded bytes, file/inode count, layer count, expansion ratio, and
   manifest digests so “large” is measured rather than asserted.
2. **First session:** start Codex read-only from the large snapshot, read the
   sentinel, run recent offline Git history, and complete from the nested working
   directory. Registry counters and runner metrics must show one bounded download,
   extraction, verification, and atomic generation publication.
3. **Second session reuse:** start OMP read-only with the identical snapshot
   identity but a different session and harness. It must report the same
   generation/manifest identity, share verified generation bytes while retaining
   isolated session state, and complete with zero additional registry manifest or
   blob requests, zero extraction, and zero publication. This is the required
   second-session cache-reuse proof.
4. **Editable reuse:** start an editable session from the same cached generation.
   It performs no registry/extraction work, receives inode-independent private
   bytes, mutates a file, continues without resending workspace metadata, and
   leaves the read-only sessions and generation unchanged.
5. **Repository matrix:** run depth-2 Git scenarios for default ref, branch, tag,
   merge tip, several repositories, nested working directory, recent history,
   and produced files across destinations. Concurrent cold requests must record
   one serialized/singleflight mirror refresh, one pack fetch, and one generation
   publication. A second read-only request with the same resolved source identity
   must record zero clone, pack transfer, checkout/materialization, and tree copy;
   it attaches the same immutable generation bytes while its session, runtime,
   conversation, outputs, and cleanup remain isolated.
6. **Access/lifecycle matrix:** cover read-only write denial, editable isolation,
   session and authorized persistent retention, continuation, restart, expiry,
   explicit deletion, cleanup retry, and missing/corrupt attachment with no
   rematerialization.
7. **Failure matrix:** cover malformed descriptor, overlap, bad working directory,
   unauthorized persistence, workspace input files with `read_only`,
   shallow-fetch refusal, moving ref, submodule/LFS, wrong OCI digest,
   workspace-manifest mismatch, extraction limit, path/link/type attack,
   cancellation in both source modes, provider failure, and reused-session
   descriptor injection. Assert there is no Git/OCI/provider fallback.
8. **Provider matrix:** complete Codex/Responses and OMP/Chat Completions through
   the one external provider gateway; reject route/model override; scan retained
   and public surfaces for caller, source, registry, broker, and provider secrets.
9. **Stock matrix:** replay baseline requests without workspace metadata and
   compare status, stream ordering, checkpoint/files behavior, and provider route
   with the characterization fixtures.

Reports retain only sanitized request/result assertions, image/source digests,
resource measurements, and source/generation counters. They never retain
credentials, private registry origins, provider traffic, internal paths, or
session volume contents.

### Phase 10: Publish a digest-pinned release

**Outcome:** a clean operator can deploy the exact tested image and reproduce the
Git/OCI contract.

Work:

1. Review the fork diff against its exact upstream tag/commit. The workspace
   changes must be limited to request/session binding, the existing hydrate and
   attachment seam, immutable generation storage, Git/OCI materialization,
   produced-file adaptation, focused lifecycle/configuration/docs, custom
   harness/provider wiring, E2E, and release automation.
2. Run the complete pinned upstream UHP conformance suite without exclusions and
   the focused fork coverage against the image candidate.
3. Run the Phase 9 Promptfoo matrix against that exact candidate digest.
4. Build `linux/amd64` from pinned inputs, attach standard SBOM and provenance,
   and publish
   `ghcr.io/allagentsdev/harnessrouter:<upstream-tag>-allagents.<revision>`.
5. Read back and deploy by manifest digest, for example
   `ghcr.io/allagentsdev/harnessrouter:v0.25.4-allagents.1@sha256:<digest>`.
6. Verify a fresh-volume deployment and a same-volume restart with both
   harnesses, Git and large OCI, cache reuse, continuation, cancellation,
   produced files, expiry, persistent deletion, generation cleanup, and stock
   requests.
7. Record upstream tag/commit, downstream source commit, UHP release, Codex/OMP/
   Promptfoo versions, base and package pins, Git depth/policy revision, OCI
   validation-policy revision, image digest, source fixture digests, SBOM,
   provenance, and E2E report identities.
8. Block release on any missing OCI implementation/evidence, large-workspace
   failure, second-session rebuild, writable read-only alias, editable inode
   sharing, continuation rematerialization, source fallback, credential leak,
   stock regression, or unpinned input.

Only after the downstream digest and evidence are available may maintainers
prepare an upstream issue or proposal for the generic contract and runner seams.
That work cites measured Git/OCI behavior, cache reuse, security failures, and
stock compatibility. Upstream discussion, acceptance, UEP timing, and merge are
outside the release critical path; a later upstream implementation replaces the
fork delta only after equivalent behavior passes the same gates.

## Failure contract

Workspace failures use bounded stable detail codes under the existing UHP error
shape. Exact HTTP mapping follows existing HarnessRouter conventions, but these
observable distinctions must remain:

| Condition | Required behavior |
|---|---|
| Invalid shape, field, digest, destination, or working directory | Reject before session source work |
| Unauthorized `persistent` retention | Reject before source lookup/network work |
| Workspace metadata on a reused session | Reject without changing the existing binding or TTL |
| Workspace input files with `read_only` access | Reject before source resolution; never overlay or copy up immutable source |
| Repository ref missing/ambiguous/moved | Fail repository resolution; no alternate ref/source |
| Server cannot satisfy depth-2 fetch | Fail repository acquisition; no deepen/full clone/OCI fallback |
| Submodule or LFS content | Fail repository validation; no helper execution |
| OCI catalog name/digest/media mismatch | Fail snapshot resolution; do not reveal catalog origin |
| Layer digest, whiteout, path, link, type, limit, or workspace-manifest failure | Fail extraction/validation; no publication or Git fallback |
| Generation capacity unavailable | Return bounded retryable capacity failure before unbounded work |
| Source timeout or cancellation | Stop descendants, detach waiter, clean incomplete private state |
| Attachment evidence missing/corrupt on continuation | Fail closed; no source access or replacement generation |
| Read-only write attempt | Filesystem denial; generation and sibling sessions unchanged |
| Provider failure | Existing provider error; source and route binding unchanged |
| Cleanup failure | Session/path remains unavailable and accounted for retry |

Failures before attachment-ready expose no generation or source provenance.
Failures after attachment-ready may return already committed public provenance,
but never internal paths, registry origins, credentials, raw tool stderr, or
private network details.

## Verification matrix

| Gate | Observable evidence |
|---|---|
| Stock compatibility | Requests without `metadata.workspace` match pinned status, stream, hydrate/checkpoint, files, cancellation, and provider behavior |
| Request/session binding | Both source variants bind only on a new session; continuation omits metadata and reuses the exact binding |
| Multiple repositories | Pairwise non-overlapping destinations compose correctly; overlap and source escape fail before acquisition |
| Git depth policy | Advertisement/default/branch/tag resolve exactly; fetch uses depth 2; tip matches; `.git/shallow`, recent history, and merge parents work offline; unsupported shallow fetch has no fallback |
| OCI integrity | Direct manifest and workspace-manifest digests, fixed `100` per-layer and aggregate expansion-ratio ceilings, bounded layers, whiteouts, paths, links, types, tree manifest, and optional normalized Git history all verify |
| Mandatory large OCI | A fixture with at least 2 GiB expanded source and 100,000 source-visible entries completes for both harnesses from the digest-pinned image; no Git acquisition occurs |
| Generation publication | Concurrent identical Git or OCI identities singleflight to one acquisition and one publication; failed/partial mirror snapshots or generations never attach |
| Git mirror/generation reuse | One operator-only bare shallow mirror exists per canonical repository identity; a second resolved-identity hit has zero clone/pack transfer/checkout/tree copy and directly attaches the same immutable generation |
| OCI generation reuse | A second exact-digest request has zero registry request/extraction/tree copy/publication and directly attaches the same immutable generation |
| Read-only sharing | Every matching read-only session leases and binds the same verified generation bytes with zero copy; all write paths/aliases fail and session/runtime state stays isolated |
| Read-only state separation | Mutable harness/runtime assets live in the session control root; checkpoint excludes generation bytes, writes no source Git state, and continuation reattaches the exact generation before restoring session state |
| Editable isolation | Private copies share no mutable inode; one session's changes and checkpoint never alter generation or siblings |
| Working directory | Root and nested valid directories become process cwd; missing, file, traversal, and symlink escape fail before harness execution |
| Produced files | Existing API reports root and nested-repository changes once, excludes baselines/admin/control/secrets, survives continuation/restart, and respects bounds |
| Continuation | Exact access, retention, generation, provenance, cwd, harness, conversation, and editable mutations restore without source traffic |
| Cancellation | Git, OCI, build wait, copy, harness, checkpoint, and collection cancellation reap descendants and leave recoverable state |
| Restart | Every generation/attachment/cleanup transition reconciles before readiness; exact attachments resume or fail closed |
| Cleanup | Expiry/deletion is unavailable-first, confined, idempotent, reference-safe, and quarantine-preserving on error |
| Provider boundary | Codex Responses and OMP Chat Completions use one operator route with brokered credentials, no caller override, fallback, or retained secrets |
| Release | GHCR image, digest, SBOM, provenance, source/runtime pins, UHP conformance, and direct Promptfoo reports identify the same candidate |

## Definition of done

1. `allagentsdev/harnessrouter` remains the existing fork and the release image is
   `ghcr.io/allagentsdev/harnessrouter` with the established
   `<upstream-tag>-allagents.<revision>` tag and a deployed manifest digest.
2. The stock behavior inventory is protected by characterization coverage, and
   requests without workspace metadata remain unchanged.
3. The exact first-turn-only snake_case contract supports required `access`,
   optional `retention`, required repositories or workspace-snapshot `source`,
   and optional workspace-relative `working_directory`, with no nested version.
4. Session state binds exact source provenance, generation/manifest identity,
   access, retention, working directory, harness, and attachment evidence.
   Continuation omits the descriptor and reuses that exact attachment.
5. Repository mode supports multiple non-overlapping destinations, resolves
   advertised default/branch/tag refs, fetches at depth 2, verifies the fetched
   tip, preserves shallow recent history and merge semantics, and never silently
   deepens or falls back. Submodules and LFS remain off.
6. OCI snapshot mode is implemented and release-tested with direct manifests,
   workspace-manifest verification, bounded layer extraction, whiteouts,
   path/link/type checks, optional normalized offline Git history, and no Git
   fallback. Callers never provide or observe registry origins or credentials.
7. Repository acquisition uses one operator-only bare shallow mirror per canonical
   repository identity, serialized singleflight refresh, immutable exact-commit
   snapshots, and a separate immutable multi-repository generation. OCI uses the
   exact digest-keyed generation cache. Identical normalized source identities
   publish once; access/retention/cwd/harness/session do not fragment identity.
8. Every matching read-only session leases and directly binds the same verified
   generation bytes with zero clone, source-byte transfer, materialization, or
   tree copy. Mirror internals are never session-visible. Editable sessions
   receive inode-independent private copies.
9. Existing hydrate, user/sandbox isolation, cancellation, TTL, restart,
   deletion, files, artifacts, and cleanup own the complete session lifecycle.
   Workspace-backed sessions relocate mutable harness/runtime assets to a
   per-session control root outside source. Read-only requests reject workspace
   input files and checkpoint no generation bytes; editable requests apply input
   files only to the private copy and checkpoint only that copy plus
   session-local state. No parallel workspace system remains.
10. Existing produced-file cursor semantics are adapted with runner-owned
    external baselines for outer paths plus declared nested/multiple repository
    and tree-only/history-bearing cursors, without writing bookkeeping Git state
    into an immutable generation or adding a second Files API.
11. Direct Promptfoo E2E against the tested image proves Git and large OCI,
    multiple repositories, nested working directory, continuation, read-only
    enforcement, editable isolation, produced files, cancellation, restart,
    cleanup, provider boundaries, and unchanged stock requests.
12. Required second-session proof covers both caches: Git performs zero clone,
    pack transfer, checkout/materialization, or tree copy after exact identity
    resolution; OCI performs zero registry request, extraction, publication, or
    tree copy. Both read-only sessions bind the same immutable generation bytes
    while session/runtime state remains isolated. Editable reuse has independent
    inodes and mutations.
13. Codex and OMP use their fixed protocol adapters through the existing external
    OAuth-to-OpenAI-compatible gateway with brokered short-lived credentials and
    no fallback or caller override.
14. UHP remains the only northbound protocol. There is no AllAgents CLI work,
    local profile synchronization, `workspace.yaml` change, provider-login
    implementation, runtime-image contract, or benchmark-environment coupling.
15. The release is blocked unless UHP conformance, focused integration coverage,
    large-OCI Promptfoo E2E, generation-reuse evidence, credential scans, SBOM,
    provenance, and digest-pinned fresh/restart deployment all pass for the same
    image.
16. Any later upstream proposal is based on this downstream evidence and remains
    outside the release path; no upstream issue, UEP, acceptance, or wait period
    blocks implementation or publication.
