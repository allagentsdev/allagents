import { afterEach, describe, expect, test } from 'bun:test';
import {
  extractJsonFlag,
  formatJsonValue,
  setJsonMode,
} from '../../../src/cli/json-output.js';

describe('extractJsonFlag', () => {
  test('returns json false when flag is absent', () => {
    const result = extractJsonFlag(['workspace', 'sync']);
    expect(result.json).toBe(false);
    expect(result.args).toEqual(['workspace', 'sync']);
  });

  test('strips --json from end of args', () => {
    const result = extractJsonFlag(['workspace', 'sync', '--json']);
    expect(result.json).toBe(true);
    expect(result.args).toEqual(['workspace', 'sync']);
  });

  test('strips --json from beginning of args', () => {
    const result = extractJsonFlag(['--json', 'workspace', 'sync']);
    expect(result.json).toBe(true);
    expect(result.args).toEqual(['workspace', 'sync']);
  });

  test('strips --json from middle of args', () => {
    const result = extractJsonFlag(['workspace', '--json', 'sync']);
    expect(result.json).toBe(true);
    expect(result.args).toEqual(['workspace', 'sync']);
  });
});

describe('jq output', () => {
  afterEach(() => {
    setJsonMode(false);
  });

  test('formats a valid runtime-sized envelope without the child buffer truncating it', () => {
    const text = 'x'.repeat(16 * 1024 * 1024 - 1024);
    const value = {
      success: true,
      command: 'mcp call',
      data: {
        result: {
          content: [{ type: 'text', text }],
        },
      },
    };
    setJsonMode(true, { jqExpr: '.' });

    const formatted = formatJsonValue(value);
    const parsed = JSON.parse(formatted);

    expect(parsed.success).toBe(true);
    expect(parsed.data.result.content[0].text).toHaveLength(text.length);
  });
});
