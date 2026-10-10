# Pi Engineering

An opt-in, project-scoped Pi workspace with a complete research-to-review stack:

| Package | Purpose |
| --- | --- |
| [pi-web-access](https://github.com/nicobailon/pi-web-access) | Web research and source retrieval |
| [pi-compound-engineering](https://github.com/jvm/pi-mono/tree/main/packages/pi-compound-engineering) | Brainstorm, plan, implement, review, and capture lessons |
| [pi-subagents](https://github.com/nicobailon/pi-subagents) | Delegation and parallel agent work |
| [pi-ask-user](https://github.com/edlsh/pi-ask-user) | Structured clarification and interactive decisions |

Compound Engineering uses subagents and interactive questions in its workflows;
web access supplies the research tools. This is a Pi-specific alternative to the
portable [`engineering`](../engineering/) template, not an extra layer to install
on top of its existing Compound Engineering skills.

## Prerequisites

- Pi on `PATH`; this pinned stack is verified with Pi **1.1.0**. AllAgents must
  include the minimum-only Pi compatibility fix (older AllAgents versions reject
  Pi releases after 0.85.x).
- Node.js **22.19.0 or newer**, npm, `tar`, and network access during installation.
  Use Linux, macOS, or WSL; the pinned Compound Engineering installer requires
  `tar` and is not supported on native Windows.
- Review the third-party packages before trusting the project. Pi extensions and
  package lifecycle scripts execute code with your user account's permissions.

## Create a workspace

Save trust for the actual target directory **before** AllAgents attempts native
installation:

```sh
mkdir pi-engineering-demo
cd pi-engineering-demo
pi
```

In Pi, run `/trust`, save a trusted decision for this folder, then exit. A one-time
`--approve` is not a saved decision and does not authorize AllAgents' later
processes. AllAgents reads trust from the user Pi agent root outside the project;
it does not set `defaultProjectTrust: always` or grant trust through setup scripts.

Then initialize and install the stack:

```sh
allagents workspace init . \
  --from allagentsdev/allagents/examples/workspaces/pi-engineering
allagents plugin list
pi list
pi
```

From a local repository checkout, replace `--from` with the absolute path to
`examples/workspaces/pi-engineering`.

In the new Pi session, inspect `/ce-status` and `/subagents-doctor`. Confirm the
Compound Engineering skills are listed and the question and web tools are
available; some tools activate on demand. Installing packages alone does not
verify provider credentials or execute delegated work.

## Ownership and configuration

The template declares packages under `plugins` with `pi:native`. AllAgents invokes
Pi's native lifecycle rather than copying TypeScript extensions or running a
second install script. Pi writes project package declarations to
`.pi/settings.json` and installs npm packages under `.pi/npm/`. AllAgents tracks
its native resources in `.allagents/sync-state.json` and preserves pre-existing,
referenced installations when removing declarations.

Your Pi model authentication and web-provider configuration remain user-owned.
Configure Pi authentication normally. Web access supports keyless search and can
reuse supported Pi authentication; consult its upstream README for provider
selection and optional `~/.pi/agent/web-search.json` configuration. Keep API keys,
OAuth state, and machine-specific settings out of the shared template.

Compound Engineering generates its skills through package install scripts. In CI
or offline mode, installation may succeed without generating those skills. If
`/ce-status` reports missing skills, or npm blocks the package's lifecycle scripts,
follow the upstream Compound Engineering approval/rebuild instructions for the
**project install root `.pi/npm`**, then restart Pi. Review scripts before approving
only that package; avoid blanket script approval. The package may also maintain
its own Pi tool-map block in the project's `AGENTS.md` when Pi starts.

## Update or remove

The recipe pins reviewed package versions. To upgrade the shared stack, change a
pin in `.allagents/workspace.yaml`, review that release, then run a targeted update:

```sh
allagents plugin update npm:pi-web-access --scope project
```

Updating without changing a pin reconciles the pinned version; it does not select
latest. To remove a declaration and safely reconcile its managed installation:

```sh
allagents plugin uninstall npm:pi-web-access --scope project
```

If the same package is also configured globally, AllAgents refuses a targeted
update that could affect both scopes. Avoid duplicating this stack globally and
project-locally. For a personal stack shared across unrelated projects, use an
[AllAgents global profile](https://allagents.dev/docs/reference/configuration/#global-profiles)
instead of this project template.
