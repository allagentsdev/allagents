import { writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR, SYNC_STATE_FILE } from '../constants.js';

const GITIGNORE_ENTRIES = [SYNC_STATE_FILE, 'mcp.json'];

/**
 * Ensure .allagents/.gitignore exists and contains entries for machine-local files.
 * Idempotent — safe to call on every sync.
 */
export async function ensureConfigGitignore(workspacePath: string): Promise<void> {
  const gitignorePath = join(workspacePath, CONFIG_DIR, '.gitignore');

  let existing = '';
  if (existsSync(gitignorePath)) {
    existing = await readFile(gitignorePath, 'utf-8');
  }

  const missing = GITIGNORE_ENTRIES.filter((entry) => !existing.split('\n').includes(entry));
  if (missing.length === 0) return;

  const content = existing
    ? `${existing.trimEnd()}\n${missing.join('\n')}\n`
    : `${missing.join('\n')}\n`;

  await writeFile(gitignorePath, content, 'utf-8');
}
