# Changelog

## [Unreleased]

### Breaking Changes

- **MCP setup commands**: HTTP servers added with `allagents mcp add` now
  authenticate and route through AllAgents automatically. The public
  `--proxy` option and `mcp auth <serverUrl>` command were replaced by
  `mcp reauth <name>`. The generated `mcp proxy` helper remains internal.

  **Migration**: Remove `--proxy` from `mcp add` calls. Replace
  `allagents mcp auth <url>` with `allagents mcp reauth <configured-name>`.

- **Plugin Git ref terminology**: Renamed workspace plugin `pin` to `ref`, CLI
  `--pin` to `--ref`, and sync-state `pinnedRef` to `requestedRef`. Inline
  `owner/repo@ref` sources are unchanged.

  **Migration**: Replace `pin:` with `ref:` in plugin objects and `--pin` with
  `--ref` in scripts. This is a clean cutover; the old names are not accepted.

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
- Versioned user and project workspace JSON Schemas generated from the runtime
  Zod models, with CI drift enforcement and YAML Language Server setup docs.
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
