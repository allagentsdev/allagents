---
title: "UHP Coding-Agent Execution through HarnessRouter - Plan"
date: 2026-09-18
updated: 2026-09-21
type: feat
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# UHP Coding-Agent Execution through HarnessRouter - Plan

## Goal Capsule

- **Objective:** Let Promptfoo and other authenticated UHP clients run a
  configured Codex or Pi harness against an AllAgents Git workspace or immutable
  OCI workspace snapshot, continue the same conversation and writable workspace
  with `previous_response_id`, and receive source provenance, output, usage, and
  artifacts.
- **Means:** Deploy a pinned HarnessRouter CE fork. Preserve HarnessRouter's UHP,
  caller authentication, session, streaming, cancellation, artifact, and
  agent-runner behavior. Add a generic first-turn materializer boundary, nested
  working-directory support, durable materialization state, nested-repository
  checkpoint/collection support, and a separation between session state and
  durable harness-native OAuth state. Implement Git/OCI semantics in a separate
  AllAgents executable. Codex authenticates through `codex login`; Pi
  authenticates through its `/login` flow for the selected provider. An
  API-key-authenticated proxy is an explicit last-resort target mode.
- **Authority:** [ADR 0002](../decisions/0002-adopt-uhp-through-harnessrouter.md)
  owns the protocol, fork, trust, workspace, harness-authentication, and
  provider-routing decisions. UHP `2026-09-12` and HarnessRouter's conformance
  suite own execution-wire behavior. The project `workspace.yaml` owns logical
  Git/OCI sources and environment-variable credential references; deployment
  secrets provide the values. HarnessRouter configuration owns harness IDs,
  model allowlists, and authentication bindings. The namespaced
  AllAgents extension owns acquisition and provenance semantics.
- **Execution order:** Prove the fork seam, Codex and Pi native-OAuth routes,
  auth-state isolation, materialization state machine, and checkpoint integration
  against a real HarnessRouter runner; freeze the generic hook and AllAgents
  contracts; implement Git then OCI acquisition; prove an explicit proxy mode
  separately; run Promptfoo one-shot and continuation E2E; complete release,
  fork-maintenance, and upstream-ready documentation.
- **Stop conditions:** Stop before production implementation if materialization
  cannot complete and durably checkpoint before provider dispatch, if nested Git
  workspaces cannot be collected without corrupting HarnessRouter checkpoints,
  if source credentials enter the harness, if the gateway/runner automatically
  copies harness OAuth files into a materialized source tree, checkpoint,
  produced-file record, passive log, or public metadata, if local OAuth state
  cannot be persisted atomically and validated fail-closed while conversation
  state remains session-scoped, or if the fork cannot preserve stock UHP
  behavior and conformance. Do not fall back to prompt
  instructions, an MCP acquisition tool, client-side repository upload, another
  OAuth profile, an implicit API-key route, a second execution protocol, or a
  parallel task/session engine.
- **Tail ownership:** Implementation owns focused tests in both repositories,
  upstream UHP conformance, built-image smoke tests, exact Git/OCI E2E, native
  Codex/Pi OAuth and explicit proxy-mode E2E, two-turn Promptfoo success and
  failure verification, credential boundary checks, documentation, and a clean
  upstreamable HarnessRouter patch series.

---

## Product Contract

### Summary

AllAgents uses HarnessRouter as the execution gateway.
HarnessRouter exposes UHP, authenticates callers, creates and persists sessions,
streams events, runs configured Codex and Pi harnesses, handles cancellation and
idempotency, and returns output, usage, and artifacts.

The missing product-specific capability is deterministic workspace acquisition
before the first agent turn. A focused HarnessRouter fork calls a generic
materializer boundary after allocating the session workspace but before provider
selection. The AllAgents executable validates the product-specific descriptor,
writes and validates staging, and returns path-free provenance. The runner
publishes staging, initializes HarnessRouter and nested-repository checkpoints,
persists a pre-agent checkpoint, and only then permits provider dispatch.

A continuation supplies `previous_response_id`, omits the workspace extension,
and uses HarnessRouter's current native conversation and writable session
workspace. A different revision, snapshot, or working directory requires a new
session. AllAgents does not add stricter predecessor-head or branching semantics
beyond HarnessRouter's UHP behavior.

### Problem Frame

HarnessRouter already implements the generic execution concerns. Reimplementing
them in AllAgents would add a second protocol, lifecycle, session store, process
supervisor, artifact model, provider integration, and conformance burden without
differentiating the product.

Stock HarnessRouter does not expose a documented generic pre-turn seam for a
server-side Git/OCI descriptor. It does not copy arbitrary request metadata into
response metadata or forward it to ordinary Codex/Pi runners. Input files are
written before the agent and support nested paths, but client-side expansion
loses exact symlink, mode, Git-history, and OCI layer semantics and makes every
caller responsible for acquisition. The temporary fork closes those seams.

### Actors

- **A1. UHP caller:** Promptfoo or another application holding a HarnessRouter
  API key. It chooses a configured HarnessRouter harness ID and model, prompt,
  initial workspace descriptor, and optional continuation predecessor.
- **A2. HarnessRouter gateway:** Authenticates and validates UHP, owns response
  and session identity, treats the configured workspace metadata value as
  bounded opaque JSON, drives materialization before provider fallback, and
  returns hook metadata on every response path.
- **A3. AllAgents materializer:** A non-network executable invoked before the
  first turn. It validates the AllAgents descriptor, reads the mounted project
  workspace configuration, acquires Git or OCI sources into staging, validates
  the tree, and returns provenance.
- **A4. HarnessRouter runner:** Owns the per-session operating-system identity,
  publication, checkpoints, nested-repository collection, input files, safe
  nested cwd, selected Codex/Pi process, session conversation state, and
  projection of the selected durable auth profile.
- **A5. Harness-native auth profile:** One dedicated durable credential root for
  one Codex or Pi harness target. The harness owns login and token refresh. The
  gateway lifecycle never copies its files into workspace checkpoints or public
  metadata; active harness access is part of the owner-trust boundary.
- **A6. Optional authenticated proxy:** A last-resort, explicitly configured
  target mode. The gateway keeps the long-lived proxy client key, the proxy owns
  upstream provider authentication, and the harness receives only a
  non-refreshable, scoped turn credential that the HarnessRouter broker validates.
- **A7. Operator:** Pins and deploys the custom image, mounts durable data and
  project workspace configuration, completes each native harness login, supplies
  deployment-only source credential values, selects any explicit proxy targets,
  and controls private-network access.

### Key Decisions

- **Use UHP as the northbound contract.** UHP `2026-09-12` is the only
  northbound execution contract. HarnessRouter conformance is authoritative.
- **Fork narrowly and upstream later.** Delivery uses an AllAgents-maintained
  fork. The upstreamable layer is a configured opaque-metadata key, immutable
  first-turn binding, typed command envelope, durable pre-provider lifecycle,
  safe nested cwd, checkpoint/collection integration, and separation of durable
  harness-auth state from session state. It contains no AllAgents Git/OCI schema
  logic. Upstream acceptance is not critical-path.
- **Run the AllAgents component behind HarnessRouter.** The materializer is a
  subprocess hook, not another HTTP gateway and not a custom agent backend.
- **Materialize once per extension-bearing session.** An extension-bearing
  initial request creates and checkpoints the workspace. Continuations must omit
  the extension and reuse the session through `previous_response_id`.
- **Keep source authority server-side.** Callers select logical source names and
  revisions but cannot send origins, credentials, host paths, commands, or
  Docker options.
- **Prefer harness-native OAuth.** Promptfoo's HarnessRouter API key authenticates
  the UHP caller only. Codex and Pi use their own login, token storage, refresh,
  and provider request path; native mode has no provider-route API key.
- **Make proxy auth explicit.** `proxyApiKey` is a last-resort target mode for a
  compatibility or stronger-isolation requirement. OAuth failure never activates
  it, and a session never changes its persisted authentication binding.
- **Preserve stock UHP requests.** Requests without the configured metadata key
  behave exactly as upstream.
- **Use a custom HarnessRouter image.** The image combines a pinned HarnessRouter
  revision, reviewed patch series, pinned agent runtimes, and the AllAgents
  materializer executable.
- **Publish from an AllAgents-owned registry.** Release the public image as
  `ghcr.io/allagentsdev/harnessrouter`; tags identify releases, but deployment
  and E2E pin the published manifest digest.

### Requirements

#### UHP, authentication, and routing

- **R1.** Pin HarnessRouter CE to a reviewed upstream commit and UHP version
  `2026-09-12`. The deployment must pass the applicable upstream conformance
  suite without weakening, replacing, or reinterpreting stock UHP behavior.
- **R2.** Require a HarnessRouter API key for every externally reachable UHP,
  response/session retrieval, stream, cancellation, file, and artifact endpoint.
  Reject unauthenticated requests before disclosing resource existence or
  metadata. Gateway-to-runner operations are not externally routable and are
  mutually authenticated. Bind the service to loopback or a private interface
  and document the remaining need for Tailscale ACLs, firewall policy, or
  equivalent network controls.
- **R3.** HarnessRouter deployment configuration owns stable harness IDs,
  backend, model allowlist, and exactly one auth binding:
  `{ mode: "nativeOAuth", profile: ConfigName }` or
  `{ mode: "proxyApiKey", connection: ConfigName }`. A proxy connection is a
  closed server-side record containing private HTTPS base URL, expected TLS
  identity/CA, HarnessRouter-supported API format and endpoint set, gateway-only
  proxy-client-key secret handle, broker audience, and requested-to-proxy model
  map. Callers cannot override any field. Requests select a harness with stock
  `metadata.harness_id` and a model with `model`; AllAgents profiles are not
  projected into this catalog. Codex and Pi targets default to `nativeOAuth`.
  A target is advertised only after its selected auth binding passes: profile
  login/refresh/live-turn checks for native OAuth, or schema, TLS, broker,
  model-map, endpoint, and live compatibility checks for `proxyApiKey`. On the
  first turn, the gateway persists the harness target, auth mode, binding
  identity, and canonical binding-config digest in the session. Continuations
  require that exact binding; deployment config changes never switch it.
- **R4.** Add a durable auth root outside session workspaces with one
  least-access profile directory per harness target. Controlled setup runs
  `CODEX_HOME=<profile> codex login` with file credential storage for Codex or
  runs Pi `/login` in an isolated Pi home for the configured provider. The
  runner projects only the selected profile's exact auth files into the
  session-specific CLI home and keeps conversation/rollout state session-scoped.
  The projection must preserve the harness's credential-file write and
  atomic-replacement behavior. A locally committed refresh uses a same-filesystem
  temporary file, file `fsync`, atomic rename, parent-directory `fsync`, and
  validation. A crash after the provider rotates credentials but before local
  commit can leave the profile stale; restart then marks it `repair-required`
  and requires native login instead of changing profile or auth mode. The
  gateway/runner must not automatically serialize auth files into root or nested
  checkpoints, produced-file records, passive logs/traces, materializer input,
  or response metadata. Native mode sets explicit owner trust because the
  harness and tool subprocesses sharing its operating-system identity may read
  or emit that credential. Version one holds a per-profile lock for every
  refresh-capable turn and every login, logout, or repair operation; a second
  turn for that profile waits or fails before launch.
  Preserve HarnessRouter streaming, cancellation, idempotency, files, artifacts,
  completed-session persistence, and per-session workspace/UID isolation.

#### Workspace extension and hook

- **R5.** On an initial response request, accept one optional JSON object of at
  most 64 KiB and 32 levels at `metadata["allagents.workspace"]`.
  HarnessRouter checks only those generic bounds, canonicalizes the opaque value
  with RFC 8785, and binds its digest to the new session. A continuation must
  omit this key. The AllAgents hook validates the exact v1 object
  `{ version: "1", source, workingDirectory? }`; `source` is exactly
  `{ kind: "repositories", revisions?: Record<ConfigName, RevisionText> }` or
  `{ kind: "workspaceSnapshot", snapshot: ConfigName, digest: Digest,
  workspaceManifestDigest: Digest }`; `workingDirectory` is exactly
  `{ kind: "workspaceRoot" }` or
  `{ kind: "repository", repository: ConfigName, path?: RelativeDirectory }`.
- **R6.** The AllAgents hook expands omitted `revisions` to `{}` and omitted
  `workingDirectory` to `{ kind: "workspaceRoot" }`; an omitted repository
  `path` remains absent and an empty path is invalid. It NFC-normalizes strings,
  sorts maps, rejects unknown fields, and hashes RFC 8785 bytes as the effective
  descriptor digest. Project-config default refs affect resolved provenance, not
  this request digest. Accepted/rejected fixtures prove omitted and
  explicit-default forms canonicalize identically.
- **R7.** Add one runner-side `/materialize` operation outside the provider
  candidate loop. It invokes a configured executable directly without a shell
  after fresh-session hydrate and before `/turn`. Pass at most 128 KiB on stdin,
  accept at most 1 MiB on stdout and 64 KiB on stderr, and use the smaller of
  900 seconds or the remaining UHP deadline. The generic request contains the
  opaque metadata value, session workspace and fixed sibling staging roots,
  project configuration root, and deadline. Source values come from an
  owner-only runner secret mount or credential-store handle, never the
  gateway/runner base environment. The runner resolves only the selected handle
  and constructs the allowlisted materializer child environment. It refuses
  agent launch if a configured secret name or value appears in the service or
  agent environment. The typed result is `completed` with effective relative cwd
  and bounded public metadata or `failed` with stable code, safe message, and
  retryability. A materializer failure terminalizes the UHP response and never
  enters provider fallback.
- **R8.** Persist a CAS-protected session materialization state:
  `unbound -> materializing -> ready` or `failed`, plus the resolved harness
  target, auth mode, native-profile or proxy-connection identity, and canonical
  binding-config digest. The runner validates successful staging, publishes it
  with a recoverable same-filesystem rename protocol, writes a
  descriptor/provenance marker, initializes the HarnessRouter root checkpoint
  and nested-repository collection baselines, and returns `published` with the
  checkpoint digest. Before provider dispatch, the gateway stores that digest
  and public metadata and CASes the session to `ready`. On restart in
  `materializing`, reconcile to `ready` only when the workspace marker and
  durable checkpoint match the bound descriptor; otherwise mark the session
  non-resumable, remove or quarantine the workspace, and never replay acquisition.
  Every continuation resolves the persisted auth binding by identity and digest;
  if unavailable or changed, it fails before runner work instead of selecting a
  replacement. Provider fallback sees `ready` state only and cannot invoke the
  hook. Ordinary input files are applied only afterward. A validated logical cwd
  may be the root or a symlink-safe descendant; the runner derives UID isolation
  from the session root and rejects cross-session or escaping paths.

#### Source acquisition and provenance

- **R9.** Parse the project `workspace.yaml` through its authoritative schema.
  Add strict project-only `workspaceSnapshots` entries:
  `{ name: ConfigName, repository: OciRepository,
  workspaceManifestMediaType: MediaType, executionCredential?: "${ENV_VAR}" }`.
  `OciRepository` is a normalized `registry-host/repository-path` with no scheme,
  tag, digest, userinfo, query, or fragment. Reject unknown fields, literal
  secrets, and duplicate snapshot names; snapshot entries do not merge with user
  configuration. Add the same optional environment-reference field to
  execution-eligible repositories. Secret values remain deployment-only. A
  repository's logical name is explicit `name` or the portable basename of
  normalized `path`. Execution-eligible Git destinations must be unique,
  non-empty, non-root relative child paths so their `.git` directories cannot
  collide with HarnessRouter's root checkpoint repository. Reuse one shared
  source resolver: `source` as a supported HTTPS URL is complete when `repo` is
  absent; otherwise `source` names the supported host/provider and `repo` names
  its repository. Conflicting forms, local/originless entries, duplicate
  repository names, escaping destinations, and unsupported schemes make
  materializer preflight fail. HarnessRouter owns harness/model/provider targets,
  and the user workspace is not a materialization catalog.
- **R10.** Repository mode materializes every execution-eligible declared
  repository. Optional revisions override only matching logical names; otherwise
  use configured `branch`, then the remote symbolic HEAD. `RevisionText` is at
  most 255 ASCII bytes and is either a full 40-hex object ID or a
  `git-check-ref-format`-equivalent ref name. Reject leading dashes, whitespace
  and controls, refspec colons, glob metacharacters, traversal-like components,
  `@{`, and `.lock` components. Resolve a validated full ref, or an unambiguous
  shorthand under `refs/heads/` or `refs/tags/`, with `ls-remote`; accept object
  IDs only when advertised. Subsequent fetch/checkout commands receive only the
  verified object ID with explicit end-of-options handling, never caller text.
  Allow only argument-vector HTTPS Git operations to exact configured hosts, with
  no URL credentials, query, fragment, or redirects. Use an isolated HOME plus
  `GIT_CONFIG_NOSYSTEM=1`, no global config, empty credential helper, disabled
  hooks, `protocol.file.allow=never`, `protocol.ext.allow=never`, and no
  submodule recursion, Git LFS hydration, or configured clean/smudge filters.
  Preserve each repository's `.git` directory for the coding agent. Failure never
  falls through to snapshot mode or another credential identity.
- **R11.** Snapshot mode constructs a server-side immutable OCI reference from
  the selected snapshot's configured repository and caller-provided digest.
  Accept only a direct OCI image manifest with at most 64 distributable
  tar/gzip/zstd layers and the entry's configured workspace-manifest media type;
  redirects may not change registry authority. Verify manifest, config, layer
  size and digest before use; apply OCI whiteouts; limit manifest and config to
  4 MiB each, total compressed layers to 8 GiB, expanded bytes to 32 GiB,
  entries to 500,000, one regular file to 4 GiB, paths to 4096 UTF-8 bytes and
  128 components, and one PAX/extended header to 1 MiB. Reject devices, sockets,
  traversal, escaping links, sparse files, unknown or foreign layers, mutable
  tags, and undeclared output. Validate the final logical repository catalog and
  workspace-manifest digest in staging. Snapshot repository roots need not
  contain `.git`; after publication the runner creates private collection
  baselines from the verified trees so later produced-file reporting remains
  truthful.
- **R12.** Extend HarnessRouter's response translator and stored-response paths
  so streaming events, terminal responses, GET, background completion, and
  idempotent replay return the same bounded
  `response.metadata["allagents.workspace"]`. It contains extension version,
  effective descriptor digest, logical cwd, source mode, completeness, resolved
  commits or OCI manifest/config/layer digests, and workspace-manifest digest.
  It never contains origins, physical paths, credentials, or unverified facts.
- **R13.** The materializer resolves `${ENV_VAR}` references from its allowlisted
  child environment, uses hermetic Git/registry configuration, removes temporary
  auth files before returning, and emits no secret. Prove with a deliberately
  innocuous variable name and value that source credentials and the HarnessRouter
  caller API key are absent from the gateway/runner base environment, every agent
  environment, workspace, nested Git remotes/config, generated CLI configuration,
  logs, checkpoints, and response metadata. In native mode there is no
  provider-route API key. The selected OAuth profile is intentionally readable by
  the harness trust boundary; the gateway/runner never automatically copies it
  into materialized source trees, checkpoints, produced-file records, passive
  logs, materializer input, or public metadata. An active same-identity harness
  or tool can exfiltrate it; that risk is explicit in owner-trust mode.

  In proxy mode, the long-lived proxy client key and upstream provider
  credentials stay in their owning services. The non-refreshable broker token is
  bound to one proxy audience, harness target, model allowlist, response/turn ID,
  and the UHP deadline plus minimal clock skew. It may authorize the bounded
  provider requests, compaction, and retries required during that active turn;
  cancellation or terminal completion revokes it. Passive persistence never
  stores it. The HarnessRouter broker rejects wrong-audience, wrong-model,
  wrong-turn, expired, or revoked tokens.
- **R14.** Build and publish a pinned `linux/amd64` custom HarnessRouter image as
  the public package `ghcr.io/allagentsdev/harnessrouter`. Replace or disable the
  inherited Docker Hub release path. The Dockerfile pins every base image by
  digest; runtime lockfiles and version-locked OS packages, Git/OCI tools, Codex,
  and Pi define the remaining build inputs. The build fails on any unpinned
  input. A no-write job builds, tests, and exports the identified image artifact
  using commit-pinned third-party actions. A separate protected,
  environment-approved publish job accepts only an approved release/tag ref and
  uses `GITHUB_TOKEN` with `contents: read`, `packages: write`,
  `attestations: write`, and `id-token: write`. It publishes unique version and
  commit tags as mutable discovery labels, reads back the registry manifest, and
  creates GitHub/Sigstore build-provenance and SBOM attestations whose subject is
  the final manifest digest. Package visibility is public and verified with an
  anonymous digest pull. Deployment fails unless both attestations verify the
  expected owner, repository, workflow, approved ref, subject digest, predicates,
  base-image digest, runtime lockfiles, OS package set, Git/OCI tool versions, and
  Codex/Pi versions. Release E2E uses that digest, never `latest`. Requests
  without the configured metadata key remain stock-compatible. CI rebases
  selected upgrades and runs upstream plus AllAgents integration tests.
- **R15.** AI Evals owns its Promptfoo provider. It sends the UHP request directly
  to HarnessRouter, maps Promptfoo variables to the closed extension, and maps
  terminal output, usage, artifacts, provenance, and failures to
  `ProviderResponse`. Multi-turn cases retain the prior response ID and send it
  as `previous_response_id`. AllAgents documents the contract and examples but
  does not depend on Promptfoo at runtime.

### Key Flows

#### F1. Start the deployment

1. Run the AllAgents materializer's bounded `preflight` mode. It validates the
   project catalog, snapshot and credential-reference schemas, referenced secret
   presence, required Git/OCI tools, hook contract version, and staging/workspace
   filesystem relationship without contacting sources.
2. In a controlled operator context, initialize each dedicated auth profile:
   run Codex login with that target's `CODEX_HOME`, or run Pi `/login` with that
   target's isolated Pi home and configured provider. Persist only the selected
   harness profile; do not copy a general developer home into the service.
3. If native OAuth cannot satisfy the deployment's trust or compatibility
   requirement, deliberately select a separately configured `proxyApiKey`
   deployment profile. Validate its closed proxy connection, start the tested
   proxy, keep its client key and upstream credentials outside the runner, and
   enable HarnessRouter broker mode. Never configure it as automatic failover
   for a native target.
4. Start the attestation-verified, digest-pinned custom HarnessRouter image with
   durable session data, durable harness auth roots, a private listener,
   HarnessRouter caller key, materializer command, project configuration,
   owner-only source-secret mount/credential-store handle, and the configured
   native or proxy trust mode.
5. From the exact container network, verify each advertised harness ID and model
   allowlist, safe roots, materializer version, selected auth binding, and a live
   turn. Native targets exercise login status, atomic local refresh persistence,
   stale-profile repair, same-binding continuation, and serialized overlapping
   turns. An explicit proxy deployment exercises schema/TLS/model-map/endpoint
   compatibility plus bounded in-turn use and wrong-scope/expired/revoked
   rejection. Any required
   preflight or auth failure prevents readiness.

#### F2. Execute the first repository-backed turn

1. Promptfoo sends one authenticated UHP request with `model`, stock
   `metadata.harness_id`, idempotency input, and the AllAgents workspace object.
2. HarnessRouter validates UHP plus generic metadata bounds, resolves and
   persists the selected harness target and canonical auth-binding identity/
   config digest, creates the response/session, CASes materialization from
   `unbound` to `materializing`, and hydrates a fresh session workspace.
3. Before provider selection, the gateway calls runner `/materialize`. The
   AllAgents child validates the descriptor and catalog, resolves exact commits
   and source credentials, writes and validates staging, removes credential
   state, and returns provenance without publishing.
4. The runner independently validates the result/tree, publishes staging,
   writes its marker, initializes the root checkpoint plus each declared
   repository's collection cursor, and returns `published`. The gateway stores a
   durable checkpoint and CASes the session to `ready`.
5. HarnessRouter applies ordinary input files and resolves the safe nested cwd.
   In `nativeOAuth`, it projects only the persisted Codex or Pi profile and the
   harness calls its provider directly. In `proxyApiKey`, it projects no native
   profile and supplies only the scoped turn credential and broker base URL for
   the persisted proxy connection. Materialization cannot rerun during provider
   retry/fallback, and failure never changes auth mode.
6. Normal UHP events and every stored/retrieved terminal response include the
   same namespaced provenance. Produced-file collection walks the HarnessRouter
   root plus each declared nested repository without reporting initial source
   files as agent output.

#### F3. Continue the session

1. The caller sends `previous_response_id` and omits
   `metadata["allagents.workspace"]`.
2. HarnessRouter resolves its current session state and writable workspace,
   requires materialization `ready`, and resolves the persisted auth-binding
   identity and config digest. An unavailable or changed binding,
   extension-bearing continuation, concurrent active turn, or non-resumable
   session fails before runner work.
3. HarnessRouter follows its stock predecessor/session semantics. Native mode
   projects the persisted profile; proxy mode mints a new scoped turn token for
   the persisted connection. It resumes the native conversation and returns
   pinned provenance plus new output, usage, and artifacts without changing auth
   mode or binding.

#### F4. Execute an OCI-backed first turn

1. The caller selects one configured snapshot and immutable manifest/workspace
   digests; it never sends the registry origin or credential.
2. The materializer fetches and verifies the direct manifest, config, and layers,
   applies changesets under fixed limits, validates the declared repository
   layout in staging, and returns exact provenance.
3. The runner publishes and checkpoints through the same state machine as F2.
   Any registry, digest, media, path, limit, or layout failure removes staging,
   terminalizes the response, and enters neither Git nor provider fallback.

#### F5. Cancel, fail, or restart

1. Materializer cancellation or deadline terminates the child and removes
   staging. The session becomes `failed` and non-resumable; no provider starts.
2. Agent cancellation and deadline use HarnessRouter's normal UHP lifecycle.
3. Startup reconciles a `materializing` session to `ready` only when the bound
   descriptor, published workspace marker, and durable checkpoint all match.
   Otherwise it marks the session failed/non-resumable and removes or quarantines
   the workspace. It never replays acquisition. A completed `ready` session
   rehydrates from its durable checkpoint.
4. Whole-container termination does not preserve the in-flight agent process.
   Interrupted agent turns fail according to HarnessRouter behavior.

### Acceptance Examples

- **AE1.** A stock UHP request without the configured metadata key produces the
  same response and conformance result on upstream HarnessRouter and the fork.
- **AE2.** Every unauthenticated external create, continuation, GET, stream,
  cancel, file, and artifact request fails before resource existence or metadata
  is disclosed. An authenticated native Codex or Pi turn uses the selected OAuth
  profile; the HarnessRouter caller key is absent from the agent environment and
  filesystem, and no provider-route API key exists in that mode.
- **AE3.** Repository mode resolves configured branch/default/HEAD refs to full
  commits, prepares every execution-eligible repository, preserves nested Git
  history, starts in a validated nested cwd, and returns path-free provenance.
- **AE4.** HarnessRouter rejects non-object/oversized metadata and an extension
  on continuation before the hook. The hook rejects unknown logical names,
  caller-provided URLs, absolute/traversal paths, commands, environment fields,
  credentials, originless/local repositories, and duplicate names/destinations
  before source network access or agent launch.
- **AE5.** Two turns linked by `previous_response_id` preserve a file and native
  conversation context. The hook runs once; produced-file collection reports
  modifications inside every nested repository but not the initial source tree.
- **AE6.** A continuation omitting the extension succeeds. Any continuation
  containing the configured workspace key is rejected without changing the
  workspace. A new revision uses a new session.
- **AE7.** Explicit UHP input files overlay materialized paths after the
  pre-agent checkpoint and before agent launch.
- **AE8.** A materializer crash, timeout, cancellation, malformed result,
  publication crash, checkpoint failure, or Git failure starts no provider,
  leaks no credential, and leaves the session failed/non-resumable rather than
  partially ready. Provider fallback never reruns materialization.
- **AE9.** OCI mode accepts a valid digest-pinned fixture with gzip/zstd layers
  and whiteouts and rejects mutable tags, indexes, mismatched digests/sizes,
  traversal, escaping links, devices, sparse files, unknown media types, and
  declared-limit overflow.
- **AE10.** Codex signs in and refreshes through Codex CLI; Pi signs in and
  refreshes through Pi for its configured provider. Missing, revoked, expired,
  unrefreshable, or locally stale-after-crash OAuth marks only that profile
  unavailable or `repair-required`; it never selects another profile or proxy.
  A second turn sharing a profile waits or fails before launch. A separately
  configured `proxyApiKey` deployment's broker permits the bounded multi-request
  provider flow during the active turn and rejects wrong-audience, wrong-model,
  wrong-turn, expired, or revoked credentials.
- **AE11.** Restart after a completed first turn preserves the session and exact
  persisted auth binding. Removing or changing that binding makes continuation
  fail before runner work; restoring the matching identity and config digest
  restores eligibility. Restart during materialization recovers only from a
  matching published marker and durable checkpoint; otherwise it fails without
  automatic replay. Restart during an agent turn follows HarnessRouter's
  interrupted-turn failure behavior.
- **AE12.** The protected publish job releases the public `linux/amd64` GHCR
  package without Docker Hub credentials. An anonymous client reads the manifest,
  verifies the GitHub/Sigstore build-provenance and SBOM attestations' expected
  owner, repository, workflow, approved ref, subject digest, and predicate, and
  pulls that digest rather than `latest`. The evidence records upstream, patch,
  materializer, Codex, and Pi inputs; mismatches fail closed.
- **AE13.** Promptfoo maps one stable materializer failure and one HarnessRouter
  execution failure to failed `ProviderResponse` results with code, safe message,
  and metadata; neither becomes a successful empty response.

### Scope Boundaries

**In scope**

- HarnessRouter workspace-integration and harness-auth-state patches.
- Versioned AllAgents workspace descriptor, hook request/result, and provenance.
- Project workspace schema additions and catalog projection.
- Deterministic Git and immutable OCI acquisition.
- Root/nested-repository checkpoint and produced-file integration.
- Source credential isolation and native-OAuth trust-boundary verification.
- Native Codex and Pi auth-profile bootstrap, refresh, readiness, and continuity.
- Explicit, separately validated API-key-authenticated proxy deployment mode.
- Public GHCR image publishing, digest-pinned release metadata, SBOM, and
  provenance.
- Promptfoo contract examples and one-shot/two-turn success/failure E2E.
- Upstream-ready generic hook and auth-state patches plus maintenance procedure.

**Out of scope**

- A second northbound execution protocol or parallel task/session control plane.
- A separate AllAgents network gateway, process supervisor, provider adapter, or
  artifact service.
- Promptfoo runtime code inside AllAgents.
- A custom OAuth broker, token translation layer, or automatic native-to-proxy
  credential fallback.
- Caller-provided origins, credentials, commands, host paths, materializers, or
  Docker options.
- Public multi-tenancy, per-caller authorization, Kubernetes workers, session
  branching, concurrent turns in one session, or guaranteed prompt-cache hits.
- Exact rollback of workspace mutations between successful session turns.

### Sources

- [ADR 0002](../decisions/0002-adopt-uhp-through-harnessrouter.md)
- [HarnessRouter repository](https://github.com/HarnessRouter/harnessrouter)
- [HarnessRouter self-hosting guide](https://github.com/HarnessRouter/harnessrouter/blob/main/docs/self-hosting-guide.md)
- [UHP 2026-09-12 architecture](https://github.com/HarnessRouter/harnessrouter/blob/main/protocol/versions/2026-09-12/architecture.md)
- [UHP sessions](https://github.com/HarnessRouter/harnessrouter/blob/main/protocol/versions/2026-09-12/sessions.md)
- [UHP lifecycle](https://github.com/HarnessRouter/harnessrouter/blob/main/protocol/versions/2026-09-12/lifecycle.md)
- [UHP files](https://github.com/HarnessRouter/harnessrouter/blob/main/protocol/versions/2026-09-12/files.md)
- [Codex authentication](https://developers.openai.com/codex/auth)
- [Pi model providers and OAuth](https://pi.dev/docs/latest/providers)
- [GitHub Container Registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)
- [`codex-lb` optional proxy](https://github.com/Soju06/codex-lb)
- [Harbor repository materialization lessons](../research/harbor-repository-materialization.md)
- [Source credential broker precedents](../research/source-credential-broker-precedents.md)

---

## Planning Contract

### High-Level Technical Design

```mermaid
flowchart TB
  PF[Promptfoo provider] -->|UHP + HR API key| GW[HarnessRouter gateway]
  GW -->|first-turn materialize| RUN[HarnessRouter runner]
  RUN -->|opaque JSON in, typed envelope out| MAT[AllAgents materializer]
  MAT --> CFG[project workspace.yaml]
  MAT --> GIT[Git sources]
  MAT --> OCI[OCI registry]
  RUN --> HARNESS[Selected Codex or Pi harness]
  AUTH[(dedicated durable OAuth profile)] -.->|native mode only| HARNESS
  HARNESS -->|native mode| MODEL[Model provider]
  HARNESS -.->|proxy mode: scoped turn credential| GW
  GW -.->|long-lived proxy client key| PROXY[optional provider proxy]
  PROXY -.-> MODEL
  GW --> DATA[(durable session checkpoints)]
```

The gateway owns generic metadata bounds, session materialization state,
persisted auth-binding identity, provider-loop ordering, checkpoint persistence,
response metadata, and optional proxy brokering. The runner owns hook invocation,
staged publication, checkpoint/collection setup, safe nested cwd, and agent
launch. In native mode it projects the bound OAuth profile; in proxy mode it
projects no native profile and supplies only the turn broker capability. The
selected harness owns native provider OAuth login and refresh. Its durable auth
root is outside session checkpoints; it is available to the harness trust
boundary but never to the materializer. The materializer owns only AllAgents
schema, catalog, acquisition, source-credential selection, staging validation,
and provenance; it never speaks UHP or publishes the live workspace.

### Extension Contract

Initial UHP request fragment:

```json
{
  "model": "gpt-5.6-sol",
  "input": "Review the service",
  "metadata": {
    "harness_id": "codex-review",
    "allagents.workspace": {
      "version": "1",
      "source": {
        "kind": "repositories",
        "revisions": {
          "api": "refs/pull/123/head"
        }
      },
      "workingDirectory": {
        "kind": "repository",
        "repository": "api",
        "path": "packages/service"
      }
    }
  }
}
```

Continuation fragment:

```json
{
  "model": "gpt-5.6-sol",
  "previous_response_id": "resp_previous",
  "input": "Now fix the highest-severity finding"
}
```

Successful response metadata fragment:

```json
{
  "allagents.workspace": {
    "version": "1",
    "descriptorDigest": "sha256:...",
    "workingDirectory": {
      "kind": "repository",
      "repository": "api",
      "path": "packages/service"
    },
    "sourceIdentity": {
      "kind": "repositories",
      "complete": true,
      "repositories": [
        {
          "name": "api",
          "requestedRevision": "refs/pull/123/head",
          "resolvedCommit": "0123456789abcdef0123456789abcdef01234567"
        }
      ]
    },
    "workspaceManifestDigest": "sha256:..."
  }
}
```

### Materializer Hook Contract

HarnessRouter configuration names one metadata key, absolute executable path,
maximum runtime, request/result byte limits, and allowlisted environment names.
The runner launches the executable directly without a shell. Standard error is
diagnostic-only, bounded, secret-checked, and never copied verbatim to callers.

The hook supports two operations:

- `preflight`: validate contract version, project catalog, credential-reference
  syntax and presence, required binaries, and filesystem assumptions without
  source network access; and
- `materialize`: validate the opaque descriptor, write only to the supplied
  sibling staging root, and return without publishing.

The materialize request contains the generic contract version, opaque metadata
value, session workspace and fixed staging roots, project configuration root,
and deadline. Secret values are injected only through the configured allowlisted
child environment; credential identifiers and values are absent from JSON.

The generic result is either:

- `completed`, effective relative cwd, effective descriptor digest,
  workspace-manifest digest, complete path-free public metadata, and declared
  nested-repository roots; or
- `failed`, stable code, safe message, retryability, and any verified incomplete
  public metadata.

The runner validates the result and staged tree independently. It rejects an
unknown envelope field/version, digest mismatch, physical path in public
metadata, incomplete success, undeclared repository root, escaping cwd, or tree
that does not match the manifest. The runner then owns publication, marker and
checkpoint setup; a valid result never means the live workspace is already
published.

### Fork Maintenance Contract

- Keep the fork in a dedicated repository/branch with the upstream remote intact.
- Pin production images to an upstream commit, never a moving branch.
- Keep the materializer changes as a small ordered patch series with focused
  commits and no formatting churn.
- For every selected upstream upgrade: rebase the patch series, inspect upstream
  changes in touched gateway/runner/session code, run upstream tests and UHP
  conformance, run AllAgents hook/session E2E, rebuild the image, and record the
  new inputs and digest.
- Publish releases to `ghcr.io/allagentsdev/harnessrouter`, record the manifest
  digest, and rehearse deployment from that digest rather than a local build or
  mutable tag.
- Prepare upstream proposals as generic command/plugin and harness-auth-state
  seams. Do not require upstream to understand AllAgents metadata, Git catalogs,
  OCI manifests, Promptfoo, or a specific OAuth provider.
- If upstream accepts an equivalent seam, delete the patch rather than retaining
  a compatibility layer.

### Risks and Mitigations

- **Fork drift:** Keep the patch ordered and narrow, pin commits, rebase only
  selected releases, and run both upstream and integration suites.
- **Gateway/runner durability split:** Use the explicit materialization CAS plus
  workspace marker and pre-agent checkpoint. Fault every boundary and fail
  incomplete sessions closed rather than attempting replay.
- **Nested Git versus HarnessRouter root Git:** Keep repository `.git` state,
  ignore declared roots in HarnessRouter's root index, and extend produced/list/
  file/ack/checkpoint/hydrate behavior to validate and walk every declared root.
- **Provider retry/fallback:** Run materialization before the provider candidate
  loop and surface a typed non-provider failure; a ready marker prevents reruns.
- **Source credential leakage:** Use subprocess-only source credentials,
  hermetic configuration, leak scans, and hostile fixtures.
- **Native OAuth exposure:** Treat the selected profile as available to the
  harness and same-identity tools. Mount no other profile and prevent passive
  gateway/runner persistence from serializing the auth file. A malicious harness
  or tool can still emit its contents; use explicit proxy mode when this
  owner-trust boundary is unacceptable.
- **OAuth refresh loss or races:** Hold one per-profile lock for every
  refresh-capable turn and administrative mutation. Persist local writes through
  same-filesystem temp-write, file `fsync`, atomic rename, parent `fsync`, and
  validation. Fault process death around local persistence; if remote rotation
  leaves the committed profile invalid, mark it `repair-required`. Never switch
  profiles or auth mode, and never run shared-profile turns concurrently.
- **Partial publication:** The materializer writes staging only. The runner
  validates and publishes with recovery markers; no agent runs until the gateway
  durably stores the resulting checkpoint and marks the session ready.
- **Descriptor/session drift:** Accept the key only on the initial request and
  persist the hook's effective digest/provenance for every later response.
- **OCI attack surface:** Use a closed media profile, streaming digest checks,
  fixed limits, strict path/link/type validation, and exact-host redirect policy.
- **Harness auth drift:** Pin Codex and Pi versions and require non-secret login,
  live-turn, refresh, and continuation probes before advertising each target.
- **HarnessRouter restart semantics:** Claim persistence only for completed state
  on durable storage; interrupted work fails and is not replayed.
- **Provider cache assumptions:** Report native cached-input usage when available;
  never promise a cache hit.
- **Registry/tag or publisher compromise:** Use a protected, environment-approved
  publish job with pinned actions and no write authority in build/test. Verify
  the attested owner/repository/workflow/ref/subject digest before deployment.
- **Upstream rejection:** The pinned fork remains supported; upstream delivery is
  maintenance reduction, not a launch dependency.

### Phased Delivery

1. Red E2E against stock HarnessRouter: prove arbitrary metadata is neither
   forwarded to Codex/Pi nor returned as workspace provenance, and document the
   stock separation between session and excluded auth files.
2. Fork spike: prove a fake hook runs through a dedicated pre-provider operation,
   publishes/checkpoints once, survives two-turn reuse, supports a safe nested
   cwd, reports nested-repository files, and cannot rerun under provider fallback.
   Prove one selected harness auth profile persists refresh without entering the
   checkpoint or exposing another profile, and prove a second turn sharing that
   profile waits or fails before launch.
3. Prove native Codex and Pi login, refresh, live turn, continuation, and
   failure behavior. Prove an explicit authenticated-proxy deployment separately;
   no native auth failure may route to it.
4. Freeze generic hook envelope/state/auth fixtures and AllAgents descriptor,
   configuration, provenance, and failure fixtures.
5. Implement project schema projection, preflight, Git materialization,
   credential containment, and checkpoint/collection integration.
6. Implement OCI materialization and its archive/registry security profile.
7. Run Promptfoo one-shot, continuation, cancellation, restart, and failure
   mappings; review both repositories; publish the exact GHCR image; deploy its
   digest; run green E2E and conformance; document operations; prepare the
   generic upstream patches.

---

## Implementation Units

### U0. HarnessRouter fork and hook feasibility

- **Goal:** Prove the smallest production-direction fork can materialize and
  durably checkpoint one workspace before provider dispatch while preserving
  stock UHP requests.
- **Repositories/files:** HarnessRouter fork `gateway/app.py`,
  `runner/server.py`, response/session persistence, checkpoint/produced-file
  helpers, runner/gateway tests, image entrypoint/Dockerfile, and fake hook.
- **Approach:** Pin upstream. Add configured opaque metadata extraction and
  bounds, generic result envelope, materialization CAS, dedicated runner
  operation before the provider loop, response-translator persistence, safe
  nested cwd, staged publication, pre-agent checkpoint, nested-repository
  collection, and durable auth-profile projection outside session state. Add
  startup preflight. Probe Codex and Pi native auth separately.
- **Verification:** Upstream UHP conformance stays green. Stock requests are
  unchanged. Faults at every state/publication/checkpoint boundary fail closed.
  Provider fallback cannot rerun the hook. A continuation reuses workspace,
  provenance, and the persisted auth binding without the extension. A changed or
  unavailable binding fails before runner work; an overlapping turn on the same
  native profile waits or fails before launch. Root and nested repository files
  collect correctly, escaping cwd fails, and only the selected auth profile is
  visible to the harness identity. Fault immediately before, during, and after
  local refresh persistence; restart sees a complete locally committed file and
  either validates it or marks the profile `repair-required`, never silently
  changing profile or auth mode. An inert-agent probe confirms the gateway/runner
  never automatically serializes the auth file into a checkpoint, produced-file
  record, passive log, or response.

### U1. AllAgents workspace contracts and Git materializer

- **Goal:** Implement the versioned schemas, authoritative catalog projection,
  deterministic Git acquisition, logical cwd resolution, and provenance.
- **Files:** `src/models/workspace-config.ts`,
  `src/models/execution-workspace.ts`, `src/core/execution-workspace.ts`,
  `src/core/workspace-repo.ts`, `src/cli/commands/workspace.ts` or one narrowly
  registered integration command, generated workspace schemas, build packaging,
  configuration documentation, unit fixtures, and Git E2E fixtures.
- **Approach:** Reuse authoritative workspace parsing and source normalization.
  Extend the project schema with strict snapshot and environment credential
  references; add descriptor/hook/result schemas, defaults, canonicalization,
  and a `preflight` mode. Expose a direct no-shell materializer entrypoint.
  Resolve the complete execution-eligible catalog to exact commits in staging,
  preserve nested `.git`, enforce the closed Git policy, validate destinations
  and cwd, compute the workspace manifest, and return without publishing.
- **Verification:** Local HTTPS fixtures cover branches, tags, commits, PR refs,
  configured defaults and symbolic HEAD, multiple repositories, optional-name
  fallback, conflicting/originless/local sources, root/duplicate destinations,
  unknown names, missing directories, traversal, leading-dash/control/refspec
  revisions, ambiguous shorthand, hooks/helpers/filters, submodules, LFS,
  file/ext protocols, redirects, cancellation, timeout, partial cleanup,
  canonical defaults, preflight failures, and exact provenance.

### U2. Session binding, failures, and credential containment

- **Goal:** Make the fork/materializer boundary durable, fail-closed, and safe for
  continued sessions.
- **Repositories/files:** HarnessRouter session/response persistence and tests;
  AllAgents credential-selection/environment code and hostile fixtures.
- **Approach:** Persist `unbound/materializing/ready/failed`, opaque request
  digest, effective descriptor digest, public provenance, workspace marker,
  checkpoint digest, and canonical auth-binding identity/digest through
  compare-and-set transitions. Extend every response construction/retrieval/
  replay path with identical public metadata. Resolve source `${ENV_VAR}`
  references only when constructing the materializer child from an owner-only
  runner secret source; reject configured names or values in the base service or
  agent environment. In native mode, project only the selected harness OAuth
  profile and exclude it from passive session persistence. In explicit proxy
  mode, broker the proxy client key with the required audience, target, model,
  turn, expiry, and revocation constraints. Scan workspace, nested Git, CLI
  session state, checkpoints, logs, and responses.
- **Verification:** Initial idempotent replay preserves one result; continuation
  omits the extension and reuses ready state plus the exact auth binding;
  extension-bearing continuation or changed/unavailable binding fails. Crashes
  around hook/publication/checkpoint/CAS reconcile to ready only when the bound
  descriptor, published marker, and durable checkpoint all match; missing or
  mismatched evidence becomes failed/non-resumable. Source secrets and the
  HarnessRouter caller key are absent from the base service and every
  shell-enabled agent path. The selected OAuth profile is available only through
  its harness home; other profiles are inaccessible. An inert-agent probe
  confirms no gateway/runner path automatically serializes it into checkpoints,
  produced-file records, passive logs, or public metadata; an active tool can
  still exfiltrate it in owner-trust mode. Native mode has no provider-route API
  key. Proxy tests allow bounded in-turn provider calls and reject every
  out-of-scope, expired, or revoked broker token.

### U3. Immutable OCI workspace materialization

- **Goal:** Add the second closed source mode without weakening Git behavior or
  allowing fallback.
- **Files:** AllAgents OCI client, manifest/archive validator, workspace-manifest
  types, deterministic snapshot producer fixture, local registry E2E, and
  security fixtures.
- **Approach:** Resolve only configured registries, implement bounded
  Basic/Bearer authentication and exact-host redirect policy, verify direct
  manifest/config/layers while streaming, apply changesets in staging, validate
  paths/types/limits/catalog, and return through the same hook envelope as Git.
  The HarnessRouter runner remains the sole publisher.
- **Verification:** Local Distribution fixtures cover anonymous and authenticated
  pulls, private CA, gzip/zstd, whiteouts, digest/size mismatch, redirects,
  rebinding policy, indexes, unknown/foreign media, traversal, escaping links,
  devices, sparse files, limit overflow, cancellation, cleanup, and no Git
  fallback.

### U4. Harness-native OAuth, optional proxy, and Promptfoo E2E

- **Goal:** Prove both real harness-native auth paths, their explicit trust
  boundary, session continuity, optional proxy isolation, and consumer
  success/failure mapping.
- **Repositories/files:** custom image/configuration, auth-profile setup and
  projection, HarnessRouter integration fixtures, AI Evals Promptfoo
  provider/configuration in its owning repository, and deployment examples in
  AllAgents docs.
- **Approach:** Configure dedicated Codex and Pi auth roots. Bootstrap them only
  through each harness's login flow; do not inject a provider-route API key.
  Exercise login status, live turns, atomic local refresh persistence,
  stale-after-remote-rotation repair, same-binding continuation, serialized
  overlapping turns, profile isolation, and missing/revoked credential failure.
  In a separate explicit deployment profile, validate the closed proxy connection
  and broker audience/target/model/turn/expiry/revocation contract. Run Promptfoo
  Git/OCI one-shot and two-turn cases plus materializer, authentication, and
  agent failures.
- **Verification:** Through the exact container network, Codex and Pi authenticate
  through their own OAuth sessions and use allowed models. Turn two sees turn
  one's conversation and file mutation with the same persisted auth binding; an
  overlapping turn sharing that profile waits or fails before launch. A config
  change or unavailable binding fails before runner work. Cancellation terminates
  the real turn. OAuth failure disables the target without selecting another
  profile or proxy. Faults around local refresh persistence leave a complete file
  that either validates or marks the profile `repair-required`; unselected
  profiles remain inaccessible. The separately configured proxy permits bounded
  multi-request use inside the active turn and rejects wrong-audience,
  wrong-target, wrong-model, wrong-turn, expired, or revoked credentials.
  Promptfoo returns successful output/usage/artifacts/provenance and maps all
  failure classes to failed, coded responses rather than empty success.

### U5. Release, operations, review, and upstream preparation

- **Goal:** Produce a reproducible, registry-published supported image and
  upstream-ready generic hook and auth-state proposals.
- **Repositories/files:** GHCR image build/release workflow, dependency lock and
  provenance record, fork-maintenance guide, deployment/reference docs,
  changelog, PR descriptions, and upstream patch series.
- **Approach:** Build from exact upstream/fork/AllAgents/agent inputs. Every base
  image is digest-pinned; runtime lockfiles and version-locked OS packages,
  Git/OCI tools, Codex, and Pi close the input set. The build fails on unpinned
  input. Replace the inherited Docker Hub path with a no-write build/test job and
  a separate protected, environment-approved GHCR publish job. Pin every
  third-party action by commit. Publish the `linux/amd64` image to
  `ghcr.io/allagentsdev/harnessrouter`, read back its manifest, create
  build-provenance and SBOM attestations for the final digest, and run conformance
  plus E2E only after verifying the expected repository, workflow, approved ref,
  subject digest, predicates, complete build inputs, and anonymous pull. Document
  durable session/auth volumes, native login/repair, optional proxy mode, private
  networking, upgrades, rollback, secret-safe backup, and the CE owner-trust
  boundary. Review both codebases before final green E2E. Split and explain the
  generic HarnessRouter patches for upstream.
- **Verification:** A clean `linux/amd64` host verifies both attestations and the
  pinned base/runtime/OS/Git/OCI/harness input set, then anonymously pulls the
  public package by subject digest and reproduces Git, OCI, native Codex/Pi,
  optional proxy, one-shot, continuation, cancellation, restart, and failure
  scenarios from documented commands. No Docker Hub credential is required. An
  unapproved ref or mismatched owner, repository, workflow, digest, attestation,
  predicate, or build input fails closed. Rebase rehearsal against the selected
  next upstream commit either passes or reports an explicit incompatibility
  before release.

---

## Verification Contract

| Gate | Required evidence |
|---|---|
| Stock compatibility | Upstream HarnessRouter tests and UHP conformance pass; requests without the configured metadata key are unchanged. |
| Caller authentication | Every unauthenticated external create, continuation, retrieval, stream, cancellation, file, and artifact request fails before resource existence or metadata disclosure; runner operations are private and mutually authenticated. |
| Hook ordering | Dedicated materialization finishes, publishes, and checkpoints before provider selection; fallback never reruns it. |
| Durable state | Fault injection proves only sessions with matching bound descriptor, published marker, and durable checkpoint become ready; missing/corrupt/mismatched evidence fails non-resumable without replay. |
| Session continuity | Two real turns share native conversation, writable workspace, and the persisted auth-binding identity/digest; continuation omits the extension. A changed or unavailable binding fails before runner work. |
| Workspace integration | Safe nested cwd, repository-mode root/nested Git checkpoints, snapshot private tree baselines, produced list/file/ack, hydrate, and initial-source suppression pass. |
| Git acquisition | Closed transport/config policy, constrained revisions, exact commits, non-root destinations, catalog validation, and partial cleanup pass against local HTTPS remotes. |
| OCI acquisition | Digest/media/path/link/type/limit matrix passes against a real local registry. |
| Credential boundary | Every configured source secret and the HarnessRouter caller key are absent from the base service and every agent-readable source/session path, checkpoint, log, and public output. The selected OAuth profile is available inside the documented harness owner-trust boundary; other profiles are inaccessible, and an inert-agent probe proves the gateway/runner never serializes the auth file automatically. |
| Provider boundary | Codex and Pi login, live-turn, atomic local refresh, crash/stale-profile repair, bound continuation, serialized overlapping turns, and failure probes use harness-native OAuth without a provider-route API key. OAuth failure never changes profile or auth mode. A separate proxy broker permits bounded in-turn calls and rejects wrong-scope, expired, or revoked tokens. |
| Lifecycle | Streaming, cancellation, idempotency, artifacts, usage, response metadata, completed restart, and interrupted-work failure match the contract. |
| Packaging | The public `linux/amd64` GHCR manifest and GitHub/Sigstore build-provenance and SBOM attestations are verified for expected owner, repository, workflow, approved ref, subject digest, predicates, base-image digest, runtime lockfiles, OS packages, Git/OCI tools, and harness versions. Deployment uses that digest and publishing needs no Docker Hub credential. |
| Consumer | Promptfoo one-shot/two-turn Git/OCI success and materializer/agent failure mappings pass. |
| Review | Final review findings in both repositories are resolved before the final built-image E2E. |

## Definition of Done

- ADR 0002, this plan, implementation, deployment topology, and request examples
  agree on UHP, the fork, the behind-router materializer, harness-native OAuth,
  explicit proxy fallback, and GHCR digest-pinned distribution.
- No second execution protocol, parallel task/session control plane, separate
  AllAgents gateway, direct provider adapter, custom OAuth broker, automatic
  auth-mode fallback, or client-side workspace expansion remains in
  implementation scope.
- R1-R15 and AE1-AE13 are implemented and verified against the exact released
  image.
- Stock UHP requests and upstream conformance remain green. Every external
  create/read/control/file/artifact path requires the HarnessRouter caller key;
  runner operations remain private and mutually authenticated.
- Git and OCI materialization publish and checkpoint before provider dispatch and
  happen exactly once per extension-bearing session.
- Continuation preserves native conversation/workspace state and the persisted
  auth-binding identity/digest, omits the extension, and follows HarnessRouter's
  predecessor semantics. A changed or unavailable binding fails before runner
  work. Every native auth profile serializes refresh-capable turns. Local refresh
  writes are atomic and validated; a stale credential after remote rotation
  becomes `repair-required` rather than changing profile or auth mode.
- Repository-mode roots preserve usable Git state. Every source mode preserves
  truthful root/nested produced files across checkpoint/hydrate.
- Source credential values are read from an owner-only runner secret source and
  injected only into the selected materializer child; they never enter the
  gateway/runner base environment or harness. Provider OAuth is available inside
  the explicitly accepted owner-trust boundary; the gateway/runner never
  automatically persists the auth file in session state or public metadata.
  Long-lived proxy client keys remain brokered, and turn tokens enforce audience,
  target, model, turn, expiry, and revocation while permitting bounded in-turn
  provider calls.
- The public `linux/amd64` GHCR manifest, verified build-provenance and SBOM
  attestations, pinned base/runtime/OS/Git/OCI/harness inputs, patch series,
  materializer contract, operational docs, and rollback procedure are
  reproducible from pinned inputs.
- The generic HarnessRouter hook patch is ready to propose upstream, but the
  shipped system remains operable from the maintained fork if it is not accepted.
