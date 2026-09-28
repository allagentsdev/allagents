# ADR 0002: Use Promptfoo native agent providers with managed disposable workspaces

- Status: Accepted
- Date: 2026-09-21
- Updated: 2026-09-28

## Decision

Coding-agent evaluations will run directly through Promptfoo's built-in agent
providers inside one disposable local or CI job. V1 will not introduce an
AllAgents execution gateway, a custom Promptfoo provider, or a separate runner
service.

Both supported providers receive the same fixed job-private working directory:

```yaml
working_dir: ./.eval/workspace
```

A Promptfoo lifecycle extension owns the mutable directory around every
evaluation row:

1. job bootstrap resolves and materializes exact source inputs into immutable,
   job-private seeds;
2. `beforeEach` removes any previous workspace and creates a private copy of the
   selected seed at `.eval/workspace`;
3. Promptfoo invokes the selected built-in agent provider in that directory;
4. deterministic JavaScript assertions inspect the final filesystem and run
   declared checks before teardown;
5. `afterEach` records bounded diagnostic metadata and removes the workspace;
6. `afterAll` removes remaining job-private evaluation state.

Setup fails closed in `beforeEach`: any reset or copy error throws before the
provider runs. Promptfoo currently catches and logs `afterEach` failures, so an
`afterEach` exception alone cannot fail the evaluation command. The extension
records a failure sentinel, and the surrounding job wrapper checks that sentinel
and workspace absence before accepting the run. `beforeEach` always deletes the
fixed workspace before copying a seed, even when the previous cleanup appeared
successful.

Promptfoo runs these rows serially and without its response cache:

```yaml
evaluateOptions:
  maxConcurrency: 1
  cache: false
```

Serial execution makes one fixed working directory unambiguous. Parallelism, if
needed later, is job-level: each disposable job receives its own `.eval` root.

Promptfoo remains the evaluation system of record. It owns prompts, provider and
model matrices, repetitions, assertions, scores, pass/fail decisions, traces,
and reports. The workspace extension owns only setup, reset, bounded diagnostic
collection, and cleanup.

## Why

Promptfoo already implements the agent-facing behavior the earlier gateway
design planned to recreate:

- the built-in Claude Agent SDK and Codex SDK providers both accept
  `working_dir`, resolved relative to the configuration file;
- Promptfoo documents extension hooks for `beforeAll`, `beforeEach`,
  `afterEach`, and `afterAll`;
- Promptfoo's own write-capable Claude example combines an extension-managed
  workspace with `maxConcurrency: 1`;
- external JavaScript assertions can inspect the final workspace and return
  structured grading results;
- built-in providers return final output, usage, provider metadata, and session
  identifiers where supported; and
- Promptfoo emits and ingests OpenTelemetry traces and projects recognized tool
  spans into `trajectory:*` assertions.

The proposed gateway added an HTTP API, custom provider, queue, database,
artifact service, source cache, worker state machine, custom agent adapters,
ATIF conversion, sandbox implementation, cancellation protocol, and recovery
semantics. None of those components is necessary for a trusted, single-tenant
evaluation that already runs inside a disposable job.

Supporting evidence and provider-specific limits are recorded in
[Promptfoo native agent workspaces](../research/promptfoo-native-agent-workspaces.md).
The implementation sequence is in the
[Promptfoo coding-agent evaluation plan](../plans/2026-09-18-0837-feat-promptfoo-coding-agent-evals-plan.md).

## Execution boundary

The disposable job is the outer lifecycle and isolation boundary. It may be a
CI job, rootless container, or VM. The job:

- starts without mutable state from another evaluation job;
- receives only the source and model credentials required for that job;
- materializes exact source revisions before starting Promptfoo;
- runs Promptfoo and all assertions;
- exports the requested Promptfoo results, traces, and bounded diagnostics; and
- destroys the complete job filesystem and process tree when finished.

Promptfoo provider sandboxes constrain agent operations but are not a substitute
for a hostile multi-tenant execution boundary. Write-capable or adversarial
evaluations must run in a disposable container or VM rather than directly on a
developer workstation.

Source acquisition occurs before agent execution. Acquisition credentials must
not be copied into `.eval/seeds`, `.eval/workspace`, result metadata, or trace
attributes. Job bootstrap removes them from the environment before Promptfoo
starts whenever the source transport permits that separation.

## Promptfoo configuration

The initial provider matrix uses Promptfoo's providers directly:

```yaml
providers:
  - id: anthropic:claude-agent-sdk
    config:
      working_dir: ./.eval/workspace
      append_allowed_tools: [Write, Edit, MultiEdit, Bash]
      permission_mode: acceptEdits
      persist_session: false
      sandbox:
        enabled: true
        failIfUnavailable: true

  - id: openai:codex-sdk
    config:
      working_dir: ./.eval/workspace
      sandbox_mode: workspace-write
      approval_policy: never
      enable_streaming: true
      persist_threads: false

extensions:
  - file://extensions/workspace.cjs:workspaceLifecycle

evaluateOptions:
  maxConcurrency: 1
  cache: false

tracing:
  enabled: true
  otlp:
    http: {}
```

Provider-specific permissions remain explicit. A common working directory does
not imply identical tool or sandbox behavior.

Codex `enable_streaming` is enabled because Promptfoo uses its SDK events to
emit provider-level command, file, search, MCP, and turn spans. Deep native
tracing is optional, not the default: it can expose additional payloads and, for
Codex, disables thread persistence.

## Workspace contract

`.eval/seeds` contains resolved inputs for the current job, published through a
read-only mount or owned by a bootstrap identity that the unprivileged
Promptfoo/agent user cannot modify. `.eval/workspace` is always disposable and
writable. `.eval/artifacts` may contain explicitly selected bounded diagnostics.

The source manifest records the requested identity and resolved immutable
identity for each seed. A mutable Git ref may be an input to resolution but is
never the recorded resolved identity. OCI input, if used, records the verified
manifest digest.

The workspace copy must not use hardlinks or any writable alias back to a seed.
A reflink or another copy-on-write primitive is acceptable only when later
writes cannot mutate the seed. A full recursive copy is the portable fallback.

Every row starts from the same selected seed state. Workspace mutations,
installed dependencies, generated files, and provider session state must not
cross row boundaries. Cross-row provider thread persistence is disabled in V1.
Agent-started background services are unsupported because the extension cannot
guarantee process-tree cleanup between rows; disposable job teardown is the
process cleanup boundary.

## Assertions and evidence

Behavioral success is decided by Promptfoo assertions, not lifecycle hooks.
Rows that inspect the live workspace use deterministic assertions only.
Promptfoo may defer a row's complete assertion set when model-graded assertions
are present; a later `beforeEach` could then replace the shared workspace before
the earlier filesystem assertion executes.

For a deterministic-only row, the filesystem assertion runs after the provider
returns and before `afterEach` removes the workspace. It may:

- verify required files and contents;
- execute bounded commands without shell interpolation;
- check exit status, timeout, and selected output;
- inspect Promptfoo provider metadata; and
- inspect OpenTelemetry trace data or use built-in `trajectory:*` assertions.

If model grading is required, the deterministic phase first serializes all
needed facts to a unique row artifact and a separate evaluation grades that
immutable evidence. It must not read the shared live workspace later.

`afterEach` may add diagnostic metadata or named scores that Promptfoo permits
hooks to mutate, but it cannot override `success`, `score`, or
`response.output`. It therefore must not contain the authoritative grader.

V1 stores Promptfoo's native result and OpenTelemetry trace exports. It does not
convert provider events to ATIF. Promptfoo's normalized trajectory view is
sufficient for tool-use, argument, sequence, step-count, and goal assertions.
An ATIF adapter may be added later at an explicit interoperability boundary; it
must not fabricate reasoning, messages, or tool results absent from provider
telemetry.

Hidden checks are not promised by this design. Keeping a verifier outside
`working_dir` does not prove that a shell-capable agent in the same job cannot
read it. A requirement for secret verifier bytes needs a separate isolation
decision.

## Scope

V1 includes:

- direct Promptfoo execution through its Claude Agent SDK and Codex SDK
  providers;
- one fixed extension-managed workspace;
- serial, uncached evaluation rows;
- exact source staging and private per-row copies;
- deterministic filesystem and command assertions;
- Promptfoo-native output, metadata, usage, and OpenTelemetry traces; and
- disposable job-level cleanup.

V1 excludes:

- a network execution API or shared remote service;
- a custom Promptfoo provider;
- a durable run database, queue, or artifact service;
- shared mutable workspaces or cross-row provider sessions;
- gateway-owned agent adapters or grading;
- ATIF normalization;
- hostile multi-tenant isolation;
- secret post-run verifier injection; and
- resumable runs, checkpoints, or workspace recovery.

## Consequences

Benefits:

- the implementation is a small Promptfoo configuration, lifecycle extension,
  source-staging helper, and deterministic assertion module;
- Claude and Codex provider behavior stays aligned with Promptfoo releases;
- Promptfoo's result, trace, assertion, repetition, and report machinery remains
  authoritative;
- source seeds can be reused within a job without sharing mutable workspaces;
- the fixed working directory keeps provider configuration static; and
- deleting the gateway removes a second protocol and telemetry model.

Costs and limits:

- V1 is a trusted single-tenant job design, not a hosted execution service;
- rows run serially inside a job;
- live-workspace assertions cannot be mixed with deferred model grading;
- provider tool, transcript, and trace coverage differs;
- `afterEach` failures need a wrapper-visible sentinel because Promptfoo logs
  them rather than converting a passing row to an error;
- a process crash can bypass extension cleanup, so disposable job teardown is
  required;
- Promptfoo's trace is observability data, not a lossless replayable transcript;
  and
- strong credential brokering, hidden verifiers, and tenant isolation remain
  unsolved because they are outside the selected scope.

## Reconsider when

Introduce a separate execution service only when a concrete requirement needs
one of the boundaries the native design does not provide: mutually untrusted
tenants, remote API callers, centrally enforced network policy, source/model
credential brokering, secret verifier injection, durable cancellation and
recovery, retention beyond the disposable job, or shared scheduling across
machines.

Need for more providers, matrices, repetitions, deterministic assertions,
workspace copies, or Promptfoo trajectory checks does not by itself justify a
gateway.
