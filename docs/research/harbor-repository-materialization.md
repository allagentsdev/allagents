# Harbor repository materialization lessons

## Current conclusion

Treat this note as future-adapter evidence only. Harbor, Terminal-Bench, and
SWE-bench integration are not part of the current v1 contract or plan. Harbor
can still inform a later design because it packages an instruction,
environment, workdir, test script, and reward artifact around one disposable
task, but it must not mediate ordinary Promptfoo Git/OCI runs or become a core
source kind.

Any future integration requires its own ADR and closed adapter request/result
mapping. That decision must define provenance, bounded complete/partial
evidence, artifact authorization/expiry, cancellation, cleanup-gated
publication, and how Promptfoo consumes raw observations. It must not reuse or
extend the current v1 request/result schemas without an explicit future contract
decision. Harbor may own its sandbox and checks, but the gateway must
not convert Harbor scores into pass/fail or reward.

The current boundary is defined by
[One-shot coding-agent gateway boundary](./one-shot-coding-agent-gateway-boundary.md)
and [ADR 0002](../decisions/0002-use-allagents-gateway-for-one-shot-runs.md).

## What Harbor fetches

### Task packages from Git

Harbor's `GitRepoRegistryClient` resolves a dataset registry ref, inspects the selected
commit's tree without checking out blobs, and identifies task directories containing
`task.toml`. When task content is requested, `TaskClient` groups requested task paths by
Git URL and performs one shallow, no-checkout clone per URL. It uses a blobless partial
clone where supported, configures sparse checkout for only the selected task paths,
fetches each requested commit at depth one, checks it out, and records the resolved
commit.

This is efficient for a large repository containing many independent Harbor tasks. It
is not a mechanism for assembling several application repositories into one agent
workspace.

Harbor also accepts an omitted commit or a mutable ref and resolves it to a
commit. AllAgents permits a caller to override a declared repository with a
branch, tag, or commit for developer convenience, but resolves and records the
full commit before agent execution. Reproducibility-sensitive callers use a full
commit; OCI snapshots remain digest-pinned at admission.

### Task packages from the package registry

Package-registry tasks are downloaded as tar archives into a cache keyed by the task's
content hash. A direct `sha256:` reference can hit that cache without registry
resolution. Dataset manifests likewise refer to task packages by SHA-256 digest. This
is the closest Harbor analogue to an OCI workspace snapshot: a content-addressed,
reusable input bundle.

Before publishing a Git task directory, Harbor stages it in a temporary directory,
rejects source paths containing symlinks, materializes only relative symlinks that stay
inside the task root, rejects cycles and special entries, then replaces the target.
Those containment and publish-after-validation properties are useful for any cached
workspace artifact.

### The repository edited by the agent

Once the task package is present, Harbor asks the selected environment provider to
start the task's `environment/` definition. For Docker this can be:

- `[environment].docker_image`;
- `environment/Dockerfile`; or
- `environment/docker-compose.yaml`.

The task format deliberately leaves the environment flexible. Harbor builds the
Dockerfile/Compose definition or uses the prebuilt image, then runs the agent in that
environment. There is no core repository-source schema carrying URL, exact commit,
destination, and per-repository provenance.

The Multi-SWE-bench adapter makes the distinction concrete. Each generated task uses
an upstream `mswebench/...:pr-...` base image that already contains the repository at
`/home/{repo_name}`. Its Dockerfile creates `/workspace/{repo_name}` as a symlink and
sets that as `WORKDIR`; Harbor itself never clones that application repository.

## Superseded materializer lessons (historical)

The sections below preserve conclusions from the rejected builder/snapshot
architecture. They are evidence about Harbor's implementation, not current
recommendations for the evaluation-only runner.

### Adopt

1. **Separate descriptor acquisition from execution.** Resolve and validate immutable
   inputs before starting the coding-agent runtime.
2. **Use content-addressed snapshot caches.** Key reusable OCI workspace
   snapshots by their immutable OCI and workspace-manifest digests. Direct Git
   mode resolves revisions independently and records the resulting commits.
   Reauthorize every remote acquisition.
3. **Avoid downloading irrelevant content.** For Git-backed descriptor catalogs,
   Harbor's tree-only discovery and sparse checkout are sound optimizations. For an
   application repository, use partial/shallow acquisition only when it preserves the
   required commit and evidence semantics.
4. **Stage, validate, then publish.** Materialize into a temporary location, enforce
   path/link/type/size limits, verify every requested identity, and atomically expose
   the completed workspace to the worker.
5. **Support prebuilt immutable artifacts.** A digest-pinned OCI workspace snapshot is
   the scalable path for very large repositories and expensive setup.

### Adapt

Keep a first-class workspace manifest instead of hiding source inside an
environment image. Each materialized repository or snapshot should retain at
least:

- canonical source URL or configured snapshot identity;
- requested revision and resolved commit, or OCI manifest digest;
- destination path and optional source subdirectory;
- acquisition implementation identity;
- resulting tree/content identity; and
- completeness and verification-versus-attestation facts.

Use exactly two initial source modes:

1. **Direct declared Git repositories** for the normal case. A request selects
   configured repository names and may override only their revisions. The
   materializer resolves and records full commits and enforces collision-free
   destinations.
2. **Named OCI workspace snapshots** for large, preassembled workspaces. The
   project workspace declares the repository; the request supplies immutable
   OCI and workspace-manifest digests.

Both modes produce the same standard workspace manifest. Neither mode falls
through to the other after admission.

### Do not copy

- Unresolved mutable Git refs as terminal execution identities. Branch and tag
  overrides are valid only when the materializer resolves and records a full
  commit before agent execution.
- Mutable OCI tags or package `latest` as accepted snapshot identities.
- Harbor's broad Git transport set (`http`, `ssh`, and `git` as well as HTTPS) at
  the materializer boundary. AllAgents permits only canonical credential-free
  HTTPS with configured hosts, disabled redirects/helpers/filters/hooks/
  submodules, and full-commit verification.
- A non-fatal Git LFS miss. If declared workspace content cannot be materialized,
  preparation fails before agent execution.
- Hashing a prebuilt image reference string as environment identity. Resolve and
  pin the OCI manifest digest.
- Arbitrary task-authored Dockerfiles, Compose files, or public-network setup as
  caller input. Harbor runs benchmark definitions trusted by the evaluator;
  AllAgents accepts authenticated service requests with a different trust
  boundary.
- Treating a container image alone as sufficient provenance. An image can carry the
  correct files while obscuring which repositories, commits, generator, and setup
  produced them.

## Future-adapter questions

Before implementing any Harbor, Terminal-Bench, or SWE-bench adapter:

1. Write a dedicated ADR and closed adapter request/result mapping. Do not add a
   Harbor source kind or field to the current `AgentRun v1` schemas.
2. Decide and specify who owns the sandbox, agent invocation, checks,
   cancellation, cleanup, and terminal publication. Do not imply direct-mode
   isolation governed a Harbor-owned sandbox.
3. Define authoritative registry/task/version/environment provenance and, where
   a runtime profile exists, immutable profile/image/tool/service implementation
   digests.
4. Preserve bounded raw complete/partial agent and check evidence without
   translating Harbor scores into gateway pass/fail or reward.
5. Define authenticated expiring artifact access and consumer digest/size
   verification.
6. Prove cleanup before terminal result visibility and define the
   infrastructure-error behavior for Harbor outages and cleanup failure.
7. Keep direct Promptfoo runs independent of Harbor and let Promptfoo assertions
   or graders make every behavioral judgment.

The practical conclusion is narrow: Harbor is useful primary-source evidence
for content-addressed task packages, isolated tasks, and colocated checks. None
of Harbor, Terminal-Bench, or SWE-bench is an approved current adapter, control
plane, provenance variant, or result contract. They do not justify reusable
sessions.

## Primary sources

Inspected Harbor commit
[`b83e7686999a18ba90a8603794d7d18d42cab010`](https://github.com/harbor-framework/harbor/tree/b83e7686999a18ba90a8603794d7d18d42cab010):

- [`src/harbor/registry/client/git_repo.py`](https://github.com/harbor-framework/harbor/blob/b83e7686999a18ba90a8603794d7d18d42cab010/src/harbor/registry/client/git_repo.py) — ref resolution, tree-only discovery, and sparse registry checkout.
- [`src/harbor/tasks/client.py`](https://github.com/harbor-framework/harbor/blob/b83e7686999a18ba90a8603794d7d18d42cab010/src/harbor/tasks/client.py) — Git/local/package task acquisition, content-hash cache, LFS behavior, safe staging, and resolved commits.
- [`src/harbor/models/task/id.py`](https://github.com/harbor-framework/harbor/blob/b83e7686999a18ba90a8603794d7d18d42cab010/src/harbor/models/task/id.py) — Git, local, and package task identities.
- [`src/harbor/models/dataset/manifest.py`](https://github.com/harbor-framework/harbor/blob/b83e7686999a18ba90a8603794d7d18d42cab010/src/harbor/models/dataset/manifest.py) — digest-addressed dataset task references.
- [`docs/content/docs/tasks/index.mdx`](https://github.com/harbor-framework/harbor/blob/b83e7686999a18ba90a8603794d7d18d42cab010/docs/content/docs/tasks/index.mdx) — task structure and Docker image/Dockerfile/Compose environment contract.
- [`src/harbor/environments/definition.py`](https://github.com/harbor-framework/harbor/blob/b83e7686999a18ba90a8603794d7d18d42cab010/src/harbor/environments/definition.py) — environment selection and content identity.
- [`src/harbor/environments/docker/docker.py`](https://github.com/harbor-framework/harbor/blob/b83e7686999a18ba90a8603794d7d18d42cab010/src/harbor/environments/docker/docker.py) — prebuilt-image versus build behavior and container startup.
- [`adapters/multi-swe-bench/README.md`](https://github.com/harbor-framework/harbor/blob/b83e7686999a18ba90a8603794d7d18d42cab010/adapters/multi-swe-bench/README.md) and its [`environment/Dockerfile`](https://github.com/harbor-framework/harbor/blob/b83e7686999a18ba90a8603794d7d18d42cab010/adapters/multi-swe-bench/src/multi_swe_bench_adapter/task-template/environment/Dockerfile) — application repository supplied by an upstream prebuilt image rather than cloned by Harbor core.
