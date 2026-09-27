---
title: "HarnessRouter Workspace Execution - Implementation Plan"
date: 2026-09-18
updated: 2026-09-27
type: feat
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
---

# HarnessRouter Workspace Execution - Implementation Plan

## Goal

Add a generic workspace contract and the runner capabilities needed to execute
Codex or OMP in a caller-selected public Git repository. Propose the protocol,
schema, implementation, conformance cases, changelog, and documentation through
HarnessRouter's upstream governance process first. If upstream declines or
defers the contribution, carry the same bounded behavior as a clearly labeled
downstream HarnessRouter extension. Keep the existing GitHub fork at
[`allagentsdev/harnessrouter`](https://github.com/allagentsdev/harnessrouter) and
publish an AllAgents-maintained image at
`ghcr.io/allagentsdev/harnessrouter`.

A new session may supply `metadata.workspace`. HarnessRouter securely resolves
one anonymous public HTTPS Git repository to an advertised SHA-1 commit,
materializes one private editable checkout, binds that exact checkout to the
session, and starts the selected harness in the requested safe working
directory. A continuation reuses the checkout and its mutations without
resolving or cloning again.

Everything else remains HarnessRouter behavior: caller authentication, UHP
request and response handling, session hydration, streaming, idempotency,
cancellation, provider and harness execution, artifacts, and ordinary lifecycle
state.

## Governance and repository boundary

### Upstream-first gate

`metadata.workspace` and the associated runner behavior solve a generic
HarnessRouter problem, so upstream gets the first opportunity to own them. The
fork may ship the contract after an upstream decision, but must label it as a
downstream HarnessRouter extension unless UHP governance standardizes it. Before
substantial implementation work:

1. Open an issue in `HarnessRouter/harnessrouter` that describes the use case,
   request and response shapes, security boundary, session semantics, runner
   seam, lifecycle, error categories, and intended conformance coverage.
2. Ask maintainers to confirm the required governance path and ownership of the
   metadata key, configuration names, and runner interfaces.
3. Write or amend the required UHP Enhancement Proposal (UEP) before changing
   protocol semantics. Follow the repository's contribution and UHP governance
   rules for discussion, review, compatibility, and approval.
4. Record the issue and UEP links in the implementation pull requests and in the
   downstream release notes.

The gate is passed when maintainers have selected the governance and ownership
path for `metadata.workspace`. Acceptance starts the coordinated upstream
contract; rejection or deferral starts the downstream-extension path. If no
maintainer decision arrives within 30 calendar days after the issue opens and a
follow-up is posted after day 14, record the proposal as deferred. A downstream
release must not claim that its workspace behavior is part of UHP or covered by
UHP conformance. If a later UHP release reserves an incompatible key or shape,
the fork migrates cleanly instead of retaining conflicting aliases.

### Upstream deliverables when accepted

An accepted upstream change is complete only when the same reviewed contract
appears in all relevant surfaces:

- the UHP specification;
- the machine-readable UHP schema;
- the HarnessRouter reference implementation;
- the UHP conformance suite;
- the HarnessRouter changelog; and
- user and operator documentation.

Generic workspace parsing, session binding, runner root separation,
materialization, lifecycle, errors, and conformance behavior are proposed
upstream together. If maintainers decline or defer that ownership, the fork
carries the smallest complete patch in the corresponding HarnessRouter paths,
with separate extension tests and release notes. The implementation remains
generic and must not couple lifecycle behavior to AllAgents harness IDs.

### Downstream repository

Keep `allagentsdev/harnessrouter` as the GitHub fork of
`HarnessRouter/harnessrouter`, preserving its fork relationship, history,
issues, settings, protections, and upstream remote. Do not create another
repository and do not add a wrapper repository.

The preferred fork delta contains only the downstream pieces specific to the
AllAgents deployment:

- deployment defaults;
- custom Codex and OMP harness definitions;
- provider connection and policy wiring;
- direct Promptfoo scenarios and sanitized reports; and
- image build and publication for `ghcr.io/allagentsdev/harnessrouter`.

If upstream declines or defers workspace ownership, the fork also carries the
smallest complete workspace contract and runner/materializer patch. Source
metadata, tests, and release notes distinguish that extension from standard UHP.

The initial examined baseline is HarnessRouter v0.25.4 at commit
`5f82db1d1f13ea25b8ed0893c38b5b7d2e3e57e3`, with UHP `2026-09-12`.
Development records that baseline exactly. The release baseline must be an exact
upstream tag and commit. Workspace behavior then comes either from an accepted
upstream release or from explicitly identified downstream commits applied to
that baseline.

The `allagentsdev/allagents` repository remains the local Bun CLI. This plan
adds no server, materializer, provider adapter, CLI command, local-profile
synchronization, or `workspace.yaml` behavior there. HarnessRouter custom
harness definitions are the complete remote configuration surface for Codex and
OMP.

## Product boundary

### In scope

- The UHP baseline selected through the upstream issue and UEP process, plus the
  accepted upstream workspace contract or documented downstream extension.
- Caller authentication through HarnessRouter's existing API-key behavior.
- One generic workspace object at `metadata.workspace`.
- Exactly one anonymous, public, HTTPS Git repository per new session.
- An optional advertised `refs/heads/*` or `refs/tags/*`, or unambiguous
  branch/tag shorthand. Omission means the remote default branch; raw object IDs
  and other ref namespaces are rejected.
- SHA-1 repositories only, with resolution to and recording of one exact 40-hex
  commit object ID.
- One private editable checkout per session.
- Immutable first-turn binding and exact-checkout continuation reuse.
- A finite server-owned idle TTL and deterministic, idempotent cleanup.
- Codex and OMP harnesses using one server-configured external
  OAuth-to-OpenAI-compatible gateway.
- One container, one `/data` volume, and Docker Compose startup bound to
  loopback by default.
- Direct Promptfoo evaluation of the built image.
- Upstream UHP conformance, separate downstream-extension coverage when needed,
  image SBOM/provenance, and digest-pinned releases.

### Non-goals

- More than one repository, destination mapping, or repository composition.
- Non-Git workspace sources, private source credentials, SSH Git transports, or
  caller-provided source headers.
- Raw commit-ID requests and SHA-256 Git repositories.
- Read-only workspaces, cross-session checkout reuse, prewarming, or shared
  source object stores.
- Caller-selected lifetime, indefinite sessions, recovery after configured
  expiry, or a separate lifetime subsystem.
- A generic extension registry, plugin framework, or multiple materializers.
- Provider login, token refresh, credential repair, or credential projection in
  HarnessRouter. Those belong to the external provider gateway.
- A caller-selected provider base URL, provider API key, transport, or fallback
  chain.
- Importing local profiles, synchronizing profile state, changing
  `workspace.yaml`, or adding an AllAgents CLI command.
- Replacing HarnessRouter sessions, task execution, artifacts, streaming,
  cancellation, or idempotency.
- New validation commitments for unrelated HarnessRouter backends.
- Kubernetes, multi-container worker orchestration, or a separately deployed
  materializer service.
- A custom attestation or green-build framework.

## External contracts

### UHP request

The proposed generic request shape is:

```json
{
  "model": "gpt-5.4",
  "input": "Inspect the project and fix the failing command.",
  "metadata": {
    "harness_id": "allagents-codex",
    "workspace": {
      "repository": {
        "url": "https://github.com/example/project.git",
        "ref": "refs/heads/main"
      },
      "working_directory": "packages/service"
    }
  }
}
```

The exact request object proposed to UHP is:

```text
metadata.workspace = {
  repository: {
    url: string,
    ref?: string
  },
  working_directory?: string
}
```

The workspace object has no independent schema marker. An accepted UHP release
owns its standard schema; while it is downstream-only, the fork release owns the
extension shape.

Rules:

1. `workspace` and `repository` must be JSON objects, not arrays or strings.
2. `repository.url` is required. It must be an anonymous public `https://` Git
   URL with no user info, query, fragment, alternate transport, or embedded
   credential.
3. `repository.ref` is optional and non-empty when present. It must identify an
   advertised `refs/heads/*` or `refs/tags/*`, or unambiguous branch/tag
   shorthand. Raw object IDs and other ref namespaces are rejected. Only SHA-1
   repositories are accepted, and the exact resolved 40-hex commit is recorded
   as provenance.
4. `working_directory` is optional. Omission means the checkout root. When
   present it is a normalized relative POSIX path to a directory within the
   checkout.
5. Unknown fields at every level are rejected. There are no aliases, commands,
   environment variables, access modes, lifetime fields, destination paths,
   materializer selectors, or provider settings.
6. HarnessRouter applies a small fixed metadata byte/depth bound before session
   allocation. The materializer applies field-specific length bounds before
   network or filesystem work.
7. A request without `metadata.workspace` follows ordinary upstream behavior.

The upstream issue and UEP own final standard names when accepted. If review
changes the proposed shape, update the specification, schema, reference
implementation, conformance suite, examples, and this plan together. A
downstream-only implementation keeps the proposed names, documents their
extension status, and tracks any later UHP collision as a required clean
migration.

### Session binding and public provenance

After materialization, the session owns one immutable binding containing:

- canonical requested repository URL;
- requested ref, or an explicit record that it was omitted;
- exact resolved 40-hex commit;
- runner-owned session root under `/data`;
- private checkout root beneath that session root;
- separate runner control root as a sibling of the checkout;
- execution working directory beneath the checkout;
- the governing UHP release;
- the workspace-contract owner and immutable revision, expressed internally as
  the accepted UHP release or exact downstream source commit;
- creation time and server-owned expiry; and
- cleanup state sufficient to make removal idempotent.

The checkout root, session root, control root, and cleanup token are internal and
must never appear in UHP responses, streams, logs, artifacts, or Promptfoo
reports. Successful responses expose only stable public provenance:

```json
{
  "metadata": {
    "workspace": {
      "repository": {
        "url": "https://github.com/example/project.git",
        "requested_ref": "refs/heads/main",
        "resolved_commit": "0123456789abcdef0123456789abcdef01234567"
      },
      "working_directory": "packages/service"
    }
  }
}
```

If the ref was omitted, `requested_ref` is omitted rather than synthesized. If
the working directory was omitted, `working_directory` is omitted. The same
public provenance is returned on successful continuations and idempotent
response retrieval. The selected contract and schema distinguish accepted
request fields from read-only response provenance fields; the UEP owns that
distinction when upstream accepts the contract.

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
session rejects `metadata.workspace`, regardless of which identifier selected
it. For a workspace-bound session, stored binding and harness state select
execution, and any caller-supplied harness must match exactly. A mismatch fails
before Git, hydration, or provider work. A reused unbound session without
workspace metadata retains ordinary upstream routing behavior.

A valid workspace continuation reuses the exact session root, checkout root,
control root, execution working directory, and checkout mutations. It verifies
that the runtime supports the binding's recorded workspace-contract owner and
revision. A missing, expired, cleaned, identity-mismatched, or unsupported
binding fails closed; HarnessRouter never silently clones or reinterprets it.
Before activating an incompatible contract, an upgrade must explicitly migrate
compatible bindings or drain and delete them.

### Provider and harness contract

The downstream deployment defines two protocol-specific HarnessRouter
connections that point to one external OAuth gateway and use the same
server-side base URL and API-key secret:

- a Responses-format connection used only by Codex; and
- an OpenAI Chat Completions connection used only by OMP.

This is one external provider route with two logical protocol adapters, not two
credential authorities. The external gateway owns user login, upstream token
storage, refresh, and repair.

- A new session selects only an allowed `metadata.harness_id` and model.
- A reused workspace-bound session derives its harness from stored state; a
  supplied mismatch fails before execution. Unbound sessions retain upstream
  routing.
- Each custom harness has an explicit model allowlist and a one-entry provider
  policy pointing to its matching protocol-specific connection.
- There is no fallback connection or automatic transport switching.
- Provider base URL, API key, transport, headers, and model mapping cannot be
  supplied in UHP input or workspace metadata.
- Provider failure is returned as an ordinary HarnessRouter/UHP failure. It does
  not change workspace or routing state.
- HarnessRouter runs in brokered sandbox mode. A harness receives a short-lived,
  session-scoped credential and loopback broker URL, never the long-lived
  external-gateway key. The scoped credential exists only for the active turn
  and is removed before checkpointing or public file collection.

## Security and resource invariants

These are release requirements, not later hardening:

1. **URL and DNS:** Accept only public HTTPS destinations. Reject loopback,
   link-local, private, carrier-grade NAT, documentation, multicast, reserved,
   and otherwise non-public IPv4/IPv6 results. Validate every DNS answer before
   connection, pin the validated address for that hop, revalidate every redirect,
   and cap redirects. A public name that resolves to any forbidden address fails
   closed.
2. **Git protocols:** Disable `file`, `ssh`, `git`, `ext`, and helper-driven
   alternate protocols. Clear inherited Git configuration and credential
   helpers. Disable terminal prompting. Requests never provide credentials.
3. **Repository execution:** Disable repository hooks and clean/smudge/process
   filters. Do not initialize submodules. Detect and reject gitlinks and Git LFS
   pointer-backed content instead of executing helpers or returning a partial
   workspace as complete.
4. **Root separation:** Keep four explicit values: session root, checkout root,
   control root, and execution working directory. The checkout and control roots
   are separate children of the session root. Harness HOME, credentials,
   scratch, skills, and runner state live only under control. The execution
   directory is a no-follow-validated descendant of checkout. Repository content
   cannot become control state.
5. **Filesystem confinement:** Build the checkout in sibling staging and publish
   it only into an absent checkout target. Reject absolute paths, `..`, empty
   segments, NUL, platform-separator ambiguity, and symlinks that escape the
   checkout.
6. **Exact provenance:** Resolve the requested ref, fetch its commit, check out
   detached, and verify `HEAD` equals the recorded object ID before publication.
   Later ref movement cannot change the bound checkout.
7. **Bounds:** Enforce server-owned limits for request bytes, URL/ref/path
   lengths, redirects, clone/fetch duration, materialized bytes, inodes, process
   output, concurrent materializations, active harness time, and idle checkout
   TTL. Apply limits during work, not only after completion.
8. **Process control:** Run Git and materializer children in a cancellable process
   group with a minimal environment, bounded stdout/stderr capture, and a hard
   termination deadline. Cancellation stops descendants.
9. **Crash-safe publication:** A workspace-aware first hydrate creates an
   isolated empty session root with checkout absent. Persist a pending
   reservation, materialize and validate in sibling staging, atomically publish
   staging as checkout, create the separate control root, then atomically commit
   the usable binding. Startup reconciliation removes abandoned staging, pending
   reservations, published-but-unbound roots, and cleanup-marked roots. A
   harness can never observe staging or a partially validated tree.
10. **Isolation:** Never bind one session to another session's checkout. Each
    first turn creates a private checkout even when URL, ref, and resolved commit
    are identical.
11. **Cleanup:** Removal is safe to repeat, never follows links, is confined to
    the recorded session root, and cannot remove another session's data.
12. **Provider secrets:** `HR_SANDBOX_TRUST=owner` is forbidden. The local broker
    exchanges a scoped turn credential for the real external-gateway key. The
    long-lived key never enters the harness environment or filesystem. Generate
    CLI credential config only in a per-turn ephemeral control subtree, exclude
    it from checkpoints and public file/artifact APIs, and delete it before
    terminal persistence. Neither long-lived keys nor scoped broker tokens may
    survive in a checkpoint, session file, artifact, stream, response, or log.

## Workstreams and implementation phases

The phases are ordered by dependency. Each ends with observable behavior; source
inspection alone is not an exit criterion.

### Phase 1: Establish the upstream issue and ownership decision

**Outcome:** HarnessRouter maintainers have selected the governance path and
either accepted upstream ownership or recorded that the fork must own the
extension.

Work:

1. Open the upstream issue with the exact request shape, response provenance,
   first-turn-only rule, continuation behavior, failure categories, source
   restrictions, root model, lifecycle, and non-goals.
2. Link prior security analysis without importing AllAgents-specific naming into
   the generic contract.
3. Draft the required UEP and identify compatibility effects on UHP clients,
   schemas, conformance runners, and existing metadata behavior.
4. Obtain maintainer direction on allocation of `metadata.workspace`, generic
   configuration names, materializer placement, runner interface, and release
   target.
5. If no decision arrives within 30 calendar days after the issue opens, post a
   follow-up after day 14 and record non-response at day 30 as deferral.
6. Split reviewable upstream changes according to maintainer preference while
   keeping one coherent protocol contract.
7. Record explicit decisions and update every example when review changes a
   name or behavior.

Exit gate:

- the upstream issue exists and links the UEP when required;
- maintainers have made an explicit decision, or the documented non-response
  window has elapsed and is recorded as deferral;
- accepted semantics are reserved through governance, or downstream semantics
  are explicitly labeled as a HarnessRouter fork extension; and
- no unresolved decision blocks implementation in the selected ownership path.

### Phase 2: Pin the fork baseline and supply chain

**Outcome:** `allagentsdev/harnessrouter` can reproducibly build the examined
upstream baseline and identify both that baseline and every downstream workspace
commit when the extension is not accepted upstream.

Work:

1. Preserve `HarnessRouter/harnessrouter` as the documented upstream remote and
   record v0.25.4 commit
   `5f82db1d1f13ea25b8ed0893c38b5b7d2e3e57e3` as the initial examined baseline.
2. Keep upstream synchronization commits separate from downstream deployment
   commits. Never combine a baseline jump with a product behavior change.
3. Pin the selected UHP release, base image by manifest digest, Codex and OMP
   runtime releases, Git/materialization system packages, Promptfoo dependency
   and lockfile, and every CI action. No `latest`, floating branch, or unbounded
   package range enters a release.
4. Configure image publication for `ghcr.io/allagentsdev/harnessrouter`.
5. Add an upstream-diff check so each candidate records its exact upstream tag
   and commit plus every downstream commit in the image.
6. Use the upstream-baseline-plus-downstream-revision tag convention
   `<upstream-tag>-allagents.<revision>`, for example
   `v0.25.4-allagents.1`. Increment the downstream revision for any image change
   on the same upstream baseline; reset it to `.1` when the upstream baseline
   tag changes.
7. Use the same tag for the downstream source release and OCI image, then deploy
   the image only by manifest digest, for example
   `ghcr.io/allagentsdev/harnessrouter:v0.25.4-allagents.1@sha256:<digest>`.

Behavior-focused proof:

- a clean fork checkout builds the recorded baseline from pinned inputs;
- source links, OCI labels, release metadata, and SBOM identify
  `allagentsdev/harnessrouter`, the exact upstream commit, and the downstream
  revision; and
- changing a pin, baseline, or lockfile appears as a reviewed source diff.

Exit gate: the unchanged pinned baseline image builds before workspace behavior
or downstream deployment configuration is added.

### Phase 3: Land the workspace contract in the selected ownership path

**Outcome:** the contract, parser, and behavior tests agree on one bounded
first-turn workspace object; requests without it retain ordinary behavior. When
accepted upstream, specification, machine schema, conformance, changelog, and
user documentation define the same standard contract.

Primary areas: UHP specification/schema and conformance when accepted upstream;
`gateway/app.py`, focused gateway tests, changelog, and user documentation in
either ownership path.

Work:

1. Define the request and public provenance shapes through the upstream review.
   An accepted UHP release owns standard compatibility and schema evolution;
   otherwise the downstream fork release owns the extension shape.
2. Parse `metadata.workspace` only on an initial request. Leave unrelated
   metadata unchanged.
3. Apply generic metadata byte/depth bounds before response or session
   allocation.
4. Strictly validate required and optional fields, unknown-field rejection,
   anonymous public HTTPS policy, and normalized relative
   `working_directory` rules.
5. Extend session resolution to report whether it created or reused a session.
   Store the canonical descriptor only after proving the session is new. Use one
   canonical serialization and digest so idempotent replay cannot create a
   second binding.
6. Reject workspace metadata for every reused session selected by either
   `previous_response_id` or `metadata.session_id`, before Git, hydration,
   runner, or provider work.
7. For a reused workspace-bound session, derive the harness from stored state and
   reject a caller-supplied mismatch before hydration. Leave reused unbound
   sessions on the ordinary route.
8. Map validation and reuse failures to stable UHP errors with the offending
   parameter named. Never expose exceptions or internal paths.
9. When accepted upstream, update the specification, machine schema, reference
   implementation, conformance suite, changelog, and docs in the same change
   set. Otherwise update the fork implementation, extension tests, changelog,
   and docs together without altering UHP conformance definitions.

Acceptance examples:

| Case | Observable result |
|---|---|
| Valid URL only | Accepted; checkout root becomes the effective working directory |
| Valid URL, ref, and nested directory | Accepted; values reach the single workspace hook |
| Missing URL, unknown field, array, or non-string field | 400 before materialization |
| Absolute or parent-traversing `working_directory` | 400 before materialization |
| Continuation containing `metadata.workspace` | 409 before materialization |
| Existing `metadata.session_id` plus workspace object | 409 before materialization |
| Workspace-bound session with a different `harness_id` | 409 before hydration |
| No workspace object | Same status, response, and runner path as upstream baseline |

Tests assert the HTTP/UHP contract and absence of materializer/provider activity,
not helper calls or field-copy plumbing.

### Phase 4: Land runner and materializer seams in the selected ownership path

**Outcome:** HarnessRouter can prepare a workspace after session resolution and
before provider execution while preserving its ordinary path.

Primary areas: `gateway/app.py`, `runner/server.py`, their existing transport,
the materializer package, focused integration tests, and operator docs. These
land upstream when accepted and otherwise remain an explicit fork patch.

Work:

1. Extend the existing gateway-to-runner turn envelope with an optional canonical
   first-turn workspace descriptor and an optional hydrated binding for a
   continuation. Do not add a public endpoint.
2. Add a first-hydrate mode that performs existing isolation, wipe, and ownership
   setup but leaves an empty session root with checkout absent. It must not run
   stock Git initialization, write `.gitignore`, apply input files, or create
   harness state before publication.
3. Define one runner-owned materializer interface with two operations:
   `materialize(first_turn_descriptor, checkout_target, limits, cancellation)`
   and `cleanup(binding)`. Use one configured implementation; do not add plugin
   discovery, registration, or hook chaining.
4. Preserve the four explicit root values in the binding. Validate the execution
   working directory without following links; keep control as a sibling of
   checkout.
5. After materialization, finish the pending-reservation/publication transition,
   create control, then atomically commit the binding and public provenance.
6. On continuation, hydrate and verify the stored roots and identity. Do not
   resolve, fetch, checkout, or validate caller workspace metadata again.
7. Spawn the harness in the execution working directory. Anchor durable HOME,
   scratch, skills, and CLI state in control. Scope input files, produced-file
   Git diffing, file APIs, and artifacts to checkout. Checkpoint the session root
   only after removing ephemeral credential state. Do not initialize an outer
   repository or overwrite the source repository's `.gitignore`.
8. Make first-turn transition idempotent. Same-key replay returns the owning
   response and binding. A competing request cannot materialize or bind a second
   checkout for the same session.
9. Preserve streaming, cancellation, terminal-state, idempotency, artifact, and
   provider-error ordering. Workspace failure terminates before provider traffic.
10. Implement typed materializer request, result, and error records. Results
    include internal roots plus safe public provenance; errors contain neither
    secrets nor uncontrolled Git output.
11. Canonicalize and authorize the HTTPS URL before Git. Use one acquisition path
    for DNS, redirects, IP policy, ref advertisement, and fetch.
12. Resolve omitted ref through the advertised symbolic default. Resolve full
    branch/tag refs or unambiguous shorthand from advertised SHA-1 refs. Reject
    raw object IDs, other namespaces, SHA-256 repositories, missing refs, and
    ambiguous shorthand. Peel annotated tags and require a commit.
13. Create restrictive random staging as a sibling of the absent checkout target.
    Fetch only the advertised ref needed for the resolved commit, disable helper
    execution, and check out detached with isolated Git configuration.
14. Reject submodule entries and LFS-managed content. Validate confinement,
    bytes, inodes, `HEAD`, and optional execution directory.
15. Atomically publish validated staging to checkout. Never write control or
    derive a host path from URL, ref, working directory, response ID, or other
    caller text.
16. Remove staging on every error, timeout, cancellation, and recovery sweep.
    Bound concurrency with one server-owned semaphore and emit stable staged
    errors with capped private stderr.
17. Document the runner/materializer contract and configuration in the owning
    HarnessRouter changelog and operator docs; include it in UHP documentation
    only when accepted as standard behavior.

Behavior-focused proof:

- a probe harness sees a committed repository file on its first instruction;
- `working_directory` becomes process cwd while HOME and runner state remain
  outside checkout;
- repository `.harness` paths and `.gitignore` cannot collide with control state;
- exact commit remains fixed if the branch later advances;
- omitted ref selects the advertised default branch;
- raw object IDs, SHA-256 repositories, escaping paths, forbidden destinations,
  protocols, credentials, hooks, filters, submodules, and LFS content fail;
- byte, inode, time, output, redirect, and concurrency limits apply during work;
- materializer failure produces no provider request, agent process, binding, or
  published checkout;
- cancellation kills Git descendants and removes staging;
- restart and continuation restore checkout mutations and control state;
- two sessions at the same commit receive distinct writable roots; and
- ordinary requests exercise the unchanged upstream sequence.

Use controlled origins and resolvers for hostile network cases and a stable
public fixture repository for built-image proof. Tests observe files, commit
identity, isolation, errors, and process termination rather than mock argument
forwarding.

### Phase 5: Complete continuation and cleanup lifecycle

**Outcome:** checkout lifecycle follows the existing session lifecycle with
bounded ephemeral storage and crash-safe recovery in the selected ownership
path.

Work:

1. Add the server-owned idle TTL configuration selected through review, with a
   finite safe default. Callers cannot set or extend it.
2. Start or reset idle expiry only after a terminal turn is durably recorded. An
   active materialization or harness turn is never removed by the sweeper.
3. On continuation, verify stored identity, contract owner and revision, and all
   roots, then use the same working directory and mutations. Reset expiry only
   after the turn becomes terminal.
4. On first-turn cancellation during materialization, terminate the process
   group, remove staging, and leave no resumable binding.
5. On cancellation after publication, stop the harness through ordinary
   HarnessRouter behavior and retain the checkout only until finite idle expiry,
   allowing a permitted continuation to see prior mutations.
6. On expiry or existing-session deletion, atomically mark the binding
   unavailable before confined idempotent cleanup. A late continuation fails
   closed and cannot recreate checkout.
7. On startup, reconcile abandoned staging, pending reservations,
   published-but-unbound roots, and cleanup-marked session roots. Do not add a
   second database, durable queue, deletion ledger, or general storage collector.
8. If cleanup encounters a transient host error, keep binding unavailable, emit
   an operator-visible error, and retry the same idempotent removal on the next
   bounded sweep or startup. Never make checkout executable again.
9. Before activating an incompatible workspace contract, explicitly migrate
   compatible bindings or drain and delete them. Unsupported revisions fail
   closed; do not add aliases or reinterpret stored descriptors.
10. Add lifecycle behavior to UHP conformance only where accepted and
    protocol-visible. Always cover implementation behavior with focused
    HarnessRouter integration tests in the owning repository.

Acceptance examples:

| Scenario | Observable result |
|---|---|
| Turn 1 edits a file; turn 2 reads it | Turn 2 sees the edit in the same checkout |
| Turn 2 omits workspace metadata | Stored binding selects checkout and cwd |
| Turn 2 includes workspace metadata | Rejected before Git or provider activity |
| Checkout missing or identity mismatched | Continuation fails; no rematerialization |
| Git cancellation | Child processes exit and staging disappears |
| Harness cancellation | Response is cancelled; checkout follows finite idle expiry |
| Expiry races with continuation | Existing session serialization selects one winner; checkout is not used after cleanup begins |
| Cleanup runs twice or after restart | Same absent final state; no neighboring path changes |

### Phase 6: Add downstream Codex, OMP, and provider wiring

**Outcome:** the fork supplies AllAgents deployment policy while consuming the
accepted upstream capability or its explicitly documented downstream workspace
patch unchanged.

Work in `allagentsdev/harnessrouter`:

1. Install exact pinned Codex and OMP releases and enable only required release
   backends with `HR_BACKENDS=codex,omp`.
2. Define stable custom harness IDs such as `allagents-codex` and
   `allagents-omp`. Store instructions, tools, allowed models, and base harness
   in downstream deployment configuration.
3. Configure two logical connections using the same external-gateway base URL
   and API-key secret: Responses for Codex and OpenAI Chat Completions for OMP.
   Give each harness policy one matching connection and no fallback.
4. Fail startup/readiness if either selected model and endpoint combination is
   unsupported. Never switch transport or connection after an error.
5. Force `HR_SANDBOX_TRUST=broker`. Configure the local loopback broker so
   self-host mode does not require a public broker URL.
6. Add readiness proof that mints a scoped turn credential, reaches the loopback
   broker, and keeps the real external-gateway key gateway-side.
7. Reject caller-selected models outside the harness allowlist and any request
   field that attempts to replace provider routing.
8. Give OMP ordinary session-local home/config and cwd. Generate its
   credential-bearing `models.json` and `models.yml` only under a per-turn
   ephemeral control subtree using the scoped token. Delete both before terminal
   checkpointing and exclude their paths from checkpoints and public walkers.
9. Redact the external key and scoped tokens from logs, traces, stored responses,
   session files, checkpoints, artifacts, and snapshots.

Acceptance examples:

- Codex completes a real Responses turn through the external gateway;
- OMP completes a real Chat Completions turn through the same external gateway;
- each harness starts inside the materialized execution working directory;
- unsupported model fails before provider traffic;
- invalid provider credentials return the ordinary provider failure without
  selecting another connection; and
- callers cannot observe or override provider URL, key, or transport.

### Phase 7: Build the one-container operator surface

**Outcome:** an operator can start the AllAgents-maintained HarnessRouter image
with Docker Compose, one data volume, and no helper service.

The checked-in Compose contract is equivalent to:

```yaml
services:
  harnessrouter:
    image: ghcr.io/allagentsdev/harnessrouter:${HARNESSROUTER_IMAGE_TAG}@${HARNESSROUTER_IMAGE_DIGEST}
    ports:
      - "127.0.0.1:3000:3000"
    env_file:
      - .env
    environment:
      HR_BACKENDS: codex,omp
      HR_SANDBOX_TRUST: broker
      HR_WORKSPACE_TTL_SECONDS: ${HR_WORKSPACE_TTL_SECONDS:-3600}
    volumes:
      - harnessrouter-data:/data
    restart: on-failure

volumes:
  harnessrouter-data:
```

The final environment key uses the upstream-approved name when accepted and the
documented fork name otherwise. The actual Compose file also carries
HarnessRouter's required caller authentication, secret,
health, and process settings. The operator supplies one external provider base
URL and key through two protocol-specific connection records; neither value is
baked into the image.

Startup contract:

1. Copy the example environment file and set non-default Console/caller
   credentials, provider route, model allowlists, TTL/resource limits, immutable
   image tag, and manifest digest.
2. Run `docker compose up -d`.
3. Readiness succeeds only after HarnessRouter, runner, Codex/OMP runtimes,
   materializer, writable `/data`, custom harnesses, both provider connections,
   and loopback credential broker pass startup checks. Owner-trust pass-through
   fails readiness.
4. The UHP base remains HarnessRouter's existing
   `http://127.0.0.1:3000/api/harness`; remote access requires operator-owned TLS
   and network controls.
5. Restart with the same volume preserves unexpired sessions and private
   checkouts. Reconciliation removes only abandoned or cleanup-marked data.

Container requirements:

- the materializer is installed in the same image and invoked locally;
- Git and certificate roots are pinned and present;
- service binds to loopback by default;
- `/data` is the only required durable mount;
- secrets are runtime inputs, not layers, labels, build arguments, or examples;
- image has standard SBOM and build provenance; and
- OCI labels record source revision, upstream tag and commit, downstream
  revision, UHP release, and runtime releases.

### Phase 8: Add direct Promptfoo smoke and E2E coverage

**Outcome:** lockfile-pinned Promptfoo calls the built image directly over UHP
and proves user-visible workspace behavior.

Suggested downstream area: `e2e/promptfoo/` in
`allagentsdev/harnessrouter`, containing only Promptfoo configuration, small
fixtures/assertions, and package metadata.

Work:

1. Configure Promptfoo's OpenAI Responses-compatible provider directly against
   `/api/harness/v1/responses`, with the HarnessRouter API key in an environment
   variable and `metadata.workspace` in the request. Do not place an HTTP adapter
   or another repository between Promptfoo and HarnessRouter.
2. Use a stable public Git fixture with known commits and a task that succeeds
   only when the harness starts in the materialized checkout.
3. Run the same first-turn scenario for `allagents-codex` and `allagents-omp`,
   using each harness's allowed model and provider transport.
4. Add a two-turn scenario that mutates a uniquely named file on turn one and
   reads or changes it on turn two through `previous_response_id`, without
   resending workspace metadata.
5. Cover malformed metadata, forbidden URL resolution, missing ref, invalid
   working directory, source limit, provider failure, cancellation during Git,
   cancellation during harness execution, continuation after cleanup,
   reused-session workspace injection, and cross-harness mismatch.
6. Assert the expected resolved commit in public provenance and absence of
   internal paths and credentials.
7. Use canary external keys and scoped tokens; assert both are absent from
   session files, checkpoints, artifacts, logs, reports, and data retained after
   each turn.
8. Exercise the built image, not an in-process server. Store only sanitized
   reports; never upload provider traffic, secret-bearing prompts, or volume
   contents.

Focused permanent tests protect schema boundaries, security invariants,
ordering, session transitions, and cleanup races. Do not add tests that merely
assert config keys, field copies, mocks, or source text.

Release-blocking E2E matrix:

| Harness | First turn | Continuation | Cancellation | Provider failure |
|---|---:|---:|---:|---:|
| Codex / Responses | required | required | required | required |
| OMP / Chat Completions | required | required | required | required |

### Phase 9: Integrate the upstream baseline and release the downstream image

**Outcome:** the fork consumes an exact upstream baseline, carries only the
workspace delta required by the recorded ownership decision, preserves ordinary
HarnessRouter behavior, and publishes a reproducible image.

Work:

1. Confirm the upstream decision. If accepted, verify that the
   UEP/specification, schema, reference implementation, conformance, changelog,
   and docs landed together. If declined or deferred, record that decision and
   the exact downstream workspace commits.
2. Advance the fork in a standalone synchronization change to the exact upstream
   release tag and commit selected as the baseline. Rebase or replay the
   downstream workspace and deployment commits separately.
3. Run the complete selected UHP conformance suite against the built image.
   Downstream scenarios supplement it; they do not replace or exclude upstream
   cases.
4. Run upstream HarnessRouter integration coverage for gateway, runner, Codex,
   OMP, sessions, streaming, cancellation, idempotency, files, artifacts, and
   ordinary requests.
5. Run the direct Promptfoo matrix against the exact image candidate.
6. Review the fork diff against its recorded upstream baseline. It must contain
   only the declared workspace extension when needed, deployment defaults,
   custom harness definitions, provider wiring, Promptfoo scenarios, and image
   publication changes. Reusable protocol or runner improvements continue to be
   proposed upstream.
7. Tag source and image using `<upstream-tag>-allagents.<revision>`, publish
   `ghcr.io/allagentsdev/harnessrouter:<tag>`, attach SBOM/provenance, and record
   the manifest digest. The first release targets `linux/amd64`; additional
   architectures are separate work.
8. Verify a clean Compose deployment using the digest, a fresh volume, both
   harnesses, first turn, continuation, cancellation, expiry, restart, and
   cleanup.
9. Publish release notes containing upstream issue/UEP links, UHP release,
   upstream tag and commit, downstream revision and source commit, pinned
   Codex/OMP and Promptfoo releases, image digest, known limitations, and
   upgrade/rollback instructions.
10. For future updates, synchronize the new upstream baseline alone, rerun
    conformance and built-image E2E, then replay or revise the declared
    downstream workspace and deployment patches. Never mix baseline movement
    with product behavior.

Release gate:

- the upstream ownership decision is recorded and all deliverables for the
  selected path are complete;
- all focused tests pass;
- UHP conformance passes without downstream exclusions;
- built-image Codex and OMP first-turn/continuation E2E passes through the
  external provider gateway;
- security failures and cancellation leave no descendant or staging directory;
- the external key is absent from harness environments, and it plus scoped
  tokens are absent from persistent and public surfaces while both broker routes
  succeed;
- expiry and cleanup make checkout unavailable and remove it idempotently;
- ordinary requests remain upstream-compatible;
- the fork diff contains only the declared downstream surface, including the
  workspace extension when upstream did not accept it;
- digest, SBOM, provenance, pins, baseline, and downstream revision are
  available; and
- Compose smoke succeeds from a fresh checkout and `/data` volume.

## Error contract

The selected workspace contract defines stable, stage-oriented detail codes
under HarnessRouter's UHP error shape. When accepted upstream, the UEP,
specification, schema where applicable, reference implementation, conformance
expectations, and docs agree on these observable categories. Otherwise the fork
implementation, extension tests, changelog, and docs agree without claiming UHP
standardization:

| Condition | HTTP class | Retry guidance |
|---|---:|---|
| Invalid workspace JSON or path | 400 | Caller must change request |
| Workspace supplied for a reused session | 409 | Caller must omit workspace |
| URL, ref, or source feature rejected | 400 | Caller must change source |
| Forbidden DNS or redirect destination | 400 | Caller or operator must change source/network policy |
| Materialization exceeds fixed source limit | 413 | Caller must choose a smaller repository |
| Materializer concurrency unavailable | 503 | Retry with backoff inside caller deadline |
| Git/network timeout before binding | 504 | Retry through ordinary idempotency rules |
| Materialization cancelled | Existing UHP cancelled outcome | Do not retry under cancelled response ID |
| Bound checkout missing, expired, cleanup-started, or on an unsupported contract revision | 410 | Start a new session with a new workspace request |
| Provider unavailable or rejects credentials | Existing provider error | Repair external provider gateway; no route fallback |

A failure before publication exposes no checkout identity or provenance. A
failure after binding may include already committed public provenance, but never
internal paths, uncontrolled Git stderr, private network topology, or provider
secrets.

## Configuration ownership

| Value | Owner | Caller-overridable? |
|---|---|---:|
| Repository URL, optional ref, optional working directory | Initial UHP request | yes, within schema and policy |
| Harness ID and allowed model | New-session request constrained by server definition; stored state on reuse | only among configured values on creation |
| External provider base URL and API key | Operator secret configuration | no |
| Codex/OMP provider transport | Downstream harness definition | no |
| Materializer implementation | HarnessRouter image/runtime configuration in the owning upstream or fork implementation | no |
| DNS, redirect, and Git restrictions | HarnessRouter safe defaults plus operator policy | no weakening by caller |
| Byte, inode, time, and concurrency limits | Operator within image-safe bounds | no |
| Idle checkout TTL | Operator within image-safe bounds | no |
| Session, checkout, control, and execution paths | Runner | no |
| Resolved commit | Materializer observation | no |
| Workspace contract owner and revision | HarnessRouter release and session binding | no |

## Delivery sequence and ownership

A practical sequence is:

1. Protocol owner opens the upstream issue, drives the UEP when required, and
   records the governance decision or documented timed deferral before
   substantial implementation.
2. Fork maintainer pins the examined baseline, supply chain, image publication,
   and baseline-plus-revision release convention in
   `allagentsdev/harnessrouter`.
3. If upstream accepts ownership, upstream protocol and runner owners land the
   coordinated specification, schema, parsing, session rules, root separation,
   materialization, lifecycle, errors, conformance, changelog, and docs.
4. If upstream declines or defers ownership, fork owners land the same bounded
   implementation with separate extension tests, changelog, and docs, and record
   every downstream workspace commit against the upstream baseline.
5. Downstream harness owner adds Codex/OMP definitions and two logical provider
   connections to the one external route.
6. Downstream container owner adds deployment defaults, readiness, `/data`,
   Compose, OCI labels, SBOM, and provenance.
7. Downstream E2E owner adds lockfile-pinned direct Promptfoo scenarios and
   built-image smoke.
8. Release owner proves the recorded upstream baseline and declared downstream
   diff, runs UHP conformance plus extension E2E, then publishes the tagged
   digest.

Upstream runner code depends only on an accepted upstream contract. The fork may
implement after the upstream ownership decision and must keep downstream
extension coverage separate from UHP conformance. Materializer security and
runner lifecycle may proceed in parallel after the selected contract freezes.
Provider wiring, downstream container work, and Promptfoo scenario authoring may
then proceed against that contract. No phase changes the AllAgents CLI
repository.

## Definition of done

This work is done when:

1. The upstream issue and required UEP have a recorded decision. On acceptance,
   the UHP specification, schema, HarnessRouter reference implementation,
   conformance suite, changelog, and docs define the same generic
   `metadata.workspace` contract. On rejection or deferral, the fork
   implementation, extension tests, changelog, and docs define it consistently
   without claiming UHP standardization.
2. `allagentsdev/harnessrouter` remains the GitHub fork and its release diff from
   the recorded upstream baseline contains only the declared workspace extension
   when needed, AllAgents deployment defaults, custom harness definitions,
   provider wiring, Promptfoo scenarios, and image publication.
3. An operator can deploy one digest-pinned
   `ghcr.io/allagentsdev/harnessrouter:<upstream-tag>-allagents.<revision>`
   container with Docker Compose and one `/data` volume.
4. Promptfoo can directly start either custom harness with a public HTTPS Git
   repository, optional advertised ref, and optional safe `working_directory`.
5. The public response reports the securely resolved exact commit without
   internal paths, while the harness runs inside a private editable checkout.
6. Continuation through either supported session-reference path verifies the
   recorded workspace-contract owner and revision, then reuses the same stored
   harness, mutations, checkout, control state, and execution directory without
   new Git work.
7. Session, checkout, control, and execution roots remain separated; staging is
   invisible; binding publication and startup recovery are crash-safe.
8. Git and harness cancellation leak no descendants or staging, and expiry makes
   the binding unavailable before deterministic idempotent cleanup.
9. Codex uses Responses and OMP uses Chat Completions through two logical
   connections to one external OAuth gateway, with no fallback.
10. The long-lived external key never enters the harness, and neither it nor
    scoped broker credentials survive in persisted or public surfaces.
11. Unsafe or invalid sources, limits, reused-session injection, missing
    checkout, and provider failures return the agreed bounded errors without
    violating ordering or making unintended provider calls.
12. Direct built-image Promptfoo coverage passes for both harnesses, first turn,
    continuation, cancellation, provider failure, security negatives, restart,
    expiry, and cleanup.
13. Ordinary requests remain upstream-compatible and the complete selected UHP
    conformance suite passes without downstream exclusions.
14. Source tag, OCI tag, digest, SBOM, provenance, exact upstream tag/commit,
    downstream revision/source commit, runtime pins, and release notes are
    published and mutually consistent.
15. No implementation code, CLI command, profile migration, or `workspace.yaml`
    change is required in `allagentsdev/allagents`.

Upstream rejection or deferral does not rename the product or block the
distribution. It changes ownership: the workspace patch remains visible in
`allagentsdev/harnessrouter`, its release notes identify it as a downstream
HarnessRouter extension, and any later conflicting UHP standard triggers a
clean migration.
