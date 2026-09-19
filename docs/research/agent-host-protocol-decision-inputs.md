# Agent Host Protocol decision inputs for the execution gateway

## Decision

Keep A2A 1.0 plus the versioned AllAgents extension as the execution gateway's
northbound contract. Treat the Agent Host Protocol (AHP) as an optional future
protocol behind the gateway for a compatible backend or beside it for a
collaborative session client.

AHP does not replace ADR 0002's deployment-wide Task identity and idempotency,
network trust boundary, immutable source handling, cleanup, terminal evidence,
or bounded result retention.

The initial backend set is Codex and Pi; OpenCode is deferred. They are peer
execution adapters behind one conformance contract; provider-specific process,
session, permission, cancellation, and evidence behavior stays below that seam.

This note records the AllAgents-specific consequences. The reusable research,
source inspection, and full protocol comparison live in the AI Research Wiki:

- [Agent Host Protocol](https://github.com/tsoyang-org/ai-research-wiki/blob/main/entities/agent-host-protocol.md)
- [Agent Host Architecture](https://github.com/tsoyang-org/ai-research-wiki/blob/main/concepts/agent-host-architecture.md)
- [Agent Host Protocol vs Agent2Agent](https://github.com/tsoyang-org/ai-research-wiki/blob/main/comparisons/agent-host-protocol-vs-agent2agent.md)
- [VS Code Agent Host source note](https://github.com/tsoyang-org/ai-research-wiki/blob/main/raw/articles/vscode-agent-host-architecture.md)

## Boundary

| Concern | AllAgents A2A gateway | AHP host/session layer |
|---|---|---|
| Northbound consumer | AI Evals and future trusted-network execution clients | IDE, browser, CLI, or collaborative operator client |
| Primary lifecycle | One addressable Task per accepted execution | Long-running session/chat with shared clients |
| Public identity | Agent Card, Message, Task, Artifact, invocation key | Host, client, channel, session, chat, turn, tool call |
| State | Deployment-wide Task status, messages, artifacts, retention | Snapshots, ordered actions, reducers, reconnect |
| Authorization | Network reachability; no application caller identity | Endpoint/resource auth and tool confirmation |
| Cancellation | Cancel Task, abort backend, terminate, clean up, report terminal outcome | Cancel interactive turn and call provider-native abort |
| Evidence | Source, output, usage/cost, traces, file changes, artifacts, failures, cleanup, completeness, provenance | Live changesets and provider/session state |
| Isolation | Single-process supervisor with invocation-owned child containment | Not supplied by the shared host process |

The identities must be correlated rather than reused. At minimum retain the A2A
Task ID, AllAgents invocation key, backend execution/session ID,
provider-native thread/chat ID, and trace ID.

## Adopt now

1. Define one narrow backend adapter contract for create/invoke, progress,
   permission decisions, cancellation, terminalization, evidence collection,
   shutdown, native evidence passthrough, and explicit capabilities.
2. Keep A2A and backend responsibilities separate inside one gateway service.
   The A2A layer owns deployment-wide Task/idempotency identity, backend
   selection, normalized results, cancellation propagation, and retention. The
   invocation supervisor owns source acquisition, provider child processes,
   mutable workspaces, evidence capture, process termination, and cleanup.
3. Propagate `CancelTask` and deadlines through the adapter to the
   provider-native abort primitive, then persist terminal status and cleanup
   outcome. Transport closure is not cancellation.
4. Separate network authorization, execution permission policy, and
   provider/resource credentials. The initial gateway has no application caller
   identity.
5. Combine normalized file operations with bounded provider-native
   diffs/checkpoints/trajectories. Declare attribution limits and
   incompleteness rather than treating the final working-tree diff as exact
   agent causality.
6. Persist terminal facts independently of progress streams and telemetry.
7. Capability-gate backend behavior instead of inferring it from provider names
   or software versions.
8. Keep Task lists and metadata bounded; store large logs, diffs, traces, and
   produced artifacts behind references with size, redaction, and truncation
   metadata.

## Defer

- An AHP backend adapter until a selected backend actually exposes AHP.
- An AHP server or multi-client reducer/reconciliation engine until a
  collaborative session client is a product requirement.
- Client-contributed tools and customizations for unattended evaluation
  profiles.
- Active-session reconnection beyond A2A Task lookup, subscription, and
  terminal result retrieval.
- AHP local endpoint discovery, SSH host selection, and tunnel multiplexing.
- Remote worker ownership, routing, and session transport until the initial
  single-process gateway needs a separate execution host.
- Generic changeset review/operation state.
- Long-lived session/chat catalogs and provider-native session adoption.

## Reject

- Replacing A2A with AHP for the execution gateway.
- Running evaluated agents or writable repositories in the gateway process.
- Treating AHP changesets as the complete AllAgents evidence envelope.
- Treating AHP action replay or session restoration as execution idempotency.
- Copying VS Code's local connection-token model as gateway authentication.
- Branching on provider names above the adapter boundary.
- Making a connected interactive client a hidden prerequisite for unattended
  execution.

## Evidence

The conclusion is based on:

- Microsoft's [Agent Host architecture article](https://code.visualstudio.com/blogs/2026/08/26/agent-host-architecture);
- the official [Agent Host Protocol documentation](https://microsoft.github.io/agent-host-protocol/);
- direct inspection of `microsoft/vscode` commit
  [`046944034292b5479b4e9a50ad1a508033ffb64f`](https://github.com/microsoft/vscode/tree/046944034292b5479b4e9a50ad1a508033ffb64f),
  whose generated registry identifies AHP `0.9.0`; and
- [ADR 0002](../decisions/0002-serve-coding-agent-execution-through-an-a2a-gateway.md).

The inspected implementation demonstrates host-owned state/sequencing,
provider-neutral adapters for Copilot, Claude, and Codex, layered persistence,
bounded reconnect replay, provider-native cancellation, client-owned tools,
permission translation, Git checkpoint plus SDK edit evidence, and local/remote
host placement. These observations support the architecture seams above; they
do not supply the public execution guarantees retained by ADR 0002.
