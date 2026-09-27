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
| Allocate the private, writable session workspace and user/sandbox identity | Validate the first-turn descriptor and reserve declared non-root source destinations |
| Choose fresh materialization or checkpoint hydration | Resolve Git commits or exact OCI artifact identity |
| Transport and restore checkpoints | Build or reuse one verified immutable generation |
| Start the harness in the private session workspace | Bind each generation repository root read-only, or populate an inode-independent editable copy |
| Track sessions, TTL, cancellation, files, and cleanup | Persist source provenance and attachment identity with the session |
| Resume an existing writable session workspace | Restore outer state and reattach the exact prior protected generation without resolving source again |

For a new workspace-backed session, source initialization runs after
authentication, request validation, idempotency, session resolution, and
allocation of HarnessRouter's fresh private session workspace, but before
provider work or harness execution. The workspace root remains private and
writable for both access modes. The initializer places source only at the
declared non-root repository destinations; it does not allocate another
workspace root or move lifecycle ownership out of HarnessRouter.

For `read_only`, the fork creates empty destination directories in the session
workspace and attaches the corresponding immutable-generation repository roots
with per-session, namespace-confined, read-only bind mounts. `.harness`, HOME,
generated instructions, plugins, skills, MCP configuration, inputs, outputs,
scratch, conversation state, and other session data continue to use ordinary
writable paths in the private workspace, provided they are outside mounted
source destinations. There is no requirement to relocate all mutable state to a
separate control root.

For continuation or recovery, workspace-aware checkpoint hydration unmounts
any stale attachment, restores the writable outer workspace without traversing
or restoring source destinations, validates empty non-link mountpoints, and
then reattaches the exact protected generation. The source initializer is not
invoked. Git refs are not resolved again, OCI is not fetched again, and a newer
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
      "working_directory": "repo/packages/compiler"
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
| `destination` | yes | Non-root, workspace-relative POSIX directory. Destinations must be unique, pairwise non-overlapping, and outside reserved runner paths. |

Depth is not caller-selectable. The repository acquisition policy defaults every entry to Git depth `2`; that effective depth is returned as provenance and participates in generation identity.

Every source composition occupies 1 to 128 declared repository roots. Whether
the roots come from repository request entries or a verified OCI workspace
manifest, their destinations are non-root, unique, and pairwise
non-overlapping. A monorepo therefore uses a destination such as `repo`, with a
working directory such as `repo/packages/compiler`; source at destination `.`
is invalid. Ancestor directories may be created as empty mount scaffolding, but
must contain no source files.

A snapshot source has exactly:

| Field | Required | Contract |
|---|---:|---|
| `kind` | yes | `workspace_snapshot`. |
| `snapshot_name` | yes | Selects an operator-owned catalog entry. It is not a registry repository or URL. |
| `image_manifest_digest` | yes | Direct `sha256:` digest of the accepted OCI image manifest. Mutable tags and indexes are not accepted as source identity. |
| `workspace_manifest_digest` | yes | `sha256:` digest of the canonical workspace manifest expected from that artifact. |

The verified canonical workspace manifest declares 1 to 128 repository roots
and their destinations under the same non-root and non-overlap rules. The
request cannot override those destinations.

The OCI catalog is HarnessRouter deployment configuration owned by the operator. It maps `snapshot_name` to a fixed registry repository, allowed media types, trust policy, and server-side registry credential reference. A caller never supplies a registry origin, repository, tag, header, or credential.

`working_directory` is interpreted only after the verified tree is attached or copied and input files are placed. It must resolve, without symlink escape, to a real directory inside the workspace; it may be within a declared source root or elsewhere in the writable outer workspace. Absolute paths, empty components, `.` or `..` components, platform-specific separators, and reserved runner paths are invalid.

Unknown keys are rejected at every level. The descriptor cannot contain credentials, headers, host paths, environment variables, commands, runtime images, Docker settings, materializer selection, resource limits, provider routes, or caller-selected TTLs. Request size, string length, array length, nesting, and validation work are bounded before source access.
UHP input files remain normal session-workspace mutations in both access modes.
They are placed before the initial produced-file baseline is sealed. In
`read_only` mode they may target writable outer-workspace paths, but any input
whose path is a declared source destination or lies beneath one fails rather
than overlaying, copying up, or modifying the mounted generation. Generated
instructions and other HarnessRouter assets follow the same boundary: they may
be written outside source destinations. In `editable` mode inputs may overlay
the private source copies before baseline.

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
      "working_directory": "repo/packages/compiler",
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
            "destination": "repo",
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

Snapshot provenance contains `kind: "workspace_snapshot"`, `snapshot_name`, exact `image_manifest_digest`, exact `workspace_manifest_digest`, and a manifest-order `repositories` array. Each declared root contains its non-root `destination`; a history-bearing root additionally contains `resolved_commit` and `object_set_digest`. Tree-only roots contain neither. Snapshot provenance never exposes a registry origin, repository, credential reference, redirect, backing path, or physical mount path.

Failures before attachment reaches `ready` omit workspace metadata. Failures after `ready` return the complete committed object. Internal generation keys, policy versions, authorization scope, mount paths, attachment IDs, pins, leases, reservations, and other sessions' state remain private.

## Immutable generations and attachment behavior

Both source modes produce the same versioned canonical workspace manifest. It
declares 1 to 128 non-root, pairwise non-overlapping repository roots and
enumerates the source-visible directories, regular files, and symbolic links
beneath them in logical path order with normalized mode, size, content digest,
or link target. HarnessRouter independently walks staging without following
links, recomputes the canonical bytes, and requires the supplied and computed
manifest digests to match before publication.

The runner computes a private generation key from every input that can change
source bytes, filesystem semantics, or sharing authorization. For Git this
includes normalized repository URLs, resolved commits, destinations, shallow
depth (`2` in v1), acquisition-policy revision, and materializer contract
revision. For OCI it includes catalog identity, exact image-manifest and
workspace-manifest digests, trust-policy revision, and materializer contract
revision. Access, retention, working directory, harness, session, and physical
paths are excluded because they do not change the generation's immutable bytes.
A later depth or acquisition-policy change therefore cannot reuse an
incompatible Git generation.

Identical normalized source identity publishes exactly one live verified
generation. The cache has two levels: one operator-only bare Git mirror/object
cache per canonical repository URL for bounded acquisition, followed by an
immutable multi-repository generation keyed by canonical URLs, exact resolved
commits, destinations, depth, acquisition-policy revision, and materializer
contract revision. Refreshes of one bare cache are serialized, and in-flight
acquisition and generation misses singleflight by generation key. Publication
is crash-safe: partial or failed staging is never attachable, and garbage
collection cannot remove a generation while a build waiter, provisional pin,
durable session reference, or attachment lease protects it.

Attachment depends on `access`:

- Every `read_only` Git request for the same normalized source identity, and
  every equivalent OCI request, leases the same immutable generation. For each
  declared root the runner creates an empty destination in the private writable
  session workspace and bind-mounts the matching generation directory there
  read-only. Matching sessions therefore see the same generation inodes and
  cached source bytes while retaining separate outer-workspace state, user and
  sandbox identity, HOME, scratch, logs, outputs, checkpoints, and response
  state.
- Each bind mount is kernel-enforced read-only, namespace-confined, `nodev`,
  and `nosuid`, while preserving repository execute bits required by tools.
  Neither a writable alias nor a copy-up path is visible to the session, and
  the generation backing store and writable acquisition cache remain
  inaccessible. Any mount or remount failure fails closed.
- `editable` sessions reuse the same acquisition cache and pinned verified
  generation as input, then receive an inode-independent, quota-bounded private
  writable copy at each declared destination. No mutable inode may be shared
  with the generation, Git object cache, or another session.

Bind mounts are required rather than symlinks. A symlink neither enforces
read-only access nor confines traversal to the workspace; it exposes a backing
path, can escape workspace containment, and gives cwd and file tools surprising
path behavior. The mounted roots instead appear as ordinary directories at the
declared workspace-relative destinations.

An attachment binds the normalized descriptor, exact generation key and epoch,
access, retention, working directory, selected harness, root-to-destination
attachment manifest, provenance, and workspace-manifest digest to the
HarnessRouter session. Continuation reuses that exact attachment. It never
re-resolves source, changes access or retention, selects another generation
with the same public ID, or rebuilds missing state.

## Git acquisition and integrity

Repository content is untrusted. Repository mode has a fixed v1 acquisition policy: `depth = 2` for every repository. This is Git's depth semantics—the requested tip plus bounded reachable history—not a guarantee of exactly two total commits when the tip is a merge.

Git initialization must satisfy all of these requirements:

- Parse and authorize every URL before DNS or process launch. Only canonical public HTTPS origins are accepted. Revalidate every redirect; reject private, loopback, link-local, reserved, metadata-service, and otherwise disallowed addresses; pin approved addresses against DNS rebinding.
- Run Git without a shell, with a sanitized environment and isolated configuration. Disable interactive credentials, inherited proxy configuration, hooks, checkout filters, Git LFS hydration, submodule recursion, alternates, and non-HTTPS helpers and protocols.
- Resolve only an advertised branch, advertised tag, or advertised remote default to one exact commit before acquisition. Fetch that selected ref with `--depth=2`, then verify the fetched tip equals the previously resolved commit. Fetch and checkout commands must not substitute caller text for the resolved selection. If the remote cannot satisfy the bounded shallow fetch, fail; never silently deepen, unshallow, or fall back to a full clone.
- Keep one server-owned bare shallow Git mirror/object cache per canonical repository URL behind the generation builder so repeated acquisition can reuse fetched objects. The cache is mutable operator-only runner infrastructure, never a session attachment. Refreshes are serialized, and it is inaccessible to harness users, credentials, hooks, and workspace writes. Publication selects only the resolved ref's bounded object graph into the immutable generation; unrelated cached refs and objects are never exposed. The generation contains its own normalized shallow repository state, so later cache updates cannot change it.
- Preserve the generation's normalized `.git/shallow` metadata and the acquired recent history so offline commands such as `git log` and recent diffs work within the fetched boundary. Remove credential-bearing remotes, hooks, worktree links, alternates, replace and graft state, locks, reflogs, and transient fetch state. Verify detached `HEAD`, shallow boundary, index-to-tree equality, included object integrity, and source-visible content against the recorded commit and acquisition policy.
- Apply finite time, transferred-byte, inode, file-count, process, descendant, and concurrency limits across all repositories. Shallow depth reduces history transfer; it does not solve large working-tree transfer or materialization, which is why OCI snapshots remain mandatory.
- Stage every repository beneath its declared non-root destination and reject overlaps, undeclared files, source files in destination ancestors, cross-root links, traversal, or reserved-path collisions. Publish the complete multi-repository generation atomically or publish nothing.
- Record normalized URL, optional requested ref, exact resolved commit, destination, and effective depth for every repository. A failure in any repository fails the whole source; partial repository sets are never attached.

## OCI acquisition and integrity

OCI snapshot support is mandatory in v1 and release-blocking. Snapshot acquisition must satisfy all of these requirements:

- Resolve `snapshot_name` only through the operator-owned catalog. Fetch only the direct image manifest named by `image_manifest_digest`; do not follow mutable tags, accept an index in its place, change registry authority on redirect, or expose catalog registry details to the caller.
- Verify the image manifest digest, media type, descriptor sizes, every selected layer digest and size, the catalog-defined workspace-manifest media type, the workspace-manifest blob digest, and the recomputed source-visible manifest digest.
- Fetch and verify the canonical workspace manifest before requesting any layer. Validate its effective repository-root map and every input, generated-asset, reserved-path, and restored-outer-state collision before any layer request or outer workspace content write.
- Enforce the v1 envelope before and during extraction: at most 64 distributable tar/gzip/zstd layers; a 4 MiB image manifest; a 128 MiB workspace manifest with at most 128 repository roots; 8 GiB total compressed layer bytes; 32 GiB expanded source bytes; 500,000 entries; 4 GiB per regular file; paths of at most 4096 UTF-8 bytes and 128 components; and 1 MiB per PAX or extended header. For each layer and for the aggregate artifact, expanded bytes divided by `max(compressed_bytes, 1)` must not exceed `100`. Cumulative-size and expansion-ratio checks apply while streaming, not only after extraction. Operators may configure lower limits, never higher ones without a contract revision.
- Apply layers in order with OCI whiteout and opaque-directory semantics. Whiteouts are metadata operations, not source-visible files. Reject malformed, duplicate, conflicting, or out-of-root whiteouts.
- Before writing each entry, validate its normalized relative path, type, declared size, mode, and link target. Every hard link or symbolic link must remain within its owning declared repository root; links into another source root or the writable outer workspace fail closed. Reject absolute paths, traversal, NULs, escaping links, devices, sockets, FIFOs, sparse-file tricks, unsupported types, and entries that collide with runner-owned paths. Extraction uses rooted, no-follow operations and cannot write through a previously extracted link.
- Require the canonical workspace manifest to declare every source-visible entry and 1 to 128 non-root, pairwise non-overlapping repository roots. Undeclared output, missing entries, type changes, digest mismatches, source at destination `.`, source files in destination ancestors, and paths outside declared roots fail closed.

A workspace snapshot may contain normalized offline Git history for any declared repository root. A history-bearing root records `resolved_commit` and `object_set_digest`; a tree-only root records neither. History-bearing roots must have detached `HEAD` at the recorded commit, an index equal to that tree, the complete required object closure matching `object_set_digest`, and no dirty, staged, untracked, unreachable, or extra source-visible state. They must contain no remote, credential helper, config include, hook, worktree link, alternate, shallow, replace, graft, reflog, transient fetch state, or credential-bearing configuration. OCI restore never contacts Git, and failure of snapshot or embedded Git verification never falls back to cloning.

The direct image digest is part of OCI identity even when two artifacts have the same source-visible tree. Repacking layers or offline Git objects creates a different generation identity. Semantic verification proves an artifact's contents; it does not silently deduplicate distinct artifacts.

## Produced files, checkpoints, and continuation

HarnessRouter's existing Files API and produced-file collection remain the only
public file surface. The fork adapts the stock root-workspace Git/bookkeeping
path rather than introducing a second Files API or parallel change tracker. The
outer session workspace stays writable, but root bookkeeping explicitly
excludes every declared source destination and must not traverse its mount.
Bookkeeping state remains in normal runner-owned session paths; it never
initializes or mutates a `.git` directory inside an immutable generation.

Bookkeeping understands the declared repository roots and source mode:

- Writable outer-workspace paths retain stock-like root bookkeeping, excluding
  all source destinations.
- Nested repository collectors compare editable Git roots with their recorded
  resolved commits, history-bearing editable snapshot roots with their verified
  commit and object-set records, and tree-only editable roots with the canonical
  workspace manifest.
- Read-only roots cannot change and are never traversed by root Git,
  produced-file scans, cleanup walks, or archive creation.
- Git control data, generation metadata, credentials, attachment evidence, and
  runner-owned checkpoint state are never reported as produced files.

The adaptation represents additions, modifications, deletions, renames, and
mode changes in the writable outer workspace and across multiple editable
nested repository roots without assuming one root `.git` directory. A
`read_only` attachment cannot produce source mutations, but files created
outside mounted roots are collected normally. Editable produced-file state and
nested repository state remain covered by the session's private quota and
lifecycle.

Checkpoint behavior is access-specific. A `read_only` checkpoint archives the
writable outer workspace while explicitly excluding every mount destination
and all source bytes. It stores the exact generation key and epoch, root
attachment manifest, workspace manifest, durable reference, and mount evidence
separately. Archive and file operations never follow or cross a source mount.
An `editable` checkpoint includes the inode-independent private source copies
and nested repository state, but never the bare acquisition cache or immutable
generation backing store.

A continuation supplies the existing predecessor/session reference and omits
`metadata.workspace`. HarnessRouter first unmounts any existing source
attachments, hydrates the writable outer state, validates that every declared
destination is an empty real directory rather than a link, and only then
reattaches the exact protected generation read-only. It verifies the stored
attachment evidence and starts the stored harness in the stored working
directory. Editable hydration restores its private copies instead. Edits from
prior editable turns and files written outside read-only roots remain visible.
A changed ref, source digest, working directory, access, retention, or harness
requires a new session.

Attachments are unmounted before hydration, deletion, workspace cleanup, or
retrying cleanup. Tar, Files API traversal, recursive cleanup, and root Git
operations must stay on the writable outer filesystem and never cross a mount.
If unmount, attachment, generation, private-copy, checkpoint, or provenance
evidence is expired, missing, busy, corrupt, or inconsistent, continuation or
cleanup fails closed and the allocation remains accounted for. Continuation
does not clone, repull, restore from OCI again, substitute another generation,
or silently start a fresh session.

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
| Input file targets a declared `read_only` source destination | Reject without overlay, copy-up, or source mutation; inputs outside mounted roots remain allowed. |
| Unauthorized `persistent` retention | Fail before source resolution; do not downgrade to `session`. |
| Invalid Git URL, ref, destination, network target, redirect, or feature | Fail the response, cancel bounded source work, and remove staging; do not start a harness or provider call. |
| Any repository in a multi-repository source fails | Fail the complete source; never attach a partial set. |
| Unknown snapshot, digest mismatch, mutable reference, disallowed registry transition, or unsupported media type | Fail OCI acquisition; do not try Git or another snapshot. |
| Layer limit, extraction violation, whiteout error, unsafe path/link/type, or manifest mismatch | Terminate extraction, quarantine or remove staging, and publish nothing. |
| Resource or concurrency capacity unavailable | Return a coded retryable capacity failure before unbounded acquisition. |
| Materializer timeout, crash, cancellation, or live descendant | Terminate and reap the complete process tree before cleanup and terminal acknowledgement. |
| Working directory missing, not a directory, or escaping by traversal/link | Fail before attachment and harness execution. |
| Crash during publication or attachment commit | Recover to either a complete verified attachment or no attachment; never expose partial staging. |
| Mountpoint is non-empty, is a link, or a bind/remount operation fails | Fail closed before harness execution; never expose a writable source alias or partial attachment. |
| Missing or corrupt bound state on continuation | Fail as non-resumable; never rematerialize or substitute. |
| External provider authentication or execution failure | Return the normalized UHP failure; do not switch endpoint, protocol, credential, or harness. |
| Cleanup or unmount failure | Quarantine and continue accounting for the allocation; never traverse the mount, and retry the same idempotent unmount-then-cleanup path. |

Promptfoo treats every non-success as an evaluation error. It does not convert a workspace failure to an empty success, source fallback, or implicit retry.

## Fork, deployment, and release boundary

`allagentsdev/harnessrouter` remains the implementation and distribution repository and remains a GitHub fork of `HarnessRouter/harnessrouter`. The downstream patch extends the fresh-workspace initialization point, source provenance, generation storage, and existing produced-file bookkeeping while leaving UHP requests without `metadata.workspace` on stock paths.

The source initializers and generation manager ship inside the HarnessRouter image; they are not another network service. The supported deployment remains one HarnessRouter container with durable `/data`, loopback binding by default, and `HR_BACKENDS=codex,omp`.

The public image remains `ghcr.io/allagentsdev/harnessrouter`. Tags identify the upstream HarnessRouter baseline plus the downstream revision; deployments pin the resulting image manifest digest. Releases produce standard SBOM and build-provenance attestations and run the upstream UHP conformance suite against the built image.

Release verification must exercise both Codex and OMP through the configured external provider gateway. In addition, v1 cannot release without:

1. an end-to-end OCI test using at least 2 GiB of expanded source bytes and 100,000 source-visible filesystem entries that fetches by direct manifest digest, applies layers and whiteouts, verifies the workspace manifest and any offline Git history, starts a harness in `working_directory`, and continues the same session successfully; and
2. a cache-reuse proof showing that identical Git and OCI source identities publish once, concurrent cache misses singleflight, every concurrent or later `read_only` task/session bind-mounts the same immutable generation inodes at its declared destinations without cloning or copying, the outer workspace remains private and writable, input and produced files outside source roots work normally, source-targeting inputs fail, mount failures fail closed, read-only checkpoints and Files/root-Git/cleanup traversal contain no generation bytes or source Git writes, `editable` sessions derive inode-independent copies from the pinned generation, unrelated bare-cache refs are not exposed, and continuation restores outer state before reattaching the exact generation without reacquisition.

These are release gates, not deferred performance tests. Git and OCI failure-path coverage must also prove that no partial generation or source-mode fallback becomes visible.

Downstream implementation and release do not wait on upstream work. Once downstream evidence exists, maintainers may propose the generic capability upstream. If upstream accepts an equivalent contract, the fork should remove the superseded patch and migrate cleanly; it must not retain conflicting aliases or claim downstream conformance before acceptance.

## Alternatives rejected

| Alternative | Why rejected |
|---|---|
| Build a new execution gateway | Duplicates HarnessRouter's UHP, sessions, workspace lifecycle, streaming, cancellation, files, artifacts, and harness supervision. |
| Put a workspace service in front of HarnessRouter | Splits source and session ownership and cannot safely participate in checkpoint hydration, continuation, or produced-file bookkeeping. |
| Create a second checkout root inside each session | Competes with the runner-owned workspace, duplicates cleanup and quota state, and makes files and checkpoints ambiguous. |
| Attach shared source with symlinks | Symlinks do not enforce read-only access, expose backing paths, can escape workspace containment, and behave inconsistently for cwd and file tools; namespace-confined read-only bind mounts present ordinary destination directories and fail closed. |
| Ship Git first and defer OCI | Fails the minimum large-repository use case and makes release viability depend on repeated acquisition. |
| Treat OCI as a runtime or benchmark image | Mixes source provenance with tools, services, verifier assumptions, and execution policy. |
| Wait for upstream before implementation | Makes delivery depend on a project we do not maintain and delays the evidence needed for a useful upstream proposal. |
| Add a general plugin or materializer framework | V1 has two explicit source modes and no demonstrated need for caller-selectable plugins. |
| Put source instructions in the prompt or a model tool | Makes acquisition model-dependent, non-deterministic, too late to set the initial directory, and unsafe for provenance. |
| Upload every source file through UHP | Pushes acquisition to callers and loses authoritative Git and OCI identity, history, links, and modes. |
| Make the AllAgents CLI the remote control plane | Couples local developer configuration to an independently deployed HarnessRouter service. |
| Add a new Files API for initialized workspaces | Duplicates HarnessRouter behavior instead of adapting its existing produced-file bookkeeping. |

## Deliberate v1 limits

V1 supports public HTTPS Git repositories acquired at fixed depth `2`, source placed under 1 to 128 pairwise non-overlapping non-root destinations, advertised branch/tag/default refs, exact resolved-commit and effective-depth provenance, one server-owned bare acquisition cache per canonical URL, operator-catalogued OCI snapshots selected by direct digests, optional normalized offline Git history, writable private session roots with `read_only` repository bind mounts or private `editable` copies, bounded `session` retention, authorized `persistent` retention, and a workspace-relative working directory.

V1 does not include caller-supplied registry origins or credentials, mutable OCI tags, OCI indexes as source identity, transparent Git/OCI fallback, caller-selected runtime images or benchmark environments, arbitrary materializer commands, private-network Git origins, caller-selected TTLs, session branching, access or retention changes on continuation, or public multi-tenant authorization. It does not add an AllAgents CLI command or change project workspace configuration.

Only Codex and OMP are required and release-validated. Other HarnessRouter backends, local-profile import, host-profile projection, provider-route override, automatic provider fallback, scoring, datasets, assertions, and evaluation-task orchestration are outside this decision.

## Consequences

HarnessRouter remains the sole execution, workspace, and session control plane.
The fork gains deterministic first-turn source initialization without adding a
new northbound API, process supervisor, checkpoint system, file service, or
workspace lifecycle. Each session keeps its private writable root; only
declared source roots participate in generation sharing.

Mandatory OCI support and generation accounting make v1 more substantial than
a Git clone hook, but they make the minimum large-repository use case viable.
Read-only bind mounts let matching sessions reuse the same protected generation
inodes without making harness state or outputs read-only. Private
inode-independent copies preserve isolation for `editable` sessions.
The operator assumes finite capacity management for staging, generations, editable copies, persistent sessions, tombstones, and quarantined deletion failures. Protected or uncertain state is never advertised as free capacity.

Provider credential lifecycle remains outside HarnessRouter. The distribution depends on the external OAuth-to-OpenAI-compatible gateway, while the harness sees only brokered short-lived credentials.

## Reconsider when

Revisit this decision if:

- UHP or upstream HarnessRouter adopts an equivalent workspace-source contract;
- HarnessRouter changes its fresh/checkpoint workspace lifecycle so the extension point no longer preserves one authoritative session workspace;
- the host cannot enforce namespace-confined read-only bind mounts for shared generations and inode-independent editable copies;
- large-repository OCI materialization or cache reuse cannot meet finite release limits;
- continuation and attachment recovery cannot fail closed without source reacquisition;
- source acquisition requires a stronger isolation boundary;
- public multi-tenancy or caller-owned private-source credentials become requirements;
- Codex or OMP can no longer use the external provider gateway's required compatible surface; or
- another UHP implementation offers a materially smaller and more stable integration surface.
