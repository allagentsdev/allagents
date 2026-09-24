# Workspace contract incumbents

## Decision

AllAgents should **not** replace its execution-gateway workspace descriptor with Harbor, Devfile, Dev Containers, E2B, Daytona, GitHub Codespaces, or Gitpod. No examined contract standardizes the same boundary: caller-selected Git or OCI source, deterministic materialization, attachment before the harness starts, a logical working directory, and immutable resolved provenance returned only after attachment is committed.

The closest portable **source-layout precedent** is Devfile 2.3's `projects` model. The closest field-level operational API is Daytona's Git clone operation. GitHub Codespaces and Gitpod Classic are stronger examples of products that bind source acquisition to workspace lifecycle, but both are provider-specific. None is a compatible normative replacement.

The recommended contract stack is therefore:

1. **Northbound execution protocol:** UHP remains the sole request/response protocol.
2. **Workspace/source descriptor:** retain `metadata["allagents.workspace"]` version 1 as an AllAgents-owned extension.
3. **Runtime sandbox:** keep provider APIs behind the gateway; Harbor ASP is a promising future runtime seam, not a workspace descriptor.
4. **Immutable artifacts:** use Git commit identity and OCI Image Specification descriptors/manifests as the normative identities, while retaining the AllAgents workspace manifest and attachment result as the binding provenance record.

Devfile should be cited as design precedent for repository URL/revision/destination concepts, not claimed as an implemented profile or conformance target.

## The four contracts are different

| Layer | AllAgents boundary | Best established precedent | Assessment |
| --- | --- | --- | --- |
| Northbound execution | UHP requests, events, results, cancellation, and continuation | UHP | Already selected. A workspace standard should not displace the execution protocol. |
| Workspace/source descriptor | `{url, ref?, destination}` or an OCI snapshot, plus `workingDirectory` | Devfile `projects` is the closest portable schema; Codespaces/Gitpod are product precedents | No incumbent covers AllAgents' complete semantics. Keep the extension. |
| Runtime sandbox | Process, filesystem, network, and lifecycle implementation behind the gateway | Harbor ASP, E2B, Daytona, Dev Containers | These contracts start at or after sandbox provisioning. They can inform or implement the southbound seam without becoming the northbound source contract. |
| Immutable artifacts | Resolved Git commit or OCI manifest digest, canonical workspace manifest, committed attachment metadata | Git object identity and OCI Image Specification 1.1.1 | Adopt the artifact standards directly. No workspace incumbent supplies the complete result record. |

This separation matters. Choosing one product contract across all four layers would either expose provider operations northbound or weaken the source and provenance guarantees already specified in [ADR 0002](../decisions/0002-adopt-uhp-through-harnessrouter.md) and the [execution-gateway implementation plan](../plans/2026-09-18-0837-feat-coding-execution-gateway-plan.md).

## Current AllAgents contract to preserve

The current design has a small request surface and a comparatively strong result contract:

- A repository source has a canonical public HTTPS `url`, optional `ref`, and required unique non-root relative `destination`. A request may contain multiple repositories.
- Omitted `ref` means the remote symbolic HEAD; a supplied ref is resolved fail-closed to a full commit. The result preserves both requested and resolved identities.
- An OCI workspace source is selected by immutable image/workspace-manifest digests from an operator-owned snapshot catalog.
- `workingDirectory` is a logical union: `workspaceRoot`, or `workspacePath` with a relative path that must be a directory in the verified workspace manifest. It is not a host path or provider mount path.
- Source credentials and policy are server-owned and limited to acquisition. They are not request fields or agent environment variables.
- Materialization and attachment complete before initial UHP files or the provider process are admitted. Public provenance is emitted only after the gateway has committed a `ready` attachment and the runner has acknowledged or reserved it.
- Continuations reuse the exact descriptor, attachment, access mode, retention, working directory, harness, and authorization context rather than accepting a new source request.

The comparison below treats those properties as requirements rather than matching field names alone.

## Incumbent comparison

### Harbor: benchmark materialization incumbent, not a direct invocation schema

Harbor absolutely materializes runnable workspaces. Its `--repo` input clones a benchmark repository from GitHub, GitLab, or Hugging Face, optionally pinned to a branch, tag, or commit. Each selected task then supplies an instruction, verifier, and environment. The environment can be built from a Dockerfile or Compose file or pulled as a prebuilt image through `environment.docker_image`; `environment.workdir` selects the command working directory. A `BaseEnvironment` provider starts that filesystem and exposes execution and file-transfer operations to the agent and verifier.

The important distinction is between two repositories that coding benchmarks often collapse:

1. the **benchmark/task repository**, selected by Harbor `--repo`, which contains `task.toml`, instructions, environment definitions, and tests; and
2. the **target application repository**, which is normally baked into the task image or acquired by task-authored environment setup.

Harbor has a strong, reusable contract for the first item and for the resulting runnable environment. Its Git dataset identifier does not independently describe an arbitrary set of target repositories, their checkout destinations, source credentials, or the resolved provenance returned to a caller. The prebuilt image field likewise selects the whole task environment rather than a workspace source artifact with a separately verified manifest. An AllAgents source artifact may preserve normalized offline Git history, but it still excludes tools, services, verifier assumptions, and runtime configuration.

AllAgents should therefore follow Harbor's **architecture** for benchmark interoperability: immutable task packages, prebuilt OCI environments, explicit workdir/resources/network policy, isolated trials, and verifier separation. A Harbor adapter can compile a selected task and environment into the AllAgents execution inputs. The Harbor task schema should not replace the smaller direct-execution descriptor used when a caller supplies target repositories or a workspace snapshot without a benchmark package.

Harbor's newer [Agent Sandbox Protocol (ASP)](https://docs.harborframework.com/core-concepts/sandboxes/asp) is a separate layer. Its draft v0 `.asp.json` describes an already provisioned sandbox reachable over SSH and supplies an absolute sandbox workspace path. It standardizes harness-to-sandbox execute/read/write behavior, explicitly leaving provisioning to the orchestrator. ASP may become a useful southbound runtime adapter, but it does not specify how Git or OCI content becomes that workspace.

Primary evidence: [Git datasets](https://docs.harborframework.com/core-concepts/datasets/git-repos), [task packages](https://docs.harborframework.com/core-concepts/tasks/overview), [environment materialization](https://docs.harborframework.com/core-concepts/tasks/environment), [task configuration](https://docs.harborframework.com/core-concepts/tasks/configuration), pinned [task config](https://github.com/harbor-framework/harbor/blob/cdb76bae6dc88d5bca1c8f0754bbba300d6574b4/src/harbor/models/task/config.py), [job config](https://github.com/harbor-framework/harbor/blob/cdb76bae6dc88d5bca1c8f0754bbba300d6574b4/src/harbor/models/job/config.py), and [Git acquisition](https://github.com/harbor-framework/harbor/blob/cdb76bae6dc88d5bca1c8f0754bbba300d6574b4/src/harbor/registry/client/git_repo.py).

### Hugging Face and SWE-bench: registry plus specialized materializer

Hugging Face also participates in real workspace materialization, but the responsibility is split. The Hub stores every dataset as a Git repository. A SWE-bench dataset row then identifies the target GitHub repository with `repo`, pins its state with `base_commit`, and can provide `environment_setup_commit`, patches, tests, and issue text. The SWE-bench harness converts that benchmark record into layered Docker artifacts—base, repository environment, and per-instance images—then starts the instance image, applies the model patch, runs tests, and grades the result.

That is a concrete and widely used Git-to-OCI workspace pipeline. Hugging Face itself supplies registry and dataset-repository contracts; SWE-bench supplies the coding-task schema and execution harness. Neither exposes one general multi-repository invocation schema. SWE-bench is intentionally specialized to one repository/base commit and its test-transition metadata.

For compatibility, an AllAgents benchmark adapter should map a SWE-bench `repo` plus `base_commit` to repository mode. A prepared instance image must instead pass through a future task/environment boundary, or an importer must extract its checkout into a `workspaceSnapshot` with a separately verified workspace manifest. The importer may preserve normalized Git history for offline evaluation, but it must remove remotes, credentials, and unsafe administrative state. The adapter must never register the runnable image itself as a workspace snapshot. This is an ingestion mapping, not a reason to replace the direct descriptor: AllAgents still needs multiple destinations, Git-or-OCI selection, strict credential and egress policy, continuation binding, and resolved attachment provenance.

Primary evidence: the [SWE-bench dataset schema on Hugging Face](https://huggingface.co/datasets/princeton-nlp/SWE-bench), [Hugging Face dataset repository model](https://huggingface.co/docs/hub/datasets-overview), and [SWE-bench evaluation harness](https://www.swebench.com/SWE-bench/reference/harness).

### Devfile 2.3: closest portable source-layout precedent

Devfile is the strongest portable comparison. It is a CNCF Sandbox project with an open governance process and documented implementations including Eclipse Che and `odo`. Its normative schema defines `projects[]` with:

- a required project `name`;
- `git.remotes`, mapping remote names to URLs;
- optional `checkoutFrom.remote` and `checkoutFrom.revision`;
- optional relative `clonePath`, defaulting to the project name; and
- ZIP sources as an alternative to Git.

This is a clear semantic match for source URL, revision, and destination. Devfile also defines a projects root and projects are mapped into runtime components through `sourceMapping`.

It is not a safe wholesale replacement:

- The schema permits multiple named remotes where AllAgents deliberately accepts one canonical source URL per repository.
- Devfile's revision description permits the default branch when the requested revision is absent or not found; AllAgents requires a supplied ref to fail closed.
- `clonePath` is optional and defaults from the project name; AllAgents requires an explicit collision-checked destination.
- ZIP sources have no required content digest. There is no OCI workspace-source variant.
- Devfile has no standard resolved-commit result, canonical source-visible manifest, generation identity, or attachment-commit acknowledgement.
- Runtime implementations own credential behavior. The DevWorkspace Operator, for example, may expose configured Git credentials to workspace containers; that is weaker than acquisition-only credentials.
- Devfile lifecycle events and component `sourceMapping` configure a development environment. They do not define the UHP timing rule that source is attached before the harness starts and metadata appears only after attachment commit.

AllAgents should cite and follow Devfile's vocabulary where it fits, while preserving stricter semantics:

| AllAgents | Devfile precedent | Decision |
| --- | --- | --- |
| `url` | `projects[].git.remotes.<name>` | Keep one canonical public HTTPS URL; do not import named-remote ambiguity. |
| `ref` | `checkoutFrom.revision` | Keep `ref`, strict resolution, and requested/resolved identity. Do not adopt fallback-on-miss behavior. |
| `destination` | `clonePath` | Treat this as the closest direct precedent, but keep it required and collision checked. |
| `workspaceRoot` | projects root / `$PROJECTS_ROOT` | Same conceptual root; keep the typed logical value rather than exposing a container path. |
| `workspacePath` | component `sourceMapping` is adjacent, not equivalent | Keep manifest-verified relative path semantics. |
| resolved Git/OCI provenance | no equivalent | Retain the AllAgents result model. |

Primary evidence: the pinned [Devfile 2.3 JSON Schema](https://github.com/devfile/api/blob/v2.3.0/schemas/latest/devfile.json), [schema reference](https://devfile.io/docs/2.3.0/devfile-schema), [project authoring guide](https://devfile.io/docs/2.3.0/adding-projects), [governance](https://github.com/devfile/api/blob/v2.3.0/GOVERNANCE.md), [CNCF project record](https://www.cncf.io/projects/devfile/), [documented users](https://devfile.io/docs/2.3.0/users-of-devfile), and the DevWorkspace Operator's pinned [Git-credential behavior](https://github.com/devfile/devworkspace-operator/blob/9df10c1baba8e7d88948a21077e3a06fd2cca639/docs/additional-configuration.adoc).

### Development Containers: environment standard, not source standard

The Development Container Specification assumes a project workspace/source folder already exists. It standardizes how that folder is mounted or opened in an image-, Dockerfile-, or Compose-based development container. Relevant fields include `workspaceMount`, `workspaceFolder`, image/build/Compose selection, Features, and ordered lifecycle commands.

`workspaceFolder` is a container/editor path, not a source descriptor. `workspaceMount` is a runtime mount expression, not a portable source identity. Lifecycle hooks run after implementations have made source available, and the specification does not define repository URL/ref/destination, Git resolution, OCI workspace snapshots, or a resolved provenance response. Feature lockfiles add integrity for Dev Container Features, not for the application workspace.

This is the most credible portable standard for a possible future **development-environment layer**, with official support listed for VS Code, Visual Studio, IntelliJ, the reference CLI, GitHub Codespaces, CodeSandbox, DevPod, and Ona. It should not be stretched into the acquisition layer.

Primary evidence: pinned [normative specification](https://github.com/devcontainers/spec/blob/c95ffeed1d059abfe9ffbe79762dc2fa4e7c2421/docs/specs/devcontainer-reference.md), [JSON Schema](https://github.com/devcontainers/spec/blob/c95ffeed1d059abfe9ffbe79762dc2fa4e7c2421/schemas/devContainer.base.schema.json), [field and lifecycle reference](https://github.com/devcontainers/spec/blob/c95ffeed1d059abfe9ffbe79762dc2fa4e7c2421/docs/specs/devcontainerjson-reference.md), [supporting tools](https://github.com/devcontainers/spec/blob/c95ffeed1d059abfe9ffbe79762dc2fa4e7c2421/docs/specs/supporting-tools.md), and [contribution process](https://github.com/devcontainers/spec/blob/c95ffeed1d059abfe9ffbe79762dc2fa4e7c2421/CONTRIBUTING.md).

### E2B and Daytona: runtime providers with clone operations

E2B creates a sandbox from a template and exposes filesystem, process, pause/resume, snapshot, and Git operations. Its sandbox-creation schema has template, timeout, network, metadata, environment, MCP, IAM, and volume fields, but no repository source. Git clone is a runtime SDK operation with URL/path/branch/depth and inline credentials. E2B warns that credentials stored in the sandbox are readable by the agent. E2B is consequently a possible runtime backend, not an agent-neutral execution or workspace contract.

Daytona is the closest field-level operational match: its Git clone operation accepts `url`, `path`, optional branch or commit, credentials, depth, and an insecure-TLS option. But this is an imperative operation against an already-created Daytona sandbox. It does not standardize multi-source declaration, strict canonicalization, immutable result provenance, or committed attachment timing. Its per-operation credentials and optional TLS bypass also conflict with the AllAgents trust boundary. Older Daytona workspace models coupled repository metadata, devcontainer/build configuration, and provider workspace state, illustrating the portability cost of adopting a vendor workspace object.

Primary evidence: pinned E2B [OpenAPI schema](https://github.com/e2b-dev/E2B/blob/ccaf9fc0ffe6ac39c7ec786af7608ab1de19467b/spec/openapi.yml), [sandbox SDK](https://docs.e2b.dev/sdk-reference/js-sdk/v2.51.0/sandbox), [template definition](https://docs.e2b.dev/template/defining-template), [Git integration](https://docs.e2b.dev/sandbox/git-integration), Daytona [Git operations](https://www.daytona.io/docs/en/git-operations), and pinned Daytona [workspace](https://github.com/daytonaio/daytona/blob/dfb50e8a31e9a93b31181113d7b44b657cf27168/pkg/models/workspace.go), [repository](https://github.com/daytonaio/daytona/blob/dfb50e8a31e9a93b31181113d7b44b657cf27168/pkg/apiclient/model_git_repository.go), and [workspace-creation](https://github.com/daytonaio/daytona/blob/dfb50e8a31e9a93b31181113d7b44b657cf27168/pkg/apiclient/model_create_workspace_dto.go) models.

### GitHub Codespaces and Gitpod Classic: lifecycle precedents, not portable standards

GitHub Codespaces creates a managed environment in the context of a GitHub repository. Its repository-scoped REST endpoint accepts `ref`, machine/location choices, `devcontainer_path`, `working_directory`, idle timeout, and retention. The repository is implied by the endpoint and the service delegates environment setup to Dev Containers. This is strong evidence for resolving source before environment startup and for treating working directory separately from source identity. It is not suitable as the AllAgents descriptor because it is GitHub-specific, single-repository, and does not expose the same resolved Git/OCI provenance or attachment transaction.

Gitpod Classic/Ona similarly combines a context URL with workspace initialization and supports `additionalRepositories` plus checkout locations in `.gitpod.yml`. It is a useful product precedent for multiple checkouts, but its API and configuration are service-specific and mix source, image/build, and task lifecycle concerns.

Primary evidence: GitHub's [create-codespace REST operation](https://docs.github.com/en/rest/codespaces/codespaces?apiVersion=2022-11-28#create-a-codespace-in-a-repository), [Codespaces CLI](https://cli.github.com/manual/gh_codespace_create), [Dev Container introduction](https://docs.github.com/en/codespaces/setting-up-your-project-for-codespaces/adding-a-dev-container-configuration/introduction-to-dev-containers), Gitpod Classic's [public API](https://ona.com/docs/classic/user/references/gitpod-public-api), and [`.gitpod.yml` reference](https://ona.com/docs/classic/user/references/gitpod-yml).

## Normative artifact standards

The source descriptor should remain AllAgents-owned, but its immutable artifact identities should not be invented locally.

For OCI snapshots, the [OCI Image Specification 1.1.1 descriptor](https://github.com/opencontainers/image-spec/blob/v1.1.1/descriptor.md) defines content identity with media type, digest, and size, including verification against the digest. The [image manifest](https://github.com/opencontainers/image-spec/blob/v1.1.1/manifest.md) defines the config descriptor and ordered layer descriptors. Those are the correct normative identities for the snapshot artifact. OCI does not define the source-visible workspace tree, destination layout, logical working directory, or the semantic state of an embedded Git repository. The AllAgents workspace manifest therefore declares each repository root as tree-only or history-bearing. A history-bearing root records its resolved commit and canonical object-set digest, while the runner verifies the offline `.git` state and absence of remotes.

For Git, a full commit object ID is the resolved source identity. The request still needs the original ref because a branch/tag name and its resolved commit answer different audit questions. OCI snapshot provenance instead retains the verified `snapshotName` and `imageManifestDigest`; each history-bearing root adds only its destination, resolved commit, and object-set digest, with no repository URL or requested ref. Neither Git nor OCI defines when a runner has successfully attached that content, so `effectiveDescriptorDigest`, `generationId`, `sourceIdentity`, `workingDirectory`, and `workspaceManifestDigest` must remain AllAgents result fields.

## Recommendation and adoption rule

Adopt the following rule for future changes:

- **Normative:** UHP northbound; AllAgents workspace extension for acquisition and attachment; Git commit identity and OCI Image Specification 1.1.1 for immutable artifacts.
- **Benchmark compatibility:** ingest Harbor task packages and SWE-bench/Hugging Face records through adapters. Preserve Harbor's task/environment/verifier split and its preference for prebuilt OCI environments; map benchmark source identities into the canonical AllAgents descriptor.
- **Source-layout precedent:** use Devfile 2.3 `projects` semantics when adding or naming direct repository fields. Document intentional divergence, especially for URL shape, revision behavior, and destination paths.
- **Runtime precedent:** evaluate Harbor ASP as a southbound execute/filesystem adapter when its draft stabilizes. E2B and Daytona remain provider adapters. Dev Containers may define an optional environment-building layer after source acquisition.
- **Do not conflate:** Harbor's benchmark repository with the target application source; a runnable environment image with a workspace source snapshot, even when the snapshot preserves Git history; or a vendor sandbox/codespace object with the northbound contract. Do not adopt Devfile's default-on-missing revision behavior, ZIP-without-digest source, or runtime credential exposure.

This is deliberately a layered answer rather than a claim that AllAgents has invented a universal workspace standard. The narrow extension exists because the examined standards stop either before source acquisition or before committed, immutable provenance.

## Existing research status

- [Harbor repository materialization](./harbor-repository-materialization.md) correctly identifies Harbor's task-repository cloning, package cache, staged publication, and prebuilt-environment model. Its statement that Harbor lacks a first-class arbitrary target-repository layer remains accurate, but should not be read as saying Harbor lacks workspace materialization. Its descriptions of AllAgents selecting configured repository names or overriding a declared repository ref are stale: current Git mode accepts caller-supplied canonical public HTTPS URLs; only OCI snapshots use the operator-owned catalog.
- [E2B execution-gateway patterns](./e2b-execution-gateway-patterns.md) remains correct that E2B is a runtime provider rather than a replacement northbound protocol. Its description of a server-authoritative logical source catalog is stale for Git sources and remains applicable only to the OCI snapshot catalog.
- The general AI research wiki has relevant Harbor and benchmark-provenance coverage but no dedicated Devfile, Dev Containers, E2B, Daytona, or Codespaces contract comparison. Its primary-source links informed source discovery; its prose is not a normative input here.
- The private AllAgents research wiki contains one execution-gateway comparison based on the older A2A-era decision baseline. That coverage is now historical because ADR 0002 selects UHP. No private synthesis or conclusion is reproduced in this public note.

ADR 0002 and the implementation plan now codify this layered result: the canonical JSON request keeps `url`, `ref`, `destination`, and logical `workingDirectory`; local `workspace.yaml` replaces `source` plus `repo` with `url` while retaining `path`; OCI requests use explicit `snapshotName`, `imageManifestDigest`, and `workspaceManifestDigest`; workspace-manifest version 2 lets each snapshot root be tree-only or carry normalized offline Git history without a configured Git remote; and benchmark task/environment ingestion remains a separate future adapter boundary. The two older public research notes still need their stale pre-cutover descriptions corrected when they are next maintained; any private-wiki refresh remains a separate private edit.
