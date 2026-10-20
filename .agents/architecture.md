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

## MCP server ownership

MCP servers from plugins are synchronized into VS Code's `mcp.json`.

- Track only servers AllAgents added.
- Preserve a server that existed in the user's configuration before plugin installation.
- Remove or update only entries represented by `trackedServers`.

`trackedServers` means “servers AllAgents owns and is responsible for updating or removing.”

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

## VS Code and Copilot identity

`vscode` is a display alias for `copilot` only when reporting artifact counts.

- Keep raw client names in MCP output because VS Code and Copilot have separate MCP support.
- Keep `vscode` and `copilot` as distinct internal client types with separate path mappings.


## Git source credentials

Reject HTTP(S) userinfo and SSH passwords at plugin declaration validation,
CLI install intake and remote descriptor parsing before output or writes.
Diagnostics must not echo rejected source strings. SSH usernames and Git-managed
keys, agents and credential helpers remain supported.
