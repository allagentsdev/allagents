import { readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import {
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  visit,
  type Node,
  type Document,
} from 'yaml';
import { loadYaml, parseYamlDocument, stringifyYaml } from './yaml.js';

interface WorkspaceWriteOptions {
  /** Disambiguate removal of declarations whose values are identical. */
  removedPluginIndexes?: readonly number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function entryIdentity(value: unknown): unknown {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return undefined;
  return value.source ?? value.path ?? value.name;
}

/** Apply semantic edits to the original nodes so comments stay with their entries. */
export function serializeWorkspaceConfig(
  config: unknown,
  original?: string,
  options: WorkspaceWriteOptions = {},
): string {
  if (original === undefined) return stringifyYaml(config);
  const before = loadYaml(original);
  if (isDeepStrictEqual(before, config)) return original;

  const document: Document = parseYamlDocument(original);

  const aliases = new Map<Node, unknown>();
  visit(document, {
    Alias: (_key, node) => {
      aliases.set(node, node.toJS(document));
    },
  });

  let plugins = document.get('plugins', true);
  if (isAlias(plugins)) plugins = plugins.resolve(document);
  const removedPlugins = new Set(options.removedPluginIndexes);

  function update(node: unknown, previous: unknown, next: unknown): Node {
    if (isNode(node) && isDeepStrictEqual(previous, next)) return node;
    if (isMap(node) && isRecord(previous) && isRecord(next)) {
      const keyFor = (key: string) =>
        node.items.find(
          (pair) => isScalar(pair.key) && String(pair.key.value) === key,
        )?.key ?? key;
      // An inherited key cannot be deleted while its merge still supplies it.
      if (
        Object.keys(previous).some(
          (key) => next[key] === undefined && !node.has(keyFor(key)),
        )
      ) {
        node.items = node.items.filter(
          (pair) =>
            !isScalar(pair.key) ||
            typeof pair.key.value !== 'symbol' ||
            pair.key.value.description !== '<<',
        );
        for (const [key, value] of Object.entries(previous)) {
          if (!node.has(keyFor(key)) && next[key] !== undefined)
            node.set(key, document.createNode(value));
        }
      }
      for (const key of Object.keys(previous)) {
        if (next[key] === undefined) node.delete(keyFor(key));
      }
      for (const [key, value] of Object.entries(next)) {
        if (value === undefined || isDeepStrictEqual(previous[key], value))
          continue;
        const yamlKey = keyFor(key);
        node.set(
          yamlKey,
          update(node.get(yamlKey, true), previous[key], value),
        );
      }
      return node;
    }
    if (isSeq(node) && Array.isArray(previous) && Array.isArray(next)) {
      const available = new Set(
        previous
          .map((_, index) => index)
          .filter((index) => node !== plugins || !removedPlugins.has(index)),
      );
      const positions = [...available];
      // Keep unchanged entries in place before matching moved or edited entries.
      const exactMatches = next.map((value, index) => {
        const candidate = positions[index];
        if (
          candidate !== undefined &&
          isDeepStrictEqual(previous[candidate], value)
        ) {
          available.delete(candidate);
          return candidate;
        }
        return undefined;
      });
      next.forEach((value, index) => {
        if (exactMatches[index] !== undefined) return;
        for (const candidate of available) {
          if (isDeepStrictEqual(previous[candidate], value)) {
            exactMatches[index] = candidate;
            available.delete(candidate);
            break;
          }
        }
      });
      next.forEach((value, index) => {
        if (exactMatches[index] !== undefined) return;
        const identity = entryIdentity(value);
        if (identity === undefined) return;
        for (const candidate of available) {
          if (entryIdentity(previous[candidate]) === identity) {
            exactMatches[index] = candidate;
            available.delete(candidate);
            break;
          }
        }
      });
      // A single unmatched entry on each side is a replacement declaration.
      const unmatched = exactMatches.flatMap((match, index) =>
        match === undefined ? [index] : [],
      );
      const unmatchedIndex = unmatched[0];
      if (
        previous.length === next.length &&
        available.size === 1 &&
        unmatched.length === 1 &&
        unmatchedIndex !== undefined
      ) {
        exactMatches[unmatchedIndex] = available.values().next().value;
      }
      node.items = next.map((value, index) => {
        const match = exactMatches[index];
        return update(
          match === undefined ? undefined : node.items[match],
          match === undefined ? undefined : previous[match],
          value,
        );
      });
      return node;
    }
    if (
      isAlias(node) &&
      node.resolve(document) &&
      isDeepStrictEqual(node.toJS(document), next)
    ) {
      aliases.set(node, next);
      return node;
    }
    if (isScalar(node) && (next === null || typeof next !== 'object')) {
      node.value = next;
      return node;
    }
    const replacement = document.createNode(next);
    if (isNode(node)) {
      replacement.commentBefore = node.commentBefore ?? null;
      replacement.spaceBefore = node.spaceBefore ?? false;
      if (
        isMap(replacement) &&
        typeof previous === 'string' &&
        entryIdentity(next) === previous
      ) {
        const source =
          replacement.get('source', true) ?? replacement.get('name', true);
        if (isNode(source)) source.comment = node.comment ?? null;
      } else {
        replacement.comment = node.comment ?? null;
      }
    }
    return replacement;
  }

  document.contents = update(document.contents, before, config);
  visit(document, {
    Alias: (_key, node) => {
      const value = aliases.get(node);
      if (
        !node.resolve(document) ||
        !isDeepStrictEqual(node.toJS(document), value)
      ) {
        const replacement = document.createNode(value);
        replacement.comment = node.comment ?? null;
        replacement.commentBefore = node.commentBefore ?? null;
        replacement.spaceBefore = node.spaceBefore ?? false;
        return replacement;
      }
    },
  });
  const result = document.toString({ lineWidth: 0 });
  if (
    !isDeepStrictEqual(
      loadYaml(result),
      loadYaml(stringifyYaml(config)),
    )
  ) {
    throw new Error(
      'Unable to preserve workspace YAML without changing configuration values',
    );
  }
  return result;
}

export async function serializeWorkspaceConfigFile(
  path: string,
  config: unknown,
  options: WorkspaceWriteOptions = {},
): Promise<string> {
  const original = await readFile(path, 'utf-8').catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  return serializeWorkspaceConfig(config, original, options);
}

export async function writeWorkspaceConfig(
  path: string,
  config: unknown,
  options: WorkspaceWriteOptions = {},
): Promise<void> {
  await writeFile(
    path,
    await serializeWorkspaceConfigFile(path, config, options),
    'utf-8',
  );
}
