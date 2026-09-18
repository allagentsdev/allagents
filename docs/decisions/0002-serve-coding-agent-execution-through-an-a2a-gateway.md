# ADR 0002: Serve coding-agent execution through an A2A gateway

- Status: Accepted; implementation pending
- Date: 2026-09-17

## Context

AllAgents already owns cross-client agent configuration, workspace knowledge,
plugins, hooks, MCP configuration, and launchers for Codex and other coding
agents. External systems also need to invoke those agents without importing
AllAgents internals or coupling to an interactive CLI process.

The first planned consumer is AI Evals. Its
[ADR 0036](https://github.com/WiseTechGlobal/ai-evals/blob/main/docs/adr/0036-remove-the-ai-evals-workspace-runtime.md)
removes AI Evals-owned coding workspaces in favor of a Promptfoo provider that
needs one remote coding-agent call to return output, usage, traces, file
changes, produced artifacts, failures, cleanup outcomes, and execution
provenance. Future clients may need the same execution boundary without
Promptfoo or evaluation semantics.

A coding-agent execution is more than a model request. It includes immutable
workspace selection, repository or snapshot acquisition, environment setup,
credentials, permissions, agent invocation, cancellation, evidence capture,
process termination, and cleanup. A workspace may contain multiple repositories
or be produced from a digest-pinned snapshot or organization-specific source.
Those responsibilities need one public contract while allowing materially
different execution backends and acquisition mechanisms.

The contract must not turn AllAgents into an evaluation harness. Dataset
expansion, repetition, assertions, scoring, experiment scheduling, and durable
evaluation Runs remain consumer concerns.

## Decision

### Add a separately deployable execution gateway

AllAgents will provide a separately testable and deployable execution-gateway
entry point. It will not be coupled to an interactive CLI command lifecycle.

The gateway owns:

- authentication and authorization;
- stable Task and idempotency identity;
- deadline and cancellation propagation;
- execution-profile and backend selection;
- normalization of terminal output and evidence;
- protocol-level Task status and bounded retention; and
- enforcement of the coding-execution contract across every backend.

The gateway is not an evaluator, grader, experiment scheduler, retry authority,
or durable evaluation Run ledger. It does not own a consumer's result store.

### Keep the gateway separate from execution backends

The initial design supports two execution backends, delivered in this order:

1. Codex; and
2. Pi.

Each backend implements the same conformance contract. Provider-specific
process, session, structured-output, cancellation, and evidence behavior
remains behind its adapter. OpenCode and other coding agents remain possible
follow-up adapters rather than part of the first delivery.

Execution workers own workspace materialization, environment setup, agent
invocation, evidence collection, process termination, and cleanup. The gateway
must not execute evaluated agents, run materializer images, or mount writable
workspaces in the gateway process.

When deployed on Kubernetes, the gateway runs as its own Deployment and
ClusterIP Service, separate from consumers and execution workers. A backend
dispatches to a worker pool, per-invocation Job, or stronger sandbox according
to the selected execution profile. The protocol does not require one worker
topology.

A separate gateway Pod is a service and failure boundary, not per-invocation
security isolation. Deployments requiring hostile-code or tenant isolation
must create or select a stronger execution boundary behind the gateway.

### Make workspace materialization explicit and operator-registered

The public extension represents one workspace as a closed discriminated union.
The allowed `kind` values and shapes are:

1. `repositories`, with a bounded list of direct Git repositories, each with a
   canonical credential-free HTTPS URL, full commit object ID, collision-free
   relative destination, and optional repository-relative subdirectory;
2. `workspaceSnapshot`, with an OCI workspace snapshot referenced by manifest
   digest and accompanied by the versioned AllAgents workspace manifest; or
3. `materializer`, with an operator-registered materializer ID, an expected
   workspace-manifest digest, and bounded structured inputs.

Fields from another union variant are invalid.

The third mode supports organization-specific acquisition such as JFrog,
generated sources, or custom monorepo assembly without accepting executable
configuration from the caller. The request cannot supply a builder image,
Dockerfile, Compose file, shell command, credential, mutable image tag, network
policy, or output contract.

Direct Git and OCI acquisition revalidate scheme, normalized host, resolved
address, port, and redirect policy for every connection. OCI foreign or
external layer URLs are rejected by default, and registry credentials are never
forwarded across origins.

Each materializer ID is defined in an operator-owned deployment registry. The
gateway receives only its non-secret descriptor: ID, bounded input schema,
expected definition digest, expected output-manifest version, and required
worker capabilities. The worker receives the runtime definition, which
additionally pins an OCI image by digest and fixes credential handle names or
mount identities, allowed network destinations, resource and phase deadlines,
cache policy, and the OCI runner or sandbox capability. Credential values are
not part of either descriptor.

The worker computes an algorithm-qualified definition digest over a versioned,
domain-separated canonical serialization of every non-secret,
behavior-affecting runtime field. The expected workspace-manifest digest
likewise identifies the canonical bytes of one declared manifest version. An
execution profile explicitly allows source modes and materializer IDs and
authorizes canonical Git repositories or namespaces, OCI namespaces, and
resource selectors inside structured materializer inputs. At readiness the
gateway matches its expected descriptor digest and profile against the
authenticated worker's computed digest and capabilities. At admission it
validates the selected ID, expected output digest, structured inputs, and
resource authorization; the worker resolves the same definition locally and
rejects missing, changed, or unsupported definitions before acquisition.

Every source mode produces the same versioned workspace manifest. The manifest
separates worker-verified observations from materializer-attested claims and
records the verification method for each identity. It includes requested and
resolved commits or OCI digests, destinations, materializer identity and image
digest when applicable, normalized input and output digests, resulting tree
identities, and completeness. Materializer assertions are not described as
independently verified unless the worker or a configured trusted acquisition
service performs that verification.

The worker materializes into a worker-owned staging directory under the same
filesystem publication root as the final workspace; readiness rejects a
cross-filesystem layout and publication never falls back to copy-then-delete.
After validating paths, file types, limits, identities, and the manifest, the
worker stops the materializer and removes its credential, process, mount, and
runner boundary. The validated host-owned staging tree remains. The worker then
atomically renames that tree into its final location before profile-owned setup
or any coding agent starts.

The registered image is part of the deployment's trusted computing base. The
worker launches it through a configured OCI runner or sandbox in a boundary
separate from the agent runtime and never exposes that runner's control socket
to setup or model tools. Phase isolation prevents later code from receiving the
materializer's credentials or mounts, but it cannot make a malicious
operator-registered image safe from credentials intentionally given to it.
Operators must review and pin that image. A deployment that will not trust it
with credentials needs a separately versioned broker or central snapshot
protocol, which is deferred from the initial architecture.

The canonical source request enters caller idempotency. The resolved
materializer definition digest enters the effective-profile binding, and both
the definition and output-manifest digests enter terminal provenance. New-claim
source authorization always runs before cache lookup. Cache metadata and keys
include the canonical source, materializer-definition digest, authorization
scope digest and revocation epoch, configured trust domain, and, for GitHub App
sources, the current installation-entitlement generation. Authenticated App
lifecycle webhooks and bounded control-plane reconciliation advance that
generation on uninstall, suspension, or repository-selection change. Unknown
or stale installation state fails cache authorization rather than reusing an
entry. Reuse also requires manifest and content revalidation under the current
authorization scope. Cache metadata preserves the original acquisition
provider metadata; terminal provenance distinguishes `cache_hit`, that original
provider, and the provider selected by current policy instead of claiming that
the current provider performed acquisition. Secret resolution and token minting
remain cache-miss-only.

This keeps Harbor's useful separation between content-addressed task acquisition
and environment execution without adopting task-owned opaque source. The
comparison is recorded in
[Harbor repository materialization lessons](../research/harbor-repository-materialization.md).

### Resolve GitHub source credentials from trusted deployment policy

The public source request remains credential-free and does not select a
credential provider. The trusted acquisition boundary normalizes the repository
host and resolves a provider from operator configuration. `github.com` selects
the built-in GitHub source backend; GitHub Enterprise Server hosts require an
explicit host and API mapping because a custom hostname does not identify its
provider. The effective profile authorizes the canonical repository and provider
entitlement before cache lookup.

For GitHub repositories, an ordered policy may prefer a GitHub App and permit a
local GitHub CLI fallback. The App provider is applicable only when trusted
operator configuration maps the requested repository to an installation ID;
`@octokit/auth-app` does not discover that mapping. It mints an installation
token scoped only to that repository, read-only contents permission, and its
GitHub expiry. A trusted-local CLI provider is pinned to one configured
non-secret account, which participates in its entitlement and effective-profile
digests. It may run only when no App installation mapping applies, as
`gh auth token --hostname <host> --user <account>`, with `GH_TOKEN`,
`GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, and `GITHUB_ENTERPRISE_TOKEN` removed
from its environment. Failure to resolve the configured account fails that
provider. This is eligibility fallback, not authentication retry: after an App
provider is selected, configuration, authentication, minting, permission,
repository, rate-limit, or service failure terminates acquisition and never
falls through to the broader user identity.

When AllAgents owns GitHub App token minting, a trusted control-plane
credential-provider component uses the focused `@octokit/auth-app` package
rather than implementing App JWT, clock-skew, expiry, and installation-token
renewal itself. Every cache-miss acquisition requests a fresh installation token
with auth-app cache bypass (`refresh: true`). Its remaining lifetime must be
strictly greater than the acquisition deadline plus the configured clock-skew
margin, and the delivery lease cannot outlive the token. Readiness rejects an
acquisition-phase ceiling that can exceed a fresh token's safe lifetime. Git
remains the repository transport; the full Octokit client is not required.

The initial remote architecture is one central token-minter path. The
gateway/control-plane credential-lease controller is authoritative: an
authenticated worker requests credentials only for its active attempt and
fence; the controller rechecks the current command revision, lease epoch,
tombstone, and fence in durable dispatch state, then derives the
effective-profile digest, selected provider, host/API-mapping digest,
installation ID, canonical repository, operation, worker route and identity,
and expiry from durable dispatch and policy state. It issues a single-use,
non-durable grant/response and, when the minter is separate, requires its
configuration digest to agree with those selected bindings. Replay, worker
field substitution, stale command state, and configuration disagreement fail
closed.

The authenticated delivery lease and channel bind that derived state to the
worker identity, attempt, lease epoch, command revision, fence, operation, and
expiry. Those bindings do not alter the bearer token: after delivery, the token
is enforceably scoped only by GitHub to the repository, read-only contents
permission, and token expiry. The remote worker never receives the App private
key, and only its one-shot acquisition child receives the token. A remote App
profile fails readiness when the central minter, authoritative lease controller,
fresh-token lifetime check, or authenticated non-durable delivery capability is
absent. A versioned central snapshot-delivery protocol is deferred and is not
an initial readiness alternative.

The local GitHub CLI provider and remote lease path expose their resolved tokens
only to the one-shot acquisition process. Neither exposes credentials to setup,
the coding-agent runtime, model tools, repository configuration, process
arguments, logs, evidence, or the published workspace. Public failures use only
deterministic coarse source-auth code, safe reason, and retryability:
`source_auth_unavailable/no_eligible_provider`,
`source_auth_denied/installation_repository_denied`, and
`source_auth_failed` with `app_configuration_invalid`,
`app_authentication_failed`, `app_mint_failed`, or
`trusted_local_cli_failed` are not retryable; `source_auth_failed` with
`provider_rate_limited` or `provider_unavailable` is retryable. Provider,
installation, and account identifiers are non-secret but operator-only
provenance. Cache-hit provenance separately records `cache_hit`, the original
acquisition provider, and current policy selection.

A standalone network broker is not required for trusted local execution: the
CLI provider may be a subprocess and a trusted co-located deployment may host
the App minter and lease controller inside its control plane. Remote routes
still use the same authenticated central-minter contract; the minter may be
split into a standalone service when private-key isolation, independent audit,
scaling, or blast-radius requirements demand it.

The supporting precedents and trust-boundary analysis are recorded in
[Source credential broker precedents](../research/source-credential-broker-precedents.md).

### Persist Task truth, not live provider execution

The gateway durably stores Task identity, idempotency claims, terminal status,
Artifact metadata, and retained evidence. A provider execution itself is
ephemeral. The initial service does not checkpoint, reattach, resume, or
automatically replay an interrupted provider session.

Gateway restart invalidates the active attempt fence and settles each
nonterminal Task failed once. A live worker that loses its lease aborts the
provider and cleans its invocation. If the worker process crashes, an external
supervisor terminates the complete execution boundary and the replacement
worker reaps or quarantines orphaned invocation roots before readiness.
Termination and filesystem cleanup are recorded separately and become complete
only when the responsible boundary proves them; otherwise the terminal record
says unknown. Durable execution and provider-session restoration require a
later decision backed by public provider guarantees.

### Integrate providers directly

The Codex adapter depends directly on `@openai/codex-sdk`; AllAgents does not
vendor or depend on Promptfoo's provider. Promptfoo's
[Codex provider](https://github.com/promptfoo/promptfoo/blob/main/src/providers/openai/codex-sdk.ts)
and
[tests](https://github.com/promptfoo/promptfoo/blob/main/test/providers/openai-codex-sdk.test.ts)
are characterization references for strict option mapping, minimal child
environment, working-directory validation, `AbortSignal`, structured output,
event normalization, and cleanup edge cases.

AllAgents keeps only the gateway-owned subset: one fresh provider session per
Task, server-owned profile settings, bounded native evidence, typed failures,
and worker-proven process cleanup. It does not inherit Promptfoo configuration
layering, caching, pricing, eval retries, thread pools, or `ProviderResponse`.

The extension defines `allagents.result-schema/v1` as a closed, bounded JSON
Schema Draft 2020-12 subset shared by admission, Codex, Pi, and terminal
validation. It requires an object root, requires every object schema to set
`additionalProperties: false`, lists every declared property in `required`, and
uses `null` unions for optional values. It allows only `type`, `properties`,
`required`, `additionalProperties` with the value `false`, `items`, `enum`,
`const`, `anyOf`, `$defs`, local `$ref`, `title`, and `description`, and rejects
remote references, format-dependent validation, and unknown keywords. The
extension version fixes byte, nesting, property, and enum limits. One shared
validator checks both the schema and the returned value, and the accepted schema
digest enters idempotency and provenance. Adapters cannot widen or narrow this
contract.

Codex receives that schema through the SDK's per-turn `outputSchema`; Pi
implements the same terminal contract with an invocation-scoped terminating
tool. A successful structured request publishes exactly one Artifact named
`allagents.structured-result` with one A2A `Part` whose `data` field contains
the validated result object and whose `mediaType` is `application/json`.
Artifact metadata contains the result-schema version and digest. The Artifact
exists only for a valid result. The integrity
kernel always records `not_requested`, `not_produced`, `valid`, or `invalid`;
an earlier source, setup, provider, cancellation, or deadline outcome remains
the primary Task classification when no result could be produced.

### Profile A2A 1.0 instead of inventing an invocation API

The external contract profiles the Linux Foundation
[Agent2Agent protocol](https://a2a-protocol.org/latest/specification/). The
initial profile requires the A2A 1.0 HTTP+JSON binding and retains Agent Card,
Message, Part, Task, Artifact, status, streaming, cancellation, security, and
error semantics.

The profile narrows A2A for deterministic coding execution:

- every accepted execution request creates exactly one addressable A2A Task;
  direct-Message completion is not supported;
- the gateway implements all mandatory A2A core operations, including
  `SendMessage`, `GetTask`, `ListTasks`, and `CancelTask`; when its Agent Card
  advertises streaming, it also implements `SendStreamingMessage` and
  `SubscribeToTask`; capability-gated operations retain their standard A2A
  behavior instead of being replaced by bespoke `/v1/invocations`, `/v1/runs`,
  or `/v1/trials` resources;
- terminal Task results use Artifacts for output and evidence rather than
  relying on transient messages or stream events; and
- each versioned Agent Card advertises one mandatory AllAgents extension version
  for source and runtime identity, traces, usage and cost, file changes,
  produced artifacts, typed failures, cancellation and cleanup outcomes,
  evidence completeness, and provenance.

Generic A2A conformance is insufficient. The AllAgents extension and its
conformance fixtures define the coding-execution guarantees every backend must
satisfy.

Breaking extension changes use a new extension URI and a versioned Agent Card
or service endpoint. During migration, the gateway keeps the old card, endpoint,
and required extension serviceable while consumers move to the new profile.
Each card requires exactly one extension version. Clients pin the card they
support; the gateway never silently falls back across incompatible versions.
Retiring an old profile is a separate coordinated compatibility decision, not a
lockstep deployment requirement.

The AAIF
[agentgateway](https://github.com/agentgateway/agentgateway) project may be used
as traffic-policy infrastructure for A2A, MCP, or model calls. It is not the
AllAgents execution service or evidence schema. Documentation uses **AllAgents
execution gateway** where the distinction matters.

### Keep adjacent protocols at their proper boundaries

The [Agent Client Protocol](https://agentclientprotocol.com/) may be used behind
a backend adapter when a coding agent supports it. Its session, progress, tool,
permission, terminal, diff, usage, and cancellation semantics are useful
internally, but its stdio editor-to-agent protocol is not the external gateway
API.

The [Agent Host Protocol](https://microsoft.github.io/agent-host-protocol/)
may be used behind a backend adapter when a host exposes it, or beside the
gateway if AllAgents later adds a collaborative multi-client session surface.
Its host-authoritative snapshots, actions, reconnection, tools, permissions,
and changesets solve live session synchronization; they do not replace A2A
Task identity, idempotency, authorization, terminal evidence, or retention.
The supporting research and implementation consequences are captured in the
[AHP decision inputs](../research/agent-host-protocol-decision-inputs.md).

[Model Context Protocol](https://modelcontextprotocol.io/) remains a tool and
resource protocol inside an execution backend. It does not represent the whole
coding-agent execution.

[Agent Format](https://agentformat.org/) may provide an optional static agent
manifest and vocabulary. It does not define the execution transport or prove
observed execution evidence.

The archived IBM/BeeAI Agent Communication Protocol is superseded by A2A and
will not be adopted.

### Separate trace propagation, span semantics, and durable evidence

Gateway calls propagate
[W3C Trace Context](https://www.w3.org/TR/trace-context/) across HTTP and process
boundaries. AllAgents uses OpenTelemetry and OTLP for metadata-only operational
telemetry by default. An explicit allowlist limits structured logs and spans to
non-content operational metadata. Prompts and model outputs, tool arguments and
results, file bodies and source fragments, and secret-bearing attributes are
prohibited before export. A bounded filtering and redaction step must run before
any structured log or span processor so disallowed content cannot enter the
telemetry pipeline.

AllAgents-managed agent, model, and tool spans use
[OpenInference](https://arize-ai.github.io/openinference/) semantic conventions
only for attributes that pass this allowlist. Backend-native attributes must
pass the same allowlist. Owner correlation is limited to an opaque identifier
appropriate for the telemetry operators' access; it does not expose caller
identity or grant access to a Task or Artifact. Telemetry access and retention
are governed separately from Task and Artifact access and retention.
Consumer-owned evaluator spans may join the propagated trace without becoming
gateway-owned.

These standards are complementary:

- W3C Trace Context propagates causal trace identity;
- OpenTelemetry and OTLP represent and transport live operational telemetry;
- OpenInference describes AI operations on OpenTelemetry spans; and
- the AllAgents A2A extension returns durable coding evidence and provenance.

An external trace backend is not the sole durable result. Sampling, redaction,
transport loss, or retention policy must not erase the terminal facts needed by
a consumer.

### Trial ATIF only as an optional trajectory Artifact

The Harbor
[Agent Trajectory Interchange Format](https://github.com/harbor-framework/harbor/blob/main/rfcs/0001-trajectory-format.md)
may be returned as an optional, explicitly versioned A2A Artifact when a backend
can produce or truthfully normalize an ordered agent trajectory. It is not the
A2A transport, the OpenTelemetry trace, or the AllAgents evidence envelope.
Backend-native trajectories remain available when conversion would lose
information.

An ATIF Artifact must declare its exact schema version and correlate its A2A
Task, OpenTelemetry trace, AllAgents invocation, and backend session identities
through the versioned AllAgents extension. Reasoning content is excluded by
default. Tool arguments, observations, and media follow explicit redaction,
size, and disclosure policy. Truncation or conversion loss is reported rather
than hidden.

ATIF remains optional until its compatibility policy, specification, tooling,
and non-Harbor conformance mature enough for a required public-contract
capability.

Harbor's task package, Job configuration, Job/Trial result models, hosted API,
artifact manifest, registry formats, and trial-directory layout will not become
the gateway contract. They remain Harbor-native formats that a future adapter
may preserve. Harbor's ASP `.asp.json` is a draft v0 sandbox proposal and is not
adopted by this decision.

### Make execution provenance and cleanup explicit

The gateway and selected worker are collectively responsible for:

1. validating one canonical immutable workspace request and the selected
   profile's exact source-resource or materializer authorization;
2. acquiring direct repositories, restoring a digest-pinned OCI snapshot, or
   running the registered materializer in a phase-scoped boundary;
3. producing and validating the standard workspace manifest;
4. transferring the validated staging tree to worker ownership, destroying the
   acquisition process/mount/credential boundary, and proving it gone;
5. atomically publishing the host-owned tree on the same filesystem;
6. running profile-owned setup before the evaluated agent action;
7. applying permissions and execution isolation;
8. invoking the agent and propagating cancellation and deadlines;
9. capturing bounded output, usage, cost, file changes, checks, artifact
   references, workspace identity, and materializer provenance;
10. returning terminal status, evidence completeness, and provenance; and
11. terminating processes and releasing or retaining resources according to
    the documented lifecycle.

Source transport, materializer image, workspace snapshot, and harness runtime
are independent identities. A backend may use one immutable runtime image plus
a separately digest-addressed workspace artifact; the contract does not require
source code to be baked into the runtime image.

Credentials remain deployment policy. Requests must not embed deployment
credentials. The gateway authenticates callers, and the selected worker scopes
source credentials to materialization and model credentials to provider
execution without returning secret-bearing paths or values. Materialization
credentials are absent from profile setup, the harness, model-initiated command
environments, tool output, retained evidence, and the published workspace.
Provider and worker-control credentials must likewise be absent from
model-initiated command environments, tool output, retained evidence, and
repository-visible configuration.

Retries must not multiply non-idempotent agent execution. Every request carries
a caller-scoped stable invocation key through the AllAgents extension. The
gateway binds the authenticated caller, invocation key, effective execution
profile, and request digest to the created Task for a documented retry-retention
window. An identical replay returns the original Task. Reusing the key with a
different request is rejected. Backend retry suppression remains an additional
safeguard; it does not replace gateway deduplication.

### Keep evaluation commands out of scope

This decision does not add `allagents eval`, benchmark authoring, assertions,
scoring, datasets, or experiment scheduling. A community evaluation wrapper and
an enterprise AI Evals wrapper may share this execution service in the future,
but their product and ownership model requires a separate decision.

## Consequences

- AllAgents becomes a service boundary in addition to a local CLI, but retains a
  narrow coding-execution responsibility.
- Consumers depend on A2A 1.0 plus a versioned AllAgents extension, not
  AllAgents TypeScript modules, CLI behavior, or workspace internals.
- Codex and Pi are the initial execution backends behind one conformance suite;
  Codex lands first and OpenCode is deferred.
- Durable Task and evidence records do not imply durable provider execution;
  interrupted attempts fail rather than resume or replay.
- The result-schema subset, structured-result Artifact, and non-success result
  states are public compatibility surface rather than adapter conventions.
- Reliable worker-crash cleanup requires an external execution supervisor and a
  pre-readiness orphan-root reaper in addition to leases.
- Gateway and execution workers scale and fail independently.
- The gateway can remain lightweight; physical isolation and resource policy
  belong to the selected execution backend.
- Custom acquisition remains available without making caller-supplied code part
  of the trust boundary: operators register digest-pinned materializers and
  profiles decide which callers may select them.
- Direct Git, OCI snapshots, and registered materializers converge on one
  validated workspace manifest and provenance contract.
- GitHub source credentials are selected by trusted host/profile policy rather
  than caller input. GitHub App is preferred when applicable; GitHub CLI is a
  local-only eligibility fallback and never masks an App authentication or
  authorization failure.
- Deployments that enable external materializers must operate their image,
  schema, credential, network, resource, and cache policies as worker
  configuration.
- A2A supplies discovery and lifecycle semantics. AllAgents supplies the
  coding-specific evidence contract.
- W3C Trace Context, OpenTelemetry/OTLP, OpenInference, optional ATIF, and the
  terminal evidence extension remain distinct layers rather than competing
  universal formats.
- Implementations must preserve bounded native evidence whenever normalization
  would lose information.

## Rejected alternatives

### Invent a bespoke invocation, run, or trial API

Rejected because A2A already defines remote-agent discovery, Task lifecycle,
streaming, artifacts, cancellation, errors, and web security. Coding-specific
evidence belongs in a versioned A2A extension rather than a parallel transport.

### Run agents in the gateway Pod

Rejected because it couples control-plane availability and credentials to
mutable repository execution, prevents independent scaling, and mistakes a
service boundary for per-invocation isolation.

### Use OpenInference instead of W3C Trace Context

Rejected as a category error. W3C Trace Context propagates trace identity;
OpenInference supplies AI semantic conventions on OpenTelemetry spans. The
gateway uses both.

### Use ATIF as the complete gateway result

Rejected because ATIF represents an ordered agent trajectory, not remote Task
lifecycle, repository provenance, workspace changes, produced artifacts,
cleanup, authorization, or evidence completeness.

### Adopt Harbor's Job or Trial API

Rejected because Harbor's formats own benchmark orchestration, verification,
and persisted runner state. The AllAgents gateway executes one coding-agent
request and does not become an evaluation harness.

### Let callers provide repository-acquisition code

Rejected because a caller-selected image, Dockerfile, Compose file, or shell
script would turn request parsing into privileged code execution and would make
credential, network, provenance, and cache policy unreviewable. Callers may
select only source modes and materializer IDs explicitly registered and allowed
by the effective execution profile.

### Replace A2A with the Agent Host Protocol

Rejected because AHP explicitly targets synchronization of independent clients
around host-owned sessions, not agent-to-agent Task execution. Its reconnect
and changeset models do not supply caller-scoped idempotency, immutable source
handling, cleanup, complete terminal evidence, or bounded Task retention.

### Vendor Promptfoo's Codex provider

Rejected because that provider includes Promptfoo-specific configuration
layering, caching, pricing, tracing, retry metadata, thread pooling, and result
mapping. AllAgents needs a smaller worker adapter against the Codex SDK and can
reuse Promptfoo's observable behavior as characterization evidence without
copying its implementation.

### Treat provider session persistence as durable execution

Rejected because a resumable provider thread does not prove workspace,
process, cancellation, evidence, or cleanup continuity across gateway or worker
failure. The initial service durably records failure and cleanup truth but does
not resume interrupted work.

## Reconsider when

Revisit this decision if A2A standardizes the required coding-execution evidence
without an extension, if a stable cross-vendor execution protocol subsumes the
same lifecycle and provenance guarantees, or if operational evidence shows that
the gateway and backend boundary prevents required cancellation, isolation, or
result integrity.
