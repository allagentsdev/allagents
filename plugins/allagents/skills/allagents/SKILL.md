---
name: allagents
description: Manage AllAgents workspaces, plugins, skills, client targets, global profiles, and MCP servers through the allagents CLI. Use when a user asks to initialize, inspect, update, or configure AllAgents; install or remove plugins or skills; manage profiles; or add, inspect, authenticate, update, or remove MCP servers. Resolve current command syntax from machine-readable help instead of relying on remembered flags.
---

# AllAgents CLI

The installed AllAgents CLI owns the current command surface and operational contract. This skill only resolves the runner, loads that contract, and applies it. Do not maintain a second command reference here.

## Resolve the CLI runner

Choose one runner at the start of the task and use it for discovery, execution, and verification:

1. If `allagents` is on `PATH`, use `allagents`.
2. Otherwise, if `npx` is available, use `npx --yes allagents`.
3. If neither is available, stop and ask the user to install AllAgents or Node.js with npm.

Examples and returned `help_command` values use the canonical `allagents` token. When `npx --yes allagents` is the selected runner, replace only that leading token before executing every discovery, execution, and verification command. Do not mix runners within one operation.

## Load the current contract

1. Confirm the selected runner with `allagents --version`.
2. Discover the concise top-level index with `allagents --help --json`.
3. Choose an entry, rewrite its leading runner token when required, and execute its `help_command`; group responses reveal only their immediate children.
4. Continue through nested groups until a leaf command returns its full contract.
5. Follow the leaf's `when_to_use`, positionals, options, examples, interaction requirement, expected output, output schema, and JSON field allowlist.

The structured response is authoritative. Do not rely on remembered flags, copied examples, aliases, destination behavior, or mutation semantics. If the installed CLI does not advertise an operation, do not invent it.

## Execute through the discovered surface

- Run `allagents` without arguments in an interactive terminal only when the user wants to browse and choose in the TUI.
- Use the discovered direct command when the operation is already known.
- For automation, use `--json` plus only the explicit selectors and non-interactive options advertised by the leaf help.
- Use `--json=<fields>` only with fields in the leaf's JSON allowlist. Use `--jq` only with JSON output.
- Prefer an advertised CLI command over hand-editing an AllAgents declaration or generated client file.
- Preserve the exact scope, destination, profile, clients, and other ownership selectors requested by the user. If the request is insufficient and the CLI requires a choice, ask rather than guessing.
- Never echo credentials. Supply sensitive values only through mechanisms advertised by the current leaf help.

Treat the process exit code and structured result as authoritative. After a mutation, rediscover and run the relevant read-only list, get, or status command against the same selectors. Do not claim success from a config write alone when the CLI reports a partial update or failed client reconciliation.

## Recover from errors

- Read the structured error before retrying.
- If command syntax is rejected, reload root, group, and leaf help; do not fall back to stale syntax.
- If a mutation may have partially applied, inspect current state before any retry.
- Follow only recovery operations exposed by the installed CLI.

## Completion

Report the selected runner, command path, explicit selectors, structured result, and verification command. Completion requires the declared state and corresponding live or generated state to agree, or an explicit partial-update result with the CLI-advertised recovery path.
