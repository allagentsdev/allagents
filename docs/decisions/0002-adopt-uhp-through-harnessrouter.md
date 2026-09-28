# ADR 0002: Adopt UHP through AllAgents Gateway with prepared workspace snapshots

- Status: Accepted
- Date: 2026-09-21
- Updated: 2026-09-28

## Context

Promptfoo needs a remote coding-harness endpoint that can start from large reproducible workspaces, preserve several complete Git histories, continue a session without source drift, and return exact filesystem changes.

The accepted HarnessRouter baseline is commit [`5f82db1d1f13ea25b8ed0893c38b5b7d2e3e57e3`](https://github.com/HarnessRouter/harnessrouter/commit/5f82db1d1f13ea25b8ed0893c38b5b7d2e3e57e3), release [`v0.25.4`](https://github.com/HarnessRouter/harnessrouter/releases/tag/v0.25.4), and UHP version [`2026-09-12`](https://github.com/HarnessRouter/harnessrouter/tree/5f82db1d1f13ea25b8ed0893c38b5b7d2e3e57e3/protocol/versions/2026-09-12). The current implementation point inspected for this revision is commit [`8f7868ccb2c97d1f611acf11e7cad0357a43064e`](https://github.com/HarnessRouter/harnessrouter/commit/8f7868ccb2c97d1f611acf11e7cad0357a43064e). The relevant workspace behavior is unchanged between those points.

Stock HarnessRouter already owns UHP, authentication, session and response identity, harness supervision, one private session filesystem, checkpoint/hydrate, Files and artifacts, cancellation, and deletion. Its root Git repository is an internal produced-file journal, not a model that the agent may edit only one repository. Repositories are ordinary content inside the session filesystem.

Stock behavior is insufficient for prepared multi-repository workspaces:

- there is no supported public immutable-snapshot import contract;
- `_git_ensure` creates or mutates `.git` at the workspace root;
- root Git cannot report exact descendant changes across embedded repositories and stock collection omits deletions;
- stock checkpoints rearchive the full workspace and are session-keyed rather than a cross-session immutable snapshot cache; and
- `BACKING.workspace` reads or writes one file and is not an acquisition seam.

The previous version of this ADR placed Git resolution, OCI acquisition, multi-source composition, source credentials, caching, attachment, execution, and collection inside AllAgents Gateway. That crosses two trust and lifecycle boundaries. Mutable source preparation belongs before execution. HarnessRouter should receive one already-published immutable filesystem, not a product-specific source plan.

The supporting evidence is in [Prebuilt immutable workspace snapshots at the HarnessRouter boundary](../research/allagents-gateway-snapshot-boundary.md).

## Decision

We will use two components in two source repositories:

1. **AllAgents Workspace Builder** in `allagentsdev/allagents-workspace-builder` owns Git and OCI acquisition, credentials, multi-repository composition, source policy, provenance, canonical baseline creation, and immutable snapshot publication.
2. **AllAgents Gateway** in `allagentsdev/allagents-gateway` remains a stock-derived HarnessRouter distribution. It accepts one exact snapshot descriptor, authorizes it, initializes a private writable session tree, journals filesystem changes without root Git, and otherwise retains HarnessRouter's UHP/session lifecycle.

This separation is a source and trust boundary, not a requirement to deploy two always-on services. The builder SHOULD begin as a CLI/library usable from CI or a job worker. It MAY gain an asynchronous service wrapper when workload or latency requires one. Published OCI artifacts are the only execution handoff.

UHP remains the only northbound execution protocol. Snapshot execution is an AllAgents vendor extension, not a claim that UHP 2026-09-12 standardizes workspace snapshots. Requests without the extension retain characterized stock behavior.

AllAgents will propose upstream-neutral immutable workspace initialization, Git-independent journaling, and recoverable terminal finalization seams to HarnessRouter. Downstream implementation may proceed while the proposal is reviewed. Product-specific Git/OCI composition and the AllAgents snapshot format remain outside HarnessRouter.

## Preparation boundary

The builder accepts an AllAgents-owned build request that MAY contain several Git and OCI inputs, non-overlapping destinations, and one default working directory. That build API is not a UHP request and is not accepted by AllAgents Gateway.

The builder MUST:

- resolve every mutable Git ref to an exact commit before publication;
- preserve complete ancestry reachable from the selected commit by default, with shallow history only when explicitly requested;
- keep source credentials, Git helpers, mirrors, registry coordinates, and acquisition network policy out of the artifact and agent environment;
- compose all inputs into one staging tree without overlapping destinations or reserved-path collisions;
- remove acquisition-only state, credential-bearing remotes, unsafe alternates, transient Git locks, devices, sockets, FIFOs, capabilities, ACLs, xattrs, and special permission bits;
- validate self-contained `.git` repositories semantically while keeping their bytes inside the snapshot;
- generate a canonical visible-tree manifest that excludes every `.git` tree and runner-owned paths;
- generate digest-covered provenance that records ordered source identity, destination, requested selector, resolved immutable identity, history completeness, builder version, and policy version;
- publish layers, config, provenance, and the tree manifest completely before returning a direct OCI image-manifest descriptor; and
- never return a tag or multi-platform index as the execution identity.

Preparation failure occurs before UHP session creation. The gateway never retries a failed build, chooses another ref, changes history depth, or falls back between Git and OCI.

## Snapshot artifact contract

A workspace snapshot is one OCI image manifest with:

- `artifactType: application/vnd.allagents.workspace-snapshot.v1`;
- config media type `application/vnd.allagents.workspace-snapshot.config.v1+json`;
- provenance media type `application/vnd.allagents.workspace-provenance.v1+json`;
- canonical visible-tree media type `application/vnd.allagents.workspace-manifest.v1+json`;
- only gzip filesystem layers with media type `application/vnd.oci.image.layer.v1.tar+gzip`; and
- ordered OCI filesystem changesets applied to an empty directory.

The closed digest-covered config contains `version: 1`, default relative working directory, workspace-manifest descriptor, provenance descriptor, builder/policy identity, `reserved_paths_schema: 1`, and `available_until`. The builder emits deterministic gzip with fixed headers and rejects uncompressed, zstd, and nondistributable layer media types in V1.

Reserved-path schema 1 contains exactly the root `.harness` path and every descendant. The builder rejects any entry or link alias at that location. Harness instruction files such as root `AGENTS.md` are visible snapshot content, not reserved paths: snapshot mode MUST preserve existing content, merge any runner-managed block deterministically, and establish the initial visible-tree cursor only after that merge and UHP input application.

Provenance is RFC 8785 canonical JSON. Its closed schema is:

```text
{
  version: 1,
  sources: Array<
    | {kind: "git", url: string, requested_ref?: string, resolved_commit: string,
       history: {mode: "full"} | {mode: "shallow", depth: integer}, destination: string}
    | {kind: "oci", source_name: string,
       descriptor: {media_type: string, digest: string, size: integer}, destination: string}
  >
}
```

Source order is build order. The builder and policy identity remain in config. Provenance contains no credential, private registry coordinate, header, host path, or helper state.

The builder returns one versioned result:

```json
{
  "version": 1,
  "descriptor": {
    "media_type": "application/vnd.oci.image.manifest.v1+json",
    "digest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "size": 123456
  },
  "workspace_manifest_digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "provenance_digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "working_directory": "services/api",
  "available_until": "2026-10-29T00:00:00Z"
}
```

Only `descriptor` is forwarded to the gateway. `available_until` is also digest-covered by config and is backed by an operator-enforced registry retention lease. The gateway admits a new session only when the remaining lease covers initialization deadline plus maximum session TTL plus safety margin.

The direct manifest digest transitively binds config, provenance, the visible-tree manifest, layers, all `.git` bytes, and the retention deadline. OCI referrers MAY add signatures or attestations, but required provenance MUST remain digest-covered by the admitted manifest because an OCI `subject` association is weak and can change independently.

The canonical visible-tree manifest uses media type `application/vnd.allagents.workspace-manifest.v1+json` and RFC 8785 canonical JSON:

```json
{"version":1,"entries":[]}
```

Entries sort by the UTF-8 bytes of their NFC-normalized relative POSIX path. The root is omitted; empty directories are represented. A path has exactly one of these states:

```json
{"path":"src","type":"directory"}
{"path":"src/main.ts","type":"file","size":123,"sha256":"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef","executable":false}
{"path":"bin/tool","type":"symlink","target":"../src/tool"}
```

Traversal never follows links. File modes normalize to `0644` or `0755`; directories normalize to `0755`; ownership is runtime-assigned rather than artifact-controlled. Symlink targets MUST be UTF-8, NFC, relative, and confined when resolved from the link parent. Safe in-root OCI hardlinks MAY be materialized as ordinary files. Duplicate, non-UTF-8, non-NFC, absolute, traversing, escaping, unsupported, or conflicting entries fail publication or admission.

Every `.git` tree and reserved `.harness` tree is excluded from the visible-tree manifest and public changes. The complete materialized namespace is still scanned independently for forbidden `.harness` entries before cache publication and ready. Layer digests bind `.git` bytes, and builder provenance records semantic Git verification. Evaluation correctness never depends on a Git index, status, commit, ignore rule, or rename heuristic.

## Gateway request contract

A snapshot-backed first turn uses `POST /v1/responses` with a closed, versioned vendor extension:

```json
{
  "input": "Make the requested change.",
  "metadata": {
    "allagents_workspace_snapshot": {
      "version": 1,
      "descriptor": {
        "media_type": "application/vnd.oci.image.manifest.v1+json",
        "digest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "size": 123456
      }
    }
  }
}
```

Only `version` and `descriptor` are accepted. Unknown keys fail. The caller cannot provide a registry, repository, tag, index, credential, header, redirect policy, host path, source list, materializer, working directory, resource limit, provider route, or expiry.

V1 maps each authenticated product domain to exactly one trusted snapshot repository and one authorization catalog; zero or multiple repository mappings are a deployment error. The catalog entry binds the exact descriptor and digest-covered `available_until`. Before cache use or registry traffic, the gateway resolves one entry and authorizes `(principal, domain, repository_id, catalog_entry_id, media_type, digest, size)` against current policy. A digest proves identity, not authorization. Every cache hit reauthorizes the tuple; policy revision does not fragment the byte-cache key.

The extension is accepted only on the request that creates a new session. Continuations selected by `previous_response_id` MUST omit it. A stock session cannot acquire a snapshot later, and a bound session cannot repeat or replace its descriptor.

After initialization reaches `ready`, terminal events, response retrieval, replay, and later terminal failures expose the same sanitized metadata:

```json
{
  "version": 1,
  "descriptor": {
    "media_type": "application/vnd.oci.image.manifest.v1+json",
    "digest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "size": 123456
  },
  "snapshot_manifest_digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "ready_manifest_digest": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "provenance_digest": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "initialization_changes_file_id": "file_...",
  "working_directory": "services/api",
  "available_until": "2026-10-29T00:00:00Z",
  "expires_at": "2026-09-29T00:00:00Z"
}
```

Repository coordinates, catalog entries, policy revisions, credentials, private cache keys, host paths, local clone mechanisms, and builder job identifiers are never public. Full source provenance is retrieved from the digest-covered snapshot provenance; UHP returns its immutable digest rather than copying a product-specific source schema into HarnessRouter.

## Binding and initialization lifecycle

A snapshot session has durable `pending`, `ready`, `failed`, and `deleting` states. Before acquisition, the gateway persists the exact descriptor, internal immutable `repository_id`, `catalog_entry_id` and version, admitted signature-policy/evidence identity, authorization audit reference, initialization deadline, and one provisional reference record keyed by `(binding_id, snapshot_key)`. It never persists credentials, public registry coordinates, local cache paths, inode identities, live attachment flags, or process-local locks.

Initialization is all-or-nothing:

1. Validate the request and first-turn rule without network or workspace writes.
2. Resolve exactly one repository/catalog entry and authorize the full tuple against current policy.
3. Persist the `pending` binding and provisional reference.
4. Fetch only from the bound repository by digest; verify response size and digest before use.
5. Verify config, provenance, retention deadline, tree manifest, gzip layer descriptors, signatures when policy requires them, and every referenced size/digest/media type. Reject expired or insufficient remaining retention with `workspace_snapshot_retention_invalid`.
6. Reject unknown reserved-path schemas. During layer application and final scan, reject every entry, whiteout, hardlink, symlink alias, or type transition at `.harness` or below.
7. Apply OCI changesets in private staging with rooted no-follow operations and bounded bytes, entries, paths, metadata, processes, descendants, and time.
8. Recompute the canonical snapshot manifest and a private full-tree seal that includes `.git`; require the declared snapshot digest and persist the seal as cache evidence.
9. Publish or reuse one immutable unpacked cache generation keyed by descriptor plus materializer-schema revision.
10. Reauthorize current policy, then create an inode-independent private session tree by same-filesystem reflink clone when supported or full private copy otherwise. Hardlinks to cache content are forbidden.
11. Apply UHP inputs and deterministic runner instruction/control preparation. Compare the snapshot manifest to the resulting ready tree, durably capture `workspace-initialization-changes-<session_id>.json` plus changed regular-file artifacts, and store the ready manifest as initial cursor.
12. Validate the digest-covered working directory, activate the reference, and atomically transition to `ready` with the snapshot/ready digests and initialization artifact; start finite session TTL and only then provider or harness work.

Credentialed Git and OCI clients authorize scheme, host, port, and resolved IP before every connection; reject loopback, link-local, private, Unix-socket, rebinding, or other disallowed targets; bound and reauthorize every redirect; never forward authorization, cookies, or client certificates across origins; require TLS; and use scoped short-lived credentials.

The initialization deadline is separate from session TTL. Deadline exhaustion is a retryable availability failure, not a request-size failure. Every pre-ready failure is terminal for that binding: it transitions to `failed`, releases the provisional reference idempotently, and leaves no runnable tree. `retryable: true` means a caller may create a new session with the same descriptor; an idempotent duplicate of the failed request returns the same failure. Restart reconciliation may resume a still-running `pending` attempt internally.

Exact-key cache misses singleflight. Cache roots and generations are owned by a gateway/materializer identity no harness UID can assume, are non-writable and non-searchable from the runner namespace, and are cloned only through trusted directory file descriptors with no-follow operations under an eviction/clone lease. The gateway verifies the full-tree seal immediately before and after cloning; unexpected mutation quarantines the generation and fails closed.

Staging and quarantine have global byte, inode, and age bounds. Complete unreferenced cache generations are evictable under high and low watermarks. Durable reference records, not counters, make claim/release and crash reconciliation idempotent. Cache attachment eligibility is reauthorized on every use.

V1 intentionally materializes a normal private directory. Reflink is preferred and full copy is required as the correctness fallback. OverlayFS and base-plus-delta checkpoints are deferred until measurements justify the larger mount-aware lifecycle change.

## Resource and extraction limits

The v1 format maximum is 64 layers, a 4 MiB OCI manifest, a 4 MiB config, a 128 MiB workspace manifest, 8 GiB total compressed layers, 64 GiB expanded workspace bytes, 1,000,000 visible entries, 4 GiB per regular file, 4096 UTF-8 bytes and 128 components per path, and 1 MiB per PAX or extended header. Expanded bytes divided by `max(compressed bytes, 1)` MUST NOT exceed 100 for each layer and for the artifact as a whole. Operators MAY lower but not raise these maxima without a contract revision.

Extraction rejects absolute or traversing paths, ambiguous separators, NULs, escaping links, devices, sockets, FIFOs, unsupported sparse files, unbounded metadata, unknown compression, duplicate/type conflicts, undeclared final content, and digest mismatches. Runtime byte and inode quotas apply to staging, cache, private workspaces, outputs, and checkpoints. Materialized roots run `nodev` and `nosuid` where the deployment filesystem supports mount flags; normalized content contains no device nodes, set-ID bits, file capabilities, or executable metadata outside the manifest contract.

## Produced files and evaluation changes

Snapshot-backed sessions replace only the stock root-Git journal behind the existing produced-list, capture, and acknowledge seams. Requests without the snapshot extension retain stock root-Git behavior.

The gateway stores the canonical no-follow manifest cursor in protected blob storage as the sole durable journal authority. It excludes every `.git` and `.harness` tree. The runner receives the explicit acknowledged cursor, compares it with the final visible tree, and returns add, modify, and delete plus the next cursor/token. Content, type, executable mode, and symlink-target changes are modifications; rename is delete plus add.

The gateway captures every added or modified regular file through the existing Files/artifact path and creates exactly one RFC 8785 canonical artifact named `workspace-changes-<response_id>.json` with media type `application/vnd.allagents.workspace-changes.v1+json`:

```json
{
  "version": 1,
  "entries": [
    {
      "path": "services/api/src/main.ts",
      "operation": "modify",
      "before": {"type":"file","sha256":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":100,"executable":false},
      "after": {"type":"file","sha256":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","size":120,"executable":false},
      "file_id": "file_..."
    }
  ]
}
```

Entries sort by normalized path bytes. `add` has only `after`; `delete` has only `before`; `modify` has both. `file_id` exists exactly when `after.type` is `file` and refers to the already-durable file artifact. Empty turns emit an empty change artifact.

Collection, checkpoint, cursor advancement, and terminal response finalization form one recoverable response transaction under an exclusive workspace mutation lease. The lease blocks Files writes, new turns, cleanup, and every other session writer after all descendants stop:

1. send the gateway-owned acknowledged cursor blob to the runner and compute the next manifest;
2. create deterministic artifact identities keyed by `response_id`;
3. open changed regular files with rooted no-follow operations, hash while streaming, and require type, size, and digest to equal each `after` state;
4. durably store regular-file artifacts and the change artifact;
5. create and durably store the exact snapshot-mode checkpoint, then verify its visible manifest equals the next cursor;
6. durably store the next cursor manifest;
7. call idempotent `/produced/ack` with base digest, next digest, and collection token; and
8. atomically compare-and-set the gateway's cursor/checkpoint/artifact pointers and terminal response to committed.

The gateway cursor blob is the sole durable journal authority. Runner ACK is a recoverable confirmation barrier, not independent cursor state; every retry supplies the base cursor explicitly. A crash before step 8 leaves the previous gateway cursor authoritative even if ACK ran, so retry reproduces the same logical transaction. Terminal response visibility occurs only after ACK and the final compare-and-set.

A retry reuses the same immutable artifacts and never reruns the harness. The exclusive lease plus streamed hash/checkpoint verification prevents a file artifact, change manifest, and checkpoint from describing different trees.

Promptfoo reconstructs the final visible tree by starting from the builder's exact snapshot, applying the durable initialization-change artifact, then applying ordered per-response change artifacts. The ready manifest digest proves that first transition. Change artifacts are deterministic deltas; they do not pretend to contain baseline bytes or `.git` history.

## Checkpoint, continuation, expiry, and deletion

Snapshot-backed V1 checkpoints the complete normal private workspace, including self-contained `.git` histories. It excludes only `.harness/tmp/**`, `.harness/home/.codex/auth.json`, `.harness/home/.omp/agent/auth.json`, `.harness/home/.omp/agent/models.json`, and `.harness/home/.omp/agent/models.yml`; every other `.harness` resume path remains. Stock broad dependency exclusions MUST NOT remove declared snapshot/session content. Any exclusion change requires a checkpoint-schema revision and compatible-reader gate.

A continuation restores the exact durable checkpoint and cursor, verifies the stored binding, working directory, quotas, and ownership, and only then starts the stored harness. It does not accept another descriptor or resolve mutable sources. Missing or corrupt binding, checkpoint, cursor, or snapshot identity fails closed rather than starting empty. An evicted unpacked cache MAY be repopulated only from the same authorized direct manifest digest; the session's checkpoint remains the source of mutable state.

The finite session TTL starts only after `ready`. Polling, replay, turns, and continuation do not extend `expires_at`. Expiry and explicit deletion make the session unavailable first, stop descendants, remove the private workspace, delete durable checkpoint/cursor state through existing records, and release each durable snapshot reference exactly once. Busy or uncertain state remains unavailable, accounted, and queued for idempotent reconciliation.

## Failure contract

Workspace failures use stable detail codes in the existing UHP error shape. For pre-`ready` initialization failures, `retryable` means a new request/binding with the same descriptor may succeed; it never revives a failed binding. For post-`ready` collection/checkpoint failures, retry resumes the same `WorkspaceTurnCommit` and MUST NOT rerun the harness. Pre-`ready` failures omit snapshot metadata. Post-`ready` workspace failures return stored sanitized metadata except inherited `session_expired`.

| Detail code | HTTP | Retryable | Condition |
|---|---:|:---:|---|
| `workspace_snapshot_invalid_request` | 400 | no | Malformed/unknown fields, unsupported version/media type, bad digest/size, continuation injection, or other request-decidable violation. |
| `workspace_snapshot_unknown` | 404 | no | Exact descriptor is absent from the caller's authorized catalog view; hides whether it exists for another principal. |
| `workspace_snapshot_invalid` | 422 | no | Manifest, config, provenance, layer, path, link, type, working directory, final-tree, or signature verification failure. |
| `workspace_snapshot_retention_invalid` | 422 | no | Digest-covered/catalog retention is expired or cannot cover initialization deadline plus maximum session TTL plus safety margin; caller must publish a new snapshot. |
| `workspace_snapshot_unavailable` | 503 | yes | Bounded transient registry, DNS, transport, initialization-deadline failure, or an authorized manifest missing before its promised `available_until`. |
| `workspace_contract_limit_exceeded` | 413 | no | Fixed format count, byte, path, ratio, metadata, or file maximum exceeded. Timeouts do not use this code. |
| `workspace_capacity_exceeded` | 503 | yes | Operator disk, inode, worker, quota, or concurrency capacity unavailable. |
| `workspace_initialization_failed` | 500 | yes | Reflink/copy, staging publication, private-tree, baseline, or ready transition fails after valid artifact admission. |
| `session_expired` | 404 | no | Inherited UHP response when continuation targets a session at or after `expires_at`. |
| `workspace_restore_invalid` | 500 | no | Durable binding, checkpoint, cursor, or identity is missing, corrupt, or inconsistent. |
| `workspace_collection_failed` | 500 | yes | Manifest comparison or artifact persistence cannot complete; cursor and checkpoint do not advance. |
| `workspace_checkpoint_failed` | 500 | yes | Exact private-workspace checkpoint persistence fails; terminal response is not finalized. |

Cancellation is not a workspace error. Inherited idempotent cancellation and terminal `status: "cancelled"` remain. Cancellation before `ready` omits snapshot metadata; after `ready` it retains stored sanitized metadata.

## Upstream boundary

The upstream proposal is tracked in [HarnessRouter issue #304](https://github.com/HarnessRouter/harnessrouter/issues/304). It is an internal implementation seam, not a UHP Enhancement Proposal:

1. an optional operator-configured `WorkspaceInitializer` invoked once after an empty private session root exists and before input or harness start;
2. a pluggable `WorkspaceJournal` behind `/produced` and `/produced/ack`, with the gateway cursor as durable authority and current root Git as the default; and
3. a recoverable terminal-finalization seam that orders artifacts, journal ACK, checkpoint/cursor publication, and terminal response visibility.

The initializer receives one opaque immutable descriptor, verifies and materializes it atomically, and returns verified identity, relative working directory, initializer schema, and journal mode. It returns no source plan, credential, registry URL, host path, cache path, or mount identity. Requests without an initializer extension remain on the stock path.

Focused upstream tests must prove initialization-before-input, idempotent retry, descriptor replacement rejection, explicit cursor handoff, exact add/modify/delete journal behavior, capture-before-ACK, checkpoint/cursor durability before terminal visibility, continuation, fail-closed restore, and unchanged stock behavior.

Until upstream ships equivalent initializer, journal, and finalization seams, `allagents-gateway` carries the smallest downstream patch and maps every remaining delta explicitly. When upstream ships all required seams, forked implementations are deleted. The gateway then becomes a thin stock-derived distribution or, if external backend loading is supported, no source fork at all. `allagents-workspace-builder` remains unchanged.

## Distribution and release boundary

`allagentsdev/allagents-gateway` preserves the HarnessRouter fork network, full Git history, Apache-2.0 `LICENSE`, `NOTICE`, attribution, and upstream remote. The existing `feat/workspace-composition` branch MUST be replaced before implementation by a snapshot-specific branch based on current downstream `main`; obsolete runtime-composition code or aliases are not retained.

`allagentsdev/allagents-workspace-builder` is a separate AllAgents-owned repository with its own release cadence, threat model, credentials, and artifact-format compatibility tests. The cross-repository compatibility contract is the versioned OCI snapshot artifact, not source-level imports or a private RPC schema.

Before release, the target production filesystem is probed for same-filesystem reflink behavior and hard byte/inode quotas. Full-copy fallback is exercised even where reflink succeeds. The candidate supports only architectures explicitly built, preflighted, and tested; V1 MAY declare `linux/amd64` only.

Capability `allagents_workspace_snapshot_v1` remains disabled until every request-serving gateway and runner understands artifact, binding, journal, checkpoint, and finalization schema V1. Snapshot requests and bound continuations carry an internal minimum-reader version and route only to compatible replicas; incompatible replicas reject before hydrate. Rollback retains compatible readers until all snapshot sessions are deleted, or first makes those sessions unavailable and drains them before old code serves traffic.

Release proof runs against the exact published image digests and includes:

- stock UHP compatibility and both supported harnesses;
- snapshot cache miss/hit, attempted cache-path access from a session UID, concurrent singleflight, private-write isolation, limits, and malicious OCI fixtures;
- exact add/modify/delete artifacts, streamed artifact/hash binding, checkpoint/continuation, cancellation, expiry, deletion, and crash reconciliation;
- fresh-volume and same-volume restart during pending initialization, collection, journal ACK, checkpoint, ready execution, and deletion;
- an N-1-to-candidate upgrade plus proven compatible routing and rollback-or-drain fencing;
- repeated race-sensitive restart, cancellation, reference-release, turn-deletion, and cleanup cases against the exact digest;
- SBOM, build provenance, secret scan, and correlation-safe telemetry that never emits credentials, private registry paths, or workspace contents; and
- an upstream-intake record linking the proposed hook issue, maintainer decision, downstream delta, and removal trigger.

## Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Resolve Git and compose OCI sources inside AllAgents Gateway | Mixes product source credentials and policy with execution, enlarges the permanent fork, and makes failures part of task startup. |
| Keep preparation and execution in one source repository | Couples release and trust boundaries and makes returning to stock a source-tree surgery. |
| Upload a tar through stock `/hydrate` | Internal checkpoint route with no public OCI identity, authorization, provenance, cache, or exact multi-repository journal. |
| Make the agent clone repositories | Runs acquisition after harness start, exposes credentials/network policy to agent code, and cannot establish a trusted pre-turn baseline. |
| Use stock root Git as evaluator | Mutates a root repository, reports embedded repositories coarsely, and omits deletions. |
| Use read-only shared trees, hardlinks, or symlinks | Harnesses need a writable workspace; these mechanisms risk cache or sibling mutation. |
| Adopt OverlayFS and delta checkpoints in V1 | Expands hydrate, checkpoint, archive, Files, deletion, mount, and crash recovery before measured need. |
| Put provenance only in OCI referrers | Referrer associations are weak and do not contribute to admitted manifest identity. |
| Accept tags or indexes at execution | Selection can change independently of the request; execution requires one direct manifest. |
| Add a second public changes endpoint | Duplicates UHP Files/artifacts and bypasses capture-before-ack. |
| Upstream the AllAgents source descriptor | Git/OCI composition is product policy, not HarnessRouter execution infrastructure. |

## Consequences

The gateway becomes materially smaller: no Git client, source credential broker, per-component destination planner, or runtime composition state. Task startup sees one authorized immutable artifact and one private filesystem.

The builder takes on explicit distributed-system obligations: asynchronous build status when needed, complete-before-return publication, artifact retention, provenance, garbage collection, and a compatibility matrix with gateway snapshot versions.

V1 pays the I/O/storage cost of a private reflink/copy and full exact checkpoint. That cost is deliberate. It preserves ordinary-directory semantics and minimizes the downstream/upstream patch. Metrics determine whether a later ADR adopts OverlayFS or base-plus-delta checkpoints.

Promptfoo must retain or fetch the admitted snapshot baseline, then apply the initialization delta and ordered response deltas to reconstruct complete final state. These UHP artifacts do not replace baseline storage.

## Reconsider when

Revisit this decision if measurements show private clone or full checkpoint costs violate release SLOs; the production filesystem cannot provide correct reflink or bounded full-copy behavior; upstream rejects the required initialization, journal, and finalization seams and fork cost exceeds a standalone executor; the snapshot format cannot preserve required Git workflows safely; or a later UHP version standardizes an equivalent immutable workspace contract.
