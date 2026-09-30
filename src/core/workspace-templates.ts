import { readdir } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { CONFIG_DIR, WORKSPACE_CONFIG_FILE } from '../constants.js';

/** Find workspace roots beneath a directory, including hidden directories. */
export async function findWorkspaceTemplatesInDirectory(
  root: string,
): Promise<string[]> {
  const templates: string[] = [];

  async function visit(directory: string, relativePath: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    const configDir = entries.find(
      (entry) => entry.name === CONFIG_DIR && entry.isDirectory(),
    );
    if (configDir) {
      const configEntries = await readdir(join(directory, CONFIG_DIR), {
        withFileTypes: true,
      });
      if (
        configEntries.some(
          (entry) => entry.name === WORKSPACE_CONFIG_FILE && entry.isFile(),
        )
      ) {
        templates.push(relativePath);
      }
    }

    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.name === '.git' ||
        entry.name === 'node_modules' ||
        entry.name === CONFIG_DIR
      ) {
        continue;
      }
      await visit(
        join(directory, entry.name),
        relativePath ? posix.join(relativePath, entry.name) : entry.name,
      );
    }
  }

  await visit(root, '');
  return templates.sort();
}
