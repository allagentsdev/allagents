#!/usr/bin/env node

import { run, setDefaultHelpFormatter } from 'cmd-ts';
import packageJson from '../../package.json';
import {
  mcpCmd,
  runMcpRuntimeCommand,
  shouldHandleMcpRuntimeCommand,
} from './commands/mcp.js';
import { pluginCmd } from './commands/plugin.js';
import { skillsCmd } from './commands/plugin-skills.js';
import { profileCmd } from './commands/profile.js';
import { selfCmd } from './commands/self.js';
import {
  initCmd,
  statusCmd,
  syncCmd,
  workspaceCmd,
} from './commands/workspace.js';
import { type AgentCommandMeta, conciseSubcommands } from './help.js';
import {
  extractJqFlag,
  extractJsonFlag,
  setJsonMode,
  validateJsonFields,
} from './json-output.js';
import { normalizeSkillArgs } from './skill-arg-normalizer.js';
import {
  createStructuredHelpFormatter,
  findMetaByCommand,
} from './structured-help.js';
import { getUpdateNotice } from './update-check.js';

const app = conciseSubcommands({
  name: 'allagents',
  description:
    'CLI tool for managing multi-repo AI agent workspaces with plugin synchronization\n\n' +
    'Use --help --json for machine-readable command metadata, or --json for structured command output',
  version: packageJson.version,
  cmds: {
    init: initCmd,
    update: syncCmd,
    status: statusCmd,
    workspace: workspaceCmd,
    plugin: pluginCmd,
    mcp: mcpCmd,
    self: selfCmd,
    skill: skillsCmd,
    profile: profileCmd,
  },
});

function hasHelpFlag(
  args: readonly string[],
  meta: AgentCommandMeta | undefined,
): boolean {
  const valueOptions = new Set(
    (meta?.options ?? [])
      .filter((option) => option.type === 'string')
      .flatMap((option) => [option.flag, option.short].filter(Boolean)),
  );
  let consumesNext = false;

  for (const arg of args) {
    if (consumesNext) {
      consumesNext = false;
      continue;
    }
    if (arg === '--') break;
    if (valueOptions.has(arg)) {
      consumesNext = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') return true;
  }

  return false;
}

const rawArgs = process.argv.slice(2);
if (shouldHandleMcpRuntimeCommand(rawArgs)) {
  await runMcpRuntimeCommand(rawArgs);
} else {
const { args: argsNoJson, json, jsonFields } = extractJsonFlag(rawArgs);
const { args: argsNoJq, jqExpr } = extractJqFlag(argsNoJson);
const finalArgs = normalizeSkillArgs(argsNoJq);
const commandPath = finalArgs.filter((arg) => !arg.startsWith('-')).join(' ');
const commandMeta = findMetaByCommand(commandPath);

// `--jq` requires `--json` so we have an envelope to pipe through.
if (jqExpr && !json) {
  process.stderr.write('Error: --jq requires --json.\n');
  process.exit(2);
}

// Help owns its field-selection error so the structured formatter can explain
// that help output is not filterable. Option values and positionals that happen
// to equal a help token remain ordinary command input.
const requestsHelp = hasHelpFlag(finalArgs, commandMeta);
let validatedFields: string[] | undefined;
if (jsonFields) {
  if (requestsHelp) {
    validatedFields = [...jsonFields];
  } else {
    const result = validateJsonFields(jsonFields, commandMeta);
    validatedFields = result ? [...result] : undefined;
  }
}

setJsonMode(json, {
  ...(validatedFields && { fields: validatedFields }),
  ...(jqExpr && { jqExpr }),
});

if (json) {
  setDefaultHelpFormatter(createStructuredHelpFormatter(packageJson.version));
}

// Kick off the update check for ordinary non-JSON invocations unless the
// resolved command metadata marks the command as strictly read-only.
const isWizard = finalArgs.length === 0 && process.stdout.isTTY && !json;
if (!json && !isWizard && !commandMeta?.skipUpdateCheck) {
  const notice = await getUpdateNotice(packageJson.version);
  if (notice) process.stderr.write(`${notice}\n\n`);
}

if (isWizard) {
  // Interactive wizard when no args and running in a terminal
  const { runWizard } = await import('./tui/wizard.js');
  await runWizard();
} else {
  run(app, finalArgs);
}
}
