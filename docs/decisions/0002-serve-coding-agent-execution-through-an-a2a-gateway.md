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

The gateway implements A2A 1.0 HTTP+JSON plus a required versioned AllAgents
coding-execution extension. It owns:

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
`0.0.0.0` binding is valid and requires no unsafe-mode flag.

Every host able to reach the listener is equally trusted. Any reachable caller
may invoke every exposed target, list and retrieve retained Tasks and Artifacts,
and request cancellation. Task lookup and idempotency are deployment-wide, not
scoped to a caller identity. Operators must use Tailscale ACLs, host firewalls,
container networking, or equivalent network controls when the listener is not
loopback-only.

TLS termination, OIDC, static bearer tokens, per-tenant ownership, and
multi-tenant information-hiding are deferred. They require a separate decision
when the service is exposed outside one trusted network boundary.

### Use existing workspace files as the configuration authority

The initial gateway has no `gateway.yaml` or `worker.yaml`.

One gateway process serves one project workspace selected by `--workspace` or
the current directory. The project `.allagents/workspace.yaml` remains
canonical for repository identities, remote sources, destination paths,
default revisions, workspace files, plugins, and named OCI snapshot sources.

The user `~/.allagents/workspace.yaml` remains canonical for global profiles and
launcher-backed execution targets. A launcher-bearing profile client is exposed
only when it explicitly declares:

```yaml
profiles:
  review:
    clients:
      - name: codex
        launcher: codex-review
        gateway:
          expose: true
```

The public target ID is the launcher basename. Launcher names are already
portable and collision-checked across every user profile, while one profile may
contain several clients and therefore several launchers. Internally the target
resolves to exactly one `(profile, client)` pair. The gateway reserves built-in
target IDs, initially `codex` and `pi`; an exposed launcher whose portable
collision key matches a built-in ID is invalid.

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

- listener and workspace selection;
- a project-specific state-directory override;
- terminal Task retention and bounded Artifact/event storage;
- GitHub App identifiers and private-key file references;
- the configured GitHub CLI account;
- an OCI credential file or fixed credential-helper executable; and
- Codex and Pi auth-file handles.

By default the state root is a deterministic child of
`~/.allagents/gateway/` keyed by the canonical project-workspace identity. The
store persists and verifies that identity and holds an exclusive lock for the
process lifetime. The root is current-user owned, private, symlink- and hard-
link-resistant, and disjoint from project, profile, and invocation roots.

Secret values never belong in either workspace file.

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

For OCI snapshots, the project workspace declares the registry repository:

```yaml
workspaceSnapshots:
  evaluation:
    repository: ghcr.io/entityprocess/allagents-workspaces
```

The request supplies the name `evaluation`, a `sha256:` OCI manifest digest, and
a `sha256:` workspace-manifest digest. The gateway constructs the full OCI
reference server-side. Callers cannot supply a registry host, repository name,
mutable tag, extraction destination, credential, or external-layer policy.

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
total sizes, digests, and the workspace manifest before atomically publishing
the invocation workspace. Absolute paths, traversal, device files, sockets,
escaping links, foreign or external OCI layers, and cross-origin credential
forwarding are rejected.

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
It implements `ApiProvider`: its constructor receives `ProviderOptions`, retains
`options.id`, validates `options.config`, and exposes `id()`.
`callApi(prompt, context, options)` reads bounded test variables from
`context.vars` and cancellation from `options?.abortSignal`. The provider
translates one `callApi` into one A2A Task: it creates an invocation key, puts
the prompt in the single `TextPart`, puts the target and closed source union in
the required extension metadata, waits or streams to terminal, and returns
output, normalized token usage, and logical provenance in Promptfoo's
`ProviderResponse`.

For example, AI Evals can define two provider instances without sending either
origin over the wire:

```yaml
providers:
  - id: file://./providers/allagents-a2a.ts
    label: codex-direct
    config:
      endpoint: http://allagents-gateway.tailnet:4732
      target: codex
      source:
        kind: repositories
        revisions:
          allagents: 0123456789abcdef0123456789abcdef01234567

  - id: file://./providers/allagents-a2a.ts
    label: codex-evaluation-snapshot
    config:
      endpoint: http://allagents-gateway.tailnet:4732
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
`ghcr.io/entityprocess/allagents-workspaces` repository.

Static provider config fixes the source kind and logical names. The only
per-test object is `context.vars.allagentsSource`: repository mode accepts
revision overrides only for statically listed names and only as full lowercase
40-hex commits; snapshot mode accepts only replacement OCI and workspace-
manifest `sha256:` digests. Missing leaves retain static values. A URL,
destination, mutable revision, credential, command, unknown member, or changed
source kind/name fails before submission. After Task acceptance, the provider's
bounded deadline or `options?.abortSignal` sends `CancelTask`. It maps gateway
input, output, cached-input, and total token counts to Promptfoo's `prompt`,
`completion`, `cached`, and `total` fields respectively; other usage and Task/
Artifact evidence stays in metadata without origins. The provider belongs in AI
Evals. AllAgents exposes the A2A contract and consumer documentation without
taking a runtime dependency on Promptfoo.

### Resolve GitHub credentials with App-first eligibility fallback

The source request is credential-free and never selects a credential provider.
For `github.com`, the gateway supports two trusted providers:

1. a configured GitHub App; and
2. a configured GitHub CLI account.

The App is preferred when it has an installation covering the configured
repository. Installation applicability has three outcomes: `eligible`,
`ineligible`, and `unknown`. The gateway discovers applicability through an
App-authenticated GitHub API client, or verifies an explicitly configured
installation ID against the repository. `@octokit/auth-app` handles App JWT and
installation-token authentication; it is not treated as the repository-
discovery policy by itself.

For an eligible installation, the gateway requests a fresh repository-scoped
installation token for each acquisition and grants only required read
permissions. Acquisition receives at most 900 seconds or the shorter remaining
Task deadline. The token must remain valid beyond that sub-budget plus a
60-second clock-skew margin.

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
token minting, permission, repository-coverage, rate-limit, or service failure
terminates acquisition. The gateway never retries the same Task through the
broader GitHub CLI identity.

Git receives credentials only through an invocation-scoped helper under
hermetic Git configuration. The gateway excludes system, global, and repository
credential helpers, Git Credential Manager, askpass, SSH agents, repository-
controlled secondary fetches, and executable Git configuration. Tokens never
appear in clone URLs, command arguments, Git configuration, logs, Tasks,
Artifacts, retained workspaces, profile setup, MCP processes, agent processes,
or model-invoked tools. The helper and token are destroyed before provider
execution.

OCI credentials come from a configured auth-file or standard credential helper,
are scoped to snapshot acquisition, and are removed before publication. Public
registries require no credential configuration.

### Integrate providers through typed adapters

The initial backend registry contains Codex and Pi, delivered in that order.
Each adapter implements one behavior-focused contract for availability,
capabilities, invocation, progress, deterministic permission handling, abort,
terminal output, optional structured result, usage, native evidence, and
disposal.

The Codex adapter depends directly on `@openai/codex-sdk`, creates one fresh
thread per Task, passes cancellation and optional output schema through the SDK,
and consumes structured events.

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
distinct allowlisted environments and filesystem views. The provider control
process sees only its invocation-private auth channel; each MCP child sees only
its own resolved secrets; shell and other model-invoked tools see neither
provider nor MCP credentials. Every view excludes gateway state, operator home,
App keys, GitHub/OCI stores, acquisition helpers, unrelated adapter auth, and
the parent environment. A target is not ready unless its adapter can enforce
these separations. This credential/state isolation is required even though
general hostile-code sandboxing remains deferred.

### Persist Task truth, not live provider execution

The gateway durably stores Task identity, the canonical request, idempotency
claim, selected target and source, effective configuration digest, terminal
status, Artifact metadata, and retained evidence under the configured state
directory. A provider session is not a durable recovery checkpoint.

An identical idempotency replay returns the existing Task. Reusing the key with
a different canonical request conflicts. Because the initial service has no
caller identity, the idempotency namespace and Task visibility are gateway-wide.

Terminal Task records, Artifacts, events, and invocation claims expire
atomically after the configured TTL. The retained-count limit never evicts an
unexpired Task; the gateway rejects new admission until expiry frees capacity.
State-store integrity or durability failure stops admission and prevents the
gateway from acknowledging creation or reporting terminal success.

On gateway restart, interrupted nonterminal Tasks settle failed; provider work
is not resumed or automatically replayed. A new invocation may start fresh.

### Make cancellation, evidence, and cleanup explicit

The gateway supervises every acquisition and provider process set. Cancellation
first invokes the provider's native abort or protocol cancellation, then applies
bounded forced termination to the complete descendant set.

Terminal cleanup evidence is recorded only after the supervisor proves the
complete invocation process set quiescent through an enforceable, invocation-
owned containment primitive. If the platform cannot provide that guarantee, the
gateway fails readiness rather than relying on best-effort process enumeration.
If termination or proof fails, the Task records termination as unknown or
failed and the gateway rejects new work. An unmanaged foreground gateway stays
alive with poisoned readiness and continues reaping while printing the stable
containment identifier and platform recovery command. It may exit with a
nonempty set only after a validated external manager accepts cleanup ownership.

On startup the gateway identifies every interrupted invocation's containment
set and proves it empty before binding or advertising readiness. It may
quarantine a stale filesystem root only after process quiescence is proven. A
reaping or proof failure terminalizes the Task with unknown/failed termination,
keeps readiness false, and enters the same managed or unmanaged recovery path.

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
streaming, and cancellation. The Agent Card declares the AllAgents coding-
execution extension as required. Every operation that creates, returns, lists,
subscribes to, or mutates profiled Tasks or Artifacts activates
`https://allagents.dev/a2a/extensions/coding-execution/v1` through the
`A2A-Extensions` header. Unsupported calls receive the standard A2A extension-
support error, and responses echo the activated URI.

The versioned extension carries the invocation key, execution target, closed
workspace source, bounded deadline, and optional bounded result schema in its
own strict `Message.metadata` member without rejecting unrelated A2A metadata.
Every terminal Task has one fixed-name, versioned integrity Artifact plus zero
or more produced Artifacts. Breaking extension versions receive versioned cards
and endpoints rather than silent fallback.

The Agent Card advertises built-in and explicitly exposed launcher-backed
targets through an allowlisted capability projection. It does not publish local
paths, commands, arguments, environment selectors, credentials, exact source
authorization details, or transient worker state.

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
  source identities and exposed profile launchers.
- AI Evals can express the configured repository set with named revision
  overrides, or select a prebuilt image through a snapshot handle, in Promptfoo
  YAML. Its custom provider translates that closed source choice to A2A and
  keeps raw origins under AllAgents operator control.
- Network reachability grants access to every exposed target and retained Task.
  Operators must treat network policy as the authorization boundary.
- GitHub App credentials support private repositories without forcing every
  developer to use one identity; GitHub CLI remains a local eligibility
  fallback when no App installation applies.
- Direct repositories and digest-pinned OCI snapshots converge on one validated
  workspace manifest and evidence contract.
- The gateway process remains a meaningful API and lifecycle boundary, but not
  a hostile-code sandbox. Strong multi-tenant isolation remains future work.
- Codex and Pi share one conformance suite while retaining bounded native
  evidence and honest capability differences.
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
