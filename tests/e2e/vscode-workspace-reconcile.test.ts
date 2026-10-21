import { describe, expect, test, beforeAll, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, chmodSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as load } from 'yaml';
import { syncWorkspace } from '../../src/core/sync.js';
import type { WorkspaceConfig } from '../../src/models/workspace-config.js';

beforeAll(() => {
  const build = Bun.spawnSync(['bun', 'run', 'build'], {
    cwd: resolve(import.meta.dir, '../..'),
    stdout: 'pipe', stderr: 'pipe',
  });
  if (build.exitCode !== 0) throw new Error(`CLI build failed: ${build.stderr.toString()}`);
});

describe('vscode workspace folder reconciliation e2e', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `allagents-e2e-reconcile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(join(testDir, '.allagents'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  test('removes repo from workspace.yaml when folder removed from .code-workspace', async () => {
    const repoBPath = '../repoB';

    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      `repositories:
  - path: ../repoA
  - path: ../repoB
plugins: []
clients:
  - vscode
`,
    );

    // First sync: generates .code-workspace and saves state
    await syncWorkspace(testDir);

    const workspaceFile = join(testDir, `${basename(testDir)}.code-workspace`);
    expect(existsSync(workspaceFile)).toBe(true);

    // Verify both repos are in .code-workspace
    const initialContent = JSON.parse(readFileSync(workspaceFile, 'utf-8'));
    expect(initialContent.folders).toHaveLength(3); // '.', repoA, repoB

    // Modify .code-workspace: remove repoB folder
    const modifiedContent = {
      ...initialContent,
      folders: initialContent.folders.filter(
        (f: { path: string }) => f.path !== repoBPath,
      ),
    };
    writeFileSync(workspaceFile, JSON.stringify(modifiedContent, null, '\t'));

    // Second sync: should reconcile and update workspace.yaml
    const result = await syncWorkspace(testDir);

    // Verify workspace.yaml was updated to remove repoB
    const updatedYaml = load(
      readFileSync(join(testDir, '.allagents', 'workspace.yaml'), 'utf-8'),
    ) as WorkspaceConfig;
    const repoPaths = updatedYaml.repositories.map((r) => r.path);
    expect(repoPaths).toContain('../repoA');
    expect(repoPaths).not.toContain('../repoB');

    // Verify sync result messages mention the removal
    expect(result.messages).toBeDefined();
    expect(result.messages!.some((m) => m.includes('removed') || m.includes('Removed'))).toBe(true);
  });

  test('adds repo to workspace.yaml when folder added to .code-workspace', async () => {
    const frontendPath = resolve(testDir, '../frontend').replace(/\\/g, '/');

    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      `repositories:
  - path: ../myrepo
plugins: []
clients:
  - vscode
`,
    );

    // First sync: generates .code-workspace and saves state
    await syncWorkspace(testDir);

    const workspaceFile = join(testDir, `${basename(testDir)}.code-workspace`);
    expect(existsSync(workspaceFile)).toBe(true);

    // Modify .code-workspace: add a new folder
    const initialContent = JSON.parse(readFileSync(workspaceFile, 'utf-8'));
    initialContent.folders.push({ path: frontendPath });
    writeFileSync(workspaceFile, JSON.stringify(initialContent, null, '\t'));

    // Second sync: should reconcile and add to workspace.yaml
    const result = await syncWorkspace(testDir);

    // Verify workspace.yaml now includes the new repo
    const updatedYaml = load(
      readFileSync(join(testDir, '.allagents', 'workspace.yaml'), 'utf-8'),
    ) as WorkspaceConfig;
    const repoPaths = updatedYaml.repositories.map((r) => r.path);
    expect(repoPaths).toContain('../myrepo');
    expect(repoPaths.some((p) => p.includes('frontend'))).toBe(true);

    // Verify sync result messages mention the addition
    expect(result.messages).toBeDefined();
    expect(result.messages!.some((m) => m.includes('added') || m.includes('Added'))).toBe(true);
  });

  test('skips reconciliation on first sync (no stored state)', async () => {
    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      `repositories:
  - path: ../myrepo
plugins: []
clients:
  - vscode
`,
    );

    // First sync: no prior state, should not reconcile
    const result = await syncWorkspace(testDir);

    // workspace.yaml should be unchanged
    const yaml = load(
      readFileSync(join(testDir, '.allagents', 'workspace.yaml'), 'utf-8'),
    ) as WorkspaceConfig;
    expect(yaml.repositories).toHaveLength(1);
    expect(yaml.repositories[0].path).toBe('../myrepo');

    // No reconciliation messages expected
    const reconcileMessages = (result.messages ?? []).filter(
      (m) => m.includes('removed') || m.includes('added') || m.includes('Removed') || m.includes('Added'),
    );
    expect(reconcileMessages).toHaveLength(0);
  });

  test('skips reconciliation when .code-workspace unchanged', async () => {
    writeFileSync(
      join(testDir, '.allagents', 'workspace.yaml'),
      `repositories:
  - path: ../myrepo
plugins: []
clients:
  - vscode
`,
    );

    // First sync
    await syncWorkspace(testDir);

    // Second sync without modifying .code-workspace
    const result = await syncWorkspace(testDir);

    // workspace.yaml should be unchanged
    const yaml = load(
      readFileSync(join(testDir, '.allagents', 'workspace.yaml'), 'utf-8'),
    ) as WorkspaceConfig;
    expect(yaml.repositories).toHaveLength(1);
    expect(yaml.repositories[0].path).toBe('../myrepo');

    // No reconciliation messages expected
    const reconcileMessages = (result.messages ?? []).filter(
      (m) => m.includes('removed') || m.includes('added') || m.includes('Removed') || m.includes('Added'),
    );
    expect(reconcileMessages).toHaveLength(0);
  });
  const configText = `# authored header
version: 2
repositories:
  - path: ../myrepo # keep repository note
    name: Original
plugins: []
clients: [vscode]
`;

  function paths() {
    return {
      yaml: join(testDir, '.allagents', 'workspace.yaml'),
      editor: join(testDir, `${basename(testDir)}.code-workspace`),
      state: join(testDir, '.allagents', 'sync-state.json'),
    };
  }

  async function initialize() {
    const files = paths();
    writeFileSync(files.yaml, configText);
    expect((await syncWorkspace(testDir)).success).toBe(true);
    return files;
  }

  test('settings-only edits preserve YAML-only names, new repository metadata and unchanged template folders', async () => {
    writeFileSync(join(testDir, '.allagents', 'template.code-workspace'), JSON.stringify({ folders: [{ path: '../template', name: 'Template' }] }));
    const files = await initialize();
    const changedYaml = configText.replace('name: Original', 'name: YAML name')
      .replace('plugins: []', '  - path: ../yaml-only\n    name: YAML addition\n    description: retained metadata\nplugins: []');
    writeFileSync(files.yaml, changedYaml);
    const editor = JSON.parse(readFileSync(files.editor, 'utf-8'));
    editor.settings['editor.fontSize'] = 14;
    writeFileSync(files.editor, JSON.stringify(editor));
    expect((await syncWorkspace(testDir)).success).toBe(true);
    expect(readFileSync(files.yaml, 'utf-8')).toBe(changedYaml);
    expect(JSON.parse(readFileSync(files.editor, 'utf-8')).folders).toContainEqual({ path: '../myrepo', name: 'YAML name' });
  });

  test('actual JSON5 editor renames win concurrent YAML names and keep other YAML syntax', async () => {
    const files = await initialize();
    writeFileSync(files.yaml, configText.replace('Original', 'YAML name'));
    writeFileSync(files.editor, `{ // VS Code comments\nfolders: [{path: '.',}, {path: '../myrepo', name: 'Editor name'},],}`);
    chmodSync(files.yaml, 0o640);
    expect((await syncWorkspace(testDir)).success).toBe(true);
    expect(readFileSync(files.yaml, 'utf-8')).toBe(configText.replace('Original', 'Editor name'));
    expect(statSync(files.yaml).mode & 0o777).toBe(0o640);
  });

  test('new editor folder retains its display name', async () => {
    const files = await initialize();
    const editor = JSON.parse(readFileSync(files.editor, 'utf-8'));
    editor.folders.push({ path: '../new', name: 'New display' });
    writeFileSync(files.editor, JSON.stringify(editor));
    expect((await syncWorkspace(testDir)).success).toBe(true);
    expect((load(readFileSync(files.yaml, 'utf-8')) as WorkspaceConfig).repositories).toContainEqual({ path: '../new', name: 'New display' });
  });

  test.each(['{', '{}', '{"folders":null}', '{"folders":[{"path":7}]}', '{"folders":[{"path":"../myrepo","name":7}]}'])(
    'invalid editor input %s preserves YAML, editor and sync state', async (content) => {
      const files = await initialize();
      const yamlBefore = readFileSync(files.yaml, 'utf-8');
      const stateBefore = readFileSync(files.state, 'utf-8');
      writeFileSync(files.editor, content);
      const result = await syncWorkspace(testDir);
      expect(result.success).toBe(false);
      expect(result.error).toContain('VS Code');
      expect(readFileSync(files.yaml, 'utf-8')).toBe(yamlBefore);
      expect(readFileSync(files.editor, 'utf-8')).toBe(content);
      expect(readFileSync(files.state, 'utf-8')).toBe(stateBefore);
    },
  );

  test('failed repository import rejects a YAML symlink without changing editor or baseline', async () => {
    const files = await initialize();
    const target = join(testDir, 'original.yaml');
    const yamlBefore = readFileSync(files.yaml, 'utf-8');
    writeFileSync(target, yamlBefore);
    rmSync(files.yaml);
    symlinkSync(target, files.yaml);
    const editor = JSON.parse(readFileSync(files.editor, 'utf-8'));
    editor.folders = [{ path: '.' }];
    const content = JSON.stringify(editor);
    writeFileSync(files.editor, content);
    const stateBefore = readFileSync(files.state, 'utf-8');
    const result = await syncWorkspace(testDir);
    expect(result.success).toBe(false);
    expect(result.error).toContain('symlink');
    expect(readFileSync(target, 'utf-8')).toBe(yamlBefore);
    expect(readFileSync(files.editor, 'utf-8')).toBe(content);
    expect(readFileSync(files.state, 'utf-8')).toBe(stateBefore);
  });

  test('a repository name edit retains unknown repository metadata and unrelated YAML sections', async () => {
    const files = await initialize();
    const original = readFileSync(files.yaml, 'utf-8').replace('    name: Original', '    name: Original\n    custom: { nested: [one, two] } # private data');
    writeFileSync(files.yaml, original);
    const editor = JSON.parse(readFileSync(files.editor, 'utf-8'));
    editor.folders[1].name = 'Editor name';
    writeFileSync(files.editor, JSON.stringify(editor));
    expect((await syncWorkspace(testDir)).success).toBe(true);
    expect(readFileSync(files.yaml, 'utf-8')).toBe(original.replace('name: Original', 'name: Editor name'));
  });

  test('an actual template-folder rename becomes a repository override', async () => {
    writeFileSync(join(testDir, '.allagents', 'template.code-workspace'), JSON.stringify({ folders: [{ path: '../template', name: 'Template' }] }));
    const files = await initialize();
    const editor = JSON.parse(readFileSync(files.editor, 'utf-8'));
    editor.folders[2].name = 'Editor override';
    writeFileSync(files.editor, JSON.stringify(editor));
    expect((await syncWorkspace(testDir)).success).toBe(true);
    expect((load(readFileSync(files.yaml, 'utf-8')) as WorkspaceConfig).repositories).toContainEqual({ path: '../template', name: 'Editor override' });
  });

  test('an empty folders array intentionally removes every repository', async () => {
    const files = await initialize();
    writeFileSync(files.editor, '{ folders: [] }');
    expect((await syncWorkspace(testDir)).success).toBe(true);
    expect((load(readFileSync(files.yaml, 'utf-8')) as WorkspaceConfig).repositories).toEqual([]);
  });

  test('dry run leaves malformed editor input and every tracked file untouched', async () => {
    const files = await initialize();
    writeFileSync(files.editor, '{}');
    const before = Object.values(files).map(file => readFileSync(file, 'utf-8'));
    expect((await syncWorkspace(testDir, { dryRun: true })).success).toBe(true);
    expect(Object.values(files).map(file => readFileSync(file, 'utf-8'))).toEqual(before);
  });

  test('workspaces without the vscode client do not import or rewrite editor files', async () => {
    const files = await initialize();
    const yaml = configText.replace('[vscode]', '[copilot]');
    writeFileSync(files.yaml, yaml);
    writeFileSync(files.editor, '{}');
    expect((await syncWorkspace(testDir)).success).toBe(true);
    expect(readFileSync(files.editor, 'utf-8')).toBe('{}');
    expect(readFileSync(files.yaml, 'utf-8')).toBe(yaml);
  });

  test('invalid template blocks a pending editor import before YAML or baseline publication', async () => {
    const files = await initialize();
    writeFileSync(files.editor, '{ folders: [] }');
    writeFileSync(join(testDir, '.allagents', 'template.code-workspace'), '{');
    const before = Object.values(files).map(file => readFileSync(file, 'utf-8'));
    expect((await syncWorkspace(testDir)).success).toBe(false);
    expect(Object.values(files).map(file => readFileSync(file, 'utf-8'))).toEqual(before);
  });

  test.each(['unchanged editor', 'reconstructable editor rename', 'legacy editor precedence'])(
    'upgrades old sync state: %s', async scenario => {
      const files = await initialize();
      const state = JSON.parse(readFileSync(files.state, 'utf-8'));
      delete state.vscodeWorkspaceFolders;
      writeFileSync(files.state, JSON.stringify(state));
      const editor = JSON.parse(readFileSync(files.editor, 'utf-8'));
      let expectedName = 'YAML name';
      if (scenario === 'unchanged editor') {
        writeFileSync(files.yaml, configText.replace('Original', 'YAML name'));
      } else if (scenario === 'reconstructable editor rename') {
        editor.folders[1].name = 'Editor name';
        expectedName = 'Editor name';
        writeFileSync(files.editor, JSON.stringify(editor));
      } else {
        writeFileSync(files.yaml, configText.replace('Original', 'YAML name'));
        editor.settings['editor.fontSize'] = 14;
        expectedName = 'Original';
        writeFileSync(files.editor, JSON.stringify(editor));
      }
      expect((await syncWorkspace(testDir, scenario === 'legacy editor precedence' ? { confirmLegacyVscodeImport: async () => true } : {})).success).toBe(true);
      expect((load(readFileSync(files.yaml, 'utf-8')) as WorkspaceConfig).repositories[0]!.name).toBe(expectedName);
      const updatedState = JSON.parse(readFileSync(files.state, 'utf-8'));
      expect(updatedState.vscodeWorkspaceFolders).toContainEqual({ path: resolve(testDir, '../myrepo'), name: expectedName });
      // Once upgraded, a settings-only edit cannot undo a later YAML name.
      writeFileSync(files.yaml, readFileSync(files.yaml, 'utf-8').replace(`name: ${expectedName}`, 'name: Later YAML name'));
      const nextEditor = JSON.parse(readFileSync(files.editor, 'utf-8'));
      nextEditor.settings['editor.fontSize'] = 15;
      writeFileSync(files.editor, JSON.stringify(nextEditor));
      expect((await syncWorkspace(testDir)).success).toBe(true);
      expect((load(readFileSync(files.yaml, 'utf-8')) as WorkspaceConfig).repositories[0]!.name).toBe('Later YAML name');
    },
  );

  test('an explicitly empty editor display name survives import and regeneration', async () => {
    const files = await initialize();
    const editor = JSON.parse(readFileSync(files.editor, 'utf-8'));
    editor.folders[1].name = '';
    writeFileSync(files.editor, JSON.stringify(editor));
    expect((await syncWorkspace(testDir)).success).toBe(true);
    expect((load(readFileSync(files.yaml, 'utf-8')) as WorkspaceConfig).repositories[0]!.name).toBe('');
    expect(JSON.parse(readFileSync(files.editor, 'utf-8')).folders[1].name).toBe('');
  });

  for (const mapping of ['string', 'explicit destination'] as const) {
    function sourceTemplateFixture() {
      const source = join(testDir, 'workspace-source');
      const template = mapping === 'string'
        ? join(source, '.allagents', 'template.code-workspace')
        : join(source, 'templates', 'editor.code-workspace');
      mkdirSync(mapping === 'string' ? join(source, '.allagents') : join(source, 'templates'), { recursive: true });
      const files = mapping === 'string'
        ? '[.allagents/template.code-workspace]'
        : '\n    - source: templates/editor.code-workspace\n      dest: .allagents/template.code-workspace';
      writeFileSync(paths().yaml, `${configText}workspace:\n  source: ${source}\n  files: ${files}\n`);
      return { source: template, local: join(testDir, '.allagents', 'template.code-workspace') };
    }

    test(`incoming workspace template is used immediately on first sync and refresh (${mapping})`, async () => {
      const templates = sourceTemplateFixture();
      for (const revision of [1, 2]) {
        writeFileSync(templates.source, JSON.stringify({
          settings: { 'template.revision': revision },
          folders: [{ path: `../template-${revision}`, name: `Template ${revision}` }],
        }));
        expect((await syncWorkspace(testDir)).success).toBe(true);
        const generated = JSON.parse(readFileSync(paths().editor, 'utf-8'));
        expect(generated.settings['template.revision']).toBe(revision);
        expect(generated.folders).toContainEqual({ path: `../template-${revision}`, name: `Template ${revision}` });
        const state = JSON.parse(readFileSync(paths().state, 'utf-8'));
        expect(state.vscodeWorkspaceFolders).toContainEqual({ path: resolve(testDir, `../template-${revision}`), name: `Template ${revision}` });
        expect(state.vscodeWorkspaceFolders).not.toContainEqual({ path: resolve(testDir, `../template-${3 - revision}`), name: `Template ${3 - revision}` });
      }
    });

    test(`valid incoming workspace template repairs a malformed local template (${mapping})`, async () => {
      const templates = sourceTemplateFixture();
      writeFileSync(templates.source, '{"settings":{"template.revision":"repaired"}}');
      writeFileSync(templates.local, '{ malformed local template');
      expect((await syncWorkspace(testDir)).success).toBe(true);
      expect(JSON.parse(readFileSync(paths().editor, 'utf-8')).settings['template.revision']).toBe('repaired');
      expect(readFileSync(templates.local, 'utf-8')).toBe(readFileSync(templates.source, 'utf-8'));
    });

    test(`malformed incoming workspace template preserves pending editor import and all existing files (${mapping})`, async () => {
      const templates = sourceTemplateFixture();
      writeFileSync(templates.source, '{"settings":{"template.revision":1}}');
      expect((await syncWorkspace(testDir)).success).toBe(true);
      writeFileSync(paths().editor, '{ folders: [] }');
      writeFileSync(templates.source, '{ malformed incoming template');
      const owned = [...Object.values(paths()), templates.local];
      const before = owned.map(file => readFileSync(file, 'utf-8'));
      const result = await syncWorkspace(testDir);
      expect(result.success).toBe(false);
      expect(result.error).toContain('VS Code');
      expect(owned.map(file => readFileSync(file, 'utf-8'))).toEqual(before);
    });
  }

  test('built plugin install reports failed VS Code import in JSON while retaining the saved declaration and pending editor bytes', async () => {
    const files = await initialize();
    const home = join(testDir, 'isolated-home');
    const plugin = join(testDir, 'local-plugin');
    mkdirSync(home);
    mkdirSync(join(plugin, 'skills', 'fixture'), { recursive: true });
    writeFileSync(join(plugin, 'skills', 'fixture', 'SKILL.md'), '---\nname: fixture\ndescription: Local writeback test\n---\n# Fixture\n');
    const editor = '{ malformed editor';
    writeFileSync(files.editor, editor);
    const baseline = readFileSync(files.state, 'utf-8');
    const result = Bun.spawnSync(['node', resolve(import.meta.dir, '../../dist/index.js'), '--json', 'plugin', 'install', plugin,
      '--scope', 'project', '--client', 'vscode', '--yes'], {
      cwd: testDir,
      env: { ...process.env, HOME: home, USERPROFILE: home, ALLAGENTS_TEST_HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'), CI: '1', NO_COLOR: '1' },
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(result.exitCode).not.toBe(0);
    const output = JSON.parse(new TextDecoder().decode(result.stdout));
    expect(output.data.syncResult.error).toContain('VS Code workspace import failed');
    expect((load(readFileSync(files.yaml, 'utf-8')) as WorkspaceConfig).plugins).toContain(plugin);
    expect(readFileSync(files.editor, 'utf-8')).toBe(editor);
    expect(readFileSync(files.state, 'utf-8')).toBe(baseline);
  });

  async function ambiguousLegacyImport() {
    const files = await initialize();
    const state = JSON.parse(readFileSync(files.state, 'utf-8'));
    delete state.vscodeWorkspaceFolders;
    writeFileSync(files.state, JSON.stringify(state));
    writeFileSync(files.yaml, configText.replace('Original', 'YAML name'));
    const editor = JSON.parse(readFileSync(files.editor, 'utf-8'));
    editor.folders[1].name = 'Editor name';
    writeFileSync(files.editor, JSON.stringify(editor));
    return files;
  }

  test.each(['missing callback', 'cancel', 'approve'] as const)(
    'ambiguous legacy import requires explicit approval: %s', async decision => {
      const files = await ambiguousLegacyImport();
      const before = Object.values(files).map(file => readFileSync(file, 'utf-8'));
      let called = false;
      const result = await syncWorkspace(testDir, decision === 'missing callback' ? {} : {
        confirmLegacyVscodeImport: async preview => {
          called = true;
          expect(preview).toEqual({
            workspacePath: testDir, added: [], removed: [],
            renamed: [{ path: '../myrepo', beforeName: 'YAML name', afterName: 'Editor name' }],
          });
          return decision === 'approve';
        },
      });
      expect(called).toBe(decision !== 'missing callback');
      expect(result.success).toBe(decision === 'approve');
      if (decision === 'approve') {
        expect((load(readFileSync(files.yaml, 'utf-8')) as WorkspaceConfig).repositories[0]!.name).toBe('Editor name');
        expect(JSON.parse(readFileSync(files.state, 'utf-8')).vscodeWorkspaceFolders).toBeDefined();
      } else {
        expect(result.error).toContain(decision === 'cancel' ? 'cancelled' : 'confirmation required');
        expect(Object.values(files).map(file => readFileSync(file, 'utf-8'))).toEqual(before);
      }
    },
  );

  test('plugin-only YAML changes and an editor rename remain automatic with reconstructable legacy folders', async () => {
    const files = await initialize();
    const state = JSON.parse(readFileSync(files.state, 'utf-8'));
    delete state.vscodeWorkspaceFolders;
    writeFileSync(files.state, JSON.stringify(state));
    const plugin = join(testDir, 'independent-plugin');
    mkdirSync(join(plugin, 'skills', 'fixture'), { recursive: true });
    writeFileSync(join(plugin, 'skills', 'fixture', 'SKILL.md'), '---\nname: fixture\ndescription: Independent change\n---\n# Fixture\n');
    writeFileSync(files.yaml, configText.replace('plugins: []', `plugins: [${plugin}]`));
    const editor = JSON.parse(readFileSync(files.editor, 'utf-8'));
    editor.folders[1].name = 'Editor name';
    writeFileSync(files.editor, JSON.stringify(editor));
    expect((await syncWorkspace(testDir, { confirmLegacyVscodeImport: async () => {
      throw new Error('independent plugin changes must not require confirmation');
    } })).success).toBe(true);
    const config = load(readFileSync(files.yaml, 'utf-8')) as WorkspaceConfig;
    expect(config.repositories[0]!.name).toBe('Editor name');
    expect(config.plugins).toContain(plugin);
  });

  test.each([false, true])('legacy baseline uses the local template before incoming replacement (local malformed: %s)', async malformed => {
    const source = join(testDir, 'source');
    const sourceTemplate = join(source, '.allagents', 'template.code-workspace');
    mkdirSync(join(source, '.allagents'), { recursive: true });
    writeFileSync(sourceTemplate, '{"settings":{"template.revision":1}}');
    writeFileSync(paths().yaml, `${configText}workspace:\n  source: ${source}\n  files: [.allagents/template.code-workspace]\n`);
    expect((await syncWorkspace(testDir)).success).toBe(true);
    const files = paths();
    const state = JSON.parse(readFileSync(files.state, 'utf-8'));
    delete state.vscodeWorkspaceFolders;
    writeFileSync(files.state, JSON.stringify(state));
    const editor = JSON.parse(readFileSync(files.editor, 'utf-8'));
    editor.folders[1].name = 'Editor name';
    writeFileSync(files.editor, JSON.stringify(editor));
    if (malformed) writeFileSync(join(testDir, '.allagents', 'template.code-workspace'), '{ broken local');
    writeFileSync(sourceTemplate, '{"settings":{"template.revision":2}}');
    let confirmations = 0;
    expect((await syncWorkspace(testDir, { confirmLegacyVscodeImport: async () => {
      confirmations++;
      return true;
    } })).success).toBe(true);
    expect(confirmations).toBe(malformed ? 1 : 0);
    expect(JSON.parse(readFileSync(files.editor, 'utf-8')).settings['template.revision']).toBe(2);
    expect((load(readFileSync(files.yaml, 'utf-8')) as WorkspaceConfig).repositories[0]!.name).toBe('Editor name');
  });

  test.each(['proven removal', 'no repository change'] as const)('legacy %s needs no confirmation even when old names cannot be reconstructed', async scenario => {
    const files = await initialize();
    const state = JSON.parse(readFileSync(files.state, 'utf-8'));
    delete state.vscodeWorkspaceFolders;
    writeFileSync(files.state, JSON.stringify(state));
    const editor = JSON.parse(readFileSync(files.editor, 'utf-8'));
    writeFileSync(files.yaml, configText.replace('Original', 'YAML name'));
    if (scenario === 'proven removal') editor.folders = [{ path: '.' }];
    else editor.folders[1].name = 'YAML name';
    writeFileSync(files.editor, JSON.stringify(editor));
    const before = readFileSync(files.yaml, 'utf-8');
    expect((await syncWorkspace(testDir, { confirmLegacyVscodeImport: async () => {
      throw new Error('this legacy change is unambiguous');
    } })).success).toBe(true);
    if (scenario === 'proven removal') expect((load(readFileSync(files.yaml, 'utf-8')) as WorkspaceConfig).repositories).toEqual([]);
    else expect(readFileSync(files.yaml, 'utf-8')).toBe(before);
  });

  test('malformed incoming template fails before ambiguous legacy confirmation', async () => {
    const files = await ambiguousLegacyImport();
    writeFileSync(join(testDir, '.allagents', 'template.code-workspace'), '{ malformed template');
    const before = Object.values(files).map(file => readFileSync(file, 'utf-8'));
    const result = await syncWorkspace(testDir, { confirmLegacyVscodeImport: async () => {
      throw new Error('confirmation must not run for invalid input');
    } });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to parse');
    expect(Object.values(files).map(file => readFileSync(file, 'utf-8'))).toEqual(before);
  });

  test.each(['YAML', 'editor'] as const)('approval cannot overwrite a concurrent %s edit made while awaiting confirmation', async location => {
    const files = await ambiguousLegacyImport();
    const before = Object.values(files).map(file => readFileSync(file, 'utf-8'));
    let concurrent = '';
    const result = await syncWorkspace(testDir, { confirmLegacyVscodeImport: async () => {
      const file = location === 'YAML' ? files.yaml : files.editor;
      concurrent = `${readFileSync(file, 'utf-8')}\n${location === 'YAML' ? '# concurrent plugin change' : '// concurrent editor change'}\n`;
      writeFileSync(file, concurrent);
      return true;
    } });
    expect(result.success).toBe(false);
    expect(result.error).toContain('changed during');
    expect(readFileSync(files.yaml, 'utf-8')).toBe(location === 'YAML' ? concurrent : before[0]);
    expect(readFileSync(files.editor, 'utf-8')).toBe(location === 'editor' ? concurrent : before[1]);
    expect(readFileSync(files.state, 'utf-8')).toBe(before[2]);
  });

  test('unknown legacy additions require approval with both proposed additions and proven removals visible', async () => {
    const files = await ambiguousLegacyImport();
    writeFileSync(files.editor, '{folders:[{path:"."},{path:"../new",name:"New folder"}]}');
    const before = Object.values(files).map(file => readFileSync(file, 'utf-8'));
    let prompted = false;
    const result = await syncWorkspace(testDir, { confirmLegacyVscodeImport: async preview => {
      prompted = true;
      expect(preview.added).toEqual([{ path: '../new', name: 'New folder' }]);
      expect(preview.removed).toEqual([{ path: '../myrepo', name: 'YAML name' }]);
      expect(preview.renamed).toEqual([]);
      return false;
    } });
    expect(prompted).toBe(true);
    expect(result.success).toBe(false);
    expect(Object.values(files).map(file => readFileSync(file, 'utf-8'))).toEqual(before);
  });

});
