import {
  isAlias,
  isScalar,
  isSeq,
  Pair,
  Scalar,
  parseDocument,
  stringify,
  YAMLMap,
  YAMLSeq,
  visit,
  type CollectionTag,
  type Document,
  type ScalarTag,
} from 'yaml';

// Keep the application's core-schema value contract in one place. In particular,
// yaml's built-in omap/pairs/binary tags have different JS representations.
const binary: ScalarTag = {
  tag: 'tag:yaml.org,2002:binary',
  identify: (value) => value instanceof Uint8Array,
  resolve(value, onError) {
    const compact = value.replace(/\s/g, '');
    if (
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        compact,
      )
    ) {
      onError('Invalid base64 binary value');
    }
    return new Uint8Array(Buffer.from(compact, 'base64'));
  },
  stringify({ value }) {
    return JSON.stringify(Buffer.from(value as Uint8Array).toString('base64'));
  },
};

function orderedTag(kind: 'omap' | 'pairs'): CollectionTag {
  return {
    tag: `tag:yaml.org,2002:${kind}`,
    collection: 'seq',
    resolve(seq, onError) {
      if (!isSeq(seq)) {
        onError(`Expected a sequence for ${kind}`);
        return seq;
      }
      // Convert after alias and merge resolution, keeping the original mapping
      // nodes intact for comment-preserving edits. Mutate the returned list so
      // aliases to this sequence retain their identity.
      seq.toJSON = function (...args: Parameters<YAMLSeq['toJSON']>) {
        const items = YAMLSeq.prototype.toJSON.apply(this, args);
        const keys = new Set<string>();
        for (let index = 0; index < items.length; index++) {
          const item = items[index];
          const entries =
            item && Object.getPrototypeOf(item) === Object.prototype
              ? Object.entries(item)
              : [];
          const entry = entries[0];
          if (!entry || entries.length !== 1) {
            throw new Error(`Each ${kind} item must be a mapping with one key`);
          }
          if (kind === 'omap' && keys.has(entry[0]))
            throw new Error('Ordered map keys must be unique');
          keys.add(entry[0]);
          if (kind === 'pairs') items[index] = entry;
        }
        return items;
      };
      return seq;
    },
  };
}

const options = {
  schema: 'core',
  customTags: [
    'timestamp',
    binary,
    orderedTag('omap'),
    orderedTag('pairs'),
    'set',
    'merge',
  ],
  merge: true,
  lineWidth: 0,
} as const;

/** Application-owned parse failures, independent of the YAML library. */
export class YamlError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'YamlError';
  }
}

function yamlOperation<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw error instanceof YamlError ? error : new YamlError(error);
  }
}

/** Parse once for both semantic reads and comment-preserving workspace edits. */
export function parseYamlDocument(input: string) {
  return yamlOperation(() => {
    const document = parseDocument(input, {
      ...options,
      customTags: [...options.customTags],
      keepSourceTokens: true,
    });
    if (document.errors.length) throw document.errors[0];
    // yaml otherwise silently accepts unknown tags as ordinary values.
    if (document.warnings.length) throw document.warnings[0];
    if (!document.contents)
      throw new Error('Expected a YAML document, but the input is empty');

    visit(document, {
      Map(_key, map) {
        if (map.tag === 'tag:yaml.org,2002:set') return;
        // yaml stringifies null keys as "" and complex keys with a warning.
        // Preserve the application's string-key mapping contract without
        // changing source nodes, anchors, or set members.
        map.toJSON = function (...args: Parameters<YAMLMap['toJSON']>) {
          const keys = new Set<string>();
          const normalized = Object.create(this) as YAMLMap;
          normalized.items = this.items.map((pair) => {
            const key = isAlias(pair.key)
              ? pair.key.resolve(document)
              : pair.key;
            const value = isScalar(key) ? key.value : key;
            if (value !== null && typeof value === 'object')
              throw new Error('Object-based map does not support complex keys');
            if (typeof value !== 'symbol') {
              const name = String(value);
              if (keys.has(name)) throw new Error('Duplicated mapping key');
              keys.add(name);
            }
            return value === null
              ? new Pair(new Scalar('null'), pair.value)
              : pair;
          });
          return YAMLMap.prototype.toJSON.apply(normalized, args);
        };
      },
    });
    return document;
  });
}

/** Read an application-parsed document without reparsing or caching values. */
export function yamlDocumentValue(document: Document): unknown {
  return yamlOperation(() => document.toJS());
}

export function loadYaml(input: string): unknown {
  return yamlDocumentValue(parseYamlDocument(input));
}

export function stringifyYaml(value: unknown): string {
  return yamlOperation(() =>
    stringify(value, { ...options, customTags: [...options.customTags] }),
  );
}
