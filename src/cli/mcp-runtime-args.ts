type McpPrimitive = string | number | boolean;

export type McpToolOptionKind =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'enum'
  | 'array';

type McpPrimitiveKind = Exclude<McpToolOptionKind, 'enum' | 'array'>;

export interface McpToolInputOption {
  name: string;
  propertyName: string;
  kind: McpToolOptionKind;
  valueKind: McpPrimitiveKind;
  required: boolean;
  description?: string;
  enumValues?: readonly McpPrimitive[];
}

export type McpToolInputClassification =
  | {
      mode: 'generated';
      options: readonly McpToolInputOption[];
    }
  | {
      mode: 'input-only';
      reason: string;
    };

const PORTABLE_OPTION_NAME = /^[a-z][a-z0-9-]*$/;
const STRICT_INTEGER = /^-?(?:0|[1-9]\d*)$/;
const STRICT_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const RESERVED_OPTION_NAMES: Record<string, true> = {
  h: true,
  help: true,
  input: true,
  json: true,
  jq: true,
  profile: true,
  project: true,
  scope: true,
  search: true,
  server: true,
  tool: true,
  user: true,
};
const PROTOTYPE_SENSITIVE_NAMES: Record<string, true> = {
  ['__proto__']: true,
  constructor: true as true,
  prototype: true,
};
const UNSUPPORTED_SCHEMA_KEYWORDS = [
  '$ref',
  'allOf',
  'anyOf',
  'dependentSchemas',
  'else',
  'if',
  'not',
  'oneOf',
  'patternProperties',
  'then',
  'unevaluatedProperties',
] as const;

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

function inputOnly(reason: string): McpToolInputClassification {
  return { mode: 'input-only', reason };
}

function unsupportedKeyword(
  schema: Record<string, unknown>,
): string | undefined {
  return UNSUPPORTED_SCHEMA_KEYWORDS.find((keyword) => hasOwn(schema, keyword));
}

function primitiveKind(value: unknown): McpPrimitiveKind | undefined {
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isSafeInteger(value) ? 'integer' : 'number';
  }
  return undefined;
}

function declaredPrimitiveKind(value: unknown): McpPrimitiveKind | undefined {
  if (value === 'string' || value === 'number' || value === 'integer' || value === 'boolean') {
    return value;
  }
  return undefined;
}

function classifyProperty(
  name: string,
  schema: unknown,
  required: boolean,
): McpToolInputOption | string {
  if (!isSchemaObject(schema)) return `Property '${name}' is not an object schema`;
  const keyword = unsupportedKeyword(schema);
  if (keyword) return `Property '${name}' uses unsupported ${keyword}`;
  if (hasOwn(schema, 'default')) return `Property '${name}' uses an unsupported default`;
  if (schema.description !== undefined && typeof schema.description !== 'string') {
    return `Property '${name}' has a non-string description`;
  }

  const description = schema.description;
  if (schema.type === 'array') {
    if (!isSchemaObject(schema.items)) return `Property '${name}' is not a homogeneous primitive array`;
    const itemKeyword = unsupportedKeyword(schema.items);
    if (itemKeyword) return `Property '${name}' array items use unsupported ${itemKeyword}`;
    const itemKind = declaredPrimitiveKind(schema.items.type);
    if (!itemKind) return `Property '${name}' is not a homogeneous primitive array`;
    if (hasOwn(schema.items, 'enum')) {
      const values = schema.items.enum;
      if (!Array.isArray(values) || values.length === 0) {
        return `Property '${name}' has an invalid item enum`;
      }
      for (const value of values) {
        if (primitiveKind(value) !== itemKind && !(itemKind === 'number' && primitiveKind(value) === 'integer')) {
          return `Property '${name}' has a heterogeneous item enum`;
        }
      }
      return {
        name,
        propertyName: name,
        kind: 'array',
        valueKind: itemKind,
        required,
        ...(description === undefined ? {} : { description }),
        enumValues: values as McpPrimitive[],
      };
    }
    return {
      name,
      propertyName: name,
      kind: 'array',
      valueKind: itemKind,
      required,
      ...(description === undefined ? {} : { description }),
    };
  }

  const kind = declaredPrimitiveKind(schema.type);
  if (!kind) return `Property '${name}' has an unsupported type`;
  if (hasOwn(schema, 'enum')) {
    const values = schema.enum;
    if (!Array.isArray(values) || values.length === 0) {
      return `Property '${name}' has an invalid enum`;
    }
    for (const value of values) {
      if (primitiveKind(value) !== kind && !(kind === 'number' && primitiveKind(value) === 'integer')) {
        return `Property '${name}' has a heterogeneous enum`;
      }
    }
    return {
      name,
      propertyName: name,
      kind: 'enum',
      valueKind: kind,
      required,
      ...(description === undefined ? {} : { description }),
      enumValues: values as McpPrimitive[],
    };
  }

  return {
    name,
    propertyName: name,
    kind,
    valueKind: kind,
    required,
    ...(description === undefined ? {} : { description }),
  };
}

export function classifyMcpToolInputSchema(
  schema: unknown,
): McpToolInputClassification {
  if (!isSchemaObject(schema) || schema.type !== 'object') {
    return inputOnly('The input schema is not a top-level object');
  }
  const keyword = unsupportedKeyword(schema);
  if (keyword) return inputOnly(`The input schema uses unsupported ${keyword}`);
  if (schema.properties !== undefined && !isSchemaObject(schema.properties)) {
    return inputOnly('The input schema properties are not an object');
  }

  const properties = schema.properties ?? Object.create(null) as Record<string, unknown>;
  const requiredValue = schema.required ?? [];
  if (!Array.isArray(requiredValue) || requiredValue.some((name) => typeof name !== 'string')) {
    return inputOnly('The input schema required list is invalid');
  }
  const required = new Set(requiredValue as string[]);
  if (required.size !== requiredValue.length) {
    return inputOnly('The input schema required list contains duplicates');
  }
  for (const name of required) {
    if (!hasOwn(properties, name)) {
      return inputOnly(`Required property '${name}' is not declared`);
    }
  }

  const propertyNames = Object.keys(properties);
  for (const name of propertyNames) {
    if (!PORTABLE_OPTION_NAME.test(name)) {
      return inputOnly(`Property '${name}' is not a portable long option name`);
    }
    if (
      RESERVED_OPTION_NAMES[name] ||
      PROTOTYPE_SENSITIVE_NAMES[name]
    ) {
      return inputOnly(`Property '${name}' is reserved`);
    }
  }

  const options: McpToolInputOption[] = [];
  const booleanNegations = new Set<string>();
  for (const name of propertyNames) {
    const option = classifyProperty(name, properties[name], required.has(name));
    if (typeof option === 'string') return inputOnly(option);
    options.push(option);
    if (option.valueKind === 'boolean' && option.kind !== 'array') {
      booleanNegations.add(`no-${option.name}`);
    }
  }
  for (const name of propertyNames) {
    if (booleanNegations.has(name)) {
      return inputOnly(`Property '${name}' collides with a boolean no-* option`);
    }
  }

  return { mode: 'generated', options };
}

function parsePrimitive(kind: McpPrimitiveKind, raw: string, optionName: string): McpPrimitive {
  if (kind === 'string') return raw;
  if (kind === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new Error(`Invalid value for --${optionName}: expected true or false`);
  }
  if (kind === 'integer') {
    if (!STRICT_INTEGER.test(raw)) {
      throw new Error(`Invalid value for --${optionName}: expected an integer`);
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Invalid value for --${optionName}: integer is outside the safe range`);
    }
    return value;
  }
  if (!STRICT_NUMBER.test(raw)) {
    throw new Error(`Invalid value for --${optionName}: expected a number`);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid value for --${optionName}: expected a finite number`);
  }
  return value;
}

function parseOptionValue(option: McpToolInputOption, raw: string): McpPrimitive {
  const value = parsePrimitive(option.valueKind, raw, option.name);
  if (option.enumValues && !option.enumValues.some((candidate) => Object.is(candidate, value))) {
    throw new Error(`Invalid value for --${option.name}: expected one of ${option.enumValues.map(String).join(', ')}`);
  }
  return value;
}

function rejectUnsafeIntegerLiterals(input: string): void {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length;) {
    const character = input[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      index += 1;
      continue;
    }
    if (character === '"') {
      inString = true;
      index += 1;
      continue;
    }
    if (character === '-' || (character !== undefined && character >= '0' && character <= '9')) {
      const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(input.slice(index));
      if (match) {
        const literal = match[0];
        if (!literal.includes('.') && !/[eE]/.test(literal) && !Number.isSafeInteger(Number(literal))) {
          throw new Error('JSON input contains an integer outside the safe range');
        }
        index += literal.length;
        continue;
      }
    }
    index += 1;
  }
}

function parseJsonObject(input: string): Record<string, unknown> {
  rejectUnsafeIntegerLiterals(input);
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid --input JSON: ${detail}`);
  }
  if (!isSchemaObject(value)) throw new Error('--input must be a JSON object');
  return value;
}

export function parseMcpToolArguments(
  classification: McpToolInputClassification,
  argv: readonly string[],
): Record<string, unknown> {
  let input: string | undefined;
  const generated: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--input') {
      if (input !== undefined) throw new Error('--input may only be specified once');
      const value = argv[index + 1];
      if (value === undefined) throw new Error('Missing value for --input');
      input = value;
      index += 1;
      continue;
    }
    if (argument?.startsWith('--input=')) {
      if (input !== undefined) throw new Error('--input may only be specified once');
      input = argument.slice('--input='.length);
      continue;
    }
    if (argument !== undefined) generated.push(argument);
  }

  if (input !== undefined) {
    if (generated.length > 0) throw new Error('--input cannot be combined with generated tool options');
    return parseJsonObject(input);
  }
  if (classification.mode === 'input-only') {
    if (generated.length > 0) throw new Error(`Unknown tool option '${generated[0]}'`);
    throw new Error(`This tool requires --input: ${classification.reason}`);
  }

  const options = new Map(classification.options.map((option) => [option.name, option]));
  const values = new Map<string, McpPrimitive | McpPrimitive[]>();
  for (let index = 0; index < generated.length; index += 1) {
    const argument = generated[index];
    if (argument === undefined || !argument.startsWith('--') || argument === '--') {
      throw new Error(`Unknown tool option '${argument ?? ''}'`);
    }
    const equals = argument.indexOf('=');
    const name = argument.slice(2, equals === -1 ? undefined : equals);
    const option = options.get(name);
    if (!option) throw new Error(`Unknown tool option '--${name}'`);

    let raw: string;
    if (equals !== -1) {
      raw = argument.slice(equals + 1);
    } else {
      const detached = generated[index + 1];
      if (detached === undefined) throw new Error(`Missing value for --${name}`);
      if (detached.startsWith('-')) {
        throw new Error(`Flag-looking values for --${name} require --${name}=value syntax`);
      }
      raw = detached;
      index += 1;
    }

    const value = parseOptionValue(option, raw);
    if (option.kind === 'array') {
      const existing = values.get(option.propertyName);
      if (existing === undefined) values.set(option.propertyName, [value]);
      else if (Array.isArray(existing)) existing.push(value);
      else throw new Error(`Option --${name} has conflicting values`);
    } else {
      if (values.has(option.propertyName)) throw new Error(`Option --${name} may only be specified once`);
      values.set(option.propertyName, value);
    }
  }

  for (const option of classification.options) {
    if (option.required && !values.has(option.propertyName)) {
      throw new Error(`Missing required option --${option.name}`);
    }
  }
  return Object.fromEntries(values);
}
