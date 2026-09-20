import { describe, expect, test } from 'bun:test';
import {
  classifyMcpToolInputSchema,
  parseMcpToolArguments,
} from '../../../src/cli/mcp-runtime-args.js';

const primitiveSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'Text to send' },
    count: { type: 'integer' },
    ratio: { type: 'number' },
    enabled: { type: 'boolean' },
    color: { type: 'string', enum: ['red', 'blue'] },
    tag: { type: 'array', items: { type: 'string' } },
  },
  required: ['text', 'count', 'enabled'],
} as const;

describe('classifyMcpToolInputSchema', () => {
  test('projects a complete primitive object schema', () => {
    const result = classifyMcpToolInputSchema(primitiveSchema);

    expect(result.mode).toBe('generated');
    if (result.mode === 'generated') {
      expect(result.options.map(({ name, kind, required }) => ({
        name,
        kind,
        required,
      }))).toEqual([
        { name: 'text', kind: 'string', required: true },
        { name: 'count', kind: 'integer', required: true },
        { name: 'ratio', kind: 'number', required: false },
        { name: 'enabled', kind: 'boolean', required: true },
        { name: 'color', kind: 'enum', required: false },
        { name: 'tag', kind: 'array', required: false },
      ]);
    }
  });

  test.each([
    ['nested object', { type: 'object', properties: { nested: { type: 'object' } } }],
    ['reference', { type: 'object', properties: { value: { $ref: '#/$defs/value' } } }],
    ['nullable union', { type: 'object', properties: { value: { type: ['string', 'null'] } } }],
    ['tuple', { type: 'object', properties: { value: { type: 'array', items: [{ type: 'string' }] } } }],
    ['reserved name', { type: 'object', properties: { json: { type: 'string' } } }],
    ['prototype name', { type: 'object', properties: { constructor: { type: 'string' } } }],
  ])('falls back wholly for an unsafe %s', (_name, schema) => {
    const result = classifyMcpToolInputSchema(schema);
    expect(result.mode).toBe('input-only');
    if (result.mode === 'input-only') expect(result.reason.length).toBeGreaterThan(0);
  });

  test.each([
    ['combinator', { type: 'object', anyOf: [] }],
    ['default', { type: 'object', properties: { value: { type: 'string', default: 'x' } } }],
    ['heterogeneous enum', { type: 'object', properties: { value: { type: 'string', enum: ['x', 1] } } }],
    ['non-portable name', { type: 'object', properties: { odd_name: { type: 'string' } } }],
    ['destination name', { type: 'object', properties: { profile: { type: 'string' } } }],
    [
      'boolean negation collision',
      {
        type: 'object',
        properties: {
          enabled: { type: 'boolean' },
          'no-enabled': { type: 'string' },
        },
      },
    ],
  ])('falls back wholly for an ambiguous %s', (_name, schema) => {
    expect(classifyMcpToolInputSchema(schema).mode).toBe('input-only');
  });

  test('supports homogeneous primitive enums and arrays', () => {
    const result = classifyMcpToolInputSchema({
      type: 'object',
      properties: {
        level: { type: 'integer', enum: [1, 2] },
        ratios: { type: 'array', items: { type: 'number' } },
        switches: { type: 'array', items: { type: 'boolean' } },
        modes: {
          type: 'array',
          items: { type: 'string', enum: ['fast', 'safe'] },
        },
      },
    });

    expect(result.mode).toBe('generated');
    if (result.mode === 'generated') {
      expect(
        result.options.map(({ name, kind, valueKind, enumValues }) => ({
          name,
          kind,
          valueKind,
          enumValues,
        })),
      ).toEqual([
        {
          name: 'level',
          kind: 'enum',
          valueKind: 'integer',
          enumValues: [1, 2],
        },
        {
          name: 'ratios',
          kind: 'array',
          valueKind: 'number',
          enumValues: undefined,
        },
        {
          name: 'switches',
          kind: 'array',
          valueKind: 'boolean',
          enumValues: undefined,
        },
        {
          name: 'modes',
          kind: 'array',
          valueKind: 'string',
          enumValues: ['fast', 'safe'],
        },
      ]);
    }
  });
});

describe('parseMcpToolArguments', () => {
  const classification = classifyMcpToolInputSchema(primitiveSchema);

  test('coerces primitive flags and preserves repeated-array order', () => {
    expect(
      parseMcpToolArguments(classification, [
        '--text=hello',
        '--count=7',
        '--ratio=1.5',
        '--enabled=false',
        '--color=blue',
        '--tag=first',
        '--tag=second',
      ]),
    ).toEqual({
      text: 'hello',
      count: 7,
      ratio: 1.5,
      enabled: false,
      color: 'blue',
      tag: ['first', 'second'],
    });
  });

  test.each(['--json', '--json=field', '--jq', '--help', '-h', '--']) (
    'round-trips flag-looking attached string value %s',
    (value) => {
      expect(
        parseMcpToolArguments(classification, [
          `--text=${value}`,
          '--count=1',
          '--enabled=true',
        ]),
      ).toEqual({ text: value, count: 1, enabled: true });
    },
  );

  test('preserves exact JSON input without schema reconstruction', () => {
    const inputOnly = classifyMcpToolInputSchema({
      type: 'object',
      properties: { nested: { type: 'object' } },
    });
    expect(
      parseMcpToolArguments(inputOnly, [
        '--input',
        '{"nested":{"empty":"","unicode":"λ","nil":null},"odd-name":[1,true]}',
      ]),
    ).toEqual({
      nested: { empty: '', unicode: 'λ', nil: null },
      'odd-name': [1, true],
    });
  });

  test('rejects missing required values', () => {
    expect(() =>
      parseMcpToolArguments(classification, ['--text=hello', '--enabled=true']),
    ).toThrow('Missing required option --count');
  });

  test.each([
    ['partial integer', ['--text=x', '--count=1x', '--enabled=true']],
    ['unsafe integer', ['--text=x', '--count=9007199254740992', '--enabled=true']],
    ['non-finite number', ['--text=x', '--count=1', '--ratio=Infinity', '--enabled=true']],
    ['invalid boolean', ['--text=x', '--count=1', '--enabled=yes']],
    ['unknown flag', ['--text=x', '--count=1', '--enabled=true', '--other=x']],
    ['ambiguous detached flag value', ['--text', '--json', '--count=1', '--enabled=true']],
  ])('rejects %s before invocation', (_name, args) => {
    expect(() => parseMcpToolArguments(classification, args)).toThrow();
  });

  test('rejects JSON input mixed with generated flags', () => {
    expect(() =>
      parseMcpToolArguments(classification, [
        '--input',
        '{"text":"x","count":1,"enabled":true}',
        '--text=x',
      ]),
    ).toThrow('--input cannot be combined');
  });

  test.each(['[]', 'null', '1', '"text"', '{"value":9007199254740992}'])(
    'rejects unsafe JSON object input %s',
    (input) => {
      expect(() => parseMcpToolArguments(classification, ['--input', input])).toThrow();
    },
  );

  test.each([
    ['9007199254740993e0', 'integer outside the safe range'],
    ['9007199254740993.0', 'integer outside the safe range'],
    ['1e309', 'non-finite number'],
  ])('rejects unsafe JSON numeric token %s before parsing', (literal, error) => {
    expect(() =>
      parseMcpToolArguments(classification, ['--input', `{"value":${literal}}`]),
    ).toThrow(error);
  });

  test('leaves omitted optional values absent and accepts strict detached values', () => {
    expect(
      parseMcpToolArguments(classification, [
        '--text',
        'hello',
        '--count=-7',
        '--enabled',
        'false',
      ]),
    ).toEqual({
      text: 'hello',
      count: -7,
      enabled: false,
    });
  });

  test('coerces repeated primitive enum, number, and boolean arrays', () => {
    const arrays = classifyMcpToolInputSchema({
      type: 'object',
      properties: {
        levels: { type: 'array', items: { type: 'integer', enum: [1, 2] } },
        ratios: { type: 'array', items: { type: 'number' } },
        switches: { type: 'array', items: { type: 'boolean' } },
      },
    });
    expect(
      parseMcpToolArguments(arrays, [
        '--levels=2',
        '--levels=1',
        '--ratios=1.25',
        '--switches=false',
        '--switches=true',
      ]),
    ).toEqual({
      levels: [2, 1],
      ratios: [1.25],
      switches: [false, true],
    });
  });

  test('rejects duplicate scalar flags and invalid enum members', () => {
    expect(() =>
      parseMcpToolArguments(classification, [
        '--text=x',
        '--text=y',
        '--count=1',
        '--enabled=true',
      ]),
    ).toThrow('may only be specified once');
    expect(() =>
      parseMcpToolArguments(classification, [
        '--text=x',
        '--count=1',
        '--enabled=true',
        '--color=green',
      ]),
    ).toThrow('expected one of red, blue');
  });

  test('requires --input for unsupported schemas and preserves prototype-sensitive JSON keys safely', () => {
    const inputOnly = classifyMcpToolInputSchema({
      type: 'object',
      properties: { nested: { type: 'object' } },
    });
    expect(() => parseMcpToolArguments(inputOnly, [])).toThrow(
      'requires --input',
    );
    const result = parseMcpToolArguments(inputOnly, [
      '--input',
      '{\"__proto__\":{\"polluted\":true},\"constructor\":\"kept\"}',
    ]);
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(result.__proto__).toEqual({ polluted: true });
    expect(result.constructor).toBe('kept');
  });

  test('returns an empty object for an inputless schema', () => {
    const inputless = classifyMcpToolInputSchema({ type: 'object' });
    expect(parseMcpToolArguments(inputless, [])).toEqual({});
  });
});
