# ADR 0002: Initialize HarnessRouter session workspaces from Git or OCI

- Status: Accepted
- Date: 2026-09-21
- Updated: 2026-09-27

## Context

Promptfoo needs a remote coding-harness endpoint that can prepare large repositories before the first turn, preserve their state across continuations, and expose exact source provenance through the Unified Harness Protocol (UHP).

HarnessRouter already owns the execution-plane lifecycle we need. Its runner materializes an existing per-session workspace either as a fresh workspace or by hydrating a checkpoint, and HarnessRouter already owns session identity, user and sandbox isolation, checkpoint transport, TTL, cancellation, files, artifacts, harness processes, and cleanup. The missing capability is narrower: on a first turn, initialize that runner-owned workspace from declared Git repositories or a verified OCI workspace snapshot before the harness starts.

The examined baseline is UHP [`2026-09-12`](https://github.com/HarnessRouter/harnessrouter/tree/5f82db1d1f13ea25b8ed0893c38b5b7d2e3e57e3/protocol/versions/2026-09-12) at HarnessRouter commit [`5f82db1d1f13ea25b8ed0893c38b5b7d2e3e57e3`](https://github.com/HarnessRouter/harnessrouter/commit/5f82db1d1f13ea25b8ed0893c38b5b7d2e3e57e3), released as [`v0.25.4`](https://github.com/HarnessRouter/harnessrouter/releases/tag/v0.25.4). UHP reserves `metadata` for additive extensions, but stock HarnessRouter gives arbitrary metadata no workspace-initialization semantics. The extension is therefore downstream HarnessRouter behavior until UHP governance standardizes an equivalent contract.

Large repositories are part of the minimum useful product, not a later optimization. Repository mode uses bounded shallow history to reduce Git history transfer, but that does not reduce a large working tree's transfer or extraction cost. OCI workspace snapshots and verified immutable-generation reuse solve that case and are therefore mandatory, release-blocking v1 capabilities alongside Git acquisition.

## Decision

We will keep [`allagentsdev/harnessrouter`](https://github.com/allagentsdev/harnessrouter) as the existing fork of [`HarnessRouter/harnessrouter`](https://github.com/HarnessRouter/harnessrouter), preserving its name, fork relationship, and history. We will extend HarnessRouter's existing session workspace initialization path in that fork. We will not create a parallel checkout service, a second workspace abstraction, a replacement repository, or a new protocol.

UHP remains the only northbound protocol. A first turn may add `metadata.workspace`; requests that omit it retain stock HarnessRouter behavior unchanged. The extension initializes the same workspace that HarnessRouter would otherwise create fresh. Continuations omit the extension and use HarnessRouter's existing checkpoint hydration and session lifecycle to recover the exact bound attachment.

V1 supports both of these source modes:

- one or more Git repositories placed at declared, pairwise non-overlapping destinations; and
- an operator-catalogued OCI workspace snapshot selected by direct immutable digests.

OCI is a source artifact for the workspace. It is not the HarnessRouter runtime image, a benchmark environment, a verifier, or a caller-selected container. There is no Git fallback for an OCI failure and no OCI fallback for a Git failure.

Implementation in the fork starts immediately. Opening an upstream issue, writing a UHP proposal, or waiting for an upstream decision is not an implementation or release gate. After the downstream implementation and release evidence prove the capability, we may propose the generic contract upstream. Until accepted upstream, releases must label `metadata.workspace` as a documented `allagentsdev/harnessrouter` extension rather than standard UHP behavior.

The supported harnesses remain **Codex** and **OMP**. Provider traffic continues through the separately operated OAuth-to-OpenAI-compatible gateway using HarnessRouter's brokered credentials. This decision adds no AllAgents CLI integration and changes no local project workspace configuration.

## Existing lifecycle and extension point

The fork must preserve the stock ownership boundary:

| Existing HarnessRouter responsibility | Extension responsibility |
|---|---|
| Allocate the session workspace and user/sandbox identity | Validate the first-turn workspace descriptor |
| Choose fresh materialization or checkpoint hydration | Resolve Git commits or exact OCI artifact identity |
| Transport and restore checkpoints | Build or reuse one verified immutable generation |
| Start the harness in the session workspace | Attach that generation read-only or as a private editable copy |
| Track sessions, TTL, cancellation, files, and cleanup | Persist source provenance and attachment identity with the session |
| Resume an existing session workspace | Verify and reuse the exact prior attachment without resolving source again |

For a new workspace-backed session, source initialization runs after
authentication, request validation, idempotency, session resolution, and
allocation of HarnessRouter's fresh session workspace, but before provider work
or harness execution. It attaches source content at the runner-designated
workspace root; it does not allocate another workspace root or move lifecycle
ownership out of HarnessRouter.

Stock HarnessRouter writes `.harness` state, generated instruction files,
plugins, skills, MCP configuration, HOME, and conversation state under the
workspace. That is incompatible with a shared read-only source mount. For
workspace-backed sessions, the fork creates a per-session writable control root
inside the existing session allocation but outside source content and redirects
all mutable harness/runtime state there. Generated instructions use a
harness-supported external instruction channel or non-shadowing session mount;
they never overwrite, overlay, or copy up a source path. If Codex or OMP cannot
honor that separation, the read-only release gate fails.

For continuation or recovery, workspace-aware checkpoint hydration first
restores and validates the minimal control metadata needed for attachment,
acquires and mounts the exact protected generation, then restores the remaining
session-local mutable state around it. The source initializer is not invoked.
Git refs are not resolved again, OCI is not fetched again, and a newer
generation is not substituted.

Workspace initialization reuses HarnessRouter's cancellation, process
containment, user isolation, quota, TTL, checkpoint transport, deletion, and
crash-recovery machinery. Source staging and immutable generations are internal
runner resources subordinate to that lifecycle, not caller-visible workspaces.

## Request contract

A workspace-backed first turn uses the normal UHP `POST /v1/responses` endpoint. `metadata.workspace` is first-turn-only and has no nested schema version.

Repository mode:

```json
{
  "model": "gpt-5.4",
  "input": "Implement the requested change.",
  "metadata": {
    "harness_id": "chrn_…",
    "workspace": {
      "access": "editable",
      "retention": "session",
      "source": {
        "kind": "repositories",
        "repositories": [
          {
            "url": "https://github.com/acme/api.git",
            "ref": "refs/heads/main",
            "destination": "services/api"
          },
          {
            "url": "https://github.com/acme/web.git",
            "destination": "services/web"
          }
        ]
      },
      "working_directory": "services/api/packages/server"
    }
  }
}
```

OCI snapshot mode:

```json
{
  "model": "gpt-5.4",
  "input": "Implement the requested change.",
  "metadata": {
    "harness_id": "chrn_…",
    "workspace": {
      "access": "read_only",
      "source": {
        "kind": "workspace_snapshot",
        "snapshot_name": "large-monorepo",
        "image_manifest_digest": "sha256:…",
        "workspace_manifest_digest": "sha256:…"
      },
      "working_directory": "packages/compiler"
    }
  }
}
```

`metadata.workspace` has exactly these fields:

| Field | Required | Contract |
|---|---:|---|
| `access` | yes | `read_only` or `editable`. |
| `retention` | no | `session` by default, or `persistent` when deployment policy authorizes it. |
| `source` | yes | Exactly one `repositories` or `workspace_snapshot` object as defined below. |
| `working_directory` | no | Workspace-relative POSIX directory. Omission means the workspace root. |

A repository source has exactly `kind: "repositories"` and `repositories`. The array contains 1 to 128 entries. Each entry has exactly:

| Field | Required | Contract |
|---|---:|---|
| `url` | yes | Canonical public HTTPS Git URL. No userinfo, query, fragment, local path, or alternate transport. |
| `ref` | no | Advertised full ref or unambiguous branch/tag shorthand. Omission uses the advertised remote default. The resolved commit, not the ref spelling, is authoritative. |
| `destination` | yes | Non-root, workspace-relative POSIX directory. Destinations must be unique, pairwise non-overlapping, and disjoint from runner-owned control paths. |

Depth is not caller-selectable. The repository acquisition policy defaults every entry to Git depth `2`; that effective depth is returned as provenance and participates in generation identity.

A snapshot source has exactly:

| Field | Required | Contract |
|---|---:|---|
| `kind` | yes | `workspace_snapshot`. |
| `snapshot_name` | yes | Selects an operator-owned catalog entry. It is not a registry repository or URL. |
| `image_manifest_digest` | yes | Direct `sha256:` digest of the accepted OCI image manifest. Mutable tags and indexes are not accepted as source identity. |
| `workspace_manifest_digest` | yes | `sha256:` digest of the canonical workspace manifest expected from that artifact. |

The OCI catalog is HarnessRouter deployment configuration owned by the operator. It maps `snapshot_name` to a fixed registry repository, allowed media types, trust policy, and server-side registry credential reference. A caller never supplies a registry origin, repository, tag, header, or credential.

`working_directory` is interpreted only after the verified tree exists. It must resolve, without symlink escape, to a real directory inside the workspace. Absolute paths, empty components, `.` or `..` components, platform-specific separators, and reserved control paths are invalid.

Unknown keys are rejected at every level. The descriptor cannot contain credentials, headers, host paths, environment variables, commands, runtime images, Docker settings, materializer selection, resource limits, provider routes, or caller-selected TTLs. Request size, string length, array length, nesting, and validation work are bounded before source access.
UHP input files are workspace mutations. They are accepted only for `editable`
workspaces, after the private copy exists and before the initial produced-file
baseline is sealed. A `read_only` first turn containing workspace input files
fails before source resolution. Harness assets, HOME, credentials, scratch, and
checkpoint control remain in runner-owned session paths outside immutable source
content in both modes.

A first turn may omit `metadata.workspace`; stock behavior then remains unchanged. A session created without workspace metadata cannot add it later. Any reused session selected through `previous_response_id` or HarnessRouter's existing session-recovery metadata must omit `metadata.workspace`, even if the repeated object is byte-for-byte identical.

## Response and provenance contract

After attachment reaches `ready`, terminal events, response retrieval, replay, and later terminal failures expose the same committed `metadata.workspace` object. All public fields use snake case.

Repository response:

```json
{
  "metadata": {
    "workspace": {
      "access": "editable",
      "retention": "session",
      "working_directory": "services/api/packages/server",
      "effective_descriptor_digest": "sha256:…",
      "generation_id": "sha256:…",
      "workspace_manifest_digest": "sha256:…",
      "provenance": {
        "kind": "repositories",
        "repositories": [
          {
            "url": "https://github.com/acme/api.git",
            "requested_ref": "refs/heads/main",
            "resolved_commit": "0123456789abcdef0123456789abcdef01234567",
            "destination": "services/api",
            "depth": 2
          },
          {
            "url": "https://github.com/acme/web.git",
            "resolved_commit": "89abcdef0123456789abcdef0123456789abcdef",
            "destination": "services/web",
            "depth": 2
          }
        ]
      },
      "expires_at": "2026-09-28T00:00:00Z"
    }
  }
}
```

Snapshot response:

```json
{
  "metadata": {
    "workspace": {
      "access": "read_only",
      "retention": "session",
      "working_directory": "packages/compiler",
      "effective_descriptor_digest": "sha256:…",
      "generation_id": "sha256:…",
      "workspace_manifest_digest": "sha256:…",
      "provenance": {
        "kind": "workspace_snapshot",
        "snapshot_name": "large-monorepo",
        "image_manifest_digest": "sha256:…",
        "workspace_manifest_digest": "sha256:…",
        "repositories": [
          {
            "destination": ".",
            "resolved_commit": "0123456789abcdef0123456789abcdef01234567",
            "object_set_digest": "sha256:…"
          }
        ]
      },
      "expires_at": "2026-09-28T00:00:00Z"
    }
  }
}
```

The response fields are exact:

| Field | Contract |
|---|---|
| `access` | Effective immutable access mode. |
| `retention` | Effective retention after authorization. It is never silently downgraded. |
| `working_directory` | Effective workspace-relative directory; the root is represented as `.`. |
| `effective_descriptor_digest` | Digest of the normalized first-turn descriptor, including applied defaults. |
| `generation_id` | Public content identifier for the verified immutable generation. It is not an authorization token or cache lookup key. |
| `workspace_manifest_digest` | Digest of the verified canonical source-visible manifest. |
| `provenance` | One of the exact source-mode objects below. |
| `expires_at` | Effective expiry timestamp for `session` retention, or `null` for authorized `persistent` retention. |

Repository provenance contains `kind: "repositories"` and the request-order `repositories` array. Each entry contains normalized `url`, `destination`, exact `resolved_commit`, effective `depth`, and `requested_ref` only when the request supplied `ref`. Branch or tag movement does not change stored provenance for an existing session.

Snapshot provenance contains `kind: "workspace_snapshot"`, `snapshot_name`, exact `image_manifest_digest`, exact `workspace_manifest_digest`, and a manifest-order `repositories` array. Each declared root contains `destination`; a history-bearing root additionally contains `resolved_commit` and `object_set_digest`. Tree-only roots contain neither. Snapshot provenance never exposes a registry origin, repository, credential reference, redirect, or physical path.

Failures before attachment reaches `ready` omit workspace metadata. Failures after `ready` return the complete committed object. Internal generation keys, policy versions, authorization scope, mount paths, attachment IDs, pins, leases, reservations, and other sessions' state remain private.

## Immutable generations and attachment behavior

Both source modes produce the same versioned canonical workspace manifest. It enumerates source-visible directories, regular files, and symbolic links in logical path order with normalized mode, size, content digest, or link target. HarnessRouter independently walks staging without following links, recomputes the canonical bytes, and requires the supplied and computed manifest digests to match before publication.

The runner computes a private generation key from every input that can change source bytes, filesystem semantics, or sharing authorization. For Git this includes the normalized repository URLs, resolved commits, destinations, shallow depth (`2` in v1), acquisition-policy revision, and materializer contract revision. For OCI it includes the catalog identity, exact image-manifest and workspace-manifest digests, trust-policy revision, and materializer contract revision. Access, retention, working directory, harness, session, and physical paths are excluded because they do not change the generation's immutable bytes. A later depth or acquisition-policy change therefore cannot reuse an incompatible Git generation.

Identical normalized source identity publishes exactly one live verified generation. The cache has two levels: an operator-only bare Git mirror/object cache per canonical repository URL for bounded acquisition, followed by an immutable multi-repository generation keyed by canonical URLs, exact resolved commits, destinations, depth, acquisition-policy revision, and materializer contract revision. Refreshes of one bare cache are serialized, and in-flight acquisition and generation misses singleflight by generation key. Publication is crash-safe: partial or failed staging is never attachable, and garbage collection cannot remove a generation while a build waiter, provisional pin, durable session reference, or attachment lease protects it.

Attachment depends on `access`:

- Every `read_only` Git request for the same normalized source identity leases and attaches the same cached immutable shallow-generation bytes; it never clones or copies that repository again. Every `read_only` OCI request for the same snapshot and generation identity likewise leases and attaches the exact digest-keyed generation. These sessions retain separate user and sandbox identity, checkpoint state, home, scratch space, control state, logs, outputs, and response state. Filesystem enforcement makes each attachment read-only; there is no copy-up path, and neither the generation backing store nor the writable acquisition cache is exposed to a session.
- `editable` sessions reuse the same acquisition cache and pinned verified generation as input, then receive a private, quota-bounded, inode-independent writable copy. No mutable inode may be shared with the generation, Git object cache, or another session. Later turns and checkpoints operate on that private copy.

An attachment binds the normalized descriptor, exact generation key and epoch, access, retention, working directory, selected harness, provenance, and manifest digest to the HarnessRouter session. Continuation reuses that exact attachment. It never re-resolves source, changes access or retention, selects another generation with the same public ID, or rebuilds missing state.

## Git acquisition and integrity

Repository content is untrusted. Repository mode has a fixed v1 acquisition policy: `depth = 2` for every repository. This is Git's depth semantics—the requested tip plus bounded reachable history—not a guarantee of exactly two total commits when the tip is a merge.

Git initialization must satisfy all of these requirements:

- Parse and authorize every URL before DNS or process launch. Only canonical public HTTPS origins are accepted. Revalidate every redirect; reject private, loopback, link-local, reserved, metadata-service, and otherwise disallowed addresses; pin approved addresses against DNS rebinding.
- Run Git without a shell, with a sanitized environment and isolated configuration. Disable interactive credentials, inherited proxy configuration, hooks, checkout filters, Git LFS hydration, submodule recursion, alternates, and non-HTTPS helpers and protocols.
- Resolve only an advertised branch, advertised tag, or advertised remote default to one exact commit before acquisition. Fetch that selected ref with `--depth=2`, then verify the fetched tip equals the previously resolved commit. Fetch and checkout commands must not substitute caller text for the resolved selection. If the remote cannot satisfy the bounded shallow fetch, fail; never silently deepen, unshallow, or fall back to a full clone.
- Keep one server-owned bare shallow Git mirror/object cache per canonical repository URL behind the generation builder so repeated acquisition can reuse fetched objects. The cache is mutable operator-only runner infrastructure, never a session attachment. Refreshes are serialized, and it is inaccessible to harness users, credentials, hooks, and workspace writes. Publication selects only the resolved ref's bounded object graph into the immutable generation; unrelated cached refs and objects are never exposed. The generation contains its own normalized shallow repository state, so later cache updates cannot change it.
- Preserve the generation's normalized `.git/shallow` metadata and the acquired recent history so offline commands such as `git log` and recent diffs work within the fetched boundary. Remove credential-bearing remotes, hooks, worktree links, alternates, replace and graft state, locks, reflogs, and transient fetch state. Verify detached `HEAD`, shallow boundary, index-to-tree equality, included object integrity, and source-visible content against the recorded commit and acquisition policy.
- Apply finite time, transferred-byte, inode, file-count, process, descendant, and concurrency limits across all repositories. Shallow depth reduces history transfer; it does not solve large working-tree transfer or materialization, which is why OCI snapshots remain mandatory.
- Stage every repository beneath its declared destination and reject overlaps, undeclared files, cross-root links, traversal, or reserved-path collisions. Publish the complete multi-repository generation atomically or publish nothing.
- Record normalized URL, optional requested ref, exact resolved commit, destination, and effective depth for every repository. A failure in any repository fails the whole source; partial repository sets are never attached.

## OCI acquisition and integrity

OCI snapshot support is mandatory in v1 and release-blocking. Snapshot acquisition must satisfy all of these requirements:

- Resolve `snapshot_name` only through the operator-owned catalog. Fetch only the direct image manifest named by `image_manifest_digest`; do not follow mutable tags, accept an index in its place, change registry authority on redirect, or expose catalog registry details to the caller.
- Verify the image manifest digest, media type, descriptor sizes, every selected layer digest and size, the catalog-defined workspace-manifest media type, the workspace-manifest blob digest, and the recomputed source-visible manifest digest.
- Enforce the v1 envelope before and during extraction: at most 64 distributable tar/gzip/zstd layers; a 4 MiB image manifest; a 128 MiB workspace manifest with at most 128 repository roots; 8 GiB total compressed layer bytes; 32 GiB expanded source bytes; 500,000 entries; 4 GiB per regular file; paths of at most 4096 UTF-8 bytes and 128 components; and 1 MiB per PAX or extended header. For each layer and for the aggregate artifact, expanded bytes divided by `max(compressed_bytes, 1)` must not exceed `100`. Cumulative-size and expansion-ratio checks apply while streaming, not only after extraction. Operators may configure lower limits, never higher ones without a contract revision.
- Apply layers in order with OCI whiteout and opaque-directory semantics. Whiteouts are metadata operations, not source-visible files. Reject malformed, duplicate, conflicting, or out-of-root whiteouts.
- Before writing each entry, validate its normalized relative path, type, declared size, mode, and link target. Reject absolute paths, traversal, NULs, escaping hard links or symbolic links, devices, sockets, FIFOs, sparse-file tricks, unsupported types, and entries that collide with runner-owned paths. Extraction uses rooted, no-follow operations and cannot write through a previously extracted link.
- Require the canonical workspace manifest to declare every source-visible entry and repository root. Undeclared output, missing entries, type changes, digest mismatches, and paths outside declared roots fail closed.

A workspace snapshot may contain normalized offline Git history for any declared repository root. A history-bearing root records `resolved_commit` and `object_set_digest`; a tree-only root records neither. History-bearing roots must have detached `HEAD` at the recorded commit, an index equal to that tree, the complete required object closure matching `object_set_digest`, and no dirty, staged, untracked, unreachable, or extra source-visible state. They must contain no remote, credential helper, config include, hook, worktree link, alternate, shallow, replace, graft, reflog, transient fetch state, or credential-bearing configuration. OCI restore never contacts Git, and failure of snapshot or embedded Git verification never falls back to cloning.

The direct image digest is part of OCI identity even when two artifacts have the same source-visible tree. Repacking layers or offline Git objects creates a different generation identity. Semantic verification proves an artifact's contents; it does not silently deduplicate distinct artifacts.

## Produced files, checkpoints, and continuation

HarnessRouter's existing Files API and produced-file collection remain the only
public file surface. The fork adapts the existing root-Git-oriented bookkeeping
rather than introducing a second Files API or parallel change tracker. It stores
workspace-backed cursors and indexes under the per-session control root; it does
not initialize or mutate a bookkeeping `.git` directory inside an immutable
generation.

Bookkeeping must understand the declared repository roots and source mode:

- Git repository roots compare editable state with their recorded resolved
  commits.
- History-bearing snapshot roots use their verified commit and object-set
  records.
- Tree-only snapshot roots compare with the canonical workspace manifest.
- Workspace paths outside declared repository roots use an external
  runner-owned baseline in the control root.
- Git control data, generation metadata, credentials, checkpoint control state,
  and runner-owned paths are never reported as produced files.

The adaptation must represent additions, modifications, deletions, renames, and
mode changes across multiple nested repository roots without assuming or
writing a single root `.git` directory. `read_only` attachments cannot produce
source mutations. Editable produced-file state and nested repository state are
covered by the session's private quota and lifecycle.

Checkpoint behavior is access-specific. A `read_only` checkpoint excludes the
generation mount and all source bytes; it persists session-local mutable state
separately from the exact generation-key, epoch, manifest, durable reference,
and attachment evidence. Hydration validates that minimal binding/control
metadata, reattaches the same protected generation, then restores the remaining
harness state before the turn. An `editable` checkpoint contains the private
workspace copy and its nested repository state, never the bare acquisition
cache or immutable generation backing store. Checkpoint creation must not run a
root Git commit against a read-only attachment.

A continuation supplies the existing predecessor/session reference and omits
`metadata.workspace`. HarnessRouter performs the access-specific hydration,
verifies the stored attachment evidence, and starts the stored harness in the
stored working directory. Edits from prior editable turns remain visible. A
changed ref, source digest, working directory, access, retention, or harness
requires a new session.

If attachment, generation, private-copy, checkpoint, or provenance evidence is expired, missing, corrupt, or inconsistent, continuation fails closed. It does not clone, repull, restore from OCI again, substitute another generation, or silently start a fresh session.

## Provider authentication and harness configuration

Provider authentication remains proxy-only. Each deployment configures one external OAuth-to-OpenAI-compatible gateway base URL and API key server-side. HarnessRouter represents that endpoint with two protocol-specific logical connections using the same secret: Responses for Codex and OpenAI Chat Completions for OMP. Each harness policy contains exactly its matching connection, with no fallback. The UHP caller cannot supply or override the endpoint, key, transport, or route.

The external OAuth gateway owns login, token persistence, refresh, repair, provider API compatibility, and provider authorization. HarnessRouter does not implement provider login, import local credentials, mount developer credential files, or coordinate provider token refresh. HarnessRouter's caller API key authenticates the UHP caller only and is never reused as a provider credential.

The deployment uses HarnessRouter's brokered sandbox mode, not owner-trust credential pass-through. The broker exchanges the long-lived external-gateway key server-side and gives each harness only a short-lived, session-scoped credential plus the loopback broker URL. The long-lived key never enters the harness process environment, session workspace, checkpoint, file output, artifact, log, response, or source provenance.

Codex uses the gateway's OpenAI Responses-compatible surface. OMP uses the same gateway's OpenAI Chat Completions-compatible surface. V1 custom harnesses are Codex and ordinary session-local OMP only. OMP starts from container/session configuration; it does not import AllAgents profiles, host profiles, or developer state.

## Failure behavior

The implementation fails closed without changing source mode, source identity, access, retention, harness, model route, or provider protocol as a recovery shortcut.

| Failure | Behavior |
|---|---|
| Malformed, oversized, too-deep, or unknown workspace field | Reject before source access and without mutating an existing session. |
| Workspace metadata on a continuation or reused session | Reject without changing the attachment, checkpoint, or TTL. |
| Workspace input files with `read_only` access | Reject before source resolution; never overlay or copy up immutable source. |
| Unauthorized `persistent` retention | Fail before source resolution; do not downgrade to `session`. |
| Invalid Git URL, ref, destination, network target, redirect, or feature | Fail the response, cancel bounded source work, and remove staging; do not start a harness or provider call. |
| Any repository in a multi-repository source fails | Fail the complete source; never attach a partial set. |
| Unknown snapshot, digest mismatch, mutable reference, disallowed registry transition, or unsupported media type | Fail OCI acquisition; do not try Git or another snapshot. |
| Layer limit, extraction violation, whiteout error, unsafe path/link/type, or manifest mismatch | Terminate extraction, quarantine or remove staging, and publish nothing. |
| Resource or concurrency capacity unavailable | Return a coded retryable capacity failure before unbounded acquisition. |
| Materializer timeout, crash, cancellation, or live descendant | Terminate and reap the complete process tree before cleanup and terminal acknowledgement. |
| Working directory missing, not a directory, or escaping by traversal/link | Fail before attachment and harness execution. |
| Crash during publication or attachment commit | Recover to either a complete verified attachment or no attachment; never expose partial staging. |
| Missing or corrupt bound state on continuation | Fail as non-resumable; never rematerialize or substitute. |
| External provider authentication or execution failure | Return the normalized UHP failure; do not switch endpoint, protocol, credential, or harness. |
| Cleanup failure | Quarantine and continue accounting for the allocation; retry the same idempotent cleanup path. |

Promptfoo treats every non-success as an evaluation error. It does not convert a workspace failure to an empty success, source fallback, or implicit retry.

## Fork, deployment, and release boundary

`allagentsdev/harnessrouter` remains the implementation and distribution repository and remains a GitHub fork of `HarnessRouter/harnessrouter`. The downstream patch extends the fresh-workspace initialization point, source provenance, generation storage, and existing produced-file bookkeeping while leaving UHP requests without `metadata.workspace` on stock paths.

The source initializers and generation manager ship inside the HarnessRouter image; they are not another network service. The supported deployment remains one HarnessRouter container with durable `/data`, loopback binding by default, and `HR_BACKENDS=codex,omp`.

The public image remains `ghcr.io/allagentsdev/harnessrouter`. Tags identify the upstream HarnessRouter baseline plus the downstream revision; deployments pin the resulting image manifest digest. Releases produce standard SBOM and build-provenance attestations and run the upstream UHP conformance suite against the built image.

Release verification must exercise both Codex and OMP through the configured external provider gateway. In addition, v1 cannot release without:

1. an end-to-end OCI test using at least 2 GiB of expanded source bytes and 100,000 source-visible filesystem entries that fetches by direct manifest digest, applies layers and whiteouts, verifies the workspace manifest and any offline Git history, starts a harness in `working_directory`, and continues the same session successfully; and
2. a cache-reuse proof showing that identical Git and OCI source identities publish once, concurrent cache misses singleflight, every concurrent or later `read_only` task/session leases the same immutable generation bytes without cloning or copying, read-only checkpoints contain no generation bytes or source Git writes, mutable harness state remains per-session outside source, `editable` sessions derive inode-independent copies from the pinned generation, unrelated bare-cache refs are not exposed, and continuation reattaches the exact generation without reacquisition.

These are release gates, not deferred performance tests. Git and OCI failure-path coverage must also prove that no partial generation or source-mode fallback becomes visible.

Downstream implementation and release do not wait on upstream work. Once downstream evidence exists, maintainers may propose the generic capability upstream. If upstream accepts an equivalent contract, the fork should remove the superseded patch and migrate cleanly; it must not retain conflicting aliases or claim downstream conformance before acceptance.

## Alternatives rejected

| Alternative | Why rejected |
|---|---|
| Build a new execution gateway | Duplicates HarnessRouter's UHP, sessions, workspace lifecycle, streaming, cancellation, files, artifacts, and harness supervision. |
| Put a workspace service in front of HarnessRouter | Splits source and session ownership and cannot safely participate in checkpoint hydration, continuation, or produced-file bookkeeping. |
| Create a second checkout root inside each session | Competes with the runner-owned workspace, duplicates cleanup and quota state, and makes files and checkpoints ambiguous. |
| Ship Git first and defer OCI | Fails the minimum large-repository use case and makes release viability depend on repeated acquisition. |
| Treat OCI as a runtime or benchmark image | Mixes source provenance with tools, services, verifier assumptions, and execution policy. |
| Wait for upstream before implementation | Makes delivery depend on a project we do not maintain and delays the evidence needed for a useful upstream proposal. |
| Add a general plugin or materializer framework | V1 has two explicit source modes and no demonstrated need for caller-selectable plugins. |
| Put source instructions in the prompt or a model tool | Makes acquisition model-dependent, non-deterministic, too late to set the initial directory, and unsafe for provenance. |
| Upload every source file through UHP | Pushes acquisition to callers and loses authoritative Git and OCI identity, history, links, and modes. |
| Make the AllAgents CLI the remote control plane | Couples local developer configuration to an independently deployed HarnessRouter service. |
| Add a new Files API for initialized workspaces | Duplicates HarnessRouter behavior instead of adapting its existing produced-file bookkeeping. |

## Deliberate v1 limits

V1 supports public HTTPS Git repositories acquired at fixed depth `2`, multiple pairwise non-overlapping destinations, advertised branch/tag/default refs, exact resolved-commit and effective-depth provenance, server-owned bare acquisition caches, operator-catalogued OCI snapshots selected by direct digests, optional normalized offline Git history, `read_only` and `editable` attachments, bounded `session` retention, authorized `persistent` retention, and a workspace-relative working directory.

V1 does not include caller-supplied registry origins or credentials, mutable OCI tags, OCI indexes as source identity, transparent Git/OCI fallback, caller-selected runtime images or benchmark environments, arbitrary materializer commands, private-network Git origins, caller-selected TTLs, session branching, access or retention changes on continuation, or public multi-tenant authorization. It does not add an AllAgents CLI command or change project workspace configuration.

Only Codex and OMP are required and release-validated. Other HarnessRouter backends, local-profile import, host-profile projection, provider-route override, automatic provider fallback, scoring, datasets, assertions, and evaluation-task orchestration are outside this decision.

## Consequences

HarnessRouter remains the sole execution, workspace, and session control plane. The fork gains deterministic first-turn source initialization without adding a new northbound API, process supervisor, checkpoint system, file service, or workspace lifecycle.

Mandatory OCI support and generation accounting make v1 more substantial than a Git clone hook, but they make the minimum large-repository use case viable. Shared immutable generations avoid repeated acquisition for `read_only` sessions; private inode-independent copies preserve isolation for `editable` sessions.

The operator assumes finite capacity management for staging, generations, editable copies, persistent sessions, tombstones, and quarantined deletion failures. Protected or uncertain state is never advertised as free capacity.

Provider credential lifecycle remains outside HarnessRouter. The distribution depends on the external OAuth-to-OpenAI-compatible gateway, while the harness sees only brokered short-lived credentials.

## Reconsider when

Revisit this decision if:

- UHP or upstream HarnessRouter adopts an equivalent workspace-source contract;
- HarnessRouter changes its fresh/checkpoint workspace lifecycle so the extension point no longer preserves one authoritative session workspace;
- the host cannot enforce immutable shared generations and inode-independent editable copies;
- large-repository OCI materialization or cache reuse cannot meet finite release limits;
- continuation and attachment recovery cannot fail closed without source reacquisition;
- source acquisition requires a stronger isolation boundary;
- public multi-tenancy or caller-owned private-source credentials become requirements;
- Codex or OMP can no longer use the external provider gateway's required compatible surface; or
- another UHP implementation offers a materially smaller and more stable integration surface.
