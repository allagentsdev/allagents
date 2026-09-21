import chalk from 'chalk';
import {
  command,
  flag,
  option,
  optional,
  restPositionals,
  string,
} from 'cmd-ts';
import type { SkillUpdateUnitExecution } from '../../core/skill-update.js';
import { buildDescription } from '../help.js';
import { isJsonMode, jsonOutput } from '../json-output.js';
import { skillsUpdateMeta } from '../metadata/plugin-skills.js';
import {
  buildSkillUpdateInventory,
  executePreparedSkillUpdate,
  findUnmatchedSkillUpdateFilters,
  hasProjectSkillConfig,
  normalizeSkillUpdateScopes,
  prepareSkillUpdateFromInventory,
  resolveNonInteractiveSkillUpdateDecisions,
  skillUpdateExitCode,
  skillUpdateSummary,
  unitDisplayName,
} from '../skill-update.js';
import { terminalSafe } from '../terminal-output.js';

class SkillUpdateUsageError extends Error {}

function renderSkillUpdateResult(
  unitResult: SkillUpdateUnitExecution,
  source: string,
): void {
  const label = terminalSafe(source);
  switch (unitResult.status) {
    case 'updated':
      console.log(`${chalk.green('✓')} Updated ${label}`);
      break;
    case 'removed':
      console.log(
        `${chalk.green('✓')} Removed deleted skills and updated ${label}`,
      );
      break;
    case 'retained':
      console.log(
        `${chalk.yellow('!')} Kept local copies and skipped updates for ${label}`,
      );
      break;
    case 'skipped':
      console.log(`${chalk.dim('–')} Skipped ${label}`);
      break;
    case 'cancelled':
      console.log(`${chalk.yellow('!')} Update cancelled before changes`);
      break;
    case 'failed':
      console.error(
        `${chalk.red('✗')} Failed ${label}${unitResult.error ? `: ${terminalSafe(unitResult.error)}` : ''}`,
      );
      break;
  }
}

export const skillUpdateCmd = command({
  name: 'update',
  description: buildDescription(skillsUpdateMeta),
  args: {
    skills: restPositionals({ type: string, displayName: 'skills' }),
    scope: option({
      type: optional(string),
      long: 'scope',
      short: 's',
      description: 'Scope: project, user, or all',
    }),
    yes: flag({
      long: 'yes',
      short: 'y',
      description: 'Run without prompts (deleted-upstream skills are retained)',
    }),
  },
  handler: async ({ skills, scope, yes }) => {
    try {
      const workspacePath = process.cwd();
      const jsonMode = isJsonMode();
      const progressiveOutput = Boolean(process.stdout.isTTY) && !jsonMode;
      const interactive =
        Boolean(process.stdout.isTTY && process.stdin.isTTY) &&
        !jsonMode &&
        !yes;
      let selectedScope = scope;

      // Validate explicit input before opening any UI.
      if (
        selectedScope !== undefined &&
        !['project', 'user', 'all'].includes(selectedScope)
      ) {
        throw new SkillUpdateUsageError(
          `Invalid scope '${selectedScope}'. Expected project, user, or all.`,
        );
      }

      if (!selectedScope && interactive) {
        const p = await import('@clack/prompts');
        const selected = await p.select({
          message: 'Update scope',
          options: [
            { value: 'project', label: 'Project' },
            { value: 'user', label: 'User' },
            { value: 'all', label: 'All' },
          ],
          initialValue: hasProjectSkillConfig(workspacePath)
            ? 'project'
            : 'user',
        });
        if (p.isCancel(selected)) {
          p.cancel('Skill update cancelled');
          return;
        }
        selectedScope = selected as string;
      }
      selectedScope ??= hasProjectSkillConfig(workspacePath)
        ? 'project'
        : 'user';
      const scopes = normalizeSkillUpdateScopes(selectedScope);

      if (!jsonMode && !progressiveOutput) {
        console.log('Checking for skill updates…');
      }
      const inventory = await buildSkillUpdateInventory(workspacePath, scopes);
      const unmatched = findUnmatchedSkillUpdateFilters(
        inventory,
        scopes,
        skills,
      );
      if (unmatched.length > 0) {
        throw new SkillUpdateUsageError(
          `No enabled installed skill matched: ${unmatched.join(', ')}`,
        );
      }
      const prepared = await prepareSkillUpdateFromInventory(
        {
          workspacePath,
          scopes,
          ...(skills.length > 0 && { filters: skills }),
          ...(progressiveOutput && {
            onUnitStart: (unit) =>
              console.log(`Updating ${terminalSafe(unitDisplayName(unit))}...`),
          }),
        },
        inventory,
      );

      let decisions = resolveNonInteractiveSkillUpdateDecisions(prepared.plan);
      if (interactive) {
        decisions = {};
        const p = await import('@clack/prompts');
        for (const unit of prepared.plan.units) {
          if (unit.deleted.length === 0) continue;
          const displayName = terminalSafe(unitDisplayName(unit));
          if (unit.blockedByOutOfScope) {
            decisions[unit.id] = 'retain';
            p.log.warn(
              `${displayName} also backs deleted skills outside the selected scope. Local copies will be kept and this source will not be updated. Rerun with --scope all to review them together.`,
            );
            continue;
          }

          const removedEntries = unit.installations.filter((installation) =>
            unit.removedInstallationIds.includes(installation.id),
          );
          const heading =
            removedEntries.length > 0
              ? `The following installed plugin entries were deleted from ${displayName} upstream:`
              : `The following skills from ${displayName} appear to have been deleted upstream:`;
          const lines = unit.deleted.map(
            (skill) =>
              `  • ${terminalSafe(skill.pluginName)}:${terminalSafe(skill.subpath)} (${terminalSafe(skill.scope)})`,
          );
          p.log.warn(`${heading}\n${lines.join('\n')}`);
          const confirmed = await p.confirm({
            message:
              removedEntries.length > 0
                ? `Remove ${removedEntries.length} local plugin entr${removedEntries.length === 1 ? 'y' : 'ies'} and update the surviving skills? No keeps the local copies and skips every update from this source.`
                : `Remove ${unit.deleted.length} local skill cop${unit.deleted.length === 1 ? 'y' : 'ies'} and update the surviving skills? No keeps them and skips every update from this source.`,
            initialValue: false,
          });
          if (p.isCancel(confirmed)) {
            decisions[unit.id] = 'cancel';
            break;
          }
          decisions[unit.id] = confirmed ? 'remove' : 'retain';
        }
      }

      if (progressiveOutput) {
        for (const local of prepared.inventory.skippedLocalSources) {
          console.log(
            `${chalk.dim('–')} Skipped local source ${terminalSafe(local)}`,
          );
        }
      }

      const planById = new Map(
        prepared.plan.units.map((unit) => [unit.id, unit]),
      );
      const sourceForResult = (unitResult: SkillUpdateUnitExecution): string => {
        const planned = planById.get(unitResult.id);
        return planned ? unitDisplayName(planned) : unitResult.id;
      };
      const result = await executePreparedSkillUpdate(
        prepared,
        decisions,
        workspacePath,
        progressiveOutput
          ? {
              onUnitResult: (unitResult) =>
                renderSkillUpdateResult(
                  unitResult,
                  sourceForResult(unitResult),
                ),
            }
          : {},
      );
      const summary = skillUpdateSummary(result);
      const results = progressiveOutput
        ? []
        : result.units.map((unitResult) => ({
            ...unitResult,
            source: sourceForResult(unitResult),
          }));

      if (jsonMode) {
        jsonOutput({
          success: result.success,
          command: 'skill update',
          data: {
            scopes,
            results,
            syncedScopes: result.syncedScopes,
            skippedLocalSources: prepared.inventory.skippedLocalSources,
            summary,
          },
        });
      } else {
        if (!progressiveOutput) {
          for (const local of prepared.inventory.skippedLocalSources) {
            console.log(
              `${chalk.dim('–')} Skipped local source ${terminalSafe(local)}`,
            );
          }
        }
        if (!progressiveOutput) {
          for (const unitResult of results) {
            renderSkillUpdateResult(unitResult, unitResult.source);
          }
        }
        if (result.units.length === 0) console.log('No skill updates found.');
        else if (result.success) {
          console.log(
            `Done: ${summary.updated} updated, ${summary.removed} removed, ${summary.retained} retained, ${summary.skipped} skipped.`,
          );
        }
      }

      const exitCode = skillUpdateExitCode(result);
      if (exitCode !== 0) process.exit(exitCode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const exitCode = error instanceof SkillUpdateUsageError ? 2 : 1;
      if (isJsonMode()) {
        jsonOutput({ success: false, command: 'skill update', error: message });
      } else {
        console.error(`Error: ${terminalSafe(message)}`);
      }
      process.exit(exitCode);
    }
  },
});
