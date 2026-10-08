import { glob, isDynamicPattern } from 'tinyglobby';
import { join } from 'node:path';

export function isGlobPattern(pattern: string): boolean {
  const p = pattern.startsWith('!') ? pattern.slice(1) : pattern;
  return isDynamicPattern(p);
}

export function isNegationPattern(pattern: string): boolean {
  return pattern.startsWith('!');
}

export interface ResolvedFile {
  sourcePath: string;
  relativePath: string;
}

export async function resolveGlobPatterns(
  sourceRoot: string,
  patterns: string[],
): Promise<ResolvedFile[]> {
  const includedFiles = new Map<string, ResolvedFile>();

  for (const pattern of patterns) {
    if (isNegationPattern(pattern)) {
      const positivePattern = pattern.slice(1);
      if (isGlobPattern(positivePattern)) {
        const matches = await glob(positivePattern, { cwd: sourceRoot, onlyFiles: true, dot: true });
        for (const match of matches) includedFiles.delete(match);
      } else {
        includedFiles.delete(positivePattern);
      }
    } else {
      if (isGlobPattern(pattern)) {
        const matches = await glob(pattern, { cwd: sourceRoot, onlyFiles: true, dot: true });
        for (const match of matches) {
          includedFiles.set(match, { sourcePath: join(sourceRoot, match), relativePath: match });
        }
      } else {
        includedFiles.set(pattern, { sourcePath: join(sourceRoot, pattern), relativePath: pattern });
      }
    }
  }

  return Array.from(includedFiles.values());
}
