---
title: "One-Shot Coding-Agent Gateway - Implementation Plan"
date: 2026-09-18
updated: 2026-09-28
type: feat
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
---

# One-Shot Coding-Agent Gateway - Implementation Plan

## Goal capsule

- **Objective:** Run one Codex or OMP coding-agent attempt in a fresh composed workspace and return bounded output, usage, bounded trajectory, provenance, and optional raw post-run evidence with authenticated artifact retrieval.
- **Means:** Build one repository and service, `allagentsdev/allagents-gateway`, containing the Promptfoo provider, gateway API, worker/runner, contracts, workspace composition, post-run collector, and agent adapters.
- **First caller:** Promptfoo is the evaluation layer. It owns rendered prompts, workspace-source JSON, matrices, repetitions, JavaScript/LLM graders, pass/fail decisions, scores, and reports.
- **Stop conditions:** Do not build reusable sessions, continuation, checkpoints, composed-workspace or snapshot caches, generic diffs, change artifacts, or a second repository.

The authoritative decision is [ADR 0002](../decisions/0002-use-allagents-gateway-for-one-shot-runs.md). Supporting evidence is in [One-shot coding-agent gateway boundary](../research/one-shot-coding-agent-gateway-boundary.md).

## Product contract

`allagentsdev/allagents-gateway` is a general one-shot coding-agent gateway. A run receives one rendered instruction and an ordered list of authorized Git, OCI, or uploaded-bundle sources, each declared `read_only` or `writable`. The worker resolves exact immutable source identities, reauthorizes and leases complete source-cache generations, mounts read-only sources directly, and makes private reflink/CoW clones for writable sources. It composes those non-overlapping destinations in one fresh sandbox, invokes one selected agent exactly once, stops and reaps the agent-owned process tree, seals the agent output/usage/trajectory record, and retains the same sandbox, runtime image, and final writable workspace for optional evidence collection.

A request may add `post_run` evidence collection. Only after the agent has stopped, the worker strips model/source credentials, destroys the agent network namespace and flows, creates a distinct default-drop check namespace, conditionally mounts an immutable hidden bundle for bundle executables, and executes structured commands in the same retained sandbox and final workspace. Commands select either an operator-approved executable from the runtime profile's fixed read-only `PATH` or a confined executable from that optional bundle, plus literal arguments. All external and service access is denied by default and exists only through endpoints brokered for the named post-run policy; direct loopback, host, and sidecar sockets stay unreachable. Commands may compile, test, start short-lived children, and create build output. The gateway returns raw command observations and requested files as bounded inline values or authenticated tenant/run-bound artifact references.

The gateway never decides whether behavior passes, fails, or deserves a reward. The Promptfoo provider exposes agent and post-run evidence to Promptfoo JavaScript or LLM graders, which own those decisions.

The lifecycle status is only `completed`, `cancelled`, or `infrastructure_error`. Agent launch/crash/timeout, requested post-run bundle/sandbox/executable-resolution/command-launch failure, artifact-store failure, result-finalization failure, or cleanup failure is infrastructure failure. Every run destroys its private clones, workspace mounts, any injected bundle, and scratch storage and releases cache leases before its terminal result is published.

V1 supports **direct mode** only, owned completely by this repository.

## Scope

### Included

- One TypeScript repository with a Promptfoo provider, gateway API, worker/runner, contracts, Codex adapter, OMP adapter, post-run collector, and Linux isolation backend.
- Closed `AgentRunRequest v1`, `AgentRunResult v1`, status-envelope, bundle-upload, and post-run JSON Schemas.
- Promptfoo local and remote provider modes using the same gateway API and request/result contract.
- Promptfoo-authored ordered multi-source workspace JSON.
- Deterministic packaging of provider-local source paths and optional post-run bundle paths before gateway submission.
- Bounded composition from one through 128 authorized Git, OCI, and uploaded-bundle sources with required `read_only` or `writable` access.
- An immutable exact-source cache with authorization on every use, exact-key singleflight, complete generations, leases, watermarks, and startup reconciliation.
- A fresh private sandbox, process hierarchy, mount tree, and writable source clone for every run.
- One agent invocation with idempotency, cancellation, deadlines, cleanup, bounded final output, usage, timing, and bounded ATIF trajectory.
- Optional ordered post-run commands and requested-file collection in the same runtime and final workspace after agent stop and credential stripping.
- Operator-managed task services with separate lifecycle ownership from agent-created processes.
- Resolved provenance for every source in request order.

### Excluded

- Pass/fail, reward, rubric, or grading fields and decisions in the gateway contract.
- Long-lived or reusable coding sessions, additional turns, continuation, resume, replay, or checkpoints.
- Reusable composed workspaces, mutable source caches, unkeyed Git clones, prepared snapshots, or OCI workspace publication. Immutable exact-source generations are required only as specified below.
- A workspace-builder service or repository.
- Generic before/after diffs, patch output, or a core modified-workspace artifact.
- Persistence of a non-evaluation run's modified workspace in V1. That requires a separately approved artifact contract.
- Caller-provided credentials, environment variables, shell commands, container images, raw network rules, policy documents, model endpoints, or proxies.
- Automatic agent or post-run retry. Promptfoo repetitions are distinct runs; transport retry reuses one idempotency identity.

## Fixed implementation choices

Implementation must not choose another framework partway through delivery.

- **Repository and service:** `allagentsdev/allagents-gateway`, Apache-2.0, protected `main`, release tags, lockfile, generated schemas checked in.
- **Runtime:** Bun 1.4 for development, tests, packaging, and worker execution; strict TypeScript; ESM; Node 22-compatible Promptfoo provider output.
- **HTTP:** Fastify 5 with strict Ajv validation against checked-in schemas. External JSON is not translated through a second hand-maintained DTO shape.
- **Persistence:** PostgreSQL stores tenant-owned upload reservations, runs, idempotency claims, state, deadlines, artifact budgets, and cache leases. An S3-compatible store holds immutable tenant/run-bound input bundles and result artifacts for agent output, command output, requested files, and trajectories. Local mode uses SQLite plus a private local artifact directory behind the same interfaces.
- **Source cache:** one V1 worker pool is one cache domain: all worker processes share an operator-owned cache root on the same reflink/CoW-capable filesystem and coordinate exact keys through PostgreSQL plus atomic filesystem publication. This guarantees one materialization for concurrent exact-key requests in the pool. Additional independent cache domains are explicit deployments and may materialize separately. The cache has a versioned materializer schema, ready markers, leases, byte/inode watermarks, exact-key singleflight, and reconciliation; it never caches a composed workspace.
- **Queue:** PostgreSQL-backed leased jobs in V1. Lease recovery may resume safe control-plane work but may not invoke an ambiguously started agent again.
- **Runtime profiles:** required `runtime_profile_id` selects a caller-authorized operator profile. Admission resolves and persists one immutable profile revision plus its `profile_digest`, runtime `image_digest`, sandbox-policy version, read-only tool implementations, phase-specific broker identities, cgroup-v2 ceilings, and service implementations/images. Dispatch uses only that pinned revision and fails before agent invocation if it is unavailable or any digest differs. The result returns sufficient immutable, nonsecret provenance to identify the exact runtime/tool/service implementations without exposing paths, launch arguments, or policy contents.
- **Isolation:** production `RunSandbox` uses an unprivileged UID/GID mapping and non-root process identity, empty Linux capabilities, `no_new_privs`, private PID/mount/IPC/UTS/network namespaces, a read-only root filesystem, minimal bounded tmpfs mounts, masked `/proc` and no exposed `/sys`, cgroup filesystem, host devices, Docker/container sockets, worker sockets, or writable control-plane mounts. A versioned explicit seccomp allowlist denies by default. Worker-owned cgroup v2 controllers mandatorily cap pids, memory, CPU, and IO for service, agent, and each check group; sandbox processes cannot modify membership or limits. The retained mount/runtime stays alive through post-run, but phase process and network namespaces are distinct. Rootless development is allowed; production is incomplete until this backend passes breakout, namespace, fork-bomb, OOM, CPU, IO, device/socket, mount, and syscall conformance.
- **Phase networking:** agent and post-run checks use different short-lived network namespaces with default-drop nftables (or an equivalent kernel enforcement point) covering external, sidecar, and loopback traffic. They receive only operator-brokered endpoints authorized by their phase policy; no direct host/sidecar socket is reachable. The worker destroys the agent namespace, conntrack/flows, and broker handles before creating the check namespace. Post-run-only services are therefore unreachable to the agent even on localhost.
- **Validation:** JSON Schema is authoritative at public and subprocess boundaries. TypeScript types are generated from it. Every owned object uses `additionalProperties: false`; unions use `oneOf` with a required discriminator.
- **Identity and time:** UUIDv7 run and artifact IDs; UTC RFC 3339 timestamps; monotonic internal durations; lowercase SHA-256 digests; byte sizes; millisecond limits.
- **Trace:** ATIF v1 is the only V1 public trajectory format. Vendor and pin its exact schema; adapters convert native events instead of creating another event model.

## Actors and ownership

| Actor | Owns | Must not own or receive |
|---|---|---|
| Promptfoo | Datasets, variables, prompt rendering, ordered source JSON, matrices, repetitions, JS/LLM grading, pass/fail, scores, reports | Source/model credentials, gateway policy bodies, a live workspace |
| `@allagents/promptfoo-provider` | Stable Promptfoo invocation/upload identity, local path packaging, idempotent upload/submission, polling/cancel mapping, authenticated artifact download/verification, result/evidence mapping | Agent execution, grading decisions, automatic run retry |
| Gateway API | Authentication, closed-schema validation, tenant-scoped object access, duplicate-before-admission idempotency, admission, state reads, cancellation, deterministic caller/source-address mapping, bundle ownership, model/network/runtime logical-name authorization, immutable result-artifact delivery, worker dispatch | Host paths, caller secrets, source credential selectors, policy bodies, workspace mutation |
| Worker/runner | State machine, deadlines, composition sequencing, sandbox/profile allocation, one agent invocation, process/network ownership boundaries, bounded output/artifact allocation, durable post-run sequencing, result finalization, cleanup | Prompt rendering, matrix expansion, grading |
| Workspace composer | Ordered attachment of cached immutable generations at non-overlapping destinations, access-mode enforcement, source-by-source provenance | Overwrite precedence, mutable shared trees, composed-workspace caches |
| Source cache | Exact-key materialization singleflight, immutable complete generations, leases, watermarks, eviction, reconciliation | Authorization decisions, writable agent aliases, visibility inside sandboxes except leased read-only mounts |
| `RunSandbox` | Pinned profile runtime, unprivileged private mounts/namespaces, seccomp and cgroup-v2 enforcement, distinct default-drop service/agent/check network boundaries, stop/kill boundaries | Evaluation semantics |
| Task service manager | Operator-declared sidecar startup/readiness/restart/stop in the service cgroup | Agent-created daemons, caller-defined service commands, grading |
| Codex adapter | Pinned Codex invocation, native-event normalization, final output, usage | Acquisition, post-run collection, retries |
| OMP adapter | Pinned OMP invocation, native-event normalization, final output, usage | Acquisition, post-run collection, retries |
| Post-run collector | Late bundle acquisition/verification/read-only mount after agent teardown, pinned-profile runtime and bundle-executable resolution, literal-argument execution in the retained sandbox/workspace, bounded output capture, requested-file promotion | Model/source credentials, grading, arbitrary external egress |
| Artifact store | Immutable tenant-owned input bundles and tenant/run-bound result artifacts for agent output, command output, requested files, and trajectories | Mutable run state, prepared workspaces, policy decisions |

## Repository layout

```text
allagents-gateway/
  apps/gateway/                 # Fastify admission, status, upload, cancellation API
  apps/worker/                  # leased-job consumer and runner entrypoint
  packages/contracts/           # schemas, generated TS types, canonicalization
  packages/runner/              # state machine and direct-mode coordinator
  packages/promptfoo-provider/  # local/remote provider and deterministic packager
  packages/workspace/           # ordered source attachment and access modes
  packages/source-cache/        # exact-key immutable generations/leases/eviction
  packages/sandbox-linux/       # retained runtime, cgroups, mounts, network policy
  packages/services/            # operator-declared task sidecar lifecycle
  packages/adapter-codex/       # pinned Codex adapter
  packages/adapter-omp/         # pinned OMP adapter
  packages/post-run/            # hidden checks, output capture, file collection
  packages/trace-atif/          # native events to bounded ATIF v1
  schemas/                      # generated public schemas, checked in
  tests/fixtures/               # local Git/OCI/bundle/agent/check fixtures
```

The runner depends only on `RunStore`, `ArtifactStore`, `SourceCache`, `WorkspaceComposer`, `RunSandbox`, `TaskServiceManager`, `AgentAdapter`, and `PostRunCollector`. It must not import Fastify, Promptfoo, Codex, or OMP types. The gateway API never accesses a run directory; the worker never interprets Promptfoo evaluation metadata.

## Public contract

### Shared scalar and path rules

- All owned objects are closed. Unknown fields fail before a run record or directory exists.
- Strings are UTF-8, contain no NUL, and obey their byte bounds.
- Logical IDs match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`.
- Digests match `^sha256:[0-9a-f]{64}$`.
- Relative paths are NFC-normalized POSIX paths, are not absolute, and contain neither empty, `.` nor `..` segments. `destination` and `working_directory` may be exactly `.` where explicitly allowed.
- Byte sizes and millisecond limits are safe positive JSON integers. Counts may be zero where stated.
- Timestamps are UTC RFC 3339 with `Z`.
- A bundle or artifact reference is accepted only when declared digest, declared size, stored size, and streamed digest all agree.

### `AgentRunRequest v1`

The authoritative file is `schemas/agent-run-request.v1.schema.json`. Its exact logical shape is:

```text
{
  schema_version: "agent_run_request.v1",
  identity: {
    run_id: UUIDv7,
    idempotency_key: string, 16..128 characters
  },
  instruction: string, 1..1_000_000 UTF-8 bytes,
  workspace: {
    working_directory: relative path or ".",
    sources: array of 1..128 GitSource | OciSource | UploadedBundleSource
  },
  agent: CodexAgent | OmpAgent,
  runtime_profile_id: logical ID,
  post_run: null | PostRunSpec,
  agent_network_policy_id: logical ID,
  limits: {
    total_timeout_ms: positive integer,
    acquisition_timeout_ms: positive integer,
    agent_timeout_ms: positive integer,
    post_run_timeout_ms: positive integer,
    max_workspace_bytes: positive integer,
    max_workspace_files: positive integer,
    max_agent_output_bytes: positive integer,
    max_artifact_bytes: positive integer,
    max_trace_bytes: positive integer,
    max_command_output_bytes: positive integer
  }
}
```

`post_run` is required and is either `null` or the closed specification below. A general run with `null` still returns a completed agent result. Promptfoo uses post-run evidence only when its graders need it.

`runtime_profile_id` is required. At admission it resolves to one caller-authorized immutable operator profile revision and canonical `profile_digest`, including the runtime image, sandbox policy, fixed read-only executable `PATH` and tool implementations, phase-specific broker identities, cgroup ceilings, and task-service implementations. The persisted run pins that revision rather than resolving the logical ID again at dispatch. Caller JSON never contains an image, executable path, service command, implementation digest, or sandbox policy body.

`max_agent_output_bytes`, `max_trace_bytes`, and `max_command_output_bytes` are independent capture bounds. `max_artifact_bytes` is the aggregate logical byte budget for content-addressed **result** artifacts in one run; input bundles and cache generations are excluded. Admission requires `sum(post_run.output_files[].max_bytes) <= max_artifact_bytes` and reserves that sum. Finalization charges actual collected-file bytes in request order, then releases unused reservation and spends the deterministic remainder on agent output, command stdout/stderr in command/stream order, then trajectory. Every promoted reference charges its full `size_bytes` even when storage deduplicates the digest. Exhausted optional promotion falls back to explicitly bounded inline/truncated or omitted evidence; it is not infrastructure failure and never permits unbounded persistence.


The three closed source variants are:

```text
GitSource = {
  kind: "git",
  url: canonical HTTPS URL, 1..2_048 UTF-8 bytes,
  ref: string, 1..1_024 UTF-8 bytes,
  history: { mode: "full" } |
           { mode: "shallow", depth: integer >= 1 and <= 1_000_000 },
  access: "read_only" | "writable",
  destination: relative path or "."
}

OciSource = {
  kind: "oci",
  repository: canonical OCI repository, 1..2_048 UTF-8 bytes,
  descriptor: {
    media_type: "application/vnd.oci.image.manifest.v1+json",
    digest: SHA-256 digest,
    size_bytes: positive integer
  },
  access: "read_only" | "writable",
  destination: relative path or "."
}

UploadedBundleSource = {
  kind: "uploaded_bundle",
  bundle: BundleReference,
  access: "read_only" | "writable",
  destination: relative path or "."
}

BundleReference = {
  artifact_id: UUIDv7,
  media_type: "application/vnd.allagents.gateway-bundle.v1.tar+gzip",
  digest: SHA-256 digest,
  size_bytes: positive integer
}

ArtifactReference = {
  artifact_id: UUIDv7,
  media_type: nonempty IANA media type, <= 127 bytes,
  digest: SHA-256 digest,
  size_bytes: integer >= 0,
  expires_at: timestamp
}
```

Source order is authoritative for acquisition logs and returned provenance. Destinations are normalized before comparison and must be pairwise non-overlapping: no destination may equal, contain, or be contained by another. `.` is allowed only when it is the sole source destination. The final `working_directory` must resolve within the composed tree, without symlink escape, to a directory. Destination overlap and working-directory syntax are rejected before credentials, network, artifact reads, or run-directory creation. Ordering never grants overwrite precedence.

Canonical source addresses have one accepted serialization. A Git URL is HTTPS with lowercase IDNA host, omitted default port, no userinfo/query/fragment, normalized percent-encoding, and a nonempty absolute repository path. An OCI repository is lowercase `registry[:nondefault-port]/name[/name...]` under OCI Distribution name rules, with no scheme, tag, digest, userinfo, query, or fragment. The gateway parses and reserializes either form and rejects the request if bytes differ; it never silently normalizes an alias before policy lookup or cache-key construction.

Git `ref` may be a full advertised ref, an unambiguous advertised branch/tag selector, or an exact commit permitted by source policy. It is resolved once to an exact commit. `full` retains ancestry reachable from that commit; `shallow` retains the requested bounded depth. The worker never substitutes a default branch, another ref, another commit, or another history mode.

The closed agent variants are:

```text
CodexAgent = {
  kind: "codex",
  model: logical ID,
  reasoning_effort: "low" | "medium" | "high"
}

OmpAgent = {
  kind: "omp",
  model: logical ID
}
```

`model`, `runtime_profile_id`, `agent_network_policy_id`, and `post_run.network_policy_id` are logical names resolved under authenticated operator configuration. Git `url` and OCI `repository` are canonical source addresses, never credential or policy selectors. Before credentials or network access, the gateway deterministically maps `(authenticated caller identity, source kind, canonical URL/repository)` to exactly one internal authorization/transport/credential route; zero or multiple matches return `source_policy_mapping_failed`. Uploaded bundles are authorized by the authenticated caller's access to `artifact_id`. The caller can never select an internal source identity, credential route, runtime image, tool path, sandbox policy, or service command. Runtime, model, and both phase-network policy IDs are authorized independently. Limits are caller-lowerable: callers send explicit values no greater than the selected profile/configured ceilings. The gateway rejects a value over a ceiling instead of silently changing it. Provider defaults are applied before request construction.


The request can never contain a host path, credential, environment map, shell string, raw network destination, proxy, runtime image, policy body, retry count, output directory, grading rubric, pass/fail expectation, reward, patch request, or modified-workspace persistence option.

### `PostRunSpec v1`

```text
PostRunSpec = {
  bundle?: BundleReference,
  network_policy_id: logical ID,
  commands: array of 0..32 PostRunCommand,
  output_files: array of 0..128 OutputFileRequest
}

PostRunCommand = {
  command_id: logical ID,
  executable: RuntimeExecutable | BundleExecutable,
  args: array of 0..63 strings, each 0..4_096 UTF-8 bytes,
  timeout_ms: positive integer
}

RuntimeExecutable = {
  kind: "runtime",
  name: string matching ^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$
}

BundleExecutable = {
  kind: "bundle",
  path: relative path
}

OutputFileRequest = {
  name: logical ID,
  path: relative path,
  media_type: nonempty IANA media type, <= 127 bytes,
  max_bytes: positive integer
}
```

At least one of `commands` or `output_files` is nonempty. Command IDs and output-file names are unique. `bundle` is present if and only if at least one command uses `BundleExecutable`; output-only collection and runtime-only commands omit it. A runtime executable name resolves only through the operator-approved fixed `PATH` of read-only runtime directories; it contains no slash, does not search the workspace, and must resolve to a regular executable beneath an approved directory. A bundle executable path resolves beneath the immutable hidden bundle without symlink escape. `args` are literal. No shell parsing, interpolation, globbing, caller environment, working-directory override, or other executable lookup is allowed. Each `timeout_ms` must be no greater than both `limits.post_run_timeout_ms` and the remaining total deadline. Each output-file path is relative to the final workspace root and is collected after all commands settle. `max_bytes` must not exceed `limits.max_artifact_bytes`.

Commands run sequentially in request order in the same retained sandbox, runtime image, and final workspace used by the agent, with current directory set to `workspace.working_directory`. A nonzero exit is recorded and does not stop later commands. A per-command timeout kills and reaps that command's process group, records a `timed_out` observation, and continues if the post-run and total deadlines permit. Failure to validate/extract/inject a requested bundle, resolve an approved executable, enforce the post-run sandbox/network policy, or launch a command is infrastructure failure and aborts remaining collection.

### `AgentRunResult v1`

The authoritative file is `schemas/agent-run-result.v1.schema.json`. Its exact common shape is:

```text
{
  schema_version: "agent_run_result.v1",
  identity: {
    run_id: UUIDv7,
    idempotency_key: string
  },
  status: "completed" | "cancelled" | "infrastructure_error",
  post_run_mode: "none" | "requested",
  effective_limits: { same ten required fields as request.limits },
  workspace_provenance: DirectWorkspaceProvenance | null,
  runtime_provenance: RuntimeProvenance | null,
  agent: AgentResult | null,
  post_run: PostRunEvidence | null,
  usage: Usage,
  timing: Timing,
  trajectory: InlineTrajectory | ArtifactTrajectory | null,
  error: RunError | null
}
```

The schema encodes these variants:

- `completed` + `post_run_mode: "none"`: non-null workspace/runtime provenance, `agent.termination: "completed"`, non-null bounded `CapturedText` final output (empty inline text is valid), usage, and trajectory; `post_run: null`; `error: null`.
- `completed` + `post_run_mode: "requested"`: the same completed agent fields plus non-null `PostRunEvidence`; every command observation is `completed` or `timed_out`, and every file observation is `collected`, `missing`, `limit_exceeded`, or `not_regular_file`; `error: null`.
- `cancelled`: `error.code: "run_cancelled"` and any already durable provenance/agent/usage/trajectory. If post-run initialization was durably recorded, `post_run` is a full request-order observation vector containing sealed observations plus `not_run` entries for work prevented by cancellation; otherwise it is null.
- `infrastructure_error`: a non-cancellation error plus any already durable provenance, agent, usage, trajectory, and `PostRunEvidence`. If post-run initialization was durable, the evidence vector contains sealed observations, `unavailable` for the item whose evidence/launch/collection failed, and `not_run` for later work; otherwise it is null. Cleanup failure preserves the fully sealed vector and can never publish `completed`.

A completed run always exposes bounded agent final output, usage, and a valid trajectory even if no post-run evidence was requested or no files changed. Nonzero exits, timed-out commands, missing files, oversized files, and non-regular paths are behavioral observations and do not change lifecycle status. Any `unavailable` observation implies `infrastructure_error`; `not_run` appears only on cancelled or infrastructure-error results. Mandatory result-finalization or cleanup failure downgrades the terminal candidate to `infrastructure_error`, retaining already durable evidence. The result remains invisible until cleanup succeeds and cache leases are released.

Closed result components are:

```text
DirectWorkspaceProvenance = {
  kind: "direct",
  working_directory: string,
  sources: array in request order of
    GitSourceProvenance | OciSourceProvenance | UploadedSourceProvenance
}

GitSourceProvenance = {
  kind: "git",
  url: canonical HTTPS URL,
  requested_ref: string,
  resolved_commit: 40 lowercase hexadecimal characters,
  history: { mode: "full" } |
           { mode: "shallow", depth: positive integer },
  access: "read_only" | "writable",
  materializer_schema: 1,
  destination: string,
  tree_digest: SHA-256 digest
}

OciSourceProvenance = {
  kind: "oci",
  repository: canonical OCI repository,
  requested_descriptor: OciSource.descriptor,
  resolved_manifest_digest: SHA-256 digest,
  rootfs_digest: SHA-256 digest,
  access: "read_only" | "writable",
  materializer_schema: 1,
  destination: string
}

UploadedSourceProvenance = {
  kind: "uploaded_bundle",
  bundle: BundleReference,
  rootfs_digest: SHA-256 digest,
  access: "read_only" | "writable",
  materializer_schema: 1,
  destination: string
}


RuntimeProvenance = {
  runtime_profile_id: logical ID,
  profile_digest: SHA-256 digest,
  image_digest: SHA-256 digest,
  sandbox_policy_version: string,
  tools: array of 0..128 {
    name: logical ID,
    version: string,
    implementation_digest: SHA-256 digest
  },
  services: array of 0..32 {
    name: logical ID,
    version: string,
    implementation_digest: SHA-256 digest,
    image_digest: SHA-256 digest | null
  }
}

`profile_digest` identifies the canonical immutable nonsecret resolved-profile manifest. A tool `implementation_digest` commits to its executable bytes and immutable runtime dependency closure. A service `implementation_digest` commits to its credential-free canonical launch manifest and executable closure; `image_digest` is non-null exactly for a containerized service and names its immutable image. The `tools` and `services` arrays enumerate the entire pinned revision with unique names sorted by name. Operator profiles never put credentials or secret values in commands, arguments, environment, or these manifests; brokers supply secrets out of process. Versions are descriptive, while digests are the implementation identities.

AgentResult = {
  kind: "codex" | "omp",
  model: logical ID,
  adapter_version: string,
  termination: "completed" | "cancelled" | "timed_out" | "failed",
  exit_code: integer | null,
  final_output: CapturedText | null
}

CapturedText =
  { storage: "inline", encoding: "utf-8", text: string,
    digest: SHA-256 digest, size_bytes: integer >= 0, truncated: boolean } |
  { storage: "artifact", encoding: "utf-8",
    artifact: ArtifactReference, truncated: boolean }
```

Agent output capture retains at most `max_agent_output_bytes` of valid UTF-8 and sets `truncated: true` if additional bytes existed. At most 64 KiB is inline. Larger retained text uses a result artifact when its deterministic artifact-budget turn fits; otherwise it returns the first at-most-64-KiB UTF-8 prefix inline with `truncated: true`. Digests and sizes describe returned bytes. The provider verifies and decodes inline text or downloads/verifies the artifact before giving Promptfoo the final string; truncation stays visible in metadata.

`PostRunEvidence` contains raw observations only:

```text
PostRunEvidence = {
  commands: one PostRunCommandObservation per requested command, in order,
  output_files: one OutputFileObservation per requested file, in order
}

PostRunCommandObservation =
  { status: "completed", command_id, executable, args,
    exit_code: integer | null, signal: integer | null,
    duration_ms: integer >= 0, stdout: CapturedOutput, stderr: CapturedOutput } |
  { status: "timed_out", command_id, executable, args,
    signal: integer | null, duration_ms: integer >= 0,
    stdout: CapturedOutput, stderr: CapturedOutput } |
  { status: "not_run", command_id, executable, args,
    reason: "cancelled" | "prior_infrastructure_error" | "deadline" } |
  { status: "unavailable", command_id, executable, args,
    reason: "cancelled" | "deadline" | "launch_failed" | "sandbox_failed" |
            "evidence_persistence_failed",
    duration_ms: integer >= 0 | null,
    stdout: CapturedOutput | null, stderr: CapturedOutput | null }

CapturedOutput =
  { storage: "inline", encoding: "utf-8", text: string,
    digest: SHA-256 digest, size_bytes: integer >= 0, truncated: boolean } |
  { storage: "artifact", artifact: ArtifactReference, truncated: boolean } |
  { storage: "omitted", digest: SHA-256 digest,
    size_bytes: integer >= 0, truncated: true,
    reason: "artifact_budget_exhausted" }

OutputFileObservation =
  { name: logical ID, path: string, status: "collected",
    media_type: string, digest: SHA-256 digest, size_bytes: integer >= 0,
    artifact: ArtifactReference } |
  { name: logical ID, path: string, status: "missing" } |
  { name: logical ID, path: string, status: "limit_exceeded",
    observed_size_bytes: integer >= 0 } |
  { name: logical ID, path: string, status: "not_regular_file" } |
  { name: logical ID, path: string, status: "not_run",
    reason: "cancelled" | "prior_infrastructure_error" | "deadline" } |
  { name: logical ID, path: string, status: "unavailable",
    reason: "cancelled" | "deadline" | "unsafe_path" |
            "changed_during_read" | "read_failed" |
            "artifact_persistence_failed" }
```

The worker durably seals each `completed` or `timed_out` command observation before starting the next command and each file observation before collecting the next file. Post-run initialization durably records the ordered item skeleton. On cancellation or infrastructure failure it seals the in-flight item as `unavailable` with any safely captured bounded streams and fills all untouched items as `not_run`, so a published non-null `PostRunEvidence` always has exactly one entry per request item.

For a completed command, exit code and signal are not both null; nonzero exit is ordinary evidence. A timed-out command records partial bounded streams after its cgroup is reaped. Each stream captures at most `max_command_output_bytes`. Valid UTF-8 at or below 64 KiB is inline; larger or binary bytes use an artifact if budget remains. Without budget, valid UTF-8 falls back to a truncated inline prefix and binary bytes use `omitted`; budget exhaustion is never infrastructure failure. The result echoes validated executable/args, never a resolved host path.

Requested files are read after commands settle without following the final path as a symlink. Missing, over-limit, and non-regular paths are completed observations. Unsafe races/read failures become `unavailable` and infrastructure error. Because requested-file maxima were reserved at admission, any valid collected file fits the artifact byte budget; artifact-store failure marks that item unavailable while retaining prior observations.


```text
Usage = {
  input_tokens: integer >= 0 | null,
  cached_input_tokens: integer >= 0 | null,
  output_tokens: integer >= 0 | null,
  reasoning_tokens: integer >= 0 | null,
  tool_calls: integer >= 0,
  estimated_cost_usd: finite number >= 0 | null,
  source: "adapter_reported" | "partially_reported" | "unavailable"
}

Timing = {
  accepted_at: timestamp,
  started_at: timestamp | null,
  agent_started_at: timestamp | null,
  agent_stopped_at: timestamp | null,
  post_run_started_at: timestamp | null,
  completed_at: timestamp,
  queue_ms: integer >= 0,
  acquisition_ms: integer >= 0,
  agent_ms: integer >= 0,
  post_run_ms: integer >= 0,
  cleanup_ms: integer >= 0,
  total_ms: integer >= 0
}

InlineTrajectory = {
  storage: "inline",
  format: "atif-v1",
  digest: SHA-256 digest,
  size_bytes: integer >= 0,
  truncated: boolean,
  document: ATIF-v1 document
}

ArtifactTrajectory = {
  storage: "artifact",
  format: "atif-v1",
  digest: SHA-256 digest,
  size_bytes: integer >= 0,
  truncated: boolean,
  artifact: ArtifactReference
}

RunError = {
  code: StableErrorCode,
  message: sanitized string, 1..1_024 UTF-8 bytes,
  retryable: boolean,
  phase: "admission" | "queue" | "acquisition" | "agent" |
         "sealing" | "post_run" | "finalization" | "cleanup" |
         "cancellation"
}
```

ATIF documents are schema-validated before publication. One byte-counting recorder owns `max_trace_bytes`; at the limit it emits one valid truncation marker and refuses further payload without corrupting the document. Up to 256 KiB is inline. A larger document uses an artifact at the final artifact-budget priority. If that promotion does not fit, the recorder emits a valid at-most-256-KiB inline ATIF document ending in the same truncation marker. Artifact-budget exhaustion is not infrastructure failure, and completed runs never omit the trajectory.

## Stable errors and consequences

| Code | API/result consequence | `retryable` |
|---|---|---:|
| `invalid_request` | HTTP 400; no run record, fetch, or directory | false |
| `unauthenticated` | HTTP 401; no run record | false |
| `forbidden` | HTTP 403; authenticated caller lacks policy permission; no public run | false |
| `object_not_found` | non-enumerating HTTP 404 for absent or cross-tenant run/upload/result artifact | false |
| `source_policy_mapping_failed` | HTTP 403; no credentials resolved, network request, or public run | false |
| `runtime_profile_forbidden` | HTTP 403; profile not authorized for caller; no public run | false |
| `post_run_executable_forbidden` | HTTP 403; runtime name absent from selected profile; no public run | false |
| `bundle_integrity_failed` | HTTP 422; reservation unusable; no bundle published | false |
| `upload_id_conflict` | HTTP 409; original tenant/upload reservation unchanged | false |
| `idempotency_conflict` | HTTP 409; original run unchanged | false |
| `admission_limit_exceeded` | HTTP 422; no public run | false |
| `queue_unavailable` | `infrastructure_error`; no agent invocation | true |
| `runtime_profile_admission_failed` | HTTP 503; authorized immutable revision cannot be resolved and verified; no public run | true |
| `runtime_profile_unavailable` | `infrastructure_error`; pinned revision or implementation unavailable at dispatch; no agent invocation | true |
| `runtime_profile_integrity_failed` | `infrastructure_error`; pinned profile/runtime/tool/service digest mismatch; no agent invocation | false |
| `workspace_acquisition_failed` | `infrastructure_error`; no agent invocation | false |
| `source_authorization_revoked` | `infrastructure_error`; cached generation is not attached; no agent invocation | false |
| `source_cache_capacity_exceeded` | `infrastructure_error`; no unsafe eviction; no agent invocation | true |
| `source_cache_integrity_failed` | `infrastructure_error`; generation quarantined; no agent invocation | false |
| `workspace_integrity_failed` | `infrastructure_error`; offending source quarantined for operators | false |
| `workspace_limit_exceeded` | `infrastructure_error`; partial tree removed | false |
| `agent_start_failed` | `infrastructure_error`; no post-run collection | false |
| `agent_failed` | `infrastructure_error`; no post-run collection | false |
| `agent_timed_out` | `infrastructure_error`; process tree killed; no post-run collection | false |
| `agent_invocation_ambiguous` | `infrastructure_error`; recovery refuses a second invocation | false |
| `agent_seal_failed` | `infrastructure_error`; no post-run collection | false |
| `post_run_bundle_failed` | `infrastructure_error`; requested bundle could not be safely injected; ordered unavailable/not-run evidence retained | false |
| `post_run_executable_resolution_failed` | `infrastructure_error`; an approved runtime or bundle executable could not be resolved safely; partial evidence retained | false |
| `post_run_sandbox_failed` | `infrastructure_error`; ordered unavailable/not-run evidence retained | false |
| `task_service_failed` | `infrastructure_error`; ordered unavailable/not-run evidence retained | true |
| `post_run_command_launch_failed` | `infrastructure_error`; failed command unavailable, later work not-run, earlier evidence retained | false |
| `post_run_collection_failed` | `infrastructure_error`; failed file unavailable, later files not-run, earlier evidence retained | false |
| `trace_finalization_failed` | `infrastructure_error`; other durable evidence retained | false |
| `result_finalization_failed` | `infrastructure_error`; no completed result published | false |
| `artifact_integrity_failed` | HTTP 502 on result-artifact download; provider reports infrastructure failure | true |
| `artifact_expired` | HTTP 410 on an expired result artifact | false |
| `cleanup_failed` | terminal candidate becomes `infrastructure_error`; durable evidence retained; publication waits for successful reconciled cleanup and lease release | true |
| `run_timed_out` | `infrastructure_error`; active processes killed and cleaned | false |
| `run_cancelled` | `cancelled`; active processes killed and cleaned | false |

`retryable: true` means only that an explicit new run may succeed after transient operator recovery; it never permits the worker or provider to rerun an agent, and retrying the same idempotency identity returns the same terminal run.

A command's nonzero exit or per-command timeout is deliberately absent from this table: both are observations in `PostRunCommandObservation`. Public errors never contain credentials, policy bodies, private endpoints, headers, host paths, resolved executable paths, raw model transport, or command stderr. Operator-only diagnostics use `run_id` correlation.

## Gateway API, uploads, and idempotency

```text
POST /v1/bundles                 # idempotent authenticated upload reservation
PUT  /v1/bundles/{artifact_id}   # idempotent exact-byte upload
POST /v1/runs                    # submit AgentRunRequest v1
GET  /v1/runs/{run_id}           # current state or terminal AgentRunResult v1
POST /v1/runs/{run_id}/cancel
GET  /v1/artifacts/{artifact_id} # immutable result-artifact bytes
```

Every upload reservation, stored input bundle, run, result, and result artifact persists a non-public `owner_tenant`. Run/result artifacts also persist `run_id` and evidence purpose. Every duplicate-submit lookup, upload PUT, run GET, cancel, and artifact GET resolves the tuple `(authenticated_tenant, object_id)`; an absent or other-tenant object returns the same non-enumerating HTTP 404. UUIDv7 is never authorization. Cancellation and artifact access require the same tenant/run authorization as result polling.

`POST /v1/bundles` accepts the closed body below. `(owner_tenant, upload_id)` is unique. A first reservation returns HTTP 201 and its `BundleReference`; an exact retry with identical media type/digest/size returns HTTP 200 and the same reference; any changed metadata returns `upload_id_conflict` without mutating the original. The provider persists `upload_id` before the request and reuses it after response loss.

```text
{
  schema_version: "bundle_reservation_request.v1",
  upload_id: UUIDv7,
  media_type: "application/vnd.allagents.gateway-bundle.v1.tar+gzip",
  digest: SHA-256 digest,
  size_bytes: positive integer
}
```

`PUT /v1/bundles/{artifact_id}` accepts exactly the reserved size, verifies the streamed digest, and atomically marks the reservation usable. Repeating the same completed upload returns success without rewriting bytes; failed or different bytes can never mutate it. Reservations expire tenant-scoped. Input/source/post-run bundles are not result artifacts and are never readable through `/v1/artifacts`.

Submission, polling, and cancellation return the same closed status envelope:

```text
{
  schema_version: "agent_run_status.v1",
  run_id: UUIDv7,
  state: "received" | "queued" | "acquiring_workspace" |
         "preparing_run" | "running_agent" | "stopping_agent" |
         "sealing_agent_result" | "preparing_post_run" |
         "running_post_run" | "finalizing" | "cleaning" |
         "cancelling" | "failing" | "stopping_processes" |
         "completed" | "cancelled" | "infrastructure_error",
  terminal: boolean,
  result: AgentRunResult | null
}
```

For nonterminal states, `terminal` is `false` and `result` is null; terminal states require a matching result. A new admitted run returns HTTP 202. An exact duplicate or poll of a terminal run returns HTTP 200. Accepted cancellation returns HTTP 202; a terminal run returns HTTP 200 unchanged.

`GET /v1/artifacts/{artifact_id}` serves only unexpired immutable **result** artifacts linked to a run visible to the authenticated tenant. A successful response streams exact bytes without redirect and includes `Content-Type`, `Content-Length`, `Digest: sha-256=...`, immutable `ETag`, and `Cache-Control: private, immutable`; these encode the `ArtifactReference` media type, size, and digest. Other-tenant, unknown, input-bundle, and detached artifacts are indistinguishable HTTP 404. An authorized reference past `expires_at` returns HTTP 410; its tenant/run metadata tombstone remains through result retention even after bytes are deleted asynchronously. The service re-verifies stored size/digest while streaming and returns `artifact_integrity_failed` instead of corrupt bytes. The provider downloads every referenced final output, command stream, requested file, or trajectory through this endpoint and verifies headers and bytes before use.

Run submission order is normative:

1. Authenticate the caller; validate the closed schema; canonicalize and hash the complete request.
2. Look up both `(owner_tenant, run_id)` and `(owner_tenant, idempotency_key)` before mutable admission. If both identify the same request digest/run, return that existing status without rechecking current source/profile/network policy or bundle mutability. Any identity/digest mismatch returns `idempotency_conflict`. Other tenants' identities are outside this lookup.
3. For a genuinely new identity, acquire an internal tenant/identity submission claim. Concurrent exact submissions wait on that claim; it is not a public run and has bounded crash recovery.
4. Under the claim, perform all mutable admission: deterministic source-route authorization, uploaded-bundle ownership/usability, model/runtime-profile/network-policy authorization, runtime executable allowlist, limit ceilings, destination/path rules, and aggregate requested-file artifact reservation. Resolve the authorized `runtime_profile_id` once to an immutable revision and verify its canonical `profile_digest`, runtime image digest, tool/service implementation digests, and any service image digests. An admission failure returns its HTTP error and creates no public run or job.
5. On successful admission, one transaction writes the tenant-owned public run in `received`, pins canonical request/digest plus the complete immutable resolved-profile revision and digests, absolute deadlines, and artifact reservation, enqueues one job, then completes the claim. Exact retries now take step 2.

The provider may retry upload reservation, byte upload, run submit, poll, cancel, and artifact download with the same identities. It never creates a replacement run for transport loss. A Promptfoo repetition creates a new run. Duplicate submission does not re-admit mutable policy, but worker execution still reauthorizes each source before resolution and cache attachment. Worker recovery may repeat safe acquisition or cleanup; if durable state cannot prove the agent was never invoked, it records infrastructure error instead of invoking again.

## State machine

Persist every transition with a monotonic sequence and compare-and-swap expected state:

```text
received -> queued -> acquiring_workspace -> preparing_run
         -> running_agent -> stopping_agent -> sealing_agent_result
         -> preparing_post_run -> running_post_run
         -> finalizing -> cleaning -> completed

sealing_agent_result -> finalizing            # post_run_mode = none
any nonterminal state -> cancelling -> stopping_processes -> cleaning -> cancelled
any nonterminal state -> failing -> stopping_processes -> cleaning -> infrastructure_error
cleaning -> cleaning                            # failed attempt downgrades candidate to cleanup_failed; retry/reconcile
```

Rules:

1. Authentication, schema/canonical hashing, tenant-scoped duplicate/conflict lookup, and all mutable policy/resource admission complete before `received`; admission failure creates no public state-machine record. Successful admission atomically creates the tenant-owned run and one queued job.
2. Queue work is leased. Lease expiry may repeat authorization, cache attachment, or cleanup only before the durable agent-invocation marker.
3. Entering `running_agent` atomically records the sole permitted invocation number, `1`.
4. `stopping_agent` gracefully terminates, waits a bounded grace period, kills the agent cgroup, closes the model proxy and agent egress, and confirms no agent-owned process remains. It does not kill operator-owned task services in the separate service cgroup.
5. `sealing_agent_result` finalizes and durably records bounded `CapturedText`, usage, and trajectory, closes agent-owned descriptors, removes adapter home/model/source credentials, and changes process ownership from agent to post-run. The final workspace remains in the same sandbox and keeps its declared source permissions.
6. If post-run work was requested, `preparing_post_run` durably writes the full ordered `PostRunEvidence` skeleton, applies the independently authorized post-run network policy, and—only after the agent teardown and credential-removal invariants hold—acquires, verifies, extracts, and mounts requested bundle bytes at the reserved late-mount point. It then resolves executables from the pinned profile revision and starts or health-checks its declared task services.
7. `running_post_run` executes commands and collects files in order, durably sealing each observation before advancing. Cancellation or infrastructure failure fills the current/later entries with `unavailable`/`not_run`. It is reachable only after agent stop and result-seal confirmation.
8. With `post_run: null`, the run skips from sealing to finalization.
9. Cancellation is first-writer-wins against terminalization. Accepted cancellation yields `cancelled` only if cleanup completes without error; a cleanup fault overrides it with `cleanup_failed`/`infrastructure_error`. Late cancellation returns the already published terminal result.
10. The total deadline dominates phase deadlines. Total expiry is infrastructure error; a command's own timeout is a completed observation if cleanup completes within the remaining total deadline.
11. `stopping_processes` revokes remaining network/model access and kills agent, check, service, acquisition, helper, and descendant cgroups before cleanup.
12. `cleaning` unmounts read-only generations, deletes private writable clones and any injected bundle/scratch/root, stops task services, and releases source-cache leases only after all mounts are gone. Any cleanup-step failure durably changes the terminal candidate—even a completed or cancelled candidate—to `infrastructure_error` with `error.code: "cleanup_failed"` while preserving already sealed evidence. The run remains nonterminal in `cleaning`; bounded retries and startup reconciliation continue, and leases needed for safety remain held until the associated mounts are gone.
13. Terminal states are immutable. The API exposes `AgentRunResult` only after process/cgroup absence, per-run storage deletion, unmount, task-service stop, and cache-lease release are all verified. Only then does it finalize `cleanup_ms`/`completed_at` and atomically publish the result. Cleanup failure can therefore never leak a `completed` result; after reconciliation succeeds it publishes `infrastructure_error` with the durable evidence.

## Main direct-mode flow

1. **Author.** Promptfoo defines the rendered instruction, ordered sources/access, agent and required `runtime_profile_id` matrix values, repetition, optional raw post-run evidence, separate agent/post-run network policy names, and caller-lowerable limits.
2. **Package local paths.** The provider deterministically packages local sources and an optional post-run bundle, persists one `upload_id` per package, idempotently reserves/uploads immutable bytes, and substitutes `BundleReference` objects. Runtime-only/output-only post-run configurations upload no bundle; gateway JSON never contains a host path.
3. **Submit.** The gateway follows the normative ordering above: authenticate/schema/hash, tenant-scoped existing identity lookup, then an internal new-identity claim, mutable source/bundle/model/runtime/network/limit/artifact-budget admission, and only then one tenant-owned public run/job. Exact duplicates bypass mutable re-admission.
4. **Dispatch.** The worker leases the job, loads only the profile revision pinned at admission, and re-verifies its `profile_digest` plus runtime/tool/service implementation digests. It creates a mode-0700 run root and retained mount/runtime with the profile's unprivileged identity, read-only root, namespace/seccomp/cgroup limits, separate service/agent/check process and network boundaries, private source-clone locations, adapter home, output, scratch, and an **empty** worker-reserved late-mount point. It neither acquires nor mounts post-run bundle bytes before agent teardown; no cross-run writable or control-plane mount exists.
5. **Resolve and compose.** In request order, reauthorize each source, resolve its exact cache key, lease/build one complete immutable generation, then attach it. Mount `read_only` generations directly read-only. For `writable`, create a private reflink/CoW clone or bounded full copy. Validate the working directory and record source plus runtime provenance.
6. **Prepare services and agent.** Start only task services declared by the pinned immutable profile revision, using their verified implementation and image digests, each behind phase-specific broker endpoints; then invoke the agent in its own cgroup/process/network namespace. Default-drop policy exposes only `agent_network_policy_id` endpoints and the credential-free model proxy; post-run-only services and direct loopback/sidecar sockets are unreachable.
7. **Run once.** The adapter invokes its pinned CLI directly without a shell. It captures at most `max_agent_output_bytes` into `CapturedText`, normalizes usage, and writes bounded ATIF. There is no worker retry.
8. **Stop and seal the agent result.** Stop/reap the agent cgroup, destroy the agent network namespace/flows/broker handles, finalize bounded output/usage/ATIF, and remove model/source credentials and agent home. Keep the mount/runtime image, final workspace, source attachments, and operator service cgroup alive.
9. **Optionally collect evidence.** After the agent cgroup/network namespace/flows are gone and credentials/home removed, durably initialize the ordered evidence skeleton and create a distinct default-drop check network namespace for `post_run.network_policy_id`. Only now acquire and verify requested bundle bytes, extract them safely, and mount them read-only at the previously empty reserved point. Health-check profile-declared services, resolve runtime tools from the pinned revision's `PATH`, then execute/collect in the same final workspace, sealing each observation before advancing. No grading occurs.
10. **Allocate artifacts and seal evidence.** Charge actual requested files against their admission reservation, then deterministically promote agent output, command streams, and trajectory. Use bounded inline/truncated/omitted fallbacks when optional promotion does not fit. Persist artifacts with owner tenant/run/purpose/expiry and the pending outcome; do not create a public result/timing completion yet.
11. **Destroy and publish.** Kill check/service cgroups and namespaces, remove any bundle/scratch, unmount sources, delete clones/root, release cache leases, and verify absence. A fault downgrades the pending outcome to `cleanup_failed` while retaining sealed evidence and hiding the result through reconciliation. After verified cleanup, finalize timing/runtime provenance and atomically publish.
12. **Report.** The provider maps verified inline or downloaded `CapturedText` and usage to Promptfoo, dereferences/verifies every result artifact, and exposes the complete run/evidence under `metadata.allagents_run`. Promptfoo graders alone decide outcomes. Cancellation, infrastructure, artifact expiry, or artifact integrity errors remain typed provider errors.

## Workspace composition and immutable source cache

### Admission and common bounds

Validate source count, required access mode, destinations, destination relationships, bundle ownership, and working-directory syntax before any source side effect. For each Git/OCI source, deterministically resolve the authenticated caller identity plus canonical URL/repository to exactly one internal authorization/transport/credential route; reject zero or ambiguous matches before credentials or network access. Reauthorize that mapping before ref/descriptor acquisition and again before attaching any cache generation, including a local hit. Reauthorize uploaded bundles through the caller's artifact-store access before cache attachment. A cached generation proves content identity, never current caller authorization.

For every network connection, re-authorize the full canonical path-specific Git URL or OCI repository route, TLS name, port, and each resolved IP. V1 rejects every HTTP redirect for Git manifests/refs, OCI manifests/blobs, and OCI authentication; it never broadens a route to origin scope. Enforce TLS and reject loopback, link-local, private, metadata-service, Unix-socket, and non-allowlisted targets unless the exact operator route owns that destination.

Enforce aggregate workspace byte/file limits across attached source generations and private clones. Materialization also caps path length, component count, archive entries, headers, compression ratio, subprocesses, output, and acquisition time. Reject absolute paths, `..`, NUL, duplicate normalized paths, case-fold collisions, devices, sockets, FIFOs, set-ID bits, capabilities, unsafe hardlinks, and escaping symlinks. Preserve only regular files, directories, confined symlinks, executable mode, and deterministic ownership.

### Cache keys and generations

The source cache stores immutable, self-contained source generations, never a composed workspace. Key the canonical request below by SHA-256:

```text
GitCacheKey = {
  materializer_schema: 1,
  kind: "git",
  canonical_url: string,
  resolved_commit: 40 lowercase hexadecimal characters,
  history: { mode: "full" } |
           { mode: "shallow", depth: positive integer }
}

OciCacheKey = {
  materializer_schema: 1,
  kind: "oci",
  canonical_repository: string,
  descriptor: exact direct OCI descriptor
}

UploadedCacheKey = {
  materializer_schema: 1,
  kind: "uploaded_bundle",
  artifact_digest: SHA-256 digest,
  artifact_size_bytes: positive integer
}
```

The access mode and destination are not cache-key fields: both affect attachment, not immutable bytes. A schema/version change creates a new key; no compatibility fallback is allowed.

Each ready directory contains one closed manifest and no credentials or transport metadata:

```text
{
  schema_version: "source_cache_generation.v1",
  generation_id: UUIDv7,
  cache_key_digest: SHA-256 digest,
  materializer_schema: 1,
  kind: "git" | "oci" | "uploaded_bundle",
  content_digest: SHA-256 digest,
  size_bytes: integer >= 0,
  inode_count: integer >= 1,
  created_at: timestamp
}
```

The durable lease row is exactly `{generation_id, run_id, worker_id, expires_at}` with a unique `(generation_id, run_id)` key. The worker renews `expires_at`; expiry is a reconciliation alarm, never by itself proof that eviction is safe. Only a provably terminal/absent run permits stale-lease repair.

For an exact-key miss, one worker owns a singleflight materialization and all concurrent callers wait under their own acquisition deadlines. The owner creates a cache-owned private staging directory, fetches/unpacks and validates within bounds, removes acquisition credentials/transient locks, computes its content digest/bytes/inodes, writes the closed generation manifest and ready marker inside staging, makes the generation immutable to worker and sandbox identities, fsyncs data/directories, then atomically renames staging to the key's final path. Waiters lease only a final-path generation whose ready manifest validates. Failure or cancellation removes/quarantines staging and returns the same infrastructure cause to current waiters; a partial generation is never a hit.

Every attachment acquires a durable lease `(generation_id, run_id, worker_id, expires_at)` after reauthorization and before mount/clone. The worker renews it through agent and post-run execution. Cleanup releases it only after mounts/clones are gone. Eviction never selects a leased generation.

Track byte and inode high/low watermarks. Crossing either high watermark evicts least-recently-leased unleased generations until both low watermarks are satisfied. Admission fails with `source_cache_capacity_exceeded` when sufficient safe space cannot be made. Startup and periodic reconciliation remove incomplete staging after its bounded grace period, validate ready manifests against directory metadata, repair only leases whose run is provably terminal/absent, quarantine corrupt generations, and resume watermark eviction. Reconciliation never guesses that a live lease is stale from age alone.

Cache directories are owned by a dedicated host identity. The sandbox cannot browse the cache root. It sees only an explicitly leased generation through a read-only bind mount, or a private clone located inside its run root. No cache file is ever exposed through a shared writable alias.

### Attachment by access mode

- `read_only`: bind-mount the leased generation at its destination with `ro,nosuid,nodev`; executable-file handling follows the fixed runtime policy. The agent and post-run checks see the same read-only destination. Filesystem writes and Git writes fail.
- `writable`: create a per-run reflink/CoW clone of the entire generation, including required Git history, inside the private run root. If reflink/CoW is unavailable, make a bounded full copy. Never hardlink cache files and never share a writable upper layer or clone across runs. Mount the clone writable at its destination.
- Build/test output that targets a `read_only` destination must be redirected to a writable source, scratch, or another writable destination. The gateway does not silently promote access.

### Git source

- Accept canonical HTTPS URL and the defined ref/history fields only.
- Map authenticated caller identity plus canonical URL to exactly one internal transport/credential route in the worker control process; the request never names that route.
- Resolve the requested selector to an exact commit, derive `GitCacheKey`, reauthorize, then hit or singleflight the generation.
- On a miss, invoke pinned Git without a shell under sanitized config. Disable prompts, hooks, filters, credential persistence, alternates, submodules, LFS smudge, local/file transports, inherited config, and inherited proxies. Fetch complete reachable ancestry for `full` or exactly the requested bounded depth for `shallow`.
- Configure Git transport to reject HTTP redirects. Credentials are scoped to the exact matched canonical URL path and are never sent to another path, origin, helper, or submodule.
- Remove credential-bearing remote state and transient locks; verify the self-contained generation and checked-out commit before publish.
- When any Git source is attached `read_only`, set `GIT_OPTIONAL_LOCKS=0` for agent and post-run processes. Read-only Git commands must work without optional lock writes; mutating Git and filesystem commands must fail.
- Record requested ref, resolved commit, history, access, materializer schema, destination, and canonical tree digest.

### OCI source

- Accept a canonical repository plus exact manifest descriptor. Map authenticated caller identity plus the full repository path to exactly one internal registry/credential/TLS/media-policy route; the request never names that route.
- The matched route pins the one registry API origin and optional OCI bearer-token realm origin/path. Credentials may be sent only to that registry and the pinned realm, with audience/scope restricted to the exact repository. Any unpinned authentication challenge, redirect, foreign layer URL, descriptor URL, alternate blob host, or cross-repository mount is rejected in V1.
- Reauthorize, derive the exact `OciCacheKey`, then hit or singleflight. On a miss, fetch the exact manifest and all blobs through the authorized repository transport, verifying media type, size, digest, config, and each layer while streaming.
- V1 accepts gzip OCI image layers only. Apply whiteouts in order into private cache staging under common path/type limits.
- Never resolve tags/indexes, follow redirects/foreign URLs, or publish the composed result.
- Record requested descriptor, resolved manifest/rootfs digests, access, materializer schema, and destination.

### Uploaded-bundle source

- The provider writes deterministic tar+gzip: lexical NFC POSIX paths, normalized uid/gid/mtime, explicit directories, preserved executable bits, no host-specific metadata, and one canonical gzip header.
- The artifact store verifies upload bytes before admission. The cache verifies them again on an exact bundle-key miss before publishing the immutable generation.
- An optional post-run bundle uses the same archive safety rules but is not acquired, extracted, or mounted by the worker until after agent cgroup/network teardown and credential/home removal. It exists only when a bundle executable requires it and is never a workspace source/cache generation.
- Record exact bundle reference, extracted rootfs digest, access, materializer schema, and destination.

## Promptfoo provider

The provider is the first client of the general gateway. Its authoring configuration is closed but is not `AgentRunRequest`:

```text
LocalMode = {
  mode: "local",
  state_directory: host path,
  workspace: {
    working_directory: string,
    sources: [GitSource | OciSource | LocalBundleSource | UploadedBundleSource]
  },
  post_run: null | {
    bundle_path?: host path,
    network_policy_id: logical ID,
    commands: PostRunCommand[],
    output_files: OutputFileRequest[]
  },
  request_defaults: { agent, runtime_profile_id, agent_network_policy_id, limits }
}

RemoteMode = {
  mode: "remote",
  base_url: HTTPS URL,
  workspace: same authoring union,
  post_run: same authoring union,
  request_defaults: { agent, runtime_profile_id, agent_network_policy_id, limits }
}

LocalBundleSource = {
  kind: "local_bundle",
  path: host path,
  access: "read_only" | "writable",
  destination: relative path or "."
}
```

The provider enforces the same conditional invariant as the gateway schema: `bundle_path` is required exactly when any command has `executable.kind: "bundle"` and forbidden otherwise. Thus output-only collection and commands such as `{executable: {kind: "runtime", name: "npm"}, args: ["test"]}` require no bundle or upload.

Local mode starts an ephemeral loopback gateway and worker using the same API handlers, runner, schemas, and states with SQLite/local artifacts. It does not bypass admission or call an adapter directly. Remote mode uses authenticated HTTPS. Promptfoo's secret mechanism supplies gateway authentication outside provider config and request JSON.

For each `callApi(renderedPrompt, context)` the provider:

1. derives stable Promptfoo evaluation/case/repetition identity, allocates and persists one UUIDv7 `run_id` plus idempotency key before side effects;
2. deterministically packages each local source/optional post-run bundle, allocates and persists one UUIDv7 `upload_id` per package, then idempotently reserves/uploads and substitutes bundle references without changing order/destinations;
3. builds and locally schema-validates the complete request, including `runtime_profile_id`, all ten limits, and requested-file artifact reservation;
4. submits, polls the tenant-owned run, and propagates Promptfoo abort to cancellation using the same identity;
5. waits for the cleanup-backed terminal result;
6. for every `ArtifactReference`, calls authenticated `GET /v1/artifacts/{artifact_id}` and verifies content type, length, digest, and expiry before use;
7. on `completed`, decodes verified `CapturedText` (or inline text), maps usage, retains truncation metadata, and attaches the complete result as `metadata.allagents_run`;
8. exposes all ordered command/file observations plus verified bytes to JS/LLM graders without interpreting them;
9. on `cancelled` or `infrastructure_error`, raises a typed provider error carrying the result and its durable partial evidence, so infrastructure is excluded from behavioral rates.

Promptfoo owns matrices, repetitions, pass/fail, scores, rewards, and grader prompts; the provider does not duplicate or infer them. Export small accessors for `metadata.allagents_run`, but no gateway-specific grader or default pass rule. A configuration with `post_run: null` can use Promptfoo-native graders against agent output.

## Agent adapters

Both adapters implement:

```text
AgentAdapter.run({
  instruction,
  workspacePath,
  modelProxy,
  limits,
  outputSink,
  traceSink,
  abortSignal
}) -> { termination, exitCode, Usage }
```

Requirements:

- Pin and verify the CLI version at worker startup.
- Invoke an argument vector directly, never a shell or caller-provided flags.
- Use a fresh adapter home/config directory in run scratch.
- Disable interactive approval, login, self-update, unshipped plugins/extensions, inherited config, and persistent history.
- Accept only the request's working directory, logical model, limits, rendered instruction, and pinned runtime-profile mapping.
- Route model traffic through a worker-owned agent-phase broker. The CLI receives no upstream credential, cookie, client certificate, provider endpoint, or policy body.
- Stream normalized final text through the runner-owned `outputSink` enforcing `max_agent_output_bytes`; never accumulate or return an unbounded string. Normalize native events to ATIF incrementally. Report usage conservatively; unknown fields remain null.
- A clean agent completion is completed even if no files changed. Startup failure, crash, protocol loss, invalid native event stream, or timeout is infrastructure failure.
- On abort, stop descendants and wait for sandbox confirmation.

Conformance fixtures prove each adapter receives the instruction once, sees exact source destinations, mutates only its private workspace, streams bounded final output/usage/valid ATIF, honors logical model/runtime routing, leaks no canary secret, and is never invoked twice during recovery.

## Post-run isolation, services, and raw evidence

Post-run commands may build and run integration tests, so they operate in the same retained sandbox/runtime image and final workspace that the agent used. The workspace is not copied or overlaid by default. The agent result is sealed as output/usage/trajectory plus a process-ownership boundary; post-run filesystem changes remain ephemeral and are destroyed at cleanup.

1. The retained runtime uses the pinned immutable profile revision's unprivileged identity, read-only root, explicit seccomp allowlist, private mount/process/IPC/UTS boundaries, and mandatory cgroup-v2 pids/memory/CPU/IO limits. Operator services, the agent, and each post-run command have distinct worker-owned cgroups; sandbox processes cannot change membership or controllers.
2. The pinned profile revision—not caller JSON—declares credential-free service launch manifests/images, implementation/image digests, readiness, restart policy, broker identities/ports, phase visibility, and resource limits. Services run in worker-owned namespaces/cgroups and are never directly addressable from agent/check loopback.
3. Run the agent in its own default-drop network namespace. nftables or an equivalent kernel layer filters loopback as well as external traffic; the namespace exposes only agent-policy broker endpoints. A post-run-only service has no route or broker endpoint in this namespace.
4. After adapter completion, close model/source brokers, remove adapter secrets/home, stop/reap the agent cgroup, destroy its network namespace plus conntrack/flows/broker handles, and confirm no agent process or socket remains. Only then durably seal bounded output, usage, and ATIF while retaining the mount/runtime/workspace and service cgroup.
5. If `bundle` is present, only after step 4 acquire its bytes from the input artifact store, reauthorize and verify digest/size, safely extract them, and mount the result read-only at the empty worker-reserved path that was absent from the agent mount namespace. Resolve every bundle executable without symlink escape. No bundle executable means no bundle bytes are acquired or mounted.
6. Create a fresh check network namespace with default-drop filtering over loopback/external traffic. Resolve `post_run.network_policy_id` to explicit operator-brokered external/service endpoints; no agent-phase flow or direct sidecar socket is reused.
7. Health-check services declared by the pinned profile revision through the same phase broker and restart them under its immutable policy if allowed. Failure is infrastructure error. Agent-owned daemons are never retained/restarted, and undeclared/post-run-disallowed services are unreachable.
8. Resolve runtime names only through the pinned revision's fixed approved read-only `PATH`, never the workspace or inherited `PATH`. Execute selected executable/literal args in a fresh check cgroup/process group and the check network namespace, with bounded scratch/fixed nonsecret environment. Source access modes remain unchanged.
9. Capture bounded stdout/stderr, reap the command cgroup, then durably seal its `completed` or `timed_out` observation before starting the next command. Launch/sandbox/evidence failure seals `unavailable`; cancellation/deadline/prior failure fills untouched commands `not_run`.
10. After commands settle, collect requested files in order without following final symlinks and durably seal every observation before advancing. Unsafe/read/artifact failure seals `unavailable`; remaining files become `not_run`. Admission-reserved maxima guarantee collected-file budget.
11. Deterministically promote optional result artifacts, stop services/check namespace, and destroy the run workspace. Post-run build output persists only when explicitly requested within bounds.

The boundary does not calculate a generic diff, publish a snapshot, preserve a workspace, or create a user-visible change artifact. Post-run observations are evidence, not a judgment.

## Secrets and operator-policy boundary

Credentials and operator policy exist only in gateway/worker control processes and dedicated brokers.

- Git/OCI credentials are resolved after authorization and passed through broker sockets or inherited descriptors not mounted into agent/post-run namespaces.
- Model credentials terminate in the model proxy. Agents see only a non-secret per-run local socket and logical model mapping.
- Gateway API credentials authenticate provider transport and never enter run storage.
- After agent exit, the worker closes model/source brokers, destroys the agent cgroup/network namespace/flows, and removes adapter credential/config mounts before acquiring optional bundle bytes or resolving any post-run executable.
- Agent and post-run commands receive separate fixed environment allowlists containing locale, deterministic home/temp paths, and required non-secret switches. They do not inherit the worker environment.
- Post-run commands receive no model/source credential socket or agent home. Their fresh network namespace has default-drop loopback/external rules and only independently authorized operator-brokered endpoints; no direct sidecar or host socket is exposed.
- Operator configuration owns caller/source-route mappings (including pinned OCI token realms), credentials, model routes, runtime profiles (image/sandbox/cgroups/tools/services), phase network brokers, sidecar definitions, resource ceilings, artifact retention, and secrets. Caller JSON contains only canonical source addresses, uploaded artifact IDs, approved runtime names/relative bundle paths, literal arguments, and authorized logical model/runtime/network IDs—never a credential identity, raw path, image, service command, socket, or policy body.
- Structured logs are redacted at ingestion. Seeded-canary tests fail on appearance in request/result JSON, cache generations, ATIF, command output, requested files, subprocess environment, errors, or artifacts.

`agent_network_policy_id` and `post_run.network_policy_id` are authorized separately per tenant and realized in separate default-drop namespaces. Allowed external or service access exists only through phase-specific operator brokers. Agent namespace/flows are destroyed before check namespace creation; post-run-only and undeclared service endpoints are never reachable by the agent, including through loopback.

## Cancellation, deadlines, recovery, and cleanup

- One root abort controller fans into authorization/materialization, adapter, trace/artifact writers, service manager, post-run collector, and sandbox operations.
- Cancellation is idempotent. Repeated cancellation returns the same state; a terminal run is unchanged.
- Total and phase deadlines are persisted as absolute times so worker restart cannot reset them.
- Agent timeout revokes model/network access and kills only the agent cgroup before run cleanup; operator service/check cgroups have separate ownership.
- Post-run never starts after cancellation/agent infrastructure failure/result-seal failure. Cancellation or deadline during post-run stops the current check cgroup, seals available bounded streams, fills the full evidence vector with `not_run`/`unavailable`, then cleans up.
- A command timeout is a `timed_out` observation and later commands may continue. Exhausting the phase/total deadline produces infrastructure error with the sealed partial vector.
- Neither agent nor post-run command is retried. Exact-key materialization is singleflight, not agent retry. Safe network reads may retry only before side effects and under the original deadline.
- Cleanup runs after success, failure, cancellation, process crash recovery, and worker shutdown. It is idempotent and keyed by run ID. It stops check/service cgroups, removes any injected bundle and private clones/mounts/root, then releases cache leases.
- A cleanup-step failure atomically replaces the pending terminal outcome with `cleanup_failed`/`infrastructure_error`, keeps already durable evidence, and leaves the status envelope nonterminal with `result: null`. Cleanup retry/reconciliation continues; only verified resource absence and lease release allow publication of that infrastructure-error result.
- Startup reconciliation finds nonterminal run records, private roots, cache staging, and leases. It completes safe staging/cleanup; if agent invocation may have begun, it records infrastructure error instead of invoking again. It never publishes a result while cleanup residue or a run lease remains.
- Run/result records and immutable cache generations follow operator retention. Input bundles have separate non-downloadable retention. Every result artifact stores owner tenant/run/purpose plus `expires_at`, remains immutable until expiry, then returns 410 to its authorized owner and is deleted asynchronously. Per-run workspaces, clones, optional bundles, and scratch are destroyed before result visibility.


## Delivery phases and observable exit proofs

### Phase 0 — Bootstrap the one repository

Create the Bun workspace, package boundaries, pinned toolchain, CI, license, schema-generation command, gateway/worker process entrypoints, PostgreSQL/SQLite migrations, artifact/cache interfaces, and health/readiness endpoints. Add dependency-boundary checks that keep Promptfoo, Fastify, and adapters out of `packages/runner`.

**Exit proof:** a clean checkout installs from the lockfile, generates schemas/types, applies and rolls back migrations on disposable state, starts gateway and worker, reports healthy/readiness with artifact/database/cache dependencies, and shuts down cleanly. No run submission, agent, cache materialization, or end-to-end claim belongs to Phase 0.

### Phase 1 — Freeze contracts, API, persistence, and state

Implement exact schemas/generated types, canonical hashing, tenant-owned upload/run/result-artifact persistence, idempotent bundle reserve/upload, artifact download, status/cancel, internal submission claims, duplicate-before-admission ordering, mutable admission, state CAS, errors, deadlines, cancellation, immutable runtime-profile revision pinning, ten limits/artifact reservation, direct provenance, bounded `CapturedText`, and full partial `PostRunEvidence` unions. Add golden documents for every union/status/nullability/limit/provenance/error.

**Exit proofs:**

- unknown fields, omitted runtime profile/source access, host paths, policy bodies, shell strings, overlap, noncanonical sources, caller credential/image/service controls, malformed executable unions, incorrect bundle conditional, and excessive/reservation limits fail before any public run;
- exact duplicate lookup returns an existing run after source/profile policy changes without mutable re-admission; conflict rejects; a new identity that fails admission leaves no public run/job, while 50 concurrent valid identical submits create one;
- every run/upload/result artifact stores owner tenant; same-tenant GET/cancel/download succeeds, while another tenant using the same run/artifact/upload UUID receives the same non-enumerating 404 as an unknown object and cannot cancel/read/write;
- bundle reservation retry with one `upload_id` returns the same reference, changed metadata conflicts, exact PUT replay succeeds, and cross-tenant PUT fails;
- artifact GET streams immutable bytes with matching media type/length/digest/expiry, returns 410 after authorized expiry, rejects input bundles/detached artifacts, and refuses corrupt stored bytes;
- golden results prove ten effective limits, `DirectWorkspaceProvenance`, revision-pinned `RuntimeProvenance`, bounded `CapturedText`, and completed/cancelled/infrastructure variants with null or full ordered partial evidence vectors;
- cancellation races terminalization deterministically; terminal results are immutable; public errors/logs omit seeded secrets and nonsecret resolved paths.

### Phase 2 — Cache, package, and compose bounded sources

Implement deterministic packaging, streamed uploads, exact Git/OCI/bundle cache keys, cache-owned staging, exact-key singleflight, atomic complete generations, authorization on hits, durable leases, reflink/full-copy attachment, read-only mounts, watermarks, eviction, reconciliation, private root allocation, aggregate bounds, ordered provenance, working-directory validation, and cleanup.

**Exit proofs:**

- two packagings of one tree are byte-identical; submitted JSON contains a bundle reference/access mode and no host path;
- three sources land at declared non-overlapping destinations and provenance preserves request order, canonical Git URL/OCI repository, access, exact resolved identity, and materializer schema;
- overlap, omitted access, destination aliasing, or `.` with multiple sources fails before credential/network/cache attachment;
- Git keys use canonical URL plus exact commit/history; OCI keys use canonical repository plus exact descriptor; bundle keys use exact digest/size; schema/key changes never fall back to another generation;
- Git/OCI reject every redirect; path-scoped credentials never reach another path/origin; OCI accepts only its pinned token realm/exact repository and rejects foreign blob/descriptor URLs, cross-repository mounts, and unpinned auth challenges;
- 50 concurrent cold runs for one exact large Git or OCI source perform one fetch/materialization, publish one complete generation, and acquire 50 leases;
- a cache hit after caller authorization is revoked or remapped is denied before mount even though identical bytes exist locally, and a different tenant cannot obtain access merely by guessing the canonical source address;
- `read_only` mounts share one immutable generation, accept read-only Git commands under `GIT_OPTIONAL_LOCKS=0`, and reject filesystem/Git writes;
- two `writable` runs receive distinct reflink/CoW clones (or bounded full copies), can mutate independently, and cannot change each other or the cache; inode/link checks prove no hardlinked writable alias;
- malicious traversal/links/devices, digest mismatch, gzip bomb, aggregate limits, and corrupt/incomplete generations fail before agent start;
- eviction skips a generation while any run lease exists, removes it only after final lease release, and converges from high to low byte/inode watermarks;
- restart reconciliation removes stale staging, preserves live leases, quarantines corrupt generations, and never exposes a partial generation;
- run cleanup removes mounts/clones/root and releases leases while leaving authorized immutable generations reusable.

### Phase 3 — Run Codex and OMP exactly once

Implement admission-time immutable runtime-profile revision/digest pinning, dispatch-time re-verification, exact `RuntimeProvenance`, the production `RunSandbox` invariants, cgroup-v2 controllers, default-drop agent networking/brokers, model proxy, retained mount/runtime, Codex/OMP adapters, bounded `CapturedText`/ATIF/usage, stop/reap/network-destruction boundary, and durable invocation marker.

**Exit proofs:**

- the full proof moved from Phase 0 now runs: a clean checkout starts disposable services, admits one no-post-run Git fixture, materializes/cache-leases it, invokes each adapter once, returns bounded output/usage/ATIF/source+runtime provenance, removes every run resource/lease, and retains only the authorized immutable source generation;
- a profile ID resolves once at admission to a persisted immutable revision. Dispatch uses only that revision and verifies the expected `profile_digest`, runtime `image_digest`, sandbox-policy version, every tool/service `implementation_digest`, containerized service `image_digest`, cgroup ceiling, and broker identity; changed/missing/mismatched revisions fail before agent invocation, and returned provenance proves exact implementations without paths, commands, policy bodies, or secrets;
- output below/at/above `max_agent_output_bytes` yields verified inline/artifact/truncated `CapturedText` without unbounded memory or persistence;
- non-root UID/GID mapping, empty capabilities, `no_new_privs`, private namespaces, read-only root, bounded tmpfs, masked proc/sys/cgroup/devices/host sockets, explicit seccomp, and no writable control-plane mount pass escape/mount/device/socket/syscall probes;
- fork-bomb, memory/OOM, CPU, and IO fixtures remain within cgroup-v2 limits and cannot affect a sibling run or worker;
- agent namespace default-drop covers loopback/external traffic: allowed broker/model fixtures work, undeclared and post-run-only services fail, and teardown removes all agent processes, sockets, flows, and namespace handles;
- crash/timeout/cancel produce infrastructure/cancelled results only after cleanup; crash around the invocation marker never starts a second agent; canary credentials/policy stay absent.

### Phase 4 — Seal agent output and collect evidence in the retained sandbox

Implement durable evidence skeleton/observation sealing, an empty reserved late-mount point plus post-agent bundle acquisition/mount, pinned-profile tool/service resolution, distinct default-drop check network namespace/brokers, ordered commands/files, partial cancellation/error vectors, aggregate artifact allocation/promotion, artifact metadata/expiry, cleanup downgrade, and publication gate.

**Exit proofs:**

- output-only and runtime-only requests omit a bundle. Before agent teardown even a requested bundle's bytes are neither acquired nor mounted and its reserved point is empty; afterward profile `npm` with literal `["test"]` runs in the exact final workspace, while a bundle executable triggers the late verified read-only confined mount;
- each command/file seals before the next. Cancellation between commands returns prior evidence plus ordered `not_run`; cancellation during command 2 seals it `unavailable` with safe bounded partial streams and later items `not_run`; command-2 launch failure returns command 1, command 2 `unavailable`, command 3/files `not_run`; file read/artifact failure similarly preserves earlier observations;
- exit zero/nonzero/timed-out commands are lifecycle completed with `completed|timed_out` observations; a timed-out cgroup is gone before the next command;
- read-only sources stay read-only; writable sources hold build output across commands; requested files produce collected/missing/limit-exceeded/not-regular states;
- the check namespace exists only after agent namespace/flows are destroyed. Default-drop includes loopback; post-run-only brokered sidecar works for checks but was unreachable to the agent; undeclared/direct sidecar and external endpoints fail;
- model/source credentials and agent home are absent and the agent cgroup/network/flows are destroyed before any optional bundle-byte acquisition, extraction, mount, or executable resolution;
- admission rejects `sum(output_files.max_bytes)` over budget. Actual files charge first, then agent output, command stdout/stderr order, then trajectory; exact-boundary fixtures prove accounting/no dedup discount and deterministic inline-truncated/omitted fallback without infrastructure error;
- downloaded artifact bytes match owner/run/purpose/media/digest/size/expiry; hidden input bundles never appear as downloadable result artifacts;
- runtime/bundle/service/sandbox/launch/unsafe collection failures return infrastructure error with the exact partial vector; cleanup failure preserves it, withholds all result visibility through reconciliation, and never publishes completed;
- large output stays bounded and ATIF fallback remains valid with one truncation marker.

### Phase 5 — Complete Promptfoo local and remote flows

Implement provider modes, crash-safe run/upload identities, multi-source/runtime-profile mapping, idempotent packaging/upload, polling/cancel, artifact download/verification, bounded output/usage/metadata mapping, partial-evidence accessors, and native matrix/repetition/JS/LLM examples.

**Exit proofs:**

- one case runs local/remote with schema-equivalent results; Git/OCI/local bundles preserve order/access without host paths;
- provider maps runtime plus phase-network logical IDs and never embeds an image, PATH, service, policy, or credential;
- lost reservation/submit/download responses replay `upload_id`/run/artifact identity without duplicate upload/run/agent;
- inline and artifact-backed agent output, command streams, files, and trajectories are byte/digest/media verified; expiry/corruption becomes typed infrastructure, never a grader input;
- cancelled/infrastructure errors carry their result/partial evidence to diagnostics but are excluded from behavioral rates;
- a Codex/OMP matrix with two repetitions creates four private runs sharing authorized immutable generations; JS/LLM graders alone decide outcomes from verified raw evidence;
- cross-tenant run/cancel/artifact attempts fail identically in local and remote modes; no host path, credential, policy body, process, mount, clone, or run directory survives.

## Deferred integrations

Harbor, Terminal-Bench, and SWE-bench integration are outside this V1 implementation plan. V1 has no Harbor source variant, request, backend, package, result variant, provenance variant, sandbox delegation, or patch exporter. Future work requires a separate ADR and closed schema extension defining its own request plus result/provenance mapping into raw nongrading evidence without changing direct-mode semantics.

## Focused release E2E

The release gate runs the built gateway, worker, packaged Promptfoo provider, real local Git/OCI/object-store fixtures, source cache, and pinned agent fixtures/CLIs. For each scenario record request/result JSON, state sequence, invocation count, source fetch/materialization count, generation/lease state, resolved provenance, per-run cleanup, and artifact digests.

| Scenario | Expected proof |
|---|---|
| Multi-source Codex/OMP direct runs | exact access/destinations; one invocation; source+runtime provenance; cleanup |
| Runtime-profile revision matrix | admission pins `profile_digest`; dispatch re-verifies exact runtime/tool/service implementation and image digests; no caller paths/commands |
| Runtime `npm test`, no bundle | approved profile tool, literal args, same final workspace, no bundle upload/mount |
| Bundle executable | bundle required iff used; worker does not acquire/mount bytes before agent teardown; later verified confined immutable mount |
| 50 cold exact-source runs | one materialization, 50 leases, isolated writable clones/shared read-only generation |
| Redirect/OCI credential attacks | all redirects/foreign URLs/unpinned realms rejected; credentials stay exact path/repository scoped |
| Read-only/writable/eviction | writes fail on shared RO; writable clones isolate; live lease blocks eviction |
| Sandbox breakout suite | non-root/no capabilities/no_new_privs/private namespaces/RO root/seccomp/hidden host resources |
| Fork/OOM/CPU/IO attacks | cgroup-v2 ceilings contain run without worker/sibling impact |
| Phase network isolation | default-drop loopback/external; agent cannot reach post-run service; check uses broker only |
| Nonzero/timed-out commands | lifecycle completed; exact completed/timed_out evidence; timed-out cgroup reaped |
| Cancel during second command | first observation retained; in-flight command unavailable with safe partial streams; untouched commands/files ordered not_run |
| Launch/file collection failure | prior observations retained; failed item unavailable; later items not_run; infrastructure_error |
| Artifact-budget boundary | files charge first, then agent/streams/trajectory; deterministic truncated/omitted fallback |
| Bounded agent output | inline/artifact/truncated `CapturedText` at below/exact/above cap; no unbounded state |
| Result artifact download | tenant/run-authorized immutable bytes verify media/size/digest; expiry 410; corrupt bytes refused |
| Cross-tenant UUID replay | run GET/cancel, upload PUT, artifact GET all match unknown-object 404 with no effect |
| Upload response loss | same `upload_id` returns one reservation/reference and exact PUT replay |
| Duplicate run after policy change | same result without re-admission; conflicting body rejects; new admission failure leaves no run |
| Promptfoo local/remote matrix | persistent identities, verified artifact dereference, four private runs, grader-only outcomes |
| Crash/cleanup fault | no second agent; result hidden through cleanup; final infra result retains durable evidence |
| Seeded canaries | absent from environments/cache/public artifacts/errors/logs |

CI may retain sanitized JSON, immutable cache fixtures, and referenced evidence, but never a live run workspace, writable clone, generic diff, grading decision, reward, or modified-workspace artifact.

## Completion checklist

- [ ] `allagentsdev/allagents-gateway` is the only new repository and contains provider, gateway API, worker/runner, contracts, source cache/composer, service manager, post-run collector, and both agent adapters.
- [ ] Runtime, HTTP, persistence, queue, cache, isolation, schema, identity, and ATIF choices match this plan; no implementation framework remains undecided.
- [ ] Closed schemas cover `runtime_profile_id`, ten limits, bounded `CapturedText`, aggregate artifact budget, `PostRunEvidence`, direct workspace and revision-pinned runtime provenance, upload idempotency, artifact references, and every result nullability/invariant.
- [ ] Promptfoo is the first caller and sole evaluation/grading layer; gateway JSON has only completed/cancelled/infrastructure_error and no pass/fail/reward.
- [ ] Authentication/schema/hash and tenant-scoped duplicate/conflict lookup precede mutable admission; exact duplicates bypass re-admission; new admission failures create no public run/job.
- [ ] Every upload/run/result artifact persists owner tenant; duplicate submit, GET, cancel, upload PUT, and artifact GET resolve tenant+object with indistinguishable unknown/cross-tenant 404 behavior.
- [ ] Bundle reserve uses persisted client `upload_id`; exact reserve/upload replay is idempotent and changed metadata conflicts.
- [ ] Authenticated artifact GET serves only tenant/run-bound unexpired result bytes with immutable media/size/digest headers; input bundles are not exposed, owner expiry is 410, and corruption is refused.
- [ ] `max_artifact_bytes` reserves requested-file maxima and charges actual files, agent output, ordered command streams, then trajectory; no dedup discount; budget exhaustion uses bounded truncated/omitted evidence rather than infrastructure failure.
- [ ] Local paths are packaged before submission; gateway JSON has no host path.
- [ ] Git canonical URL/ref/history, OCI repository/exact descriptor, bundles, access, schema, destination, and resolved identities return ordered provenance.
- [ ] Git/OCI use exact path-specific caller routes, reject all redirects, pin OCI token realm/repository scope, and reject foreign descriptor/blob URLs; cache hits reauthorize.
- [ ] Exact cache keys singleflight into complete immutable generations with durable leases, byte/inode watermarks, safe eviction/reconciliation, direct RO mounts, and private CoW/full-copy writable clones without hardlinks.
- [ ] Admission persists one immutable runtime-profile revision and `profile_digest`; dispatch uses only that revision and re-verifies runtime image, sandbox, broker, tool/service implementation, and containerized-service image identities before agent invocation; `RuntimeProvenance` proves them without secret args/paths.
- [ ] `RunSandbox` enforces unprivileged non-root UID/GID, empty capabilities, no_new_privs, private namespaces, RO root, bounded tmpfs, masked host resources/sockets, explicit seccomp allowlist, mandatory cgroup-v2 pids/memory/CPU/IO, and no writable control-plane mounts.
- [ ] Agent/check network namespaces are distinct and default-drop including loopback; all external/service access is phase-brokered; agent flows/namespaces die before post-run, so post-run-only services are never agent-reachable.
- [ ] Codex/OMP invoke once and stream at most `max_agent_output_bytes`; completed results expose inline/artifact/truncated `CapturedText`, usage, and valid bounded ATIF.
- [ ] Optional bundle is present iff a bundle executable is requested; dispatch creates only an empty reserved late-mount point and does not acquire or mount bundle bytes until agent cgroup/network/flows and credentials/home are gone. Runtime tools come only from the pinned profile revision's PATH; args are literal; commands use the exact final workspace.
- [ ] Post-run initializes one full ordered evidence skeleton, seals each command/file before advancing, and represents completed/timed_out/not_run/unavailable plus all file states.
- [ ] Cancelled/infrastructure results retain durable partial evidence; behavioral nonzero/timeout/missing/limit/non-regular observations do not become infrastructure.
- [ ] Provider persists run/upload identities, downloads/verifies all artifact-backed output/evidence/trajectory, exposes partial evidence diagnostically, and leaves grading to Promptfoo.
- [ ] Cleanup removes every process/namespace/flow/service/mount/clone/root and releases leases before result visibility; cleanup failure forces infrastructure_error while retaining evidence through reconciliation.
- [ ] Credentials/policy remain outside caller JSON, run environments, cache, evidence, errors, artifacts, and logs.
- [ ] No reusable session, continuation, checkpoint, composed-workspace or snapshot publication cache, generic core change artifact, or second repository remains.
