# ADR 0002: Serve coding-agent execution through an A2A gateway

- Status: Accepted; implementation pending
- Date: 2026-09-17
- Updated: 2026-09-21

## Decision

AllAgents will provide a separately installed gateway that lets trusted tools
start a configured Codex or Pi run remotely and receive its output, usage, file
changes, artifacts, source provenance, and cleanup outcome through A2A.

AI Evals is the first consumer. The gateway executes one coding-agent run; it
does not own datasets, scoring, assertions, scheduling, retries, or durable
evaluation records.

Version one serves one AllAgents project workspace on one trusted Linux runner.
Network access controls who can use it, and the runner is the execution and
secret boundary. This is not a sandbox for hostile code or model-invoked tools.

Implementation details live in the
[coding-agent execution gateway plan](../plans/2026-09-18-0837-feat-coding-execution-gateway-plan.md).
This ADR records the decisions and their impact.

## What changes for users

- **CLI users:** installing `allagents` does not install or start the gateway.
- **Operators:** install `allagents-gateway`, select one existing workspace, and
  run `allagents-gateway serve`. Existing project and user workspace files remain
  the source of truth.
- **Callers:** choose a configured target, declared workspace source, logical
  working directory, `readOnly` or `readWrite` access, a bounded deadline, and an
  optional result schema. They cannot provide repository URLs, host paths,
  commands, credentials, or environment overrides.
- **AI Evals:** owns the Promptfoo provider and evaluation behavior. AllAgents
  owns the gateway contract and documentation.

## Main flow

1. The operator starts the gateway for one project workspace.
2. A caller sends an A2A Message with one invocation key. Reusing that key with
   the same canonical request returns the same Task; a new key starts a new run.
3. The gateway reuses or prepares a workspace from declared Git repositories or
   an immutable OCI snapshot.
4. Codex or Pi runs on the trusted host against a validated read-only base,
   shared only for exact immutable requests, or a private disposable read-write
   workspace.
5. The gateway streams progress, handles cancellation, records observed evidence,
   cleans up Task-owned state, and frees the single execution slot. Uncertainty
   about source cleanup, an active mount, or a writable Task view stops admission.
   If it cannot confirm provider termination, it retains the slot and stays
   unready until teardown confirms the process is gone.

## Important consequences

### Network reachability grants full access

The gateway has no application login, caller identity, tenant isolation, or
per-caller privacy. Loopback is the default, but operators may expose it on a
private interface or `0.0.0.0`.

Every reachable caller can invoke every available target, inspect every retained
Task and Artifact, and request cancellation. Non-loopback exposure requires
operator-managed HTTPS and network access controls such as Tailscale ACLs,
firewalls, or container networking. Direct HTTP is limited to loopback use.

Providers and model-invoked tools may use the runner's credentials, secrets, and
network access. Explicit environments reduce accidental leakage but do not
create isolation. Application authentication and multi-tenant ownership are
deferred until the service must leave one trusted network.

### Callers choose logical work, not infrastructure

The gateway reuses existing workspace configuration; it does not add
`gateway.yaml` or `worker.yaml`. Built-in Codex and Pi targets are available when
ready. Profile-backed targets require explicit gateway enablement.

A request chooses either the complete configured repository set, with optional
revision overrides by declared name, or one declared OCI snapshot selected by
immutable digests. It never falls back between those modes. The operator owns
origins, destinations, credentials, and registry policy. Credential routing
prefers a proven applicable GitHub App and uses the configured `gh` account only
when the App is absent or positively ineligible. Ambiguity or failure after
selection never falls back to a broader identity.

The caller selects the workspace root or a directory beneath a declared
repository, never a physical host path. Invalid or escaping paths fail before
provider execution.

### Read-only is an optimization, not a security boundary

`readWrite` is the default and gives each Task a private disposable workspace.
`readOnly` uses a validated base: exact immutable requests may share a reusable
base, while mutable revisions get a Task-owned, non-reusable base. Every Task
still gets disposable private provider, temporary, and evidence state.

Read-only enforcement is cooperative. A provider that writes anyway can
contaminate the shared workspace and later Tasks; the operator must then evict
that workspace before reuse.

Workspace preparation is isolated from provider execution and receives only the
source credential and network access it needs. That credential and preparation
environment are gone before Codex or Pi starts.

### Providers run directly on the trusted host

Codex and Pi use supported, pinned integrations and existing host authentication.
The gateway does not run workspace `setup` shell entries, download a provider
runtime for each request, execute generated launcher files remotely, or expose
arbitrary installed executables.

If a supported integration lacks a required control, that target is unavailable
rather than silently weakening the public contract.

### One Task runs at a time

One execution slot covers workspace preparation, provider execution, evidence,
and cleanup. A second valid request becomes a failed Task with
`execution_capacity_unavailable`; it starts no workspace or provider work.

Task identity, retries, and visibility are shared across the gateway. Reusing an
invocation key for a different request conflicts.

Terminal Tasks and evidence are retained within configured limits. Unexpired
Tasks are not deleted to make room for new work. Prompts, output, structured
results, native evidence, and produced Artifacts remain sensitive and
unredacted.
Operational logs exclude credential values, secret-bearing paths, and
unrestricted prompt, output, tool, source, and file content.

### A2A provides the lifecycle; AllAgents defines coding execution

A2A 1.0 over HTTP+JSON provides discovery, Messages, Tasks, streaming, Artifacts,
cancellation, and errors. A required, versioned AllAgents extension adds targets,
workspace selection, idempotency, provenance, and evidence. Callers send the A2A
version and activate the extension on every operation that creates, returns,
lists, subscribes to, or mutates profiled Tasks or Artifacts. Missing extension
support and unsupported versions use standard A2A errors. Breaking changes use a
new extension version rather than silent fallback.

The known conformance question is authentication. A2A 1.0 says servers
authenticate requests and authorization-scope Task operations, while this design
has no application identity and treats every reachable caller as one authority
domain. Agent Card security declarations are optional, so the anonymous case is
not explicit. The implementation feasibility gate must resolve this before the
gateway claims full A2A 1.0 conformance. If it cannot, this ADR must be amended;
the implementation must not silently add authentication or weaken the
conformance claim.

### The gateway remains a separate product

`allagents` and `allagents-gateway` have independent versions and release
cadence. Installing the CLI fetches neither the gateway nor its workspace-
preparation image. Compatibility comes from versioned contracts, not matching
package versions.

Every terminal Task has exactly one versioned, extension-marked
execution-integrity Artifact, plus any produced Artifacts, even after failure or
cancellation. Consumers remain
responsible for evaluation workflows, retries, retention, sharing, and redaction.

## Failure behavior

- **Busy:** the new Task fails with `execution_capacity_unavailable`; no work
  starts.
- **Malformed source or working-directory input:** admission fails with
  `invalid_execution_request`; no Task is created.
- **Accepted source, credential, or logical-directory resolution then fails:**
  the Task fails with the corresponding stable error code and does not switch
  source mode or credential identity.
- **Gateway restart:** interrupted Tasks fail. Provider work is not resumed or
  automatically replayed.
- **Provider cannot be stopped:** the Task reports
  `execution_termination_failed` with live-provider and observed termination
  evidence, but no filesystem, Git, or produced-Artifact evidence. It retains
  its workspace and execution slot and leaves the gateway unready until teardown
  confirms the process is gone.
- **Workspace cleanup fails:** the Task reports `workspace_cleanup_failed` and
  retains enough state for later cleanup.
- **Durable Task state is unsafe:** the gateway stops admitting work and does not
  acknowledge creation or report success it cannot preserve.

Evidence describes only what the gateway observed. It never presents uncertain
termination, cleanup, provenance, or file state as verified.

## Deliberate limits

Version one deliberately avoids:

- application authentication, tenants, caller-private Tasks, and public-Internet
  hardening because the initial product assumes one trusted network;
- queues, concurrent execution, replicas, remote workers, shared provider
  daemons, and resumed provider sessions because one durable Task lifecycle is
  the initial boundary;
- caller-provided origins, physical host paths, configured destinations,
  commands, credentials, environments, or materializers because the gateway is
  not a remote shell;
- hostile-code containment and per-provider containers because the runner is
  already the execution and secret boundary;
- a bespoke or evaluator-specific API because A2A already owns the remote Task
  lifecycle;
- a second configuration registry because workspace files already own sources
  and profiles; and
- bundling or version-locking the gateway with the CLI because most CLI users do
  not need the service and the products have different release cadence.

## Reconsider when

Revisit this decision when:

- callers outside one trusted network must share the service;
- callers need private Tasks, distinct authorization, or audit identity;
- provider or model-tool code must be isolated from runner secrets;
- the gateway needs concurrency, replicas, shared daemons, or remote workers;
- non-Linux runners, new source materializers, or richer credential routing are
  required;
- A2A standardizes the coding-execution fields now carried by the AllAgents
  extension; or
- a stable cross-vendor protocol replaces the Codex/Pi adapter seam.
