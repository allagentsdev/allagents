# ADR 0002: Adopt UHP through AllAgents Gateway with composable workspace sources

- Status: Accepted
- Date: 2026-09-21
- Updated: 2026-09-28

## Context

Promptfoo needs a remote coding-harness endpoint that can prepare large source trees before the first turn, preserve session state across continuations, and expose exact source provenance through the Unified Harness Protocol (UHP).

Upstream [`HarnessRouter/harnessrouter`](https://github.com/HarnessRouter/harnessrouter) already provides the execution-plane lifecycle we need: session identity, user and sandbox isolation, a private per-session workspace, checkpoint transport, TTL, cancellation, Files and artifact surfaces, harness supervision, and cleanup. The missing capability is first-turn initialization of that workspace from one or more independently identified Git or OCI source trees.

The examined upstream baseline is UHP [`2026-09-12`](https://github.com/HarnessRouter/harnessrouter/tree/5f82db1d1f13ea25b8ed0893c38b5b7d2e3e57e3/protocol/versions/2026-09-12) at HarnessRouter commit [`5f82db1d1f13ea25b8ed0893c38b5b7d2e3e57e3`](https://github.com/HarnessRouter/harnessrouter/commit/5f82db1d1f13ea25b8ed0893c38b5b7d2e3e57e3), released as [`v0.25.4`](https://github.com/HarnessRouter/harnessrouter/releases/tag/v0.25.4). UHP reserves `metadata` for additive extensions, but stock HarnessRouter gives arbitrary metadata no workspace-initialization semantics.

Large source trees are a minimum product requirement. Git depth `2` bounds history transfer but does not reduce working-tree transfer or extraction cost. OCI transport, immutable component caching, and cache reuse are therefore mandatory v1 capabilities rather than later optimizations.

## Decision

We will ship a downstream product named **AllAgents Gateway** in [`allagentsdev/allagents-gateway`](https://github.com/allagentsdev/allagents-gateway), distributed as `ghcr.io/allagentsdev/allagents-gateway` and deployed under the service name `allagents-gateway`. AllAgents Gateway is derived from upstream HarnessRouter, but it is not named HarnessRouter and must not imply that its downstream workspace extension is standard upstream behavior.

UHP remains the only northbound protocol. A first turn MAY add `metadata.workspace`. Requests without `metadata.workspace` MUST retain stock upstream UHP and HarnessRouter behavior. A continuation MUST omit the descriptor and recover the exact bound workspace state through the existing session and checkpoint lifecycle.

A workspace descriptor contains a closed, ordered `sources` array of 1 to 128 independent entries. Every entry materializes exactly one source tree at one required, pairwise non-overlapping, non-root `destination`. The array MAY contain multiple Git entries, multiple OCI entries, or any mixture in any order. A monorepo is one source tree and therefore one entry.

An OCI image is a source-tree transport and cache unit. It is never the runtime workspace, a runtime or benchmark image, a verifier, a caller-selected container, or a bundle of multiple workspace roots. Its source manifest describes paths relative to its one tree; only the request assigns that tree a destination. There is no Git fallback for an OCI failure and no OCI fallback for a Git failure.

All sources support the same `read_only` and `editable` access modes. `read_only` exposes immutable cached component roots through namespace-confined read-only bind mounts. `editable` gives the session inode-independent private writable copies or reflinks. An editable OCI source is fully writable and is the expected mode for bug-fix evaluations. Cached component generations remain immutable in both modes.

Every component publishes a canonical baseline source manifest. Workspace-backed evaluation and produced-file collection compare final filesystem manifests with those baselines; Git state is not an evaluation authority. Root Git, nested Git, commits, index state, and Git rename detection MUST NOT determine correctness for a workspace-backed session.

Implementation and release do not wait for an upstream issue or UHP proposal. After downstream evidence proves the capability, maintainers MAY propose the generic contract upstream. Until upstream accepts an equivalent contract, releases MUST identify `metadata.workspace` as an AllAgents Gateway extension.

The supported harnesses remain **Codex** and **OMP**. Provider traffic continues through the separately operated OAuth-to-OpenAI-compatible gateway using brokered credentials. This decision adds no AllAgents CLI integration and changes no local project workspace configuration.

## Upstream and downstream boundary

AllAgents Gateway MUST preserve the upstream remote, the recorded fork point, upstream history needed for attribution, the upstream MIT license and copyright notices, and downstream modification notices. The repository MUST keep `https://github.com/HarnessRouter/harnessrouter` as its upstream source of record. Upstream changes are reviewed and selectively integrated; the downstream repository is not a blind mirror, and incompatible upstream changes are not accepted merely to track the latest commit.

The downstream patch extends upstream fresh-workspace initialization, checkpoint hydration, source provenance, component storage, attachment, and produced-file bookkeeping. It does not create a second workspace service, replace UHP, or move session lifecycle ownership away from the inherited runner.

When upstream accepts equivalent behavior, AllAgents Gateway SHOULD remove superseded downstream code and migrate cleanly. It MUST NOT retain compatibility aliases, deprecated descriptor shapes, or conflicting schema variants.

## Existing lifecycle and extension point

| Inherited execution responsibility | AllAgents Gateway extension responsibility |
|---|---|
| Allocate the private writable session workspace and user/sandbox identity | Validate the first-turn descriptor and reserve every declared destination |
| Choose fresh materialization or checkpoint hydration | Resolve and acquire each exact source component |
| Transport and restore checkpoints | Cache components independently and compose them atomically |
| Start the harness in the private session workspace | Attach immutable roots or create private editable roots before execution |
| Track sessions, TTL, cancellation, files, and cleanup | Persist component provenance, baseline manifests, composition identity, and attachment evidence |
| Resume an existing writable session workspace | Restore outer and editable-root state and recover exact component bindings without source resolution |

For a new workspace-backed session, initialization runs after authentication, bounded request validation, idempotency handling, session resolution, and allocation of the private workspace, but before provider work or harness execution. The workspace root remains private and writable for both access modes. Sources occupy only their declared non-root destinations.

Destination ownership MUST be decidable from the request before DNS, Git, registry, or other source access. The gateway MUST reject root destinations, overlapping destinations, reserved paths, and every known input, generated asset, restored outer path, or runner-owned path that collides at or below a destination. Ancestor directories MAY be created as empty scaffolding, but MUST NOT contain a file or link that prevents safe attachment. Inputs and assets outside source roots remain allowed.

The outer workspace stores `.harness`, HOME, generated instructions, plugins, skills, MCP configuration, inputs, outputs, scratch, conversation state, and other session data outside source destinations. The extension does not allocate a second workspace root.

## Request contract

A workspace-backed first turn uses the normal UHP `POST /v1/responses` endpoint. `metadata.workspace` is first-turn-only and has no nested schema version.

This editable request composes two Git trees and one OCI tree. The OCI source is writable after attachment and can be modified by a bug-fix evaluation:

```json
{
  "model": "gpt-5.4",
  "input": "Implement the requested change.",
  "metadata": {
    "harness_id": "chrn_…",
    "workspace": {
      "access": "editable",
      "retention": "session",
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
        },
        {
          "kind": "git",
          "url": "https://github.com/acme/web.git",
          "destination": "services/web"
        }
      ],
      "working_directory": "services/api/packages/server"
    }
  }
}
```

`metadata.workspace` has exactly these fields:

| Field | Required | Contract |
|---|---:|---|
| `access` | yes | `read_only` or `editable`; it applies identically to every entry. |
| `retention` | no | `session` by default, or `persistent` when deployment policy authorizes it. |
| `sources` | yes | Closed ordered array containing 1 to 128 Git or OCI entries. |
| `working_directory` | no | Workspace-relative POSIX directory. Omission means the workspace root. |

A Git entry has exactly these fields:

| Field | Required | Contract |
|---|---:|---|
| `kind` | yes | `git`. |
| `url` | yes | Canonical public HTTPS Git URL. Userinfo, query, fragment, local path, and alternate transports are forbidden. |
| `ref` | no | Advertised full ref or unambiguous branch/tag shorthand. Omission selects the advertised remote default. The resolved commit is authoritative. |
| `destination` | yes | Non-root workspace-relative POSIX directory, pairwise non-overlapping with every other destination. |

Git depth is not caller-selectable. Every Git entry uses effective depth `2`, which is returned in provenance and participates in component identity.

An OCI entry has exactly these fields:

| Field | Required | Contract |
|---|---:|---|
| `kind` | yes | `oci`. |
| `snapshot_name` | yes | Operator-catalog key; it is not a registry repository or URL. |
| `image_manifest_digest` | yes | Direct `sha256:` digest of the accepted OCI image manifest. Tags and indexes are not source identity. |
| `source_manifest_digest` | yes | `sha256:` digest of the canonical manifest for the image's one relative source tree. |
| `destination` | yes | Non-root workspace-relative POSIX directory, pairwise non-overlapping with every other destination. |

The OCI catalog is operator-owned AllAgents Gateway configuration. It maps `snapshot_name` to a fixed registry repository, allowed media types, trust policy, and server-side credential reference. A caller never supplies a registry origin, repository, tag, header, redirect policy, or credential.

The order of `sources` is semantic and retained in provenance and composition identity. It does not define overlay precedence: destinations cannot overlap, and one source cannot mask another. Unknown keys MUST be rejected at every level. No deprecated spelling or alternate shape is accepted.

`working_directory` is interpreted only after all trees are attached or copied and allowed inputs are placed. It MUST resolve, without symlink escape, to a real directory inside the workspace. It MAY be inside a source tree or in the writable outer workspace. Absolute paths, empty components, `.` or `..` components, platform-specific separators, and reserved runner paths are invalid.

The descriptor cannot contain credentials, headers, host paths, environment variables, commands, runtime images, Docker settings, materializer selection, resource limits, provider routes, or caller-selected TTLs. Request size, string length, array length, nesting, and validation work MUST be bounded before source access.

UHP input files and generated assets remain ordinary outer-workspace mutations. For either access mode, any such path at or below a declared destination MUST fail during pre-network validation rather than overlaying, copying up, or modifying a source tree. Paths outside all source destinations remain allowed and are included in the sealed outer-workspace baseline.

A first turn MAY omit `metadata.workspace`; stock behavior then remains unchanged. A session created without workspace metadata cannot add it later. Any reused session selected through `previous_response_id` or existing recovery metadata MUST omit `metadata.workspace`, even if a repeated descriptor would be byte-for-byte identical.

## Response and provenance contract

After attachment reaches `ready`, terminal events, response retrieval, replay, and later terminal failures expose the same committed `metadata.workspace` response object. All public fields use snake case.

The response for the mixed request above is shaped as follows:

```json
{
  "metadata": {
    "workspace": {
      "access": "editable",
      "retention": "session",
      "working_directory": "services/api/packages/server",
      "effective_descriptor_digest": "sha256:3333333333333333333333333333333333333333333333333333333333333333",
      "composition_id": "sha256:4444444444444444444444444444444444444444444444444444444444444444",
      "sources": [
        {
          "kind": "git",
          "url": "https://github.com/acme/api.git",
          "requested_ref": "refs/heads/main",
          "resolved_commit": "0123456789abcdef0123456789abcdef01234567",
          "depth": 2,
          "destination": "services/api",
          "component_id": "sha256:5555555555555555555555555555555555555555555555555555555555555555",
          "source_manifest_digest": "sha256:6666666666666666666666666666666666666666666666666666666666666666"
        },
        {
          "kind": "oci",
          "snapshot_name": "compiler-tree",
          "image_manifest_digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111",
          "source_manifest_digest": "sha256:2222222222222222222222222222222222222222222222222222222222222222",
          "destination": "vendor/compiler",
          "component_id": "sha256:7777777777777777777777777777777777777777777777777777777777777777"
        },
        {
          "kind": "git",
          "url": "https://github.com/acme/web.git",
          "resolved_commit": "89abcdef0123456789abcdef0123456789abcdef",
          "depth": 2,
          "destination": "services/web",
          "component_id": "sha256:8888888888888888888888888888888888888888888888888888888888888888",
          "source_manifest_digest": "sha256:9999999999999999999999999999999999999999999999999999999999999999"
        }
      ],
      "expires_at": "2026-09-29T00:00:00Z"
    }
  }
}
```

The response fields are exact:

| Field | Contract |
|---|---|
| `access` | Effective immutable access mode. |
| `retention` | Effective retention after authorization; it is never silently downgraded. |
| `working_directory` | Effective workspace-relative directory; the workspace root is represented as `.`. |
| `effective_descriptor_digest` | Digest of the normalized first-turn descriptor, including applied defaults. |
| `composition_id` | Public identity of the ordered composition, derived from each exact `component_id` and its destination. It is not an authorization token or cache lookup key. |
| `sources` | Request-order closed provenance entries for every component. |
| `expires_at` | Effective expiry for `session` retention, or `null` for authorized `persistent` retention. |

A Git provenance entry contains normalized `url`, exact `resolved_commit`, effective `depth`, `destination`, `component_id`, `source_manifest_digest`, and `requested_ref` only when the request supplied `ref`. Branch or tag movement does not change stored provenance for an existing session.

An OCI provenance entry contains `snapshot_name`, exact `image_manifest_digest`, exact `source_manifest_digest`, `destination`, and `component_id`. It never exposes registry origin, repository, credential reference, redirect, backing path, layer-cache key, or physical mount path. OCI provenance has no implied Git commit and does not require Git metadata.

Failures before attachment reaches `ready` omit workspace response metadata. Failures after `ready` return the complete committed object. Private generation keys, policy versions, authorization scope, mount paths, attachment IDs, pins, leases, reservations, and other sessions' state are never exposed.

## Canonical manifests, identities, and caches

Each verified component publishes a versioned canonical source manifest keyed by normalized relative POSIX path. Every entry records its type, regular-file content digest, executable or normalized mode semantics, and symbolic-link target where applicable. Canonical ordering, encoding, path normalization, directory treatment, and supported file types are part of the manifest contract. The gateway walks staging without following links, recomputes canonical bytes, and records their digest before publication.

For Git, the gateway derives the canonical source manifest from the verified checkout. For OCI, the gateway MUST fetch and digest-verify `source_manifest_digest` before requesting any layer. That manifest describes only paths relative to the entry's single source root. The gateway validates all declared paths, types, sizes, modes, and links before layer requests, then requires extracted contents and recomputed canonical bytes to match it exactly before publication.

A private component key includes every input that can change component bytes, filesystem semantics, or sharing authorization. A Git key includes canonical URL, exact resolved commit, depth `2`, acquisition-policy revision, and materializer-contract revision. An OCI key includes catalog identity, exact image-manifest digest, exact source-manifest digest, trust-policy revision, and materializer-contract revision. Destination, array position, access, retention, working directory, harness, session, and physical paths are excluded from component identity because they do not change component bytes.

The component cache is independent for every entry. Git uses an operator-only bare mirror/object cache per canonical URL for bounded acquisition, followed by an immutable verified component generation. OCI uses verified blob/layer caches followed by an immutable verified component generation. Refreshes of a mutable acquisition cache are serialized. Concurrent misses singleflight by exact component key, not by the complete request.

A composition does not merge source bytes into another cached generation. Its identity commits to the ordered sequence of exact component identities and destinations. The gateway MAY acquire or reuse independent components concurrently, but it MUST reserve every component and attach or copy the full composition atomically. All destinations become visible to the session or none do. A failure or cancellation of one entry rolls back provisional mounts, copies, leases, and pins for the complete composition.

Publication is crash-safe. Partial staging is never attachable. Garbage collection MUST NOT remove an acquisition object or immutable component while a builder, waiter, provisional composition pin, durable session reference, or attachment lease protects it. A later acquisition, trust, or materializer policy revision cannot reuse an incompatible component.

## Attachment behavior

Attachment is uniform across Git and OCI:

- For `read_only`, the gateway creates empty destination directories in the private writable outer workspace and bind-mounts each immutable component root there. Matching sessions MAY share cached source bytes and immutable inodes while retaining separate outer state, user and sandbox identity, HOME, scratch, logs, outputs, checkpoints, and response state.
- Every source bind mount MUST be kernel-enforced read-only, namespace-confined, `nodev`, and `nosuid`, while preserving required execute bits. The session MUST have no writable alias or copy-up path to the generation or acquisition cache. A mount or remount failure fails closed.
- For `editable`, the gateway materializes a quota-bounded, inode-independent private writable copy or reflink of every pinned component at its destination. No mutable inode may be shared with a cached generation, acquisition cache, or another session. Git and OCI entries receive identical write semantics.

Bind mounts are required for shared read-only roots rather than symlinks. A symlink does not enforce read-only access, exposes a backing path, can escape workspace containment, and gives cwd and file tools surprising behavior. Mounted roots appear as ordinary directories at their declared destinations.

An attachment binds the normalized descriptor, ordered exact component keys and epochs, composition identity, access, retention, working directory, selected harness, destination map, provenance, canonical source-manifest digests, and evaluation baselines to the session. Continuation MUST reuse that exact attachment. It never re-resolves a Git ref, repulls OCI, changes access or retention, or substitutes another component with the same public identifier.

## Git acquisition and integrity

Git content is untrusted. Every Git entry uses depth `2`: the selected tip plus bounded reachable history, not necessarily exactly two total commits when the tip is a merge.

Git initialization MUST satisfy all of these requirements:

- Parse and authorize every URL before DNS or process launch. Accept only canonical public HTTPS origins. Revalidate every redirect; reject private, loopback, link-local, reserved, metadata-service, and otherwise disallowed addresses; pin approved addresses against DNS rebinding.
- Run Git without a shell, with a sanitized environment and isolated configuration. Disable interactive credentials, inherited proxies, hooks, checkout filters, Git LFS hydration, submodule recursion, alternates, and non-HTTPS helpers and protocols.
- Resolve only an advertised branch, tag, or remote default to one exact commit. Fetch that selection with `--depth=2`, then verify the fetched tip equals the resolved commit. Caller text MUST NOT be substituted into fetch or checkout commands. If the remote cannot satisfy the bounded shallow fetch, fail rather than deepen, unshallow, or clone fully.
- Keep the bare shallow acquisition cache mutable, operator-only, and inaccessible to harness users, credentials, workspace writes, and attachments. Publish only the selected bounded object graph into the immutable component; unrelated cached refs and objects MUST NOT be exposed.
- The published component MAY preserve normalized `.git/shallow` metadata and recent history for agent convenience. Remove credential-bearing remotes, hooks, worktree links, alternates, replace and graft state, locks, reflogs, transient fetch state, and unsafe configuration. Verify detached `HEAD`, shallow boundary, index-to-tree equality, included-object integrity, and source content against the resolved commit and canonical source manifest.
- Enforce finite time, transferred-byte, expanded-byte, inode, file-count, process, descendant, and concurrency limits independently for each Git entry and for the complete request.
- Reject undeclared output, traversal, unsafe links, reserved-path collisions, and any path that escapes its owning source root. A failed Git entry fails the complete composition; no partial set is attached.
- Record normalized URL, optional requested ref, exact resolved commit, effective depth, component identity, source-manifest digest, and destination.

Git metadata is acquisition evidence and MAY be useful to an agent. It is never the evaluator's diff engine. Its absence or mutation cannot change the baseline or final-tree comparison used to judge a workspace-backed evaluation.

## OCI acquisition and integrity

OCI support is mandatory and release-blocking. Each OCI entry transports exactly one relative source tree and MUST satisfy all of these requirements:

- Resolve `snapshot_name` only through the operator catalog. Fetch only the direct image manifest named by `image_manifest_digest`; do not follow a mutable tag, accept an index in its place, change registry authority on redirect, or expose registry details to the caller.
- Verify the image-manifest digest, media type, descriptor sizes, every selected layer digest and size, the catalog-defined source-manifest media type, the source-manifest blob digest, and the recomputed canonical source-manifest digest.
- Fetch and verify the canonical source manifest before any layer. Validate all relative paths and types plus every request-known input, asset, reserved-path, and restored-outer-state collision before any layer request or outer-workspace content write.
- Apply layers in order with OCI whiteout and opaque-directory semantics. Whiteouts are metadata operations, not source-visible files. Reject malformed, duplicate, conflicting, or out-of-root whiteouts.
- Before writing an entry, validate its normalized relative path, type, declared size, mode, and link target. Every hard link and symbolic link MUST remain within that OCI entry's one source root. Links into another source, the writable outer workspace, or an absolute path fail closed. Extraction uses rooted no-follow operations and cannot write through a previously extracted link.
- Reject traversal, NULs, devices, sockets, FIFOs, sparse-file tricks, unsupported types, undeclared entries, missing entries, type changes, digest mismatches, and writes outside the one declared tree.
- Publish only after the extracted tree exactly matches the canonical source manifest. Failure MUST NOT fall back to Git or another catalog entry.

The v1 envelope permits at most 64 distributable tar/gzip/zstd layers, a 4 MiB image manifest, a 128 MiB source manifest, 8 GiB compressed layer bytes, 32 GiB expanded source bytes, 500,000 entries, 4 GiB per regular file, paths of at most 4096 UTF-8 bytes and 128 components, and 1 MiB per PAX or extended header for one OCI entry. Expanded bytes divided by `max(compressed_bytes, 1)` MUST NOT exceed `100` for each layer and for the entry. Checks apply while streaming.

Finite time, bytes, entries, inodes, layers, processes, descendants, and concurrency are also bounded across the complete request, including mixed Git and OCI compositions. Per-entry success does not bypass request-aggregate limits. Operators MAY configure lower limits and MUST NOT raise contractual maxima without a contract revision.

An OCI tree need not contain `.git` or any other Git metadata. If such metadata is present, it is untrusted source content and optional agent convenience only; it conveys no implicit commit identity and is not used for evaluation diffs. Repacking layers produces a different OCI component identity even if canonical source-tree bytes are equal, because the exact image-manifest digest remains part of identity.

## Produced files and evaluation diffs

The inherited Files API and produced-file collection remain the only public file surface. AllAgents Gateway adapts that surface rather than adding another change API.

Before harness execution, the gateway seals:

1. the published canonical baseline source manifest for every attached component; and
2. a canonical baseline manifest of the writable outer workspace after allowed inputs and assets are placed, excluding every source destination and runner-owned state.

At collection time, the gateway computes final manifests for every editable source root and the writable outer workspace using the same canonical rules. A read-only source root remains equal to its pinned immutable baseline by construction; collection MUST NOT traverse through its mount into backing storage. The gateway compares baseline and final maps by normalized path and reports additions, modifications, deletions, executable or normalized-mode changes, symbolic-link target changes, and binary content changes. Content digests, rather than text decoding, determine equality.

Rename inference is OPTIONAL presentation metadata. Final-tree equality is authoritative: two sessions with the same included final path/type/mode/link/content maps are equivalent even if one report infers a rename and another reports delete-plus-add.

For workspace-backed sessions, the manifest comparison is the only correctness source. The collector MUST NOT consult root Git, nested Git, commits, index state, worktree status, staged state, or Git rename detection. It MUST NOT initialize or mutate a root `.git` repository. Stock root-Git behavior MAY remain only on requests that omit `metadata.workspace`.

The evaluation projection excludes `.git` trees, runner-owned state, credentials, caches, acquisition and generation metadata, attachment evidence, checkpoint metadata, and other internal control paths from reported changes. Those exclusions apply equally to Git and OCI roots and to outer-workspace bookkeeping. They do not weaken acquisition integrity checks.

A `read_only` attachment cannot produce source mutations, but files created or changed outside mounted roots are collected through the outer manifest. Editable Git and editable OCI changes are collected identically. All final state remains subject to the session's private quota and lifecycle.

## Checkpoints and continuation

Checkpointing is mount-aware and preserves outer state and editable roots separately.

A `read_only` checkpoint archives the writable outer workspace while excluding every source destination and all source bytes. It stores exact ordered component keys and epochs, composition identity, destination map, canonical baseline digests, durable references, and mount evidence as protected checkpoint metadata. Archive, Files, cleanup, and manifest operations MUST NOT follow or cross a source mount.

An `editable` checkpoint stores the writable outer workspace and each inode-independent private source root as separate logical checkpoint members, together with their canonical baselines and attachment evidence. It never stores the bare Git cache, OCI blob cache, immutable component backing store, credentials, or transient acquisition state. Separation prevents a restored outer archive from overwriting, omitting, or aliasing an editable root.

A continuation supplies the existing predecessor or session reference and omits `metadata.workspace`. The gateway first removes stale attachments, restores the writable outer state, and validates all destination mountpoints. For `read_only`, it then reattaches the exact protected components atomically. For `editable`, it restores each preserved private writable root at its exact destination. It verifies stored provenance, baselines, composition identity, and attachment evidence before starting the stored harness in the stored working directory.

Edits from prior editable turns and files written outside read-only roots remain visible. A changed ref, source digest, destination, source order, working directory, access, retention, or harness requires a new session. Continuation never clones, repulls, rematerializes from OCI, substitutes a newer component, or silently starts fresh.

Attachments are unmounted before hydration, deletion, workspace cleanup, or cleanup retry. If an unmount, component, private copy, checkpoint member, baseline, provenance record, pin, or lease is missing, busy, corrupt, expired, or inconsistent, continuation or cleanup fails closed and the allocation remains accounted for.

## Provider authentication and harness configuration

Provider authentication remains proxy-only. Each deployment configures one external OAuth-to-OpenAI-compatible gateway base URL and API key server-side. AllAgents Gateway represents that endpoint with two protocol-specific logical connections using the same secret: Responses for Codex and OpenAI Chat Completions for OMP. Each harness policy contains exactly its matching connection, with no fallback. A UHP caller cannot supply or override the endpoint, key, transport, or route.

The external OAuth gateway owns login, token persistence, refresh, repair, provider API compatibility, and provider authorization. AllAgents Gateway does not implement provider login, import local credentials, mount developer credential files, or coordinate provider token refresh. Its caller API key authenticates the UHP caller only and is never reused as a provider credential.

The deployment uses inherited brokered sandbox mode, not owner-trust credential pass-through. The broker exchanges the long-lived external-gateway key server-side and gives each harness only a short-lived, session-scoped credential plus a loopback broker URL. The long-lived key MUST NOT enter the harness environment, session workspace, checkpoint, file output, artifact, log, response, or source provenance.

Codex uses the gateway's OpenAI Responses-compatible surface. OMP uses its OpenAI Chat Completions-compatible surface. V1 custom harnesses are Codex and ordinary session-local OMP only. OMP starts from container and session configuration; it does not import AllAgents profiles, host profiles, or developer state.

## Failure behavior

The implementation fails closed without changing source identity, source kind, access, retention, harness, model route, or provider protocol as a recovery shortcut.

| Failure | Required behavior |
|---|---|
| Malformed, oversized, too-deep, unknown, or deprecated workspace field | Reject before source access and without mutating an existing session. |
| Workspace metadata on a continuation or reused session | Reject without changing attachment, checkpoint, or TTL. |
| Invalid, root, overlapping, or reserved destination | Reject the complete descriptor before network access. |
| Input, generated asset, or restored outer path collides at or below a destination | Reject before source access or outer-workspace mutation. |
| Unauthorized `persistent` retention | Fail before source resolution; do not downgrade to `session`. |
| Invalid Git URL, ref, network target, redirect, or feature | Fail the complete composition, cancel bounded work, and remove staging. |
| Unknown OCI catalog entry, digest mismatch, mutable reference, disallowed registry transition, or unsupported media type | Fail that component and therefore the complete composition; do not try Git or another artifact. |
| Layer limit, extraction violation, whiteout error, unsafe path/link/type, or source-manifest mismatch | Terminate extraction, quarantine or remove staging, and publish nothing. |
| Any source fails or aggregate capacity is exceeded | Roll back the complete composition; never attach a partial set. |
| Resource or concurrency capacity unavailable | Return a coded retryable capacity failure before unbounded acquisition. |
| Materializer timeout, crash, cancellation, or live descendant | Terminate and reap the complete process tree before cleanup and terminal acknowledgement. |
| Working directory missing, not a directory, or escaping through traversal or a link | Fail before attachment commit and harness execution. |
| Crash during component publication or composition commit | Recover to either a complete verified composition or no attachment. |
| Mountpoint non-empty or linked, or bind/remount/copy failure | Fail closed before harness execution; expose no partial or writable alias. |
| Missing or corrupt bound state on continuation | Fail as non-resumable; never reacquire or substitute. |
| External provider authentication or execution failure | Return the normalized UHP failure; do not switch endpoint, protocol, credential, or harness. |
| Cleanup or unmount failure | Quarantine and continue accounting for the allocation; retry the same idempotent unmount-then-cleanup path. |

Promptfoo treats every non-success as an evaluation error. It does not convert a workspace failure to an empty success, a source fallback, or an implicit retry.

## Distribution and release boundary

`allagentsdev/allagents-gateway` is the implementation and distribution repository. The source initializer, component caches, composition manager, manifest collector, and checkpoint adaptations ship in the AllAgents Gateway image; they are not another network service.

The supported deployment is one `allagents-gateway` service using `ghcr.io/allagentsdev/allagents-gateway`, durable `/data`, loopback binding by default, and the inherited Codex and OMP backend configuration. Deployments pin an exact image-manifest digest. Release tags identify both the upstream HarnessRouter baseline and downstream revision. Releases produce SBOM and build-provenance attestations and run the upstream UHP conformance suite against the built image.

A v1 release is complete only when all of the following are demonstrated:

1. Codex and OMP each complete and continue a session through the configured external provider gateway.
2. A mixed composition with multiple Git and multiple OCI entries resolves independent provenance, preserves request order, rejects every overlap before network access, and becomes visible atomically.
3. An OCI entry with at least 2 GiB of expanded source and 100,000 source-visible entries is fetched by direct image digest; its source manifest is verified before layers, layers and whiteouts are applied, the one relative tree is verified, and a harness starts inside it.
4. Identical Git and OCI component identities publish once and singleflight independently, while compositions reuse those components without constructing a request-wide cached tree.
5. Concurrent and later `read_only` sessions bind the same protected component inodes at their destinations, keep writable outer workspaces private, and never include mounted bytes in checkpoint or cleanup archives.
6. `editable` Git and OCI sessions receive inode-independent writable roots. An editable OCI bug-fix run modifies source, continues from a checkpoint, and reports the exact final filesystem change without Git metadata.
7. Manifest comparison proves add, modify, delete, executable/mode, symlink-target, and binary changes across multiple editable roots and the outer workspace. Altering Git commits, indexes, staged state, or rename detection cannot change the evaluated final-tree result.
8. Input and asset paths outside roots work normally; collisions at or below a destination fail before network access. OCI links escaping their owning root and mount failures fail closed.
9. Cancellation, failure, crash recovery, and aggregate-limit tests prove that no partial composition, stale pin, source-kind fallback, or unaccounted allocation becomes visible.
10. A request without `metadata.workspace` passes stock UHP behavior and conformance without invoking workspace acquisition or manifest-based workspace evaluation.

These are release gates, not deferred performance tests.

## Alternatives rejected

| Alternative | Why rejected |
|---|---|
| Keep the downstream product and image named HarnessRouter | Obscures which behavior is upstream and falsely suggests downstream extension conformance. |
| Build a new execution gateway from scratch | Duplicates UHP, sessions, workspace lifecycle, streaming, cancellation, files, artifacts, and harness supervision already inherited from HarnessRouter. |
| Put a workspace service in front of the gateway | Splits source and session ownership and cannot safely participate in checkpoint hydration, continuation, or produced-file collection. |
| Keep a mutually exclusive single source object | Prevents first-class mixed Git and OCI workspaces and couples unrelated source lifecycles and cache misses. |
| Let one OCI image declare multiple destination roots | Hides destination ownership until after network access, makes one artifact a multi-root workspace bundle, and prevents independent component caching. |
| Build one cached generation for the complete composition | Rebuilds and duplicates unchanged components whenever one entry or destination changes and singleflights at the wrong granularity. |
| Put source at the workspace root | Collides with runner-owned state, inputs, checkpoints, and the private writable outer workspace. |
| Attach shared source with symlinks | Does not enforce read-only access, exposes backing paths, permits containment escape, and gives cwd and file tools surprising behavior. |
| Share cached inodes with editable sessions | Lets one session mutate another session or the immutable cache and makes checkpoints non-isolating. |
| Use Git as the evaluation diff engine | Fails for OCI trees without Git, mishandles multiple roots and outer files, and lets mutable commits or index state redefine correctness. |
| Ship Git first and defer OCI | Fails the minimum large-source use case and makes release viability depend on repeated working-tree acquisition. |
| Treat OCI as a runtime or benchmark image | Mixes source provenance with tools, services, verifier assumptions, and execution policy. |
| Wait for upstream before implementation | Makes delivery depend on a project we do not maintain and delays evidence needed for an upstream proposal. |
| Add a general plugin or materializer framework | V1 has two explicit entry kinds and no demonstrated need for caller-selectable plugins. |
| Put acquisition instructions in the prompt or a model tool | Makes acquisition model-dependent, non-deterministic, too late to set the initial directory, and unsafe for provenance. |
| Upload every source file through UHP | Pushes acquisition to callers and loses authoritative Git and OCI identity, links, modes, and cache reuse. |
| Make the AllAgents CLI the remote control plane | Couples local developer configuration to an independently deployed service. |
| Add a second Files or changes API | Duplicates inherited behavior instead of adapting it around canonical filesystem manifests. |

## Deliberate v1 limits

V1 supports 1 to 128 ordered Git or OCI source entries at pairwise non-overlapping non-root destinations; public HTTPS Git at fixed depth `2`; advertised branch, tag, or default refs; operator-catalogued OCI images selected by direct digests; one relative source tree per OCI image; independent component caches; atomic composition; canonical source and outer-workspace manifests; private writable outer workspaces; read-only bind mounts or private editable copies; `session` and authorized `persistent` retention; and a workspace-relative working directory.

V1 excludes caller-supplied registry origins or credentials, mutable OCI tags, OCI indexes as source identity, OCI multi-root bundles, transparent source-kind fallback, caller-selected runtime images or benchmark environments, arbitrary materializer commands, private-network Git origins, caller-selected Git depth or TTL, session branching, access or retention changes on continuation, compatibility aliases, deprecated schemas, and public multi-tenant authorization. It adds no AllAgents CLI command and changes no local project workspace configuration.

Only Codex and OMP are required and release-validated. Other inherited backends, local-profile import, host-profile projection, provider-route override, automatic provider fallback, scoring, datasets, assertions, and evaluation-task orchestration are outside this decision.

## Consequences

AllAgents Gateway remains one execution, workspace, and session control plane while explicitly preserving its derivation from upstream HarnessRouter. UHP clients that do not request workspace initialization retain stock compatibility. The downstream product, repository, image, and service have one unambiguous identity.

Independent component caching makes mixed-source composition efficient and lets repeated requests reuse unchanged Git or OCI trees. Atomic composition and pre-network destination ownership add reservation and rollback complexity, but prevent partial or network-dependent workspace layouts.

Mandatory OCI support makes v1 more substantial than a Git clone hook, but it makes large-source evaluations viable. Read-only bind mounts share protected bytes without making the outer workspace read-only. Private writable copies give Git and OCI identical editable behavior, including OCI-backed bug-fix evaluations.

Canonical filesystem manifests add scanning and digest cost, but establish one source-kind-independent definition of final state. Evaluations no longer depend on whether Git metadata exists, whether an agent modified an index or commit, or whether rename inference agrees.

Checkpoint metadata and storage become root-aware: immutable roots are referenced, editable roots are preserved separately, and outer state remains independent. The operator assumes finite capacity management for acquisition caches, staging, immutable components, editable copies, persistent sessions, tombstones, and quarantined deletion failures. Protected or uncertain state is never advertised as free capacity.

Provider credential lifecycle remains outside AllAgents Gateway. The distribution depends on the external OAuth-to-OpenAI-compatible gateway, while each harness sees only a brokered short-lived credential.

## Reconsider when

Revisit this decision if:

- UHP or upstream HarnessRouter adopts an equivalent ordered multi-source contract;
- upstream workspace lifecycle changes so the extension point no longer preserves one authoritative session workspace;
- the host cannot enforce namespace-confined read-only bind mounts and inode-independent editable copies;
- large OCI materialization, canonical manifest comparison, or component cache reuse cannot meet finite release limits;
- continuation cannot fail closed without source reacquisition;
- source acquisition requires a stronger isolation boundary;
- public multi-tenancy or caller-owned private-source credentials become requirements;
- Codex or OMP can no longer use the external provider gateway's required compatible surface; or
- another UHP implementation offers a materially smaller and more stable integration surface.
