# Changelog

## [1.16.7](https://github.com/allagentsdev/allagents/compare/v1.16.6...v1.16.7) (2026-09-23)


### Fixed

* **cli:** check plugin sources before applying updates ([#516](https://github.com/allagentsdev/allagents/issues/516)) ([b1bcc45](https://github.com/allagentsdev/allagents/commit/b1bcc4509a72933d6f1397b8ba9a5af810a56dd0))
* **cli:** separate skill check and apply progress ([#515](https://github.com/allagentsdev/allagents/issues/515)) ([b4af16b](https://github.com/allagentsdev/allagents/commit/b4af16b258f3843945aa16b03baefadbb41f2890))
* **plugin:** remove the unused --force flag from marketplace add ([#518](https://github.com/allagentsdev/allagents/issues/518)) ([e9f4c52](https://github.com/allagentsdev/allagents/commit/e9f4c52f0d85b0465fdbdbea43250aa1bc656100))

## [1.16.6] - 2026-09-22

### Fixed

- The published project and user workspace JSON Schemas again carry the
  `default: []` annotation on the plugin and client collections — at project
  scope `mcpProxy.clients`, and at user scope `plugins`, `clients`,
  `mcpProxy.clients`, and `profiles.*.plugins` — restoring the defaults the
  previous schema generation dropped.

## [1.16.5] - 2026-09-22

### Fixed

- `allagents skill list` no longer fails with `plugins is not iterable` when the
  user workspace config omits the `plugins` key, as hand-written and
  profile-only configs do. An absent key now means no plugins are declared, and
  the command reports `No skills found.`

### Added

- Direct plugin and skill updates now name each source and show its result as it
  settles instead of staying silent until the whole run finishes. A TTY keeps
  one `Updating ...` line per source, and **Plugins → Update all** leaves the
  current source on its existing spinner; internal preflight and client
  synchronization add no separate status phases. Warnings and failures stay
  detailed, and JSON or redirected output remains one-shot and batched.

## [1.16.3] - 2026-09-21

### Fixed

- `plugin install --yes` and source-backed `skill add --yes` now use configured
  or default scopes and clients without opening interactive prompts.

## [1.16.2] - 2026-09-21

### Fixed

- Clients that share the canonical `.agents/skills/` destination now materialize
  it regardless of declaration order, so a workspace listing such a client
  before `universal` no longer skips syncing that destination.

### Added

- Skills now sync to a curated registry of client destinations: 49 skill-only
  destinations adopted from the pinned `skills@1.7.0` registry, limited to
  coding clients that consume skills directly. Non-coding platforms are
  intentionally excluded, and these destinations claim no instruction file,
  commands, agents, hooks, GitHub overlays, or MCP support. New ids include
  `goose`, `grok`, `qwen-code`, `tabnine-cli`, `warp`, and `zed`.
- Client ids may be written as compatibility aliases: `claude-code` resolves to
  `claude`, `github-copilot` to `copilot`, `gemini-cli` to `gemini`, `droid` to
  `factory`, `amp` to `ampcode`, `kiro-cli` to `kiro`, and `kimi-code-cli` to
  `kimi`. Aliases are accepted anywhere a client id or a `client:file` /
  `client:native` shorthand is accepted, and never create a second destination.
- Client selections are validated against the chosen scope: a client with no
  user-scope destination is rejected with `Client '<id>' does not support user
  scope`, and interactive client pickers list only the destinations valid for
  that scope. `workspace status` reports native resources only for clients with
  tracked state, so a declared but never-synced native client no longer adds an
  installed-CLI requirement.
- The published npm package is now a self-contained artifact: runtime
  dependencies are bundled into `dist/index.js` instead of being declared and
  installed separately, so installing the CLI pulls no dependency tree. Bundled
  third-party licenses ship as `dist/THIRD_PARTY_NOTICES.txt`.

## [1.16.0] - 2026-09-20

### Breaking Changes

- **MCP setup commands**: HTTP servers added with `allagents mcp add` now
  authenticate and route through AllAgents automatically. The public
  `--proxy` option was replaced by `mcp reauth <name>`. The generated
  `mcp proxy` helper remains internal.

  **Migration**: Remove `--proxy` from `mcp add` calls. Renew a managed
  server's credentials with `allagents mcp reauth <configured-name>` instead.

### Fixed

- Project-scoped Copilot MCP servers are now written to `.github/mcp.json`,
  which Copilot CLI discovers, instead of the unsupported
  `.copilot/mcp-config.json` project path.
- Interactive OAuth guidance for `mcp add` and `mcp reauth` now uses normal
  terminal output instead of the error channel. Callback URLs are entered
  through an abortable masked prompt, and failed reauthentication restores the
  previous working credentials.

### Added

- Added a thin first-party AllAgents skill that treats the installed CLI as
  authoritative and follows its progressive `--help --json` indexes and leaf
  contracts instead of relying on memorized commands.
- Added progressive machine-readable CLI help: concise root and group indexes
  lead to leaf contracts with usage guidance, interaction requirements,
  expected output, options, examples, and output schemas.
- Added `mcp tools` discovery and synchronous `mcp call` execution for project,
  user, and profile declarations, with direct HTTP/stdio connections, live
  input help, safe generated flags or exact JSON input, and complete
  human/JSON automation output with nonzero tool-error status.
- MCP commands now choose one declaration destination with `--scope
  project|user` or `--profile <name>`, which cannot be combined; without
  either, a command acts on the current project workspace.
- Added the official TradingView MCP plugin with OAuth-backed access to market
  data, analytics, watchlists, alerts, news, and screeners.
- Added automatic OAuth login to `allagents mcp add` and named credential
  renewal with `allagents mcp reauth`, including local loopback completion and
  remote callback URL paste with strict redirect and state validation.
- Generated HTTP MCP bridges now invoke the current pinned AllAgents version
  through cached `npx`, so managed MCP connections do not require a global
  AllAgents installation.
- Full MCP server management in the interactive TUI, including destination
  selection, listing, inspection, add, reauthenticate, and remove flows for
  project, user, and named-profile declarations. Client configuration updates
  automatically after mutations, with a contextual retry when an update fails.
- Interactive install targeting for `plugin install` and source-backed
  `skill add`: choose project or user scope, select clients, review the exact
  declaration, and confirm before mutation. Automation can use `--scope`,
  `--client`, and `--yes`; JSON, CI, and non-TTY runs remain prompt-free.
- GitHub marketplace URLs in plugin specs, such as
  `plugin@https://github.com/owner/repo`; AllAgents normalizes the URL to the
  canonical source and uses the existing marketplace registration flow.
- Interactive install confirmation now defaults to **Yes**, making Enter the
  happy path while retaining an explicit cancellation choice.
- Atomic publication of targeted plugin declarations, preserving existing
  plugin fields and writing per-plugin client overrides only when they differ
  from the selected scope's top-level clients.

## [1.15.0] - 2026-09-18

### Fixed

- `plugin update`, `skill update`, and `plugin marketplace update` now skip
  sources that already match their recorded revision. Unchanged plugins, skills,
  and marketplaces are no longer fetched, re-cloned, or re-applied; unchanged
  plugins and skills are reported as skipped instead of updated, while
  `plugin marketplace update` still reports a current marketplace as updated. A
  source shared by several plugins in one run is checked once.
- Project-scoped marketplaces keep their own cache directory under
  `~/.allagents/marketplaces/.projects/`, so a project marketplace no longer
  overwrites or reads the user-scope cache entry of the same name. Project
  caches left in the user cache root stay readable and are migrated when that
  marketplace is updated.
- Adding or replacing a marketplace is staged and committed in one step: when
  the clone, the manifest, or the registry write fails, the previous
  registration and cache are preserved instead of leaving a partial marketplace
  directory behind.
- `plugin marketplace list` reports each marketplace's version from the registry
  and cache that own it, so project-scoped entries no longer show the user-scope
  version or none at all.

### Added

- Pi and OMP as file-sync clients at project and user scope, including native
  runtime skill paths and agent instructions.
- Native Pi package and OMP marketplace-plugin lifecycle support for install,
  update, uninstall, status, and list output, with fail-closed trust and
  ownership checks.
- Global Pi and OMP profiles declared in `~/.allagents/workspace.yaml`, with
  preflighted install/status/remove commands, generated launchers, incremental
  managed-versus-referenced ownership state, and repeatable
  `allagents update --profile`.
- Pi profile MCP materialization with an explicitly declared, usable
  profile-scoped `pi-mcp-adapter`, plus native OMP named-profile marketplace
  lifecycle and revision verification.
- OpenCode global profiles using additive `OPENCODE_CONFIG` and
  `OPENCODE_CONFIG_DIR` overrides, file-installed skills and commands, strict
  settings, MCP serialization, generated launchers, and ownership-safe cleanup.
- Claude Code global profiles using isolated `CLAUDE_CONFIG_DIR` roots,
  additive MCP configuration, strict settings, native marketplace/plugin
  lifecycle, generated launchers, and ownership-safe cleanup.
- Copilot global profiles using isolated `COPILOT_HOME` and
  `COPILOT_CACHE_HOME` roots, with native marketplace/plugin lifecycle,
  skills, agents, and hooks, MCP configuration, strict settings, generated
  launchers, and ownership-safe cleanup.
- Codex global profiles using an owned `CODEX_HOME` and a `<profile>.config.toml`
  named profile, with a generated launcher that runs `codex --profile <name>`,
  MCP translation that keeps secret values unresolved, and ownership-safe
  cleanup.
- Versioned user and project workspace JSON Schemas generated from the runtime
  Zod models, with CI drift enforcement and YAML Language Server setup docs.
- Added `allagents profile list`, a read-only inventory of every declared
  profile plus each installed profile whose declaration is missing. Human and
  JSON output report each profile's overall status, whether it is declared and
  installed, its clients, and every launcher path with its PATH state. The
  command never opens a selector and changes no files or native state.

## [1.13.9] - 2026-09-14

### Fixed

- Marketplace registry writes are serialized per registry file and reload the
  latest saved state before merging their own change, so concurrent updates to
  plugins backed by the same marketplace no longer silently overwrite each
  other's changes. Concurrent temporary-file renames on Windows no longer make
  `allagents update` fail with `EPERM`.

## [1.13.8] - 2026-09-12

### Fixed

- A plugin that ships both `<name>.md` and `<name>.agent.md` for the same agent
  now syncs that agent once: the `.agent.md` file is kept, the `.md` twin is
  removed, and the survivor is tracked in sync state so later purges do not
  orphan it. Only files the synced plugins actually provide are considered, so
  unmanaged user files are never removed, and dry runs report the same dedup as
  a real sync.
- `plugin list` now identifies entries consistently: marketplace entries are
  headed by `plugin@marketplace`, while direct GitHub and local entries use a
  friendly final-segment name and show their effective source, including a
  configured Git ref. Every entry keeps `Type` and `Scope`, `Clients` appears
  when at least one file target or tracked native installation is known, and
  native clients are labeled explicitly. With `--json`, entries include the
  friendly `name`, raw `spec`, `marketplace`, `scope`, and `kind`, plus
  `clients` and `nativeClients` when present.

## [1.13.7] - 2026-09-10

### Breaking Changes

- **Plugin Git ref terminology**: Renamed workspace plugin `pin` to `ref`, CLI
  `--pin` to `--ref`, and sync-state `pinnedRef` to `requestedRef`. Inline
  `owner/repo@ref` sources are unchanged.

  **Migration**: Replace `pin:` with `ref:` in plugin objects and `--pin` with
  `--ref` in scripts. This is a clean cutover; the old names are not accepted.

### Fixed

- Windows native client commands are launched without a shell, so their
  arguments reach the client unchanged instead of being re-parsed by `cmd.exe`.
  Command shims are resolved to their real target and interpreter, and a shim
  that targets a `.bat`, `.cmd`, or `.ps1` file, or uses an interpreter other
  than `node`, is refused with an error instead of being executed.
- An unreadable marketplace registry now fails with an error naming the file
  instead of being treated as empty and overwritten, and registry writes are
  atomic, so an interrupted write can no longer truncate or corrupt the file.
  The existing file mode is preserved.
- `skill update` and the TUI's **Plugins → Update all** now include skills
  installed directly from a GitHub URL, including sources whose cache is shared
  with a plugin or marketplace entry; previously those standalone sources were
  left out of the update run.
- `skill add` accepts a URL that ends in `SKILL.md`, such as
  `https://github.com/owner/repo/blob/main/skills/pdf/SKILL.md`, and normalizes
  it to the containing skill directory.
- Plugin sources given as a deep GitHub URL that includes a branch, such as
  `https://github.com/owner/repo/blob/main/skills/example`, now resolve and
  cache at that branch, so repeated syncs reuse the same cache entry instead of
  cloning again.

### Added

- Workspace configuration supports an optional top-level `setup` list, and
  `allagents workspace setup` runs the entries that match the current platform
  and architecture. String entries run everywhere; object entries may restrict
  execution with `platforms` and `architectures`, and nonmatching entries are
  reported as skipped. Matching commands are shown immediately before they run,
  execute sequentially from the workspace root with inherited terminal I/O, and
  stop on the first nonzero exit or terminating signal. `workspace init`,
  `update`, and `workspace sync` never run setup commands, because workspace
  templates may come from untrusted remote sources. With `--json`, stdout holds
  one deterministic result document in declaration order, each entry reporting
  `succeeded`, `failed`, or `skipped`, while command announcements and output go
  to stderr.
- Added the first-party `engineering` plugin to this repository's marketplace,
  which ships the `pr-interactive-review` and `worktree` skills below.
- Added the `pr-interactive-review` skill to the engineering plugin. It turns a
  structured GitHub pull request review into a local interactive site with
  business context, verdict and metrics, status-grouped findings, severity and
  status filters, search, reviewed-commit source links, and local comments. It
  never posts to GitHub, keeps generated review data outside the repository, and
  binds to loopback unless `--expose` is passed.
- Interactive review findings are presented as present defects only when their
  cited evidence names a concrete triggering setup and an observable outcome;
  otherwise the finding becomes an evidence-seeking open question. Reviewer
  corrections are recorded as local lifecycle revisions instead of edits to the
  original review artifact.
- Every interactive review now carries a constrained
  `interactive-presentation.json` sidecar (eyebrow, headline, summary, context
  cards, and an optional mental model) consumed by the shared renderer;
  workspaces without presentation metadata still render using the review title,
  intent, and primer fields.
- Added the `worktree` skill to the engineering plugin, which adds and removes
  isolated Git worktrees under a sibling `<repo>__worktrees/` directory. It
  reuses an existing local branch, creates a tracking branch when the remote has
  one, and otherwise creates the branch from a start point or the remote default
  branch. `WORKTREE_ROOT` and `WORKTREE_REMOTE` override the parent directory
  and remote, and removal keeps Git's dirty-worktree protection unless `--force`
  is passed.

## [1.13.5] - 2026-08-20

### Fixed

- Marketplace registrations are validated before use: a marketplace name that is
  not a single directory name, a remote cache path that is a symbolic link, and
  a local source that points at a filesystem root or the home directory are
  rejected with an error instead of being registered or followed.
- Marketplace registry entries are treated as untrusted data. A failed refresh
  preserves the existing registration and its cached content, deletion is
  limited to cache paths AllAgents actually manages (any other path is kept and
  reported as a warning), and `plugin update` reports a marketplace it cannot
  access instead of failing the run.

### Added

- Added `allagents skill update [skill...] [--scope <scope>] [--yes]`, which
  checks installed remote skills for upstream changes, updates the surviving
  skills, and reconciles skills that were deleted upstream. A read-only
  preflight runs against disposable checkouts before any config or cache is
  changed. When an installed skill has disappeared upstream, interactive runs
  list the affected copies and ask once for the shared physical source:
  accepting removes the deleted selectors and advances that source, while
  declining keeps the local copies and skips every update from that source.
  Non-interactive runs — `--yes`, redirected input or output, CI, and `--json` —
  behave like declining, so unattended updates never delete skills. `--json`
  reports one status per physical source (`updated`, `removed`, `retained`,
  `skipped`, `failed`, `cancelled`); retained and skipped results exit 0, usage
  errors exit 2, and operational failures exit 1.

## [1.13.4] - 2026-07-30

### Fixed

- Copilot project sync now activates plugin hook declarations from `hooks.json`
  or `hooks/hooks.json` by combining them into the AllAgents-owned
  `.github/hooks/allagents.json` with each plugin's `COPILOT_PLUGIN_ROOT` bound,
  instead of copying the declaration verbatim where that variable would not
  resolve. A declaration that cannot be read, is not valid JSON, or lacks the
  version-1 `hooks` object envelope is reported and omitted without rejecting
  the plugin or suppressing its other artifacts, and `disableAllHooks: true`
  contributes no entries. Copilot package metadata under `.github/plugin/` is no
  longer copied into the project overlay.
- Repository hooks under `.github/hooks/` are never promoted into the
  user-global `~/.copilot/hooks/` directory. Copies that older versions may have
  left there are kept in place and reported for manual review, because their
  ownership was not tracked.
- Marketplace entries marked `strict: false` now define the complete set of
  plugin components, so skills, commands, agents, hooks, and MCP servers the
  entry omits are no longer inferred from the repository, and `.github/` content
  is not treated as a plugin artifact. Marketplace manifests are also read from
  `.github/plugin/marketplace.json`, which takes precedence over
  `.claude-plugin/marketplace.json` when a repository has both.
- `plugin update` and the TUI's **Plugins → Update all** now refresh
  marketplaces in the scope that declares each plugin, so project-scoped
  marketplace registrations are updated instead of being resolved against the
  user registry. A plugin installed in both scopes is updated once per scope.

## [1.13.3] - 2026-07-15

### Fixed

- Skill scanning during sync no longer aborts on unreadable directories: read
  failures are reported as warnings with remediation steps, symlinks and
  junctions are skipped, and the remaining plugins still sync.
- Installing or adding a plugin whose local source resolves to a filesystem root
  (for example a bare `\` on Windows) is now rejected instead of being written
  to `workspace.yaml`, where it later broke sync.
- User-scope sync now prints its `Warnings:` section like project-scope sync,
  instead of discarding warnings.

## [1.13.2] - 2026-07-13

### Fixed

- Interactive plugin install, update, and removal, plus skill updates from the
  plugins browser, no longer expose the internal sync step: progress reads
  `Updating...` and the final message names only the action (`Installed`,
  `Updated`, `Removed`).

## [1.13.1] - 2026-07-13

### Fixed

- User-scope sync resolves the home directory through the operating system
  instead of the `HOME` environment variable, so a mistranslated `HOME` (for
  example under Git Bash) can no longer make sync treat a drive root as home and
  walk into permission-restricted system folders.
- `allagents status` now finds the plugin cache for sources that pin a branch,
  instead of reporting a successfully installed branch-qualified source as not
  cached.
- `status` and `skill list` output shortens GitHub sources to `owner/repo`,
  dropping `/blob/<default-branch>/` and keeping `@<ref>` for non-default refs.
- `--agent-help workspace status` resolves the deprecated `workspace status`
  command path to `status` instead of failing with `Unknown command`.
- Workspace initialization prints `Updating plugins...` instead of
  `Syncing plugins...`, matching the wording used elsewhere.

### Added

- Codex project sync now installs plugin hooks: skills are copied into
  `.codex/skills/` and plugin hooks are merged into `.codex/hooks.json`,
  preserving hooks the user already declared there. Plugins can declare hook
  paths or inline hooks in `.codex-plugin/plugin.json`, falling back to
  `hooks/hooks.json`.
- `skill add owner/repo` now treats a bare GitHub source (`owner/repo`,
  `gh:owner/repo`, or a `https://github.com/...` URL) as a skill source and
  installs all of its skills, instead of failing as an unknown skill name. On a
  TTY it shows a picker with every discovered skill pre-selected so any can be
  deselected; non-TTY and `--json` runs install all of them.
- `skill add` shows the same picker for marketplace sources, grouping skills by
  plugin name, with every skill pre-selected and fallback to install-all in
  non-TTY and `--json` runs.
- Skill discovery is now recursive, so nested layouts such as
  `skills/research/llm-wiki/SKILL.md` are found and can be selected by leaf name
  or by their `category/skill` subpath. `skill add --list` no longer reports
  container directories without a `SKILL.md` as skills.
- `skill add` accepts a GitHub source as its positional argument together with a
  selector (`--skill`, `--list`, `--all`), and the new `--skill` flag takes a
  comma-separated list of skill names for multi-skill installs.
- `allagents status` now works without the `workspace` prefix, matching how
  `update` is exposed; `allagents workspace status` still resolves as an alias.
- `allagents status` and `allagents plugin list` label each entry as a `skill`
  or a `plugin`, with the same value in the JSON `kind` field and in the
  interactive status panel and plugins picker.
- Added a Claude Code plugin manifest for the `deepwiki` plugin, matching the
  other first-party plugins in the AllAgents plugin marketplace.

## [1.11.9] - 2026-05-21

### Fixed

- Plugin, marketplace, and remote workspace-repository git operations keep the
  inherited environment instead of a stripped one, so credential helpers,
  `~/.gitconfig`, SSH agent settings, and shell-configured proxies apply to
  clones and pulls again. Managed repository clone and pull now also run with
  interactive credential prompts disabled and Git LFS smudge skipped, which
  those paths previously allowed.

## [1.11.8] - 2026-05-21

### Fixed

- Installing from a GitHub URL that points at one skill directory now works: a
  URL such as `https://github.com/owner/repo/tree/main/skills/my-skill` passed
  to `allagents skill add` resolves the skills inside the referenced directory,
  records the repository as the canonical plugin source instead of accumulating
  a duplicate entry, and keeps working for later `allagents update` runs.
- `allagents skill search` ranks results by relevance: exact and prefix
  skill-name matches first, then namespace, description, owner, and repo
  matches, weighted by star count. Each result shows its star count and its own
  `SKILL.md` frontmatter description, falling back to the repository
  description.
- `allagents skill search --limit` now caps the merged result set rather than
  each underlying query, with a default of 15, and `SKILL.md` detection is
  case-insensitive. Results that duplicate workspace-synced skill files under
  hidden output directories such as `.agents/skills` or `.copilot/skills` are
  filtered out, and those directories no longer leak into skill namespaces.
- `allagents skill search` reads credentials from the `gh` credential store
  (`gh auth token`) when `GITHUB_TOKEN` and `GH_TOKEN` are unset, so an existing
  `gh auth login` is enough, and its unauthenticated error points at
  `gh auth login`.
- In a terminal, `allagents skill search` prints one summary line before the
  picker — `Showing N skills matching "query"` — instead of the full result
  table, and the picker prompt no longer repeats the result count.
- Removing a skill with `allagents skill remove` or from the TUI now removes the
  plugin entry itself when no other skill of that plugin stays enabled, and the
  TUI list refreshes immediately after a removal.
- The generated MCP proxy helper is now `allagents mcp proxy <serverUrl>`;
  `allagents mcp proxy-stdio` was a temporary name and is no longer accepted.
  Proxied client configurations are regenerated with the new name on the next
  update, so no manual edit is needed.

### Added

- `allagents skill search` accepts a bare query as shorthand, for example
  `allagents skill pr-search`, `allagents skill pr search`, or
  `allagents skill "pr search"`; all of them run the search instead of failing
  as an unknown subcommand. A single bare word is still treated as a subcommand
  name so typos remain visible.
- The install prompt after `allagents skill search` in a terminal is a
  searchable multi-select, so the plugins behind several selected results are
  installed in one pass; already-installed and failed repositories are reported
  separately.

## [1.11.0] - 2026-05-18

### Breaking Changes

- The canonical command group is the singular `skill`; `allagents skills` keeps
  working as a permanent alias with identical output. JSON envelopes and
  generated help now report `skill <subcommand>` as the command name.

  **Migration**: None required — `allagents skills ...` keeps working.
  Automation that reads the `command` field of JSON output should expect the
  `skill` prefix.

### Fixed

- Generated VS Code workspace files keep repository folder paths as written in
  `workspace.yaml` — relative paths stay relative — instead of rewriting them to
  absolute paths.
- OAuth login for proxied MCP servers opens the browser with each platform's
  native opener, including on Windows.
- `allagents skill add` and `allagents skill remove` no longer print the
  redundant `Syncing workspace...` and `Sync complete.` pair; the confirmation
  line and the per-client sync output are unchanged.

### Added

- Top-level `allagents init [path]` for creating a workspace; the previous
  `allagents workspace init` command remains a backward-compatible alias.
- `allagents skill search <query>` discovers skills on GitHub through the Code
  Search API, accepting `--owner`, `--page`, and `--limit` (1–100, default 30)
  and printing either a human table or the standard JSON envelope.
- Skill search also matches skills whose directory path contains the query even
  when their `SKILL.md` never mentions it, such as skills under
  `plugins/cargowise/skills/`, and reports each hit by its namespace-qualified
  name so identically named skills in different namespaces stay distinct.
  Duplicate hits for the same skill folder collapse into one result.
- `allagents skill add --list` (`-l`) lists the skills available at a `--from`
  source without installing anything, and `allagents skill add --all` installs
  every discovered skill from the source, including every skill of every plugin
  when the source is a marketplace.
- Skills and plugins can be pinned to a Git ref: an inline `owner/repo@<ref>`
  source (optionally with a `/subpath`), a `pin:` field on a workspace plugin
  entry, or `--pin <ref>` on `allagents skill add`. Pins are honored by
  `allagents update`, and combining `--pin` with an inline `@ref` is rejected.
- `--json=<field>,<field>` narrows command output to a per-command field
  allowlist and `--jq <expr>` pipes the JSON envelope through `jq`. Unknown
  fields exit 2 with the available fields listed, and `--jq` without `--json`
  exits 2.
- `allagents mcp add <name> <url> --proxy` serves an HTTP MCP server through the
  built-in AllAgents HTTP-to-stdio proxy for the targeted clients instead of the
  external `mcp-remote` package, and records the proxied intent per server under
  `mcpProxy.servers` in the workspace configuration so later syncs keep the
  rewrite. Generated client configs call the internal helper
  `allagents mcp proxy-stdio <serverUrl>`.
- The TUI Skills menu gained **Search online**, which prompts for a query, lists
  matching GitHub skills, and installs the plugin behind the selected result.

## [1.8.0] - 2026-04-10

### Added

- Added the `allagents mcp` subcommand for managing MCP servers declared in
  the workspace. `mcp add <name> <commandOrUrl>` writes a server to
  `workspace.yaml` and syncs it to configured clients, `mcp remove <name>`
  removes it and unsyncs it from clients, `mcp list` and `mcp get <name>`
  inspect declarations, and `mcp update` syncs MCP servers only without
  touching other artifacts. `mcp add` accepts `--transport`, repeatable
  `--arg`, `-e`/`--env`, and `--header`, plus `--client` to filter clients
  and `--force` to replace an existing server of the same name.
- Transport is detected from the command or URL argument, so `--transport`
  is only needed to override it; inconsistent combinations such as
  `--transport stdio` with a URL or `--arg` with an HTTP URL are rejected.
- Added a top-level `mcpServers:` field to `workspace.yaml` for declaring
  HTTP and stdio MCP servers directly instead of through a plugin. A
  per-server `clients:` filter limits which clients receive the server;
  without one it syncs to every configured client that supports
  project-scoped MCP.
- Only MCP servers AllAgents added are tracked and can be modified or
  removed. Servers added by hand to `.mcp.json` or
  `.copilot/mcp-config.json` are left untouched.
- Added a copy-and-run MCP proxy example workspace at
  `examples/workspaces/mcp-proxy`, which installs the deepwiki plugin and
  proxies its HTTP MCP server to Codex through `mcp-remote`.

## [1.7.2] - 2026-04-09

### Fixed

- Native plugin installs now name the client that ran the install, such as
  `installed via claude CLI`, instead of the generic
  `installed via native CLI`.

### Added

- Added managed workspace repositories: a repository entry with
  `managed: true` (or `sync`) is cloned when missing and pulled on every
  workspace sync, `managed: clone` clones it once and never pulls, and
  `managed: false` (the default) leaves the repository untouched.
  `allagents update` and `allagents sync` accept `--no-managed` to skip
  clone and pull operations, and clone, pull, and failure results are
  reported in the sync output and JSON payload.

## [1.7.1] - 2026-03-29

### Fixed

- Skills index entries no longer contain doubled path separators when a
  repository path in `workspace.yaml` ends with a trailing slash.

## [1.7.0] - 2026-03-29

### Fixed

- Repository skills are no longer inlined in `AGENTS.md`, where VS Code
  loaded them twice. Each repository's skills are now written to
  `.allagents/skills-index/<repo-name>.md`, `AGENTS.md` links the index
  files instead, and index files are removed once their skills are gone.
- Repository skill discovery is now opt-in: a repository contributes skills
  only when its `skills` field is `true` or a list of skill directories.

### Added

- Added MCP proxy support: the top-level `mcpProxy:` section in
  `workspace.yaml` rewrites HTTP MCP servers into stdio configurations that
  launch through `npx mcp-remote`, for clients that cannot consume HTTP MCP
  entries directly. The rewrite applies to both project- and user-scoped
  sync.

## [1.6.1] - 2026-03-27

### Fixed

- Repository skills with the same name across repositories are now
  deduplicated: skills under `.agents/` take priority, and otherwise the
  largest file wins. The generated section is titled "Repository Skills"
  instead of "Workspace Skills".

## [1.6.0] - 2026-03-27

### Added

- Workspace repositories now contribute their skills to the agent rules
  AllAgents writes into `AGENTS.md` and `CLAUDE.md`: each discovered skill's
  name, description, and location is listed in an `<available_skills>`
  block, so agents can find repository skills without reading
  `workspace.yaml`. Skills are discovered from the skill directories of the
  configured clients, parsed from `SKILL.md` frontmatter, and symlinked
  skill directories are skipped.
- Added a `skills` field to repository entries in `workspace.yaml` that
  accepts a list of skill directories relative to the repository root, or
  `false` to exclude the repository from the skills index.

## [1.5.0] - 2026-03-27

### Fixed

- `allagents plugin marketplace add` now replaces an existing marketplace
  entry instead of reporting that it already exists, so re-running the
  command updates the registration as intended.

### Added

- Added top-level `allagents update`, with `sync` as an alias, as the
  primary way to sync a workspace. `allagents workspace sync` continues to
  work.
- Workspace init and every sync-state save now create
  `.allagents/.gitignore` excluding `sync-state.json`, which records
  machine-local filesystem paths. Existing entries in the file are
  preserved.

## [1.4.11] - 2026-03-24

### Fixed

- Repository names defined on a folder in `.code-workspace` survive
  `workspace sync`: the name is written back to the matching repository entry
  in `workspace.yaml` and reported as an update, and removing the name from the
  workspace file clears it again.

## [1.4.10] - 2026-03-24

### Fixed

- Sync no longer fetches the same plugin source twice in one run: results
  fetched for the user scope are reused by the project scope, and GitHub
  marketplaces registered during the run are reused instead of being cloned or
  pulled again, including sources that name a branch such as `/tree/main/`.

### Added

- `ALLAGENTS_DEBUG=timing` prints a per-step sync timing breakdown to stderr.

## [1.4.8] - 2026-03-23

### Added

- The interactive TUI now shows the same detailed sync report as the headless
  commands for sync, init, and plugin install: per-client artifact counts,
  generated and failed file details, MCP server changes, warnings, and native
  plugin results.

## [1.4.7] - 2026-03-23

### Fixed

- `plugin list` no longer shows every plugin twice when run from the home
  directory, where the project and user workspace files resolve to the same
  path; plugins are reported once, at user scope.
- A failed workspace init in the TUI stops the spinner and reports the error
  instead of leaving a dangling animation that corrupted the display.

### Added

- Workspace repositories accept an optional `name` field, used as the folder
  name in the generated `.code-workspace` file.

## [1.4.6] - 2026-03-22

### Fixed

- `workspace init --from` parses GitHub `/blob/` URLs the same as `/tree/`
  URLs, so links copied from GitHub's file browser keep their subdirectory path
  instead of failing with "No workspace.yaml found".

## [1.4.5] - 2026-03-22

### Fixed

- A `workspace.source` that cannot be fetched, such as a private repository the
  current credentials cannot clone, no longer aborts `workspace sync`: the
  failure is reported as a warning, workspace file copying is skipped, and the
  remaining plugins still sync.
- Repositories cloned by `workspace init --from` seed the plugin and
  marketplace caches, so the following sync does not clone the same private
  repository again.
- Git clone failures caused by GitHub HTTP 5xx responses are reported as
  authentication problems with guidance to run `gh auth setup-git`, instead of
  as generic server errors.
- Marketplace scope is reported correctly when the user and project registry
  paths resolve to the same file, for example when running from the home
  directory: entries are listed once at user scope instead of appearing at
  project scope with a spurious override warning.

## [1.4.4] - 2026-03-22

### Fixed

- New user-scope workspaces no longer enable the `factory` and `ampcode`
  clients by default.

### Added

- `plugin install` at user scope prompts for client selection when no user
  `workspace.yaml` exists yet, matching project-scope behavior, instead of
  silently applying the default clients.
- The client selection prompt pre-selects `universal`, `copilot`, and `vscode`.

## [1.4.2] - 2026-03-20

### Fixed

- `plugin install` separates its progress line and success message from the
  surrounding sync output with blank lines.

## [1.4.1] - 2026-03-20

### Breaking Changes

- `allagents plugin install` no longer accepts `--force`/`-f`.

  **Migration**: Remove `--force` from `plugin install` invocations; replacing
  an already-declared plugin is now the default behavior.

### Fixed

- `plugin install` now reinstalls a plugin that is already declared, refreshing
  its files and running sync, instead of failing with "Plugin already exists".

## [1.4.0] - 2026-03-20

### Added

- Interactive TUI lists support type-to-filter search: marketplace plugin
  browsing, skills browsing, plugin install, and client selection accept typed
  input to narrow long plugin and client lists.
- The TUI menu shows a compact one-line workspace summary on repeat visits
  instead of repeating the full workspace note box.
- Long-running TUI actions use a single progress spinner whose message updates
  in place, instead of stacking separate action and sync spinners.
- Plugin and skill lists show the name prominently with type and scope metadata
  dimmed to the right, and skills browsing shows each plugin's skill count with
  a truncated preview instead of the full skill inventory.

## [1.3.0] - 2026-03-20

### Fixed

- MCP sync results name the raw client (`vscode`) instead of its `copilot`
  display alias. Artifact counts for skills, commands, agents, and hooks keep
  using the alias, since both clients share those paths.

### Added

- Plugins that define MCP servers now sync them for the Copilot CLI client:
  project-scoped servers are written to `.copilot/mcp-config.json` and
  user-scoped servers to `~/.copilot/mcp-config.json`, both in the
  `{"mcpServers": {...}}` format Copilot CLI reads.
- `allagents workspace update` is now an alias for `allagents workspace sync`.

## [1.2.0] - 2026-03-20

### Fixed

- Plugins with MCP servers now sync them for the `claude` client: project-scoped
  servers are written to `.mcp.json`, the file `claude mcp add --scope project`
  uses, and user-scoped servers are registered and removed through
  `claude mcp add/remove --scope user` under the same ownership tracking as
  other clients.
- Plugins with MCP servers now sync them for the `codex` client at project
  scope, writing `[mcp_servers.*]` sections to `.codex/config.toml` so Codex
  picks them up in trusted projects.

### Added

- Workspace client lists accept the `client:mode` shorthand, so
  `- claude:native` is equivalent to `- name: claude` with `install: native`.
- Sync output labels MCP server results with the client they were written for
  and warns when a plugin defines MCP servers but a configured client does not
  support MCP sync at the current scope.
- Each plugin header in sync output now shows its scope (`project` or `user`),
  and the duplicate per-client artifact summary that repeated the per-plugin
  results has been removed.

## [1.1.0] - 2026-03-20

### Added

- Plugins with MCP servers now sync them for the `vscode` client at project
  scope, writing entries to `<workspace>/.vscode/mcp.json` and tracking them in
  the project sync state so servers are added, updated, and removed with the
  plugin.
- `plugin install` output follows the Claude CLI flow: it announces
  `Installing plugin "<name>"...` and reports
  `✔ Successfully installed plugin: <name> (scope: project)` (or `user`) once
  the sync succeeds.
- `plugin install`, `plugin update`, and `plugin uninstall` no longer repeat the
  per-client artifact summary after their results, and their progress banner
  now reads `Updating workspace...` instead of `Syncing workspace...`.
- The deepwiki plugin is published from this repository's `allagents`
  marketplace, giving MCP access to AI-generated documentation for public
  GitHub repositories (`read_wiki_structure`, `read_wiki_contents`,
  `ask_question`).

## [1.0.15] - 2026-03-20

### Fixed

- Sync artifact counts no longer double-count a source that aliased clients such
  as `vscode` and `copilot` write to different directories; each artifact is
  counted once per client no matter how many directories it lands in.
- The overall sync summary no longer prefixes its totals with a redundant
  `Sync complete:` line.

### Added

- `workspace sync` prints a concise header before its per-plugin results:
  `Updating N plugin(s)...` followed by `✓ Successfully updated M plugin(s)`,
  replacing the separate "Syncing user workspace" and "Syncing project
  workspace" banners.

## [1.0.12] - 2026-03-20

### Fixed

- Sync output no longer double-counts artifacts when the same destination is
  written more than once.

## [1.0.11] - 2026-03-17

### Fixed

- Removing the last skill from a plugin's allowlist now keeps the allowlist
  empty instead of dropping it, so the plugin stays in allowlist mode with all
  of its skills disabled.

## [1.0.10] - 2026-03-17

### Fixed

- `skills add <skill> --from <url>` reuses a marketplace already registered at
  the user or project scope instead of registering a duplicate and warning that
  it overrides the user marketplace, and its marketplace path prints a single
  installing line instead of the marketplace-detection, lookup, and
  already-installed messages.

## [1.0.9] - 2026-03-17

### Fixed

- `skills add --from` now defaults to project scope unless `--scope user` is
  passed. Plain `skills add` keeps resolving the scope from the workspace
  config: project when a project workspace exists, otherwise user.
- Plugin lookup for skills resolves GitHub `{owner}-{repo}` names, so a skill
  whose plugin name differs from the workspace source no longer fails with
  "Plugin not found in workspace config", and `plugin install --skill` no
  longer reports "No skills found" after installation.

## [1.0.8] - 2026-03-17

### Fixed

- Skills from marketplaces whose plugins share one source directory are now
  attributed using each plugin's declared skill list, so a skill goes to the
  plugin that provides it instead of the first plugin discovered.

## [1.0.7] - 2026-03-16

### Fixed

- `skills add <skill> --from <url>` detects a `.claude-plugin/marketplace.json`
  source, registers the marketplace, and installs the owning plugin through the
  marketplace spec with only the requested skill enabled. Adding another skill
  from the same plugin extends the allowlist.

## [1.0.6] - 2026-03-16

### Added

- `skills add` accepts a GitHub repository or skill URL directly and
  auto-detects the skill to install, so the skill and plugin do not have to be
  named separately.

## [1.0.4] - 2026-03-14

### Fixed

- Skills that are only disabled no longer appear as deleted in sync output when
  a plugin is reinstalled with `--skill`. Deleted artifacts are reported as one
  deduplicated line instead of being grouped per client.

## [1.0.3] - 2026-03-14

### Fixed

- The "Deleted" line in sync output no longer repeats an artifact when several
  internal clients map to the same display name, such as vscode and copilot
  both displaying as "copilot".

## [1.0.2] - 2026-03-14

### Added

- Plugin detail in the TUI has an "auto-enable new skills" toggle that switches
  a plugin between allowlist and blocklist behavior, and browsing marketplace
  skills routes through that per-plugin toggle.

## [1.0.1] - 2026-03-14

### Breaking Changes

- `allagents workspace sync` no longer accepts the `--client`/`-c` option.

  **Migration**: Remove `--client` from sync invocations; sync operates on all
  configured clients.

### Fixed

- Sync warns when `workspace.yaml` configures no clients, and when a plugin has
  no effective clients and is skipped, instead of producing no work silently.
- `skills add` no longer claims that flat `SKILL.md` repositories are
  unsupported; the error points to `allagents skills list` for available
  skills.

### Added

- The TUI skills screen lists marketplace skills grouped by plugin when none
  are installed, adds a "Browse marketplace skills..." option when skills
  exist, and shows each plugin's skill names in the install picker.
- Skills repositories that keep `SKILL.md` at the repository root, as created
  by `npx skills init`, are detected and synced. The skill name is read from
  the frontmatter, falling back to the directory name.

## [1.0.0] - 2026-03-13

### Breaking Changes

- **Workspace schema v2**: Skill selection is now configured inline on each plugin entry rather than via top-level `disabledSkills`/`enabledSkills` arrays.

  **Before (v1):**
  ```yaml
  plugins:
    - superpowers@marketplace
  enabledSkills:
    - superpowers:brainstorming
  disabledSkills:
    - my-tools:verbose-logging
  ```

  **After (v2):**
  ```yaml
  version: 2
  plugins:
    - source: superpowers@marketplace
      skills: [brainstorming]
    - source: my-tools@marketplace
      skills:
        exclude: [verbose-logging]
  ```

  **Migration**: Automatic — existing `workspace.yaml` files are migrated to v2 format on the next `allagents workspace sync`. No manual action required.

### Added
- Top-level `allagents skills` command as shorthand for `allagents plugin skills`
- `allagents skills add --from <source>` to install a plugin and enable a skill in one step
- Auto-wrap support for flat SKILL.md repos (npx skills ecosystem compatibility)
- `allagents plugin install --skill` now works even when plugin is already installed
