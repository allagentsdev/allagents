import { describe, expect, test } from 'bun:test';
import { loadYaml, parseYamlDocument, stringifyYaml, yamlDocumentValue, YamlError } from '../../../src/utils/yaml.js';
import { serializeWorkspaceConfig } from '../../../src/utils/workspace-writer.js';

describe('application YAML contract', () => {
  test('reads a reused document without changing tagged nodes or caching alias values', () => {
    const source = `item: &item { a: one } # Keep the anchor
ordered: &ordered !!omap [*item]
orderedCopy: *ordered
pairs: &pairs !!pairs [*item]
pairsCopy: *pairs
binary: !!binary SGVsbG8=
date: !!timestamp 2024-01-01
set: !!set { one: null }
`;
    const document = parseYamlDocument(source);
    const originalNodes = document.toString();
    const before = yamlDocumentValue(document) as any;
    expect(before).toEqual(loadYaml(source));
    expect(before.orderedCopy).toBe(before.ordered);
    expect(before.pairsCopy).toBe(before.pairs);
    expect(document.toString()).toBe(originalNodes);

    document.setIn(['item', 'a'], 'two');
    const after = yamlDocumentValue(document) as any;
    expect(before.item.a).toBe('one');
    expect(before.ordered).toEqual([{ a: 'one' }]);
    expect(before.pairs).toEqual([['a', 'one']]);
    expect(after.ordered).toEqual([{ a: 'two' }]);
    expect(after.pairs).toEqual([['a', 'two']]);
    expect(after.orderedCopy).toBe(after.ordered);
    expect(after.pairsCopy).toBe(after.pairs);
    expect(yamlDocumentValue(document)).toEqual(after);

    document.delete('item');
    expect(() => yamlDocumentValue(document)).toThrow(YamlError);
  });

  test('wraps value-conversion failures consistently for source and parsed documents', () => {
    for (const source of [
      'copy: *missing',
      '!!omap [a: one, a: two]',
      '!!pairs [{ a: one, b: two }]',
      '1: first\n"1": second',
      '[a, b]: c',
    ]) {
      expect(() => loadYaml(source)).toThrow(YamlError);
      const document = parseYamlDocument(source);
      expect(() => yamlDocumentValue(document)).toThrow(YamlError);
      expect(() => serializeWorkspaceConfig({}, source)).toThrow(YamlError);
    }
  });

  test('preserves core strings, dates, merges, aliases and tagged collection shapes', () => {
    const source = `defaults: &defaults { enabled: true }
copy: *defaults
merged: { <<: *defaults, other: on }
ordered: !!omap [first: one, second: two]
pairs: !!pairs [same: one, same: two, 123: number]
set: !!set { one: null, two: null }
binary: !!binary SGVsbG8=
date: 2024-01-01
strings: [on, off, yes, no]
`;
    const value = loadYaml(source) as Record<string, unknown>;
    expect(value).toEqual({
      defaults: { enabled: true }, copy: { enabled: true },
      merged: { enabled: true, other: 'on' },
      ordered: [{ first: 'one' }, { second: 'two' }],
      pairs: [['same', 'one'], ['same', 'two'], ['123', 'number']],
      set: new Set(['one', 'two']), binary: new Uint8Array([72, 101, 108, 108, 111]),
      date: new Date('2024-01-01T00:00:00Z'), strings: ['on', 'off', 'yes', 'no'],
    });
    expect(value.copy).toBe(value.defaults);
    expect(value.binary?.constructor).toBe(Uint8Array);
    expect(loadYaml(stringifyYaml(value))).toEqual(value);
    const edited = { ...value, clients: ['codex'] };
    expect(loadYaml(serializeWorkspaceConfig(edited, source))).toEqual(edited);
  });

  test('resolves aliases inside ordered maps and pairs', () => {
    expect(loadYaml('item: &item { a: one }\nordered: !!omap [*item]\npairs: !!pairs [*item]\n')).toEqual({
      item: { a: 'one' }, ordered: [{ a: 'one' }], pairs: [['a', 'one']],
    });
  });

  test('serializes only the selected bytes of a binary view', () => {
    const bytes = new Uint8Array([0, 72, 105, 0]).subarray(1, 3);
    expect(loadYaml(stringifyYaml({ bytes }))).toEqual({ bytes: new Uint8Array([72, 105]) });
  });

  test('distinguishes an empty stream from an explicit null document', () => {
    for (const source of ['', ' \n', '# Comment only\n']) expect(() => loadYaml(source)).toThrow();
    for (const source of ['---', '---\n# Comment\n', 'null', '~']) expect(loadYaml(source)).toBeNull();
  });

  test('rejects invalid documents and unsupported tags without logging warnings', () => {
    const originalWarn = console.warn;
    const warnings: unknown[] = [];
    console.warn = (...args) => { warnings.push(args); };
    try {
      for (const source of [
        'value: !unknown text', 'value: !!js/function function() {}',
        'key: first\nkey: second', 'value: [', '---\na: 1\n---\nb: 2',
        '!!omap [a: one, a: two]', '!!omap [a]', '!!pairs [a]',
        '!!pairs [{ a: one, b: two }]', '!!set { a: one }', '!!binary invalid',
      ]) expect(() => loadYaml(source)).toThrow();
      expect(warnings).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
  });
});

test('preserves null mapping keys and scalar anchor values without conversion warnings', () => {
  expect(loadYaml('&key null: &value value\ncopy: *key\npairs: !!pairs [null: yes]\nordered: !!omap [~: no]\nset: !!set { null: null }\n')).toEqual({
    null: 'value', copy: null, pairs: [['null', 'yes']], ordered: [{ null: 'no' }], set: new Set([null]),
  });
  const emitWarning = process.emitWarning;
  const warnings: unknown[] = [];
  process.emitWarning = (...args: unknown[]) => { warnings.push(args); };
  try {
    for (const source of ['[a, b]: c', '2024-01-01: a', '!!pairs [[a, b]: c]', '!!omap [[a, b]: c]', 'null: a\n"null": b', '1: a\n"1": b']) {
      expect(() => loadYaml(source)).toThrow();
    }
    expect(warnings).toEqual([]);
  } finally {
    process.emitWarning = emitWarning;
  }
});
