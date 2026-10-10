import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCli(workdir: string, homeDir: string, json = false): CliResult {
  const cliEntry = join(import.meta.dir, '..', '..', 'src', 'cli', 'index.ts');
  const args = ['bun', 'run', cliEntry, ...(json ? ['--json'] : []), 'plugin', 'list'];
  const proc = Bun.spawnSync(args, {
    cwd: workdir,
    env: {
      ...process.env,
      ALLAGENTS_TEST_HOME: homeDir,
      HOME: homeDir,
    },
    stderr: 'pipe',
    stdout: 'pipe',
  });

  return {
    exitCode: proc.exitCode,
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

describe('plugin list e2e', () => {
  let rootDir: string;
  let workspaceDir: string;
  let homeDir: string;
  let projectConfigPath: string;
  let userConfigPath: string;
  let projectConfig: string;
  let userConfig: string;

  beforeEach(() => {
    rootDir = join(
      tmpdir(),
      `allagents-e2e-plugin-list-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    workspaceDir = join(rootDir, 'workspace');
    homeDir = join(rootDir, 'home');
    projectConfigPath = join(workspaceDir, '.allagents', 'workspace.yaml');
    userConfigPath = join(homeDir, '.allagents', 'workspace.yaml');

    mkdirSync(join(workspaceDir, '.allagents'), { recursive: true });
    mkdirSync(join(homeDir, '.allagents'), { recursive: true });

    projectConfig = `version: 2
repositories: []
plugins:
  - source: https://github.com/acme/toolbox/tree/main/plugins/alpha
    clients:
      - codex
  - source: https://github.com/acme/toolbox/tree/main/plugins/beta
    clients:
      - cursor
  - source: acme/toolbox/plugins/research
    ref: v1
    clients:
      - codex
  - source: acme/toolbox/plugins/research
    ref: v2
    clients:
      - cursor
  - acme/toolbox@v3/plugins/inline
clients:
  - codex
`;
    userConfig = `version: 2
repositories: []
plugins:
  - demo@acme/official
clients:
  - claude:native
profiles:
  work:
    clients:
      - name: pi
    plugins: []
`;

    writeFileSync(projectConfigPath, projectConfig, 'utf-8');
    writeFileSync(userConfigPath, userConfig, 'utf-8');
    writeFileSync(
      join(homeDir, '.allagents', 'sync-state.json'),
      JSON.stringify({
        version: 1,
        lastSync: '2026-09-11T00:00:00.000Z',
        files: {},
        nativePlugins: { claude: ['demo@official'] },
      }),
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  test('renders distinct friendly names and compact direct sources', () => {
    const human = runCli(workspaceDir, homeDir);
    expect(human.exitCode).toBe(0);
    expect(human.stderr).toBe('');
    expect(human.stdout).toContain('❯ alpha');
    expect(human.stdout).toContain('Source: acme/toolbox/plugins/alpha');
    expect(human.stdout).toContain('❯ beta');
    expect(human.stdout).toContain('Source: acme/toolbox/plugins/beta');
    expect(human.stdout.match(/❯ research/g)).toHaveLength(2);
    expect(human.stdout).toContain(
      'Source: acme/toolbox@v1/plugins/research',
    );
    expect(human.stdout).toContain(
      'Source: acme/toolbox@v2/plugins/research',
    );
    expect(human.stdout).toContain('❯ inline');
    expect(human.stdout).toContain(
      'Source: acme/toolbox@v3/plugins/inline',
    );
    expect(human.stdout).toContain('Type: plugin');
    expect(human.stdout).toContain('Scope: project');
    expect(human.stdout).toContain('Clients: codex');
    expect(human.stdout).toContain('Clients: cursor');
  });

  test('returns corrected names and raw specs without internal fields in JSON', () => {
    const json = runCli(workspaceDir, homeDir, true);
    expect(json.exitCode).toBe(0);
    expect(json.stderr).toBe('');
    const payload = JSON.parse(json.stdout);
    expect(
      payload.data.plugins.filter(
        (plugin: { scope: string }) => plugin.scope === 'project',
      ),
    ).toEqual([
      {
        name: 'alpha',
        spec: 'https://github.com/acme/toolbox/tree/main/plugins/alpha',
        marketplace: '',
        scope: 'project',
        kind: 'plugin',
        clients: ['codex'],
      },
      {
        name: 'beta',
        spec: 'https://github.com/acme/toolbox/tree/main/plugins/beta',
        marketplace: '',
        scope: 'project',
        kind: 'plugin',
        clients: ['cursor'],
      },
      {
        name: 'research',
        spec: 'acme/toolbox/plugins/research',
        marketplace: '',
        scope: 'project',
        kind: 'plugin',
        clients: ['codex'],
      },
      {
        name: 'research',
        spec: 'acme/toolbox/plugins/research',
        marketplace: '',
        scope: 'project',
        kind: 'plugin',
        clients: ['cursor'],
      },
      {
        name: 'inline',
        spec: 'acme/toolbox@v3/plugins/inline',
        marketplace: '',
        scope: 'project',
        kind: 'plugin',
        clients: ['codex'],
      },
    ]);
    expect(payload.data.total).toBe(6);
  });

  test('keeps native npm pins separate from the upstream Codex plugin', () => {
    writeFileSync(projectConfigPath, 'version: 2\nrepositories: []\nplugins: []\nclients: [codex]\n');
    writeFileSync(userConfigPath, `version: 2
plugins:
  - source: npm:pi-compound-engineering@3.19.2
    clients: [pi]
  - source: npm:@acme/pi-tools@1.2.3
    clients: [pi]
  - source: https://github.com/EveryInc/compound-engineering-plugin
    clients: [codex]
clients: [pi:native, codex]
`);
    writeFileSync(join(homeDir, '.allagents', 'sync-state.json'), JSON.stringify({
      version: 1, lastSync: '2026-09-11T00:00:00.000Z', files: {},
      nativePlugins: { pi: ['npm:pi-compound-engineering@3.19.2', 'npm:@acme/pi-tools@1.2.3'] },
    }));
    const result = runCli(workspaceDir, homeDir, true);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const payload = JSON.parse(result.stdout);
    expect(payload.data.total).toBe(3);
    expect(payload.data.plugins).toEqual([
      { name: 'pi-compound-engineering', spec: 'npm:pi-compound-engineering@3.19.2', marketplace: '', scope: 'user', kind: 'plugin', nativeClients: ['pi'] },
      { name: '@acme/pi-tools', spec: 'npm:@acme/pi-tools@1.2.3', marketplace: '', scope: 'user', kind: 'plugin', nativeClients: ['pi'] },
      { name: 'compound-engineering-plugin', spec: 'https://github.com/EveryInc/compound-engineering-plugin', marketplace: '', scope: 'user', kind: 'plugin', clients: ['codex'] },
    ]);
    const human = runCli(workspaceDir, homeDir);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain('❯ pi-compound-engineering');
    expect(human.stdout).toContain('Clients: native pi');
    expect(human.stdout).toContain('❯ compound-engineering-plugin');
    expect(human.stdout).toContain('Clients: codex');
    expect(human.stdout).toContain('Source: npm:@acme/pi-tools@1.2.3');
  });

  test('merges canonical native state with parsed native client config', () => {
    const human = runCli(workspaceDir, homeDir);
    expect(human.exitCode).toBe(0);
    const demoSection = human.stdout
      .split('❯ demo@acme/official')[1]
      ?.split('\n\n')[0];
    expect(demoSection).toContain('Type: plugin');
    expect(demoSection).toContain('Scope: user');
    expect(demoSection).toContain('Clients: native claude');
    expect(demoSection).not.toContain('claude:native');
    expect(demoSection).not.toContain('Source:');
    expect(human.stdout.match(/❯ demo@acme\/official/g)).toHaveLength(1);
  });

  test('does not report configured native intent without tracked state', () => {
    rmSync(join(homeDir, '.allagents', 'sync-state.json'));

    const human = runCli(workspaceDir, homeDir);
    expect(human.exitCode).toBe(0);
    const demoSection = human.stdout
      .split('❯ demo@acme/official')[1]
      ?.split('\n\n')[0];
    expect(demoSection).toContain('Type: plugin');
    expect(demoSection).not.toContain('Clients:');

    const json = runCli(workspaceDir, homeDir, true);
    expect(json.exitCode).toBe(0);
    const payload = JSON.parse(json.stdout);
    expect(
      payload.data.plugins.find(
        (plugin: { scope: string }) => plugin.scope === 'user',
      ),
    ).toEqual({
      name: 'demo',
      spec: 'demo@acme/official',
      marketplace: 'official',
      scope: 'user',
      kind: 'plugin',
    });
  });

  test('does not modify either workspace config', () => {
    const human = runCli(workspaceDir, homeDir);
    const json = runCli(workspaceDir, homeDir, true);
    expect(human.exitCode).toBe(0);
    expect(json.exitCode).toBe(0);
    expect(readFileSync(projectConfigPath, 'utf-8')).toBe(projectConfig);
    expect(readFileSync(userConfigPath, 'utf-8')).toBe(userConfig);
  });
});
