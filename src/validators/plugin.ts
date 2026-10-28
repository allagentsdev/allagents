import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import JSON5 from 'json5';
import { discoverSkillEntriesFromPluginRoot } from '../core/skills.js';
import { parseMarketplaceManifest } from '../utils/marketplace-manifest-parser.js';
import { validateSkill } from './skill.js';

interface PluginDiagnostic {
  severity: 'error' | 'warning';
  /** Location relative to the plugin root; "." refers to the root itself. */
  path: string;
  message: string;
}

export interface PluginValidationResult {
  path: string;
  valid: boolean;
  message: string;
  // Keep arrays nested so --json=path,valid projects the top-level fields.
  validation: { skills: number; diagnostics: PluginDiagnostic[] };
}

/** Inspect local content only. Never resolve sources or invoke plugin code. */
export async function validateLocalPlugin(
  path: string,
): Promise<PluginValidationResult> {
  const root = resolve(path);
  const diagnostics: PluginDiagnostic[] = [];
  let skills = 0;
  let recognized = false;

  function diagnostic(
    location: string,
    message: string,
    severity: PluginDiagnostic['severity'] = 'error',
  ) {
    diagnostics.push({
      severity,
      path: location,
      message: message.replaceAll(root, '.'),
    });
  }

  async function inspect(location: string) {
    let linked = false;
    try {
      const entry = await lstat(join(root, location));
      if (!entry.isSymbolicLink()) return entry;
      linked = true;
      return await stat(join(root, location));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (linked || code !== 'ENOENT')
        diagnostic(
          location,
          `Cannot inspect path (${code ?? 'unknown error'})`,
        );
      return undefined;
    }
  }

  async function readObject(location: string, label: string, format: 'JSON' | 'JSON5' = 'JSON') {
    try {
      const content = await readFile(join(root, location), 'utf8');
      const value: unknown = format === 'JSON5' ? JSON5.parse(content) : JSON.parse(content.replace(/^\uFEFF/, ''));
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        diagnostic(location, `${label} must be a ${format} object`);
        return undefined;
      }
      return value as Record<string, unknown>;
    } catch {
      diagnostic(location, `Cannot read ${label.toLowerCase()} or parse it as ${format}`);
      return undefined;
    }
  }

  async function hasResourceFiles(directory: string): Promise<boolean> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (entry.isFile() || (entry.isSymbolicLink() && (await stat(target)).isFile())) return true;
      // Directory links are deliberately not traversed, just as in skill discovery.
      if (entry.isDirectory() && await hasResourceFiles(target)) return true;
    }
    return false;
  }

  function result(): PluginValidationResult {
    const valid = !diagnostics.some((entry) => entry.severity === 'error');
    return {
      path,
      valid,
      message: valid ? 'Plugin is valid' : 'Plugin validation failed',
      validation: { skills, diagnostics },
    };
  }

  const rootStat = await inspect('.');
  if (!rootStat) {
    if (diagnostics.length === 0) diagnostic('.', 'Plugin path does not exist');
    return result();
  }
  if (!rootStat.isDirectory()) {
    diagnostic('.', 'Plugin path must be a directory');
    return result();
  }

  for (const location of [
    '.claude-plugin/plugin.json',
    '.github/plugin/plugin.json',
    '.codex-plugin/plugin.json',
  ]) {
    if (!(await inspect(location))) continue;
    recognized = true;
    await readObject(location, 'Plugin manifest');
  }

  // These declarations have different accepted syntaxes but share an object container.
  for (const [location, label, format] of [
    ['.mcp.json', 'MCP declaration', 'JSON5'],
    ['hooks.json', 'Hook declaration', 'JSON'],
    ['hooks/hooks.json', 'Hook declaration', 'JSON'],
    ['.codex/hooks.json', 'Hook declaration', 'JSON'],
  ] as const) {
    if (!(await inspect(location))) continue;
    recognized = true;
    await readObject(location, label, format);
  }

  // Match the precedence and lenient semantics used during installation.
  for (const location of [
    '.github/plugin/marketplace.json',
    '.claude-plugin/marketplace.json',
  ]) {
    if (!(await inspect(location))) continue;
    recognized = true;
    const manifest = await parseMarketplaceManifest(root);
    if (!manifest.success) diagnostic(location, manifest.error);
    else
      for (const warning of manifest.warnings)
        diagnostic(location, warning, 'warning');
    break;
  }

  try {
    const warnings: string[] = [];
    const entries = await discoverSkillEntriesFromPluginRoot(root, warnings);
    for (const warning of warnings) diagnostic('.', warning);
    skills = entries.length;
    recognized ||= skills > 0;
    for (const entry of entries.sort((a, b) =>
      a.skillPath.localeCompare(b.skillPath),
    )) {
      const skill = await validateSkill(entry.skillPath);
      if (!skill.valid)
        diagnostic(
          relative(root, skill.path).replaceAll('\\', '/'),
          skill.error ?? 'Invalid skill',
        );
    }
  } catch (error) {
    diagnostic(
      '.',
      `Cannot discover skills (${(error as NodeJS.ErrnoException).code ?? 'read error'})`,
    );
  }

  for (const location of ['commands', 'agents', 'hooks', '.github']) {
    const entry = await inspect(location);
    if (!entry) continue;
    if (!entry.isDirectory()) {
      diagnostic(location, 'Resource path must be a directory');
      continue;
    }
    try {
      const hasFiles = await hasResourceFiles(join(root, location));
      recognized ||= hasFiles;
    } catch (error) {
      diagnostic(
        location,
        `Cannot read resource directory (${(error as NodeJS.ErrnoException).code ?? 'read error'})`,
      );
    }
  }
  for (const location of [
    'AGENTS.md',
    'CLAUDE.md',
  ]) {
    const entry = await inspect(location);
    if (!entry) continue;
    if (entry.isFile()) recognized = true;
    else diagnostic(location, 'Resource path must be a file');
  }

  // Infer Pi only after recognizing file plugins: their supporting directories and
  // unmarked sidecar package.json files must not become Pi declarations.
  let piResources = false;
  for (const location of ['extensions', 'prompts', 'themes']) {
    const entry = await inspect(location);
    if (entry?.isDirectory()) piResources = true;
  }
  const piLayout = piResources && !recognized;
  recognized ||= piResources;
  if (await inspect('package.json')) {
    let manifest: unknown;
    try {
      manifest = JSON.parse((await readFile(join(root, 'package.json'), 'utf8')).replace(/^\uFEFF/, ''));
    } catch {
      if (piLayout) diagnostic('package.json', 'Cannot read Pi package manifest or parse it as JSON');
    }
    if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
      const value = manifest as Record<string, unknown>;
      if (piLayout || (value.pi !== null && typeof value.pi === 'object' && !Array.isArray(value.pi))) {
        recognized = true;
        if (typeof value.name !== 'string' || !value.name) diagnostic('package.json', 'Pi package manifest must have a nonempty name');
      }
    } else if (manifest !== undefined && piLayout) diagnostic('package.json', 'Pi package manifest must be a JSON object');
  }

  if (!recognized && diagnostics.length === 0) {
    diagnostic(
      '.',
      'No supported plugin resources found (expected skills, commands, agents, hooks, .github content, .mcp.json, instructions, a Pi package, or a plugin/marketplace manifest)',
    );
  }
  return result();
}
