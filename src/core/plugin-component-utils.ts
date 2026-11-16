import { lstatSync } from 'node:fs';
import { relative } from 'node:path';
import picomatch from 'picomatch';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function excluded(root: string, path: string, patterns?: string[]): boolean {
  const source = relative(root, path).replaceAll('\\', '/');
  return patterns?.some((pattern) => {
    const matches = picomatch(pattern);
    return matches(source) || matches(`${source}/`);
  }) ?? false;
}

export function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

