# ADR 0002: Serve coding-agent execution through an A2A gateway

- Status: Accepted; implementation pending
- Date: 2026-09-17
- Updated: 2026-09-20

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
must acquire or reuse an immutable workspace base, select a configured agent
target, propagate cancellation, collect bounded evidence, and clean up.
The trusted CI job, VM, or container that runs the gateway is the execution and
secret boundary: provider code and model-invoked tools run with that runner's
authority. The gateway owns one public contract for the lifecycle without
claiming hostile-code containment inside that boundary.

The contract must not turn AllAgents into an evaluation harness. Dataset
expansion, repetitions, assertions, scoring, experiment scheduling, and durable
evaluation Runs remain consumer concerns.

## Decision

### Add a trusted-network execution gateway

AllAgents will provide an independently testable, separately installed
`allagents-gateway serve` entry point. It runs as one Bun service process that
supervises phase-scoped acquisition and host provider processes. The ordinary
`allagents` CLI does not contain or depend on the gateway. A convenience
dispatcher may locate and execute a separately installed compatible
`allagents-gateway`, but it must not download or embed gateway artifacts.

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

### Use one TypeScript/Bun workspace with narrow package boundaries

The gateway and CLI are TypeScript products in one Bun workspace monorepo. The
private root package owns orchestration only. `apps/cli` publishes `allagents`;
`apps/gateway` publishes `allagents-gateway`; and `apps/acquirer` is built only
as a digest-pinned GHCR image, never as an npm package. Shared code is limited to
three justified packages:

- `packages/workspace-config` owns the project and user workspace projections
  consumed by the CLI and gateway;
- `packages/execution-contracts` owns the A2A coding-execution wire contract and
  portable validation; and
- `packages/acquisition-contracts` owns the typed request and manifest exchanged
  with the acquisition image.

Generated, language-portable contract fixtures live under `contracts/`. The
repository does not introduce speculative `core`, `common`, native platform, or
provider-sharing packages. A package is added only for an already-demonstrated
ownership boundary.

This architecture follows from the deployment boundary. V1 runs on one trusted
Linux CI runner, the gateway and official provider automation surfaces are
available in TypeScript, and Docker is needed only for untrusted repository and
OCI materialization. Adding another gateway implementation runtime and custom
in-job security layer would increase release and operational surface without
creating a boundary inside the already-trusted CI job.

### Keep independent CLI and gateway release trains

The `allagents` CLI and `allagents-gateway` have independent versions, tags, and
release triggers. A CLI release publishes only `apps/cli`; installing it fetches
neither the gateway package nor the acquisition image.

A gateway release first builds the multi-architecture `apps/acquirer` image,
pushes it to GHCR, records the immutable image-index digest and each supported
architecture's manifest digest, and verifies acquisition against those exact
digests. It then packs the exact `apps/gateway` npm tarball and runs package and
registry conformance with that tarball and those image digests. Only after both
artifacts pass does the workflow publish `allagents-gateway`. It does not
publish `allagents`.

Compatibility is a versioned contract, not equal npm versions.
`allagents-gateway compatibility --format json` reports the product, gateway
version, build identity, acquisition image digest, and supported A2A,
coding-extension, workspace, execution-contract, acquisition-contract, and
snapshot versions. The
optional CLI dispatcher may launch a separately installed gateway only when the
required contract-version intersections are non-empty. Compatibility does not
depend on target-specific npm wrappers or embedded native binaries.

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

Provider processes, MCP servers, and model-invoked tools are not separate
network principals. They execute on the same trusted CI runner as the gateway
and may exercise the authority available to that job. Operators must provision
the runner accordingly and must not rely on AllAgents to isolate host secrets,
the gateway listener, management networks, or arbitrary repository code from
model-invoked tools.

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
- disjoint immutable-base cache and per-Task runtime/workspace roots;
- workspace materialization policy plus Task and cache retention limits;
- GitHub App identifiers and private-key file references;
- the configured GitHub CLI account; and
- a strict Docker-auth file or fixed Docker credential-helper executable used
  only for acquisition.

By default the state root is a deterministic child of
`~/.allagents/gateway/` keyed by the canonical project-workspace identity. The
gateway owns an ordinary private Bun SQLite database with transactions, WAL
mode, and full synchronization. It persists claims, Tasks, one execution lease,
internal outcome intent, events, bounded Artifact bytes, and expiry state. The
gateway verifies workspace identity and holds an exclusive process-lifetime
lock. The root is current-user owned, private, and disjoint from project,
profile, and invocation roots. Standard Bun SQLite APIs are the entire storage
layer. The listener exposes metadata-only `/healthz` and `/readyz`; readiness is
false whenever admission is unsafe.

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

For OCI snapshots, the project workspace declares an operator-selected OCI
Distribution repository and any exact cross-origin layer-blob redirect hosts:

```yaml
workspaceSnapshots:
  evaluation:
    repository: ghcr.io/entityprocess/allagents-workspaces
    layerRedirectHosts:
      - pkg-containers.githubusercontent.com
```

The repository field is registry-neutral. V1 must pull AllAgents-formatted
workspace snapshots from Docker Hub, GHCR, JFrog Artifactory/JFrog Container
Registry, and compatible private OCI Distribution registries. Registry choice
does not change the snapshot media types, digest requirements, extraction
rules, or caller-visible source contract.

Registry conformance is tiered. Every pull request runs local Distribution
fixtures and a live public, digest-pinned GHCR pull through the exact gateway
package under test and the exact acquisition image index and architecture
manifest digests built for that pull request. A release workflow additionally
tests least-privilege authenticated GHCR and a digest-pinned disposable JFrog
Container Registry over HTTPS with a private CA and pull-only identity. Those
release checks install the exact gateway npm tarball and use the exact
multi-architecture acquisition image index and per-architecture manifests
intended for publication, for every architecture the registry and runner
support, without rebuilding either artifact. A report for another commit,
package, image digest, architecture manifest, build identity, or compatibility
output is rejected. Docker Hub behavior remains covered by protocol fixtures to
avoid public rate-limit dependence in pull-request CI.

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

For a source without a reusable validated base, the host gateway creates a
staging directory and bind-mounts only that directory into the digest-pinned
acquisition image. The acquisition container receives only the selected
repository or registry credential plus the strict network, redirect, size,
file-count, and archive policy needed for that source. The host resolves GitHub
App eligibility and mints any installation token; the container never receives
the App private key, host home directory, provider authentication state, or
Docker socket. The image contains and downloads no Codex, Pi, or other coding
harness.

The container materializes the repository or OCI source into staging, emits the
typed acquisition manifest, and exits. The gateway removes it before provider
execution, validates the manifest plus paths, collisions, file types, symlinks,
layer and file counts, individual and total compressed and expanded sizes, and
digests, then atomically promotes staging to a validated base. Absolute paths,
traversal, device files, sockets, escaping links, foreign or external OCI
layers, and unapproved cross-origin access are rejected. Every non-publication
path removes staging. Docker has no role after acquisition completes.

The base-cache key binds the acquisition-contract version, compiled catalog and
layout digest, and immutable source identity: every effective repository commit,
or the OCI manifest and workspace-manifest digests. A repository request is
reusable only when every effective revision is a full commit ID. Mutable
branch or tag requests instead receive a non-reusable Task-owned base that is
removed during settlement or reconciliation. Cache hits mint no credential and
start no acquisition container. Active Tasks pin reusable bases; bounded cache
eviction removes only unpinned entries.

The request optionally selects `workspaceAccess: "readOnly" | "readWrite"` and
defaults to `readWrite`. A read-only Task resolves its provider cwd directly
inside its validated base; exact immutable requests may share a reusable cached
base, while mutable branch or tag requests own a non-reusable base. Every Task
receives a private runtime directory for temporary, home, provider-state, and
evidence files. The gateway disables optional Git locks and asks the adapter for
its native read-only policy when available. It does not inspect the prompt or
add a per-Task mount, chmod pass, or full-tree verification. Read-only is a
cooperative contract and best-effort provider control, not a hostile-code
boundary; the consumer remains responsible for giving the Task work that does
not require project writes. A violating provider can contaminate a cached base
and later Tasks; the operator must evict that entry before reuse.

A read-write Task receives a unique writable view under
`<invocation-root>/<task-id>/workspace`. The host materializer prefers a
filesystem block clone, falls back to rootless OverlayFS on supported Linux
hosts, and supports an explicit ordinary-copy backend for portability. It never
uses hard links for writable files. The selected materializer is operator
configuration, not request input. After evidence collection, normal settlement
unmounts when needed and removes the Task-owned view plus any non-reusable base;
a non-settling provider retains them with the poisoned execution lease until
reconciliation.

For either access mode, the provider cwd is resolved from an optional logical
`workingDirectory` selector:

- `{ kind: "workspaceRoot" }` selects the effective workspace root and is the
  default; or
- `{ kind: "repository", repository: ConfigName, path?: RelativeDirectory }`
  selects a declared repository and an optional validated directory beneath it.

The caller never supplies an absolute path, configured destination, materializer,
cache key, or physical workspace name. The gateway maps the repository name
through the compiled catalog, resolves the optional relative path, and requires
the result to be an existing directory whose resolved path remains beneath the
selected repository root. The logical selector and access mode are part of the
canonical request, idempotency identity, and integrity evidence.
Gateway-generated structured metadata and operational logs never contain the
physical path; opaque terminal output, native evidence, and produced Artifact
payloads are not sanitized and may contain it.

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
`callApi(prompt, context?, options?)` reads bounded source, working-directory,
and workspace-access test variables from `context?.vars` when present and
cancellation from `options?.abortSignal`. The provider translates one `callApi`
into one A2A Task: it creates and retains a high-entropy invocation key, resolves
the effective logical working-directory selector and `readOnly | readWrite`
access mode, sends one Message whose sole Part has `text` set, declares the
extension in `Message.extensions`, puts the target, closed source union, logical
working directory, and access mode in the matching metadata member, and calls
`SendMessage` with `returnImmediately: true`.
It captures the Task ID and follows terminal state through `SubscribeToTask`,
with `GetTask` and bounded resubscription for races or
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
      workingDirectory:
        kind: repository
        repository: allagents
      workspaceAccess: readOnly
      source:
        kind: repositories
        revisions:
          allagents: 0123456789abcdef0123456789abcdef01234567

  - id: file://./providers/allagents-a2a.ts
    label: codex-evaluation-snapshot
    config:
      endpoint: https://allagents-gateway.example.internal
      target: codex
      workingDirectory:
        kind: repository
        repository: allagents
      workspaceAccess: readWrite
      source:
        kind: workspaceSnapshot
        snapshot: evaluation
        digest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
        workspaceManifestDigest: sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789

tests:
  - description: gateway package trial
    providers: [codex-direct]
    vars:
      allagentsWorkingDirectory:
        kind: repository
        repository: allagents
        path: apps/gateway
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

Static provider config fixes the source kind and logical names and may define a
default logical `workingDirectory` and `workspaceAccess`; absent values default
to `{ kind: "workspaceRoot" }` and `readWrite`. Per-test
`context?.vars?.allagentsWorkingDirectory` may replace the selector, while
`context?.vars?.allagentsWorkspaceAccess` may replace the access mode with the
exact string `readOnly` or `readWrite`. Separate read-only trials may share one
immutable physical base and cwd. Read-write trials receive distinct Task-owned
writable views even when their logical selectors are equal.
`context?.vars?.allagentsSource` remains limited to revision or digest leaves.
Missing variables retain static values. Absolute paths, `.` or `..` segments,
configured destinations, unknown repositories, URLs, mutable revisions,
credentials, commands, materializer choices, and unknown members fail before
provider execution. After Task acceptance, the provider's bounded deadline or
`options?.abortSignal` sends one `CancelTask` using a fresh cleanup signal
rather than the already aborted request signal.
It maps gateway input, output, cached-input, and total token counts to
Promptfoo's `prompt`, `completion`, `cached`, and `total` fields respectively.
Safe stable failure code, retryability, accepted Task ID, other usage, logical
working directory, and Task/Artifact evidence stay in metadata without origins,
configured destinations, or physical paths. Opaque prompts, terminal output,
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
hermetic Git configuration inside the acquisition container. The gateway
excludes system, global, and repository credential helpers, Git Credential
Manager, askpass, SSH agents, repository-controlled secondary fetches, and
executable Git configuration. Tokens never appear in clone URLs, command
arguments, Git configuration, logs, Tasks, Artifacts, or retained workspaces.
The helper and token are destroyed and the acquisition container is removed
before provider execution.

OCI credentials come from either a strict Docker-auth subset that cannot name
executables or a fixed Docker credential helper using its standard `get`
protocol. Acquisition supports anonymous pulls plus same-origin Basic and
Distribution Bearer challenge flows required by the declared registry, with the
documented Docker Hub token-service exception. Any other cross-origin Bearer
realm is rejected before a request is sent. System roots may be supplemented by
an operator map from exact registry `host[:port]` keys to verified PEM bundles;
each bundle is trusted only for connections to its key. Credentials and custom
trust material are scoped to snapshot acquisition and removed before
publication. Public registries require no credential or custom-CA
configuration.

### Integrate host providers through narrow typed adapters

The initial backend registry contains Codex and Pi, delivered in that order.
Each adapter implements a narrow AllAgents-owned contract for availability,
capabilities, invocation, progress, deterministic permission handling, abort,
terminal output, optional structured result, usage, native evidence, and
disposal. The gateway does not adopt AI SDK Harnesses or make a third-party
cross-provider abstraction part of its execution contract.

The Codex adapter uses a pinned `@openai/codex-sdk` release first. App-server is
permitted only when a required, demonstrated capability is absent from that
SDK; convenience or speculative parity is not enough. Native `outputSchema` is
used only for schemas supported by the pinned Structured Outputs contract;
other valid public schemas use explicit JSON guidance and the same gateway-side
validator used by every backend. The adapter does not scrape a TUI or use an
unstable bridge merely to preserve the target name.

The Pi adapter uses a pinned, supported RPC or package surface with
invocation-owned configuration and a restricted policy extension. Repository
extensions and unrestricted built-ins are not loaded merely because they exist
in acquired source. OMP remains out of the initial registry and is added only
for demonstrated OMP-specific value beyond direct Pi.

Provider runtimes are installed and pinned as part of the CI runner or gateway
installation; the gateway never downloads them per request. An operator may
select a globally installed binary override only when an exact version and
capability compatibility probe succeeds. Missing controls are reported honestly
as capability gaps, and the gateway never exposes arbitrary installed
executables.

Codex and Pi execute bare metal, directly on the same trusted Linux CI runner as
the gateway. For a read-only Task, cwd resolves inside its validated base,
shared only when reusable; for a read-write Task, cwd resolves inside the Task's
unique writable view. When
explicit API credentials are absent, Codex reuses the runner's existing
`CODEX_HOME` and ChatGPT login, and Pi reuses its existing supported host
authentication. The gateway references those host paths in place; it does not
copy, mount, or import OAuth files.

Each provider process receives an explicitly constructed environment containing
only the invocation configuration, selected provider settings, and required
host identity, executable, home, and authentication paths. This reduces
accidental ambient-variable leakage but is not an isolation or secret-
containment claim: MCP servers, provider descendants, and model-invoked tools
may exercise the same CI-job authority and reach secrets available to that
runner. The CI job, VM, or container must therefore be provisioned as the
security boundary.

Provider preparation is adapter-owned and typed. The gateway never executes
project or user `setup` shell entries as part of acquisition or invocation.
Validated profile settings, plugins, MCP declarations, and deterministic
workspace projections are applied through existing typed transforms.

### Persist Task truth, not live provider execution

The gateway durably stores Task identity, the canonical request, idempotency
claim, selected target and source, effective configuration digest, one execution
lease, internal outcome intent, Artifact bytes, retained evidence, cleanup
outcome, and expiry state under the configured state directory. AllAgents-owned
TypeScript handlers expose the A2A contract and use ordinary private Bun SQLite
ownership and transactions with full synchronization. One transaction
arbitrates `createOrReplay`, UUIDv7 Task creation, and execution-lease
acquisition. Normal terminal settlement atomically writes status, result or
failure, evidence, Artifacts, cleanup, and lease release. A provider session is
not a durable recovery checkpoint.

At most one Task holds the execution lease from acquisition through final
evidence collection. A second otherwise-valid request settles failed with
`execution_capacity_unavailable` without launching an acquisition container or
provider process. An identical idempotency replay returns the existing Task.
Reusing the key with a different canonical request conflicts. Clients generate
at least 128 bits of randomness once per logical invocation and reuse the same
key plus request after an ambiguous transport failure. Because the initial
service has no caller identity, the idempotency namespace and Task visibility
are gateway-wide.

Terminal Task records, Artifacts, events, and invocation claims expire in one
transaction after the configured TTL. The retained-count limit never evicts an
unexpired Task; the gateway rejects new admission until expiry frees capacity.
State-store integrity or durability failure stops admission and prevents the
gateway from acknowledging creation or reporting terminal success.

On gateway restart, interrupted nonterminal Tasks settle failed; provider work
is not resumed or automatically replayed. Admission resumes only after any
recorded acquisition container is gone and the recorded provider process group
is confirmed absent. Otherwise the gateway remains unready with the lease held.

### Make cancellation, evidence, and cleanup explicit

One durable compare-and-set arbitrates provider terminal outcome, caller
cancellation, deadline, and shutdown as an internal outcome intent while the
externally visible Task remains nonterminal. The winning intent owns the stable
result or failure code and drives one idempotent cancellation and settlement
path.

On Linux, each direct provider process starts in its own process group.
Cancellation first invokes the provider's supported graceful abort, then sends
`SIGTERM` to the process group after a bounded grace period, and finally sends
`SIGKILL` after a second bounded period. This is best-effort lifecycle control,
not containment: descendants can deliberately detach or escape the group. CI
runner teardown is the final orphan boundary. Cancellation during acquisition
stops and removes the acquisition container and unpublished staging; provider
execution never occurs in that container.

Live provider events are bounded while execution runs. Filesystem, Git, and
produced-Artifact evidence is collected only after the direct provider process
has settled and the configured process-group escalation has completed. The
gateway does not claim to prove full descendant quiescence. A settled read-only
Task removes its private runtime and any non-reusable base; it retains only a
reusable cached base. A settled read-write Task removes its writable view and
any non-reusable base after evidence collection. One transaction then atomically
publishes terminal status, the integrity Artifact, bounded evidence, result or
failure, produced Artifacts, observed termination and cleanup outcomes, and
lease release. Task-owned cleanup failure publishes `workspace_cleanup_failed`
and retains an internal cleanup record for reconciliation. If the direct process
does not settle after final escalation, the gateway instead publishes
`execution_termination_failed` without filesystem, Git, or produced-Artifact
evidence; retains any Task-owned runtime, writable view, non-reusable base, and
the lease; stops admission; and remains unready until runner teardown and
startup reconciliation confirm the recorded process group is absent and clean
the retained state.
Evidence describes only what the gateway actually observed;
escaped descendants and uncertain cleanup are never upgraded to verified
outcomes.

V1 supports trusted Linux CI runners and one active invocation. Other operating
systems and concurrent execution require a separate lifecycle design rather
than silent degradation.

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
workspace source, logical working-directory selector, bounded deadline, and
optional bounded result schema in its own strict `Message.metadata` member
without rejecting unrelated A2A metadata.
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

- Developers who explicitly install the gateway package can start one endpoint
  with `allagents-gateway serve` and use loopback, `0.0.0.0`, a specific
  interface, Tailscale, or firewall policy.
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
  Task. Operators treat network policy as authorization and must restrict the
  systems and secrets available to the trusted CI runner; AllAgents does not
  isolate provider or model-tool descendants within that runner.
- One durable SQLite execution lease enforces one active invocation independent
  of consumer concurrency settings.
- GitHub App credentials support private repositories without forcing every
  developer to use one identity; GitHub CLI remains a local eligibility fallback
  only when no App installation applies.
- Direct repositories and digest-pinned OCI snapshots converge on one validated
  immutable-base manifest and evidence contract. Immutable source identities may
  reuse a cached base; OCI metadata remains same-origin and only layer blobs may
  redirect to exact operator-approved hosts.
- Read-only Tasks may share that base and physical cwd while keeping private
  runtime state. Read-write Tasks receive disposable independent writable views
  through the selected copy-on-write or copy materializer.
- Docker is a short-lived base-acquisition boundary only when no reusable
  validated base exists. The container receives staging plus source credentials,
  emits a typed manifest, and is removed before Codex or Pi starts on the host
  runner.
- The private Bun workspace root orchestrates `apps/cli`, `apps/gateway`, the
  image-only `apps/acquirer`, and the three contract/configuration packages.
  CLI-only installs fetch neither the gateway package nor acquisition image.
- CLI and gateway versions and releases remain independent. Gateway releases
  verify the exact npm tarball and the exact digest-pinned multi-architecture
  acquisition image before publishing.
- Codex and Pi use pinned supported automation surfaces and existing host
  authentication through narrow adapters. Explicit environment construction
  reduces accidental leakage but cannot hide runner secrets from model-invoked
  tools.
- Linux process-group escalation provides bounded best-effort cancellation.
  Runner teardown remains the final orphan boundary, and evidence never claims
  full descendant quiescence.
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

### Let callers provide a host cwd

Rejected because an absolute or configured destination path would let a caller
select unrelated host content and bypass gateway-owned acquisition. Promptfoo
gets the required runtime control through a logical workspace-root or declared-
repository selector; the gateway maps it into the access-appropriate reusable
or Task-owned base or writable view according to `workspaceAccess`.

### Always allocate a unique full workspace

Rejected because read-only Tasks have no mutable project state to isolate, and
copying a large immutable workspace for every trial wastes transfer, storage,
and I/O. They share one validated base. Writable Tasks isolate only their
changes through a disposable copy-on-write view or explicit portable copy.

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

### Build v1 around Rust and kernel containment

Rejected because the trusted CI job is already the execution boundary. A Rust
gateway plus custom cgroups, pidfds, `openat2` VFS behavior, namespaces,
`nftables`, or spawn mediation would add implementation and release risk without
isolating model-invoked tools from secrets available to that job. Reconsider
native or stronger containment only if hostile-code or in-job secret isolation
becomes a product requirement.

### Adopt AI SDK Harnesses as the backend abstraction

Rejected because AllAgents needs a small contract tailored to its A2A Task,
evidence, cancellation, and profile semantics. Depending on a broad
cross-provider abstraction would enlarge the compatibility surface without
removing the need to understand the official Codex and Pi automation APIs.

### Run shared host provider daemons

Rejected because a long-lived daemon introduces cross-invocation state,
ownership, cancellation, and authentication ambiguity. V1 starts one direct
provider process for the one active Task and treats provider sessions as
ephemeral.

### Run providers in per-invocation containers

Rejected because official Codex and Pi automation should reuse the trusted
runner's existing installation and authentication. Copying or mounting OAuth
state into a provider container complicates ownership without creating a
security boundary against model tools. Docker remains limited to acquisition.

### Trust ambient unversioned provider binaries

Rejected because PATH discovery can silently change behavior between runs.
Pinned SDK, RPC, or package surfaces are the default; a global binary override
must pass exact version and capability probes, and runtimes are never downloaded
per request.

### Couple CLI and gateway versions or publish them together

Rejected because the products have different dependencies and release cadence.
Compatibility is explicit at the contract boundary; gateway-only work must not
force a CLI release, and CLI-only installation must not fetch gateway or
acquisition artifacts.

### Bundle the gateway into every CLI installation

Rejected because plugin/skill-only users do not need the A2A server, SQLite,
provider adapters, or acquisition image. The gateway ships as the separately
installed `allagents-gateway` npm package, and its release independently binds
the digest-pinned GHCR acquisition image.

## Reconsider when

Revisit this decision when any of these become requirements:

- callers outside one trusted network must share the endpoint;
- per-caller Task privacy, authorization, or audit identity is required;
- provider or model-tool code must be isolated from runner secrets or treated as
  hostile inside the execution environment;
- multiple gateway replicas need transactional shared storage;
- more than one active invocation or shared provider daemons are required;
- execution must route among remote worker pools or sandboxes;
- non-Linux runners need equivalent lifecycle and cancellation semantics;
- custom materializers are needed beyond direct Git and OCI snapshots;
- multiple GitHub hosts, Apps, CLI accounts, or ordered credential policies need
  declarative configuration;
- A2A standardizes the required coding-execution evidence without an extension;
  or
- a stable cross-vendor automation protocol subsumes the backend adapter seam.
