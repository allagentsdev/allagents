import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  ProjectWorkspaceConfigSchema,
  UserWorkspaceConfigSchema,
} from '../src/models/workspace-config.js';

const SCHEMA_VERSION = 'v1';
const SCHEMA_ROOT = resolve(
  import.meta.dir,
  '..',
  'docs',
  'public',
  'schemas',
  SCHEMA_VERSION,
);
const PUBLIC_ROOT = `https://allagents.dev/schemas/${SCHEMA_VERSION}`;
const JSON_SCHEMA_DIALECT = 'http://json-schema.org/draft-07/schema#';

type JsonSchemaNode = {
  default?: unknown;
  properties?: Record<string, JsonSchemaNode>;
};

/**
 * Zod 4 aliases a `z.X().default(v)` node to its inner schema, so the emitted
 * property loses the `default` annotation whenever that inner schema contains a
 * transform — which is every client-backed collection here. `default` is only
 * an annotation, but the published documents have always carried it, so restore
 * it from the zod shape at the enclosing object.
 */
function restoreDefaultAnnotations(ctx: {
  zodSchema?: { _zod?: { def?: { type?: string; shape?: Record<string, unknown> } } };
  jsonSchema?: JsonSchemaNode;
}): void {
  const shape = ctx.zodSchema?._zod?.def?.shape;
  if (!shape || !ctx.jsonSchema?.properties) return;
  for (const [key, child] of Object.entries(shape)) {
    const childDef = (
      child as { _zod?: { def?: { type?: string; defaultValue?: unknown } } } | undefined
    )?._zod?.def;
    const property = ctx.jsonSchema.properties[key];
    if (
      childDef?.type === 'default' &&
      childDef.defaultValue !== undefined &&
      property &&
      property.default === undefined
    ) {
      property.default = childDef.defaultValue;
    }
  }
}

const WORKSPACE_SCHEMAS = [
  {
    fileName: 'project-workspace.schema.json',
    definitionName: 'AllAgentsProjectWorkspace',
    title: 'AllAgents project workspace',
    description:
      'Configuration for a project .allagents/workspace.yaml. Global profiles are not accepted.',
    schema: ProjectWorkspaceConfigSchema,
  },
  {
    fileName: 'user-workspace.schema.json',
    definitionName: 'AllAgentsUserWorkspace',
    title: 'AllAgents user workspace',
    description:
      'Configuration for ~/.allagents/workspace.yaml, including global profiles.',
    schema: UserWorkspaceConfigSchema,
  },
] as const;

export interface GeneratedWorkspaceSchema {
  readonly fileName: string;
  readonly path: string;
  readonly url: string;
  readonly content: string;
}

export function generateWorkspaceSchemas(): readonly GeneratedWorkspaceSchema[] {
  return WORKSPACE_SCHEMAS.map((entry) => {
    const generated = z.toJSONSchema(entry.schema, {
      target: 'draft-7',
      io: 'input',
      unrepresentable: 'any',
      override: (context) => {
        restoreDefaultAnnotations(context);
        return undefined;
      },
    }) as Record<string, unknown>;
    const { $schema: _dialect, ...definition } = generated;
    const document = {
      $schema: JSON_SCHEMA_DIALECT,
      $id: `${PUBLIC_ROOT}/${entry.fileName}`,
      title: entry.title,
      description: entry.description,
      $ref: `#/definitions/${entry.definitionName}`,
      definitions: { [entry.definitionName]: definition },
    };
    return {
      fileName: entry.fileName,
      path: resolve(SCHEMA_ROOT, entry.fileName),
      url: document.$id,
      content: `${JSON.stringify(document, null, 2)}\n`,
    };
  });
}

async function writeSchemas(check: boolean): Promise<void> {
  const schemas = generateWorkspaceSchemas();
  if (check) {
    const drifted: string[] = [];
    for (const schema of schemas) {
      const current = await readFile(schema.path, 'utf8').catch(() => null);
      if (current !== schema.content) drifted.push(schema.path);
    }
    if (drifted.length > 0) {
      throw new Error(
        `Generated workspace schemas are stale:\n${drifted.map((path) => `- ${path}`).join('\n')}\nRun bun run schema:generate.`,
      );
    }
    return;
  }

  await mkdir(SCHEMA_ROOT, { recursive: true });
  await Promise.all(
    schemas.map((schema) => writeFile(schema.path, schema.content, 'utf8')),
  );
}

if (import.meta.main) {
  await writeSchemas(process.argv.includes('--check'));
}
