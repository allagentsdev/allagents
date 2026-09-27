---
title: "AllAgents Gateway v1 - Implementation Plan"
date: 2026-09-18
updated: 2026-09-27
type: feat
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
---

# AllAgents Gateway v1 - Implementation Plan

## Goal

Ship **AllAgents Gateway** as a small, maintainable downstream of HarnessRouter
that lets Promptfoo invoke Codex or OMP over UHP against a caller-selected public
Git repository.

The implementation repository is
[`allagentsdev/allagents-gateway`](https://github.com/allagentsdev/allagents-gateway).
Establish it by renaming the existing `allagentsdev/harnessrouter` GitHub fork,
not by creating a third repository or wrapping one repository with another. The
rename must preserve the fork relationship, commit history, issues, settings,
and a usable upstream remote.

The implementation starts from HarnessRouter v0.25.4 at commit
`5f82db1d1f13ea25b8ed0893c38b5b7d2e3e57e3` and keeps UHP
`2026-09-12` as the northbound protocol. The public image is
`ghcr.io/allagentsdev/allagents-gateway`, with versions and release notes that
are independent of the AllAgents npm CLI.

Version one adds one product behavior to stock HarnessRouter: on the first turn
of a session, recognize `metadata.allagents.workspace`, securely materialize one
public HTTPS Git repository into one private editable checkout, bind that exact
checkout to the session, and start the selected harness in the requested safe
working directory. A continuation reuses that checkout without resolving or
cloning again.

Everything else stays with HarnessRouter: caller authentication, UHP request and
response behavior, session hydration, streaming, idempotency, cancellation,
provider and harness execution, artifacts, and ordinary lifecycle state.

## Repository boundary

All production code, image construction, Compose configuration, Promptfoo
configuration, tests, and release automation land in
`allagentsdev/allagents-gateway`.

This `allagentsdev/allagents` repository remains the local Bun CLI. For v1 it
contains only the accepted ADR and this implementation plan. Specifically:

- no gateway server, materializer, image build, or provider adapter is added here;
- no `allagents gateway start` command is added;
- local profiles are not uploaded, synchronized, or translated into remote
  configuration;
- local `workspace.yaml`, its schema, and its behavior remain unchanged; and
- the gateway does not import an AllAgents host profile or invoke the AllAgents
  CLI.

HarnessRouter custom harness definitions are the complete remote configuration
surface for Codex and OMP. OMP runs as an ordinary session-local harness inside
HarnessRouter.

## Product boundary

### In scope

- UHP `2026-09-12`, exposed by the pinned HarnessRouter downstream.
- Caller authentication using HarnessRouter's existing API-key behavior.
- Exactly one workspace extension: `metadata.allagents.workspace`.
- Exactly one anonymous, public, HTTPS Git repository per new session.
- An optional advertised `refs/heads/*` or `refs/tags/*`, or unambiguous
  branch/tag shorthand. Omission means the remote default branch; raw object IDs
  and other ref namespaces are not accepted.
- SHA-1 repositories only, with resolution to and recording of one exact
  40-hex commit object ID.
- One private editable checkout per session.
- Immutable first-turn binding and exact-checkout continuation reuse.
- A finite server-owned idle TTL and deterministic, idempotent cleanup.
- Codex and OMP harnesses using one server-configured external
  OAuth-to-OpenAI-compatible gateway.
- One container, one `/data` volume, and Docker Compose startup bound to
  loopback by default.
- Direct Promptfoo evaluation of the built image.
- Upstream UHP conformance, image SBOM/provenance, and digest-pinned releases.

### Non-goals

- More than one repository, destination mapping, or repository composition.
- Non-Git workspace sources, private source credentials, SSH Git transports,
  or caller-provided source headers.
- Raw commit-ID requests and SHA-256 Git repositories.
- Read-only workspaces, cross-session workspace reuse, prewarming, or source
  object stores.
- Caller-selected lifetime, indefinite sessions, recovery after the configured
  expiry, or a new lifetime subsystem.
- A generic extension registry, plugin framework, or multiple materializers.
- Provider login, token refresh, credential repair, or credential projection in
  HarnessRouter. Those belong to the external provider gateway.
- A caller-selected provider base URL, provider API key, transport, or fallback
  chain.
- Importing local profiles, synchronizing profile state, changing
  `workspace.yaml`, or adding an AllAgents CLI command.
- Replacing HarnessRouter sessions, task execution, artifacts, streaming,
  cancellation, or idempotency.
- New validation commitments for other HarnessRouter backends.
- Kubernetes, multi-container worker orchestration, or a separately deployed
  materializer service.
- A custom release-attestation or green-build framework.

## External contracts

### UHP request

The workspace object is nested metadata, following HarnessRouter's existing
`metadata.systemone.script` precedent. It is not a flat metadata key.

```json
{
  "model": "gpt-5.4",
  "input": "Inspect the project and fix the failing command.",
  "metadata": {
    "harness_id": "allagents-codex",
    "allagents": {
      "workspace": {
        "version": "1",
        "repository": {
          "url": "https://github.com/example/project.git",
          "ref": "refs/heads/main"
        },
        "workingDirectory": "packages/service"
      }
    }
  }
}
```

The exact v1 JSON shape is:

```text
metadata.allagents.workspace = {
  version: "1",
  repository: {
    url: string,
    ref?: string
  },
  workingDirectory?: string
}
```

Rules:

1. `workspace` and `repository` must be JSON objects, not arrays or strings.
2. `version` is required and must equal `"1"`.
3. `repository.url` is required. It must be an anonymous public `https://` Git
   URL with no user info, query, fragment, alternate transport, or embedded
   credential.
4. `repository.ref` is optional and non-empty when present. It must be an
   advertised `refs/heads/*` or `refs/tags/*`, or unambiguous branch/tag
   shorthand. Raw object IDs and other ref namespaces are rejected. V1 accepts
   SHA-1 repositories only and records the exact resolved 40-hex commit as
   provenance.
5. `workingDirectory` is optional. Omission means the checkout root. When
   present it is a normalized, relative POSIX path to a directory within the
   checkout.
6. Unknown fields at every level are rejected. There are no aliases, commands,
   environment variables, access modes, lifetime fields, destination paths,
   materializer selectors, or provider settings.
7. The gateway applies a small fixed metadata byte/depth bound before session
   allocation. The materializer applies field-specific length bounds before
   network or filesystem work.
8. A request without `metadata.allagents.workspace` follows unmodified
   HarnessRouter behavior.

### Session binding and public provenance

After materialization, the session owns one immutable binding containing:

- canonical requested repository URL;
- requested ref, or an explicit record that it was omitted;
- exact resolved 40-hex commit;
- runner-owned session root under `/data`;
- private checkout root beneath that session root;
- separate runner control root as a sibling of the checkout;
- execution working directory beneath the checkout;
- materializer contract version;
- creation time and server-owned expiry; and
- cleanup state sufficient to make removal idempotent.

The checkout root and cleanup token are internal and must never appear in UHP
responses, streams, logs, or Promptfoo output. Successful responses expose the
stable portion as nested provenance:

```json
{
  "metadata": {
    "allagents": {
      "workspace": {
        "version": "1",
        "repository": {
          "url": "https://github.com/example/project.git",
          "requestedRef": "refs/heads/main",
          "resolvedCommit": "0123456789abcdef0123456789abcdef01234567"
        },
        "workingDirectory": "packages/service"
      }
    }
  }
}
```

If the ref was omitted, `requestedRef` is omitted rather than synthesized. The
same public provenance is returned on successful continuations and idempotent
response retrieval.

### Continuation

A continuation normally supplies only `previous_response_id`:

```json
{
  "previous_response_id": "resp_...",
  "input": "Now run the focused check and summarize the result."
}
```

HarnessRouter may also reuse a session through its existing
`metadata.session_id` recovery path. After session resolution, every reused
session rejects `metadata.allagents.workspace` regardless of which identifier
selected it. For a workspace-bound session, the stored binding and harness
select execution, and any caller-supplied harness must match exactly; the gateway
rejects a mismatch before Git, hydration, or provider work. A reused session
without an AllAgents binding and without workspace metadata retains pinned
upstream routing behavior.

A valid workspace continuation reuses the exact checkout, control root, and
execution working directory. A missing, expired, cleaned, or mismatched checkout
fails closed; it is never silently cloned again.

### Provider and harness contract

The deployment defines two protocol-specific HarnessRouter connections that
point to the same existing OAuth gateway and use the same server-side base URL
and API-key secret:

- a Responses-format connection used only by Codex; and
- an OpenAI Chat Completions connection used only by OMP.

This is one external provider route with two HarnessRouter protocol adapters,
not two credential authorities. The OAuth gateway owns user login, upstream
token storage, refresh, and repair.

- A new session selects only an allowed `metadata.harness_id` and model.
- A reused workspace-bound session derives its harness from stored session
  state; a supplied mismatch fails before execution. Unbound sessions retain
  upstream routing.
- Each custom harness has an explicit model allowlist and a one-entry provider
  policy pointing to its protocol-specific connection.
- There is no fallback connection or automatic transport switching.
- Provider base URL, API key, transport, headers, and model mapping cannot be
  supplied in UHP input or workspace metadata.
- Provider failure is returned as ordinary HarnessRouter/UHP failure. It never
  changes workspace or routing state.
- HarnessRouter runs in brokered sandbox mode. The harness receives a
  short-lived session-scoped credential and loopback broker URL, never the
  long-lived external-gateway key. The scoped credential exists only for the
  active turn and is removed before checkpointing or public file collection.

## Security and resource invariants

These are release requirements, not later hardening:

1. **URL and DNS:** accept only public HTTPS destinations. Reject loopback,
   link-local, private, carrier-grade NAT, documentation, multicast, reserved,
   and otherwise non-public IPv4/IPv6 results. Validate every DNS answer before
   connection, pin the validated address for that hop, revalidate every redirect,
   and cap redirects. A public name that resolves to any forbidden address
   fails closed.
2. **Git protocols:** disable `file`, `ssh`, `git`, `ext`, and helper-driven
   alternate protocols. Clear inherited Git configuration and credential
   helpers. Set terminal prompting off. Requests never provide credentials.
3. **Repository execution:** disable repository hooks and clean/smudge/process
   filters. Do not initialize submodules. Detect and reject gitlinks and Git LFS
   pointer-backed content rather than executing helpers or returning a partial
   workspace as complete.
4. **Filesystem confinement:** each runner-owned session root has separate
   checkout and control children. Build the checkout in sibling staging, then
   publish it into an absent checkout target. Keep harness home, credentials,
   scratch, skills, and runner state in the control root. Reject absolute paths,
   `..`, empty segments, NUL, platform separator ambiguity, and symlinks that
   escape the checkout. The execution working directory must exist beneath the
   checkout and never changes the control root.
5. **Exact provenance:** resolve the requested ref, fetch the corresponding
   commit, detach checkout at that commit, and verify `HEAD` equals the recorded
   object ID before publication. Ref movement after resolution cannot change the
   bound checkout.
6. **Bounds:** enforce server-owned limits for request bytes, ref and path
   lengths, clone/fetch duration, materialized bytes, inodes, process output,
   concurrent materializations, active harness time, and idle checkout TTL.
   Limits apply during work, not only after completion.
7. **Process control:** run Git and materializer children in a cancellable process
   group with a minimal environment, bounded stdout/stderr capture, and a hard
   termination deadline. Cancellation must stop descendants.
8. **Publication:** a workspace-aware first hydrate creates an isolated empty
   session root without stock Git initialization or other files in the checkout
   target. Materialize and validate in sibling staging, persist a pending
   reservation, atomically publish staging as the checkout child, create the
   separate control child, then commit the usable binding. Startup cleanup
   removes abandoned staging, pending reservations, and published-but-unbound
   roots. A harness cannot observe staging or a partially validated tree.
9. **Isolation:** never bind one session to another session's checkout. Each
   first turn creates a new private checkout even when URL, ref, and resolved
   commit are identical.
10. **Cleanup:** removal is safe to repeat, never follows links, is confined to
    the recorded session root, and cannot remove another session's data.
11. **Provider secrets:** `HR_SANDBOX_TRUST=owner` is forbidden. The local
    HarnessRouter broker must exchange a scoped turn credential for the real
    external-gateway key. The long-lived key never enters the harness
    environment or filesystem. Generate any CLI credential config in a
    per-turn ephemeral control subtree, explicitly exclude it from checkpoints
    and public file/artifact APIs, and delete it before terminal persistence.
    Neither long-lived keys nor scoped broker tokens may survive in a
    checkpoint, session file, artifact, stream, response, or log.

## Workstreams and implementation phases

The phases are ordered by dependency. Each phase ends with observable behavior;
implementation does not advance on the strength of source inspection alone.

### Phase 1: Establish the downstream repository and immutable pins

**Outcome:** `allagentsdev/allagents-gateway` is the sole implementation
repository and can reproduce the examined HarnessRouter baseline.

Work:

1. Rename the existing GitHub fork `allagentsdev/harnessrouter` to
   `allagentsdev/allagents-gateway`. Preserve its upstream fork relationship,
   branches, history, issues, rules, secrets, and package/container permissions.
2. Set `HarnessRouter/harnessrouter` as the documented upstream remote and record
   the baseline commit
   `5f82db1d1f13ea25b8ed0893c38b5b7d2e3e57e3` / v0.25.4 in release automation.
3. Keep the downstream patch series reviewable: baseline sync commits are
   separate from AllAgents behavior commits, and upstream merges never combine
   with feature changes.
4. Pin UHP `2026-09-12`; the base image by manifest digest; Codex and OMP runtime
   versions; system packages that affect Git/materialization; and every CI action.
   No `latest`, floating branch, or unbounded package range may enter a release.
5. Add an exact Promptfoo development dependency and committed lockfile in this
   repository. Promptfoo is an image consumer, not a service dependency.
6. Rename image/repository references and release coordinates to
   `ghcr.io/allagentsdev/allagents-gateway`. Do not reuse the AllAgents npm
   version or publish under the old image name.
7. Capture an upstream-diff check in CI so every release identifies the baseline
   and downstream commits included in the image.

Behavior-focused proof:

- a clean checkout builds the same downstream commit from recorded pins;
- repository links, image labels, and release metadata identify
  `allagentsdev/allagents-gateway` and the pinned upstream commit; and
- changing a pin or lockfile is visible as a reviewed source diff.

Exit gate: the renamed repository builds the unchanged pinned HarnessRouter
image before workspace behavior is introduced.

### Phase 2: Define and enforce the exact workspace schema

**Outcome:** the gateway recognizes only the bounded v1 object and ordinary UHP
requests remain stock behavior.

Primary area: `gateway/app.py` and focused gateway tests.

Work:

1. Parse nested `metadata.allagents.workspace` on initial Responses requests.
   Leave handling of unrelated metadata unchanged.
2. Apply generic byte/depth bounds before response/session allocation.
3. Strictly validate the exact request schema defined above, including unknown
   field rejection and normalized relative working-directory rules.
4. Extend session resolution to return whether it created or reused a session.
   Store the canonical descriptor only when the resolver proves the session is
   new. Use one canonical serialization and digest so idempotent replay cannot
   create a second binding.
5. Reject workspace metadata for every reused session, whether selected through
   `previous_response_id` or `metadata.session_id`, before Git, hydration,
   runner, or provider work.
6. For a reused workspace-bound session, derive the harness from stored state
   and reject a caller-supplied mismatch before hydration. Leave reused unbound
   sessions on the pinned upstream routing path.
7. Map schema and reuse failures into stable UHP errors with the offending
   parameter named. Do not expose Python exceptions or internal paths.
8. Keep requests without the object on the untouched upstream path.

Acceptance examples:

| Case | Observable result |
|---|---|
| Valid URL only | Accepted; checkout root becomes effective working directory |
| Valid URL, ref, and nested directory | Accepted; values reach the single workspace hook |
| Flat `metadata["allagents.workspace"]` | Rejected as not the v1 extension |
| Missing URL, unknown field, array, or non-string field | 400 before materialization |
| Absolute or parent-traversing working directory | 400 before materialization |
| Continuation containing a workspace object | 409 before materialization |
| Existing `metadata.session_id` plus workspace object | 409 before materialization |
| Workspace-bound session with a different `harness_id` | 409 before hydration |
| No workspace object | Same status, response, and runner path as pinned upstream |

Tests must assert the HTTP/UHP contract and absence of materializer/provider
activity, not internal helper calls or field-copy plumbing.

### Phase 3: Add the workspace-aware hydrate and runner seam

**Outcome:** one workspace-specific path prepares the runner allocation after
session resolution and before provider or harness execution, while ordinary
sessions keep the pinned path.

Primary areas: `gateway/app.py`, `runner/server.py`, their existing transport,
and focused integration tests.

Work:

1. Extend the existing gateway-to-runner turn envelope with an optional canonical
   workspace descriptor for a first turn and an optional hydrated workspace
   binding for a continuation. Do not add a public endpoint.
2. Add a workspace-aware first-hydrate mode that performs the existing
   isolation/wipe and ownership setup but leaves an empty session root with an
   absent checkout child. It must not run stock `_git_ensure`, write
   `.gitignore`, apply input files, or create harness state before publication.
3. Define one runner-owned materializer interface with two operations:
   `materialize(firstTurnDescriptor, checkoutTarget, limits, cancellation)` and
   `cleanup(binding)`. There is one configured implementation in v1 and no
   registration mechanism.
4. Keep four distinct values in the binding: session root, checkout root,
   control root, and execution working directory. The execution directory must
   be a no-follow validated descendant of the checkout; the control root must be
   a sibling outside repository content.
5. After materialization succeeds, complete the
   pending-reservation/publication transition, create the control root, then
   atomically commit the usable binding and public provenance.
6. On continuation, hydrate the bound session root and verify all stored roots
   before use. Do not resolve, fetch, checkout, or validate caller workspace
   metadata again.
7. Adapt the existing runner plumbing to explicit roots: spawn the harness in
   the execution working directory; anchor durable HOME, scratch, skills, and
   CLI state in the control root; and scope input files, produced-file Git
   diffing, file APIs, and artifacts to the checkout. Generate credential-bearing
   CLI config only in a per-turn ephemeral control subtree, delete it before
   checkpointing, and exclude it defensively from checkpoint and public-file
   walkers. Checkpoint the remaining session root. Do not initialize an outer
   Git repository or overwrite the source repository's `.gitignore`.
8. Make the first-turn transition idempotent. Same-key replay returns the owning
   response/binding. A competing request cannot materialize or bind a second
   checkout for the same session.
9. Preserve pinned behavior for non-workspace requests and unbound
   continuations. Preserve existing streaming, cancellation, terminal-state,
   and provider-error ordering around the workspace path.
10. Ensure workspace failures terminate before the provider receives a request.

The seam is intentionally workspace-specific. It does not generalize arbitrary
metadata into runner callbacks and does not introduce extension discovery,
capabilities negotiation, plugin loading, or hook chaining.

Acceptance examples:

- a probe harness sees a committed file from the repository on its first
  instruction;
- a nested `workingDirectory` becomes process cwd while HOME and `.harness`
  state remain outside the checkout;
- source-controlled `.harness` paths and `.gitignore` cannot collide with or
  rewrite runner state;
- materializer failure produces no provider request, agent process, or published
  checkout;
- restart and continuation restore both checkout mutations and control state;
- same-key replay owns one checkout; and
- an ordinary non-workspace request exercises the unchanged upstream sequence.

### Phase 4: Implement the Git materializer

**Outcome:** the in-image materializer produces one verified private checkout and
returns a binding only after all safety and resource checks pass.

Suggested home: a small `runner/allagents_workspace/` package plus a single
in-image executable entry point. Reuse HarnessRouter's process, cancellation,
logging, and session identity primitives instead of creating a daemon.

Work:

1. Define typed internal request/result/error records matching the runner seam.
   The result contains the internal checkout root, validated execution directory,
   and safe public provenance; errors never contain secrets or uncontrolled Git
   output.
2. Canonicalize and authorize the HTTPS URL before running Git. Implement the
   DNS, redirect, IP-range, and protocol rules as one acquisition path used by
   ref resolution and fetch.
3. Resolve omitted ref through the remote symbolic default and requested
   `refs/heads/*`, `refs/tags/*`, or unambiguous branch/tag shorthand through
   advertised SHA-1 refs. Reject raw object IDs, other ref namespaces, SHA-256
   repositories, missing refs, and ambiguous shorthand. Peel an annotated tag
   and verify the final object is one commit.
4. Create staging as a sibling of the absent runner-assigned checkout target,
   with a random unguessable component and restrictive ownership/mode. The
   caller never influences a host path.
5. Run Git with isolated config and environment. Fetch only the advertised ref
   needed for the resolved commit, disable helper execution, and check out
   detached.
6. Reject submodule entries and LFS-managed content. Validate tree confinement,
   materialized byte/inode limits, checkout `HEAD`, and optional execution
   working directory.
7. Atomically rename validated staging to the checkout target and return the
   result. Never write the sibling control root or derive a filesystem path
   directly from a URL, ref, working directory, response ID, or caller string.
8. Remove staging on every error, timeout, cancellation, or crash-recovery sweep.
   A failed attempt cannot become a resumable checkout.
9. Bound concurrent materializations with one server-owned semaphore. Saturation
   fails or waits only within the request deadline; it never creates unbounded
   processes.
10. Emit structured stage/error codes for URL policy, ref resolution, fetch,
    source feature rejection, limits, validation, publication, and cancellation.
    Keep stderr capped and private.

Behavior-focused tests:

- exact commit checkout when a branch advances between later requests;
- omitted-ref resolution to the advertised default branch;
- safe nested working directory and rejection of file/nonexistent/escaping paths;
- rejection of raw object IDs and SHA-256 repositories;
- a nested working directory that cannot move control state into repository
  content;
- redirect and DNS rebinding attempts into forbidden address ranges;
- forbidden Git protocols, embedded credentials, hooks, filters, submodules, and
  LFS content;
- byte, inode, time, output, and concurrency limits during materialization;
- cancellation kills Git descendants and removes staging; and
- two sessions requesting the same commit receive different writable roots and
  cannot observe each other's mutations.

Use controlled test origins/resolvers for adverse network cases and one stable
public fixture repository for built-image proof. Tests must observe files,
commit identity, isolation, errors, and process termination rather than mock
argument forwarding.

### Phase 5: Wire Codex and OMP to the external provider

**Outcome:** both required harnesses execute through the operator's single
OAuth-to-OpenAI-compatible gateway without exposing or changing its
credentials.

Primary areas: existing HarnessRouter provider connections/policies, custom
harness definitions, image runtime installation, and focused runner tests.

Work:

1. Install exact pinned Codex and OMP versions in the image and enable only the
   required release backends with `HR_BACKENDS=codex,omp`.
2. Define stable custom harness IDs, for example `allagents-codex` and
   `allagents-omp`, using HarnessRouter custom harness definitions. Store their
   instructions, tools, allowed models, and base harness in gateway-owned
   configuration.
3. Configure two logical HarnessRouter connections from the same server-side
   external-gateway base URL and API-key secret: `responses` for Codex and
   `openai` Chat Completions for OMP. Give each harness policy a one-entry chain
   containing only its matching connection.
4. Force Codex onto the Responses connection and OMP onto the Chat Completions
   connection. Fail startup/readiness if either selected model and endpoint
   combination is unsupported. Never switch transport or connection after an
   error.
5. Override the self-host image's owner-trust default with
   `HR_SANDBOX_TRUST=broker`. Make the existing local
   `HARNESS_GATEWAY_URL` satisfy broker availability in self-host mode without
   requiring a publicly reachable gateway URL.
6. Add a readiness probe that mints a scoped turn credential, reaches the
   loopback broker, and proves the real external-gateway key remains gateway-side.
7. Reject caller-selected models outside the harness allowlist and any request
   field that attempts to replace provider routing.
8. Confirm that OMP receives an ordinary session-local home/config and cwd. It
   must not read AllAgents local profiles or host configuration. Generate its
   credential-bearing `models.json` and `models.yml` under a per-turn ephemeral
   control subtree using only the scoped broker token, then delete both before
   terminal checkpointing. Add explicit checkpoint and public-file exclusions
   for the OMP paths as defense in depth.
9. Redact both the external-gateway key and scoped broker tokens from logs,
   traces, stored responses, session files, checkpoints, artifacts, and test
   snapshots.

Acceptance examples:

- Codex completes a real Responses turn through the external gateway;
- OMP completes a real Chat Completions turn through the external gateway;
- each harness starts inside the materialized working directory;
- an unsupported model fails before provider traffic;
- an invalid provider credential returns the upstream provider failure without
  selecting another connection; and
- callers cannot observe or override base URL, API key, or transport.

### Phase 6: Complete continuation, cancellation, and cleanup

**Outcome:** the checkout lifecycle follows the existing session lifecycle with
bounded ephemeral storage and no separate lifetime platform.

Work:

1. Add a server-owned `ALLAGENTS_WORKSPACE_TTL_SECONDS` with a finite safe
   default. Callers cannot set or extend it directly.
2. Start/reset the idle expiry only after a terminal turn is durably recorded.
   An active materialization or harness turn is not removed by the idle sweeper.
3. On a valid continuation, verify the stored checkout identity/root and use the
   exact prior working directory and mutations. Reset the idle deadline only
   after that turn reaches a terminal state.
4. On first-turn cancellation during materialization, terminate the process
   group, remove staging, and leave no resumable binding.
5. On cancellation after publication, stop the harness through stock
   HarnessRouter behavior and retain the bound checkout only until the ordinary
   finite idle deadline, so a permitted continuation sees prior mutations.
6. On expiry or explicit existing-session deletion, mark the binding unavailable
   in the session transaction and invoke idempotent confined cleanup. A late
   continuation fails closed and cannot recreate the checkout.
7. On startup, remove abandoned staging, pending reservations,
   published-but-unbound roots, and cleanup-marked session roots. Do not add a
   second database, durable queue, elaborate deletion ledger, or general storage
   collector.
8. If cleanup encounters a transient host error, keep the binding unavailable,
   report an operator-visible error, and retry the same idempotent removal on the
   next bounded sweep/startup. Never make the checkout executable again.

Acceptance examples:

| Scenario | Observable result |
|---|---|
| Turn 1 edits a file; turn 2 reads it | Turn 2 sees the edit in the same checkout |
| Turn 2 omits workspace metadata | Stored binding selects checkout and cwd |
| Turn 2 includes workspace metadata | Rejected before Git/provider activity |
| Checkout missing or identity mismatched | Continuation fails; no rematerialization |
| Git cancellation | Child processes exit and staging disappears |
| Harness cancellation | Response is cancelled; no process remains; checkout follows finite idle expiry |
| Expiry races with continuation | Exactly one wins through existing session serialization; checkout is never used after cleanup begins |
| Cleanup called twice or after restart | Same final absent state; no neighboring path changes |

### Phase 7: Build the one-container operator surface

**Outcome:** an operator can start the built AllAgents Gateway image with Docker
Compose, one data volume, and no helper service.

The checked-in Compose contract is equivalent to:

```yaml
services:
  allagents-gateway:
    image: ghcr.io/allagentsdev/allagents-gateway:${ALLAGENTS_GATEWAY_VERSION}@${ALLAGENTS_GATEWAY_DIGEST}
    ports:
      - "127.0.0.1:3000:3000"
    env_file:
      - .env
    environment:
      HR_BACKENDS: codex,omp
      HR_SANDBOX_TRUST: broker
      ALLAGENTS_WORKSPACE_TTL_SECONDS: ${ALLAGENTS_WORKSPACE_TTL_SECONDS:-3600}
    volumes:
      - allagents-gateway-data:/data
    restart: on-failure

volumes:
  allagents-gateway-data:
```

The real file must also carry HarnessRouter's required authentication, secret,
health, and process settings. The operator supplies one external provider base
URL and API key through two protocol-specific HarnessRouter connection records;
the Compose file does not bake either value into the image.

Startup contract:

1. Copy the example environment file and set non-default Console/caller
   credentials, the external provider route, model allowlists, TTL/resource
   limits, and an immutable image version plus manifest digest.
2. Run `docker compose up -d`.
3. Readiness succeeds only after the gateway, runner, enabled Codex/OMP runtimes,
   materializer executable, writable `/data`, custom harnesses, both
   protocol-specific provider connections, and loopback credential broker pass
   startup checks. Owner-trust credential pass-through fails readiness.
4. The public UHP base remains HarnessRouter's existing
   `http://127.0.0.1:3000/api/harness`; remote access requires operator-owned TLS
   and network controls.
5. Restarting the container with the same volume preserves unexpired
   HarnessRouter sessions and their private checkouts. Startup reconciliation
   removes only abandoned staging or cleanup-marked roots.

Container requirements:

- the materializer is installed in the same image and invoked locally;
- Git and certificate roots are pinned and present;
- the service binds to loopback by default;
- `/data` is the only required durable mount;
- secrets are runtime inputs, not layers, labels, build args, or example values;
- the image has a standard SBOM and build provenance; and
- image labels record gateway version, source revision, upstream commit, and UHP
  version.

### Phase 8: Add direct Promptfoo smoke and E2E coverage

**Outcome:** the lockfile-pinned Promptfoo installation calls the built image
directly over UHP and proves user-visible workspace behavior.

Suggested area: `e2e/promptfoo/` in `allagentsdev/allagents-gateway`, containing
only Promptfoo config, small fixtures/assertions, and package metadata.

Work:

1. Configure Promptfoo's OpenAI Responses-compatible provider directly against
   `/api/harness/v1/responses`, with the HarnessRouter API key in an environment
   variable and nested workspace metadata in the request. Do not place another
   HTTP adapter or repository between Promptfoo and the gateway.
2. Use a stable public Git fixture with known commits and a task whose answer or
   file change can only succeed if the harness started in the materialized
   checkout.
3. Run the same first-turn scenario for `allagents-codex` and `allagents-omp`,
   with each harness's allowed model and configured provider transport.
4. Include a two-turn scenario that mutates a uniquely named file on turn one
   and reads/changes it on turn two via `previous_response_id` without resending
   workspace metadata.
5. Include negative cases for malformed metadata, forbidden URL resolution,
   missing ref, invalid working directory, materialization limit, provider
   failure, cancellation during Git, cancellation during harness execution, and
   continuation after cleanup.
   Include reused-session workspace injection and cross-harness continuation
   mismatch cases.
6. Inspect public response metadata to verify the expected resolved commit and
   absence of checkout paths and credentials.
   Use canary values for the external-gateway key and scoped broker token and
   assert both are absent from session files, checkpoints, artifacts, logs, and
   reports after each turn.
7. Exercise the built image, not an in-process gateway. Store only sanitized
   reports; do not upload provider traffic, prompts containing secrets, or data
   volume contents.

Direct smoke/E2E is the proof of the feature. Focused permanent tests remain only
where they protect schema boundaries, ordering, security invariants, session
transitions, and cleanup races. Do not add tests that merely assert config keys,
field copies, mocks, or source text.

Release-blocking E2E matrix:

| Harness | First turn | Continuation | Cancellation | Provider failure |
|---|---:|---:|---:|---:|
| Codex / Responses | required | required | required | required |
| OMP / Chat Completions | required | required | required | required |

### Phase 9: Conformance, upstream maintenance, and release

**Outcome:** the downstream preserves stock HarnessRouter behavior and publishes
a reproducible, independently versioned image.

Work:

1. Run the complete UHP `2026-09-12` conformance suite against the built image.
   Workspace tests supplement it; they do not replace or relax upstream cases.
2. Run upstream HarnessRouter integration coverage for gateway, runner, Codex,
   OMP, sessions, streaming, cancellation, idempotency, files, artifacts, and
   non-workspace requests.
3. Run the direct Promptfoo E2E matrix against the exact image candidate.
4. Review the downstream diff against
   `5f82db1d1f13ea25b8ed0893c38b5b7d2e3e57e3`. Keep the seam patch separable
   from the AllAgents schema/materializer implementation so generally useful
   changes can be proposed upstream without blocking release.
5. Build and publish the v1 `linux/amd64` image as
   `ghcr.io/allagentsdev/allagents-gateway:<gateway-version>`, attach standard
   SBOM/provenance, and record its manifest digest. Additional architectures are
   separate release work after v1.
6. Verify a clean Compose deployment using that digest, a fresh volume, both
   harnesses, a first turn, a continuation, cancellation, expiry, restart, and
   cleanup.
7. Publish release notes containing gateway version, source commit, upstream
   baseline, UHP version, pinned Codex/OMP versions, Promptfoo version, image
   digest, known limitations, and upgrade/rollback instructions.
8. For future upstream updates, first merge/rebase the new upstream baseline as
   its own change, rerun conformance and built-image E2E, then replay or revise
   the narrow downstream patches. Never mix an upstream baseline jump with a
   product behavior change.

Release gate:

- all required focused tests pass;
- UHP conformance passes without exclusions introduced by this work;
- built-image Codex and OMP first-turn/continuation E2E passes through the
  external provider gateway;
- security failure and cancellation cases leave no child process or staging
  directory;
- the external-gateway key is absent from harness environments, and both it and
  scoped broker tokens are absent from persisted or public session surfaces,
  while both protocol-specific broker routes succeed;
- expiry and cleanup make the checkout unavailable and remove it idempotently;
- ordinary non-workspace HarnessRouter requests remain compatible;
- image digest, SBOM, provenance, pins, and downstream diff are available; and
- the Compose smoke succeeds from a fresh checkout and fresh `/data` volume.

## Error contract

Use stable, stage-oriented detail codes under HarnessRouter's existing UHP error
shape. Final names should follow upstream conventions, but the observable
categories are fixed:

| Condition | HTTP class | Retry guidance |
|---|---:|---|
| Invalid workspace JSON or path | 400 | Caller must change request |
| Workspace supplied for any reused session | 409 | Caller must omit workspace |
| URL/ref/source feature rejected | 400 | Caller must change source |
| Forbidden DNS/redirect destination | 400 | Caller or operator must change source/network policy |
| Materialization exceeds a fixed source limit | 413 | Caller must choose a smaller repository |
| Materializer concurrency unavailable | 503 | Retry with backoff within caller deadline |
| Git/network timeout before binding | 504 | Retry creates a new first-turn attempt under normal idempotency rules |
| Materialization cancelled | Existing UHP cancelled outcome | Do not retry under the cancelled response ID |
| Bound checkout missing, expired, or cleanup-started | 410 | Start a new session with a new workspace request |
| Provider unavailable or rejects credentials | Existing upstream provider error | Repair external provider gateway; no route fallback |

A failure before publication exposes no checkout identity or provenance. A
failure after a binding exists may include the already committed public
provenance, but never internal paths, Git stderr, DNS details that disclose
private topology, or provider secrets.

## Configuration ownership

| Value | Owner | Caller-overridable? |
|---|---|---:|
| Repository URL, optional ref, optional working directory | Initial UHP request | yes, within strict schema/policy |
| Harness ID and allowed model | New-session request constrained by server definition; stored workspace-bound session on reuse | only among configured values on creation; mismatch rejected only for workspace-bound reuse |
| External provider base URL/API key | Operator secret configuration | no |
| Codex/OMP provider transport | Operator harness definition | no |
| Materializer executable | Image/operator startup configuration | no |
| DNS/redirect/Git restrictions | Image and operator policy | no weakening by caller |
| Byte/inode/time/concurrency limits | Operator within image-safe bounds | no |
| Idle checkout TTL | Operator within image-safe bounds | no |
| Checkout path/identity | Runner | no |
| Resolved commit | Materializer observation | no |

## Delivery sequence and ownership

A practical implementation sequence inside `allagentsdev/allagents-gateway` is:

1. Repository maintainer performs the fork rename and establishes release/image
   permissions and pins.
2. Gateway owner implements the exact nested schema, canonical binding input,
   continuation rejection, and public error mapping.
3. Runner owner implements the single seam, first-turn/continuation ordering, and
   cancellation propagation.
4. Materializer owner implements secure Git acquisition, validation,
   publication, and cleanup under the runner contract.
5. Harness owner pins Codex/OMP, configures the two protocol adapters to the
   single external provider route, and defines the custom harnesses.
6. Container owner integrates the materializer, `/data` layout, readiness,
   Compose contract, and standard supply-chain outputs.
7. E2E owner adds the lockfile-pinned direct Promptfoo matrix and built-image
   smoke.
8. Release owner runs upstream conformance, reviews the downstream diff, and
   publishes the independently versioned digest.

Schema and seam contracts must merge before materializer and E2E work depend on
them. Git security, provider wiring, and container work can proceed in parallel
once those contracts are frozen. No implementation phase requires a change in
the AllAgents CLI repository.

## Definition of done

V1 is done when an operator can deploy one digest-pinned
`ghcr.io/allagentsdev/allagents-gateway` container with Docker Compose, configure
one external OAuth-to-OpenAI-compatible provider route through two
protocol-specific HarnessRouter connections and two custom harnesses, and have
lockfile-pinned Promptfoo directly:

1. start a Codex or OMP UHP session with the exact
   `metadata.allagents.workspace` object;
2. observe a securely resolved exact Git commit in public provenance;
3. run the harness inside a private editable checkout at the requested safe
   directory;
4. continue through either supported session-reference path with the same
   stored harness, mutations, and exact checkout;
5. cancel Git or harness work without leaked descendants or staging;
6. keep the long-lived external-gateway key out of harness environments and
   persisted session data while both brokered protocol routes succeed;
7. receive bounded, stable failures without provider calls for invalid or unsafe
   workspaces;
8. lose access after the server-owned expiry and see deterministic idempotent
   cleanup; and
9. run stock non-workspace UHP requests with upstream-compatible behavior.

No gateway implementation code, CLI command, profile migration, or
`workspace.yaml` change is required in `allagentsdev/allagents` to satisfy this
definition.