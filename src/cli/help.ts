import { subcommands } from 'cmd-ts';
import { terminalSafe } from './terminal-output.js';

/**
 * Command metadata type and help text builder for enriched --help output.
 */
export interface CommandMeta {
  description: string;
  whenToUse: string;
  examples: string[];
  expectedOutput: string;
}

export interface CommandOption {
  flag: string;
  short?: string;
  type: 'boolean' | 'string';
  description: string;
  required?: boolean;
  choices?: string[];
}

export interface CommandPositional {
  name: string;
  type: 'string';
  required: boolean;
  description?: string;
}

export interface AgentCommandMeta extends CommandMeta {
  command: string;
  positionals?: CommandPositional[];
  options?: CommandOption[];
  outputSchema?: Record<string, unknown>;
  /** Whether an agent can invoke the command without a human interaction step. */
  interaction?: 'none' | 'conditional' | 'required';
  /**
   * Allowlist of fields that may be requested via `--json=<f1>,<f2>`.
   *
   * When the data envelope contains a single top-level array of objects,
   * the listed fields select which keys remain on each array item. Otherwise
   * the fields are pulled from the top-level data object. Unknown fields are
   * rejected with a sorted suggestion list and exit code 2.
   */
  jsonFields?: readonly string[];
  /** Skip the automatic update check for commands that must be strictly read-only. */
  skipUpdateCheck?: true;
}

/**
 * Build an enriched description string from structured command metadata.
 * The result is used as the `description` field in cmd-ts command definitions,
 * so that --help output includes examples, when-to-use, and expected output.
 */
export function buildDescription(meta: CommandMeta): string {
  let desc = meta.description;
  desc += `\n\nWhen to use: ${meta.whenToUse}`;
  desc += '\n\nExamples:';
  for (const ex of meta.examples) {
    desc += `\n  $ ${ex}`;
  }
  desc += `\n\nOutput: ${meta.expectedOutput}`;
  return desc;
}

/**
 * Wrapper around cmd-ts `subcommands` that shows only the first line
 * of each child command's description in the group listing.
 *
 * Individual command --help still shows the full enriched description.
 */
export function conciseSubcommands(
  config: Parameters<typeof subcommands>[0],
  hiddenSubcommands: readonly string[] = [],
): ReturnType<typeof subcommands> {
  const result = subcommands(config);
  const originalPrintHelp = result.printHelp.bind(result);

  // Temporarily replace each child's description with the short first line,
  // render help, then restore the originals.
  result.printHelp = (context: Parameters<typeof result.printHelp>[0]) => {
    const originals = new Map<string, string>();
    for (const [key, cmd] of Object.entries(config.cmds)) {
      if (cmd.description) {
        originals.set(key, cmd.description);
        cmd.description = cmd.description.split('\n')[0] ?? cmd.description;
      }
    }
    let output = originalPrintHelp(context);
    for (const [key, cmd] of Object.entries(config.cmds)) {
      const original = originals.get(key);
      if (original !== undefined) {
        cmd.description = original;
      }
    }
    for (const name of hiddenSubcommands) {
      output = output
        .split('\n')
        .filter(
          (line) => !terminalSafe(line).startsWith(`- ${name} -`),
        )
        .join('\n');
    }
    return output;
  };

  return result;
}
