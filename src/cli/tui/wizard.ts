import { relative } from 'node:path';
import { settings } from '@clack/core';
import * as p from '@clack/prompts';
import chalk from 'chalk';
import packageJson from '../../../package.json';
import { TuiCache } from './cache.js';
import { getTuiContext, type TuiContext } from './context.js';

const { select } = p;

// Disable Escape key as cancel trigger to prevent terminal freezes.
// Ctrl+C (\x03) still works for cancellation.
settings.aliases.delete('escape');

import { getUpdateNotice } from '../update-check.js';
import { runManageClients } from './actions/clients.js';
import { runMcpServers } from './actions/mcp.js';
import { runBrowseMarketplaces, runPlugins } from './actions/plugins.js';
import { runSkills } from './actions/skills.js';
import { runStatus } from './actions/status.js';
import { runSync } from './actions/sync.js';

export type MenuAction =
  | 'workspace'
  | 'sync'
  | 'plugins'
  | 'skills'
  | 'clients'
  | 'mcp'
  | 'marketplace'
  | 'exit';

/**
 * Build context-aware menu options based on workspace state.
 * Plugins, Skills, Clients, MCP Servers, and Marketplaces are always visible.
 */
export function buildMenuOptions(context: TuiContext) {
  const options: Array<{ label: string; value: MenuAction; hint?: string }> =
    [];

  if (context.needsSync) {
    options.push({ label: 'Update', value: 'sync', hint: 'update needed' });
  }

  options.push({ label: 'Workspace', value: 'workspace' });
  options.push({ label: 'Plugins', value: 'plugins' });
  options.push({ label: 'Skills', value: 'skills' });
  options.push({ label: 'Clients', value: 'clients' });
  options.push({ label: 'MCP Servers', value: 'mcp' });
  options.push({ label: 'Marketplaces', value: 'marketplace' });

  options.push({ label: 'Exit', value: 'exit' });
  return options;
}

/**
 * Build a compact one-line workspace summary for subsequent menu loops.
 */
function buildCompactSummary(context: TuiContext): string {
  const parts: string[] = [];
  if (context.hasWorkspace) {
    parts.push(`${context.projectPluginCount} project`);
  }
  parts.push(`${context.userPluginCount} user`);
  parts.push(`${context.marketplaceCount} marketplaces`);
  if (context.needsSync) {
    parts.push(chalk.yellow('update needed'));
  }
  return parts.join(', ');
}

/**
 * Build a workspace summary for display in a note.
 */
function buildSummary(context: TuiContext): string {
  const lines: string[] = [];

  if (context.hasWorkspace && context.workspacePath) {
    const relPath = relative(process.cwd(), context.workspacePath) || '.';
    lines.push(`Workspace: ${relPath}`);
    lines.push(`Project plugins: ${context.projectPluginCount}`);
  } else {
    lines.push('No workspace detected');
  }

  lines.push(`User plugins: ${context.userPluginCount}`);
  lines.push(`Marketplaces: ${context.marketplaceCount}`);

  if (context.needsSync) {
    lines.push(`Update: ${chalk.yellow('needed')}`);
  } else if (context.hasWorkspace) {
    lines.push(`Update: ${chalk.green('up to date')}`);
  }

  return lines.join('\n');
}

/**
 * Main interactive TUI wizard loop.
 * Detects workspace state, shows a context-aware menu, dispatches actions,
 * and loops until the user exits.
 */
export async function runWizard(): Promise<void> {
  p.intro(`${chalk.cyan('allagents')} v${packageJson.version}`);

  const updateNotice = await getUpdateNotice(packageJson.version);
  if (updateNotice) {
    p.log.info(updateNotice);
  }

  const cache = new TuiCache();
  let context = await getTuiContext(process.cwd(), cache);
  let isFirstLoop = true;

  while (true) {
    if (isFirstLoop) {
      p.note(buildSummary(context), 'Workspace');
      isFirstLoop = false;
    } else {
      p.log.info(chalk.dim(`Workspace: ${buildCompactSummary(context)}`));
    }

    const action = await select<MenuAction>({
      message: 'What would you like to do?',
      options: buildMenuOptions(context),
    });

    if (p.isCancel(action)) {
      p.cancel('Cancelled');
      return;
    }

    switch (action) {
      case 'sync':
        await runSync(context);
        cache.invalidate();
        break;
      case 'workspace':
        await runStatus(context, cache);
        cache.invalidate();
        break;
      case 'plugins':
        await runPlugins(context, cache);
        break;
      case 'skills':
        await runSkills(context, cache);
        break;
      case 'clients':
        await runManageClients(context, cache);
        break;
      case 'mcp':
        await runMcpServers(context, cache);
        break;
      case 'marketplace':
        await runBrowseMarketplaces(context, cache);
        break;
      case 'exit':
        p.outro('Bye');
        return;
    }

    // Refresh context after each action (cache makes this cheap when nothing changed)
    context = await getTuiContext(process.cwd(), cache);
  }
}
