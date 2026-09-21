import { describe, expect, test } from 'bun:test';
import { buildClientOptions } from '../../../../src/cli/tui/prompt-clients.js';

describe('buildClientOptions', () => {
  test('returns every client with project-scoped destination hints by default', () => {
    const options = buildClientOptions();

    expect(options.length).toBeGreaterThan(10);
    expect(options.find((option) => option.value === 'universal')?.hint).toBe(
      '.agents/skills/',
    );
    expect(options.map((option) => option.value)).toEqual(
      expect.arrayContaining(['warp', 'aider-desk', 'eve']),
    );
    expect(options.find((option) => option.value === 'claude')?.hint).toBe(
      '.claude/skills/',
    );
    expect(options.every((option) => option.hint.length > 0)).toBe(true);
  });

  test('uses user-scoped client mappings', () => {
    const options = buildClientOptions('user');

    expect(options.find((option) => option.value === 'copilot')?.hint).toBe(
      '.copilot/skills/',
    );
    expect(options.find((option) => option.value === 'pi')?.hint).toBe(
      '.pi/agent/skills/',
    );
    expect(options.map((option) => option.value)).toEqual(
      expect.arrayContaining(['warp', 'aider-desk']),
    );
  });

  test('omits the project-only destination from user-scope choices', () => {
    const values = buildClientOptions('user').map((option) => option.value);

    expect(values).not.toContain('eve');
  });

  test('describes configured native clients without claiming a file destination', () => {
    const options = buildClientOptions('project', [
      { name: 'claude', install: 'native' },
    ]);

    expect(options.find((option) => option.value === 'claude')?.hint).toBe(
      'Native install',
    );
    expect(options.find((option) => option.value === 'codex')?.hint).toBe(
      '.codex/skills/',
    );
  });
});
