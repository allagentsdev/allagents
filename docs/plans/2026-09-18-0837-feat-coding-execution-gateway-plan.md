---
title: "Prepared Workspace Snapshots - Cross-Repository Implementation Plan"
date: 2026-09-18
updated: 2026-09-28
type: feat
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
---

# Prepared Workspace Snapshots - Cross-Repository Implementation Plan

## Goal

Deliver reproducible large coding workspaces through two narrow components:

1. **AllAgents Workspace Builder** prepares Git/OCI inputs, preserves required Git histories, publishes one immutable OCI workspace snapshot, and returns its direct manifest descriptor.
2. **AllAgents Gateway** consumes only that exact descriptor, authorizes and materializes a private writable session directory, runs the existing HarnessRouter/UHP lifecycle, and returns exact filesystem deltas.

The execution gateway MUST NOT resolve Git refs, receive source credentials, compose repository arrays, or call the builder during task execution. The cross-repository contract is the versioned OCI artifact. A new snapshot session is runnable only after descriptor authorization, artifact verification, private materialization, working-directory validation, and baseline-journal creation complete.

Requests without the vendor snapshot extension remain on characterized stock HarnessRouter behavior.

## Architecture decision

The authoritative decision is [ADR 0002](../decisions/0002-adopt-uhp-through-harnessrouter.md). The evidence is [Prebuilt immutable workspace snapshots at the HarnessRouter boundary](../research/allagents-gateway-snapshot-boundary.md).

Two repositories are intentional:

| Repository | Owns | Must not own |
|---|---|---|
| `allagentsdev/allagents-workspace-builder` | Git/OCI acquisition, credentials, source policy, composition, provenance, canonical baseline, OCI publication, build retention | UHP, harness/provider routing, session continuation, produced-file ACK, response lifecycle |
| `allagentsdev/allagents-gateway` | UHP, descriptor admission, authorization, immutable cache, private session tree, manifest journal, Files/artifacts, checkpoint, continuation, cancellation, deletion | Git refs, source credentials, caller-selected registries, repository arrays, composition jobs |

This is not a mandate for two always-on services. V1 builder delivery is a CLI/library suitable for CI or a job worker. A service wrapper is optional and must preserve the same artifact contract.

The upstream change is tracked in [HarnessRouter issue #304](https://github.com/HarnessRouter/harnessrouter/issues/304). The proposal covers an immutable workspace initializer, an explicit-cursor non-Git journal, and recoverable terminal finalization; it does not upstream AllAgents source semantics or require a UHP change.

## Repository and branch prerequisites

### AllAgents Gateway

`allagentsdev/allagents-gateway` already exists as the renamed HarnessRouter fork. It preserves the fork relationship, full history, Apache-2.0 `LICENSE`, `NOTICE`, attribution, settings, and redirects. `HarnessRouter/harnessrouter` remains the upstream parent.

Before implementation:

1. Fetch current downstream `main` and upstream.
2. Record the accepted characterized baseline `5f82db1d1f13ea25b8ed0893c38b5b7d2e3e57e3` and current inspected point `8f7868ccb2c97d1f611acf11e7cad0357a43064e`.
3. Create `feat/workspace-snapshots` from current downstream `main`.
4. Retire the unused `feat/workspace-composition` branch after confirming it contains no unique implementation. Do not carry runtime-composition scaffolding, aliases, or dead request fields.
5. Keep `origin` on `allagentsdev/allagents-gateway` and `upstream` on `HarnessRouter/harnessrouter`.

### AllAgents Workspace Builder

Create public repository `allagentsdev/allagents-workspace-builder` with Apache-2.0 licensing, protected `main`, required checks, immutable release tags, GHCR package access, and a security policy. Start implementation on `feat/workspace-snapshot-v1`.

The repository MUST produce one pinned CLI binary and one reusable package from the same code. Prefer a small static implementation suitable for untrusted archive handling; pin the language toolchain and every dependency in the initial bootstrap. The CLI surface is:

```text
allagents-workspace-builder build \
  --context /run/secrets/build-context.v1.json \
  --spec workspace-build.v1.json \
  --output descriptor.json
```

A later queue/API wrapper invokes the same package. It does not define a second artifact format or source-resolution path.

### Shared fixtures, not shared source

Each repository owns local focused fixtures. Cross-repository E2E uses published fixture snapshots pinned by digest. Do not share code through Git submodules, relative checkouts, unpublished packages, or branch references. If schema generation is added, publish a versioned schema artifact and check generated outputs in each consumer.

Required fixture classes:

- one root Git repository with complete merge history;
- two independent nested Git repositories;
- one Git-free OCI tree;
- composition with whiteouts, empty directories, symlinks, executable files, and safe hardlinks;
- malformed manifests, configs, layers, links, paths, types, sparse files, compression bombs, metadata bombs, and digest mismatches;
- source trees colliding with versioned runner-reserved paths; and
- a snapshot large enough to exercise cache watermarks, quota rejection, reflink, and full-copy fallback.

## Secrets and operator-owned inputs

No implementation or fixture requires production credentials. Local authenticated registries, local Git servers, and mocked provider transport prove behavior.

Operator-owned values remain outside source and tests:

- source and snapshot registry credentials;
- Git credentials and network allowlists;
- snapshot authorization-catalog entries;
- UHP caller credentials;
- provider gateway URL/key;
- GHCR publish rights; and
- production deployment, object-store, quota, and telemetry configuration.

Secrets MUST enter through each repository's secret mechanism. They MUST NOT appear in build specs, OCI config/provenance, layers, logs, errors, response metadata, checkpoints, SBOMs, build arguments, or harness environments.

All credentialed Git and OCI fetchers share one minimum transport policy: authorize scheme, host, port, and every resolved IP before connection; reject loopback, link-local, private, Unix-socket, rebinding, and other non-allowlisted targets; cap and reauthorize redirects; never forward authorization, cookies, or client certificates across origins; require TLS; use repository-scoped short-lived credentials; and redact redirect/auth diagnostics.

## Characterized HarnessRouter seams

Implementation starts from these existing seams rather than a parallel executor:

- gateway request/session resolution and `CreateResponseBody.metadata` extension handling;
- gateway `_resp_execute` and `_hydrate`, where initialization must gate input and harness start;
- runner `_ws`, `/hydrate`, `/checkpoint`, and `/turn`;
- runner `_produced_list`, `_produced_ack`, and the internal `/produced` routes;
- gateway `_collect_produced`, which captures artifacts before ACK;
- `BACKING.workspace`, `RunnerWorkspaceFiles`, and `CheckpointWorkspaceFiles`;
- durable `HarnessSession` plus separate checkpoint, artifact, response, and control records;
- existing cancellation, explicit session deletion, live-workspace reaping, graph/blob backing, provider routing, SSE translation, and harness adapters.

The red characterization MUST prove current limitations before code changes:

1. a root repository is mutated by `_git_ensure`;
2. an embedded repository's internal file changes are not emitted exactly by root Git;
3. a deletion is absent from stock produced-file artifacts;
4. `/hydrate` accepts only the internal checkpoint shape and is not a supported OCI import; and
5. a request without the vendor extension retains current UHP behavior.

## Workspace Builder contract

### Build request v1

The builder accepts a closed versioned build spec plus a trusted out-of-band `BuildContext`. This is an AllAgents preparation contract, not UHP. `BuildContext` contains authenticated `principal`, `product_domain`, and operator-selected `policy_id`; it is supplied by the embedding job/CLI environment, never the build spec. V1 CLI execution is operator-trusted. A later service wrapper MUST authenticate its caller and map it to the same `BuildContext` before invoking the package.

```json
{
  "version": 1,
  "working_directory": "services/api",
  "sources": [
    {
      "kind": "git",
      "url": "https://github.com/example/api.git",
      "ref": "refs/heads/main",
      "history": {"mode": "full"},
      "destination": "services/api"
    },
    {
      "kind": "oci",
      "source_name": "compiler-tree",
      "descriptor": {
        "media_type": "application/vnd.oci.image.manifest.v1+json",
        "digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        "size": 123456
      },
      "destination": "vendor/compiler"
    }
  ]
}
```

Rules:

- `version` is exactly `1`; all objects are closed.
- `sources` contains 1 through 128 ordered entries.
- `destination` is NFC-normalized relative POSIX. `.` is allowed only when it is the sole source. Otherwise destinations are non-root and pairwise non-overlapping.
- `working_directory` is relative to the final snapshot root, defaults to `.`, and must resolve without symlink escape to a real directory.
- Git URLs are canonical HTTPS identities. Userinfo, query, fragment, local paths, alternate transports, and caller Git options are rejected.
- Omitted Git `ref` selects the advertised default. A supplied ref resolves only through advertised full-ref or unambiguous branch/tag semantics.
- Omitted `history` means `{"mode":"full"}`. Shallow mode is `{"mode":"shallow","depth":N}` with integer `N` from 1 through 1,000,000. Full means complete ancestry reachable from the selected commit, not unrelated refs/tags.
- `source_name` selects an operator configuration for registry origin, credentials, TLS, redirects, media types, and trust. Callers do not supply these.
- Unknown kinds, commands, environment, credentials, host paths, runtime images, provider routes, resource-limit overrides, and tags/indexes fail before network access.
- Source and destination authorization is evaluated against `BuildContext` before credentials or network are used.

### Git preparation

For each Git source:

1. resolve allowed credentials and egress policy from `BuildContext`, outside the request;
2. run Git without a shell under sanitized environment/config;
3. disable interactive prompts, hooks, filters, credential persistence, submodule recursion, LFS hydration, alternate helpers, inherited proxies except explicit policy, and file/local transports; enforce the shared per-connection DNS/redirect/credential policy;
4. resolve the advertised selector to one exact commit;
5. fetch complete reachable ancestry or the exact requested shallow boundary under byte/object/time/process/output limits;
6. export a detached self-contained repository with no alternates, transient locks, credential-bearing remotes, or acquisition-only state;
7. reject gitlinks, unhydrated LFS pointers when policy requires real content, unsafe symlinks, and reserved-path collisions;
8. verify offline `log`, parent traversal, blame/diff across the selected history, and bisect prerequisites for full history; and
9. record requested selector, exact commit, history mode, normalized URL identity, destination, and verification policy in provenance.

A source failure never chooses a different ref, deepens or shallows history, fetches an arbitrary object ID, or falls back to OCI.

### OCI input preparation

OCI source inputs are direct descriptors admitted by `source_name` and `BuildContext`. Apply the shared per-connection transport policy plus descriptor, distribution, and layer rules equivalent to the final snapshot. Tags, indexes, caller registries, ambiguous media types, traversal, links, devices, FIFOs, sockets, capabilities, ACLs, xattrs, set-ID bits, unsupported sparse files, and unbounded metadata fail closed.

OCI inputs may be Git-free. The builder never invents Git metadata.

### Composition and reserved paths

Build in private staging. Validate all destination ownership and reserved-path conflicts before network access. Apply sources in request order only for deterministic construction; overlap is invalid, so order never grants overwrite precedence.

Reserved-path schema 1 is the root `.harness` path and every descendant, with path comparison after UTF-8/NFC/POSIX normalization. Builder and gateway share golden accept/reject fixtures but independent implementations. Reject an entry, whiteout, hardlink, symlink path or target alias, or type transition that occupies `.harness` or a descendant. Unknown schema versions fail before extraction. Root instruction files such as `AGENTS.md` are not reserved: snapshot mode preserves their content and merges the runner-managed block before the initial cursor is established.

After composition:

- normalize ownership, timestamps where format policy requires them, modes, and metadata;
- walk without following links;
- validate the default working directory;
- produce the canonical visible-tree manifest excluding `.git` and `.harness`;
- produce digest-covered provenance;
- construct deterministic OCI layers/config/manifest; and
- publish blobs/config/layers before the direct image manifest.

A failed or canceled publication never returns a result. Staging is cleaned or quarantined under bounded age/bytes/inodes. Config includes `available_until`, backed by an operator-enforced registry retention lease. Automatic garbage collection MUST NOT remove the manifest or referenced blobs before that timestamp. The lease duration covers expected scheduling delay plus gateway initialization deadline, maximum session TTL, and safety margin.

## Snapshot artifact v1

The final artifact contract is fixed by ADR 0002:

- OCI image manifest media type `application/vnd.oci.image.manifest.v1+json`;
- `artifactType` `application/vnd.allagents.workspace-snapshot.v1`;
- config media type `application/vnd.allagents.workspace-snapshot.config.v1+json`;
- provenance media type `application/vnd.allagents.workspace-provenance.v1+json`;
- canonical visible-tree media type `application/vnd.allagents.workspace-manifest.v1+json`;
- direct execution descriptor `{media_type,digest,size}`; and
- deterministic gzip layers only, media type `application/vnd.oci.image.layer.v1.tar+gzip`, applied in order to an empty root. V1 rejects uncompressed, zstd, and nondistributable layers.

Config contains exactly:

```text
{
  version: 1,
  working_directory: string,
  workspace_manifest: OCI descriptor,
  provenance: OCI descriptor,
  builder: {name: string, version: string, policy: string},
  reserved_paths_schema: 1,
  available_until: RFC3339 timestamp
}
```

Required provenance is RFC 8785 canonical JSON with media type `application/vnd.allagents.workspace-provenance.v1+json`. It is a closed `{version:1,sources:[...]}` object. A Git record contains only `kind`, normalized `url`, optional `requested_ref`, exact `resolved_commit`, closed full-or-shallow `history`, and `destination`. An OCI record contains only `kind`, public logical `source_name`, exact direct `descriptor`, and `destination`. Source order is build order. Credentials, registry coordinates, headers, helpers, and host paths are forbidden. Builder and policy identity remain in config.

The canonical visible-tree entry forms, sorting, hashing, link confinement, mode normalization, `.git` exclusion, and runner-path exclusion match ADR 0002 exactly. Builder and gateway MUST use independent implementations against the same golden corpus; a shared implementation would hide interoperability bugs.

The builder outputs:

```json
{
  "version": 1,
  "descriptor": {
    "media_type": "application/vnd.oci.image.manifest.v1+json",
    "digest": "sha256:...",
    "size": 123456
  },
  "workspace_manifest_digest": "sha256:...",
  "provenance_digest": "sha256:...",
  "working_directory": "services/api",
  "available_until": "2026-10-29T00:00:00Z"
}
```

This versioned builder result contains no credentials or private registry transport details. The caller supplies only nested `descriptor` to the gateway and retains the complete result as its baseline/provenance/retention record.

## Gateway public contract

### Request

Only the first request creating a new session may contain:

```text
metadata.allagents_workspace_snapshot = {
  version: 1,
  descriptor: {
    media_type: "application/vnd.oci.image.manifest.v1+json",
    digest: "sha256:<64 lowercase hex>",
    size: positive integer
  }
}
```

All objects are closed. No alias for the old `metadata.workspace`, `sources`, `access`, `snapshot_name`, `image_manifest_digest`, or `source_manifest_digest` shape is retained.

Request-decidable validation finishes before catalog, cache, registry, workspace, or lifecycle mutation. Continuation/replay/reused-session injection fails before hydrate. The media type is exact. Digest is SHA-256 lowercase. Size is bounded by manifest maximum.

### Authorization

V1 server configuration maps each authenticated product domain to exactly one trusted snapshot repository and one catalog. Zero or multiple mappings fail deployment preflight. Catalog lookup returns exactly one immutable `catalog_entry_id` and version binding the descriptor and digest-covered `available_until`; ambiguity fails before registry traffic.

Authorization key is the exact `(principal, domain, repository_id, catalog_entry_id, media_type, digest, size)` tuple plus current policy. Authorization occurs before fetch, cache attachment, restart completion, and exact-digest reacquisition. Unauthorized and unknown both return `404 workspace_snapshot_unknown`. A cache hit is never authorization.

### Response

After `ready`, return:

```text
metadata.allagents_workspace_snapshot = {
  version: 1,
  descriptor: {media_type, digest, size},
  snapshot_manifest_digest: "sha256:<64 lowercase hex>",
  ready_manifest_digest: "sha256:<64 lowercase hex>",
  provenance_digest: "sha256:<64 lowercase hex>",
  initialization_changes_file_id: string,
  working_directory: string,
  available_until: RFC3339 timestamp,
  expires_at: RFC3339 timestamp
}
```

Terminal streaming, retrieval, replay, and later workspace failures use the stored sanitized object. Pre-ready failures omit it. Catalog/repository names, policy revisions, credentials, private cache keys, local paths, reference IDs, builder jobs, and live filesystem facts remain private.

Advertise vendor capability `allagents_workspace_snapshot_v1: true`. It means request schema V1 and snapshot artifact/config/provenance/manifest V1 are all supported. Absence or false means unsupported. Do not modify UHP conformance claims.

## Gateway durable model

### Snapshot binding

Extend `HarnessSession` with one logical binding reference. Store large manifests in blob storage, not graph properties.

```text
WorkspaceSnapshotBinding = {
  binding_id,
  state: pending | ready | failed | deleting,
  descriptor: {media_type, digest, size},
  snapshot_key,
  repository_id,
  catalog_entry_id,
  catalog_entry_version,
  signature_policy_id,
  signature_evidence_digest,
  authorization_audit_ref,
  minimum_reader_version,
  initializer_schema,
  journal_schema,
  initialization_deadline,
  ready_at?,
  expires_at?,
  available_until?,
  snapshot_manifest_digest?,
  ready_manifest_digest?,
  provenance_digest?,
  initialization_changes_file_id?,
  working_directory?,
  cursor_blob_digest?,
  failure_code?
}
```

`expires_at` is absent until the `ready` transition and is computed from `ready_at`. Polling and continuation never change it.

`WorkspaceSnapshotReference` is a durable record keyed by `(binding_id, snapshot_key)` with `provisional | active | released`. Creation, activation, and release use compare-and-set. A still-running pending attempt retains its provisional claim across internal restart reconciliation. Every pre-ready response failure makes the binding terminal `failed` and releases the claim; a caller retry creates a new binding. Counters are derived, never authoritative.

Do not persist local cache paths, inode/device identities, reflink facts, attachment flags, staging paths, lock owners, registry credentials, or process IDs.

### Turn finalization record

Add a recoverable record keyed by `response_id`:

```text
WorkspaceTurnCommit = {
  response_id,
  state: preparing | durable | acknowledged | committed | aborted,
  base_cursor_digest,
  next_cursor_digest?,
  change_artifact_id?,
  file_artifact_ids: [],
  checkpoint_digest?,
  collection_token?,
  collection_fingerprint?
```

All artifact IDs and blob keys are deterministic from response identity plus content identity. Retry verifies and reuses existing durable objects. `acknowledged` means the runner accepted the explicit base/next cursor token, while the gateway cursor remains authoritative. `committed` is reached only when response artifacts, checkpoint, cursor pointers, and terminal state publish together under the existing response/session control lease.

## Snapshot admission, cache, and private materialization

### Admission

Fetch only from the binding's persisted `repository_id` by direct digest under the shared per-connection transport policy. Never search another repository or follow caller-selected origins or tags. Verify declared size and response digest before parsing. Reject indexes/lists. Verify manifest/config/provenance/tree/layer media types, descriptor sizes, digests, supported `reserved_paths_schema`, and catalog/config `available_until` equality before use.

If retention is expired or cannot cover initialization deadline plus maximum session TTL plus safety margin, return nonretryable `422 workspace_snapshot_retention_invalid`. If an authorized manifest is missing before `available_until`, return `503 workspace_snapshot_unavailable` and alert on the broken retention lease. Never search another repository.

Apply only gzip OCI layer changesets in order, including whiteouts and opaque directories, through rooted no-follow operations; do not shell out to `tar`. Reject every layer or final-tree path/link/whiteout/type transition at `.harness` or below, including content omitted from the public manifest. Normalize or reject ownership/mode/xattr/ACL/capability metadata. Compute the public snapshot manifest plus a private full-tree seal covering `.git` before publication.

### Immutable cache

Cache key:

```text
sha256(canonical({descriptor, materializer_schema}))
```

Destination, principal, session, harness, provider, expiry, policy revision, and working directory do not fragment the verified byte cache. Authorization remains separate.

An exact-key miss singleflights. Publication sequence is staging -> full verification -> immutable generation -> complete marker -> available. Cache roots and generations are owned by a gateway/materializer identity no harness/session UID can assume, are non-writable, and are non-searchable from the runner namespace. Failed or uncertain staging is unavailable and quarantined.

Clone/reflink reads use trusted directory file descriptors, rooted no-follow operations, and an eviction/clone lease. Verify the private full-tree seal immediately before and after cloning. Any unexpected metadata/content mutation quarantines the generation and fails closed.

Global controls are mandatory: maximum cache/staging bytes and inodes; high/low watermarks; eviction only among complete unreferenced generations; staging/quarantine age and size; bounded waiters/builds; metrics; and reconciliation from durable reference records. A malicious session test MUST prove a guessed cache path cannot be searched, read, or mutated.

### Private writable tree

Every snapshot session gets an ordinary private writable directory:

1. prefer same-filesystem per-file reflink with independently created directory entries/inodes;
2. fall back to full private copy;
3. never hardlink regular files to cache, expose a writable cache alias, or symlink the workspace to cache;
4. walk no-follow and revalidate source generation before cloning;
5. apply hard runtime byte/inode quotas; and
6. validate the digest-covered working directory beneath the private root.

Probe production filesystem behavior before implementation is considered deployable. The integration suite forces both reflink and copy paths. OverlayFS, bind-mounted source roots, per-source read-only/editable modes, and delta checkpoints are out of V1.

### Ready transition

New-session sequence:

1. run stock auth, UHP validation, idempotency, and session selection;
2. parse/validate the closed extension and compatible minimum-reader routing;
3. resolve one repository/catalog entry and authorize the exact tuple;
4. persist pending binding, private authorization subject, and provisional reference before fetch;
5. claim/reuse/build immutable generation;
6. reauthorize current policy;
7. materialize and full-seal-check the private tree;
8. apply UHP inputs and deterministic runner instruction/control preparation;
9. compare snapshot manifest with the ready tree; durably capture changed regular files plus `workspace-initialization-changes-<session_id>.json`;
10. store the ready manifest as authoritative initial cursor and validate working directory;
11. activate reference and transition binding to `ready` with snapshot/ready digests, initialization artifact, `ready_at`, and `expires_at`; and
12. start the stored harness/provider path.

The initialization artifact uses `application/vnd.allagents.workspace-changes.v1+json` and the same canonical schema as turn deltas. It is emitted even when empty. Promptfoo applies it to builder snapshot bytes before response deltas. No Files, checkpoint, provider, harness, or response success path observes the workspace before step 11. A pre-ready failure is terminal for that binding, releases provisional state once, and leaves no runnable tree.

## Manifest journal and change artifacts

Snapshot sessions select `manifest-v1`; stock sessions keep root Git. The gateway-owned cursor blob is the sole durable journal authority. Gateway `/produced` sends the explicit base cursor blob/digest to the runner; the runner returns changes, next canonical cursor, and a collection token without mutating durable state. `/produced/ack` idempotently confirms `(base,next,token)` but cannot supersede the gateway cursor.

Terminal collection holds one exclusive workspace mutation lease. It stops and proves absence of descendants and blocks Files writes, new turns, cancellation cleanup, deletion cleanup, and every other writer until finalization:

1. send/load the acknowledged base cursor;
2. compute the final canonical manifest under output byte/inode/time limits;
3. derive add/modify/delete operations;
4. open every added/modified regular file with rooted `openat`/no-follow semantics, hash while streaming, and require type/size/digest to equal its `after` state;
5. durably store file artifacts and one canonical `workspace-changes-<response_id>.json`;
6. create the exact snapshot-mode checkpoint and verify its visible manifest equals the next cursor;
7. durably store the next cursor;
8. call idempotent ACK with base, next, and token; and
9. compare-and-set artifacts, checkpoint, authoritative cursor, and terminal response to committed.

Change artifact media type is `application/vnd.allagents.workspace-changes.v1+json`. Schema and ordering match ADR 0002. `file_id` exists exactly for added/modified regular files after streamed bytes match their manifest state.

`WorkspaceTurnCommit` resumes crashes without rerunning the harness. A crash before step 9 leaves the old gateway cursor authoritative even when ACK ran; retry supplies the old base and reproduces the transaction. Terminal response visibility occurs only at step 9.

Promptfoo applies ordered deltas to the exact builder baseline. Test reconstruction against the baseline snapshot; do not assert that deltas alone contain the original tree.

## Checkpoint, continuation, cancellation, and deletion

### Exact snapshot-mode checkpoint

Implement this exact snapshot-mode checkpoint before integrating turn finalization:

- skip `_git_ensure` and any root-Git commit;
- archive the complete normal private directory, including nested/root `.git` histories;
- reject any snapshot-origin `.harness` content before ready;
- exclude from checkpoints only `.harness/tmp/**`, `.harness/home/.codex/auth.json`, `.harness/home/.omp/agent/auth.json`, `.harness/home/.omp/agent/models.json`, and `.harness/home/.omp/agent/models.yml`;
- retain every other `.harness` path required for conversation, skills, plugins, and resume;
- stream through bounded disk rather than memory;
- store checksum/size; and
- reconstruct the checkpoint's visible manifest and require equality with the next cursor before publishing its pointer.

Matching uses NFC-normalized POSIX paths after no-follow traversal. Directories named `node_modules`, `.venv`, `venv`, or other stock scratch names remain checkpointed when declared snapshot or session content. Any future exclusion changes require a checkpoint-schema revision and mixed-version reader gate.

### Continuation

A continuation:

1. resolves the original session and enforces current principal/session ownership;
2. rejects supplied snapshot metadata;
3. rejects at or after `expires_at` before restore;
4. restores the exact checkpoint and cursor under quotas;
5. verifies binding, checkpoint checksum, journal schema, reserved-path schema, and working directory;
6. reacquires an evicted immutable base only by the same authorized direct digest when needed for integrity evidence, never to replace mutable checkpoint state; and
7. starts the stored harness only after the restored workspace is ready.

Missing/corrupt binding, checkpoint, cursor, or identity fails closed. Do not start empty, substitute a newer descriptor, call the builder, or resolve a source.

### Cancellation

Preserve stock idempotent cancel endpoints and terminal `status: "cancelled"`. Stop descendants before final collection/checkpoint. Cancellation before ready releases provisional initialization and omits snapshot metadata. Cancellation after ready runs the same recoverable finalization transaction and retains stored metadata.

### Expiry and deletion

TTL begins at ready. Expiry/delete first atomically makes the session unavailable and stops descendants, then handles `WorkspaceTurnCommit` deterministically:

| Turn state | Deletion action |
|---|---|
| `preparing` | Mark `aborted`, discard only unreferenced staging objects, retain the old checkpoint/cursor as authority, and finalize the response through stock cancellation/deletion semantics. |
| `durable` or `acknowledged` | Finish idempotent ACK/CAS to `committed` from durable evidence; do not rerun the harness. The terminal response may remain retrievable while the session is unavailable. |
| `committed` | Retain response/artifact records per stock policy and proceed with session cleanup. |
| `aborted` | Reconcile/discard unreferenced staging and proceed. |

Only after turn state resolves does deletion remove the private tree with rooted no-follow operations, delete checkpoint/cursor state under retention policy, release `(binding_id,snapshot_key)` once, and tombstone/delete the binding. A turn record is removed only after response state and every referenced/unreferenced blob are reconciled.

Busy or uncertain state stays unavailable, counted, and queued for retry. Restart reconciliation resumes pending initialization/finalization/deletion from durable records and never trusts process-local filesystem facts.

## Stable failure contract

| Detail code | Condition | HTTP | Retryable | Required behavior |
|---|---|---:|:---:|---|
| `workspace_snapshot_invalid_request` | Closed-schema, version, media type, digest, size, first-turn, or continuation violation | 400 | no | Fail before catalog/cache/registry/workspace/lifecycle mutation. |
| `workspace_snapshot_unknown` | Exact descriptor absent from caller's authorized catalog view | 404 | no | Hide cross-principal existence; do not consult cache as authorization. |
| `workspace_snapshot_invalid` | Manifest/config/provenance/layer/path/link/type/signature/final-tree/cwd verification failure | 422 | no | Publish no generation and expose no partial workspace. |
| `workspace_snapshot_retention_invalid` | Catalog/config retention expired or cannot cover initialization deadline + maximum session TTL + safety margin | 422 | no | Fail before cache attachment; caller must publish a new snapshot descriptor. |
| `workspace_snapshot_unavailable` | Registry/DNS/transport, initialization deadline, or authorized manifest missing before `available_until` | 503 | yes | Fail the binding, release its provisional claim, and allow a new request with the same descriptor; never search another repository. |
| `workspace_contract_limit_exceeded` | Fixed format count/byte/path/ratio/metadata/file maximum | 413 | no | Stop bounded work; elapsed time never uses this code. |
| `workspace_capacity_exceeded` | Lower operator disk/inode/quota/worker/concurrency capacity | 503 | yes | Admit no partial generation or private tree. |
| `workspace_initialization_failed` | Verified artifact cannot publish/clone/baseline/transition because of internal failure | 500 | yes | Mark binding failed, clean/quarantine, and release provisional reference safely. |
| `session_expired` | Continuation at or after ready-based expiry | 404 | no | Preserve inherited UHP shape; do not restore or extend TTL. |
| `workspace_restore_invalid` | Binding/checkpoint/cursor/identity missing, corrupt, or inconsistent | 500 | no | Fail closed without empty-root or replacement recovery. |
| `workspace_collection_failed` | Manifest or artifact persistence cannot complete | 500 | yes | Keep previous cursor/checkpoint authoritative; resume transaction. |
| `workspace_checkpoint_failed` | Exact checkpoint cannot persist | 500 | yes | Do not finalize terminal response or advance cursor; resume without rerunning harness. |

Pre-ready failures omit snapshot metadata. Post-ready workspace failures return stored sanitized metadata except inherited `session_expired`. Provider/harness failures retain stock codes. Errors and logs never expose credentials, registry paths, private catalog names, local paths, source content, or raw tool stderr.

For pre-ready retryable failures, retry means a new request/binding with the same descriptor; an idempotent duplicate returns the original failed response. For post-ready collection/checkpoint failures, retry resumes the same `WorkspaceTurnCommit` and never reruns the harness.

## Observability and audit

Use correlation-safe identifiers: request/response/session ID, binding ID, redacted descriptor prefix, snapshot-key prefix, cache outcome, state transition, duration, bounded byte/inode counters, and stable error code. Never log full private URLs, headers, credentials, provenance content, source filenames, file bytes, host paths, or complete digests where organizational policy treats them as sensitive.

Required metrics:

- authorization allow/deny by stable reason;
- pending/ready/failed/deleting transitions and duration;
- registry bytes/time and verification failures;
- cache hit/miss/singleflight wait/build/evict/quarantine;
- reflink/copy selection, bytes, inodes, and duration;
- workspace quota utilization;
- manifest walk/change counts and duration;
- turn-finalization resume/failure stage;
- checkpoint bytes/time/failure;
- reference claim/activation/release/reconciliation; and
- cleanup backlog age and capacity impact.

Audit records identify the exact descriptor, catalog/policy decision reference, builder/provenance digests, gateway/upstream commit, and published image digest without secrets.

## Implementation phases and exit proofs

Every phase changes the named real seam and ends with observable proof. Project-wide suites run only after focused phase work. Source-text assertions and mock forwarding are not proof.

### Phase 0: Bootstrap repositories and characterize stock

**Workspace Builder work**

- Create repository, license/security/CI/release skeleton, pinned toolchain, CLI/library boundary, local registry/Git fixtures, and deterministic golden corpus.
- Record artifact media types and version ownership.

**Gateway work**

- Create `feat/workspace-snapshots`, preserve fork history/license/NOTICE, add upstream remote, and record fork point.
- Capture the red stock limitations and unchanged stock UHP trace.
- Probe the target deployment filesystem for reflink correctness, quota support, path/mode semantics, and full-copy fallback before deeper implementation.
- Link [upstream issue #304](https://github.com/HarnessRouter/harnessrouter/issues/304) in the downstream delta record.

**Exit proof:** both repos have protected reproducible builds; red fixtures prove root-Git mutation/nested-repo/deletion limitations; stock no-extension traces are recorded; production filesystem capability is known rather than assumed.

### Phase 1: Build and publish snapshot v1

**Work**

- Implement closed build spec plus trusted `BuildContext` and pre-network path/ownership authorization.
- Implement full-by-default Git and exact optional shallow acquisition under the shared per-connection fetch policy.
- Implement digest-pinned OCI input admission and secure extraction.
- Implement deterministic composition, exact reserved-path schema, independent canonical manifest/provenance schemas, canonical gzip OCI layers/config/manifest, complete-before-return publication, and digest-covered retention lease.
- Add malicious fixtures and bounded cancellation/restart cleanup.

**Exit proof:** root single-repo, multi-repo, Git-free, full-history, shallow, whiteout, empty-dir, link, executable, and repeated deterministic builds publish expected descriptors. Offline Git operations work at promised history depth. Every malicious fixture fails before descriptor return. Pulling by returned digest reconstructs the exact canonical tree and provenance with no secret material.

### Phase 2: Add gateway contract, authorization, and durable binding

**Work**

- Parse vendor extension in create-response path; reject every obsolete source schema and continuation injection.
- Add literal capability `allagents_workspace_snapshot_v1`, sanitized response metadata, private repository/catalog/signature binding fields, reference records, pending transition, ready-based TTL, minimum-reader routing, and restart reconciliation.
- Implement unique repository/catalog resolution, descriptor authorization, and cache-hit reauthorization.

**Exit proof:** malformed/unknown fields fail `400` with zero cache/network/write activity; unknown/unauthorized both fail `404`; a valid descriptor persists pending identity before fetch; duplicate idempotency shares one binding; continuation replacement fails before hydrate; stock requests remain trace-equivalent.

### Phase 3: Implement admission, immutable cache, and private tree

**Work**

- Fetch from the persisted repository and verify all descriptor/media/signature/provenance/tree/layer/retention identities.
- Apply layers securely; independently reject `.harness` aliases and recompute public manifest plus private full-tree seal.
- Implement inaccessible immutable cache ownership, FD-based clone lease, seal checks, singleflight, watermarks, eviction, quarantine, and reconciliation.
- Implement private reflink clone and forced full-copy fallback; apply inputs/instruction merge, capture the initialization delta, validate cwd, and transition ready only after ready-manifest cursor storage.

**Exit proof:** exact descriptor miss publishes once under concurrency; hits reauthorize; expired/short retention returns `422`, while a promised-but-missing manifest returns `503` without repository search; initialization delta reconstructs the ready tree from builder baseline; failed final verification exposes no Files/provider/harness state; session UIDs cannot search/read/mutate guessed cache paths; malicious reserved paths fail independently; both reflink and copy pass.

### Phase 4: Add exact checkpoint, manifest journal, and recoverable finalization

**Work**

- Implement snapshot-mode checkpoint/hydrate first: no root Git, exact `.harness` policy, complete Git history, checksum, and visible-manifest verification.
- Add `manifest-v1` behind produced routes with explicit gateway-to-runner cursor input while retaining stock root Git.
- Implement streamed file/hash binding and exact add/modify/delete/type/mode/link behavior under the exclusive mutation lease.
- Add `WorkspaceTurnCommit` and integrate artifacts, exact checkpoint, next cursor, ACK, CAS, deletion states, and terminal visibility.

**Exit proof:** independent fixtures produce exact operations regardless of Git state; `.git` and `.harness` never appear; injected failure at every checkpoint/ACK/CAS/deletion stage resumes to one logical artifact/checkpoint/cursor without rerunning; baseline plus deltas reconstructs final state; raced writers cannot make artifact bytes, manifest, and checkpoint disagree.

### Phase 5: Complete continuation and lifecycle

**Work**

- Implement continuation, cancellation, ready-based expiry, state-specific explicit deletion, reference release, and unavailable-first reconciliation.
- Exercise `RunnerWorkspaceFiles` and `CheckpointWorkspaceFiles` against live and restored snapshot sessions.
- Add mixed-version admission fencing and internal minimum-reader routing.

**Exit proof:** mutations and Git history survive turns/restart; corrupt evidence fails closed; cancellation produces one terminal state; polling/continuation do not move expiry; every turn-commit deletion state reconciles without orphaning/publishing inconsistent data; concurrent expiry/delete/restart releases one reference; incompatible replicas reject before hydrate.

### Phase 6: Cross-repository and Promptfoo integration

**Work**

- Build fixture snapshots with the published builder binary, push to an authenticated local registry, authorize exact descriptors, and run Codex and OMP through the built gateway.
- Implement Promptfoo flow: retain builder snapshot/provenance, invoke UHP with descriptor, apply initialization delta, consume ordered response changes, and reconstruct final tree.
- Prove no task-time call to builder and no Git/source credentials in gateway or harness.

**Exit proof:** one snapshot runs with both harnesses; cache miss/hit have identical semantics; builder baseline + initialization delta equals `ready_manifest_digest`; subsequent deltas reconstruct the final private tree; continuation performs no mutable source resolution.

### Phase 7: Upstream the generic seam

**Work after maintainer agreement on issue #304**

- Split changes into the smallest accepted upstream reviews: initializer/lifecycle seam, explicit-cursor manifest journal, recoverable terminal-finalization seam, and focused tests/docs as maintainers direct.
- Keep stock implementations default and avoid AllAgents names/source schemas in core.
- Maintain one downstream delta map from every patch to upstream issue/PR/release/removal condition.

**Exit proof:** upstream tests prove initialization order, idempotency, replacement rejection, explicit cursor handoff, exact journal, capture-before-ACK, checkpoint/cursor durability before terminal visibility, continuation, restore failure, and unchanged stock behavior. Downstream adapter builds against all accepted seams without aliases; unaccepted seams remain explicit fork deltas.

If maintainers reject or materially reshape the proposal, update ADR 0002 before introducing a different fork architecture. Do not push product-specific source preparation into HarnessRouter as a shortcut.

### Phase 8: Review and release exact digests

Run final architecture/security review before the green E2E. Resolve important findings, then:

1. publish builder and gateway candidates with SBOM and build provenance;
2. read both back and record exact registry manifest digests;
3. deploy/test only those digests on the preflighted production-equivalent filesystem;
4. keep `allagents_workspace_snapshot_v1` disabled until every serving gateway/runner is compatible, then prove version-aware routing rejects old replicas before hydrate;
5. run stock UHP conformance and snapshot E2E with both supported harnesses;
6. run N-1-to-candidate upgrade and prove compatible-reader rollback or enforce unavailable-first drain before old code serves snapshot sessions;
7. repeat race-sensitive singleflight, cache-path attack, writer race, ACK/CAS, cancellation, crash, turn deletion, reference release, eviction, and cleanup cases against the exact digest;
8. run fresh/same-volume restarts at pending initialization, ready, active turn, durable/acknowledged finalization, checkpoint, and every deletion state;
9. run secret, artifact-content, and telemetry scans; and
10. record upstream issue/PR status, downstream delta, fixture digests, builder/gateway digests, SBOMs, provenance, compatibility versions, and E2E report.

Do not prove a local build and assume the published image is equivalent. Do not support an architecture that was not built, preflighted, and tested; V1 MAY declare `linux/amd64` only.

## Completion checklist

### AllAgents Workspace Builder

- Repository exists with protected main, pinned toolchain/dependencies, license, security policy, and reproducible releases.
- Build spec v1, full/shallow Git, OCI inputs, secure composition, provenance, canonical manifest, and OCI publication match this plan.
- Versioned builder result and digest-covered `available_until` match registry retention; delayed execution inside the admitted window succeeds.
- Credentials and private transport configuration never enter artifact/log/output.
- Independent provenance/manifest implementations, canonical gzip, golden fixtures, malicious fixtures, and published readback reproduce identity.

### AllAgents Gateway

- Fork relationship, history, `LICENSE`, `NOTICE`, upstream remote, and stock behavior remain intact.
- Runtime source composition and obsolete schemas/branches are absent.
- Vendor request/response, authorization, binding/reference state, cache, private clone, ready gating, journal, turn commit, checkpoint, continuation, cancellation, expiry, and deletion match ADR 0002.
- Cache hits reauthorize; private repository/catalog/signature subject persists; durable references are idempotent; TTL starts at ready; expired/short retention returns `422`, deadlines/promised-retention misses return `503`, and invalid cwd returns `422 workspace_snapshot_invalid`.
- Snapshot baseline plus initialization delta equals ready manifest; exact response changes include deletion and exclude `.git`/`.harness`; streamed bytes equal `after` state before ACK.
- Response visibility cannot outrun journal ACK, exact checkpoint, or authoritative cursor durability.
- Reflink/copy, inaccessible cache, reserved paths, quota, mixed-version fencing, restart, rollback-or-drain, turn deletion, and race repetitions pass against the exact published digest.

### Promptfoo/integrator

- Preparation and execution are separate steps.
- Builder result and snapshot baseline are retained.
- UHP request carries only the direct descriptor extension.
- Initialization delta is applied before ordered response deltas; neither is treated as a self-contained snapshot.
- Continuation omits snapshot metadata and reuses the original session.

### Upstream/migration

- [HarnessRouter issue #304](https://github.com/HarnessRouter/harnessrouter/issues/304) has a recorded maintainer decision.
- Downstream code is isolated behind initializer, explicit-cursor journal, and recoverable-finalization interfaces compatible with the proposal.
- Accepted upstream patches contain no AllAgents source model.
- Only an upstream release containing every required seam triggers deletion of corresponding forked implementations; remaining deltas stay explicit.

### Operator

- Supply secrets through protected mechanisms only.
- Maintain snapshot authorization catalog, registry retention, cache/quota policy, and production filesystem capability.
- Publish and deploy by digest.
- Accept release only when builder/gateway digests, SBOMs, provenance, compatibility record, upstream delta, and E2E evidence identify the same tested artifacts.
