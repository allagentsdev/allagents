import { describe, expect, test } from 'bun:test';
import { readYamlFrontmatter } from '../../../src/utils/frontmatter.js';
import { parseSkillMetadata } from '../../../src/validators/skill.js';

describe('YAML frontmatter', () => {
  test('reads BOM/CRLF and multiline YAML without parsing the Markdown body', () => {
    const source = '\uFEFF---\r\nname: test-skill\r\ndescription: |\r\n  First line\r\n  --- inside a scalar\r\n  Last line\r\n---\r\n# Body\r\ninvalid: [\r\n---\r\n';
    expect(parseSkillMetadata(source)).toMatchObject({
      name: 'test-skill', description: 'First line\n--- inside a scalar\nLast line\n',
    });
  });

  test('supports YAML-labelled delimiters, flow mappings, comments and unterminated YAML', () => {
    for (const opening of ['---', '---yaml', '---yml']) {
      expect(readYamlFrontmatter(`${opening}\n{ name: test-skill, description: Test }\n---\n`)).toEqual({ name: 'test-skill', description: 'Test' });
    }
    expect(readYamlFrontmatter('---\n# comment\nname: test-skill\ndescription: Test')).toEqual({ name: 'test-skill', description: 'Test' });
  });

  test('requires a delimiter line at the start and keeps body metadata out', () => {
    for (const source of ['# Body\n---\nname: test', '\n---\nname: test', '----\nname: test', '---\n---\nname: test', '---\n# Comment\n---\nname: test']) {
      expect(readYamlFrontmatter(source)).toEqual({});
      expect(parseSkillMetadata(source)).toBeNull();
    }
  });

  test('rejects malformed YAML and never executes frontmatter code', () => {
    expect(() => readYamlFrontmatter('---\nname: [\n---')).toThrow();
    expect(readYamlFrontmatter('---js\nthrow new Error("executed")\n---')).toEqual({});
    expect(parseSkillMetadata('---\nname: !!js/function function() {}\ndescription: Test\n---')).toBeNull();
  });
});

test('accepts whitespace in YAML language labels and comments on closing delimiters', () => {
  for (const opening of ['--- yaml', '--- yml ', '---\tyaml', '--- YAML', '---YML', '--- Yaml']) {
    expect(parseSkillMetadata(`${opening}\nname: test-skill\ndescription: Test\n--- # end\n# Markdown\ninvalid: [\n`)).toMatchObject({ name: 'test-skill', description: 'Test' });
  }
});
