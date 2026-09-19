import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const cliEntry = join(import.meta.dir, '..', '..', '..', 'src', 'cli', 'index.ts');

describe('CLI JSON field validation', () => {
  test('validates skill update fields when skill filters follow the command', () => {
    const proc = Bun.spawnSync(
      [
        'bun',
        'run',
        cliEntry,
        '--json=definitely-invalid',
        'skill',
        'update',
        'code-review',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    expect(proc.exitCode).toBe(2);
    expect(proc.stderr.toString()).toContain(
      'Unknown JSON field: "definitely-invalid"',
    );
    expect(proc.stderr.toString()).toContain('Available fields:');
    expect(proc.stdout.toString()).toBe('');
  });

  test('derives JSON fields from the command output schema', () => {
    const proc = Bun.spawnSync(
      [
        'bun',
        'run',
        cliEntry,
        '--json=definitely-invalid',
        'mcp',
        'list',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    expect(proc.exitCode).toBe(2);
    expect(proc.stderr.toString()).toContain(
      'Unknown JSON field: "definitely-invalid"',
    );
    expect(proc.stderr.toString()).toContain('  destination');
    expect(proc.stderr.toString()).toContain('  servers');
    expect(proc.stderr.toString()).toContain('  total');
    expect(proc.stdout.toString()).toBe('');
  });
});
