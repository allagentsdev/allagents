# Promptfoo-native coding-agent workspaces

## Conclusion

For a **trusted, single-host local or CI evaluation**, Promptfoo's built-in Claude
Agent SDK or OpenAI Codex SDK provider can replace the proposed execution gateway's
basic evaluation loop:

1. a Promptfoo `beforeEach` extension deletes and re-copies a fixture into the fixed
   `./.eval/workspace` path;
2. `evaluateOptions.maxConcurrency: 1` prevents two cases from sharing that path;
3. the provider receives `config.working_dir: ./.eval/workspace` and runs one agent;
4. a deterministic `javascript` assertion reads the final filesystem;
5. `afterEach` records bounded observations if needed and removes the workspace; and
6. `afterAll` retries cleanup of remaining job-private state.

That is enough when the source fixture is already local, the CI runner is the
security boundary, the checks are trusted, and raw Promptfoo results plus
OpenTelemetry traces are sufficient. It is composition, not a built-in disposable
workspace feature: the reset/materialization and filesystem verifier are glue code.
Promptfoo explicitly recommends serial execution, extension hooks, wrapper scripts,
Git, or containers for side-effecting Claude runs, and its official advanced example
uses `maxConcurrency: 1` plus an extension reset
([side-effect guidance](https://www.promptfoo.dev/docs/providers/claude-agent-sdk/#managing-side-effects),
[pinned example config](https://github.com/promptfoo/promptfoo/blob/712a506de6412ca6879fe8dba1319569ea820cbf/examples/claude-agent-sdk/advanced/promptfooconfig.yaml#L8-L29),
[pinned reset hook](https://github.com/promptfoo/promptfoo/blob/712a506de6412ca6879fe8dba1319569ea820cbf/examples/claude-agent-sdk/advanced/hooks.js#L58-L101)).

It does **not** replace the gateway's stronger contracts: authenticated and
provenance-preserving Git/OCI/bundle composition, isolation from an untrusted agent,
phase-separated credentials and networking, resource/process-tree enforcement,
hidden post-run checks, bounded and durable evidence, normalized ATIF trajectories,
idempotency/cancellation, or an OMP adapter. Those requirements can justify an
external runner even when there is no remote multi-tenant service.

## Evidence labels and source snapshot

- **Documented** means Promptfoo's public documentation promises the behavior.
- **Source-observed** means the current implementation does it, but the public docs do
  not define it as a stable contract.
- **Proposed glue** means code this evaluation repository must own; it is not supplied
  by Promptfoo or either agent SDK provider.

Source was inspected at Promptfoo commit
[`712a506de6412ca6879fe8dba1319569ea820cbf`](https://github.com/promptfoo/promptfoo/tree/712a506de6412ca6879fe8dba1319569ea820cbf).
All source links below are pinned to that revision. Public documentation links are
unversioned and describe the current docs as inspected on 2026-09-28.

## Direct answer: can the fixed-workspace loop work?

Yes, with the following boundaries.

| Step | Status | Exact behavior and boundary |
|---|---|---|
| Serialize cases | **Documented** | `evaluateOptions.maxConcurrency: 1` sets the maximum concurrent requests to one; the CLI equivalent is `--max-concurrency 1`. `tests[].options.runSerially: true` is also supported, but global concurrency one is simpler when every case shares one path ([configuration reference](https://www.promptfoo.dev/docs/configuration/reference/#config), [test-case reference](https://www.promptfoo.dev/docs/configuration/reference/#test-case)). |
| Reset before a case | **Documented hook, proposed reset** | Root `extensions` supports `beforeEach`, whose context is `{ test }`, before each individual evaluation. Promptfoo provides the callback point, not copy/clone/reset logic ([extension hooks](https://www.promptfoo.dev/docs/configuration/reference/#extension-hooks)). |
| Point the agent at the path | **Documented** | Both providers accept `config.working_dir`; relative values resolve from the config file's directory ([Claude working directory](https://www.promptfoo.dev/docs/providers/claude-agent-sdk/#with-working-directory), [Codex working directory](https://www.promptfoo.dev/docs/providers/openai-codex-sdk/#with-working-directory)). The shared resolver in source confirms config-relative resolution ([`resolveAgenticWorkingDir`](https://github.com/promptfoo/promptfoo/blob/712a506de6412ca6879fe8dba1319569ea820cbf/src/providers/agentic-utils.ts#L74-L90)). |
| Run a write-capable agent | **Documented** | Codex uses `sandbox_mode: workspace-write` by default. Claude requires explicit write/edit tools and a permission mode such as `acceptEdits`; a configured directory is read-only by default ([Codex sandbox modes](https://www.promptfoo.dev/docs/providers/openai-codex-sdk/#sandbox-modes), [Claude tools and permissions](https://www.promptfoo.dev/docs/providers/claude-agent-sdk/#tools-and-permissions)). |
| Inspect the final filesystem | **Documented assertion API; source-observed ordering** | An external `javascript` assertion is trusted Node code and receives `output` plus `context`, so it can read files or invoke a fixed verifier ([JavaScript assertions](https://www.promptfoo.dev/docs/configuration/expected-outputs/javascript/#external-script)). Current source invokes `beforeEach`, then `runEvalInternal`, and only afterward invokes `afterEach` and persists the row ([provider/evaluation order](https://github.com/promptfoo/promptfoo/blob/712a506de6412ca6879fe8dba1319569ea820cbf/src/evaluator.ts#L3567-L3593), [post-row hook order](https://github.com/promptfoo/promptfoo/blob/712a506de6412ca6879fe8dba1319569ea820cbf/src/evaluator.ts#L3595-L3653)). Thus a normal deterministic assertion sees the provider's final filesystem. |
| Reset for the next case | **Proposed glue** | `afterEach` may archive bounded evidence and then remove the workspace; the next `beforeEach` removes it again before copying the seed. Cleanup failures are only logged by the current evaluator and do not automatically turn a passing row into an error ([caught `afterEach` failure](https://github.com/promptfoo/promptfoo/blob/712a506de6412ca6879fe8dba1319569ea820cbf/src/evaluator.ts#L3614-L3650)). Therefore `beforeEach` must throw on a failed reset, `afterAll` must retry cleanup, and the outer job should verify teardown when cleanup is a correctness requirement. |
| Prevent a cache hit from skipping the run | **Documented and source-observed** | Set `evaluateOptions.cache: false` or use `--no-cache`. This disables the scoped cache used by agentic providers; the Claude provider otherwise fingerprints the working directory and can return a prior response ([caching configuration](https://www.promptfoo.dev/docs/configuration/caching/), [evaluation cache scope](https://github.com/promptfoo/promptfoo/blob/712a506de6412ca6879fe8dba1319569ea820cbf/src/evaluate.ts#L361-L364), [agentic cache initialization](https://github.com/promptfoo/promptfoo/blob/712a506de6412ca6879fe8dba1319569ea820cbf/src/providers/agentic-utils.ts#L203-L273)). A cached response cannot recreate cached filesystem mutations. |

### Important grading-order caveat

The fixed shared path is safe for the deterministic filesystem assertion shown below.
Do not assume it remains safe if the same test also contains a model-graded assertion.
At concurrency one, the current evaluator can group model-graded assertions by provider:
it performs several target calls and defers each row's complete assertion set before
flushing grading ([grouping predicate](https://github.com/promptfoo/promptfoo/blob/712a506de6412ca6879fe8dba1319569ea820cbf/src/evaluator.ts#L519-L537),
[grouped execution](https://github.com/promptfoo/promptfoo/blob/712a506de6412ca6879fe8dba1319569ea820cbf/src/evaluator.ts#L3912-L4007),
[deferred assertion call](https://github.com/promptfoo/promptfoo/blob/712a506de6412ca6879fe8dba1319569ea820cbf/src/evaluator.ts#L1449-L1469)).
A later `beforeEach` can therefore replace the workspace before the earlier row's
filesystem assertion executes.

Use one of these clean boundaries:

- keep filesystem-observing rows deterministic-only;
- have the deterministic assertion capture all needed facts and grade later from those
  persisted facts in a separate evaluation; or
- use a wrapper/custom provider that returns a per-run evidence snapshot with the agent
  response.

A nonzero `evaluateOptions.timeoutMs` currently disables grouped grading, but that is
an implementation detail rather than a documented workspace-lifecycle guarantee; it
should not be the foundation of evidence correctness
([grouping condition](https://github.com/promptfoo/promptfoo/blob/712a506de6412ca6879fe8dba1319569ea820cbf/src/evaluator.ts#L4939-L4960)).

## Minimal verified composition

The following shape is verified against the configuration reference, both provider
implementations, and Promptfoo's official Claude reset example at the pinned revision.
It intentionally uses one prompt, one provider, deterministic-only assertions, global
serialization, and disabled response caching.

Expected repository layout:

```text
promptfooconfig.yaml
fixtures/base/                 # immutable or otherwise protected seed
.eval/workspace/               # disposable; ignored by version control
promptfoo/workspace-hooks.cjs
promptfoo/assert-workspace.cjs
```

### `promptfooconfig.yaml`

```yaml
# yaml-language-server: $schema=https://promptfoo.dev/config-schema.json

description: Native fixed-workspace coding-agent evaluation

prompts:
  - |
    Implement the requested change. Write the exact value "{{ expected }}" to result.txt.

providers:
  - id: openai:codex-sdk
    config:
      working_dir: ./.eval/workspace
      skip_git_repo_check: true # remove when fixtures contain a Git repository
      sandbox_mode: workspace-write
      approval_policy: never
      network_access_enabled: false
      web_search_mode: disabled
      enable_streaming: true
      persist_threads: false

extensions:
  - file://./promptfoo/workspace-hooks.cjs:extensionHook

evaluateOptions:
  maxConcurrency: 1
  cache: false

tracing:
  enabled: true
  otlp:
    http: {}

outputPath: ./.eval/results.json

tests:
  - description: writes the requested result
    vars:
      expected: READY
    assert:
      - type: javascript
        value: file://./promptfoo/assert-workspace.cjs
```

`skip_git_repo_check: true` is necessary only for a non-Git fixture; Codex otherwise
requires the working directory or a parent to be a Git repository. `approval_policy:
never` is the documented unattended-CI recommendation, and network, search, and full
process-environment inheritance are separate settings from the filesystem sandbox
([Codex parameters and caveats](https://www.promptfoo.dev/docs/providers/openai-codex-sdk/#supported-parameters),
[Codex sandbox modes](https://www.promptfoo.dev/docs/providers/openai-codex-sdk/#sandbox-modes)).

For Claude, replace only the provider block:

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
```

Claude's `sandbox.enabled` is not implied by `working_dir` or `permission_mode`.
`failIfUnavailable` defaults to true when the sandbox is enabled, but spelling it out
makes the CI requirement visible. Network domains, local binding, Unix sockets, and
credential masking have their own `sandbox.network.*` and
`sandbox.credentials.envVars` keys
([Claude sandbox configuration](https://www.promptfoo.dev/docs/providers/claude-agent-sdk/#sandbox-configuration)).

`deep_tracing` is intentionally omitted from the baseline. Root tracing plus Claude's
provider spans, or Codex `enable_streaming`, supplies the normal evaluation trajectory
with less payload exposure. Opt into deep tracing only when SDK/CLI-internal spans are
required: Codex deep tracing disables `persist_threads`, `thread_id`, and
`thread_pool_size`, and native CLI spans can contain payloads outside Promptfoo's
stream-event sanitizer
([Codex deep tracing](https://www.promptfoo.dev/docs/providers/openai-codex-sdk/#deep-tracing)).

### `promptfoo/workspace-hooks.cjs` — proposed glue

```js
const fs = require('node:fs/promises');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const seed = path.join(root, 'fixtures', 'base');
const workspace = path.join(root, '.eval', 'workspace');

async function materializeFreshWorkspace() {
  await fs.rm(workspace, { recursive: true, force: true });
  await fs.mkdir(path.dirname(workspace), { recursive: true });
  await fs.cp(seed, workspace, { recursive: true, errorOnExist: true });
}

module.exports = async function extensionHook(hookName, context) {
  if (hookName === 'beforeEach') {
    // Do not catch this error: a failed reset must prevent the agent call.
    await materializeFreshWorkspace();
  } else if (hookName === 'afterEach' || hookName === 'afterAll') {
    // Assertions have completed before afterEach on the normal deterministic path.
    await fs.rm(workspace, { recursive: true, force: true });
  }
  return context;
};
```

This materializes a local directory tree; it does not resolve a Git ref, pull OCI
content, validate a bundle digest, enforce read-only subtrees, or record provenance.
A CI checkout step or wrapper must prepare `fixtures/base`. The seed must not be
agent-writable. If checks need the final tree after the entire evaluation, copy selected
evidence to a case-specific artifact directory in `afterEach` before deleting the
workspace.

### `promptfoo/assert-workspace.cjs` — proposed deterministic grader

```js
const fs = require('node:fs/promises');
const path = require('node:path');

const workspace = path.resolve(__dirname, '..', '.eval', 'workspace');

module.exports = async function assertWorkspace(_output, context) {
  try {
    const actual = await fs.readFile(path.join(workspace, 'result.txt'), 'utf8');
    const expected = String(context.vars.expected);
    const pass = actual.trim() === expected;
    return {
      pass,
      score: pass ? 1 : 0,
      reason: pass
        ? 'result.txt has the expected content'
        : `result.txt was ${JSON.stringify(actual.trim())}`,
    };
  } catch (error) {
    return { pass: false, score: 0, reason: `result.txt unavailable: ${error.message}` };
  }
};
```

For executable checks, this module can use `execFile`/`spawn` with a fixed executable
and literal argument array. That remains trusted assertion code running as the
Promptfoo process. It is not the gateway's separately sandboxed, credential-stripped,
structured `post_run` phase.

## Lifecycle hooks: exact names and timing

Two unrelated hook systems must not be conflated.

### Promptfoo evaluation extensions

Root `extensions` accepts JavaScript or Python functions. The exact lifecycle names
are `beforeAll`, `beforeEach`, `afterEach`, and `afterAll`
([configuration reference](https://www.promptfoo.dev/docs/configuration/reference/#available-hooks)).

| Hook | Documented context | Relevant timing | Mutation contract |
|---|---|---|---|
| `beforeAll` | `{ suite }` | Once before the evaluation | May return selected mutated suite fields. |
| `beforeEach` | `{ test }` | Before one expanded evaluation step invokes the provider | Returning `{ test }` replaces the test context; a thrown reset error propagates. Current source calls it immediately before `runEvalInternal` ([source](https://github.com/promptfoo/promptfoo/blob/712a506de6412ca6879fe8dba1319569ea820cbf/src/evaluator.ts#L3567-L3593)). |
| `afterEach` | `{ test, result }` | After the row is graded, before persistence in the normal non-deferred path | Only `result.namedScores`, `result.metadata`, and `result.response.metadata` are persisted; it cannot override `success`, `score`, or `response.output` ([mutation reference](https://www.promptfoo.dev/docs/configuration/reference/#aftereach)). |
| `afterAll` | `{ results, prompts, suite, evalId, config }` | Once after all rows | Side effects only; its return value is not persisted. |

A path naming a custom function, such as
`file://./workspace-hooks.cjs:extensionHook`, receives every event as
`(hookName, context)`. A path whose function name is exactly one lifecycle name runs
only for that event and is called as `(context, { hookName })`
([implementation rules](https://github.com/promptfoo/promptfoo/blob/712a506de6412ca6879fe8dba1319569ea820cbf/src/evaluatorHelpers.ts#L774-L816)).
Returned mutable fields are shallow-merged, not deep-merged
([extension mutation docs](https://www.promptfoo.dev/docs/configuration/reference/#extension-hooks)).

`beforeEach` is invoked for each expanded `RunEvalOptions`, not merely once for the
original YAML object (**source-observed**). With multiple prompts, providers, or
repeats, the same logical YAML test can therefore be reset several times. The scheduler
runs `options.runSerially` steps first and other steps through a concurrency-limited
loop; global concurrency one makes both phases single-file
([scheduler source](https://github.com/promptfoo/promptfoo/blob/712a506de6412ca6879fe8dba1319569ea820cbf/src/evaluator.ts#L4048-L4111),
[matrix partition](https://github.com/promptfoo/promptfoo/blob/712a506de6412ca6879fe8dba1319569ea820cbf/src/evaluator.ts#L4924-L4951)).

### Claude Agent SDK provider hooks

`providers[].config.hooks` is a different, SDK-native interception system for events
such as `PreToolUse` and `PostToolUse`. Promptfoo preserves SDK input/return shapes;
these callbacks are programmatic-only and must be defined in a JS/TS provider file,
not expressed as YAML functions. For example, `PostToolUse` can return
`updatedToolOutput` before the model sees a tool result
([Claude provider hooks](https://www.promptfoo.dev/docs/providers/claude-agent-sdk/#hooks)).
These hooks are useful inside a run, but they do not reset the shared workspace between
Promptfoo cases.

## Provider comparison

| Capability | Claude Agent SDK (`anthropic:claude-agent-sdk`) | OpenAI Codex SDK (`openai:codex-sdk`) |
|---|---|---|
| Working directory | `working_dir`; omitted means a provider-created temporary directory that is removed after the call. An explicit directory persists and is read-only by default ([docs](https://www.promptfoo.dev/docs/providers/claude-agent-sdk/#quick-start), [cleanup source](https://github.com/promptfoo/promptfoo/blob/712a506de6412ca6879fe8dba1319569ea820cbf/src/providers/claude-agent-sdk.ts#L1801-L1824)). | `working_dir`; omitted means the current directory. It must be in a Git repo unless `skip_git_repo_check: true` ([docs](https://www.promptfoo.dev/docs/providers/openai-codex-sdk/#quick-start)). |
| Write enablement | Add `Write`, `Edit`, `MultiEdit`, and optionally `Bash` via `append_allowed_tools`/`custom_allowed_tools`/`tools`; set `permission_mode`. | `sandbox_mode: workspace-write` is default; set `approval_policy: never` for unattended evaluation. |
| Filesystem isolation | Claude SDK `sandbox.enabled`; `failIfUnavailable`, network/socket policy, exclusions, and credential masking are explicit. | `sandbox_mode` controls filesystem access only; network/search, environment inheritance, and approvals are separate. |
| Extra paths | `additional_directories` | `additional_directories` |
| Fresh session default | Auto-generated SDK session; `persist_session` defaults true on disk, while `continue`/`resume` are opt-in. A new Promptfoo call is not by itself a fresh filesystem. | New ephemeral thread for each case by default. `persist_threads`, `thread_id`, and `thread_pool_size` opt into reuse; `deep_tracing` ignores all three and makes a fresh SDK client/thread ([thread docs](https://www.promptfoo.dev/docs/providers/openai-codex-sdk/#thread-management), [deep-trace caveat](https://www.promptfoo.dev/docs/providers/openai-codex-sdk/#deep-tracing)). |
| Provider response metadata | `metadata.toolCalls`, `skillCalls`, `numTurns`, `durationMs`, `durationApiMs`, `modelUsage`, permission denials, terminal reason, structured output, and surfaced assistant errors when present ([response construction](https://github.com/promptfoo/promptfoo/blob/712a506de6412ca6879fe8dba1319569ea820cbf/src/providers/claude-agent-sdk.ts#L2267-L2339)). | General Codex items are not copied into stable `metadata`; current `metadata` is skill-detection data when present. `output` is final text, `sessionId` is the thread, token usage/cost are separate, and `raw` serializes the SDK turn ([response construction](https://github.com/promptfoo/promptfoo/blob/712a506de6412ca6879fe8dba1319569ea820cbf/src/providers/openai/codex-sdk.ts#L2419-L2449)). |
| Tool/trajectory visibility | Completed tool calls are available directly in `metadata.toolCalls`; provider tracing also emits tool and turn spans. | Set `enable_streaming: true` for command, file-change, MCP, search, reasoning, message, and turn spans; set `deep_tracing: true` for CLI-native spans. |
| Full transcript | No stable full-transcript result. `raw` is the terminal SDK result; `metadata.toolCalls` carries tool I/O. Subagent text/thinking is omitted by default and requires `forward_subagent_text: true`, with documented redaction behavior ([tool tracking](https://www.promptfoo.dev/docs/providers/claude-agent-sdk/#tool-call-tracking)). | No stable normalized transcript result. Final text is `output`; streaming-mode `raw` includes provider-specific `items`, sanitized `reasoningTexts`, and `conversationMessages`, while traces carry operation events ([stream-result source](https://github.com/promptfoo/promptfoo/blob/712a506de6412ca6879fe8dba1319569ea820cbf/src/providers/openai/codex-sdk.ts#L1544-L1561)). |

Neither provider materializes an application repository into an explicit directory.
Claude's automatic temporary directory is empty and deleted, and Codex defaults to the
current directory. An explicit `working_dir` means "operate here," not "make this path
fresh." The provider validates/accesses the directory after the evaluation extension
has prepared it
([Claude validation and `cwd`](https://github.com/promptfoo/promptfoo/blob/712a506de6412ca6879fe8dba1319569ea820cbf/src/providers/claude-agent-sdk.ts#L1801-L1844),
[Codex resolution and validation](https://github.com/promptfoo/promptfoo/blob/712a506de6412ca6879fe8dba1319569ea820cbf/src/providers/openai/codex-sdk.ts#L2222-L2273)).

## Deterministic filesystem grading and result metadata

A JavaScript assertion can return a boolean, number, or `{ pass, score, reason,
namedScores?, componentResults? }`; its `context` includes the prompt, vars, test,
provider, complete `providerResponse`, response metadata shortcut, and trace data when
enabled
([JavaScript assertion context](https://www.promptfoo.dev/docs/configuration/expected-outputs/javascript/#using-test-context)).
This supports deterministic checks of:

- exact file content, mode, or absence;
- a parsed manifest or compiler output;
- a fixed executable's exit code/stdout/stderr; and
- Claude's `context.providerResponse.metadata.toolCalls`.

Promptfoo can export complete evaluation data to JSON or one row per line to JSONL
([output formats](https://www.promptfoo.dev/docs/configuration/outputs/)). An
`afterEach` hook can add structured observations to `result.metadata`, add numeric
metrics to `result.namedScores`, or add provider-level details to
`result.response.metadata`; it cannot retroactively change the grade
([afterEach contract](https://www.promptfoo.dev/docs/configuration/reference/#aftereach)).

Limitations of this native pattern:

1. Assertions run with the Promptfoo process's authority, not a separate restricted
   checker identity.
2. There is no built-in hidden-check-bundle timing boundary. Keeping the assertion
   outside `working_dir` is not a guarantee that a shell-capable agent cannot read it.
3. There is no built-in structured post-run command/result schema, byte limit, file
   promotion, digest, or artifact retention contract.
4. A fixed workspace has only one live final state. A later `beforeEach` overwrites it;
   evidence that must survive must be copied or serialized per case.
5. `afterEach` cleanup is best-effort in the current evaluator because its exception
   is caught. The next `beforeEach` and final `afterAll` should retry and throw, and the
   surrounding job should independently verify cleanup when it is a release condition.
6. Provider and evaluation timeouts stop the call, but native composition does not
   establish the gateway's process-tree/cgroup cleanup guarantee for arbitrary daemons
   the agent launched.

## OpenTelemetry, trajectory assertions, and transcript limits

Root `tracing.enabled: true` creates a distinct trace per test-case execution and puts
`traceId` plus `evaluationId` on each result row. Promptfoo's built-in OTLP receiver is
configured under `tracing.otlp.http`; traces can be inspected in the UI, fetched through
`GET /api/traces/:traceId` or `GET /api/traces/evaluation/:evaluationId`, or exported as
JSON
([tracing overview](https://www.promptfoo.dev/docs/tracing/#built-in-provider-instrumentation),
[result-row linkage and API](https://www.promptfoo.dev/docs/tracing/#trace-linkage-on-result-rows),
[JSON export](https://www.promptfoo.dev/docs/tracing/#exporting-traces)).
JavaScript assertions receive trace spans as `context.trace`, and built-in
`trajectory:tool-used`, `trajectory:tool-args-match`, `trajectory:tool-sequence`,
`trajectory:step-count`, and `trajectory:goal-success` assertions consume normalized
span information
([traced-workflow assertions](https://www.promptfoo.dev/docs/tracing/#4-assert-on-traced-workflows)).

Provider differences matter:

- Claude emits an `invoke_agent` span, `gen_ai.turn N` spans, and a child span for each
  completed tool call. `deep_tracing: true` asks the SDK subprocess to export native
  model/tool/subagent spans to the receiver
  ([Claude tracing](https://www.promptfoo.dev/docs/providers/claude-agent-sdk/#tracing)).
- Codex needs `enable_streaming: true` for Promptfoo to turn SDK events into command,
  file-change, MCP, search, reasoning, message, and turn spans. `deep_tracing: true`
  additionally injects OTEL context into the Codex CLI
  ([Codex tracing](https://www.promptfoo.dev/docs/providers/openai-codex-sdk/#tracing-and-observability)).
- Codex streaming still returns only after the turn completes; it is event aggregation,
  not live partial-token delivery to assertions
  ([streaming behavior](https://www.promptfoo.dev/docs/providers/openai-codex-sdk/#streaming)).

These traces are useful trajectory evidence, but they are not the proposed gateway's
bounded, normalized ATIF v1 artifact. No ATIF exporter or stable cross-provider full
transcript contract was found in the inspected Promptfoo docs/source (**source-review
finding, not a documented guarantee of absence**). The supported export is Promptfoo's
OpenTelemetry-shaped trace JSON. Provider `raw` payloads remain SDK-specific, and
neither provider documents them as a complete, size-bounded transcript schema.

Treat trace redaction as defense in depth. Promptfoo warns that Codex CLI-native spans
created by `deep_tracing` are outside Promptfoo's stream-event sanitizer, and the OTLP
receiver's `redactAttributes` does not filter in-process built-in provider spans before
local storage
([Codex deep-trace warning](https://www.promptfoo.dev/docs/providers/openai-codex-sdk/#deep-tracing),
[trace redaction scope](https://www.promptfoo.dev/docs/tracing/#configuration-reference)).

## Native composition versus the proposed gateway

The accepted ADR now selects this native composition and explicitly rejects a gateway
for V1. It makes the disposable job the outer isolation/lifecycle boundary and assigns
exact source staging plus bounded diagnostics to job-owned glue
([native-execution decision](../decisions/0002-use-promptfoo-native-agent-execution.md#decision),
[evaluation plan contract](../plans/2026-09-18-0837-feat-promptfoo-coding-agent-evals-plan.md#product-contract)).
The table below compares that decision with the stronger responsibilities of the
earlier proposed gateway so the point at which a future external runner becomes
justified remains explicit.

| Gateway responsibility | Native Promptfoo + fixed local path | Assessment for trusted local/CI |
|---|---|---|
| Prompt/test/provider matrices, repeats, grading, reports | Native Promptfoo strength | **Replace gateway portion; Promptfoo already owns this.** |
| Run Claude or Codex in an existing checkout | Built-in SDK providers with `working_dir` | **Sufficient.** |
| Fresh workspace per case | Extension/wrapper deletes and copies a fixture | **Sufficient as repo-owned glue**, provided reset failure aborts and the seed is protected. |
| Deterministic final-filesystem checks | Trusted JS assertion reads files or runs a fixed verifier | **Sufficient** for deterministic-only rows and trusted checks. |
| Basic tool/step evidence | Claude metadata plus OTLP traces; Codex streamed and optionally deep OTLP traces | **Usually sufficient**, if Promptfoo JSON/trace JSON is the accepted evidence format. |
| Exact Git/OCI/bundle acquisition and provenance | Not provided by these providers or extensions | Use CI checkout/container tooling for a simple local case; retain an external materializer when exact multi-source provenance is a requirement. |
| Read-only and writable source views in one composed tree | No first-class source/access-mode model | External runner required when access modes are security properties rather than fixture convention. |
| Agent isolation, resource ceilings, process-tree reaping | Partial provider-specific sandbox controls; no gateway-equivalent lifecycle contract | External sandbox/runner required for untrusted code or strict CPU/memory/PID/IO cleanup. |
| Separate agent/check credentials and network namespaces | Assertions share the host process/runtime; no hidden late bundle | External runner required for secret tests, phase separation, or policy-enforced egress. |
| Bounded output, requested files, digests, immutable artifacts, retention | Promptfoo outputs/traces, plus arbitrary glue | External evidence/artifact service required when these are contractual. |
| Stable normalized ATIF trajectory | OTLP spans and provider-specific raw/metadata | External normalization required if ATIF is mandatory. |
| Idempotency, cancellation, queue recovery, durable terminal states | Local process semantics only | External control plane required if ambiguous/retried infrastructure execution matters. |
| OMP execution and cross-agent parity | No built-in OMP provider among the two evaluated here | Custom provider or external adapter required. |

## Application to the PR 679 Promptfoo experiment

The authenticated
[`framework-parity/promptfoo/pr-679`](https://github.com/EntityProcess/wtg-ai-prompts-experiment/tree/main/framework-parity/promptfoo/pr-679)
experiment currently uses top-level Promptfoo `metadata` as an execution
configuration channel:

- the
  [`with-agentrules` suite](https://github.com/EntityProcess/wtg-ai-prompts-experiment/blob/main/framework-parity/promptfoo/pr-679/with-agentrules.suite.yaml)
  puts repository URLs, revisions, a workdir, Git-cache configuration, and a
  skills-config path under `metadata`;
- `setup_environment_extension.ts` reads `suite.metadata.environment`, creates a
  timestamped workspace, and publishes its path through process environment
  variables; and
- `skills_extension.ts` reads `suite.metadata.skills`, while the PI provider
  consumes the resulting workspace and manifest through `workdirEnv` and
  `environmentManifestEnv`.

That works, but Promptfoo documents top-level `metadata` as arbitrary data stored
with the eval config, not as a workspace lifecycle schema. The fixed-workspace
composition provides a cleaner replacement:

1. Move repository and exact-revision declarations to the checked-in source
   catalog owned by the evaluation harness.
2. Let the job launcher stage the CargoWise seed before Promptfoo starts.
3. Put `source_id` or a workspace-profile ID in suite `defaultTest.vars`; the
   `beforeEach` extension copies that seed to `./.eval/workspace`.
4. Configure a built-in agent with
   `working_dir: ./.eval/workspace`. If the PI provider remains, give it the same
   ordinary `working_dir` config field instead of discovering a path through
   suite metadata and environment-variable indirection.
5. Treat the with-skill and without-skill variants as distinct staged workspace
   profiles. Skill materialization belongs in source/profile setup, or in the
   built-in provider's documented skill configuration when that provider owns
   skill loading.
6. Keep Promptfoo `metadata` descriptive only: source PR, source eval, experiment
   tags, and other report annotations.

The shared PR 679 cases currently model-grade the agent's textual review and do
not inspect a mutable final filesystem, so Promptfoo's deferred-grading behavior
does not invalidate them. If those cases later add live-workspace assertions,
the deterministic phase must persist row evidence before a separate model-
grading evaluation, as described above.

## Narrow recommendation

Adopt the native composition first for evaluations that meet **all** of these
conditions:

- one trusted local/CI runner owns the workspace and credentials;
- inputs are already checked out or can be copied from a protected local fixture;
- one shared `./.eval/workspace` is acceptable with `maxConcurrency: 1`;
- tests can use deterministic filesystem assertions without same-row deferred
  model grading;
- provider-specific Claude/Codex metadata plus Promptfoo OTLP trace JSON is adequate;
- caching is disabled so every row actually executes; and
- the provider sandbox plus the CI/container boundary is an acceptable risk boundary.

Under those conditions, a gateway adds little evaluation value. Keep the composition
small: one fail-closed `beforeEach` materializer, one deterministic assertion module,
one built-in provider, and optional tracing. Do not recreate an API, job queue, upload
protocol, or artifact store around a local run.

Retain or introduce an external gateway/runner only when at least one concrete
requirement crosses that boundary: untrusted agent execution; multi-source Git/OCI
composition with verified provenance; read-only mount enforcement; hidden checks;
credential/network phase separation; strict cgroup/process cleanup; durable bounded
artifacts; idempotent cancellation/recovery; mandatory ATIF; OMP support; or execution
on a machine other than the Promptfoo process. Remote multi-tenancy is one reason for
those contracts, not a prerequisite for them.
