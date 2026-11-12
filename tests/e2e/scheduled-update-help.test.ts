import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..');
const cliEntry = join(repoRoot, 'dist', 'index.js');

describe('scheduled update guidance discovery', () => {
  let root: string;
  let home: string;
  let project: string;

  beforeAll(() => {
    const build = Bun.spawnSync(['bun', 'run', 'build'], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (build.exitCode !== 0) {
      throw new Error(`Build failed: ${build.stderr.toString()}`);
    }
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'allagents-schedule-help-'));
    home = join(root, 'home');
    project = join(root, 'project');
    mkdirSync(home);
    mkdirSync(project);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function help(path: string[] = []) {
    const result = Bun.spawnSync(['node', cliEntry, ...path, '--help', '--json'], {
      cwd: project,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ALLAGENTS_TEST_HOME: home,
        XDG_CONFIG_HOME: join(home, '.config'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe('');
    return JSON.parse(result.stdout.toString());
  }

  test('discovers the recipe from the root index without expanding it there', () => {
    const index = help();
    const update = index.commands.find(
      (entry: { command: string }) => entry.command === 'update',
    );
    expect(update.when_to_use).toContain('scheduled updates');
    expect(JSON.stringify(index)).not.toContain('"workflows"');
    expect(JSON.stringify(index)).not.toContain('OnCalendar');

    const leaf = help(update.help_command.split(' ').slice(1, -2));
    expect(leaf.command).toBe('update');
    expect(leaf.workflows).toEqual([
      expect.objectContaining({
        id: 'scheduled-updates',
        description: expect.stringContaining('explicitly requests'),
        steps: expect.arrayContaining([
          expect.stringContaining('--scope project'),
          expect.stringContaining(
            'ExecStart=/ABS/ALLAGENTS update --scope user --json',
          ),
          expect.stringContaining('crontab -l'),
          expect.stringContaining('next trigger'),
        ]),
      }),
    ]);
    expect(leaf.options).toContainEqual(
      expect.objectContaining({ flag: '--profile' }),
    );
    expect(leaf.output_schema).toBeDefined();
    expect(leaf.json_fields).toBeInstanceOf(Array);
  });

  test('shares the recipe across update aliases while other help stays unchanged', () => {
    const group = help(['workspace']);
    const entry = group.commands.find(
      (item: { command: string }) => item.command === 'workspace update',
    );
    expect(JSON.stringify(group)).not.toContain('"workflows"');
    const leaf = help(entry.help_command.split(' ').slice(1, -2));
    for (const path of [['update'], ['sync'], ['workspace', 'sync']]) {
      expect(help(path).workflows).toEqual(leaf.workflows);
    }
    expect(help(['self', 'update']).workflows).toBeUndefined();
    expect(help(['status']).workflows).toBeUndefined();
  });

  test('leaves the home, project, and existing scheduler files untouched', () => {
    const units = join(home, '.config', 'systemd', 'user');
    mkdirSync(units, { recursive: true });
    const existing = join(units, 'unrelated.timer');
    writeFileSync(existing, '[Timer]\nOnCalendar=weekly\n');
    const before = readdirSync(root, { recursive: true }).sort();
    help();
    help(['workspace']);
    help(['update']);
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(before);
    expect(readFileSync(existing, 'utf8')).toBe('[Timer]\nOnCalendar=weekly\n');
  });
});
