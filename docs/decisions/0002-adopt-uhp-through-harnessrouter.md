# ADR 0002: Adopt UHP through AllAgents Gateway with composable workspace sources

- Status: Accepted
- Date: 2026-09-21
- Updated: 2026-09-28

## Context

Promptfoo needs a remote coding-harness endpoint that can prepare large source trees before the first turn, preserve session state across continuations, and expose exact source provenance and filesystem changes through the Unified Harness Protocol (UHP).

The pinned baseline is HarnessRouter commit [`5f82db1d1f13ea25b8ed0893c38b5b7d2e3e57e3`](https://github.com/HarnessRouter/harnessrouter/commit/5f82db1d1f13ea25b8ed0893c38b5b7d2e3e57e3), release [`v0.25.4`](https://github.com/HarnessRouter/harnessrouter/releases/tag/v0.25.4), and UHP version [`2026-09-12`](https://github.com/HarnessRouter/harnessrouter/tree/5f82db1d1f13ea25b8ed0893c38b5b7d2e3e57e3/protocol/versions/2026-09-12). That source is Apache-2.0 licensed and includes a `NOTICE`; a downstream repository MUST preserve the license, `NOTICE`, attribution, and history.

Stock HarnessRouter already owns session identity, user and sandbox isolation, the private workspace, checkpoints, cancellation, Files and artifacts, harness supervision, cleanup, live-workspace cache reaping, and explicit deletion of durable sessions. A fresh stock workspace initializes a root Git repository. Git supplies the produced-file listing cursor: checkpoint creation commits and then archives the directory, while hydration restores the archive. Git is not a durable-session expiry mechanism.

The existing extension seams are sufficient:

- runner `_produced_list` lists produced paths from a cursor and `_produced_ack` advances that cursor;
- gateway `_collect_produced` durably captures listed files before acknowledging them;
- `BACKING.workspace` exposes either `RunnerWorkspaceFiles` or `CheckpointWorkspaceFiles`; and
- the `HarnessSession` vertex owns session identity, while checkpoint, artifact, and control records remain separate.

The missing capability is first-turn initialization from one or more independently identified Git or OCI source trees. Git depth `2` bounds history but not working-tree transfer, so OCI transport and independent immutable component reuse are required in v1.

## Decision

We will ship a downstream product named **AllAgents Gateway**, derived from the pinned HarnessRouter baseline and distributed as `ghcr.io/allagentsdev/allagents-gateway`. UHP remains the only northbound protocol. `metadata.workspace` is an explicitly downstream first-turn extension; requests that omit it retain pinned stock behavior.

A descriptor contains one ordered `sources` array with 1 to 128 entries. Each entry materializes one tree at a pairwise non-overlapping, non-root destination. Git and OCI entries MAY be mixed in any order. One OCI image represents one source tree, not a runtime image, benchmark image, verifier, or multi-root bundle. A source-kind failure never falls back to the other kind.

The gateway adds workspace binding and a `pending` to `ready` transition to the existing session lifecycle. It MUST resolve, verify, and materialize every root and validate the working directory before making any source visible to the harness or starting provider work. “Atomic” means application visibility after all roots verify; it does not require an atomic filesystem rename or namespace handoff. Failure before `ready` exposes no partial workspace.

Implementation and release do not wait for an upstream issue or UHP proposal. Until upstream accepts an equivalent contract, releases MUST identify this behavior as an AllAgents Gateway extension.

## Request contract

A workspace-backed first turn uses the normal `POST /v1/responses` endpoint. `metadata.workspace` is a closed object with no nested schema version:

```json
{
  "access": "editable",
  "sources": [
    {
      "kind": "git",
      "url": "https://github.com/acme/api.git",
      "ref": "refs/heads/main",
      "destination": "services/api"
    },
    {
      "kind": "oci",
      "snapshot_name": "compiler-tree",
      "image_manifest_digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "source_manifest_digest": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      "destination": "vendor/compiler"
    }
  ],
  "working_directory": "services/api/packages/server"
}
```

| Field | Required | Contract |
|---|---:|---|
| `access` | yes | `read_only` or `editable`, applied to every source. |
| `sources` | yes | Ordered closed array of 1 to 128 Git or OCI entries. |
| `working_directory` | no | Workspace-relative POSIX directory; omission means `.`. |

A Git entry contains only `kind: "git"`, canonical public HTTPS `url`, optional `ref`, and `destination`. Userinfo, query, fragment, local paths, alternate transports, and private or otherwise disallowed network targets are forbidden. `ref` is an advertised full ref or unambiguous branch/tag shorthand; omission selects the advertised default. Resolution produces one exact commit. Depth is always `2` and is not caller-selectable.

An OCI entry contains only `kind: "oci"`, `snapshot_name`, exact `image_manifest_digest`, exact `source_manifest_digest`, and `destination`. `snapshot_name` resolves through an operator-owned catalog to a fixed registry repository, catalog-entry identity, allowed media types, trust policy, and server-side credential reference. Callers cannot supply registry origins, repositories, tags, indexes, headers, redirects, or credentials.

Every destination and `working_directory` is an NFC-normalized relative POSIX path with no empty, `.`, `..`, absolute, platform-specific, or reserved component. Destinations MUST be non-root and pairwise non-overlapping. Destination ownership, reserved-path conflicts, and collisions with known inputs or generated assets MUST be rejected before DNS, Git, registry, or other source access. Ancestor directories may be empty scaffolding only. After materialization, `working_directory` MUST resolve without symlink escape to a real directory.

The order of `sources` is semantic but does not establish overlay precedence. Unknown keys are rejected at every level. The descriptor cannot contain credentials, headers, host paths, commands, environment variables, runtime images, materializer selection, resource limits, provider routes, or expiry controls. Request size, string length, nesting, and validation work are bounded before source access.

A continuation selected by `previous_response_id` or other inherited recovery state MUST omit `metadata.workspace`. A stock session cannot acquire a workspace binding later, and an existing workspace-backed session cannot replace or repeat its descriptor.

## Response and provenance contract

After the binding reaches `ready`, terminal events, response retrieval, replay, and later terminal failures expose the same sanitized `metadata.workspace` object:

```json
{
  "access": "editable",
  "working_directory": "services/api/packages/server",
  "sources": [
    {
      "kind": "git",
      "url": "https://github.com/acme/api.git",
      "requested_ref": "refs/heads/main",
      "resolved_commit": "0123456789abcdef0123456789abcdef01234567",
      "depth": 2,
      "destination": "services/api",
      "source_manifest_digest": "sha256:6666666666666666666666666666666666666666666666666666666666666666"
    },
    {
      "kind": "oci",
      "snapshot_name": "compiler-tree",
      "image_manifest_digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      "source_manifest_digest": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      "destination": "vendor/compiler"
    }
  ],
  "expires_at": "2026-09-29T00:00:00Z"
}
```

`working_directory` is always present and uses `.` for the workspace root. Git provenance contains normalized `url`, optional `requested_ref`, exact `resolved_commit`, `depth: 2`, `destination`, and the verified source-manifest digest. OCI provenance contains the catalog key, exact image and source-manifest digests, and `destination`. Registry details, credentials, private cache keys, backing paths, and live attachment details are never public.

Every workspace-backed session receives one operator-configured finite expiry at creation. `expires_at` is always a timestamp; polling, replay, and continuation do not extend it. Explicit deletion remains supported. Failures before `ready` omit workspace metadata; failures after `ready` return the stored sanitized object.

## Canonical source manifest v1

The source-manifest media type is `application/vnd.allagents.source-manifest.v1+json`. Its exact bytes are the RFC 8785 JSON Canonicalization Scheme representation of:

```json
{"version":1,"entries":[]}
```

`entries` is sorted by the UTF-8 bytes of each NFC-normalized relative POSIX `path`. The root is omitted. Duplicate paths, non-UTF-8 or non-NFC names, empty, `.` or `..` path components, type conflicts, and unsupported file types fail validation. The digest exposed as `source_manifest_digest` is `sha256:` followed by the lowercase hexadecimal SHA-256 of the canonical bytes.

Entries have exactly one of these forms:

```json
{"path":"src","type":"directory"}
{"path":"src/main.ts","type":"file","size":123,"sha256":"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","executable":false}
{"path":"bin/tool","type":"symlink","target":"../src/tool"}
```

A file `sha256` is `sha256:` followed by the lowercase hexadecimal SHA-256 of
its content. `executable: false` represents normalized mode `0644`; `true`
represents `0755`. A symlink target MUST be UTF-8, NFC, relative, and confined
to its owning source root when resolved from the link's parent. Empty
directories are represented. Safe in-root OCI hardlinks may be materialized as
ordinary file entries and are not a manifest type. `.git` content MAY be
integrity-verified in a source manifest but is excluded from change reporting.

The gateway walks without following links and recomputes the canonical manifest before publication. For OCI, it fetches and digest-verifies the source manifest before any layer, validates its paths and limits, applies ordinary OCI image/layer/whiteout semantics, and requires the extracted tree to reproduce the declared canonical manifest exactly.

## Resolution, caching, and visibility

A private Git component key is exactly the canonical URL, exact resolved commit, depth `2`, and one cache-schema revision. A private OCI component key is exactly the catalog-entry identity, exact image-manifest digest, exact source-manifest digest, and one cache-schema revision. Recomputing a baseline digest proves publication integrity; it is not a cache-key input.

Components cache independently and exact-key misses singleflight independently. Git retains the accepted operator-only acquisition mirror per canonical URL, then publishes an immutable verified generation. OCI MAY use standard registry-client, image, and layer caches; this decision does not require a separate gateway-managed blob-cache lifecycle. There is no request-wide composition cache, record, or public identity.

The session binding stores the private descriptor digest, ordered resolved source plan, exact private component keys, public provenance, access, working directory, canonical baselines and acknowledged manifest cursors, durable component and checkpoint references, and `expires_at`. It MUST NOT persist live mount IDs, filesystem identities, attachment flags, publication generations, or inode evidence. Live read-only protection, destination ownership, and writable-copy isolation are revalidated on every attach.

The ordered plan remains `pending` until every component is verified, each destination is safely materialized, and the working directory is valid. One transition to `ready` makes the plan visible to application code. A failure rolls back provisional work and leaves no visible partial plan.

## Access and source integrity

For `read_only`, each immutable component root is exposed at its destination through a namespace-confined read-only bind mount with `nodev` and `nosuid`, without a writable alias or copy-up path. For `editable`, each destination is a quota-bounded, inode-independent private reflink or copy. Git and OCI receive identical write semantics. The outer workspace remains private and writable in both modes.

Git acquisition resolves only advertised refs, fetches the selected commit at depth `2`, and verifies the fetched tip, bounded object graph, checkout, and source manifest. Commands run without a shell in a sanitized, isolated configuration; credentials, inherited proxies, hooks, filters, LFS hydration, submodule recursion, alternates, and non-HTTPS helpers are disabled. The published tree may retain safe shallow `.git` metadata and bounded recent history for agent convenience, but removes credential-bearing remotes and unsafe or transient state. Git metadata never defines evaluation correctness.

OCI acquisition uses the catalog-selected direct image manifest and the declared source manifest. It verifies descriptor media types, sizes, and digests; applies layers in order with standard whiteout and opaque-directory behavior; and extracts with rooted no-follow operations. Traversal, out-of-root links, devices, sockets, FIFOs, sparse-file tricks, undeclared or missing entries, unsupported types, and digest or type mismatches fail closed. OCI sources need not contain Git metadata.

The v1 maximum for one OCI entry is 64 tar/gzip/zstd layers, a 4 MiB image manifest, a 128 MiB source manifest, 8 GiB compressed layers, 32 GiB expanded source, 500,000 entries, 4 GiB per regular file, 4096 UTF-8 bytes and 128 components per path, and 1 MiB per PAX or extended header. Expanded bytes divided by `max(compressed bytes, 1)` MUST NOT exceed 100 per layer or entry. Time, bytes, inodes, processes, descendants, and concurrency are also bounded per entry and per request. Operators MAY lower but not raise these contractual maxima without a contract revision.

## Produced files and evaluation changes

The inherited UHP Files/artifact surface remains the only public file surface. Workspace-backed collection replaces only the stock root-Git listing/cursor implementation behind the existing seams:

1. `_produced_list` compares the last acknowledged canonical manifest cursor for the outer workspace and every editable root with their final manifests. Read-only roots are not walked; their unchanged state is trusted only from immutable component identity plus freshly verified mount protection.
2. `_collect_produced` captures every added or modified regular file through the existing gateway file-artifact path.
3. `_collect_produced` then captures one server-generated `workspace-changes-<response_id>.json` artifact with media type `application/vnd.allagents.workspace-changes.v1+json`.
4. Only after all file artifacts and the change artifact are durable does `_produced_ack` advance all cursor manifests. A retry before acknowledgement reproduces the same logical change set.

The change artifact is RFC 8785 canonical JSON:

```json
{
  "version": 1,
  "entries": [
    {
      "path": "services/api/src/main.ts",
      "operation": "modify",
      "before": {"type": "file", "sha256": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "size": 100, "executable": false},
      "after": {"type": "file", "sha256": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "size": 120, "executable": false},
      "file_id": "file_…"
    }
  ]
}
```

Entries sort by the UTF-8 bytes of NFC-normalized workspace-relative `path`. `operation` is `add`, `modify`, or `delete`. `add` has `after`; `delete` has `before`; `modify` has both. State objects use `{type:"directory"}`, `{type:"file",sha256,size,executable}`, or `{type:"symlink",target}`. `file_id` is required exactly when `after.type` is `file` and refers to the captured regular-file artifact. Mode or symlink-target changes are `modify`; a rename is `delete` plus `add`. An empty collection still emits the change artifact with an empty `entries` array.

Runner-owned state, credentials, caches, control metadata, checkpoint metadata, and every `.git` tree are excluded from reporting. Promptfoo consumes change artifacts in response order and applies them to its previous reconstructed state. It does not inspect gateway Git state or require a new endpoint.

## Checkpoints, continuation, expiry, and deletion

Workspace-backed checkpointing keeps the inherited archive/hydration lifecycle but is mount-aware. Archive, Files, cleanup, and manifest operations MUST NOT follow or cross read-only mounts. Checkpoints preserve the writable outer workspace and editable-root bytes, plus durable references to the ordered binding and baselines; they never archive immutable cache roots or acquisition state.

Continuation restores the inherited checkpoint archive, recovers the exact stored source plan without resolving refs or pulling OCI again, verifies durable component and baseline references, revalidates destinations and live attachment protection, attaches read-only roots or restores editable roots, validates the working directory, and only then starts the stored harness. Expired, missing, or corrupt bound state fails closed rather than substituting a newer source or silently starting fresh.

Live-workspace cache reaping and durable session deletion remain distinct operations. The gateway rejects continuation at or after `expires_at` and performs deletion through the inherited explicit durable-session deletion path. Attachments are removed before hydration, deletion, workspace cleanup, or cleanup retry. Uncertain or busy state remains accounted for until cleanup succeeds.

## Failure contract

Workspace failures use these stable detail codes in the existing UHP error
shape. `retryable` states whether the same operation may succeed without
changing the request. Pre-`ready` failures omit workspace metadata; post-`ready`
workspace failures return the stored sanitized metadata except inherited
`session_expired`, which retains the pinned UHP response unchanged.

| Detail code | HTTP | Retryable | Timing and condition |
|---|---:|:---:|---|
| `workspace_invalid_request` | 400 | no | Pre-`ready`: malformed/unknown fields, invalid paths or refs, continuation metadata, or invalid working-directory syntax. |
| `workspace_path_collision` | 409 | no | Pre-`ready`, before source access: overlapping/reserved destinations or input/asset collisions. |
| `workspace_source_unknown` | 404 | no | Pre-`ready`: unknown catalog entry or missing, ambiguous, or unsupported Git ref identity. |
| `workspace_source_invalid` | 422 | no | Pre-`ready`: digest, manifest, layer, path, link, type, checkout, or extracted-content verification failure. |
| `workspace_acquisition_unavailable` | 503 | yes | Pre-`ready`: bounded transient Git, registry, DNS, transport, or upstream service failure. |
| `workspace_contract_limit_exceeded` | 413 | no | Pre-`ready`: request, component, expansion, file, path, process, time, or aggregate contractual maximum exceeded. |
| `workspace_capacity_exceeded` | 503 | yes | Pre-`ready`: operator storage, inode, mount, worker, or concurrency capacity unavailable. |
| `workspace_attachment_failed` | 500 | yes | Initial attachment before `ready` or live reattachment after `ready`: bind/remount, copy/reflink, destination, protection, baseline, or working-directory validation failure. |
| `session_expired` | 404 | no | Inherited UHP response when continuation targets a session at or after `expires_at`; omit workspace metadata and do not restore or extend expiry. |
| `workspace_restore_invalid` | 500 | no | Post-`ready`: binding, component, checkpoint, baseline, or cursor evidence is missing, corrupt, or inconsistent. |
| `workspace_collection_failed` | 500 | yes | Post-`ready`: manifest comparison, file/change-artifact capture, or cursor acknowledgement cannot complete. The cursor is not advanced. |
| `workspace_checkpoint_failed` | 500 | yes | Post-`ready`: mount-aware archive creation or durable checkpoint persistence fails after collection. |

Cancellation is not a workspace error. The inherited cancel endpoints remain
idempotent and successful, and a cancelled task terminates with
`status: "cancelled"`, never failed. A cancellation before `ready` omits
workspace metadata; one after `ready` retains the stored sanitized metadata.

Provider and harness failures that are not workspace failures retain their exact inherited UHP codes. Implementations MUST NOT reuse an inherited code for a workspace condition unless status, retryability, and semantics are identical. No failure may change source kind, source identity, access, working directory, harness, or provider route as a recovery shortcut.

## Distribution and release boundary

`allagentsdev/allagents-gateway` does not exist at the time of this decision. Before implementation, an organization repository administrator must rename or bootstrap the current `allagentsdev/harnessrouter` repository from the pinned commit, preserve Apache-2.0, `NOTICE`, attribution, and history, add `HarnessRouter/harnessrouter` as the upstream remote, and create a writable implementation branch.

Implementation also requires checked-in local builders for an authenticated OCI registry, catalog, and source fixtures, plus a Linux environment capable of namespace-confined bind mounts and reflink-or-copy isolation. The implementation agent can deliver a pull request using those fixtures and mocked provider transport without production secrets. Provider gateway URL/key, UHP caller credentials, GHCR rights, protected settings, and final publication/deployment are operator-owned inputs supplied through the repository's secret mechanism.

Workspace code only gates inherited harness start until the binding is `ready` and the working directory is valid; it does not redesign Codex, OMP, or provider authentication. Release validation runs once against the published image read back and pinned by digest. Completion requires stock UHP compatibility, Git/OCI/mixed workspace flows, read-only and editable isolation, canonical change artifacts, continuation, cancellation, expiry/deletion, cache reuse, fresh-volume and same-volume restart, both supported harnesses, UHP conformance, security scans, SBOM, and build provenance.

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Build a new execution service or a separate workspace service | Duplicates UHP/session behavior or splits ownership away from checkpoint, continuation, collection, and deletion. |
| Use one source object, one multi-root OCI bundle, or one request-wide cached tree | Prevents independent mixed-source identity and reuse and hides destination ownership. |
| Put a source at workspace root | Collides with runner-owned state, inputs, checkpoints, and the writable outer workspace. |
| Use symlinks for shared read-only roots or shared inodes for editable roots | Does not enforce isolation and can expose or mutate backing storage. |
| Use Git as the evaluation diff engine | Cannot represent Git-free OCI roots, multiple roots, outer files, or immutable final-tree semantics. |
| Add a second changes endpoint | Duplicates the inherited Files/artifact surface and bypasses its capture-before-ack behavior. |
| Add a general materializer plugin framework | V1 has two explicit source kinds and no caller-selectable implementation need. |
| Wait for upstream acceptance | Delays downstream evidence and makes delivery depend on a project we do not control. |

## Consequences

AllAgents Gateway remains one execution, workspace, and session control plane. Independent component caching permits reuse without a global composition object. Visibility gating and mount-aware lifecycle work add implementation complexity but prevent partial workspaces, mutable shared state, and checkpoint traversal into caches.

Canonical manifests and change artifacts add bounded filesystem scanning and hashing, but give Git and OCI one evaluator-visible definition of state. Promptfoo can reconstruct results entirely from ordered UHP artifacts, regardless of Git metadata or index state.

Mandatory OCI support and Linux mount/copy capabilities make v1 substantial, but they satisfy the large-source requirement while preserving safe shallow Git history for agent convenience and Git-free OCI operation.

## Reconsider when

Revisit this decision if upstream adopts an equivalent ordered multi-source contract, its lifecycle removes these extension seams, the deployment platform cannot enforce the required isolation, bounded OCI materialization or manifest collection cannot meet release limits, continuation cannot fail closed without reacquisition, or another UHP implementation offers a materially smaller and equally stable integration surface.
