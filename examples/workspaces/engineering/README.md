# Engineering

One project workspace with portable engineering skills and Pi-native tools.
The portable sources install into `.agents/skills/` through the `universal`
client: Compound Engineering, selected Matt Pocock workflows and their helpers,
Hermes LLM Wiki, and Herdr. The workspace also retains the optional Herdr
installation commands, which run only when you invoke `allagents workspace setup`.

The following pinned packages install through Pi's native lifecycle:

| Package | Purpose |
| --- | --- |
| [pi-web-access](https://github.com/nicobailon/pi-web-access) | Web research and source retrieval |
| [Compound Engineering](https://github.com/EveryInc/compound-engineering-plugin#pi) | Official upstream Pi package: brainstorm, plan, implement, review, and capture lessons |
| [pi-subagents](https://github.com/nicobailon/pi-subagents) | Delegation and parallel agent work |
| [pi-ask-user](https://github.com/edlsh/pi-ask-user) | Structured clarification and interactive decisions |

Pi Compound Engineering uses subagents and interactive questions in its workflows;
web access supplies the research tools. Each native declaration targets only `pi`
with `install: native`, while the portable sources inherit `universal` file
installation. The two Compound Engineering distributions remain separate
resources with independent destinations and lifecycles. Both use the reviewed
`compound-engineering-v3.30.5` release; Pi installs the upstream Git package directly.

## Prerequisites

- Pi on `PATH`; this pinned stack is verified with Pi **1.1.0**. AllAgents must
  include the minimum-only Pi compatibility fix (older AllAgents versions reject
  Pi releases after 0.85.x).
- Node.js **22.19.0 or newer**, npm, Git, and network access during installation.
- Review the third-party packages before trusting the project. Pi extensions and
  package lifecycle scripts execute code with your user account's permissions.

## Create a workspace

Save trust for the actual target directory **before** AllAgents attempts native
installation:

```sh
mkdir engineering-demo
cd engineering-demo
pi
```

In Pi, run `/trust`, save a trusted decision for this folder, then exit. A one-time
`--approve` is not a saved decision and does not authorize AllAgents' later
processes. AllAgents reads trust from the user Pi agent root outside the project;
it does not set `defaultProjectTrust: always` or grant trust through setup scripts.

Pi automatically discovers `.agents/skills` before package skills. Without a
resource selection, the portable Compound Engineering skills shadow the native
Pi versions. From this project directory, append exclusions for the portable
Compound Engineering files to your existing `.pi/settings.json`:

```sh
node --input-type=module <<'JS'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const path = resolve('.pi/settings.json');
const settings = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
if (settings.skills !== undefined && !Array.isArray(settings.skills)) {
  throw new Error('Expected settings.skills to be an array; no settings were changed.');
}
const portable = resolve('.agents/skills').replaceAll('\\', '/');
settings.skills = [...new Set([
  ...(settings.skills ?? []),
  `!${portable}/ce-*/SKILL.md`,
  `!${portable}/lfg/SKILL.md`,
])];
mkdirSync('.pi', { recursive: true });
writeFileSync(path, JSON.stringify(settings, null, 2) + '\n');
JS
```

This preserves existing settings and skill selections. Pi still loads the other
universal skills and custom `.pi/skills` resources, while Compound Engineering
comes from the native package. The exclusions use the actual project path so
they also work beneath hidden directories. These machine-specific selections
remain user-owned; keep them out of the shared template and rerun the command if
you move the project. AllAgents preserves them when installing or updating packages.

Then initialize and install the stack:

```sh
allagents workspace init . \
  --from allagentsdev/allagents/examples/workspaces/engineering
allagents plugin list
pi list
pi
```

From a local repository checkout, replace `--from` with the absolute path to
`examples/workspaces/engineering`.

In the new Pi session, inspect `/subagents-doctor` and the `/skill:ce-` command
completions. Confirm the Compound Engineering skills are listed and the question
and web tools are available; some tools activate on demand. Installing packages
alone does not verify provider credentials or execute delegated work.

## Ownership and configuration

The template declares packages under `plugins` with `clients: [pi]` and
`install: native`. AllAgents invokes
Pi's native lifecycle rather than copying TypeScript extensions or running a
second install script. Pi writes project package declarations to
`.pi/settings.json`, installs npm packages under `.pi/npm/`, and checks out Git
packages under `.pi/git/`. AllAgents tracks
its native resources in `.allagents/sync-state.json` and preserves pre-existing,
referenced installations when removing declarations.

Your Pi model authentication and web-provider configuration remain user-owned.
Configure Pi authentication normally. Web access supports keyless search and can
reuse supported Pi authentication; consult its upstream README for provider
selection and optional `~/.pi/agent/web-search.json` configuration. Keep API keys,
OAuth state, and machine-specific settings out of the shared template.

The official Compound Engineering Git package includes its skills in the repository
and loads them through Pi's native package manifest. It does not use the former
`pi-compound-engineering` adaptation's skill-generation scripts or `/ce-status`
command. After installing or updating the package, run `/reload` or restart Pi.

## Update or remove

The recipe pins reviewed package versions. To upgrade the shared stack, change a
pin in `.allagents/workspace.yaml`, review that release, then run a targeted update:

```sh
allagents plugin update npm:pi-web-access --scope project
```

Updating without changing a pin reconciles the pinned version; it does not select
latest. For Compound Engineering, update both the portable `ref` and the native
Git source's `@compound-engineering-v...` suffix to the same reviewed release,
then run `allagents plugin update --scope project`.

When migrating an existing workspace from `npm:pi-compound-engineering@3.19.2`,
run `allagents plugin uninstall npm:pi-compound-engineering --scope project` before
replacing its declaration with the upstream Git package. This lets AllAgents
reconcile the old managed installation. Check `pi list` for a separately installed
user package and remove that old adaptation in Pi if present; loading both CE
packages can leave duplicate skill names.

To remove a declaration and safely reconcile its managed installation:

```sh
allagents plugin uninstall npm:pi-web-access --scope project
```

If the same package is also configured globally, AllAgents refuses a targeted
update that could affect both scopes. Avoid duplicating this stack globally and
project-locally. For a personal stack shared across unrelated projects, use an
[AllAgents global profile](https://allagents.dev/docs/reference/configuration/#global-profiles)
instead of this project template.
