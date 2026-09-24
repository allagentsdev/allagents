# E2B execution gateway patterns

## Scope and evidence date

This note describes E2B's public product and source as of **2026-09-22**. Source links to code pin runtime commit [`9dd5b72`](https://github.com/e2b-dev/runtime/tree/9dd5b727318831ebbdd84cc9f51b25c5f3af96c8) (2026-09-22) and SDK commit [`ccaf9fc`](https://github.com/e2b-dev/E2B/tree/ccaf9fc0ffe6ac39c7ec786af7608ab1de19467b) (2026-09-18). Links to unversioned official product documentation were accessed 2026-09-22.

## Product boundary

E2B exposes **sandbox infrastructure**, not an agent-neutral execution protocol. Its public contract creates and controls Linux sandboxes, runs commands and PTYs, reads and writes files, exposes guest ports, and manages templates, snapshots, and volumes. The official [coding-agent guide](https://docs.e2b.dev/use-cases/coding-agents.md) requires the application to install its chosen agent in a template and extract the resulting diff or files. The [Codex integration](https://docs.e2b.dev/agents/codex.md) likewise creates a sandbox, passes a Codex credential, clones a repository, invokes `codex exec`, interprets Codex-specific output, retrieves a diff, and kills the sandbox in caller code. The [public OpenAPI document](https://docs.e2b.dev/openapi-public.yaml) describes sandbox infrastructure resources rather than a common agent run/session/event/result model.

That makes E2B usable as a sandbox provider beneath an execution gateway. Repository acquisition, harness selection, credential policy, prompt construction, reconnect/retry behavior, normalized events, terminal outcomes, and result provenance remain responsibilities above E2B.

## Runtime architecture

The open [`e2b-dev/runtime`](https://github.com/e2b-dev/runtime/blob/9dd5b727318831ebbdd84cc9f51b25c5f3af96c8/README.md) repository describes itself as the complete backend used by E2B Cloud, Enterprise, and Embed. Its [architecture specification](https://github.com/e2b-dev/runtime/blob/9dd5b727318831ebbdd84cc9f51b25c5f3af96c8/docs/ARCHITECTURE.md) defines these boundaries:

- **API/control plane:** authenticates callers, enforces quotas, places sandboxes, and records durable and ephemeral state.
- **Orchestrator:** runs on each KVM host and owns Firecracker, cgroups, network namespaces, veth/tap devices, NBD-backed root filesystems, snapshots, caches, and template builds.
- **Client proxy/data plane:** routes sandbox traffic directly to the selected orchestrator; guest traffic does not pass through the control-plane API.
- **`envd`:** runs inside each microVM and exposes authenticated process, PTY, filesystem, watcher, upload/download, signal, and port APIs. Public proxying rejects internal init, upgrade, freeze, and thaw routes.
- **State stores:** PostgreSQL holds durable metadata; Redis holds running-sandbox and routing state; ClickHouse holds events, metrics, and optionally logs; object storage holds template and paused-sandbox artifacts.

Each sandbox is one Firecracker microVM with its own guest kernel. The Firecracker process gets its own cgroup and network namespace; the host supplies a COW root filesystem, memory restore, and network policy. This is a stronger guest boundary than a shared-kernel container, while still trusting a privileged, root-running host orchestrator and the host kernel/KVM boundary ([architecture](https://github.com/e2b-dev/runtime/blob/9dd5b727318831ebbdd84cc9f51b25c5f3af96c8/docs/ARCHITECTURE.md), [security](https://e2b.dev/security)).

## Lifecycle, templates, and persistence

A template is a pre-booted snapshot of memory, filesystem, and machine state. Template builds execute layered phases, hash step inputs, cache reusable layers, and produce immutable artifacts. Sandbox creation restores that snapshot, lazily faults memory through `userfaultfd`, and overlays root filesystem writes. The result is fast creation without making the container image or install recipe the live runtime boundary ([architecture](https://github.com/e2b-dev/runtime/blob/9dd5b727318831ebbdd84cc9f51b25c5f3af96c8/docs/ARCHITECTURE.md), [template mechanics](https://docs.e2b.dev/template/how-it-works.md), [cache semantics](https://docs.e2b.dev/template/caching.md)).

E2B distinguishes three related artifacts:

- **Declarative template:** reproducible start state built from a recipe; the preferred durable baseline.
- **Paused sandbox:** preserves filesystem, memory, and processes until explicitly killed in managed E2B ([persistence](https://docs.e2b.dev/sandbox/persistence.md)).
- **Live snapshot/fork:** captures a running sandbox as a reusable checkpoint; active PTY, WebSocket, and command streams disconnect and must be re-established ([snapshots](https://docs.e2b.dev/sandbox/snapshots.md)).

Template and paused-sandbox storage use the same broad artifact shape: memory, rootfs, VM state, metadata, and memory/rootfs index files. Persistent volumes are a separate, private-beta resource, and their content path is served by a separate `belt` API rather than the main control-plane API ([volumes](https://docs.e2b.dev/volumes.md), [architecture](https://github.com/e2b-dev/runtime/blob/9dd5b727318831ebbdd84cc9f51b25c5f3af96c8/docs/ARCHITECTURE.md)). E2B's file API transfers and manipulates guest files, but it does not define an agent-run artifact manifest or source/workspace provenance model ([filesystem upload](https://docs.e2b.dev/filesystem/upload.md)).

## SDK and API shape

The JavaScript and Python SDKs expose sandbox lifecycle, commands/process streaming, PTYs, filesystem operations, networking, templates, snapshots, volumes, and secrets. Callers can target another deployment through `E2B_API_URL`, `E2B_SANDBOX_URL`, an API key, or an explicit client/domain ([connection configuration](https://github.com/e2b-dev/E2B/blob/ccaf9fc0ffe6ac39c7ec786af7608ab1de19467b/packages/js-sdk/src/connectionConfig.ts), [custom client](https://docs.e2b.dev/client.md)). This is a clean provider seam, but it is a sandbox API seam rather than an agent/harness abstraction.

Version compatibility needs active management. SDK release [`e2b@2.51.0`](https://github.com/e2b-dev/E2B/releases/tag/e2b%402.51.0) (2026-09-18) moved create/connect behavior onto v2 endpoints. The SDK [changelog](https://github.com/e2b-dev/E2B/blob/ccaf9fc0ffe6ac39c7ec786af7608ab1de19467b/packages/js-sdk/CHANGELOG.md) also warns that an older self-hosted/BYOC control plane can silently ignore a newer resume option. A provider integration therefore needs an explicit tested SDK/control-plane compatibility range.

## Deployment and self-hosting boundary

“Self-hosted E2B” currently describes more than one materially different operating model:

| Mode | Where it runs | Who operates it | Current boundary |
| --- | --- | --- | --- |
| E2B Cloud | E2B account | E2B | Managed control and data planes. |
| BYOC | Customer AWS or GCP account/VPC | E2B | E2B provisions, monitors, and upgrades it; E2B Cloud remains the management/control plane. Official docs explicitly say this is managed deployment, not self-hosting ([BYOC](https://docs.e2b.dev/byoc.md), [security](https://e2b.dev/security)). |
| E2B Embed | One operator-owned KVM machine | Operator | The whole functional stack and sandboxes run locally; available as Compose, one-GCE-instance Terraform, or a single-node Kubernetes StatefulSet ([Embed](https://github.com/e2b-dev/runtime/blob/9dd5b727318831ebbdd84cc9f51b25c5f3af96c8/embed/README.md)). |
| Private Cloud | Customer environment | Customer/E2B contract not yet public | Listed as “in development”; intended to keep both planes within the customer boundary ([enterprise](https://e2b.dev/enterprise)). |

E2B is therefore self-runnable today as a complete **single-node functional stack**, but the public package is not a complete, supported **production multi-node self-operated distribution**. The Embed repository calls Compose, GCP Terraform, and Kubernetes “single-machine evaluation packages, not deployment patterns.” The current enterprise page calls Embed available and suitable for self-hosting/embedding while separately listing Private Cloud as in development. Both statements matter: availability does not establish HA, production operations, or air-gap support.

### E2B Embed operational facts

The [Compose guide](https://github.com/e2b-dev/runtime/blob/9dd5b727318831ebbdd84cc9f51b25c5f3af96c8/embed/compose/README.md) requires Linux, KVM, `/dev/net/tun`, cgroup v2, NBD, 4 KiB pages, hugepages, Docker Engine 27+, Compose 2.24+, about 12 GiB RAM, and 20 GiB free disk. It supports x86-64 and arm64, with newer arm64 kernel requirements. It is not a rootless or container-only Firecracker deployment.

The [reference](https://github.com/e2b-dev/runtime/blob/9dd5b727318831ebbdd84cc9f51b25c5f3af96c8/embed/docs/REFERENCE.md) shows that Embed includes local PostgreSQL, Redis, ClickHouse, Vector, dashboard/API, client proxy, template builder, orchestrator, and local template/build storage. Logs remain in local ClickHouse for seven days. Running sandboxes end when the orchestrator stops; the launcher now sweeps sandbox cgroups on termination and after a crash.

Durability depends on packaging:

- Compose named volumes and local storage survive ordinary stack shutdown, but running VMs do not.
- The [Kubernetes package](https://github.com/e2b-dev/runtime/blob/9dd5b727318831ebbdd84cc9f51b25c5f3af96c8/embed/kubernetes/README.md) is a privileged, host-network/host-PID StatefulSet pinned to one labelled KVM node. It uses node-local `hostPath`; sandboxes end on pod deletion/restart, and the guide calls for a dedicated node.
- The [GCP Terraform package](https://github.com/e2b-dev/runtime/blob/9dd5b727318831ebbdd84cc9f51b25c5f3af96c8/embed/terraform/gcp/README.md) creates a managed instance group of one with no persistent data disk. Instance replacement loses databases and built templates.

The default installation is not turnkey air-gapped. Initial Compose setup fetches images from Docker Hub and Google Artifact Registry and binaries from Google Storage/GitHub; template builds normally pull a base image. Published binaries are pinned and accompanied by SHA-256 files, but the public runtime repository is a read-only mirror of E2B's internal source-of-truth monorepo ([release process](https://github.com/e2b-dev/runtime/blob/9dd5b727318831ebbdd84cc9f51b25c5f3af96c8/docs/RELEASING.md), [Embed reference](https://github.com/e2b-dev/runtime/blob/9dd5b727318831ebbdd84cc9f51b25c5f3af96c8/embed/docs/REFERENCE.md)). No official offline-mirroring deployment procedure was found in the current public documentation.

### Managed-feature parity

The open runtime is substantial, but standard Embed is not configuration-equivalent to E2B Cloud/BYOC:

- Embed's [Compose definition](https://github.com/e2b-dev/runtime/blob/9dd5b727318831ebbdd84cc9f51b25c5f3af96c8/embed/compose/compose.yaml) does not configure the separate secret-store backend and explicitly disables volume-content token support. The API returns an error when the secret backend/feature is unavailable ([secret handler](https://github.com/e2b-dev/runtime/blob/9dd5b727318831ebbdd84cc9f51b25c5f3af96c8/packages/api/internal/handlers/secrets.go)).
- The SDK documents SOCKS5 egress proxying as Cloud/BYOC functionality that an open-source runtime deployment rejects ([SDK source](https://github.com/e2b-dev/E2B/blob/ccaf9fc0ffe6ac39c7ec786af7608ab1de19467b/packages/js-sdk/src/sandbox/sandboxApi.ts)).
- Workload-identity definitions can cross the open API/orchestrator contract, but the open [orchestrator protocol](https://github.com/e2b-dev/runtime/blob/9dd5b727318831ebbdd84cc9f51b25c5f3af96c8/packages/orchestrator/orchestrator.proto) explicitly says it does not mint, sign, or deliver the credential.

These are feature-boundary facts, not evidence that the single-node runtime is a stub: it can build templates and run real Firecracker sandboxes through the same SDK surface.

## Security and networking boundary

The Firecracker/KVM boundary is complemented by per-sandbox cgroups, namespaces, NBD devices, NAT, nftables, and token-authenticated `envd`. Public sandbox ingress can require an access token. Those controls do not remove operator obligations around the privileged host and management network.

Embed deliberately exposes a low-level local stack. Its [README](https://github.com/e2b-dev/runtime/blob/9dd5b727318831ebbdd84cc9f51b25c5f3af96c8/embed/README.md) says 13 ports bind all interfaces. Only API, dashboard, and client proxy ports 3000–3002 are for trusted clients; the other ten must be firewalled. In particular, orchestrator gRPC on port 5008 is unauthenticated and grants full orchestrator control. Embed does not supply wildcard DNS or TLS. Its plain-HTTP dashboard configuration cannot mark the team-key cookie `Secure` ([reference](https://github.com/e2b-dev/runtime/blob/9dd5b727318831ebbdd84cc9f51b25c5f3af96c8/embed/docs/REFERENCE.md)).

Outbound internet access defaults on. E2B supports IP/CIDR allow and deny lists plus HTTP Host/TLS SNI domain allowlists, but its [network documentation](https://docs.e2b.dev/network/internet-access.md) records important limits: domain filtering sees Host only on HTTP/80 and SNI only on TLS/443; it does not cover UDP/QUIC or arbitrary ports; allow wins over deny; shared CDN/IP use weakens domain isolation; and a blocked TCP connection can appear established until application data is attempted. E2B itself says a domain allowlist is a routing control, not a strict security boundary on shared infrastructure.

## Operations and observability

Runtime services emit OpenTelemetry. Orchestrators publish lifecycle events and host statistics; ClickHouse stores metrics/events and optionally logs. Production architecture supports centralized observability, while Embed intentionally uses local Vector → ClickHouse with a fixed seven-day retention and no Loki or LaunchDarkly dependency ([architecture](https://github.com/e2b-dev/runtime/blob/9dd5b727318831ebbdd84cc9f51b25c5f3af96c8/docs/ARCHITECTURE.md), [Embed reference](https://github.com/e2b-dev/runtime/blob/9dd5b727318831ebbdd84cc9f51b25c5f3af96c8/embed/docs/REFERENCE.md)).

A 2025 [self-hosting report](https://github.com/e2b-dev/runtime/issues/1421) documented orphaned Firecracker processes/veth state after an orchestrator crash, cache-locality concerns, and difficult Kubernetes resource accounting. At the time, E2B recommended replacing the node. Current runtime code adds startup reclaim and single-instance locking, and Embed's launcher sweeps cgroups before restart. The history is still useful: privileged node reconciliation, cache placement, and capacity accounting are production concerns, not incidental packaging details.

## Patterns supported by the evidence

Patterns that can be evaluated independently of an E2B adoption decision:

1. **Separate lifecycle control from sandbox traffic.** Keep placement, quotas, and durable state in the control plane; route high-volume process/file/port traffic directly through a data-plane proxy.
2. **Hide host mechanics behind a node-local orchestrator.** The gateway should not understand NBD, Firecracker, cgroups, namespaces, or snapshot files.
3. **Use an explicit lifecycle state machine.** Running, pausing, paused, resuming, snapshotting, forking, and killed states need durable identities and well-defined terminal behavior.
4. **Separate reproducible templates from live checkpoints.** A build recipe and a memory-preserving snapshot answer different provenance and recovery questions.
5. **Make cold-start optimizations content-addressed.** Hash steps and inputs, share immutable layers, prefetch likely pages, and use COW overlays rather than copying a workspace/rootfs on every start.
6. **Keep the guest API narrow.** Authenticated process/PTY and filesystem operations are a useful runtime primitive; private init/upgrade/checkpoint routes should not share the public proxy path.
7. **Treat networking as a first-class per-run contract.** Record ingress authentication and egress policy with the run. E2B's documented domain-filter limits show why policy claims must match enforcement layers.
8. **Design crash reconciliation with the runtime.** Startup reclaim, idempotent teardown, single-instance locks, and explicit cache/storage recovery belong in the node contract before multi-node production use.
9. **Expose runtime telemetry without making it the agent protocol.** Lifecycle events, resource metrics, logs, and trace context should correlate with a gateway run ID, while normalized agent events remain above the sandbox provider.
10. **Pin a provider compatibility matrix.** SDK, API, guest daemon, kernel, Firecracker, and template versions change on different cadences; deployment provenance needs immutable versions and checksums.

Patterns that should remain above any E2B provider adapter are harness/provider routing, credentials and source authorization, workspace provenance, event normalization, completion taxonomy, result/artifact manifests, retries/idempotency, and cross-provider conformance.

## Licensing and current activity

The runtime and dashboard repositories use Apache-2.0 ([runtime license](https://github.com/e2b-dev/runtime/blob/9dd5b727318831ebbdd84cc9f51b25c5f3af96c8/LICENSE), [dashboard license](https://github.com/e2b-dev/dashboard/blob/main/LICENSE)). The JavaScript and Python SDK package licenses are MIT ([JS SDK](https://github.com/e2b-dev/E2B/blob/ccaf9fc0ffe6ac39c7ec786af7608ab1de19467b/packages/js-sdk/LICENSE)). Runtime `main` had changes on 2026-09-22, runtime release [`2026.30`](https://github.com/e2b-dev/runtime/releases/tag/2026.30) was published 2026-09-10, and SDK release [`e2b@2.51.0`](https://github.com/e2b-dev/E2B/releases/tag/e2b%402.51.0) was published 2026-09-18. Embed itself is recent and still explicitly framed as evaluation packaging in source.

## Primary sources

- [Runtime repository and architecture](https://github.com/e2b-dev/runtime/tree/9dd5b727318831ebbdd84cc9f51b25c5f3af96c8) — source dated 2026-09-22.
- [SDK repository](https://github.com/e2b-dev/E2B/tree/ccaf9fc0ffe6ac39c7ec786af7608ab1de19467b) — source dated 2026-09-18.
- [E2B Embed](https://github.com/e2b-dev/runtime/tree/9dd5b727318831ebbdd84cc9f51b25c5f3af96c8/embed) — source dated 2026-09-22.
- [Official E2B documentation index](https://docs.e2b.dev/llms.txt) — accessed 2026-09-22.
- [Enterprise deployment options](https://e2b.dev/enterprise), [BYOC](https://docs.e2b.dev/byoc.md), and [security](https://e2b.dev/security) — accessed 2026-09-22.
- [Runtime release 2026.30](https://github.com/e2b-dev/runtime/releases/tag/2026.30) — published 2026-09-10.
- [SDK release 2.51.0](https://github.com/e2b-dev/E2B/releases/tag/e2b%402.51.0) — published 2026-09-18.

## AllAgents comparison and decision

### Verdict

**Reject E2B as a replacement for the planned UHP/HarnessRouter gateway. Trial it later only as a stronger sandbox runtime beneath the runner if hostile-code isolation becomes a product requirement.**

The current AllAgents decision is accepted but not implemented: [ADR 0002](../decisions/0002-adopt-uhp-through-harnessrouter.md) selects UHP `2026-09-12` through a pinned HarnessRouter CE fork, and the [implementation plan](../plans/2026-09-18-0837-feat-coding-execution-gateway-plan.md) assigns the wire protocol, caller authentication, normalized streaming, cancellation, idempotency, conversation continuity, harness execution, usage, and artifacts to HarnessRouter. AllAgents owns deterministic Git/OCI materialization and source provenance. Repository inspection found no gateway, fork, materializer, or deployment implementation yet.

E2B does not implement that contract. It creates an isolated machine and exposes low-level process, filesystem, network, and lifecycle APIs. Its official Codex and Pi integrations leave command construction, harness credentials, event parsing, continuation, and result extraction in caller code. Replacing HarnessRouter with E2B would therefore recreate the custom gateway, session, event-normalization, harness-adapter, and artifact layers that ADR 0002 rejected.

### Does E2B do the same thing?

No. The systems overlap at the execution-workspace layer but own different abstractions.

| Concern | Planned AllAgents gateway | E2B |
| --- | --- | --- |
| Northbound contract | UHP request, ordered events, cancellation, idempotency, continuation, files, usage, artifacts, and normalized errors | Sandbox REST API plus process/filesystem APIs; no agent-neutral request/event/result protocol |
| Harness execution | HarnessRouter selects and runs configured Codex or Pi targets | Caller starts an agent-specific command inside a sandbox and interprets its output |
| Session identity | `previous_response_id` binds conversation, writable workspace, harness target, auth binding, and provenance | Sandbox ID binds machine state; agent thread/session identity remains harness- and caller-specific |
| Workspace acquisition | Server-authoritative logical source catalog; exact Git commits or immutable OCI digests; pre-agent checkpoint; returned provenance | Caller uploads files, clones Git, or starts from a template/snapshot; no agent-run source-provenance contract |
| Isolation | Private per-session UID/workspace; explicitly not a hostile-code sandbox | One Firecracker microVM and guest kernel per sandbox |
| Credentials | Separate caller, source, and provider trust domains; native OAuth owner-trust mode or explicit brokered proxy | Core sandbox auth plus caller-supplied agent/Git credentials; managed egress secrets and workload identity are not fully present in standard Embed |
| Results | UHP output, usage, artifacts, produced-file collection, and identical provenance across stream/retrieval/replay paths | Guest files, command streams, VM snapshots, and templates; the caller defines an agent result or artifact manifest |
| Deployment | Planned pinned private HarnessRouter image with durable sessions and a narrow AllAgents hook | Multi-service KVM stack with API, proxies, orchestrator, guest daemon, three datastores, and template/snapshot storage |

E2B could occupy the runner's future sandbox-runtime slot. HarnessRouter and the AllAgents materializer would still remain above it.

### Is it completely self-hosted?

The answer depends on the operating standard:

- **Yes for a functional single-node deployment.** Apache-2.0 E2B Embed runs the API, dashboard, proxies, PostgreSQL, Redis, ClickHouse, Vector, template builder, Firecracker orchestrator, storage, and sandboxes on an operator-owned KVM host. It generates its own team API key and stores its runtime data locally.
- **No for a turnkey production-equivalent distribution.** The source guides call every Embed shape a “single-machine evaluation package, not a deployment pattern.” Compose, the one-node Kubernetes StatefulSet, and the one-instance GCP module do not establish HA, multi-node recovery, or production scaling.
- **No for managed-feature parity.** Standard Embed does not configure every managed backend. Current gaps include the separate secret store, volume-content service/token path, managed SOCKS5 egress, and credential delivery for workload identity.
- **No for turnkey air-gapped installation.** Installation fetches pinned public images and binaries from Docker Hub, Google Artifact Registry/Storage, and GitHub; no current public offline-mirroring guide was found.
- **BYOC is not self-hosting.** E2B provisions, monitors, and operates BYOC in the customer's AWS or GCP account, while E2B Cloud remains part of its management plane. E2B's fully private production option is listed as in development.

The [enterprise page](https://e2b.dev/enterprise) markets Embed as an available self-hosting pattern. The [Embed source guide](https://github.com/e2b-dev/runtime/blob/9dd5b727318831ebbdd84cc9f51b25c5f3af96c8/embed/README.md) sets the narrower operational boundary. For architecture decisions, use the source guide's single-node/evaluation limit.

### No E2B-derived changes for version one

Version one should adopt none of E2B's runtime patterns. The accepted gateway already has a coherent private owner-trust scope, and E2B addresses requirements that version one explicitly excludes: hostile-code isolation, public multi-tenancy, VM suspension and forking, multi-node placement, and microVM startup optimization.

Do not add an E2B dependency, a sandbox-provider interface, a guest daemon, egress-policy machinery, runtime telemetry infrastructure, or any other future-runtime seam to version one. The runner boundary is already a sufficient future integration point. Building an abstraction before a second runtime and a measured requirement exist would increase the initial implementation and verification burden without satisfying an acceptance criterion.

Existing requirements for private runner routes, credential containment, crash-consistent materialization, immutable source identity, release pinning, and provenance remain necessary on their own merits. They are not E2B adoption.

If a reconsideration trigger is reached later, E2B provides a useful checklist for that separate design: place stronger isolation beneath the runner; separate public and private control routes; bind egress and ingress policy to the execution identity; keep environment identity distinct from source provenance; keep long-lived credentials outside the guest; reclaim orphaned runtime resources after crashes; correlate runtime telemetry with UHP identifiers without creating another agent protocol; and pin the sandbox SDK, API, guest daemon, kernel, and runtime as one tested compatibility set.

### Patterns to defer or reject

- **Defer Firecracker, memory snapshots, forking, lazy restore, COW root filesystems, placement, and multi-node scheduling.** They solve hostile multi-tenancy, recovery, or startup-cost problems that v1 does not claim. Adopt them only after a requirement or measurement justifies their operational weight.
- **Reject E2B's API as the AllAgents northbound contract.** It would discard UHP conformance and make callers own harness-specific behavior.
- **Reject caller-side repository acquisition and inline long-lived credentials.** E2B's convenience examples conflict with the server-authoritative source catalog, hermetic materializer, and credential-containment requirements.
- **Reject open internet by default for a future sandboxed mode.** Outbound access should be an explicit target policy.
- **Reject live VM snapshots as source provenance.** They are useful recovery artifacts, not reproducible evidence of which repositories and commits an agent received.

### Reconsideration conditions

Evaluate E2B as a runner backend when AllAgents must execute mutually untrusted tenant code, support public multi-tenancy, preserve in-flight processes across suspension, fork live workspaces, or meet measured sandbox-start targets that process/UID isolation cannot satisfy. The trial must keep UHP and AllAgents provenance above E2B, pin an SDK/runtime compatibility pair, prove private-route containment and default-deny egress, and exercise crash recovery on the exact self-hosted deployment shape.

E2B is not the ADR's “second independent UHP implementation” reconsideration trigger because it does not implement UHP. It becomes relevant when the isolation requirement changes, not because it duplicates the current gateway.
