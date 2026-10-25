# Repository quality audit

Base: `origin/main` at `2debf73`; branch: `refactor/repo-quality-audit`.
The review used Bun 1.4.3 on Linux and a dedicated worktree. No release metadata,
external accounts, main checkout, or other workers' files were changed.

## Coverage

This was a repository-wide structural survey with targeted implementation review
and a complete test run, not a line-by-line correctness proof of every source file.
The initial implementation/script inventory contained about 49,000 lines.

| Area | Review performed | Limits |
| --- | --- | --- |
| CLI | Command inventory, root dispatch, JSON and redirected output contracts, shared output, install-target resolution, plugin/skill/update/MCP/repository flows | Manual CLI checks concentrated on the changed paths; no live self-update |
| TUI | Wizard/menu routing, context/cache invalidation, install prompts, plugin/update/sync actions and their tests | No TUI code changed; no interactive journey or video recorded |
| Workspace and sync | Initialization, managed repositories, repository metadata, source reconciliation, tracked purge boundaries, state persistence, project/user completion, repository skills | Large sync and modification modules received targeted reads and call tracing |
| Plugins and marketplaces | Source/cache identity, Git transport/error boundaries, registry read/write, locking/publication, marketplace lookup/update, skill discovery/search/update | Existing local fixtures exercised remote-shaped workflows; no live hosted marketplace audit |
| Profiles and native clients | Profile planning/manager entry points, source resolution, safe file publication/state, launcher generation, adapter registries, representative Pi/OMP/native boundaries | No real client lifecycle re-run; root-skill implementation in #587 remained owned by its worker |
| MCP | JSON and TOML/client writers, ownership propagation, project/user pipelines, proxy/runtime, pagination, timeouts, stdio cleanup, HTTP credential/redirect boundaries | Live third-party OAuth and externally installed clients were not exercised |
| Models/parsers/filesystem | Client/workspace/profile/state schemas, marketplace schema/parser, YAML/frontmatter/source writer, remote/path parsing, symlinks/globs/link rewriting/name resolution | No fuzzing or race stress test; platform-specific filesystem behavior was not validated on Windows/macOS |
| Tests/build/package | Baseline and focused tests, mock isolation, CI workflows, production bundling/notices, schema generation, size budgets, packed Node CLI smoke | Linux execution only; Windows-specific tests remain skipped |
| Documentation/examples/plugins | Root guides, public workspace/plugin/CLI references, docs build, representative engineering/example configuration, bundled CLI skill and marketplace forwarding layout | Remote examples were not installed; published website and release workflows were not executed |

The #588 client capability/global-path changes remained with their worker.
The parent explicitly authorized the independent malformed-JSON fix and duplicate
merge removal in `vscode-mcp.ts`; its existing destination default was retained.

## Findings and changes

1. **User configuration loss during MCP synchronization.** Both JSON writers
   treated parse failures as empty configuration, then overwrote the user's file
   when adding servers. Non-object containers/maps could also throw or silently
   lose additions. A shared JSON merge boundary now validates the document and
   server map before mutation. Failure retains the original bytes and prior
   tracked names, reports `authoritative: false`, and propagates failure and a
   repair diagnostic through project/user update and MCP-only update. Force and
   dry-run retain the same validation boundary.
2. **Incorrect repository remote metadata.** Dots in repository names were excluded
   by five separate regexes; GitLab subgroup paths were omitted; an unanchored
   host match could mistake `notgithub.com` or a URL path for a supported host.
   Parse the host/path once, retain platform-specific path shapes, and use an
   own-property platform lookup. Existing Git transport/source parsers were
   inspected: they either describe GitHub-only canonical plugin identity or
   plugin cache/ref metadata, rather than this case-preserving multi-platform
   workspace repository contract.
3. **Test-order-dependent native command failure.** The native marketplace test
   replaced native types, Git and simple-git modules in the shared Bun process.
   Running it before `native/types.test.ts` made the real NUL-argument error test
   receive the mocked success result. The fixture now runs in a child process,
   matching existing worker tests, and imports real native helpers rather than
   maintaining copies of them.

The JSON extraction removes two independent merge implementations, duplicated
recursive equality code, and redundant orphan cleanup/write blocks. Client
wrappers still own destination choice and server collection. Healthy ownership,
force, equality, cleanup, ordering, JSON5 input and no-op behavior retain existing
test coverage.

The parent and an independent read-only peer review found the user-completion
seam after the first project-focused implementation. Regression coverage now
includes Copilot's user config through both CLI entry points and dry-run.

## Verification

Baseline: `bun test` produced **2,306 pass, seven skip, one fail** across 196 files.
The sole failure was reproduced independently with:

```sh
bun test tests/unit/core/native/native-marketplace-registration.test.ts tests/unit/core/native/types.test.ts
```

Before implementation, the new repository/Claude regressions produced 13 failures.
The new built-CLI project preservation tests produced four failures against the
original bundle. User CLI regressions then reproduced success on failed full
user update and missing repair diagnostics in MCP-only user update.

Focused verification:

```sh
bun run build
bun test tests/e2e/mcp-config-preservation.test.ts tests/unit/core/json-mcp-config.test.ts tests/unit/core/mcp-sync-user.test.ts tests/unit/core/sync-user.test.ts tests/unit/core/claude-mcp.test.ts tests/unit/core/vscode-mcp.test.ts tests/unit/core/workspace-repo.test.ts tests/unit/core/native/native-marketplace-registration.test.ts tests/unit/core/native/types.test.ts
bun run typecheck
bun run lint
bun run schema:check
bun run docs:build
bun run package:check
bun run package:smoke
```

Integrated focused result: **110 pass, one Windows-only skip, zero fail** across
nine files. Full-suite result after the fixes: **2,334 pass, seven skip, zero fail**
across 198 files. Typecheck, lint, build, schema and documentation checks passed.
The packed artifact passed isolated Node smoke across 54 help nodes without
installing runtime dependencies. Final package sizes: 1,546,174 bytes emitted
JavaScript; 1,644,465 bytes unpacked; 470,287 bytes compressed, all within budget.

The permanent [built CLI regression fixture](../../tests/e2e/mcp-config-preservation.test.ts)
creates isolated HOME/project directories, invokes `node dist/index.js`, checks
exit status and one JSON result, verifies exact file bytes and ownership state,
repairs the file, and verifies successful cleanup/addition without removing the
personal server. Full update also checks read-only dry-run. The
[shared adapter tests](../../tests/unit/core/json-mcp-config.test.ts) cover malformed,
null, array, scalar, and invalid server-map documents, force/dry-run, JSON5 input,
unrelated fields, owned-only removal, and no-op writes.

Manual checks used a separately written fixture with isolated HOME and projects:

```sh
node dist/index.js update --scope project --offline --json
node dist/index.js mcp update --scope project --offline --json
node dist/index.js update --scope user --offline --json
node dist/index.js mcp update --scope user --offline --json
node dist/index.js update --scope project --offline --dry-run --json
node dist/index.js update --scope user --offline --dry-run --json
node dist/index.js workspace repo add <isolated-git-directory> --json
node dist/index.js workspace repo list --json
```

Each MCP destination started with a truncated JSON5 file, a declared new server,
and an old owned server in sync state. Checks covered failure, retained bytes and
tracking, redirected human output, repair, personal-server preservation, stale
owned-server removal, successful new ownership, and a repeated no-op. Repository
fixtures used GitHub/Bitbucket dotted names, nested GitLab groups, both Azure
transports, a lookalike host, and `constructor`; no network fetch was necessary.
Temporary HOME/project fixtures were removed after checking their filesystem state.

## Remaining limitations

The review does not establish correctness for every native-client version,
operating system, concurrent writer, dependency or remote service. Existing
`plugin validate` is explicitly a stub and was not implemented as part of this
bug/refactor audit. A candidate relative-symlink issue was excluded because the
production destination guard rejects that symlinked-parent fixture before writes.
The 17 existing Biome warnings in `workspace-source-editor.ts` were left intact;
there were no lint errors. Integration with the separately owned root-skill and
client capability/path changes remains with the parent reviewer. Publication is
a non-draft PR; merging is reserved for the parent.
