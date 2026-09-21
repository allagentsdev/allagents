# ADR 0002: Serve coding-agent execution through an A2A gateway

- Status: Accepted; implementation pending
- Date: 2026-09-17
- Updated: 2026-09-21

## Decision

AllAgents will provide a separately installed gateway that lets trusted tools
start a configured Codex or Pi run remotely and receive its output, usage, file
changes, artifacts, source provenance, and cleanup outcome through A2A.

AI Evals is the first consumer. The gateway executes one coding-agent turn at a
time; it does not own datasets, scoring, assertions, scheduling, retries, or
durable evaluation records.

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
  working directory, `readOnly` or `readWrite` access, a bounded deadline,
  optional result schema, and one-shot/start/resume session mode. They cannot
  provide repository URLs, host paths, commands, credentials, or environment
  overrides.
- **AI Evals:** owns the Promptfoo provider, turn chaining, and evaluation
  behavior. AllAgents preserves provider/workspace session continuity and
  reports native cached-input usage, but does not guarantee a model cache hit.

## Main flow

1. The operator starts the gateway for one project workspace.
2. A caller sends an A2A Message with one invocation key for one turn. It may run
   one-shot, start a session, or resume the exact head Task in an existing
   context. Reusing the key with the same canonical request returns the same
   Task; each intentional new turn uses a new key and immutable Task.
3. The gateway reuses or prepares a workspace from declared Git repositories or
   an immutable OCI snapshot. A resumed read-write session derives a per-turn
   candidate from its last committed workspace generation.
4. Codex or Pi runs on the trusted host against a validated read-only base or the
   private candidate. A session resumes the provider-native conversation.
5. The gateway streams progress, handles cancellation, and records observed
   evidence. A successful continuing turn atomically advances the provider
   checkpoint, committed workspace generation, and session head; a one-shot or
   closing turn cleans up. Cleanup/checkpoint uncertainty, a live provider
   process group, or an observed escaped/outliving descendant retains the
   execution slot and makes the gateway unready. Process groups do not prove that
   an unobserved hostile descendant cannot escape the trusted runner boundary.

## Important consequences

### Network reachability grants full access

The gateway has no application login, caller identity, tenant isolation, or
per-caller privacy. Loopback is the default. Version one supports two enforceable
private topologies:

- bind loopback HTTP and expose it only through a private HTTPS terminator such
  as Tailscale Serve; or
- bind one specific loopback, RFC 1918, RFC 4193, link-local, or RFC 6598
  address and serve TLS itself from configured certificate/key files.

Wildcard and public-address listeners are rejected. The advertised URL is
loopback HTTP for local development or private HTTPS for either remote topology.
Every reachable caller can invoke every available target, inspect every retained
Task and Artifact, resume every retained conversation, and request cancellation.
Operators must also enforce Tailscale ACLs, private firewall rules, or equivalent
network policy. Version one must not be exposed to the public Internet.

Providers and model-invoked tools may use the runner's credentials, secrets, and
network access. Explicit environments reduce accidental leakage but do not
create isolation. Public-Internet exposure requires application authentication,
authorization, and an amended ADR before deployment.

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

`readWrite` is the default. A one-shot Task gets a disposable workspace. A
read-write session keeps an immutable committed generation and runs each turn in
a candidate that becomes committed only with the provider checkpoint/session
head. `readOnly` uses a validated base: exact immutable requests may share one,
while mutable revisions get a Task/session-owned non-reusable base. Every
one-shot Task/session still gets private provider, temporary, and evidence state.

Read-only enforcement is cooperative. A provider that writes anyway can
contaminate the shared workspace and later Tasks; the operator must then evict
that workspace before reuse.

Workspace preparation is isolated from provider execution and receives only the
source credential and network access it needs. That credential and preparation
environment are gone before Codex or Pi starts.

### Providers run directly on the trusted host

Codex and Pi use supported, pinned integrations. Mutable provider/session state
lives in Task/session-private storage. Existing host authentication is reusable
only when the pinned integration can reference it separately without copying,
mounting, parsing, or writing conversation state into the auth location.
Otherwise that auth/target/mode combination is unavailable. The gateway does not
run workspace `setup` shell entries, download a provider runtime for each
request, execute generated launcher files remotely, or expose arbitrary
installed executables. It never silently weakens its advertised contract.

### One gateway-controlled Task runs at a time

One execution slot covers workspace preparation, one session turn, evidence, and
cleanup/checkpointing. A second valid request becomes a failed Task with
`execution_capacity_unavailable`; it starts no gateway-controlled workspace or
provider work. Sessions never run concurrent turns.

This is an admission and supervision invariant, not hostile-process containment.
An observed escaped/outliving descendant retains the slot until verified gone or
runner teardown. An unobserved descendant can outlive a turn because version one
does not provide a non-bypassable process boundary.

Task identity, retries, and visibility are shared across the gateway. Reusing an
invocation key for a different request conflicts. Each turn is a new immutable
Task; the session persists conversation and committed workspace state between
turns.

Terminal Tasks and evidence are retained within configured limits. Unexpired
Tasks are not deleted to make room for new work. Prompts, output, structured
results, native evidence, and produced Artifacts remain sensitive and
unredacted.
Operational logs exclude credential values, secret-bearing paths, and
unrestricted prompt, output, tool, source, and file content.

### The Harness Execution Contract owns semantics; A2A is the first binding

The caller may be an evaluation runner, chat platform, application, or another
agent. The shared domain is therefore not agent-to-agent collaboration or one
vendor's HTTP shape; it is configured harness execution.

AllAgents defines a transport-neutral, versioned Harness Execution Contract (HEC).
Its Core conformance class covers one turn: configured target selection,
idempotency, deadlines, ordered progress, normalized tool-call/result trajectory,
cancellation, terminal result, usage, stable failures, and artifacts. The
version-one Sessions extension adds a durable session identity, ordered turns,
provider-native conversation resumption, a retained workspace, expiry, and
close-after-turn cleanup. One-shot Core invocation remains available when a
caller does not request a session.

Protocol bindings map that contract onto an existing transport without changing
its semantics. Core owns neutral outcomes such as `timedOut` and the cancel
dispositions `accepted | alreadyTerminal`; each binding maps those outcomes to
its own state and response vocabulary. Every binding must pass the same Core
semantic vectors plus its own wire-conformance cases. A2A 1.0 over HTTP+JSON is
the first binding: discovery uses an Agent Card, one turn becomes one Message
and one immutable Task, ordered execution events become Task updates and
Artifacts, and A2A owns streaming, retrieval, cancellation, and transport
errors. A2A `contextId` identifies the durable session; a resumed turn uses the
same context and references the prior terminal Task. An A2A Client may be an
application or an agent; neither side needs autonomous multi-agent behavior.

The AllAgents coding-workspace extension remains separate from Core and
Sessions. It defines configured Git/OCI sources, logical working directories,
access mode, provenance, produced files, integrity, and cleanup. A session pins
those inputs and retains its private provider state and workspace until
close-after-turn, expiry, or verified operator cleanup. Version one uses the
non-dereferenceable Profile Extension identifier
`urn:allagents:a2a:profile:coding-execution:v1`, which composes the HEC A2A
binding, Sessions, and the coding-workspace extension. This URN identifies a
contract; it is not a network endpoint. Their schemas and conformance groups
remain independently validatable. Breaking changes use a new URN rather than
silent fallback.

This is a contract and standard candidate, not a claimed neutral standard.
AllAgents should describe it as a standard only after independent
implementations, multiple bindings, executable cross-binding conformance, and
neutral governance exist.

The known A2A-binding conformance question is authentication. A2A 1.0 says
servers authenticate requests and authorization-scope Task operations, while
this design has no application identity and treats every reachable caller as
one authority domain. Agent Card security declarations are optional, so the
anonymous case is not explicit. The implementation feasibility gate must
resolve this before the gateway claims full A2A 1.0 conformance. If it cannot,
this ADR must be amended; the implementation must not silently add
authentication or weaken the conformance claim.

### UHP informs a future Responses binding but is not the version-one wire

The Unified Harness Protocol (UHP) is a close semantic match for
application-to-harness execution. Its Responses-compatible request shape,
ordered tool-call/result output, durable session with conversation and working
directory continuity, exact `previous_response_id` predecessor chaining,
lifecycle vocabulary, and executable conformance suite are design inputs for
Core, Sessions, and a possible future Responses/UHP binding.

UHP is not adopted as the version-one wire because its conformant core also
assumes application authentication, principal scoping, and concurrent work
across sessions. Those are appropriate for a hosted, multi-user harness router
but conflict with this gateway's trusted-private-network and one-execution-slot
boundary. UHP also leaves the AllAgents-specific Git/OCI acquisition and
integrity evidence contract to an extension, so it would not eliminate the
domain contract this project must own.

Version one exposes only the A2A binding. The implementation may reuse UHP
semantics, not UHP wire claims. It must not advertise UHP compatibility without
implementing a defined binding and passing the applicable UHP and
Harness Execution Contract conformance suites.

### The gateway remains a separate product

`allagents` and `allagents-gateway` have independent versions and release
cadence. Installing the CLI fetches neither the gateway nor its workspace-
preparation image. Compatibility comes from versioned contracts, not matching
package versions.

Every terminal Task has exactly one versioned Core outcome Artifact, one ordered
normalized Core execution-trajectory Artifact, one AllAgents workspace-
integrity Artifact, and any produced Artifacts, even after failure or
cancellation. Consumers remain responsible for evaluation workflows, retries,
retention, sharing, and redaction.

## Failure behavior

- **Busy:** the new Task fails with `execution_capacity_unavailable`; no work
  starts.
- **Malformed source or working-directory input:** admission fails with
  `invalid_execution_request`; no Task is created.
- **Accepted source, credential, or logical-directory resolution then fails:**
  the Task fails with the corresponding stable error code and does not switch
  source mode or credential identity.
- **Gateway restart:** interrupted Tasks fail and are never replayed. A retained
  session remains resumable only after the gateway confirms the recorded process
  group and observed descendants are gone, discards any uncommitted workspace
  candidate, and verifies the prior provider/workspace checkpoint pair;
  otherwise it becomes non-resumable pending cleanup.
- **Provider cannot be stopped:** the Task reports
  `execution_termination_failed` with live-provider and observed termination
  evidence, but no filesystem, Git, or produced-Artifact evidence. A live process
  group or observed outliving descendant retains its workspace/execution slot
  and leaves the gateway unready until verified disappearance or runner teardown.
- **Workspace cleanup fails:** the Task reports `workspace_cleanup_failed` and
  retains enough state for later cleanup.
- **Durable gateway state is unsafe:** the gateway stops admitting work and does
  not acknowledge creation or report success it cannot preserve.

Evidence describes only what the gateway observed. It never presents uncertain
termination, cleanup, provenance, or file state as verified.

## Deliberate limits

Version one deliberately avoids:

- application authentication, tenants, caller-private Tasks, and public-Internet
  exposure because version one is restricted to one trusted private network;
- queues, concurrent admission, replicas, remote workers, and shared provider
  daemons because the gateway supervises one admitted turn at a time;
- caller-provided origins, physical host paths, configured destinations,
  commands, credentials, environments, or materializers because the gateway is
  not a remote shell;
- hostile-code containment and per-provider containers because the runner is
  already the execution/secret boundary. An unobserved escaped descendant can
  overlap a later admitted turn; operators needing OS-wide exclusivity must use
  an ephemeral runner boundary or wait for a future containment design;
- a bespoke or evaluator-specific API because HEC owns harness semantics and A2A
  already owns the version-one remote Task and multi-turn context lifecycle;
- a second wire binding because version one proves Core and Sessions through
  A2A before adding Responses/UHP;
- a second configuration registry because workspace files already own sources
  and profiles; and
- bundling or version-locking the gateway with the CLI because most CLI users do
  not need the service and the products have different release cadence.

## Reconsider when

Revisit this decision when:

- callers outside one trusted private network must share the service, which
  requires application authentication and authorization before exposure;
- provider or model-tool code must be isolated from runner secrets;
- OS-wide turn exclusivity is required, which needs a non-bypassable provider
  lifecycle boundary before the gateway may admit a later turn;
- the gateway needs concurrency, replicas, shared daemons, or remote workers;
- non-Linux runners, new source materializers, or richer credential routing are
  required;
- another independent implementation needs the Harness Execution Contract or a
  second binding, at which point both must pass the shared Core conformance
  vectors without changing Core semantics;
- session branching or concurrent turns, which require explicit fork semantics
  beyond the version-one linear session history;
- A2A standardizes equivalent portable harness-execution semantics that should
  replace or upstream the AllAgents binding;
- UHP gains neutral multi-vendor governance, several independent conformant
  implementations, and a one-shot conformance class suitable for a
  Responses/UHP binding; or
- a stable cross-vendor protocol replaces the Codex/Pi adapter seam.
