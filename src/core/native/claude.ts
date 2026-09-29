import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  executeCommand,
  compareNativeVersions,
  type NativeClient,
  type NativeCommandOptions,
  type NativeCommandResult,
  type NativeInspectionResult,
  type NativeMutationResult,
  type NativeOperationContext,
  type NativeResource,
  type NativeResourceObservation,
  type NativeSourceResolution,
} from './types.js';

type ClaudeCommandRunner = (
  binary: string,
  args: string[],
  options?: NativeCommandOptions,
) => Promise<NativeCommandResult>;

export interface ClaudeNativeClientOptions {
  execute?: ClaudeCommandRunner;
  minimumVersion?: readonly [number, number, number];
}

export interface ClaudeMarketplaceRegistrationInspection {
  success: boolean;
  present: boolean;
  source?: string;
  sourceType?: string;
  ref?: string;
  error?: string;
}

export interface ClaudePluginInventoryEntry {
  readonly id: string;
  readonly scope?: 'user' | 'project' | 'local' | 'managed' | 'synced';
  readonly enabled: boolean;
}

export interface ClaudeMarketplaceInventoryEntry {
  readonly name: string;
  readonly sourceType: string;
  readonly source: string;
  readonly ref?: string;
}

function commandOptions(context: NativeOperationContext): NativeCommandOptions {
  return {
    ...(context.cwd && { cwd: context.cwd }),
    ...(context.env && { env: context.env }),
  };
}

function commandError(result: NativeCommandResult): string {
  if (result.error) return result.error;
  if (result.signal) return `Claude CLI terminated by ${result.signal}`;
  return `Claude CLI exited with code ${result.exitCode ?? 'unknown'}`;
}

function versionTuple(output: string): readonly number[] | null {
  const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?=\D|$)/.exec(output);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

async function profileRootExists(
  context: NativeOperationContext,
): Promise<boolean> {
  const stats = await lstat(context.root).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!stats) return false;
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(
      `Claude configuration root is not a real directory: ${context.root}`,
    );
  }
  return true;
}

function parseJsonRecord(output: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(output);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function lastJsonRecord(output: string): Record<string, unknown> | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    const parsed = parseJsonRecord(lines[index] ?? '');
    if (parsed) return parsed;
  }
  return null;
}

function parsePluginEntry(
  value: unknown,
  available: boolean,
): ClaudePluginInventoryEntry | null {
  if (typeof value === 'string' && !available) {
    return parseClaudePluginId(value) ? { id: value, enabled: true } : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  let id: string | undefined;
  for (const key of ['id', 'pluginId', 'spec', 'plugin']) {
    if (typeof entry[key] === 'string' && entry[key].length > 0) {
      id = entry[key];
      break;
    }
  }
  if (
    !id &&
    typeof entry.name === 'string' &&
    typeof entry.marketplaceName === 'string'
  ) {
    id = `${entry.name}@${entry.marketplaceName}`;
  }
  if (
    !id &&
    typeof entry.name === 'string' &&
    parseClaudePluginId(entry.name)
  ) {
    id = entry.name;
  }
  if (!id || !parseClaudePluginId(id)) return null;
  const scope =
    entry.scope === 'user' ||
    entry.scope === 'project' ||
    entry.scope === 'local' ||
    entry.scope === 'managed' ||
    entry.scope === 'synced'
      ? entry.scope
      : undefined;
  if (!available && entry.scope !== undefined && !scope) return null;
  if (
    !available &&
    entry.enabled !== undefined &&
    typeof entry.enabled !== 'boolean'
  ) {
    return null;
  }
  return {
    id,
    ...(scope && { scope }),
    enabled: available ? false : entry.enabled !== false,
  };
}

export function parseClaudePluginInventory(output: string): {
  readonly installed: readonly ClaudePluginInventoryEntry[];
  readonly available: readonly ClaudePluginInventoryEntry[];
} | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  const installedValues = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? ((['installed', 'plugins', 'installedPlugins', 'installed_plugins']
          .map((key) => (parsed as Record<string, unknown>)[key])
          .find(Array.isArray) as unknown[] | undefined) ?? null)
      : null;
  const availableValues =
    parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    Array.isArray((parsed as Record<string, unknown>).available)
      ? ((parsed as Record<string, unknown>).available as unknown[])
      : [];
  if (!installedValues) return null;
  const installed = installedValues.map((entry) =>
    parsePluginEntry(entry, false),
  );
  const available = availableValues.map((entry) =>
    parsePluginEntry(entry, true),
  );
  return installed.every(
    (entry): entry is ClaudePluginInventoryEntry => entry !== null,
  ) &&
    available.every(
      (entry): entry is ClaudePluginInventoryEntry => entry !== null,
    )
    ? { installed, available }
    : null;
}

function parseMarketplaceEntry(
  value: unknown,
): ClaudeMarketplaceInventoryEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.name !== 'string' || typeof entry.source !== 'string') {
    return null;
  }
  let source: string | undefined;
  for (const key of ['path', 'repo', 'url']) {
    if (typeof entry[key] === 'string' && entry[key].length > 0) {
      source = entry[key];
      break;
    }
  }
  if (!source && typeof entry.installLocation === 'string') {
    source = entry.installLocation;
  }
  if (!source) return null;
  return {
    name: entry.name,
    sourceType: entry.source,
    source,
    ...(typeof entry.ref === 'string' &&
      entry.ref.length > 0 && {
        ref: entry.ref,
      }),
  };
}

export function parseClaudeMarketplaceInventory(
  output: string,
): readonly ClaudeMarketplaceInventoryEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const entries = parsed.map(parseMarketplaceEntry);
  return entries.every(
    (entry): entry is ClaudeMarketplaceInventoryEntry => entry !== null,
  )
    ? entries
    : null;
}

export function parseClaudePluginId(
  source: string,
): { plugin: string; marketplace: string } | null {
  const atIndex = source.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === source.length - 1) return null;
  const plugin = source.slice(0, atIndex);
  const marketplace = source.slice(atIndex + 1);
  if (
    plugin.includes('@') ||
    plugin.includes('/') ||
    plugin.includes('\\') ||
    marketplace.includes('/') ||
    marketplace.includes('\\') ||
    marketplace.includes('://')
  ) {
    return null;
  }
  return { plugin, marketplace };
}

function parseMutationResult(
  output: string,
  command: 'install' | 'update' | 'uninstall',
  expectedIdentity: string,
  expectedScope: string,
): boolean {
  const parsed = lastJsonRecord(output);
  return (
    parsed?.command === command &&
    parsed.outcome === 'ok' &&
    parsed.pluginId === expectedIdentity &&
    parsed.scope === expectedScope
  );
}

function cliScope(context: NativeOperationContext): string {
  return context.nativeScope.startsWith('profile:')
    ? 'user'
    : context.nativeScope;
}

function isProfileContext(context: NativeOperationContext): boolean {
  return context.nativeScope.startsWith('profile:');
}

function marketplaceSourceArgument(resource: NativeResource): string | null {
  const source = resource.provenance.marketplaceSource;
  if (!source) return null;
  const ref = resource.provenance.resolvedRef;
  return ref && /^[^/:]+\/[^/]+$/.test(source) ? `${source}@${ref}` : source;
}

interface ClaudeSettingsSnapshot {
  readonly path: string;
  readonly content: Uint8Array | null;
  readonly mode?: number;
}

async function captureProfileSettings(
  context: NativeOperationContext,
): Promise<ClaudeSettingsSnapshot | null> {
  if (!context.nativeScope.startsWith('profile:')) return null;
  const path = join(context.roots?.config ?? context.root, 'settings.json');
  const stats = await lstat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (!stats) return { path, content: null };
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Claude profile settings are not a regular file: ${path}`);
  }
  return {
    path,
    content: await readFile(path),
    mode: stats.mode & 0o777,
  };
}

async function restoreProfileSettings(
  snapshot: ClaudeSettingsSnapshot | null,
): Promise<void> {
  if (!snapshot) return;
  if (!snapshot.content) {
    await rm(snapshot.path, { force: true });
    return;
  }
  const temporaryPath = join(
    dirname(snapshot.path),
    `.allagents-settings-${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryPath, 'wx', snapshot.mode ?? 0o600);
    await handle.writeFile(snapshot.content);
    await handle.chmod(snapshot.mode ?? 0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, snapshot.path);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true });
  }
}

export class ClaudeNativeClient implements NativeClient {
  readonly client = 'claude';
  private readonly run: ClaudeCommandRunner;
  private readonly minimumVersion:
    | readonly [number, number, number]
    | undefined;

  constructor(options: ClaudeNativeClientOptions = {}) {
    this.run = options.execute ?? executeCommand;
    this.minimumVersion = options.minimumVersion;
  }

  private async runIsolated(
    args: string[],
    context?: NativeOperationContext,
  ): Promise<NativeCommandResult> {
    const temporaryRoot = await mkdtemp(
      join(tmpdir(), 'allagents-claude-inspection-'),
    );
    try {
      return await this.run('claude', args, {
        ...(context?.cwd && { cwd: context.cwd }),
        env: {
          ...context?.env,
          CLAUDE_CONFIG_DIR: temporaryRoot,
          CLAUDE_CODE_PLUGIN_CACHE_DIR: join(temporaryRoot, 'plugins'),
          CLAUDE_CODE_PLUGIN_SEED_DIR: undefined,
          CLAUDE_CODE_PROJECT_DIR_NAME: undefined,
        },
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  private async runForInspection(
    args: string[],
    context: NativeOperationContext,
  ): Promise<NativeCommandResult> {
    return (await profileRootExists(context))
      ? this.run('claude', args, commandOptions(context))
      : this.runIsolated(args, context);
  }

  private async runMutation(
    args: string[],
    context: NativeOperationContext,
  ): Promise<NativeCommandResult> {
    const settings = await captureProfileSettings(context);
    try {
      return await this.run('claude', args, commandOptions(context));
    } finally {
      await restoreProfileSettings(settings);
    }
  }

  async isAvailable(context?: NativeOperationContext): Promise<boolean> {
    const version = await this.runIsolated(['--version'], context);
    if (!version.success) return false;
    const parsedVersion = versionTuple(version.output);
    if (
      this.minimumVersion &&
      (!parsedVersion ||
        compareNativeVersions(parsedVersion, this.minimumVersion) < 0)
    ) {
      return false;
    }
    if (!this.minimumVersion) return true;
    const pluginHelp = await this.runIsolated(['plugin', '--help'], context);
    return (
      pluginHelp.success &&
      ['install', 'list', 'marketplace', 'uninstall', 'update'].every(
        (command) => pluginHelp.output.includes(command),
      )
    );
  }

  supportsScope(_scope: 'user' | 'project'): boolean {
    return true;
  }

  toPluginSpec(allagentsSource: string): string | null {
    const exact = parseClaudePluginId(allagentsSource);
    if (exact) return allagentsSource;
    const atIndex = allagentsSource.lastIndexOf('@');
    if (atIndex <= 0 || atIndex === allagentsSource.length - 1) return null;
    const pluginName = allagentsSource.slice(0, atIndex);
    const marketplacePart = allagentsSource.slice(atIndex + 1);
    if (!marketplacePart.includes('/') || marketplacePart.includes('://')) {
      return null;
    }
    const [, repository] = marketplacePart.split('/');
    return repository ? `${pluginName}@${repository}` : null;
  }

  extractMarketplaceSource(pluginSpec: string): string | null {
    const atIndex = pluginSpec.lastIndexOf('@');
    if (atIndex <= 0 || atIndex === pluginSpec.length - 1) return null;
    const marketplacePart = pluginSpec.slice(atIndex + 1);
    return marketplacePart.includes('/') && !marketplacePart.includes('://')
      ? marketplacePart
      : null;
  }

  resolveSource(
    source: string,
    context: NativeOperationContext,
    provenance: Readonly<Record<string, string>> = {},
  ): NativeSourceResolution {
    const spec = this.toPluginSpec(source);
    if (!spec) {
      return {
        success: false,
        error: `Claude native install does not support source '${source}'`,
      };
    }
    const identity = parseClaudePluginId(spec);
    return {
      success: true,
      resource: {
        kind: 'plugin',
        requestedIdentity: source,
        resolvedIdentity: spec,
        context,
        provenance: {
          ...(identity && { marketplaceName: identity.marketplace }),
          ...provenance,
        },
      },
    };
  }

  async inspect(
    context: NativeOperationContext,
  ): Promise<NativeInspectionResult> {
    if (!(await profileRootExists(context))) {
      return { success: true, resources: [] };
    }
    const result = await this.runForInspection(
      ['plugin', 'list', '--json'],
      context,
    );
    if (!result.success) {
      return { success: false, resources: [], error: commandError(result) };
    }
    if (!result.output.trim() && !isProfileContext(context)) {
      return { success: true, resources: [] };
    }
    const inventory = parseClaudePluginInventory(result.output);
    if (!inventory) {
      return {
        success: false,
        resources: [],
        error: 'Could not parse Claude plugin inventory',
      };
    }
    const resources: NativeResource[] = [];
    const observations: NativeResourceObservation[] = [];
    for (const entry of inventory.installed) {
      const expectedScope = cliScope(context);
      if (
        entry.scope &&
        entry.scope !== expectedScope &&
        !(expectedScope === 'project' && entry.scope === 'local')
      ) {
        continue;
      }
      const pluginId = parseClaudePluginId(entry.id);
      const resource: NativeResource = {
        kind: 'plugin',
        requestedIdentity: entry.id,
        resolvedIdentity: entry.id,
        context,
        provenance: {
          ...(pluginId && { marketplaceName: pluginId.marketplace }),
        },
      };
      if (entry.enabled) resources.push(resource);
      else observations.push({ resource, status: 'disabled' });
    }
    return {
      success: true,
      resources,
      ...(observations.length > 0 && { observations }),
    };
  }

  async inspectMarketplaceRegistration(
    marketplaceName: string,
    context: NativeOperationContext,
  ): Promise<ClaudeMarketplaceRegistrationInspection> {
    const result = await this.runForInspection(
      ['plugin', 'marketplace', 'list', '--json'],
      context,
    );
    if (!result.success) {
      return {
        success: false,
        present: false,
        error: commandError(result),
      };
    }
    const inventory = parseClaudeMarketplaceInventory(result.output);
    if (!inventory) {
      return {
        success: false,
        present: false,
        error: 'Could not parse Claude marketplace inventory',
      };
    }
    const marketplace = inventory.find(
      (entry) => entry.name === marketplaceName,
    );
    return {
      success: true,
      present: Boolean(marketplace),
      ...(marketplace?.source && { source: marketplace.source }),
      ...(marketplace?.sourceType && { sourceType: marketplace.sourceType }),
      ...(marketplace?.ref && { ref: marketplace.ref }),
    };
  }

  async inspectMarketplacePlugin(
    marketplaceName: string,
    pluginName: string,
    context: NativeOperationContext,
  ): Promise<{ success: boolean; present: boolean; error?: string }> {
    const result = await this.runForInspection(
      ['plugin', 'list', '--available', '--json'],
      context,
    );
    if (!result.success) {
      return {
        success: false,
        present: false,
        error: commandError(result),
      };
    }
    const inventory = parseClaudePluginInventory(result.output);
    if (!inventory) {
      return {
        success: false,
        present: false,
        error: `Could not parse Claude marketplace '${marketplaceName}'`,
      };
    }
    const expected = `${pluginName}@${marketplaceName}`;
    return {
      success: true,
      present: [...inventory.installed, ...inventory.available].some(
        (entry) => entry.id === expected,
      ),
    };
  }

  async install(
    resource: NativeResource,
    context: NativeOperationContext,
  ): Promise<NativeMutationResult> {
    const scope = cliScope(context);
    if (!isProfileContext(context)) {
      const registrations: string[] = [];
      const marketplaceSource = resource.provenance.marketplaceSource;
      if (marketplaceSource) {
        const registration = await this.run(
          'claude',
          ['plugin', 'marketplace', 'add', marketplaceSource],
          commandOptions(context),
        );
        if (!registration.success) {
          return { success: false, error: commandError(registration) };
        }
        registrations.push(marketplaceSource);
      }
      const result = await this.run(
        'claude',
        ['plugin', 'install', resource.resolvedIdentity, '--scope', scope],
        commandOptions(context),
      );
      return result.success
        ? {
            success: true,
            ...(registrations.length > 0 && { registrations }),
          }
        : {
            success: false,
            error: commandError(result),
            ...(registrations.length > 0 && { registrations }),
          };
    }
    const marketplaceName = resource.provenance.marketplaceName;
    if (!marketplaceName) {
      return { success: false, error: 'Claude plugin marketplace is missing' };
    }
    const registrations: string[] = [];
    const inspection = await this.inspectMarketplaceRegistration(
      marketplaceName,
      context,
    );
    if (!inspection.success) {
      return {
        success: false,
        error:
          inspection.error ??
          `Could not inspect Claude marketplace '${marketplaceName}'`,
      };
    }
    if (!inspection.present) {
      const source = marketplaceSourceArgument(resource);
      if (!source) {
        return {
          success: false,
          error: `Claude marketplace '${marketplaceName}' is not registered and has no source`,
        };
      }
      const args = ['plugin', 'marketplace', 'add', source, '--scope', scope];
      const sparsePath = resource.provenance.marketplaceSparsePath;
      if (sparsePath) args.push('--sparse', sparsePath);
      const registration = await this.runMutation(args, context);
      if (!registration.success) {
        return { success: false, error: commandError(registration) };
      }
      registrations.push(
        resource.provenance.managedMarketplaceRegistration === 'true'
          ? marketplaceName
          : source,
      );
      const verified = await this.inspectMarketplaceRegistration(
        marketplaceName,
        context,
      );
      if (!verified.success || !verified.present) {
        return {
          success: false,
          error:
            verified.error ??
            `Claude marketplace '${marketplaceName}' registration could not be verified`,
          registrations,
        };
      }
    }
    if (
      resource.provenance.managedMarketplaceRegistration === 'true' &&
      registrations.length === 0
    ) {
      registrations.push(marketplaceName);
    }
    const result = await this.runMutation(
      [
        'plugin',
        'install',
        resource.resolvedIdentity,
        '--scope',
        scope,
        '--yes',
        '--json',
      ],
      context,
    );
    return result.success &&
      parseMutationResult(
        result.output,
        'install',
        resource.resolvedIdentity,
        scope,
      )
      ? {
          success: true,
          ...(registrations.length > 0 && { registrations }),
        }
      : {
          success: false,
          error: result.success
            ? `Could not parse Claude plugin '${resource.resolvedIdentity}' install result`
            : commandError(result),
          ...(registrations.length > 0 && { registrations }),
        };
  }

  async update(
    resource: NativeResource,
    _current: NativeResource,
    context: NativeOperationContext,
  ): Promise<NativeMutationResult> {
    const scope = cliScope(context);
    if (!isProfileContext(context)) {
      const result = await this.run(
        'claude',
        ['plugin', 'update', resource.resolvedIdentity, '--scope', scope],
        commandOptions(context),
      );
      return result.success
        ? { success: true }
        : { success: false, error: commandError(result) };
    }
    const marketplaceName = resource.provenance.marketplaceName;
    if (marketplaceName) {
      const marketplace = await this.runMutation(
        ['plugin', 'marketplace', 'update', marketplaceName],
        context,
      );
      if (!marketplace.success) {
        return { success: false, error: commandError(marketplace) };
      }
    }
    const result = await this.runMutation(
      [
        'plugin',
        'update',
        resource.resolvedIdentity,
        '--scope',
        scope,
        '--yes',
        '--json',
      ],
      context,
    );
    return result.success &&
      parseMutationResult(
        result.output,
        'update',
        resource.resolvedIdentity,
        scope,
      )
      ? { success: true }
      : {
          success: false,
          error: result.success
            ? `Could not parse Claude plugin '${resource.resolvedIdentity}' update result`
            : commandError(result),
        };
  }

  async remove(
    resource: NativeResource,
    context: NativeOperationContext,
  ): Promise<NativeMutationResult> {
    const scope = cliScope(context);
    if (!isProfileContext(context)) {
      const result = await this.run(
        'claude',
        ['plugin', 'uninstall', resource.resolvedIdentity, '--scope', scope],
        commandOptions(context),
      );
      return result.success
        ? { success: true }
        : { success: false, error: commandError(result) };
    }
    const result = await this.runMutation(
      [
        'plugin',
        'uninstall',
        resource.resolvedIdentity,
        '--scope',
        scope,
        '--yes',
        '--json',
      ],
      context,
    );
    return result.success &&
      parseMutationResult(
        result.output,
        'uninstall',
        resource.resolvedIdentity,
        scope,
      )
      ? { success: true }
      : {
          success: false,
          error: result.success
            ? `Could not parse Claude plugin '${resource.resolvedIdentity}' removal result`
            : commandError(result),
        };
  }

  async removeMarketplaceRegistration(
    marketplaceName: string,
    context: NativeOperationContext,
  ): Promise<NativeMutationResult> {
    const scope = cliScope(context);
    const inspection = await this.inspectMarketplaceRegistration(
      marketplaceName,
      context,
    );
    if (!inspection.success) {
      return {
        success: false,
        error:
          inspection.error ??
          `Could not inspect Claude marketplace '${marketplaceName}'`,
      };
    }
    if (!inspection.present) return { success: true };
    const plugins = await this.runForInspection(
      ['plugin', 'list', '--json'],
      context,
    );
    if (!plugins.success) {
      return { success: false, error: commandError(plugins) };
    }
    const inventory = parseClaudePluginInventory(plugins.output);
    if (!inventory) {
      return {
        success: false,
        error: `Could not parse Claude marketplace '${marketplaceName}' plugin inventory`,
      };
    }
    if (
      inventory.installed.some(
        (entry) =>
          parseClaudePluginId(entry.id)?.marketplace === marketplaceName,
      )
    ) {
      return {
        success: false,
        error: `Claude marketplace '${marketplaceName}' is still used by installed plugins`,
      };
    }
    const result = await this.runMutation(
      ['plugin', 'marketplace', 'remove', marketplaceName, '--scope', scope],
      context,
    );
    if (!result.success) return { success: false, error: commandError(result) };
    const verified = await this.inspectMarketplaceRegistration(
      marketplaceName,
      context,
    );
    return verified.success && !verified.present
      ? { success: true }
      : {
          success: false,
          error:
            verified.error ??
            `Claude marketplace '${marketplaceName}' removal could not be verified`,
        };
  }
}
