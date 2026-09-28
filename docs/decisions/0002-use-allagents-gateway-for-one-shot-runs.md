# ADR 0002: Use a one-shot AllAgents Gateway with Promptfoo as the first caller

- Status: Accepted
- Date: 2026-09-21
- Updated: 2026-09-28

## At a glance

A Promptfoo case asks OMP to fix a bug in a workspace composed from writable application Git commit `8c4f…` at `app/` and a read-only OCI-hosted fixture at `fixtures/`, with `app/` as the working directory. It selects the authorized `node22` runtime profile and `package-install` agent network policy, then requests post-run evidence from a hidden immutable check bundle: confined executable `verify`, literal arguments `["--json", "reports/test.json"]`, bounded output file `reports/test.json`, and the `integration-checks` post-run network policy. The provider packages local content and submits one `AgentRunRequest v1`. A worker resolves the profile to an immutable image and creates a fresh `RunSandbox`; the runner attaches authorized immutable source generations and invokes OMP once. After OMP exits, the runner terminates its process tree, destroys its network namespace and credentials, preserves the runtime and workspace, and runs the check in a separately brokered post-run network namespace. Only after evidence persistence, service stop, unmount, private-root deletion, and lease release succeed does the gateway return `status: "completed"` with direct and runtime provenance, bounded agent output, usage, trajectory, ordered raw command evidence, and the report's `ArtifactReference`. The provider downloads that artifact through the authenticated result-artifact endpoint, verifies its length and digest, and gives the evidence to Promptfoo's code grader; the gateway itself never decides pass or reward.

The gateway's product is one-shot execution output and raw evidence, not a behavioral judgment or workspace diff. No caller continues the coding session, restores a checkpoint, or reconstructs the final tree from change artifacts. The previous HarnessRouter/UHP session and snapshot architecture therefore solves lifecycle and transport problems that one-shot runs do not have.

## Context

AllAgents needs a general remote gateway for one-shot coding-agent runs, similar in purpose to HarnessRouter but deliberately smaller in lifecycle. Promptfoo is its first caller and remains the authoring and experiment layer for evaluations: it owns test cases, variable and provider matrices, prompt rendering, repetitions, grading, assertions, and reports. Other callers may omit post-run evidence collection and consume the agent output directly.

A run has one rendered instruction, one composed workspace, one selected agent, and optional post-run evidence collection. Its mutable state exists only for that run. It is not a reusable coding session. Promptfoo maps each evaluation trial and repetition to a distinct run and applies its own code or LLM grader to the returned evidence. Retries must not accidentally share state or run the agent more than once.

The earlier version of this decision treated remote agent execution as a UHP session served by a HarnessRouter-derived gateway. It introduced a separate workspace-builder repository, published OCI workspace snapshots, added snapshot import and filesystem journaling to HarnessRouter, checkpointed workspaces for continuation, and exported generic workspace-change artifacts. Those capabilities are unnecessary for one-shot runs and create protocol, fork, storage, and recovery obligations unrelated to the result callers need.

Supporting evidence and comparisons are recorded in [One-shot coding-agent gateway boundary](../research/one-shot-coding-agent-gateway-boundary.md).

## Decision

We will build one general one-shot AllAgents Gateway. The gateway API, reusable worker and runner packages, Promptfoo provider, and Codex and OMP adapters will live in one source repository: `allagentsdev/allagents-gateway`.

The public operation is `AgentRunRequest v1` and `AgentRunResult v1`. Both are closed, versioned JSON contracts: unknown fields are rejected, identifiers are explicit, and incompatible changes require a new version. The contract borrows useful UHP conventions—stable IDs, idempotency, cancellation, structured errors, and bounded structured telemetry—but V1 does not implement UHP or expose reusable sessions.

HarnessRouter issue [#304](https://github.com/HarnessRouter/harnessrouter/issues/304) is superseded by this decision. The two-repository gateway/workspace-builder snapshot design is also superseded and is not an implementation contract for the AllAgents Gateway.
The `allagentsdev/allagents-gateway` repository name is retained for the new standalone service; none of the former HarnessRouter fork, snapshot, or workspace-builder contract survives.

## Main flow

1. A caller defines an ordered multi-source workspace, selects an authorized logical runtime profile, and renders one instruction. For evaluations, Promptfoo first expands its cases, variables, providers, and repetitions and assigns every repetition a distinct run identity.
2. The Promptfoo provider deterministically packages local source and optional check content, reserves uploads with client-generated `upload_id` values, uploads immutable bundles, and configures the raw evidence its graders need. It calls the AllAgents Gateway with artifact references and digests; remote JSON never contains a caller host path.
3. The gateway authenticates and validates the closed request, then performs tenant-scoped duplicate lookup before mutable admission. An exact duplicate returns the existing run without re-admission. For a genuinely new identity, the gateway applies source, model, network, and resource policy, resolves `runtime_profile_id` to an authorized immutable `profile_digest`, and durably pins that revision; rejected new requests create no public run or job.
4. A worker accepts only the pinned profile revision and creates one fresh ephemeral sandbox from its immutable image and sandbox policy; unavailable or mismatched profile content fails the run. For Git and OCI, the gateway maps the authenticated caller plus canonical URL or repository to exactly one internal source policy and credential route before credentials or network access; zero or ambiguous matches reject the run. The runner resolves sources, rechecks policy, and attaches operator-owned immutable generations. `read_only` sources mount directly read-only; `writable` sources receive private CoW/reflink clones or full-copy fallback.
5. The selected Codex or OMP adapter runs the agent once under the agent network phase. The runner captures bounded structured final output, usage, timing, and trajectory.
6. After the agent exits, the runner terminates the agent process tree, destroys its network namespace and flows, and removes model and source credentials while preserving the sandbox, pinned runtime, final workspace access modes, and operator-declared task services. Only after that transition does it inject the immutable check bundle when requested, create the separately authorized post-run network namespace, and execute declared runtime or bundle executables with literal arguments.
7. The worker durably seals each raw post-run observation in request order, persists requested file artifacts, then stops post-run processes and task services, unmounts every trial mount, deletes the private trial root, and releases every cache lease. These operations are idempotent and must all succeed before any terminal result becomes visible.
8. The gateway then publishes `completed`, `cancelled`, or `infrastructure_error`. Cleanup failure forces `infrastructure_error` with partial evidence; reconciliation completes cleanup before publication. Promptfoo retrieves referenced artifacts, verifies their declared size and digest, and exposes the evidence to code or LLM graders, which alone decide behavioral outcomes.

There is no checkpoint, continuation, reusable coding session, or implicit rerun in this flow.

## Ownership

### Promptfoo

Promptfoo owns evaluation intent and aggregation:

- case and dataset authoring;
- variables, provider and agent matrices, and repetition counts;
- rendering the complete instruction supplied to a run;
- defining post-run evidence collection and applying code or LLM graders to agent output, command results, and file artifacts; and
- experiment reports, pass/fail decisions, rewards, assertions, and comparisons across runs.

Promptfoo does not own the remote sandbox, materialize host paths remotely, inspect gateway credentials, or infer success from changed files.

### AllAgents Promptfoo provider

The provider is the boundary adapter between Promptfoo and the AllAgents Gateway API. It assigns run and idempotency identity, converts Promptfoo configuration into `AgentRunRequest v1`, packages any check bundle, uploads and content-addresses local inputs before submission, waits for or cancels the run, and exposes `AgentRunResult v1` output, command results, and file artifacts to Promptfoo's code or LLM graders. Those graders alone assign pass, fail, or reward.

Packaging is intentionally client-side. A local repository path, check-bundle path, fixture path, or requested output destination on the caller host is never meaningful to a remote worker and must not appear in the remote request.

### AllAgents Gateway, worker, and runner

The gateway API is the durable public control plane. It owns tenant authentication, request validation, duplicate lookup, admission, idempotency, cancellation, worker dispatch, artifact authorization, and result retrieval. A worker owns one admitted run's process and sandbox lifecycle. Inside that worker, the reusable runner package owns workspace composition, isolation, resource enforcement, agent supervision, the agent-to-evidence phase transition, ordered durable evidence capture, cleanup, and terminalization. Codex and OMP adapters translate the common run contract into each agent's invocation and normalize output, usage, and trajectory data; they do not define separate public execution contracts.

Operator configuration owns credentials, source authorization, model routing, runtime profiles, fixed runtime tools, sandbox policies, phase-specific network policies, task-service definitions, resource ceilings, retention, and deployment policy. None of those secrets or policy documents are caller-controlled fields.

### Post-run evidence

The `post_run` field is required but nullable: `null` requests no extra evidence, while a nonnull value requests evidence collection rather than verification. It may identify an immutable check bundle, commands with individual timeouts, bounded workspace-relative `output_files`, and a separately named post-run network policy. Each command selects either an operator-allowed executable already present in the task runtime or an executable at a confined path inside the optional check bundle, then supplies literal arguments. A bundle executable requires `bundle`; runtime executables and output-only collection do not. Bundle bytes and a populated bundle mount are absent throughout agent execution; at most an empty, runner-owned reserved mountpoint exists. The runner first terminates every agent-owned descendant, destroys the agent network namespace and flows, and removes model and source credentials. Only then may it materialize the bundle into that mountpoint read-only and make it visible to post-run commands. Those commands use the same pinned runtime and final workspace with each source's declared access mode preserved. This lets checks use build tools such as `npm`, build the project, and exercise its actual runtime. Operator-declared task services may remain running or be restarted for checks; arbitrary agent-owned background processes never cross the phase boundary. Checks that need to modify a source must declare it `writable` or place build and test output in a separate writable path. Nonzero exits, timeouts, stdout, stderr, and generated files are observations. The gateway records them without interpreting task success. Promptfoo or another caller owns any code or LLM grader that turns those observations into pass, fail, reward, or commentary.

## Public request boundary

`AgentRunRequest v1` is defined by the normative closed schema `schemas/agent-run-request.v1.schema.json`. Its logical shape is:

```text
{
  schema_version: "agent_run_request.v1",
  identity: {
    run_id: UUIDv7,
    idempotency_key: string
  },
  instruction: string,
  workspace: {
    working_directory: relative path or ".",
    sources: array of 1..128
      | {
          kind: "git",
          url: canonical HTTPS URL,
          ref: string,
          history: { mode: "full" } |
                   { mode: "shallow", depth: positive integer },
          access: "read_only" | "writable",
          destination: relative path or "."
        }
      | {
          kind: "oci",
          repository: canonical OCI repository,
          descriptor: {
            media_type: "application/vnd.oci.image.manifest.v1+json",
            digest: SHA-256 digest,
            size_bytes: positive integer
          },
          access: "read_only" | "writable",
          destination: relative path or "."
        }
      | {
          kind: "uploaded_bundle",
          bundle: BundleReference,
          access: "read_only" | "writable",
          destination: relative path or "."
        }
  },
  agent:
    | { kind: "codex", model: logical ID, reasoning_effort: "low" | "medium" | "high" }
    | { kind: "omp", model: logical ID },
  runtime_profile_id: logical ID,
  post_run: null | {
    bundle?: BundleReference,
    network_policy_id: logical ID,
    commands: array of 0..32 {
      command_id: logical ID,
      executable:
        | { kind: "runtime", name: logical ID }
        | { kind: "bundle", path: relative path },
      args: array of literal strings,
      timeout_ms: positive integer
    },
    output_files: array of 0..128 {
      name: logical ID,
      path: relative path,
      media_type: IANA media type,
      max_bytes: positive integer
    }
  },
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

BundleReference = {
  artifact_id: UUIDv7,
  media_type: "application/vnd.allagents.gateway-bundle.v1.tar+gzip",
  digest: SHA-256 digest,
  size_bytes: positive integer
}
```

Source order is authoritative. Normalized destinations are pairwise non-overlapping; `.` is allowed only as the sole destination. `working_directory` must resolve without symlink escape to a directory in the composed tree. Every source requires `access: read_only | writable`.

Git carries a canonical URL, requested ref, history, access mode, and destination. The runner resolves the ref once to an exact commit and reports it in provenance. OCI carries a canonical repository because the exact direct image-manifest descriptor has no location. Uploaded content uses the tenant-authorized `BundleReference`.

For Git, the gateway maps `(authenticated tenant, canonical URL)` to exactly one internal source policy and credential route. For OCI it maps `(authenticated tenant, canonical repository)` the same way. Bundle `artifact_id` is resolved through tenant-scoped artifact authorization. Zero or multiple matches reject before credential resolution, DNS, registry, Git, artifact reads, or mutable run admission. The caller never names a credential, internal route, mirror, token realm, or policy record.

V1 rejects all Git and OCI redirects. The exact internal OCI route pins its permitted bearer-token realm; OCI manifests and blobs must be fetched through that repository route, and foreign blob or descriptor URLs are rejected. Credentials are never forwarded to a target selected by remote content.

`runtime_profile_id`, agent model, `agent_network_policy_id`, and `post_run.network_policy_id` are independently authorized logical IDs. Admission resolves the runtime ID to an immutable `profile_digest` and persists that exact revision with its runtime image digest, fixed read-only runtime `PATH` and tool implementations, sandbox policy, and operator task-service implementations. Dispatch may resolve only the pinned revision and rejects unavailable or mismatched content. The caller cannot submit an image, executable path, service definition, raw network destination, policy body, credential, environment map, shell string, host path, grading rule, patch request, or workspace-persistence option.

`post_run` is required and is either `null` or the closed evidence specification. At least one of `commands` or `output_files` is nonempty. `bundle` is present if and only if a bundle executable is requested. Runtime executable names resolve through the profile's fixed read-only tool mapping, never an agent-modifiable `PATH`; bundle paths remain confined beneath the hidden immutable bundle. Arguments are literal. There is no shell, interpolation, globbing, working-directory override, caller environment, or per-command network override.

All ten limits are required and caller-lowerable beneath operator and runtime-profile ceilings. `max_agent_output_bytes` bounds the agent's structured final response. `max_artifact_bytes` is the aggregate logical-byte budget for result artifacts, excluding input bundles and source caches. Admission requires the sum of `output_files[].max_bytes` to fit this budget. Actual collected files charge first in request order, followed by promoted agent output, command stdout/stderr in command order, and trajectory; content deduplication gives no accounting discount. Optional promotion that cannot fit falls back to bounded inline truncated data or an explicit omitted observation, never unbounded storage.

## Public result boundary

`AgentRunResult v1` is defined by the normative closed schema `schemas/agent-run-result.v1.schema.json`. Its common logical shape is:

```text
{
  schema_version: "agent_run_result.v1",
  identity: {
    run_id: UUIDv7,
    idempotency_key: string
  },
  status: "completed" | "cancelled" | "infrastructure_error",
  post_run_mode: "none" | "requested",
  effective_limits: { the ten required request limit fields },
  workspace_provenance: DirectWorkspaceProvenance | null,
  runtime_provenance: RuntimeProvenance | null,
  agent: AgentResult | null,
  post_run: PostRunEvidence | null,
  usage: Usage,
  timing: Timing,
  trajectory: InlineTrajectory | ArtifactTrajectory | null,
  error: RunError | null
}

DirectWorkspaceProvenance = {
  kind: "direct",
  working_directory: relative path or ".",
  sources: ordered array of DirectSourceProvenance
}

RuntimeProvenance = {
  runtime_profile_id: logical ID,
  profile_digest: SHA-256 digest,
  image_digest: SHA-256 digest,
  sandbox_policy_version: string,
  tools: array of {
    name: logical ID,
    version: string,
    implementation_digest: SHA-256 digest
  },
  services: array of {
    name: logical ID,
    version: string,
    implementation_digest: SHA-256 digest,
    image_digest: SHA-256 digest | null
  }
}

AgentResult = {
  kind: "codex" | "omp",
  model: logical ID,
  adapter_version: string,
  termination: AgentTermination,
  exit_code: integer | null,
  final_output: CapturedText | null
}

CapturedText =
  | {
      storage: "inline",
      encoding: "utf-8",
      text: string,
      digest: SHA-256 digest,
      size_bytes: integer >= 0,
      truncated: boolean
    }
  | {
      storage: "artifact",
      encoding: "utf-8",
      artifact: ArtifactReference,
      truncated: boolean
    }

ArtifactReference = {
  artifact_id: UUIDv7,
  media_type: IANA media type,
  digest: SHA-256 digest,
  size_bytes: integer >= 0,
  expires_at: UTC RFC 3339 timestamp
}

PostRunEvidence = {
  commands: array in request order of PostRunCommandObservation,
  output_files: array in request order of OutputFileObservation
}
```

`completed`, `cancelled`, and `infrastructure_error` describe only gateway lifecycle. The gateway never returns behavioral pass, fail, or reward. `completed` requires nonnull workspace and runtime provenance, agent result with nonnull final output, and trajectory, requires `error: null`, and requires nonnull post-run evidence exactly when `post_run_mode` is `requested`. Cancelled and infrastructure-error results may carry partial or null provenance, agent, and trajectory fields and require a structured error. Runtime provenance records what actually ran without exposing policy bodies, host paths, credentials, private endpoints, or mutable runtime aliases.

Post-run evidence always preserves request order. Command observations are discriminated as `completed`, `timed_out`, `not_run`, or `unavailable`; output-file observations are `collected`, `missing`, `limit_exceeded`, `not_regular_file`, `not_run`, or `unavailable`. Each observation is sealed durably as it becomes terminal. For cancellation or infrastructure failure before the post-run skeleton is durable, `post_run` may be null. Once it is durable, `post_run` is nonnull and contains the full requested vectors: durable observations followed by explicit `not_run` or `unavailable` entries. Already durable evidence is never discarded or reordered.
A `completed` command observation records `command_id`, exit or signal termination, duration, and bounded stdout and stderr; `timed_out` records its signal, duration, and bounded streams. `not_run` and `unavailable` record a structured reason. Every output-file observation retains its requested name and uses its discriminant to distinguish a collected `ArtifactReference` from missing, over-limit, non-regular, not-run, and unavailable outcomes.


A nonzero command exit, configured command timeout, missing file, non-regular file, or requested-file limit breach is raw evidence in a completed run. It is not an infrastructure or behavioral failure. Referenced-bundle failure, approved-executable resolution or launch failure, sandbox failure, inability to persist promised evidence, or cleanup failure is `infrastructure_error`.

Direct provenance contains the ordered canonical Git, OCI, and uploaded-bundle identities, access modes, materializer versions, destinations, and resolved digests. `AgentRunResult v1` has no imported-task or alternate-backend provenance variant.

V1 does not return a generic workspace diff, reconstructed or modified workspace, checkpoint, patch, or change artifact. Post-run mutations are permitted only in sources declared `writable` or in separate writable build paths; they are discarded with the sandbox and are not agent output or a persisted caller artifact. Every direct run removes its mutable workspace and releases cache leases before terminal result visibility.

## Bundle and result-artifact API

Every bundle reservation, uploaded bundle, run, status, cancellation target, result artifact, and result is owned by one authenticated tenant. Lookups use `(authenticated tenant, object identity)` and cross-tenant access receives the same non-enumerating denial as an unknown object. UUIDs and digests are identities, never authorization.

`POST /v1/bundles` accepts the closed reservation `{schema_version: "bundle_reservation_request.v1", upload_id: UUIDv7, media_type: "application/vnd.allagents.gateway-bundle.v1.tar+gzip", digest: SHA-256 digest, size_bytes: positive integer}`. `(tenant, upload_id)` is idempotent: an exact retry returns the original immutable reservation, while reuse with different canonical content returns conflict. `PUT /v1/bundles/{artifact_id}` is tenant-authorized, accepts exactly the reserved byte count, verifies the streamed digest, and marks the bundle usable only after both checks pass.

`GET /v1/artifacts/{artifact_id}` is an authenticated, tenant- and run-authorized download of immutable result bytes. For an authorized live reference, `Content-Type`, `Content-Length`, and `Digest` match the `ArtifactReference`; after `expires_at` it returns `410 Gone`. Unknown, cross-tenant, wrong-run, and otherwise unauthorized identities use one non-enumerating denial. Artifact expiry and retention cover every artifact-backed agent output, command stream, requested file, and trajectory.

The Promptfoo provider dereferences every artifact it exposes to a grader through this endpoint, verifies those response headers, streams exactly `size_bytes`, computes the declared digest, and rejects expired, short, long, wrong-media-type, or mismatched content. Unverified artifact bytes never enter grading.

## Isolation and trust guarantees

An authorized `runtime_profile_id` resolves during admission to a persisted immutable `profile_digest`; the worker executes only that pinned revision and rejects digest mismatch or unavailability. The revision fixes the runtime image digest, read-only runtime `PATH`, sandbox policy, tool implementation closures, and task-service implementations. `RuntimeProvenance` reports the logical ID and profile digest, image and sandbox identities, each tool's implementation digest, and each service's implementation digest plus container image digest where applicable. These are canonical nonsecret identities: tool digests cover the executable and immutable dependency closure, service implementation digests cover the canonical launch implementation, and secret arguments and host paths are never returned.

Every direct execution uses the profile's `RunSandbox` security baseline: a non-root process under an unprivileged UID/GID mapping; an empty capability set with `no_new_privs`; private PID, mount, IPC, UTS, and network namespaces; a read-only runtime root; and only the declared workspace/build mounts writable. Host `/proc` and `/sys` surfaces, cgroup control files, device nodes, host sockets, container APIs, and control-plane mounts are masked or absent. A versioned explicit seccomp allowlist applies to agent and post-run processes. Cgroup v2 enforcement of PID count, memory, CPU, and I/O is mandatory in addition to wall-time, workspace, file-count, and output limits. A backend that cannot establish this baseline must reject the run rather than weaken isolation.

Each direct run receives a newly created sandbox and composed workspace. No mutable filesystem, process, home directory, or agent session is reused between runs. Concurrent runs may share only operator-owned immutable source generations; they never share writable workspace state, home state, process state, or post-run output.

The gateway caches each admitted source as an immutable materialized generation. A Git generation key binds the canonical source origin, resolved exact commit, requested history mode and depth, and materializer-schema version. An OCI generation key binds the canonical repository, exact direct descriptor, and materializer-schema version. An uploaded bundle generation key binds its artifact digest and materializer-schema version. Authorization, internal policy identity, and credential route are deliberately separate from the content key. Before every attachment, including every cache hit, the gateway remaps the authenticated caller and canonical origin or repository and rechecks authorization for the exact resolved identity; bundle hits recheck artifact authorization. A cache key proves identity, not authorization, and a cache hit never bypasses current policy.

Exact-key misses, fetches, and unpacks are singleflighted so concurrent runs do not refetch or rematerialize the same large source. Complete generations are immutable and operator-owned. A run holds an eviction lease from attachment through cleanup. Cache roots and unrelated generations are inaccessible to the agent; a generation is visible only through its declared trial mount.

A `read_only` source mounts the cached generation directly and read-only into every requesting trial. The filesystem rejects writes. Git operations that are valid against a read-only repository run with optional locks disabled; any Git operation requiring a lock or write fails rather than mutating shared state. A `writable` source receives a private reflink or other copy-on-write clone, with a full private copy as the correctness fallback. Hardlinks and any other shared writable alias to cached content are forbidden.

Agent and post-run commands see the same per-source access modes. A check that compiles in-tree, installs dependencies into a source, creates a database there, or otherwise writes beneath a source must mark it `writable`; alternatively it must direct build and test output to a separate writable path. Read-only fixtures and repositories remain read-only throughout both phases.

The gateway control plane remains outside worker, agent, and post-run command authority. Within a worker, the runner enforces process, time, CPU, memory, storage, output, and phase-specific network limits and can terminate the complete agent-owned descendant process tree. Gateway records, runner control files, result storage, and cleanup authority are inaccessible to the agent and evidence commands.

Source, registry, model, optional check-bundle, and artifact credentials are resolved from operator-controlled configuration. They are absent from caller JSON, workspace contents, logs, trajectories, and returned evidence. Source acquisition and model authentication occur through gateway- and runner-owned mechanisms that do not disclose credentials to workspace commands. A referenced check bundle is authorized before the run, but its bytes and populated mount are absent from the agent sandbox; only an empty, runner-owned, non-writable reserved mountpoint may exist. Evidence commands receive no acquisition or model credentials.

Network access is phase-specific, namespace-separated, brokered, and deny-by-default. Source acquisition follows the resolved internal source route. Agent execution runs in its own fresh network namespace under `agent_network_policy_id`; post-run evidence runs in a different fresh network namespace under `post_run.network_policy_id`. The default-drop rule covers external interfaces and loopback. A policy can expose only operator-declared broker endpoints for the phase, including individually named task-service endpoints; it cannot implicitly expose the worker host or another phase. The caller cannot submit hosts, ports, CIDRs, headers, proxies, service definitions, credentials, or policy bodies.

The phase transition is ordered and fail-closed. The runner first terminates every agent-owned descendant, destroys the agent network namespace and all agent flows, removes model and source credentials from the runtime, environment, and runner-managed auth material, and verifies those steps. Only then may it materialize the authorized bundle into the reserved mountpoint read-only, expose it to post-run commands, and create the post-run network namespace with a newly resolved endpoint set. A task service may remain supervised across the transition, but it is unreachable unless the pinned runtime profile and active phase policy both authorize its broker endpoint. Namespace teardown, rather than a best-effort firewall rewrite, prevents an agent-opened loopback or sidecar connection from surviving.

The runner keeps the same pinned runtime and final workspace with declared source access modes alive across this transition. Runtime executables resolve only through the pinned tool mapping; bundle executables resolve only beneath the newly populated bundle root; arguments are literal and never interpreted by a shell. Commands may build in writable paths, write test artifacts, and exercise authorized task services, but cannot depend on arbitrary agent-owned background processes or mutate `read_only` sources. The runner records raw outcomes and only requested bounded paths. Referenced-bundle acquisition failure or runner failure is `infrastructure_error`; a command's own nonzero exit or timeout remains completed-run evidence.

Cleanup is mandatory, idempotent, and part of terminalization. After persisting available evidence, the worker stops every remaining evidence process and operator task service, unmounts every trial mount, deletes the private trial root, and releases every cache lease. The gateway does not expose a terminal result until all cleanup steps succeed. If any cleanup step initially fails, the run's eventual status is `infrastructure_error`, not `completed`; its available evidence is marked partial, and reconciliation finishes cleanup without rerunning the agent before the terminal error becomes visible.

## V1 execution scope

V1 supports only direct execution. The AllAgents Gateway admits and tracks the run; a worker and runner own ordered workspace composition, sandboxing, Codex or OMP execution, the credential-stripping phase transition, optional post-run bundle injection, runtime or bundle evidence commands in the same pinned environment, raw result construction, cleanup, and terminalization.

Harbor and Terminal-Bench imports are deferred entirely beyond V1. Any future adapter requires a separate ADR and a new request/result schema version that defines its ownership, provenance, isolation, and evidence semantics. V1 makes no Harbor source, backend, provenance, or result-mapping promise.

## Idempotency, retries, and cancellation

`run_id` identifies the logical run and `idempotency_key` protects submission. After authentication, closed-schema validation, and canonical request hashing—but before mutable source admission, capacity allocation, artifact consumption, or creation of a public run—the gateway looks up both identities under the authenticated tenant.

- An exact tenant-scoped duplicate returns the same run handle or terminal result without re-running current admission or starting new work, including after client timeout, policy change, or worker restart.
- Reusing either identity for a different canonical request is a conflict and starts nothing.
- A genuinely new request first acquires an internal tenant-scoped identity claim so concurrent duplicates converge. The gateway then performs every policy, bundle, source, limit, runtime-profile, and capacity admission check. A rejected new request releases that claim and leaves no public run or job record.
- Only successful admission atomically commits the immutable canonical request and public run before dispatch. Recovery can finish dispatch from that record but cannot admit or start a second agent.
- Promptfoo repetitions use distinct identities even when every evaluation input is otherwise identical.

Transport retries and result polling are safe because they do not rerun the agent. The gateway may reconcile or resume its durable orchestration around a running request, but no worker or runner automatically starts the agent a second time after an attempt has begun. An infrastructure failure is terminal for that run. An intentional rerun requires a new run identity and therefore a fresh workspace; the caller, not the gateway, decides whether to schedule it.

Cancellation is an idempotent request against `run_id`. Before execution it prevents agent start; during execution it terminates the full descendant process tree; during post-run collection it terminates evidence commands. Once cancellation wins the terminal-state race, the worker preserves bounded partial evidence and performs the same process/service stop, unmount, private-root deletion, and cache-lease release. `cancelled` becomes visible only after cleanup succeeds; any cleanup failure changes the eventual status to `infrastructure_error` after reconciliation finishes cleanup. If a terminal result was published first, later cancellation returns that unchanged result. Cancellation never preserves a workspace for continuation.

Failures in admission, materialization, sandbox control, agent launch or supervision, referenced check-bundle acquisition, evidence-command supervision, artifact storage, cleanup, and result commitment use stable structured error codes. A `retryable` flag tells the caller whether a new run might succeed; it never authorizes the gateway or worker to silently rerun the agent. Cleanup failure produces `infrastructure_error` with partial evidence after reconciliation completes cleanup. The gateway never converts infrastructure failure or command evidence into pass, fail, or reward.

## Rejected alternatives

### UHP through HarnessRouter

UHP and HarnessRouter are designed around reusable harness sessions: response and session identity, continuation, checkpoint and hydrate, produced-file collection, and session deletion. The AllAgents Gateway is similar in purpose but V1 needs one isolated run, captured agent output, and optional raw post-run evidence. Adopting the session protocol would force the gateway to define which state survives, how continuation interacts with caller retries, and how checkpoints and produced files become run results even though none are required.

A HarnessRouter fork would also make AllAgents carry upstream integration seams and release work for workspace initialization, journaling, and terminal finalization. The former issue #304 proposal pursued those seams for the superseded snapshot design. Borrowing its sound protocol habits is useful; retaining its execution architecture is not.

We therefore reject UHP conformance, a HarnessRouter distribution or fork, checkpoints, continuation, and reusable coding sessions for this system.

### Two repositories and published workspace snapshots

Separating workspace construction into a builder repository and passing published OCI snapshots into a session gateway optimized an imagined reuse boundary. In a one-shot run, the worker already owns acquisition, isolated materialization, execution, optional evidence collection, and destruction as one lifecycle. Splitting that lifecycle adds artifact publication, leases, cross-repository versioning, cache authorization, and recovery states without improving the run result.

OCI remains a valid immutable workspace input, not the mandatory handoff between two AllAgents systems. One repository keeps the provider, public contract, lifecycle, and agent adapters versioned and tested together.

### Generic workspace diffs as product output

A generic diff says which bytes changed, not what the agent reported or what checks observed. It is ambiguous around generated files, ignored files, nested repositories, modes, links, and task-specific equivalence; it can also expose unnecessary source content. Making diffs authoritative would require baseline retention and reconstruction machinery that a one-shot result does not need.

For Promptfoo, code or LLM graders consume agent output, raw command results, and requested file artifacts and emit the task-specific outcome and reward outside the gateway. Other callers consume the same uninterpreted evidence. No caller receives modified workspace state in V1. Any future patch or workspace export requires a separately approved, explicit artifact contract rather than an extension of the core result by convention.

## Consequences

Positive consequences:

- the architecture supports a general one-shot coding-agent gateway while matching Promptfoo's unit of work: one independently graded run;
- a reader can locate authoring and grading in Promptfoo, public lifecycle in the gateway, and execution and raw evidence collection in a worker and runner;
- every run starts clean and cannot inherit a prior coding session;
- concurrent runs can reuse large immutable Git, OCI, and bundle generations without sharing mutable trial state or refetching exact sources;
- idempotent network retries cannot duplicate agent work;
- gateway lifecycle remains separate from caller-owned behavioral grading;
- credentials and operator policy stay on the operator side of a small closed boundary;
- Codex and OMP share isolation, output, evidence, and lifecycle semantics without pretending their CLIs are identical.

Costs and constraints:

- workers and the runner must implement strong sandbox, process-tree, credential, network, artifact, and cleanup controls rather than inheriting them from a session service;
- there is deliberately no interactive continuation, modified-workspace export, or post-run workspace recovery;
- local inputs and check bundles incur a packaging and upload step before remote execution;
- immutable source generations require bounded cache storage, eviction leases, singleflight recovery, authorization on every attachment, and materializer-schema migrations;
- callers must choose source access deliberately; agents and checks that write in-tree require `writable`, while `read_only` sources require a separate writable build path;
- check bundles and evidence commands are security-sensitive executable inputs and require authorization, immutability, isolation, and resource bounds;
- closed contracts require explicit versioning when new workspace, agent, post-run evidence, or artifact capabilities are introduced; and
- debugging and grading rely on bounded agent output, trajectory, command results, and file artifacts because the mutable workspace is destroyed.

We will reconsider this decision if the product requires reusable interactive coding sessions rather than one-shot runs, or if direct execution can no longer provide the required isolation guarantees. A need for more Promptfoo matrices, grader types, benchmark adapters, or raw evidence does not by itself justify UHP sessions, HarnessRouter, snapshot publication, gateway-owned grading, or generic workspace diffs.
