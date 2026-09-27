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

Create AllAgents Gateway as the downstream distribution derived from
`HarnessRouter/harnessrouter`. A first-turn UHP request MAY declare an ordered
set of independent Git and OCI source trees. The gateway MUST acquire and cache
each component independently, then compose every requested tree at its declared
non-root destination in the existing private session workspace. A composition
MUST become visible atomically: either every source root is ready at the exact
requested identity or none is visible.

The public downstream names are:

- repository: `allagentsdev/allagents-gateway`;
- image: `ghcr.io/allagentsdev/allagents-gateway`;
- service: `allagents-gateway`; and
- product: **AllAgents Gateway**.

The fork MUST retain `HarnessRouter/harnessrouter` as its upstream remote, the
recorded fork point, the upstream license, and required attribution. Upstream
changes MUST be taken selectively and reviewed against the downstream contract;
upstream acceptance is not a release dependency.

Requests without `metadata.workspace` MUST remain on the stock UHP path. Their
root-Git hydration, produced-file behavior, checkpointing, continuation,
provider routing, cancellation, retention, and cleanup MUST remain compatible
with the pinned upstream baseline. The new component, composition, manifest,
and workspace-aware lifecycle apply only when `metadata.workspace` is present
on a new session.

## Stock behavior and adaptation boundary

The pinned upstream baseline owns session identity, one private writable
workspace per session, hydrate/checkpoint, UHP inputs, generated instructions,
`.harness`, HOME, skills, plugins, MCP configuration, conversation state,
Files/artifacts, cancellation, TTL, deletion, restart reconciliation, harness
supervision, and provider brokering. Stock fresh hydration initializes an empty
root Git repository. Stock produced-file collection and checkpointing use that
root repository and may traverse the whole workspace.

Phase 1 MUST characterize the exact upstream call paths and ordering rather than
assuming that summary is exhaustive. The workspace-backed path MUST reuse the
same session and runner lifecycle but replace root/nested Git correctness with
filesystem-manifest correctness. For a workspace-backed session:

- the outer workspace remains private and writable;
- source destination ownership and identities are immutable for the life of the
  session, while `editable` tree contents may change;
- root Git, nested Git commits, indexes, status, diff, and rename detection MUST
  NOT determine produced changes, evaluation results, or checkpoint correctness;
- Git metadata MAY be present as acquisition data and agent convenience only;
- OCI components need not contain Git metadata;
- Files collection and final evaluation MUST compare canonical filesystem
  manifests for every source root and the writable outer workspace;
- checkpoint, restore, Files walks, and cleanup MUST understand source
  boundaries and MUST NOT accidentally traverse a read-only mount; and
- no second workspace service, session database, Files API, scheduler, or
  external materializer service is introduced.

## Product and ownership boundary

### In scope

- A strict first-turn-only `metadata.workspace` extension to UHP.
- A closed ordered `sources` array containing 1 to 128 independent Git, OCI, or
  mixed source entries.
- Exactly one source tree and one required non-root `destination` per entry. A
  monorepo is one tree, not an implicit bundle of roots.
- Canonical public HTTPS Git acquisition with exact commit resolution and a
  mandatory depth-2 fetch policy.
- Operator-cataloged OCI source-tree transport selected by a direct image
  manifest digest and a canonical source manifest digest.
- Independent component cache and singleflight, followed by atomic composition.
- Identical `read_only` and `editable` attachment semantics for Git and OCI.
- Canonical baseline source manifests for all components and a canonical
  baseline for the writable outer workspace.
- Manifest-based add, modify, delete, mode, executable, symlink, and binary
  change detection for workspace-backed sessions.
- Mount-aware checkpoint and continuation, including separate preservation of
  editable roots.
- Per-source and request-aggregate resource limits.
- Codex and OMP through the existing separately operated
  OAuth-to-OpenAI-compatible provider gateway and brokered credentials.
- Direct Promptfoo proof against the built image, including multiple OCI
  components, a mixed Git/OCI composition, editable OCI mutation, and cache
  reuse.
- Digest-pinned GHCR publication with SBOM and build provenance.

### Explicit non-goals

- Caller-selected runtime/container images or benchmark environments. An OCI
  image is only a transport and cache unit for one source tree; it is never the
  runtime workspace and never a multi-root workspace bundle.
- Caller-provided registry origins, credentials, headers, certificates, mirrors,
  proxy settings, Git configuration, source commands, or materializer hooks.
- A public component-cache or composition API.
- Silent Git-to-OCI, OCI-to-Git, ref, digest, mirror, deepening, full-clone, or
  provider fallback.
- Git submodule initialization, Git LFS hydration, checkout filters, or hook
  execution.
- Requiring a Git repository at workspace root or inside an OCI tree.
- Provider login, refresh, or repair in AllAgents Gateway.
- An AllAgents CLI, profile import, local gateway command, or `workspace.yaml`
  change.
- Upstream acceptance as a release condition.

## Request contract

`metadata.workspace` MUST be accepted only while creating a new session. The
schema uses snake_case, has no nested schema version, and is closed at every
object boundary.

```json
{
  "metadata": {
    "harness_id": "allagents-codex",
    "workspace": {
      "access": "editable",
      "retention": "session",
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

The exact shape is:

```text
metadata.workspace = {
  access: "read_only" | "editable",
  retention?: "session" | "persistent",
  sources: Array<
    | {
        kind: "git",
        url: string,
        ref?: string,
        destination: string
      }
    | {
        kind: "oci",
        snapshot_name: string,
        image_manifest_digest: string,
        source_manifest_digest: string,
        destination: string
      }
  >,
  working_directory?: string
}
```

The obsolete singular `source`, `kind: "repositories"`, `repositories`,
`kind: "workspace_snapshot"`, and `workspace_manifest_digest` fields MUST NOT be
accepted as aliases. There is no compatibility schema.

### Validation rules

1. `access` and `sources` are REQUIRED. `retention` defaults to `session`.
   `sources` MUST contain 1 to 128 entries and preserves request order.
2. Every entry MUST materialize exactly one tree at its own required
   `destination`. Multiple Git entries, multiple OCI entries, duplicate
   component identities at different destinations, and mixed Git/OCI entries
   are valid.
3. Every destination and supplied `working_directory` MUST be a relative POSIX
   path with no empty, `.`, `..`, ambiguous, or platform-specific component and
   no link escape. A destination that normalizes to the workspace root is
   invalid. An omitted `working_directory` means the root, represented as `.`
   only in the response.
4. Destinations MUST be pairwise non-overlapping after normalization: no two are
   equal and neither is an ancestor of another. Their ownership is determined
   entirely from the request; OCI content MUST NOT add or move a root.
5. UHP input paths, generated assets, reserved runner paths, credential paths,
   cache paths, attachment state, and checkpoint state MUST be normalized and
   checked against every destination before source resolution, network traffic,
   cache lookup, session workspace writes, or component claims. Any path equal
   to or below a source destination MUST be rejected for both access modes.
   Inputs and generated assets outside all source destinations remain valid in
   the writable outer workspace.
6. Destination ancestor scaffolding MAY coexist only with independently valid
   outer directories. A file, symlink, generated asset, input, or reserved path
   at an ancestor that prevents safe directory scaffolding MUST fail before
   network work.
7. `working_directory` syntax is validated before network work. After atomic
   composition it MUST resolve, without link escape, to a real directory either
   in the outer workspace or within exactly one source root.
8. A Git `url` MUST be canonical public HTTPS under the deployment egress policy.
   User information, query strings, fragments, credentials, alternate
   transports, ambiguous encodings, and caller transport options are forbidden.
   `ref`, when present, is bounded and resolves only through advertised branch
   or tag semantics.
9. An OCI entry MUST provide an operator-catalog `snapshot_name`, a direct
   `sha256:` image manifest digest, and a canonical `sha256:`
   `source_manifest_digest`. Tags, indexes/lists, mutable references, and caller
   registry coordinates are forbidden.
10. Unknown fields, wrong-kind fields, mixed fields within one entry, invalid
    digests, and obsolete schema fields MUST fail closed.
11. Metadata bytes, nesting, strings, path lengths, source count, and input count
    MUST be bounded during parsing. Persistent retention MUST be authorized
    before cache lookup or network work.
12. A continuation selected by `previous_response_id` or the existing recovery
    mechanism MUST omit `metadata.workspace`. Supplying it on a reused session
    MUST fail before hydrate, component lookup, provider traffic, or TTL changes,
    even if it equals the stored descriptor. A stock session cannot become a
    workspace-backed session later.
13. Workspace fields MUST NOT contain commands, environment variables, resource
    limits, provider settings, model settings, registry settings, or harness
    settings.

Because every source declares its destination, all destination ownership,
source-source overlap, and input/asset collision decisions are request-decidable
and MUST complete before any network request. OCI source-manifest validation is
content validation, not destination discovery.

## Source and request limits

Bounds MUST be enforced while streaming, before allocation whenever the size is
known, and both per source and across the whole request. Deployment policy MAY
lower a bound but MUST NOT raise these v1 ceilings without a contract revision.
A lower runtime capacity is a coded capacity failure, not a schema change.

| Resource | Per source ceiling | Request aggregate ceiling |
|---|---:|---:|
| Expanded source bytes | 32 GiB | 64 GiB |
| Source-visible entries | 500,000 | 1,000,000 |
| Compressed Git pack or OCI layer bytes | 8 GiB | 16 GiB |
| Regular file size | 4 GiB | 4 GiB |
| Path | 4096 UTF-8 bytes / 128 components | same per path |
| Acquisition and materialization wall time | bounded by operator policy | bounded by session policy |

Each OCI source additionally permits at most 64 distributable tar/gzip/zstd
layers, a 4 MiB image manifest, a 128 MiB canonical source manifest, and 1 MiB
per PAX or extended header. For each layer, each OCI source, and the request
aggregate, `expanded_bytes / max(compressed_bytes, 1)` MUST NOT exceed `100`.
Git object, checkout, inode, output, and filesystem quotas MUST feed the same
per-source and aggregate accounting rather than becoming unbounded exceptions.

## Canonical manifests and change semantics

### Component baseline source manifest

Every published Git or OCI component MUST have a canonical baseline source
manifest. It is keyed by normalized path relative to that component root and
contains, for every included filesystem entry:

- normalized relative path and entry type;
- regular-file content digest and size;
- executable bit and the platform-normalized mode semantics needed to reproduce
  observable permissions;
- symlink target bytes after canonical encoding; and
- any bounded hardlink representation required by the extraction policy.

Ordering and serialization MUST be canonical. Directory and link semantics MUST
make type changes observable. Binary files use content digests exactly like text
files; no text decoding or line diff is required for correctness. The component
manifest digest is part of the immutable component publication.

For Git, the runner computes the manifest from the verified detached depth-2
checkout. For OCI, the canonical manifest named by `source_manifest_digest` MUST
be fetched and verified before any layer request. Its paths are relative to the
single requested destination. It MUST declare the final types, modes, sizes,
content digests, and links that layer application is expected to produce. Final
extraction MUST exactly match it before publication.

Git administrative state MAY be acquired and retained for agent convenience,
but it is never a change baseline. OCI trees MAY omit it entirely. A source
manifest MAY verify declared Git administrative files when present; the change
collector MUST exclude every `.git` entry from reported changes.

### Outer workspace baseline

For a workspace-backed session, fresh hydration MUST create the writable outer
workspace and apply allowed UHP inputs, generated instructions, harness assets,
and other initial session material outside source destinations. Immediately
before the first harness process starts, the runner MUST publish a canonical
outer baseline manifest using the same path/type/content/mode/link model. It
MUST exclude source destinations and runner-owned state.

The session binding MUST preserve the exact component baseline manifests and the
outer baseline across continuation. A continuation MUST NOT silently regenerate
a baseline from already-mutated content.

### Final-tree comparison

At every required collection/evaluation boundary, the runner MUST walk the
writable outer workspace without crossing a source mount and MUST walk every
source root through its declared ownership boundary. It MUST compare each final
manifest to the corresponding persisted baseline and report the union of:

- additions;
- content modifications, including binary changes;
- deletions;
- executable or other observable mode changes; and
- symlink additions, removals, retargeting, and type transitions.

Rename inference is OPTIONAL. Delete-plus-add is correct; final-tree equality is
authoritative. Root Git, nested Git, commits, index state, ignored-file rules,
and Git rename detection MUST NOT be correctness sources. A Git command MAY be
available to the agent, but it MUST NOT change evaluator results.

The collector MUST normalize each reported path into workspace-relative form,
assign it to exactly one owner (outer workspace or one source destination), and
deduplicate it. It MUST exclude `.git`, runner-owned state, credentials, caches,
attachment evidence, checkpoint metadata, harness-private ephemeral state, and
the component store. Existing count, size, and artifact limits still apply to
reported outputs. Initial source and outer baseline entries MUST NOT be reported
merely because composition or hydration created them.

`read_only` source roots are compared as an integrity check and MUST remain equal
to their component baselines. `editable` Git and OCI roots are compared with the
same algorithm and MUST report mutations identically. Bug-fix evaluations MUST
request `access: "editable"`.

## Identity, cache, and generation design

A **component** is one verified immutable source tree. A **composition** is an
ordered mapping of exact component identities to normalized destinations. A
**session attachment** applies one composition under an access mode to one
private outer workspace. None is a runtime image or a second session.

### Component identities

A Git component identity MUST include the canonical URL, exact resolved commit,
fixed depth `2`, Git acquisition-policy revision, materializer revision, and
canonical baseline source-manifest digest. The request destination, ref spelling,
access, session, harness, provider, retention, and working directory MUST NOT
fragment the component cache.

An OCI component identity MUST include the operator catalog identity,
`snapshot_name`, direct `image_manifest_digest`, canonical
`source_manifest_digest`, OCI validation-policy revision, materializer revision,
and verified baseline source-manifest digest. Registry origin and credentials
MUST remain private. Destination and session concerns MUST NOT fragment the
component cache.

The canonical composition identity MUST reference, in request order, each exact
component publication identity paired with its normalized destination, plus the
layout/materializer contract revision. Reordering entries therefore changes the
composition identity even when component bytes are the same. The composition
record contains references and evidence, not another copy of component bytes.

### Git acquisition cache

The runner MUST maintain one operator-only bare shallow acquisition mirror per
canonical Git URL. Every write to that mirror MUST be serialized; concurrent
resolution/fetch for the same normalized request MUST singleflight. On a miss,
the worker MUST resolve the advertised default, branch, or tag to an exact
commit, fetch exactly depth 2, verify the fetched tip and shallow boundary, and
atomically import the bounded result. It MUST NOT deepen, unshallow, full-clone,
fetch an arbitrary object ID, choose another ref, or fall back to OCI.

An immutable self-contained component checkout MUST be exported without
alternates or writable links to the mirror. It MUST preserve enough normalized
`.git` data for recent offline `git log`, parent inspection, blame where the
shallow history permits, and diff. A merge tip MUST retain both fetched parent
edges when the server supplies them at depth 2. Submodule gitlinks and LFS
pointer-backed content MUST fail rather than invoke helpers.

A hit for the same exact component identity MAY advertise a mutable ref to prove
that it still resolves to that commit, but MUST perform zero pack acquisition,
checkout, tree copy, baseline recomputation, or publication. Separate counters
MUST distinguish advertisement from source-byte transfer.

### OCI component cache

The deployment owns a bounded catalog. Each `snapshot_name` maps to one
operator-controlled registry/repository origin, credential reference, TLS and
redirect policy, allowed media types, and resource policy. Those values MUST NOT
appear in the request, session workspace, logs, public provenance, or harness
environment.

The worker MUST require a direct image manifest digest and reject tags,
indexes/lists, mutable references, and catalog mismatches. It MUST fetch and
verify the image manifest, config, and canonical source manifest before any
layer request. It MUST validate the source manifest's relative paths, types,
sizes, modes, content digests, links, declared layer requirements, and per-source
and aggregate limits before downloading layers.

Layers MUST be streamed, digest-checked, and applied in order with correct file
and opaque-directory whiteout semantics. Whiteouts are instructions and MUST
NOT appear in the publication. Extraction MUST reject absolute paths, traversal,
NULs, ambiguous separators, conflicting duplicates, devices, FIFOs, sockets,
unsafe sparse files, unsupported types, and unbounded metadata. Symlinks and
hardlinks MUST remain within their owning source root; links to the outer
workspace or another source are invalid. The completed tree MUST exactly match
the canonical source manifest before atomic publication.

An exact OCI component-cache hit MUST perform zero registry manifest/config/
source-manifest/layer requests, extraction, tree copy, baseline recomputation, or
publication. An OCI component is always one tree; an image that encodes multiple
workspace roots or files outside that tree's relative manifest MUST fail.

### Singleflight, publication, and reuse

Each component identity MUST have its own durable singleflight claim and random
private staging directory. Independent components MAY acquire concurrently
within request and operator limits. A waiter cancellation MUST detach only that
waiter while another live request still needs the build. When no waiter remains,
the bounded builder MAY be cancelled. Failed, timed-out, cancelled, partial, or
unverified staging MUST never become attachable.

After streamed accounting and full manifest verification, publication MUST use
an atomic rename and record ownership, policy revisions, manifest digest,
publication epoch, and completeness. Published component bytes and manifests
MUST be immutable. Startup reconciliation MUST quarantine uncertain state. A
lease/reference MUST protect a component from cleanup; cleanup MUST remove only
complete unreferenced publications and MUST NOT invalidate an attached session.

A composition resolver MUST wait for every independently claimed component,
verify the ordered identities and destinations, and commit one immutable
composition record. One component failure MUST roll back request-local staging
and references without invalidating successful shared components needed by
other sessions. No partial composition can be attached.

## Access and atomic attachment

Both acquisition kinds MUST implement the same access behavior.

- `read_only`: lease each immutable component and bind-mount its root at the
  declared destination with kernel-enforced read-only, `nodev`, and `nosuid`
  semantics while preserving required execute bits. The session MUST receive no
  writable backing descriptor, alias, overlay/copy-up path, mirror path, or
  component-store path. Symlinks are forbidden as an attachment mechanism.
- `editable`: lease each immutable component and create an inode-independent
  private writable copy or safe reflink at the declared destination. A later
  write MUST NOT mutate the cache or any sibling session. Hard-linked mutable
  files and writable aliases are forbidden.

The runner MUST construct fresh and continued workspace-backed sessions in a
private, non-runnable staging workspace or private mount namespace. It MUST
prepare the outer state, all mountpoint scaffolding, every read-only mount and
editable copy, manifest evidence, and the validated working directory there. It
MUST expose no Files, checkpoint, provider, or harness consumer until every
entry verifies. A single atomic workspace-path publication or namespace handoff,
paired with the session ready transition, MUST make all roots visible together.
Any failure MUST unwind mounts in reverse order, remove private copies/staging,
release request-local references, and leave no runnable or externally visible
partial workspace.

Matching read-only sessions MUST bind the same immutable component bytes.
Editable sessions MUST start from those same publications without reacquisition
but have independent inodes. The outer workspace remains private and writable
in both modes.

## Session binding and public provenance

The existing session/checkpoint record MUST store:

- the canonical effective descriptor and digest;
- the ordered resolved source plan;
- each exact component identity, publication epoch, and baseline source-manifest
  digest;
- the composition identity and ordered destination ownership map;
- `access`, effective `retention`, normalized `working_directory`, and selected
  harness/provider binding;
- the outer baseline manifest identity;
- attachment evidence per destination, including mount/copy method, filesystem
  identity, read-only protection or editable inode independence;
- checkpoint identities for writable outer state and each editable source root;
- exact sanitized public provenance; and
- existing expiry, deletion, and lifecycle state.

The public `metadata.workspace` response MUST contain exactly `access`,
`retention`, `working_directory`, `effective_descriptor_digest`,
`composition_id`, ordered `sources`, and `expires_at`. `working_directory` is
always present and uses `.` for workspace root. `expires_at` is `null` only for
authorized persistent retention.

Each public Git source entry contains `kind: "git"`, normalized public `url`,
`destination`, exact `resolved_commit`, `depth: 2`, `component_id`,
`source_manifest_digest`, and `requested_ref` only when supplied. Each public
OCI entry contains `kind: "oci"`, `snapshot_name`, `destination`, exact
`image_manifest_digest`, exact `source_manifest_digest`, and `component_id`.
Private component keys, catalog origins, mirrors, credentials, host paths, mount
IDs, leases, policy identities, and attachment paths MUST NOT be public. Replay
and continuation return the stored committed object and MUST NOT re-resolve
mutable references.

## Lifecycle

### New workspace-backed session

1. Authenticate and validate the stock UHP envelope; establish existing
   idempotency ownership and whether the request creates or reuses a session.
2. For a new workspace-backed session, parse and strictly validate the closed
   descriptor, authorize retention, normalize the ordered 1–128 entries, and
   reject all destination overlap and destination/input/asset/reserved-path
   collisions before network, cache lookup, workspace writes, or component
   claims.
3. Persist a pending session binding containing only the validated canonical
   request. Allocate an inaccessible staging workspace under the existing
   session/isolation lifecycle.
4. Resolve exact components. Git resolves advertised refs and depth-2 commits.
   OCI verifies the image and canonical source manifest before layer requests.
   Enforce per-source and aggregate limits as facts become known.
5. Claim/reuse each component independently. Acquire, materialize, verify, and
   atomically publish misses; retain leases for hits. Wait for all entries and
   commit the ordered composition identity. On any failure, attach none.
6. Fresh-hydrate the private outer staging workspace. Apply allowed inputs and
   generated assets only outside destinations. Create empty, non-link
   destination directories and safe ancestor scaffolding after rechecking the
   prevalidated ownership map.
7. Attach every component using the requested access mode. Verify exact
   identities, read-only flags/no writable aliases, or editable ownership/inode
   independence. No consumer can observe the workspace during this step.
8. Validate the effective working directory. Publish the canonical outer
   baseline after all initial outer assets are present, retain every canonical
   component baseline, and persist attachment/checkpoint evidence.
9. Atomically publish the complete workspace and transition the existing session
   binding to ready. Only then select the provider and start the harness.
10. At collection, compare final outer and source manifests to their baselines.
    Checkpoint the writable outer tree without crossing source destinations;
    checkpoint each editable source separately. Read-only source bytes are never
    archived. Complete the existing stream/session transition and schedule
    cleanup.

Duplicate initial requests MUST share the existing idempotent result and MUST
NOT claim a second composition or attachment.

### Continuation

A continuation MUST NOT parse or resolve sources or contact Git/OCI endpoints.
It MUST:

1. recover and validate the stored descriptor digest, exact component and
   composition identities, destination map, access, manifests, attachment
   evidence, checkpoints, and lifecycle state;
2. ensure stale mounts are unmounted, then restore the writable outer checkpoint
   into an inaccessible staging workspace using no-follow/no-cross-mount
   operations;
3. restore each editable root from its separate checkpoint, or reacquire the
   exact recorded immutable lease and prepare the exact read-only bind mount;
4. validate destination scaffolding, collisions, component/baseline identities,
   editable ownership, and read-only protection;
5. restore the original outer and component baselines without recomputing them
   from mutated session content;
6. validate the working directory and atomically publish the complete workspace;
   and
7. only then activate provider credentials, Files collection, and the harness.

A missing, expired, corrupt, wrong-generation, writable, partially restored, or
unsupported attachment MUST fail closed. Continuation MUST NOT select another
cached component, reacquire source bytes, publish empty roots, or discard
editable mutations.

### Checkpoint, retention, and cleanup

The outer checkpoint MUST exclude every source destination and all source bytes.
Each editable Git or OCI root MUST have a separate private checkpoint and retain
its baseline identity. Read-only roots are reattached from immutable component
publications. Checkpointing and restore MUST be no-follow, mount-aware, bounded,
and cancellation-safe.

`retention: "session"` follows existing finite TTL and deletion. Authorized
`persistent` retention pins the existing session and required references until
explicit deletion or applicable operator policy; it does not create another
scheduler. Polling and replay MUST NOT extend retention.

Cleanup MUST first make the session unavailable, stop descendants, unmount every
source destination, verify mount absence, remove editable copies and outer
state, and release composition/component references exactly once. Hydrate,
restore, delete, cancellation, and restart reconciliation MUST follow the same
unmount-before-traversal rule. An uncertain or failed cleanup MUST quarantine the
path, keep it unavailable and accounted, and permit confined idempotent retry.

## Implementation phases

Every phase ends in observable behavior through the real boundary. Source-text
inspection and mock forwarding are not sufficient proof.

### Phase 1: Rename the downstream and pin the upstream baseline

**Outcome:** AllAgents Gateway has stable distribution identity and a recorded,
reproducible upstream relationship.

Work:

1. Record HarnessRouter `v0.25.4`, commit
   `5f82db1d1f13ea25b8ed0893c38b5b7d2e3e57e3`, and UHP `2026-09-12` as the
   initially examined fork point. The implementation PR MUST record the exact
   selected baseline and move it only in a standalone synchronization change.
2. Rename downstream repository/package references from
   `allagentsdev/harnessrouter` to `allagentsdev/allagents-gateway`, the image to
   `ghcr.io/allagentsdev/allagents-gateway`, the service to `allagents-gateway`,
   and user-facing product text to AllAgents Gateway.
3. Preserve `HarnessRouter/harnessrouter` as upstream, the upstream license and
   notices, copyright/attribution, commit history where available, and a durable
   fork-point record. Configure origin as `allagentsdev/allagents-gateway`.
4. Define selective upstream intake: inspect each upstream diff, preserve the
   downstream schema/security/lifecycle contract, and run stock plus downstream
   gates before accepting it. Do not mirror upstream blindly.
5. Pin base image, OS packages, Git and OCI libraries/tools, Codex, OMP,
   Promptfoo, lockfiles, and CI actions. Build the unchanged renamed baseline.
6. Characterize fresh root-Git hydration, pre-turn writes, Files collection,
   checkpoint Git mutation/archive/restore, continuation clearing,
   cancellation, TTL, deletion, cleanup, restart, and provider routing.
7. Save stock UHP traces for requests without `metadata.workspace`. Identify the
   exact branch point where workspace-backed requests stop using root-Git change
   collection while stock requests remain unchanged.

Exit proof:

- repository, image, service, and product surfaces use only the new downstream
  names while attribution and the upstream remote/fork point remain intact;
- a clean checkout builds the pinned image; and
- stock requests complete with byte-for-byte compatible status/stream fixtures
  and no workspace-specific state.

### Phase 2: Implement the ordered closed request schema

**Outcome:** request validation decides ownership and collisions before source or
session side effects.

Work:

1. Parse only `metadata.workspace` and reject obsolete schema names.
2. Apply metadata byte, nesting, list, string, digest, URL, and path bounds during
   parsing.
3. Validate the closed `sources` array for counts `1..128`, entry-kind fields,
   canonical Git HTTPS URLs, OCI direct digests, required destinations, global
   pairwise non-overlap, and working-directory syntax.
4. Normalize UHP inputs, generated assets, reserved paths, credentials, caches,
   attachment/checkpoint locations, and source destinations in one request-level
   ownership validator. Reject every collision at or below a destination and
   unsafe ancestor before network or cache work, regardless of access mode.
5. Authorize persistent retention before source lookup. Canonically serialize
   the descriptor with defaults and calculate its digest.
6. Extend the existing new-session transition with pending and ready workspace
   binding states. Reject metadata on every reuse/continuation path before
   hydration.
7. Preserve initial-request idempotency and bounded UHP error details. Commit
   public provenance only after atomic attachment readiness.

Exit proof covers zero, one, 128, and 129 sources; all-Git, all-OCI, and mixed
arrays; repeated component identity at different destinations; ordering;
unknown/obsolete/wrong-kind fields; normalized root/equal/ancestor overlap;
input/asset/reserved collisions; outer inputs; URL/digest/path bounds;
retention authorization; both continuation mechanisms; idempotent duplicates;
harness mismatch; and an unchanged stock trace. Network and component counters
MUST remain zero for every request-decidable rejection.

### Phase 3: Add canonical manifests and manifest-based collection

**Outcome:** workspace-backed correctness depends only on canonical filesystem
state, never Git state.

Work:

1. Implement canonical streaming manifest creation and comparison for regular
   files, binary bytes, directories, executable/mode semantics, symlinks, and
   supported hardlinks.
2. Define deterministic ordering/serialization and content-digest algorithms.
   Enforce no-follow traversal, ownership boundaries, source and aggregate
   limits, and cancellation.
3. Publish one immutable baseline manifest with every component. Create and
   persist the outer baseline only after initial outer inputs/assets exist and
   before the first harness process.
4. Route workspace-backed Files/evaluation collection through final-manifest
   comparison for the outer workspace and every source. Remove root/nested Git
   commits, indexes, status/diff, ignore behavior, and rename detection from the
   correctness path. Leave the stock collector untouched for requests without
   workspace metadata.
5. Normalize ownership and exclude `.git`, runner state, credentials, caches,
   attachment evidence, checkpoint metadata, harness-private ephemeral state,
   and component-store paths.
6. Persist baseline identities across checkpoint/continuation and fail closed on
   missing or mismatched baseline evidence.

Exit proof mutates outer, Git, and Git-free OCI trees and observes identical
add/modify/delete/mode/symlink/binary results. It changes Git index, commits,
ignore files, and rename heuristics without changing final-tree results. It
proves delete-plus-add is accepted as a rename representation, initial trees are
not reported, exclusions never leak, read-only trees remain equal, and a stock
request still uses unchanged root-Git behavior.

### Phase 4: Add independent component storage and atomic composition

**Outcome:** components singleflight and cache independently, while consumers see
all requested roots or none.

Work:

1. Add durable component claim, staging, verification, atomic publication,
   lease, quarantine, and cleanup states under runner-owned `/data`.
2. Key components without destination/session concerns. Build composition
   identity from the ordered exact component identities and destinations; store
   references rather than copied source bytes.
3. Resolve and claim independent entries concurrently within bounded worker,
   network, disk, and aggregate request limits. Detach cancelled waiters without
   cancelling a component still needed elsewhere.
4. Construct the outer workspace and all source attachments in an inaccessible
   staging path or private mount namespace. Add one atomic publish/handoff plus
   ready transition. Reverse-unwind every partial mount/copy/reference on error.
5. Implement identical read-only bind and editable copy/reflink behavior for Git
   and OCI. Verify mount flags, no writable aliases, component identity, and
   editable inode independence.
6. Thread the immutable destination map through Files, archive, hydrate, restore,
   delete, and cleanup with explicit excludes and no-cross-mount traversal.
7. Add bounded metrics for component resolution/acquisition/hit/publication,
   composition commit/hit/rollback, mount/copy, manifest creation/comparison,
   checkpoint, reconciliation, quarantine, and cleanup without paths or secrets.

Exit proof races identical and partially overlapping compositions. Each exact
component publishes at most once; a warm Git/cold OCI request reuses Git while
building only OCI; a warm OCI/cold Git request does the inverse. Ordered
composition IDs change with order/destination while component IDs stay stable.
Injected failure in the last of several roots exposes no source or runnable
workspace. Two read-only sessions share component inodes but not outer state;
two editable sessions share no mutable inode.

### Phase 5: Implement depth-2 Git components

**Outcome:** each Git entry produces one verified immutable component with useful
bounded recent history.

Work:

1. Enforce canonical public HTTPS and the fixed egress/redirect/address policy.
   Isolate Git config and disable interactive credentials, hooks, filters,
   alternates, alternate protocols, submodules, and LFS hydration.
2. Resolve omitted ref through advertised symbolic default; resolve advertised
   branches and lightweight/annotated tags to exact commits. Reject ambiguous,
   missing, unsupported, non-commit, or moved targets.
3. Serialize one operator-only bare shallow mirror per canonical URL. Fetch the
   selected advertised path with exactly `--depth=2` into bounded private state,
   verify the expected commit and shallow boundary, then atomically import.
4. Export a self-contained detached checkout with normalized bounded `.git`
   metadata and no writable mirror link. Preserve merge parents when available
   within depth 2. Reject gitlinks and LFS pointer-backed content.
5. Compute/verify the canonical component baseline, enforce per-source and
   aggregate checkout bounds, and publish independently of destination.
6. Ensure exact identity hits transfer no pack and perform no checkout, tree
   copy, baseline recomputation, or publication after optional ref confirmation.

Exit proof covers default, branch, lightweight/annotated tag, moved ref, same URL
at different refs, depth exactly 2, `.git/shallow`, recent offline log/blame/diff,
merge parents, detached exact commit, malicious redirects, unsupported shallow
server, submodule/LFS rejection, cancellation, restart, and exact provenance.
Concurrent cold requests perform one mirror refresh and component publication;
an exact hit records zero source-byte work. Release notes state that depth 2
limits history, not working-tree bytes.

### Phase 6: Implement OCI source-tree components

**Outcome:** each OCI entry produces exactly one verified tree component without
Git fallback or implicit workspace roots.

Work:

1. Implement the bounded operator catalog and direct image-manifest resolution.
   Keep registry/repository origin, credentials, TLS configuration, and redirects
   server-side.
2. Fetch and verify the image manifest, config, and exact canonical source
   manifest before layers. Validate relative ownership, all expected final
   entries, links, modes, sizes, digests, and known per-source/aggregate limits.
3. Stream bounded layers, verify descriptors, apply whiteouts, and enforce path,
   type, link, sparse-file, compression-ratio, inode, byte, output, cancellation,
   and time limits.
4. Confine links to the one owning component root and reject multi-root or outer
   workspace content. Match the final tree exactly to the canonical source
   manifest before publication.
5. Support Git-free trees and optionally normalized bounded Git administrative
   data for agent convenience. Neither form changes manifest-based evaluation.
6. Ensure exact identity hits make zero registry requests, extraction, tree copy,
   baseline recomputation, or publication.

Exit proof uses an authenticated local registry and malicious fixtures for
catalog/digest/media mismatch, indexes, redirects, authentication, truncation,
compression bombs, limits, whiteouts, traversal, path/type/link attacks,
devices, sparse files, cancellation, partial cleanup, and restart. Positive
fixtures cover Git-free and history-bearing trees, read-only and editable
attachment, two independent OCI entries, exact-hit reuse, and source-manifest
rejection before the first layer request.

### Phase 7: Make checkpoint and continuation composition-aware

**Outcome:** complete compositions survive turns and restarts without source
traffic or baseline loss.

Work:

1. Archive the writable outer workspace with every destination excluded and
   no-follow/no-cross-mount enforcement. Store no source bytes in the outer
   checkpoint.
2. Preserve every editable Git or OCI root in an independent private checkpoint;
   preserve immutable component references for read-only roots. Retain original
   baseline identities separately from mutable final state.
3. Implement the staged continuation order: validate binding/evidence, unmount
   stale roots, restore outer state, restore editable roots or exact read-only
   leases, verify all roots, restore baselines, validate cwd, then atomically
   publish.
4. Reconcile every durable transition after restart. Missing/corrupt evidence,
   publication, checkpoint, mount, or baseline fails closed without network or
   replacement component selection.
5. Make cancellation, expiry, explicit deletion, persistent retention, cleanup,
   quarantine, and reference release composition-aware and idempotent.

Exit proof checkpoints mixed compositions after mutating outer, editable Git,
and editable OCI paths. Continuation preserves every mutation and baseline,
makes zero source requests, and reports the same final-tree changes. A read-only
continuation rebinds exact component inodes. Restart and cancellation are
injected at each claim, publication, composition, mount/copy, baseline,
checkpoint, handoff, and cleanup transition. No partial workspace becomes ready.

### Phase 8: Wire harnesses and provider boundary

**Outcome:** Codex and OMP run in the atomically composed workspace without
source or long-lived provider credentials.

Work:

1. Pin Codex and OMP and enable only required backends with
   `HR_BACKENDS=codex,omp` unless the renamed downstream configuration surface
   adopts an equivalent key in the same change.
2. Define stable `allagents-codex` and `allagents-omp` harnesses with explicit
   model allowlists.
3. Use the same external provider gateway through one Responses connection for
   Codex and one Chat Completions connection for OMP, with no fallback.
4. Retain server-side long-lived credentials and existing short-lived scoped
   turn credentials/loopback route. Remove ephemeral provider configuration
   before checkpoint and collection.
5. Start each harness only after atomic attachment and from the validated working
   directory. Keep HOME, skills, scratch, conversation, credentials, generated
   assets, and checkpoint control in private outer locations.
6. Reject caller provider, route, model, transport, source credential, and
   registry overrides. Provider failure MUST NOT alter composition binding.

Exit proof runs both harnesses against all-Git, all-OCI, and mixed compositions
at outer and nested working directories in both access modes. It verifies that
caller, Git, registry, broker, and provider secrets are absent from output,
checkpoints, reported files, artifacts, logs, and public metadata. Unsupported
models and bad credentials produce no route fallback. Stock requests retain
their original provider path.

### Phase 9: Run direct release-blocking E2E

**Outcome:** the built image proves the consumer-visible component, composition,
manifest, lifecycle, and compatibility contracts.

Promptfoo MUST call the built image directly at the existing UHP Responses
endpoint with an AllAgents Gateway caller API key. There is no adapter service or
alternate execution protocol.

Release-blocking scenarios:

1. **Large OCI component:** publish a deterministic source tree with at least
   2 GiB expanded bytes and 100,000 source-visible entries, a late-path sentinel,
   a nested working directory, and optional normalized offline history. Record
   actual compressed/expanded bytes, entry count, layers, ratio, and digests.
2. **Multiple OCI:** compose at least two independent OCI entries at sibling
   destinations. Codex MUST read both; a second session MUST reuse both with zero
   registry, extraction, copy, baseline, or publication work.
3. **Mixed source:** compose at least two depth-2 Git and two OCI entries. OMP
   MUST read all four, work from a nested directory, and report ordered
   provenance and composition identity. Reject an overlap before network access.
   Warm only one component, then prove the cold components build independently
   and atomic visibility waits for every entry.
4. **Editable OCI:** run a bug-fix evaluation with `access: "editable"`, mutate
   an OCI file, add a binary, delete another path, change executable mode, and
   retarget a symlink. Manifest comparison MUST report the exact final state;
   continuation MUST preserve it; cache and sibling sessions MUST remain
   unchanged.
5. **Editable mixed composition:** mutate Git, OCI, and outer paths in one turn.
   Prove ownership, deduplication, exclusion, binary/mode/link semantics, and
   final-tree equality without Git status/index/commit dependence.
6. **Git matrix:** cover default/branch/tag/merge, depth 2, several entries,
   repeated identity at distinct destinations, recent offline history, cache
   singleflight, and zero source-byte work on exact hit.
7. **Atomicity and access:** delay/fail the last component and observe no partial
   Files/harness/workspace visibility. Prove read-only mutation denial, shared
   immutable inodes, editable independent inodes, writable outer assets, and
   pre-network input/asset collision rejection for Git and OCI destinations.
8. **Lifecycle:** cover continuation, restart, cancellation during each
   acquisition kind and composition wait, expiry, authorized persistence,
   explicit deletion, cleanup retry, corrupt evidence, and no rematerialization.
9. **Failure/security:** cover malformed/obsolete descriptors, 0/129 sources,
   root/overlap paths, per-source and aggregate limits, unsafe links/types,
   digest mismatch, depth refusal, provider failure, reused-session injection,
   and absence of Git/OCI/provider fallback or secret leakage.
10. **Stock compatibility:** replay requests without workspace metadata and
    compare status, stream ordering, root-Git Files/checkpoint behavior,
    continuation, cancellation, and provider route with Phase 1 fixtures.

Reports MUST retain only sanitized assertions, image/source digests, measured
resource values, and component/composition counters. They MUST NOT retain
credentials, private origins, provider traffic, internal paths, or volume
contents.

### Phase 10: Publish the digest-pinned AllAgents Gateway release

**Outcome:** a clean operator can deploy the exact tested downstream image and
reproduce the Git/OCI/mixed contract.

Work:

1. Review the downstream diff from the recorded upstream fork point, including
   license/attribution, renamed distribution surfaces, selective upstream
   changes, request/session binding, component caches, atomic composition,
   manifests, lifecycle, provider wiring, E2E, and release automation.
2. Run pinned upstream UHP conformance without exclusions and all focused
   downstream gates against one image candidate.
3. Run Phase 9 against that exact candidate digest.
4. Build `linux/amd64` from pinned inputs, attach standard SBOM and provenance,
   and publish
   `ghcr.io/allagentsdev/allagents-gateway:<upstream-tag>-allagents.<revision>`.
5. Read back and deploy by manifest digest, for example
   `ghcr.io/allagentsdev/allagents-gateway:v0.25.4-allagents.1@sha256:<digest>`,
   under service name `allagents-gateway`.
6. Verify fresh-volume and same-volume restart with both harnesses, Git, multiple
   OCI, mixed composition, cache reuse, editable mutation, continuation,
   cancellation, cleanup, manifests, and stock requests.
7. Record upstream tag/commit and fork point, downstream commit, license/notices,
   UHP and harness versions, base/package pins, Git/OCI/manifest/materializer
   policy revisions, image digest, fixtures, SBOM, provenance, and E2E reports.
8. Block release on any old downstream name in a public distribution surface,
   missing attribution, obsolete accepted schema, partial composition exposure,
   cache mutation, incorrect editable isolation, Git-based workspace evaluation,
   continuation source traffic, credential leak, stock regression, or unpinned
   input.

Only after downstream evidence exists MAY maintainers propose generic seams
upstream. Upstream issue, UEP, acceptance, merge, and release timing remain
outside the downstream critical path.

## Failure contract

Workspace failures MUST use bounded stable detail codes under the existing UHP
error shape. Exact HTTP mapping follows pinned upstream conventions.

| Condition | Required behavior and timing |
|---|---|
| Invalid/obsolete shape, count, field, URL, digest, destination, overlap, or cwd syntax | Reject before cache lookup, network, session workspace write, or component claim |
| Input/generated/reserved-path collision at or below any destination | Reject before network for Git and OCI and for both access modes; outer paths remain valid |
| Unauthorized `persistent` retention | Reject before cache lookup or network |
| Workspace metadata on reused session | Reject without changing binding, checkpoint, or TTL |
| Git ref missing, ambiguous, non-commit, or moved | Fail that component; no alternate ref or source |
| Server cannot satisfy depth-2 Git fetch | Fail that component; no deepen, full clone, history stripping, or OCI fallback |
| Submodule or LFS-backed content | Fail Git validation; no helper execution |
| OCI catalog, manifest, media, or digest mismatch | Fail that component without revealing catalog origin |
| Invalid canonical OCI source manifest | Fail before any layer request |
| OCI layer digest, whiteout, path, link, type, sparse, ratio, or final-manifest mismatch | Fail extraction; no publication or Git fallback |
| Per-source limit exceeded | Stop that component, clean staging, and fail the composition |
| Request aggregate limit/capacity exceeded | Cancel/detach request-local work, preserve valid shared work, attach none |
| One component fails after siblings succeed | Publish no composition attachment; release request-local references; retain only independently valid shared cache entries |
| Cancellation/timeout during component or composition work | Stop unneeded descendants, detach waiter, clean private staging, expose no partial roots |
| Mount/copy/atomic handoff failure | Reverse-unwind all roots; session never becomes ready |
| Missing/corrupt attachment, checkpoint, or baseline on continuation | Fail closed; no source access, replacement component, or empty root |
| Read-only mutation attempt or changed final manifest | Filesystem denial/integrity failure; cache and siblings unchanged |
| Manifest collection limit or unsafe traversal | Fail collection/checkpoint; do not publish an incomplete result/baseline |
| Provider failure | Return existing provider error; source/composition/route binding remains unchanged |
| Cleanup failure | Keep session/path unavailable, quarantined, and accounted for idempotent retry |

Failures before attachment-ready MUST expose no component/composition provenance.
Every failure after readiness MUST return the complete stored sanitized
`metadata.workspace` object while excluding internal paths, registry origins,
credentials, raw tool stderr, and private network details.

## Verification matrix

| Gate | Observable evidence |
|---|---|
| Naming/distribution | Repository is `allagentsdev/allagents-gateway`, image is `ghcr.io/allagentsdev/allagents-gateway`, service is `allagents-gateway`, and public product text says AllAgents Gateway |
| Upstream relationship | `HarnessRouter/harnessrouter`, fork point, license, notices, attribution, and selective-intake procedure are recorded and intact |
| Stock compatibility | Requests without `metadata.workspace` match pinned root-Git hydrate/checkpoint/Files, stream, continuation, cancellation, and provider behavior |
| Closed ordered schema | `sources` accepts 1..128 Git/OCI/mixed entries; obsolete singular/bundle forms and unknown fields fail |
| Pre-network ownership | Root/equal/ancestor destinations and all input/asset/reserved collisions fail with zero source/cache/component activity |
| Component semantics | Every entry owns exactly one non-root tree; OCI never supplies a runtime or multi-root workspace |
| Git depth policy | Default/branch/tag resolve exactly; depth is 2; shallow recent history and merge parents work offline; refusal has no fallback |
| OCI integrity | Direct image and canonical source-manifest digests, pre-layer manifest validation, bounded layers, whiteouts, paths, links, types, and exact final tree verify |
| Per-source/aggregate limits | Bytes, entries, ratio, path, file, inode, time, and output limits fail at the correct component or composition boundary |
| Independent singleflight | Identical components publish once even across different compositions; unrelated entries proceed independently |
| Composition identity | Ordered exact component identities plus destinations determine the ID without copying bytes |
| Atomic composition | Late failure/cancellation exposes no subset to Files, checkpoint, provider, or harness; success reveals all roots together |
| Git cache reuse | Exact hit has zero pack acquisition, checkout, tree copy, manifest recomputation, or publication |
| OCI cache reuse | Exact hit has zero registry request, extraction, tree copy, manifest recomputation, or publication |
| Read-only sharing | Matching sessions bind the same immutable component inodes with enforced flags/no aliases; outer paths remain private and writable |
| Editable isolation | Git and OCI copies/reflinks share no mutable inode; mutations survive continuation and cannot affect cache/siblings |
| Canonical baselines | Every component and outer workspace have persisted canonical path/type/digest/mode/link manifests |
| Manifest final diff | Add/modify/delete/mode/symlink/binary changes across outer, Git, and Git-free OCI roots reflect final-tree equality independent of Git state |
| Exclusions | `.git`, credentials, caches, runner state, attachment evidence, checkpoint metadata, and component paths never appear as reported changes |
| Checkpoint | Outer archive contains no source bytes; editable roots persist separately; read-only roots reattach by exact identity |
| Continuation | Exact composition/access/cwd/provenance/baselines and editable mutations restore with zero source traffic or fallback |
| Cancellation/restart | Every claim/publication/composition/attachment/checkpoint/cleanup transition reconciles or fails closed |
| Cleanup | Expiry/deletion is unavailable-first, mount-aware, confined, idempotent, reference-safe, and quarantine-preserving |
| Multiple OCI E2E | Two independent OCI entries compose, execute, and reuse independently in a second session |
| Mixed E2E | Git and OCI compose atomically; partial cache warmth builds only missing components; both harnesses consume the result |
| Editable OCI E2E | Bug-fix evaluation mutates OCI content and manifest comparison reports exact persistent final changes |
| Provider boundary | Codex Responses and OMP Chat Completions use fixed brokered routes with no caller override, fallback, or retained secrets |
| Release | Candidate digest, GHCR image, deployed service, SBOM, provenance, pins, UHP conformance, and Promptfoo report all identify the same build |

## Definition of done

1. All public downstream repository, image, service, and product names use
   AllAgents Gateway. `HarnessRouter/harnessrouter` remains the attributed
   upstream with its recorded fork point, license, notices, and selective-intake
   process.
2. Requests without `metadata.workspace` remain stock-compatible and are the
   only requests permitted to use stock root-Git change collection and
   checkpoint correctness.
3. The first-turn-only closed contract requires `access` and an ordered
   `sources` array of 1–128 independent `git`/`oci` entries, permits mixed and
   repeated identities at distinct destinations, and accepts no obsolete alias.
4. Every source has one required non-root pairwise-non-overlapping destination.
   All source ownership and input/asset/reserved collisions fail before network,
   cache lookup, claims, or workspace writes.
5. Git components use canonical public HTTPS, exact advertised commit resolution,
   mandatory depth 2, useful bounded offline history, no submodule/LFS helpers,
   and no deepening/full-clone/source fallback.
6. OCI components use an operator catalog, direct image manifest digest, direct
   canonical source manifest digest, pre-layer relative-tree validation, bounded
   secure extraction, exact final-tree verification, and no Git fallback. Each
   OCI image is one source-tree transport/cache unit, never a runtime or bundle.
7. Per-source and aggregate bounds are enforced for all acquisition kinds and at
   composition time.
8. Components cache and singleflight independently. The composition identity
   references ordered exact component identities and destinations. A composition
   is atomically visible only after every component and attachment verifies.
9. `read_only` Git and OCI roots bind immutable cached bytes. `editable` Git and
   OCI roots use inode-independent private writable copies/reflinks. Bug-fix
   evaluation uses editable mode. Cached publications never mutate.
10. Every component publishes a canonical baseline keyed by normalized relative
    path with type, content digest, executable/mode semantics, and symlink target.
    Every workspace-backed session persists an equivalent outer baseline.
11. Final collection/evaluation compares source and outer filesystem manifests,
    detects add/modify/delete/mode/symlink/binary changes, treats final-tree
    equality as authoritative, and does not rely on root/nested Git state or
    rename detection.
12. `.git`, runner-owned state, credentials, caches, attachment evidence, and
    checkpoint metadata are excluded from reported changes. OCI roots work with
    no Git metadata.
13. The private outer workspace remains writable. Inputs/assets outside source
    destinations work; paths at or below destinations fail before network.
14. Checkpoint and continuation are mount-aware. Outer archives exclude all
    source bytes, editable roots persist separately, read-only roots reattach by
    exact identity, baselines remain stable, and continuation performs no source
    traffic.
15. Direct Promptfoo against the tested image proves multiple OCI, mixed Git/OCI,
    partial cache warmth, component and composition singleflight, atomic
    visibility, editable OCI mutation/evaluation, manifest final diffs, both
    harnesses, lifecycle failures, security boundaries, and stock compatibility.
16. A second exact-identity session proves zero Git source-byte work and zero OCI
    registry/extraction work while reusing immutable publications; editable
    reuse proves independent mutation.
17. Codex and OMP use fixed adapters through the existing external provider
    gateway with brokered short-lived credentials, no caller override, and no
    fallback.
18. The same digest-pinned `ghcr.io/allagentsdev/allagents-gateway` candidate
    passes UHP conformance, focused integration, large/multiple/mixed Promptfoo
    E2E, restart deployment, secret scans, SBOM, and provenance gates under
    service name `allagents-gateway`.
19. No upstream issue, UEP, acceptance, merge, or release blocks downstream
    implementation or publication.
