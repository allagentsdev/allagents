---
title: Bring the AllAgents MCP implementation to feature parity with mcp-remote
date: 2026-11-09
type: feat
baseline: mcp-remote@0.16.5
execution: implementation
---

# Goal

Keep AllAgents' integrated MCP setup and recovery experience and close the
capability gaps against the published `mcp-remote@0.16.5` CLI. The user chose
improving AllAgents rather than delegating its implementation to an automatically
downloaded `mcp-remote` process. Do not introduce that dependency as a substitute.

The comparison baseline is an exact published version, not a moving GitHub
branch. Verify its executable, documentation and behavior when resolving a
parity claim. Do not call the work complete after fixing only the two protocol
gaps demonstrated below.

# Settled requirements

- Preserve the public `mcp add`, `reauth`, `tools`, `call`, configuration and
  synchronization workflows across project, user and named-profile destinations.
- Preserve `oauth.clientName` and `--oauth-client-name`. This changes OAuth
  `client_name`, not the MCP initialization identity or ownership of another
  application's credentials. Default registration remains AllAgents.
- Keep credentials isolated by URL, effective OAuth identity and profile. An
  identity change must not reuse another identity's registration or tokens.
- Keep configured resource headers restricted to the resource origin, with
  transport-owned headers taking precedence. Do not copy upstream's observed
  forwarding of resource headers to the separate identity-provider origin.
- Keep runtime discovery, live help and calls noninteractive: cached/refreshable
  credentials work; fresh consent yields a destination-specific reauth command.
- Preserve normal loopback login, pasted remote-browser callbacks, cancellation,
  reauth rollback, secret-reference resolution and credential-reflection checks.
- Preserve JSON and redirected-output contracts and user-owned client config.
- Use the official MCP SDK and existing modules where practical. Remove the
  fixed forwarding bottleneck rather than adding more one-off handlers.
- Feature work must ship through a feature branch and reviewed PR. Do not change
  versions, release tags or CHANGELOG.md manually.

# Verified starting evidence

Baseline AllAgents: latest fetched `origin/main`, commit
`782ffc95a71ebb50b87881c54c31933a21167b82`, published version 1.23.0. The OAuth
client-name feature shipped in PR #607. The primary checkout remains stale;
implementation belongs in the dedicated worktree, not that checkout.

Hands-on trials used the built AllAgents CLI, published upstream 0.16.5, real
stdio processes, agent-tui PTYs and isolated local MCP/OAuth servers:

- AllAgents completed one login and generated Codex and Copilot configuration.
- Cached discovery/calls, token refresh, generated tool help and exact JSON calls
  worked. Pasted callback login worked. Cancelled reauth preserved a usable grant.
- Default, Codex and profile-owned Codex credentials remained separate.
- AllAgents sent a custom resource header to the resource but not the distinct
  OAuth origin; upstream sent it to OAuth discovery, registration and token paths.
- Upstream changing `client_name` within one cache reused its original identity.
- Fresh noninteractive upstream connections attempted browser auth and waited;
  AllAgents failed promptly with the expected reauth guidance.
- Upstream delivered `notifications/tools/list_changed` and `roots/list` to the
  host. AllAgents delivered zero notifications and returned Method not found for
  roots; the remote side saw empty host capabilities.
- AllAgents' rejected registration displayed only `Error:`. Unreachable setup
  displayed `Error: fetch failed`. Improve these without reflecting credentials.

Local evidence (machine-local, not a portable prerequisite):

- `/tmp/allagents-mcp-ux-CaaebnsH/evidence.json`
- `/tmp/allagents-mcp-ux-CaaebnsH/protocol-bridge.ts`
- `/tmp/allagents-mcp-ux-CaaebnsH/protocol-bridge-results.json`
- `/tmp/allagents-mcp-ux-CaaebnsH/upstream-report.md`
- `/tmp/allagents-mcp-ux-CaaebnsH/upstream/` contains installed published upstream,
  fixture scripts and raw logs; temporary credentials have been removed.

No live Notion/Figma consent, real desktop browser, native Codex/Copilot host,
Windows/macOS or exhaustive protocol conformance was proved by those trials.

# Parity inventory and acceptance ledger

Before implementation, confirm every row against the published upstream
README/parser and SDK. Record unsupported or experimental upstream behavior
explicitly; resolve its implementation scope rather than silently dropping it.

| Capability | Acceptance evidence |
| --- | --- |
| Streamable HTTP and legacy SSE | Real servers for both; automatic eligible fallback and each forced strategy; no endless retry loop. Distinguish legacy SSE from SSE responses within Streamable HTTP. |
| Bidirectional protocol forwarding | Preserve host capabilities, request/response IDs and errors; roots, sampling, elicitation, notifications, progress, cancellation, logging, resource subscriptions and supported task operations reach their intended peer. |
| Capability and version negotiation | Advertise only supported behavior; preserve server metadata and selected protocol version. Investigate upstream's opt-in modern-protocol translation before claiming full parity. |
| OAuth discovery and metadata | Dynamic registration, client-name override, static registration/client ID and metadata, scopes, client metadata URL, resource indicators, extra authorization parameters and disabling the resource parameter. |
| Alternative authorization | Inventory and implement upstream device-code/client-credentials and ID-token behavior where supported; maintain explicit user consent and cached-only runtime policy. |
| Authorization callbacks | Configurable port/host/bind host/path, timeout and success destination where upstream exposes them; preserve existing loopback defaults and pasted-callback validation. |
| Shared credential coordination | Concurrent cold starts avoid competing registration/browser flows; token refresh is coordinated; owner failure and cancellation permit recovery without cross-identity sharing. |
| Mid-session authorization | A challenge after initialization can recover in interactive bridge use; finite runtime commands return reauth guidance instead of requesting new consent. |
| Tool filtering | Wildcards remove tools from discovery and prevent direct calls to excluded tools; cover notification-driven catalog changes and pagination. |
| Network controls | Inventory and cover proxy environment support, custom trust roots, HTTP allowance, network timeouts, keep-alive/ping and IPv4 selection without weakening existing defaults. |
| Diagnostics | Useful failure context, debug/silent behavior and redaction; no protocol contamination of stdout; no credentials in logs or process arguments generated from secret references. |
| All supported callers | YAML, CLI, management preflight, runtime, generated bridges, plugin declarations and profiles consistently use the same selected policy. |

# Implementation approach

## 1. Inventory and freeze shared interfaces

Read the current HTTP connector/provider, bridge, workspace schemas, management,
runtime and sync callers. Inspect focused tests and current upstream published
features. Build a durable public compatibility matrix from the ledger above.
Choose one shared typed connection policy and one configuration-to-runtime
translation boundary before concurrent implementation. Reuse the YAML writer.

Keep the SDK upgrade decision evidence-based: identify which required behavior
the locked SDK already supports before introducing a broad version migration.
Do not rely on private SDK fields or cast away unsupported protocol behavior.

Likely integration files:

- `src/core/mcp-http-client.ts`
- `src/core/mcp-http-stdio-proxy.ts`
- `src/core/mcp-proxy.ts`
- `src/core/mcp-management.ts`
- `src/core/mcp-runtime.ts`
- `src/models/workspace-config.ts`
- `src/cli/commands/mcp.ts`
- profile/synchronization adapters reached by these shared types

## 2. Replace fixed forwarding and add transport compatibility

Start with regression proof for the demonstrated lost notification and roots
request. Implement a generic transport/protocol boundary with deterministic
startup, authentication, cancellation and shutdown. Negotiate host/server
capabilities correctly. Add real HTTP/SSE fixtures and prove fallback behavior.
Keep server errors and all supported protocol message shapes intact.

## 3. Extend authentication while retaining AllAgents contracts

Expose the inventoried metadata/grant/callback capabilities through the shared
policy. Scope registrations and grants to every identity-affecting option.
Coordinate registration and refresh across processes with bounded waits and
recoverable ownership. Test revocation, mid-session challenges and cancellation.
Maintain origin-safe fetch and cached-only runtime behavior through every path.

## 4. Add connection controls and propagate configuration

Implement filtering, timeout/keep-alive, network/proxy and diagnostics controls
identified by the inventory. Wire them through all declarations and generated
configs; validate portable secret references for profiles. Keep broad option
objects out of generated command lines where they would expose credentials.
Update user docs and agent guidance for durable architecture boundaries.

## 5. Verify, review and ship

Run focused tests per unit, then integrated typecheck, lint, schema generation
check, build, package checks and relevant E2E/full-suite checks. Exercise the
built Node CLI with temporary HOME/project/profile fixtures and real processes.
Review and simplify the integrated diff. Fix findings before final E2E, commit
only owned paths, push and open a conventional-title PR with exact evidence.
Watch CI and report the exact remaining blocker if any check cannot complete.

# Verification requirements

Regression coverage should extend the existing homes:

- `tests/unit/core/mcp-http-stdio-proxy.test.ts`
- `tests/unit/core/mcp-proxy.test.ts`
- `tests/unit/core/mcp-runtime.test.ts`
- `tests/unit/models/workspace-config-mcp-proxy.test.ts`
- `tests/e2e/mcp-proxy-oauth.test.ts`
- `tests/e2e/mcp-add-proxy.test.ts`
- `tests/e2e/mcp-runtime-cli.test.ts`
- new protocol/transport/concurrency fixtures and tests when behavior needs them

For each changed behavior, capture a failing proof before production changes
when practical. Tests must assert observable protocol/config/filesystem results,
not internal calls or implementation-shaped snapshots. Keep fixture processes,
sessions and children bounded and cleaned up on success, failure and interrupt.

Retest the setup/recovery flows witnessed in the UX trials, plus all newly
implemented parity rows. Use agent-tui for changed terminal interactions and
the repository's MP4 evidence requirements for visible TUI changes. Do not call
mocked browser approval proof of live-provider compatibility.

# Definition of done

- Every parity row has implemented, verified evidence or an explicitly resolved
  scope decision. Do not claim full parity while required rows remain open.
- Existing AllAgents setup, recovery, credential, scope and output contracts pass.
- User documentation and durable agent guidance describe the final behavior.
- Review findings are resolved, required checks pass, and a feature PR is open.

# Resume checkpoint

This section records the initial handoff point, not an assertion that features
are implemented. Future execution progress belongs in commits and handoff notes.

- Canonical worktree:
  `/home/christso/projects/allagentsdev/allagents.worktrees/feat-mcp-parity`
- Branch: `feat/mcp-parity`, based on fresh `origin/main` at `782ffc9`.
- Engine: native implementation. No external-model route configured.
- Dependencies installed with locked Bun dependencies:
  `bun install --frozen-lockfile --ignore-scripts --cafile=/etc/ssl/certs/ca-certificates.crt --registry=https://registry.npmjs.org`
- No production implementation has started at this checkpoint.
- Next action: finish the published feature inventory and shared-interface design,
  then dispatch independent implementation slices with exclusive file ownership.
- Read root `AGENTS.md` and applicable `.agents/` routes before resuming. The
  primary checkout is stale and must not be used as the implementation base.
