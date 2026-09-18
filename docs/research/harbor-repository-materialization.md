# Harbor repository materialization lessons

## Decision

Borrow Harbor's content-addressed package cache, sparse Git reads, staged publication,
and prebuilt-environment option. Do not copy its task model as the execution gateway's
workspace contract.

Harbor does not expose a first-class, general-purpose "repositories in a workspace"
layer. It first downloads a Harbor **task package**. The task then defines an execution
environment with a Dockerfile, Compose file, or prebuilt image. Acquisition of the
repository the agent edits is therefore benchmark- and task-owned: it may be baked into
an image, cloned by a Dockerfile, copied as task content, or otherwise prepared by the
task author.

For AllAgents, repository and workspace provenance must remain explicit in the public
execution request and terminal evidence. Custom acquisition should be an
operator-registered, digest-pinned materializer behind the worker protocol, not an
arbitrary caller-supplied image or setup script.

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

Harbor also accepts an omitted commit or a mutable ref and resolves it to a commit.
That is convenient for an interactive local benchmark CLI, but it is weaker than the
AllAgents gateway requirement that an accepted request already name immutable source.

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

## Lessons for the AllAgents execution gateway

### Adopt

1. **Separate descriptor acquisition from execution.** Resolve and validate immutable
   inputs before starting the coding-agent runtime.
2. **Use content-addressed caches.** Key reusable workspace snapshots by a digest of
   normalized source identities, materializer version/digest, setup policy, current
   authorization scope, and revocation epoch rather than a mutable name. Reauthorize
   before lookup and make an old epoch ineligible after revocation.
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

Keep a first-class workspace manifest instead of hiding source inside an environment
image. Each materialized repository should retain at least:

- canonical source URL or snapshot identity;
- requested and resolved immutable commit or OCI digest;
- destination path and optional source subdirectory;
- materializer identity and version/digest;
- resulting tree/content identity;
- cache hit/miss and completeness facts.

Use three explicit source modes:

1. **Direct Git repositories** for the normal case, each with an exact commit and
   collision-free destination.
2. **OCI workspace snapshots** for large, preassembled workspaces, referenced by digest
   rather than tag and accompanied by a signed/validated workspace manifest.
3. **Operator-registered materializers** for JFrog, unusual monorepos, generated source,
   or organization-specific setup. A request selects a configured materializer ID,
   pins the expected workspace-manifest digest, and supplies validated,
   resource-authorized structured inputs. The operator configuration pins the builder
   image by digest, the worker derives the non-secret definition digest, credentials are
   scoped only to materialization, and the builder must produce the standard workspace
   manifest before the agent starts. The builder is operator-trusted deployment code;
   deployments that cannot grant that trust need a broker or stronger acquisition
   service.

This retains Harbor's useful task-owned flexibility without allowing a caller to choose
an arbitrary executable image or shell script inside the trusted worker.

### Do not copy

- Mutable Git refs, `HEAD`, image tags, or package `latest` as accepted execution
  identities.
- Harbor's broad Git transport set (`http`, `ssh`, and `git` as well as HTTPS) at a
  remote service boundary. The gateway should keep canonical credential-free HTTPS,
  destination-policy revalidation, disabled redirects/helpers/filters/hooks/submodules,
  and exact commit verification.
- A non-fatal Git LFS miss. If declared workspace content cannot be materialized,
  preparation must fail before provider execution.
- Hashing a prebuilt image reference string as environment identity. Resolve and pin
  the OCI manifest digest.
- Arbitrary task-authored Dockerfiles, Compose files, or public-network setup as caller
  input. Harbor runs benchmark definitions trusted by the evaluator; the gateway
  accepts remote service requests and has a different threat boundary.
- Treating a container image alone as sufficient provenance. An image can carry the
  correct files while obscuring which repositories, commits, generator, and setup
  produced them.

## Recommended boundary

The worker should execute a dedicated materialization phase before any harness starts:

1. Validate the normalized workspace request, exact source-resource authorization,
   configured materializer, and current authorization scope before any cache lookup.
2. Resolve phase-scoped source credentials without exposing them to setup, the model,
   or later evidence.
3. Populate a worker-owned staging directory on the final publication filesystem or
   pull and unpack a digest-pinned workspace snapshot there.
4. Verify repository commits, paths, limits, content, the expected manifest digest,
   and the standard workspace manifest; distinguish worker-verified identities from
   materializer-attested claims.
5. Stop the acquisition process, revoke credentials, remove its mounts and runner
   resource, and retain only the validated host-owned staging tree.
6. Atomically rename that tree into the final workspace, record provenance, run
   operator-owned setup, record the post-setup baseline, and only then launch the
   harness-specific worker runtime.

The practical conclusion is narrow: Harbor is strong evidence for content-addressed
input bundles and environment-provider indirection. It is not evidence for making
repository acquisition opaque or task-defined in the AllAgents public contract.

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
