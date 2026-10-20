# Review: VS Code workspace write-back

Status: proposed direction; runtime behavior is unchanged by this review.
Reviewed against `593fd371caa85289317b3486ca8782f586c2ad77` on 2026-10-20.

## Recommendation

Make YAML authoritative for VS Code generation during ordinary synchronization.
Move reverse synchronization into an explicit import action with a preview.
Preserve pending editor changes during migration; simply disabling import and
overwriting the generated file would lose the workflow this feature supports.

This review is a decision prerequisite, not an implementation of that policy.
It covers VS Code folder/name imports. Automatic legacy YAML migrations and
explicit plugin/configuration edits are separate ownership questions.

## Why automatic import exists

[Issue 181](https://github.com/allagentsdev/allagents/issues/181) requested that
removing a folder in VS Code also remove its declaration in YAML.
[PR 189](https://github.com/allagentsdev/allagents/pull/189) deliberately added
two-way folder synchronization. [PR 328](https://github.com/allagentsdev/allagents/pull/328)
extended it to folder display names. Users can therefore maintain repositories
through the VS Code workspace UI without repeating those edits in YAML.

Comment loss was a separate serialization bug affecting every workspace writer.
Preserving comments remains necessary for deliberate CLI configuration edits,
regardless of the decision about automatic VS Code import.

## Current behavior and ownership

The relevant paths are
[`syncVscodeWorkspaceFile`](../../src/core/sync.ts),
[`reconcileVscodeWorkspaceFolders`](../../src/core/vscode-workspace.ts), and
the path/hash fields in [`SyncState`](../../src/models/sync-state.ts).

1. Project sync collects both workspace and plugin-specific clients. If that
   set contains `vscode`, a non-dry run reaches the VS Code generation stage.
2. A prior sync must have recorded the generated file's hash and repository
   paths. First sync and unchanged file bytes skip reverse import.
3. Any changed file bytes trigger reconciliation, including settings or
   whitespace changes unrelated to folders.
4. Reconciliation imports editor additions/removals and display names into
   `workspace.yaml`. YAML-only path additions survive and YAML-only path
   deletions are respected. There is no previous-name baseline for resolving
   competing display-name edits.
5. The stage always regenerates `.code-workspace` afterward. Invalid JSON or an
   import/write error is silently caught before generation continues. Valid
   JSON without an array-valued `folders` field is treated as an empty list.

This stage runs inside generic project sync. Plugin install, uninstall and
update can invoke it; it is not limited to a command that explicitly imports
VS Code settings. It also runs after some other workspace-derived output has
already been generated, so a repository change imported here can leave earlier
outputs based on the old repository list until another sync.

## Reproduced through the built CLI

Built with `bun install --frozen-lockfile` and exercised `node dist/index.js`
in isolated project and HOME directories, using project scope and offline
updates. All commands produced successful JSON results. These are observations
of the existing implementation, not acceptance of the resulting policy.

| Scenario | Observed result |
| --- | --- |
| Remove a generated repository folder, then run update | Repository declaration is removed from YAML; surviving comments remain. |
| Run dry-run before applying that removal | YAML, generated workspace, and sync-state bytes remain unchanged. |
| Rename a repository in YAML and change only a generated workspace setting | The stale generated display name replaces the newer YAML name. |
| Rename only in YAML, leaving workspace bytes unchanged | YAML keeps the new name and generation uses it. |
| Replace generated output with valid JSON containing only `settings` | All previously synchronized repository declarations are removed from YAML. |
| Remove a generated folder, then install a local plugin | The plugin is declared and the unrelated repository removal is imported in the same invocation. |
| Leave a template-only folder unchanged, but edit a generated setting | The template folder becomes a YAML repository because it is absent from the saved repository baseline. |

Existing unit and sync integration tests establish useful path-merging behavior,
including concurrent YAML additions. They do not establish conflict protection
for display names, template-only folder ownership, or a malformed folder list.

## Alternatives and compatibility

| Approach | Benefit | Cost |
| --- | --- | --- |
| Keep automatic import and harden it | Preserves the existing editor-first workflow. | Retains two configuration authorities; requires folder provenance, name baselines, validation, conflict handling, and clear output. |
| Make automatic import opt-in | Existing users can deliberately retain the workflow. | Adds a persistent mode and keeps the same merge machinery; changing the default still needs migration. |
| Explicit import; ordinary sync generates from YAML | Makes configuration changes deliberate and gives import its own review/validation boundary. | Adds an import step for existing users and needs safe handling of pending editor changes. |

Explicit import is recommended because its ownership boundary matches a
human-authored YAML file and keeps unrelated plugin operations from changing
repository declarations. The existing convenience is real; this is a product
compatibility change, not a parser cleanup or a bug-only removal.

## Proposed implementation contract for review

- Ordinary VS Code generation does not write repository paths or names into
  YAML. This is scoped to the VS Code stage, not a claim that every other sync
  path is already read-only toward configuration.
- Provide an explicit import action, provisionally `allagents workspace
  import-vscode`, that previews added/removed/renamed repositories before apply.
  Its final command spelling is part of implementation review.
- Validate the workspace and folder entries before planning changes. Invalid
  or missing folder data must never stand for a request to remove every repo.
- Preserve YAML-only metadata, shorthand, comments and permissions. Distinguish
  generated template folders from repositories; show ambiguous additions or
  competing edits in the plan rather than silently resolving them.
- Use the same planned change in human and JSON output. Offer a read-only
  dry-run; make noninteractive application an explicit command invocation with
  an explicit apply acknowledgement. Reuse existing CLI conventions where they
  satisfy that contract.
- Detect pending editor folder/name changes before a normal sync overwrites
  them. Check at sync preflight, before publishing workspace-derived outputs,
  and report how to import or explicitly discard the editor changes. A changed
  whole-file hash alone is insufficient evidence of folder edits. An explicit
  configuration edit already saved by the invoking command, such as a plugin
  declaration, remains saved; report that separately from the blocked sync.
  This proposal does not introduce command-wide rollback.
- Announce the changed default and explain how current automatic-import users
  preserve their pending work. Do not infer consent from old sync-state fields.
  A permanent compatibility mode is a separate choice, not a requirement of the
  recommended design.

Acceptance must cover first/unchanged sync, settings-only edits, YAML-only edits,
editor-only edits, concurrent additions/removals/renames, template folders,
invalid folder data, path normalization, stale-plan rejection, dry-run/JSON
contracts, failed writes, and plugin operations that trigger project sync.

The decision to change the default remains open in this review. No automatic
import behavior has been removed or made opt-in by this PR.
