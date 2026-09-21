import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import { load } from 'js-yaml';
import { generateWorkspaceSchemas } from '../../../scripts/generate-workspace-schemas.js';
import {
  ProjectWorkspaceConfigSchema,
  UserWorkspaceConfigSchema,
} from '../../../src/models/workspace-config.js';

function parsedYaml(source: string): unknown {
  return load(source);
}
describe('published workspace JSON Schemas', () => {
  test('validates real user and project workspace YAML by scope', async () => {
    const schemaEntries = generateWorkspaceSchemas();
    const generated = new Map(
      await Promise.all(
        schemaEntries.map(async (schema) => [
          schema.fileName,
          JSON.parse(await readFile(schema.path, 'utf8')),
        ] as const),
      ),
    );
    for (const schema of schemaEntries) {
      expect(generated.get(schema.fileName).$id).toBe(schema.url);
    }
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validateUser = ajv.compile(
      generated.get('user-workspace.schema.json'),
    );
    const validateProject = ajv.compile(
      generated.get('project-workspace.schema.json'),
    );

    const userWorkspace = parsedYaml(`
profiles:
  review:
    clients:
      - name: claude-code
        launcher: claude-review
        settings:
          model: sonnet
          effortLevel: xhigh
      - name: codex
        install: native
        settings:
          approval_policy: on-request
    plugins:
      - source: owner/review-tools
        ref: stable
        skills:
          exclude: [legacy]
    mcpServers:
      review:
        command: review-mcp
        env:
          REVIEW_TOKEN: \${REVIEW_TOKEN}
`);
    const userWithNativeClients = parsedYaml(`
clients:
  - codex:native
  - name: github-copilot
    install: native
`);
    const projectWorkspace = parsedYaml(`
repositories: []
plugins:
  - source: owner/project-tools
    ref: main
clients:
  - name: claude
    install: native
`);
    const projectWithNativeAlias = parsedYaml(`
repositories: []
plugins: []
clients:
  - claude-code:native
`);
    const projectWithProfiles = parsedYaml(`
repositories: []
plugins: []
clients: []
profiles:
  review:
    clients:
      - name: claude
`);
    const userWithUnknownSettings = parsedYaml(`
profiles:
  review:
    clients:
      - name: claude
        settings:
          unknownSetting: true
`);
    const userWithInvalidClientShorthand = parsedYaml(`
clients:
  - claude:bogus
`);
    const projectWithUnsupportedNativeClient = parsedYaml(`
repositories: []
plugins: []
clients:
  - cursor:native
`);
    const projectWithUserOnlyNativeClient = parsedYaml(`
repositories: []
plugins: []
clients:
  - codex:native
`);
    const userWithUnsupportedNativeClient = parsedYaml(`
clients:
  - name: cursor
    install: native
`);
    const userWithInvalidProfileName = parsedYaml(`
profiles:
  ../escape:
    clients:
      - name: claude
`);
    const projectWithAliasesAndProjectOnlyClient = parsedYaml(`
repositories: []
plugins: []
clients:
  - claude-code
  - eve
`);
    const userWithAliases = parsedYaml(`
clients:
  - claude-code
  - warp
`);
    const userWithProjectOnlyClient = parsedYaml(`
clients:
  - eve
`);
    const userWithProjectOnlyNestedSelectors = parsedYaml(`
plugins:
  - source: owner/plugin
    clients: [eve]
mcpServers:
  example:
    command: example-mcp
    clients: [eve]
`);

    expect(validateUser(userWorkspace)).toBe(true);
    expect(UserWorkspaceConfigSchema.safeParse(userWorkspace).success).toBe(
      true,
    );
    expect(validateUser(userWithNativeClients)).toBe(true);
    expect(
      UserWorkspaceConfigSchema.safeParse(userWithNativeClients).success,
    ).toBe(true);
    expect(validateProject(projectWorkspace)).toBe(true);
    expect(
      ProjectWorkspaceConfigSchema.safeParse(projectWorkspace).success,
    ).toBe(true);
    expect(validateProject(projectWithNativeAlias)).toBe(true);
    expect(
      ProjectWorkspaceConfigSchema.safeParse(projectWithNativeAlias).success,
    ).toBe(true);
    expect(validateProject(projectWithProfiles)).toBe(false);
    expect(
      ProjectWorkspaceConfigSchema.safeParse(projectWithProfiles).success,
    ).toBe(false);
    expect(validateUser(userWithUnknownSettings)).toBe(false);
    expect(
      UserWorkspaceConfigSchema.safeParse(userWithUnknownSettings).success,
    ).toBe(false);
    expect(validateUser(userWithInvalidClientShorthand)).toBe(false);
    expect(
      UserWorkspaceConfigSchema.safeParse(userWithInvalidClientShorthand)
        .success,
    ).toBe(false);
    for (const invalid of [
      projectWithUnsupportedNativeClient,
      projectWithUserOnlyNativeClient,
    ]) {
      expect(validateProject(invalid)).toBe(false);
      expect(ProjectWorkspaceConfigSchema.safeParse(invalid).success).toBe(
        false,
      );
    }
    expect(validateUser(userWithUnsupportedNativeClient)).toBe(false);
    expect(
      UserWorkspaceConfigSchema.safeParse(userWithUnsupportedNativeClient)
        .success,
    ).toBe(false);
    expect(validateUser(userWithInvalidProfileName)).toBe(false);
    expect(
      UserWorkspaceConfigSchema.safeParse(userWithInvalidProfileName).success,
    ).toBe(false);
    expect(validateProject(projectWithAliasesAndProjectOnlyClient)).toBe(true);
    expect(
      ProjectWorkspaceConfigSchema.safeParse(
        projectWithAliasesAndProjectOnlyClient,
      ).success,
    ).toBe(true);
    expect(validateUser(userWithAliases)).toBe(true);
    expect(UserWorkspaceConfigSchema.safeParse(userWithAliases).success).toBe(
      true,
    );
    expect(validateUser(userWithProjectOnlyClient)).toBe(false);
    expect(
      UserWorkspaceConfigSchema.safeParse(userWithProjectOnlyClient).success,
    ).toBe(false);
    expect(validateUser(userWithProjectOnlyNestedSelectors)).toBe(false);
    expect(
      UserWorkspaceConfigSchema.safeParse(userWithProjectOnlyNestedSelectors)
        .success,
    ).toBe(false);
  });
});
