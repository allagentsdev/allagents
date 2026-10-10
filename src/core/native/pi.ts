import type { Stats } from 'node:fs';
import { homedir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  resolve,
  win32,
} from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
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
import { pathIsWithin } from '../client-context.js';

const PI_MINIMUM_VERSION = [0, 85, 1] as const;
const PACKAGE_FILTER_KEYS = [
  'extensions',
  'skills',
  'prompts',
  'themes',
] as const;


type PiCommandRunner = (
  binary: string,
  args: string[],
  options?: NativeCommandOptions,
) => Promise<NativeCommandResult>;

export interface PiNativeClientOptions {
  execute?: PiCommandRunner;
}

export interface PiPackageEntry {
  source: string;
  autoload?: boolean;
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
}

export interface PiNormalizedSource {
  kind: 'npm' | 'git' | 'local';
  requested: string;
  resolvedIdentity: string;
  packageIdentity: string;
  commandSource: string;
  packageName?: string;
  host?: string;
  repositoryPath?: string;
  localPath?: string;
}

export type PiProjectTrustStatus =
  | 'allowed'
  | 'ask'
  | 'denied'
  | 'inspection-failed'
  | 'ambiguous';

export interface PiProjectTrustInspection {
  status: PiProjectTrustStatus;
  allowed: boolean;
  source?: 'saved' | 'default';
  matchedPath?: string;
  error?: string;
}

export interface PiSettings {
  packages: PiPackageEntry[];
  defaultProjectTrust: 'ask' | 'always' | 'never';
}

function contextCwd(context: NativeOperationContext): string {
  return resolve(context.cwd ?? process.cwd());
}

function piAgentRoot(context: NativeOperationContext): string {
  const namedRoot = context.roots?.agent;
  if (namedRoot) return resolve(namedRoot);
  if (context.scope === 'user') return resolve(context.root);

  const cwd = contextCwd(context);
  const configured = context.env?.PI_CODING_AGENT_DIR;
  if (configured) {
    if (configured === '~') return contextHome(context);
    if (configured.startsWith('~/') || configured.startsWith('~\\')) {
      return resolve(contextHome(context), configured.slice(2));
    }
    return resolve(cwd, configured);
  }
  return join(contextHome(context), '.pi', 'agent');
}

function contextHome(context: NativeOperationContext): string {
  return resolve(context.env?.HOME ?? context.env?.USERPROFILE ?? homedir());
}

function settingsRoot(context: NativeOperationContext): string {
  return context.scope === 'user'
    ? piAgentRoot(context)
    : join(contextCwd(context), '.pi');
}

function commandOptions(context: NativeOperationContext): NativeCommandOptions {
  return {
    cwd: contextCwd(context),
    ...(context.env && { env: context.env }),
  };
}

function commandError(result: NativeCommandResult): string {
  if (result.error) return result.error;
  if (result.signal) return `Pi CLI terminated by ${result.signal}`;
  return `Pi CLI exited with code ${result.exitCode ?? 'unknown'}`;
}

function parseNpmSource(source: string): PiNormalizedSource | null {
  if (!source.startsWith('npm:')) return null;
  const spec = source.slice(4).trim();
  const match = spec.startsWith('@')
    ? /^(@[^/@\s]+\/[^/@\s]+)(?:@([^\s]+))?$/.exec(spec)
    : /^([^/@\s]+)(?:@([^\s]+))?$/.exec(spec);
  if (!match?.[1]) return null;
  const name = match[1];
  let decodedName: string;
  try {
    decodedName = decodeURIComponent(name);
  } catch {
    return null;
  }
  if (
    decodedName.includes('\0') ||
    decodedName.includes('\\') ||
    decodedName.split('/').some((segment) => segment === '.' || segment === '..') ||
    decodedName.split('/').length !== name.split('/').length
  ) {
    return null;
  }
  const version = match[2];
  return {
    kind: 'npm',
    requested: source,
    resolvedIdentity: `npm:${name}${version ? `@${version}` : ''}`,
    packageIdentity: `npm:${name}`,
    commandSource: `npm:${name}${version ? `@${version}` : ''}`,
    packageName: name,
  };
}

function unsafeGitPart(value: string, allowSlash: boolean): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return true;
  }
  for (const candidate of [value, decoded]) {
    if (
      candidate.length === 0 ||
      candidate.includes('\0') ||
      candidate.includes('\\') ||
      candidate.startsWith('/') ||
      (!allowSlash && candidate.includes('/')) ||
      candidate.split('/').includes('..')
    ) {
      return true;
    }
  }
  return false;
}

function splitGitRef(path: string): { path: string; ref?: string } | null {
  const separator = path.indexOf('@');
  if (separator < 0) return { path };
  const repositoryPath = path.slice(0, separator);
  const ref = path.slice(separator + 1);
  return repositoryPath && ref ? { path: repositoryPath, ref } : null;
}

function buildGitSource(
  requested: string,
  host: string,
  pathWithRef: string,
): PiNormalizedSource | null {
  const split = splitGitRef(pathWithRef.replace(/^\/+/, ''));
  if (!split) return null;
  const repositoryPath = split.path.replace(/\.git$/, '').replace(/\/$/, '');
  const normalizedHost = host.toLowerCase();
  if (
    unsafeGitPart(normalizedHost, false) ||
    unsafeGitPart(repositoryPath, true) ||
    repositoryPath.split('/').length < 2 ||
    (split.ref && unsafeGitPart(split.ref, true))
  ) {
    return null;
  }
  const base = `${normalizedHost}/${repositoryPath}`;
  return {
    kind: 'git',
    requested,
    resolvedIdentity: `git:${base}${split.ref ? `@${split.ref}` : ''}`,
    packageIdentity: `git:${base}`,
    commandSource: requested,
    host: normalizedHost,
    repositoryPath,
  };
}

function parseGitSource(source: string): PiNormalizedSource | null {
  const hasGitPrefix = source.startsWith('git:');
  const value = (hasGitPrefix ? source.slice(4) : source).trim();
  if (!value) return null;

  const scp = /^git@([^:]+):(.+)$/.exec(value);
  if (scp?.[1] && scp[2]) {
    return buildGitSource(source, scp[1], scp[2]);
  }

  if (/^(?:https?|ssh|git):\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (
        url.password ||
        (url.username && !(url.protocol === 'ssh:' && url.username === 'git')) ||
        url.search ||
        url.hash
      ) {
        return null;
      }
      return buildGitSource(source, url.hostname, url.pathname);
    } catch {
      return null;
    }
  }

  if (!hasGitPrefix) return null;
  const slash = value.indexOf('/');
  if (slash <= 0) return null;
  const host = value.slice(0, slash);
  if (!host.includes('.') && host !== 'localhost') return null;
  return buildGitSource(source, host, value.slice(slash + 1));
}

function expandTilde(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return join(home, value.slice(2));
  }
  return value;
}

function parseLocalSource(
  source: string,
  context: NativeOperationContext,
): PiNormalizedSource | null {
  const isFileUrl = source.startsWith('file://');
  let localCandidate: string;
  try {
    localCandidate = isFileUrl
      ? fileURLToPath(source)
      : expandTilde(source, contextHome(context));
  } catch {
    return null;
  }
  if (
    !isFileUrl &&
    !isAbsolute(localCandidate) &&
    !win32.isAbsolute(localCandidate) &&
    !localCandidate.startsWith('./') &&
    !localCandidate.startsWith('../') &&
    !localCandidate.startsWith('.\\') &&
    !localCandidate.startsWith('..\\')
  ) {
    return null;
  }
  const localPath = resolve(contextCwd(context), localCandidate);
  return {
    kind: 'local',
    requested: source,
    resolvedIdentity: `local:${localPath}`,
    packageIdentity: `local:${localPath}`,
    commandSource: localPath,
    localPath,
  };
}

export function normalizePiPackageSource(
  source: string,
  context: NativeOperationContext,
  options: { baseDir?: string } = {},
): PiNormalizedSource | null {
  const trimmed = source.trim();
  if (!trimmed) return null;

  const npm = parseNpmSource(trimmed);
  if (npm) return npm;
  const git = parseGitSource(trimmed);
  if (git) return git;

  const localContext = options.baseDir
    ? { ...context, cwd: options.baseDir }
    : context;
  return parseLocalSource(trimmed, localContext);
}

function parsePackageEntry(value: unknown, index: number): PiPackageEntry {
  if (typeof value === 'string' && value.trim()) {
    return { source: value.trim() };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`packages[${index}] must be a source string or object`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.source !== 'string' || !record.source.trim()) {
    throw new Error(`packages[${index}].source must be a non-empty string`);
  }
  if (record.autoload !== undefined && typeof record.autoload !== 'boolean') {
    throw new Error(`packages[${index}].autoload must be a boolean`);
  }

  const entry: PiPackageEntry = { source: record.source.trim() };
  if (typeof record.autoload === 'boolean') entry.autoload = record.autoload;
  for (const key of PACKAGE_FILTER_KEYS) {
    const value = record[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new Error(`packages[${index}].${key} must be an array of strings`);
    }
    entry[key] = [...value] as string[];
  }
  return entry;
}

export async function readPiSettings(path: string): Promise<PiSettings> {
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { packages: [], defaultProjectTrust: 'ask' };
    }
    throw new Error(
      `Could not read Pi settings ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(contents.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(
      `Could not parse Pi settings ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid Pi settings ${path}: expected an object`);
  }
  const record = value as Record<string, unknown>;
  if (record.packages !== undefined && !Array.isArray(record.packages)) {
    throw new Error(`Invalid Pi settings ${path}: packages must be an array`);
  }
  const defaultProjectTrust = record.defaultProjectTrust ?? 'ask';
  if (
    defaultProjectTrust !== 'ask' &&
    defaultProjectTrust !== 'always' &&
    defaultProjectTrust !== 'never'
  ) {
    throw new Error(
      `Invalid Pi settings ${path}: defaultProjectTrust must be ask, always, or never`,
    );
  }
  return {
    packages: (record.packages ?? []).map(parsePackageEntry),
    defaultProjectTrust,
  };
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(resolve(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolve(path);
    throw error;
  }
}


export async function inspectPiProjectTrust(
  context: NativeOperationContext,
): Promise<PiProjectTrustInspection> {
  const agentRoot = piAgentRoot(context);
  let projectBoundary: string;
  let canonicalAgentRoot: string;
  try {
    projectBoundary = await canonicalPath(context.root);
    canonicalAgentRoot = await canonicalPath(agentRoot);
  } catch (error) {
    return {
      status: 'inspection-failed',
      allowed: false,
      error: `Could not canonicalize Pi trust boundary: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (pathIsWithin(projectBoundary, canonicalAgentRoot)) {
    return {
      status: 'denied',
      allowed: false,
      error:
        'Pi project trust cannot be authorized from an agent root inside the project boundary',
    };
  }

  const settingsPath = join(agentRoot, 'settings.json');
  let settings: PiSettings;
  try {
    settings = await readPiSettings(settingsPath);
  } catch (error) {
    return {
      status: 'inspection-failed',
      allowed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const trustPath = join(agentRoot, 'trust.json');
  let contents: string;
  try {
    contents = await readFile(trustPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        status: 'inspection-failed',
        allowed: false,
        error: `Could not read Pi trust store ${trustPath}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    contents = '{}';
  }

  let value: unknown;
  try {
    value = JSON.parse(contents.replace(/^\uFEFF/, ''));
  } catch (error) {
    return {
      status: 'inspection-failed',
      allowed: false,
      error: `Could not parse Pi trust store ${trustPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      status: 'inspection-failed',
      allowed: false,
      error: `Invalid Pi trust store ${trustPath}: expected an object`,
    };
  }

  let cwd: string;
  try {
    cwd = await canonicalPath(contextCwd(context));
  } catch (error) {
    return {
      status: 'inspection-failed',
      allowed: false,
      error: `Could not canonicalize Pi project cwd: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const decisions = new Map<string, boolean | null>();
  for (const [savedPath, decision] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (decision !== true && decision !== false && decision !== null) {
      return {
        status: 'inspection-failed',
        allowed: false,
        error: `Invalid Pi trust store ${trustPath}: decision for ${JSON.stringify(savedPath)} must be true, false, or null`,
      };
    }
    if (!isAbsolute(savedPath) && !win32.isAbsolute(savedPath)) {
      return {
        status: 'ambiguous',
        allowed: false,
        error: `Pi trust store contains non-absolute path ${JSON.stringify(savedPath)}`,
      };
    }
    let canonicalSavedPath: string;
    try {
      canonicalSavedPath = await canonicalPath(savedPath);
    } catch (error) {
      return {
        status: 'inspection-failed',
        allowed: false,
        error: `Could not canonicalize Pi trust path ${JSON.stringify(savedPath)}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const existing = decisions.get(canonicalSavedPath);
    if (
      existing !== undefined &&
      decision !== null &&
      existing !== null &&
      existing !== decision
    ) {
      return {
        status: 'ambiguous',
        allowed: false,
        error: `Pi trust store has conflicting decisions for ${canonicalSavedPath}`,
      };
    }
    if (existing === undefined || decision !== null) {
      decisions.set(canonicalSavedPath, decision);
    }
  }

  let current = cwd;
  while (true) {
    const decision = decisions.get(current);
    if (decision === true || decision === false) {
      return {
        status: decision ? 'allowed' : 'denied',
        allowed: decision,
        source: 'saved',
        matchedPath: current,
        ...(!decision && {
          error: `Pi project trust is denied by saved decision ${current}`,
        }),
      };
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  if (settings.defaultProjectTrust === 'always') {
    return { status: 'allowed', allowed: true, source: 'default' };
  }
  if (settings.defaultProjectTrust === 'never') {
    return {
      status: 'denied',
      allowed: false,
      source: 'default',
      error: 'Pi defaultProjectTrust is never',
    };
  }
  return {
    status: 'ask',
    allowed: false,
    source: 'default',
    error:
      'Pi project trust requires confirmation. Trust this project in Pi before running native package operations.',
  };
}

function packageIsEntirelyDisabled(entry: PiPackageEntry): boolean {
  if (entry.autoload === false) {
    return !PACKAGE_FILTER_KEYS.some((key) =>
      (entry[key] ?? []).some(
        (pattern) => pattern.length > 0 && !pattern.startsWith('!') && !pattern.startsWith('-'),
      ),
    );
  }
  return PACKAGE_FILTER_KEYS.every(
    (key) => entry[key] !== undefined && entry[key]?.length === 0,
  );
}

function installPathForSource(
  source: PiNormalizedSource,
  root: string,
): string {
  if (source.kind === 'npm') {
    return join(root, 'npm', 'node_modules', source.packageName ?? '');
  }
  if (source.kind === 'git') {
    return join(root, 'git', source.host ?? '', source.repositoryPath ?? '');
  }
  return source.localPath ?? '';
}

async function manifestStatus(
  normalized: PiNormalizedSource,
  installedPath: string,
): Promise<{ status: 'installed' | 'unusable'; error?: string }> {
  let installedStat: Stats;
  try {
    installedStat = await stat(installedPath);
  } catch (error) {
    return {
      status: 'unusable',
      error: `Could not inspect installed Pi package ${installedPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (installedStat.isFile()) {
    return normalized.kind === 'local' && /\.(?:[cm]?[jt]s)$/.test(installedPath)
      ? { status: 'installed' }
      : { status: 'unusable', error: `Pi package path is not a directory: ${installedPath}` };
  }
  if (!installedStat.isDirectory()) {
    return { status: 'unusable', error: `Pi package path is not a directory: ${installedPath}` };
  }

  const manifestPath = join(installedPath, 'package.json');
  let contents: string;
  try {
    contents = await readFile(manifestPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (normalized.kind === 'npm') {
        return { status: 'unusable', error: `Installed npm package has no manifest: ${manifestPath}` };
      }
      for (const key of PACKAGE_FILTER_KEYS) {
        try {
          if ((await stat(join(installedPath, key))).isDirectory()) {
            return { status: 'installed' };
          }
        } catch {
          // Try the next conventional resource directory.
        }
      }
      return {
        status: 'unusable',
        error: `Installed Pi package has no manifest or conventional resources: ${installedPath}`,
      };
    }
    return {
      status: 'unusable',
      error: `Could not read installed Pi package manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    const manifest = JSON.parse(contents.replace(/^\uFEFF/, '')) as unknown;
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
      throw new Error('expected an object');
    }
    const name = (manifest as Record<string, unknown>).name;
    if (typeof name !== 'string' || !name) throw new Error('missing package name');
    if (normalized.kind === 'npm' && name !== normalized.packageName) {
      throw new Error(
        `manifest name ${JSON.stringify(name)} does not match ${JSON.stringify(normalized.packageName)}`,
      );
    }
    return { status: 'installed' };
  } catch (error) {
    return {
      status: 'unusable',
      error: `Invalid installed Pi package manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function inspectScopePackages(
  context: NativeOperationContext,
): Promise<NativeInspectionResult> {
  if (context.scope === 'project') {
    const trust = await inspectPiProjectTrust(context);
    if (!trust.allowed) {
      return {
        success: false,
        resources: [],
        observations: [],
        error: trust.error ?? `Pi project trust is ${trust.status}`,
      };
    }
  }

  const root = settingsRoot(context);
  let settings: PiSettings;
  try {
    settings = await readPiSettings(join(root, 'settings.json'));
  } catch (error) {
    return {
      success: false,
      resources: [],
      observations: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const observations: NativeResourceObservation[] = [];
  const identities = new Set<string>();
  for (const entry of settings.packages) {
    const normalized = normalizePiPackageSource(entry.source, context, {
      baseDir: root,
    });
    if (!normalized) {
      return {
        success: false,
        resources: [],
        observations,
        error: `Unsupported Pi package source in ${join(root, 'settings.json')}: ${entry.source}`,
      };
    }
    if (identities.has(normalized.packageIdentity)) {
      return {
        success: false,
        resources: [],
        observations,
        error: `Ambiguous duplicate Pi package identity ${normalized.packageIdentity} in ${join(root, 'settings.json')}`,
      };
    }
    identities.add(normalized.packageIdentity);

    const installedPath = installPathForSource(normalized, root);
    const resource: NativeResource = {
      kind: 'package',
      requestedIdentity: entry.source,
      resolvedIdentity: normalized.resolvedIdentity,
      context,
      provenance: {
        sourceType: normalized.kind,
        packageIdentity: normalized.packageIdentity,
        commandSource: normalized.commandSource,
        installedPath,
      },
    };

    let exists = true;
    try {
      await stat(installedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
      else {
        observations.push({
          resource,
          status: 'unusable',
          installedPath,
          error: `Could not inspect Pi package path ${installedPath}: ${error instanceof Error ? error.message : String(error)}`,
        });
        continue;
      }
    }
    if (!exists) {
      observations.push({
        resource,
        status: 'configured-missing',
        installedPath,
      });
      continue;
    }

    const manifest = await manifestStatus(normalized, installedPath);
    if (manifest.status === 'unusable') {
      observations.push({
        resource,
        status: 'unusable',
        installedPath,
        ...(manifest.error && { error: manifest.error }),
      });
      continue;
    }
    observations.push({
      resource,
      status: packageIsEntirelyDisabled(entry) ? 'disabled' : 'installed',
      installedPath,
    });
  }

  return {
    success: true,
    resources: observations
      .filter((observation) => observation.status === 'installed')
      .map((observation) => observation.resource),
    observations,
  };
}

function versionTuple(output: string): [number, number, number] | null {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:[-+\s]|$)/.exec(output.trim());
  return match?.[1] && match[2] && match[3]
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : null;
}


function sourceFromResource(resource: NativeResource): string {
  return resource.provenance.commandSource ?? resource.requestedIdentity;
}

function packageIdentityFromResource(
  resource: NativeResource,
  context: NativeOperationContext,
): string | undefined {
  return (
    resource.provenance.packageIdentity ??
    normalizePiPackageSource(sourceFromResource(resource), context)?.packageIdentity
  );
}

function mutationArgs(
  operation: 'install' | 'remove',
  source: string,
  context: NativeOperationContext,
): string[] {
  return context.scope === 'project'
    ? [operation, source, '-l', '--approve']
    : [operation, source, '--no-approve'];
}

export class PiNativeClient implements NativeClient {
  readonly client = 'pi';
  private readonly run: PiCommandRunner;

  constructor(options: PiNativeClientOptions = {}) {
    this.run = options.execute ?? executeCommand;
  }

  async isAvailable(context?: NativeOperationContext): Promise<boolean> {
    const result = await this.run(
      'pi',
      ['--version'],
      context ? commandOptions(context) : undefined,
    );
    if (!result.success) return false;
    const version = versionTuple(result.output);
    return Boolean(
      version &&
      compareNativeVersions(version, PI_MINIMUM_VERSION) >= 0,
    );
  }

  supportsScope(_scope: 'user' | 'project'): boolean {
    return true;
  }

  resolveSource(
    source: string,
    context: NativeOperationContext,
    provenance: Readonly<Record<string, string>> = {},
  ): NativeSourceResolution {
    const normalized = normalizePiPackageSource(source, context);
    if (!normalized) {
      return {
        success: false,
        error: `Pi native install does not support source '${source}'`,
      };
    }
    return {
      success: true,
      resource: {
        kind: 'package',
        requestedIdentity: source,
        resolvedIdentity: normalized.resolvedIdentity,
        context,
        provenance: {
          ...provenance,
          sourceType: normalized.kind,
          packageIdentity: normalized.packageIdentity,
          commandSource: normalized.commandSource,
        },
      },
    };
  }

  inspect(context: NativeOperationContext): Promise<NativeInspectionResult> {
    return inspectScopePackages(context);
  }

  private async preflightMutation(
    resource: NativeResource,
    context: NativeOperationContext,
  ): Promise<string | null> {
    const inspection = await inspectScopePackages(context);
    if (!inspection.success) return inspection.error ?? 'Could not inspect Pi packages';
    const packageIdentity = packageIdentityFromResource(resource, context);
    if (!packageIdentity) return 'Pi package resource has no valid package identity';
    const observation = inspection.observations?.find(
      (candidate) =>
        candidate.resource.provenance.packageIdentity === packageIdentity,
    );
    if (observation?.status === 'disabled') {
      return `${packageIdentity} is configured but disabled in Pi settings; enable it with pi config before syncing`;
    }
    if (observation?.status === 'unusable') {
      return observation.error ?? `${packageIdentity} is unusable in Pi settings`;
    }
    return null;
  }

  async install(
    resource: NativeResource,
    context: NativeOperationContext,
  ): Promise<NativeMutationResult> {
    const preflightError = await this.preflightMutation(resource, context);
    if (preflightError) return { success: false, error: preflightError };
    const result = await this.run(
      'pi',
      mutationArgs('install', sourceFromResource(resource), context),
      commandOptions(context),
    );
    return result.success
      ? { success: true }
      : { success: false, error: commandError(result) };
  }

  async update(
    resource: NativeResource,
    current: NativeResource,
    context: NativeOperationContext,
  ): Promise<NativeMutationResult> {
    const preflightError = await this.preflightMutation(resource, context);
    if (preflightError) return { success: false, error: preflightError };

    const selectedIdentity = packageIdentityFromResource(resource, context);
    if (!selectedIdentity) {
      return { success: false, error: 'Pi package resource has no valid package identity' };
    }
    const opposite: NativeOperationContext = {
      ...context,
      scope: context.scope === 'user' ? 'project' : 'user',
      nativeScope: context.scope === 'user' ? 'project' : 'user',
      root:
        context.scope === 'user'
          ? contextCwd(context)
          : piAgentRoot(context),
    };
    if (opposite.scope === 'project') {
      const trust = await inspectPiProjectTrust(opposite);
      if (trust.allowed) {
        const oppositeInspection = await inspectScopePackages(opposite);
        if (!oppositeInspection.success) {
          return {
            success: false,
            error: `Could not prove Pi update scope isolation: ${oppositeInspection.error ?? 'opposite scope inspection failed'}`,
          };
        }
        if (
          oppositeInspection.observations?.some(
            (candidate) =>
              candidate.resource.provenance.packageIdentity === selectedIdentity,
          )
        ) {
          return {
            success: false,
            error: `Refusing targeted Pi update for ${selectedIdentity}: the same package is configured in both user and project scopes`,
          };
        }
      }
    } else {
      const oppositeInspection = await inspectScopePackages(opposite);
      if (!oppositeInspection.success) {
        return {
          success: false,
          error: `Could not prove Pi update scope isolation: ${oppositeInspection.error ?? 'opposite scope inspection failed'}`,
        };
      }
      if (
        oppositeInspection.observations?.some(
          (candidate) =>
            candidate.resource.provenance.packageIdentity === selectedIdentity,
        )
      ) {
        return {
          success: false,
          error: `Refusing targeted Pi update for ${selectedIdentity}: the same package is configured in both user and project scopes`,
        };
      }
    }

    let args: string[];
    if (resource.resolvedIdentity !== current.resolvedIdentity) {
      args = mutationArgs('install', sourceFromResource(resource), context);
    } else {
      args = [
        'update',
        sourceFromResource(resource),
        context.scope === 'project' ? '--approve' : '--no-approve',
      ];
    }
    const result = await this.run('pi', args, commandOptions(context));
    return result.success
      ? { success: true }
      : { success: false, error: commandError(result) };
  }

  async remove(
    resource: NativeResource,
    context: NativeOperationContext,
  ): Promise<NativeMutationResult> {
    if (context.scope === 'project') {
      const trust = await inspectPiProjectTrust(context);
      if (!trust.allowed) {
        return {
          success: false,
          error: trust.error ?? `Pi project trust is ${trust.status}`,
        };
      }
    }
    const result = await this.run(
      'pi',
      mutationArgs('remove', sourceFromResource(resource), context),
      commandOptions(context),
    );
    return result.success
      ? { success: true }
      : { success: false, error: commandError(result) };
  }
}
