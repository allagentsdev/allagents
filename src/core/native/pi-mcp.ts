import { relative, resolve } from 'node:path';
import { readFile, realpath, stat } from 'node:fs/promises';
import picomatch from 'picomatch';
import { pathIsWithin } from '../client-context.js';
import {
  PiNativeClient,
  normalizePiPackageSource,
  readPiSettings,
  type PiPackageEntry,
  type PiSettings,
} from './pi.js';
import type {
  NativeOperationContext,
  NativeResourceObservation,
} from './types.js';

const MCP_PACKAGE_NAME = 'pi-mcp-adapter';
const MCP_PACKAGE_IDENTITY = `npm:${MCP_PACKAGE_NAME}`;

export type PiMcpAdapterClassification =
  | 'absent'
  | 'configured-missing'
  | 'installed-disabled'
  | 'usable'
  | 'inspection-failed';

export interface PiMcpAdapterInspection {
  classification: PiMcpAdapterClassification;
  root: string;
  packageSource?: string;
  packagePath?: string;
  manifestPath?: string;
  version?: string;
  extensionPath?: string;
  error?: string;
}

function configuredEntry(
  settings: PiSettings,
  source: string,
): PiPackageEntry | undefined {
  return settings.packages.find((entry) => entry.source === source);
}

function normalizedPattern(pattern: string): string {
  const withoutMarker = /^[!+-]/.test(pattern) ? pattern.slice(1) : pattern;
  return withoutMarker.replace(/^\.\//, '').replaceAll('\\', '/');
}

function patternMatches(path: string, pattern: string): boolean {
  const normalizedPath = path.replaceAll('\\', '/');
  const normalized = normalizedPattern(pattern);
  const basename = normalizedPath.split('/').at(-1) ?? normalizedPath;
  return (
    picomatch(normalized)(normalizedPath) ||
    picomatch(normalized)(basename)
  );
}

function extensionEnabled(entry: PiPackageEntry, path: string): boolean {
  const patterns = entry.extensions;
  if (entry.autoload === false) {
    let enabled = false;
    for (const pattern of patterns ?? []) {
      if (!patternMatches(path, pattern)) continue;
      enabled = !pattern.startsWith('!') && !pattern.startsWith('-');
    }
    return enabled;
  }
  if (patterns === undefined) return true;
  if (patterns.length === 0) return false;

  const includes = patterns.filter((pattern) => !/^[!+-]/.test(pattern));
  let enabled =
    includes.length === 0 || includes.some((pattern) => patternMatches(path, pattern));
  if (
    patterns.some(
      (pattern) => pattern.startsWith('!') && patternMatches(path, pattern),
    )
  ) {
    enabled = false;
  }
  if (
    patterns.some(
      (pattern) => pattern.startsWith('+') && patternMatches(path, pattern),
    )
  ) {
    enabled = true;
  }
  if (
    patterns.some(
      (pattern) => pattern.startsWith('-') && patternMatches(path, pattern),
    )
  ) {
    enabled = false;
  }
  return enabled;
}

async function canonicalExistingPath(path: string): Promise<string> {
  await stat(path);
  return realpath(path);
}

function failed(
  root: string,
  error: string,
  details: Partial<PiMcpAdapterInspection> = {},
): PiMcpAdapterInspection {
  return { classification: 'inspection-failed', root, ...details, error };
}

function recognizableAdapterSource(observation: NativeResourceObservation): boolean {
  const normalized = observation.resource.provenance.packageIdentity;
  if (normalized === MCP_PACKAGE_IDENTITY) return true;
  const source = observation.resource.requestedIdentity;
  return /(?:^|[\\/])pi-mcp-adapter(?:\.git)?(?:@[^\\/]*)?$/.test(source);
}

export async function inspectPiMcpAdapter(
  selectedRoot: string,
): Promise<PiMcpAdapterInspection> {
  const root = resolve(selectedRoot);
  const context: NativeOperationContext = {
    client: 'pi',
    scope: 'user',
    nativeScope: 'user',
    root,
    cwd: root,
    roots: { agent: root },
  };

  let settings: PiSettings;
  try {
    settings = await readPiSettings(resolve(root, 'settings.json'));
  } catch (error) {
    return failed(
      root,
      error instanceof Error ? error.message : String(error),
    );
  }

  const inventory = await new PiNativeClient().inspect(context);
  if (!inventory.success) {
    return failed(root, inventory.error ?? 'Could not inspect selected Pi root');
  }

  const candidates: NativeResourceObservation[] = [];
  for (const observation of inventory.observations ?? []) {
    if (recognizableAdapterSource(observation)) {
      candidates.push(observation);
      continue;
    }
    if (!observation.installedPath || observation.status === 'configured-missing') {
      continue;
    }
    try {
      const manifest = JSON.parse(
        await readFile(resolve(observation.installedPath, 'package.json'), 'utf8'),
      ) as unknown;
      if (
        manifest &&
        typeof manifest === 'object' &&
        !Array.isArray(manifest) &&
        (manifest as Record<string, unknown>).name === MCP_PACKAGE_NAME
      ) {
        candidates.push(observation);
      }
    } catch {
      // Non-adapter packages are irrelevant; the generic inventory already
      // records malformed installed packages as unusable.
    }
  }

  if (candidates.length === 0) {
    return { classification: 'absent', root };
  }
  if (candidates.length > 1) {
    return failed(root, 'Multiple configured packages resolve to pi-mcp-adapter');
  }

  const candidate = candidates[0];
  if (!candidate) return { classification: 'absent', root };
  const packageSource = candidate.resource.requestedIdentity;
  const packagePath = candidate.installedPath;
  if (!packagePath || candidate.status === 'configured-missing') {
    return {
      classification: 'configured-missing',
      root,
      packageSource,
      ...(packagePath && { packagePath }),
    };
  }
  if (candidate.status === 'unusable') {
    return failed(root, candidate.error ?? 'Configured adapter package is unusable', {
      packageSource,
      packagePath,
    });
  }

  let canonicalRoot: string;
  let canonicalPackagePath: string;
  try {
    canonicalRoot = await canonicalExistingPath(root);
    canonicalPackagePath = await canonicalExistingPath(packagePath);
  } catch (error) {
    return failed(
      root,
      `Could not resolve selected Pi package path: ${error instanceof Error ? error.message : String(error)}`,
      { packageSource, packagePath },
    );
  }
  if (!pathIsWithin(canonicalRoot, canonicalPackagePath)) {
    return failed(root, 'Configured pi-mcp-adapter package escapes the selected Pi root', {
      packageSource,
      packagePath,
    });
  }

  const manifestPath = resolve(packagePath, 'package.json');
  let manifest: Record<string, unknown>;
  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected an object');
    }
    manifest = parsed as Record<string, unknown>;
  } catch (error) {
    return failed(
      root,
      `Could not parse pi-mcp-adapter manifest: ${error instanceof Error ? error.message : String(error)}`,
      { packageSource, packagePath, manifestPath },
    );
  }
  if (manifest.name !== MCP_PACKAGE_NAME) {
    return failed(root, `Configured adapter manifest name is not ${MCP_PACKAGE_NAME}`, {
      packageSource,
      packagePath,
      manifestPath,
    });
  }
  if (typeof manifest.version !== 'string' || !manifest.version) {
    return failed(root, 'Configured pi-mcp-adapter manifest has no version', {
      packageSource,
      packagePath,
      manifestPath,
    });
  }

  const pi = manifest.pi;
  if (!pi || typeof pi !== 'object' || Array.isArray(pi)) {
    return failed(root, 'Configured pi-mcp-adapter manifest has no Pi resource declaration', {
      packageSource,
      packagePath,
      manifestPath,
      version: manifest.version,
    });
  }
  const extensions = (pi as Record<string, unknown>).extensions;
  if (
    !Array.isArray(extensions) ||
    extensions.length === 0 ||
    extensions.some((entry) => typeof entry !== 'string' || !entry)
  ) {
    return failed(root, 'Configured pi-mcp-adapter manifest has no valid extension path', {
      packageSource,
      packagePath,
      manifestPath,
      version: manifest.version,
    });
  }

  const settingsEntry = configuredEntry(settings, packageSource);
  if (!settingsEntry) {
    return failed(root, 'Configured adapter entry disappeared during inspection', {
      packageSource,
      packagePath,
      manifestPath,
      version: manifest.version,
    });
  }

  let enabledExtension: string | undefined;
  for (const extension of extensions as string[]) {
    if (/[*?]/.test(extension) || /^[!+-]/.test(extension)) {
      return failed(root, 'pi-mcp-adapter extension path must resolve unambiguously', {
        packageSource,
        packagePath,
        manifestPath,
        version: manifest.version,
      });
    }
    const extensionPath = resolve(packagePath, extension);
    if (!pathIsWithin(resolve(packagePath), extensionPath)) {
      return failed(root, 'pi-mcp-adapter extension path escapes its package', {
        packageSource,
        packagePath,
        manifestPath,
        version: manifest.version,
      });
    }
    let canonicalExtension: string;
    try {
      canonicalExtension = await canonicalExistingPath(extensionPath);
    } catch (error) {
      return failed(
        root,
        `Could not resolve pi-mcp-adapter extension: ${error instanceof Error ? error.message : String(error)}`,
        {
          packageSource,
          packagePath,
          manifestPath,
          version: manifest.version,
        },
      );
    }
    if (
      !pathIsWithin(canonicalPackagePath, canonicalExtension) ||
      !pathIsWithin(canonicalRoot, canonicalExtension)
    ) {
      return failed(root, 'pi-mcp-adapter extension escapes the selected Pi root', {
        packageSource,
        packagePath,
        manifestPath,
        version: manifest.version,
      });
    }
    const relativeExtension = relative(packagePath, extensionPath).replaceAll(
      '\\',
      '/',
    );
    if (extensionEnabled(settingsEntry, relativeExtension)) {
      enabledExtension = canonicalExtension;
    }
  }

  if (candidate.status === 'disabled' || !enabledExtension) {
    return {
      classification: 'installed-disabled',
      root,
      packageSource,
      packagePath,
      manifestPath,
      version: manifest.version,
    };
  }
  return {
    classification: 'usable',
    root,
    packageSource,
    packagePath,
    manifestPath,
    version: manifest.version,
    extensionPath: enabledExtension,
  };
}

export function isPiMcpAdapterSource(
  source: string,
  context: NativeOperationContext,
): boolean {
  return normalizePiPackageSource(source, context)?.packageIdentity === MCP_PACKAGE_IDENTITY;
}
