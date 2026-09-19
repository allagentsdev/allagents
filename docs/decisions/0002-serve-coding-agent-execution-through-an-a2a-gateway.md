# ADR 0002: Serve coding-agent execution through an A2A gateway

- Status: Accepted; implementation pending
- Date: 2026-09-17
- Updated: 2026-09-19

## Context

AllAgents already owns cross-client agent configuration, project workspace
knowledge, global profiles, plugins, hooks, MCP configuration, and generated
launchers. External systems also need to invoke those agents without importing
AllAgents internals or driving an interactive terminal.

The first planned consumer is AI Evals. It needs one remote coding-agent call to
return terminal output, usage, traces, file changes, produced artifacts,
failures, cleanup outcomes, and execution provenance. Future trusted tools on a
private developer network may need the same execution boundary.

The initial product is not a public multi-tenant control plane. Developers are
expected to run one gateway for one AllAgents project workspace and expose it on
loopback, a firewalled network, or a Tailscale network. Network reachability is
the trust and authorization boundary.

A coding-agent execution still includes more than a model request. The gateway
must acquire an immutable workspace, select a configured agent target, contain
credentials to their required phases, propagate cancellation, collect evidence,
terminate descendants, and clean up. Those responsibilities need one public
contract even when the initial deployment remains a single trusted process.

The contract must not turn AllAgents into an evaluation harness. Dataset
expansion, repetitions, assertions, scoring, experiment scheduling, and durable
evaluation Runs remain consumer concerns.

## Decision

### Add a trusted-network execution gateway

AllAgents will provide an independently testable `allagents gateway serve`
entry point. It is separate from the interactive CLI command lifecycle but may
run as a single local service process that supervises acquisition and provider
child processes.

The gateway implements A2A protocol version `1.0` over the `HTTP+JSON` binding
plus a required versioned AllAgents coding-execution extension. It owns:

- stable Task and idempotency identity;
- execution-target selection;
- workspace acquisition;
- deadline and cancellation propagation;
- normalized terminal output and evidence;
- bounded Task and Artifact retention; and
- enforcement of the coding-execution contract across every backend.

The gateway is not an evaluator, grader, experiment scheduler, retry authority,
or durable evaluation Run ledger.

### Trust the network boundary instead of adding application authentication

The initial gateway has no application-level authentication or per-caller
authorization. It may bind to loopback, a specific interface, or `0.0.0.0`.
Loopback remains the default when no listen address is supplied, but an explicit
`0.0.0.0` binding is valid and requires no unsafe-mode flag. The Agent Card
advertises a separate absolute interface URL; non-loopback listeners require
that value explicitly because a wildcard bind address is not routable.
Production interfaces use HTTPS; direct HTTP is limited to loopback development.

Every external host able to reach the listener is equally trusted. Any reachable
caller may invoke every available target, including built-in and gateway-enabled
profile targets; list or retrieve retained Tasks and their Artifacts; and
request cancellation. Task lookup and idempotency are deployment-wide, not
scoped to a caller identity. Operators must use Tailscale ACLs, host firewalls,
container networking, or equivalent network controls when the listener is not
loopback-only.

Invocation descendants are not network peers. Provider, MCP, and model-tool
processes run in role-specific network namespaces that cannot route to host
loopback, any gateway bind or advertised address, ingress proxies, or operator
management networks. Provider and MCP egress is default-deny except for
destinations compiled from adapter and MCP configuration; model tools receive no
network unless an explicit adapter policy grants the same constrained egress.

Gateway-managed TLS termination, OIDC, static bearer tokens, per-tenant
ownership, and multi-tenant information-hiding are deferred. Production clients
reach the advertised HTTPS interface through operator-managed termination or an
encrypted private overlay. Application authentication requires a separate
decision when the service leaves one trusted network boundary.

### Use existing workspace files as the configuration authority

The initial gateway has no `gateway.yaml` or `worker.yaml`.

One gateway process serves one project workspace selected by `--workspace` or
the current directory. The project `.allagents/workspace.yaml` remains
canonical for repository identities, remote sources, destination paths,
default revisions, workspace files, plugins, and named OCI snapshot sources.

The user `~/.allagents/workspace.yaml` remains canonical for global profiles and
launcher-backed execution targets. A launcher-bearing profile client is gateway-
enabled only when it explicitly declares:

```yaml
profiles:
  review:
    clients:
      - name: codex
        launcher: codex-review
        gateway:
          enabled: true
```

The public target ID is the launcher basename. Launcher names are already
portable and collision-checked across every user profile, while one profile may
contain several clients and therefore several launchers. Internally the target
resolves to exactly one `(profile, client)` pair. The gateway reserves built-in
target IDs, initially `codex` and `pi`; a gateway-enabled launcher whose
portable collision key matches a built-in ID is invalid.

The built-in `codex` and `pi` targets remain available when their adapters are
ready. Explicit launcher-backed targets add configured variants such as
`codex-review` and `pi-tools`. Initially only Codex and Pi profile clients are
gateway-executable; other launcher-bearing clients become eligible only after a
reviewed adapter implements the common execution contract.

The generated launcher file is a local UX artifact, not the remote execution
boundary. The gateway never discovers launchers from `PATH`, accepts a command,
executable path, arbitrary arguments, or environment overrides from a request,
or appends request data to a generated launcher. It resolves the profile through
its typed adapter and invokes the provider's supported automation surface.

Process-level options use exact flags and environment variables for:

- listener, advertised-interface URL, and workspace selection;
- a project-specific state-directory override;
- terminal Task retention and bounded Artifact/event storage;
- GitHub App identifiers and private-key file references;
- the configured GitHub CLI account;
- a strict Docker-auth file or fixed Docker credential-helper executable; and
- Codex and Pi auth-file handles.

By default the state root is a deterministic child of
`~/.allagents/gateway/` keyed by the canonical project-workspace identity. The
packaged Rust helper owns a private SQLite store in WAL/full-synchronization mode
through a descriptor-rooted VFS. Every database, WAL, SHM, journal, and temporary
file open uses `openat2` beneath/no-symlink resolution and rejects hard links.
The store persists claims, Tasks, one execution lease, internal outcome intent,
events, bounded Artifact bytes, containment identity, and expiry transactions.
It verifies workspace identity and holds an exclusive process-lifetime lock.
The root is current-user owned, private, link-resistant, and disjoint from
project, profile, and invocation roots. The listener exposes metadata-only
`/healthz` and `/readyz`; readiness is false whenever admission is unsafe.

### Support direct repositories and OCI workspace snapshots

Each request selects exactly one closed workspace source variant:

1. `repositories`, which materializes the repositories declared by name in the
   project workspace and accepts only optional revision overrides; or
2. `workspaceSnapshot`, which selects a named OCI snapshot repository declared
   in the project workspace and supplies an immutable OCI manifest digest plus
   the expected AllAgents workspace-manifest digest.

Fields from another variant are invalid. The gateway does not fall back from an
OCI snapshot to Git repositories, or from Git repositories to a snapshot, after
a Task selects its source mode.

For direct repositories, callers cannot override repository URLs or destination
paths. A revision override is keyed by a declared repository name. Branches and
tags may be accepted for developer convenience, but the gateway resolves and
records the full commit object ID before provider execution. Reproducibility-
sensitive callers should supply full commit IDs.

For OCI snapshots, the project workspace declares the registry repository and
any exact cross-origin layer-blob redirect hosts:

```yaml
workspaceSnapshots:
  evaluation:
    repository: ghcr.io/entityprocess/allagents-workspaces
    layerRedirectHosts:
      - pkg-containers.githubusercontent.com
```

The request supplies the name `evaluation`, a `sha256:` OCI image-manifest
digest, and a `sha256:` workspace-manifest digest. The gateway constructs the
full OCI reference server-side. Callers cannot supply a registry host,
repository name, mutable tag, extraction destination, credential, platform
selector, redirect host, or external-layer policy.

V1 accepts only an OCI Image Manifest directly at the requested digest; image
indexes, descriptor URLs or embedded data, non-distributable layers, and
unknown media types are rejected. Its config is the RFC 8785 canonical
`application/vnd.allagents.workspace-manifest.v1+json` object and must match the
requested workspace-manifest digest. The gateway verifies the manifest body,
config, and every distributable tar/gzip/zstd layer descriptor before decoding,
then applies layers in manifest order with OCI whiteout and opaque-whiteout
semantics.

Registry metadata remains same-origin. A cross-origin redirect is allowed only
for a layer-blob `GET` or `HEAD` to an exact operator-declared
`layerRedirectHosts` entry; an absent allowlist rejects it. Every bounded HTTPS
hop strips authorization, cookies, and client credentials, rejects URL
credentials, resolves and validates every address at connection time, and
rejects mixed answers, rebinding, downgrade, and unapproved destinations.
Loopback, link-local, private, reserved, or other non-global addresses are
permitted only when their exact host is the source's operator-declared
repository host or layer-redirect host. Token, manifest, and config redirects
remain same-origin. Descriptor size and digest verification remains mandatory
after redirects.

Both modes produce the same versioned, wire-visible workspace manifest. It
records declared logical repository names, requested revisions, resolved
commits, acquisition kind, relevant OCI manifest and layer digests, the
workspace-manifest digest, completeness, and whether each fact was independently
verified or snapshot-attested. It omits Git URLs, OCI repository origins, and
destination paths. A commit listed inside an OCI snapshot is not described as
independently verified unless the gateway separately verifies it against its
Git remote.

Acquisition occurs in a gateway-owned staging directory. The gateway validates
paths, collisions, file types, symlinks, layer and file counts, individual and
total compressed and expanded sizes, digests, and the workspace manifest before
atomically publishing the invocation workspace. Absolute paths, traversal,
device files, sockets, escaping links, foreign or external OCI layers, and
unapproved cross-origin access are rejected.

### Consume the gateway from Promptfoo through an AI Evals provider

Rejecting caller-supplied origins does not prevent AI Evals from selecting a
workspace in Promptfoo YAML. The two files have different ownership:

- the AllAgents project workspace is the operator-controlled catalog that maps
  repository and snapshot names to Git URLs, destinations, and OCI repositories;
- the Promptfoo configuration selects a target and source mode. Repository mode
  materializes the complete configured repository set and may override
  revisions by declared repository name. Snapshot mode selects one declared
  snapshot name and supplies immutable digests.

AI Evals owns a Promptfoo
[custom JavaScript/TypeScript provider](https://www.promptfoo.dev/docs/providers/custom-api/).
It implements `ApiProvider`: its constructor receives `ProviderOptions`,
requires and retains a nonempty `options.id`, validates `options.config`, and
exposes `id()`.
`callApi(prompt, context?, options?)` reads bounded test variables from
`context?.vars` when present and cancellation from `options?.abortSignal`. The
provider translates one `callApi` into one A2A Task: it creates and retains a
high-entropy invocation key, sends one Message whose sole Part has `text` set,
declares the extension in `Message.extensions`, puts the target and closed source
union in the matching metadata member, and calls `SendMessage` with
`returnImmediately: true`. It captures the Task ID and follows terminal state
through `SubscribeToTask`, with `GetTask` and bounded resubscription for races or
disconnects. It returns output, normalized token usage, stable failure metadata,
and logical provenance in Promptfoo's `ProviderResponse`.

For example, AI Evals can define two provider instances without sending either
origin over the wire:

```yaml
prompts:
  - file://./prompts/coding-task.txt

sharing: false
evaluateOptions:
  maxConcurrency: 1
  cache: false
commandLineOptions:
  write: false
  share: false

providers:
  - id: file://./providers/allagents-a2a.ts
    label: codex-direct
    config:
      endpoint: https://allagents-gateway.example.internal
      target: codex
      source:
        kind: repositories
        revisions:
          allagents: 0123456789abcdef0123456789abcdef01234567

  - id: file://./providers/allagents-a2a.ts
    label: codex-evaluation-snapshot
    config:
      endpoint: https://allagents-gateway.example.internal
      target: codex
      source:
        kind: workspaceSnapshot
        snapshot: evaluation
        digest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
        workspaceManifestDigest: sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789
```

The first provider materializes the complete configured repository set and uses
the `allagents` key only to override that repository's revision. The second
provider's `evaluation` key resolves to the declared
`ghcr.io/entityprocess/allagents-workspaces` repository. The gateway enforces
one active invocation transactionally. Promptfoo keeps `maxConcurrency: 1` to
avoid predictably creating failed capacity Tasks; other trusted callers need no
external queue for correctness. The no-cache/no-write/no-share values are secure
defaults for confidential prompts and outputs; consumers may enable persistence
or sharing only after applying their own retention, access, destination, and
redaction policy.

Static provider config fixes the source kind and logical names. The only
per-test object is `context?.vars?.allagentsSource`: repository mode accepts
revision overrides only for statically listed names and only as full lowercase
40-hex commits; snapshot mode accepts only replacement OCI and workspace-
manifest `sha256:` digests. Missing context or leaves retain static values. A
URL, destination, mutable revision, credential, command, unknown member, or
changed source kind/name fails before submission. After Task acceptance, the
provider's bounded deadline or `options?.abortSignal` sends one `CancelTask`
using a fresh cleanup signal rather than the already aborted request signal.
It maps gateway input, output, cached-input, and total token counts to
Promptfoo's `prompt`, `completion`, `cached`, and `total` fields respectively.
Safe stable failure
code, retryability, accepted Task ID, other usage, and logical Task/Artifact
evidence stay in metadata without origins. Opaque prompts, terminal output,
structured results, native evidence, and produced-Artifact payloads remain
unredacted sensitive data. The provider belongs in AI Evals. AllAgents exposes
the A2A contract and consumer documentation without taking a runtime dependency
on Promptfoo.

### Resolve GitHub credentials with App-first eligibility fallback

The source request is credential-free and never selects a credential provider.
For `github.com`, the gateway supports two trusted providers:

1. a configured GitHub App; and
2. a configured GitHub CLI account.

The App is preferred when it has an installation covering the configured
repository. Installation applicability has three outcomes: `eligible`,
`ineligible`, and `unknown`. An App-authenticated lookup that returns coverage
is eligible. A 404 is ineligible only after the configured GitHub CLI identity
independently proves that the repository exists; an uncorroborated 404 or any
authentication, permission, rate-limit, timeout, or service ambiguity is
unknown. An explicitly configured installation ID must positively verify
repository coverage.

For an eligible installation, the gateway bypasses the SDK token cache and
requests a fresh repository-scoped, read-only token for each acquisition. It
validates repository selection, permissions, creation time, and expiry.
Acquisition receives at most 900 seconds or the shorter remaining Task deadline,
and the token must remain valid beyond that sub-budget plus a 60-second clock-
skew margin. The gateway revokes the token after acquisition; unconfirmed
revocation fails before provider execution.

GitHub CLI is an eligibility fallback only when the App is not configured or
applicability is positively `ineligible`. An `unknown` result caused by
configuration, authentication, rate-limit, permission, or service failure
terminates acquisition. The CLI provider invokes:

```text
gh auth token --hostname github.com --user <configured-account>
```

with `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, and
`GITHUB_ENTERPRISE_TOKEN` removed from its environment. The configured account
is part of the acquisition-policy digest.

After an App installation is selected, App configuration, authentication,
token minting or validation, permission, repository coverage, revocation,
rate-limit, or service failure terminates acquisition. The gateway never retries
the same Task through the broader GitHub CLI identity.

Git receives credentials only through an invocation-scoped helper under
hermetic Git configuration. The gateway excludes system, global, and repository
credential helpers, Git Credential Manager, askpass, SSH agents, repository-
controlled secondary fetches, and executable Git configuration. Tokens never
appear in clone URLs, command arguments, Git configuration, logs, Tasks,
Artifacts, retained workspaces, profile setup, MCP processes, agent processes,
or model-invoked tools. The helper and token are destroyed before provider
execution.

OCI credentials come from either a strict Docker-auth subset that cannot name
executables or a fixed Docker credential helper using its standard `get`
protocol. They are scoped to snapshot acquisition and removed before
publication. Public registries require no credential configuration.

### Integrate providers through typed adapters

The initial backend registry contains Codex and Pi, delivered in that order.
Each adapter implements one behavior-focused contract for availability,
capabilities, invocation, progress, deterministic permission handling, abort,
terminal output, optional structured result, usage, native evidence, and
disposal.

The Codex adapter depends directly on pinned `@openai/codex-sdk`, creates one
fresh thread per Task, passes cancellation, and consumes structured events. It
uses native `outputSchema` only for schemas supported by the pinned Structured
Outputs contract; other valid public schemas use explicit JSON guidance and the
same gateway-side validator used by every backend.

The Pi adapter uses strict RPC mode with invocation-owned configuration and a
restricted policy extension. Repository extensions and unrestricted built-ins
are not loaded merely because they exist in acquired source.

CLI-backed compatibility adapters may be added later when a client has a stable
machine protocol. Missing controls are reported honestly as capability gaps.
The gateway never scrapes a TUI or exposes arbitrary installed executables.
OMP is Pi-derived and is added only for demonstrated OMP-specific value beyond
direct Pi.

Provider preparation is adapter-owned and typed. The gateway never executes
project or user `setup` shell entries as part of acquisition or invocation.
Validated profile settings, plugins, MCP declarations, and deterministic
workspace projections are applied through existing typed transforms.

Provider control processes, MCP children, and model-invoked tools receive
distinct allowlisted filesystem, environment, descriptor, secret, and network
views. The provider control process sees only its invocation-private auth
channel; each MCP child sees only its own resolved secrets; shell and other
model-invoked tools see neither provider nor MCP credentials. Every view excludes
gateway state, operator home, App keys, GitHub/OCI stores, acquisition helpers,
unrelated adapter auth, the parent environment, gateway endpoints, host
loopback, and management networks.

The pinned backend must expose a non-bypassable synchronous hook that delegates
every MCP and model-tool spawn to the Rust helper. The helper enters the role's
mount and network namespaces, replaces the environment, closes every
non-allowlisted descriptor, and only then executes untrusted code. Codex or Pi
is unavailable when its pinned surface can bypass that hook. This enforced
credential/state/network boundary is required even though general hostile-code
sandboxing remains deferred.

### Persist Task truth, not live provider execution

The gateway durably stores Task identity, the canonical request, idempotency
claim, selected target and source, effective configuration digest, one execution
lease, internal outcome intent, Artifact bytes, retained evidence, and
containment identity under the configured state directory. The official A2A
HTTP+JSON transport wraps an AllAgents-owned request handler; typed transactions
execute in the Rust helper's descriptor-rooted SQLite VFS. One transaction
arbitrates `createOrReplay`, UUIDv7 Task creation, execution-lease acquisition,
and containment binding; another atomically settles terminal status, result or
failure, evidence, Artifacts, cleanup, and lease release. A provider session is
not a durable recovery checkpoint.

At most one Task holds the execution lease from acquisition through final
evidence collection. A second otherwise-valid request settles failed with
`execution_capacity_unavailable`. Its transient empty containment set is
destroyed after settlement without releasing the start gate or launching a
helper child. An identical idempotency replay returns the existing Task. Reusing
the key with a different canonical request conflicts. Clients generate at least
128 bits of randomness
once per logical invocation and reuse the same key plus request after an
ambiguous transport failure. Because the initial service has no caller identity,
the idempotency namespace and Task visibility are gateway-wide.

Terminal Task records, Artifacts, events, and invocation claims expire in one
transaction after the configured TTL. The retained-count limit never evicts an
unexpired Task; the gateway rejects new admission until expiry frees capacity.
State-store integrity, VFS, helper protocol, or durability failure stops
admission and prevents the gateway from acknowledging creation or reporting
terminal success.

On gateway restart, interrupted nonterminal Tasks settle failed only after
containment reconciliation; provider work is not resumed or automatically
replayed. A new invocation may start fresh.

### Make cancellation, evidence, and cleanup explicit

The gateway supervises every acquisition and provider process set. The helper
allocates a stable empty containment set behind a start gate. The Task,
execution lease, and containment identifier commit durably before the helper may
release that gate or execute any child; a failed commit destroys the empty set.

One durable compare-and-set arbitrates provider terminal outcome, caller
cancellation, deadline, and shutdown as an internal outcome intent while the
externally visible Task remains nonterminal. The winning intent owns the stable
result or failure code and drives one idempotent abort and quiescence path.
Cancellation first invokes the provider's native abort or protocol cancellation,
then applies bounded forced termination to the complete descendant set.

Live provider events are bounded while execution runs. Filesystem, Git, and
produced-Artifact evidence is read only after the supervisor proves the complete
invocation process set quiescent through its invocation-owned containment.
Only then does one transaction atomically publish terminal status, the integrity
Artifact, bounded evidence, result or failure, produced Artifacts, termination,
cleanup, and lease release. If quiescence cannot be proven, that transaction
settles `execution_quiescence_unknown` without verified filesystem evidence.
The gateway rejects new work and stays alive with poisoned readiness while
continuing to reap; later recovery changes only internal recovery/readiness
state, never the settled Task.

On startup the helper enumerates the entire project-owned containment namespace,
including unknown identifiers, and proves every set empty before binding,
releasing a retained lease, quarantining stale roots, or advertising readiness.
It prints the stable containment identifier and platform recovery command for
any nonempty set. An unsupported platform fails before binding rather than
relying on process enumeration.

Terminal evidence distinguishes:

- agent output;
- optional validated structured result;
- logical repository names, requested revisions, resolved commits, or snapshot
  names and digests, never source origins or destinations;
- pre- and post-execution Git state where applicable;
- produced artifacts;
- usage and bounded provider-native evidence;
- cancellation and termination outcomes; and
- workspace cleanup outcome.

Credentials, raw secret-bearing paths, and unrestricted prompt, output, tool,
source, or file contents are excluded from operational logs.

### Profile A2A instead of inventing an invocation API

The gateway uses A2A Agent Cards, Messages, Tasks, Artifacts, operations, errors,
streaming, and cancellation. Its Agent Card advertises one interface with
`protocolBinding: "HTTP+JSON"`, `protocolVersion: "1.0"`, and
`capabilities.streaming: true`. The coding-
execution `AgentExtension` is required and has strict
`params: { targets: TargetId[] }`, populated from ready built-in and explicitly
gateway-enabled launcher-backed targets. It does not publish paths, commands,
arguments, environment selectors, credentials, exact source authorization
details, or transient worker state.

Every A2A HTTP+JSON request carries `A2A-Version: 1.0`. Every operation that
creates, returns, lists, subscribes to, or mutates profiled Tasks or Artifacts
also activates `https://allagents.dev/a2a/extensions/coding-execution/v1`
through `A2A-Extensions`. Missing activation receives
`ExtensionSupportRequiredError`; an unsupported protocol version receives
`VersionNotSupportedError`. Unsuccessful HTTP responses use the A2A
`google.rpc.Status` JSON envelope with typed `google.rpc.ErrorInfo` details;
validation also uses `google.rpc.BadRequest`, never JSON-RPC error carriers.

The published versioned extension specification defines Agent Card params,
activation, request/idempotency/replay, errors, and terminal Task/Artifact
schemas. Its request carries the invocation key, execution target, closed
workspace source, bounded deadline, and optional bounded result schema in its
own strict `Message.metadata` member without rejecting unrelated A2A metadata.
The request Message lists the URI in `Message.extensions`. Every terminal Task
has one fixed-name, versioned integrity Artifact whose `Artifact.extensions`
lists the URI, plus zero or more produced Artifacts. Breaking extension versions
receive versioned cards and endpoints rather than silent fallback.

ACP, app-server, SDK, and RPC protocols remain backend implementation details.
W3C Trace Context may propagate correlation through HTTP and child-process
boundaries. OpenTelemetry and provider-native evidence remain optional,
separate layers; neither replaces durable Task evidence.

### Keep evaluation commands out of scope

This decision does not add `allagents eval`, benchmark authoring, assertions,
scoring, datasets, repetitions, experiment scheduling, or automatic execution
retry. Consumers own those concerns.

## Consequences

- Developers can start one endpoint with `allagents gateway serve` and use
  loopback, `0.0.0.0`, a specific interface, Tailscale, or firewall policy.
- There is no application authentication, per-caller authorization, tenant
  isolation, `gateway.yaml`, `worker.yaml`, remote worker protocol, or required
  Kubernetes deployment in the initial product.
- Project and user workspace files remain the sole declaration authority for
  source identities and gateway-enabled profile launchers.
- AI Evals can express the configured repository set with named revision
  overrides, or select a prebuilt image through a snapshot handle, in Promptfoo
  YAML. Its custom provider translates that closed source choice to A2A and
  keeps raw origins under AllAgents operator control.
- External network reachability grants access to every available target,
  including built-in and gateway-enabled profile targets, plus every retained
  Task. Operators treat network policy as the authorization boundary; invocation
  descendants are isolated from that boundary and host-management networks.
- One durable execution lease enforces one active invocation independent of
  consumer concurrency settings.
- GitHub App credentials support private repositories without forcing every
  developer to use one identity; GitHub CLI remains a local eligibility fallback
  only when no App installation applies.
- Direct repositories and digest-pinned OCI snapshots converge on one validated
  workspace manifest and evidence contract. OCI metadata remains same-origin;
  only layer blobs may redirect to exact operator-approved hosts.
- Gateway v1 execution is supported on Linux x64/arm64 with the packaged state/
  security helper, descriptor-rooted SQLite VFS, cgroup v2, mount/network
  namespaces, nftables, pidfds, and safe-file operations. Matching helper
  packages publish and verify before the root package; unsupported hosts or
  missing capabilities fail before binding rather than degrading containment.
- The gateway process remains a meaningful API and lifecycle boundary, but not a
  hostile-code sandbox. Strong multi-tenant isolation remains future work.
- Codex and Pi share one conformance suite while retaining bounded native
  evidence and honest capability differences. A backend is unavailable unless
  its pinned surface can delegate every MCP/tool spawn through the helper.
- A future deployment configuration becomes justified only when the product
  needs multiple worker routes, tenants, credential policies, custom
  materializers, centralized storage, or other operator-selected variants.

## Rejected alternatives

### Define a second profile registry in `gateway.yaml`

Rejected because global profiles and launcher identities already belong to
`~/.allagents/workspace.yaml`. A second profile map would drift in client,
model, plugin, MCP, and launcher configuration.

### Require application authentication for every deployment

Rejected for the initial trusted-network product. It would add caller identity,
tenant scoping, token lifecycle, and ingress configuration before the expected
users need those boundaries. Tailscale ACLs and firewalls are the initial access
control.

### Restrict the listener to loopback

Rejected because developers need to expose the endpoint through Tailscale,
containers, VMs, and private networks. Explicit `0.0.0.0` binding is supported;
the operator owns the surrounding network policy.

### Execute generated launcher files as the remote protocol

Rejected because local launchers intentionally preserve cwd and append local
caller arguments. Remote requests must resolve a typed profile adapter and can
never control commands or argv.

### Let callers provide repository URLs or OCI repositories

Rejected because workspace configuration already defines trusted source
identities and destinations. Repository requests materialize the configured set
and may override revisions by declared name; snapshot requests select a declared
name and immutable digests. Neither variant introduces a new origin.

### Fall back from a selected GitHub App after runtime failure

Rejected because it would silently change identity and authorization scope after
selection. GitHub CLI fallback applies only when the App is ineligible.

### Use mutable OCI tags

Rejected because the same request could produce different workspaces. Snapshot
selection requires an OCI manifest digest and expected workspace-manifest
digest.

### Treat provider sessions as durable execution

Rejected because a resumable provider thread does not prove workspace,
process, cancellation, evidence, or cleanup continuity across gateway restart.

### Invent a bespoke invocation API

Rejected because A2A already supplies discovery, Task lifecycle, streaming,
Artifacts, cancellation, and errors. Coding-specific evidence belongs in a
versioned extension.

### Adopt an evaluator's Job or Trial API

Rejected because benchmark orchestration, verification, and persisted evaluation
state remain consumer concerns. The gateway executes one coding-agent Task.

## Reconsider when

Revisit this decision when any of these become requirements:

- callers outside one trusted network must share the endpoint;
- per-caller Task privacy, authorization, or audit identity is required;
- multiple gateway replicas need transactional shared storage;
- execution must route among remote worker pools or hostile-code sandboxes;
- custom materializers are needed beyond direct Git and OCI snapshots;
- multiple GitHub hosts, Apps, CLI accounts, or ordered credential policies need
  declarative configuration;
- A2A standardizes the required coding-execution evidence without an extension;
  or
- a stable cross-vendor automation protocol subsumes the backend adapter seam.
