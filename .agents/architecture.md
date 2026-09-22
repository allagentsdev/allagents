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

## VS Code and Copilot identity

`vscode` is a display alias for `copilot` only when reporting artifact counts.

- Keep raw client names in MCP output because VS Code and Copilot have separate MCP support.
- Keep `vscode` and `copilot` as distinct internal client types with separate path mappings.
