import { spawnSync } from 'node:child_process';
import type { AgentCommandMeta } from './help.js';

const JQ_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

let jsonMode = false;
let jsonFields: string[] | null = null;
let jqExpr: string | null = null;

export function isJsonMode(): boolean {
  return jsonMode;
}

export function setJsonMode(
  value: boolean,
  options?: { fields?: string[]; jqExpr?: string },
): void {
  jsonMode = value;
  jsonFields = options?.fields ?? null;
  jqExpr = options?.jqExpr ?? null;
}

export function getJsonFields(): readonly string[] | null {
  return jsonFields;
}

export interface JsonEnvelope {
  success: boolean;
  command: string;
  data?: unknown;
  error?: string;
}

/**
 * Apply the active `--json=<fields>` filter to an envelope. When `data` has a
 * single top-level array of objects (e.g. `{ skills: [...] }`), the filter
 * narrows each item to the requested fields. Otherwise the filter is applied
 * to the top-level `data` object directly.
 */
function applyFieldFilter(
  envelope: JsonEnvelope,
  fields: string[],
): JsonEnvelope {
  if (!envelope.data || typeof envelope.data !== 'object') return envelope;
  const data = envelope.data as Record<string, unknown>;
  const keys = Object.keys(data);

  // Single top-level array of objects → filter each item.
  const arrayKey = keys.find(
    (k) =>
      Array.isArray(data[k]) &&
      (data[k] as unknown[]).every(
        (it) => it !== null && typeof it === 'object' && !Array.isArray(it),
      ),
  );
  if (arrayKey && keys.length >= 1) {
    const items = data[arrayKey] as Array<Record<string, unknown>>;
    const filteredItems = items.map((item) => projectFields(item, fields));
    return { ...envelope, data: { ...data, [arrayKey]: filteredItems } };
  }

  // Otherwise project the top-level data object.
  return { ...envelope, data: projectFields(data, fields) };
}

function projectFields(
  obj: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f in obj) out[f] = obj[f];
  }
  return out;
}

/**
 * Run a JSON value through the system `jq` binary. Returns the stdout string.
 * On any failure, exits with a clear error rather than dumping a raw stderr.
 */
function runJq(value: unknown, expr: string): string {
  const input = JSON.stringify(value);
  const result = spawnSync('jq', [expr], {
    input,
    encoding: 'utf-8',
    // Parsed MCP output may reach 16 MiB; leave bounded room for jq's
    // whitespace formatting and the surrounding CLI envelope.
    maxBuffer: JQ_MAX_BUFFER_BYTES,
  });
  if (result.error || result.status !== 0) {
    const msg =
      result.stderr?.trim() || result.error?.message || 'jq invocation failed';
    process.stderr.write(`Error: --jq failed: ${msg}\n`);
    process.exit(1);
  }
  return result.stdout.trimEnd();
}

/**
 * Format a bare JSON value through the active serializer.
 */
export function formatJsonValue(value: unknown): string {
  return jqExpr ? runJq(value, jqExpr) : JSON.stringify(value, null, 2);
}

export function jsonValueOutput(value: unknown): void {
  console.log(formatJsonValue(value));
}

export function jsonOutput(envelope: JsonEnvelope): void {
  const final =
    jsonFields && jsonFields.length > 0
      ? applyFieldFilter(envelope, jsonFields)
      : envelope;
  jsonValueOutput(final);
}

/**
 * Parse `--json` and `--json=<fields>` out of the argv.
 *
 * Returns:
 *   `json`        — boolean, true if the flag was present in either form.
 *   `jsonFields`  — comma-split field list when `--json=<fields>` was supplied.
 */
export function extractJsonFlag(args: string[]): {
  args: string[];
  json: boolean;
  jsonFields?: string[];
} {
  const out: string[] = [];
  let json = false;
  let fields: string[] | undefined;

  for (const a of args) {
    if (a === '--json') {
      json = true;
      continue;
    }
    if (a.startsWith('--json=')) {
      json = true;
      const value = a.slice('--json='.length);
      if (value.length > 0) {
        fields = value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }
      continue;
    }
    out.push(a);
  }

  return fields ? { args: out, json, jsonFields: fields } : { args: out, json };
}

/**
 * Parse `--jq <expr>` out of the argv. The expression is the following arg.
 *
 * `--jq` without `--json` is rejected by the caller; this function only does
 * lexical extraction so the args list passed to cmd-ts no longer contains it.
 */
export function extractJqFlag(args: string[]): {
  args: string[];
  jqExpr?: string;
} {
  const idx = args.indexOf('--jq');
  if (idx === -1) return { args };
  const expr = args[idx + 1];
  if (expr === undefined) {
    process.stderr.write('Error: --jq requires an expression argument.\n');
    process.exit(2);
  }
  const next = [...args.slice(0, idx), ...args.slice(idx + 2)];
  return { args: next, jqExpr: expr };
}

export function jsonFieldAllowlist(
  meta: AgentCommandMeta | undefined,
): readonly string[] {
  if (meta?.jsonFields && meta.jsonFields.length > 0) {
    return meta.jsonFields;
  }
  return Object.keys(meta?.outputSchema ?? {});
}

/**
 * Validate requested `--json=<fields>` against a meta's allowlist. Exits with
 * a sorted "Available fields" message on any unknown field.
 *
 * Returns the validated fields (echoed back) or null when nothing to do.
 */
export function validateJsonFields(
  fields: readonly string[] | undefined,
  meta: AgentCommandMeta | undefined,
): readonly string[] | undefined {
  if (!fields || fields.length === 0) return undefined;
  const allow = jsonFieldAllowlist(meta);
  if (allow.length === 0) {
    return fields;
  }
  const unknown = fields.find((f) => !allow.includes(f));
  if (unknown) {
    const sorted = [...allow].sort();
    process.stderr.write(`Error: Unknown JSON field: "${unknown}"\n`);
    process.stderr.write('Available fields:\n');
    for (const f of sorted) process.stderr.write(`  ${f}\n`);
    process.exit(2);
  }
  return fields;
}
