import * as p from '@clack/prompts';
import type { PluginFetchProgress } from '../core/plugin.js';
import type { SyncOptions } from '../core/sync.js';
import { isJsonMode } from './json-output.js';
import { terminalSafe } from './terminal-output.js';

export type ProgressSpinner = Pick<ReturnType<typeof p.spinner>, 'start' | 'stop'> &
  Partial<Pick<ReturnType<typeof p.spinner>, 'message'>>;

const stages: Record<PluginFetchProgress['phase'], string> = {
  checking: 'Checking upstream',
  downloading: 'Downloading plugin source',
  updating: 'Updating plugin source',
  current: 'Already current',
  ready: 'Plugin source ready',
  cached: 'Using cached content (remote refresh failed)',
  failed: 'Plugin source refresh failed',
};

/** Own terminal progress at the CLI boundary; core and redirected output stay silent. */
export async function withPluginProgress<T>(
  run: (onProgress: SyncOptions['onPluginProgress']) => Promise<T>,
  options: { spinner?: ProgressSpinner | undefined; onPluginProgress?: SyncOptions['onPluginProgress'] } = {},
): Promise<T> {
  if (isJsonMode() || !process.stdout.isTTY) {
    return run(options.onPluginProgress);
  }
  const spinner = options.spinner ?? p.spinner();
  const pending = new Map<string, string>();
  const results = new Map<string, PluginFetchProgress['phase']>();
  let started = false;
  let message = '';
  let timer: ReturnType<typeof setInterval> | undefined;
  const start = performance.now();
  const render = () => spinner.message?.(`${message} (${Math.floor((performance.now() - start) / 1000)}s)`);
  const summary = () => {
    const phases = [...results.values()];
    if (pending.size || phases.includes('failed')) return 'Plugin source refresh failed';
    const cached = phases.filter((phase) => phase === 'cached').length;
    return cached
      ? `Plugin sources ready; using cached content for ${cached} source(s) (remote refresh failed)`
      : 'Plugin sources ready';
  };
  try {
    return await run((event) => {
      options.onPluginProgress?.(event);
      const label = terminalSafe(`${event.source}${event.ref ? ` (${event.ref})` : ''}`);
      const line = `${stages[event.phase]}: ${label}`;
      if (['checking', 'downloading', 'updating'].includes(event.phase)) {
        pending.set(event.cachePath, line);
      } else {
        pending.delete(event.cachePath);
        results.set(event.cachePath, event.phase);
      }
      message = pending.values().next().value ?? line;
      if (pending.size > 1) message += ` (+${pending.size - 1} more)`;
      if (!started) {
        if (!options.spinner) spinner.start(message);
        timer = setInterval(render, 1000);
        started = true;
      }
      render();
      if (!pending.size && !options.spinner) {
        clearInterval(timer);
        spinner.stop(summary());
        started = false;
      }
    });
  } finally {
    clearInterval(timer);
    if (started) {
      if (options.spinner && [...results.values()].includes('cached')) {
        spinner.stop(summary());
        spinner.start('Updating workspace...');
      } else if (options.spinner) spinner.message?.(summary());
      else spinner.stop(summary());
    }
  }
}
