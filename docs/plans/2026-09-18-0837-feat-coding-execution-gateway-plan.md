---
title: "AllAgents Gateway Workspace Composition - Implementation Plan"
date: 2026-09-18
updated: 2026-09-28
type: feat
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
---

# AllAgents Gateway Workspace Composition - Implementation Plan

## Goal

Create AllAgents Gateway as a downstream distribution of
`HarnessRouter/harnessrouter`. On the first request of a new UHP session, a
caller MAY declare an ordered set of independent Git and OCI source trees. The
gateway acquires and caches each component independently and places each tree at
its requested non-root destination in the existing private session workspace.
The application exposes the workspace to Files, checkpoint, provider, or harness
consumers only after every root verifies.

Requests without `metadata.workspace` remain on the pinned stock path. Workspace
support introduces no second session database, Files API, scheduler, execution
protocol, global composition cache, or materializer service.

## Implementation-handoff prerequisites

### Target repository: operator setup complete

On 2026-09-27, an organization repository administrator completed the
repository setup:

1. Renamed the existing `allagentsdev/harnessrouter` GitHub fork in place to
   `allagentsdev/allagents-gateway`, preserving repository identity, fork
   network, complete history, settings, redirects, Apache-2.0 `LICENSE`,
   `NOTICE`, copyright, and attribution.
2. Verified that GitHub still identifies `HarnessRouter/harnessrouter` as the
   parent. Upstream commit `5f82db1d1f13ea25b8ed0893c38b5b7d2e3e57e3`
   remains the characterized baseline; upstream acceptance is not a dependency.
3. Created writable branch `feat/workspace-composition` from downstream `main`
   commit `fbcb73132423c8c4575113fc8943c6a6280a4746`. That commit is the pinned
   upstream baseline plus the existing three downstream commits.
4. Updated the repository description, homepage, topics, and merge policy for
   the AllAgents Gateway identity.

The implementation clone MUST use the renamed repository as `origin` and retain
`HarnessRouter/harnessrouter` as `upstream`. It MUST start from the existing
`feat/workspace-composition` branch rather than discard downstream work by
branching from the older upstream commit. Do not create a second repository.

Keep the downstream distribution names fixed:

- repository: `allagentsdev/allagents-gateway`;
- image: `ghcr.io/allagentsdev/allagents-gateway`;
- service: `allagents-gateway`; and
- product: **AllAgents Gateway**.

The implementation environment also requires these checked-in local test
capabilities, with no external credentials:

- `oci-auth-registry`: an authenticated local OCI registry fixture;
- `oci-catalog-builder`: a builder for the server-owned catalog fixture; and
- `oci-source-fixture-builder`: a builder for deterministic image manifests,
  source manifests, layers, whiteouts, and malicious extraction fixtures.

The Linux integration runner MUST support read-only bind mounts and either safe
reflinks or inode-independent private copies. If reflinks are unavailable, the
implementation MUST use the private-copy path; it MUST NOT hard-link mutable
files. These are implementation prerequisites, not caller-visible options.

### Secrets and actions outside the implementation agent

The implementation agent can deliver the complete implementation PR using local
fixtures and mocked provider transport. The following remain operator-owned:

- the external provider gateway URL and key;
- a real UHP caller credential;
- GHCR publish rights;
- protected repository, registry, network, and deployment settings; and
- final image publication and deployment.

Release gates that require these values run only after an operator supplies them
through the repository's existing secret mechanism. The plan MUST NOT put
secrets in source, fixtures, build arguments, logs, artifacts, session metadata,
or harness environments.

## Pinned stock behavior and exact adaptation seams

The baseline owns UHP request/stream handling, authentication, idempotency,
provider brokering, harness supervision, one private workspace per session,
inputs and generated assets, checkpoint/artifact/control records, cancellation,
and deletion.

The implementation MUST begin by confirming these pinned behaviors at the
named seams, then adapt them rather than adding parallel machinery:

- Fresh stock hydration initializes Git at the workspace root.
- Git powers only the stock produced-file listing and cursor. It is not the
  workspace storage or restore mechanism.
- Stock checkpointing commits and then tars the directory; hydration restores
  the tar.
- Runner `_produced_list` returns produced files and `_produced_ack` advances the
  produced cursor.
- Gateway `_collect_produced` captures artifacts before calling the ACK path.
- `BACKING.workspace` exposes live files through `RunnerWorkspaceFiles` and
  checkpoint files through `CheckpointWorkspaceFiles`.
- The durable graph uses the `HarnessSession` vertex plus separate checkpoint,
  artifact, and control records. Workspace state extends those seams; it does
  not collapse them into a new session store.
- Stock reaps cached live workspaces and supports explicit deletion of durable
  sessions. It does not provide a durable-session TTL.

For workspace-backed sessions, `_produced_list` and `_produced_ack` remain the
runner protocol, `_collect_produced` remains the capture-before-ACK gateway
boundary, and `BACKING.workspace` remains the Files abstraction. Only the
workspace-backed produced-file implementation changes from root-Git cursoring
to canonical manifest cursoring. Stock requests retain root-Git listing and all
other pinned behavior.

Provider routing remains inherited. Workspace code only delays harness start
until the workspace binding is ready and the working directory has verified.
There is no provider-specific workspace implementation phase.

## Scope and invariants

### In scope

- A strict, closed, first-turn-only `metadata.workspace` request extension.
- An ordered array of 1 to 128 Git, OCI, or mixed source entries.
- Exactly one tree and one required non-root destination per source.
- Canonical public HTTPS Git acquisition at an exact resolved commit with full
  reachable ancestry by default, optional explicit shallow depth, and safe
  self-contained `.git` metadata for regression analysis.
- Operator-cataloged OCI source trees selected by exact image-manifest and
  source-manifest digests, including Git-free trees.
- Per-component cache/singleflight followed by one session-local resolved plan.
- Identical `read_only` and `editable` attachment semantics for Git and OCI.
- Canonical manifests, cursor-based change projection, mount-aware checkpoint
  and continuation, finite expiry, and explicit deletion.
- Existing Codex and OMP paths through the existing provider broker.

### Non-goals

- Caller-selected runtime images, registry origins, credentials, mirrors,
  transport settings, commands, materializer hooks, provider routes, models, or
  resource limits.
- A public component-cache or composition API, a global composition record,
  cache, identifier, or compatibility aliases for obsolete workspace schemas.
- Git-to-OCI, OCI-to-Git, ref, digest, registry, provider, or history-mode
  fallback. A failed full fetch never silently becomes shallow, and a failed
  shallow fetch never deepens.
- Git submodule initialization, LFS hydration, checkout filters, or hook
  execution.
- Requiring Git at workspace root or in OCI trees.
- A second Files endpoint or an AllAgents CLI/profile format change.

## Public request and response contract

`metadata.workspace` is accepted only on the first request that creates a new
session. All objects are closed, use snake_case, and have no nested version.

```json
{
  "metadata": {
    "harness_id": "allagents-codex",
    "workspace": {
      "access": "editable",
      "sources": [
        {
          "kind": "git",
          "url": "https://github.com/example/service.git",
          "ref": "refs/heads/main",
          "destination": "service"
        },
        {
          "kind": "oci",
          "snapshot_name": "shared-release",
          "image_manifest_digest": "sha256:...",
          "source_manifest_digest": "sha256:...",
          "destination": "libraries/shared"
        }
      ],
      "working_directory": "service"
    }
  }
}
```

```text
metadata.workspace = {
  access: "read_only" | "editable",
  sources: Array<
    | {
        kind: "git",
        url: string,
        ref?: string,
        depth?: integer,
        destination: string
      }
    | {
        kind: "oci",
        snapshot_name: string,
        image_manifest_digest: "sha256:<64 lowercase hex>",
        source_manifest_digest: "sha256:<64 lowercase hex>",
        destination: string
      }
  >,
  working_directory?: string
}
```

For a Git source, omitted `depth` means the complete ancestry reachable from the
resolved commit. A supplied `depth` is an integer from 1 through 1,000,000 and
requests exactly that shallow boundary. Full history does not fetch unrelated
refs or tags merely for completeness.

There is no request `retention` field and no `persistent` mode. The obsolete
singular `source`, `kind: "repositories"`, `repositories`,
`kind: "workspace_snapshot"`, and `workspace_manifest_digest` forms are
rejected, not aliased.

Every workspace-backed session receives the same operator-configured finite,
non-extendable expiry at creation. Replay, polling, turns, attachment, and
continuation MUST NOT move it. Explicit deletion remains available.

After the ready transition, responses return this exact sanitized shape:

```text
metadata.workspace = {
  access: "read_only" | "editable",
  working_directory: string,
  expires_at: RFC3339 timestamp,
  sources: Array<
    | {
        kind: "git",
        url: string,
        destination: string,
        resolved_commit: string,
        depth?: integer,
        source_manifest_digest: "sha256:<64 lowercase hex>",
        requested_ref?: string
      }
    | {
        kind: "oci",
        snapshot_name: string,
        destination: string,
        image_manifest_digest: "sha256:<64 lowercase hex>",
        source_manifest_digest: "sha256:<64 lowercase hex>"
      }
  >
}
```

Git response provenance mirrors the selected history: omitted `depth` means full
reachable ancestry, while a present value is the exact requested shallow depth.

`working_directory` is always present and uses `.` for the outer root. There is
no public `retention`, `effective_descriptor_digest`, `composition_id`, or
per-source `component_id`. Catalog coordinates, private cache keys, mirrors,
host paths, leases, mounts, credentials, and policy identifiers are also
private. Replays and continuations return the stored ready metadata and never
re-resolve mutable Git refs.

### Validation and ownership

Validation MUST complete every request-decidable check before source network
traffic, cache lookup, component claim, workspace write, or expiry mutation:

1. Require `access` and `sources`; accept 1 through 128 sources in request order.
2. Require one non-root relative POSIX `destination` per source. Reject empty,
   `.`, `..`, non-NFC, ambiguous, platform-specific, overlong, or link-escaping
   components.
3. Reject equal or ancestor/descendant destinations. Repeated component
   identities at different non-overlapping destinations are valid.
4. Normalize UHP inputs, generated assets, runner-reserved paths, credential and
   control paths, and every destination through one ownership validator. Reject
   a file, symlink, input, asset, reserved path, or unsafe ancestor at or below a
   destination in either access mode. Outer paths remain writable and valid.
5. Validate optional `working_directory` syntax before network work. After all
   attachments, require it to resolve without link escape to one real directory.
6. Accept only canonical public HTTPS Git URLs allowed by deployment egress
   policy. Reject userinfo, query, fragment, ambiguous encodings, alternate
   transports, and caller Git options. A ref resolves only through advertised
   default, branch, or tag semantics. Omitted `depth` means complete ancestry
   reachable from the resolved commit; a supplied `depth` MUST be an integer
   from 1 through 1,000,000.
7. For OCI require a catalog `snapshot_name` and direct SHA-256 image/source
   manifest digests. Reject tags, indexes/lists, caller registry coordinates,
   and mutable references.
8. Bound metadata bytes, nesting, strings, paths, source count, and input count
   while parsing. Reject unknown and wrong-kind fields.
9. Reject `metadata.workspace` on every replay, reused session, and continuation
   before hydrate, cache lookup, provider traffic, or any lifecycle mutation.

### Resource ceilings

Deployment policy MAY lower but MUST NOT raise these v1 ceilings without a
contract revision:

| Resource | Per source | Request aggregate |
|---|---:|---:|
| Expanded bytes | 32 GiB | 64 GiB |
| Source-visible entries | 500,000 | 1,000,000 |
| Compressed Git pack or OCI layer bytes | 8 GiB | 16 GiB |
| Reachable Git objects | 5,000,000 | 10,000,000 |
| Regular-file bytes | 4 GiB | 4 GiB per file |
| Path | 4096 UTF-8 bytes / 128 components | same per path |
| Acquisition/materialization time | bounded operator policy | bounded session policy |

Each OCI source permits at most 64 distributable tar/gzip/zstd layers, a 4 MiB
image manifest, a 128 MiB source manifest, and 1 MiB per PAX/extended header.
For every layer, source, and request, `expanded_bytes / max(compressed_bytes, 1)`
MUST NOT exceed 100. Git objects, checkout, filesystem entries, output, and
checkpoint accounting feed the same per-source and aggregate enforcement.

## Canonical source-manifest v1

The pinned media type is
`application/vnd.allagents.source-manifest.v1+json`.

The exact bytes are the RFC 8785 JSON Canonicalization Scheme encoding of:

```text
{
  version: 1,
  entries: Array<
    | {path: string, type: "directory"}
    | {
        path: string,
        type: "file",
        size: integer,
        sha256: "sha256:<64 lowercase hex>",
        executable: boolean
      }
    | {path: string, type: "symlink", target: string}
  >
}
```

The manifest digest is SHA-256 over those exact canonical bytes. Entries sort by
the UTF-8 bytes of their NFC-normalized relative POSIX `path`. The root entry is
omitted; empty directories are represented. Duplicate paths, non-UTF-8 or
non-NFC names, empty/`.`/`..` components, type conflicts, and unsupported types
fail validation. Regular files normalize to 0644 or 0755 according to
`executable`; all other mode bits are outside this schema. File SHA-256 is over
exact content bytes.

A symlink target is a UTF-8 NFC string whose resolution from the symlink's parent
stays within the owning root. Absolute, escaping, malformed, or cyclic targets
that cannot be safely materialized fail. Safe in-root OCI hardlinks MAY be
materialized as ordinary files and are not a manifest type. `.git` entries MAY
be covered by source integrity manifests, but `.git` is always excluded from
public change reporting.

Git acquisition computes this manifest from the verified detached tree with the
selected full or shallow history.
OCI fetches and validates the named source manifest before requesting any layer,
applies standard OCI image/layer/whiteout semantics, and requires the extracted
final tree to match exactly.

## Public change projection on the existing Files/artifact surface

No endpoint is added. Workspace-backed collection replaces only root-Git
produced-file listing behind the existing runner/gateway seams.

At ready time, persist canonical manifest cursors for the writable outer tree
(excluding source destinations) and each editable source root. At every terminal
collection:

1. `_produced_list` compares the last acknowledged cursor with fresh final
   manifests for the outer and editable roots. Traversal is no-follow, bounded,
   owner-aware, and does not cross mounts.
2. Read-only roots are not walked. They are trusted from immutable component
   identity plus freshly revalidated read-only mount evidence.
3. The runner projects add, modify, and delete operations. Content, type,
   executable-mode, and symlink-target changes are `modify`; rename is
   `delete` plus `add`. Git status, commits, indexes, ignore rules, and rename
   inference do not affect the result.
4. Gateway `_collect_produced` captures every added/modified regular file through
   the existing artifact path. It then captures one server-generated artifact
   named `workspace-changes-<response_id>.json`.
5. Only after all file artifacts and the change artifact are durable does the
   gateway call `_produced_ack`. ACK persists the new outer/editable cursor
   manifests. A retry before ACK reproduces the same logical changes.

The change artifact media type is
`application/vnd.allagents.workspace-changes.v1+json`. Its exact bytes are RFC
8785 canonical JSON:

```text
{
  version: 1,
  entries: Array<{
    path: string,
    operation: "add" | "modify" | "delete",
    before?:
      | {type: "directory"}
      | {type: "file", size: integer, sha256: "sha256:<64 lowercase hex>", executable: boolean}
      | {type: "symlink", target: string},
    after?:
      | {type: "directory"}
      | {type: "file", size: integer, sha256: "sha256:<64 lowercase hex>", executable: boolean}
      | {type: "symlink", target: string},
    file_id?: string
  }>
}
```

Entries sort by UTF-8 bytes of NFC-normalized workspace-relative `path`.
`before` is absent for `add`; `after` is absent for `delete`. `file_id` is
required exactly when an added or modified `after` value is a regular file and
references its already-durable existing-path artifact; it is otherwise absent.
The artifact excludes `.git`, runner/control state, credentials, caches,
checkpoint metadata, and component-store paths. Promptfoo consumes ordered
change artifacts to reconstruct final state.

## Private identity, cache, and publication

A component is one verified immutable source tree. There is no durable or cached
composition object. The session binding contains the ordered resolved source
plan and becomes visible in one downstream `ready` transition after every root
verifies.

Private component keys MUST be computable before materialization:

- Git key: canonical URL + exact resolved commit + history selector (`full` or
  exact requested depth) + one cache-schema revision.
- OCI key: catalog entry identity + exact image-manifest digest + exact
  source-manifest digest + one cache-schema revision.

Destination, ref spelling, access, session, harness, provider, working directory,
and expiry do not fragment component keys. The recomputed canonical baseline
digest is evidence required to publish or reuse a component; it is not a cache
key input. Do not add separate acquisition-policy, materializer, publication,
epoch, or baseline-digest dimensions to the key.

### Git acquisition

Maintain one operator-only bare acquisition mirror per canonical URL and
serialize its writes. Resolve the advertised default, branch, or lightweight or
annotated tag to an exact commit. With omitted `depth`, fetch the complete
ancestry reachable from that commit without fetching unrelated refs merely for
completeness. With supplied `depth`, fetch exactly that shallow ancestry.
Verify the tip and requested history boundary, then export a self-contained
detached checkout with no alternates or writable mirror links. Preserve safe
`.git` metadata for offline log, parent inspection, blame, and diff within the
selected history. Editable private copies additionally support bisect; read-only
mounts do not promise Git operations that mutate the worktree or repository.

Disable interactive credentials, hooks, filters, alternates, alternate
protocols, submodules, and LFS hydration. Reject gitlinks and LFS pointer-backed
content. Never change the requested history mode, fetch arbitrary object IDs,
choose another ref, fetch unrelated refs as a completeness shortcut, or fall
back to OCI. Contractual pack, expanded-byte, object, time, process, and output
limits apply to full and shallow acquisition; exceeding one fails without
publishing a component.

### OCI acquisition

The bounded server-owned catalog maps `snapshot_name` to registry/repository
origin, credential reference, TLS/redirect policy, allowed media types, and
resource policy. These remain private. Require the direct image-manifest digest,
verify manifest and config, fetch and validate the canonical source manifest
before any layer, then stream and digest-check layers in order.

Use standard OCI layer caching supplied by the selected library/client where
useful. Do not create a separate gateway-managed OCI blob-cache lifecycle.
Apply standard file and opaque-directory whiteouts. Reject absolute/traversing
paths, NULs, ambiguous separators, duplicate/type conflicts, devices, FIFOs,
sockets, unsafe sparse files, unsupported types, escaping links, and unbounded
metadata. OCI sources MAY be Git-free. There is no Git fallback and one OCI
image always represents one tree.

### Component singleflight and publication

Singleflight independently by private component key. Each miss uses private
staging and streamed accounting; canceled waiters detach without canceling work
still needed by another live waiter. Publish only after exact manifest
verification. Published component bytes and evidence are immutable; failed or
uncertain staging is unavailable and cleaned or quarantined. Existing live
workspace cache reaping may delete only complete, unreferenced publications and
must not invalidate an attached session.

## Access, binding, and application-level visibility

- `read_only`: bind the immutable component root at its destination with
  kernel-enforced read-only, `nodev`, and `nosuid` behavior while preserving
  required execute bits. Expose no writable alias, backing descriptor, mirror,
  or component-store path.
- `editable`: create an inode-independent private reflink or copy at the
  destination. No write may mutate the cache or a sibling session.

Prepare the outer workspace, destination scaffolding, every bind/copy, baseline,
and working directory while the `HarnessSession` workspace binding is pending.
Files, checkpoint, provider, and harness consumers already gate on application
state; extend that gate to require workspace `ready`. After all roots verify,
persist the resolved plan and transition once to ready. Atomicity means
application visibility after this transition. It does not require a special
filesystem rename, mount-namespace handoff, global composition transaction, or
composition identifier.

The durable workspace binding stores only:

- the validated descriptor and its private digest;
- pending/ready/failed state and fixed `expires_at`;
- the ordered resolved source plan and sanitized public metadata;
- immutable component and baseline-manifest references;
- the outer/editable acknowledged cursor manifests; and
- outer/editable checkpoint references.

Checkpoint, artifact, and control data remain in their existing separate
records. Do not persist live mount IDs, filesystem identities, verified flags,
publication epochs, inode evidence, or other process-local attachment facts.
On every initial attach, continuation, restart, and live-workspace cache attach,
revalidate component identity, ownership, mount target, read-only flags/no
writable aliases, or editable inode independence before ready.

## Lifecycle

### New session

1. Use stock authentication, UHP validation, idempotency, and new-versus-reused
   session selection.
2. Parse the closed workspace request and complete request-decidable ownership,
   collision, bounds, and continuation checks.
3. Assign the fixed expiry and persist a pending binding on `HarnessSession`.
4. Resolve exact Git/OCI identities and private keys; independently claim, reuse,
   or build each component under per-source and aggregate limits.
5. Hydrate the writable outer workspace through the existing path. Apply inputs
   and generated assets only outside source destinations.
6. Attach every source according to `access`; recompute/verify baselines and live
   protection. Any failure leaves the binding non-ready and exposes no partial
   workspace.
7. Validate `working_directory`, persist ordered resolved plan, public metadata,
   baselines, and initial manifest cursors; transition the binding once to ready.
8. Only then start the inherited harness/provider path.
9. On terminal collection, use manifest projection and capture-before-ACK. Then
   checkpoint and complete the existing turn/session transition.

An idempotent duplicate shares the same pending or ready binding and does not
create another attachment plan.

### Checkpoint and continuation

The existing stock sequence commits and tars a normal workspace. For a
workspace-backed session, retain that lifecycle while making archive boundaries
explicit:

- tar the writable outer workspace without crossing any source destination;
- checkpoint each editable Git/OCI root separately;
- store only immutable component references for read-only roots; and
- preserve original baselines and acknowledged cursor manifests separately from
  mutable final content.

Continuation never resolves a ref or contacts Git/OCI. Restore the outer tar and
editable-root checkpoints, reattach recorded read-only components, revalidate
all live attachment protections, restore baseline/cursor references, validate
cwd, and only then mark the live workspace ready. Missing, expired, corrupt, or
mismatched binding, baseline, component, or checkpoint evidence fails closed.
Do not select a replacement component, rematerialize from a source, expose an
empty root, or discard editable mutations.

### Expiry, deletion, restart, and cleanup

The fixed workspace expiry applies to every workspace-backed session and is
never extended. Expiry and explicit deletion first make the session unavailable,
stop descendants, unmount source roots, verify mount absence, remove editable
and outer state, release references once, and delete durable binding/checkpoint
state through existing records. Cleanup is mount-aware, confined, idempotent,
and unavailable-first. Uncertain paths remain unavailable, accounted, and
quarantined for retry.

Restart reconciliation resumes or fails each pending durable transition without
trusting process-local attachment facts. Stock live-workspace cache reaping
remains distinct from durable session expiry and deletion.

## Stable workspace failure contract

Workspace failures use the existing bounded UHP error envelope with the exact
detail codes below. `retryable` describes retrying the same logical operation
after its stated cause is corrected; it is not permission to extend expiry or
change a binding. Base UHP authentication, envelope, provider, and transport
errors retain stock codes only where their meaning is exact.

| Detail code | Condition | HTTP | Retryable | Required behavior |
|---|---|---:|:---:|---|
| `workspace_invalid_request` | Closed-schema, count, field, URL, depth syntax/range, digest syntax, path, cwd, first-turn, or reused-session violation | 400 | no | Fail before cache, network, workspace write, claim, or lifecycle mutation. |
| `workspace_path_collision` | Equal/overlapping destinations or input/generated/reserved/ancestor collision | 409 | no | Fail before cache or network; report only sanitized conflicting workspace-relative fields. |
| `workspace_source_unknown` | Unknown OCI catalog entry or missing/ambiguous/unsupported Git ref identity | 404 | no | Fail that source with no alternate ref, catalog entry, or source kind. |
| `workspace_source_invalid` | Moved/non-commit Git target, requested-history refusal, gitlink/LFS content, OCI media/digest/source-manifest/layer/final-tree failure, or unsafe source content | 422 | no | Publish no failed component and perform no ref, history-mode, or source-kind fallback; invalid OCI source manifest fails before layer requests. |
| `workspace_acquisition_unavailable` | Timeout, DNS, registry/Git service, or other transient source transport failure | 503 | yes | Detach request-local work, preserve independently valid shared components, and expose no partial workspace. |
| `workspace_contract_limit_exceeded` | A fixed v1 per-source or aggregate count/byte/path/ratio/time/output ceiling is exceeded | 413 | no | Stop bounded work, clean/quarantine staging, and expose no partial workspace. |
| `workspace_capacity_exceeded` | Operator concurrency, disk, inode, mount, or lower policy capacity is temporarily unavailable | 503 | yes | Admit no partial binding; capacity policy must not masquerade as a schema limit. |
| `workspace_attachment_failed` | Initial attachment or later live reattachment fails bind/copy, ownership, protection, baseline, cwd, or ready validation | 500 | yes | Keep an initial binding non-ready or fail a post-ready reattachment; reverse/unmount request-local state and never run the harness. |
| `session_expired` | Continuation targets a workspace-backed session at or after fixed `expires_at` | 404 | no | Preserve the pinned UHP `session_expired` response, omit workspace metadata, and do not restore, reacquire, or extend expiry. |
| `workspace_restore_invalid` | Required binding, component, checkpoint, baseline, or cursor evidence is missing, corrupt, or mismatched | 500 | no | Fail closed with no source traffic, replacement selection, or empty-root recovery. |
| `workspace_collection_failed` | Manifest traversal/comparison, file/change-artifact capture, or ACK persistence fails | 500 | yes | Do not ACK or publish an incomplete change set; retry reproduces the same logical changes. |
| `workspace_checkpoint_failed` | Mount-aware archive creation or durable checkpoint persistence fails after collection | 500 | yes | Preserve the acknowledged collection state, publish no invalid checkpoint, and retry checkpoint persistence without rerunning the harness. |

Failures before the first ready transition omit `metadata.workspace`; workspace
failures after ready return the stored sanitized `metadata.workspace`. The
inherited `session_expired` response is the sole exception and remains unchanged.
No case exposes private keys, catalog origins, host paths, mounts, credentials,
raw tool stderr, or network details.

Cancellation is not a workspace error. Preserve the inherited idempotent `2xx`
cancel endpoints and terminal `status: "cancelled"` rather than returning an
error code. Cancellation before ready omits workspace metadata; cancellation
after ready returns the stored sanitized metadata. Stop unneeded descendants,
detach shared waiters safely, and leave no partial ready state.

## Implementation phases and exit proofs

Every phase changes the real named seam and ends with observable focused proof.
Mocks may isolate external provider transport, but source-text assertions and
mock forwarding are not proof.

### Phase 1: Bootstrap baseline and characterize stock seams

**Work**

- After the admin bootstrap, verify target/ref, Apache-2.0/NOTICE/history,
  `origin`, `upstream`, and fork-point record.
- Rename downstream distribution surfaces without changing attributed upstream
  material.
- Trace and record `_produced_list`, `_produced_ack`, `_collect_produced`,
  `BACKING.workspace`, `RunnerWorkspaceFiles`, `CheckpointWorkspaceFiles`,
  `HarnessSession`, and separate checkpoint/artifact/control records.
- Capture stock traces proving fresh root Git, Git produced cursoring,
  checkpoint commit-then-tar, tar hydration, live-workspace cache reaping,
  durable explicit deletion, continuation, cancellation, and provider routing.

**Exit proof:** a request without `metadata.workspace` matches pinned status,
stream, Files, checkpoint/restore, continuation, cancellation, deletion, and
provider traces; the renamed checkout preserves license/NOTICE/history and the
exact fork point.

### Phase 2: Add the closed request and session binding

**Work**

- Implement parsing, all pre-network ownership/collision checks, fixed expiry,
  private descriptor digest, and pending/ready/failed binding states on the
  existing session seam.
- Persist only the durable fields listed above and return only the pinned public
  shape after ready.
- Reject workspace metadata on every reuse/continuation path before hydration.

**Exit proof:** omitted depth and depths 1 and 1,000,000 parse and persist; depth
0, 1,000,001, fractional, and wrong-type values return
`400 workspace_invalid_request` with zero source/cache activity. One and 128
Git/OCI/mixed entries pass; 0/129, obsolete fields, unknown fields,
root/overlap/collision, malformed identities, and reused-session injection
return their exact coded errors with zero source/cache activity. Stock traces
remain unchanged.

### Phase 3: Implement canonical manifests and produced projection

**Work**

- Implement source-manifest v1 canonicalization and secure bounded traversal.
- Replace workspace-backed root-Git listing behind `_produced_list` with
  outer/editable cursor comparison; keep stock implementation unchanged.
- Extend `_collect_produced` to capture changed regular files and the canonical
  change artifact before `_produced_ack`; advance cursors only in ACK.
- Route live/checkpoint reads through the existing `BACKING.workspace` classes.

**Exit proof:** synthetic outer/editable-root fixtures produce exact
add/modify/delete/type/mode/symlink/binary artifacts independent of Git state; a
failure before ACK retries identically; and the canonical change-artifact parser
reconstructs final state from ordered artifacts.

### Phase 4: Add component cache, access modes, and ready gating

**Work**

- Implement the two exact private cache keys, independent singleflight, private
  staging, immutable publication evidence, references, reconciliation, and
  quarantine.
- Attach read-only bind mounts or editable reflink/private copies into the
  existing private workspace and revalidate live protection on every attach.
- Persist the ordered plan on the session binding and expose it only through the
  single ready transition. Add no composition cache, record, ID, or filesystem
  handoff protocol.

**Exit proof:** overlapping concurrent requests publish each missing component
once; partial cache warmth builds only misses; last-root failure exposes no
Files/checkpoint/provider/harness view; read-only sessions share immutable bytes
without source traversal during collection and require fresh mount evidence;
editable sessions cannot mutate cache/sibling content. Restart discards or
reconciles uncertain publications without persisted mount/inode facts.

### Phase 5: Implement full-by-default Git acquisition

**Work**

- Implement canonical HTTPS validation, advertised ref resolution, the per-URL
  serialized mirror, full reachable ancestry by default, exact optional shallow
  depth, detached self-contained export, safe `.git`, and source-manifest
  publication evidence.
- Enforce egress/redirect policy, limits, disabled helpers, and no ref,
  history-mode, or source-kind fallback.

**Exit proof:** default/branch/lightweight-tag/annotated-tag/merge cases resolve
to exact commits. Omitted depth provides offline log/blame/diff across complete
fetched ancestry in both access modes and bisect in editable mode. A fixture
with unrelated branches and tags proves they are neither requested for the
selected full ancestry nor exposed in the published component. Depths 1 and 2
expose exactly their shallow boundaries, publish distinct components, and each
reuses only its exact-depth component on repetition. Different ref spellings
resolving to one commit and the same history selector reuse one component; full,
depth 1, and depth 2 remain distinct. Moved refs, unsupported history requests,
malicious redirects, gitlinks, LFS, limits, cancellation, and restart fail with
exact codes. An exact key hit performs no pack acquisition or materialization.

### Phase 6: Implement OCI source-tree acquisition

**Work**

- Use `oci-auth-registry`, `oci-catalog-builder`, and
  `oci-source-fixture-builder` for catalog resolution, direct digest fetch,
  pre-layer canonical manifest validation, standard layer/whiteout extraction,
  limits, secure links/types, and exact final verification.
- Use standard client/library layer caching only; add no managed blob-cache
  subsystem. Preserve Git-free operation.

**Exit proof:** authenticated positive fixtures cover multiple OCI roots,
read-only/editable access, whiteouts, empty directories, safe hardlinks, and
exact reuse. An editable Git-free OCI mutation produces the exact canonical
change artifacts. Malicious fixtures cover catalog/media/digest mismatch,
manifest rejection before layers, traversal, links, types, sparse/compression
bombs, limits, cancellation, partial cleanup, and restart. Exact component hits
require no registry fetch or extraction.

### Phase 7: Make checkpoint, continuation, expiry, and deletion mount-aware

**Work**

- Adapt stock commit/tar and hydrate through existing checkpoint seams: outer tar
  excludes all source roots; editable roots checkpoint separately; read-only
  roots retain immutable references.
- Restore without source traffic, revalidate live attachment protection, restore
  baselines/cursors, and gate cwd/harness on ready.
- Implement fixed non-extendable expiry, explicit deletion, cancellation,
  restart reconciliation, reference release, and unavailable-first cleanup.

**Exit proof:** mixed outer/editable Git/editable OCI mutations survive turns and
restart and retain their original comparison cursors; read-only roots reattach
by exact identity; polling and continuation do not move `expires_at`; corrupt or
expired evidence fails closed; cancellation and cleanup never traverse a live
mount or expose a partial session.

### Phase 8: Produce the implementation handoff and run one release flow

The implementation agent completes the PR with local fixtures, mocked provider
transport, focused phase proofs, pinned dependencies, and release automation.
There is no separate provider phase: tests assert that both inherited harness
paths start only after ready/cwd and that workspace code does not change broker,
credential, model, or route behavior.

After review, the operator performs one release flow:

1. Build one `linux/amd64` candidate from pinned inputs, attach SBOM and build
   provenance, and publish it to
   `ghcr.io/allagentsdev/allagents-gateway:<upstream-tag>-allagents.<revision>`.
2. Read the image back and record its registry manifest digest. Deploy and test
   only `ghcr.io/allagentsdev/allagents-gateway@sha256:<digest>`.
3. Run the full release matrix once against that published/read-back digest:
   stock UHP compatibility; Codex and OMP; all-Git, multiple-OCI, and mixed
   ordered plans; partial cache warmth and singleflight; editable Git/OCI/outer
   mutation and change-artifact reconstruction; read-only enforcement; limits,
   failures, cancellation, expiry, deletion, cleanup, and secret scans.
4. Include fresh-volume and same-volume restart cases in that same matrix,
   covering pending acquisition/publication, ready attachment, checkpoint,
   continuation, cache reuse, quarantine, and cleanup reconciliation.
5. Record the upstream/fork/downstream commits, dependency and harness pins,
   fixture digests, published image digest, SBOM, provenance, and one E2E report.

Do not run a duplicate full matrix against a pre-publication build and then again
after publication. Focused local phase proofs protect implementation; the one
release matrix proves the exact distributed digest.

## Completion checklist

### Implementation agent

- PR targets renamed `allagentsdev/allagents-gateway` branch
  `feat/workspace-composition` at downstream commit `fbcb73132423c8c4575113fc8943c6a6280a4746`
  and preserves the fork network, existing downstream commits,
  Apache-2.0/NOTICE/history/upstream.
- Stock seams remain the integration points, and stock requests retain their
  pinned behavior.
- Request/response, source-manifest, change-artifact, cache-key, binding,
  lifecycle, and coded-error contracts match this plan exactly.
- Local OCI fixtures and Linux capability checks prove Git/OCI/mixed access,
  manifest cursoring, checkpoint/restore, restart reconciliation, and cleanup.
- No composition record/ID, retention/persistent field, durable live attachment
  facts, managed OCI blob-cache lifecycle, provider fork, or compatibility shim
  remains.

### Operator

- Supply provider/UHP/GHCR/deployment secrets only through the existing secret
  mechanism and retain protected settings.
- Review and merge the implementation PR, publish/read back one candidate,
  deploy by digest, and run the single full release/restart matrix.
- Accept release only when the digest, SBOM, provenance, deployment, and E2E
  report identify the same image and no secret or private workspace metadata is
  exposed.
