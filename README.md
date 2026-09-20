# AllAgents

[![npm](https://img.shields.io/npm/v/allagents)](https://www.npmjs.com/package/allagents)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Docs](https://img.shields.io/badge/docs-allagents.dev-blue)](https://allagents.dev)

Write AI agent skills once. Sync across every configured client. Manage across multiple repos.

AllAgents keeps your AI tooling (skills, agents, hooks, MCP servers) in one workspace and syncs it everywhere your team works — including Claude Code, GitHub Copilot, Cursor, Codex, OpenCode, and dozens more.

## Quick Start

```bash
# Create a workspace from a shared template
npx allagents init my-workspace --from myorg/templates/nodejs
cd my-workspace

# Install a plugin, choosing its scope and target clients interactively
npx allagents plugin install code-review@claude-plugins-official

# Sync to all configured clients
npx allagents update
```

No cloning required — AllAgents fetches the `workspace.yaml` directly from GitHub and sets up everything.

Install the end-user AllAgents skill when you want your coding agent to operate
the CLI using its current machine-readable command contracts:

```bash
npx allagents plugin install allagents@allagentsdev/allagents --scope user
```

## How It Works

1. **Configure** your workspace with repos, plugins, and target clients in `workspace.yaml`
2. **Sync** — AllAgents copies skills, agents, hooks, and MCP servers to each client's expected paths
3. **Work** — every team member gets identical AI tooling via git, across any client they choose

```
┌─────────────────┐
│   Marketplace   │  GitHub repos containing plugins
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│    AllAgents     │  sync & transform
│      sync       │
└────────┬────────┘
         │
    ┌────┴────┬────────┬─────────┐
    ▼         ▼        ▼         ▼
.claude/  .github/  .cursor/  .agents/   client paths
```

## Why AllAgents?

`npx skills` installs skills across many client destinations, while `npx plugins` installs richer plugin artifacts into its supported clients. AllAgents manages skills, agents, hooks, commands, and MCP servers across multiple repositories and clients from one declarative workspace.

| | `npx skills` | `npx plugins` | `npx allagents` |
|---|---|---|---|
| **Config** | Imperative | Imperative | Declarative (`workspace.yaml`) |
| **Scope** | Single project | Single project | Multi-repo workspace |
| **Artifacts** | Skills | Skills, agents, hooks, commands, MCP | Skills, agents, hooks, commands, MCP |
| **Clients** | 79 destination IDs (`skills@1.7.0`) | 2 (Claude, Cursor) | Canonical registry plus compatibility aliases |
| **Team sharing** | Each dev runs install | Each dev runs install | Git-versioned — clone and go |
| **Ongoing sync** | One-shot install | One-shot install | `allagents update` keeps everything current |
| **Workspace awareness** | None | None | WORKSPACE-RULES injected so AI knows all repos and skills |
| **Provider resilience** | Per-client | Per-client | Switch clients instantly — same tooling everywhere |

## workspace.yaml

```yaml
workspace:
  source: ../shared-config
  files:
    - AGENTS.md

repositories:
  - path: ../my-project
    description: Main project
  - path: ../my-api
    description: API service

plugins:
  - code-review@claude-plugins-official
  - my-plugin@someuser/their-repo

clients:
  - claude
  - copilot
  - cursor
```

## Commands

| Command | Description |
|---|---|
| `allagents init <path>` | Create a workspace (optionally `--from owner/repo`) |
| `allagents update` | Sync all plugins to workspace |
| `allagents update --profile <name>` | Reconcile an installed global profile |
| `allagents plugin install <spec> [--scope project\|user] [--client <clients>] [--yes]` | Install a plugin for selected scope and clients |
| `allagents plugin uninstall <spec>` | Remove a plugin |
| `allagents plugin list` | List installed plugins and skills with source, scope, and clients |
| `allagents profile install <name> --yes` | Install a declared global profile |
| `allagents profile list` | List declared and installed profiles with clients and launchers |
| `allagents profile status [name]` | Inspect declared and installed profiles |
| `allagents profile remove <name> --yes` | Remove unchanged managed profile resources |
| `allagents skill add <name> [--from <source>] [--scope project\|user] [--client <clients>] [--yes]` | Add source-backed skills for selected scope and clients (plural `skills` alias supported) |
| `allagents skill list` | List skills and status |
| `allagents mcp add <name> <commandOrUrl> [--scope user \| --profile <name>]` | Add, authenticate, and sync an MCP server |
| `allagents mcp reauth <name> [--scope user \| --profile <name>]` | Reauthenticate an HTTP MCP server in one destination |
| `allagents mcp list [--scope user \| --profile <name>]` | List MCP declarations in one destination |
| `allagents mcp tools <server> [--search <text>] [--scope user \| --profile <name>]` | Discover a configured server's live tools |
| `allagents mcp call <server> <tool> [options] [--scope user \| --profile <name>]` | Inspect or call a live MCP tool |
| `allagents workspace status` | Show workspace state |
| `allagents self update` | Update AllAgents CLI |

See the [full CLI reference](https://allagents.dev/docs/reference/cli/) for all options.

## Supported Clients

AllAgents has one canonical, capability-aware client registry. It covers shared
`.agents/skills/` destinations, provider-specific skill roots, and project-only
clients, while separately recording instruction, command, agent, hook, GitHub
overlay, MCP, native, and profile support. Compatibility aliases such as
`claude-code` and `github-copilot` normalize to their canonical AllAgents IDs.

See the [client support matrix](https://allagents.dev/docs/reference/clients/) for paths, hooks, commands, and MCP support per client.

## Plugin Structure

```
my-plugin/
├── skills/          # Reusable prompts (all clients)
│   └── debugging/
│       └── SKILL.md
├── agents/          # Agent definitions
├── commands/        # Slash commands (Claude, OpenCode)
├── hooks/           # Lifecycle hooks (Claude, Factory, Copilot, Codex)
├── .codex-plugin/   # Codex plugin manifest and explicit hook paths
├── .github/         # Copilot/VSCode project overrides
└── .mcp.json        # MCP server configs
```

For Codex project sync, AllAgents copies skills into `.codex/skills/`, merges
plugin hooks into `.codex/hooks.json`, and preserves user-owned hooks already in
that file. Codex plugins can declare hooks in `.codex-plugin/plugin.json` with a
`hooks` path, path array, inline object, or inline object array; otherwise
AllAgents falls back to `hooks/hooks.json`.

For Copilot project sync, AllAgents combines plugin hook declarations from
`hooks.json` or `hooks/hooks.json` in `.github/hooks/allagents.json` and binds
`COPILOT_PLUGIN_ROOT` for each plugin. Other repository hooks under
`.github/hooks/` remain project-scoped and are never promoted into the
user-global `~/.copilot/hooks/` directory. Copilot package metadata under
`.github/plugin/` is not copied into the project overlay. Potential user-scope
copies from older versions are left untouched and reported for manual review
because their ownership was not tracked.

Marketplace registration and `plugin.json` are not required for direct plugin
sources. A plugin without a supported hook declaration continues syncing its
other artifacts. AllAgents warns and omits a declaration that cannot be read or
parsed as JSON or lacks the version-1 `hooks` object envelope. A declaration
with `disableAllHooks: true` adds no entries; otherwise, a non-array event value
also omits the declaration. Skipping a declaration does not reject the plugin
or itself suppress other eligible artifacts, including repository hook files.

## Documentation

Full documentation at [allagents.dev](https://allagents.dev):

- [Getting Started](https://allagents.dev/docs/getting-started/introduction/)
- [Workspaces Guide](https://allagents.dev/docs/guides/workspaces/)
- [Plugins Guide](https://allagents.dev/docs/guides/plugins/)
- [Agent Portability](https://allagents.dev/docs/guides/agent-portability/)
- [Client Support Matrix](https://allagents.dev/docs/reference/clients/)
- [Configuration Reference](https://allagents.dev/docs/reference/configuration/)

## Related Projects

- [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) — Universal skills for AI coding assistants
- [skillpm](https://github.com/sbroenne/skillpm) — npm-native package manager for Agent Skills
- [skills-npm](https://github.com/antfu/skills-npm) — Discover agent skills shipped in npm packages
- [dotagents](https://github.com/iannuttall/dotagents) — Unified AI agent configuration management

## License

MIT
