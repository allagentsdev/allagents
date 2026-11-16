import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type {
  PluginComponentPolicy,
  PluginComponents,
} from '../models/plugin-components.js';
import { readYamlFrontmatter } from '../utils/frontmatter.js';
import {
  assertPluginComponentPath,
  assertPluginComponentTree,
} from './plugin-components.js';
import { resolvePortableMcp } from './portable-mcp.js';
import { excluded, exists, isRecord } from './plugin-component-utils.js';

export const PORTABLE_PLUGIN_SCHEMA =
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';

function validateManifest(value: unknown, warnings: string[]): string {
  if (!isRecord(value))
    throw new Error('Portable plugin.json must be an object');
  if (value.$schema !== PORTABLE_PLUGIN_SCHEMA)
    throw new Error(
      'Portable plugin.json requires the supported Agent Plugins 1.0.0 $schema',
    );
  if (
    typeof value.name !== 'string' ||
    value.name.length > 64 ||
    !/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value.name)
  ) {
    throw new Error('Portable plugin.json name is invalid');
  }
  const strings = [
    'version',
    'description',
    'homepage',
    'repository',
    'license',
  ];
  for (const key of strings) {
    if (Object.hasOwn(value, key) && typeof value[key] !== 'string')
      throw new Error(`Portable plugin.json ${key} must be a string`);
  }
  if (Object.hasOwn(value, 'author')) {
    if (
      !isRecord(value.author) ||
      Object.entries(value.author).some(
        ([key, entry]) =>
          !['name', 'email', 'url'].includes(key) || typeof entry !== 'string',
      )
    ) {
      throw new Error(
        'Portable plugin.json author must contain only name, email and url strings',
      );
    }
  }
  if (
    Object.hasOwn(value, 'keywords') &&
    (!Array.isArray(value.keywords) ||
      value.keywords.some((entry) => typeof entry !== 'string'))
  ) {
    throw new Error(
      'Portable plugin.json keywords must be an array of strings',
    );
  }
  const known = [
    '$schema',
    'name',
    ...strings,
    'author',
    'keywords',
    'extensions',
  ];
  for (const key of Object.keys(value)) {
    if (!known.includes(key))
      warnings.push(
        `Portable plugin.json field '${key}' is unknown and ignored`,
      );
  }
  if (
    Object.hasOwn(value, 'extensions') &&
    !isRecord(value.extensions)
  ) {
    warnings.push(
      'Portable plugin.json extensions is not an object and is ignored',
    );
  }
  return value.name;
}

function validateSkill(path: string, name: string): void {
  const text = readFileSync(path, 'utf8');
  // The shared frontmatter reader deliberately tolerates absent closing markers;
  // portable skill documents require a complete YAML frontmatter block.
  if (
    !/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:[ \t]*(?:#.*)?)?(?:\r?\n|$)/.test(text)
  ) {
    throw new Error(
      'SKILL.md must contain YAML frontmatter with a closing delimiter',
    );
  }
  const metadata = readYamlFrontmatter(text);
  if (
    metadata.name !== name ||
    name.length > 64 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
  ) {
    throw new Error(
      'Skill name must match its directory and the Agent Skills name rules',
    );
  }
  if (
    typeof metadata.description !== 'string' ||
    !metadata.description.trim() ||
    metadata.description.length > 1024
  ) {
    throw new Error(
      'Skill description must be a nonempty string of at most 1024 characters',
    );
  }
  if (
    Object.hasOwn(metadata, 'compatibility') &&
    (typeof metadata.compatibility !== 'string' ||
      metadata.compatibility.length < 1 ||
      metadata.compatibility.length > 500)
  ) {
    throw new Error(
      'Skill compatibility must be a string of 1 to 500 characters',
    );
  }
  if (
    Object.hasOwn(metadata, 'metadata') &&
    (!isRecord(metadata.metadata) ||
      Object.values(metadata.metadata).some(
        (entry) => typeof entry !== 'string',
      ))
  ) {
    throw new Error('Skill metadata must map strings to strings');
  }
  for (const key of ['license', 'allowed-tools']) {
    if (Object.hasOwn(metadata, key) && typeof metadata[key] !== 'string')
      throw new Error(`Skill ${key} must be a string`);
  }
}

function discoverSkills(
  root: string,
  policy: PluginComponentPolicy,
  warnings: string[],
): string[] {
  const directory = join(root, 'skills');
  if (excluded(root, directory, policy.exclude)) return [];
  try {
    assertPluginComponentPath(root, directory, policy.exclude);
    if (!exists(directory)) return [];
    if (!statSync(directory).isDirectory())
      throw new Error('skills must be a directory');
    const skills: string[] = [];
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      if (excluded(root, path, policy.exclude)) continue;
      try {
        assertPluginComponentPath(root, path, policy.exclude);
        if (!statSync(path).isDirectory()) continue;
        const document = join(path, 'SKILL.md');
        if (
          excluded(root, document, policy.exclude) ||
          !exists(document)
        )
          continue;
        assertPluginComponentPath(root, document, policy.exclude);
        if (!statSync(document).isFile())
          throw new Error('SKILL.md must be a regular file');
        validateSkill(document, name);
        assertPluginComponentTree(root, path, policy.exclude);
        skills.push(path);
      } catch (error) {
        warnings.push(
          `Portable skill '${name}' was skipped: ${error instanceof Error ? error.message : 'invalid skill'}`,
        );
      }
    }
    return skills;
  } catch (error) {
    warnings.push(
      `Portable skills were disabled: ${error instanceof Error ? error.message : 'invalid skills directory'}`,
    );
    return [];
  }
}

/** Read only canonical portable files; native manifests and overlays never supplement them. */
export function resolvePortablePlugin(
  pluginPath: string,
  policy: PluginComponentPolicy = {},
): PluginComponents {
  const root = resolve(pluginPath);
  if (!statSync(root).isDirectory())
    throw new Error('Portable plugin source must be a directory');
  const path = join(root, 'plugin.json');
  assertPluginComponentPath(root, path);
  if (!statSync(path).isFile())
    throw new Error('Portable plugin.json must be a regular file');
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('Portable plugin.json is not valid JSON');
  }
  const warnings: string[] = [];
  const name = validateManifest(value, warnings);
  const skills = discoverSkills(root, policy, warnings);
  const mcp = resolvePortableMcp(root, name, policy, warnings);
  return {
    format: 'portable',
    skills,
    commands: [],
    agents: [],
    hooks: [],
    ...mcp,
    github: false,
    legacyRepository: false,
    ...(warnings.length > 0 && { warnings }),
  };
}
