# Architecture Boundaries

This guide expands [`AGENTS.md`](../AGENTS.md) for synchronization ownership, output formatting, and client identity rules.

## Workspace YAML edits

Use `src/utils/yaml.ts` for production YAML parsing, document creation, and
serialization. It owns core-schema tags, JavaScript value shapes, and parse
errors. Read Markdown metadata through `src/utils/frontmatter.ts`, which uses
that boundary and accepts YAML only.

Use `src/utils/workspace-writer.ts` when persisting workspace configuration changes.
Its serializer reconciles semantic edits, then retains source tokens for unchanged
YAML and generates only new or replaced syntax. Keep token rendering inside
`workspace-source-editor.ts` and retain the semantic round-trip check; domain
callers should not manipulate YAML tokens. Pass the original content for
templates and staged transactions;
file writers can use `writeWorkspaceConfig` or `serializeWorkspaceConfigFile`.
Keep scope validation and atomic replacement safeguards in the calling operation.

## Remote MCP connection policy

Keep HTTP/SSE construction and authorization in the shared remote transport
boundary. The stdio bridge relays protocol messages instead of terminating them
at a second SDK Client/Server pair; the real host's capabilities, request IDs,
notifications and remote metadata must survive. Finite CLI operations use an SDK
Client over that same boundary and must not initiate fresh human consent.

Apply connection options consistently through management, runtime, profiles and
generated bridges. Keep resource headers origin-restricted, configured secrets
out of generated process arguments, and grants isolated by effective identity.
Keep authored query-reference URLs as cache and reauthentication identities when
query secrets rotate; resolve those values only for outbound requests. Whole-URL
references select their resolved destination, and resource headers partition
tenant grants. Keep reset coordination outside the cache directory that moves
during credential backup and rollback.

Coordinate registration and token refresh in the provider/store rather than
serializing unrelated tool requests. Keep modern-protocol translation opt-in and
outside the legacy relay. Verify protocol behavior with real peers, including a
server request during an outstanding tool call, to detect relay deadlocks.

## MCP server ownership

MCP servers from plugins are synchronized into VS Code's `mcp.json`.

- Track only servers AllAgents added.
- Preserve a server that existed in the user's configuration before plugin installation.
- Remove or update only entries represented by `trackedServers`.

`trackedServers` means “servers AllAgents owns and is responsible for updating or removing.”

Keep Claude and VS Code JSON file merging in `src/core/json-mcp-config.ts`.
Unreadable, malformed, or non-object configurations and server maps retain their
bytes and prior tracking, return `authoritative: false`, and fail reconciliation.
Force permits individual server replacement only after the container is valid.

## Pi native compatibility

Use a minimum Pi version requirement rather than a moving upper bound. Keep
package inspection, project trust, and scope isolation fail-closed before native
mutation. Verify adapter changes through the real Pi lifecycle in an isolated
HOME and project; a passing version check alone is not compatibility evidence.

## Synchronization output

Synchronization results are surfaced by multiple entry points:

- `update` and `workspace sync` in `src/cli/commands/workspace.ts`
- `plugin install|uninstall|update` in `src/cli/commands/plugin.ts`
- TUI synchronization actions in `src/cli/tui/actions/sync.ts`

Put shared formatting in `src/cli/format-sync.ts` rather than duplicating it at call sites. Keep JSON, redirected human output, and interactive TTY behavior as distinct contracts.

## Plugin source and destination identity

Resolve plugin/client install modes through `resolveInstallMode`: plugin-wide
override, explicit plugin client mode, then inherited workspace mode.
Use `getPluginClients` for identities and retain `getPluginClientEntries` when
narrowing declarations or serializing configuration. Raw YAML edits can still
contain `client:mode` strings; preserve their modes and original representation
when changing client targets.

- Explicit npm/Git package sources are not `plugin@marketplace` declarations. Do not interpret npm versions, Git refs, or SSH transport usernames as marketplace names.
- Keep independently configured package and file installations distinct, even when they expose the same upstream skills. UI hints should identify their configured clients, install methods, and scopes; updates/removals retain exact source and configuration-index targeting.
- Native package availability comes from native resource inspection, not from treating the source string as a local cache path.
- Ordinary file Git sources use the shared remote descriptor for transport, requested ref, cache path and provenance. Keep generic host/port/path/ref identities distinct; interpret `ref` and `subdir` metadata before Git transport, and resolve subdirectories inside the checkout. Determine native versus file status from the declaration's effective install modes.
- The Plugins menu selects individual resources. Bulk updates remain under Workspace → Status → Update all.
- Share short resource names and source hints between the Plugins menu and Workspace status. Keep the full configured source visible in details and retain exact source, scope, and configuration-index action targets when names collide.

## Plugin component sources

Resolve supported legacy component sources once in
`src/core/plugin-components.ts` and carry `PluginComponents` through marketplace
resolution, validation, copying, inventories, MCP-only updates, and profile file
planning. Consumers must not interpret `strict` as a component allowlist or
independently choose a different manifest.
Keep `PluginComponents.legacyRepository` separate from GitHub overlay eligibility:
ordinary manifest-free repositories retain nested-skill precedence, while a
marketplace root skill stays authoritative over unsupported flat children.

Keep conventional MCP precedence, plugin-manifest custom paths, and inline
configuration provenance aligned with the
[marketplace discovery contract](../docs/src/content/docs/docs/guides/plugins.mdx#marketplace-component-discovery).
Check lexical and canonical source containment before reading components, and
retain original plugin-relative exclusions even when a component uses a custom
directory. `hooks: false` is the explicit file-install hook opt-out, including raw
`.github/hooks/`; it must not disable MCP or other assistant components.
Use `GITHUB_ASSISTANT_ENTRIES` in `src/models/plugin-components.ts` as the shared
boundary for `.github/` discovery, preflight, copying, and inventory: `agents/`,
`instructions/`, `prompts/`, `skills/`, `hooks/`, `scripts/`, `tools/`, and
`copilot-instructions.md`. Preserve these assistant resources regardless of
marketplace/plugin manifests or `strict`, including supporting scripts/tools
and existing GitHub-agent precedence. Do not copy workflows, plugin metadata,
or other unsupported `.github/` entries as repository overlays. Preflight only
selected supported roots, retaining exclusions, lexical/canonical containment,
and copy-time source safety checks. Preserve existing ownership and cleanup
rules; failed source resolution must preserve previously owned output and state.

## Root skill resources

Keep root skill copying and profile plan expansion aligned with the
[single-skill repository contract](../docs/src/content/docs/docs/guides/plugins.mdx#single-skill-repositories).
Share metadata exclusions between those paths. Resolve source aliases before
checking recursive copy overlap. Verify supporting resources through direct
copies, canonical copies exposed through client symlinks, and profile installs.

## VS Code and Copilot identity

`vscode` is a display alias for `copilot` only when reporting artifact counts.

- Keep raw client names in MCP output because VS Code and Copilot have separate MCP support.
- Keep `vscode` and `copilot` as distinct internal client types with separate path mappings.
- Keep VS Code MCP writes project-scoped at `.vscode/mcp.json`. User MCP uses
  the `copilot` target at `~/.copilot/mcp-config.json`; VS Code's user-profile
  `mcp.json` is deprecated. Leave existing deprecated files untouched, including
  entries tracked by older AllAgents versions. Ownership at the old destination
  grants no ownership at the Copilot destination.

## Git source credentials

Reject HTTP(S) userinfo and SSH passwords at plugin declaration validation,
CLI install intake and remote descriptor parsing before output or writes.
Diagnostics must not echo rejected source strings. SSH usernames and Git-managed
keys, agents and credential helpers remain supported.

## VS Code repository write-back

Preserve automatic folder/name import during project synchronization. Compare
editor folders with the saved generated folder snapshot, including template
folders, before changing YAML repositories. Whole-file hash changes alone do not
prove a folder edit. Actual editor name changes retain precedence over competing
YAML names; unrelated editor edits must preserve YAML-only changes.

Validate and prepare imports before migrations or sync-state publication. Failed
imports must preserve pending editor bytes and their baseline. Change only raw
repository declarations through the shared YAML writer and keep dry-run read-only.
Keep confirmation limited to uncertain legacy repository imports. Core owns the
repository-only preview and invokes an optional confirmation callback before
publication; CLI/TUI code owns `--yes`, terminal detection, sanitized display and
spinner suspension. A missing or declined confirmation leaves the pending import
unchanged. Complete snapshots retain automatic editor precedence, and unrelated
plugin edits do not create repository ambiguity. Keep settings import and
command-wide rollback outside this boundary.
