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
source selection, repository acquisition, environment setup, credentials,
permissions, agent invocation, cancellation, evidence capture, process
termination, and cleanup. Those responsibilities need one public contract while
allowing materially different execution backends.

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

Execution backends own repository materialization, environment setup, agent
invocation, evidence collection, process termination, and cleanup. The gateway
must not execute evaluated agents or mount their writable repositories in the
gateway process.

When deployed on Kubernetes, the gateway runs as its own Deployment and
ClusterIP Service, separate from consumers and execution workers. A backend
dispatches to a worker pool, per-invocation Job, or stronger sandbox according
to the selected execution profile. The protocol does not require one worker
topology.

A separate gateway Pod is a service and failure boundary, not per-invocation
security isolation. Deployments requiring hostile-code or tenant isolation
must create or select a stronger execution boundary behind the gateway.

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
boundaries. AllAgents uses OpenTelemetry and OTLP for operational telemetry.
AllAgents-managed agent, model, and tool spans use
[OpenInference](https://arize-ai.github.io/openinference/) semantic conventions
where corresponding attributes exist; useful backend-native attributes may be
retained alongside them. Consumer-owned evaluator spans may join the propagated
trace without becoming gateway-owned.

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

The gateway and selected backend are collectively responsible for:

1. resolving and verifying immutable source identity;
2. acquiring or restoring source through the selected transport;
3. creating a fresh working location for one execution attempt;
4. running setup before the evaluated agent action;
5. applying permissions and execution isolation;
6. invoking the agent and propagating cancellation and deadlines;
7. capturing bounded output, usage, cost, file changes, checks, and artifact
   references;
8. returning terminal status, evidence completeness, and provenance; and
9. terminating processes and releasing or retaining resources according to the
   documented lifecycle.

Source transport and runtime transport are independent. A backend may use one
immutable runtime image plus a separately digest-addressed source artifact; the
contract does not require source code to be baked into the runtime image.

Credentials remain deployment policy. Requests must not embed deployment
credentials. The gateway authenticates callers, and the selected backend scopes
source and model credentials to the execution boundary without returning
secret-bearing paths or values. Provider and worker-control credentials must
also be absent from model-initiated command environments, tool output, retained
evidence, and repository-visible configuration.

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
