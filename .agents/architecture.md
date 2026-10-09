# Architecture Boundaries

This guide expands [`AGENTS.md`](../AGENTS.md) for synchronization ownership, output formatting, and client identity rules.

## MCP server ownership

MCP servers from plugins are synchronized into VS Code's `mcp.json`.

- Track only servers AllAgents added.
- Preserve a server that existed in the user's configuration before plugin installation.
- Remove or update only entries represented by `trackedServers`.

`trackedServers` means “servers AllAgents owns and is responsible for updating or removing.”

## Synchronization output

Synchronization results are surfaced by multiple entry points:

- `update` and `workspace sync` in `src/cli/commands/workspace.ts`
- `plugin install|uninstall|update` in `src/cli/commands/plugin.ts`
- TUI synchronization actions in `src/cli/tui/actions/sync.ts`

Put shared formatting in `src/cli/format-sync.ts` rather than duplicating it at call sites. Keep JSON, redirected human output, and interactive TTY behavior as distinct contracts.

## Plugin source and destination identity

- Explicit npm/Git package sources are not `plugin@marketplace` declarations. Do not interpret npm versions, Git refs, or SSH transport usernames as marketplace names.
- Keep independently configured package and file installations distinct, even when they expose the same upstream skills. UI hints should identify their configured clients, install methods, and scopes; updates/removals retain exact source and configuration-index targeting.
- Native package availability comes from native resource inspection, not from treating the source string as a local cache path.
- The Plugins menu selects individual resources. Bulk updates remain under Workspace → Status → Update all.

## VS Code and Copilot identity

`vscode` is a display alias for `copilot` only when reporting artifact counts.

- Keep raw client names in MCP output because VS Code and Copilot have separate MCP support.
- Keep `vscode` and `copilot` as distinct internal client types with separate path mappings.
