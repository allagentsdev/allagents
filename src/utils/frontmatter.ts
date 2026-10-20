import { loadYaml } from './yaml.js';

/** Read YAML metadata only; Markdown after the closing delimiter is never parsed. */
export function readYamlFrontmatter(content: string): Record<string, unknown> {
  const source = content.startsWith('\uFEFF') ? content.slice(1) : content;
  const lines = source.split('\n');
  const opening = lines[0]?.trimEnd();
  if (!opening?.startsWith('---')) return {};
  const language = opening.slice(3).trim().toLowerCase();
  if (language !== '' && language !== 'yaml' && language !== 'yml') return {};

  let end = 1;
  while (end < lines.length) {
    const line = lines[end]?.trimEnd() ?? '';
    if (line === '---' || /^---[ \t]+#/.test(line)) break;
    end++;
  }
  // An explicit document also handles empty/comment-only metadata as null.
  const data = loadYaml(`---\n${lines.slice(1, end).join('\n')}`);
  return data !== null && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}
