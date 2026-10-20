# Review: VS Code workspace write-back

Status: implementation contract updated after the design review. The baseline
observations below describe the earlier implementation.
Reviewed against `593fd371caa85289317b3486ca8782f586c2ad77` on 2026-10-20.

## Recommendation

Keep one synchronization behavior, with no new mode, flag or import command:

- Changed VS Code folders/names update the corresponding YAML declarations.
- If those fields have not changed, do not write YAML. Preserve its exact bytes,
  including all formatting, comments and blank lines.
- Settings-only or whitespace-only changes in `.code-workspace` are not folder
  edits and must not cause a YAML rewrite.

Compare the relevant values with the previous synchronization snapshot. Preserve
the established edit-in-VS-Code, then sync workflow while detecting invalid data and failed writes without discarding pending edits.
Actual VS Code repository folder/name edits retain precedence when both files
change the same field; there is no new conflict prompt or opt-in surface.

This review records the ownership and compatibility decisions for implementation.
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

## Baseline behavior and ownership

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

## Compatibility

The existing editor workflow takes precedence over imposing a new import step.
VS Code is another human-operated configuration editor in this workflow; its
folder edits are not inherently unauthorized changes. The observed problems
call for safer merging, not removal of automatic write-back.

The synchronization snapshot must distinguish real editor changes from stale
generated content. That is an internal reconciliation responsibility, not a
reason to add configuration choices or change the user workflow.

## Implementation contract

- Preserve the default sequence: edit folders/names in VS Code, then run normal
  sync; actual repository changes are written into YAML before workspace output is
  regenerated. No new import command, flag or confirmation is required for that
  existing path.
- Compare semantic folder/name changes against an adequate previous snapshot,
  rather than using any whole-file byte change as evidence of a folder edit.
  A change on one side is applied; matching changes on both sides coalesce.
  An actual editor display-name change takes precedence over a competing YAML
  name. An unchanged generated name must not overwrite a YAML-only rename.
  Recover an older snapshot when its saved hash proves the previous folders.
  If recovery is impossible, retain legacy VS Code precedence for that first
  update, then save the full snapshot. This compatibility choice can apply a
  stale editor name over a competing YAML-only rename once; it avoids blocking
  the established upgrade workflow.
- If reconciliation requires no semantic YAML change, skip the YAML writer
  entirely. Byte-exact preservation is required, including for user-authored
  YAML formatting edits and unrelated `.code-workspace` changes. If an actual
  editor change requires a declaration edit, use the existing comment-preserving
  writer rather than regenerating YAML from normalized configuration.
- Validate the workspace and folder entries before planning changes. Invalid
  or missing folder data must never stand for a request to remove every repo;
  distinguish it from an explicit empty folder list.
- Preserve YAML-only metadata, shorthand, comments and permissions. Distinguish
  generated template folders from repositories; do not promote an unchanged
  template-only folder into YAML because unrelated output bytes changed.
- Reconcile at sync preflight, before publishing workspace-derived outputs, so
  those outputs use the resulting repository configuration. On an import
  validation failure or failed YAML write, preserve pending editor content and
  do not advance its synchronization baseline or regenerate over it. An explicit
  configuration edit already saved by the invoking command, such as a plugin
  declaration, remains saved; report that separately from the blocked sync.
  This proposal does not introduce command-wide rollback.
- Report applied changes and failures consistently in human and JSON output.
  Keep the existing dry-run behavior read-only: skip import and generation.

Acceptance must cover first/unchanged sync, settings-only edits, YAML-only edits,
editor-only edits, concurrent additions/removals/renames, template folders,
invalid folder data, path normalization, stale-plan rejection, dry-run/JSON
contracts, failed writes, and plugin operations that trigger project sync.
For all cases requiring no YAML declaration change, assert byte-for-byte YAML
equality, including CRLF, indentation, quoting, comments and blank lines.

The implementation preserves the established default and fixes its unsafe
edges. General settings import, template-folder exclusions and command-wide
rollback remain outside this contract.
